import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { SandboxError } from './contract.ts';
import { requireSuccess, type CommandRunner } from './process.ts';

export interface Lease {
  version: 1;
  name: string;
  id?: string;
  createdAt: string;
  pid: number;
  host: string;
  phase: 'creating' | 'running' | 'cleanup_pending';
}
export function parseSandboxList(text: string): { name: string; id: string }[] {
  const rows: unknown = JSON.parse(text);
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) => !row || typeof row.name !== 'string' || typeof row.id !== 'string' || !row.id,
    )
  )
    throw new SandboxError('Unsupported sbx ls JSON schema; cannot verify sandbox identity');
  return rows;
}
export class LeaseStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  path(name: string) {
    if (!/^goal-[a-f0-9-]{36}$/.test(name))
      throw new SandboxError('Invalid goal sandbox lease name');
    return join(this.root, `${name}.json`);
  }
  async save(lease: Lease) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(lease.name);
    const temp = `${target}.${process.pid}.tmp`;
    const file = await open(temp, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(lease));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, target);
  }
  async list(): Promise<Lease[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const result: Lease[] = [];
    for (const file of await readdir(this.root)) {
      if (!file.endsWith('.json')) continue;
      const lease = JSON.parse(await readFile(join(this.root, file), 'utf8')) as Lease;
      if (
        lease.version !== 1 ||
        this.path(lease.name) !== join(this.root, file) ||
        !Number.isSafeInteger(lease.pid) ||
        lease.pid <= 0 ||
        typeof lease.host !== 'string' ||
        !['creating', 'running', 'cleanup_pending'].includes(lease.phase) ||
        (lease.id !== undefined && (typeof lease.id !== 'string' || !lease.id))
      )
        throw new SandboxError('Invalid sandbox lease; inspect it before recovery', 'cleanup');
      result.push(lease);
    }
    return result;
  }
  async forget(lease: Lease) {
    await rm(this.path(lease.name), { force: true });
  }
}
export function ownerAlive(lease: Lease): boolean {
  if (lease.host !== hostname()) return true;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Uses a fresh deadline, never the aborted execution signal. Identity must match, not just a prefix. */
export async function disposeSandbox(
  lease: Lease,
  store: LeaseStore,
  run: CommandRunner,
  timeoutMs: number,
) {
  const options = { timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
  try {
    const list = async () =>
      parseSandboxList(requireSuccess(await run(['ls', '--json'], options), 'sbx ls'));
    const target = (await list()).find((row) => row.name === lease.name);
    if (!target) {
      // A creation request interrupted before its reply could still be in flight on the daemon.
      if (!lease.id)
        throw new Error('Creation outcome is unknown; manually reconcile this exact name');
      await store.forget(lease);
      return;
    }
    if (!lease.id || target.id !== lease.id)
      throw new Error('Sandbox identity is unknown or changed; refusing removal');
    try {
      await run(['stop', lease.name], options);
    } catch {
      /* Still try rm within the cleanup deadline. */
    }
    requireSuccess(await run(['rm', '--force', lease.name], options), 'sbx rm');
    if ((await list()).some((row) => row.name === lease.name || row.id === lease.id))
      throw new Error('Sandbox still exists after remove');
    await store.forget(lease);
  } catch (error) {
    lease.phase = 'cleanup_pending';
    await store.save(lease);
    throw new SandboxError(
      `Sandbox cleanup pending for ${lease.name}: ${String(error)}`,
      'cleanup',
    );
  }
}
