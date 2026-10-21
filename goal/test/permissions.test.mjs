import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, effectivePermissions, loadSettings } from '../src/settings.ts';
import { permissionReason } from '../src/permissions.ts';
import {
  applySpec,
  isTaskRefinement,
  makeGoal,
  permissionDefaults,
  transition,
} from '../src/state.ts';

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-permissions-'));
  const agent = join(cwd, 'agent');
  mkdirSync(agent);
  mkdirSync(join(cwd, '.pi'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    agent,
    globalFile: join(agent, 'my-pi-goal.json'),
    localFile: join(cwd, '.pi/my-pi-goal.json'),
  };
}

test('autonomous defaults remove redundant Goal prompts while explicit network/install ask overrides still apply', (t) => {
  const { cwd } = setup(t);
  const policy = defaults.permissions;
  for (const command of [
    'npm install dependency',
    'npx tsc',
    'curl https://example.com',
    'git clone source',
    'rm -rf generated',
    'ssh host command',
    'git push origin branch',
    'npm publish',
  ]) {
    assert.equal(permissionReason('bash', { command }, cwd, policy), undefined, command);
  }
  assert.equal(permissionReason('custom_tool', {}, cwd, policy), undefined);
  assert.equal(permissionReason('write', { path: '/tmp/generated.txt' }, cwd, policy), undefined);
  assert.ok(
    permissionReason('bash', { command: 'curl https://example.com' }, cwd, {
      ...policy,
      network: 'ask',
    }),
  );
  assert.ok(
    permissionReason('bash', { command: 'npm install dependency' }, cwd, {
      ...policy,
      install: 'ask',
    }),
  );
});

test('profiles merge global/project settings without discarding explicit legacy asks', (t) => {
  const { cwd, agent, globalFile, localFile } = setup(t);
  assert.deepEqual(loadSettings(cwd, agent).permissions, permissionDefaults('autonomous'));
  writeFileSync(globalFile, JSON.stringify({ permissions: { mode: 'confirm' } }));
  assert.deepEqual(loadSettings(cwd, agent).permissions, permissionDefaults('confirm'));
  writeFileSync(localFile, JSON.stringify({ permissions: { mode: 'autonomous' } }));
  assert.deepEqual(loadSettings(cwd, agent).permissions, permissionDefaults('autonomous'));
  writeFileSync(globalFile, JSON.stringify({ permissions: { network: 'ask', install: 'ask' } }));
  assert.deepEqual(loadSettings(cwd, agent).permissions, {
    mode: 'autonomous',
    network: 'ask',
    install: 'ask',
  });
  writeFileSync(
    localFile,
    JSON.stringify({ permissions: { mode: 'autonomous', network: 'allow', install: 'allow' } }),
  );
  assert.deepEqual(loadSettings(cwd, agent).permissions, permissionDefaults('autonomous'));
});

test('legacy global/project budget caps are discarded while retained protections still merge', (t) => {
  const { cwd, agent, globalFile, localFile } = setup(t);
  writeFileSync(
    globalFile,
    JSON.stringify({
      limits: { maxTurns: 100, maxSeconds: 43200, maxTokens: 1000000, maxAuditFailures: 4 },
      audit: {
        maxTurns: 20,
        maxTokens: 60000,
        timeoutSeconds: 600,
        provider: 'fixture',
        model: 'test',
      },
    }),
  );
  writeFileSync(
    localFile,
    JSON.stringify({
      limits: {
        maxTurns: 1,
        maxSeconds: 1,
        maxTokens: null,
        noProgressWarn: 4,
        noProgressPause: 8,
      },
      audit: { maxTokens: 200000, timeoutSeconds: 1, thinking: 'high' },
    }),
  );
  const settings = loadSettings(cwd, agent);
  assert.deepEqual(settings.limits, {
    maxTokens: null,
    maxAuditFailures: 4,
    noProgressWarn: 4,
    noProgressPause: 8,
  });
  assert.deepEqual(settings.audit, { provider: 'fixture', model: 'test', thinking: 'high' });
  assert.deepEqual(defaults.audit, {});
});

test('invalid policies fail clearly; old journals inherit configuration until a policy is saved', (t) => {
  const { cwd, agent, localFile } = setup(t);
  for (const permissions of [
    null,
    [],
    { mode: 'typo' },
    { network: 'sometimes' },
    { install: false },
    { unknown: 'allow' },
  ]) {
    writeFileSync(localFile, JSON.stringify({ permissions }));
    assert.throws(() => loadSettings(cwd, agent), /permissions/);
  }
  const goal = makeGoal('Old goal');
  const settings = { ...defaults, permissions: permissionDefaults('confirm') };
  assert.equal(effectivePermissions(settings, goal).mode, 'confirm');
  goal.permissionPolicy = permissionDefaults('autonomous');
  assert.equal(effectivePermissions(settings, goal).mode, 'autonomous');
});

test('task refinement preserves mandatory research requirements and rejects changes to checks or objective', () => {
  const spec = {
    objective: 'Analyze data',
    kind: 'research',
    criteria: ['Analysis is reproducible'],
    tasks: ['Analyze'],
    checks: [{ command: 'test -s report.md', timeoutSeconds: 10 }],
  };
  const goal = makeGoal(spec.objective);
  applySpec(goal, spec);
  transition(goal, 'active');
  assert.equal(
    isTaskRefinement(goal, { ...spec, tasks: ['Inspect', 'Analyze', 'Validate'] }),
    true,
  );
  assert.equal(isTaskRefinement(goal, { ...spec, tasks: [] }), false);
  assert.equal(isTaskRefinement(goal, { ...spec, checks: [] }), false);
  assert.equal(isTaskRefinement(goal, { ...spec, objective: 'A different objective' }), false);
  assert.equal(isTaskRefinement(goal, { ...spec, kind: 'general' }), false);
});
