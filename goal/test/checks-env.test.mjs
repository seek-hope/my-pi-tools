import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VERIFICATION,
  EnvironmentError,
  environmentSignature,
  normalizeVerification,
  probeEnvironment,
  runCheck,
  sandboxArgs,
  sensitiveMaskArgs,
  verificationKey,
  verificationSummary,
} from '../src/checks.ts';
import { overlayAvailable } from './sandbox-capability.mjs';

test('verification environment normalizes defaults, deduplicates names and rejects invalid values', () => {
  assert.deepEqual(normalizeVerification(undefined), DEFAULT_VERIFICATION);
  assert.deepEqual(normalizeVerification({}), DEFAULT_VERIFICATION);
  assert.deepEqual(
    normalizeVerification({ workspace: 'ephemeral', network: 'host', env: ['PATH', 'PATH'] }),
    { workspace: 'ephemeral', network: 'host', env: ['PATH'] },
  );
  for (const value of [
    'readonly',
    [],
    { workspace: 'rw' },
    { network: 'offline' },
    { env: ['1BAD'] },
    { env: Array.from({ length: 33 }, () => 'PATH') },
    { extra: true },
  ])
    assert.throws(() => normalizeVerification(value), /verification|Verification/);
});
test('verification identity is order-insensitive and summaries expose every capability', () => {
  assert.equal(
    verificationKey({ workspace: 'readonly', network: 'host', env: ['B', 'A'] }),
    verificationKey({ workspace: 'readonly', network: 'host', env: ['A', 'B'] }),
  );
  assert.notEqual(
    verificationKey({ workspace: 'readonly', network: 'host', env: [] }),
    verificationKey({ workspace: 'readonly', network: 'isolated', env: [] }),
  );
  assert.equal(
    verificationSummary({ workspace: 'ephemeral', network: 'host', env: ['PATH'] }),
    'workspace: ephemeral writable snapshot; network: host network; environment variables: PATH; host filesystem: read-only, with sensitive home paths masked',
  );
});
test('sandbox composition keeps the host workspace read-only and isolates undeclared capabilities', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-sandbox-args-'));
  const home = mkdtempSync(join(tmpdir(), 'goal-sandbox-home-'));
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.npmrc'), '');
  try {
    const readonly = sandboxArgs(cwd, DEFAULT_VERIFICATION, 'true', home);
    assert.ok(readonly.includes('--unshare-all'));
    assert.equal(readonly.includes('--share-net'), false);
    assert.deepEqual(readonly.slice(-8), [
      '--chdir',
      cwd,
      '--',
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      'true',
    ]);
    assert.deepEqual(readonly.slice(-11, -8), ['--ro-bind', cwd, cwd]);
    assert.ok(readonly.includes('--overlay-src') === false);
    const ephemeral = sandboxArgs(
      cwd,
      { workspace: 'ephemeral', network: 'host', env: [] },
      'make',
      home,
    );
    assert.ok(ephemeral.includes('--share-net'));
    assert.ok(ephemeral.includes('--overlay-src'));
    assert.ok(ephemeral.includes('--tmp-overlay'));
    assert.equal(ephemeral.at(-1), 'make');
    assert.ok(ephemeral.includes('--ro-bind'));
    assert.equal(ephemeral[ephemeral.indexOf('--ro-bind') + 1], '/');
    assert.equal(ephemeral[ephemeral.indexOf('--overlay-src') + 1], cwd);
    assert.equal(ephemeral[ephemeral.indexOf('--tmp-overlay') + 1], cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
test('sensitive home paths are masked inside the sandbox', () => {
  const home = mkdtempSync(join(tmpdir(), 'goal-mask-'));
  try {
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.npmrc'), '');
    const root = realpathSync(home);
    assert.deepEqual(sensitiveMaskArgs(home), [
      '--tmpfs',
      join(root, '.ssh'),
      '--ro-bind',
      '/dev/null',
      join(root, '.npmrc'),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('failure signatures only suggest changes for capabilities the environment withheld', () => {
  assert.match(
    environmentSignature('curl: (6) Could not resolve host: example.com', DEFAULT_VERIFICATION, 6),
    /network/,
  );
  assert.equal(
    environmentSignature(
      'Could not resolve host: example.com',
      { ...DEFAULT_VERIFICATION, network: 'host' },
      6,
    ),
    undefined,
  );
  assert.match(
    environmentSignature(
      '/bin/sh: 1: cannot create out: Read-only file system',
      DEFAULT_VERIFICATION,
      2,
    ),
    /ephemeral/,
  );
  assert.equal(
    environmentSignature(
      'Read-only file system',
      { ...DEFAULT_VERIFICATION, workspace: 'ephemeral' },
      2,
    ),
    undefined,
  );
  assert.match(
    environmentSignature('cc: command not found', DEFAULT_VERIFICATION, 127),
    /not found/,
  );
  assert.match(
    environmentSignature(
      'exec: "clang": executable file not found in $PATH',
      DEFAULT_VERIFICATION,
      1,
    ),
    /not found/,
  );
  assert.equal(environmentSignature('1 test failed', DEFAULT_VERIFICATION, 1), undefined);
});
test(
  'real sandbox honors the declared environment and never writes the host workspace',
  { skip: !overlayAvailable },
  async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'goal-sandbox-env-'));
    const server = createServer((socket) => socket.end());
    t.after(() => {
      server.close();
      rmSync(cwd, { recursive: true, force: true });
    });
    writeFileSync(join(cwd, 'result.txt'), 'complete\n');
    const readonly = await runCheck(cwd, {
      id: 'K1',
      command: 'echo tampered > result.txt',
    });
    assert.notEqual(readonly.exitCode, 0);
    assert.equal(readonly.failure, 'environment');
    assert.match(readonly.hint, /ephemeral/);
    assert.equal(readFileSync(join(cwd, 'result.txt'), 'utf8'), 'complete\n');
    const ephemeral = await runCheck(
      cwd,
      { id: 'K2', command: 'echo built > build.out && cat build.out' },
      undefined,
      { workspace: 'ephemeral', network: 'isolated', env: [] },
    );
    assert.equal(ephemeral.exitCode, 0, ephemeral.output);
    assert.match(ephemeral.output, /built/);
    assert.equal(readFileSync(join(cwd, 'result.txt'), 'utf8'), 'complete\n');
    assert.throws(() => readFileSync(join(cwd, 'build.out')), /ENOENT/);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const connect = `python3 -c 'import socket; s=socket.create_connection(("127.0.0.1", ${port}), timeout=1); s.close(); print("connected")'`;
    const isolated = await runCheck(cwd, { id: 'K3', command: connect }, undefined, {
      workspace: 'ephemeral',
      network: 'isolated',
      env: [],
    });
    assert.notEqual(isolated.exitCode, 0);
    assert.equal(isolated.failure, 'environment');
    const host = await runCheck(cwd, { id: 'K4', command: connect }, undefined, {
      workspace: 'readonly',
      network: 'host',
      env: [],
    });
    assert.equal(host.exitCode, 0, host.output);
    assert.match(host.output, /connected/);
    process.env.GOAL_SANDBOX_FIXTURE = 'visible';
    t.after(() => delete process.env.GOAL_SANDBOX_FIXTURE);
    const variables = await runCheck(
      cwd,
      {
        id: 'K5',
        command: 'printf "%s" "${GOAL_SANDBOX_FIXTURE:-missing}"',
      },
      undefined,
      { workspace: 'readonly', network: 'isolated', env: ['GOAL_SANDBOX_FIXTURE'] },
    );
    assert.equal(variables.exitCode, 0, variables.output);
    assert.equal(variables.output, 'visible');
    const hidden = await runCheck(cwd, {
      id: 'K6',
      command: 'printf "%s" "${GOAL_SANDBOX_FIXTURE:-missing}"',
    });
    assert.equal(hidden.output, 'missing');
    assert.deepEqual(await probeEnvironment(cwd, DEFAULT_VERIFICATION), { ok: true });
  },
);
test(
  'sandbox start failures are environment errors, not implementation failures',
  { skip: process.platform === 'linux' },
  async () => {
    await assert.rejects(
      runCheck(process.cwd(), { id: 'K1', command: 'true' }),
      (error) => error instanceof EnvironmentError && /bubblewrap|Linux/.test(error.message),
    );
  },
);
