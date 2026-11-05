import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import type { DeepSeekClient, SearchInput } from "../src/deepseek.ts";
import { registerWebTools } from "../src/tools.ts";

test("real Pi validates Search arguments and exposes both tools directly and through codemode", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-search-schema-"));
	const agentDir = join(cwd, "agent");
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const searches: SearchInput[] = [];
	const fetches: string[] = [];
	const client: DeepSeekClient = {
		search: async (input) => {
			searches.push(input);
			return { results: [], fromCache: false, source: "network", durationMs: 0 };
		},
		fetchPage: async (url) => {
			fetches.push(url);
			return { url, title: "Fixture", content: "Body", fromCache: false, source: "network", durationMs: 0 };
		},
		searchCache: {} as never,
		fetchCache: {} as never,
	};
	const settingsManager = SettingsManager.inMemory({
		defaultTools: ["+codemode"],
		retry: { enabled: false },
		compaction: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [
			createCodemodeExtension({ mode: "on" }),
			(pi) =>
				registerWebTools(pi, {
					config: loadConfig({ DEEPSEEK_API_KEY: "fixture" }),
					getClients: async () => ({ deepseek: client }),
				}),
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader: loader,
		sessionManager: manager,
	});
	t.after(async () => {
		await session.abort();
		session.dispose();
	});
	await session.bindExtensions({});
	for (const name of ["web_search", "web_fetch"]) {
		assert.ok(session.getActiveToolNames().includes(name), `${name} is directly declared`);
		assert.ok(session.getCallableToolNames().includes(name), `${name} is callable by codemode`);
	}
	// Seed the issuing call so the real nested-tool pipeline can run without a model.
	manager.appendMessage({
		role: "assistant",
		api: "openai-completions",
		provider: "fixture",
		model: "offline",
		content: [
			{ type: "toolCall", id: "schema-test", name: "web_search", arguments: {} },
			{ type: "toolCall", id: "codemode-test", name: "codemode", arguments: {} },
		],
		stopReason: "toolUse",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	// Mirror the authoritative projection into the agent before creating a tool context.
	session.agent.state.messages = manager.buildSessionProjection().messages;
	const ctx = session.extensionRunner.createToolContext("schema-test", AbortSignal.timeout(10000));
	for (const input of [
		{ query: "" },
		{ query: "Pi", count: 51 },
		{ query: "Pi", provider: "unknown" },
		{ query: "Pi", unexpected: true },
	]) {
		const outcome = await ctx.executeTool("web_search", input);
		assert.equal(outcome.isError, true);
		assert.equal(outcome.durationMs, undefined, "validation rejects before execution");
	}
	assert.equal(searches.length, 0);
	const valid = await ctx.executeTool("web_search", {
		query: "Pi",
		count: "2",
		need_content: "true",
		provider: "deepseek",
	});
	assert.equal(valid.isError, false, JSON.stringify(valid.result));
	assert.equal(searches.length, 1);
	assert.equal(searches[0]!.count, 2);
	assert.equal(searches[0]!.need_content, true);
	const invalidFetch = await ctx.executeTool("web_fetch", { url: "https://example.com", provider: "both" });
	assert.equal(invalidFetch.isError, true);
	assert.deepEqual(fetches, []);
	const fetched = await ctx.executeTool("web_fetch", { url: "https://example.com", provider: "deepseek" });
	assert.equal(fetched.isError, false);
	assert.deepEqual(fetches, ["https://example.com"]);
	const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
	assert.ok(codemode);
	const scripted = await codemode.execute("codemode-test", {
		code: 'text(await tools.web_search({query: "Pi codemode", provider: "deepseek"})); text(await tools.web_fetch({url: "https://example.com/codemode", provider: "deepseek"}));',
	}, AbortSignal.timeout(10000));
	assert.notEqual(scripted.isError, true, JSON.stringify(scripted));
	assert.equal(searches.at(-1)?.query, "Pi codemode");
	assert.equal(fetches.at(-1), "https://example.com/codemode");
	assert.match(JSON.stringify(scripted.content), /Body/);
});
