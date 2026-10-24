import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  writeFile,
  readFile,
  readlink,
  lstat,
  symlink,
  link,
  access,
  rm,
  chmod,
} from 'node:fs/promises';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { createSnapshot, inspectInputs, inputPage } from '../src/verification/snapshot.ts';
import { sandboxSettings } from '../src/verification/contract.ts';
import { loadSettings } from '../src/settings.ts';
import { fixture } from './sandbox-fixtures.mjs';

test('snapshot includes dirty/untracked inputs, excludes credentials and detects later changes', async (t) => {
  const { cwd, settings } = await fixture(t);
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'state.jsonl'), 'private journal');
  await writeFile(join(cwd, '.env'), 'DO_NOT_TRANSFER=secret');
  await writeFile(join(cwd, 'new.txt'), 'untracked');
  const snapshot = await createSnapshot(cwd, settings);
  t.after(() => snapshot.dispose());
  assert.equal(await readFile(join(snapshot.root, 'new.txt'), 'utf8'), 'untracked');
  await assert.rejects(access(join(snapshot.root, '.env')));
  assert.deepEqual(snapshot.manifest.excluded, ['.env', '.pi']);
  await writeFile(join(cwd, '.pi', 'state.jsonl'), 'later journal');
  await snapshot.assertUnchanged();
  await writeFile(join(cwd, 'result.txt'), 'new implementation');
  assert.equal(await readFile(join(snapshot.root, 'result.txt'), 'utf8'), 'original\n');
  await assert.rejects(snapshot.assertUnchanged(), /inputs changed/);
});

test('snapshot rejects external links, hardlinks, and enforces entry and byte limits', async (t) => {
  for (const kind of ['symlink', 'hardlink', 'bytes', 'entries']) {
    const { cwd, root, settings } = await fixture(t);
    const external = join(root, 'secret');
    await writeFile(external, 'host secret');
    if (kind === 'symlink') await symlink(external, join(cwd, 'escape'));
    if (kind === 'hardlink') await link(external, join(cwd, 'escape'));
    if (kind === 'bytes') settings.snapshotBytes = 1;
    if (kind === 'entries') settings.snapshotFiles = 0;
    await assert.rejects(createSnapshot(cwd, settings), /rejects|limit/);
  }
});

test('snapshot rejects cancellation and removes its private copy after dispose', async (t) => {
  const { cwd, settings } = await fixture(t);
  await assert.rejects(createSnapshot(cwd, settings, AbortSignal.abort()));
  const snapshot = await createSnapshot(cwd, settings);
  await snapshot.dispose();
  await assert.rejects(access(snapshot.root));
});

test('selected internal hardlinks become independent copies without modifying their host inode', async (t) => {
  const { cwd, settings } = await fixture(t);
  await link(join(cwd, 'result.txt'), join(cwd, 'alias.txt'));
  const snapshot = await createSnapshot(cwd, settings);
  t.after(() => snapshot.dispose());
  const a = await lstat(join(snapshot.root, 'result.txt'));
  const b = await lstat(join(snapshot.root, 'alias.txt'));
  assert.equal(a.nlink, 1);
  assert.equal(b.nlink, 1);
  assert.notEqual(a.ino, b.ino);
  await chmod(join(snapshot.root, 'alias.txt'), 0o600);
  await writeFile(join(snapshot.root, 'alias.txt'), 'private changes');
  assert.equal(await readFile(join(snapshot.root, 'result.txt'), 'utf8'), 'original\n');
  assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'original\n');
  await snapshot.assertUnchanged();
});

test('unselected hardlink aliases require an exact personal grant and still create independent bytes', async (t) => {
  const { cwd, root, settings } = await fixture(t);
  await link(join(cwd, 'result.txt'), join(root, 'external-alias'));
  await assert.rejects(createSnapshot(cwd, settings), /materializeHardlinks/);
  settings.inputs = { project: cwd, materializeHardlinks: ['result.txt'] };
  const snapshot = await createSnapshot(cwd, settings);
  t.after(() => snapshot.dispose());
  assert.equal((await lstat(join(snapshot.root, 'result.txt'))).nlink, 1);
  assert.equal(snapshot.manifest.entries[0].hardlink, 'authorized-copy');
});

test('relative file and directory links stay inside selected frozen inputs', async (t) => {
  const { cwd, settings } = await fixture(t);
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'x.txt'), 'frozen bytes');
  await symlink('src', join(cwd, 'lib'));
  await symlink('../src/x.txt', join(cwd, 'src', 'alias.txt'));
  const snapshot = await createSnapshot(cwd, settings);
  t.after(() => snapshot.dispose());
  assert.equal(await readlink(join(snapshot.root, 'lib')), 'src');
  assert.equal(await readFile(join(snapshot.root, 'lib', 'alias.txt'), 'utf8'), 'frozen bytes');
  await writeFile(join(cwd, 'src', 'x.txt'), 'new bytes');
  assert.equal(await readFile(join(snapshot.root, 'lib', 'alias.txt'), 'utf8'), 'frozen bytes');
  await assert.rejects(snapshot.assertUnchanged(), /inputs changed/);
});

test('absolute, excluded, dangling and cyclic links are rejected before copying', async (t) => {
  for (const kind of [
    'absolute',
    'excluded',
    'dangling',
    'cycle',
    'directory-cycle',
    'unselected',
  ]) {
    const { cwd, settings } = await fixture(t);
    await writeFile(join(cwd, '.env'), 'private');
    let target = {
      absolute: join(cwd, 'result.txt'),
      excluded: '.env',
      dangling: 'missing',
      cycle: 'alias',
      'directory-cycle': '.',
      unselected: 'result.txt',
    }[kind];
    await symlink(target, join(cwd, 'alias'));
    if (kind === 'unselected') settings.inputs = { include: ['alias'] };
    const report = await inspectInputs(cwd, settings);
    assert.ok(report.issues.length, kind);
    assert.equal(inputPage(report).ready, false);
    await assert.rejects(createSnapshot(cwd, settings), /Snapshot rejects/);
  }
});

test('input selection, fixture exceptions and exclusions are explicit and cannot expose control paths', async (t) => {
  const { cwd, settings } = await fixture(t);
  await mkdir(join(cwd, 'test'));
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, 'test', 'public.pem'), 'synthetic certificate');
  await writeFile(join(cwd, 'test', '.env.example'), 'CI=1');
  await writeFile(join(cwd, '.pi', 'secret.key'), 'private');
  settings.inputs = {
    project: cwd,
    include: ['test'],
    allowFiles: ['test/public.pem', 'test/.env.example', '.pi/secret.key'],
  };
  const snapshot = await createSnapshot(cwd, settings);
  t.after(() => snapshot.dispose());
  assert.equal(
    await readFile(join(snapshot.root, 'test', 'public.pem'), 'utf8'),
    'synthetic certificate',
  );
  await assert.rejects(access(join(snapshot.root, '.pi')));
  await assert.rejects(access(join(snapshot.root, 'result.txt')));
  await writeFile(join(cwd, 'result.txt'), 'outside scope changes');
  await writeFile(join(cwd, '.env.other'), 'ignored');
  await snapshot.assertUnchanged();
  settings.inputs = { project: cwd, exclude: ['test'], allowFiles: ['test/public.pem'] };
  const report = await inspectInputs(cwd, settings);
  assert.ok(
    report.exclusions.some((item) => item.path === 'test' && item.reason === 'operator exclusion'),
  );
  assert.ok(!report.entries.some((item) => item.path === 'test/public.pem'));
});

test('hardlink aliases hidden in excluded credentials cannot masquerade as normal source', async (t) => {
  const { cwd, settings } = await fixture(t);
  await link(join(cwd, 'result.txt'), join(cwd, '.env'));
  await assert.rejects(createSnapshot(cwd, settings), /only 1 selected/);
  assert.equal((await inspectInputs(cwd, settings)).issues.length, 1);
});

test('input inventory is bounded, paged and available without a daemon or image archive', async (t) => {
  const { cwd, settings } = await fixture(t);
  await Promise.all(
    Array.from({ length: 60 }, (_, i) => writeFile(join(cwd, `data-${i}.txt`), 'value')),
  );
  settings.imageArchive = '/does/not/exist';
  const page = inputPage(await inspectInputs(cwd, settings));
  assert.equal(page.included, 61);
  assert.equal(page.entries.length, 50);
  assert.equal(page.nextOffset, 50);
  assert.equal(JSON.stringify(page).includes('value'), false);
  assert.throws(() => inputPage({ ...page, issues: [] }, -1), /offset/);
  settings.inputs = { include: ['absent'] };
  assert.equal(inputPage(await inspectInputs(cwd, settings)).ready, false);
});

test('link retargeting and directory cycles cannot escape a frozen snapshot', async (t) => {
  const { cwd, settings } = await fixture(t);
  await mkdir(join(cwd, 'a'));
  await mkdir(join(cwd, 'b'));
  await symlink('result.txt', join(cwd, 'alias'));
  const snapshot = await createSnapshot(cwd, settings);
  t.after(() => snapshot.dispose());
  await rm(join(cwd, 'alias'));
  await symlink('b', join(cwd, 'alias'));
  await assert.rejects(snapshot.assertUnchanged(), /inputs changed/);
  await symlink('../b', join(cwd, 'a', 'back'));
  await symlink('../a', join(cwd, 'b', 'back'));
  await assert.rejects(createSnapshot(cwd, settings), /cyclic directory/);
});

test('content exceptions cannot be reused in another project or authorize an entire sensitive directory', async (t) => {
  const { cwd, root, settings } = await fixture(t);
  assert.throws(
    () => sandboxSettings({ ...settings, inputs: { allowFiles: ['test.pem'] } }),
    /exact workspace/,
  );
  settings.inputs = { project: root, allowFiles: ['test.pem'] };
  await assert.rejects(inspectInputs(cwd, settings), /does not match/);
  await mkdir(join(cwd, '.env.fixture'));
  await writeFile(join(cwd, '.env.fixture', 'private'), 'must not enter');
  settings.inputs = { project: cwd, allowFiles: ['.env.fixture'] };
  const report = await inspectInputs(cwd, settings);
  assert.ok(report.issues.some((item) => /exact regular files/.test(item.reason)));
  assert.equal(
    report.entries.some((item) => item.path.endsWith('/private')),
    false,
  );
});

test('filesystem-root workspaces reject temporary descendants before scanning', async (t) => {
  const { settings } = await fixture(t);
  // A zero entry limit ensures a broken guard cannot enumerate the real filesystem.
  await assert.rejects(
    createSnapshot(parse(tmpdir()).root, { ...settings, snapshotFiles: 0 }),
    /Temporary snapshot directory must be outside/,
  );
});

test('long acyclic directory-link graphs do not depend on the JavaScript call-stack limit', async (t) => {
  const { cwd, settings } = await fixture(t);
  const count = 5000;
  const name = (i) => `d${String(i).padStart(4, '0')}`;
  for (let i = 0; i < count; i++) {
    await mkdir(join(cwd, name(i)));
    if (i + 1 < count) await symlink(`../${name(i + 1)}`, join(cwd, name(i), 'next'));
  }
  const report = await inspectInputs(cwd, settings);
  assert.equal(report.issues.length, 0);
  assert.equal(report.entries.length, count * 2);
});

test('only personal config can enable a pinned sandbox profile; unknown or mutable settings fail', async (t) => {
  const { root, cwd, settings } = await fixture(t);
  const agent = join(root, 'agent');
  await mkdir(agent);
  await writeFile(join(agent, 'my-pi-goal.json'), JSON.stringify({ sandbox: settings }));
  assert.deepEqual(loadSettings(cwd, agent).sandbox, settings);
  for (const override of [
    { template: 'image:latest' },
    { backend: 'docker' },
    { cpus: 0 },
    { arbitraryHook: 'sh' },
    { executable: './in-project' },
    { imageArchiveSha256: 'bad' },
    { inputs: { include: [] } },
    { inputs: { include: ['/outside'] } },
    { inputs: { exclude: ['../outside'] } },
    { inputs: { allowFiles: ['test/*.pem'] } },
    { inputs: { hook: 'sh' } },
  ]) {
    assert.throws(() => sandboxSettings({ ...settings, ...override }));
  }
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'my-pi-goal.json'), JSON.stringify({ sandbox: settings }));
  assert.throws(() => loadSettings(cwd, agent), /personal-only/);
});
