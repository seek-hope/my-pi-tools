import datetime as dt
import importlib.util
import os
from pathlib import Path
import plistlib
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load('macos-run')
installer = load('install_macos')


class MacosModelUpdateTest(unittest.TestCase):
    def test_wake_outside_window_is_skipped_and_delay_stays_within_window(self):
        self.assertIsNone(runner.delay_for_window(dt.datetime(2026, 11, 19, 19, 59)))
        self.assertIsNone(runner.delay_for_window(dt.datetime(2026, 11, 19, 22)))
        self.assertEqual(runner.delay_for_window(dt.datetime(2026, 11, 19, 20)), 7199)
        self.assertEqual(runner.delay_for_window(dt.datetime(2026, 11, 19, 21, 59, 59)), 0)

    def test_job_uses_unprotected_runtime_and_has_no_credentials_or_run_at_load(self):
        home = Path('/Users/example')
        job = installer.job_for(home, home / '.local/share/my-pi-tools/models-updater', home / '.local/state/pi-model-updates')
        encoded = plistlib.dumps(job)
        self.assertEqual(job['StartCalendarInterval'], {'Hour': 20, 'Minute': 0})
        self.assertFalse(job['RunAtLoad'])
        self.assertEqual(job['ProgramArguments'][-1], '--scheduled')
        self.assertNotIn(b'Desktop', encoded)
        self.assertNotIn(b'API_KEY', encoded)

    def test_local_credentials_never_override_environment_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'orca-api-key'
            p.write_text('existing-mac-key\n', encoding='utf8')
            p.chmod(0o600)
            env = {'ORCA_API_KEY': 'precedence'}
            runner.load_env(p.parent, env)
            self.assertEqual(env, {'ORCA_API_KEY': 'precedence'})
            env = {}
            runner.load_env(p.parent, env)
            self.assertEqual(env['ORCA_API_KEY'], 'existing-mac-key')
            p.chmod(0o644)
            with self.assertRaises(ValueError):
                runner.load_env(p.parent, {})
            p.rename(p.with_name('credential-elsewhere'))
            os.symlink('credential-elsewhere', p)
            with self.assertRaises(OSError):
                runner.load_env(p.parent, {})


if __name__ == '__main__':
    unittest.main()
