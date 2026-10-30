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
  {
    request,
    child,
    gate,
    cancelChild = false,
    meteredRead = false,
    readNavigation = true,
    resultGate,
  },
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
  writeFileSync(join(cwd, 'rewritten.txt'), 'after\n');
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
        'independent read-only helper handling one explicit delegation',
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
          if (event.parentToolCallId) return resultGate?.(event);
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
  'real SDK: navigation and ordinary read/grep errors are handled by the child Pi loop',
  { timeout: 15000 },
  async (t) => {
    const h = await host(t, {
      request: { task: 'Find and inspect original.txt' },
      child(n, context) {
        const declared =
          context.tools ??
          context.messages.flatMap((m) => (m.role === 'system' ? (m.toolsAdded ?? []) : []));
        assert.deepEqual(declared.map((t) => t.name).sort(), ['find', 'grep', 'ls', 'read']);
        if (n === 1) return message([call('read', { path: 'missing.txt' }, 'missing')], 'toolUse');
        if (n === 2) {
          assert.equal(context.messages.at(-1).isError, true);
          return message(
            [
              call('ls', { path: '.' }, 'ls'),
              call('find', { pattern: '*.txt' }, 'find'),
              call('grep', { pattern: '(?!before)', path: 'original.txt' }, 'regex'),
            ],
            'toolUse',
          );
        }
        if (n === 3) {
          assert.match(context.messages.at(-1).content[0].text, /look-around/);
          return message(
            [
              call('grep', { pattern: 'before', path: 'original.txt' }, 'correct'),
              call('read', { path: 'original.txt', offset: 240 }, 'range'),
            ],
            'toolUse',
          );
        }
        if (n === 4) {
          assert.match(context.messages.at(-1).content[0].text, /beyond end/);
          return message(
            [call('grep', { pattern: '\u0000', path: 'original.txt' }, 'nul')],
            'toolUse',
          );
        }
        if (n === 5) {
          assert.match(context.messages.at(-1).content[0].text, /null bytes/);
          return message(
            [call('read', { path: 'original.txt', offset: 1, limit: 2 }, 'read')],
            'toolUse',
          );
        }
        assert.equal(n, 6);
        assert.match(context.messages.at(-1).content[0].text, /before/);
        return message('Inspected original.txt: before.');
      },
    });
    assert.equal(h.result.status, 'answered', JSON.stringify(h.result));
    assert.equal(h.result.toolCalls, 8);
    assert.equal(h.childCalls, 6);
    assert.equal(h.result.usage.totalTokens, 60);
    assert.equal(h.nested.length, 8);
  },
);

for (const tool of ['read', 'ls', 'grep', 'find'])
  for (const terminate of [false, true])
    test(`real SDK: parent ${tool} denial stops even when disguised as a lookup error (${terminate})`, async (t) => {
      const args = {
        read: { path: 'original.txt' },
        ls: { path: '.' },
        grep: { pattern: 'before' },
        find: { pattern: '*.txt' },
      };
      const h = await host(t, {
        request: { task: 'Inspect' },
        child: () =>
          message(
            [
              call(tool, args[tool], 'deny'),
              call('read', { path: 'rewritten.txt' }, 'must-not-run'),
            ],
            'toolUse',
          ),
        gate: () => ({
          block: true,
          reason: "ENOENT: no such file or directory, access '/hidden'",
          terminate,
        }),
      });
      assert.equal(h.result.status, terminate ? 'terminated' : 'error', JSON.stringify(h.result));
      assert.equal(h.childCalls, 1);
      assert.equal(h.nested.length, 1);
      assert.equal(h.parentCalls, terminate ? 1 : 2);
    });

test('real SDK: parent argument rewrites and result redaction reach the child', async (t) => {
  const h = await host(t, {
    request: { task: 'Inspect original.txt' },
    gate: (event) => {
      event.input.path = 'rewritten.txt';
    },
    resultGate: () => ({ content: [{ type: 'text', text: 'REDACTED' }] }),
    child(n, context) {
      if (n === 1) return message([call('read', { path: 'original.txt' })], 'toolUse');
      const output = JSON.stringify(context.messages.at(-1));
      assert.match(output, /Host executed adjusted arguments/);
      assert.match(output, /rewritten.txt/);
      assert.match(output, /REDACTED/);
      assert.doesNotMatch(output, /after/);
      return message('The host supplied a redacted result.');
    },
  });
  assert.equal(h.result.status, 'answered', JSON.stringify(h.result));
  assert.equal(readFileSync(join(h.cwd, 'original.txt'), 'utf8'), 'before\n');
});

test('real SDK: unavailable write/command tools never reach the host', async (t) => {
  const h = await host(t, {
    request: { task: 'Analyze only' },
    child(n, context) {
      if (n === 1)
        return message(
          [
            call('write', { path: 'forbidden.txt', content: 'bad' }, 'write'),
            call('bash', { command: 'touch forbidden.txt' }, 'bash'),
          ],
          'toolUse',
        );
      assert.match(JSON.stringify(context.messages.slice(-2)), /not found/);
      return message('Only read-only inspection is available.');
    },
  });
  assert.equal(h.result.status, 'answered');
  assert.equal(h.nested.length, 0);
  assert.equal(existsSync(join(h.cwd, 'forbidden.txt')), false);
});

test('real SDK: nested tool usage is charged once, separately from child model usage', async (t) => {
  const h = await host(t, {
    request: { task: 'Inspect' },
    meteredRead: true,
    child: (n) =>
      n === 1 ? message([call('read', { path: 'original.txt' })], 'toolUse') : message('Done'),
  });
  assert.equal(h.result.status, 'answered');
  assert.equal(h.result.usage.totalTokens, 20);
  const stored = h.session.messages.find((m) => m.role === 'toolResult' && m.toolName === 'helper');
  assert.equal(stored.usage.totalTokens, 30);
  assert.equal(h.result.usage.totalTokens, 20);
});

test('real SDK: parent cancellation stops the child model', { timeout: 10000 }, async (t) => {
  const h = await host(t, {
    request: { task: 'Inspect' },
    child: () => message('unused'),
    cancelChild: true,
  });
  assert.equal(h.result.status, 'cancelled', JSON.stringify(h.result));
  assert.equal(h.childCalls, 1);
  assert.equal(h.parentCalls, 1);
});
