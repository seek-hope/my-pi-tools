import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import {
  BASE_URL,
  TOKEN_URL,
  GeminiError,
  object,
  postJson,
  readJson,
  requiredString,
  type Fetch,
  type Json,
} from './http.ts';

// Public installed-application identifiers from the Apache-2.0 Google Gemini CLI. See NOTICE.
const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
export const REDIRECT_URI = 'https://codeassist.google.com/authcode';
const SCOPES = ['cloud-platform', 'userinfo.email', 'userinfo.profile']
  .map((scope) => `https://www.googleapis.com/auth/${scope}`)
  .join(' ');
const METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
};

export interface AuthDependencies {
  fetch?: Fetch;
  projectId?: string;
  pollMs?: number;
}

async function exchange(
  fetch: Fetch,
  fields: Record<string, string>,
  signal: AbortSignal,
  previous?: OAuthCredential,
): Promise<OAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }),
  });
  // Token endpoint bodies can contain secrets. Never put them into an error or a progress message.
  if (!response.ok) {
    await response.body?.cancel();
    throw new GeminiError(
      `Google token exchange failed (HTTP ${response.status}); retry /login gemini-login`,
    );
  }
  const data = await readJson(response);
  if (
    typeof data.expires_in !== 'number' ||
    !Number.isSafeInteger(Date.now() + data.expires_in * 1000) ||
    data.expires_in <= 0
  )
    throw new GeminiError('Google returned an invalid token lifetime');
  return {
    ...previous,
    type: 'oauth',
    access: requiredString(data.access_token, 'access token'),
    refresh: requiredString(
      data.refresh_token ?? previous?.refresh,
      'refresh token; retry login and grant offline access',
    ),
    expires: Date.now() + Math.max(0, data.expires_in * 1000 - 60_000),
  };
}

function authorizationCode(input: string, state: string): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.origin + url.pathname !== REDIRECT_URI || url.searchParams.get('state') !== state)
      throw new GeminiError('Authorization URL or state does not match this login');
    return requiredString(url.searchParams.get('code'), 'authorization code');
  }
  if (value.length > 8192 || /\s/.test(value)) throw new GeminiError('Invalid authorization code');
  return requiredString(value, 'authorization code');
}

const ELIGIBILITY_REASONS: Record<string, string> = {
  DASHER_USER: 'Google Workspace account is not eligible for the individual tier',
  INELIGIBLE_ACCOUNT: 'Account is not eligible for this tier',
  NON_USER_ACCOUNT: 'A personal user sign-in is required',
  RESTRICTED_AGE: 'Google reports an age restriction',
  RESTRICTED_NETWORK: 'Google reports a network restriction',
  UNKNOWN_LOCATION: 'Google could not determine an eligible location',
  UNSUPPORTED_LOCATION: 'Google reports an unsupported location',
  VALIDATION_REQUIRED: 'Complete account verification in the official Gemini CLI and retry login',
  UNKNOWN: 'Google did not provide a recognized eligibility reason',
};

function eligibilityFailure(loaded: Json): string | undefined {
  if (!Array.isArray(loaded.ineligibleTiers) || !loaded.ineligibleTiers.length) return undefined;
  // Only render known reason codes. Raw server messages can contain account data or credentials.
  const reasons = loaded.ineligibleTiers.map((tier: Json | null) => {
    const code =
      typeof tier?.reasonCode === 'string' && Object.hasOwn(ELIGIBILITY_REASONS, tier.reasonCode)
        ? tier.reasonCode
        : 'UNKNOWN';
    return `${code}: ${ELIGIBILITY_REASONS[code]}`;
  });
  return `Google Code Assist eligibility: ${[...new Set(reasons)].join('; ')}`;
}

function resolvedProject(value: unknown, loaded: Json): string {
  if (typeof value === 'string' && value.trim())
    return requiredString(value, 'Code Assist project');
  throw new GeminiError(
    eligibilityFailure(loaded) ??
      'Google did not return a Code Assist project. If this account requires a user-managed project, set GEMINI_LOGIN_PROJECT and log in again',
  );
}

export async function setupProject(
  token: string,
  dependencies: AuthDependencies,
  signal: AbortSignal,
): Promise<{ projectId: string; tier?: string }> {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const project = dependencies.projectId?.trim() || undefined;
  if (project && (/^\d+$/.test(project) || /[\r\n\0]/.test(project)))
    throw new GeminiError('GEMINI_LOGIN_PROJECT must be a project ID, not a project number');
  const metadata = { ...METADATA, ...(project ? { duetProject: project } : {}) };
  const loaded = await postJson(
    fetch,
    `${BASE_URL}:loadCodeAssist`,
    { metadata, ...(project ? { cloudaicompanionProject: project } : {}) },
    token,
    signal,
  );
  if (loaded.currentTier) {
    return {
      projectId: resolvedProject(loaded.cloudaicompanionProject || project, loaded),
      tier: loaded.paidTier?.id ?? loaded.currentTier.id,
    };
  }
  if (
    Array.isArray(loaded.ineligibleTiers) &&
    loaded.ineligibleTiers.some((tier: Json) => tier.reasonCode === 'VALIDATION_REQUIRED')
  )
    throw new GeminiError(
      'Google account verification is required; complete it in the official Gemini CLI and retry login',
    );
  // Match Gemini CLI setupUser: use the offered default or its legacy fallback.
  // The userDefinedCloudaicompanionProject hint must not prevent onboarding:
  // Google may still return a managed project from onboardUser.
  const tier = (Array.isArray(loaded.allowedTiers) ? loaded.allowedTiers : []).find(
    (tier: Json) => tier?.isDefault,
  ) ?? { id: 'legacy-tier' };
  requiredString(tier.id, 'default Code Assist tier');
  let operation: Json;
  try {
    operation = await postJson(
      fetch,
      `${BASE_URL}:onboardUser`,
      {
        tierId: tier.id,
        metadata: tier.id === 'free-tier' ? METADATA : metadata,
        ...(tier.id !== 'free-tier' && project ? { cloudaicompanionProject: project } : {}),
      },
      token,
      signal,
    );
  } catch (error) {
    const eligibility = eligibilityFailure(loaded);
    if (error instanceof GeminiError && eligibility && !signal.aborted)
      throw new GeminiError(`${error.message}. ${eligibility}`);
    throw error;
  }
  while (!operation.done) {
    const name = requiredString(operation.name, 'onboarding operation');
    if (!/^(?:[a-zA-Z0-9_-]+\/)*operations\/[a-zA-Z0-9_.~=-]+$/.test(name))
      throw new GeminiError('Google returned an invalid onboarding operation');
    await delay(dependencies.pollMs ?? 1000, undefined, { signal });
    const response = await fetch(`${BASE_URL}/${name}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GeminiError(`Google onboarding failed (HTTP ${response.status})`);
    }
    operation = await readJson(response);
  }
  if (operation.error)
    throw new GeminiError(
      `Google Code Assist onboarding failed. ${eligibilityFailure(loaded) ?? ''}`.trim(),
    );
  return {
    projectId: resolvedProject(operation.response?.cloudaicompanionProject?.id || project, loaded),
    tier: tier.id,
  };
}

export function createOAuth(dependencies: AuthDependencies = {}): OAuthAuth {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  return {
    name: 'Google Gemini subscription',
    isSubscription: true,
    loginLabel: 'Sign in with Google (AI Pro / Ultra)',
    async login(interaction: ProviderAuthInteraction) {
      const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(300_000)]);
      try {
        signal.throwIfAborted();
        const verifier = randomBytes(32).toString('base64url');
        const state = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({
          client_id: CLIENT_ID,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          scope: SCOPES,
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString();
        interaction.notify({
          type: 'auth_url',
          url: url.toString(),
          instructions:
            'Sign in with the Google account holding your subscription, then paste the code shown by Google.',
        });
        const input = await interaction.prompt({
          type: 'manual_code',
          message: 'Paste the Google authorization code:',
          placeholder: 'Authorization code',
          signal,
        });
        signal.throwIfAborted();
        const credential = await exchange(
          fetch,
          {
            grant_type: 'authorization_code',
            code: authorizationCode(input, state),
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
          },
          signal,
        );
        interaction.notify({ type: 'progress', message: 'Checking Google Code Assist access…' });
        const account = await setupProject(credential.access, { ...dependencies, fetch }, signal);
        signal.throwIfAborted();
        return { ...credential, ...account };
      } catch (error) {
        if (signal.aborted) throw new GeminiError('Gemini login cancelled or timed out');
        if (error instanceof GeminiError) throw error;
        throw new GeminiError('Gemini login failed; check network connectivity and retry');
      }
    },
    async refresh(credential, callerSignal) {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]);
      try {
        signal.throwIfAborted();
        return await exchange(
          fetch,
          {
            grant_type: 'refresh_token',
            refresh_token: requiredString(credential.refresh, 'refresh token'),
          },
          signal,
          credential,
        );
      } catch (error) {
        if (signal.aborted) throw new GeminiError('Gemini token refresh cancelled or timed out');
        if (error instanceof GeminiError) throw error;
        throw new GeminiError('Gemini token refresh failed; check network connectivity and retry');
      }
    },
    async toAuth(credential) {
      return {
        apiKey: JSON.stringify({
          access: requiredString(credential.access, 'access token'),
          projectId: requiredString(credential.projectId, 'Code Assist project; log in again'),
        }),
      };
    },
  };
}

export function requestCredential(apiKey?: string): { access: string; projectId: string } {
  try {
    const value = object(JSON.parse(apiKey ?? ''));
    return {
      access: requiredString(value.access, 'access token'),
      projectId: requiredString(value.projectId, 'Code Assist project'),
    };
  } catch {
    throw new GeminiError('Sign in with /login gemini-login before using this provider');
  }
}
