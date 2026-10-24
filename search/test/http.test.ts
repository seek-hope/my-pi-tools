import assert from "node:assert/strict";
import test from "node:test";

import { WebToolError } from "../src/errors.ts";
import {
	classifyHttpError,
	computeRetryDelay,
	parseRetryAfter,
	postJson,
	type PostJsonOptions,
} from "../src/http.ts";
import { delay, json, startMockServer } from "./helpers.ts";

function options(overrides: Partial<PostJsonOptions> = {}): PostJsonOptions {
	return {
		apiKey: "test-key",
		timeoutMs: 2_000,
		maxRetries: 0,
		retryBaseDelayMs: 5,
		retryMaxDelayMs: 20,
		maxResponseBytes: 64 * 1024,
		userAgent: "pi-deepseek-web-test",
		sleep: async () => {},
		...overrides,
	};
}

async function rejection(promise: Promise<unknown>): Promise<WebToolError> {
	try {
		await promise;
	} catch (error) {
		assert.ok(error instanceof WebToolError, `expected WebToolError, got ${String(error)}`);
		return error;
	}
	throw new Error("expected the promise to reject");
}

test("postJson sends JSON, auth and user agent, then parses the response", async () => {
	const server = await startMockServer((_request, res) => json(res, 200, { ok: true, value: 42 }));
	try {
		const result = await postJson<{ ok: boolean; value: number }>(
			`${server.url}/v1/tools/search`,
			{ query: "hello" },
			options(),
		);
		assert.deepEqual(result, { ok: true, value: 42 });
		assert.equal(server.requests.length, 1);
		const request = server.requests[0]!;
		assert.equal(request.path, "/v1/tools/search");
		assert.equal(request.headers.authorization, "Bearer test-key");
		assert.equal(request.headers["content-type"], "application/json");
		assert.equal(request.headers["user-agent"], "pi-deepseek-web-test");
		assert.deepEqual(JSON.parse(request.body), { query: "hello" });
	} finally {
		await server.close();
	}
});

test("postJson retries 429 with Retry-After before succeeding", async () => {
	let calls = 0;
	const server = await startMockServer((_request, res) => {
		calls += 1;
		if (calls === 1) {
			json(res, 429, { error: { message: "slow down", code: "rate_limit" } }, { "retry-after": "0" });
			return;
		}
		json(res, 200, { ok: true });
	});
	try {
		const result = await postJson<{ ok: boolean }>(
			`${server.url}/v1/tools/search`,
			{},
			options({ maxRetries: 1 }),
		);
		assert.equal(result.ok, true);
		assert.equal(server.requests.length, 2);
	} finally {
		await server.close();
	}
});

test("postJson retries 5xx and surfaces a retryable error when exhausted", async () => {
	const server = await startMockServer((_request, res) =>
		json(res, 503, { error: { message: "upstream unavailable" } }),
	);
	try {
		const error = await rejection(
			postJson(`${server.url}/v1/tools/search`, {}, options({ maxRetries: 1 })),
		);
		assert.equal(error.kind, "http");
		assert.equal(error.status, 503);
		assert.equal(error.retryable, true);
		assert.match(error.message, /upstream unavailable/);
		assert.equal(server.requests.length, 2);
	} finally {
		await server.close();
	}
});

test("postJson does not retry non-retryable 4xx errors", async () => {
	const server = await startMockServer((_request, res) =>
		json(res, 400, { error: { message: "query too long", code: "invalid_request_error" } }),
	);
	try {
		const error = await rejection(
			postJson(`${server.url}/v1/tools/search`, {}, options({ maxRetries: 3 })),
		);
		assert.equal(error.kind, "invalid_input");
		assert.equal(error.status, 400);
		assert.match(error.message, /query too long/);
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("postJson maps 401 to an auth error with a hint", async () => {
	const server = await startMockServer((_request, res) =>
		json(res, 401, { error: { message: "invalid api key" } }),
	);
	try {
		const error = await rejection(postJson(`${server.url}/v1/tools/search`, {}, options()));
		assert.equal(error.kind, "auth");
		assert.match(error.hint ?? "", /DEEPSEEK_API_KEY/);
	} finally {
		await server.close();
	}
});

test("postJson times out slow responses", async () => {
	const server = await startMockServer(async (_request, res) => {
		await delay(150);
		json(res, 200, { ok: true });
	});
	try {
		const error = await rejection(
			postJson(`${server.url}/v1/tools/search`, {}, options({ timeoutMs: 40 })),
		);
		assert.equal(error.kind, "timeout");
		assert.equal(error.retryable, true);
	} finally {
		await server.close();
	}
});

test("postJson propagates caller cancellation without retrying", async () => {
	const server = await startMockServer(async (_request, res) => {
		await delay(200);
		json(res, 200, { ok: true });
	});
	try {
		const controller = new AbortController();
		const pending = postJson(`${server.url}/v1/tools/search`, {}, options({ maxRetries: 2 }), controller.signal);
		setTimeout(() => controller.abort(), 20);
		const error = await rejection(pending);
		assert.equal(error.kind, "aborted");
		assert.equal(server.requests.length, 1);
	} finally {
		await server.close();
	}
});

test("postJson rejects malformed JSON and oversized bodies", async () => {
	const malformed = await startMockServer((_request, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{not json");
	});
	try {
		const error = await rejection(postJson(`${malformed.url}/v1/tools/search`, {}, options()));
		assert.equal(error.kind, "invalid_response");
	} finally {
		await malformed.close();
	}

	const oversized = await startMockServer((_request, res) => json(res, 200, { data: "x".repeat(5_000) }));
	try {
		const error = await rejection(
			postJson(`${oversized.url}/v1/tools/search`, {}, options({ maxResponseBytes: 1_000 })),
		);
		assert.equal(error.kind, "invalid_response");
		assert.match(error.message, /exceeded 1000 bytes/);
	} finally {
		await oversized.close();
	}
});

test("postJson cancels redirect response bodies instead of leaving streams open", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
	const error = await rejection(postJson("https://api.example.com/search", {}, options({
		fetchImpl: async () => new Response(body, { status: 302, headers: { location: "https://other.example.com/" } }),
	})));
	assert.equal(error.status, 302);
	assert.equal(cancelled, true);
});

test("parseRetryAfter understands seconds, HTTP dates and junk", () => {
	assert.equal(parseRetryAfter("3"), 3_000);
	assert.equal(parseRetryAfter(" 0 "), 0);
	assert.equal(parseRetryAfter(null), null);
	assert.equal(parseRetryAfter("soon"), null);
	const now = Date.parse("2026-01-01T00:00:00Z");
	assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now), 5_000);
	assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now + 10_000), 0);
});

test("computeRetryDelay grows exponentially and respects the cap", () => {
	assert.equal(computeRetryDelay(0, null, 100, 5_000, () => 0), 100);
	assert.equal(computeRetryDelay(1, null, 100, 5_000, () => 0), 200);
	assert.equal(computeRetryDelay(2, null, 100, 5_000, () => 0), 400);
	assert.equal(computeRetryDelay(10, null, 100, 5_000, () => 0), 5_000);
	assert.equal(computeRetryDelay(0, 2_000, 100, 5_000, () => 0), 2_000);
	assert.equal(computeRetryDelay(0, 60_000, 100, 5_000, () => 0), 5_000);
});

test("classifyHttpError maps every documented status family", () => {
	assert.equal(classifyHttpError(403, "").kind, "auth");
	assert.equal(classifyHttpError(429, "").retryable, true);
	assert.equal(classifyHttpError(408, "").kind, "timeout");
	assert.equal(classifyHttpError(500, "").retryable, true);
	assert.equal(classifyHttpError(502, "").kind, "http");
	assert.equal(classifyHttpError(422, "").kind, "invalid_input");
	assert.equal(classifyHttpError(418, "").retryable, false);
});
