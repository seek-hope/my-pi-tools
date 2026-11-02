import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/runner.ts';
import { fixture, message, call } from './fixtures.mjs';

for (const sources of [
  [true, true],
  [true, false],
  [false, true],
  [undefined, true],
  [true, undefined],
  [true, 'true'],
]) {
  test(`cost provenance includes every model request: ${JSON.stringify(sources)}`, async () => {
    const usages = sources.map((source, index) => ({
      ...message().usage,
      // Billed totals intentionally differ from the catalog component sum.
      cost: { ...message().usage.cost, total: index === 0 ? 0 : 1.25, totalFromProvider: source },
    }));
    const f = fixture([
      message([call('read')], 'toolUse', { usage: usages[0] }),
      message('Done', 'stop', { usage: usages[1] }),
    ]);
    const result = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
    assert.equal(result.status, 'answered');
    assert.equal(result.usage.cost.total, 1.25);
    assert.equal(
      result.usage.cost.totalFromProvider,
      sources.every((source) => source === true),
    );
    assert.equal(usages[0].cost.total, 0, 'source usage is not mutated');
  });
}

test('a missing billed total falls back to estimates and clears provider provenance', async () => {
  const usage = message().usage;
  usage.cost.totalFromProvider = true;
  delete usage.cost.total;
  const f = fixture([message('Done', 'stop', { usage })]);
  const result = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(result.usage.cost.total, 0.4);
  assert.equal(result.usage.cost.totalFromProvider, false);
  assert.equal(result.usageIncomplete, true);
});
