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
test('settings merge only explicit Helper files and ignore historical Goal settings', (t) => {
  const { cwd, agentDir } = directories(t);
  writeFileSync(join(agentDir, 'my-pi-goal.json'), '{invalid retired config');
  assert.deepEqual(loadSettings(cwd, agentDir), defaults);
  writeFileSync(
    join(agentDir, 'my-pi-helper.json'),
    JSON.stringify({ provider: 'p', model: 'm', maxTurns: 10 }),
  );
  writeFileSync(join(cwd, '.pi/my-pi-helper.json'), JSON.stringify({ maxTurns: 4 }));
  const a = loadSettings(cwd, agentDir);
  assert.equal(a.provider, 'p');
  assert.equal(a.model, 'm');
  assert.equal(a.maxTurns, 4);
  a.maxTurns = 1;
  assert.equal(loadSettings(cwd, agentDir).maxTurns, 4);
});
test('invalid, unbounded or unknown settings are rejected', (t) => {
  const { cwd, agentDir } = directories(t);
  const file = join(agentDir, 'my-pi-helper.json');
  for (const value of [
    null,
    [],
    { maxTurns: 0 },
    { maxTurns: null },
    { maxTurns: 65 },
    { maxTurns: 1.5 },
    { provider: 'p' },
    { provider: ' ', model: 'm' },
    { thinking: 'invalid' },
    { autoContinue: true },
    { timeoutSeconds: 0 },
    { maxToolCalls: 257 },
  ]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadSettings(cwd, agentDir));
  }
  writeFileSync(file, '{not json');
  assert.throws(() => loadSettings(cwd, agentDir), /Cannot read/);
  for (const key of [
    'maxTurns',
    'maxToolCalls',
    'timeoutSeconds',
    'maxOutputTokens',
    'maxContextChars',
  ])
    assert.throws(() => validateSettings({ ...defaults, [key]: Infinity }));
});
test('registration adds one model-only tool and only observation/shutdown hooks', (t) => {
  const { agentDir } = directories(t);
  const tools = [],
    events = [];
  registerHelper({ registerTool: (t) => tools.push(t), on: (name) => events.push(name) }, agentDir);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['helper'],
  );
  assert.equal(tools[0].exposure, 'model-only');
  assert.equal(tools[0].executionMode, 'sequential');
  assert.deepEqual(events, ['session_shutdown', 'tool_result']);
  assert.ok(!tools[0].reachesTools({}).includes('bash'));
  assert.ok(tools[0].reachesTools({ mode: 'work' }).includes('bash'));
});
test('shutdown aborts in-flight requests and a later invocation starts fresh', async (t) => {
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
  const running = tool.execute('a', { task: 'Inspect' }, undefined, undefined, f.ctx);
  await started;
  events.get('session_shutdown')();
  const stopped = await running;
  assert.equal(stopped.details.status, 'cancelled');
  assert.equal(stopped.isError, true);
  const fresh = fixture([message('Fresh answer')]);
  fresh.ctx.cwd = cwd;
  const next = await tool.execute('b', { task: 'Different task' }, undefined, undefined, fresh.ctx);
  assert.equal(next.details.status, 'answered');
  assert.equal(fresh.contexts[0].messages.length, 1);
  assert.equal(next.details.usage.totalTokens, 10);
  next.usage.totalTokens = 1000;
  assert.equal(
    next.details.usage.totalTokens,
    10,
    'host usage aggregation must not mutate our recorded model usage',
  );
});
test('support window accepts only the tested release pair', () => {
  assert.doesNotThrow(() => assertSupportedPi('1.3.0'));
  assert.doesNotThrow(() => assertSupportedPi('1.4.0'));
  for (const version of ['1.2.0', '1.5.0', '1.4.0-dev'])
    assert.throws(() => assertSupportedPi(version), /supports Pi/);
});
