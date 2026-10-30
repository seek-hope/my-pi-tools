import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { runHelper } from '../src/runner.ts';
import { fixture, message, call, model, toolNames } from './fixtures.mjs';

test('fresh Pi contexts contain only explicit material and callable read-only tools', async () => {
  const f = fixture([message([call('read')], 'toolUse'), message('Answer')]);
  const r = await runHelper({ task: 'Inspect', context: 'EXPLICIT_MATERIAL' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered', JSON.stringify(r));
  assert.deepEqual(toolNames(f.contexts[0]).sort(), ['find', 'grep', 'ls', 'read']);
  assert.match(JSON.stringify(f.contexts[0]), /EXPLICIT_MATERIAL/);
  assert.match(JSON.stringify(f.contexts[1]), /FILE_VALUE/);
  assert.equal(r.lastTool, undefined);
  assert.equal(r.usage.totalTokens, 20);
  const fresh = fixture([message('Fresh')]);
  await runHelper({ task: 'Other task' }, fresh.ctx, fresh.settings);
  assert.doesNotMatch(JSON.stringify(fresh.contexts), /EXPLICIT_MATERIAL|FILE_VALUE/);
});

test('disabled host tools have no local built-in fallback', async () => {
  const f = fixture([message([call('read')], 'toolUse'), message('Unavailable')]);
  f.ctx.tools = [];
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(f.executions.length, 0);
  assert.deepEqual(toolNames(f.contexts[0]), []);
});

for (const request of [
  { task: ' ' },
  { task: 'x', mode: 'work' },
  { task: 'x', mode: 'read' },
  { task: 'x', other: 1 },
  { task: 'x'.repeat(20001) },
  { task: 'x', context: 'x'.repeat(120001) },
])
  test(`invalid request rejected before model or tool access: ${Object.keys(request)}`, async () => {
    const f = fixture([]);
    await assert.rejects(runHelper(request, f.ctx, f.settings));
    assert.equal(f.contexts.length, 0);
    assert.equal(f.executions.length, 0);
  });

test('ordinary tool failures are fed back without an error-message whitelist', async () => {
  const f = fixture([message([call('grep')], 'toolUse'), message('Corrected')], {
    execute: () => ({
      toolCall: { id: 'n' },
      isError: true,
      durationMs: 0,
      result: { content: [{ type: 'text', text: 'An ordinary tool error' }] },
    }),
  });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(f.contexts[1].messages.at(-1).isError, true);
});

test('Pi handles malformed JSON without executing the invalid action', async () => {
  const bad = { ...call('read'), argumentsError: 'Malformed JSON' };
  const f = fixture([message([bad], 'toolUse'), message('Cannot execute invalid input')]);
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(f.executions.length, 0);
  assert.equal(f.contexts[1].messages.at(-1).isError, true);
});

test('normal Pi loop can exceed the removed 20-turn limit', async () => {
  const f = fixture((_c, _o, n) =>
    n <= 21 ? message([call('read', {}, `r${n}`)], 'toolUse') : message('Finished'),
  );
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(r.turns, 22);
  assert.equal(r.toolCalls, 21);
});

test('native provider failure is not mistaken for a successful prior answer', async () => {
  const f = fixture([
    message([{ type: 'text', text: 'Partial findings' }, call('read')], 'toolUse'),
    message('', 'error', { errorMessage: 'fatal fixture error' }),
  ]);
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'error');
  assert.match(r.reason, /fatal fixture/);
  assert.equal(r.output, 'Partial findings');
});

test('a truncated normal answer returns a size-limited partial result', async () => {
  const f = fixture([message('x'.repeat(33000))]);
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'limited');
  assert.equal(r.outputTruncated, true);
  assert.ok(r.output.length <= 32000);
});

test('configured model and thinking are passed to the native session', async () => {
  const other = { ...model, id: 'selected' };
  const f = fixture([message('Answer', 'stop', { model: other.id })], { resolve: () => other });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, {
    ...f.settings,
    provider: other.provider,
    model: other.id,
    thinking: 'high',
  });
  assert.equal(r.status, 'answered');
  assert.equal(f.requests[0].model.id, 'selected');
  assert.equal(f.requests[0].reasoning, 'high');
});

test('pre-cancellation and progress-callback cancellation never request the provider', async () => {
  for (const progressAbort of [false, true]) {
    const controller = new AbortController();
    const f = fixture([]);
    if (!progressAbort) controller.abort();
    const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings, controller.signal, () =>
      controller.abort(),
    );
    assert.equal(r.status, 'cancelled');
    assert.equal(f.contexts.length, 0);
  }
});

test('deadline cancels a waiting provider and releases the child', { timeout: 5000 }, async () => {
  const f = fixture(
    (_c, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, timeoutSeconds: 1 });
  assert.equal(r.status, 'limited');
  assert.match(r.reason, /time limit/);
  assert.equal(f.contexts.length, 1);
});

test('expired synchronous host work cannot start another tool or model request', async () => {
  const f = fixture([message([call('read', {}, 'a'), call('read', {}, 'b')], 'toolUse')], {
    execute: () => {
      const until = performance.now() + 1050;
      while (performance.now() < until) {}
      return {
        toolCall: { id: 'n' },
        isError: false,
        durationMs: 1050,
        result: { content: [{ type: 'text', text: 'late' }] },
      };
    },
  });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, timeoutSeconds: 1 });
  assert.equal(r.status, 'limited');
  assert.equal(f.executions.length, 1);
  assert.equal(f.contexts.length, 1);
});

test(
  'caller cancellation remains cancelled when provider cleanup crosses the deadline',
  { timeout: 5000 },
  async () => {
    const controller = new AbortController();
    const f = fixture(
      (_context, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => resolve(message('', 'aborted')), 1100);
            },
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        }),
    );
    const r = await runHelper(
      { task: 'Inspect' },
      f.ctx,
      { ...f.settings, timeoutSeconds: 1 },
      controller.signal,
    );
    assert.equal(r.status, 'cancelled');
    assert.match(r.reason, /invocation cancelled/);
    assert.equal(f.contexts.length, 1);
  },
);

test('resource discovery is disabled, sessions are in memory, and dispose runs', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'helper-discovery-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.pi/extensions'), { recursive: true });
  writeFileSync(join(cwd, 'AGENTS.md'), 'PRIVATE_PROJECT_INSTRUCTIONS');
  writeFileSync(
    join(cwd, '.pi/extensions/trap.ts'),
    'throw new Error("Unexpected extension discovery");',
  );
  const before = readdirSync(cwd, { recursive: true }).sort();
  const original = AgentSession.prototype.dispose;
  const disposed = [];
  AgentSession.prototype.dispose = function () {
    disposed.push(this);
    return original.call(this);
  };
  t.after(() => {
    AgentSession.prototype.dispose = original;
  });
  const f = fixture([message('Done')]);
  f.ctx.cwd = cwd;
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered', JSON.stringify(r));
  assert.doesNotMatch(JSON.stringify(f.contexts), /PRIVATE_PROJECT_INSTRUCTIONS/);
  assert.deepEqual(readdirSync(cwd, { recursive: true }).sort(), before);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].sessionFile, undefined);
  assert.equal(disposed[0].isStreaming, false);
});
