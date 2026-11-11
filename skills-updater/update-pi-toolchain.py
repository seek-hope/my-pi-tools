#!/usr/bin/env python3
"""Run the skill and CLI updaters in order, keeping their failures independent."""
from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SKILLS = ROOT / "check-agent-skills.py"
TOOLS = ROOT / "update-clis.py"


def run_component(label: str, script: Path, args: list[str]) -> int:
    print(f"=== {label} ===", flush=True)
    if not script.is_file():
        print(f"找不到更新脚本: {script}", file=sys.stderr)
        return 1
    try:
        return subprocess.run(
            [sys.executable, str(script), *args],
            stdin=subprocess.DEVNULL,
            check=False,
        ).returncode
    except OSError as exc:
        print(f"无法启动 {label}: {exc}", file=sys.stderr)
        return 1


def main(
    argv: list[str] | None = None,
    *,
    skills_script: Path = SKILLS,
    tools_script: Path = TOOLS,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="只检查，不执行更新")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--skills-only", action="store_true", help="只更新技能")
    group.add_argument("--tools-only", action="store_true", help="只更新 CLI 工具")
    args = parser.parse_args(argv)

    extra = ["--dry-run"] if args.dry_run else []
    results: list[tuple[str, int]] = []
    if not args.tools_only:
        results.append(("技能", run_component("技能更新", skills_script, extra)))
    if not args.skills_only:
        results.append(("CLI", run_component("CLI 更新", tools_script, extra)))
    failed = [name for name, code in results if code != 0]
    if failed:
        print(f"更新未全部成功: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("更新完成。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
