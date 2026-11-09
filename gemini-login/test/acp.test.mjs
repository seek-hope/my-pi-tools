import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { AcpProcess, errorText, plain, strictAcpInput } from '../src/acp.ts';
import { fixture, until } from './fixtures.mjs';

const text = (c) => c.entries.map((e) => e.text).join('\n');

test('real stdio connection negotiates honest capabilities and streams distinct turns', async (t) => {
  const { conversation: c, remembered } = await fixture(t);
  await c.start();
  assert.equal(c.state, 'ready');
  assert.deepEqual(remembered, ['session-1']);
  await c.prompt('first');
  await c.prompt('second');
  assert.equal(c.state, 'ready');
  assert.equal(c.entries.filter((e) => e.kind === 'user').length, 2);
  assert.equal(c.entries.filter((e) => e.kind === 'assistant').length, 2);
  assert.match(text(c), /Hello first 世界 👋/);
  assert.doesNotMatch(text(c), /Do not show this/);
  assert.match(text(c), /考虑中/);
});

test('authentication required remains recoverable and offers only personal Google login', async (t) => {
  const { conversation: c } = await fixture(t, 'auth');
  await c.start();
  assert.equal(c.state, 'login');
  assert.match(text(c), /需要 Google 登录/);
  await c.login();
  assert.equal(c.state, 'ready');
  await c.prompt('authenticated');
  assert.match(text(c), /Hello authenticated/);
});

test('saved sessions replay history and new sessions clear the previous view', async (t) => {
  const { conversation: c, remembered } = await fixture(t);
  await c.start('saved-session');
  assert.match(text(c), /Earlier user prompt/);
  assert.match(text(c), /Earlier answer/);
  await c.open();
  assert.doesNotMatch(text(c), /Earlier/);
  assert.deepEqual(remembered, ['saved-session', 'session-1']);
});

test('failed load never silently creates or continues another session', async (t) => {
  const { conversation: c, remembered } = await fixture(t);
  await c.start('missing');
  assert.equal(c.sessionId, undefined);
  assert.match(text(c), /Session not found/);
  assert.deepEqual(remembered, []);
  await c.open();
  assert.equal(c.state, 'ready');
});

for (const option of ['allow', 'deny', undefined, 'invented-id']) {
  test(`permission ${String(option)} controls actual file mutation in the agent process`, async (t) => {
    const { conversation: c, cwd } = await fixture(t);
    await c.start();
    const turn = c.prompt('permission');
    await until(() => c.permissions.length === 1, 'permission');
    assert.deepEqual(c.permissions[0].request.toolCall.rawInput, {
      path: 'allowed.txt',
      text: 'approved',
    });
    await assert.rejects(access(join(cwd, 'allowed.txt')));
    c.permissions[0].answer(option);
    await turn;
    if (option === 'allow')
      assert.equal(await readFile(join(cwd, 'allowed.txt'), 'utf8'), 'approved');
    else await assert.rejects(access(join(cwd, 'allowed.txt')));
    assert.equal(c.permissions.length, 0);
    assert.match(c.entries.find((entry) => entry.kind === 'tool').text, /修改后：\napproved/);
    assert.match(c.entries.find((entry) => entry.kind === 'tool').text, /completed/);
  });
}

test('foreign session permission requests are cancelled without showing an approval UI', async (t) => {
  const { conversation: c, cwd } = await fixture(t);
  await c.start();
  await c.prompt('permission-foreign');
  assert.equal(c.permissions.length, 0);
  assert.match(text(c), /cancelled/);
  await assert.rejects(access(join(cwd, 'allowed.txt')));
});

test('cancellation resolves all pending permissions, preserving no stale allow action', async (t) => {
  const { conversation: c, cwd } = await fixture(t, 'normal', 1000);
  await c.start();
  const turn = c.prompt('permission-two');
  await until(() => c.permissions.length === 2, 'two permissions');
  const stale = [...c.permissions];
  await c.cancel();
  stale.forEach((permission) => permission.answer('allow'));
  await turn;
  assert.equal(c.permissions.length, 0);
  assert.equal(c.state, 'ready');
  await assert.rejects(access(join(cwd, 'allowed.txt')));
});

test('cancellation retains partial output and waits for the agent terminal response', async (t) => {
  const { conversation: c } = await fixture(t, 'normal', 1000);
  await c.start();
  const turn = c.prompt('wait');
  await until(() => text(c).includes('Partial output'));
  await c.cancel();
  await turn;
  assert.equal(c.state, 'ready');
  assert.match(text(c), /Partial output/);
  assert.match(text(c), /cancelled/);
});

test('ignored cancellation disconnects within a bound and cannot be reported as success', async (t) => {
  const { conversation: c } = await fixture(t, 'ignore-cancel');
  await c.start();
  const turn = c.prompt('wait');
  await until(() => text(c).includes('Partial output'));
  await c.cancel();
  await turn;
  assert.equal(c.state, 'disconnected');
  assert.match(text(c), /取消未在期限内确认/);
  assert.ok(c.process.connection.signal.aborted);
});

for (const prompt of ['crash', 'malformed', 'bad-response', 'bad-notification']) {
  test(`unexpected ${prompt} preserves an error state and releases subprocess resources`, async (t) => {
    const { conversation: c } = await fixture(t);
    await c.start();
    await c.prompt(prompt);
    assert.equal(c.state, 'disconnected');
    assert.ok(c.process.connection.signal.aborted);
  });
}

test('configuration uses server values including grouped models and typed booleans', async (t) => {
  const { conversation: c } = await fixture(t);
  await c.start();
  await c.configure(c.config[0], 'not-a-model');
  assert.equal(c.config[0].currentValue, 'gemini-test');
  await c.configure(c.config[0], 'gemini-other');
  assert.equal(c.config[0].currentValue, 'gemini-other');
  await c.configure(c.config[2], true);
  assert.equal(c.config[2].currentValue, true);
});

test('unadvertised file and terminal methods do not execute in the Pi client', async (t) => {
  const { conversation: c } = await fixture(t);
  await c.start();
  await c.prompt('unexpected-fs');
  assert.match(text(c), /Denied: -32601/);
});

test('display retention is bounded and does not rewrite the agent session', async (t) => {
  const { conversation: c } = await fixture(t);
  await c.start();
  const id = c.sessionId;
  await c.prompt('large');
  assert.equal(c.trimmed, true);
  assert.ok(c.entries.reduce((total, entry) => total + entry.text.length, 0) <= 512_000);
  assert.match(text(c), /显示内容已截断/);
  assert.equal(c.sessionId, id);
});

test('output limits retain their non-success stop reason', async (t) => {
  const { conversation: c } = await fixture(t);
  await c.start();
  await c.prompt('limited');
  assert.match(text(c), /max_tokens/);
});

test('incompatible versions are rejected before session creation', async (t) => {
  const { conversation: c, remembered } = await fixture(t, 'version');
  await c.start();
  assert.equal(c.state, 'disconnected');
  assert.match(text(c), /不支持 ACP 协议版本 9/);
  assert.deepEqual(remembered, []);
});

test('missing executable gives an actionable error without a dangling request', async () => {
  const process = new AcpProcess(
    '/tmp',
    {
      update() {},
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      disconnected() {},
    },
    { command: '/no/such/agy', stopMs: 20 },
  );
  await assert.rejects(process.initialize(), /找不到 Antigravity CLI/);
  await process.stop();
});

test('shutdown during initialize and SIGTERM resistance are bounded', async (t) => {
  const { conversation: c } = await fixture(t, 'hang-init');
  const start = c.start();
  await c.close();
  await start;
  assert.equal(c.state, 'closed');
  const { conversation: resistant } = await fixture(t, 'ignore-term');
  await resistant.start();
  await resistant.close();
  await until(() => resistant.process.child.signalCode !== null);
  assert.equal(resistant.process.child.signalCode, 'SIGKILL');
});

test('repeated cancellation and close share the same acknowledgement wait', async (t) => {
  const { conversation: c } = await fixture(t, 'slow-cancel', 1000);
  await c.start();
  const turn = c.prompt('wait');
  await until(() => text(c).includes('Partial output'));
  const cancel = c.cancel();
  assert.equal(c.cancel(), cancel);
  await c.close();
  await turn;
  assert.match(text(c), /cancelled/);
  assert.equal(c.state, 'closed');
  assert.ok(c.process.child.stdin.destroyed);
  assert.ok(c.process.child.stdout.destroyed);
  assert.ok(c.process.child.stderr.destroyed);
});

test('malformed config responses preserve prior settings and disconnect', async (t) => {
  const { conversation: c } = await fixture(t, 'bad-config');
  await c.start();
  const previous = structuredClone(c.config);
  await c.configure(c.config[0], 'gemini-other');
  assert.deepEqual(c.config, previous);
  assert.equal(c.state, 'disconnected');
});

test('binary content is not retained in the tool merge cache', async (t) => {
  const { conversation: c } = await fixture(t);
  await c.start();
  await c.prompt('images');
  assert.equal(c.state, 'ready');
  assert.ok(JSON.stringify([...c.tools.values()]).length < 2 * 1024 * 1024);
  assert.match(text(c), /图片：image\/png/);
});

test('stdio rejects invalid UTF-8, truncated frames and oversized lines', async () => {
  for (const bytes of [
    new Uint8Array([0xff]),
    new TextEncoder().encode('{"jsonrpc":"2.0"}'),
    new Uint8Array(8 * 1024 * 1024 + 1).fill(32),
  ]) {
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await assert.rejects(async () => {
      for await (const _chunk of strictAcpInput(input)) {
      }
    });
  }
});

test('diagnostics remove terminal escapes and credential fields', () => {
  assert.equal(plain('\x1b[31mhello\x1b[0m\x1b]52;c;secret\x07\u202e'), 'hello');
  const value = errorText(
    new Error('Bearer SECRET access_token="TOKEN" https://example.test/?code=CODE&key=KEY'),
  );
  assert.doesNotMatch(value, /SECRET|TOKEN|CODE|KEY/);
});
