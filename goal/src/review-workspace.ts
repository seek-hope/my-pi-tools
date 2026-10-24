import { createHash } from 'node:crypto';
import { lstat, readdir, readlink, realpath, readFile } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

// These paths change during ordinary dependency installation/builds or contain Goal's
// own journal. They are not source-version evidence. Explicit audit reads still track them.
const OMIT = new Set([
  '.git',
  '.pi',
  '.codegraph',
  'node_modules',
  '.venv',
  '__pycache__',
  'target',
  'dist',
  'build',
  'coverage',
  '.cache',
]);
export class ReviewChangedError extends Error {}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function contains(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export async function projectPath(cwd: string, path: string) {
  const root = await realpath(cwd),
    actual = await realpath(resolve(root, path));
  if (!contains(root, actual))
    throw new Error('The auditor can only read files inside the project');
  return actual;
}
/** Lightweight freshness marker, not a filesystem snapshot or an execution sandbox. */
export async function workspaceStamp(
  cwd: string,
  signal?: AbortSignal,
  controlPaths: string[] = [],
): Promise<string> {
  const root = await realpath(cwd),
    digest = createHash('sha256');
  const controls = await Promise.all(
    controlPaths.map(async (path) => {
      try {
        return await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return resolve(path);
      }
    }),
  );
  const pending = [''];
  let count = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const dir = pending.pop()!;
    for (const name of (await readdir(join(root, dir))).sort()) {
      signal?.throwIfAborted();
      const path = dir ? `${dir}/${name}` : name;
      const absolute = join(root, path);
      if (controls.some((control) => contains(control, absolute))) continue;
      const info = await lstat(absolute, { bigint: true });
      if (info.isDirectory() && OMIT.has(name)) continue;
      if (++count > 100000) throw new Error('Workspace freshness inventory exceeds 100000 entries');
      if (info.isDirectory()) {
        digest.update(JSON.stringify([path, 'directory']));
        pending.push(path);
      } else if (info.isSymbolicLink()) {
        digest.update(JSON.stringify([path, 'link', await readlink(join(root, path))]));
      } else {
        digest.update(
          JSON.stringify([
            path,
            String(info.dev),
            String(info.ino),
            String(info.mode),
            String(info.size),
            String(info.mtimeNs),
            String(info.ctimeNs),
          ]),
        );
      }
    }
  }
  signal?.throwIfAborted();
  return digest.digest('hex');
}
/** Track the exact text and directory listings seen by this temporary reviewer. */
export class ReviewWorkspace {
  readonly cwd: string;
  private observations = new Map<
    string,
    { requested: string; actual: string; kind: 'file' | 'directory'; digest: string }
  >();
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  private async observe(path: string, kind: 'file' | 'directory') {
    const actual = await projectPath(this.cwd, path);
    const info = await lstat(actual);
    if (kind === 'file' && (!info.isFile() || info.size > 5000000))
      throw new Error('Only text files up to 5 MB are supported');
    if (kind === 'directory' && !info.isDirectory()) throw new Error('Not a directory');
    const text =
      kind === 'file'
        ? await readFile(actual, 'utf8')
        : (await readdir(actual, { withFileTypes: true }))
            .map((x) => `${x.name}${x.isDirectory() ? '/' : ''}`)
            .sort()
            .join('\n');
    if (kind === 'file' && text.includes('\0'))
      throw new Error('Provide a reviewable text or statistical export for binary files');
    return { requested: path, actual, kind, digest: hash(text), text };
  }
  async read(path: string, kind: 'file' | 'directory' = 'file') {
    const next = await this.observe(path, kind),
      key = `${kind}:${path}`;
    const previous = this.observations.get(key);
    if (previous && (previous.actual !== next.actual || previous.digest !== next.digest))
      throw new ReviewChangedError(`Reviewed artifact changed: ${path}`);
    this.observations.set(key, next);
    return next.text;
  }
  async assertCurrent(signal?: AbortSignal) {
    for (const previous of this.observations.values()) {
      signal?.throwIfAborted();
      let next;
      try {
        next = await this.observe(previous.requested, previous.kind);
      } catch (error) {
        throw new ReviewChangedError(
          `Reviewed artifact is no longer readable: ${previous.requested}: ${String(error)}`,
        );
      }
      if (previous.actual !== next.actual || previous.digest !== next.digest)
        throw new ReviewChangedError(`Reviewed artifact changed: ${previous.requested}`);
    }
  }
}
