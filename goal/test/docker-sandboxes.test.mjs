import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DockerSandboxes } from '../src/verification/docker-sandboxes.ts';
import { LeaseStore, disposeSandbox } from '../src/verification/leases.ts';
import { prepareVerification } from '../src/verification/pipeline.ts';
import { commandRunner, controlEnvironment } from '../src/verification/process.ts';
import { fixture, fakeSbx } from './sandbox-fixtures.mjs';

const goal = () => ({
  objective: 'test',
  kind: 'coding',
  criteria: [{ id: 'C1', text: 'passes' }],
  tasks: [],
  checks: [{ id: 'K1', command: 'echo "$HOME"; false' }],
  verification: { workspace: 'readonly', network: 'isolated', env: [] },
});
async function attempt(t, behavior = {}) {
  const f = await fixture(t);
  const fake = fakeSbx(behavior);
  const backend = new DockerSandboxes(f.settings, join(f.root, 'leases'), fake.run);
  const g = goal();
  const context = await prepareVerification(
    f.cwd,
    g,
    f.settings,
    backend.leases.root,
    undefined,
    backend,
  );
  t.after(() => context.finish(false).catch(() => {}));
  return { ...f, fake, backend, g, context };
}

test('checks and audit reruns get distinct mountless VMs with the same frozen identity', async (t) => {
  const h = await attempt(t);
  for (let i = 0; i < 2; i++) {
    const result = await h.context.check(h.g.checks[0]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.verification, h.context.identity);
  }
  const creates = h.fake.calls.filter((c) => c.args[0] === 'create');
  assert.equal(creates.length, 2);
  assert.notEqual(creates[0].args[2], creates[1].args[2]);
  for (const { args } of creates) {
    assert.equal(args.at(-1), 'shell');
    assert.ok(args.includes('**'));
    assert.equal(args.includes(h.cwd), false);
    assert.equal(args.includes('.'), false);
    assert.equal(args.includes('--clone'), false);
  }
  assert.deepEqual(await h.backend.leases.list(), []);
  assert.equal(h.fake.sandboxes.length, 0);
  await h.context.finish(true);
  await assert.rejects(access(h.context.cwd));
});

test('online checks scope outer rules to their VM and freeze the proxy policy', async (t) => {
  const { root, cwd, settings } = await fixture(t);
  const fake = fakeSbx();
  const backend = new DockerSandboxes(settings, join(root, 'leases'), fake.run);
  const g = goal();
  g.verification = {
    workspace: 'ephemeral',
    network: 'allowlist',
    allow: ['registry.npmjs.org:443'],
    deny: ['blocked.example.com'],
    env: [],
  };
  const context = await prepareVerification(
    cwd,
    g,
    settings,
    backend.leases.root,
    undefined,
    backend,
  );
  g.verification.allow.push('evil.example.org');
  try {
    await context.check(g.checks[0]);
    const policies = fake.calls.filter((c) => c.args[0] === 'policy');
    assert.ok(policies.length >= 4);
    for (const call of policies.filter((c) => c.args[1] !== 'ls'))
      assert.ok(call.args.includes('--sandbox'));
    assert.ok(policies.some((c) => c.args.includes('registry.npmjs.org:443')));
    assert.ok(!policies.some((c) => c.args.includes('evil.example.org')));
    assert.ok(policies.some((c) => c.args.includes('--id') && c.args.includes('deny-gate')));
    assert.deepEqual(await backend.leases.list(), []);
  } finally {
    await context.finish(false);
  }
});

test('open egress handles the real sbx conflicting-wildcard rule contract before project execution', async (t) => {
  const { root, cwd, settings } = await fixture(t);
  const fake = fakeSbx();
  const backend = new DockerSandboxes(settings, join(root, 'leases'), fake.run);
  const g = goal();
  g.verification = { ...g.verification, network: 'open', deny: ['blocked.example.com'] };
  const context = await prepareVerification(
    cwd,
    g,
    settings,
    backend.leases.root,
    undefined,
    backend,
  );
  try {
    assert.equal((await context.check(g.checks[0])).exitCode, 0);
  } finally {
    await context.finish(false);
  }
  assert.equal(fake.sandboxes.length, 0);
});

test('a transfer failure still removes the identified VM; no fallback execution', async (t) => {
  const h = await attempt(t, { copyError: true });
  await assert.rejects(h.context.check(h.g.checks[0]), /copy failed/);
  assert.equal(h.fake.sandboxes.length, 0);
  assert.ok(h.fake.calls.some((c) => c.args[0] === 'rm'));
  assert.equal(
    h.fake.calls.some((c) => c.args.includes('node')),
    false,
  );
});

test('cancellation cleanup uses an independent signal and confirms removal', async (t) => {
  const abort = new AbortController();
  const h = await attempt(t, {
    execute: async () => {
      abort.abort();
      throw new Error('cancelled');
    },
  });
  await assert.rejects(h.context.check(h.g.checks[0], abort.signal), /cancelled/);
  const cleanup = h.fake.calls.find((c) => c.args[0] === 'rm');
  assert.notEqual(cleanup.config.signal, abort.signal);
  assert.equal(cleanup.config.signal.aborted, false);
  assert.equal(h.fake.sandboxes.length, 0);
});

test('cleanup failure is durable and blocks new verification; exact-ID recovery succeeds', async (t) => {
  const options = { removeError: true };
  const h = await attempt(t, options);
  await assert.rejects(h.context.check(h.g.checks[0]), /cleanup pending/);
  const [lease] = await h.backend.leases.list();
  assert.equal(lease.phase, 'cleanup_pending');
  await assert.rejects(h.backend.doctor(), /Unreconciled/);
  options.removeError = false;
  assert.deepEqual(await h.backend.recover(), [lease.name]);
  await h.backend.doctor();
});

test('cleanup never deletes a sandbox with a replaced or unknown identity', async (t) => {
  const { root } = await fixture(t);
  const fake = fakeSbx();
  const store = new LeaseStore(join(root, 'leases'));
  const lease = {
    version: 1,
    name: `goal-${randomUUID()}`,
    id: 'old',
    createdAt: new Date().toISOString(),
    pid: process.pid,
    host: hostname(),
    phase: 'running',
  };
  fake.sandboxes.push({ name: lease.name, id: 'replacement' });
  await store.save(lease);
  await assert.rejects(disposeSandbox(lease, store, fake.run, 1000), /identity/);
  assert.equal(
    fake.calls.some((c) => c.args[0] === 'rm'),
    false,
  );
});

test('lost creation reply leaves an explicit pending intent instead of guessing ownership', async (t) => {
  const h = await attempt(t, { createError: true });
  await assert.rejects(h.context.check(h.g.checks[0]), /cleanup pending/);
  assert.equal((await h.backend.leases.list())[0].id, undefined);
  assert.equal(
    h.fake.calls.some((c) => c.args[0] === 'rm'),
    false,
  );
});

test('forged or incomplete supervisor output cannot become success', async (t) => {
  for (const result of [
    { version: 1, runId: 'wrong', kind: 'check', exitCode: 0, output: 'PASS', truncated: false },
    { version: 1, kind: 'check', exitCode: 0 },
  ]) {
    const h = await attempt(t, { execute: async ({ success }) => success(result) });
    await assert.rejects(h.context.check(h.g.checks[0]), /response|result/);
    assert.equal(h.fake.sandboxes.length, 0);
  }
});

test('auditor cannot ignore a failed rerun, or verify a different command/input generation', async (t) => {
  const h = await attempt(t, { exitCode: 2 });
  assert.equal((await h.context.check(h.g.checks[0])).exitCode, 2);
  await assert.rejects(h.context.check({ id: 'K1', command: 'true' }), /approved scope/);
  await assert.rejects(h.context.finish(true), /did not pass/);
  await assert.rejects(access(h.context.cwd));
  const newer = await attempt(t);
  await writeFile(join(newer.cwd, 'result.txt'), 'changed during audit');
  assert.equal(await readFile(join(newer.context.cwd, 'result.txt'), 'utf8'), 'original\n');
  await assert.rejects(newer.context.finish(true), /inputs changed/);
});

test('environment failures during audit reruns remain environment failures for either verdict', async (t) => {
  for (const passingVerdict of [false, true]) {
    let calls = 0;
    const h = await attempt(t, {
      execute: async ({ request, success }) =>
        success({
          version: 1,
          runId: request.runId,
          kind: 'check',
          truncated: false,
          exitCode: calls++ === 0 ? 0 : 127,
          output: calls === 1 ? 'initial check passed' : 'tool: command not found',
        }),
    });
    assert.equal((await h.context.check(h.g.checks[0])).exitCode, 0);
    assert.equal((await h.context.check(h.g.checks[0])).failure, 'environment');
    assert.equal(h.context.issue.kind, 'environment');
    await assert.rejects(h.context.finish(passingVerdict), { kind: 'environment' });
    await assert.rejects(access(h.context.cwd));
    assert.equal(h.fake.sandboxes.length, 0);
  }
});

test('preflight rejects obsolete network modes, host variables and unknown CLI versions', async (t) => {
  const { root, settings } = await fixture(t);
  const backend = new DockerSandboxes(settings, join(root, 'leases'), fakeSbx().run);
  assert.throws(
    () => backend.validateEnvironment({ ...goal().verification, network: 'host' }),
    /Unsupported/,
  );
  assert.throws(
    () => backend.validateEnvironment({ ...goal().verification, env: ['PATH'] }),
    /host variables/,
  );
  for (const options of [{ version: 'sbx version 0.50.0' }]) {
    const fake = fakeSbx(options);
    await assert.rejects(new DockerSandboxes(settings, join(root, 'leases'), fake.run).doctor());
    assert.equal(
      fake.calls.some((c) => c.args[0] === 'create'),
      false,
    );
    assert.equal(
      fake.calls.some((c) => c.args[0] === 'settings' && c.args[1] === 'set'),
      false,
    );
  }
});

test('image archive changes are rejected before creating a VM', async (t) => {
  const { cwd, root, settings } = await fixture(t);
  await writeFile(settings.imageArchive, 'replaced');
  const fake = fakeSbx();
  await assert.rejects(
    prepareVerification(
      cwd,
      goal(),
      settings,
      join(root, 'leases'),
      undefined,
      new DockerSandboxes(settings, join(root, 'leases'), fake.run),
    ),
    /digest mismatch/,
  );
  assert.equal(
    fake.calls.some((c) => c.args[0] === 'create'),
    false,
  );
});

test('command transport never shell-expands argv, bounds output and terminates on timeout', async () => {
  const run = commandRunner(process.execPath);
  const value = '$(echo SHOULD_NOT_RUN); `hostname` " spaced argument';
  const result = await run(['-e', 'process.stdout.write(process.argv[1])', value], {
    timeoutMs: 1000,
  });
  assert.equal(result.stdout, value);
  await assert.rejects(
    run(['-e', 'process.stdout.write("x".repeat(100000))'], { timeoutMs: 1000, maxBytes: 100 }),
    /byte limit/,
  );
  await assert.rejects(run(['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 30 }), /timed out/);
  assert.equal('SSH_AUTH_SOCK' in controlEnvironment(), false);
  assert.equal('DEEPSEEK_API_KEY' in controlEnvironment(), false);
});
