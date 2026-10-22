/**
 * Exa Search & Contents REST client.
 *
 * Endpoints:
 *   POST {baseUrl}/search   -> ranked web results, optional highlights/text
 *   POST {baseUrl}/contents -> cleaned text for one URL
 *
 * Exa is optional. The unified tools choose it when EXA_API_KEY is present,
 * and can also be called explicitly with provider="exa".
 */

import { SharedFetchCache, TtlLruCache } from "./cache.ts";
import type { FetchOutcome, SearchInput, SearchOutcome, SearchResultItem } from "./deepseek.ts";
import { normalizeSearchInput } from "./deepseek.ts";
import { WebToolError } from "./errors.ts";
import { postJson, type FetchLike } from "./http.ts";
import { assertPublicUrl, parseHttpUrl, type LookupFn } from "./ssrf.ts";

const MAX_CONTENT_CHARS = 200_000;

export interface ExaClientOptions {
	apiKey: string;
	baseUrl: string;
	searchType: string;
	maxSnippetChars: number;
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

export interface ExaClient {
	search(input: SearchInput, signal?: AbortSignal): Promise<SearchOutcome>;
	fetchPage(url: string, signal?: AbortSignal): Promise<FetchOutcome>;
	readonly searchCache: SharedFetchCache<string, SearchResultItem[]>;
	readonly fetchCache: SharedFetchCache<string, { title: string; content: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function hostname(url: string): string | null {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

export function parseExaSearchResponse(payload: unknown): SearchResultItem[] {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new WebToolError("invalid_response", "Exa search response is missing a results array");
	}
	const results: SearchResultItem[] = [];
	for (const raw of payload.results) {
		if (!isRecord(raw)) continue;
		const url = asString(raw.url).trim();
		if (!url) continue;
		const highlights = Array.isArray(raw.highlights)
			? raw.highlights.filter((item): item is string => typeof item === "string")
			: [];
		const summary = asString(raw.summary);
		const snippet = summary || highlights.join("\n\n");
		results.push({
			title: asString(raw.title, url),
			url,
			snippet,
			summary,
			content: asString(raw.text),
			site_name: hostname(url),
			date: asNullableString(raw.publishedDate),
			authority: -1,
			rerank_score: 0,
			provider: "exa",
			providers: ["exa"],
		});
	}
	return results;
}

export function parseExaContentsResponse(
	payload: unknown,
	url: string,
): { title: string; content: string } {
	if (!isRecord(payload) || !Array.isArray(payload.results)) {
		throw new WebToolError("invalid_response", "Exa contents response is missing a results array");
	}
	const result =
		payload.results.find((raw) => isRecord(raw) && asString(raw.url).trim() === url) ??
		payload.results.find((raw) => isRecord(raw) && typeof raw.text === "string");
	if (!isRecord(result)) {
		const statuses = Array.isArray(payload.statuses) ? payload.statuses : [];
		const failure = statuses.find(
			(status) => isRecord(status) && status.status === "error",
		) as Record<string, unknown> | undefined;
		const detail = failure ? `: ${JSON.stringify(failure.error ?? failure)}` : "";
		throw new WebToolError("invalid_response", `Exa returned no content for ${url}${detail}`);
	}
	const content = asString(result.text);
	if (!content.trim()) {
		throw new WebToolError("invalid_response", `Exa returned empty content for ${url}`);
	}
	return { title: asString(result.title, url), content };
}

export function createExaClient(options: ExaClientOptions): ExaClient {
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
		authHeader: "x-api-key",
		authPrefix: "",
		providerLabel: "Exa",
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
			t: options.searchType,
		});
		const body = {
			query: normalized.query,
			numResults: normalized.count,
			type: options.searchType,
			contents: {
				highlights: {
					maxCharacters: options.maxSnippetChars,
					...(normalized.ori_question ? { query: normalized.ori_question } : {}),
				},
				...(normalized.need_content
					? { text: { maxCharacters: MAX_CONTENT_CHARS } }
					: {}),
			},
		};

		const { value, source } = await searchCache.getOrLoad(
			key,
			async (loaderSignal) => {
				const payload = await postJson<unknown>(
					`${baseUrl}/search`,
					body,
					httpOptions,
					loaderSignal,
				);
				return parseExaSearchResponse(payload);
			},
			signal,
		);

		return {
			results: value,
			fromCache: source === "cache",
			source,
			durationMs: now() - startedAt,
			providers: ["exa"],
		};
	}

	async function fetchPage(rawUrl: string, signal?: AbortSignal): Promise<FetchOutcome> {
		const parsed = parseHttpUrl(rawUrl);
		const key = parsed.toString();
		const startedAt = now();

		const { value, source } = await fetchCache.getOrLoad(
			key,
			async (loaderSignal) => {
				await assertPublicUrl(key, {
					allowPrivateHosts: options.allowPrivateHosts,
					...(options.lookup ? { lookup: options.lookup } : {}),
					signal: loaderSignal,
					timeoutMs: options.timeoutMs,
				});
				const payload = await postJson<unknown>(
					`${baseUrl}/contents`,
					{ urls: [key], text: { maxCharacters: MAX_CONTENT_CHARS } },
					httpOptions,
					loaderSignal,
				);
				return parseExaContentsResponse(payload, key);
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
			provider: "exa",
		};
	}

	return { search, fetchPage, searchCache, fetchCache };
}
