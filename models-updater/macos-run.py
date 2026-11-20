#!/usr/bin/python3
"""Run model sync with the same advisory lock for manual and launchd runs."""
import datetime as dt
import fcntl
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import sys
import time


def delay_for_window(now):
    if not 20 <= now.hour < 22:
        return None
    end = now.replace(hour=22, minute=0, second=0, microsecond=0)
    return max(0, int((end - now).total_seconds()) - 1)


def load_env(config, environ):
    for variable, filename in [('ORCA_API_KEY', 'orca-api-key'), ('KIMI_API_KEY', 'kimi-api-key')]:
        if environ.get(variable):
            continue
        try:
            fd = os.open(config / filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            continue
        with os.fdopen(fd, encoding='utf8') as handle:
            attrs = os.fstat(fd)
            if not stat.S_ISREG(attrs.st_mode) or attrs.st_uid != os.getuid() or attrs.st_mode & 0o077:
                raise ValueError(f'Unsafe mode or owner for {filename}')
            key = handle.read(8193).strip()
        if not key or len(key) > 8192 or any(c.isspace() or c == '\0' for c in key):
            raise ValueError(f'Invalid credential file: {filename}')
        environ[variable] = key


def main(args):
    os.umask(0o077)
    scheduled = args == ['--scheduled']
    if scheduled:
        start = dt.datetime.now()
        delay = delay_for_window(start)
        if delay is None:
            return 0  # launchd may deliver a missed trigger on wake.
        time.sleep(secrets.randbelow(delay + 1))
        now = dt.datetime.now()
        if now.date() != start.date() or delay_for_window(now) is None:
            return 0
        args = ['--sync']
    env = os.environ.copy()
    home = Path.home()
    state = Path(env.get('XDG_STATE_HOME', home / '.local/state')) / 'pi-model-updates'
    config = Path(env.get('XDG_CONFIG_HOME', home / '.config')) / 'pi-model-updates'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if state.is_symlink():
        raise ValueError('Model state directory cannot be a symlink')
    state.chmod(0o700)
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js not on PATH')
    script = Path(__file__).resolve().with_name('check-models.mjs')
    fd = os.open(state / 'update.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Model sync already running', file=sys.stderr)
            return 1
        load_env(config, env)
        return subprocess.run([node, str(script), *args], env=env, pass_fds=(fd,), timeout=180).returncode


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print('Model sync launcher failed; check Node.js, private config files, and timeout.', file=sys.stderr)
        sys.exit(1)
