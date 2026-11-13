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

LINKS = {
    "cliproxy-pi-sync": ROOT / "bin/cliproxy-pi-sync",
    "cliproxy-antigravity-login": ROOT / "bin/cliproxy-antigravity-login",
    "update-cliproxyapi": ROOT / "update.py",
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


def install_launchd(dry_run: bool, stamp: str) -> int:
    if not shutil.which("launchctl"):
        print("warning: launchctl is unavailable; plist was not installed", file=sys.stderr)
        return 1
    LAUNCHD_DIR.mkdir(parents=True, exist_ok=True)
    if LAUNCHD_PLIST.exists() or LAUNCHD_PLIST.is_symlink():
        backup = LAUNCHD_PLIST.with_name(f"{LAUNCHD_PLIST.name}.bak-{stamp}")
        print(f"backup  {LAUNCHD_PLIST} -> {backup}")
        if not dry_run:
            LAUNCHD_PLIST.rename(backup)
    else:
        print(f"write   {LAUNCHD_PLIST}")
    if dry_run:
        print("service skipped in dry-run")
        return 0
    text = LAUNCHD_TEMPLATE.read_text().replace("__HOME__", str(HOME))
    LAUNCHD_PLIST.write_text(text)
    os.chmod(LAUNCHD_PLIST, 0o644)
    uid = os.getuid()
    run(["launchctl", "bootout", f"gui/{uid}/{LAUNCHD_LABEL}"])  # idempotent
    if not run(["launchctl", "bootstrap", f"gui/{uid}", str(LAUNCHD_PLIST)]):
        print("warning: launchctl bootstrap failed; inspect the plist and log", file=sys.stderr)
        return 1
    run(["launchctl", "enable", f"gui/{uid}/{LAUNCHD_LABEL}"])
    if not run(["launchctl", "kickstart", "-k", f"gui/{uid}/{LAUNCHD_LABEL}"]):
        print("warning: launchctl kickstart failed", file=sys.stderr)
        return 1
    print(f"service {LAUNCHD_LABEL} bootstrapped and running")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="show changes only")
    parser.add_argument("--no-service", action="store_true", help="do not reload/enable systemd")
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
        return install_launchd(args.dry_run, stamp)
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
