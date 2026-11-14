import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { loadConfig } from "../src/config.ts";
import type { DeepSeekClient, SearchOutcome } from "../src/deepseek.ts";
import { WebToolError } from "../src/errors.ts";
import { registerWebTools } from "../src/tools.ts";

function assistant(
	content: AssistantMessage["content"] | string,
	stopReason: "stop" | "toolUse" = "stop",
): AssistantMessage {
	return {
		role: "assistant" as const,
		api: "openai-completions",
		provider: "search-fixture",
		model: "offline",
		timestamp: Date.now(),
		stopReason,
		content: typeof content === "string" ? [{ type: "text" as const, text: content }] : content,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function call(name: string, args: any, id: string) {
	return { type: "toolCall" as const, name, arguments: args, id };
}

const outcome: SearchOutcome = {
	results: [{
		title: "Pi docs",
		url: "https://pi.dev/docs",
		snippet: "short snippet",
		summary: "structured summary",
		content: "full result body",
		site_name: "pi.dev",
		date: null,
		authority: 3,
		rerank_score: 2,
		provider: "deepseek",
		providers: ["deepseek"],
	}],
	fromCache: false,
	source: "network",
	durationMs: 1,
	providers: ["deepseek"],
};

function client(): DeepSeekClient {
	return {
		search: async (input) => {
			if (input.query === "fail") throw new WebToolError("rate_limit", "slow down", { status: 429, retryable: true });
			return outcome;
		},
		fetchPage: async (url) => ({
			url,
			title: "Fetched page",
			content: "complete fetch body",
			fromCache: false,
			source: "network",
			durationMs: 2,
			provider: "deepseek",
		}),
		searchCache: {} as never,
		fetchCache: {} as never,
	};
}

test("real Pi codemode resolves Search objects, full fetch content and structured errors", { timeout: 20000 }, async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-search-codemode-"));
	const agentDir = join(cwd, "agent");
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const errors: unknown[] = [];
	const toolResults: Array<{ toolName: string; structuredContent?: unknown }> = [];
	t.after(async () => {
		if (session) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		rmSync(cwd, { recursive: true, force: true });
	});

	const models = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
	let calls = 0;
	models.registerProvider("search-fixture", {
		api: "openai-completions",
		apiKey: "offline",
		baseUrl: "http://127.0.0.1:1",
		models: [{
			id: "offline",
			name: "Offline",
			reasoning: false,
			input: ["text"],
			contextWindow: 100000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}],
		streamSimple(_model, _context, _options) {
			const stream = createAssistantMessageEventStream();
			calls++;
			const answer = calls === 1
				? assistant([call("codemode", {
					code: `
const search = await tools.web_search({ query: "pi", need_content: true });
const fetched = await tools.web_fetch({ url: "https://example.com/" });
const failed = await tools.web_search({ query: "fail" });
text({
  searchType: typeof search,
  searchStatus: search.status,
  summary: search.results[0].summary,
  content: search.results[0].content,
  fetchType: typeof fetched,
  fetchContent: fetched.content,
  failedStatus: failed.status,
  failedKind: failed.error.kind,
});
`,
				}, "search-script")], "toolUse")
				: assistant("finished");
			stream.push({ type: "start", partial: answer });
			stream.push({ type: "done", reason: answer.stopReason === "toolUse" ? "toolUse" : "stop", message: answer });
			stream.end();
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		defaultTools: ["+codemode"],
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => "test parent",
		extensionFactories: [
			createCodemodeExtension({ mode: "on" }),
			(pi) => {
				registerWebTools(pi, {
					getClients: async () => ({ deepseek: client() }),
					config: loadConfig({ DEEPSEEK_API_KEY: "offline" }),
				});
				pi.on("tool_result", (event) => {
					if (event.toolName === "web_search" || event.toolName === "web_fetch")
						toolResults.push({ toolName: event.toolName, structuredContent: event.structuredContent });
				});
			},
		],
	});
	await loader.reload();
	({ session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: models,
		model: models.getModel("search-fixture", "offline"),
		thinkingLevel: "off",
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: settings,
	}));
	await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
	await session.prompt("run the fixture script");
	assert.deepEqual(errors, []);
	const result = session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "codemode",
	) as any;
	assert.ok(result, "codemode should produce a result");
	assert.equal(result.isError, false, JSON.stringify(result));
	const payloadText = result.content.filter((block: { type: string; text?: string }) => block.type === "text").at(-1)?.text;
	assert.ok(payloadText, "codemode should return the script's JSON output");
	assert.deepEqual(JSON.parse(payloadText), {
		searchType: "object",
		searchStatus: "ok",
		summary: "structured summary",
		content: "full result body",
		fetchType: "object",
		fetchContent: "complete fetch body",
		failedStatus: "error",
		failedKind: "rate_limit",
	});
	const searchResult = toolResults.find((item) => item.toolName === "web_search");
	assert.equal((searchResult?.structuredContent as any)?.status, "ok");
	const failedResult = toolResults.filter((item) => item.toolName === "web_search").at(-1);
	assert.equal((failedResult?.structuredContent as any)?.status, "error");
});
