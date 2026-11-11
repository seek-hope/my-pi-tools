#!/usr/bin/env python3
"""Link the repository-managed updater and user systemd units into this account."""
from __future__ import annotations

import argparse
import datetime
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent


def paths(home: Path):
    config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    state = Path(os.environ.get("XDG_STATE_HOME", home / ".local/state"))
    return {
        home / ".local/bin/check-agent-skills": ROOT / "check-agent-skills.py",
        home / ".local/bin/update-clis": ROOT / "update-clis.py",
        home / ".local/bin/update-pi-toolchain": ROOT / "update-pi-toolchain.py",
        config / "systemd/user/check-agent-skills.service": ROOT / "systemd/check-agent-skills.service",
        config / "systemd/user/check-agent-skills.timer": ROOT / "systemd/check-agent-skills.timer",
    }, state / "scientific-skills-check"


def systemctl(*args, check=True):
    return subprocess.run(["systemctl", "--user", *args], check=check, timeout=30,
                          capture_output=True, text=True)


def linked_to(destination: Path, source: Path) -> bool:
    return destination.is_symlink() and destination.resolve() == source.resolve()


def replace_link(destination: Path, source: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".skill-install-", dir=destination.parent) as directory:
        link = Path(directory) / "link"
        link.symlink_to(source)
        os.replace(link, destination)


def install(home: Path, *, no_systemd=False, dry_run=False) -> Path | None:
    targets, state = paths(home)
    for destination, source in targets.items():
        if not source.is_file():
            raise FileNotFoundError(source)
        if destination.is_dir() and not destination.is_symlink():
            raise ValueError(f"目标为目录，拒绝覆盖: {destination}")
    for script in ("check-agent-skills.py", "update-clis.py", "update-pi-toolchain.py"):
        if not os.access(ROOT / script, os.X_OK):
            raise ValueError(f"{script} 必须有可执行权限")
    if dry_run:
        for destination, source in targets.items():
            print(f"{destination} -> {source}")
        print("仅预览；未修改文件或 systemd 状态。")
        return None

    state.mkdir(parents=True, exist_ok=True)
    with (state / "update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        timer_active = False
        timer = next(path for path in targets if path.name == "check-agent-skills.timer")
        enable_link = timer.parent / "timers.target.wants" / timer.name
        if not no_systemd and enable_link.exists() and not enable_link.is_symlink():
            raise ValueError(f"启用入口不是符号链接，拒绝覆盖: {enable_link}")
        previous_enable_link = os.readlink(enable_link) if enable_link.is_symlink() else None
        activation_attempted = False
        changes = []
        backup = None
        if not no_systemd:
            # Probe the manager before changing any files; a missing user bus is an error.
            systemctl("show-environment")
            timer_active = systemctl("is-active", "check-agent-skills.timer", check=False).returncode == 0
        try:
            if not no_systemd:
                if timer_active:
                    systemctl("stop", "check-agent-skills.timer")
                service = systemctl("show", "check-agent-skills.service", "--property=ActiveState", "--value").stdout.strip()
                if service not in ("inactive", "failed"):
                    raise RuntimeError("技能更新服务仍在运行，请等其结束后再安装。")
            pending = [(dst, src) for dst, src in targets.items() if not linked_to(dst, src)]
            if pending:
                backup_root = state / "install-backups"
                backup_root.mkdir(exist_ok=True)
                stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-")
                backup = Path(tempfile.mkdtemp(prefix=stamp, dir=backup_root))
                # Complete all backups before changing any live entry point.
                for destination, _ in pending:
                    if destination.exists() or destination.is_symlink():
                        shutil.copy2(destination, backup / destination.name, follow_symlinks=False)
                for destination, source in pending:
                    saved = backup / destination.name
                    changes.append((destination, saved if saved.exists() or saved.is_symlink() else None))
                    replace_link(destination, source)
            if not no_systemd:
                systemctl("daemon-reload")
                activation_attempted = True
                systemctl("enable", "--now", "check-agent-skills.timer")
        except BaseException:
            # The shipped unit has only WantedBy=timers.target. Restore that
            # enablement link directly: `disable` may also delete external unit
            # symlinks, including an old timer that we are trying to restore.
            if activation_attempted:
                if previous_enable_link is None:
                    enable_link.unlink(missing_ok=True)
                else:
                    replace_link(enable_link, Path(previous_enable_link))
            for destination, saved in reversed(changes):
                if saved is None:
                    destination.unlink(missing_ok=True)
                elif saved.is_symlink():
                    # Keep a relative old link relative to its original directory.
                    replace_link(destination, Path(os.readlink(saved)))
                else:
                    with tempfile.TemporaryDirectory(prefix=".skill-restore-", dir=destination.parent) as directory:
                        restored = Path(directory) / "original"
                        shutil.copy2(saved, restored)
                        os.replace(restored, destination)
            if not no_systemd:
                systemctl("daemon-reload", check=False)
                systemctl("start" if timer_active else "stop", "check-agent-skills.timer", check=False)
            raise

    for destination, source in targets.items():
        print(f"{destination} -> {source}")
    if backup:
        print(f"原入口备份: {backup}")
    print("链接已安装；尚未加载 systemd。" if no_systemd else "每日技能与 CLI 更新定时器已启用；未主动执行更新。")
    return backup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="仅显示安装目标，不修改文件")
    parser.add_argument("--no-systemd", action="store_true", help="仅安装链接，不调用 systemctl")
    args = parser.parse_args()
    try:
        install(Path.home(), no_systemd=args.no_systemd, dry_run=args.dry_run)
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"安装失败: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
