/**
 * Configuration for the DeepSeek web tools.
 *
 * Everything is driven by environment variables so the extension stays
 * zero-config in a default Pi install. Numeric values are clamped to sane
 * ranges; a bad value degrades to the default instead of breaking the tool.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface WebToolsConfig {
	baseUrl: string;
	/** Resolved lazily: the key is only required when a tool actually runs. */
	apiKey: string | undefined;
	/** Exa REST API base URL. Its key is resolved lazily from EXA_API_KEY. */
	exaBaseUrl: string;
	exaSearchType: string;
	exaAllowInsecureBaseUrl: boolean;
	timeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
	searchCacheTtlMs: number;
	searchCacheMaxEntries: number;
	fetchCacheTtlMs: number;
	fetchCacheMaxEntries: number;
	/** Model-facing budget for one tool result. */
	maxResultBytes: number;
	maxResultLines: number;
	/** Per-result summary budget inside a search result. */
	maxSnippetChars: number;
	/** Hard cap on a raw HTTP response body before giving up. */
	maxResponseBytes: number;
	allowPrivateHosts: boolean;
	/** Allow cleartext HTTP for a non-loopback API base URL. Sends the key in the clear. */
	allowInsecureBaseUrl: boolean;
	spillToTempFile: boolean;
	debug: boolean;
	userAgent: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULTS = {
	baseUrl: "https://api.deepseek.com",
	exaBaseUrl: "https://api.exa.ai",
	exaSearchType: "auto",
	timeoutMs: 20_000,
	maxRetries: 2,
	retryBaseDelayMs: 350,
	retryMaxDelayMs: 5_000,
	searchCacheTtlMs: 5 * 60_000,
	searchCacheMaxEntries: 64,
	fetchCacheTtlMs: 10 * 60_000,
	fetchCacheMaxEntries: 32,
	maxResultBytes: 40_000,
	maxResultLines: 1_200,
	maxSnippetChars: 800,
	maxResponseBytes: 8 * 1024 * 1024,
	allowInsecureBaseUrl: false,
} as const;

function firstSet(env: Env, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function readInt(env: Env, names: readonly string[], fallback: number, min: number, max: number): number {
	const raw = firstSet(env, names);
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

function readBool(env: Env, names: readonly string[], fallback: boolean): boolean {
	const raw = firstSet(env, names)?.toLowerCase();
	if (raw === undefined) return fallback;
	if (["1", "true", "yes", "on"].includes(raw)) return true;
	if (["0", "false", "no", "off"].includes(raw)) return false;
	return fallback;
}

function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeBaseUrl(raw: string, allowInsecure: boolean, fallback: string): string {
	const trimmed = raw.trim().replace(/\/+$/, "");
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
		if (url.username || url.password) return fallback;
		// API keys are sent as headers. Never send one over cleartext to a
		// remote host; loopback is allowed for local development.
		if (url.protocol === "http:" && !allowInsecure && !isLoopbackHostname(url.hostname)) {
			return fallback;
		}
		return trimmed;
	} catch {
		return fallback;
	}
}

/** Build the configuration from an environment snapshot. */
export function loadConfig(env: Env = process.env): WebToolsConfig {
	const allowInsecureBaseUrl = readBool(
		env,
		["DEEPSEEK_WEB_ALLOW_INSECURE_BASE_URL"],
		DEFAULTS.allowInsecureBaseUrl,
	);
	return {
		baseUrl: normalizeBaseUrl(
			firstSet(env, ["DEEPSEEK_SEARCH_BASE_URL", "DEEPSEEK_BASE_URL"]) ?? DEFAULTS.baseUrl,
			allowInsecureBaseUrl,
			DEFAULTS.baseUrl,
		),
		apiKey: firstSet(env, ["DEEPSEEK_API_KEY"]),
		exaBaseUrl: normalizeBaseUrl(
			firstSet(env, ["EXA_BASE_URL"]) ?? DEFAULTS.exaBaseUrl,
			readBool(env, ["EXA_WEB_ALLOW_INSECURE_BASE_URL"], false),
			DEFAULTS.exaBaseUrl,
		),
		exaSearchType: firstSet(env, ["EXA_SEARCH_TYPE"]) ?? DEFAULTS.exaSearchType,
		exaAllowInsecureBaseUrl: readBool(env, ["EXA_WEB_ALLOW_INSECURE_BASE_URL"], false),
		timeoutMs: readInt(env, ["DEEPSEEK_SEARCH_TIMEOUT_MS"], DEFAULTS.timeoutMs, 1_000, 300_000),
		maxRetries: readInt(env, ["DEEPSEEK_SEARCH_MAX_RETRIES"], DEFAULTS.maxRetries, 0, 5),
		retryBaseDelayMs: readInt(env, ["DEEPSEEK_SEARCH_RETRY_BASE_MS"], DEFAULTS.retryBaseDelayMs, 50, 10_000),
		retryMaxDelayMs: readInt(env, ["DEEPSEEK_SEARCH_RETRY_MAX_MS"], DEFAULTS.retryMaxDelayMs, 100, 60_000),
		searchCacheTtlMs: readInt(
			env,
			["DEEPSEEK_SEARCH_CACHE_TTL_MS"],
			DEFAULTS.searchCacheTtlMs,
			0,
			24 * 60 * 60_000,
		),
		searchCacheMaxEntries: readInt(
			env,
			["DEEPSEEK_SEARCH_CACHE_MAX"],
			DEFAULTS.searchCacheMaxEntries,
			0,
			1_000,
		),
		fetchCacheTtlMs: readInt(
			env,
			["DEEPSEEK_FETCH_CACHE_TTL_MS"],
			DEFAULTS.fetchCacheTtlMs,
			0,
			24 * 60 * 60_000,
		),
		fetchCacheMaxEntries: readInt(env, ["DEEPSEEK_FETCH_CACHE_MAX"], DEFAULTS.fetchCacheMaxEntries, 0, 1_000),
		maxResultBytes: readInt(env, ["DEEPSEEK_WEB_MAX_RESULT_BYTES"], DEFAULTS.maxResultBytes, 1_000, 1_000_000),
		maxResultLines: readInt(env, ["DEEPSEEK_WEB_MAX_RESULT_LINES"], DEFAULTS.maxResultLines, 10, 100_000),
		maxSnippetChars: readInt(env, ["DEEPSEEK_WEB_MAX_SNIPPET_CHARS"], DEFAULTS.maxSnippetChars, 80, 8_000),
		maxResponseBytes: readInt(
			env,
			["DEEPSEEK_WEB_MAX_RESPONSE_BYTES"],
			DEFAULTS.maxResponseBytes,
			64 * 1024,
			64 * 1024 * 1024,
		),
		allowPrivateHosts: readBool(env, ["DEEPSEEK_WEB_ALLOW_PRIVATE_HOSTS"], false),
		allowInsecureBaseUrl,
		spillToTempFile: readBool(env, ["DEEPSEEK_WEB_SPILL"], true),
		debug: readBool(env, ["DEEPSEEK_WEB_DEBUG"], false),
		userAgent: `pi-deepseek-web/0.1.0 (+pi)`,
	};
}

/** Pi's agent directory, matching `getAgentDir()` in Pi itself. */
export function agentDir(env: Env = process.env): string {
	const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
	return fromEnv ? fromEnv : join(homedir(), CONFIG_DIR_NAME, "agent");
}

interface StoredCredential {
	type?: string;
	key?: string;
}

/**
 * Resolve the DeepSeek API key from the environment, then from Pi's
 * `auth.json`. Shell-command credentials (`!cmd`) are deliberately ignored:
 * running shell commands from a tool call is surprising, so they fall through
 * to a clear error message instead.
 */
export function resolveApiKey(env: Env = process.env, authPath?: string): string | undefined {
	const fromEnv = env.DEEPSEEK_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	const path = authPath ?? join(agentDir(env), "auth.json");
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredCredential | undefined>;
		const credential = data.deepseek;
		if (credential?.type === "api_key" && typeof credential.key === "string") {
			const key = credential.key.trim();
			if (key && !key.startsWith("!")) return key;
		}
	} catch {
		// Missing or unreadable auth.json is not an error here; the caller
		// reports the missing key with instructions.
	}
	return undefined;
}

/** Resolve the optional Exa key from the environment, then Pi's auth.json. */
export function resolveExaApiKey(env: Env = process.env, authPath?: string): string | undefined {
	const fromEnv = env.EXA_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	const path = authPath ?? join(agentDir(env), "auth.json");
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredCredential | undefined>;
		const credential = data.exa;
		if (credential?.type === "api_key" && typeof credential.key === "string") {
			const key = credential.key.trim();
			if (key && !key.startsWith("!")) return key;
		}
	} catch {
		// Missing or unreadable auth.json is not an error here.
	}
	return undefined;
}
