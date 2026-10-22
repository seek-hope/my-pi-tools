import assert from "node:assert/strict";
import test from "node:test";

import {
	createExaClient,
	parseExaContentsResponse,
	parseExaSearchResponse,
	type ExaClientOptions,
} from "../src/exa.ts";
import { WebToolError } from "../src/errors.ts";
import { json, startMockServer } from "./helpers.ts";

const RESULT = {
	title: "Pi Coding Agent",
	url: "https://pi.dev/",
	publishedDate: "2026-10-01T00:00:00.000Z",
	author: "Pi",
	highlights: ["Pi is a minimal agent harness.", "Extensions customize Pi."],
	text: "Pi is a minimal agent harness.\n\nExtensions customize Pi.",
};

function options(baseUrl: string, overrides: Partial<ExaClientOptions> = {}): ExaClientOptions {
	return {
		apiKey: "exa-test-key",
		baseUrl,
		searchType: "auto",
		maxSnippetChars: 300,
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

test("Exa search posts highlights/text with x-api-key and normalizes results", async () => {
	const server = await startMockServer((_request, res) => json(res, 200, { results: [RESULT] }));
	try {
		const client = createExaClient(options(server.url));
		const outcome = await client.search({
			query: "  pi coding agent  ",
			count: 3,
			need_content: true,
			ori_question: "what is Pi?",
		});

		assert.equal(server.requests.length, 1);
		const request = server.requests[0]!;
		assert.equal(request.path, "/search");
		assert.equal(request.headers["x-api-key"], "exa-test-key");
		assert.equal(request.headers.authorization, undefined);
		assert.deepEqual(JSON.parse(request.body), {
			query: "pi coding agent",
			numResults: 3,
			type: "auto",
			contents: {
				highlights: { maxCharacters: 300, query: "what is Pi?" },
				text: { maxCharacters: 200_000 },
			},
		});

		assert.equal(outcome.fromCache, false);
		assert.deepEqual(outcome.providers, ["exa"]);
		const item = outcome.results[0]!;
		assert.equal(item.title, RESULT.title);
		assert.equal(item.snippet, "Pi is a minimal agent harness.\n\nExtensions customize Pi.");
		assert.equal(item.summary, "");
		assert.equal(item.content, RESULT.text);
		assert.equal(item.site_name, "pi.dev");
		assert.equal(item.date, RESULT.publishedDate);
		assert.equal(item.provider, "exa");
		assert.deepEqual(item.providers, ["exa"]);
	} finally {
		await server.close();
	}
});

test("Exa search caches identical requests", async () => {
	let calls = 0;
	const server = await startMockServer((_request, res) => {
		calls += 1;
		json(res, 200, { results: [RESULT] });
	});
	try {
		const client = createExaClient(options(server.url));
		await client.search({ query: "same", count: 2 });
		const cached = await client.search({ query: "same", count: 2 });
		assert.equal(calls, 1);
		assert.equal(cached.fromCache, true);
		assert.equal(cached.source, "cache");
	} finally {
		await server.close();
	}
});

test("Exa contents fetches text and caches the page", async () => {
	const server = await startMockServer((_request, res) =>
		json(res, 200, {
			results: [{ url: "https://example.com/a", title: "Example", text: "Page body" }],
		}),
	);
	try {
		const client = createExaClient(
			options(server.url, { allowPrivateHosts: true, lookup: async () => ["93.184.216.34"] }),
		);
		const first = await client.fetchPage("https://example.com/a#section");
		assert.equal(server.requests.length, 1);
		assert.equal(server.requests[0]!.path, "/contents");
		assert.deepEqual(JSON.parse(server.requests[0]!.body), {
			urls: ["https://example.com/a"],
			text: { maxCharacters: 200_000 },
		});
		assert.equal(first.title, "Example");
		assert.equal(first.content, "Page body");
		assert.equal(first.provider, "exa");

		const second = await client.fetchPage("https://example.com/a");
		assert.equal(second.fromCache, true);
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("Exa contents refuses private DNS answers before calling the API", async () => {
	const server = await startMockServer((_request, res) => json(res, 200, { results: [] }));
	try {
		const client = createExaClient(
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

test("Exa auth, quota and malformed responses become typed errors", async () => {
	const unauthorized = await startMockServer((_request, res) =>
		json(res, 401, { error: { message: "invalid key" } }),
	);
	try {
		const client = createExaClient(options(unauthorized.url));
		await assert.rejects(client.search({ query: "x" }), (error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "auth");
			assert.equal(error.status, 401);
			return true;
		});
	} finally {
		await unauthorized.close();
	}

	const quota = await startMockServer((_request, res) =>
		json(res, 402, { error: { message: "out of credits" } }),
	);
	try {
		const client = createExaClient(options(quota.url));
		await assert.rejects(client.search({ query: "x" }), (error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "rate_limit");
			assert.equal(error.status, 402);
			assert.equal(error.retryable, false);
			return true;
		});
	} finally {
		await quota.close();
	}

	const malformed = await startMockServer((_request, res) => json(res, 200, { results: "nope" }));
	try {
		const client = createExaClient(options(malformed.url));
		await assert.rejects(client.search({ query: "x" }), (error: unknown) => {
			assert.ok(error instanceof WebToolError);
			assert.equal(error.kind, "invalid_response");
			return true;
		});
	} finally {
		await malformed.close();
	}
});

test("Exa response parsers tolerate partial records and report missing content", () => {
	const results = parseExaSearchResponse({
		results: [
			{ url: "https://a.example/" },
			{ title: "no url" },
			{ url: "https://b.example/", title: "B", highlights: ["hint", 3] },
		],
	});
	assert.equal(results.length, 2);
	assert.equal(results[0]!.title, "https://a.example/");
	assert.equal(results[0]!.snippet, "");
	assert.equal(results[1]!.snippet, "hint");
	assert.deepEqual(results[1]!.providers, ["exa"]);

	assert.throws(
		() => parseExaContentsResponse({ results: [] }, "https://a.example/"),
		/no content/,
	);
	assert.throws(
		() =>
			parseExaContentsResponse(
				{ results: [{ url: "https://a.example/", title: "A", text: "   " }] },
				"https://a.example/",
			),
		/empty content/,
	);
});
