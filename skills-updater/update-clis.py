#!/usr/bin/env python3
"""Update the CLI tools declared in tools.json.

Each tool has an explicit argv check and update command; no shell is involved.
Failures are isolated, reported, and returned as a non-zero exit status.
"""
from __future__ import annotations

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

HOME = Path.home()
STATE = Path(
    os.environ.get("XDG_STATE_HOME", HOME / ".local/state")
) / "pi-toolchain-updates"
REPORT = STATE / "last-report.txt"
STATUS = STATE / "status.json"
HISTORY = STATE / "history.log"
LOCK = STATE / "update.lock"
MANIFEST = Path(__file__).resolve().parent / "tools.json"
FAILED = {"failed", "missing", "error"}
ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def clean(value: str) -> str:
    """Make subprocess output safe for the terminal and the report."""
    value = ANSI.sub("", value)
    value = CONTROL.sub("", value)
    value = re.sub(r"Bearer\s+[^\s\"']+", "Bearer [redacted]", value, flags=re.I)
    value = re.sub(
        r"((?:access_token|refresh_token|api[_-]?key|token)\s*[:=]\s*)[^\s\"']+",
        r"\1[redacted]",
        value,
        flags=re.I,
    )
    return value


def tail(value: str, limit: int = 2000) -> str:
    value = clean(value).strip()
    return value if len(value) <= limit else "…" + value[-limit:]


def first_line(value: str, limit: int = 200) -> str:
    for line in clean(value).splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return "(未知版本)"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".cli-state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_manifest(path: Path) -> list[dict]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取工具清单 {path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("工具清单必须是 version=1 的对象")
    tools = value.get("tools")
    if not isinstance(tools, list) or not tools:
        raise ValueError("工具清单 tools 必须是非空数组")
    seen: set[str] = set()
    result: list[dict] = []
    allowed = {"id", "enabled", "check", "update", "link", "timeout"}
    for index, item in enumerate(tools):
        where = f"tools[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where} 必须是对象")
        unknown = set(item) - allowed
        if unknown:
            raise ValueError(f"{where} 含未知字段: {', '.join(sorted(unknown))}")
        name = item.get("id")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", name):
            raise ValueError(f"{where}.id 非法")
        if name in seen:
            raise ValueError(f"工具 id 重复: {name}")
        seen.add(name)
        commands = {}
        for key in ("check", "update"):
            command = item.get(key)
            if (
                not isinstance(command, list)
                or not command
                or any(not isinstance(part, str) or not part for part in command)
            ):
                raise ValueError(f"{where}.{key} 必须是非空字符串数组")
            commands[key] = command
        timeout = item.get("timeout", 300)
        if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 3600:
            raise ValueError(f"{where}.timeout 必须是 1–3600 的整数")
        enabled = item.get("enabled", True)
        if not isinstance(enabled, bool):
            raise ValueError(f"{where}.enabled 必须是布尔值")
        link = item.get("link")
        if link is not None:
            if not isinstance(link, dict) or set(link) != {"target", "path"}:
                raise ValueError(f"{where}.link 必须只含 target 和 path")
            for key in ("target", "path"):
                value = link.get(key)
                if not isinstance(value, str) or not value:
                    raise ValueError(f"{where}.link.{key} 必须是非空字符串")
                expanded = Path(os.path.expanduser(value))
                if not expanded.is_absolute():
                    raise ValueError(f"{where}.link.{key} 必须是绝对路径或 ~ 路径")
        result.append(
            {
                "id": name,
                "enabled": enabled,
                "check": commands["check"],
                "update": commands["update"],
                "link": link,
                "timeout": timeout,
            }
        )
    return result


def command_env() -> dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "CI": "1",
            "NO_COLOR": "1",
            "TERM": "dumb",
            "npm_config_yes": "true",
            "npm_config_audit": "false",
            "npm_config_fund": "false",
        }
    )
    return env


def run(command: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=command_env(),
    )


def probe(command: list[str]) -> tuple[str | None, str | None]:
    if not shutil.which(command[0]):
        return None, "未安装或不在 PATH"
    try:
        result = run(command, 20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"版本检查失败: {type(exc).__name__}"
    output = (result.stdout or "") + "\n" + (result.stderr or "")
    if result.returncode != 0:
        return None, f"版本检查退出码 {result.returncode}: {tail(output, 300)}"
    return first_line(output), None


def ensure_link(link: dict[str, str]) -> None:
    target = Path(os.path.expanduser(link["target"]))
    path = Path(os.path.expanduser(link["path"]))
    if not target.exists():
        raise ValueError(f"链接目标不存在: {target}")
    if path.is_symlink():
        if path.resolve() == target.resolve():
            return
    elif path.exists():
        raise ValueError(f"链接位置是普通文件，拒绝覆盖: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.symlink_to(target)
    os.replace(temporary, path)


def notify(title: str, body: str) -> None:
    if shutil.which("notify-send") and os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        try:
            run(["notify-send", "-a", "Pi Toolchain Updates", title, body], 10)
        except (OSError, subprocess.TimeoutExpired):
            pass


def selected_tools(tools: list[dict], only: str | None) -> list[dict]:
    if not only:
        return [tool for tool in tools if tool["enabled"]]
    wanted = {value.strip() for value in only.split(",") if value.strip()}
    known = {tool["id"] for tool in tools}
    unknown = wanted - known
    if unknown:
        raise ValueError(f"未知工具: {', '.join(sorted(unknown))}")
    if not wanted:
        raise ValueError("--only 不能为空")
    selected = [tool for tool in tools if tool["id"] in wanted]
    disabled = [tool["id"] for tool in selected if not tool["enabled"]]
    if disabled:
        raise ValueError(f"工具已停用: {', '.join(sorted(disabled))}")
    return selected


def update_tool(tool: dict, dry_run: bool) -> dict:
    before, error = probe(tool["check"])
    row = {
        "id": tool["id"],
        "before": before,
        "after": before,
        "status": "error",
        "error": error,
        "updateCommand": tool["update"],
    }
    if error:
        row["status"] = "missing" if "未安装" in error else "error"
        return row
    if dry_run:
        row["status"] = "dry-run"
        return row
    try:
        result = run(tool["update"], tool["timeout"])
    except subprocess.TimeoutExpired:
        row["status"] = "failed"
        row["error"] = f"超时（{tool['timeout']} 秒）"
        return row
    except OSError as exc:
        row["status"] = "failed"
        row["error"] = f"无法启动更新命令: {exc}"
        return row
    output = (result.stdout or "") + "\n" + (result.stderr or "")
    if result.returncode != 0:
        row["status"] = "failed"
        row["error"] = f"退出码 {result.returncode}: {tail(output)}"
        return row
    after, error = probe(tool["check"])
    if error:
        row["status"] = "failed"
        row["error"] = f"更新后检查失败: {error}"
        return row
    row["after"] = after
    row["status"] = "updated" if before != after else "current"
    try:
        if tool["link"]:
            ensure_link(tool["link"])
    except (OSError, ValueError) as exc:
        row["status"] = "failed"
        row["error"] = f"更新成功但链接失败: {exc}"
    return row


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--dry-run", action="store_true", help="只检查版本，不执行更新")
    parser.add_argument("--only", help="只更新逗号分隔的工具 id")
    args = parser.parse_args(argv)

    STATE.mkdir(parents=True, exist_ok=True)
    # Lock across manual and timer runs. Do not unlink this inode.
    with LOCK.open("a") as lock_file:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("另一个 CLI 更新任务正在运行。", file=sys.stderr)
            return 1
        try:
            tools = load_manifest(args.manifest)
            tools = selected_tools(tools, args.only)
        except ValueError as exc:
            print(f"CLI 更新配置错误: {exc}", file=sys.stderr)
            return 1
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        rows: list[dict] = []
        for tool in tools:
            row = update_tool(tool, args.dry_run)
            rows.append(row)
            change = (
                f"{row['before']} → {row['after']}"
                if row["before"] and row["after"] and row["before"] != row["after"]
                else row["after"] or row["before"] or "(未知)"
            )
            print(f"[{row['id']}] {row['status']}: {change}")
            if row["error"]:
                print(f"  ! {row['error']}", file=sys.stderr)

        failed = [row for row in rows if row["status"] in FAILED]
        updated = [row for row in rows if row["status"] == "updated"]
        current = [row for row in rows if row["status"] == "current"]
        dry = [row for row in rows if row["status"] == "dry-run"]
        mode = "dry-run" if args.dry_run else "auto-update"
        summary = f"共 {len(rows)} 个工具："
        if dry:
            summary += f"待运行 {len(dry)}，"
        summary += f"更新 {len(updated)}，最新 {len(current)}，失败 {len(failed)}"
        lines = [
            f"CLI 更新检查 — {stamp}" + ("（dry-run）" if args.dry_run else ""),
            "",
            summary,
        ]
        for row in rows:
            if row["status"] == "dry-run":
                lines.append(f"  - {row['id']}: {row['before']}（将运行: {' '.join(row['updateCommand'])}）")
            elif row["status"] in FAILED:
                lines.append(f"  ! {row['id']}: {row['error']}")
            elif row["status"] == "updated":
                lines.append(f"  - {row['id']}: {row['before']} → {row['after']}")
        report = "\n".join(lines) + "\n"
        with REPORT.open("w", encoding="utf-8") as handle:
            handle.write(report)
        with HISTORY.open("a", encoding="utf-8") as handle:
            handle.write(
                f"{stamp}  [{mode}]  checked={len(rows)} updated={len(updated)} "
                f"current={len(current)} failed={len(failed)}\n"
            )
        write_json(
            STATUS,
            {
                "checkedAt": datetime.datetime.now().isoformat(timespec="seconds"),
                "mode": mode,
                "checked": len(rows),
                "updated": [row["id"] for row in updated],
                "current": [row["id"] for row in current],
                "failed": [row["id"] for row in failed],
                "tools": rows,
            },
        )
        if updated or failed:
            parts = []
            if updated:
                parts.append(f"更新 {len(updated)} 个: {', '.join(row['id'] for row in updated)}")
            if failed:
                parts.append(f"失败 {len(failed)} 个: {', '.join(row['id'] for row in failed)}")
            notify("CLI 更新完成" if not failed else "CLI 更新需要处理", "；".join(parts))
        print(report, end="")
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
