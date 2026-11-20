import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pi-model-install-")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.env = patch.dict(os.environ, {
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_STATE_HOME": str(self.home / ".local/state"),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        spec = importlib.util.spec_from_file_location("model_installer", ROOT / "install.py")
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)

    def install(self, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            self.installer.install(self.home, **kwargs)

    def test_dry_run_does_not_create_home_or_contact_systemd(self):
        with patch.object(self.installer, "systemctl", side_effect=AssertionError("must not contact systemd")):
            self.install(dry_run=True)
        self.assertFalse(self.home.exists())

    def test_idempotent_links_and_no_personal_model_configuration(self):
        self.install(no_systemd=True)
        command = self.home / ".local/bin/check-pi-models"
        self.assertEqual(command.resolve(), ROOT / "bin/check-pi-models")
        self.assertFalse((self.home / ".pi").exists())
        before = command.lstat().st_ino
        self.install(no_systemd=True)
        self.assertEqual(command.lstat().st_ino, before)
        self.assertEqual(list((self.home / ".local/state/pi-model-updates/install-backups").iterdir()), [])

    def test_activation_failure_restores_plain_file_without_touching_repository(self):
        command = self.home / ".local/bin/check-pi-models"
        command.parent.mkdir(parents=True)
        command.write_text("previous command")
        source = (ROOT / "bin/check-pi-models").read_bytes()

        def ctl(*args, **kwargs):
            if args[:1] == ("enable",):
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0, "inactive\n" if args[:1] == ("show",) else "", "")

        with patch.object(self.installer, "systemctl", side_effect=ctl):
            with self.assertRaises(subprocess.CalledProcessError):
                self.install()
        self.assertFalse(command.is_symlink())
        self.assertEqual(command.read_text(), "previous command")
        self.assertEqual((ROOT / "bin/check-pi-models").read_bytes(), source)
        self.assertFalse((self.home / ".config/systemd/user/check-pi-models.timer").exists())

    def test_active_check_refuses_install_before_writing_anything(self):
        with patch.object(self.installer, "systemctl", return_value=subprocess.CompletedProcess([], 0, "active\n", "")):
            with self.assertRaisesRegex(RuntimeError, "仍在运行"):
                self.install()
        self.assertFalse(self.home.exists())

    def test_both_scheduled_tasks_start_only_inside_evening_window(self):
        for package, service in [("models-updater", "check-pi-models"), ("skills-updater", "check-agent-skills")]:
            root = ROOT.parent / package / "systemd"
            timer = (root / f"{service}.timer").read_text()
            self.assertIn("OnCalendar=*-*-* 20:00:00", timer)
            self.assertIn("RandomizedDelaySec=2h", timer)
            self.assertIn("Persistent=false", timer)
            unit = (root / f"{service}.service").read_text()
            condition = next(line.split("=", 1)[1] for line in unit.splitlines() if line.startswith("ExecCondition="))
            args = shlex.split(condition)
            expression = args[2]
            for hour in (0, 9, 19, 20, 21, 22, 23):
                result = subprocess.run([args[0], "-c", expression.replace("datetime.datetime.now().hour", str(hour))], check=False)
                self.assertEqual(result.returncode, 0 if 20 <= hour < 22 else 1)


if __name__ == "__main__":
    unittest.main()
