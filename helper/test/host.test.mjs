import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { registerHelper } from '../src/index.ts';
import { message, call } from './fixtures.mjs';

async function host(
  t,
  { request, child, gate, cancelChild = false, meteredRead = false, readNavigation = false },
) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-helper-host-'));
  const agentDir = join(cwd, 'agent');
  let session,
    parentCalls = 0,
    childCalls = 0;
  const errors = [],
    childContexts = [],
    parents = [],
    outcomes = [],
    nested = [];
  t.after(async () => {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(join(cwd, 'original.txt'), 'before\n');
  const models = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  models.registerProvider('helper-fixture', {
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
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const isChild = JSON.stringify(context).includes(
        'independent helper handling one explicit delegation',
      );
      let answer;
      if (isChild) {
        childContexts.push(structuredClone(context));
        childCalls++;
        assert.ok(childCalls <= 8, 'unexpected helper loop');
        if (cancelChild) {
          options.signal.addEventListener(
            'abort',
            () => {
              const aborted = {
                ...message('cancelled', 'aborted'),
                api: model.api,
                provider: model.provider,
                model: model.id,
              };
              stream.push({ type: 'done', reason: 'aborted', message: aborted });
              stream.end();
            },
            { once: true },
          );
          queueMicrotask(() => {
            void session.abort();
          });
          return stream;
        }
        answer = child(childCalls, context);
      } else {
        parents.push(structuredClone(context));
        parentCalls++;
        assert.ok(parentCalls <= 2, 'Helper must never trigger main-session continuation');
        answer =
          parentCalls === 1
            ? message([call('helper', request, 'parent-call')], 'toolUse')
            : message('Main session is done.');
      }
      answer = { ...answer, api: model.api, provider: model.provider, model: model.id };
      stream.push({ type: 'start', partial: answer });
      stream.push({ type: 'done', reason: answer.stopReason, message: answer });
      stream.end();
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...(readNavigation ? { defaultTools: ['+grep', '+find', '+ls'] } : {}),
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
    systemPromptOverride: () => 'PARENT_SYSTEM_PRIVATE_72691',
    extensionFactories: [
      (pi) => {
        if (meteredRead)
          pi.registerTool({
            name: 'read',
            label: 'Metered read',
            description: 'Read the fixture file',
            parameters: Type.Object({ path: Type.String() }),
            async execute(_id, args) {
              return {
                content: [{ type: 'text', text: readFileSync(join(cwd, args.path), 'utf8') }],
                details: undefined,
                usage: message().usage,
              };
            },
          });
        registerHelper(pi, agentDir);
        pi.on('tool_call', (event) => {
          if (!event.parentToolCallId) return;
          nested.push(structuredClone(event));
          return gate?.(event);
        });
        pi.on('tool_result', (event) => {
          if (event.toolName === 'helper') outcomes.push(structuredClone(event));
        });
      },
    ],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({
    role: 'user',
    content: 'PARENT_HISTORY_PRIVATE_13987',
    timestamp: Date.now(),
  });
  ({ session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: models,
    model: models.getModel('helper-fixture', 'offline'),
    thinkingLevel: 'off',
    ...(readNavigation ? {} : { tools: ['read', 'ls', 'write', 'edit', 'bash', 'helper'] }),
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager,
  }));
  await session.bindExtensions({ mode: 'json', onError: (e) => errors.push(e) });
  const before = session.getActiveToolNames();
  await session.prompt('PARENT_CURRENT_PRIVATE_84231. Delegate the selected task to helper.');
  assert.deepEqual(errors, []);
  assert.deepEqual(session.getActiveToolNames(), before, 'Helper does not activate extra tools');
  for (const context of childContexts)
    assert.doesNotMatch(JSON.stringify(context), /PARENT_(SYSTEM|HISTORY|CURRENT)_PRIVATE/);
  assert.ok(JSON.stringify(parents).includes('PARENT_SYSTEM_PRIVATE_72691'));
  assert.ok(JSON.stringify(parents).includes('PARENT_HISTORY_PRIVATE_13987'));
  assert.equal(session.isStreaming, false);
  assert.equal(outcomes.length, 1);
  return {
    session,
    cwd,
    result: outcomes[0].structuredContent,
    event: outcomes[0],
    parentCalls,
    childCalls,
    childContexts,
    nested,
  };
}

test(
  'real SDK: independent work request reads, edits, writes and runs a command through host tools',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t, {
      request: {
        mode: 'work',
        task: 'Update original.txt and create output.txt, then verify them',
        context: 'EXPLICIT_REQUEST_CONTEXT',
      },
      child(n, context) {
        assert.match(JSON.stringify(context), /EXPLICIT_REQUEST_CONTEXT/);
        if (n === 1) return message([call('read', { path: 'original.txt' }, 'r')], 'toolUse');
        if (n === 2) {
          assert.match(JSON.stringify(context), /before/);
          return message(
            [
              call(
                'edit',
                { path: 'original.txt', edits: [{ oldText: 'before', newText: 'after' }] },
                'e',
              ),
              call('write', { path: 'output.txt', content: 'created\n' }, 'w'),
              call(
                'bash',
                { command: 'test -f output.txt && test "$(head -n 1 original.txt)" = after' },
                'b',
              ),
            ],
            'toolUse',
          );
        }
        return message(
          'Updated original.txt, created output.txt, and the command returned exit 0.',
        );
      },
    });
    assert.equal(h.result.status, 'answered');
    assert.equal(h.parentCalls, 2);
    assert.equal(h.childCalls, 3);
    assert.equal(h.result.toolCalls, 4);
    assert.equal(h.result.usage.totalTokens, 30);
    assert.equal(h.event.usage.totalTokens, 30, 'nested model usage is reported once');
    assert.equal(readFileSync(join(h.cwd, 'original.txt'), 'utf8'), 'after\n');
    assert.equal(readFileSync(join(h.cwd, 'output.txt'), 'utf8'), 'created\n');
    assert.ok(h.nested.every((e) => e.parentToolCallId === 'parent-call'));
  },
);

test(
  'real SDK: nested tool usage is counted once without mutating Helper model accounting',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t, {
      request: { task: 'Read original.txt' },
      meteredRead: true,
      child: (n) =>
        n === 1
          ? message([call('read', { path: 'original.txt' })], 'toolUse')
          : message('Read the file.'),
    });
    assert.equal(h.result.status, 'answered');
    assert.equal(h.result.usage.totalTokens, 20);
    const output = h.session.state.messages.find(
      (m) => m.role === 'toolResult' && m.toolName === 'helper',
    );
    assert.equal(output.usage.totalTokens, 30);
    assert.equal(JSON.parse(output.content[0].text).usage.totalTokens, 20);
  },
);

test(
  'real SDK: default read mode prevents a write even with writing tools active in the main session',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t, {
      request: { task: 'Inspect files' },
      child: () => message([call('write', { path: 'forbidden.txt', content: 'no' })], 'toolUse'),
    });
    assert.equal(h.result.status, 'error');
    assert.equal(h.childCalls, 1);
    assert.equal(h.nested.length, 0);
    assert.equal(existsSync(join(h.cwd, 'forbidden.txt')), false);
  },
);
test(
  'real SDK: malformed JSON arguments reject the full batch before a valid earlier write',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t, {
      request: { task: 'Write a file and inspect the directory', mode: 'work' },
      child: (n) =>
        n === 1
          ? message(
              [
                call(
                  'write',
                  { path: 'forbidden.txt', content: 'must not persist' },
                  'write-first',
                ),
                {
                  ...call('ls', {}, 'bad-json'),
                  argumentsError: 'The model returned malformed JSON, normalized to {}',
                },
              ],
              'toolUse',
            )
          : message('Done'),
    });
    assert.equal(existsSync(join(h.cwd, 'forbidden.txt')), false);
    assert.equal(h.result.status, 'error');
    assert.equal(h.nested.length, 0);
    assert.equal(h.childCalls, 1);
  },
);

test(
  'real SDK: configured navigation recovers a missing path and an out-of-range read',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t, {
      request: { task: 'Locate original.txt and inspect before' },
      readNavigation: true,
      child(n, context) {
        const declared =
          context.tools ??
          context.messages.flatMap((m) => (m.role === 'system' ? (m.toolsAdded ?? []) : []));
        assert.deepEqual(declared.map((t) => t.name).sort(), ['find', 'grep', 'ls', 'read']);
        if (n === 1) return message([call('read', { path: 'missing.txt' }, 'missing')], 'toolUse');
        if (n === 2) {
          assert.equal(context.messages.at(-1).isError, true);
          assert.match(context.messages.at(-1).content[0].text, /ENOENT/);
          return message(
            [
              call('ls', { path: '.' }, 'ls'),
              call('find', { pattern: '*.txt', path: '.' }, 'find'),
              call('grep', { pattern: 'before', path: 'original.txt' }, 'grep'),
            ],
            'toolUse',
          );
        }
        if (n === 3) {
          assert.match(JSON.stringify(context.messages.slice(-3)), /original.txt/);
          assert.match(context.messages.at(-1).content[0].text, /before/);
          return message(
            [call('read', { path: 'original.txt', offset: 240 }, 'bad-range')],
            'toolUse',
          );
        }
        if (n === 4) {
          assert.equal(context.messages.at(-1).isError, true);
          assert.match(context.messages.at(-1).content[0].text, /beyond end/);
          return message(
            [call('read', { path: 'original.txt', offset: 1, limit: 2 }, 'corrected')],
            'toolUse',
          );
        }
        assert.equal(n, 5);
        assert.match(context.messages.at(-1).content[0].text, /before/);
        return message('Located original.txt and read before.');
      },
    });
    assert.equal(h.result.status, 'answered', JSON.stringify(h.result));
    assert.equal(h.result.toolCalls, 6);
    assert.equal(h.childCalls, 5);
    assert.equal(h.result.usage.totalTokens, 50);
    assert.equal(h.nested.length, 6);
  },
);

for (const tool of ['read', 'ls', 'grep', 'find'])
  for (const terminate of [false, true])
    test(
      `real SDK: ${tool} permission rejection cannot masquerade as a recoverable lookup (${terminate})`,
      { timeout: 15000 },
      async (t) => {
        const args = {
          read: { path: 'original.txt' },
          ls: { path: '.' },
          grep: { pattern: 'before', path: '.' },
          find: { pattern: '*.txt', path: '.' },
        };
        const h = await host(t, {
          request: { task: 'Inspect local files' },
          readNavigation: true,
          child: () => message([call(tool, args[tool])], 'toolUse'),
          gate: () => ({
            block: true,
            reason:
              tool === 'read'
                ? "ENOENT: no such file or directory, access '/hidden'"
                : 'Path not found: /hidden',
            terminate,
          }),
        });
        assert.equal(h.result.status, terminate ? 'terminated' : 'error');
        assert.equal(h.childCalls, 1);
        assert.equal(h.nested.length, 1);
        assert.equal(h.parentCalls, terminate ? 1 : 2);
      },
    );

for (const hook of ['deny', 'rewrite', 'terminate'])
  test(
    `real SDK: ${hook} hook is preserved, including adjusted command reporting`,
    { timeout: 15000 },
    async (t) => {
      const h = await host(t, {
        request: { task: 'Create forbidden.txt with the command', mode: 'work' },
        child(n, context) {
          if (n === 1)
            return message([call('bash', { command: 'touch forbidden.txt' })], 'toolUse');
          assert.equal(hook, 'rewrite');
          assert.match(JSON.stringify(context), /Host executed adjusted arguments/);
          assert.match(JSON.stringify(context), /command.*true/);
          return message(
            'The host replaced the requested command with true; forbidden.txt was not created.',
          );
        },
        gate(event) {
          if (event.toolName !== 'bash') return;
          if (hook === 'rewrite') {
            event.input.command = 'true';
            return;
          }
          return {
            block: true,
            reason: 'fixture denied',
            ...(hook === 'terminate' ? { terminate: true } : {}),
          };
        },
      });
      assert.equal(existsSync(join(h.cwd, 'forbidden.txt')), false);
      assert.equal(
        h.result.status,
        hook === 'rewrite' ? 'answered' : hook === 'terminate' ? 'terminated' : 'error',
      );
      assert.equal(h.childCalls, hook === 'rewrite' ? 2 : 1);
      assert.equal(h.parentCalls, hook === 'terminate' ? 1 : 2);
      assert.equal(h.result.usage.totalTokens, h.childCalls * 10);
      assert.equal(h.nested.length, 1);
    },
  );

test(
  'real SDK: abort cancels a nested model request and retains reported usage',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t, { request: { task: 'Analyze' }, cancelChild: true });
    assert.equal(h.result.status, 'cancelled');
    assert.equal(h.result.usage.totalTokens, 10);
    assert.equal(h.parentCalls, 1);
    assert.equal(h.childCalls, 1);
  },
);
