import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ProjectStore } from '../src/store.ts';
import { emptyState, makeGoal } from '../src/state.ts';

function dir(t) {
  const root = mkdtempSync(join(tmpdir(), 'goal-session-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function legacy(root, sessionId, liveOwner = false) {
  const file = join(root, '.pi/my-pi-goal/state.jsonl');
  mkdirSync(join(root, '.pi/my-pi-goal'), { recursive: true });
  const s = emptyState();
  s.goals.push(makeGoal('Legacy obligation'));
  s.goals[0].notes.push('Do not lose the original evidence');
  s.activeId = s.goals[0].id;
  s.owner = {
    sessionId,
    token: 'legacy-token',
    pid: liveOwner ? process.pid : 2147483647,
    host: hostname(),
  };
  let previous = '';
  const lines = [];
  for (let revision = 1; revision <= (liveOwner ? 1 : 2); revision++) {
    s.revision = revision;
    if (revision === 2) s.owner = null;
    const payload = {
      revision,
      at: '2026-10-07T00:00:00.000Z',
      event: revision === 1 ? 'goal.create' : 'owner.release',
      previous,
      state: s,
    };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    lines.push(JSON.stringify({ ...payload, hash }));
    previous = hash;
  }
  writeFileSync(file, `${lines.join('\n')}\n`);
  return { file, original: readFileSync(file, 'utf8'), state: s };
}

test('different sessions in the same directory can own independent goals concurrently', (t) => {
  const root = dir(t),
    a = new ProjectStore(root, 'A'),
    b = new ProjectStore(root, 'B');
  a.claim();
  a.change('add', (s) => s.goals.push(makeGoal('A only')));
  b.claim();
  b.change('add', (s) => s.goals.push(makeGoal('B only')));
  assert.notEqual(a.file, b.file);
  assert.ok(a.owns());
  assert.ok(b.owns());
  assert.deepEqual(
    a.load().goals.map((g) => g.objective),
    ['A only'],
  );
  assert.deepEqual(
    b.load().goals.map((g) => g.objective),
    ['B only'],
  );
  assert.equal(a.load().sessionId, 'A');
  assert.equal(b.load().sessionId, 'B');
  assert.throws(
    () =>
      a.change('wrong.scope', (s) => {
        s.sessionId = 'B';
      }),
    /another Pi session/,
  );
  assert.ok(a.owns());
  writeFileSync(b.file, readFileSync(a.file));
  assert.throws(() => b.load(), /belongs to another Pi session/);
});

test('custom SDK session IDs cannot escape or alias a session directory', (t) => {
  const root = dir(t);
  const ids = ['../escape', '..', '/', 'a/b', 'a%2Fb', '中文', 'A'];
  const files = ids.map((id) => {
    const store = new ProjectStore(root, id);
    store.claim();
    assert.ok(
      relative(join(root, '.pi/my-pi-goal/sessions'), store.file).match(
        /^[0-9a-f]{64}\/state.jsonl$/,
      ),
    );
    assert.equal(store.load().sessionId, id);
    return store.file;
  });
  assert.equal(new Set(files).size, ids.length);
  assert.throws(() => new ProjectStore(root, ''), /session ID/);
});

test('legacy migration selects the last owner session, preserves bytes and never resurrects after clear', (t) => {
  const root = dir(t),
    old = legacy(root, 'A');
  const b = new ProjectStore(root, 'B');
  assert.equal(b.migrateLegacy(), false);
  assert.equal(existsSync(b.file), false);
  assert.equal(b.load().goals.length, 0);
  const a = new ProjectStore(root, 'A');
  assert.equal(a.migrateLegacy(), true);
  assert.equal(readFileSync(a.file, 'utf8'), old.original);
  assert.equal(readFileSync(old.file, 'utf8'), old.original);
  assert.deepEqual(a.load().goals, old.state.goals);
  a.claim();
  a.change('goal.clear', (s) => {
    s.goals = [];
    s.activeId = null;
    s.queuePaused = true;
  });
  a.release();
  const reopened = new ProjectStore(root, 'A');
  assert.equal(reopened.migrateLegacy(), false);
  assert.deepEqual(reopened.load().goals, []);
  assert.ok(readFileSync(a.file, 'utf8').startsWith(old.original));
  assert.equal(readFileSync(old.file, 'utf8'), old.original);
  assert.doesNotMatch(readFileSync(join(a.directory, 'STATUS.md'), 'utf8'), /Legacy obligation/);
});

test('legacy migration refuses a live old writer, preserves partial tails and validates the hash chain', (t) => {
  const root = dir(t),
    store = new ProjectStore(root, 'A');
  legacy(root, 'A', true);
  assert.throws(() => store.migrateLegacy(), /older version still owns/);
  assert.equal(existsSync(store.file), false);
  const old = legacy(root, 'A');
  writeFileSync(old.file, old.original.replace('Legacy obligation', 'tampered'));
  assert.throws(() => store.migrateLegacy(), /integrity/);
  assert.equal(existsSync(store.file), false);
  writeFileSync(old.file, old.original + '{"partial":');
  assert.equal(store.migrateLegacy(), true);
  assert.equal(readFileSync(store.file, 'utf8'), old.original + '{"partial":');
  store.claim();
  assert.equal(store.load().goals.length, 1);
  assert.equal(readFileSync(old.file, 'utf8'), old.original + '{"partial":');
});
