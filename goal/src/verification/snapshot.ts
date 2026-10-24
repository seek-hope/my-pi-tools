import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { digest, SandboxError, type SandboxSettings } from './contract.ts';

// Deliberately versioned, fixed scope. No project-supplied glob/hook/filter execution.
export const INPUT_POLICY = 'source-v1';
const EXCLUDE = new Set([
  '.git',
  '.pi',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.codegraph',
  'node_modules',
  'target',
  '.venv',
  '__pycache__',
  '.npmrc',
  '.netrc',
  '.pypirc',
]);
const excluded = (name: string) =>
  EXCLUDE.has(name) ||
  name === '.env' ||
  name.startsWith('.env.') ||
  /\.(pem|key|p12|pfx)$/.test(name);
export interface ManifestEntry {
  path: string;
  type: 'file' | 'directory';
  executable?: boolean;
  bytes?: number;
  sha256?: string;
}
export interface InputManifest {
  policy: string;
  entries: ManifestEntry[];
  excluded: string[];
  bytes: number;
}
export interface Snapshot {
  root: string;
  digest: string;
  manifest: InputManifest;
  assertUnchanged(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

async function scan(
  source: string,
  limits: Pick<SandboxSettings, 'snapshotBytes' | 'snapshotFiles'>,
  signal?: AbortSignal,
  destination?: string,
): Promise<InputManifest> {
  const manifest: InputManifest = { policy: INPUT_POLICY, entries: [], excluded: [], bytes: 0 };
  let visited = 0;
  async function walk(dir: string, rel: string) {
    signal?.throwIfAborted();
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      signal?.throwIfAborted();
      if (++visited > limits.snapshotFiles) throw new SandboxError('Snapshot entry limit exceeded');
      const path = rel ? `${rel}/${name}` : name;
      if (excluded(name)) {
        manifest.excluded.push(path);
        continue;
      }
      const absolute = join(dir, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
        throw new SandboxError(`Snapshot rejects links and special files: ${path}`);
      const actual = await realpath(absolute);
      if (actual !== absolute)
        throw new SandboxError(`Snapshot path changed: ${path}`, 'input_changed');
      if (info.isDirectory()) {
        manifest.entries.push({ path, type: 'directory' });
        if (destination) await mkdir(join(destination, path), { mode: 0o700 });
        await walk(absolute, path);
      } else {
        // Refuse hardlinks: cannot determine whether another name is outside the input scope.
        if (info.nlink !== 1) throw new SandboxError(`Snapshot rejects hard-linked file: ${path}`);
        if (manifest.bytes + info.size > limits.snapshotBytes)
          throw new SandboxError('Snapshot byte limit exceeded');
        const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        let data: Buffer;
        try {
          const before = await file.stat();
          if (
            !before.isFile() ||
            before.ino !== info.ino ||
            before.dev !== info.dev ||
            before.nlink !== 1
          )
            throw new SandboxError(`Snapshot input changed: ${path}`, 'input_changed');
          // Bounded reads even if a concurrent writer grows the source file.
          if (manifest.bytes + before.size > limits.snapshotBytes)
            throw new SandboxError('Snapshot byte limit exceeded');
          data = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < data.length) {
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          const after = await file.stat();
          if (
            offset !== data.length ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new SandboxError(`Snapshot input changed: ${path}`, 'input_changed');
        } finally {
          await file.close();
        }
        const executable = Boolean(info.mode & 0o111);
        manifest.bytes += data.length;
        manifest.entries.push({
          path,
          type: 'file',
          executable,
          bytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
        });
        if (destination) {
          await writeFile(join(destination, path), data, {
            flag: 'wx',
            mode: executable ? 0o500 : 0o400,
          });
        }
      }
    }
  }
  await walk(source, '');
  return manifest;
}

export async function createSnapshot(
  cwd: string,
  settings: SandboxSettings,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const source = await realpath(cwd);
  const parent = await realpath(tmpdir());
  if (parent === source || parent.startsWith(source + sep))
    throw new SandboxError('Temporary snapshot directory must be outside the source tree');
  const root = await mkdtemp(join(parent, 'goal-verification-'));
  await chmod(root, 0o700);
  try {
    const manifest = await scan(source, settings, signal, root);
    const identity = digest(manifest);
    const assertUnchanged = async (nextSignal?: AbortSignal) => {
      if (digest(await scan(source, settings, nextSignal)) !== identity)
        throw new SandboxError(
          'Verification inputs changed; submit the current files again',
          'input_changed',
        );
    };
    await assertUnchanged(signal);
    return {
      root,
      digest: identity,
      manifest,
      assertUnchanged,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
