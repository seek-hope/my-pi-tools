import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { PermissionPolicy } from './state.ts';
export function permissionKey(name: string, input: unknown) {
  return createHash('sha256').update(JSON.stringify({ name, input })).digest('hex');
}
export function permissionSummary(policy: PermissionPolicy) {
  return `Execution policy: ${policy.mode === 'autonomous' ? 'autonomous (no per-tool Goal approval)' : 'confirm (additional tool approval)'}; network: ${policy.network === 'allow' ? 'allowed' : 'approval required'}; dependency installation: ${policy.install === 'allow' ? 'allowed' : 'approval required'}. Work only within the approved scope; Pi and other extensions retain their permission checks.`;
}
export function within(cwd: string, path: string) {
  let parent = resolve(cwd, path);
  const tail: string[] = [];
  while (!existsSync(parent)) {
    const up = dirname(parent);
    if (up === parent) return false;
    tail.unshift(relative(up, parent));
    parent = up;
  }
  const actual = resolve(realpathSync(parent), ...tail),
    rel = relative(realpathSync(cwd), actual);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
/** Optional cooperative checks. The autonomous profile delegates scope to the agent and host. */
export function permissionReason(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  policy: PermissionPolicy,
): string | undefined {
  if (name.startsWith('goal_')) return undefined;
  if (['codemode', 'tool_search'].includes(name)) return undefined; // nested calls still receive tool_call
  if (['read', 'grep', 'find', 'ls'].includes(name)) return undefined;
  const command = name === 'bash' ? String(input.command ?? '') : '';
  // Explicit per-action settings remain effective even in autonomous mode, including old configs.
  if (
    policy.install === 'ask' &&
    /\b(?:npm|pnpm|yarn|pip|pip3|uv|conda|apt|dnf|brew)\b.*\b(?:install|add|sync|update|upgrade)\b|\bnpx\b/.test(
      command,
    )
  )
    return 'Install or update dependencies';
  if (
    policy.network === 'ask' &&
    /\b(?:curl|wget|git\s+(?:clone|fetch|pull))\b|https?:\/\//.test(command)
  )
    return 'Access an external network';
  if (policy.mode === 'autonomous') return undefined;

  if (['edit', 'write'].includes(name)) {
    const path = String(input.path ?? '');
    if (!within(cwd, path)) return 'Write files outside the project';
    if (resolve(cwd, path).includes('/.pi/my-pi-goal'))
      return 'Modify goal controller state or configuration';
    return undefined;
  }
  if (name !== 'bash') return 'Call an external or extension tool';
  if (
    /(?:^|[\s;&|])(rm|rmdir|sudo|su|ssh|scp|rsync|docker|kubectl|terraform|mkfs|dd|shred|truncate)\b|git\s+(?:[^;&|]*\s)?(?:commit|push|reset|clean)\b|\b(?:drop\s+(?:table|database)|delete\s+from)\b|\b(?:npm|pnpm|yarn)\s+publish\b|\b(?:deploy|release)\b/i.test(
      command,
    )
  )
    return 'Commit, publish, remote or potentially destructive command';
  return undefined;
}
