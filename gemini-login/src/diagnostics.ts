import { type Json } from './http.ts';

export const CONSUMER_DEPRECATION_URL =
  'https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals';
const REASONS: Record<string, string> = {
  DASHER_USER: 'Google Workspace account is not eligible for the individual tier',
  INELIGIBLE_ACCOUNT: 'Account is not eligible for this tier',
  NON_USER_ACCOUNT: 'A personal user sign-in is required',
  RESTRICTED_AGE: 'Google reports an age restriction',
  RESTRICTED_NETWORK: 'Google reports a network restriction',
  UNKNOWN_LOCATION: 'Google could not determine an eligible location',
  UNSUPPORTED_LOCATION: 'Google reports an unsupported location',
  VALIDATION_REQUIRED: 'Complete account verification in the official Gemini CLI',
  UNSUPPORTED_CLIENT: 'Google no longer supports this client',
};

/** Show diagnostic fields only, redacting known credentials before applying output limits. */
function diagnosticText(value: unknown, secrets: readonly string[], limit: number): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, encodeURIComponent(secret)]))
      text = text.split(form).join('[redacted]');
  }
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b((?:access_token|refresh_token|id_token|authorization_code|code_verifier|token)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;}]+/gi,
      '$1[redacted]',
    )
    .replace(/([?&](?:code|key)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function hasUnsupportedClient(loaded: Json): boolean {
  return (
    Array.isArray(loaded.ineligibleTiers) &&
    loaded.ineligibleTiers.some((tier: Json | null) => tier?.reasonCode === 'UNSUPPORTED_CLIENT')
  );
}

export function eligibilityFailure(loaded: Json, secrets: readonly string[]): string | undefined {
  if (!Array.isArray(loaded.ineligibleTiers) || !loaded.ineligibleTiers.length) return undefined;
  const reasons = loaded.ineligibleTiers.slice(0, 5).map((tier: Json | null) => {
    const rawCode = tier?.reasonCode;
    const code =
      typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
        ? diagnosticText(rawCode, secrets, 64)
        : 'UNRECOGNIZED_CODE';
    const message =
      diagnosticText(tier?.reasonMessage, secrets, 500) ||
      (Object.hasOwn(REASONS, code) ? REASONS[code] : 'Google did not provide a reason message');
    return `${code}: ${message}`;
  });
  const migration = hasUnsupportedClient(loaded)
    ? ` Google retired the consumer Gemini CLI / Code Assist entry (including Google AI Pro and Ultra) on 2026-06-18 and directs users to Antigravity: ${CONSUMER_DEPRECATION_URL}`
    : '';
  return `Google Code Assist eligibility: ${[...new Set(reasons)].join('; ')}${migration}`;
}
