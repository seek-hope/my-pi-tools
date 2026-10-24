import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  digest,
  inputPolicy,
  SandboxError,
  type InputPolicy,
  type SandboxSettings,
} from './contract.ts';

export const INPUT_POLICY = 'source-v2';
// Always excluded, including when an operator grants a particular fixture file.
const PRIVATE = new Set([
  '.git',
  '.pi',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.codegraph',
]);
const GENERATED = new Set(['node_modules', 'target', '.venv', '__pycache__']);
const sensitive = (name: string) =>
  ['.npmrc', '.netrc', '.pypirc', '.env'].includes(name) ||
  name.startsWith('.env.') ||
  /\.(pem|key|p12|pfx)$/.test(name);
const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/');
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
};

type SnapshotSettings = Pick<SandboxSettings, 'snapshotBytes' | 'snapshotFiles' | 'inputs'>;
export interface ManifestEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  executable?: boolean;
  bytes?: number;
  sha256?: string;
  /** Canonical relative target inside the snapshot, never a host path. */
  target?: string;
  sourceTarget?: string;
  hardlink?: 'internal-copy' | 'authorized-copy';
}
export interface InputManifest {
  policy: string;
  selection: InputPolicy;
  entries: ManifestEntry[];
  excluded: string[];
  exclusions: { path: string; reason: string }[];
  bytes: number;
}
export interface InputInspection extends InputManifest {
  issues: { path: string; reason: string }[];
}
export interface Snapshot {
  root: string;
  digest: string;
  manifest: InputManifest;
  assertUnchanged(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

/** Inventory first: never read rejected files, follow a symlink directory or execute project filters. */
async function inventory(source: string, settings: SnapshotSettings, signal?: AbortSignal) {
  const selection = inputPolicy(settings.inputs);
  if (selection.project && (await realpath(selection.project)) !== source)
    throw new SandboxError(
      'sandbox.inputs.project does not match this workspace; input exceptions cannot be reused across projects',
    );
  const report: InputInspection = {
    policy: INPUT_POLICY,
    selection,
    entries: [],
    excluded: [],
    exclusions: [],
    bytes: 0,
    issues: [],
  };
  const stats = new Map<string, Stats>();
  const nodes = new Map<string, ManifestEntry>();
  const hardlinks = new Map<string, string[]>();
  const issue = (path: string, reason: string) => report.issues.push({ path, reason });
  let visited = 0;
  async function walk(dir: string, rel: string) {
    signal?.throwIfAborted();
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || (await realpath(dir)) !== dir)
      throw new SandboxError(`Snapshot input changed: ${rel || '.'}`, 'input_changed');
    for (const name of (await readdir(dir)).sort()) {
      signal?.throwIfAborted();
      if (++visited > settings.snapshotFiles)
        throw new SandboxError('Snapshot entry limit exceeded');
      const path = rel ? `${rel}/${name}` : name;
      const reason = PRIVATE.has(name)
        ? 'private control or credential path'
        : selection.exclude?.some((prefix) => under(path, prefix))
          ? 'operator exclusion'
          : selection.include &&
              !selection.include.some((prefix) => under(path, prefix) || under(prefix, path))
            ? 'outside selected inputs'
            : GENERATED.has(name)
              ? 'dependency or generated directory; prepare dependencies in the check environment'
              : sensitive(name) && !selection.allowFiles?.includes(path)
                ? 'sensitive filename; exact fixture exceptions require personal sandbox.inputs.allowFiles'
                : undefined;
      if (reason) {
        report.excluded.push(path);
        report.exclusions.push({ path, reason });
        continue;
      }
      const absolute = join(source, path);
      const info = await lstat(absolute);
      if (selection.allowFiles?.includes(path) && !info.isFile()) {
        issue(
          path,
          'allowFiles exceptions must name exact regular files, not directories or symlinks',
        );
        continue;
      }
      stats.set(path, info);
      let entry: ManifestEntry;
      if (info.isDirectory()) {
        entry = { path, type: 'directory' };
      } else if (info.isSymbolicLink()) {
        entry = { path, type: 'symlink', sourceTarget: await readlink(absolute) };
      } else if (info.isFile()) {
        entry = { path, type: 'file', executable: Boolean(info.mode & 0o111), bytes: info.size };
        report.bytes += info.size;
        const key = `${info.dev}:${info.ino}`;
        const aliases = hardlinks.get(key) ?? [];
        aliases.push(path);
        hardlinks.set(key, aliases);
      } else {
        issue(path, 'special files (sockets, devices, FIFOs) cannot enter a source snapshot');
        continue;
      }
      nodes.set(path, entry);
      report.entries.push(entry);
      if (info.isDirectory()) await walk(absolute, path);
    }
  }
  await walk(source, '');
  if (report.bytes > settings.snapshotBytes) issue('.', 'Snapshot byte limit exceeded');
  for (const path of selection.include ?? [])
    if (!nodes.has(path))
      issue(path, 'selected input is absent or excluded; inspect the exclusion list');
  for (const paths of hardlinks.values()) {
    for (const path of paths) {
      const info = stats.get(path)!;
      if (info.nlink === 1) continue;
      const entry = nodes.get(path)!;
      if (info.nlink === paths.length) entry.hardlink = 'internal-copy';
      else if (selection.materializeHardlinks?.includes(path)) entry.hardlink = 'authorized-copy';
      else
        issue(
          path,
          `hard-linked file has ${info.nlink} names but only ${paths.length} selected. Select every alias, or authorize this exact file in personal sandbox.inputs.materializeHardlinks after checking its contents`,
        );
    }
  }
  const linkTargets = new Map<string, string>();
  for (const entry of report.entries.filter((item) => item.type === 'symlink')) {
    const raw = entry.sourceTarget!;
    if (isAbsolute(raw) || !inside(source, resolve(source, dirname(entry.path), raw))) {
      issue(entry.path, 'symlink must be relative and remain inside selected project inputs');
      continue;
    }
    try {
      const actual = await realpath(join(source, entry.path));
      const target = relative(source, actual);
      if (
        !inside(source, actual) ||
        (target && !nodes.has(target)) ||
        nodes.get(target)?.type === 'symlink'
      ) {
        issue(entry.path, 'symlink resolves outside selected inputs or into an excluded path');
        continue;
      }
      entry.target = relative(dirname(join(source, entry.path)), actual) || '.';
      linkTargets.set(entry.path, target);
    } catch (error) {
      if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        issue(entry.path, 'symlink is dangling or cyclic');
      else throw error;
    }
  }
  // Directory links can form traversal cycles even when realpath of each link succeeds.
  const children = new Map<string, string[]>();
  for (const entry of report.entries) {
    const parent = dirname(entry.path) === '.' ? '' : dirname(entry.path);
    const siblings = children.get(parent) ?? [];
    siblings.push(entry.path);
    children.set(parent, siblings);
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  // A shallow filesystem can contain a very deep directory-link graph. Keep traversal
  // on an explicit stack bounded by the input inventory, not the JS call-stack size.
  const stack = [{ path: '', leave: false }];
  while (stack.length) {
    signal?.throwIfAborted();
    const { path, leave } = stack.pop()!;
    if (leave) {
      visiting.delete(path);
      done.add(path);
      continue;
    }
    if (visiting.has(path)) {
      issue(path || '.', 'cyclic directory links are not supported');
      continue;
    }
    if (done.has(path)) continue;
    visiting.add(path);
    stack.push({ path, leave: true });
    const next = linkTargets.has(path) ? [linkTargets.get(path)!] : (children.get(path) ?? []);
    for (let i = next.length - 1; i >= 0; i--) stack.push({ path: next[i], leave: false });
  }
  return { report, stats };
}

export async function inspectInputs(
  cwd: string,
  settings: SnapshotSettings,
  signal?: AbortSignal,
): Promise<InputInspection> {
  return (await inventory(await realpath(cwd), settings, signal)).report;
}

/** Bounded, paged diagnostics available before a VM or image archive is touched. */
export function inputPage(report: InputInspection, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Input offset must be a nonnegative integer');
  const rows = [
    ...report.issues.map((item) => ({ ...item, action: 'rejected' })),
    ...report.exclusions.map((item) => ({ ...item, action: 'excluded' })),
    ...report.entries.map((item) => ({ ...item, action: 'included' })),
  ];
  const next = offset + 50;
  return {
    policy: report.policy,
    selection: report.selection,
    ready: report.issues.length === 0,
    included: report.entries.length,
    excluded: report.excluded.length,
    rejected: report.issues.length,
    bytes: report.bytes,
    offset,
    total: rows.length,
    nextOffset: next < rows.length ? next : null,
    entries: rows.slice(offset, next),
    note: 'Inventory only; files can change before submission. No VM created or file contents returned. Included source bytes are available to checks; network access can disclose them.',
  };
}

async function scan(
  source: string,
  settings: SnapshotSettings,
  signal?: AbortSignal,
  destination?: string,
): Promise<InputManifest> {
  const { report, stats } = await inventory(source, settings, signal);
  if (report.issues.length) {
    const first = report.issues[0];
    throw new SandboxError(
      `Snapshot rejects ${first.path}: ${first.reason}. Inspect with /goal sandbox inputs (${report.issues.length} issue(s)).`,
    );
  }
  const { issues: _issues, ...manifest } = report;
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    const path = entry.path,
      absolute = join(source, path),
      info = stats.get(path)!;
    const current = await lstat(absolute);
    if (
      current.ino !== info.ino ||
      current.dev !== info.dev ||
      current.mode !== info.mode ||
      current.nlink !== info.nlink
    )
      throw new SandboxError(`Snapshot input changed: ${path}`, 'input_changed');
    if (entry.type === 'symlink') {
      if (
        (await readlink(absolute)) !== entry.sourceTarget ||
        (await realpath(absolute)) !== resolve(source, dirname(path), entry.target!)
      )
        throw new SandboxError(`Snapshot link changed: ${path}`, 'input_changed');
      continue; // Install validated links last, after all regular files and directories.
    }
    if ((await realpath(absolute)) !== absolute)
      throw new SandboxError(`Snapshot path changed: ${path}`, 'input_changed');
    if (entry.type === 'directory') {
      if (destination) await mkdir(join(destination, path), { mode: 0o700 });
      continue;
    }
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.ino !== info.ino ||
        before.dev !== info.dev ||
        before.nlink !== info.nlink ||
        before.size !== info.size ||
        before.mtimeMs !== info.mtimeMs ||
        before.ctimeMs !== info.ctimeMs
      )
        throw new SandboxError(`Snapshot input changed: ${path}`, 'input_changed');
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
        before.ctimeMs !== after.ctimeMs ||
        before.nlink !== after.nlink
      )
        throw new SandboxError(`Snapshot input changed: ${path}`, 'input_changed');
    } finally {
      await file.close();
    }
    entry.sha256 = createHash('sha256').update(data).digest('hex');
    if (destination)
      await writeFile(join(destination, path), data, {
        flag: 'wx',
        mode: entry.executable ? 0o500 : 0o400,
      });
  }
  if (destination)
    for (const entry of manifest.entries.filter((item) => item.type === 'symlink'))
      await symlink(entry.target!, join(destination, entry.path));
  return manifest;
}

export async function createSnapshot(
  cwd: string,
  settings: SnapshotSettings,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const frozenSettings = structuredClone(settings);
  const source = await realpath(cwd),
    parent = await realpath(tmpdir());
  if (inside(source, parent))
    throw new SandboxError('Temporary snapshot directory must be outside the source tree');
  const root = await mkdtemp(join(parent, 'goal-verification-'));
  await chmod(root, 0o700);
  try {
    const manifest = await scan(source, frozenSettings, signal, root);
    // Exclusion diagnostics are not inputs: adding an ignored cache or credential must not
    // invalidate an otherwise identical selected snapshot.
    const fingerprint = ({ policy, selection, entries, bytes }: InputManifest) =>
      digest({ policy, selection, entries, bytes });
    const identity = fingerprint(manifest);
    const assertUnchanged = async (nextSignal?: AbortSignal) => {
      if (fingerprint(await scan(source, frozenSettings, nextSignal)) !== identity)
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
