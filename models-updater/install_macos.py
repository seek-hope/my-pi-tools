#!/usr/bin/env python3
"""Install the model sync command and a per-user launchd schedule."""
import argparse
import fcntl
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
LABEL = 'com.my-pi-tools.check-pi-models'
FILES = ('macos-run.py', 'check-models.mjs', 'sync-models.mjs')


def job_for(home, runtime, state):
    return {
        'Label': LABEL,
        'ProgramArguments': ['/usr/bin/python3', str(runtime / 'macos-run.py'), '--scheduled'],
        'WorkingDirectory': str(home),
        'EnvironmentVariables': {'PATH': f'{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
        'StartCalendarInterval': {'Hour': 20, 'Minute': 0},
        'RunAtLoad': False,
        'ProcessType': 'Background',
        'StandardOutPath': '/dev/null',
        'StandardErrorPath': str(state / 'launchd.err.log'),
    }


def save(path, data, mode):
    fd, tmp = tempfile.mkstemp(prefix='.model-sync-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            os.fchmod(f.fileno(), mode)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def launchctl(*args, check=True):
    return subprocess.run(['/bin/launchctl', *args], check=check, capture_output=True, timeout=20)


def install(home, dry_run=False):
    runtime = home / '.local/share/my-pi-tools/models-updater'
    state = home / '.local/state/pi-model-updates'
    agent = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    entry = home / '.local/bin/check-pi-models'
    runner = runtime / 'macos-run.py'
    job = job_for(home, runtime, state)
    if dry_run:
        print(f'{agent} -> {runner}; local time 20:00–22:00')
        return
    domain = f'gui/{os.getuid()}'
    launchctl('print', domain)
    for directory in (runtime, state, entry.parent, agent.parent):
        if directory.is_symlink():
            raise ValueError(f'Refusing symlink directory: {directory}')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    runtime.chmod(0o700)
    if (entry.exists() or entry.is_symlink()) and not (entry.is_symlink() and entry.resolve() == runner):
        raise ValueError(f'Refusing to replace existing command: {entry}')
    previous = agent.read_bytes() if agent.is_file() and not agent.is_symlink() else None
    if agent.is_symlink() or (agent.exists() and (previous is None or plistlib.loads(previous).get('Label') != LABEL)):
        raise ValueError(f'Refusing to replace unrecognized agent: {agent}')
    log = state / 'launchd.err.log'
    log_fd = os.open(log, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.close(log_fd)
    fd = os.open(state / 'update.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old_files = {name: (runtime / name).read_bytes() if (runtime / name).is_file() else None for name in FILES}
        data = plistlib.dumps(job)
        was_enabled = launchctl('print', f'{domain}/{LABEL}', check=False).returncode == 0
        if was_enabled:
            launchctl('bootout', f'{domain}/{LABEL}')
        made_entry = False
        try:
            for name in FILES:
                save(runtime / name, (ROOT / name).read_bytes(), 0o700 if name == 'macos-run.py' else 0o600)
            if not entry.is_symlink():
                entry.symlink_to(runner)
                made_entry = True
            save(agent, data, 0o600)
            subprocess.run(['/usr/bin/plutil', '-lint', str(agent)], check=True, capture_output=True)
            launchctl('enable', f'{domain}/{LABEL}')
            launchctl('bootstrap', domain, str(agent))
        except BaseException:
            launchctl('bootout', f'{domain}/{LABEL}', check=False)
            if previous is None:
                agent.unlink(missing_ok=True)
            else:
                save(agent, previous, 0o600)
            for name, old in old_files.items():
                if old is None:
                    (runtime / name).unlink(missing_ok=True)
                else:
                    save(runtime / name, old, 0o700 if name == 'macos-run.py' else 0o600)
            if made_entry:
                entry.unlink(missing_ok=True)
            if was_enabled and previous is not None:
                launchctl('bootstrap', domain, str(agent), check=False)
            raise
    print(f'{LABEL}: installed; daily 20:00–22:00. Run {entry} --sync to update now.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('macOS required')
    install(Path.home(), dry_run=args.dry_run)
