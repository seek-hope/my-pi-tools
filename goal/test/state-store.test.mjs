import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.ts';
import {
  makeGoal,
  applySpec,
  transition,
  resumeGoal,
  budgetReason,
  recordTurn,
  emptyState,
  nextQueued,
  tokensFromUsage,
  completionProblems,
  canAutoClear,
} from '../src/state.ts';
const spec = {
  objective: 'Fix the bug',
  kind: 'coding',
  criteria: ['Regression is fixed'],
  tasks: ['Implement fix'],
  checks: [],
};
function dir(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-goal-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test('cannot complete with executor claims alone; research requires provenance artifacts', () => {
  const g = makeGoal('Fix the bug');
  applySpec(g, spec);
  transition(g, 'active');
  assert.throws(() => transition(g, 'complete'), /independent audit/);
  assert.equal(completionProblems(g).length, 2);
  const research = makeGoal('Analyze data');
  applySpec(research, { ...spec, kind: 'research' });
  assert.equal(research.criteria.length, 5);
});
test('optional cumulative budget counts input/output/caches and survives resume', () => {
  assert.equal(
    tokensFromUsage({ input: 5, output: 7, cacheRead: 11, cacheWrite: 13, reasoning: 4 }),
    36,
  );
  assert.equal(tokensFromUsage({ totalTokens: 9, input: 100 }), 9);
  const g = makeGoal('Fix bug', { maxTurns: 2, maxTokens: 10 });
  applySpec(g, spec);
  transition(g, 'active');
  recordTurn(g, 3, true);
  recordTurn(g, 3, false);
  assert.equal(budgetReason(g), undefined);
  transition(g, 'paused');
  resumeGoal(g);
  assert.equal(g.epoch.turns, 0);
  assert.equal(g.usage.tokens, 6);
  recordTurn(g, 5, true);
  transition(g, 'budget_limited');
  assert.throws(() => resumeGoal(g), /budget/);
});
test('automatic cleanup requires a verified selection and an entirely finished queue', () => {
  const statuses = [
    'draft',
    'queued',
    'active',
    'verifying',
    'paused',
    'blocked',
    'budget_limited',
    'complete',
    'skipped',
  ];
  for (const status of statuses)
    for (const verdict of [undefined, 'pass', 'fail', 'error'])
      for (const next of [undefined, ...statuses]) {
        const selected = { id: 'current', status, audits: verdict ? [{ verdict }] : [] };
        const s = {
          ...emptyState(),
          activeId: 'current',
          goals: [selected, ...(next ? [{ id: 'next', status: next, audits: [] }] : [])],
        };
        assert.equal(
          canAutoClear(s),
          status === 'complete' &&
            verdict === 'pass' &&
            (!next || ['complete', 'skipped'].includes(next)),
        );
        s.activeId = null;
        assert.equal(canAutoClear(s), false);
      }
});

test('a pending queue draft cannot be silently skipped', () => {
  const s = emptyState(),
    draft = makeGoal('First'),
    queued = makeGoal('Second');
  applySpec(queued, spec);
  transition(queued, 'queued');
  s.goals = [draft, queued];
  assert.equal(nextQueued(s), undefined);
  transition(draft, 'skipped');
  assert.equal(nextQueued(s).id, queued.id);
});
test('durable journal recovers a partial tail, preserves it and rejects corruption', (t) => {
  const root = dir(t),
    store = new ProjectStore(root, 'A');
  store.claim();
  store.change('add', (s) => s.goals.push(makeGoal('Test')));
  appendFileSync(store.file, '{"interrupted":');
  assert.equal(store.load().goals.length, 1);
  store.change('note', (s) => s.goals[0].notes.push('restored'));
  assert.equal(new ProjectStore(root, 'A').load().goals[0].notes[0], 'restored');
  assert.match(readFileSync(join(store.directory, 'STATUS.md'), 'utf8'), /restored/);
  const before = readFileSync(store.file, 'utf8');
  writeFileSync(store.file, before.replace('Test', 'Tampered'));
  assert.throws(() => store.load(), /integrity/);
});
test('legacy journal caps migrate only after hash verification, preserving evidence and history', (t) => {
  const root = dir(t);
  const store = new ProjectStore(root, 'A');
  store.claim();
  store.change('legacy.fixture', (s) => {
    const g = makeGoal('Legacy');
    applySpec(g, spec);
    g.limits = { ...g.limits, maxTurns: 100, maxSeconds: 43200, maxTokens: 900000 };
    g.criteria[0].evidence.push('original evidence');
    g.tasks[0].evidence.push('task evidence');
    g.checks = [
      {
        id: 'K1',
        command: 'true',
        timeoutSeconds: 1,
        last: { at: 'then', command: 'true', exitCode: 0, output: 'original output' },
      },
    ];
    g.pendingSpec = { ...spec, checks: [{ command: 'test -f result.txt', timeoutSeconds: 600 }] };
    g.usage.tokens = 123456;
    s.goals.push(g);
    s.activeId = g.id;
  });
  const original = readFileSync(store.file, 'utf8');
  const legacy = store.history().at(-1).state.goals[0];
  const g = store.load().goals[0];
  assert.equal(g.limits.maxTokens, 900000);
  assert.equal(Object.hasOwn(g.limits, 'maxTurns'), false);
  assert.equal(Object.hasOwn(g.limits, 'maxSeconds'), false);
  assert.deepEqual(g.criteria, legacy.criteria);
  assert.deepEqual(g.tasks, legacy.tasks);
  assert.deepEqual(g.usage, legacy.usage);
  assert.deepEqual(g.checks, [{ id: 'K1', command: 'true', last: legacy.checks[0].last }]);
  assert.deepEqual(g.pendingSpec.checks, [{ command: 'test -f result.txt' }]);
  assert.equal(readFileSync(store.file, 'utf8'), original);
  store.change('migration.checkpoint', () => {});
  assert.ok(readFileSync(store.file, 'utf8').startsWith(original));
  assert.deepEqual(store.load().goals[0], g);
  writeFileSync(store.file, original.replace('"maxTurns":100', '"maxTurns":1'));
  assert.throws(() => store.load(), /integrity/);
});

test('single writer survives competing instances of the same session and transfers after release', (t) => {
  const root = dir(t),
    a = new ProjectStore(root, 'A'),
    b = new ProjectStore(root, 'A');
  a.claim();
  assert.throws(() => b.claim(), /another Pi instance/);
  assert.throws(() => b.change('bad', () => {}), /ownership/);
  a.release();
  b.claim();
  assert.throws(() => a.change('stale', () => {}), /ownership/);
});
test('crash recovery excludes offline time and needs explicit resume', (t) => {
  const root = dir(t),
    a = new ProjectStore(root, 'A');
  a.claim();
  a.change('crash-fixture', (s) => {
    const g = makeGoal('Test');
    applySpec(g, spec);
    transition(g, 'active');
    g.clockAt = '2000-01-01T00:00:00Z';
    s.goals.push(g);
    s.activeId = g.id;
    s.owner = { sessionId: 'A', token: 'dead', pid: 2147483647, host: hostname() };
  });
  const b = new ProjectStore(root, 'A');
  const s = b.claim();
  assert.equal(s.goals[0].status, 'paused');
  assert.equal(s.goals[0].usage.activeSeconds, 0);
  assert.equal(s.queuePaused, true);
});
test('invalid limits fail instead of silently disabling budgets', () => {
  assert.throws(() => makeGoal('Test', { maxTokens: -1 }), /Invalid/);
  assert.throws(() => makeGoal('Test', { maxTokens: Infinity }), /Invalid/);
  assert.throws(() => makeGoal('Test', { maxAuditFailures: 0 }), /Invalid/);
  assert.throws(() => makeGoal('Test', { noProgressPause: 3 }), /threshold/);
  assert.throws(() => makeGoal('Test', { noProgressWarn: undefined }), /Invalid/);
});

test('journal stores deltas with periodic snapshots and reconstructs event history', (t) => {
  const root = dir(t);
  const store = new ProjectStore(root, 'A');
  store.claim();
  store.change('first', (s) => s.goals.push(makeGoal('Delta')));
  for (let i = 0; i < 40; i++)
    store.change('note', (s) => {
      s.goals[0].notes.push(`note ${i} ${'x'.repeat(80)}`);
      s.goals[0].usage.turns++;
    });
  const entries = readFileSync(store.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(
    entries.some((entry) => entry.patch),
    'small updates are stored as deltas',
  );
  assert.ok(
    entries.some((entry) => entry.state),
    'periodic full snapshots remain',
  );
  assert.ok(
    entries.every((entry) => (entry.patch ? entry.state === undefined : entry.state !== undefined)),
    'each entry carries exactly one representation',
  );
  const history = store.history();
  const loaded = store.load();
  assert.equal(history.length, loaded.revision);
  assert.deepEqual(history.at(-1).state, loaded);
  assert.equal(history.at(-1).state.goals[0].notes.at(-1), `note 39 ${'x'.repeat(80)}`);
  assert.equal(history.at(-1).event, 'note');
  assert.ok(
    statSync(store.file).size < Buffer.byteLength(JSON.stringify(loaded)) * entries.length,
    'delta journal is smaller than one full snapshot per event',
  );
});

test('repeated reads reuse the parsed snapshot and detect external appends or tampering', (t) => {
  const root = dir(t);
  const first = new ProjectStore(root, 'A');
  first.claim();
  first.change('first', (s) => s.goals.push(makeGoal('Cached')));
  const initial = first.load();
  assert.deepEqual(first.load(), initial);
  assert.deepEqual(first.load(), initial);
  first.release();
  const other = new ProjectStore(root, 'A');
  other.claim();
  other.change('external', (s) => s.goals.push(makeGoal('External')));
  other.release();
  assert.equal(first.load().goals.length, 2, 'external append invalidates the cache');
  const original = readFileSync(first.file, 'utf8');
  writeFileSync(first.file, original.replace('External', 'Tampered'));
  assert.throws(() => first.load(), /integrity/);
});
