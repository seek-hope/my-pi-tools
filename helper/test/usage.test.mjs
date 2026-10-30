import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/runner.ts';
import { fixture, message, call } from './fixtures.mjs';

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
