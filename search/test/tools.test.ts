import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../src/config.ts";
import type { DeepSeekClient, SearchOutcome } from "../src/deepseek.ts";
import { WebToolError } from "../src/errors.ts";
import { registerWebTools } from "../src/tools.ts";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details: unknown;
	isError?: boolean;
}

interface Rendered {
	render(width: number): string[];
}

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	parameters: { properties?: Record<string, unknown> };
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<ToolResult>;
	renderCall?: (args: Record<string, unknown>, theme: Theme) => Rendered;
	renderResult?: (
		result: ToolResult,
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
	) => Rendered;
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const SEARCH_OUTCOME: SearchOutcome = {
	results: [
		{
			title: "Pi documentation",
			url: "https://pi.dev/docs",
			snippet: "short",
			summary: "Everything about the Pi coding agent.",
			content: "",
			site_name: "pi.dev",
			date: "2026-01-02T03:04:05Z",
			authority: 4,
			rerank_score: 2.9,
		},
	],
	fromCache: false,
	source: "network",
	durationMs: 12,
};

function fakeClient(overrides: Partial<DeepSeekClient> = {}): DeepSeekClient {
	return {
		search: async () => SEARCH_OUTCOME,
		fetchPage: async (url: string) => ({
			url,
			title: "Example",
			content: "Body",
			fromCache: false,
			source: "network" as const,
			durationMs: 3,
		}),
		searchCache: {} as never,
		fetchCache: {} as never,
		...overrides,
	};
}

function captureTools(
	client: DeepSeekClient,
	config = loadConfig({ DEEPSEEK_API_KEY: "test-key" }),
): { tools: CapturedTool[]; byName: (name: string) => CapturedTool } {
	const tools: CapturedTool[] = [];
	const pi = {
		registerTool: (tool: unknown) => {
			tools.push(tool as CapturedTool);
		},
	} as unknown as ExtensionAPI;
	registerWebTools(pi, { getClient: async () => client, config });
	return {
		tools,
		byName: (name) => {
			const tool = tools.find((candidate) => candidate.name === name);
			if (!tool) throw new Error(`tool not registered: ${name}`);
			return tool;
		},
	};
}

test("registers web_search and web_fetch with the documented schema", () => {
	const { tools, byName } = captureTools(fakeClient());
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["web_search", "web_fetch"],
	);
	const search = byName("web_search");
	const searchProps = search.parameters.properties ?? {};
	assert.ok("query" in searchProps);
	assert.ok("count" in searchProps);
	assert.ok("need_content" in searchProps);
	assert.ok("ori_question" in searchProps);
	const fetch = byName("web_fetch");
	assert.ok("url" in (fetch.parameters.properties ?? {}));
	assert.match(search.description, /DeepSeek/);
});

test("web_search executes and returns text plus structured details", async () => {
	const { byName } = captureTools(fakeClient());
	const result = await byName("web_search").execute("call-1", { query: "pi coding agent", count: 3 });
	assert.equal(result.isError, undefined);
	const text = result.content[0]?.text ?? "";
	assert.match(text, /Found 1 result/);
	assert.match(text, /Pi documentation/);
	assert.match(text, /https:\/\/pi\.dev\/docs/);
	assert.match(text, /pi\.dev/);
	assert.match(text, /authority 4/);
	const details = result.details as {
		tool: string;
		resultCount: number;
		query: string;
		results: Array<{ title: string }>;
	};
	assert.equal(details.tool, "web_search");
	assert.equal(details.resultCount, 1);
	assert.equal(details.query, "pi coding agent");
	assert.equal(details.results[0]?.title, "Pi documentation");
});

test("web_search reports typed failures as model-readable text", async () => {
	const failing = fakeClient({
		search: async () => {
			throw new WebToolError("rate_limit", "slow down", { status: 429, retryable: true });
		},
	});
	const { byName } = captureTools(failing);
	const result = await byName("web_search").execute("call-2", { query: "x" });
	assert.equal(result.isError, true);
	const text = result.content[0]?.text ?? "";
	assert.match(text, /web_search failed \[rate_limit\]/);
	assert.match(text, /HTTP 429/);
	assert.match(text, /transient/);
	const details = result.details as { error: { kind: string; retryable: boolean } };
	assert.equal(details.error.kind, "rate_limit");
	assert.equal(details.error.retryable, true);
});

test("web_fetch truncates long pages and spills the full text", async () => {
	const content = `${"paragraph line\n".repeat(400)}THE-END`;
	const client = fakeClient({
		fetchPage: async (url: string) => ({
			url,
			title: "Long page",
			content,
			fromCache: false,
			source: "network" as const,
			durationMs: 4,
		}),
	});
	const config = loadConfig({
		DEEPSEEK_API_KEY: "test-key",
		DEEPSEEK_WEB_MAX_RESULT_BYTES: "1000",
		DEEPSEEK_WEB_MAX_RESULT_LINES: "100",
	});
	const { byName } = captureTools(client, config);
	const result = await byName("web_fetch").execute("call-3", { url: "https://example.com/long" });
	const text = result.content[0]?.text ?? "";
	assert.match(text, /^# Long page/);
	assert.match(text, /page truncated/);
	assert.match(text, /Full content saved to .*web-fetch-/);
	const details = result.details as { truncated: boolean; fullPath: string; bytes: number };
	assert.equal(details.truncated, true);
	assert.ok(details.bytes > 1000);
	const spilled = await readFile(details.fullPath, "utf8");
	assert.match(spilled, /THE-END/);
	assert.match(spilled, /^# Long page/);
});

test("web_fetch surfaces SSRF rejections without fetching", async () => {
	const client = fakeClient({
		fetchPage: async () => {
			throw new WebToolError("blocked_url", 'refusing to fetch internal host "localhost"');
		},
	});
	const { byName } = captureTools(client);
	const result = await byName("web_fetch").execute("call-4", { url: "http://localhost:8080/" });
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /blocked_url/);
	assert.match(result.content[0]?.text ?? "", /internal host/);
});

test("renderers produce text without touching terminal state", () => {
	const { byName } = captureTools(fakeClient());
	const search = byName("web_search");
	const callLines = search.renderCall?.({ query: "hello", need_content: true }, theme).render(80) ?? [];
	assert.match(callLines.join("\n"), /web_search/);
	assert.match(callLines.join("\n"), /hello/);

	const success = search.renderResult?.(
		{
			content: [{ type: "text", text: "..." }],
			details: {
				tool: "web_search",
				query: "hello",
				count: 10,
				needContent: false,
				resultCount: 2,
				fromCache: true,
				truncated: false,
				durationMs: 8,
				results: [
					{ title: "A", url: "https://a.example", site: "a.example", date: null, authority: 0, score: 0 },
					{ title: "B", url: "https://b.example", site: null, date: null, authority: 0, score: 0 },
				],
			},
		},
		{ expanded: true, isPartial: false },
		theme,
	);
	const successLines = success?.render(80) ?? [];
	assert.match(successLines.join("\n"), /2 results/);
	assert.match(successLines.join("\n"), /cached/);
	assert.match(successLines.join("\n"), /A/);

	const partial = search.renderResult?.(
		{ content: [], details: undefined },
		{ expanded: false, isPartial: true },
		theme,
	);
	assert.match((partial?.render(80) ?? []).join("\n"), /searching/);

	const failed = search.renderResult?.(
		{
			content: [],
			details: { error: { kind: "timeout", status: null, retryable: true, message: "too slow" } },
			isError: true,
		},
		{ expanded: false, isPartial: false },
		theme,
	);
	assert.match((failed?.render(80) ?? []).join("\n"), /timeout/);
});
