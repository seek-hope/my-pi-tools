import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxSettings, type SandboxSettings } from './verification/contract.ts';
import {
  DEFAULT_LIMITS,
  permissionDefaults,
  normalizeLimits,
  validatePermissionPolicy,
  type Goal,
  type Limits,
  type PermissionPolicy,
} from './state.ts';
export interface Settings {
  limits: Limits;
  audit: {
    provider?: string;
    model?: string;
    thinking?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  permissions: PermissionPolicy;
  sandbox?: SandboxSettings;
}
export const defaults: Settings = {
  limits: DEFAULT_LIMITS,
  audit: {},
  permissions: permissionDefaults(),
};
export function loadSettings(cwd: string, agentDir: string): Settings {
  let result = structuredClone(defaults);
  let permissions: Partial<PermissionPolicy> = {};
  for (const file of [join(agentDir, 'my-pi-goal.json'), join(cwd, '.pi', 'my-pi-goal.json')]) {
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`Invalid configuration: ${file}`);
    if (
      raw.permissions !== undefined &&
      (!raw.permissions || typeof raw.permissions !== 'object' || Array.isArray(raw.permissions))
    )
      throw new Error(`Invalid permissions configuration: ${file}`);
    if (raw.sandbox !== undefined && file !== join(agentDir, 'my-pi-goal.json'))
      throw new Error(
        'sandbox configuration is personal-only; project settings cannot select host executables or images',
      );
    const sandbox = raw.sandbox !== undefined ? sandboxSettings(raw.sandbox) : result.sandbox;
    permissions = { ...permissions, ...raw.permissions };
    result = {
      ...(sandbox ? { sandbox } : {}),
      limits: normalizeLimits({ ...result.limits, ...raw.limits }),
      audit: { ...result.audit, ...raw.audit },
      permissions: { ...permissionDefaults(permissions.mode), ...permissions },
    };
  }
  // Old configuration files remain loadable, but cannot re-enable removed audit caps.
  result.audit = Object.fromEntries(
    Object.entries(result.audit).filter(([key]) => ['provider', 'model', 'thinking'].includes(key)),
  );
  if (Boolean(result.audit.provider) !== Boolean(result.audit.model))
    throw new Error('audit.provider and audit.model must be set together');
  if (
    result.audit.thinking &&
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(result.audit.thinking)
  )
    throw new Error('Invalid audit.thinking');
  validatePermissionPolicy(result.permissions);
  return result;
}
export function effectivePermissions(settings: Settings, goal?: Goal): PermissionPolicy {
  return goal?.permissionPolicy ?? settings.permissions;
}
