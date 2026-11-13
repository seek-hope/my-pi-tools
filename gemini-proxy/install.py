#!/usr/bin/env python3
"""Install the CLIProxyAPI user service and helper links from this repository.

Existing configuration and OAuth state are never overwritten. The service is
installed as a user unit, so no root access is required.
"""
from __future__ import annotations

import argparse
import datetime
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOME = Path.home()
BIN = HOME / ".local/bin"
CONFIG = HOME / ".config/cliproxyapi"
UNIT_DIR = HOME / ".config/systemd/user"
UNIT = UNIT_DIR / "cliproxyapi.service"
LAUNCHD_DIR = HOME / "Library/LaunchAgents"
LAUNCHD_LABEL = "com.my-pi-tools.cliproxyapi"
LAUNCHD_PLIST = LAUNCHD_DIR / f"{LAUNCHD_LABEL}.plist"
LAUNCHD_TEMPLATE = ROOT / "launchd/com.my-pi-tools.cliproxyapi.plist"
LAUNCHD_UPDATE_LABEL = "com.my-pi-tools.cliproxyapi-update"
LAUNCHD_UPDATE_PLIST = LAUNCHD_DIR / f"{LAUNCHD_UPDATE_LABEL}.plist"
LAUNCHD_UPDATE_TEMPLATE = ROOT / "launchd/com.my-pi-tools.cliproxyapi-update.plist"

LINKS = {
    "cliproxy-pi-sync": ROOT / "bin/cliproxy-pi-sync",
    "cliproxy-antigravity-login": ROOT / "bin/cliproxy-antigravity-login",
    "update-cliproxyapi": ROOT / "update.py",
    "update-cliproxyapi-scheduled": ROOT / "bin/update-cliproxyapi-scheduled",
}


def run(args: list[str]) -> bool:
    try:
        return subprocess.run(args, check=False).returncode == 0
    except FileNotFoundError:
        return False


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


def install_launchd(dry_run: bool, stamp: str, no_timer: bool) -> int:
    if not shutil.which("launchctl"):
        print("warning: launchctl is unavailable; launchd agents were not installed", file=sys.stderr)
        return 1
    LAUNCHD_DIR.mkdir(parents=True, exist_ok=True)
    agents = [(LAUNCHD_PLIST, LAUNCHD_TEMPLATE)]
    if not no_timer:
        agents.append((LAUNCHD_UPDATE_PLIST, LAUNCHD_UPDATE_TEMPLATE))
    for plist, template in agents:
        backup = None
        if plist.exists() or plist.is_symlink():
            backup = plist.with_name(f"{plist.name}.bak-{stamp}")
            print(f"backup  {plist} -> {backup}")
            if not dry_run:
                plist.rename(backup)
        else:
            print(f"write   {plist}")
        if dry_run:
            continue
        text = template.read_text().replace("__HOME__", str(HOME))
        plist.write_text(text)
        os.chmod(plist, 0o644)
        label = plist.stem
        if not run(["plutil", "-lint", str(plist)]):
            print(f"warning: invalid plist: {plist}", file=sys.stderr)
            if backup:
                plist.unlink(missing_ok=True)
                backup.rename(plist)
            return 1
        uid = os.getuid()
        run(["launchctl", "bootout", f"gui/{uid}/{label}"])
        time.sleep(1)
        loaded = False
        for _ in range(3):
            if run(["launchctl", "bootstrap", f"gui/{uid}", str(plist)]):
                loaded = True
                break
            time.sleep(1.5)
        if not loaded:
            print(f"warning: launchctl bootstrap failed for {label}; restoring previous agent", file=sys.stderr)
            plist.unlink(missing_ok=True)
            if backup:
                backup.rename(plist)
                run(["launchctl", "bootout", f"gui/{uid}/{label}"])
                time.sleep(1)
                run(["launchctl", "bootstrap", f"gui/{uid}", str(plist)])
            return 1
        run(["launchctl", "enable", f"gui/{uid}/{label}"])
    if dry_run:
        print("service skipped in dry-run")
        return 0
    uid = os.getuid()
    if not run(["launchctl", "kickstart", "-k", f"gui/{uid}/{LAUNCHD_LABEL}"]):
        print("warning: launchctl kickstart failed", file=sys.stderr)
        return 1
    print(f"service {LAUNCHD_LABEL} bootstrapped and running")
    if not no_timer:
        print(f"timer {LAUNCHD_UPDATE_LABEL} loaded (daily 09:00 + 0-10 min)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="show changes only")
    parser.add_argument("--no-service", action="store_true", help="do not reload/enable the service")
    parser.add_argument("--no-timer", action="store_true", help="do not install the daily macOS updater")
    args = parser.parse_args()
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

    BIN.mkdir(parents=True, exist_ok=True)
    CONFIG.mkdir(parents=True, exist_ok=True)
    if sys.platform != "darwin":
        UNIT_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(CONFIG, 0o700)

    config = CONFIG / "config.yaml"
    example = ROOT / "config.example.yaml"
    if not config.exists():
        print(f"config  create {config} from template (edit it before use)")
        if not args.dry_run:
            shutil.copy2(example, config)
            os.chmod(config, 0o600)
    else:
        print(f"keep    {config}")

    if sys.platform != "darwin":
        link(ROOT / "systemd/cliproxyapi.service", UNIT, args.dry_run, stamp)
    for name, source in LINKS.items():
        link(source, BIN / name, args.dry_run, stamp)

    binary = BIN / "cliproxyapi"
    if not binary.exists():
        print("warning: cliproxyapi is missing; run update-cliproxyapi or install the release first")
    else:
        print(f"binary  {binary} -> {os.path.realpath(binary)}")

    if args.no_service:
        print("service skipped")
        return 0
    if sys.platform == "darwin":
        return install_launchd(args.dry_run, stamp, args.no_timer)
    if args.dry_run:
        print("service skipped in dry-run")
        return 0
    if not run(["systemctl", "--user", "daemon-reload"]):
        print("warning: systemctl --user is unavailable; unit was linked but not reloaded", file=sys.stderr)
        return 0
    if not run(["systemctl", "--user", "enable", "--now", "cliproxyapi.service"]):
        print("warning: could not enable/start cliproxyapi.service", file=sys.stderr)
        return 1
    # Reload the unit after replacing a hand-written unit file.
    run(["systemctl", "--user", "restart", "cliproxyapi.service"])
    print("service cliproxyapi.service enabled and running")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
