export interface VerificationEnvironment {
  workspace: 'readonly' | 'ephemeral';
  network: 'isolated' | 'allowlist' | 'open';
  allow?: string[];
  deny?: string[];
  env: string[];
  /** Explicit non-secret values; never inherited from the host environment. */
  variables?: Record<string, string>;
}
export const DEFAULT_VERIFICATION: VerificationEnvironment = {
  workspace: 'ephemeral',
  network: 'isolated',
  env: [],
};
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function verificationVariables(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32)
    throw new Error('verification.variables must contain at most 32 explicit non-secret values');
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  let bytes = 0;
  for (const [name, text] of entries) {
    const upper = name.toUpperCase();
    if (
      !ENV_NAME.test(name) ||
      name.length > 128 ||
      /^(PATH|HOME|TMPDIR|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NPM_CONFIG_CAFILE)$/.test(
        upper,
      ) ||
      /PROXY|(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|PRIVATE_KEY|ACCESS_KEY)(_|$)|^LD_/.test(
        upper,
      )
    )
      throw new Error(`verification.variables cannot set reserved or credential variable ${name}`);
    if (typeof text !== 'string' || text.includes('\u0000') || Buffer.byteLength(text) > 4096)
      throw new Error(`Invalid explicit environment value for ${name}`);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(text);
  }
  if (bytes > 16384) throw new Error('Explicit environment values exceed 16 KiB');
  return Object.fromEntries(entries) as Record<string, string>;
}
/** Exact DNS names, optional wildcard subdomains, and optional TCP ports. No URLs or raw IPs. */
export function destinations(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error('verification destinations must contain at most 64 entries');
  return [
    ...new Set(
      value.map((entry) => {
        if (typeof entry !== 'string') throw new Error('Invalid verification destination');
        const host = entry.toLowerCase();
        const match =
          /^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::([0-9]{1,5}))?$/.exec(
            host,
          );
        if (
          !match ||
          match[2].length > 253 ||
          match[2].split('.').some((x) => x.length > 63) ||
          /^\d+(\.\d+){3}$/.test(match[2]) ||
          (match[3] && (+match[3] < 1 || +match[3] > 65535))
        )
          throw new Error(
            'Invalid verification destination: use a DNS name, optional *. prefix and :port',
          );
        return host;
      }),
    ),
  ].sort();
}
export function normalizeVerification(value: unknown): VerificationEnvironment {
  // Historical goals without an environment retain the original read-only default.
  if (value === undefined || value === null)
    return { ...DEFAULT_VERIFICATION, workspace: 'readonly', env: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Verification environment must be an object');
  const raw = value as Record<string, unknown>;
  const workspace = raw.workspace ?? 'readonly';
  // An old host-network grant cannot silently become a new open-egress grant.
  const network = raw.network === 'host' ? 'isolated' : (raw.network ?? 'isolated');
  if (workspace !== 'readonly' && workspace !== 'ephemeral')
    throw new Error('verification.workspace must be readonly or ephemeral');
  if (network !== 'isolated' && network !== 'allowlist' && network !== 'open')
    throw new Error('verification.network must be isolated, allowlist or open');
  const env = raw.env ?? [];
  if (
    !Array.isArray(env) ||
    env.length > 32 ||
    env.some((name) => typeof name !== 'string' || !ENV_NAME.test(name))
  )
    throw new Error('verification.env must list at most 32 environment variable names');
  if (
    Object.keys(raw).some(
      (key) => !['workspace', 'network', 'allow', 'deny', 'env', 'variables'].includes(key),
    )
  )
    throw new Error('Unknown verification environment field');
  const allow = destinations(raw.allow ?? []),
    deny = destinations(raw.deny ?? []);
  if (network === 'allowlist' && !allow.length)
    throw new Error('verification.allowlist requires at least one allowed destination');
  const variables = verificationVariables(raw.variables);
  return {
    workspace,
    network,
    env: [...new Set(env)],
    ...(Object.keys(variables).length ? { variables } : {}),
    ...(allow.length ? { allow } : {}),
    ...(deny.length ? { deny } : {}),
  };
}
export function verificationKey(environment: VerificationEnvironment): string {
  const value = normalizeVerification(environment);
  return JSON.stringify([
    value.workspace,
    value.network,
    value.allow ?? [],
    value.deny ?? [],
    [...value.env].sort(),
    value.variables ?? {},
  ]);
}
export function verificationSummary(environment: VerificationEnvironment): string {
  const value = normalizeVerification(environment);
  return `workspace: ${value.workspace === 'readonly' ? 'read-only snapshot' : 'ephemeral writable snapshot'}; network: ${value.network === 'isolated' ? 'isolated network' : value.network + ' via HTTP/HTTPS proxy'}; allow: ${(value.allow ?? []).join(', ') || 'none'}; deny: ${(value.deny ?? []).join(', ') || 'none'}; host environment: ${value.env.length ? 'unsupported forwarding requested' : 'not inherited'}; explicit non-secret variables: ${Object.keys(value.variables ?? {}).join(', ') || 'none'}; host filesystem: not mounted`;
}
export function environmentSignature(
  output: string,
  environment: VerificationEnvironment,
  exitCode: number,
): string | undefined {
  if (
    environment.network !== 'open' &&
    /(could not resolve host|network is unreachable|enotfound|eai_again|proxy denied|403 forbidden|connection refused)/i.test(
      output,
    )
  )
    return 'The check may need network access. Use goal_environment with network "allowlist" and the required DNS destinations. HTTP(S) clients must honor HTTP_PROXY/HTTPS_PROXY.';
  if (
    environment.workspace === 'readonly' &&
    /(read-only file system|erofs|readonly file system)/i.test(output)
  )
    return 'Use goal_environment with workspace "ephemeral" for builds or tests that create files.';
  if (
    exitCode === 127 ||
    /(command not found|executable file not found|no such file or directory)/i.test(output)
  )
    return 'A command or file needed by the check was not found. Include it in the pinned verification image or source inputs.';
  return undefined;
}
