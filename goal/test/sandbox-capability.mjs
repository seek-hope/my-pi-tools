import { spawnSync } from 'node:child_process';
import { DEFAULT_VERIFICATION, sandboxArgs } from '../src/checks.ts';

/**
 * Real sandbox tests require a kernel that lets bubblewrap create and
 * configure an isolated network namespace. GitHub-hosted runners may deny
 * that even when bwrap is installed, so probe once and skip those tests
 * instead of reporting an implementation failure.
 */
export const sandboxAvailable = (() => {
  if (process.platform !== 'linux') return false;
  try {
    const args = sandboxArgs(process.cwd(), DEFAULT_VERIFICATION, 'true');
    const result = spawnSync('bwrap', args, { stdio: 'ignore', timeout: 5_000 });
    return result.status === 0;
  } catch {
    return false;
  }
})();
