import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "update-clis.py"
WRAPPER = ROOT / "update-pi-toolchain.py"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class Workspace(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pi-cli-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.state = self.root / "state"
        self.manifest = self.root / "tools.json"
        self.env = {
            "HOME": str(self.home),
            "XDG_STATE_HOME": str(self.state),
            "PATH": f"{self.bin}:{os.environ.get('PATH', '')}",
            "DBUS_SESSION_BUS_ADDRESS": "",
            "NO_COLOR": "1",
            "TERM": "dumb",
        }
        self.write_tools(
            [
                {"id": "alpha", "check": ["alpha", "--version"], "update": ["alpha", "update"], "timeout": 30},
                {"id": "beta", "check": ["beta", "--version"], "update": ["beta", "update"], "timeout": 30},
            ]
        )
        self.tool("alpha")
        self.tool("beta")

    def write_tools(self, tools):
        self.manifest.write_text(
            json.dumps({"version": 1, "tools": tools}, indent=2), encoding="utf-8"
        )

    def tool(self, name, update_code=0, output="", sleep=0, version_file=True):
        """Create a fake CLI with a version and an update subcommand."""
        path = self.bin / name
        version = self.state / f"{name}.version"
        version.parent.mkdir(parents=True, exist_ok=True)
        script = textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import pathlib, sys, time
            version = pathlib.Path({str(version)!r})
            if sys.argv[1:] == ["--version"]:
                print(version.read_text().strip() if version.exists() else {f"{name} 1.0"!r})
                raise SystemExit(0)
            if sys.argv[1:] == ["update"]:
                time.sleep({sleep})
                sys.stdout.write({output!r})
                if {update_code == 0 and version_file}:
                    version.write_text({f"{name} 2.0"!r})
                raise SystemExit({update_code})
            raise SystemExit(2)
            """
        )
        path.write_text(script, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(CLI), "--manifest", str(self.manifest), *args],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def status(self):
        return json.loads((self.state / "pi-toolchain-updates/status.json").read_text())

    def versions(self):
        result = {}
        for path in self.state.glob("*.version"):
            result[path.stem] = path.read_text().strip()
        return result


class CliUpdaterTests(Workspace):
    def test_default_manifest_lists_the_expected_tools(self):
        tools = module("cli_updater", CLI).load_manifest(ROOT / "tools.json")
        self.assertEqual({tool["id"] for tool in tools}, {"agent-desktop", "markitdown", "codegraph", "agy"})
        self.assertTrue(all(tool["enabled"] for tool in tools))
        agent = next(tool for tool in tools if tool["id"] == "agent-desktop")
        self.assertIn("--allow-scripts=agent-desktop", agent["update"])
        self.assertEqual(agent["link"]["path"], "~/.local/bin/agent-desktop")

    def test_updates_both_tools_and_reports_versions(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.versions(), {"alpha": "alpha 2.0", "beta": "beta 2.0"})
        status = self.status()
        self.assertEqual(status["mode"], "auto-update")
        self.assertEqual(status["updated"], ["alpha", "beta"])
        self.assertEqual(status["failed"], [])
        self.assertEqual(status["checked"], 2)
        self.assertIn("alpha", (self.state / "pi-toolchain-updates/last-report.txt").read_text())
        self.assertIn("checked=2 updated=2", (self.state / "pi-toolchain-updates/history.log").read_text())

    def test_dry_run_does_not_execute_updates(self):
        result = self.run_cli("--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.versions(), {})
        status = self.status()
        self.assertEqual(status["mode"], "dry-run")
        self.assertEqual([tool["status"] for tool in status["tools"]], ["dry-run", "dry-run"])
        self.assertIn("将运行", (self.state / "pi-toolchain-updates/last-report.txt").read_text())

    def test_failure_is_isolated_and_returns_nonzero(self):
        self.tool("alpha", update_code=3, output="alpha failed")
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.versions(), {"beta": "beta 2.0"})
        status = self.status()
        self.assertEqual(status["failed"], ["alpha"])
        self.assertEqual(status["updated"], ["beta"])
        self.assertIn("退出码 3", status["tools"][0]["error"])
        self.assertIn("alpha failed", status["tools"][0]["error"])

    def test_timeout_is_reported_and_other_tools_continue(self):
        self.tool("alpha", sleep=5)
        tools = json.loads(self.manifest.read_text())["tools"]
        tools[0]["timeout"] = 1
        self.write_tools(tools)
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.versions(), {"beta": "beta 2.0"})
        self.assertIn("超时", self.status()["tools"][0]["error"])

    def test_missing_command_is_a_failure(self):
        self.write_tools(
            [{"id": "absent", "check": ["absent-cli", "--version"], "update": ["absent-cli", "update"], "timeout": 30}]
        )
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.status()["tools"][0]["status"], "missing")
        self.assertIn("不在 PATH", self.status()["tools"][0]["error"])

    def test_only_filters_tools(self):
        result = self.run_cli("--only", "beta")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.versions(), {"beta": "beta 2.0"})
        self.assertEqual(self.status()["updated"], ["beta"])
        self.assertEqual(self.status()["checked"], 1)
        self.assertEqual(self.run_cli("--only", "unknown").returncode, 1)
        tools = json.loads(self.manifest.read_text())["tools"]
        tools[0]["enabled"] = False
        self.write_tools(tools)
        result = self.run_cli("--only", "alpha")
        self.assertEqual(result.returncode, 1)
        self.assertIn("已停用", result.stdout + result.stderr)

    def test_link_is_created_and_plain_files_are_not_overwritten(self):
        target = self.home / ".npm/bin/agent-desktop"
        target.parent.mkdir(parents=True)
        target.write_text("binary")
        link = self.home / ".local/bin/agent-desktop"
        self.tool("alpha")
        self.write_tools(
            [
                {
                    "id": "alpha",
                    "check": ["alpha", "--version"],
                    "update": ["alpha", "update"],
                    "link": {"target": str(target), "path": str(link)},
                    "timeout": 30,
                }
            ]
        )
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.resolve(), target.resolve())
        self.assertEqual(self.run_cli().returncode, 0)
        link.unlink()
        link.write_text("do not replace")
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(link.read_text(), "do not replace")
        self.assertIn("拒绝覆盖", self.status()["tools"][0]["error"])

    def test_lock_prevents_concurrent_run(self):
        lock = self.state / "pi-toolchain-updates/update.lock"
        lock.parent.mkdir(parents=True)
        with lock.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        self.assertIn("正在运行", result.stdout + result.stderr)
        self.assertEqual(self.versions(), {})

    def test_invalid_manifests_fail_before_running_tools(self):
        for value in [
            "{bad json",
            json.dumps([]),
            json.dumps({"version": 2, "tools": []}),
            json.dumps({"version": 1, "tools": [{"id": "a", "check": [], "update": ["a"], "timeout": 30}]}),
            json.dumps({"version": 1, "tools": [{"id": "a", "check": ["a"], "update": ["a"], "timeout": 0}]}),
            json.dumps({"version": 1, "tools": [{"id": "a", "check": ["a"], "update": ["a"], "timeout": 30, "extra": 1}]}),
            json.dumps({"version": 1, "tools": [{"id": "a", "check": ["a"], "update": ["a"], "timeout": 30, "link": {"target": "rel", "path": "~/.local/bin/a"}}]}),
        ]:
            with self.subTest(value=value):
                self.manifest.write_text(value)
                result = self.run_cli()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.versions(), {})

    def test_failure_output_is_sanitized(self):
        self.tool("alpha", update_code=1, output="\x1b[31mBearer SECRET\x1b[0m")
        result = self.run_cli()
        self.assertEqual(result.returncode, 1)
        error = self.status()["tools"][0]["error"]
        self.assertNotIn("\x1b", error)
        self.assertNotIn("SECRET", error)
        self.assertIn("Bearer [redacted]", error)


class WrapperTests(Workspace):
    def fake_script(self, name, code, record):
        path = self.root / name
        path.write_text(
            textwrap.dedent(
                f"""\
                #!/usr/bin/env python3
                import pathlib, sys
                pathlib.Path({str(record)!r}).write_text(" ".join(sys.argv[1:]))
                print({name!r})
                raise SystemExit({code})
                """
            ),
            encoding="utf-8",
        )
        path.chmod(0o755)
        return path

    def test_runs_both_components_even_when_the_first_fails(self):
        skills_record = self.root / "skills.args"
        tools_record = self.root / "tools.args"
        skills = self.fake_script("skills.py", 1, skills_record)
        tools = self.fake_script("tools.py", 0, tools_record)
        wrapper = module("wrapper", WRAPPER)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = wrapper.main([], skills_script=skills, tools_script=tools)
        self.assertEqual(code, 1)
        self.assertEqual(skills_record.read_text(), "")
        self.assertEqual(tools_record.read_text(), "")
        self.assertIn("更新未全部成功", output.getvalue())

    def test_dry_run_is_forwarded_to_both(self):
        skills_record = self.root / "skills.args"
        tools_record = self.root / "tools.args"
        skills = self.fake_script("skills.py", 0, skills_record)
        tools = self.fake_script("tools.py", 0, tools_record)
        wrapper = module("wrapper", WRAPPER)
        with contextlib.redirect_stdout(io.StringIO()):
            code = wrapper.main(["--dry-run"], skills_script=skills, tools_script=tools)
        self.assertEqual(code, 0)
        self.assertEqual(skills_record.read_text(), "--dry-run")
        self.assertEqual(tools_record.read_text(), "--dry-run")

    def test_only_flags_skip_the_other_component(self):
        skills = self.root / "skills-missing.py"
        tools = self.fake_script("tools.py", 0, self.root / "tools.args")
        wrapper = module("wrapper", WRAPPER)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(wrapper.main(["--tools-only"], skills_script=skills, tools_script=tools), 0)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(wrapper.main(["--skills-only"], skills_script=skills, tools_script=tools), 1)


if __name__ == "__main__":
    unittest.main()
