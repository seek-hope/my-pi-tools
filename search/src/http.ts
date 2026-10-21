/**
 * HTTP transport for the DeepSeek Search & Fetch API.
 *
 * Responsibilities:
 * - per-attempt timeout, linked to the caller's AbortSignal
 * - bounded response bodies (no unbounded `res.text()`)
 * - retries with exponential backoff, jitter and `Retry-After`
 * - a single normalized error type for every failure mode
 */

import { WebToolError } from "./errors.ts";

export type FetchLike = typeof fetch;

export interface HttpClientOptions {
	timeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
	maxResponseBytes: number;
	userAgent: string;
	fetchImpl?: FetchLike;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	debug?: (message: string, meta?: Record<string, unknown>) => void;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		timer.unref?.();
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new DOMException("aborted", "AbortError"));
		};
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface LinkedSignal {
	signal: AbortSignal;
	timedOut: () => boolean;
	cleanup: () => void;
}

function linkSignals(external: AbortSignal | undefined, timeoutMs: number): LinkedSignal {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timer.unref?.();

	const onAbort = () => controller.abort(external?.reason);
	if (external) {
		if (external.aborted) controller.abort(external.reason);
		else external.addEventListener("abort", onAbort, { once: true });
	}

	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cleanup: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", onAbort);
		},
	};
}

/** Parse `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - now);
}

/** Sleep between attempts, normalizing cancellation into a typed error. */
async function pause(
	delayMs: number,
	signal: AbortSignal | undefined,
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
	if (signal?.aborted) {
		throw new WebToolError("aborted", "request was cancelled", {
			cause: new DOMException("aborted", "AbortError"),
		});
	}
	try {
		await sleep(delayMs, signal);
	} catch (error) {
		if (signal?.aborted) {
			throw new WebToolError("aborted", "request was cancelled", { cause: error });
		}
		throw new WebToolError("network", "retry wait was interrupted", { cause: error });
	}
}

/** Exponential backoff with jitter, honoring a server-provided delay. */
export function computeRetryDelay(
	attempt: number,
	retryAfterMs: number | null,
	baseDelayMs: number,
	maxDelayMs: number,
	random: () => number = Math.random,
): number {
	const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
	const jitter = Math.floor(random() * Math.min(250, Math.max(1, exponential * 0.2)));
	if (retryAfterMs !== null) {
		return Math.min(maxDelayMs, Math.max(0, retryAfterMs)) + jitter;
	}
	return Math.min(maxDelayMs, exponential + jitter);
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new WebToolError("invalid_response", `DeepSeek response exceeded ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

interface ParsedErrorBody {
	message: string;
	code: string | undefined;
}

export function parseErrorBody(bodyText: string): ParsedErrorBody {
	const trimmed = bodyText.trim();
	if (!trimmed) return { message: "empty response body", code: undefined };
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			const nested = record.error;
			if (nested && typeof nested === "object") {
				const error = nested as Record<string, unknown>;
				const message = typeof error.message === "string" ? error.message : undefined;
				const codeValue = error.code ?? error.type;
				const code = typeof codeValue === "string" ? codeValue : undefined;
				if (message) return { message, code };
			}
			if (typeof record.message === "string") {
				const code = typeof record.code === "string" ? record.code : undefined;
				return { message: record.message, code };
			}
		}
	} catch {
		// Fall through to the raw body.
	}
	return { message: trimmed.slice(0, 300), code: undefined };
}

export function classifyHttpError(status: number, bodyText: string): WebToolError {
	const { message, code } = parseErrorBody(bodyText);
	const suffix = code ? ` (${code})` : "";
	if (status === 401 || status === 403) {
		return new WebToolError("auth", `DeepSeek rejected the credentials${suffix}: ${message}`, {
			status,
			hint: "Check DEEPSEEK_API_KEY, or run /login deepseek in Pi and retry.",
		});
	}
	if (status === 429) {
		return new WebToolError("rate_limit", `DeepSeek rate limit reached${suffix}: ${message}`, {
			status,
			retryable: true,
			hint: "Wait a moment, then retry with a narrower query.",
		});
	}
	if (status === 408) {
		return new WebToolError("timeout", `DeepSeek timed out${suffix}: ${message}`, {
			status,
			retryable: true,
		});
	}
	if (status >= 500) {
		return new WebToolError("http", `DeepSeek server error ${status}${suffix}: ${message}`, {
			status,
			retryable: true,
			hint: "This is usually transient; retrying once is reasonable.",
		});
	}
	if (status === 400 || status === 404 || status === 413 || status === 422) {
		return new WebToolError("invalid_input", `DeepSeek rejected the request${suffix}: ${message}`, { status });
	}
	return new WebToolError("http", `DeepSeek returned HTTP ${status}${suffix}: ${message}`, { status });
}

function debugLog(
	options: HttpClientOptions,
	message: string,
	meta?: Record<string, unknown>,
): void {
	options.debug?.(message, meta);
}

export interface PostJsonOptions extends HttpClientOptions {
	apiKey: string;
}

/**
 * POST a JSON body and decode a JSON response. Retries only retryable errors;
 * aborts and caller cancellation are never retried.
 */
export async function postJson<T>(
	url: string,
	body: unknown,
	options: PostJsonOptions,
	signal?: AbortSignal,
): Promise<T> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const payload = JSON.stringify(body);
	let lastError: WebToolError | undefined;

	for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
		if (signal?.aborted) {
			throw new WebToolError("aborted", "request was cancelled", {
				cause: new DOMException("aborted", "AbortError"),
			});
		}

		const linked = linkSignals(signal, options.timeoutMs);
		const startedAt = Date.now();
		try {
			const response = await fetchImpl(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					authorization: `Bearer ${options.apiKey}`,
					"user-agent": options.userAgent,
				},
				body: payload,
				signal: linked.signal,
				// The API never redirects; following one could be used to reach
				// an otherwise blocked destination.
				redirect: "manual",
			});

			debugLog(options, "response", {
				url,
				status: response.status,
				attempt,
				durationMs: Date.now() - startedAt,
			});

			if (response.status >= 300 && response.status < 400) {
				throw new WebToolError("http", `unexpected redirect (HTTP ${response.status})`, {
					status: response.status,
				});
			}

			const raw = await readLimited(response, options.maxResponseBytes);
			if (!response.ok) {
				const error = classifyHttpError(response.status, raw);
				const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
				if (!error.retryable || attempt >= options.maxRetries) throw error;
				lastError = error;
				const delay = computeRetryDelay(attempt, retryAfter, options.retryBaseDelayMs, options.retryMaxDelayMs);
				debugLog(options, "retry", {
					url,
					status: response.status,
					attempt,
					delayMs: delay,
					retryAfterMs: retryAfter,
				});
				await pause(delay, signal, sleep);
				continue;
			}

			try {
				return JSON.parse(raw) as T;
			} catch (error) {
				throw new WebToolError("invalid_response", "DeepSeek returned malformed JSON", { cause: error });
			}
		} catch (error) {
			if (signal?.aborted) {
				throw new WebToolError("aborted", "request was cancelled", { cause: error });
			}
			if (error instanceof WebToolError && !error.retryable) throw error;
			if (linked.timedOut()) {
				const timeoutError = new WebToolError(
					"timeout",
					`DeepSeek did not respond within ${options.timeoutMs} ms`,
					{ retryable: true, cause: error },
				);
				if (attempt >= options.maxRetries) throw timeoutError;
				lastError = timeoutError;
				const delay = computeRetryDelay(attempt, null, options.retryBaseDelayMs, options.retryMaxDelayMs);
				debugLog(options, "retry-timeout", { url, attempt, delayMs: delay });
				await pause(delay, signal, sleep);
				continue;
			}
			if (error instanceof WebToolError) {
				if (attempt >= options.maxRetries) throw error;
				lastError = error;
				const delay = computeRetryDelay(attempt, null, options.retryBaseDelayMs, options.retryMaxDelayMs);
				debugLog(options, "retry-error", { url, attempt, delayMs: delay, kind: error.kind });
				await pause(delay, signal, sleep);
				continue;
			}

			const message = error instanceof Error ? error.message : String(error);
			const networkError = new WebToolError("network", `network error contacting DeepSeek: ${message}`, {
				retryable: true,
				cause: error,
			});
			if (attempt >= options.maxRetries) throw networkError;
			lastError = networkError;
			const delay = computeRetryDelay(attempt, null, options.retryBaseDelayMs, options.retryMaxDelayMs);
			debugLog(options, "retry-network", { url, attempt, delayMs: delay });
			await pause(delay, signal, sleep);
		} finally {
			linked.cleanup();
		}
	}

	throw lastError ?? new WebToolError("network", "request failed after retries");
}
