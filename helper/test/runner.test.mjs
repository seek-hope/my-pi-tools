import test from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';
import { runHelper, resultSchema, READ_TOOLS } from '../src/runner.ts';
import { fixture, message, call, model } from './fixtures.mjs';

test('only explicit request data enters a fresh context; own tool results persist within one run', async () => {
  const f = fixture([
    message([call('read')], 'toolUse'),
    message('FIRST_HELPER_SECRET'),
    message('Second answer'),
  ]);
  const first = await runHelper(
    { task: 'Inspect src/example.ts', context: 'EXPLICIT_MATERIAL' },
    f.ctx,
    f.settings,
  );
  assert.equal(first.status, 'answered');
  assert.equal(first.turns, 2);
  assert.equal(first.usage.totalTokens, 20);
  assert.equal(first.usage.cost.total, 0.8);
  assert.ok(Check(resultSchema, first));
  const initial = f.contexts[0];
  assert.equal(initial.messages.length, 1);
  assert.deepEqual(JSON.parse(initial.messages[0].content), {
    mode: 'read',
    task: 'Inspect src/example.ts',
    context: 'EXPLICIT_MATERIAL',
  });
  assert.deepEqual(
    initial.tools.map((t) => t.name),
    [...READ_TOOLS],
  );
  assert.match(JSON.stringify(f.contexts[1]), /FILE_VALUE/);
  first.usage.totalTokens = 99999;
  const second = await runHelper({ task: 'Another task' }, f.ctx, f.settings);
  assert.equal(second.usage.totalTokens, 10);
  assert.equal(f.contexts[2].messages.length, 1);
  assert.doesNotMatch(
    JSON.stringify(f.contexts[2]),
    /FIRST_HELPER_SECRET|EXPLICIT_MATERIAL|FILE_VALUE/,
  );
});
for (const name of [
  'bash',
  'powershell',
  'write',
  'edit',
  'helper',
  'codemode',
  'goal_status',
  'web_fetch',
])
  test(`read mode cannot reach ${name}, even when the host exposes it`, async () => {
    const f = fixture([message([call(name)], 'toolUse')]);
    const r = await runHelper({ task: 'Inspect only' }, f.ctx, f.settings);
    assert.equal(r.status, 'error');
    assert.equal(f.executions.length, 0);
    assert.equal(f.contexts.length, 1);
  });
test('work mode dispatches host tools without enabling absent tools or exposing a dispatcher', async () => {
  const f = fixture([
    message([call('write', {}, 'a'), call('edit', {}, 'b'), call('bash', {}, 'c')], 'toolUse'),
    message('Finished'),
  ]);
  f.ctx.tools = f.ctx.tools.filter((t) => t.name !== 'powershell');
  const r = await runHelper(
    { task: 'Implement the requested fix', mode: 'work' },
    f.ctx,
    f.settings,
  );
  assert.equal(r.status, 'answered');
  assert.deepEqual(
    f.executions.map((e) => e.name),
    ['write', 'edit', 'bash'],
  );
  assert.deepEqual(r.toolsUsed, ['write', 'edit', 'bash']);
  assert.ok(f.executions.every((e) => e.signal instanceof AbortSignal));
  assert.ok(
    !f.contexts[0].tools.some((t) => ['helper', 'powershell', 'codemode'].includes(t.name)),
  );
});
test('a mixed batch with an unknown call cannot perform earlier writes', async () => {
  const f = fixture([message([call('write', {}, 'a'), call('helper', {}, 'b')], 'toolUse')]);
  const r = await runHelper({ task: 'Write a file', mode: 'work' }, f.ctx, f.settings);
  assert.equal(r.status, 'error');
  assert.equal(f.executions.length, 0);
});
test('duplicate call IDs cannot replay work', async () => {
  const f = fixture([message([call('write')], 'toolUse'), message([call('write')], 'toolUse')]);
  const r = await runHelper({ task: 'Write one file', mode: 'work' }, f.ctx, f.settings);
  assert.equal(r.status, 'error');
  assert.equal(f.executions.length, 1);
});
test('endless tool requests reach the turn limit without continuing or performing a final unreviewed action', async () => {
  const f = fixture((_c, _o, n) => message([call('read', {}, `r-${n}`)], 'toolUse'));
  const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, maxTurns: 3 });
  assert.equal(r.status, 'limited');
  assert.equal(r.partial, true);
  assert.equal(f.contexts.length, 3);
  assert.equal(f.executions.length, 2);
  assert.equal(r.usage.totalTokens, 30);
});
test('tool-call and context limits stop before oversized work', async () => {
  const f = fixture([message([call('write', {}, 'a'), call('write', {}, 'b')], 'toolUse')]);
  const r = await runHelper({ task: 'Write', mode: 'work' }, f.ctx, {
    ...f.settings,
    maxToolCalls: 1,
  });
  assert.equal(r.status, 'limited');
  assert.equal(f.executions.length, 0);
  const g = fixture([]);
  const limited = await runHelper({ task: 'Inspect', context: 'x'.repeat(3000) }, g.ctx, {
    ...g.settings,
    maxContextChars: 1000,
  });
  assert.equal(limited.status, 'limited');
  assert.equal(g.contexts.length, 0);
});
test('a missing-information answer returns immediately with no protocol or further request', async () => {
  const f = fixture([message('Please provide the target filename.')]);
  const r = await runHelper({ task: 'Review it' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(f.contexts.length, 1);
  assert.equal(f.executions.length, 0);
});
for (const source of ['session', 'tool'])
  test(`${source} cancellation is honored before a request and after incurred usage`, async () => {
    const controller = new AbortController();
    const f = fixture(
      () => {
        controller.abort();
        return message('Late answer');
      },
      { signal: source === 'session' ? controller.signal : undefined },
    );
    const r = await runHelper(
      { task: 'Inspect' },
      f.ctx,
      f.settings,
      source === 'tool' ? controller.signal : undefined,
    );
    assert.equal(r.status, 'cancelled');
    assert.equal(r.usage.totalTokens, 10);
    assert.equal(r.partial, true);
    const before = await runHelper(
      { task: 'Inspect' },
      f.ctx,
      f.settings,
      source === 'tool' ? controller.signal : undefined,
    );
    assert.equal(before.turns, 0);
    assert.equal(f.contexts.length, 1);
  });
test(
  'deadline aborts a pending provider call without a retry or invented usage',
  { timeout: 4000 },
  async () => {
    const f = fixture(
      (_c, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    );
    const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, timeoutSeconds: 1 });
    assert.equal(r.status, 'limited');
    assert.match(r.reason, /time/);
    assert.equal(r.usageIncomplete, true);
    assert.equal(f.contexts.length, 1);
  },
);
for (const kind of ['error', 'terminate', 'throw'])
  test(`host ${kind} stops the helper and preserves model usage`, async () => {
    const f = fixture([message([call('bash')], 'toolUse')], {
      execute: () => {
        if (kind === 'throw') throw new Error('host unavailable');
        return {
          toolCall: { id: 'nested-1' },
          result: {
            isError: true,
            terminate: kind === 'terminate',
            content: [{ type: 'text', text: 'host denied operation' }],
          },
        };
      },
    });
    const r = await runHelper({ task: 'Run tests', mode: 'work' }, f.ctx, f.settings);
    assert.equal(r.status, kind === 'terminate' ? 'terminated' : 'error');
    assert.equal(r.usage.totalTokens, 10);
    assert.equal(f.contexts.length, 1);
    assert.equal(r.partial, true);
  });
test('unknown usage does not prevent accounting for later responses', async () => {
  const f = fixture([message([call('read')], 'toolUse', { usage: undefined }), message('Done')]);
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'answered');
  assert.equal(r.usageIncomplete, true);
  assert.equal(r.usage.totalTokens, 10);
});
test('model selection uses the configured model and thinking without falling back silently', async () => {
  const selected = { ...model, id: 'alternative' };
  const f = fixture([message('Done')], { resolve: () => selected });
  const r = await runHelper({ task: 'Analyze' }, f.ctx, {
    ...f.settings,
    provider: 'offline',
    model: 'alternative',
    thinking: 'high',
  });
  assert.match(r.model, /alternative/);
  assert.equal(f.requests[0].reasoning, 'high');
  const g = fixture([]);
  assert.equal(
    (
      await runHelper({ task: 'Analyze' }, g.ctx, {
        ...g.settings,
        provider: 'missing',
        model: 'missing',
      })
    ).status,
    'error',
  );
  assert.equal(g.contexts.length, 0);
});
for (const stopReason of ['length', 'error', 'aborted', 'deferred', 'pending'])
  test(`model ${stopReason} is never presented as an answer`, async () => {
    const f = fixture([message('Partial', stopReason)]);
    const r = await runHelper({ task: 'Analyze' }, f.ctx, f.settings);
    assert.notEqual(r.status, 'answered');
    assert.equal(r.partial, true);
    assert.equal(r.usage.totalTokens, 10);
    assert.equal(f.contexts.length, 1);
  });
test('tool output and final answers are bounded and truncation is explicit', async () => {
  const f = fixture([message([call('read')], 'toolUse'), message('x'.repeat(60000))], {
    execute: () => ({
      toolCall: { id: 'n' },
      result: { content: [{ type: 'text', text: 'y'.repeat(60000) }] },
    }),
  });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'limited');
  assert.equal(r.outputTruncated, true);
  assert.equal(r.lastTool.outputTruncated, true);
  assert.ok(r.output.length <= 32000);
  assert.ok(r.lastTool.output.length <= 32000);
  assert.ok(f.contexts[1].messages.at(-1).content[0].text.length <= 32000);
});
test('UI failures do not affect results or usage', async () => {
  const f = fixture([message('Done')]);
  const r = await runHelper({ task: 'Analyze' }, f.ctx, f.settings, undefined, () => {
    throw new Error('UI unavailable');
  });
  assert.equal(r.status, 'answered');
  assert.equal(r.usage.totalTokens, 10);
});
test('a later tool-only failure preserves the last useful partial answer', async () => {
  const f = fixture(
    [
      message(
        [{ type: 'text', text: 'Found an issue in parsing.' }, call('read', {}, 'a')],
        'toolUse',
      ),
      message([call('read', {}, 'b')], 'toolUse'),
    ],
    {
      execute: (_name, _args) => ({
        toolCall: { id: 'n' },
        isError: true,
        result: { content: [{ type: 'text', text: 'host denied' }] },
      }),
    },
  );
  // Permit the first read, then fail solely through the native outcome flag.
  let count = 0;
  f.ctx.executeTool = async () => ({
    toolCall: { id: `n${++count}` },
    isError: count > 1,
    result: { content: [{ type: 'text', text: count > 1 ? 'host denied' : 'file contents' }] },
  });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
  assert.equal(r.status, 'error');
  assert.equal(r.output, 'Found an issue in parsing.');
  assert.equal(r.lastTool.isError, true);
  assert.equal(f.contexts.length, 2);
  assert.equal(r.usage.totalTokens, 20);
});
test('unavailable tools and invalid arguments cannot dispatch through the host', async () => {
  const f = fixture([message([call('read', 'not-an-object')], 'toolUse')]);
  assert.equal((await runHelper({ task: 'Inspect' }, f.ctx, f.settings)).status, 'error');
  assert.equal(f.executions.length, 0);
  const g = fixture([message([call('bash')], 'toolUse')]);
  g.ctx.tools = [];
  assert.equal(
    (await runHelper({ task: 'Run tests', mode: 'work' }, g.ctx, g.settings)).status,
    'error',
  );
  assert.equal(g.executions.length, 0);
});

test('invalid requests fail before provider or tool access', async () => {
  const f = fixture([]);
  for (const request of [
    { task: ' ' },
    { task: 'x', mode: 'admin' },
    { task: 'x', parentHistory: 'hidden' },
  ])
    await assert.rejects(runHelper(request, f.ctx, f.settings), /valid mode/);
  assert.equal(f.contexts.length, 0);
});
