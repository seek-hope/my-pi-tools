#!/usr/bin/env python3
"""Install the Pi skills/CLI updater links and the macOS launchd timer."""
from __future__ import annotations

import argparse
import datetime
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOME = Path.home()
BIN = HOME / ".local/bin"
STATE = HOME / ".local/state/scientific-skills-check"
LAUNCHD = HOME / "Library/LaunchAgents"
LABEL = "com.my-pi-tools.update-pi-toolchain"
PLIST = LAUNCHD / f"{LABEL}.plist"
TEMPLATE = ROOT / "launchd/com.my-pi-tools.update-pi-toolchain.plist"
LINKS = {
    "check-agent-skills": ROOT / "check-agent-skills.py",
    "update-clis": ROOT / "update-clis.py",
    "update-pi-toolchain": ROOT / "update-pi-toolchain.py",
    "update-pi-toolchain-scheduled": ROOT / "bin/update-pi-toolchain-scheduled",
}


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def link(source: Path, target: Path, dry_run: bool, stamp: str) -> None:
    source = source.resolve()
    if not source.exists():
        raise SystemExit(f"missing source: {source}")
    if target.is_symlink() and target.resolve() == source:
        print(f"ok      {target}")
        return
    if target.exists() or target.is_symlink():
        backup = target.with_name(f"{target.name}.bak-{stamp}")
        print(f"backup  {target} -> {backup}")
        if not dry_run:
            target.rename(backup)
    else:
        print(f"link    {target} -> {source}")
    if not dry_run:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(source)


def install_timer(dry_run: bool, stamp: str) -> int:
    if not shutil.which("launchctl"):
        print("warning: launchctl is unavailable", file=sys.stderr)
        return 1
    LAUNCHD.mkdir(parents=True, exist_ok=True)
    backup = None
    if PLIST.exists() or PLIST.is_symlink():
        backup = PLIST.with_name(f"{PLIST.name}.bak-{stamp}")
        print(f"backup  {PLIST} -> {backup}")
        if not dry_run:
            PLIST.rename(backup)
    print(f"write   {PLIST}")
    if dry_run:
        print("timer skipped in dry-run")
        return 0
    PLIST.write_text(TEMPLATE.read_text().replace("__HOME__", str(HOME)))
    os.chmod(PLIST, 0o644)
    if not run(["plutil", "-lint", str(PLIST)]):
        print("warning: invalid plist", file=sys.stderr)
        PLIST.unlink(missing_ok=True)
        if backup:
            backup.rename(PLIST)
        return 1
    uid = os.getuid()
    run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"])
    time.sleep(1)
    loaded = False
    for _ in range(3):
        if run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST)]).returncode == 0:
            loaded = True
            break
        time.sleep(1.5)
    if not loaded:
        print("warning: launchctl bootstrap failed; restoring previous timer", file=sys.stderr)
        PLIST.unlink(missing_ok=True)
        if backup:
            backup.rename(PLIST)
            run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"])
            time.sleep(1)
            run(["launchctl", "bootstrap", f"gui/{uid}", str(PLIST)])
        return 1
    run(["launchctl", "enable", f"gui/{uid}/{LABEL}"])
    print(f"timer {LABEL} loaded (daily 09:00 + 0-10 min)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="show changes only")
    parser.add_argument("--no-timer", action="store_true", help="install links without the launchd timer")
    args = parser.parse_args()
    if sys.platform != "darwin":
        print("this installer is for macOS; use install.py on Linux", file=sys.stderr)
        return 2
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    BIN.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)
    for name, source in LINKS.items():
        link(source, BIN / name, args.dry_run, stamp)
    print(f"state   {STATE}")
    if args.no_timer:
        print("timer skipped")
        return 0
    return install_timer(args.dry_run, stamp)


if __name__ == "__main__":
    raise SystemExit(main())
