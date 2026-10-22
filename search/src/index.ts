/**
 * Pi extension entry point.
 *
 * Registers provider-neutral `web_search` and `web_fetch` tools. DeepSeek and
 * Exa clients are created lazily; a missing key only disables that provider,
 * so a session can use Exa alone, DeepSeek alone, or both.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, resolveApiKey, resolveExaApiKey } from "./config.ts";
import { createDeepSeekClient, type DeepSeekClient } from "./deepseek.ts";
import { WebToolError } from "./errors.ts";
import { createExaClient, type ExaClient } from "./exa.ts";
import { registerWebTools } from "./tools.ts";

export default function deepseekWebExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const debug = config.debug
		? (message: string, meta?: Record<string, unknown>) => {
				const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
				process.stderr.write(`[deepseek-web] ${message}${suffix}\n`);
			}
		: undefined;

	let deepseekPromise: Promise<DeepSeekClient> | undefined;
	let deepseekKey: string | undefined;
	let exaPromise: Promise<ExaClient> | undefined;
	let exaKey: string | undefined;

	const getDeepSeek = (apiKey: string): Promise<DeepSeekClient> => {
		if (deepseekPromise && deepseekKey !== apiKey) {
			deepseekPromise = undefined;
			deepseekKey = undefined;
		}
		if (!deepseekPromise) {
			deepseekKey = apiKey;
			deepseekPromise = Promise.resolve().then(() =>
				createDeepSeekClient({
					apiKey,
					baseUrl: config.baseUrl,
					timeoutMs: config.timeoutMs,
					maxRetries: config.maxRetries,
					retryBaseDelayMs: config.retryBaseDelayMs,
					retryMaxDelayMs: config.retryMaxDelayMs,
					maxResponseBytes: config.maxResponseBytes,
					searchCacheTtlMs: config.searchCacheTtlMs,
					searchCacheMaxEntries: config.searchCacheMaxEntries,
					fetchCacheTtlMs: config.fetchCacheTtlMs,
					fetchCacheMaxEntries: config.fetchCacheMaxEntries,
					allowPrivateHosts: config.allowPrivateHosts,
					userAgent: config.userAgent,
					...(debug ? { debug } : {}),
				}),
			).catch((error: unknown) => {
				deepseekPromise = undefined;
				deepseekKey = undefined;
				throw error;
			});
		}
		return deepseekPromise;
	};

	const getExa = (apiKey: string): Promise<ExaClient> => {
		if (exaPromise && exaKey !== apiKey) {
			exaPromise = undefined;
			exaKey = undefined;
		}
		if (!exaPromise) {
			exaKey = apiKey;
			exaPromise = Promise.resolve().then(() =>
				createExaClient({
					apiKey,
					baseUrl: config.exaBaseUrl,
					searchType: config.exaSearchType,
					maxSnippetChars: config.maxSnippetChars,
					timeoutMs: config.timeoutMs,
					maxRetries: config.maxRetries,
					retryBaseDelayMs: config.retryBaseDelayMs,
					retryMaxDelayMs: config.retryMaxDelayMs,
					maxResponseBytes: config.maxResponseBytes,
					searchCacheTtlMs: config.searchCacheTtlMs,
					searchCacheMaxEntries: config.searchCacheMaxEntries,
					fetchCacheTtlMs: config.fetchCacheTtlMs,
					fetchCacheMaxEntries: config.fetchCacheMaxEntries,
					allowPrivateHosts: config.allowPrivateHosts,
					userAgent: config.userAgent,
					...(debug ? { debug } : {}),
				}),
			).catch((error: unknown) => {
				exaPromise = undefined;
				exaKey = undefined;
				throw error;
			});
		}
		return exaPromise;
	};

	const getClients = async (): Promise<{ deepseek?: DeepSeekClient; exa?: ExaClient }> => {
		const currentDeepSeekKey = resolveApiKey();
		const currentExaKey = resolveExaApiKey();
		if (!currentDeepSeekKey && !currentExaKey) {
			deepseekPromise = undefined;
			deepseekKey = undefined;
			exaPromise = undefined;
			exaKey = undefined;
			throw new WebToolError("config", "No web search API key found", {
				hint: "Set DEEPSEEK_API_KEY and/or EXA_API_KEY, then retry.",
			});
		}
		if (!currentDeepSeekKey) {
			deepseekPromise = undefined;
			deepseekKey = undefined;
		}
		if (!currentExaKey) {
			exaPromise = undefined;
			exaKey = undefined;
		}

		const clients: { deepseek?: DeepSeekClient; exa?: ExaClient } = {};
		if (currentDeepSeekKey) clients.deepseek = await getDeepSeek(currentDeepSeekKey);
		if (currentExaKey) clients.exa = await getExa(currentExaKey);
		return clients;
	};

	registerWebTools(pi, { getClients, config });
}
