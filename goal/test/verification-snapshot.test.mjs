import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, link, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createSnapshot } from '../src/verification/snapshot.ts';
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
  ]) {
    assert.throws(() => sandboxSettings({ ...settings, ...override }));
  }
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'my-pi-goal.json'), JSON.stringify({ sandbox: settings }));
  assert.throws(() => loadSettings(cwd, agent), /personal-only/);
});
