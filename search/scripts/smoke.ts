/**
 * Real-API smoke test (not part of `npm test`; requires at least one key).
 *
 *   npm run smoke
 *
 * Verifies every configured provider: search results, page fetch and the
 * local SSRF guard. DeepSeek uses DEEPSEEK_API_KEY; Exa uses EXA_API_KEY.
 */

import { loadConfig, resolveApiKey, resolveExaApiKey } from "../src/config.ts";
import { createDeepSeekClient, type DeepSeekClient } from "../src/deepseek.ts";
import { WebToolError } from "../src/errors.ts";
import { createExaClient, type ExaClient } from "../src/exa.ts";

const config = loadConfig();
const deepseekKey = resolveApiKey();
const exaKey = resolveExaApiKey();
if (!deepseekKey && !exaKey) {
	console.error("smoke: DEEPSEEK_API_KEY or EXA_API_KEY is required");
	process.exit(1);
}

async function smokeProvider(name: string, client: DeepSeekClient | ExaClient): Promise<void> {
	const search = await client.search({ query: "DeepSeek API documentation", count: 3 });
	console.log(`${name} search: ${search.results.length} result(s) in ${search.durationMs} ms`);
	for (const result of search.results) {
		console.log(`  - ${result.title} <${result.url}>`);
	}
	if (search.results.length === 0) throw new Error(`${name} search returned no results`);

	const target = search.results.find((result) => /^https?:\/\//.test(result.url)) ?? search.results[0]!;
	const page = await client.fetchPage(target.url);
	console.log(`${name} fetch: ${page.title || "(no title)"} — ${page.content.length} chars in ${page.durationMs} ms`);
	if (!page.content.trim()) throw new Error(`${name} fetch returned empty content`);

	try {
		await client.fetchPage("http://169.254.169.254/latest/meta-data/");
		throw new Error(`${name} SSRF guard did not reject the metadata endpoint`);
	} catch (error) {
		if (!(error instanceof WebToolError) || error.kind !== "blocked_url") throw error;
		console.log(`${name} guard: blocked metadata endpoint (${error.message})`);
	}
}

if (deepseekKey) {
	const client = createDeepSeekClient({
		apiKey: deepseekKey,
		baseUrl: config.baseUrl,
		timeoutMs: config.timeoutMs,
		maxRetries: config.maxRetries,
		retryBaseDelayMs: config.retryBaseDelayMs,
		retryMaxDelayMs: config.retryMaxDelayMs,
		maxResponseBytes: config.maxResponseBytes,
		searchCacheTtlMs: 0,
		searchCacheMaxEntries: 0,
		fetchCacheTtlMs: 0,
		fetchCacheMaxEntries: 0,
		allowPrivateHosts: false,
		userAgent: config.userAgent,
	});
	await smokeProvider("deepseek", client);
}

if (exaKey) {
	const client = createExaClient({
		apiKey: exaKey,
		baseUrl: config.exaBaseUrl,
		searchType: config.exaSearchType,
		maxSnippetChars: config.maxSnippetChars,
		timeoutMs: config.timeoutMs,
		maxRetries: config.maxRetries,
		retryBaseDelayMs: config.retryBaseDelayMs,
		retryMaxDelayMs: config.retryMaxDelayMs,
		maxResponseBytes: config.maxResponseBytes,
		searchCacheTtlMs: 0,
		searchCacheMaxEntries: 0,
		fetchCacheTtlMs: 0,
		fetchCacheMaxEntries: 0,
		allowPrivateHosts: false,
		userAgent: config.userAgent,
	});
	await smokeProvider("exa", client);
}

console.log("smoke ok");
