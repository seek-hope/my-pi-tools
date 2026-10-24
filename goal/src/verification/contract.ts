import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export interface InputPolicy {
  /** Canonical project boundary for input overrides; required for content exceptions. */
  project?: string;
  /** Relative paths, with directories selecting their descendants. No globs or hooks. */
  include?: string[];
  exclude?: string[];
  /** Exact, operator-reviewed files exempted from default sensitive-file exclusions. */
  allowFiles?: string[];
  /** Exact files whose other hardlink names may be outside the selected input scope. */
  materializeHardlinks?: string[];
}

export function inputPolicy(value: unknown): InputPolicy {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('sandbox.inputs must be an object');
  const result: InputPolicy = {};
  for (const [key, paths] of Object.entries(value)) {
    if (key === 'project') {
      if (typeof paths !== 'string' || !isAbsolute(paths) || paths.includes('\u0000'))
        throw new Error('sandbox.inputs.project must be an absolute project path');
      result.project = paths;
      continue;
    }
    if (!['include', 'exclude', 'allowFiles', 'materializeHardlinks'].includes(key))
      throw new Error(`Unknown sandbox.inputs field: ${key}`);
    if (!Array.isArray(paths) || paths.length > 128 || (key === 'include' && !paths.length))
      throw new Error(`sandbox.inputs.${key} requires at most 128 paths (include cannot be empty)`);
    for (const path of paths) {
      if (
        typeof path !== 'string' ||
        path.length > 1024 ||
        /[\\\\\x00-\x1f:*?\[\]]/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error(`Invalid sandbox.inputs.${key} path: use a relative path without globs`);
    }
    result[key as Exclude<keyof InputPolicy, 'project'>] = [...new Set(paths)].sort();
  }
  if ((result.allowFiles?.length || result.materializeHardlinks?.length) && !result.project)
    throw new Error(
      'Input content exceptions require sandbox.inputs.project to bind the exact workspace',
    );
  return result;
}

/** Personal configuration only: project files cannot select a host executable or image archive. */
export interface SandboxSettings {
  backend: 'docker-sandboxes';
  executable: string;
  template: string;
  imageArchive: string;
  imageArchiveSha256: string;
  imageId: string;
  cpus: number;
  memoryMiB: number;
  pids: number;
  checkTimeoutMs: number;
  provisionTimeoutMs: number;
  cleanupTimeoutMs: number;
  outputBytes: number;
  snapshotBytes: number;
  snapshotFiles: number;
  inputs?: InputPolicy;
}

export function sandboxSettings(value: unknown): SandboxSettings | undefined {
  if (value === undefined) return undefined; // No profile means verification is unavailable; there is no fallback backend.
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('sandbox must be an object');
  const raw = value as Record<string, unknown>;
  const result: SandboxSettings = {
    backend: 'docker-sandboxes',
    executable: 'sbx',
    template: '',
    imageArchive: '',
    imageArchiveSha256: '',
    imageId: '',
    cpus: 2,
    memoryMiB: 4096,
    pids: 256,
    checkTimeoutMs: 120_000,
    provisionTimeoutMs: 300_000,
    cleanupTimeoutMs: 30_000,
    outputBytes: 24_000,
    snapshotBytes: 256 * 1024 * 1024,
    snapshotFiles: 20_000,
    ...raw,
  } as SandboxSettings;
  if (Object.keys(raw).some((k) => !(k in result) || !Object.hasOwn(DEFAULT_KEYS, k)))
    throw new Error('Unknown sandbox setting');
  if (result.backend !== 'docker-sandboxes')
    throw new Error('sandbox.backend must be docker-sandboxes');
  if (
    typeof result.executable !== 'string' ||
    (result.executable !== 'sbx' && !isAbsolute(result.executable))
  )
    throw new Error('sandbox.executable must be sbx or an absolute path');
  if (
    typeof result.template !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(result.template)
  )
    throw new Error('sandbox.template must be an OCI reference pinned by sha256 digest');
  if (typeof result.imageArchive !== 'string' || !isAbsolute(result.imageArchive))
    throw new Error(
      'sandbox.imageArchive must be an absolute path to a trusted Docker image archive',
    );
  if (
    !/^[a-f0-9]{64}$/.test(result.imageArchiveSha256) ||
    !/^sha256:[a-f0-9]{64}$/.test(result.imageId)
  )
    throw new Error('sandbox requires imageArchiveSha256 and an immutable imageId');
  const bounds = {
    cpus: [1, 32],
    memoryMiB: [512, 65536],
    pids: [16, 4096],
    checkTimeoutMs: [1000, 3600000],
    provisionTimeoutMs: [1000, 3600000],
    cleanupTimeoutMs: [1000, 120000],
    outputBytes: [1024, 1000000],
    snapshotBytes: [1024, 2147483648],
    snapshotFiles: [1, 100000],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = result[key as keyof SandboxSettings];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max)
      throw new Error(`Invalid sandbox.${key}: expected integer ${min}..${max}`);
  }
  if (raw.inputs !== undefined) result.inputs = inputPolicy(raw.inputs);
  return result;
}
const DEFAULT_KEYS = Object.fromEntries(
  [
    'backend',
    'executable',
    'template',
    'imageArchive',
    'imageArchiveSha256',
    'imageId',
    'cpus',
    'memoryMiB',
    'pids',
    'checkTimeoutMs',
    'provisionTimeoutMs',
    'cleanupTimeoutMs',
    'outputBytes',
    'snapshotBytes',
    'snapshotFiles',
    'inputs',
  ].map((k) => [k, true]),
);

export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface VerificationIdentity {
  backend: 'docker-sandboxes';
  attemptId: string;
  snapshotDigest: string;
  environmentDigest: string;
  specDigest: string;
}

export class SandboxError extends Error {
  readonly kind: 'environment' | 'cleanup' | 'input_changed' | 'check';
  constructor(message: string, kind: SandboxError['kind'] = 'environment') {
    super(message);
    this.kind = kind;
    this.name = 'SandboxError';
  }
}
