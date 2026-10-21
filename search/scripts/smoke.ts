/**
 * Real-API smoke test (not part of `npm test`; requires DEEPSEEK_API_KEY).
 *
 *   npm run smoke
 *
 * Verifies both endpoints, field parsing and the SSRF guard against the live
 * DeepSeek Search & Fetch API.
 */

import { loadConfig, resolveApiKey } from "../src/config.ts";
import { createDeepSeekClient } from "../src/deepseek.ts";
import { WebToolError } from "../src/errors.ts";

const config = loadConfig();
const apiKey = resolveApiKey();
if (!apiKey) {
	console.error("smoke: DEEPSEEK_API_KEY (or ~/.pi/agent/auth.json deepseek) is required");
	process.exit(1);
}

const client = createDeepSeekClient({
	apiKey,
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

const search = await client.search({ query: "DeepSeek API documentation", count: 3 });
console.log(`search: ${search.results.length} result(s) in ${search.durationMs} ms`);
for (const result of search.results) {
	console.log(`  - ${result.title} <${result.url}> authority=${result.authority} score=${result.rerank_score}`);
}
if (search.results.length === 0) {
	console.error("smoke: search returned no results");
	process.exit(1);
}

const target = search.results.find((result) => /^https?:\/\//.test(result.url)) ?? search.results[0]!;
const page = await client.fetchPage(target.url);
console.log(`fetch: ${page.title || "(no title)"} — ${page.content.length} chars in ${page.durationMs} ms`);
if (!page.content.trim()) {
	console.error("smoke: fetch returned empty content");
	process.exit(1);
}

// The SSRF guard must reject before any network request is made.
try {
	await client.fetchPage("http://169.254.169.254/latest/meta-data/");
	console.error("smoke: SSRF guard did not reject the metadata endpoint");
	process.exit(1);
} catch (error) {
	if (!(error instanceof WebToolError) || error.kind !== "blocked_url") {
		console.error("smoke: unexpected SSRF guard error", error);
		process.exit(1);
	}
	console.log(`guard: blocked metadata endpoint (${error.message})`);
}

console.log("smoke ok");
