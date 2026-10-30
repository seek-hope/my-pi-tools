import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { createHelperSession } from '../src/session.ts';
import { runHelper } from '../src/runner.ts';
import { fixture, message, model, call } from './fixtures.mjs';

async function child(t, f, tools = []) {
  const created = await createHelperSession(f.ctx, f.ctx.model, 'off', tools, () => {});
  const { session } = created;
  t.after(async () => {
    await session.abort();
    session.dispose();
  });
  return created;
}

test('Pi compacts the child context and preserves summary usage without a Helper compaction loop', async (t) => {
  let normal = 0,
    summaries = 0;
  const f = fixture(
    (context) => {
      if (
        JSON.stringify(context).includes('conversation to summarize') ||
        JSON.stringify(context).includes('earlier context from an ongoing conversation')
      ) {
        summaries++;
        return message('CHILD_SUMMARY_SENTINEL');
      }
      normal++;
      return normal === 1
        ? message('evidence '.repeat(1000), 'stop', {
            usage: { ...message().usage, input: 25000, totalTokens: 25008 },
          })
        : message('Final answer');
    },
    { model: { ...model, contextWindow: 32768 } },
  );
  const { session, getUsage } = await child(t, f);
  session.settingsManager.applyOverrides({
    compaction: { reserveTokens: 10000, keepRecentTokens: 1000 },
  });
  const events = [];
  session.subscribe((e) => events.push(e.type));
  await session.prompt('Inspect the evidence');
  await session.prompt('Summarize the findings');
  assert.ok(events.includes('compaction_start'));
  assert.ok(summaries >= 1);
  assert.match(JSON.stringify(f.contexts.at(-1)), /CHILD_SUMMARY_SENTINEL/);
  const entries = session.sessionManager.getEntries();
  assert.ok(entries.some((e) => e.type === 'compaction'));
  assert.equal(getUsage().usage.totalTokens, 25008 + (summaries + 1) * 10);
});

test('Pi retries transient model errors and prompt waits for settled completion', async (t) => {
  const f = fixture([
    message('', 'error', { errorMessage: '503 service unavailable' }),
    message('Recovered'),
  ]);
  const { session, getUsage } = await child(t, f);
  session.settingsManager.applyOverrides({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  });
  const events = [];
  session.subscribe((e) => events.push(e.type));
  await session.prompt('Inspect');
  assert.equal(session.getLastAssistantText(), 'Recovered');
  assert.equal(f.contexts.length, 2);
  assert.ok(events.includes('auto_retry_start'));
  assert.equal(events.at(-1), 'agent_settled');
  assert.equal(getUsage().usage.totalTokens, 20);
});

test('the Helper deadline also stops native retry backoff', { timeout: 5000 }, async () => {
  const f = fixture([
    message('', 'error', { errorMessage: '503 service unavailable' }),
    message('Must not run'),
  ]);
  const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, timeoutSeconds: 1 });
  assert.equal(r.status, 'limited');
  assert.equal(f.contexts.length, 1);
});

test('cancellation during native compaction aborts the summary request', async (t) => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const f = fixture(
    (context, { signal }) => {
      if (
        JSON.stringify(context).includes('conversation to summarize') ||
        JSON.stringify(context).includes('earlier context from an ongoing conversation')
      ) {
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      return message('evidence '.repeat(1000), 'stop', {
        usage: { ...message().usage, input: 25000, totalTokens: 25008 },
      });
    },
    { model: { ...model, contextWindow: 32768 } },
  );
  const { session, getUsage } = await child(t, f);
  session.settingsManager.applyOverrides({
    compaction: { reserveTokens: 10000, keepRecentTokens: 1000 },
  });
  const prompt = session.prompt('Inspect');
  await entered;
  await session.abort();
  await prompt;
  assert.equal(session.isStreaming, false);
  assert.equal(f.contexts.length, 2);
  assert.equal(
    session.sessionManager.getEntries().some((e) => e.type === 'compaction'),
    false,
  );
  assert.equal(getUsage().usage.totalTokens, 25018);
  assert.equal(getUsage().usageIncomplete, true);
});

for (const status of ['answered', 'error', 'cancelled', 'terminated'])
  test(`child disposal runs after ${status}`, async (t) => {
    const original = AgentSession.prototype.dispose;
    let count = 0;
    AgentSession.prototype.dispose = function () {
      count++;
      return original.call(this);
    };
    t.after(() => {
      AgentSession.prototype.dispose = original;
    });
    const f = fixture(
      status === 'terminated'
        ? [message([call('read')], 'toolUse')]
        : [
            message(
              status === 'answered' ? 'Done' : '',
              status === 'error' ? 'error' : status === 'cancelled' ? 'aborted' : 'stop',
              { errorMessage: 'fatal fixture error' },
            ),
          ],
      {
        execute: () => ({
          toolCall: { id: 'n' },
          isError: false,
          durationMs: 0,
          result: { content: [{ type: 'text', text: 'Stop' }], terminate: true },
        }),
      },
    );
    const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
    assert.equal(r.status, status, JSON.stringify(r));
    assert.equal(count, 1);
  });

test('tool-result termination prevents later members of the batch from reaching the parent', async () => {
  const f = fixture([message([call('read', {}, 'a'), call('read', {}, 'b')], 'toolUse')], {
    execute: () => ({
      toolCall: { id: 'n' },
      isError: false,
      durationMs: 0,
      result: { content: [{ type: 'text', text: 'Host stopped' }], terminate: true },
    }),
  });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'terminated');
  assert.equal(f.executions.length, 1);
  assert.equal(f.contexts.length, 1);
});

test('provider transport and auth options remain host-managed', async () => {
  const f = fixture([message('Done')]);
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(f.requests[0].apiKey, undefined, 'no copied or fabricated API key');
  assert.deepEqual(f.requests[0].model, model);
});
