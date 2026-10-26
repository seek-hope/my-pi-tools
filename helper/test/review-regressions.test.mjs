import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/runner.ts';
import { fixture, message, call } from './fixtures.mjs';

test('cancellation from progress stops before starting or charging a model request', async () => {
  const controller = new AbortController();
  const f = fixture([message('Should not be requested')]);
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings, controller.signal, () =>
    controller.abort(),
  );
  assert.equal(r.status, 'cancelled');
  assert.equal(f.contexts.length, 0);
  assert.equal(r.turns, 0);
  assert.equal(r.usage.totalTokens, 0);
  assert.equal(r.usageIncomplete, false);
});

test(
  'an overdue synchronous tool cannot start later writes before the timer callback runs',
  { timeout: 5000 },
  async () => {
    const f = fixture(
      [
        message([call('write', {}, 'a'), call('write', {}, 'b')], 'toolUse'),
        message('Should not be requested'),
      ],
      {
        execute: () => {
          // Model a synchronous extension that returns after the wall-time budget.
          // No event-loop turn occurs, so a setTimeout-only deadline cannot fire yet.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
          return {
            toolCall: { id: 'nested-a' },
            isError: false,
            result: { content: [{ type: 'text', text: 'first write persisted' }] },
          };
        },
      },
    );
    const r = await runHelper({ task: 'Write the requested files', mode: 'work' }, f.ctx, {
      ...f.settings,
      timeoutSeconds: 1,
    });
    assert.equal(r.status, 'limited');
    assert.equal(r.partial, true);
    assert.equal(f.executions.length, 1);
    assert.equal(f.contexts.length, 1);
    assert.match(r.lastTool.output, /first write persisted/);
    assert.equal(r.usage.totalTokens, 10);
  },
);

test('successful assistance does not replay raw inspected file bodies to the caller', async () => {
  const f = fixture([message([call('read')], 'toolUse'), message('Review summary')], {
    execute: () => ({
      toolCall: { id: 'n' },
      isError: false,
      result: { content: [{ type: 'text', text: 'RAW_INSPECTED_BODY' }] },
    }),
  });
  const r = await runHelper({ task: 'Review the file' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.match(JSON.stringify(f.contexts[1]), /RAW_INSPECTED_BODY/);
  assert.doesNotMatch(JSON.stringify(r), /RAW_INSPECTED_BODY/);
  assert.deepEqual(r.toolsUsed, ['read']);
});

test('malformed or overflowing usage is marked incomplete and remains JSON-safe', async () => {
  const usage = message().usage;
  usage.input = usage.totalTokens = Number.MAX_VALUE;
  usage.cost.input = usage.cost.total = Number.MAX_VALUE;
  const f = fixture([
    message([call('read')], 'toolUse', { usage }),
    message('Done', 'stop', { usage }),
  ]);
  const r = await runHelper({ task: 'Analyze' }, f.ctx, f.settings);
  assert.equal(r.usageIncomplete, true);
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'])
    assert.ok(Number.isSafeInteger(r.usage[key]));
  for (const cost of Object.values(r.usage.cost)) assert.ok(Number.isFinite(cost));
  assert.deepEqual(JSON.parse(JSON.stringify(r.usage)), r.usage);
});

for (const id of [17, '  '])
  test(`invalid call ID ${JSON.stringify(id)} rejects the batch before writing`, async () => {
    const f = fixture([
      message([call('write', {}, 'valid'), call('ls', {}, id)], 'toolUse'),
      message('Done'),
    ]);
    const r = await runHelper({ task: 'Write and list', mode: 'work' }, f.ctx, f.settings);
    assert.equal(r.status, 'error');
    assert.equal(f.executions.length, 0);
  });

test('optional token breakdowns are retained across turns without double-counting totals', async () => {
  const usage = { ...message().usage, reasoning: 1, cacheWrite1h: 2 };
  const f = fixture([
    message([call('read')], 'toolUse', { usage }),
    message('Done', 'stop', { usage }),
  ]);
  const r = await runHelper({ task: 'Analyze' }, f.ctx, f.settings);
  assert.equal(r.usage.reasoning, 2);
  assert.equal(r.usage.cacheWrite1h, 4);
  assert.equal(r.usage.totalTokens, 20);
  assert.equal(r.usage.cost.total, 0.8);
  assert.equal(r.usageIncomplete, false);
});

for (const final of [true, false])
  test(`an exhausted tool budget permits a final answer but no further tools (${final})`, async () => {
    const f = fixture([
      message([call('read', {}, 'first')], 'toolUse'),
      final
        ? message('Read and analyzed the result')
        : message([call('read', {}, 'second')], 'toolUse'),
    ]);
    const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, maxToolCalls: 1 });
    assert.equal(r.status, final ? 'answered' : 'limited');
    assert.equal(r.turns, 2);
    assert.equal(f.executions.length, 1);
    assert.equal(r.usage.totalTokens, 20);
  });

test('reported usage components survive missing token and cost aggregates', async () => {
  const usage = message().usage;
  delete usage.totalTokens;
  delete usage.cost.total;
  const f = fixture([message('Done', 'stop', { usage })]);
  const r = await runHelper({ task: 'Analyze' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(r.usageIncomplete, true);
  assert.equal(r.usage.totalTokens, 10);
  assert.equal(r.usage.cost.total, 0.4);
});
