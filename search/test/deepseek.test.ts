import assert from "node:assert/strict";
import test from "node:test";

import {
	createDeepSeekClient,
	normalizeSearchInput,
	parseSearchResponse,
	type DeepSeekClientOptions,
} from "../src/deepseek.ts";
import { WebToolError } from "../src/errors.ts";
import { delay, json, startMockServer } from "./helpers.ts";

const RESULT = {
	rerank_score: 2.4,
	title: "DeepSeek V4 model released",
	url: "https://example.com/deepseek-v4",
	snippet: "short snippet",
	summary: "long summary for the model",
	content: "",
	site_name: "Example News",
	site_icon: null,
	date: "2026-06-01T00:00:00+00:00",
	authority: 3,
};

function options(baseUrl: string, overrides: Partial<DeepSeekClientOptions> = {}): DeepSeekClientOptions {
	return {
		apiKey: "test-key",
		baseUrl,
		timeoutMs: 2_000,
		maxRetries: 0,
		retryBaseDelayMs: 5,
		retryMaxDelayMs: 20,
		maxResponseBytes: 1_000_000,
		searchCacheTtlMs: 1_000,
		searchCacheMaxEntries: 10,
		fetchCacheTtlMs: 1_000,
		fetchCacheMaxEntries: 10,
		allowPrivateHosts: false,
		userAgent: "pi-deepseek-web-test",
		sleep: async () => {},
		...overrides,
	};
}

test("search posts the documented body and normalizes results", async () => {
	const server = await startMockServer((_request, res) => json(res, 200, { results: [RESULT] }));
	try {
		const client = createDeepSeekClient(options(server.url));
		const outcome = await client.search({ query: "  deepseek v4  ", count: 5, need_content: true });

		assert.equal(server.requests.length, 1);
		const request = server.requests[0]!;
		assert.equal(request.path, "/v1/tools/search");
		assert.deepEqual(JSON.parse(request.body), {
			query: "deepseek v4",
			count: 5,
			need_content: true,
		});

		assert.equal(outcome.results.length, 1);
		const item = outcome.results[0]!;
		assert.equal(item.title, RESULT.title);
		assert.equal(item.url, RESULT.url);
		assert.equal(item.site_name, "Example News");
		assert.equal(item.authority, 3);
		assert.equal(item.rerank_score, 2.4);
		assert.equal(outcome.fromCache, false);
		assert.equal(outcome.source, "network");
	} finally {
		await server.close();
	}
});

test("search clamps count and omits empty ori_question", async () => {
	const server = await startMockServer((_request, res) => json(res, 200, { results: [] }));
	try {
		const client = createDeepSeekClient(options(server.url));
		await client.search({ query: "x", count: 999, ori_question: "   " });
		const body = JSON.parse(server.requests[0]!.body) as Record<string, unknown>;
		assert.equal(body.count, 50);
		assert.equal("ori_question" in body, false);
	} finally {
		await server.close();
	}
});

test("repeated searches hit the cache; concurrent misses coalesce", async () => {
	let searchCalls = 0;
	const server = await startMockServer(async (_request, res) => {
		searchCalls += 1;
		await delay(30);
		json(res, 200, { results: [RESULT] });
	});
	try {
		const client = createDeepSeekClient(options(server.url));
		const [a, b] = await Promise.all([
			client.search({ query: "same" }),
			client.search({ query: "same" }),
		]);
		assert.equal(searchCalls, 1, "concurrent identical searches should share one request");
		assert.deepEqual(new Set([a.source, b.source]), new Set(["network", "coalesced"]));

		const third = await client.search({ query: "same" });
		assert.equal(third.fromCache, true);
		assert.equal(third.source, "cache");
		assert.equal(searchCalls, 1);
	} finally {
		await server.close();
	}
});

test("fetchPage posts the URL and caches the page, with private hosts allowed explicitly", async () => {
	const server = await startMockServer((_request, res) =>
		json(res, 200, { title: "Example article", content: "# Example article\n\nBody." }),
	);
	try {
		const client = createDeepSeekClient(options(server.url, { allowPrivateHosts: true }));
		const first = await client.fetchPage("https://example.com/article#section");
		assert.equal(server.requests.length, 1);
		assert.equal(server.requests[0]!.path, "/v1/tools/fetch");
		assert.deepEqual(JSON.parse(server.requests[0]!.body), { url: "https://example.com/article" });
		assert.equal(first.title, "Example article");
		assert.match(first.content, /Body\./);

		const second = await client.fetchPage("https://example.com/article");
		assert.equal(second.fromCache, true);
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("fetchPage refuses private DNS answers before calling DeepSeek", async () => {
	const server = await startMockServer((_request, res) => json(res, 200, { title: "nope", content: "nope" }));
	try {
		const client = createDeepSeekClient(
			options(server.url, { allowPrivateHosts: false, lookup: async () => ["10.0.0.1"] }),
		);
		await assert.rejects(client.fetchPage("https://internal.example/"), (error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "blocked_url");
			return true;
		});
		assert.equal(server.requests.length, 0);
	} finally {
		await server.close();
	}
});

test("fetchPage bounds DNS resolution before calling the API", async () => {
	let fetches = 0;
	const client = createDeepSeekClient(
		options("https://api.example", {
			lookup: () => new Promise(() => {}),
			timeoutMs: 25,
			fetchImpl: (async () => {
				fetches += 1;
				return new Response(JSON.stringify({ title: "x", content: "x" }), { status: 200 });
			}) as typeof fetch,
		}),
	);
	await assert.rejects(client.fetchPage("https://slow.example/"), (error: unknown) => {
		assert.ok(error instanceof WebToolError);
		assert.equal(error.kind, "timeout");
		return true;
	});
	assert.equal(fetches, 0);
});

test("search surfaces auth and malformed-response failures as typed errors", async () => {
	const unauthorized = await startMockServer((_request, res) =>
		json(res, 401, { error: { message: "invalid key" } }),
	);
	try {
		const client = createDeepSeekClient(options(unauthorized.url));
		await assert.rejects(client.search({ query: "x" }), (error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "auth");
			return true;
		});
	} finally {
		await unauthorized.close();
	}

	const malformed = await startMockServer((_request, res) => json(res, 200, { results: "nope" }));
	try {
		const client = createDeepSeekClient(options(malformed.url));
		await assert.rejects(client.search({ query: "x" }), (error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "invalid_response");
			return true;
		});
	} finally {
		await malformed.close();
	}
});

test("normalizeSearchInput enforces the documented limits", () => {
	assert.deepEqual(normalizeSearchInput({ query: "  hello  " }), {
		query: "hello",
		count: 10,
		need_content: false,
		ori_question: undefined,
	});
	assert.equal(normalizeSearchInput({ query: "x", count: 0 }).count, 1);
	assert.equal(normalizeSearchInput({ query: "x", count: 7.9 }).count, 7);

	assert.throws(() => normalizeSearchInput({ query: "   " }), /must not be empty/);
	assert.throws(() => normalizeSearchInput({ query: "a".repeat(129) }), /at most 128 characters/);
	assert.throws(
		() => normalizeSearchInput({ query: "x", ori_question: "q".repeat(129) }),
		/ori_question must be at most 128/,
	);
	// Length is measured in Unicode code points, matching the API contract.
	assert.equal(normalizeSearchInput({ query: "😀".repeat(128) }).query.length > 128, true);
	assert.throws(() => normalizeSearchInput({ query: "😀".repeat(129) }), /at most 128 characters/);
});

test("parseSearchResponse tolerates partial records and drops unusable results", () => {
	const results = parseSearchResponse({
		results: [
			{ url: "https://a.example/" },
			{ title: "no url" },
			"garbage",
			{ url: "https://b.example/", title: "B", authority: "high" },
		],
	});
	assert.equal(results.length, 2);
	assert.equal(results[0]!.title, "https://a.example/");
	assert.equal(results[0]!.authority, -1);
	assert.equal(results[1]!.title, "B");
	assert.equal(results[1]!.authority, -1);
});
