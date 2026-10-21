/**
 * Pi extension entry point.
 *
 * Registers `web_search` and `web_fetch`, both backed by the DeepSeek
 * Search & Fetch API. The client is created lazily so Pi starts normally when
 * no API key is configured; the first tool call reports the missing key.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, resolveApiKey } from "./config.ts";
import { createDeepSeekClient, type DeepSeekClient } from "./deepseek.ts";
import { WebToolError } from "./errors.ts";
import { registerWebTools } from "./tools.ts";

export default function deepseekWebExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	const debug = config.debug
		? (message: string, meta?: Record<string, unknown>) => {
				const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
				process.stderr.write(`[deepseek-web] ${message}${suffix}\n`);
			}
		: undefined;

	let clientPromise: Promise<DeepSeekClient> | undefined;
	let clientKey: string | undefined;

	const getClient = (): Promise<DeepSeekClient> => {
		const apiKey = resolveApiKey();
		if (!apiKey) {
			clientPromise = undefined;
			clientKey = undefined;
			return Promise.reject(
				new WebToolError("config", "No DeepSeek API key found", {
					hint: "Set DEEPSEEK_API_KEY, or run /login deepseek in Pi, then retry.",
				}),
			);
		}
		// Recreate the client when the credential changed, so a retry after
		// /login or key rotation does not keep sending the old key.
		if (clientPromise && clientKey !== apiKey) {
			clientPromise = undefined;
			clientKey = undefined;
		}
		if (!clientPromise) {
			clientKey = apiKey;
			clientPromise = (async () => {
				return createDeepSeekClient({
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
				});
			})().catch((error: unknown) => {
				// Allow a later call to retry after the credential is fixed.
				clientPromise = undefined;
				clientKey = undefined;
				throw error;
			});
		}
		return clientPromise;
	};

	registerWebTools(pi, { getClient, config });
}
