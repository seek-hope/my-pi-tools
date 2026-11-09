export const BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export type Fetch = typeof globalThis.fetch;
export type Json = Record<string, any>;

export class GeminiError extends Error {}

export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GeminiError('Google returned an invalid response object');
  return value as Json;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value))
    throw new GeminiError(`Missing or invalid ${label}`);
  return value;
}

export function apiError(status: number, data?: unknown): GeminiError {
  const error = data && typeof data === 'object' ? (data as Json).error : undefined;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (
    status === 400 &&
    /(?:input|context|prompt).*(?:token|length).*(?:exceed|limit|maximum)|(?:token|context).*exceed/i.test(
      message,
    )
  )
    return new GeminiError(
      'context_length_exceeded: Gemini input exceeds the model context window',
    );
  const hints: Record<number, string> = {
    401: 'Sign in again with /login gemini-login',
    403: 'Check account eligibility, subscription and Code Assist project permissions',
    404: 'The selected model or Code Assist resource is unavailable for this account',
    429: 'Gemini subscription quota or rate limit reached; retry later',
  };
  return new GeminiError(
    `Google Code Assist HTTP ${status}. ${hints[status] ?? 'The request failed'}`,
  );
}

export async function readJson(response: Response): Promise<Json> {
  if (!response.body) throw new GeminiError('Google returned an empty response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '',
    bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) throw new GeminiError('Google response exceeded the size limit');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return object(JSON.parse(text));
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    throw new GeminiError('Google returned malformed JSON');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function postJson(
  fetch: Fetch,
  url: string,
  body: unknown,
  token: string,
  signal: AbortSignal,
): Promise<Json> {
  signal.throwIfAborted();
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) throw apiError(response.status, data);
  return data;
}

/** Only complete SSE events are decoded; JSON and UTF-8 failures never become successful answers. */
export async function* sse(response: Response, signal?: AbortSignal): AsyncGenerator<Json> {
  if (!response.body) throw new GeminiError('Google returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    data: string[] = [],
    size = 0;
  const parse = () => {
    const text = data.join('\n');
    data = [];
    size = 0;
    if (!text || text === '[DONE]') return undefined;
    try {
      return object(JSON.parse(text));
    } catch {
      throw new GeminiError('Google returned a malformed stream event');
    }
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line === '') {
          const event = parse();
          if (event) yield event;
        } else if (line.startsWith('data:')) {
          const part = line.slice(5).replace(/^ /, '');
          size += part.length;
          if (size > 2_097_152)
            throw new GeminiError('Google stream event exceeded the size limit');
          data.push(part);
        }
      }
      if (buffer.length > 2_097_152)
        throw new GeminiError('Google stream line exceeded the size limit');
      if (done) {
        if (buffer.trim() || data.length)
          throw new GeminiError('Google stream ended with an incomplete event');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
