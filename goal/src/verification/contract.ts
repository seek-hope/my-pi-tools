import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

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
