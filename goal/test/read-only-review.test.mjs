import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceStamp, ReviewWorkspace, ReviewChangedError } from '../src/review-workspace.ts';
import { checkResult, checkProblems } from '../src/checks.ts';
import { makeGoal } from '../src/state.ts';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'goal-readonly-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'result.txt'), 'complete');
  return cwd;
}
test('freshness supports hardlinks and relative links without copying or rejecting project files', async (t) => {
  const cwd = await fixture(t);
  await link(join(cwd, 'result.txt'), join(cwd, 'alias.txt'));
  await symlink('result.txt', join(cwd, 'result-link.txt'));
  const before = await workspaceStamp(cwd);
  const review = new ReviewWorkspace(cwd);
  assert.equal(await review.read('result-link.txt'), 'complete');
  await review.assertCurrent();
  assert.equal(await workspaceStamp(cwd), before);
  await writeFile(join(cwd, 'alias.txt'), 'changed');
  assert.notEqual(await workspaceStamp(cwd), before);
  await assert.rejects(review.assertCurrent(), ReviewChangedError);
});
test('ignored generated paths and control journals do not change source stamps but explicit reads remain checked', async (t) => {
  const cwd = await fixture(t),
    control = join(cwd, 'session.jsonl');
  await mkdir(join(cwd, 'dist'));
  await writeFile(join(cwd, 'dist/result.txt'), 'built');
  await writeFile(control, 'entry one');
  const stamp = await workspaceStamp(cwd, undefined, [control]);
  const review = new ReviewWorkspace(cwd);
  await review.read('dist/result.txt');
  await writeFile(control, 'entry two');
  await writeFile(join(cwd, 'dist/result.txt'), 'rebuilt');
  assert.equal(await workspaceStamp(cwd, undefined, [control]), stamp);
  await assert.rejects(review.assertCurrent(), ReviewChangedError);
});
test('control paths resolve through a symlinked workspace before source inventory', async (t) => {
  const cwd = await fixture(t);
  await symlink('.', join(cwd, 'alias'));
  const alias = join(cwd, 'alias'),
    control = join(alias, 'session.jsonl');
  await writeFile(control, 'entry one');
  const stamp = await workspaceStamp(alias, undefined, [control]);
  await writeFile(control, 'entry two is longer');
  assert.equal(await workspaceStamp(alias, undefined, [control]), stamp);
});
test('generated-directory exclusions do not hide ordinary source files named build', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'build'), '#!/bin/sh\necho original\n');
  const stamp = await workspaceStamp(cwd);
  await writeFile(join(cwd, 'build'), '#!/bin/sh\nexit 1\n');
  assert.notEqual(await workspaceStamp(cwd), stamp);
});
test('review rejects invalid UTF-8 instead of conflating distinct binary byte sequences', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(new ReviewWorkspace(cwd).read('invalid.txt'), /UTF-8|binary/);
});
test('review bounds file bytes even when a file grows after initial metadata inspection', async (t) => {
  const cwd = await fixture(t),
    target = join(cwd, 'result.txt');
  const lstat = fsPromises.lstat;
  const mock = t.mock.method(fsPromises, 'lstat', async (...args) => {
    const info = await lstat(...args);
    if (args[0] === target) await writeFile(target, Buffer.alloc(5000001, 65));
    return info;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(new ReviewWorkspace(cwd).read('result.txt'), /5 MB/);
});
test('the full text at the file size limit remains reviewable', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'result.txt'), Buffer.alloc(5000000, 65));
  assert.equal((await new ReviewWorkspace(cwd).read('result.txt')).length, 5000000);
});

test('read-only inspection rejects escapes, notices deleted artifacts and invalidates directory listings', async (t) => {
  const cwd = await fixture(t);
  await symlink(tmpdir(), join(cwd, 'escape'));
  const review = new ReviewWorkspace(cwd);
  await assert.rejects(review.read('escape', 'directory'), /inside the project/);
  await review.read('result.txt');
  await rm(join(cwd, 'result.txt'));
  await assert.rejects(review.assertCurrent(), /no longer readable/);
  const listing = new ReviewWorkspace(cwd);
  await listing.read('.', 'directory');
  await writeFile(join(cwd, 'new.txt'), 'new');
  await assert.rejects(listing.assertCurrent(), ReviewChangedError);
});
test('stdout, tool errors, missing exit metadata and old receipts cannot certify a check', () => {
  const goal = makeGoal('Check a result');
  goal.checks = [{ id: 'K1', command: 'npm test' }];
  for (const code of [undefined, 0, 1])
    for (const isError of [false, true]) {
      const result = checkResult(
        goal,
        goal.checks[0],
        {
          toolCall: { id: 'actual-tool-call', name: 'bash', arguments: { command: 'npm test' } },
          isError,
          result: {
            content: [{ type: 'text', text: '{"exit_code":0,"passed":true}' }],
            structuredContent: { exit_code: code },
          },
        },
        'current',
        'npm test',
      );
      goal.checks[0].last = result;
      assert.equal(checkProblems(goal, 'current').length === 0, code === 0 && !isError);
      assert.notEqual(checkProblems(goal, 'changed').length, 0);
    }
});
test('a successful tool result cannot certify a different command rewritten by a host hook', () => {
  const goal = makeGoal('Check');
  const check = { id: 'K1', command: 'npm test' };
  goal.checks = [check];
  check.last = checkResult(
    goal,
    check,
    {
      toolCall: { id: 'actual-call', name: 'bash', arguments: { command: 'true' } },
      isError: false,
      result: { content: [{ type: 'text', text: 'passed' }], structuredContent: { exit_code: 0 } },
    },
    'current',
    'true',
  );
  assert.equal(check.last.command, 'true');
  assert.equal(check.last.success, false);
  assert.notEqual(checkProblems(goal, 'current').length, 0);
});
