#!/usr/bin/env python3
"""Check or update CLIProxyAPI from upstream GitHub releases.

The updater keeps versioned releases under ~/.local/opt/cliproxyapi, switches
the `current` and `~/.local/bin/cliproxyapi` symlinks atomically, verifies the
published SHA-256 checksum, and restarts the user service. A failed install
restores the previous symlinks and service.

Usage:
    update-cliproxyapi --check
    update-cliproxyapi --dry-run
    update-cliproxyapi [--no-restart] [--force]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = "router-for-me/CLIProxyAPI"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
HOME = Path.home()
OPT = HOME / ".local/opt/cliproxyapi"
CURRENT = OPT / "current"
BIN_LINK = HOME / ".local/bin/cliproxyapi"
SERVICE = "cliproxyapi.service"
LAUNCHD_LABEL = "com.my-pi-tools.cliproxyapi"
LAUNCHD_PLIST = HOME / "Library/LaunchAgents" / f"{LAUNCHD_LABEL}.plist"


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=False)


def current_version() -> str | None:
    if not BIN_LINK.exists():
        return None
    result = run([str(BIN_LINK), "--version"])
    match = re.search(r"CLIProxyAPI Version:\s*([0-9][0-9A-Za-z.\-]*)",
                      result.stdout + result.stderr)
    return match.group(1) if match else None


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "my-pi-tools-cliproxy-updater"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def platform_tag() -> tuple[str, str]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    os_name = {"linux": "linux", "darwin": "darwin"}.get(system)
    arch = {
        "x86_64": "amd64", "amd64": "amd64",
        "aarch64": "aarch64", "arm64": "aarch64",
    }.get(machine)
    if not os_name or not arch:
        raise SystemExit(f"unsupported platform: {system}/{machine}")
    return os_name, arch


def release_info() -> tuple[str, dict[str, str]]:
    data = fetch_json(API)
    tag = str(data.get("tag_name", "")).strip()
    version = tag.lstrip("v")
    if not version:
        raise SystemExit("latest release has no tag_name")
    assets = {asset["name"]: asset["browser_download_url"] for asset in data.get("assets", [])}
    return version, assets


def asset_name(version: str) -> str:
    os_name, arch = platform_tag()
    return f"CLIProxyAPI_{version}_{os_name}_{arch}.tar.gz"


def download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "my-pi-tools-cliproxy-updater"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)


def verify_checksum(checksums_url: str, filename: str, archive: Path) -> None:
    text = urllib.request.urlopen(
        urllib.request.Request(checksums_url, headers={"User-Agent": "my-pi-tools-cliproxy-updater"}),
        timeout=30,
    ).read().decode("utf-8")
    expected = None
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].lstrip("*") == filename:
            expected = parts[0].lower()
            break
    if not expected:
        raise SystemExit(f"checksum for {filename} not found")
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"checksum mismatch for {filename}: {actual} != {expected}")


def safe_extract(archive: Path, destination: Path) -> Path:
    with tarfile.open(archive, "r:gz") as tar:
        root = destination.resolve()
        for member in tar.getmembers():
            target = (destination / member.name).resolve()
            if root not in target.parents and target != root:
                raise SystemExit(f"unsafe archive path: {member.name}")
            if member.issym() or member.islnk():
                raise SystemExit(f"archive links are not allowed: {member.name}")
        try:
            tar.extractall(destination, filter="data")
        except TypeError:
            # Python < 3.12 has no extraction filter; paths were checked above.
            tar.extractall(destination)
    binary = next((p for p in destination.rglob("cli-proxy-api") if p.is_file()), None)
    if not binary:
        raise SystemExit("archive does not contain cli-proxy-api")
    return binary.parent


def replace_symlink(link: Path, target: Path) -> None:
    temporary = link.with_name(link.name + ".tmp")
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(target)
    os.replace(temporary, link)


def restart_service() -> None:
    if sys.platform == "darwin":
        if not shutil.which("launchctl"):
            raise SystemExit("launchctl is unavailable")
        uid = os.getuid()
        target = f"gui/{uid}/{LAUNCHD_LABEL}"
        if run(["launchctl", "kickstart", "-k", target]).returncode != 0:
            # Bootstrap once if the agent was not installed yet.
            run(["launchctl", "bootstrap", f"gui/{uid}", str(LAUNCHD_PLIST)])
            result = run(["launchctl", "kickstart", "-k", target])
            if result.returncode != 0:
                raise SystemExit((result.stderr or result.stdout or "launchd restart failed").strip())
        return
    if not shutil.which("systemctl"):
        print("warning: systemctl not found; service was not restarted", file=sys.stderr)
        return
    result = run(["systemctl", "--user", "restart", SERVICE])
    if result.returncode != 0:
        raise SystemExit((result.stderr or result.stdout or "service restart failed").strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="print installed version only")
    parser.add_argument("--dry-run", action="store_true", help="show the latest version without installing")
    parser.add_argument("--no-restart", action="store_true", help="do not restart the systemd service")
    parser.add_argument("--force", action="store_true", help="install even when already current")
    args = parser.parse_args()

    installed = current_version()
    if args.check:
        if not installed:
            print("cliproxyapi is not installed", file=sys.stderr)
            return 1
        print(installed)
        return 0

    version, assets = release_info()
    filename = asset_name(version)
    if filename not in assets:
        raise SystemExit(f"release asset not found: {filename}")
    if installed == version and not args.force:
        print(f"up-to-date: {version}")
        return 0
    if args.dry_run:
        print(f"installed: {installed or '(none)'}\nlatest: {version}\nasset: {assets[filename]}")
        return 0

    checksums = assets.get("checksums.txt")
    if not checksums:
        raise SystemExit("release has no checksums.txt")
    with tempfile.TemporaryDirectory(prefix="cliproxy-update-") as temporary:
        work = Path(temporary)
        archive = work / filename
        print(f"downloading CLIProxyAPI {version}")
        download(assets[filename], archive)
        verify_checksum(checksums, filename, archive)
        extracted = work / "extracted"
        extracted.mkdir()
        root = safe_extract(archive, extracted)

        target = OPT / version
        staging = OPT / f".{version}.tmp"
        OPT.mkdir(parents=True, exist_ok=True)
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        for item in root.iterdir():
            if item.is_file():
                shutil.copy2(item, staging / item.name)
        os.chmod(staging / "cli-proxy-api", 0o755)
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)

        old_current = os.readlink(CURRENT) if CURRENT.is_symlink() else None
        old_bin = os.readlink(BIN_LINK) if BIN_LINK.is_symlink() else None
        try:
            replace_symlink(CURRENT, target)
            replace_symlink(BIN_LINK, CURRENT / "cli-proxy-api")
            if not args.no_restart:
                restart_service()
        except BaseException:
            if old_current:
                replace_symlink(CURRENT, Path(old_current))
            if old_bin:
                replace_symlink(BIN_LINK, Path(old_bin))
            if not args.no_restart:
                try:
                    restart_service()
                except BaseException:
                    pass
            raise
        print(f"installed {version} -> {target}")
        if not args.no_restart:
            print(f"restarted {LAUNCHD_LABEL if sys.platform == 'darwin' else SERVICE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
