import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelperSession } from '../src/session.ts';
import { runHelper } from '../src/runner.ts';
import { fixture, message, model } from './fixtures.mjs';

for (const reason of ['length', 'error'])
  test('terminal ' + reason + ' survives native recovery projection edits', async () => {
    const f = fixture([
      message('Partial answer', reason, { errorMessage: 'maximum context length exceeded' }),
    ]);
    const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
    assert.equal(r.status, reason === 'length' ? 'limited' : 'error');
    assert.match(r.reason, reason === 'length' ? /output limit/ : /maximum context length/);
    assert.equal(r.output, 'Partial answer');
  });

test('virtual selections return an actionable error before starting a request', async () => {
  const f = fixture([], { model: { ...model, api: 'pi-virtual' } });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'error');
  assert.match(r.reason, /physical model/);
  assert.equal(f.contexts.length, 0);
});

test('summary retries count failed and successful requests exactly once', async (t) => {
  let summaries = 0;
  const f = fixture(
    (context) => {
      if (
        JSON.stringify(context).includes('conversation to summarize') ||
        JSON.stringify(context).includes('earlier context from an ongoing conversation')
      ) {
        summaries++;
        return summaries === 1
          ? message('', 'error', { errorMessage: '503 service unavailable' })
          : message('Summary');
      }
      return message('evidence '.repeat(1000), 'stop', {
        usage: { ...message().usage, input: 25000, totalTokens: 25008 },
      });
    },
    { model: { ...model, contextWindow: 32768 } },
  );
  const { session, getUsage } = await createHelperSession(f.ctx, f.ctx.model, 'off', [], () => {});
  t.after(async () => {
    await session.abort();
    session.dispose();
  });
  session.settingsManager.applyOverrides({
    compaction: { reserveTokens: 10000, keepRecentTokens: 1000 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  });
  await session.prompt('Inspect');
  assert.equal(summaries, 2);
  assert.equal(getUsage().usage.totalTokens, 25028);
  assert.equal(getUsage().usageIncomplete, true);
});
