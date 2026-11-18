import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class MacRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pi-macos-runtime-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.source = self.home / "Desktop/my-pi-tools/skills-updater"
        self.runtime = self.home / ".local/share/my-pi-tools"
        self.source.mkdir(parents=True)
        spec = importlib.util.spec_from_file_location("mac_installer", ROOT / "install_macos.py")
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)
        self.sources = {
            name: self.source / path.relative_to(ROOT)
            for name, path in self.installer.LINKS.items()
        }
        for name, path in self.sources.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / path.relative_to(self.source), path)
            if name in ("check-agent-skills", "update-clis"):
                path.write_text(f"#!/usr/bin/env python3\nprint({name!r})\n")
                path.chmod(0o755)
        (self.source / "tools.json").write_text('{"version":1,"tools":[]}\n')
        proxy = self.source.parent / "gemini-proxy/update.py"
        proxy.parent.mkdir()
        proxy.write_text("#!/usr/bin/env python3\nprint('proxy updater')\n")
        proxy.chmod(0o755)
        (proxy.parent / "config.yaml").write_text("private: do-not-deploy\n")
        self.patcher = patch.multiple(
            self.installer, ROOT=self.source, LINKS=self.sources, RUNTIME=self.runtime
        )
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def deploy(self, dry_run=False):
        with contextlib.redirect_stdout(io.StringIO()):
            return self.installer.deploy_runtime(dry_run)

    def test_deploys_only_required_files_outside_desktop(self):
        links = self.deploy()
        self.assertEqual(set(links), set(self.sources) | {"update-cliproxyapi"})
        files = {str(p.relative_to(self.runtime)) for p in self.runtime.rglob("*") if p.is_file()}
        self.assertEqual(files, {
            "skills-updater/check-agent-skills.py", "skills-updater/update-clis.py",
            "skills-updater/update-pi-toolchain.py", "skills-updater/tools.json",
            "skills-updater/bin/update-pi-toolchain-scheduled", "gemini-proxy/update.py",
        })
        for name, path in links.items():
            self.assertNotIn("Desktop", str(path))
            self.assertTrue(path.is_file(), name)
            self.assertTrue(os.access(path, os.X_OK), name)
        self.assertEqual(self.runtime.stat().st_mode & 0o777, 0o700)

    def test_dry_run_does_not_create_runtime_or_links(self):
        links = self.deploy(dry_run=True)
        destination = self.home / ".local/bin/update-pi-toolchain"
        with contextlib.redirect_stdout(io.StringIO()):
            self.installer.link(links["update-pi-toolchain"], destination, True, "test")
        self.assertFalse(self.runtime.exists())
        self.assertFalse(destination.parent.exists())
        launchd = self.home / "Library/LaunchAgents"
        with patch.multiple(self.installer, LAUNCHD=launchd, PLIST=launchd / "timer.plist"), \
                patch.object(self.installer.shutil, "which", return_value="/bin/launchctl"), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.installer.install_timer(True, "test"), 0)
        self.assertFalse(launchd.exists())

    def test_reinstall_refreshes_changed_source_and_keeps_other_files(self):
        links = self.deploy()
        keep = self.runtime / "operator-note.txt"
        keep.write_text("keep")
        self.sources["update-clis"].write_text("#!/usr/bin/env python3\nprint('new')\n")
        self.deploy()
        self.assertEqual(links["update-clis"].read_text(), self.sources["update-clis"].read_text())
        self.assertEqual(keep.read_text(), "keep")
        before = links["update-clis"].stat().st_ino
        self.deploy()
        self.assertEqual(links["update-clis"].stat().st_ino, before)

    def test_runtime_works_when_source_repository_is_unavailable(self):
        links = self.deploy()
        self.source.parent.rename(self.source.parent.with_name("repository-unavailable"))
        result = subprocess.run(
            [sys.executable, str(links["update-pi-toolchain"]), "--dry-run"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("check-agent-skills", result.stdout)
        self.assertIn("update-clis", result.stdout)
        self.assertIn("更新完成", result.stdout)

    def test_invalid_plist_keeps_existing_timer_loaded_and_restores_file(self):
        launchd = self.home / "Library/LaunchAgents"
        launchd.mkdir(parents=True)
        plist = launchd / "timer.plist"
        plist.write_text("previous timer")
        with patch.multiple(self.installer, HOME=self.home, LAUNCHD=launchd, PLIST=plist), \
                patch.object(self.installer.shutil, "which", return_value="/bin/launchctl"), \
                patch.object(self.installer, "run", return_value=subprocess.CompletedProcess([], 1)) as run, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = self.installer.install_timer(False, "test")
        self.assertEqual(result, 1)
        self.assertEqual(plist.read_text(), "previous timer")
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][:2], ["plutil", "-lint"])

    def test_duplicate_proxy_timer_removed_only_after_successful_install(self):
        for exit_code in (0, 1):
            calls = []
            with self.subTest(exit_code=exit_code), \
                    patch.object(sys, "argv", ["install_macos.py", "--dry-run"]), \
                    patch.object(sys, "platform", "darwin"), \
                    patch.object(self.installer, "deploy_runtime", return_value={}), \
                    patch.object(self.installer, "install_timer", side_effect=lambda *args: calls.append("install") or exit_code), \
                    patch.object(self.installer, "remove_duplicate_proxy_timer", side_effect=lambda *args: calls.append("remove")), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(self.installer.main(), exit_code)
            self.assertEqual(calls, ["install", "remove"] if exit_code == 0 else ["install"])

    def test_runtime_symlink_is_rejected(self):
        outside = self.home / "outside"
        outside.mkdir()
        self.runtime.parent.mkdir(parents=True)
        self.runtime.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(SystemExit, "symlink"):
            self.deploy()
        self.assertEqual(list(outside.iterdir()), [])

    def test_failed_copy_leaves_existing_runtime_file_intact(self):
        links = self.deploy()
        destination = links["check-agent-skills"]
        before = destination.read_bytes()
        self.sources["check-agent-skills"].write_text("changed")
        with patch.object(self.installer.shutil, "copy2", side_effect=OSError("copy failed")):
            with self.assertRaisesRegex(OSError, "copy failed"):
                self.deploy()
        self.assertEqual(destination.read_bytes(), before)
        self.assertFalse(list(destination.parent.glob(".deploy-*")))


if __name__ == "__main__":
    unittest.main()
