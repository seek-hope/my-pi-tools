import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check, CheckResult, Goal } from '../state.ts';
import type { VerificationEnvironment } from '../checks.ts';
import {
  digest,
  SandboxError,
  type SandboxSettings,
  type VerificationIdentity,
} from './contract.ts';
import { createSnapshot, type Snapshot } from './snapshot.ts';
import { DockerSandboxes } from './docker-sandboxes.ts';

export interface VerificationContext {
  cwd: string;
  identity: VerificationIdentity;
  manifest: Snapshot['manifest'];
  check(check: Check, signal?: AbortSignal): Promise<CheckResult>;
  /** Failure latch: an auditor cannot turn a failed rerun into a passing verification. */
  issue?: SandboxError;
  finish(requireCurrentInputs: boolean, signal?: AbortSignal): Promise<void>;
}

export async function prepareVerification(
  cwd: string,
  goal: Goal,
  settings: SandboxSettings,
  stateDirectory: string,
  signal?: AbortSignal,
  backend = new DockerSandboxes(settings, stateDirectory),
): Promise<VerificationContext> {
  const environment: VerificationEnvironment = structuredClone(goal.verification);
  try {
    backend.validateEnvironment(environment);
    await backend.doctor(signal);
  } catch (error) {
    throw error instanceof SandboxError ? error : new SandboxError(String(error));
  }
  const root = await mkdtemp(join(tmpdir(), 'goal-control-'));
  let snapshot: Snapshot | undefined;
  try {
    signal?.throwIfAborted();
    // Freeze the archive too: changes to the configured path cannot swap the image after validation.
    await copyFile(settings.imageArchive, join(root, 'image.tar'));
    const image = join(root, 'image.tar');
    const info = await stat(image);
    if (!info.isFile()) throw new SandboxError('Check image archive is not a regular file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(image, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== settings.imageArchiveSha256)
      throw new SandboxError('Check image archive digest mismatch');
    snapshot = await createSnapshot(cwd, settings, signal);
    const frozen = snapshot;
    const identity: VerificationIdentity = {
      backend: 'docker-sandboxes',
      attemptId: randomUUID(),
      snapshotDigest: snapshot.digest,
      environmentDigest: digest({ version: 1, settings, environment }),
      specDigest: digest({
        objective: goal.objective,
        kind: goal.kind,
        criteria: goal.criteria.map(({ id, text }) => ({ id, text })),
        tasks: goal.tasks.map(({ id, text }) => ({ id, text })),
        checks: goal.checks.map(({ id, command }) => ({ id, command })),
      }),
    };
    const approved = new Map(goal.checks.map((check) => [check.id, check.command]));
    let closed = false;
    const context: VerificationContext = {
      cwd: snapshot.root,
      identity,
      manifest: snapshot.manifest,
      async check(check, checkSignal) {
        if (closed) throw new SandboxError('Verification attempt is closed');
        if (approved.get(check.id) !== check.command)
          throw new SandboxError('Check is not in the frozen approved scope');
        try {
          const result = await backend.check(
            frozen,
            root,
            check,
            environment,
            identity,
            checkSignal,
          );
          if (result.exitCode !== 0) {
            const issue = new SandboxError(
              result.hint ?? `Independent check ${check.id} did not pass (exit ${result.exitCode})`,
              result.failure === 'environment' ? 'environment' : 'check',
            );
            if (!context.issue || (context.issue.kind === 'check' && issue.kind === 'environment'))
              context.issue = issue;
          }
          return result;
        } catch (error) {
          context.issue = error instanceof SandboxError ? error : new SandboxError(String(error));
          throw context.issue;
        }
      },
      async finish(requireCurrentInputs, finishSignal) {
        if (closed) return;
        closed = true;
        try {
          if (context.issue && (requireCurrentInputs || context.issue.kind !== 'check'))
            throw context.issue;
          if (requireCurrentInputs) {
            await frozen.assertUnchanged(finishSignal);
          }
        } finally {
          const cleanup = await Promise.allSettled([
            frozen.dispose(),
            rm(root, { recursive: true, force: true }),
          ]);
          if (cleanup.some((result) => result.status === 'rejected'))
            throw new SandboxError('Could not remove private verification inputs', 'cleanup');
        }
      },
    };
    return context;
  } catch (error) {
    await snapshot?.dispose();
    await rm(root, { recursive: true, force: true });
    throw error instanceof SandboxError ? error : new SandboxError(String(error));
  }
}
