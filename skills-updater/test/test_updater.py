import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def put_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class Workspace(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="skills-updater-test-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        env = {
            "HOME": str(self.home), "XDG_CACHE_HOME": str(self.home / ".cache"),
            "XDG_STATE_HOME": str(self.home / ".local/state"),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "DBUS_SESSION_BUS_ADDRESS": "", "GIT_TERMINAL_PROMPT": "0",
        }
        self.environment = patch.dict(os.environ, env)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.u = module("updater", ROOT / "check-agent-skills.py")
        self.i = module("installer", ROOT / "install.py")
        Path(self.u.SKILLS).mkdir(parents=True)
        put_json(self.u.REGISTRY, {"version": 1, "packageSkills": {}, "extraGitSkills": {}})
        put_json(self.u.LOCK, {"version": 3, "dismissed": {"keep": True}, "skills": {}})
        self.repo = Path(self.tmp.name) / "upstream"
        self.git("init", "-q", str(self.repo))
        self.git("-C", str(self.repo), "config", "user.email", "test@example.invalid")
        self.git("-C", str(self.repo), "config", "user.name", "Test")

    def git(self, *args):
        result = subprocess.run(["git", *args], check=True, capture_output=True, text=True)
        return result.stdout.strip()

    def upstream(self, name="example", text="upstream", folder=None):
        folder = folder or f"skills/{name}"
        directory = self.repo / folder
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(text)
        self.commit()
        return folder

    def commit(self):
        self.git("-C", str(self.repo), "add", "-A")
        self.git("-C", str(self.repo), "commit", "-qm", "fixture")

    def register(self, name="example", folder=None):
        folder = folder or f"skills/{name}"
        doc = json.loads(Path(self.u.LOCK).read_text())
        doc["skills"][name] = {
            "sourceUrl": self.repo.as_uri(), "skillPath": f"{folder}/SKILL.md",
            "skillFolderHash": self.git("-C", str(self.repo), "rev-parse", f"HEAD:{folder}"),
            "installedAt": "keep-this-timestamp",
        }
        put_json(self.u.LOCK, doc)
        return doc["skills"][name]["skillFolderHash"]

    def local(self, name="example", text="local"):
        directory = Path(self.u.SKILLS) / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(text)
        return directory

    def update(self, *args):
        stream = io.StringIO()
        with patch.object(sys, "argv", ["check-agent-skills", *args]), contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
            status = self.u.main()
        self.output = stream.getvalue()
        return status

    def status(self):
        return json.loads(Path(self.u.STATUS).read_text())


class UpdaterTests(Workspace):
    def test_hash_matches_upstream_and_ignores_python_cache(self):
        folder = self.upstream()
        expected = self.register()
        local = self.local(text="upstream")
        self.assertEqual(self.u.dir_hash(str(local)), expected)
        (local / "__pycache__").mkdir()
        (local / "__pycache__/module.pyc").write_bytes(b"cache")
        self.assertEqual(self.u.dir_hash(str(local)), expected)
        self.assertEqual(self.u.dir_hash(str(self.repo / folder)), expected)

    def test_update_restore_backup_and_unknown_lock_fields(self):
        self.upstream()
        self.register()
        local = self.local()
        self.assertEqual(self.update(), 0, self.output)
        self.assertEqual((local / "SKILL.md").read_text(), "upstream")
        report = self.status()
        self.assertEqual(report["restored"], ["example"])
        self.assertEqual((Path(report["backups"][0]) / "SKILL.md").read_text(), "local")
        doc = json.loads(Path(self.u.LOCK).read_text())
        self.assertEqual(doc["dismissed"], {"keep": True})
        self.assertEqual(doc["skills"]["example"]["installedAt"], "keep-this-timestamp")
        self.assertEqual(self.update(), 0, self.output)
        self.assertEqual(self.status()["uptodate"], 1)
        self.assertEqual(self.status()["backups"], [])

    def test_fetch_updates_and_missing_skills_are_reinstalled(self):
        self.upstream()
        self.register()
        self.assertEqual(self.update(), 0, self.output)
        self.assertEqual(self.status()["updated"], ["example"])
        self.upstream(text="new upstream")
        self.assertEqual(self.update(), 0, self.output)
        self.assertEqual((Path(self.u.SKILLS) / "example/SKILL.md").read_text(), "new upstream")
        self.assertEqual(self.status()["backups"], [])
        self.assertEqual(json.loads(Path(self.u.LOCK).read_text())["skills"]["example"]["skillFolderHash"], self.git("-C", str(self.repo), "rev-parse", "HEAD:skills/example"))

    def test_dry_run_only_changes_cache_and_reports(self):
        self.upstream()
        self.register()
        local = self.local()
        before = [Path(p).read_bytes() for p in (self.u.LOCK, self.u.REGISTRY)]
        self.assertEqual(self.update("--dry-run"), 0, self.output)
        self.assertEqual([Path(p).read_bytes() for p in (self.u.LOCK, self.u.REGISTRY)], before)
        self.assertEqual((local / "SKILL.md").read_text(), "local")
        self.assertEqual(self.status()["mode"], "dry-run")
        self.assertIn("待还原", self.output)
        self.assertFalse((Path(self.u.STATE) / "backups").exists())

    def test_removed_upstream_is_kept_and_unmanaged_is_reported(self):
        self.upstream()
        self.register()
        self.local(text="upstream")
        self.local("private", "private skill")
        shutil.rmtree(self.repo / "skills/example")
        (self.repo / "README.md").write_text("empty source")
        self.commit()
        self.assertEqual(self.update(), 0, self.output)
        self.assertEqual(self.status()["removed"], ["example"])
        self.assertEqual(self.status()["untracked"], ["private"])
        self.assertTrue((Path(self.u.SKILLS) / "example/SKILL.md").is_file())

    def test_autodiscovery_registers_only_existing_matching_directories(self):
        self.upstream()
        self.register()
        self.upstream("added")
        self.upstream("not-installed")
        self.local("added", "edited locally")
        self.assertEqual(self.update(), 0, self.output)
        extra = json.loads(Path(self.u.REGISTRY).read_text())["extraGitSkills"]
        self.assertEqual(set(extra), {"added"})
        self.assertTrue(extra["added"]["autoDiscovered"])
        self.assertEqual((Path(self.status()["backups"][0]) / "SKILL.md").read_text(), "edited locally")
        self.assertFalse((Path(self.u.SKILLS) / "not-installed").exists())

    def test_bad_source_returns_failure_without_losing_local_files(self):
        self.upstream()
        self.register()
        local = self.local()
        doc = json.loads(Path(self.u.LOCK).read_text())
        doc["skills"]["example"]["sourceUrl"] = (self.repo / "missing").as_uri()
        put_json(self.u.LOCK, doc)
        self.assertEqual(self.update(), 1)
        self.assertTrue(self.status()["errors"])
        self.assertEqual((local / "SKILL.md").read_text(), "local")

    def test_invalid_state_and_unsafe_paths_fail_before_network_or_mutation(self):
        self.upstream()
        self.register()
        for path, value in [
            (self.u.REGISTRY, "{bad json"),
            (self.u.REGISTRY, "[]"),
            (self.u.LOCK, json.dumps({"skills": {"../outside": {}}})),
            (self.u.LOCK, json.dumps({"skills": {"example": {"folder": "../../outside"}}})),
            (self.u.LOCK, json.dumps({"skills": {"example": {"folder": ".git"}}})),
        ]:
            with self.subTest(value=value):
                old = Path(path).read_text()
                Path(path).write_text(value)
                with patch.object(self.u, "sync_mirror", side_effect=AssertionError("No network")):
                    self.assertEqual(self.update(), 1)
                self.assertEqual(Path(path).read_text(), value)
                Path(path).write_text(old)

    def test_symlink_or_unhashable_skill_is_not_overwritten(self):
        self.upstream()
        self.register()
        outside = self.home / "elsewhere"
        outside.mkdir()
        (outside / "SKILL.md").write_text("keep")
        target = Path(self.u.SKILLS) / "example"
        target.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.update(), 1)
        self.assertEqual((outside / "SKILL.md").read_text(), "keep")
        target.unlink()
        self.local()
        with patch.object(self.u, "tree_hashes", return_value={"example": None}):
            self.assertEqual(self.update(), 1)
        self.assertEqual((target / "SKILL.md").read_text(), "local")

    def test_single_instance_lock(self):
        with (Path(self.u.STATE) / "update.lock").open("a") as guard:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.update(), 1)
            self.assertIn("正在运行", self.output)

    def test_failed_copy_or_publish_keeps_original_directory(self):
        src = self.local("source", "new")
        dst = self.local("target", "old")
        with patch.object(self.u.shutil, "copytree", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.u.sync_dir(str(src), str(dst))
        self.assertEqual((dst / "SKILL.md").read_text(), "old")
        rename = os.rename
        def fail_publish(source, destination):
            if Path(source).name == "incoming":
                raise OSError("rename failed")
            rename(source, destination)
        with patch.object(self.u.os, "rename", side_effect=fail_publish):
            with self.assertRaises(OSError):
                self.u.sync_dir(str(src), str(dst))
        self.assertEqual((dst / "SKILL.md").read_text(), "old")
        self.assertEqual(list(Path(self.u.SKILLS).glob(".skill-update-*")), [])

    def test_atomic_json_does_not_destroy_previous_state_on_error(self):
        before = Path(self.u.REGISTRY).read_bytes()
        with self.assertRaises(TypeError):
            self.u.write_json(self.u.REGISTRY, {"bad": object()})
        self.assertEqual(Path(self.u.REGISTRY).read_bytes(), before)

    def test_package_upgrade_sync_dry_run_and_failure(self):
        source = self.home / "package/example"
        source.mkdir(parents=True)
        (source / "SKILL.md").write_text("packaged")
        put_json(self.u.REGISTRY, {"packageSkills": {"example": {
            "type": "uv-tool", "package": "example-package", "skillDirGlob": str(source),
        }}, "extraGitSkills": {}})
        local = self.local()
        original = self.u.run
        calls = []
        def run(args, **kwargs):
            if args[0] == "uv":
                calls.append(args)
                return subprocess.CompletedProcess(args, 0)
            return original(args, **kwargs)
        with patch.object(self.u, "run", side_effect=run):
            self.assertEqual(self.update("--dry-run"), 0)
            self.assertEqual(calls, [])
            self.assertEqual(self.update(), 0, self.output)
            self.assertEqual(calls, [["uv", "tool", "upgrade", "example-package"]])
        self.assertEqual((local / "SKILL.md").read_text(), "packaged")
        (source / "SKILL.md").write_text("should not sync after failed upgrade")
        def fail(args, **kwargs):
            if args[0] == "uv":
                return subprocess.CompletedProcess(args, 1)
            return original(args, **kwargs)
        with patch.object(self.u, "run", side_effect=fail):
            self.assertEqual(self.update(), 1)
        self.assertEqual((local / "SKILL.md").read_text(), "packaged")


class InstallTests(Workspace):
    def test_dry_run_makes_no_changes(self):
        targets, state = self.i.paths(self.home)
        before = set(state.iterdir())
        with contextlib.redirect_stdout(io.StringIO()):
            self.i.install(self.home, dry_run=True)
        self.assertEqual(set(state.iterdir()), before)
        self.assertTrue(all(not p.exists() for p in targets))

    def test_install_links_backups_existing_files_and_is_idempotent(self):
        targets, state = self.i.paths(self.home)
        for dst in targets:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(f"old {dst.name}")
        before = [Path(p).read_bytes() for p in (self.u.LOCK, self.u.REGISTRY)]
        with contextlib.redirect_stdout(io.StringIO()):
            backup = self.i.install(self.home, no_systemd=True)
            self.assertIsNone(self.i.install(self.home, no_systemd=True))
        for dst, src in targets.items():
            self.assertTrue(self.i.linked_to(dst, src))
            self.assertEqual((backup / dst.name).read_text(), f"old {dst.name}")
        self.assertEqual([Path(p).read_bytes() for p in (self.u.LOCK, self.u.REGISTRY)], before)
        self.assertEqual(len(list((state / "install-backups").iterdir())), 1)

    def test_service_active_refuses_install_and_restores_timer(self):
        calls = []
        def ctl(*args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="activating\n" if args[0] == "show" else "")
        with patch.object(self.i, "systemctl", side_effect=ctl), self.assertRaises(RuntimeError):
            self.i.install(self.home)
        self.assertIn(("stop", "check-agent-skills.timer"), calls)
        self.assertIn(("start", "check-agent-skills.timer"), calls)
        self.assertTrue(all(not p.exists() for p in self.i.paths(self.home)[0]))

    def test_activation_failure_rolls_back_files_and_relative_links(self):
        targets, _ = self.i.paths(self.home)
        command = next(path for path in targets if path.name == "check-agent-skills")
        service = next(path for path in targets if path.name == "check-agent-skills.service")
        timer = next(path for path in targets if path.name == "check-agent-skills.timer")
        command.parent.mkdir(parents=True)
        command.write_text("old script")
        service.parent.mkdir(parents=True)
        service.symlink_to("relative-old-service")
        calls = []
        def ctl(*args, **kwargs):
            calls.append(args)
            if args[0] == "enable":
                raise subprocess.CalledProcessError(1, args)
            code = 1 if args[0] in ("is-active", "is-enabled") else 0
            return subprocess.CompletedProcess(args, code, stdout="inactive\n" if args[0] == "show" else "")
        with patch.object(self.i, "systemctl", side_effect=ctl), self.assertRaises(subprocess.CalledProcessError):
            self.i.install(self.home)
        self.assertEqual(command.read_text(), "old script")
        self.assertFalse(command.is_symlink())
        self.assertEqual(os.readlink(service), "relative-old-service")
        self.assertFalse(timer.exists())
        self.assertNotIn(("disable", "check-agent-skills.timer"), calls)
        self.assertIn(("stop", "check-agent-skills.timer"), calls)

    def test_failed_activation_preserves_old_external_timer_and_enablement(self):
        targets, _ = self.i.paths(self.home)
        timer = next(p for p in targets if p.name.endswith('.timer'))
        timer.parent.mkdir(parents=True)
        timer.symlink_to('/old/external/check-agent-skills.timer')
        enable = timer.parent / 'timers.target.wants' / timer.name
        enable.parent.mkdir()
        enable.symlink_to('../old-check-agent-skills.timer')
        def ctl(*args, **kwargs):
            if args[0] == 'enable':
                enable.unlink()
                enable.symlink_to(timer)
                raise subprocess.CalledProcessError(1, args)
            if args[0] == 'disable':
                timer.unlink()
                enable.unlink()
            code = 1 if args[0] == 'is-active' else 0
            return subprocess.CompletedProcess(args, code, stdout='inactive\n' if args[0] == 'show' else '')
        with patch.object(self.i, 'systemctl', side_effect=ctl), self.assertRaises(subprocess.CalledProcessError):
            self.i.install(self.home)
        self.assertEqual(os.readlink(timer), '/old/external/check-agent-skills.timer')
        self.assertEqual(os.readlink(enable), '../old-check-agent-skills.timer')

    def test_stop_timeout_restores_active_timer_before_propagating(self):
        calls = []
        def ctl(*args, **kwargs):
            calls.append(args)
            if args[0] == 'stop':
                raise subprocess.TimeoutExpired(args, 30)
            return subprocess.CompletedProcess(args, 0, stdout='')
        with patch.object(self.i, 'systemctl', side_effect=ctl), self.assertRaises(subprocess.TimeoutExpired):
            self.i.install(self.home)
        self.assertIn(('start', 'check-agent-skills.timer'), calls)
        self.assertTrue(all(not p.exists() for p in self.i.paths(self.home)[0]))

    def test_installs_tool_updater_and_wrapper_links(self):
        targets, _ = self.i.paths(self.home)
        names = {path.name for path in targets}
        self.assertTrue({"check-agent-skills", "update-clis", "update-pi-toolchain"}.issubset(names))
        service = (ROOT / "systemd/check-agent-skills.service").read_text()
        self.assertIn("ExecStart=/usr/bin/python3 %h/.local/bin/update-pi-toolchain", service)
        self.assertIn("TimeoutStartSec=1800", service)
        self.assertIn("%h/.local/share/pi-node/current/bin", service)
        self.assertIn("pi-toolchain-updates/last-report.txt", service)

    def test_systemd_install_does_not_explicitly_start_update_service(self):
        calls = []
        def ctl(*args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, stdout="inactive\n" if args[0] == "show" else "")
        with patch.object(self.i, "systemctl", side_effect=ctl), contextlib.redirect_stdout(io.StringIO()):
            self.i.install(self.home)
        self.assertIn(("daemon-reload",), calls)
        self.assertIn(("enable", "--now", "check-agent-skills.timer"), calls)
        self.assertNotIn(("start", "check-agent-skills.service"), calls)
        self.assertIn("OnCalendar=*-*-* 09:00:00", (ROOT / "systemd/check-agent-skills.timer").read_text())


if __name__ == "__main__":
    unittest.main()
