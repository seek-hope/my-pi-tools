import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import { agentPath, until } from './fixtures.mjs';
import antigravity, { rememberedSession } from '../src/index.ts';

function extension() {
  const commands = new Map(),
    events = new Map();
  antigravity({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
  });
  return { commands, events };
}

test('extension registers only an interactive ACP command, with no model or tool bridge', () => {
  const { commands, events } = extension();
  assert.deepEqual([...commands.keys()], ['antigravity']);
  assert.ok(events.has('session_shutdown'));
});

test('native Pi loader imports the ACP SDK and UI using the installed extension entry', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-load-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, 'agent'),
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  assert.equal(loader.getExtensions().extensions[0].commands.has('antigravity'), true);
});

test('non-interactive and busy Pi sessions cannot silently launch the external agent', async () => {
  const { commands } = extension();
  const notices = [];
  const ctx = { mode: 'json', ui: { notify: (message) => notices.push(message) } };
  await commands.get('antigravity').handler('', ctx);
  assert.match(notices.pop(), /交互界面/);
  await commands.get('antigravity').handler('', { ...ctx, mode: 'tui', isIdle: () => false });
  assert.match(notices.pop(), /结束当前 Pi 任务/);
});

test('command preserves drafts during startup and shutdown awaits an already-running exit', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-command-'));
  const launcher = join(cwd, 'agy.mjs');
  await writeFile(
    launcher,
    `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(agentPath).href)};\n`,
    { mode: 0o700 },
  );
  const saved = process.env.ANTIGRAVITY_ACP_COMMAND;
  const savedScenario = process.env.ACP_TEST_SCENARIO;
  process.env.ANTIGRAVITY_ACP_COMMAND = launcher;
  process.env.ACP_TEST_SCENARIO = 'slow-init';
  t.after(async () => {
    if (saved === undefined) delete process.env.ANTIGRAVITY_ACP_COMMAND;
    else process.env.ANTIGRAVITY_ACP_COMMAND = saved;
    if (savedScenario === undefined) delete process.env.ACP_TEST_SCENARIO;
    else process.env.ACP_TEST_SCENARIO = savedScenario;
    await rm(cwd, { recursive: true, force: true });
  });
  initTheme('dark', false);
  const commands = new Map(),
    events = new Map(),
    entries = [];
  antigravity({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => events.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  });
  let screen,
    done = 0;
  const ctx = {
    mode: 'tui',
    cwd,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'owner', getBranch: () => entries },
    ui: {
      notify: (message) => assert.fail(message),
      custom: (factory) =>
        new Promise((resolve) => {
          screen = factory(
            { terminal: { rows: 30 }, requestRender() {} },
            { fg: (_color, value) => value },
            {
              matches: (value, action) =>
                action === 'tui.select.cancel' && matchesKey(value, 'escape'),
            },
            () => {
              done++;
              resolve();
            },
          );
        }),
    },
  };
  const command = commands.get('antigravity').handler('first message', ctx);
  t.after(async () => {
    await screen?.leave();
    await command;
  });
  await until(() => screen !== undefined);
  screen.handleInput('draft entered while connecting');
  await until(() =>
    screen.conversation.entries.some(
      (entry) => entry.kind === 'assistant' && entry.text.includes('first message'),
    ),
  );
  assert.match(screen.render(100).join('\n'), /draft entered while connecting/);
  assert.equal(entries[0].data.owner, 'owner');
  const firstExit = screen.leave();
  assert.equal(screen.leave(), firstExit);
  await events.get('session_shutdown')();
  assert.equal(screen.conversation.state, 'closed');
  await command;
  assert.equal(done, 1);
});

test('session references use the current branch, project and owning Pi session only', () => {
  const entry = (sessionId, extra = {}) => ({
    type: 'custom',
    customType: 'my-pi-antigravity-session',
    data: { version: 1, owner: 'owner', cwd: '/project', sessionId, ...extra },
  });
  const branch = [
    entry('first'),
    entry('latest'),
    entry('different-project', { cwd: '/other' }),
    entry('inherited', { owner: 'parent' }),
  ];
  const ctx = {
    cwd: '/project',
    sessionManager: { getSessionId: () => 'owner', getBranch: () => branch },
  };
  assert.equal(rememberedSession(ctx), 'latest');
  assert.equal(rememberedSession({ ...ctx, cwd: '/missing' }), undefined);
});
