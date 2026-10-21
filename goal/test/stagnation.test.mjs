import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewStagnation } from '../src/stagnation.ts';
import { makeGoal } from '../src/state.ts';
import { defaults } from '../src/settings.ts';

const context = (streamSimple) => ({
  model: { provider: 'fixture', id: 'test', maxTokens: 32000 },
  modelRegistry: { streamSimple },
  sessionManager: { getBranch: () => [] },
});

test('stagnation diagnosis has no plugin deadline or output cap and still records usage', async (t) => {
  t.mock.method(AbortSignal, 'timeout', () => assert.fail('no diagnosis timeout'));
  const controller = new AbortController();
  const diagnosis =
    'English diagnosis; quoted input: 用户原文\n' +
    'Detailed observation. '.repeat(1000) +
    'Final recommendation retained.';
  const result = await reviewStagnation(
    makeGoal('Diagnose'),
    context((_model, input, options) => {
      assert.match(input.systemPrompt, /concise English diagnosis/);
      assert.match(input.systemPrompt, /preserving quoted user content in its original language/);
      assert.equal(options.signal, controller.signal);
      assert.equal(Object.hasOwn(options, 'maxTokens'), false);
      return {
        result: async () => ({
          content: [{ type: 'text', text: diagnosis }],
          stopReason: 'stop',
          usage: { totalTokens: 6000, input: 2000, output: 4000 },
        }),
      };
    }),
    defaults,
    controller.signal,
  );
  assert.equal(result.tokens, 6000);
  assert.equal(result.details, diagnosis);
});

test('stagnation diagnosis respects only the remaining goal-wide token budget', async () => {
  const goal = makeGoal('Diagnose', { maxTokens: 10000 });
  goal.usage.tokens = 7000;
  goal.usage.auditTokens = 500;
  let calls = 0;
  const ctx = context((_model, _input, options) => {
    calls++;
    assert.ok(options.maxTokens > 2048 && options.maxTokens < 2500);
    return {
      result: async () => ({
        content: [{ type: 'text', text: 'Try a different test' }],
        stopReason: 'stop',
        usage: { totalTokens: 1000 },
      }),
    };
  });
  assert.equal((await reviewStagnation(goal, ctx, defaults)).tokens, 1000);
  goal.usage.auditTokens = 3000;
  assert.match((await reviewStagnation(goal, ctx, defaults)).details, /Insufficient remaining/);
  assert.equal(calls, 1);
});

test('stagnation diagnosis remains manually cancellable', async () => {
  const controller = new AbortController();
  const ctx = context((_model, _input, { signal }) => ({
    result: () =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('operator cancelled')), {
          once: true,
        });
        controller.abort();
      }),
  }));
  const result = await reviewStagnation(makeGoal('Diagnose'), ctx, defaults, controller.signal);
  assert.match(result.details, /operator cancelled/);
});
