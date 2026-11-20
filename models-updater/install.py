#!/usr/bin/env python3
"""Install the local Pi model monitor and its daily user-level systemd timer."""
from __future__ import annotations

import argparse
import datetime
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
TIMER = "check-pi-models.timer"
SERVICE = "check-pi-models.service"


def systemctl(*args, check=True):
    return subprocess.run(["systemctl", "--user", *args], check=check,
                          capture_output=True, text=True, timeout=30)


def replace_link(destination: Path, target: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".model-install-", dir=destination.parent) as work:
        link = Path(work) / "link"
        link.symlink_to(target)
        os.replace(link, destination)


def install(home: Path, *, dry_run=False, no_systemd=False):
    config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    state = Path(os.environ.get("XDG_STATE_HOME", home / ".local/state")) / "pi-model-updates"
    targets = {
        home / ".local/bin/check-pi-models": ROOT / "bin/check-pi-models",
        config / "systemd/user" / SERVICE: ROOT / "systemd" / SERVICE,
        config / "systemd/user" / TIMER: ROOT / "systemd" / TIMER,
    }
    for destination, source in targets.items():
        if not source.is_file():
            raise FileNotFoundError(source)
        print(f"link {destination} -> {source}")
    if dry_run:
        return
    if not no_systemd:
        systemctl("show-environment")
        active = systemctl("show", SERVICE, "--property=ActiveState", "--value", check=False)
        if active.stdout.strip() not in ("", "inactive", "failed"):
            raise RuntimeError("模型检测仍在运行，请等其结束后再安装")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    enabled = config / "systemd/user/timers.target.wants" / TIMER
    previous_enabled = os.readlink(enabled) if enabled.is_symlink() else None
    pending = [(dst, src) for dst, src in targets.items()
               if not (dst.is_symlink() and dst.resolve() == src.resolve())]
    changes = []
    backup = None
    try:
        if pending:
            backup = state / "install-backups" / datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            backup.mkdir(parents=True, mode=0o700)
            for dst, src in pending:
                saved = None
                if dst.exists() or dst.is_symlink():
                    saved = backup / dst.name
                    shutil.copy2(dst, saved, follow_symlinks=False)
                changes.append((dst, saved))
                replace_link(dst, src)
        if not no_systemd:
            systemctl("daemon-reload")
            systemctl("enable", "--now", TIMER)
    except BaseException:
        if previous_enabled is None:
            enabled.unlink(missing_ok=True)
        else:
            replace_link(enabled, Path(previous_enabled))
        for dst, saved in reversed(changes):
            if saved is None:
                dst.unlink(missing_ok=True)
            elif saved.is_symlink():
                replace_link(dst, Path(os.readlink(saved)))
            else:
                with tempfile.TemporaryDirectory(prefix=".model-restore-", dir=dst.parent) as work:
                    staged = Path(work) / "original"
                    shutil.copy2(saved, staged)
                    os.replace(staged, dst)
        if not no_systemd:
            systemctl("daemon-reload", check=False)
        raise
    finally:
        if backup and not any(backup.iterdir()):
            backup.rmdir()
    print(f"state {state}")
    if not no_systemd:
        print("timer enabled: daily 20:00 + 0–2 hours; run check-pi-models to check immediately")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-systemd", action="store_true")
    args = parser.parse_args()
    if sys.platform != "linux" and not args.no_systemd:
        raise SystemExit("此安装器使用 Linux 用户级 systemd")
    install(Path.home(), dry_run=args.dry_run, no_systemd=args.no_systemd)


if __name__ == "__main__":
    main()
