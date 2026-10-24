import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoalRuntime } from '../src/runtime.ts';
import { activeGoal } from '../src/state.ts';
import { writeFileSync } from 'node:fs';
import { WORK_RULES, goalContext, kickoffPrompt, continuationPrompt } from '../src/prompts.ts';

async function harness(t, deps = {}, cwdOverride, sessionId = 'test-session', savedEntries = []) {
  const cwd = cwdOverride ?? mkdtempSync(join(tmpdir(), 'goal-runtime-test-'));
  const events = new Map(),
    tools = new Map(),
    commands = new Map(),
    messages = [],
    entries = savedEntries;
  let aborted = false;
  const pi = {
    on(name, fn) {
      events.set(name, fn);
      return () => {};
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, cmd) {
      commands.set(name, cmd);
    },
    getActiveTools() {
      return [...tools.keys()];
    },
    sendMessage(m, opts) {
      messages.push({ ...m, opts });
    },
    appendEntry(type, data) {
      entries.push({ type: 'custom', customType: type, data });
    },
  };
  const ctx = {
    cwd,
    mode: 'json',
    hasUI: false,
    signal: undefined,
    isIdle: () => true,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
    abort() {
      aborted = true;
    },
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    ui: { notify() {}, setStatus() {}, setWidget() {}, confirm: async () => true },
  };
  const { check, ...runtimeDeps } = deps;
  ctx.executeTool = async (name, args, options) => {
    assert.equal(name, 'bash');
    const result = check
      ? await check(cwd, { command: args.command }, options.signal)
      : { exitCode: 0, output: 'passed' };
    await events.get('tool_result')?.(
      {
        toolName: name,
        toolCallId: 'main-check-call',
        parentToolCallId: 'test-tool',
        input: args,
      },
      ctx,
    );
    return {
      toolCall: { id: 'main-check-call', name, arguments: args },
      isError: result.exitCode !== 0,
      result: {
        content: [{ type: 'text', text: result.output }],
        structuredContent: { exit_code: result.exitCode },
      },
    };
  };
  const rt = new GoalRuntime(pi, {
    ...runtimeDeps,
    agentDir: join(cwd, 'fake-agent'),
  });
  rt.register();
  await events.get('session_start')({}, ctx);
  t.after(() => {
    rt.shutdown();
    if (!cwdOverride) rmSync(cwd, { recursive: true, force: true });
  });
  return {
    rt,
    ctx,
    events,
    tools,
    entries,
    messages,
    get aborted() {
      return aborted;
    },
    async cmd(text) {
      await commands.get('goal').handler(text, ctx);
    },
    async emit(name, value = {}) {
      return await events.get(name)?.(value, ctx);
    },
    goal() {
      return activeGoal(rt.state);
    },
    async tool(name, params) {
      return await tools.get(name).execute('test-tool', params, undefined, undefined, ctx);
    },
  };
}
async function until(ready) {
  for (let i = 0; i < 1000; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('Expected asynchronous work to start');
}
async function start(h, objective = 'Fix bug') {
  await h.cmd(`start ${objective}`);
  const g = h.goal();
  await h.tool('goal_plan', {
    goal_id: g.id,
    generation: g.generation,
    spec: { objective, kind: 'coding', criteria: ['Bug is fixed'], tasks: [], checks: [] },
  });
}
async function evidence(h) {
  const g = h.goal();
  await h.tool('goal_progress', {
    goal_id: g.id,
    generation: g.generation,
    criterion_id: 'C1',
    evidence: 'result.txt:1',
    note: 'fixed',
    next_step: 'submit',
  });
}
const boundary = { outcome: 'completed', context: { canContinue: true, pendingMessages: [] } };
const turn = {
  message: { role: 'assistant', usage: { totalTokens: 25 } },
  toolResults: [],
  outcome: 'completed',
};
const audit = (verdict = 'pass') => ({
  at: new Date().toISOString(),
  verdict,
  details: 'fixture artifact check',
  model: 'fixture',
  findings: [{ criterionId: 'C1', passed: verdict === 'pass', evidence: 'result.txt:1' }],
  tokens: 10,
  usageUnknown: false,
});

test('normal completion goes through fresh audit and charges final turn', async (t) => {
  let calls = 0;
  const h = await harness(t, {
    audit: async () => {
      calls++;
      return audit();
    },
  });
  await start(h);
  await evidence(h);
  await h.emit('turn_start');
  const g = h.goal();
  await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  await h.emit('turn_end', turn);
  assert.equal(calls, 1);
  assert.equal(h.goal().status, 'complete');
  assert.equal(h.goal().usage.tokens, 25);
  assert.equal(h.goal().usage.auditTokens, 10);
});
test('runtime continues past legacy round/time caps and submits without a deadline', async (t) => {
  t.mock.method(AbortSignal, 'timeout', () => assert.fail('no submit timeout may be installed'));
  let calls = 0;
  const h = await harness(t, {
    check: async (_cwd, check, signal) => {
      assert.equal(signal.aborted, false);
      calls++;
      return { at: 'now', command: check.command, exitCode: 0, output: 'checked' };
    },
    audit: async (_g, _summary, _ctx, settings, signal) => {
      assert.deepEqual(settings.audit, {});
      assert.equal(signal.aborted, false);
      return audit();
    },
  });
  await start(h);
  await evidence(h);
  h.rt.store.change('legacy.fixture', (s) => {
    const g = activeGoal(s);
    g.epoch.turns = 200;
    g.epoch.seconds = 43201;
    g.limits.maxTurns = 100;
    g.limits.maxSeconds = 1;
    g.checks = [{ id: 'K1', command: 'true', timeoutSeconds: 1 }];
  });
  await h.emit('turn_start');
  await h.emit('turn_end', turn);
  assert.equal(h.goal().epoch.turns, 201);
  assert.equal(h.goal().status, 'active');
  assert.equal((await h.emit('agent_before_settle', boundary)).continue, true);
  assert.equal(h.aborted, false);
  const limits = structuredClone(h.goal().limits);
  await h.cmd('limits 1 1'); // Removed command must not reintroduce caps.
  assert.deepEqual(h.goal().limits, limits);
  assert.equal(
    Object.hasOwn(
      h.tools.get('goal_plan').parameters.properties.spec.properties.checks.items.properties,
      'timeoutSeconds',
    ),
    false,
  );
  const g = h.goal();
  await h.tool('goal_check', { goal_id: g.id, generation: g.generation, check_id: 'K1' });
  await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  assert.equal(calls, 1);
  assert.equal(h.goal().status, 'complete');
});

test('cannot submit unfinished work; draft planning stops until exact revision approved', async (t) => {
  const h = await harness(t);
  await h.cmd('Complete research analysis and produce a report');
  let g = h.goal();
  assert.equal(g.status, 'draft');
  await h.tool('goal_plan', {
    goal_id: g.id,
    generation: g.generation,
    spec: { objective: g.objective, kind: 'research', criteria: ['report'], tasks: [], checks: [] },
  });
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
  g = h.goal();
  await h.cmd(`approve-exact ${g.id} ${g.revision}`);
  assert.equal(h.goal().status, 'active');
  g = h.goal();
  await assert.rejects(
    h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' }),
    /missing evidence/,
  );
});
test('audit cumulative budget errors retain cost/evidence and resume only after the goal budget changes', async (t) => {
  const h = await harness(t, {
    audit: async (_goal, _summary, _ctx, _settings, _signal, progress) => {
      progress('Independent audit progress');
      return {
        ...audit('error'),
        errorKind: 'budget',
        details: 'cumulative input budget exhausted',
        tokens: 70_000,
      };
    },
  });
  await start(h);
  await evidence(h);
  const before = structuredClone(h.goal().criteria);
  await h.cmd('budget 60k');
  const g = h.goal();
  const updates = [];
  const submitted = await h.tools.get('goal_submit').execute(
    'submit',
    {
      goal_id: g.id,
      generation: g.generation,
      summary: 'done',
    },
    undefined,
    (update) => updates.push(update.content[0].text),
    h.ctx,
  );
  assert.equal(submitted.terminate, true);
  assert.equal(h.goal().status, 'budget_limited');
  assert.equal(h.goal().consecutiveAuditFailures, 0);
  assert.equal(h.goal().usage.auditTokens, 70_000);
  assert.equal(h.goal().audits.at(-1).errorKind, 'budget');
  assert.match(h.goal().reason, /cumulative token budget/i);
  assert.deepEqual(h.goal().criteria, before);
  assert.ok(updates.includes('Independent audit progress'));
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
  await h.cmd('resume');
  assert.equal(h.goal().status, 'budget_limited');
  await h.cmd('budget none');
  await h.cmd('resume');
  assert.equal(h.goal().status, 'active');
  assert.deepEqual(h.goal().criteria, before);
  const status = await h.tool('goal_status', {});
  assert.deepEqual(JSON.parse(status.content[0].text).auditSettings, {});
  const current = await h.emit('context', { messages: [] });
  const projection = current.messages.find((m) => m.customType === 'my-pi-goal-current').content;
  assert.match(projection, /"auditSettings":\{\}/);
  assert.doesNotMatch(projection, /"auditLimits"|"maxTurns"|"maxSeconds"/);
  assert.match(projection, /"consecutiveAuditFailures":0/);
});
test('pause invalidates stale tools and pending audit results', async (t) => {
  let finish, began;
  const started = new Promise((r) => (began = r));
  const h = await harness(t, {
    audit: async () => {
      began();
      return await new Promise((r) => (finish = r));
    },
  });
  await start(h);
  await evidence(h);
  const old = h.goal();
  const pending = h.tool('goal_submit', {
    goal_id: old.id,
    generation: old.generation,
    summary: 'done',
  });
  await started;
  await h.cmd('pause');
  finish(audit());
  await pending;
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().usage.auditTokens, 10);
  await assert.rejects(
    h.tool('goal_progress', {
      goal_id: old.id,
      generation: old.generation,
      note: 'stale',
      next_step: 'x',
    }),
    /changed/,
  );
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
});
test('new user requirements during audit invalidate completion and retain the objective', async (t) => {
  let finish, began;
  const started = new Promise((r) => (began = r));
  const h = await harness(t, {
    audit: async () => {
      began();
      return await new Promise((r) => (finish = r));
    },
  });
  await start(h);
  await evidence(h);
  const g = h.goal();
  const pending = h.tool('goal_submit', {
    goal_id: g.id,
    generation: g.generation,
    summary: 'done',
  });
  await started;
  await h.emit('input', { source: 'interactive', text: 'Also handle Unicode inputs' });
  finish(audit());
  await pending;
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().objective, 'Fix bug');
  assert.deepEqual(h.goal().inputs, ['Also handle Unicode inputs']);
});
test('queue only advances to an approved goal after audited completion', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await start(h);
  await evidence(h);
  await h.cmd('add Second goal');
  const queued = h.rt.state.goals[1];
  await h.tool('goal_plan', {
    goal_id: queued.id,
    generation: queued.generation,
    spec: {
      objective: queued.objective,
      kind: 'coding',
      criteria: ['second result'],
      tasks: [],
      checks: [],
    },
  });
  assert.equal(h.rt.state.goals[1].status, 'draft');
  assert.equal(h.goal().status, 'active');
  const proposal = h.rt.state.goals[1];
  await h.cmd(`approve-exact ${proposal.id} ${proposal.revision}`);
  const g = h.goal();
  await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  const next = await h.emit('agent_before_settle', boundary);
  assert.equal(next.continue, true);
  assert.equal(h.goal().id, proposal.id);
  assert.equal(h.goal().status, 'active');
});
test('formal FIFO counterexample: adding after skip must not bypass an earlier draft', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('add Earlier draft');
  const earlier = h.rt.state.goals[1];
  h.ctx.hasUI = true;
  await h.cmd('skip');
  assert.equal(h.rt.state.activeId, null);
  await h.cmd('add Later draft');
  assert.equal(h.rt.state.activeId, earlier.id);
  assert.equal(h.goal().status, 'draft');
  assert.equal(h.rt.state.queuePaused, true);
});

test('formal FIFO counterexample: adding after completion keeps the older queued head', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await start(h);
  await evidence(h);
  await h.cmd('add Earlier goal');
  const earlier = h.rt.state.goals[1];
  await h.tool('goal_plan', {
    goal_id: earlier.id,
    generation: earlier.generation,
    spec: {
      objective: earlier.objective,
      kind: 'coding',
      criteria: ['ready'],
      tasks: [],
      checks: [],
    },
  });
  const proposal = h.rt.state.goals[1];
  await h.cmd(`approve-exact ${proposal.id} ${proposal.revision}`);
  const current = h.goal();
  await h.tool('goal_submit', {
    goal_id: current.id,
    generation: current.generation,
    summary: 'done',
  });
  await h.cmd('add Later goal');
  assert.equal(h.rt.state.activeId, current.id);
  assert.equal(h.goal().status, 'complete');
  assert.equal((await h.emit('agent_before_settle', boundary)).continue, true);
  assert.equal(h.rt.state.activeId, earlier.id);
  assert.equal(h.goal().status, 'active');
});

test('formal ownership counterexample: old audit cannot write after another store takes over', async (t) => {
  let finish, began;
  const started = new Promise((resolve) => (began = resolve));
  const first = await harness(t, {
    audit: async () => {
      began();
      return await new Promise((resolve) => (finish = resolve));
    },
  });
  await start(first);
  await evidence(first);
  const old = first.goal();
  const pending = first.tool('goal_submit', {
    goal_id: old.id,
    generation: old.generation,
    summary: 'done',
  });
  await started;
  first.rt.shutdown();
  const second = await harness(t, {}, first.ctx.cwd);
  await second.cmd('resume');
  const before = structuredClone(second.rt.state);
  finish(audit());
  const result = await pending;
  assert.match(result.content[0].text, /session changed/);
  assert.deepEqual(second.rt.state, before);
  assert.equal(second.goal().status, 'active');
});

test('formal generation counterexample: late pass cannot complete a new verifying generation', async (t) => {
  const replies = [];
  const h = await harness(t, {
    audit: async () => await new Promise((resolve) => replies.push(resolve)),
  });
  await start(h);
  await evidence(h);
  const old = h.goal();
  const pendingOld = h.tool('goal_submit', {
    goal_id: old.id,
    generation: old.generation,
    summary: 'old',
  });
  await until(() => replies.length === 1);
  assert.equal(replies.length, 1);
  await h.cmd('pause');
  await h.cmd('resume');
  const current = h.goal();
  const pendingCurrent = h.tool('goal_submit', {
    goal_id: current.id,
    generation: current.generation,
    summary: 'new',
  });
  await until(() => replies.length === 2);
  assert.equal(replies.length, 2);
  replies[0](audit());
  const stale = await pendingOld;
  assert.match(stale.content[0].text, /stale verdict discarded/);
  assert.equal(h.goal().status, 'verifying');
  assert.equal(h.goal().generation, current.generation);
  assert.equal(h.goal().audits.length, 0);
  assert.equal(h.goal().usage.auditTokens, 10);
  replies[1](audit('fail'));
  await pendingCurrent;
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().audits.length, 1);
  assert.equal(h.goal().audits[0].verdict, 'fail');
  assert.equal(h.goal().usage.auditTokens, 20);
});

test('failed audit allows exactly three repair cycles then blocks', async (t) => {
  const h = await harness(t, { audit: async () => audit('fail') });
  await start(h);
  await evidence(h);
  for (let i = 0; i < 4; i++) {
    const g = h.goal();
    await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
    assert.equal(h.goal().status, i < 3 ? 'active' : 'blocked');
  }
});
test('settled continuation yields to queued input, cancellation and no-progress limits', async (t) => {
  const h = await harness(t);
  await start(h);
  assert.equal(
    await h.emit('agent_before_settle', {
      ...boundary,
      context: { ...boundary.context, pendingMessages: [{}] },
    }),
    undefined,
  );
  assert.equal((await h.emit('agent_before_settle', boundary)).continue, true);
  for (let i = 0; i < 6; i++) {
    await h.emit('turn_start');
    await h.emit('turn_end', turn);
  }
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
  assert.equal(h.goal().status, 'blocked');
  await h.cmd('resume');
  await h.emit('agent_before_settle', { ...boundary, outcome: 'aborted' });
  assert.equal(h.goal().status, 'paused');
});
test('budget stops within a tool loop and resume requires increasing the total allowance', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('budget 20');
  await h.emit('turn_start');
  await h.emit('turn_end', turn);
  assert.equal(h.goal().status, 'budget_limited');
  assert.ok(h.aborted);
  await h.cmd('resume');
  assert.equal(h.goal().status, 'budget_limited');
  await h.cmd('budget 100');
  await h.cmd('resume');
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().usage.tokens, 25);
});
test('repeated identical tool results do not reset no-progress even when host duration changes', async (t) => {
  const h = await harness(t);
  await start(h);
  for (let i = 0; i < 4; i++) {
    await h.emit('turn_start');
    await h.emit('tool_execution_start', {
      toolCallId: String(i),
      toolName: 'read',
      args: { path: 'x' },
    });
    await h.emit('tool_execution_end', {
      toolCallId: String(i),
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'same' }], durationMs: 20 * i },
      durationMs: 20 * i,
      isError: false,
    });
    await h.emit('turn_end', turn);
  }
  assert.equal(h.goal().noProgressTurns, 3);
});
test('opt-in confirm mode without UI blocks instead of auto-approving', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('permissions confirm');
  const decision = await h.emit('tool_call', {
    toolName: 'bash',
    input: { command: 'git push origin main' },
  });
  assert.ok(decision.block);
  assert.equal(h.goal().status, 'blocked');
  assert.match(h.goal().reason, /approval|publish|remote/);
});
test('autonomous work proceeds without dialogs, including external tools and dependency commands', async (t) => {
  const h = await harness(t);
  await start(h);
  h.ctx.hasUI = true;
  let prompts = 0;
  h.ctx.ui.confirm = async () => {
    prompts++;
    return false;
  };
  for (const input of [
    { toolName: 'bash', input: { command: 'npm install dependency' } },
    { toolName: 'bash', input: { command: 'curl https://example.com/reference' } },
    { toolName: 'bash', input: { command: 'rm -rf ./temporary-build' } },
    { toolName: 'write', input: { path: '/tmp/analysis-intermediate.json' } },
    { toolName: 'mcp__research__search', input: { query: 'research question' } },
    { toolName: 'bash', input: { command: 'ssh approved-host run-analysis' } },
  ])
    assert.equal(await h.emit('tool_call', input), undefined);
  assert.equal(prompts, 0);
  assert.equal(h.goal().status, 'active');
  assert.deepEqual(h.goal().permissionPolicy, {
    mode: 'autonomous',
    network: 'allow',
    install: 'allow',
  });
  const context = await h.emit('context', { messages: [] });
  assert.match(
    context.messages.find((m) => m.customType === 'my-pi-goal-current').content,
    /"executionPermissions":\{"mode":"autonomous"/,
  );
});

test('autonomous mode preserves draft, pause, budget and audit boundaries', async (t) => {
  const h = await harness(t);
  await h.cmd('Analyze experimental data and write a research report');
  await h.cmd('permissions autonomous');
  assert.ok(
    (await h.emit('tool_call', { toolName: 'bash', input: { command: 'npm test' } })).block,
  );
  let g = h.goal();
  await h.tool('goal_plan', {
    goal_id: g.id,
    generation: g.generation,
    spec: { objective: g.objective, kind: 'research', criteria: ['report'], tasks: [], checks: [] },
  });
  assert.equal(h.goal().status, 'draft');
  g = h.goal();
  await h.cmd(`approve-exact ${g.id} ${g.revision}`);
  g = h.goal();
  await assert.rejects(
    h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' }),
    /missing evidence/,
  );
  await h.cmd('pause');
  assert.ok(
    (await h.emit('tool_call', { toolName: 'write', input: { path: 'result.txt' } })).block,
  );
});

test('switching policy recovers a permission blocker and persists across restart', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('permissions confirm');
  const old = h.goal();
  await h.emit('tool_call', { toolName: 'bash', input: { command: 'npm install dependency' } });
  assert.equal(h.goal().status, 'blocked');
  await h.cmd('permissions autonomous');
  assert.ok(h.goal().generation > old.generation);
  await h.cmd('resume');
  assert.equal(
    await h.emit('tool_call', { toolName: 'bash', input: { command: 'npm install dependency' } }),
    undefined,
  );
  h.rt.shutdown();
  await h.rt.init(h.ctx);
  assert.equal(h.goal().permissionPolicy.mode, 'autonomous');
  assert.equal(h.goal().status, 'paused');
  await h.cmd('resume');
  assert.equal(h.goal().status, 'active');
});

test('task amendments wait for approval and then preserve evidence; identical scope is a no-op', async (t) => {
  const h = await harness(t);
  await start(h);
  await evidence(h);
  const spec = {
    objective: 'Fix bug',
    kind: 'coding',
    criteria: ['Bug is fixed'],
    tasks: ['Fix', 'Verify'],
    checks: [],
  };
  const propose = async (value) => {
    const g = h.goal();
    return h.tool('goal_plan', { goal_id: g.id, generation: g.generation, spec: value });
  };
  await propose(spec);
  assert.equal(h.goal().status, 'draft');
  assert.deepEqual(h.goal().tasks, []);
  await h.cmd(`approve-exact ${h.goal().id} ${h.goal().revision}`);
  let g = h.goal();
  await h.tool('goal_progress', {
    goal_id: g.id,
    generation: g.generation,
    task_id: 'T1',
    task_status: 'done',
    evidence: 'result.txt:1',
    note: 'implemented',
    next_step: 'verify',
  });
  const generation = h.goal().generation;
  await propose({ ...spec, tasks: ['Verify', 'Fix', 'Inspect edge cases'] });
  assert.equal(h.goal().status, 'draft');
  assert.equal(h.goal().tasks[0].id, 'T1');
  assert.equal(h.goal().tasks.length, 2);
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
  await h.cmd(`approve-exact ${h.goal().id} ${h.goal().revision}`);
  g = h.goal();
  assert.equal(g.status, 'active');
  assert.equal(g.pendingSpec, undefined);
  assert.equal(g.tasks[1].id, 'T1');
  assert.equal(g.tasks[1].status, 'done');
  assert.deepEqual(g.tasks[1].evidence, ['result.txt:1']);
  assert.deepEqual(g.criteria[0].evidence, ['result.txt:1']);
  assert.ok(g.generation > generation);
  assert.equal((await h.emit('agent_before_settle', boundary)).continue, true);
  const version = g.progressVersion;
  await propose({ ...spec, tasks: ['Verify', 'Fix', 'Inspect edge cases'] });
  assert.equal(h.goal().progressVersion, version);
  await propose({ ...spec, criteria: ['Weaker standard'] });
  assert.equal(h.goal().status, 'draft');
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
});

test('confirm mode reuses exact grants and discards outstanding dialogs when policy changes', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('permissions confirm');
  h.ctx.hasUI = true;
  let prompts = 0;
  h.ctx.ui.confirm = async () => {
    prompts++;
    return true;
  };
  const input = { toolName: 'bash', input: { command: 'npm install dependency' } };
  assert.equal(await h.emit('tool_call', input), undefined);
  assert.equal(await h.emit('tool_call', input), undefined);
  assert.equal(prompts, 1);
  assert.equal(h.goal().permissions.length, 1);
  let finish;
  h.ctx.ui.confirm = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = h.emit('tool_call', {
    ...input,
    input: { command: 'npm install other-dependency' },
  });
  await h.cmd('permissions autonomous');
  finish(true);
  const stale = await pending;
  assert.ok(stale.block);
  assert.match(stale.reason, /authorization is stale/);
  assert.equal(h.goal().permissions.length, 0);
  assert.equal(h.goal().permissionPolicy.mode, 'autonomous');
});

test('branch navigation and restart pause; external journal never rewinds with the transcript', async (t) => {
  const h = await harness(t);
  await start(h);
  await evidence(h);
  await h.emit('session_before_tree');
  assert.equal(h.goal().status, 'paused');
  const revision = h.rt.state.revision;
  await h.emit('session_tree');
  assert.equal(h.rt.state.revision, revision);
  h.rt.shutdown();
  await h.rt.init(h.ctx);
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.goal().criteria[0].evidence.length, 1);
});

test('approving a queue item after prior completion can resume without selecting the completed goal', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await start(h);
  await evidence(h);
  await h.cmd('add Second');
  const queued = h.rt.state.goals[1];
  await h.tool('goal_plan', {
    goal_id: queued.id,
    generation: queued.generation,
    spec: {
      objective: queued.objective,
      kind: 'coding',
      criteria: ['second'],
      tasks: [],
      checks: [],
    },
  });
  const first = h.goal();
  await h.tool('goal_submit', { goal_id: first.id, generation: first.generation, summary: 'done' });
  await h.emit('agent_before_settle', boundary);
  assert.equal(h.rt.state.queuePaused, true);
  const proposed = h.rt.state.goals[1];
  await h.cmd(`approve-exact ${proposed.id} ${proposed.revision}`);
  await h.cmd('resume');
  assert.equal(h.goal().id, queued.id);
  assert.equal(h.goal().status, 'active');
});
test('failed mechanical check returns to repair and does not call the independent model', async (t) => {
  let calls = 0;
  const h = await harness(t, {
    audit: async () => {
      calls++;
      return audit();
    },
    check: async (_cwd, c) => ({
      at: new Date().toISOString(),
      command: c.command,
      exitCode: 1,
      output: 'regression still fails',
    }),
  });
  await start(h);
  await evidence(h);
  h.rt.store.change('test-check', (s) => {
    activeGoal(s).checks = [{ id: 'K1', command: 'test regression', timeoutSeconds: 1 }];
  });
  const g = h.goal();
  await h.tool('goal_check', { goal_id: g.id, generation: g.generation, check_id: 'K1' });
  await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  assert.equal(calls, 0);
  assert.equal(h.goal().status, 'active');
  assert.match(h.goal().checks[0].last.output, /regression/);
});
test('explicit pause cancels an unbounded stagnation review even without a host signal', async (t) => {
  let began;
  const started = new Promise((resolve) => (began = resolve));
  const h = await harness(t, {
    stagnation: async (_g, _ctx, _settings, signal) => {
      began();
      return await new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () =>
            resolve({
              details: 'cancelled',
              tokens: 0,
              unknown: false,
            }),
          { once: true },
        ),
      );
    },
  });
  await start(h);
  h.rt.store.change('stalled.fixture', (s) => {
    activeGoal(s).noProgressTurns = 5;
  });
  const pending = h.emit('agent_before_settle', boundary);
  await started;
  await h.cmd('pause');
  await pending;
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.rt.state.queuePaused, true);
});

test('independent stagnation review records guidance and cost before pausing', async (t) => {
  let reviews = 0;
  const diagnosis =
    'Repeated failing command. '.repeat(500) + 'Keep quoted 用户原文; reduce the minimal example.';
  const h = await harness(t, {
    stagnation: async () => {
      reviews++;
      return {
        details: diagnosis,
        tokens: 17,
        unknown: false,
      };
    },
  });
  await start(h);
  for (let i = 0; i < 6; i++) {
    await h.emit('turn_start');
    await h.emit('turn_end', turn);
  }
  await h.emit('agent_before_settle', boundary);
  assert.equal(reviews, 1);
  assert.equal(h.goal().status, 'blocked');
  assert.equal(h.goal().usage.auditTokens, 17);
  assert.match(h.goal().reason, /minimal example/);
  assert.equal(h.goal().notes.at(-1), diagnosis);
  assert.ok(h.messages.at(-1).content.endsWith(diagnosis));
  const stored = h.rt.store.history().at(-1);
  assert.equal(stored.state.goals.find((g) => g.id === h.goal().id).notes.at(-1), diagnosis);
});
test('TUI factory redraws with the current theme without reading the journal during rendering', async (t) => {
  const h = await harness(t);
  await start(h);
  let factory;
  h.ctx.mode = 'tui';
  h.ctx.ui.theme = { fg: (_color, text) => `\x1b[31m${text}\x1b[39m`, bold: (text) => text };
  h.ctx.ui.setWidget = (_key, value) => {
    factory = value;
  };
  await h.cmd('panel expand');
  const component = factory({ terminal: { rows: 24 } }, h.ctx.ui.theme);
  const load = h.rt.store.load;
  h.rt.store.load = () => {
    throw new Error('Journal I/O during render');
  };
  try {
    const red = component.render(80).join('\n');
    h.ctx.ui.theme = { fg: (_color, text) => `\x1b[32m${text}\x1b[39m`, bold: (text) => text };
    component.invalidate();
    const green = component.render(80).join('\n');
    assert.match(red, /\x1b\[31m/);
    assert.match(green, /\x1b\[32m/);
    assert.doesNotMatch(green, /\x1b\[31m/);
    assert.ok(component.render(80).length <= 14);
  } finally {
    h.rt.store.load = load;
  }
});

test('external restrictive tool policy pauses rather than looping without a completion tool', async (t) => {
  const h = await harness(t);
  await start(h);
  h.tools.delete('goal_submit');
  await h.emit('agent_before_settle', boundary);
  assert.equal(h.goal().status, 'paused');
});

for (const missing of ['goal_check', 'goal_reply'])
  test(`missing required ${missing} pauses before requesting impossible continuation`, async (t) => {
    const h = await harness(t);
    if (missing === 'goal_check') await startWithChecks(h);
    else {
      await start(h);
      h.rt.store.change('fixture.request', (s) => {
        const g = activeGoal(s);
        g.auditRequests.push({
          id: 'pending',
          generation: g.generation,
          at: 'now',
          criterionId: 'C1',
          question: 'Where is the result?',
        });
      });
    }
    h.tools.delete(missing);
    assert.equal(await h.emit('agent_before_settle', boundary), undefined);
    assert.equal(h.goal().status, 'paused');
    assert.match(h.goal().reason, new RegExp(missing));
  });
test('tools for absent checks or answered requests are not required for continuation', async (t) => {
  const h = await harness(t);
  await start(h);
  h.tools.delete('goal_check');
  h.tools.delete('goal_reply');
  assert.equal((await h.emit('agent_before_settle', boundary)).continue, true);
});

function captureUI(h) {
  const view = { widget: undefined, status: undefined };
  h.ctx.mode = 'tui';
  h.ctx.ui.setWidget = (_key, value) => {
    view.widget = value;
  };
  h.ctx.ui.setStatus = (_key, value) => {
    view.status = value;
  };
  return view;
}

test('verified goals auto-clear on the next real message, preserve history and survive reload', async (t) => {
  for (const source of ['interactive', 'rpc']) {
    const h = await harness(t, { audit: async () => audit() });
    const view = captureUI(h);
    await start(h);
    await evidence(h);
    await h.emit('turn_start');
    const goal = h.goal();
    await h.tool('goal_submit', { goal_id: goal.id, generation: goal.generation, summary: 'done' });
    await h.emit('turn_end', turn);
    await h.emit('agent_before_settle', boundary);
    await h.emit('agent_settled');
    assert.equal(h.goal().status, 'complete');
    assert.ok(view.widget);
    const old = readFileSync(h.rt.store.file, 'utf8');
    const count = h.messages.length;
    assert.equal(await h.emit('input', { source: 'extension', text: 'Keep going' }), undefined);
    assert.equal(h.goal().status, 'complete');
    const input = { source, text: 'Thanks. Now explain the result.' };
    assert.equal(await h.emit('input', input), undefined);
    assert.equal(input.text, 'Thanks. Now explain the result.');
    assert.equal(h.aborted, false);
    assert.deepEqual(h.rt.state.goals, []);
    assert.equal(h.rt.state.activeId, null);
    assert.equal(h.rt.state.owner, null);
    assert.equal(h.rt.state.clearReason, 'verified');
    assert.equal(view.widget, undefined);
    assert.equal(view.status, undefined);
    assert.ok(readFileSync(h.rt.store.file, 'utf8').startsWith(old));
    assert.equal(h.messages.length, count + 1);
    assert.equal(h.messages.at(-1).opts.triggerTurn, false);
    assert.match(h.messages.at(-1).content, /cleared automatically/);
    const user = { role: 'user', content: input.text };
    const projected = await h.emit('context', { messages: [user] });
    assert.ok(projected.messages.includes(user));
    assert.match(projected.messages.at(-1).content, /No current goal exists/);
    await h.rt.init(h.ctx);
    assert.deepEqual(h.rt.state.goals, []);
    assert.equal(view.widget, undefined);
    const stale = await h.tool('goal_progress', {
      goal_id: goal.id,
      generation: goal.generation,
      note: 'old',
      next_step: 'old',
    });
    assert.equal(stale.details.disposition, 'stale_goal');
  }
});

test('automatic clearing waits for final usage and never aborts the submitted input', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await start(h);
  await evidence(h);
  await h.emit('turn_start');
  const g = h.goal();
  await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  h.ctx.isIdle = () => false;
  await h.emit('input', { source: 'interactive', text: 'My next question' });
  assert.equal(h.goal().status, 'complete');
  assert.equal(h.goal().usage.tokens, 0);
  assert.equal(h.aborted, false);
  await h.emit('turn_end', turn);
  assert.deepEqual(h.rt.state.goals, []);
  assert.equal(h.aborted, false);
  const history = h.rt.store.history();
  const charged = history.findLast((e) => e.event === 'usage.turn');
  const cleared = history.findLast((e) => e.event === 'goal.auto-clear');
  assert.equal(charged.state.goals.find((x) => x.id === g.id).usage.tokens, 25);
  assert.ok(cleared.revision > charged.revision);
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
});

test('auto-clear never removes unfinished queued goals, skipped-only state or another session', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await start(h);
  await evidence(h);
  await h.cmd('add Later work');
  const g = h.goal();
  await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  const before = structuredClone(h.rt.state.goals);
  await h.emit('input', { source: 'interactive', text: 'Next please' });
  assert.deepEqual(h.rt.state.goals, before);
  const other = await harness(t, {}, h.ctx.cwd, 'other-session');
  await start(other, 'Other work');
  const otherBytes = readFileSync(other.rt.store.file, 'utf8');
  // Explicit clear still cancels unfinished work; a skipped goal by itself is not verified.
  await h.cmd('clear');
  await start(h);
  await h.cmd('skip');
  const skipped = structuredClone(h.rt.state);
  await h.emit('input', { source: 'rpc', text: 'Explain' });
  assert.deepEqual(h.rt.state, skipped);
  assert.equal(readFileSync(other.rt.store.file, 'utf8'), otherBytes);
});

test('deferred auto-clear cannot remove replacement work or steal a live owner', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await start(h);
  await evidence(h);
  await h.emit('turn_start');
  const g = h.goal();
  await h.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  await h.emit('input', { source: 'interactive', text: 'Next' });
  await h.cmd('clear');
  await h.cmd('Replacement');
  const before = structuredClone(h.rt.state.goals);
  await h.emit('turn_end', turn);
  assert.deepEqual(h.rt.state.goals, before);
  let r = h.goal();
  await h.tool('goal_plan', {
    goal_id: r.id,
    generation: r.generation,
    spec: { objective: r.objective, kind: 'coding', criteria: ['done'], tasks: [], checks: [] },
  });
  await evidence(h);
  r = h.goal();
  await h.tool('goal_submit', { goal_id: r.id, generation: r.generation, summary: 'done' });
  const observer = await harness(t, {}, h.ctx.cwd);
  const journal = readFileSync(h.rt.store.file, 'utf8');
  await observer.emit('input', { source: 'interactive', text: 'New message' });
  assert.equal(readFileSync(h.rt.store.file, 'utf8'), journal);
  assert.equal(observer.aborted, false);
});

test('clear removes session goals and queue, hides UI, retains journal history and survives reload', async (t) => {
  const h = await harness(t);
  const view = captureUI(h);
  await start(h);
  await evidence(h);
  await h.cmd('add Later');
  assert.ok(view.widget);
  const journal = h.rt.store.file;
  const prior = readFileSync(journal, 'utf8');
  h.ctx.ui.confirm = async () => {
    throw new Error('clear must not request redundant approval');
  };
  await h.cmd('clear');
  assert.deepEqual(h.rt.state.goals, []);
  assert.equal(h.rt.state.activeId, null);
  assert.equal(h.rt.state.owner, null);
  assert.equal(h.rt.state.queuePaused, true);
  assert.equal(view.widget, undefined);
  assert.equal(view.status, undefined);
  assert.equal(h.aborted, true);
  assert.ok(readFileSync(journal, 'utf8').startsWith(prior));
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
  await h.rt.init(h.ctx);
  assert.deepEqual(h.rt.state.goals, []);
  assert.equal(view.widget, undefined);
  await h.cmd('clear');
  assert.equal(h.rt.state.owner, null);
  await start(h, 'New goal');
  assert.ok(view.widget);
  assert.equal(h.goal().objective, 'New goal');
});

test('panel can hide independently, persists on reload and resets across session replacement/fork', async (t) => {
  const h = await harness(t);
  const view = captureUI(h);
  await start(h);
  await h.cmd('panel hide');
  assert.equal(view.widget, undefined);
  assert.ok(view.status);
  assert.equal(h.goal().status, 'active');
  await h.rt.init(h.ctx);
  assert.equal(view.widget, undefined);
  await h.cmd('panel');
  assert.ok(view.widget);
  await h.cmd('panel');
  assert.equal(view.widget, undefined);
  const firstFile = h.rt.store.file;
  h.ctx.sessionManager.getSessionId = () => 'forked-session';
  await h.rt.init(h.ctx);
  assert.notEqual(h.rt.store.file, firstFile);
  assert.deepEqual(h.rt.state.goals, []);
  assert.equal(view.widget, undefined);
  assert.equal(view.status, undefined);
  await start(h, 'Fork goal');
  assert.ok(view.widget);
  h.ctx.sessionManager.getSessionId = () => 'test-session';
  await h.rt.init(h.ctx);
  assert.equal(h.goal().objective, 'Fix bug');
  assert.equal(view.widget, undefined);
});

test('same-directory sessions stay independent when one clears and retain independent UI choices', async (t) => {
  const a = await harness(t);
  const av = captureUI(a);
  await start(a, 'Session A');
  const b = await harness(t, {}, a.ctx.cwd, 'B', structuredClone(a.entries));
  const bv = captureUI(b);
  assert.deepEqual(b.rt.state.goals, []);
  await start(b, 'Session B');
  await b.cmd('panel expand');
  const before = readFileSync(b.rt.store.file, 'utf8');
  await a.cmd('clear');
  assert.equal(av.widget, undefined);
  assert.ok(bv.widget);
  assert.equal(b.goal().objective, 'Session B');
  assert.equal(b.goal().status, 'active');
  assert.equal(readFileSync(b.rt.store.file, 'utf8'), before);
});

test('clear during audit cancels it; a late pass cannot affect a newly started goal', async (t) => {
  let finish, signal;
  const h = await harness(t, {
    audit: async (_g, _summary, _ctx, _settings, received) => {
      signal = received;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await start(h);
  await evidence(h);
  const old = h.goal();
  const pending = h.tool('goal_submit', {
    goal_id: old.id,
    generation: old.generation,
    summary: 'old',
  });
  await until(() => signal);
  await h.cmd('clear');
  assert.equal(signal.aborted, true);
  await start(h, 'Replacement');
  const current = structuredClone(h.goal());
  finish(audit());
  await pending;
  assert.deepEqual(h.goal(), current);
  assert.equal(h.rt.state.goals.length, 1);
  const beforeStaleTool = structuredClone(h.rt.state);
  const stale = await h.tool('goal_progress', {
    goal_id: old.id,
    generation: old.generation,
    note: 'stale',
    next_step: 'x',
  });
  assert.equal(stale.details.disposition, 'stale_goal');
  assert.equal(stale.isError, undefined);
  assert.deepEqual(h.rt.state, beforeStaleTool);
});

test('clear during a mechanical check rejects its late result before calling the auditor', async (t) => {
  let finish,
    signal,
    audits = 0;
  const h = await harness(t, {
    check: async (_cwd, _check, received) => {
      signal = received;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    audit: async () => {
      audits++;
      return audit();
    },
  });
  await start(h);
  await evidence(h);
  h.rt.store.change('fixture', (s) => {
    activeGoal(s).checks = [{ id: 'K1', command: 'true' }];
  });
  const g = h.goal();
  const pending = h.tool('goal_check', {
    goal_id: g.id,
    generation: g.generation,
    check_id: 'K1',
  });
  await until(() => Boolean(signal));
  await h.cmd('clear');
  assert.equal(signal.aborted, true);
  const empty = structuredClone(h.rt.state);
  finish({ at: 'then', command: 'true', exitCode: 0, output: 'late success' });
  await assert.rejects(pending);
  assert.equal(audits, 0);
  assert.deepEqual(h.rt.state, empty);
});

test('a late main check failure from a cleared goal is not applied to its replacement', async (t) => {
  let rejectCheck;
  const h = await harness(t, {
    check: async () =>
      new Promise((_resolve, reject) => {
        rejectCheck = reject;
      }),
    audit: async () => audit(),
  });
  await start(h);
  await evidence(h);
  h.rt.store.change('fixture', (s) => {
    activeGoal(s).checks = [{ id: 'K1', command: 'true' }];
  });
  const old = h.goal();
  const pending = h.tool('goal_check', {
    goal_id: old.id,
    generation: old.generation,
    check_id: 'K1',
  });
  await until(() => Boolean(rejectCheck));
  await h.cmd('clear');
  await start(h, 'Replacement');
  const before = structuredClone(h.goal());
  rejectCheck(new Error('late main check failure from the old goal'));
  await assert.rejects(pending, /late main check failure/);
  assert.deepEqual(h.goal(), before);
});

test('request projection keeps one fresh policy and snapshot after repeated continuations and compaction', async (t) => {
  const h = await harness(t);
  await start(h);
  const g = h.goal();
  const identity = { sessionId: 'test-session', goalId: g.id, generation: g.generation };
  const control = (customType, content, details = identity) => ({
    role: 'custom',
    customType,
    content,
    details,
    timestamp: 1,
  });
  // Include pre-upgrade persisted messages, not just newly shortened prompts.
  const oldRules = 'Legacy rules that must not survive reload';
  const history = [
    control('my-pi-goal-work', oldRules + '\n' + WORK_RULES + '\n' + kickoffPrompt(g)),
    control('my-pi-goal-context', goalContext(g, h.rt.state) + '\n' + WORK_RULES),
    ...Array.from({ length: 10 }, () =>
      control('my-pi-goal-continue', continuationPrompt(g) + '\n' + WORK_RULES),
    ),
  ];
  const user = { role: 'user', content: 'Keep my message verbatim', timestamp: 1 };
  const result = {
    role: 'toolResult',
    toolCallId: 'ordinary',
    toolName: 'read',
    content: [{ type: 'text', text: 'Keep this result' }],
    timestamp: 1,
  };
  const before = structuredClone(history);
  await evidence(h);
  const current = await h.emit('context', { messages: [...history, user, result] });
  assert.equal(current.messages.filter((m) => m.content === WORK_RULES).length, 1);
  assert.equal(current.messages.filter((m) => m.customType === 'my-pi-goal-current').length, 1);
  const text = current.messages.map((m) => String(m.content)).join('\n');
  assert.equal(text.split(WORK_RULES).length - 1, 1);
  assert.ok(!text.includes(oldRules));
  assert.ok(current.messages.includes(user));
  assert.ok(current.messages.includes(result));
  assert.deepEqual(history, before);
  const state = JSON.parse(current.messages.at(-1).content.split('\n')[1]);
  assert.equal(state.nextStep, 'submit');
  assert.deepEqual(state.criteria[0].evidence, {
    records: 1,
    latestIndex: 0,
    latestPreview: 'result.txt:1',
    latestChars: 12,
  });
  assert.ok(!kickoffPrompt(g).includes(WORK_RULES));
  assert.ok(!continuationPrompt(g).includes(WORK_RULES));
  const reprojected = await h.emit('context', { messages: current.messages });
  assert.deepEqual(
    reprojected.messages.map(({ timestamp, ...m }) => m),
    current.messages.map(({ timestamp, ...m }) => m),
  );
  const summary = {
    role: 'custom',
    customType: 'compaction-summary',
    content: 'Conversation summary',
    timestamp: 1,
  };
  const compacted = await h.emit('context', { messages: [summary, user] });
  assert.ok(compacted.messages.includes(summary));
  assert.equal(compacted.messages.filter((m) => m.content === WORK_RULES).length, 1);
  const observer = await harness(t, {}, h.ctx.cwd);
  const unowned = await observer.emit('context', { messages: current.messages });
  assert.equal(unowned.messages.filter((m) => m.content === WORK_RULES).length, 0);
  assert.ok(unowned.messages.includes(result));
});

test('queued planning is regenerated once from current records without replaying its old prompt', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('add Queued proposal');
  const queued = h.rt.state.goals[1];
  const request = { ...h.messages.at(-1), role: 'custom', timestamp: 1 };
  const current = await h.emit('context', { messages: [request, request] });
  const work = current.messages.filter((m) => m.customType === 'my-pi-goal-work');
  assert.equal(work.length, 1);
  assert.equal(work[0].details.goalId, queued.id);
  assert.match(work[0].content, /without executing it/);
  assert.equal(current.messages.filter((m) => m.content === WORK_RULES).length, 1);
  assert.equal(h.rt.state.activeId, h.goal().id);
  const projected = JSON.parse(work[0].content.split('\n')[2]);
  assert.equal(projected.objective, queued.objective);
  const stale = { ...request, details: { ...request.details, generation: queued.generation + 1 } };
  const invalid = await h.emit('context', { messages: [stale] });
  assert.ok(!invalid.messages.some((m) => m.customType === 'my-pi-goal-work'));
});

test('context drops cleared or copied goal control prompts but retains conversation and current queue planning', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('add Queued proposal');
  const messages = h.messages
    .filter((m) => m.customType === 'my-pi-goal-work')
    .map((m) => ({ ...m, role: 'custom', timestamp: 1 }));
  const user = { role: 'user', content: 'Keep this conversation', timestamp: 1 };
  const current = await h.emit('context', { messages: [...messages, user] });
  assert.ok(current.messages.some((m) => m.details?.goalId === h.rt.state.goals[1].id));
  await h.cmd('clear');
  const cleared = await h.emit('context', { messages: [...messages, user] });
  assert.deepEqual(cleared.messages.slice(0, -1), [user]);
  assert.match(cleared.messages.at(-1).content, /No current goal exists.*user cleared/);
  assert.equal(cleared.messages.at(-1).details.sessionId, 'test-session');
  await start(h, 'Different goal');
  const next = await h.emit('context', { messages: [...messages, user] });
  assert.ok(next.messages.includes(user));
  assert.equal(next.messages.filter((m) => m.customType === 'my-pi-goal-work').length, 0);
  const fork = await harness(t, {}, h.ctx.cwd, 'fork', structuredClone(h.entries));
  const copied = await fork.emit('context', { messages: next.messages });
  assert.deepEqual(copied.messages.slice(0, -1), [user]);
  assert.equal(copied.messages.at(-1).details.sessionId, 'fork');
  assert.match(copied.messages.at(-1).content, /No current goal exists/);
  assert.doesNotMatch(copied.messages.at(-1).content, /user cleared|Different goal/);
});

test('ownership automatically releases on idle pause and settled completion, then resumes from another instance', async (t) => {
  const a = await harness(t);
  await start(a);
  await evidence(a);
  const b = await harness(t, { audit: async () => audit() }, a.ctx.cwd);
  const busy = readFileSync(a.rt.store.file, 'utf8');
  await b.cmd('resume');
  assert.equal(readFileSync(a.rt.store.file, 'utf8'), busy);
  assert.match(b.messages.at(-1).content, /another Pi instance/);
  await a.cmd('pause');
  assert.equal(a.rt.state.owner, null);
  await b.cmd('resume');
  assert.ok(b.rt.store.owns());
  assert.equal(b.goal().status, 'active');
  const g = b.goal();
  await b.emit('turn_start');
  await b.tool('goal_submit', { goal_id: g.id, generation: g.generation, summary: 'done' });
  await b.emit('turn_end', turn);
  await b.emit('agent_before_settle', boundary);
  await b.emit('agent_settled');
  assert.equal(b.goal().status, 'complete');
  assert.equal(b.goal().usage.tokens, 25);
  assert.equal(b.rt.state.owner, null);
});

test('draft planning automatically obtains ownership after command idle release; waiting releases at settlement', async (t) => {
  const h = await harness(t);
  await h.cmd('Research the new project requirements');
  assert.equal(h.rt.state.owner, null);
  await h.emit('before_agent_start');
  assert.ok(h.rt.store.owns());
  const g = h.goal();
  await h.tool('goal_plan', {
    goal_id: g.id,
    generation: g.generation,
    spec: {
      objective: g.objective,
      kind: 'general',
      criteria: ['approved result'],
      tasks: [],
      checks: [],
    },
  });
  await h.emit('agent_settled');
  assert.equal(h.rt.state.owner, null);
  assert.equal(h.goal().approved, false);
  await h.cmd(`approve-exact ${h.goal().id} ${h.goal().revision}`);
  assert.equal(h.goal().status, 'active');
  await h.emit('input', { source: 'interactive', text: 'Also handle Unicode' });
  assert.deepEqual(h.goal().inputs, ['Also handle Unicode']);
  const active = h.goal();
  await h.tool('goal_wait', {
    goal_id: active.id,
    generation: active.generation,
    reason: 'Required input unavailable',
  });
  await h.emit('agent_settled');
  assert.equal(h.goal().status, 'blocked');
  assert.equal(h.rt.state.owner, null);
});

test('readable approval leaves declined scope pending and accepts the exact reviewed proposal', async (t) => {
  const h = await harness(t);
  await h.cmd('research approval display');
  const g = h.goal();
  const proposal = {
    objective: g.objective,
    kind: 'general',
    criteria: ['All details visible'],
    tasks: ['First\nSecond'],
    checks: [{ command: 'printf "quoted"\nprintf done' }],
  };
  await h.tool('goal_plan', { goal_id: g.id, generation: g.generation, spec: proposal });
  h.ctx.hasUI = true;
  h.ctx.mode = 'rpc';
  let accepted = false,
    message;
  h.ctx.ui.confirm = async (_title, body) => {
    message = body;
    return accepted;
  };
  const before = structuredClone(h.goal());
  await h.cmd('approve');
  assert.deepEqual(h.goal(), before);
  assert.match(message, /Acceptance criteria \(1\)/);
  assert.match(message, /Checks \(1\)/);
  assert.doesNotMatch(message, /"objective":/);
  accepted = true;
  await h.cmd('approve');
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().pendingSpec, undefined);
  assert.equal(h.goal().objective, proposal.objective);
  assert.deepEqual(
    h.goal().criteria.map((c) => c.text),
    proposal.criteria,
  );
  assert.deepEqual(
    h.goal().tasks.map((t) => t.text),
    proposal.tasks,
  );
  assert.deepEqual(
    h.goal().checks.map(({ command }) => ({ command })),
    proposal.checks,
  );
});

test('TUI approval uses the same summary and rejects a late confirmation after a new proposal', async (t) => {
  const h = await harness(t);
  await h.cmd('research approval display');
  let g = h.goal();
  const proposal = {
    objective: g.objective,
    kind: 'general',
    criteria: ['Original'],
    tasks: [],
    checks: [],
  };
  await h.tool('goal_plan', { goal_id: g.id, generation: g.generation, spec: proposal });
  captureUI(h);
  h.ctx.hasUI = true;
  let finish, component;
  h.ctx.ui.confirm = () => assert.fail('TUI must use scrollable review');
  h.ctx.ui.custom = async (factory) =>
    new Promise((resolve) => {
      finish = resolve;
      component = factory(
        { terminal: { rows: 24 }, requestRender() {} },
        { fg: (_c, s) => s, bold: (s) => s },
        { getKeys: () => [], matches: () => false },
        resolve,
      );
    });
  const pending = h.cmd('approve');
  assert.match(component.render(80).join('\n'), /Original/);
  g = h.goal();
  const replacement = { ...proposal, criteria: ['Replacement'] };
  await h.tool('goal_plan', { goal_id: g.id, generation: g.generation, spec: replacement });
  finish(true);
  await pending;
  assert.equal(h.goal().approved, false);
  assert.deepEqual(h.goal().pendingSpec, replacement);
  // No UI: exact revision remains required; stale revisions cannot approve.
  h.ctx.hasUI = false;
  h.ctx.mode = 'json';
  await h.cmd('approve');
  assert.deepEqual(h.goal().pendingSpec, replacement);
  g = h.goal();
  await h.cmd(`approve-exact ${g.id} ${g.revision - 1}`);
  assert.equal(h.goal().approved, false);
  await h.cmd(`approve-exact ${g.id} ${g.revision}`);
  assert.equal(h.goal().status, 'active');
  assert.deepEqual(
    h.goal().criteria.map((c) => c.text),
    replacement.criteria,
  );
});

test('pending approval cannot regain authority after the same runtime reacquires ownership', async (t) => {
  const h = await harness(t);
  await h.cmd('Research a new project');
  const draft = h.goal();
  await h.tool('goal_plan', {
    goal_id: draft.id,
    generation: draft.generation,
    spec: {
      objective: draft.objective,
      kind: 'general',
      criteria: ['Required result'],
      tasks: [],
      checks: [],
    },
  });
  let accept;
  h.ctx.hasUI = true;
  h.ctx.ui.confirm = () =>
    new Promise((resolve) => {
      accept = resolve;
    });
  const pending = h.cmd('approve');
  const oldToken = h.rt.store.token;
  const generation = h.goal().generation;
  await h.cmd('help');
  assert.equal(h.rt.state.owner, null);
  await h.emit('before_agent_start');
  assert.notEqual(h.rt.store.token, oldToken);
  assert.equal(h.goal().generation, generation);
  accept(true);
  await pending;
  assert.equal(h.goal().approved, false);
  assert.ok(h.goal().pendingSpec);
});

test('busy pause retains ownership until final worker usage is recorded and the run settles', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.emit('turn_start');
  h.ctx.isIdle = () => false;
  await h.cmd('pause');
  assert.ok(h.rt.store.owns());
  await h.emit('turn_end', turn);
  await h.emit('agent_before_settle', { ...boundary, outcome: 'aborted' });
  h.ctx.isIdle = () => true;
  await h.emit('agent_settled');
  assert.equal(h.goal().usage.tokens, 25);
  assert.equal(h.goal().status, 'paused');
  assert.equal(h.rt.state.owner, null);
});

test('main help is concise; advanced controls and legacy ownership commands do not create goals', async (t) => {
  const h = await harness(t);
  await h.cmd('help');
  const help = h.messages.at(-1).content;
  assert.match(help, /goal clear/);
  assert.doesNotMatch(help, /take-over|release|goal plan|goal amend|goal start|approve-exact/);
  await h.cmd('help more');
  assert.match(h.messages.at(-1).content, /approve-exact/);
  await h.cmd('release');
  await h.cmd('take-over');
  assert.deepEqual(h.rt.state.goals, []);
});

const goalKey = (h) => ({ goal_id: h.goal().id, generation: h.goal().generation });
const createKey = (h) => ({
  session_id: h.rt.state.sessionId,
  expected_revision: h.rt.state.revision,
});
const fixSpec = {
  objective: 'Fix bug',
  kind: 'coding',
  criteria: ['Bug is fixed'],
  tasks: [],
  checks: [],
};

test('clear informs the model in TUI and rebuilds empty state after reload/compaction without starting a turn', async (t) => {
  const h = await harness(t);
  captureUI(h);
  h.ctx.hasUI = true;
  await start(h);
  const key = goalKey(h);
  const before = h.messages.length;
  await h.cmd('clear');
  const notices = h.messages.slice(before);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].customType, 'my-pi-goal-cleared');
  assert.equal(notices[0].opts.triggerTurn, false);
  assert.match(notices[0].content, /No current goal exists.*user cleared/);
  await h.rt.init(h.ctx);
  const snapshot = structuredClone(h.rt.state);
  const summary = {
    role: 'compactionSummary',
    summary: 'Old goal should submit next',
    tokensBefore: 100,
    timestamp: 1,
  };
  const context = await h.emit('context', { messages: [summary] });
  assert.equal(context.messages[0], summary);
  assert.match(context.messages.at(-1).content, /All previous goal IDs are invalid/);
  for (const name of ['goal_plan', 'goal_progress', 'goal_submit', 'goal_wait', 'goal_resume']) {
    assert.equal(await h.emit('tool_call', { toolName: name, input: key }), undefined);
    const result = await h.tool(name, key);
    assert.equal(result.details.disposition, 'stale_goal');
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Nothing was changed/);
  }
  assert.deepEqual(h.rt.state, snapshot);
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
});

test('model creates and plans a simple goal in its current turn and enters native audited work', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await h.emit('turn_start');
  const before = h.messages.length;
  const created = await h.tool('goal_create', { ...createKey(h), objective: 'Fix bug' });
  assert.match(created.content[0].text, /Goal created/);
  assert.match(created.content[0].text, new RegExp(h.goal().id));
  assert.equal(h.messages.length, before, 'model creation must not schedule a second run');
  assert.equal(h.goal().status, 'draft');
  const snapshot = structuredClone(h.rt.state);
  const again = await h.tool('goal_create', { ...createKey(h), objective: 'Other work' });
  assert.equal(again.details.disposition, 'existing_goal');
  assert.deepEqual(h.rt.state, snapshot);
  await h.tool('goal_plan', { ...goalKey(h), spec: fixSpec });
  assert.equal(h.goal().status, 'active');
  assert.equal((await h.emit('agent_before_settle', boundary)).continue, true);
  await evidence(h);
  await h.tool('goal_submit', { ...goalKey(h), summary: 'Finished' });
  assert.equal(h.goal().status, 'complete');
});

test('model creation fences session/revision/cancellation and never bypasses an unfinished queue', async (t) => {
  const h = await harness(t);
  const old = createKey(h);
  await h.cmd('clear');
  const empty = structuredClone(h.rt.state);
  for (const key of [old, { ...createKey(h), session_id: 'another-session' }]) {
    const result = await h.tool('goal_create', { ...key, objective: 'Stale task' });
    assert.equal(result.details.disposition, 'stale_state');
    assert.deepEqual(h.rt.state, empty);
  }
  const result = await h.tools
    .get('goal_create')
    .execute(
      'cancelled',
      { ...createKey(h), objective: 'Cancelled' },
      AbortSignal.abort(),
      undefined,
      h.ctx,
    );
  assert.equal(result.details.disposition, 'stale_state');
  assert.deepEqual(h.rt.state, empty);
  // The revision precondition is also checked inside the ownership transaction.
  assert.throws(() => h.rt.store.claim(old.expected_revision), /state changed/);
  assert.deepEqual(h.rt.state, empty);
  await start(h);
  await h.cmd('add Earlier draft');
  await h.cmd('skip');
  assert.equal(h.rt.state.activeId, null);
  const queued = structuredClone(h.rt.state);
  const blocked = await h.tool('goal_create', { ...createKey(h), objective: 'Cannot jump queue' });
  assert.equal(blocked.details.disposition, 'existing_goal');
  assert.deepEqual(h.rt.state, queued);
});

test('model-created complex goals cannot approve themselves or turn an initial proposal into direct-start work', async (t) => {
  const h = await harness(t);
  await h.tool('goal_create', { ...createKey(h), objective: 'Research a new project' });
  const spec = { ...fixSpec, objective: h.goal().objective };
  await h.tool('goal_plan', { ...goalKey(h), spec });
  assert.equal(h.goal().status, 'draft');
  assert.equal(h.goal().approved, false);
  const result = await h.tool('goal_resume', goalKey(h));
  assert.equal(result.details.disposition, 'approval_required');
  assert.equal(
    (await h.emit('tool_call', { toolName: 'write', input: { path: 'x' } })).block,
    true,
  );
  assert.equal(await h.emit('agent_before_settle', boundary), undefined);
  await h.cmd(`approve-exact ${h.goal().id} ${h.goal().revision}`);
  assert.equal(h.goal().status, 'active');
});

test('model resume respects stop boundaries, persists across reload, and never resets an active goal', async (t) => {
  const h = await harness(t);
  await start(h);
  h.rt.store.change('fixture', (s) => {
    activeGoal(s).noProgressTurns = 3;
    activeGoal(s).consecutiveAuditFailures = 2;
  });
  const active = structuredClone(h.rt.state);
  await h.tool('goal_resume', goalKey(h));
  assert.deepEqual(h.rt.state, active);
  await h.cmd('pause');
  await h.rt.init(h.ctx);
  const stopped = structuredClone(h.rt.state);
  assert.equal(
    (await h.tool('goal_resume', goalKey(h))).details.disposition,
    'user_input_required',
  );
  assert.deepEqual(h.rt.state, stopped);
  await h.emit('input', { source: 'interactive', text: 'Continue the saved goal' });
  await h.emit('before_agent_start');
  await h.emit('turn_start');
  const key = goalKey(h);
  assert.equal(await h.emit('tool_call', { toolName: 'goal_resume', input: key }), undefined);
  const messages = h.messages.length;
  await h.tool('goal_resume', key);
  assert.equal(h.goal().status, 'active');
  assert.equal(h.rt.state.queuePaused, false);
  assert.equal(h.messages.length, messages);
  assert.equal(h.goal().noProgressTurns, 0);
  assert.equal((await h.emit('agent_before_settle', boundary)).continue, true);
  await h.emit('turn_end', turn);
  assert.equal(h.goal().usage.tokens, 25);
  await h.emit('agent_before_settle', { ...boundary, outcome: 'aborted' });
  assert.equal(
    (await h.tool('goal_resume', goalKey(h))).details.disposition,
    'user_input_required',
  );
});

test('model resume cannot bypass protection stops, pending approval, budget, or a queue head', async (t) => {
  const h = await harness(t);
  await start(h);
  await h.cmd('budget 20');
  await h.emit('turn_start');
  await h.emit('turn_end', turn);
  assert.equal(h.goal().status, 'budget_limited');
  assert.equal(
    (await h.tool('goal_resume', goalKey(h))).details.disposition,
    'user_input_required',
  );
  await h.emit('input', { source: 'interactive', text: 'Continue if possible' });
  assert.equal((await h.tool('goal_resume', goalKey(h))).details.disposition, 'budget_limited');
  await h.cmd('budget 100');
  await h.tool('goal_resume', goalKey(h));
  assert.equal(h.goal().status, 'active');
  await h.cmd('add Second');
  const second = h.rt.state.goals[1];
  await h.tool('goal_plan', {
    goal_id: second.id,
    generation: second.generation,
    spec: { ...fixSpec, objective: 'Second' },
  });
  await h.cmd(`approve-exact ${second.id} ${h.rt.state.goals[1].revision}`);
  const next = h.rt.state.goals[1];
  assert.equal(
    (await h.tool('goal_resume', { goal_id: next.id, generation: next.generation })).details
      .disposition,
    'queue_blocked',
  );
  await h.cmd('pause');
  assert.equal(await h.emit('tool_call', { toolName: 'goal_plan', input: goalKey(h) }), undefined);
  const before = structuredClone(h.goal());
  await h.tool('goal_plan', {
    ...goalKey(h),
    spec: { ...fixSpec, criteria: ['Fix and handle Unicode'] },
  });
  assert.equal(h.goal().status, 'draft');
  assert.deepEqual(h.goal().criteria, before.criteria);
  assert.equal((await h.tool('goal_resume', goalKey(h))).details.disposition, 'approval_required');
  assert.equal(
    (await h.emit('tool_call', { toolName: 'bash', input: { command: 'touch x' } })).block,
    true,
  );
  await h.cmd(`approve-exact ${h.goal().id} ${h.goal().revision}`);
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().criteria[0].text, 'Fix and handle Unicode');
});

async function startWithChecks(h, checks = [{ command: 'npm test' }]) {
  await h.cmd('start Fix bug');
  const g = h.goal();
  await h.tool('goal_plan', {
    goal_id: g.id,
    generation: g.generation,
    spec: { objective: 'Fix bug', kind: 'coding', criteria: ['Bug is fixed'], tasks: [], checks },
  });
  await evidence(h);
}

test('goal_status defaults to a compact summary and the full view keeps complete evidence', async (t) => {
  const h = await harness(t);
  await start(h);
  await evidence(h);
  const summary = JSON.parse((await h.tool('goal_status', {})).content[0].text);
  assert.equal(summary.goals[0].criteria[0].text, 'Bug is fixed');
  assert.deepEqual(summary.goals[0].criteria[0].evidence, {
    records: 1,
    latestIndex: 0,
    latestPreview: 'result.txt:1',
    latestChars: 12,
  });
  assert.deepEqual(summary.goals[0].tasks, []);
  assert.equal(Object.hasOwn(summary.goals[0].criteria[0], 'evidenceRecords'), false);
  const full = JSON.parse((await h.tool('goal_status', { view: 'full' })).content[0].text);
  assert.deepEqual(full.goals[0].criteria[0].evidence, ['result.txt:1']);
  assert.deepEqual(full.goals[0].tasks, []);
});

test('goal_evidence pages recorded evidence without claiming ownership or changing state', async (t) => {
  const h = await harness(t);
  await start(h);
  const long = 'evidence record '.repeat(300);
  let g = h.goal();
  await h.tool('goal_progress', {
    goal_id: g.id,
    generation: g.generation,
    note: 'recorded',
    next_step: 'verify',
    criterion_id: 'C1',
    evidence: long,
  });
  g = h.goal();
  const before = g.revision;
  const key = { goal_id: g.id, generation: g.generation, source: 'criterion', id: 'C1' };
  const first = JSON.parse((await h.tool('goal_evidence', { ...key, chars: 40 })).content[0].text);
  assert.equal(first.offset, 1);
  assert.equal(first.text, long.slice(0, 40));
  assert.equal(first.totalChars, long.length);
  assert.equal(first.nextOffset, 41);
  const second = JSON.parse(
    (await h.tool('goal_evidence', { ...key, offset: 41, chars: 40 })).content[0].text,
  );
  assert.equal(second.text, long.slice(40, 80));
  assert.equal(second.nextOffset, 81);
  const end = JSON.parse(
    (await h.tool('goal_evidence', { ...key, offset: long.length + 1 })).content[0].text,
  );
  assert.equal(end.text, '');
  assert.equal(end.nextOffset, null);
  assert.equal(h.goal().revision, before);
  await assert.rejects(h.tool('goal_evidence', { ...key, index: 5 }), /index is out of range/);
  await assert.rejects(h.tool('goal_evidence', { ...key, id: 'C9' }), /not found/);
  const stale = await h.tool('goal_evidence', { ...key, generation: key.generation + 1 });
  assert.equal(stale.details.disposition, 'stale_goal');
  const missing = await h.tool('goal_evidence', {
    goal_id: 'missing-goal',
    generation: 1,
    source: 'criterion',
    id: 'C1',
  });
  assert.equal(missing.details.disposition, 'stale_goal');
});

test('submission revalidates progress changed during asynchronous source inventory', async (t) => {
  const h = await harness(t, {
    audit: async () => assert.fail('incomplete work cannot be reviewed'),
  });
  await start(h);
  await evidence(h);
  h.rt.store.change('fixture.task', (s) => {
    activeGoal(s).tasks = [{ id: 'T1', text: 'Finish work', status: 'done', evidence: ['done'] }];
  });
  const original = h.rt.sourceStamp.bind(h.rt);
  t.mock.method(h.rt, 'sourceStamp', async (...args) => {
    const stamp = await original(...args);
    await h.tool('goal_progress', {
      ...goalKey(h),
      task_id: 'T1',
      task_status: 'active',
      note: 'Reopened task',
      next_step: 'finish it',
    });
    return stamp;
  });
  await assert.rejects(h.tool('goal_submit', { ...goalKey(h), summary: 'done' }));
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().tasks[0].status, 'active');
});

test('source changes during a main-session check cannot certify the resulting version', async (t) => {
  let mutate = true,
    reviews = 0;
  const h = await harness(t, {
    check: async (cwd) => {
      if (mutate) writeFileSync(join(cwd, 'source.txt'), 'changed after test assertions');
      return { exitCode: 0, output: 'tests passed before the source changed' };
    },
    audit: async () => {
      reviews++;
      return audit();
    },
  });
  await startWithChecks(h);
  writeFileSync(join(h.ctx.cwd, 'source.txt'), 'original');
  await h.tool('goal_check', { ...goalKey(h), check_id: 'K1' });
  const result = await h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  assert.equal(result.details.disposition, 'evidence_needed');
  assert.equal(reviews, 0);
  assert.equal(h.goal().checks[0].last.exitCode, 0, 'retain the actual tool exit code');
  assert.equal(h.goal().checks[0].last.success, false);
  mutate = false;
  await h.tool('goal_check', { ...goalKey(h), check_id: 'K1' });
  await h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  assert.equal(h.goal().status, 'complete');
});
for (const interruption of ['throw', 'abort'])
  test(`a ${interruption} during a rerun invalidates the previous successful check`, async (t) => {
    let retry = false;
    const controller = new AbortController();
    const h = await harness(t, {
      check: async () => {
        if (retry && interruption === 'throw') throw new Error('check interrupted');
        if (retry) controller.abort();
        return { exitCode: 0, output: 'passed' };
      },
      audit: async () => audit(),
    });
    await startWithChecks(h);
    await h.tool('goal_check', { ...goalKey(h), check_id: 'K1' });
    assert.equal(h.goal().checks[0].last.success, true);
    retry = true;
    h.ctx.signal = controller.signal;
    await assert.rejects(
      h.tool('goal_check', { ...goalKey(h), check_id: 'K1' }),
      /interrupted|aborted/i,
    );
    h.ctx.signal = undefined;
    assert.equal(h.goal().checks[0].last, undefined);
    assert.equal(
      (await h.tool('goal_submit', { ...goalKey(h), summary: 'done' })).details.disposition,
      'evidence_needed',
    );
  });
for (const toolName of ['goal_check', 'goal_reply'])
  test(`stale ${toolName} calls do not claim or block a paused replacement goal`, async (t) => {
    const h = await harness(t);
    await start(h);
    const key = goalKey(h);
    await h.cmd('clear');
    await start(h, 'Replacement task');
    await h.cmd('pause');
    const before = structuredClone(h.rt.state);
    assert.equal(h.rt.store.owns(), false);
    assert.equal(await h.emit('tool_call', { toolName, input: key }), undefined);
    assert.equal((await h.tool(toolName, key)).details.disposition, 'stale_goal');
    assert.deepEqual(h.rt.state, before);
    assert.equal(h.rt.store.owns(), false);
  });

test('main checks are explicit, recorded from tool metadata and invalidated by source changes', async (t) => {
  let runs = 0,
    reviews = 0;
  const h = await harness(t, {
    check: async () => {
      runs++;
      return { exitCode: 0, output: 'passed' };
    },
    audit: async () => {
      reviews++;
      return audit();
    },
  });
  await startWithChecks(h);
  writeFileSync(join(h.ctx.cwd, 'source.txt'), 'v1');
  const submit = () => h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  assert.equal((await submit()).details.disposition, 'evidence_needed');
  assert.equal(runs, 0);
  assert.equal(reviews, 0);
  await h.tool('goal_check', { ...goalKey(h), check_id: 'K1' });
  assert.equal(h.goal().checks[0].last.source, 'main-session');
  writeFileSync(join(h.ctx.cwd, 'source.txt'), 'v2');
  assert.match((await submit()).content[0].text, /source inputs changed/);
  await h.tool('goal_check', { ...goalKey(h), check_id: 'K1' });
  await submit();
  assert.equal(h.goal().status, 'complete');
  assert.equal(runs, 2);
  assert.equal(reviews, 1);
});

for (const timing of ['before', 'during'])
  test(`session cancellation ${timing} review prevents completion without a separate tool signal`, async (t) => {
    const controller = new AbortController();
    let reviews = 0;
    const h = await harness(t, {
      audit: async () => {
        reviews++;
        controller.abort();
        return audit();
      },
    });
    await start(h);
    await evidence(h);
    h.ctx.signal = controller.signal;
    if (timing === 'before') {
      controller.abort();
      await assert.rejects(h.tool('goal_submit', { ...goalKey(h), summary: 'done' }), /aborted/i);
      assert.equal(reviews, 0);
      assert.equal(h.goal().status, 'active');
    } else {
      await h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
      assert.equal(h.goal().status, 'paused');
      assert.equal(h.goal().usage.auditTokens, 10);
    }
  });

test('reviewer information requests persist, do not spend repair attempts, and require a fresh audit', async (t) => {
  let reviews = 0;
  const h = await harness(t, {
    audit: async (g) => {
      reviews++;
      if (reviews === 1)
        return {
          ...audit('needs_info'),
          requests: [
            {
              id: 'request-1',
              at: 'now',
              generation: g.generation,
              criterionId: 'C1',
              question: 'Where is the result?',
            },
          ],
        };
      assert.match(g.auditRequests[0].answer.text, /result.txt/);
      return audit();
    },
  });
  await start(h);
  await evidence(h);
  const submit = () => h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  const first = await submit();
  assert.equal(first.details.verdict, 'needs_info');
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().consecutiveAuditFailures, 0);
  assert.equal((await submit()).details.disposition, 'evidence_needed');
  assert.equal(reviews, 1);
  const originalAudit = structuredClone(h.goal().audits.at(-1));
  await h.tool('goal_reply', {
    ...goalKey(h),
    request_id: 'request-1',
    answer: 'result.txt:1 contains the result',
  });
  assert.deepEqual(
    h.goal().audits.at(-1),
    originalAudit,
    'a reply must not rewrite the original reviewer record',
  );
  assert.equal(h.goal().status, 'active');
  await submit();
  assert.equal(h.goal().status, 'complete');
  assert.equal(reviews, 2);
  assert.equal(h.goal().usage.auditTokens, 20);
});

test('stale reviewer requests cannot be answered after user supplements or clear', async (t) => {
  const h = await harness(t, {
    audit: async (g) => ({
      ...audit('needs_info'),
      requests: [
        {
          id: 'old-request',
          at: 'now',
          generation: g.generation,
          criterionId: 'C1',
          question: 'Explain the result',
        },
      ],
    }),
  });
  await start(h);
  await evidence(h);
  await h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  await h.emit('input', { source: 'interactive', text: 'Also check the boundary case' });
  await assert.rejects(
    h.tool('goal_reply', { ...goalKey(h), request_id: 'old-request', answer: 'old answer' }),
    /stale/,
  );
  const old = goalKey(h);
  await h.cmd('clear');
  assert.equal(
    (await h.tool('goal_reply', { ...old, request_id: 'old-request', answer: 'old' })).details
      .disposition,
    'stale_goal',
  );
});

test('a filesystem failure during final source revalidation is not an implementation repair failure', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await start(h);
  await evidence(h);
  const original = h.rt.sourceStamp.bind(h.rt);
  let calls = 0;
  t.mock.method(h.rt, 'sourceStamp', (...args) => {
    if (++calls === 2)
      throw Object.assign(new Error('source disappeared during inventory'), { code: 'ENOENT' });
    return original(...args);
  });
  await h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().audits.at(-1).errorKind, 'input_changed');
  assert.equal(h.goal().consecutiveAuditFailures, 0);
  assert.equal(h.goal().usage.auditTokens, 10);
});

test('review freshness failure preserves incurred usage without completing or counting a repair', async (t) => {
  const h = await harness(t, {
    audit: async (_g, _s, ctx, _settings, _signal, _update, workspace) => {
      await workspace.read('result.txt');
      writeFileSync(join(ctx.cwd, 'result.txt'), 'changed');
      return audit();
    },
  });
  writeFileSync(join(h.ctx.cwd, 'result.txt'), 'complete');
  await start(h);
  await evidence(h);
  await h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  assert.equal(h.goal().status, 'active');
  assert.equal(h.goal().audits.at(-1).errorKind, 'input_changed');
  assert.equal(h.goal().usage.auditTokens, 10);
  assert.equal(h.goal().consecutiveAuditFailures, 0);
});

test('old sandbox settings load without executing anything and historical check receipts need rerunning', async (t) => {
  const h = await harness(t, { audit: async () => audit() });
  await startWithChecks(h);
  h.rt.store.change('legacy.fixture', (s) => {
    const g = activeGoal(s);
    g.verification = { workspace: 'ephemeral', network: 'open', env: [] };
    g.checks[0].last = {
      at: 'past',
      command: g.checks[0].command,
      exitCode: 0,
      output: 'old VM pass',
    };
  });
  const result = await h.tool('goal_submit', { ...goalKey(h), summary: 'done' });
  assert.equal(result.details.disposition, 'evidence_needed');
  assert.equal(h.tools.has('goal_environment'), false);
  assert.equal(Object.hasOwn(h.goal(), 'verification'), false);
});
