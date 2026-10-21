/**
 * Typed errors for the DeepSeek web tools.
 *
 * Every failure path funnels into `WebToolError` so the tools can hand the
 * model a short, actionable message instead of an uncaught exception.
 */

export type WebToolErrorKind =
	| "config"
	| "invalid_input"
	| "blocked_url"
	| "auth"
	| "rate_limit"
	| "timeout"
	| "aborted"
	| "network"
	| "http"
	| "invalid_response";

export interface WebToolErrorOptions {
	status?: number;
	retryable?: boolean;
	hint?: string;
	cause?: unknown;
}

export class WebToolError extends Error {
	readonly kind: WebToolErrorKind;
	readonly status: number | undefined;
	readonly retryable: boolean;
	readonly hint: string | undefined;

	constructor(kind: WebToolErrorKind, message: string, options: WebToolErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "WebToolError";
		this.kind = kind;
		this.status = options.status;
		this.retryable = options.retryable ?? false;
		this.hint = options.hint;
	}

	/** Model-facing description, kept short and free of stack traces. */
	toModelText(toolName = "web_search"): string {
		const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
		const lines = [`${toolName} failed [${this.kind}]${status}: ${this.message}`];
		if (this.hint) lines.push(`Hint: ${this.hint}`);
		if (this.retryable) {
			lines.push("This looks transient. Retrying the same call once may succeed.");
		}
		return lines.join("\n");
	}

	toDetails(): { kind: WebToolErrorKind; status: number | null; retryable: boolean; message: string } {
		return {
			kind: this.kind,
			status: this.status ?? null,
			retryable: this.retryable,
			message: this.message,
		};
	}
}

export function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || error.name === "TimeoutError";
}

/** Normalize unknown thrown values into a `WebToolError`. */
export function toWebToolError(error: unknown, fallbackKind: WebToolErrorKind = "network"): WebToolError {
	if (error instanceof WebToolError) return error;
	if (error instanceof Error) {
		return new WebToolError(fallbackKind, error.message || error.name, { cause: error });
	}
	return new WebToolError(fallbackKind, String(error), { cause: error });
}
