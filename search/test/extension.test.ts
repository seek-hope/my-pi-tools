import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.ts";

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown; isError?: boolean }>;
}

test("extension loads without credentials and registers both tools", async () => {
	const previousKey = process.env.DEEPSEEK_API_KEY;
	const previousExaKey = process.env.EXA_API_KEY;
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.EXA_API_KEY;
	process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-deepseek-ext-"));

	try {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool: (tool: unknown) => {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;

		// Loading must not require a key; the error is deferred to the call.
		extension(pi);
		assert.deepEqual(
			tools.map((tool) => tool.name),
			["web_search", "web_fetch"],
		);

		const result = await tools[0]!.execute("call-1", { query: "anything" });
		assert.equal(result.isError, true);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /No web search API key found/);
		assert.match(text, /DEEPSEEK_API_KEY/);
		assert.match(text, /EXA_API_KEY/);
	} finally {
		if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousKey;
		if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = previousExaKey;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	}
});

test("a changed API key replaces the cached client", async () => {
	const previousKey = process.env.DEEPSEEK_API_KEY;
	const previousExaKey = process.env.EXA_API_KEY;
	const previousRetries = process.env.DEEPSEEK_SEARCH_MAX_RETRIES;
	const previousFetch = globalThis.fetch;
	delete process.env.EXA_API_KEY;
	process.env.DEEPSEEK_API_KEY = "old-key";
	process.env.DEEPSEEK_SEARCH_MAX_RETRIES = "0";
	const headers: string[] = [];
	globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
		const init = args[1];
		headers.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(JSON.stringify({ error: { message: "revoked" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	try {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool: (tool: unknown) => {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;
		extension(pi);

		await tools[0]!.execute("call-1", { query: "first" });
		process.env.DEEPSEEK_API_KEY = "new-key";
		await tools[0]!.execute("call-2", { query: "second" });

		assert.deepEqual(headers, ["Bearer old-key", "Bearer new-key"]);
	} finally {
		if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousKey;
		if (previousExaKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = previousExaKey;
		if (previousRetries === undefined) delete process.env.DEEPSEEK_SEARCH_MAX_RETRIES;
		else process.env.DEEPSEEK_SEARCH_MAX_RETRIES = previousRetries;
		globalThis.fetch = previousFetch;
	}
});
