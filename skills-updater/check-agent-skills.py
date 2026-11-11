#!/usr/bin/env python3
"""检查并自动更新 ~/.agents/skills 中的全部技能。

原理
----
* 每个技能的"版本"用其目录的 git tree 哈希表示（与安装器写入
  ~/.agents/.skill-lock.json 的 skillFolderHash 一致，已验证）。
* git 来源：用 `--filter=blob:none` 的浅镜像只比对树对象，判定变化后再按需
  拉取文件内容（lazy blob fetch）落地更新，省流量。
* 包来源（如 uv tool 提供的 browser-use）：升级工具后从其 site-packages
  同步技能目录。
* 本地有改动（与记录哈希不一致）时会先备份到 backups/<时间戳>/ 再覆盖。

默认检测 + 自动更新；`--dry-run` 不修改技能、来源锁文件或登记信息，
但仍刷新 Git 缓存并写入检查报告。
"""
from __future__ import annotations

import argparse
import datetime
import fcntl
import glob
import json
import os
from pathlib import PurePosixPath
import shutil
import subprocess
import sys
import tempfile

HOME = os.path.expanduser("~")
SKILLS = os.path.join(HOME, ".agents", "skills")
LOCK = os.path.join(HOME, ".agents", ".skill-lock.json")
CACHE = os.path.join(os.environ.get("XDG_CACHE_HOME", os.path.join(HOME, ".cache")), "skills-upstream")
STATE = os.path.join(
    os.environ.get("XDG_STATE_HOME", os.path.join(HOME, ".local", "state")),
    "scientific-skills-check",
)
REGISTRY = os.path.join(STATE, "registry.json")
REPORT = os.path.join(STATE, "last-report.txt")
HISTORY = os.path.join(STATE, "history.log")
STATUS = os.path.join(STATE, "status.json")

DEFAULT_REGISTRY = {
    "version": 1,
    "packageSkills": {
        "browser-use": {
            "type": "uv-tool",
            "package": "browser-use",
            "skillDirGlob": "~/.local/share/uv/tools/browser-use/lib/python*/site-packages/browser_use/skills/browser-use",
        }
    },
    "extraGitSkills": {},
}


def run(args: list[str], **kw) -> subprocess.CompletedProcess:
    kw.setdefault("timeout", 300)
    return subprocess.run(args, capture_output=True, text=True, **kw)


def now_stamp() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- git mirrors
def slug_for(url: str) -> str:
    return url.rstrip("/").removesuffix(".git").replace("https://github.com/", "").replace("/", "__")


def mirror_path(url: str) -> str:
    return os.path.join(CACHE, slug_for(url))


def sync_mirror(url: str) -> tuple[str | None, str, str | None]:
    path = mirror_path(url)
    if not os.path.isdir(os.path.join(path, ".git")):
        os.makedirs(CACHE, exist_ok=True)
        r = run(["git", "clone", "--filter=blob:none", "--depth", "1", "--no-checkout", url, path])
        if r.returncode != 0:
            return None, "-", _err("clone", r)
        commit = run(["git", "-C", path, "rev-parse", "HEAD"]).stdout.strip()
    else:
        r = run(["git", "-C", path, "fetch", "--depth", "1", "--filter=blob:none", "origin", "HEAD"])
        if r.returncode != 0:
            return None, "-", _err("fetch", r)
        commit = run(["git", "-C", path, "rev-parse", "FETCH_HEAD"]).stdout.strip()
    branch = run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip() or "-"
    return commit, branch, None


def _err(stage: str, r: subprocess.CompletedProcess) -> str:
    tail = (r.stderr or "").strip().splitlines()
    return f"{stage} 失败: {tail[-1] if tail else 'unknown'}"


def tree_of(mirror: str, commit: str, folder: str) -> str | None:
    r = run(["git", "-C", mirror, "rev-parse", f"{commit}:{folder}"])
    if r.returncode != 0:
        return None
    tree = r.stdout.strip()
    kind = run(["git", "-C", mirror, "cat-file", "-t", tree])
    return tree if kind.returncode == 0 and kind.stdout.strip() == "tree" else None


def list_skill_folders(mirror: str, commit: str) -> dict[str, str]:
    """返回 {技能名: 仓库内目录}（依据 **/SKILL.md 反推）。"""
    r = run(["git", "-C", mirror, "ls-tree", "-r", "--name-only", commit])
    out: dict[str, str] = {}
    for line in r.stdout.splitlines():
        if line.endswith("/SKILL.md"):
            folder = line[: -len("/SKILL.md")]
            out.setdefault(os.path.basename(folder), folder)
    return out


def materialize(mirror: str, commit: str, folder: str) -> str:
    """把仓库中某目录的文件内容取到工作区，返回该目录绝对路径。"""
    target = os.path.join(mirror, folder)
    shutil.rmtree(target, ignore_errors=True)
    r = run(["git", "-C", mirror, "checkout", commit, "--", folder])
    if r.returncode != 0:
        raise RuntimeError(_err("checkout", r))
    return target


# ------------------------------------------------------------------- hashing
def tree_hashes(dirs: dict[str, str]) -> dict[str, str | None]:
    """批量计算目录的 git tree 哈希（一次 git 仓库，复用对象库）。"""
    repo = tempfile.mkdtemp(prefix="skillhash-")
    result: dict[str, str | None] = {}
    try:
        run(["git", "init", "-q", repo])
        gd = os.path.join(repo, ".git")
        # 忽略运行时缓存，避免 __pycache__/*.pyc 让本地哈希与上游不一致（误判为“本地改动”）
        os.makedirs(os.path.join(gd, "info"), exist_ok=True)
        with open(os.path.join(gd, "info", "exclude"), "w") as fh:
            fh.write("__pycache__/\n*.pyc\n*.pyo\n")
        idx = os.path.join(repo, "index")
        for name, d in dirs.items():
            if not os.path.isdir(d):
                result[name] = None
                continue
            if os.path.exists(idx):
                os.remove(idx)
            env = dict(os.environ, GIT_DIR=gd, GIT_WORK_TREE=d, GIT_INDEX_FILE=idx)
            a = subprocess.run(["git", "add", "-A"], env=env, capture_output=True)
            if a.returncode != 0:
                result[name] = None
                continue
            w = subprocess.run(["git", "write-tree"], env=env, capture_output=True, text=True)
            result[name] = w.stdout.strip() if w.returncode == 0 else None
        return result
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def dir_hash(path: str) -> str | None:
    return tree_hashes({os.path.basename(path): path}).get(os.path.basename(path))


# ------------------------------------------------------------------ file ops
def sync_dir(src: str, dst: str) -> None:
    """Stage a complete copy before replacing a skill; roll back a failed rename."""
    if os.path.islink(dst) or (os.path.lexists(dst) and not os.path.isdir(dst)):
        raise ValueError(f"拒绝覆盖非普通技能目录: {dst}")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".skill-update-", dir=os.path.dirname(dst))
    incoming = os.path.join(staging, "incoming")
    previous = os.path.join(staging, "previous")
    try:
        shutil.copytree(src, incoming, symlinks=True)
        if os.path.exists(dst):
            os.rename(dst, previous)
        try:
            os.rename(incoming, dst)
        except BaseException:
            if os.path.exists(previous):
                os.rename(previous, dst)
            raise
    finally:
        # If rollback itself failed, retain the old data for manual recovery.
        if os.path.exists(previous) and not os.path.exists(dst):
            print(f"旧目录保留在 {previous}", file=sys.stderr)
        else:
            shutil.rmtree(staging, ignore_errors=True)


def backup(name: str, src: str, stamp: str) -> str:
    dest = os.path.join(STATE, "backups", stamp, name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(src, dest, symlinks=True)
    return dest


def notify(title: str, body: str) -> None:
    if shutil.which("notify-send") and os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        run(["notify-send", "-a", "Skills Updater", title, body])


# ---------------------------------------------------------------------- main
def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            result = json.load(fh)
        if not isinstance(result, dict):
            raise ValueError(f"JSON 必须是对象: {path}")
        return result
    except FileNotFoundError:
        return default


def write_json(path, value):
    """Do not truncate the previous state if serialization or writing fails."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".skills-state-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(value, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_entries(entries):
    if not isinstance(entries, dict):
        raise ValueError("技能来源清单必须是对象")
    for name, meta in entries.items():
        if (not isinstance(name, str) or not name or name.startswith(".")
                or "/" in name or "\\" in name or not isinstance(meta, dict)):
            raise ValueError(f"非法技能条目: {name!r}")
        folder = meta.get("folder") or os.path.dirname(meta.get("skillPath") or f"skills/{name}/SKILL.md")
        parts = PurePosixPath(folder).parts
        if not parts or parts[0].startswith("-") or PurePosixPath(folder).is_absolute() or any(p in ("..", ".git") for p in parts):
            raise ValueError(f"非法技能来源目录: {folder!r}")


def main() -> int:
    os.makedirs(STATE, exist_ok=True)
    # The timer and manual invocations share a lock; never unlink this inode.
    with open(os.path.join(STATE, "update.lock"), "a") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("另一个技能更新任务正在运行。", file=sys.stderr)
            return 1
        try:
            return update()
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            print(f"技能更新失败: {exc}", file=sys.stderr)
            return 1


def update() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="只检测，不写入任何更新")
    args = ap.parse_args()

    os.makedirs(STATE, exist_ok=True)
    stamp = now_stamp()
    bid = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")

    lock_doc = load_json(LOCK, {"skills": {}})
    lock = lock_doc.setdefault("skills", {})
    reg = load_json(REGISTRY, json.loads(json.dumps(DEFAULT_REGISTRY)))
    reg.setdefault("packageSkills", {})
    reg.setdefault("extraGitSkills", {})
    for entries in (lock, reg["packageSkills"], reg["extraGitSkills"]):
        validate_entries(entries)
    overlap = set(lock) & set(reg["extraGitSkills"])
    overlap |= (set(lock) | set(reg["extraGitSkills"])) & set(reg["packageSkills"])
    if overlap:
        raise ValueError(f"技能来源重复登记: {', '.join(sorted(overlap))}")

    # ---- 汇总来源
    git_sources: dict[str, list[str]] = {}          # url -> [skill names]
    for name, meta in lock.items():
        git_sources.setdefault(meta.get("sourceUrl", "unknown"), []).append(name)
    for name, meta in reg["extraGitSkills"].items():
        git_sources.setdefault(meta.get("sourceUrl", "unknown"), []).append(name)

    errors: list[str] = []
    mirror_state: dict[str, tuple[str, str]] = {}   # url -> (commit, branch)
    folder_maps: dict[str, dict[str, str]] = {}     # url -> {name: folder}
    for url in sorted(git_sources):
        try:
            commit, branch, err = sync_mirror(url)
        except (OSError, subprocess.SubprocessError) as exc:
            commit, branch, err = None, "-", str(exc)
        if err:
            errors.append(f"{slug_for(url)}: {err}")
            continue
        mirror_state[url] = (commit, branch)
        folder_maps[url] = list_skill_folders(mirror_path(url), commit)

    # ---- 自动登记：目录中存在但未登记的技能
    known = set(lock) | set(reg["extraGitSkills"]) | set(reg["packageSkills"])
    for name in (sorted(os.listdir(SKILLS)) if os.path.isdir(SKILLS) else []):
        if name in known or not os.path.isdir(os.path.join(SKILLS, name)):
            continue
        for url, (commit, _) in mirror_state.items():
            folder = folder_maps.get(url, {}).get(name)
            if folder:
                validate_entries({name: {"folder": folder}})
                h = tree_of(mirror_path(url), commit, folder)
                reg["extraGitSkills"][name] = {
                    "sourceUrl": url,
                    "folder": folder,
                    "skillFolderHash": h,
                    "registeredAt": datetime.datetime.now().isoformat(timespec="seconds"),
                    "autoDiscovered": True,
                }
                git_sources.setdefault(url, []).append(name)
                known.add(name)
                break

    # ---- 计算本地哈希
    local_dirs = {n: os.path.join(SKILLS, n) for n in os.listdir(SKILLS) if os.path.isdir(os.path.join(SKILLS, n))} if os.path.isdir(SKILLS) else {}
    local_hashes = tree_hashes(local_dirs)

    updated: list[str] = []
    restored: list[str] = []
    uptodate = 0
    removed: list[str] = []
    backups: list[str] = []
    upstream_info: list[str] = []

    # ---- 处理 git 来源技能
    handled: set[str] = set()
    for url, names in sorted(git_sources.items()):
        if url not in mirror_state:
            upstream_info.append(f"  {slug_for(url):45s} 不可用")
            continue
        commit, branch = mirror_state[url]
        upstream_info.append(f"  {slug_for(url):45s} {branch}@{commit[:12]}")
        mirror = mirror_path(url)
        for name in sorted(names):
            handled.add(name)
            destination = os.path.join(SKILLS, name)
            if os.path.islink(destination) or (os.path.lexists(destination) and local_hashes.get(name) is None):
                errors.append(f"{name}: 本地目录不可读取或为符号链接，未覆盖")
                continue
            meta = lock.get(name) or reg["extraGitSkills"].get(name) or {}
            folder = meta.get("folder") or os.path.dirname(meta.get("skillPath") or f"skills/{name}/SKILL.md")
            up = tree_of(mirror, commit, folder)
            if up is None:
                removed.append(name)
                continue
            local = local_hashes.get(name)
            if local == up:
                if meta.get("skillFolderHash") != up:
                    meta["skillFolderHash"] = up
                else:
                    uptodate += 1
                continue
            # 需要更新
            if not args.dry_run:
                try:
                    if local is not None and local not in (meta.get("skillFolderHash"), up):
                        backups.append(backup(name, os.path.join(SKILLS, name), bid))
                    src = materialize(mirror, commit, folder)
                    sync_dir(src, os.path.join(SKILLS, name))
                    local_hashes[name] = up
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{name}: {exc}")
                    continue
            if local is not None and meta.get("skillFolderHash") == up:
                restored.append(name)
            else:
                updated.append(name)
            meta["skillFolderHash"] = up
            meta["updatedAt"] = datetime.datetime.now().isoformat(timespec="seconds")

    # ---- 处理包来源技能
    for name, meta in sorted(reg["packageSkills"].items()):
        handled.add(name)
        destination = os.path.join(SKILLS, name)
        if os.path.islink(destination) or (os.path.lexists(destination) and local_hashes.get(name) is None):
            errors.append(f"{name}: 本地目录不可读取或为符号链接，未覆盖")
            continue
        pkg = meta.get("package", name)
        pattern = os.path.expanduser(meta.get("skillDirGlob", ""))
        if meta.get("type") != "uv-tool" or not isinstance(pkg, str) or not pkg or pkg.startswith("-"):
            errors.append(f"{name}: 不支持的包来源配置")
            continue
        if not args.dry_run:
            try:
                r = run(["uv", "tool", "upgrade", pkg])
            except (OSError, subprocess.SubprocessError) as exc:
                errors.append(f"{name}: uv tool upgrade 失败: {exc}")
                continue
            if r.returncode != 0:
                errors.append(f"{name}: uv tool upgrade {pkg} 失败")
                continue
        matches = sorted(glob.glob(pattern))
        if not matches:
            errors.append(f"{name}: 未找到包内技能目录（{pattern}）")
            continue
        up = dir_hash(matches[0])
        local = local_hashes.get(name)
        if up is None:
            errors.append(f"{name}: 无法计算包内技能哈希")
            continue
        if local == up:
            meta["skillFolderHash"] = up
            uptodate += 1
            continue
        if not args.dry_run:
            try:
                if local is not None and local != meta.get("skillFolderHash"):
                    backups.append(backup(name, os.path.join(SKILLS, name), bid))
                sync_dir(matches[0], os.path.join(SKILLS, name))
                local_hashes[name] = up
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{name}: {exc}")
                continue
        updated.append(name)
        meta["skillFolderHash"] = up
        meta["updatedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
    if reg["packageSkills"]:
        upstream_info.append(f"  {'uv-tool 包':45s} {', '.join(sorted(reg['packageSkills']))}")

    # ---- 未纳管目录提示
    untracked = sorted(set(local_dirs) - handled)

    # ---- 落盘
    if not args.dry_run:
        write_json(LOCK, lock_doc)
        write_json(REGISTRY, reg)

    # ---- 报告
    total = len(handled)
    lines = [f"技能更新检查 — {stamp}" + ("（dry-run）" if args.dry_run else ""), "", "上游来源:"]
    lines.extend(sorted(upstream_info) or ["  （无）"])
    lines.append("")
    lines.append(
        f"共纳入 {total} 个技能：最新 {uptodate}，更新 {len(updated)}，还原 {len(restored)}，"
        f"上游已移除 {len(removed)}，错误 {len(errors)}"
    )
    if updated:
        lines += ["", f"{'待更新' if args.dry_run else '已更新'} ({len(updated)}):"] + [f"  - {n}" for n in sorted(updated)]
    if restored:
        lines += ["", f"{'待还原' if args.dry_run else '已还原'}（本地改动被覆盖）({len(restored)}):"] + [f"  - {n}" for n in sorted(restored)]
    if backups:
        lines += ["", f"更新前已备份 ({len(backups)}):"] + [f"  - {b}" for b in backups]
    if removed:
        lines += ["", f"上游已移除（本地保留）({len(removed)}):"] + [f"  - {n}" for n in sorted(removed)]
    if untracked:
        lines += ["", f"未纳管 ({len(untracked)}):"] + [f"  - {n}" for n in sorted(untracked)]
    if errors:
        lines += ["", "错误:"] + [f"  ! {e}" for e in errors]
    lines.append("")
    report = "\n".join(lines)
    with open(REPORT, "w", encoding="utf-8") as fh:
        fh.write(report)

    mode = "dry-run" if args.dry_run else "auto-update"
    with open(HISTORY, "a") as fh:
        fh.write(
            f"{stamp}  [{mode}]  checked={total} uptodate={uptodate} updated={len(updated)} "
            f"restored={len(restored)} removed={len(removed)} errors={len(errors)}\n"
        )
    write_json(
        STATUS,
        {
            "checkedAt": datetime.datetime.now().isoformat(timespec="seconds"),
            "mode": mode,
            "checked": total,
            "uptodate": uptodate,
            "updated": sorted(updated),
            "restored": sorted(restored),
            "removed": sorted(removed),
            "untracked": untracked,
            "backups": backups,
            "errors": errors,
        },
    )

    if updated or restored or errors:
        parts = []
        if updated:
            parts.append(f"更新 {len(updated)} 个技能")
        if restored:
            parts.append(f"还原 {len(restored)} 个")
        if errors:
            parts.append(f"错误 {len(errors)} 个")
        notify("技能已自动更新" if not args.dry_run else "技能更新可用", "；".join(parts))

    print(report)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
