import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
import { activeGoal, makeGoal, applySpec, transition } from '../src/state.ts';

for (const hook of ['deny', 'rewrite', 'terminate'])
  test(
    `installed Pi host: ${hook} hook controls nested goal_check execution and invalidates prior success`,
    { timeout: 15000 },
    async (t) => {
      const cwd = mkdtempSync(join(tmpdir(), 'goal-check-hook-'));
      const agentDir = join(cwd, 'agent');
      let runtime,
        session,
        calls = 0;
      const errors = [],
        nested = [];
      t.after(() => {
        runtime?.shutdown();
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
      });
      const models = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        modelsStorePath: join(agentDir, 'models.json'),
        refreshOnCreate: false,
      });
      models.registerProvider('check-fixture', {
        api: 'openai-completions',
        apiKey: 'offline',
        baseUrl: 'http://127.0.0.1:1',
        models: [
          {
            id: 'offline',
            name: 'Fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        streamSimple(model) {
          assert.ok(++calls <= 2, 'the fixture must stop after the check');
          const g = activeGoal(runtime.state),
            key = { goal_id: g.id, generation: g.generation };
          const message = {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            stopReason: 'toolUse',
            content: [
              {
                type: 'toolCall',
                id: `call-${calls}`,
                name: calls === 1 ? 'goal_check' : 'goal_wait',
                arguments:
                  calls === 1
                    ? { ...key, check_id: 'K1' }
                    : {
                        ...key,
                        reason:
                          'Host hook prevented the approved check; operator input is required.',
                      },
              },
            ],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'done', reason: 'toolUse', message });
          stream.end();
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
            runtime = new GoalRuntime(pi, { agentDir });
            runtime.register();
            pi.on('tool_call', (event) => {
              if (event.toolName !== 'bash') return;
              nested.push(structuredClone(event));
              if (hook !== 'rewrite')
                return {
                  block: true,
                  reason: 'fixture denied the command',
                  ...(hook === 'terminate' ? { terminate: true } : {}),
                };
              event.input.command = 'true';
            });
          },
        ],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: models,
        model: models.getModel('check-fixture', 'offline'),
        thinkingLevel: 'off',
        tools: ['bash', 'goal_check', 'goal_wait'],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
      }));
      await session.bindExtensions({ mode: 'json', onError: (e) => errors.push(e) });
      const goal = makeGoal('Verify a command');
      applySpec(goal, {
        objective: goal.objective,
        kind: 'coding',
        criteria: ['The approved check passes'],
        tasks: [],
        checks: [{ command: 'touch should-not-exist' }],
      });
      transition(goal, 'active');
      goal.checks[0].last = {
        at: 'past',
        command: goal.checks[0].command,
        exitCode: 0,
        output: 'old success',
        source: 'main-session',
        toolCallId: 'old-call',
        generation: goal.generation,
        workspaceStamp: 'old',
        success: true,
      };
      runtime.store.claim();
      runtime.store.change('fixture.ready', (state) => {
        state.goals.push(goal);
        state.activeId = goal.id;
        state.queuePaused = false;
      });
      await session.prompt('Run the approved check, then stop for operator input.');
      assert.deepEqual(errors, []);
      if (hook === 'terminate')
        assert.equal(calls, 1, 'a nested termination must stop before another model request');
      assert.equal(nested.length, 1);
      assert.equal(nested[0].parentToolCallId, 'call-1');
      assert.equal(nested[0].input.command, 'touch should-not-exist');
      assert.equal(existsSync(join(cwd, 'should-not-exist')), false);
      const current = activeGoal(runtime.state);
      assert.notEqual(current.status, 'complete');
      assert.equal(current.audits.length, 0);
      assert.notEqual(current.checks[0].last?.toolCallId, 'old-call');
      assert.notEqual(current.checks[0].last?.success, true);
      if (hook === 'rewrite') {
        assert.equal(current.checks[0].last.command, 'true');
        assert.equal(current.checks[0].last.exitCode, 0);
      }
    },
  );
