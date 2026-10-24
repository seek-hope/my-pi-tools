import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import {
  activeGoal,
  emptyState,
  isRunning,
  normalizeLimits,
  validateState,
  type Owner,
  type ProjectState,
} from './state.ts';

export type StatePath = (string | number)[];
/** Compact journal update: explicit sets and removals instead of a full state copy. */
export interface StatePatch {
  set: [StatePath, unknown][];
  unset: StatePath[];
}
interface Entry {
  revision: number;
  at: string;
  event: string;
  previous: string;
  state?: ProjectState;
  patch?: StatePatch;
  hash: string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function collectPatch(previous: unknown, next: unknown, path: StatePath, patch: StatePatch) {
  if (previous === next) return;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const shared = Math.min(previous.length, next.length);
    for (let i = 0; i < shared; i++) collectPatch(previous[i], next[i], [...path, i], patch);
    // Remove descending so earlier indices do not shift during application.
    for (let i = previous.length - 1; i >= next.length; i--) patch.unset.push([...path, i]);
    for (let i = previous.length; i < next.length; i++)
      patch.set.push([[...path, i], structuredClone(next[i])]);
    return;
  }
  if (isRecord(previous) && isRecord(next)) {
    for (const key of Object.keys(previous))
      if (!(key in next) || next[key] === undefined) patch.unset.push([...path, key]);
    for (const key of Object.keys(next)) {
      const value = next[key];
      if (value === undefined) continue;
      if (!(key in previous) || previous[key] === undefined)
        patch.set.push([[...path, key], structuredClone(value)]);
      else collectPatch(previous[key], value, [...path, key], patch);
    }
    return;
  }
  if (JSON.stringify(previous) !== JSON.stringify(next))
    patch.set.push([path, structuredClone(next)]);
}
/** Build a deterministic delta between two state snapshots. */
export function diffState(previous: unknown, next: unknown): StatePatch {
  const patch: StatePatch = { set: [], unset: [] };
  collectPatch(previous, next, [], patch);
  return patch;
}
function assignAt(root: unknown, path: StatePath, value: unknown) {
  if (!path.length) throw new Error('Invalid goal journal patch path');
  let parent: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    parent = parent?.[path[i] as never];
    if (!parent || typeof parent !== 'object') throw new Error('Invalid goal journal patch path');
  }
  const key = path[path.length - 1]!;
  if (Array.isArray(parent)) {
    if (typeof key !== 'number' || key < 0 || key > parent.length)
      throw new Error('Invalid goal journal patch index');
  } else if (isRecord(parent)) {
    if (typeof key !== 'string') throw new Error('Invalid goal journal patch key');
  } else throw new Error('Invalid goal journal patch target');
  (parent as Record<string | number, unknown>)[key] = value;
}
function removeAt(root: unknown, path: StatePath) {
  if (!path.length) throw new Error('Invalid goal journal patch path');
  let parent: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    parent = parent?.[path[i] as never];
    if (!parent || typeof parent !== 'object') throw new Error('Invalid goal journal patch path');
  }
  const key = path[path.length - 1]!;
  if (Array.isArray(parent)) {
    if (typeof key !== 'number' || key < 0 || key >= parent.length)
      throw new Error('Invalid goal journal patch index');
    parent.splice(key, 1);
  } else if (isRecord(parent)) {
    if (typeof key !== 'string') throw new Error('Invalid goal journal patch key');
    delete parent[key];
  } else throw new Error('Invalid goal journal patch target');
}
/** Apply a validated journal patch without mutating the previous state. */
export function applyStatePatch(state: ProjectState, patch: StatePatch): ProjectState {
  if (
    !patch ||
    !Array.isArray(patch.set) ||
    !Array.isArray(patch.unset) ||
    !patch.set.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        Array.isArray(item[0]) &&
        item[0].every((key) => typeof key === 'string' || typeof key === 'number'),
    ) ||
    !patch.unset.every(
      (path) =>
        Array.isArray(path) &&
        path.every((key) => typeof key === 'string' || typeof key === 'number'),
    )
  )
    throw new Error('Invalid goal journal patch');
  const next = structuredClone(state);
  for (const path of patch.unset) removeAt(next, path);
  for (const [path, value] of patch.set) assignAt(next, path, structuredClone(value));
  return next;
}
type GoalWithLegacyEnvironment = ProjectState['goals'][number] & {
  verification?: unknown;
  consecutiveEnvironmentFailures?: unknown;
};
/** Project a loaded or just-mutated state into the current schema in place. */
function normalizeState(state: ProjectState) {
  for (const goal of state.goals) {
    goal.limits = normalizeLimits(goal.limits);
    if (
      ['paused', 'blocked', 'budget_limited'].includes(goal.status) &&
      goal.resumeAfterInput === undefined
    )
      goal.resumeAfterInput = goal.inputs.length;
    goal.checks = goal.checks.map(({ id, command, last }) => ({
      id,
      command,
      ...(last ? { last } : {}),
    }));
    goal.auditRequests ??= [];
    // Retired runtime settings are ignored in current projections; journal bytes remain intact.
    delete (goal as GoalWithLegacyEnvironment).verification;
    delete (goal as GoalWithLegacyEnvironment).consecutiveEnvironmentFailures;
    if (goal.pendingSpec)
      goal.pendingSpec.checks = goal.pendingSpec.checks.map(({ command }) => ({ command }));
  }
  return state;
}
export class ProjectStore {
  readonly directory: string;
  readonly file: string;
  token = randomUUID();
  readonly legacyDirectory: string;
  exportError?: string;
  readonly cwd: string;
  readonly sessionId: string;
  private cache?: {
    state: ProjectState;
    hash: string;
    bytes: number;
    tail: string;
    lastSessionId?: string;
    size: number;
    mtimeNs: bigint;
    ctimeNs: bigint;
    ino: bigint;
  };
  constructor(cwd: string, sessionId: string) {
    this.cwd = cwd;
    if (!sessionId) throw new Error('Missing Pi session ID; cannot create a session goal store');
    this.sessionId = sessionId;
    this.legacyDirectory = join(realpathSync(cwd), '.pi', 'my-pi-goal');
    // SDK session IDs need not be UUIDs; hashing also prevents path traversal.
    const key = createHash('sha256').update(sessionId).digest('hex');
    this.directory = join(this.legacyDirectory, 'sessions', key);
    this.file = join(this.directory, 'state.jsonl');
  }
  private statFile() {
    try {
      const stat = statSync(this.file, { bigint: true });
      return {
        size: Number(stat.size),
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
        ino: stat.ino,
      };
    } catch {
      return undefined;
    }
  }
  /** Reuse the last parsed snapshot only while the journal's identity is unchanged. */
  private cachedRead() {
    const cache = this.cache;
    if (!cache) return undefined;
    const stat = this.statFile();
    if (
      !stat ||
      stat.size !== cache.size ||
      stat.mtimeNs !== cache.mtimeNs ||
      stat.ctimeNs !== cache.ctimeNs ||
      stat.ino !== cache.ino
    )
      return undefined;
    return cache;
  }
  private remember(result: {
    state: ProjectState;
    hash: string;
    bytes: number;
    tail: string;
    lastSessionId?: string;
  }) {
    // A cached snapshot must match what a fresh read would project.
    normalizeState(result.state);
    const stat = this.statFile();
    if (stat) this.cache = { ...result, ...stat };
  }
  private decode(text: string) {
    const boundary = text.lastIndexOf('\n') + 1;
    let state = emptyState(),
      hash = '',
      lastSessionId: string | undefined;
    const history: {
      revision: number;
      at: string;
      event: string;
      state: ProjectState;
    }[] = [];
    for (const line of text.slice(0, boundary).split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line) as Entry;
      const { hash: claimed, ...payload } = entry;
      if (
        entry.previous !== hash ||
        entry.revision !== state.revision + 1 ||
        digest(payload) !== claimed
      )
        throw new Error(
          'Goal journal integrity check failed; writes stopped. Preserve the journal for recovery',
        );
      if (entry.state !== undefined) {
        validateState(entry.state);
        if (entry.state.revision !== entry.revision)
          throw new Error('Goal journal revision mismatch');
        state = entry.state;
      } else if (entry.patch !== undefined) {
        state = applyStatePatch(state, entry.patch);
        if (state.revision !== entry.revision) throw new Error('Goal journal revision mismatch');
      } else throw new Error('Goal journal entry has neither a snapshot nor a patch');
      lastSessionId = state.owner?.sessionId ?? lastSessionId;
      hash = claimed;
      history.push({ revision: entry.revision, at: entry.at, event: entry.event, state });
    }
    // Patch chains are validated once at the end; every entry hash above is still checked.
    validateState(state);
    return {
      state,
      hash,
      bytes: Buffer.byteLength(text.slice(0, boundary)),
      tail: text.slice(boundary),
      lastSessionId,
      history,
    };
  }
  private read(file = this.file) {
    if (file === this.file) {
      const cached = this.cachedRead();
      if (cached) return cached;
      this.cache = undefined;
    }
    if (!existsSync(file)) {
      const result = {
        state: { ...emptyState(), ...(file === this.file ? { sessionId: this.sessionId } : {}) },
        hash: '',
        bytes: 0,
        tail: '',
        lastSessionId: undefined as string | undefined,
      };
      if (file === this.file) this.remember(result);
      return result;
    }
    if (statSync(file).size > 128 * 1024 * 1024)
      throw new Error('Goal journal exceeds 128 MiB; archive it before continuing');
    const decoded = this.decode(readFileSync(file, 'utf8'));
    const state = decoded.state;
    if (file === this.file) {
      if (state.sessionId !== undefined && state.sessionId !== this.sessionId)
        throw new Error('Goal journal belongs to another Pi session; refusing to load it');
      state.sessionId = this.sessionId;
    }
    // Project only the live snapshot into the current schema; historical bytes stay untouched.
    normalizeState(state);
    const result = {
      state,
      hash: decoded.hash,
      bytes: decoded.bytes,
      tail: decoded.tail,
      lastSessionId: decoded.lastSessionId,
    };
    if (file === this.file) this.remember(result);
    return result;
  }
  /** Import only the legacy journal's last owning session. The original remains intact. */
  migrateLegacy() {
    const legacy = join(this.legacyDirectory, 'state.jsonl');
    if (existsSync(this.file) || !existsSync(legacy)) return false;
    if (this.read(legacy).lastSessionId !== this.sessionId) return false;
    return this.locked(() => {
      const previous = this.read(legacy);
      if (previous.lastSessionId !== this.sessionId) return false;
      if (previous.state.owner && ownerAlive(previous.state.owner))
        throw new Error(
          'An older version still owns this session; close that Pi process before resuming',
        );
      return this.locked(() => {
        if (existsSync(this.file)) return false;
        const bytes = readFileSync(legacy);
        // A complete temporary copy is atomically installed; interruption never imports half a journal.
        const tmp = join(this.directory, `legacy-${this.token}.tmp`);
        const fd = openSync(tmp, 'wx', 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, this.file);
        this.cache = undefined;
        try {
          this.export(this.load());
        } catch (e) {
          this.exportError = String(e);
        }
        return true;
      });
    }, this.legacyDirectory);
  }
  load() {
    return structuredClone(this.read().state);
  }
  /** Reconstructed per-event snapshots for audits, tests and derived history views. */
  history() {
    if (!existsSync(this.file)) return [];
    if (statSync(this.file).size > 128 * 1024 * 1024)
      throw new Error('Goal journal exceeds 128 MiB; archive it before continuing');
    return this.decode(readFileSync(this.file, 'utf8')).history.map(
      ({ revision, at, event, state }) => ({
        revision,
        at,
        event,
        state: structuredClone(state),
      }),
    );
  }
  owns(s = this.load()) {
    return s.owner?.token === this.token;
  }
  private locked<T>(fn: () => T, directory = this.directory): T {
    mkdirSync(directory, { recursive: true });
    const rel = relative(realpathSync(this.cwd), realpathSync(directory));
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error('The goal state directory cannot symlink outside the project');
    const lock = join(directory, 'transaction.lock');
    try {
      mkdirSync(lock);
    } catch {
      throw new Error(
        'Goal journal is busy or has an interrupted transaction.lock; verify other Pi processes have stopped before removing the empty lock directory',
      );
    }
    try {
      return fn();
    } finally {
      rmdirSync(lock);
    }
  }
  private commit(event: string, change: (s: ProjectState) => void, requireOwner: boolean) {
    return this.locked(() => {
      const previous = this.read();
      const state = structuredClone(previous.state);
      if (requireOwner && !this.owns(state))
        throw new Error('Session ownership changed; read the goal state again');
      change(state);
      if (state.sessionId !== this.sessionId)
        throw new Error('Cannot write goals into another Pi session');
      state.revision++;
      validateState(state);
      const patch = diffState(previous.state, state);
      const stateText = JSON.stringify(state);
      // Periodic snapshots bound replay work after restart; sparse or large
      // changes are cheaper to store whole than as a long patch chain.
      const snapshot =
        previous.bytes === 0 ||
        state.revision % 25 === 0 ||
        patch.set.length + patch.unset.length > 500 ||
        JSON.stringify(patch).length * 2 >= stateText.length;
      const payload = {
        revision: state.revision,
        at: new Date().toISOString(),
        event,
        previous: previous.hash,
        ...(snapshot ? { state } : { patch }),
      };
      const hash = digest(payload);
      if (previous.tail) {
        writeFileSync(
          join(this.directory, `interrupted-${Date.now()}-${randomUUID()}.txt`),
          previous.tail,
          { flag: 'wx', mode: 0o600 },
        );
        truncateSync(this.file, previous.bytes);
      }
      const line = `${JSON.stringify({ ...payload, hash })}\n`;
      const fd = openSync(this.file, 'a', 0o600);
      try {
        appendFileSync(fd, line);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // The in-memory snapshot must match the journal even if the derived export fails.
      this.remember({
        state,
        hash,
        bytes: previous.bytes + Buffer.byteLength(line),
        tail: '',
        lastSessionId: state.owner?.sessionId ?? previous.lastSessionId,
      });
      try {
        this.export(state);
        this.exportError = undefined;
      } catch (e) {
        this.exportError = String(e);
      }
      return structuredClone(state);
    });
  }
  change(event: string, mutate: (s: ProjectState) => void) {
    return this.commit(event, mutate, true);
  }
  claim(expectedRevision?: number) {
    const token = randomUUID();
    const state = this.commit(
      'owner.claim',
      (s) => {
        if (expectedRevision !== undefined && s.revision !== expectedRevision)
          throw new Error('Goal state changed; read goal_status before creating a goal');
        if (s.owner && !this.owns(s)) {
          if (ownerAlive(s.owner))
            throw new Error(
              'This session is running in another Pi instance; wait for it to finish, or pause that instance before retrying',
            );
        }
        s.owner = {
          sessionId: this.sessionId,
          token,
          pid: process.pid,
          host: hostname(),
        };
        const g = activeGoal(s);
        if (g && isRunning(g)) {
          // The last persisted clock is a checkpoint, not proof the process was alive during downtime.
          delete g.clockAt;
          g.status = 'paused';
          g.resumeAfterInput = g.inputs.length;
          g.generation++;
          g.reason = 'State recovered after interruption; use /goal resume';
        }
        s.queuePaused = true;
      },
      false,
    );
    this.token = token;
    return state;
  }
  release() {
    if (!this.owns()) return;
    this.change('owner.release', (s) => {
      s.owner = null;
      s.queuePaused = true;
    });
  }
  private export(s: ProjectState) {
    const report = [
      '# Goal status and evidence',
      '',
      `Session: ${this.sessionId}`,
      '',
      `Revision: ${s.revision}; Queue: ${s.queuePaused ? 'paused' : 'running'}`,
      '',
    ];
    for (const g of s.goals) {
      report.push(
        `## ${g.id} · ${g.status}`,
        '',
        g.objective,
        '',
        `Next step: ${g.nextStep || 'Not recorded'}`,
        '',
        '### Acceptance criteria',
        '',
      );
      for (const c of g.criteria)
        report.push(`- ${c.id}: ${c.text}`, ...c.evidence.map((e) => `  - ${e}`));
      report.push(
        '',
        '### Tasks',
        '',
        ...g.tasks.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.id} ${t.text}`),
        '',
        '### Checks',
        '',
      );
      for (const c of g.checks)
        report.push(
          `- ${c.id}: ${c.command} — ${c.last ? `exit ${c.last.exitCode} @ ${c.last.at}` : 'Not run'}`,
        );
      report.push(
        '',
        '### Audit history',
        '',
        ...g.audits.map((a) => `- ${a.at} ${a.verdict} (${a.model}): ${a.details}`),
        '',
        `Usage: ${JSON.stringify(g.usage)}`,
        '',
        ...g.notes.map((n) => `- ${n}`),
        '',
      );
    }
    const tmp = join(this.directory, `STATUS-${this.token}.tmp`);
    writeFileSync(tmp, report.join('\n'), { mode: 0o600 });
    renameSync(tmp, join(this.directory, 'STATUS.md'));
  }
}
export function ownerAlive(owner: Owner) {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
