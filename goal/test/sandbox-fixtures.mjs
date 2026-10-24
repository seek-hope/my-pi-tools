import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sandboxSettings } from '../src/verification/contract.ts';

export const testSandbox = {
  backend: 'docker-sandboxes',
  executable: 'sbx',
  template: `example/image@sha256:${'a'.repeat(64)}`,
  imageArchive: '/unused-test-image.tar',
  imageArchiveSha256: 'b'.repeat(64),
  imageId: `sha256:${'c'.repeat(64)}`,
};
/** Host lifecycle tests inject transport; real enforcement lives in check:sandbox. */
export function verificationFixture(checkImplementation) {
  return async (cwd, goal) => ({
    cwd,
    identity: {
      backend: 'docker-sandboxes',
      snapshotDigest: 'fixture',
      environmentDigest: 'fixture',
      specDigest: 'fixture',
      attemptId: 'fixture',
    },
    manifest: { entries: [], excluded: [] },
    check: (check, signal) =>
      checkImplementation
        ? checkImplementation(cwd, check, signal, structuredClone(goal.verification))
        : Promise.resolve({
            at: new Date().toISOString(),
            command: check.command,
            exitCode: 0,
            output: 'fixture check',
          }),
    finish: async () => {},
  });
}

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'goal-sbx-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  await writeFile(join(cwd, 'result.txt'), 'original\n');
  const archive = Buffer.from('trusted fixture image archive');
  const imageArchive = join(root, 'image.tar');
  await writeFile(imageArchive, archive);
  const settings = sandboxSettings({
    backend: 'docker-sandboxes',
    template: `docker.io/example/template@sha256:${'a'.repeat(64)}`,
    imageArchive,
    imageArchiveSha256: createHash('sha256').update(archive).digest('hex'),
    imageId: `sha256:${'b'.repeat(64)}`,
  });
  return { root, cwd, settings };
}

export function fakeSbx(options = {}) {
  const calls = [],
    sandboxes = [];
  let request;
  const success = (value = '') => ({
    code: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  });
  const run = async (args, config) => {
    calls.push({ args, config });
    if (args[0] === 'version')
      return success(
        options.version ?? 'sbx version v0.49.2 5d40fd43027b33ed1f1a39c14fb07e2503d6998f',
      );
    if (args[0] === 'policy' && args[1] === 'ls')
      return success({
        rules: [
          { id: 'deny-gate', decision: 'deny', resources: ['**'], scope: `sandbox:${args[2]}` },
        ],
      });
    if (
      args[0] === 'policy' &&
      args[1] === 'allow' &&
      args.at(-1) === '**' &&
      !calls.some(
        (c) =>
          c.args[0] === 'policy' &&
          c.args[1] === 'rm' &&
          c.args.includes(args[4]) &&
          c.args.includes('deny-gate'),
      )
    ) {
      throw new Error('allow ** conflicts with existing deny **');
    }
    if (args[0] === 'ls') return success(sandboxes);
    if (args[0] === 'create') {
      sandboxes.push({ name: args[args.indexOf('--name') + 1], id: `vm-${sandboxes.length}` });
      if (options.createError) throw new Error('lost create response');
    }
    if (args[0] === 'cp') {
      if (args[2].endsWith('/request.json')) request = JSON.parse(await readFile(args[1], 'utf8'));
      if (options.copyError) throw new Error('copy failed');
    }
    if (args[0] === 'exec' && args.includes('node')) {
      if (options.execute) return await options.execute({ args, config, request, success });
      return success({
        version: 1,
        runId: request.runId,
        kind: 'check',
        exitCode: options.exitCode ?? 0,
        output: 'ok',
        truncated: false,
      });
    }
    if (args[0] === 'stop' && options.stopError) throw new Error('stop unavailable');
    if (args[0] === 'rm') {
      if (options.removeError) return { code: 1, stdout: '', stderr: 'daemon unavailable' };
      sandboxes.splice(
        sandboxes.findIndex((x) => x.name === args.at(-1)),
        1,
      );
    }
    return success();
  };
  return { run, calls, sandboxes };
}
