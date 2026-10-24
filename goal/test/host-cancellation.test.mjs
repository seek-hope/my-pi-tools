import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} from '@earendil-works/pi-coding-agent';
import { GoalRuntime } from '../src/runtime.ts';
import { testSandbox, verificationFixture } from './sandbox-fixtures.mjs';
import { activeGoal } from '../src/state.ts';

const [major, minor] = VERSION.split('.').map(Number);
const hasSettledAborted = major > 1 || (major === 1 && minor >= 1);

// Test deadlines protect the test runner only; Goal/provider calls remain unbounded.
for (const [phase, clear] of [
  ['worker', false],
  ['audit', false],
  ['worker', true],
  ['audit', true],
]) {
  test(
    `installed Pi ${VERSION}: ${clear ? 'clear' : 'cancellation'} during ${phase} stops without completion or continuation`,
    { timeout: 15_000 },
    async (t) => {
      const cwd = mkdtempSync(join(tmpdir(), 'goal-host-cancel-'));
      const agentDir = join(cwd, 'agent');
      let runtime,
        session,
        entered,
        calls = 0,
        cancelled = false;
      const suspended = new Promise((resolve) => {
        entered = resolve;
      });
      const errors = [],
        extensionSettled = [],
        sessionSettled = [];
      t.after(async () => {
        await session?.abort();
        runtime?.shutdown();
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
      });
      writeFileSync(join(cwd, 'result.txt'), 'Candidate result, not independently verified.\n');
      const models = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        modelsStorePath: join(agentDir, 'models-store.json'),
        refreshOnCreate: false,
      });
      const tool = (name, args) => ({
        type: 'toolCall',
        id: crypto.randomUUID(),
        name,
        arguments: args,
      });
      models.registerProvider('goal-cancel-fixture', {
        api: 'openai-completions',
        apiKey: 'offline',
        baseUrl: 'http://127.0.0.1:1',
        models: [
          {
            id: 'offline',
            name: 'Offline cancellation fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 200_000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        streamSimple(model, context, options) {
          calls++;
          const g = activeGoal(runtime.state);
          const key = { goal_id: g.id, generation: g.generation };
          const isAudit = context.messages.some(
            (m) =>
              m.role === 'system' && String(m.content).includes('read-only completion auditor'),
          );
          const suspend = isAudit || (phase === 'worker' && g.status === 'active');
          let content = [];
          if (!suspend) {
            if (g.status === 'draft')
              content = [
                tool('goal_plan', {
                  ...key,
                  spec: {
                    objective: g.objective,
                    kind: 'coding',
                    criteria: ['result.txt is verified'],
                    tasks: [],
                    checks: [],
                  },
                }),
              ];
            else if (!g.criteria[0].evidence.length)
              content = [
                tool('goal_progress', {
                  ...key,
                  note: 'Candidate written',
                  next_step: 'Verify independently',
                  criterion_id: 'C1',
                  evidence: 'result.txt:1',
                }),
              ];
            else content = [tool('goal_submit', { ...key, summary: 'Verify result.txt' })];
          }
          const message = {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            content,
            stopReason: suspend ? 'pending' : 'toolUse',
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
          if (suspend) {
            assert.ok(options.signal);
            const finish = () => {
              cancelled = true;
              stream.push({
                type: 'error',
                reason: 'aborted',
                error: { ...message, stopReason: 'aborted', errorMessage: 'Fixture cancelled' },
              });
              stream.end();
            };
            if (options.signal.aborted) finish();
            else options.signal.addEventListener('abort', finish, { once: true });
            entered();
          } else {
            stream.push({ type: 'done', reason: 'toolUse', message });
            stream.end();
          }
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
            pi.on('agent_settled', (event) => extensionSettled.push(event));
          },
        ],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: models,
        model: models.getModel('goal-cancel-fixture', 'offline'),
        thinkingLevel: 'off',
        tools: ['goal_status', 'goal_plan', 'goal_progress', 'goal_wait', 'goal_submit'],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
      }));
      await session.bindExtensions({ mode: 'json', onError: (error) => errors.push(error) });
      const settled = new Promise((resolve) =>
        session.subscribe((event) => {
          if (event.type === 'agent_settled') {
            sessionSettled.push(event);
            resolve();
          }
        }),
      );
      // Commands schedule the first model turn; subscribe before dispatching one.
      await session.prompt('/goal start Produce and verify the fixture');
      await suspended;
      assert.equal(activeGoal(runtime.state).status, phase === 'worker' ? 'active' : 'verifying');
      const callsAtAbort = calls;
      const continuationCount = () =>
        session.sessionManager
          .getEntries()
          .filter((e) => e.type === 'custom_message' && e.customType === 'my-pi-goal-continue')
          .length;
      const continuationsBefore = continuationCount();
      if (clear) await session.prompt('/goal clear');
      else await session.abort();
      await settled;
      assert.equal(cancelled, true);
      assert.deepEqual(errors, []);
      assert.equal(calls, callsAtAbort);
      assert.equal(continuationCount(), continuationsBefore);
      if (clear) {
        assert.deepEqual(runtime.state.goals, []);
        assert.ok(runtime.state.clearedAt);
        assert.ok(
          session.sessionManager
            .getEntries()
            .some((e) => e.type === 'custom_message' && e.customType === 'my-pi-goal-cleared'),
        );
      } else {
        assert.equal(activeGoal(runtime.state).status, 'paused');
        assert.equal(
          activeGoal(runtime.state).audits.some((a) => a.verdict === 'pass'),
          false,
        );
      }
      assert.equal(runtime.state.queuePaused, true);
      assert.equal(runtime.state.owner, null);
      assert.equal(extensionSettled.length, 1);
      assert.equal(sessionSettled.length, 1);
      if (hasSettledAborted) {
        assert.equal(extensionSettled[0].aborted, true);
        assert.equal(sessionSettled[0].aborted, true);
      }
      const beforeIdleCommand = calls;
      await session.prompt('/goal');
      assert.equal(calls, beforeIdleCommand);
      await session.prompt('/goal clear');
      assert.deepEqual(runtime.state.goals, []);
      assert.equal(runtime.state.owner, null);
    },
  );
}
