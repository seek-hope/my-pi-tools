import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings, defaults, validateSettings } from '../src/settings.ts';
import { registerHelper } from '../src/index.ts';
import { assertSupportedPi } from '../src/compatibility.ts';
import { fixture, message } from './fixtures.mjs';

function directories(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'helper-settings-'));
  const agentDir = join(cwd, 'agent');
  mkdirSync(agentDir);
  mkdirSync(join(cwd, '.pi'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return { cwd, agentDir };
}
test('settings load only explicit helper files and merge project over personal values', (t) => {
  const { cwd, agentDir } = directories(t);
  assert.deepEqual(loadSettings(cwd, agentDir), defaults);
  writeFileSync(
    join(agentDir, 'my-pi-helper.json'),
    JSON.stringify({ provider: 'p', model: 'm', timeoutSeconds: 60 }),
  );
  writeFileSync(join(cwd, '.pi/my-pi-helper.json'), JSON.stringify({ timeoutSeconds: 30 }));
  assert.deepEqual(loadSettings(cwd, agentDir), { provider: 'p', model: 'm', timeoutSeconds: 30 });
});
test('settings keep only timeout and optional model selection; unknown limits are rejected', (t) => {
  const { cwd, agentDir } = directories(t);
  const file = join(agentDir, 'my-pi-helper.json');
  assert.deepEqual(defaults, { timeoutSeconds: 1200 });
  assert.doesNotThrow(() => validateSettings({ timeoutSeconds: 3600 }));
  for (const value of [
    null,
    [],
    { timeoutSeconds: 0 },
    { timeoutSeconds: 3601 },
    { timeoutSeconds: 1.5 },
    { provider: 'p' },
    { provider: ' ', model: 'm' },
    { thinking: 'bad' },
    { maxTurns: 20 },
    { maxToolCalls: 200 },
    { maxContextChars: 2000000 },
    { maxOutputTokens: 4096 },
  ]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadSettings(cwd, agentDir));
  }
  writeFileSync(file, '{invalid');
  assert.throws(() => loadSettings(cwd, agentDir), /Cannot read/);
  assert.throws(() => validateSettings({ timeoutSeconds: Infinity }));
});
test('one model-only read-only tool declares exactly the parent tools it reaches', (t) => {
  const { agentDir } = directories(t);
  const tools = [],
    events = [];
  registerHelper({ registerTool: (t) => tools.push(t), on: (name) => events.push(name) }, agentDir);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].exposure, 'model-only');
  assert.equal(tools[0].executionMode, 'sequential');
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[0].annotations.destructiveHint, false);
  assert.deepEqual(tools[0].reachesTools({}), ['read', 'grep', 'find', 'ls']);
  assert.deepEqual(events, ['session_shutdown', 'tool_result']);
});
test('shutdown cancels the native child and a later invocation starts fresh', async (t) => {
  const { cwd, agentDir } = directories(t);
  const events = new Map();
  let tool, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  registerHelper(
    {
      registerTool: (t) => {
        tool = t;
      },
      on: (name, handler) => events.set(name, handler),
    },
    agentDir,
  );
  const f = fixture(
    (_c, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered();
      }),
  );
  f.ctx.cwd = cwd;
  const pending = tool.execute(
    'a',
    { task: 'FIRST_HELPER_PRIVATE_TASK' },
    undefined,
    undefined,
    f.ctx,
  );
  await started;
  events.get('session_shutdown')();
  const stopped = await pending;
  assert.equal(stopped.details.status, 'cancelled');
  const fresh = fixture([message('Fresh')]);
  fresh.ctx.cwd = cwd;
  const next = await tool.execute('b', { task: 'Different' }, undefined, undefined, fresh.ctx);
  assert.equal(next.details.status, 'answered');
  assert.doesNotMatch(JSON.stringify(fresh.contexts), /FIRST_HELPER_PRIVATE_TASK/);
  next.usage.totalTokens = 1000;
  assert.equal(next.details.usage.totalTokens, 10);
});
test('support window remains the tested Pi pair', () => {
  for (const v of ['1.3.0', '1.4.0']) assert.doesNotThrow(() => assertSupportedPi(v));
  for (const v of ['1.2.0', '1.5.0', '1.4.0-dev']) assert.throws(() => assertSupportedPi(v));
});
