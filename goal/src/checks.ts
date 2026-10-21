import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check, CheckResult } from './state.ts';

/**
 * Declared needs of an approved check. The workspace snapshot is always
 * isolated; `workspace` only decides whether the sandbox sees it read-only or
 * through an ephemeral writable overlay. Host network access and environment
 * variables are explicit rather than silently inherited.
 */
export interface VerificationEnvironment {
  workspace: 'readonly' | 'ephemeral';
  network: 'isolated' | 'host';
  /** Host environment variable names to pass by name; values are never recorded. */
  env: string[];
}
export const DEFAULT_VERIFICATION: VerificationEnvironment = {
  workspace: 'readonly',
  network: 'isolated',
  env: [],
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Host home paths that commonly hold credentials; masked inside the sandbox. */
const SENSITIVE_HOME_PATHS = [
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.gnupg',
  '.kube',
  '.docker',
  '.npmrc',
  '.netrc',
  '.pi',
] as const;
/** The sandbox itself could not start; this is never an implementation failure. */
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}
export function normalizeVerification(value: unknown): VerificationEnvironment {
  if (value === undefined || value === null) return { ...DEFAULT_VERIFICATION, env: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Verification environment must be an object');
  const raw = value as Partial<VerificationEnvironment>;
  const workspace = raw.workspace ?? DEFAULT_VERIFICATION.workspace;
  const network = raw.network ?? DEFAULT_VERIFICATION.network;
  const env = raw.env ?? [];
  if (!['readonly', 'ephemeral'].includes(workspace))
    throw new Error('verification.workspace must be readonly or ephemeral');
  if (!['isolated', 'host'].includes(network))
    throw new Error('verification.network must be isolated or host');
  if (!Array.isArray(env) || env.length > 32 || env.some((name) => !ENV_NAME.test(name)))
    throw new Error('verification.env must list at most 32 environment variable names');
  if (Object.keys(raw).some((key) => !['workspace', 'network', 'env'].includes(key)))
    throw new Error('Unknown verification environment field');
  return { workspace, network, env: [...new Set(env)] };
}
/** Order-insensitive identity used to freeze and compare a verification snapshot. */
export function verificationKey(environment: VerificationEnvironment): string {
  const value = normalizeVerification(environment);
  return JSON.stringify([value.workspace, value.network, [...value.env].sort()]);
}
export function verificationSummary(environment: VerificationEnvironment): string {
  const value = normalizeVerification(environment);
  return `workspace: ${value.workspace === 'readonly' ? 'read-only snapshot' : 'ephemeral writable snapshot'}; network: ${value.network === 'host' ? 'host network' : 'isolated network'}; environment variables: ${value.env.length ? value.env.join(', ') : 'none passed'}; host filesystem: read-only, with sensitive home paths masked`;
}

/**
 * Mask credential-bearing paths under the host home. The sandbox still binds
 * `/` read-only, so this is defense in depth, not a complete host view.
 */
export function sensitiveMaskArgs(home = homedir()): string[] {
  const args: string[] = [];
  for (const name of SENSITIVE_HOME_PATHS) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    try {
      const resolved = realpathSync(path);
      if (resolved === '/') continue;
      if (statSync(resolved).isDirectory()) args.push('--tmpfs', resolved);
      else args.push('--ro-bind', '/dev/null', resolved);
    } catch {
      // Unreadable or racing paths are left alone; masking is best-effort.
    }
  }
  return args;
}
/**
 * Classify a check failure that a different verification environment could
 * explain. This is a heuristic prompt to adjust the environment; it never
 * turns a failed check into a passing one.
 */
export function environmentSignature(
  output: string,
  environment: VerificationEnvironment,
  exitCode: number,
): string | undefined {
  const value = normalizeVerification(environment);
  if (
    value.network === 'isolated' &&
    /(could not resolve host|temporary failure in name resolution|name or service not known|network is unreachable|no route to host|connection refused|connection timed out|could not connect|failed to establish a new connection|enotfound|eai_again|proxy)/i.test(
      output,
    )
  )
    return 'The failure looks network-related while verification network is isolated. Use goal_environment with network "host" if this check needs a network or local service.';
  if (
    value.workspace === 'readonly' &&
    /(read-only file system|erofs|readonly file system)/i.test(output)
  )
    return 'The check tried to write inside its workspace while verification workspace is read-only. Use goal_environment with workspace "ephemeral" for builds or tests that create files, or redirect outputs to TMPDIR.';
  if (
    exitCode === 127 ||
    /(command not found|executable file not found in \$path|no such file or directory)/i.test(
      output,
    )
  )
    return 'A command or file needed by the check was not found in the verification sandbox. Install the dependency, or pass the required environment variables (toolchain, cache or home paths) with goal_environment.';
  return undefined;
}
/** Pure bubblewrap composition, so the environment contract is enumerable. */
export function sandboxArgs(
  cwd: string,
  environment: VerificationEnvironment,
  command: string,
  home = homedir(),
): string[] {
  const value = normalizeVerification(environment);
  const root = realpathSync(cwd);
  const args = [
    '--die-with-parent',
    '--unshare-all',
    ...(value.network === 'host' ? ['--share-net'] : []),
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/run',
    ...sensitiveMaskArgs(home),
  ];
  if (value.workspace === 'ephemeral') args.push('--overlay-src', root, '--tmp-overlay', root);
  else args.push('--ro-bind', root, root);
  args.push('--chdir', root, '--', '/bin/bash', '--noprofile', '--norc', '-c', command);
  return args;
}
function childEnvironment(environment: VerificationEnvironment): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: '/tmp',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    CI: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const name of environment.env)
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
/**
 * Checks run against the workspace snapshot with only the declared environment
 * capabilities. Missing isolation fails closed; the host workspace is never
 * writable, including in ephemeral mode, because writes use a temporary overlay.
 */
export async function runCheck(
  cwd: string,
  check: Check,
  signal?: AbortSignal,
  environment: VerificationEnvironment = DEFAULT_VERIFICATION,
): Promise<CheckResult> {
  const declared = normalizeVerification(environment);
  if (process.platform !== 'linux')
    throw new EnvironmentError(
      'Read-only checks require Linux bubblewrap; unsandboxed checks will not run on this platform',
    );
  signal?.throwIfAborted();
  const args = sandboxArgs(cwd, declared, check.command);
  return await new Promise((resolve, reject) => {
    const child = spawn('bwrap', args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnvironment(declared),
    });
    let output = '';
    const capture = (data: Buffer) => {
      output = (output + data.toString()).slice(-24_000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const cleanup = () => signal?.removeEventListener('abort', kill);
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    child.on('error', (e) => {
      cleanup();
      reject(
        new EnvironmentError(
          `Cannot start a verification check; install or enable bubblewrap: ${e.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) {
        reject(new Error('Check cancelled'));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && /^bwrap: /m.test(output)) {
        reject(new EnvironmentError(`The verification sandbox could not start: ${output.trim()}`));
        return;
      }
      const hint = environmentSignature(output, declared, exitCode);
      resolve({
        at: new Date().toISOString(),
        command: check.command,
        exitCode,
        output,
        environmentKey: verificationKey(declared),
        ...(hint ? { failure: 'environment' as const, hint } : {}),
      });
    });
  });
}
/** Validate that the declared environment can start the sandbox before applying it. */
export async function probeEnvironment(
  cwd: string,
  environment: VerificationEnvironment,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; hint: string }> {
  try {
    const result = await runCheck(
      cwd,
      { id: 'environment-probe', command: 'true' },
      signal,
      environment,
    );
    if (result.exitCode !== 0)
      return { ok: false, hint: result.hint ?? (result.output.trim() || 'probe failed') };
    return { ok: true };
  } catch (error) {
    return { ok: false, hint: String(error) };
  }
}
