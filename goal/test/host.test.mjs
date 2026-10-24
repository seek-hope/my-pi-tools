import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { GoalRuntime } from '../src/runtime.ts';
import { testSandbox, verificationFixture } from './sandbox-fixtures.mjs';
import { activeGoal } from '../src/state.ts';
import { WORK_RULES } from '../src/prompts.ts';

for (const { queuedInput, commandStart } of [
  { queuedInput: false, commandStart: false },
  { queuedInput: true, commandStart: false },
  { queuedInput: false, commandStart: true },
])
  test(
    `installed Pi host: ${commandStart ? 'command-triggered run' : 'model-created goal'} and verified auto-clear with ${queuedInput ? 'queued' : 'idle'} user input`,
    { timeout: 15_000 },
    async (t) => {
      const cwd = mkdtempSync(join(tmpdir(), 'goal-host-test-'));
      const agentDir = join(cwd, 'agent');
      let runtime,
        session,
        workerCalls = 0,
        auditCalls = 0,
        cleanupCalled = false,
        deliberatelyStopped = false,
        afterClear = false,
        staleGoal,
        staleSent = false,
        tokensBeforeFinal = 0;
      const errors = [],
        toolEnds = [],
        extensionSettled = [],
        starts = [];
      t.after(() => {
        runtime?.shutdown();
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
      });
      writeFileSync(join(cwd, 'result.txt'), 'complete\n');
      writeFileSync(join(cwd, 'goal-scratch.tmp'), 'synthetic disposable artifact');
      const models = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        modelsStorePath: join(agentDir, 'models-store.json'),
        refreshOnCreate: false,
      });
      const toolCall = (name, args) => ({
        type: 'toolCall',
        id: crypto.randomUUID(),
        name,
        arguments: args,
      });
      models.registerProvider('goal-fixture', {
        api: 'openai-completions',
        apiKey: 'offline-fixture',
        baseUrl: 'http://127.0.0.1:1',
        models: [
          {
            id: 'offline',
            name: 'Offline Fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 200_000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        streamSimple(model, context) {
          const isAudit = context.messages.some(
            (m) =>
              m.role === 'system' && String(m.content).includes('read-only completion auditor'),
          );
          let content;
          if (isAudit) {
            auditCalls++;
            content =
              auditCalls === 1
                ? [toolCall('audit_read', { path: 'result.txt' })]
                : [
                    toolCall('audit_result', {
                      details: 'Independently read result.txt:1',
                      findings: [
                        {
                          criterionId: 'C1',
                          passed: true,
                          evidence: 'result.txt:1 contains complete',
                        },
                      ],
                    }),
                  ];
          } else {
            workerCalls++;
            const g = activeGoal(runtime.state);
            const key = g && { goal_id: g.id, generation: g.generation };
            const text = context.messages
              .filter((m) => m.role !== 'toolResult')
              .map((m) =>
                typeof m.content === 'string'
                  ? m.content
                  : m.content
                      ?.filter((c) => c.type === 'text')
                      .map((c) => c.text)
                      .join('\n'),
              )
              .join('\n');
            if (commandStart && workerCalls === 1)
              assert.ok(text.includes('Startup marker queued into the same run'));
            const eligible =
              g && !['complete', 'skipped'].includes(g.status) && runtime.store.owns();
            assert.equal(text.split(WORK_RULES).length - 1, Number(Boolean(eligible)));
            if (!g && afterClear) {
              const projection = context.messages
                .map((m) =>
                  typeof m.content === 'string'
                    ? m.content
                    : m.content
                        ?.filter((c) => c.type === 'text')
                        .map((c) => c.text)
                        .join('\n'),
                )
                .findLast((text) => text?.startsWith('MY-PI-GOAL current session state'));
              assert.match(projection, /No current goal exists.*cleared automatically/);
              assert.ok(
                JSON.stringify(context.messages).includes('Thanks. Explain the current state.'),
              );
              const stale = context.messages.findLast(
                (m) => m.role === 'toolResult' && m.toolName === 'goal_progress',
              );
              if (staleSent) {
                assert.equal(stale.isError, false);
                assert.match(stale.content[0].text, /Nothing was changed/);
                content = [{ type: 'text', text: 'The goal is cleared. We can chat normally.' }];
              } else {
                staleSent = true;
                content = [
                  toolCall('goal_progress', {
                    ...staleGoal,
                    note: 'Old context',
                    next_step: 'Stale submission',
                  }),
                ];
              }
            } else if (!g) {
              const projection = context.messages
                .map((m) =>
                  typeof m.content === 'string'
                    ? m.content
                    : m.content
                        ?.filter((c) => c.type === 'text')
                        .map((c) => c.text)
                        .join('\n'),
                )
                .findLast((text) => text?.startsWith('MY-PI-GOAL current session state'));
              assert.match(projection, /No current goal exists/);
              const state = JSON.parse(projection.split('\n')[1]);
              content = [
                toolCall('goal_create', {
                  session_id: state.sessionId,
                  expected_revision: state.revision,
                  objective: 'Produce a result file',
                }),
              ];
            } else if (g.status === 'draft')
              content = [
                toolCall('goal_plan', {
                  ...key,
                  spec: {
                    objective: g.objective,
                    kind: 'coding',
                    criteria: ['result.txt contains complete'],
                    tasks: [],
                    checks: [{ command: 'test "$(cat result.txt)" = complete' }],
                  },
                }),
              ];
            else if (g.status === 'complete')
              content = [{ type: 'text', text: 'Verified complete.' }];
            else if (!cleanupCalled) {
              cleanupCalled = true;
              content = [toolCall('bash', { command: 'rm goal-scratch.tmp' })];
            } else if (!g.criteria[0].evidence.length)
              content = [
                toolCall('goal_progress', {
                  ...key,
                  note: 'Result exists',
                  next_step: 'verify',
                  criterion_id: 'C1',
                  evidence: 'result.txt:1 contains complete',
                }),
              ];
            else if (!deliberatelyStopped) {
              deliberatelyStopped = true;
              content = [{ type: 'text', text: 'I have stopped early.' }];
            } else
              content = [toolCall('goal_submit', { ...key, summary: 'Result file is complete.' })];
          }
          const message = {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            content,
            stopReason: content.some((x) => x.type === 'toolCall') ? 'toolUse' : 'stop',
            timestamp: Date.now(),
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: 'start', partial: message });
          const finish = () => {
            stream.push({ type: 'done', reason: message.stopReason, message });
            stream.end();
          };
          if (
            queuedInput &&
            !isAudit &&
            !afterClear &&
            activeGoal(runtime.state)?.status === 'complete'
          ) {
            afterClear = true;
            const g = activeGoal(runtime.state);
            staleGoal = { goal_id: g.id, generation: g.generation };
            tokensBeforeFinal = g.usage.tokens;
            queueMicrotask(async () => {
              try {
                await session.prompt('Thanks. Explain the current state.', {
                  streamingBehavior: 'steer',
                });
                assert.equal(activeGoal(runtime.state)?.status, 'complete');
              } catch (error) {
                errors.push(error);
              }
              finish();
            });
          } else finish();
          return stream;
        },
      });
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => {
            runtime = new GoalRuntime(pi, { agentDir, prepareVerification: verificationFixture() });
            runtime.register();
            pi.on('session_start', () => {
              runtime.settings.sandbox = structuredClone(testSandbox);
            });
            pi.on('before_agent_start', (event, ctx) => {
              starts.push({
                messageType: event.messageType,
                idle: ctx.isIdle(),
                hasPrompt: 'prompt' in event,
                customType: event.message?.customType,
              });
              if (event.messageType === 'custom')
                pi.sendMessage(
                  {
                    customType: 'startup-marker',
                    content: 'Startup marker queued into the same run',
                    display: false,
                  },
                  { triggerTurn: false },
                );
            });
            pi.on('tool_execution_end', (event) => toolEnds.push(event));
            pi.on('agent_settled', (event) => extensionSettled.push(event));
          },
        ],
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: models,
        model: models.getModel('goal-fixture', 'offline'),
        thinkingLevel: 'off',
        tools: [
          'bash',
          'goal_status',
          'goal_create',
          'goal_resume',
          'goal_plan',
          'goal_progress',
          'goal_wait',
          'goal_submit',
        ],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
      });
      session = created.session;
      await session.bindExtensions({ mode: 'json', onError: (e) => errors.push(e) });
      const settled = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `No settlement: ${JSON.stringify(errors)}; ${JSON.stringify(runtime?.state)}`,
              ),
            ),
          10_000,
        );
        session.subscribe((e) => {
          if (e.type === 'agent_settled') {
            clearTimeout(timer);
            resolve(e);
          }
        });
      });
      await session.prompt(
        commandStart
          ? '/goal Produce a result file'
          : 'Use a durable goal to produce and verify the result file.',
      );
      const settledEvent = await settled;
      assert.equal(settledEvent.aborted, false);
      assert.equal(extensionSettled.at(-1).aborted, false);
      const executed = toolEnds.filter((event) => !event.isError);
      assert.ok(executed.length > 0);
      assert.ok(
        executed.every((event) => Number.isFinite(event.durationMs) && event.durationMs >= 0),
      );
      assert.deepEqual(errors, []);
      if (queuedInput) {
        assert.deepEqual(runtime.state.goals, []);
        assert.equal(runtime.state.clearReason, 'verified');
        assert.equal(runtime.state.owner, null);
        assert.ok(staleSent);
        assert.equal(auditCalls, 2);
        const history = runtime.store.history();
        const charged = history.findLast((e) => e.event === 'usage.turn');
        assert.equal(
          charged.state.goals.find((g) => g.id === staleGoal.goal_id).usage.tokens,
          tokensBeforeFinal + 15,
        );
        assert.ok(
          history.findLast((e) => e.event === 'goal.auto-clear').revision > charged.revision,
        );
        return;
      }
      assert.equal(activeGoal(runtime.state).status, 'complete');
      if (commandStart) {
        assert.deepEqual(activeGoal(runtime.state).inputs, []);
        assert.equal(starts.length, 1);
        assert.deepEqual(starts[0], {
          messageType: 'custom',
          idle: false,
          hasPrompt: false,
          customType: 'my-pi-goal-work',
        });
        assert.equal(extensionSettled.length, 1);
      }
      assert.equal(auditCalls, 2);
      assert.ok(cleanupCalled);
      assert.equal(existsSync(join(cwd, 'goal-scratch.tmp')), false);
      assert.ok(workerCalls >= 6);
      assert.ok(deliberatelyStopped);
      assert.ok(
        session.sessionManager
          .getBranch()
          .some((e) => e.type === 'custom_message' && e.customType === 'my-pi-goal-continue'),
      );
      assert.equal(activeGoal(runtime.state).usage.auditTokens, 30);
      assert.equal(runtime.state.owner, null);
      await session.prompt('/goal panel hide');
      const savedPanel = session.sessionManager
        .getEntries()
        .findLast((entry) => entry.type === 'custom' && entry.customType === 'my-pi-goal-panel');
      assert.equal(savedPanel.data.sessionId, session.sessionManager.getSessionId());
      assert.equal(savedPanel.data.mode, 'hidden');
      staleGoal = {
        goal_id: activeGoal(runtime.state).id,
        generation: activeGoal(runtime.state).generation,
      };
      afterClear = true;
      const callsBeforeClear = workerCalls;
      await session.prompt('Thanks. Explain the current state.');
      assert.ok(staleSent);
      assert.equal(workerCalls, callsBeforeClear + 2);
      assert.equal(runtime.state.clearReason, 'verified');
      assert.deepEqual(runtime.state.goals, []);
      assert.equal(runtime.state.owner, null);
      assert.equal(runtime.state.activeId, null);
      assert.deepEqual(errors, []);
    },
  );
