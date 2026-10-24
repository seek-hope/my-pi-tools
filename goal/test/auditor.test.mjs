import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIndependentAudit, safeAuditPath } from '../src/auditor.ts';

import { applySpec, makeGoal, permissionDefaults } from '../src/state.ts';
import { auditPrompt } from '../src/prompts.ts';
import { defaults } from '../src/settings.ts';
import { permissionReason } from '../src/permissions.ts';
const spec = {
  objective: 'produce result',
  kind: 'general',
  criteria: ['result.txt contains complete'],
  tasks: [],
  checks: [],
};
function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-audit-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'result.txt'), 'complete\n');
  const goal = makeGoal(spec.objective);
  applySpec(goal, spec);
  return { cwd, goal };
}
const usage = { input: 12, output: 5, totalTokens: 17 };
function context(cwd, calls, onContext = () => {}, responseUsage = usage) {
  let i = 0;
  return {
    cwd,
    model: { provider: 'fixture', id: 'test' },
    modelRegistry: {
      streamSimple(_model, ctx, options) {
        onContext(ctx, options);
        const content = calls[i++];
        return {
          async result() {
            return { role: 'assistant', content, usage: responseUsage, stopReason: 'toolUse' };
          },
        };
      },
    },
  };
}
const call = (name, args) => ({ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args });
const verdict = (passed = true) =>
  call('audit_result', {
    details: 'Checked result.txt:1',
    findings: [{ criterionId: 'C1', passed, evidence: 'result.txt:1 = complete' }],
  });
test('auditor must actually inspect an artifact before passing; cost includes every request', async (t) => {
  const { cwd, goal } = setup(t);
  const ctx = context(
    cwd,
    [[verdict()], [call('audit_read', { path: 'result.txt' })], [verdict()]],
    (input) => {
      assert.equal(input.messages[0].role, 'user');
      assert.ok(!input.tools.some((t) => t.name === 'bash'));
    },
  );
  const result = await runIndependentAudit(goal, 'done', ctx, defaults);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.tokens, 51);
});
test('auditor must see inspection results before submitting a verdict, even in a batched response', async (t) => {
  const { cwd, goal } = setup(t);
  const result = await runIndependentAudit(
    goal,
    'done',
    context(
      cwd,
      [[call('audit_read', { path: 'result.txt' }), verdict()], [verdict()]],
      (input) => {
        const results = input.messages.filter((m) => m.role === 'toolResult');
        if (results.length) {
          assert.equal(results.at(-1).toolName, 'audit_result');
          assert.equal(results.at(-1).isError, true);
          assert.match(results.at(-1).content[0].text, /next response/);
        }
      },
    ),
    defaults,
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.diagnostics.requests, 2);
});
test('audit instructions and tool descriptions distinguish navigation from later-response inspection', async (t) => {
  const { cwd, goal } = setup(t);
  const ctx = context(
    cwd,
    [
      [call('audit_list', { path: '.' })],
      [verdict()],
      [call('audit_read', { path: 'result.txt' })],
      [verdict()],
    ],
    (input) => {
      const prompt = input.messages[0].content;
      assert.match(
        prompt,
        /audit_list is navigation only and does not satisfy artifact inspection/,
      );
      assert.match(prompt, /only in a later model response after receiving and reviewing/);
      assert.match(
        input.tools.find((t) => t.name === 'audit_result').description,
        /exactly one finding per criterion/,
      );
      assert.match(input.tools.find((t) => t.name === 'audit_list').description, /does not count/);
      const failed = input.messages.find(
        (m) => m.role === 'toolResult' && m.toolName === 'audit_result',
      );
      if (failed) {
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /next response/);
      }
    },
  );
  const result = await runIndependentAudit(goal, 'done', ctx, defaults);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.diagnostics.requests, 4);
});

test('Pi malformed-JSON tool calls with empty arguments cannot inspect or submit an audit', async (t) => {
  const { cwd, goal } = setup(t);
  // Pi 1.3 replaces malformed final JSON with {} and carries argumentsError.
  // All audit tools require parameters, so the existing schema gate must fail closed.
  const malformed = (name) => ({
    ...call(name, {}),
    argumentsError: 'Invalid JSON object: {"path":"result.txt",',
  });
  const invalid = [
    'audit_read',
    'audit_search',
    'audit_list',
    'audit_record',
    'audit_check',
    'audit_result',
  ].map(malformed);
  const result = await runIndependentAudit(
    goal,
    'done',
    context(
      cwd,
      [
        invalid,
        [verdict()],
        [call('audit_read', { path: 'result.txt' })],
        [malformed('audit_result')],
        [verdict()],
      ],
      (input) => {
        const results = input.messages.filter((m) => m.role === 'toolResult');
        for (const r of results.filter((r) => invalid.some((c) => c.id === r.toolCallId))) {
          assert.equal(r.isError, true);
          assert.match(r.content[0].text, /invalid arguments/);
        }
        if (results.length > invalid.length) {
          assert.equal(results[invalid.length].isError, true);
          assert.match(results[invalid.length].content[0].text, /Independently read/);
        }
      },
    ),
    defaults,
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.diagnostics.requests, 5);
  assert.equal(result.tokens, 85);
  assert.equal(result.diagnostics.toolCalls.audit_read, 1);
  assert.equal(result.diagnostics.toolCalls.audit_result, 2);
});

test('auditor exceeds retired turn/token/output caps with no timeout or forced conclusion', async (t) => {
  const { cwd, goal } = setup(t);
  t.mock.method(AbortSignal, 'timeout', () => assert.fail('no audit timeout may be installed'));
  const controller = new AbortController();
  const settings = { ...defaults, audit: { maxTurns: 1, maxTokens: 1, timeoutSeconds: 1 } };
  const ctx = context(
    cwd,
    [
      ...Array.from({ length: 25 }, () => [call('audit_read', { path: 'result.txt' })]),
      [verdict()],
    ],
    (input, options) => {
      assert.equal(options.signal, controller.signal);
      assert.equal(Object.hasOwn(options, 'maxTokens'), false);
      assert.ok(input.tools.some((tool) => tool.name === 'audit_read'));
      assert.ok(input.tools.some((tool) => tool.name === 'audit_result'));
    },
    { input: 8000, output: 17000, totalTokens: 25000 },
  );
  ctx.model.maxTokens = 384000;
  const result = await runIndependentAudit(goal, 'done', ctx, settings, controller.signal);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.tokens, 650000);
  assert.equal(result.diagnostics.requests, 26);
  assert.equal(result.diagnostics.responses.at(-1).outputTokens, 17000);
});
test('unlimited audit remains cancellable during a provider request', async (t) => {
  const { cwd, goal } = setup(t);
  const controller = new AbortController();
  const ctx = context(cwd, []);
  ctx.modelRegistry.streamSimple = (_model, _input, { signal }) => ({
    result: () =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort(new Error('operator cancelled audit'));
      }),
  });
  const result = await runIndependentAudit(goal, 'done', ctx, defaults, controller.signal);
  assert.equal(result.verdict, 'error');
  assert.match(result.details, /operator cancelled audit/);
  assert.equal(result.errorKind, undefined);
});
test('missing verdict, provider error, missing criterion and cancelled work never pass', async (t) => {
  const { cwd, goal } = setup(t);
  const missing = await runIndependentAudit(goal, 'done', context(cwd, [[]]), defaults);
  assert.equal(missing.verdict, 'error');
  const ctx = context(cwd, [
    [call('audit_read', { path: 'result.txt' })],
    [
      call('audit_result', {
        details: 'done',
        findings: [{ criterionId: 'wrong', passed: true, evidence: 'done' }],
      }),
    ],
    [],
  ]);
  assert.equal((await runIndependentAudit(goal, 'done', ctx, defaults)).verdict, 'error');
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await runIndependentAudit(goal, 'done', context(cwd, []), defaults, controller.signal))
      .verdict,
    'error',
  );
});
test('audit file reader prevents symlink and parent-directory escape', async (t) => {
  const { cwd } = setup(t);
  symlinkSync('/etc/passwd', join(cwd, 'outside'));
  await assert.rejects(safeAuditPath(cwd, 'outside'), /inside the project/);
  await assert.rejects(safeAuditPath(cwd, '/etc/passwd'), /inside the project/);
});
test('audit budget includes replayed input, stops before unaffordable requests and records overshoot', async (t) => {
  const { cwd, goal } = setup(t);
  goal.limits.maxTokens = 10;
  const settings = structuredClone(defaults);
  const stopped = await runIndependentAudit(
    goal,
    'done',
    context(cwd, [], () => {
      assert.fail('an unaffordable request must not start');
    }),
    settings,
  );
  assert.equal(stopped.errorKind, 'budget');
  assert.equal(stopped.tokens, 0);
  assert.equal(stopped.diagnostics.requests, 0);
  const ctx = context(cwd, []);
  ctx.modelRegistry.streamSimple = () => ({
    result: async () => ({
      role: 'assistant',
      content: [verdict()],
      usage: { totalTokens: 70_000 },
      stopReason: 'toolUse',
    }),
  });
  goal.limits.maxTokens = 80_000;
  goal.usage.tokens = 15_000;
  goal.usage.auditTokens = 5_000;
  const exceeded = await runIndependentAudit(goal, 'done', ctx, defaults);
  assert.equal(exceeded.verdict, 'error');
  assert.equal(exceeded.errorKind, 'budget');
  assert.equal(exceeded.tokens, 70_000);
  assert.equal(exceeded.diagnostics.requests, 1);
  assert.match(exceeded.details, /70000\/60000/);
});
test('explicit goal budget constrains audit output without reinstating a separate audit cap', async (t) => {
  const { cwd, goal } = setup(t);
  goal.limits.maxTokens = 100000;
  goal.usage.tokens = 50000;
  goal.usage.auditTokens = 10000;
  const ctx = context(
    cwd,
    [[call('audit_read', { path: 'result.txt' })], [verdict()]],
    (_input, options) => {
      assert.equal(options.maxTokens, 32000);
    },
  );
  ctx.model.maxTokens = 32000;
  const result = await runIndependentAudit(goal, 'done', ctx, defaults);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.tokens, 34);
});

test('audit prompt keeps the contract while long records remain retrievable and cannot substitute for inspection', async (t) => {
  const { cwd, goal } = setup(t);
  const evidence = 'review/path:101 evidence '.repeat(1000);
  goal.criteria[0].evidence = ['old evidence', evidence];
  goal.tasks = [{ id: 'T1', text: 'Inspect result', status: 'done', evidence: [evidence] }];
  goal.inputs = ['Preserve the original result'];
  goal.checks = [
    {
      id: 'K1',
      command: 'test -f result.txt',
      timeoutSeconds: 5,
      last: { at: '2026-10-06', command: 'test -f result.txt', exitCode: 0, output: evidence },
    },
  ];
  const snapshot = structuredClone(goal);
  const prompt = auditPrompt(goal, 'Claim of completion');
  assert.ok(prompt.length < JSON.stringify(goal).length / 5);
  const projected = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.equal(projected.objective, goal.objective);
  assert.equal(projected.criteria[0].text, goal.criteria[0].text);
  assert.equal(projected.tasks[0].text, goal.tasks[0].text);
  assert.deepEqual(projected.supplements, goal.inputs);
  assert.equal(projected.checks[0].command, goal.checks[0].command);
  assert.equal(projected.checks[0].last.exitCode, 0);
  const pages = Array.from({ length: Math.ceil(evidence.length / 4000) }, (_, i) =>
    call('audit_record', { source: 'criterion', id: 'C1', offset: 1 + i * 4000 }),
  );
  let inspectedRecords = false;
  const ctx = context(
    cwd,
    [
      [
        ...pages,
        call('audit_record', { source: 'criterion', id: 'C1', index: 0 }),
        call('audit_record', { source: 'task', id: 'T1', chars: 30 }),
        call('audit_record', { source: 'check', id: 'K1', chars: 20 }),
        verdict(),
      ],
      [call('audit_read', { path: 'result.txt' })],
      [verdict()],
    ],
    (input) => {
      const results = input.messages.filter((m) => m.role === 'toolResult');
      if (!inspectedRecords && results.length) {
        inspectedRecords = true;
        const records = results
          .filter((r) => r.toolName === 'audit_record')
          .map((r) => JSON.parse(r.content[0].text));
        assert.equal(
          records
            .slice(0, pages.length)
            .map((r) => r.text)
            .join(''),
          evidence,
        );
        assert.equal(records[0].nextOffset, 4001);
        assert.equal(records[pages.length - 1].nextOffset, null);
        assert.equal(records[pages.length].text, 'old evidence');
        assert.equal(records.at(-2).text, evidence.slice(0, 30));
        assert.equal(records.at(-1).text, evidence.slice(0, 20));
        assert.equal(results.at(-1).isError, true);
        assert.match(results.at(-1).content[0].text, /Independently read/);
      }
    },
  );
  const updates = [];
  const result = await runIndependentAudit(goal, 'done', ctx, defaults, undefined, (text) =>
    updates.push(text),
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.diagnostics.requests, 3);
  assert.equal(result.diagnostics.toolCalls.audit_read, 1);
  assert.ok(updates.some((text) => text.includes('round 3')));
  assert.deepEqual(goal, snapshot);
});
test('bounded file reads report continuation and search locates distant evidence without path escape', async (t) => {
  const { cwd, goal } = setup(t);
  writeFileSync(
    join(cwd, 'large.txt'),
    Array.from({ length: 4000 }, (_, i) =>
      i === 3998 ? 'unique-evidence' : 'line content '.repeat(30),
    ).join('\n'),
  );
  symlinkSync('/etc/passwd', join(cwd, 'outside'));
  const result = await runIndependentAudit(
    goal,
    'done',
    context(
      cwd,
      [
        [
          call('audit_read', { path: 'large.txt', lines: 500 }),
          call('audit_search', { path: 'large.txt', text: 'unique-evidence' }),
          call('audit_search', { path: 'outside', text: 'root' }),
        ],
        [verdict()],
      ],
      (input) => {
        const results = input.messages.filter((m) => m.role === 'toolResult');
        if (!results.length) return;
        assert.ok(results[0].content[0].text.length < 8200);
        assert.match(results[0].content[0].text, /next offset 21/);
        assert.match(results[1].content[0].text, /3999: unique-evidence/);
        assert.equal(results[2].isError, true);
        assert.match(results[2].content[0].text, /inside the project/);
      },
    ),
    defaults,
    undefined,
    () => {
      throw new Error('broken UI');
    },
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.tokens, 34);
});
test('audit_check is not available to the read-only reviewer', async (t) => {
  const { cwd, goal } = setup(t);
  goal.checks = [{ id: 'K1', command: 'touch should-not-exist' }];
  let rejected = false;
  await runIndependentAudit(
    goal,
    'done',
    context(
      cwd,
      [
        [call('audit_check', { id: 'K1' })],
        [call('audit_read', { path: 'result.txt' })],
        [verdict()],
      ],
      (input) => {
        const result = input.messages.find(
          (m) => m.role === 'toolResult' && m.toolName === 'audit_check',
        );
        if (result) {
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /Unknown tool/);
          rejected = true;
        }
      },
    ),
    defaults,
  );
  assert.equal(rejected, true);
  assert.equal(existsSync(join(cwd, 'should-not-exist')), false);
});
test('reviewer yields an identified information request without write or execution capabilities', async (t) => {
  const { cwd, goal } = setup(t);
  const ctx = context(
    cwd,
    [[call('audit_request', { criterionId: 'C1', question: 'Where is the result?' })]],
    (input) => {
      assert.deepEqual(
        input.tools.map((t) => t.name).sort(),
        [
          'audit_read',
          'audit_search',
          'audit_record',
          'audit_list',
          'audit_request',
          'audit_result',
        ].sort(),
      );
    },
  );
  const result = await runIndependentAudit(goal, 'done', ctx, defaults);
  assert.equal(result.verdict, 'needs_info');
  assert.equal(result.requests[0].generation, goal.generation);
  assert.ok(result.requests[0].id);
  assert.equal(result.tokens, 17);
  assert.equal(result.diagnostics.requests, 1);
});

test('fresh review can read a full answer but that answer alone does not satisfy inspection', async (t) => {
  const { cwd, goal } = setup(t);
  goal.auditRequests = [
    {
      id: 'question',
      generation: goal.generation,
      at: 'now',
      criterionId: 'C1',
      question: 'Where?',
      answer: { at: 'now', text: 'result.txt:1 complete' },
    },
  ];
  const result = await runIndependentAudit(
    goal,
    'done',
    context(
      cwd,
      [
        [call('audit_record', { source: 'request', id: 'question' })],
        [verdict()],
        [call('audit_read', { path: 'result.txt' })],
        [verdict()],
      ],
      (input) => {
        const answer = input.messages.find(
          (m) => m.role === 'toolResult' && m.toolName === 'audit_record',
        );
        if (answer) assert.match(answer.content[0].text, /result.txt:1 complete/);
      },
    ),
    defaults,
  );
  assert.equal(result.verdict, 'pass');
  assert.equal(result.diagnostics.requests, 4);
});

test('an information request cannot be bypassed by a pass in the same response', async (t) => {
  const { cwd, goal } = setup(t);
  const result = await runIndependentAudit(
    goal,
    'done',
    context(cwd, [
      [call('audit_read', { path: 'result.txt' })],
      [
        verdict(),
        call('audit_request', { criterionId: 'C1', question: 'Explain the boundary case' }),
      ],
    ]),
    defaults,
  );
  assert.equal(result.verdict, 'needs_info');
});

test('request cannot name an unapproved check or an unknown criterion', async (t) => {
  const { cwd, goal } = setup(t);
  const result = await runIndependentAudit(
    goal,
    'done',
    context(cwd, [
      [call('audit_request', { criterionId: 'C9', question: 'New scope' })],
      [call('audit_request', { criterionId: 'C1', question: 'Run it', checkId: 'K9' })],
      [call('audit_request', { criterionId: 'C1', question: 'Clarify the existing artifact' })],
    ]),
    defaults,
  );
  assert.equal(result.verdict, 'needs_info');
  assert.equal(result.diagnostics.requests, 3);
});

test('opt-in confirm policy distinguishes checks, installation, publication and paths outside project', (t) => {
  const { cwd } = setup(t);
  const policy = permissionDefaults('confirm');
  assert.equal(permissionReason('bash', { command: 'npm test' }, cwd, policy), undefined);
  for (const command of [
    'git push origin main',
    'git -C . commit -m x',
    'npm publish',
    'rm -rf data',
    'npm install x',
    'ssh host true',
  ])
    assert.ok(permissionReason('bash', { command }, cwd, policy), command);
  assert.ok(permissionReason('write', { path: '/tmp/outside-goal.txt' }, cwd, policy));
});
