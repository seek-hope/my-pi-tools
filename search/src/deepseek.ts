/**
 * DeepSeek Search & Fetch API client.
 *
 * Endpoints:
 *   POST {baseUrl}/v1/tools/search  -> ranked web results
 *   POST {baseUrl}/v1/tools/fetch   -> { title, content } for one URL
 *
 * The client owns validation, caching, request coalescing and response
 * normalization. Tool registration and rendering live in `tools.ts`.
 */

import { SharedFetchCache, TtlLruCache, type CacheSource } from "./cache.ts";
import { WebToolError } from "./errors.ts";
import { postJson, type FetchLike } from "./http.ts";
import { assertPublicUrl, parseHttpUrl, type LookupFn } from "./ssrf.ts";

export const MAX_QUERY_CHARS = 128;
export const MIN_RESULT_COUNT = 1;
export const MAX_RESULT_COUNT = 50;
export const DEFAULT_RESULT_COUNT = 10;

export type SearchProvider = "deepseek" | "exa";

export interface SearchInput {
	query: string;
	count?: number | undefined;
	need_content?: boolean | undefined;
	ori_question?: string | undefined;
}

export interface SearchResultItem {
	title: string;
	url: string;
	snippet: string;
	summary: string;
	content: string;
	site_name: string | null;
	date: string | null;
	authority: number;
	rerank_score: number;
	/** Provider that produced this item. */
	provider?: SearchProvider;
	providers?: SearchProvider[];
}

export interface SearchOutcome {
	results: SearchResultItem[];
	fromCache: boolean;
	source: CacheSource;
	durationMs: number;
	providers?: SearchProvider[];
}

export interface FetchOutcome {
	url: string;
	title: string;
	content: string;
	fromCache: boolean;
	source: CacheSource;
	durationMs: number;
	provider?: SearchProvider;
}

export interface DeepSeekClientOptions {
	apiKey: string;
	baseUrl: string;
	timeoutMs: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	retryMaxDelayMs: number;
	maxResponseBytes: number;
	searchCacheTtlMs: number;
	searchCacheMaxEntries: number;
	fetchCacheTtlMs: number;
	fetchCacheMaxEntries: number;
	allowPrivateHosts: boolean;
	userAgent: string;
	fetchImpl?: FetchLike;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	lookup?: LookupFn;
	now?: () => number;
	debug?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface DeepSeekClient {
	search(input: SearchInput, signal?: AbortSignal): Promise<SearchOutcome>;
	fetchPage(url: string, signal?: AbortSignal): Promise<FetchOutcome>;
	readonly searchCache: SharedFetchCache<string, SearchResultItem[]>;
	readonly fetchCache: SharedFetchCache<string, { title: string; content: string }>;
}

interface NormalizedSearchInput {
	query: string;
	count: number;
	need_content: boolean;
	ori_question: string | undefined;
}

function charCount(value: string): number {
	return Array.from(value).length;
}

export function normalizeSearchInput(input: SearchInput): NormalizedSearchInput {
	const query = typeof input.query === "string" ? input.query.trim() : "";
	if (!query) {
		throw new WebToolError("invalid_input", "query must not be empty", {
			hint: "Pass a short search query, for example: \"pi coding agent extensions\".",
		});
	}
	const queryChars = charCount(query);
	if (queryChars > MAX_QUERY_CHARS) {
		throw new WebToolError(
			"invalid_input",
			`query must be at most ${MAX_QUERY_CHARS} characters (got ${queryChars})`,
			{ hint: "Shorten the query; use quoted phrases or site: operators for precision." },
		);
	}

	let count = DEFAULT_RESULT_COUNT;
	if (input.count !== undefined) {
		if (typeof input.count !== "number" || !Number.isFinite(input.count)) {
			throw new WebToolError("invalid_input", "count must be a number between 1 and 50");
		}
		count = Math.min(MAX_RESULT_COUNT, Math.max(MIN_RESULT_COUNT, Math.trunc(input.count)));
	}

	let oriQuestion: string | undefined;
	if (input.ori_question !== undefined) {
		const trimmed = String(input.ori_question).trim();
		if (trimmed) {
			if (charCount(trimmed) > MAX_QUERY_CHARS) {
				throw new WebToolError(
					"invalid_input",
					`ori_question must be at most ${MAX_QUERY_CHARS} characters`,
				);
			}
			oriQuestion = trimmed;
		}
	}

	return {
		query,
		count,
		need_content: input.need_content === true,
		ori_question: oriQuestion,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function parseSearchResponse(payload: unknown): SearchResultItem[] {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new WebToolError("invalid_response", "DeepSeek search response is missing a results array");
	}
	const results: SearchResultItem[] = [];
	for (const raw of payload.results) {
		if (!isRecord(raw)) continue;
		const url = asString(raw.url).trim();
		if (!url) continue;
		results.push({
			title: asString(raw.title, url),
			url,
			snippet: asString(raw.snippet),
			summary: asString(raw.summary),
			content: asString(raw.content),
			site_name: asNullableString(raw.site_name),
			date: asNullableString(raw.date),
			authority: asNumber(raw.authority, -1),
			rerank_score: asNumber(raw.rerank_score, 0),
			provider: "deepseek",
			providers: ["deepseek"],
		});
	}
	return results;
}

export function parseFetchResponse(payload: unknown, url: string): { title: string; content: string } {
	if (!isRecord(payload)) {
		throw new WebToolError("invalid_response", "DeepSeek fetch response is not an object");
	}
	if (typeof payload.content !== "string") {
		throw new WebToolError("invalid_response", "DeepSeek fetch response is missing page content");
	}
	return {
		title: asString(payload.title, url),
		content: payload.content,
	};
}

export function createDeepSeekClient(options: DeepSeekClientOptions): DeepSeekClient {
	const now = options.now ?? Date.now;
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const httpOptions = {
		timeoutMs: options.timeoutMs,
		maxRetries: options.maxRetries,
		retryBaseDelayMs: options.retryBaseDelayMs,
		retryMaxDelayMs: options.retryMaxDelayMs,
		maxResponseBytes: options.maxResponseBytes,
		userAgent: options.userAgent,
		apiKey: options.apiKey,
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		...(options.sleep ? { sleep: options.sleep } : {}),
		...(options.debug ? { debug: options.debug } : {}),
	};

	const searchCache = new SharedFetchCache<string, SearchResultItem[]>(
		new TtlLruCache<string, SearchResultItem[]>({
			ttlMs: options.searchCacheTtlMs,
			maxEntries: options.searchCacheMaxEntries,
			now,
		}),
	);
	const fetchCache = new SharedFetchCache<string, { title: string; content: string }>(
		new TtlLruCache<string, { title: string; content: string }>({
			ttlMs: options.fetchCacheTtlMs,
			maxEntries: options.fetchCacheMaxEntries,
			now,
		}),
	);

	async function search(input: SearchInput, signal?: AbortSignal): Promise<SearchOutcome> {
		const normalized = normalizeSearchInput(input);
		const startedAt = now();
		const key = JSON.stringify({
			q: normalized.query,
			c: normalized.count,
			n: normalized.need_content,
			o: normalized.ori_question ?? null,
		});
		const body = {
			query: normalized.query,
			count: normalized.count,
			need_content: normalized.need_content,
			...(normalized.ori_question ? { ori_question: normalized.ori_question } : {}),
		};

		const { value, source } = await searchCache.getOrLoad(
			key,
			async (loaderSignal) => {
				const payload = await postJson<unknown>(
					`${baseUrl}/v1/tools/search`,
					body,
					httpOptions,
					loaderSignal,
				);
				return parseSearchResponse(payload);
			},
			signal,
		);

		return {
			results: value,
			fromCache: source === "cache",
			source,
			durationMs: now() - startedAt,
			providers: ["deepseek"],
		};
	}

	async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<FetchOutcome> {
		// Cheap syntactic validation runs even on cache hits.
		const parsed = parseHttpUrl(rawUrl);
		const key = parsed.toString();
		const startedAt = now();

		const { value, source } = await fetchCache.getOrLoad(
			key,
			async (loaderSignal) => {
				// DNS-level validation only runs on a miss; a cached page was
				// already checked when it was stored.
				await assertPublicUrl(key, {
					allowPrivateHosts: options.allowPrivateHosts,
					...(options.lookup ? { lookup: options.lookup } : {}),
					signal: loaderSignal,
					timeoutMs: options.timeoutMs,
				});
				const payload = await postJson<unknown>(
					`${baseUrl}/v1/tools/fetch`,
					{ url: key },
					httpOptions,
					loaderSignal,
				);
				return parseFetchResponse(payload, key);
			},
			signal,
		);

		return {
			url: key,
			title: value.title,
			content: value.content,
			fromCache: source === "cache",
			source,
			durationMs: now() - startedAt,
			provider: "deepseek",
		};
	}

	return { search, fetchPage, searchCache, fetchCache };
}
