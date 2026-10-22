import { spawnSync } from 'node:child_process';
import { DEFAULT_VERIFICATION, sandboxArgs } from '../src/checks.ts';

function probe(environment) {
  if (process.platform !== 'linux') return false;
  try {
    const args = sandboxArgs(process.cwd(), environment, 'true');
    const result = spawnSync('bwrap', args, { stdio: 'ignore', timeout: 5_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Real sandbox tests require a kernel and bwrap build that can create and
 * configure an isolated network namespace. GitHub-hosted runners may deny
 * that even when bwrap is installed, so probe once and skip those tests
 * instead of reporting an implementation failure.
 */
export const sandboxAvailable = probe(DEFAULT_VERIFICATION);

/**
 * `ephemeral` workspaces additionally need bwrap's overlay support
 * (`--overlay-src` / `--tmp-overlay`). Older distro packages lack it.
 */
export const overlayAvailable =
  sandboxAvailable && probe({ workspace: 'ephemeral', network: 'isolated', env: [] });
