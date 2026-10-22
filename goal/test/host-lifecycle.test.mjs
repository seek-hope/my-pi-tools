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
import { activeGoal } from '../src/state.ts';

for (const reopen of [false, true])
  test(
    `installed host: model modifies paused scope, waits for user approval and resumes through tools${reopen ? ' after reopening a saved session' : ''}`,
    { timeout: 15_000 },
    async (t) => {
      const cwd = mkdtempSync(join(tmpdir(), 'goal-host-lifecycle-'));
      const agentDir = join(cwd, 'agent');
      let runtime,
        session,
        phase = 'initial',
        resumeDenied = false,
        auditCalls = 0,
        workerCalls = 0;
      const errors = [],
        toolEnds = [];
      t.after(async () => {
        await session?.abort();
        runtime?.shutdown();
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
      });
      writeFileSync(join(cwd, 'result.txt'), 'complete\n');
      const models = await ModelRuntime.create({
        authPath: join(agentDir, 'auth.json'),
        modelsPath: null,
        modelsStorePath: join(agentDir, 'models-store.json'),
        refreshOnCreate: false,
      });
      const call = (name, args) => [
        { type: 'toolCall', id: crypto.randomUUID(), name, arguments: args },
      ];
      const spec = (g, criterion) => ({
        objective: g.objective,
        kind: 'coding',
        criteria: [criterion],
        tasks: [],
        checks: [],
      });
      models.registerProvider('lifecycle-fixture', {
        api: 'openai-completions',
        apiKey: 'offline',
        baseUrl: 'http://127.0.0.1:1',
        models: [
          {
            id: 'offline',
            name: 'Offline lifecycle',
            reasoning: false,
            input: ['text'],
            contextWindow: 200_000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        streamSimple(model, context) {
          const g = activeGoal(runtime.state);
          const key = g && { goal_id: g.id, generation: g.generation };
          const isAudit = context.messages.some(
            (m) =>
              m.role === 'system' && String(m.content).includes('read-only completion auditor'),
          );
          let content;
          if (!isAudit) workerCalls++;
          if (isAudit) {
            auditCalls++;
            content =
              auditCalls === 1
                ? call('audit_read', { path: 'result.txt' })
                : call('audit_result', {
                    details: 'Read the approved result',
                    findings: [
                      {
                        criterionId: 'C1',
                        passed: true,
                        evidence: 'result.txt:1 contains complete',
                      },
                    ],
                  });
          } else if (!g)
            content = call('goal_create', {
              session_id: runtime.state.sessionId,
              expected_revision: runtime.state.revision,
              objective: 'Check result fixture',
            });
          else if (phase === 'initial' && g.status === 'draft')
            content = call('goal_plan', { ...key, spec: spec(g, 'Result exists') });
          else if (phase === 'initial' || phase === 'approved')
            content = call('goal_wait', {
              ...key,
              reason: 'Required fixture confirmation unavailable',
            });
          else if (phase === 'modify' && !g.pendingSpec)
            content = call('goal_plan', { ...key, spec: spec(g, 'result.txt contains complete') });
          else if (phase === 'modify' && !resumeDenied) {
            resumeDenied = true;
            content = call('goal_resume', key);
          } else if (phase === 'modify')
            content = [{ type: 'text', text: 'Please approve the proposed criterion.' }];
          else if (g.status === 'paused') content = call('goal_resume', key);
          else if (g.status === 'complete')
            content = [{ type: 'text', text: 'Verified complete.' }];
          else if (!g.criteria[0].evidence.length)
            content = call('goal_progress', {
              ...key,
              note: 'Fixture readied',
              next_step: 'Audit',
              criterion_id: 'C1',
              evidence: 'result.txt:1 contains complete',
            });
          else content = call('goal_submit', { ...key, summary: 'Check the approved fixture' });
          const message = {
            role: 'assistant',
            api: model.api,
            provider: model.provider,
            model: model.id,
            content,
            stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
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
          stream.push({ type: 'done', reason: message.stopReason, message });
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
            pi.on('tool_execution_end', (event) => toolEnds.push(event));
          },
        ],
      });
      const goalTools = [
        'goal_status',
        'goal_create',
        'goal_resume',
        'goal_plan',
        'goal_wait',
        'goal_progress',
        'goal_submit',
      ];
      const open = async (sessionManager, tools = goalTools) => {
        await loader.reload();
        ({ session } = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime: models,
          model: models.getModel('lifecycle-fixture', 'offline'),
          thinkingLevel: 'off',
          tools,
          resourceLoader: loader,
          sessionManager,
          settingsManager,
        }));
        await session.bindExtensions({ mode: 'json', onError: (e) => errors.push(e) });
      };
      await open(
        reopen ? SessionManager.create(cwd, join(cwd, 'sessions')) : SessionManager.inMemory(cwd),
        reopen ? ['-bash'] : goalTools,
      );
      const run = async (text) => {
        let unsubscribe;
        const settled = new Promise((resolve) => {
          unsubscribe = session.subscribe((e) => {
            if (e.type === 'agent_settled') resolve();
          });
        });
        try {
          await session.prompt(text);
          await settled;
        } finally {
          unsubscribe();
        }
      };
      await run('Create a goal to check the fixture.');
      assert.equal(activeGoal(runtime.state).status, 'blocked');
      await session.prompt('/goal pause');
      if (reopen) {
        session.setActiveToolsByName([...goalTools, 'grep']);
        assert.ok(session.getActiveToolNames().includes('grep'));
      }
      phase = 'modify';
      await run('Change the criterion to require the exact file content.');
      const pending = activeGoal(runtime.state);
      assert.equal(pending.status, 'draft');
      assert.equal(pending.criteria[0].text, 'Result exists');
      assert.equal(pending.pendingSpec.criteria[0], 'result.txt contains complete');
      assert.equal(runtime.state.owner, null);
      const denial = toolEnds.find((e) => e.toolName === 'goal_resume');
      assert.equal(denial.result.details.disposition, 'approval_required');
      phase = 'approved';
      await run(`/goal approve-exact ${pending.id} ${pending.revision}`);
      assert.equal(activeGoal(runtime.state).criteria[0].text, 'result.txt contains complete');
      assert.equal(activeGoal(runtime.state).pendingSpec, undefined);
      await session.prompt('/goal pause');
      if (reopen) {
        const file = session.sessionFile;
        const id = session.sessionId;
        const goal = structuredClone(activeGoal(runtime.state));
        const callsBeforeOpen = workerCalls;
        assert.ok(file);
        runtime.shutdown();
        session.dispose();
        await open(SessionManager.open(file), ['-bash']);
        assert.equal(session.sessionId, id);
        assert.deepEqual(activeGoal(runtime.state), goal);
        assert.equal(runtime.state.owner, null);
        assert.equal(workerCalls, callsBeforeOpen, 'reopening must not restart stopped work');
        for (const name of goalTools) assert.ok(session.getActiveToolNames().includes(name), name);
        assert.equal(session.getActiveToolNames().includes('bash'), false);
        assert.equal(
          session.getActiveToolNames().includes('grep'),
          ['1.3.0', '1.4.0'].includes(VERSION),
        );
      }
      phase = 'resume';
      await run('The fixture is available. Resume the approved goal and finish.');
      assert.equal(activeGoal(runtime.state).status, 'complete');
      assert.equal(runtime.state.owner, null);
      assert.equal(auditCalls, 2);
      assert.ok(
        toolEnds
          .filter((e) => e.toolName === 'goal_resume')
          .some((e) => e.result.content[0].text.startsWith('Goal resumed.')),
      );
      assert.deepEqual(errors, []);
      assert.equal(toolEnds.filter((e) => e.isError).length, 0);
    },
  );
