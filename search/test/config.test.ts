import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentDir, DEFAULTS, loadConfig, resolveApiKey, resolveExaApiKey } from "../src/config.ts";

test("loadConfig provides stable defaults", () => {
	const config = loadConfig({});
	assert.equal(config.baseUrl, DEFAULTS.baseUrl);
	assert.equal(config.apiKey, undefined);
	assert.equal(config.exaBaseUrl, DEFAULTS.exaBaseUrl);
	assert.equal(config.exaSearchType, DEFAULTS.exaSearchType);
	assert.equal(config.exaAllowInsecureBaseUrl, false);
	assert.equal(config.timeoutMs, DEFAULTS.timeoutMs);
	assert.equal(config.maxRetries, DEFAULTS.maxRetries);
	assert.equal(config.searchCacheTtlMs, DEFAULTS.searchCacheTtlMs);
	assert.equal(config.allowPrivateHosts, false);
	assert.equal(config.allowInsecureBaseUrl, false);
	assert.equal(config.spillToTempFile, true);
	assert.equal(config.debug, false);
});

test("loadConfig applies environment overrides and clamps ranges", () => {
	const config = loadConfig({
		DEEPSEEK_SEARCH_BASE_URL: "https://proxy.example.com/",
		DEEPSEEK_API_KEY: "  sk-test  ",
		DEEPSEEK_SEARCH_TIMEOUT_MS: "500",
		DEEPSEEK_SEARCH_MAX_RETRIES: "99",
		DEEPSEEK_SEARCH_CACHE_TTL_MS: "0",
		DEEPSEEK_FETCH_CACHE_MAX: "3",
		DEEPSEEK_WEB_MAX_RESULT_BYTES: "12000",
		DEEPSEEK_WEB_ALLOW_PRIVATE_HOSTS: "yes",
		DEEPSEEK_WEB_SPILL: "off",
		DEEPSEEK_WEB_DEBUG: "1",
		EXA_BASE_URL: "https://exa-proxy.example.com/",
		EXA_SEARCH_TYPE: "deep",
		EXA_WEB_ALLOW_INSECURE_BASE_URL: "1",
	});
	assert.equal(config.baseUrl, "https://proxy.example.com");
	assert.equal(config.apiKey, "sk-test");
	assert.equal(config.exaBaseUrl, "https://exa-proxy.example.com");
	assert.equal(config.exaSearchType, "deep");
	assert.equal(config.exaAllowInsecureBaseUrl, true);
	assert.equal(config.timeoutMs, 1_000);
	assert.equal(config.maxRetries, 5);
	assert.equal(config.searchCacheTtlMs, 0);
	assert.equal(config.fetchCacheMaxEntries, 3);
	assert.equal(config.maxResultBytes, 12_000);
	assert.equal(config.allowPrivateHosts, true);
	assert.equal(config.spillToTempFile, false);
	assert.equal(config.debug, true);
});

test("loadConfig falls back on invalid values instead of throwing", () => {
	const config = loadConfig({
		DEEPSEEK_SEARCH_BASE_URL: "not a url",
		DEEPSEEK_SEARCH_TIMEOUT_MS: "NaN",
		DEEPSEEK_WEB_ALLOW_PRIVATE_HOSTS: "maybe",
	});
	assert.equal(config.baseUrl, DEFAULTS.baseUrl);
	assert.equal(config.timeoutMs, DEFAULTS.timeoutMs);
	assert.equal(config.allowPrivateHosts, false);
});

test("loadConfig requires HTTPS for a remote API base URL unless explicitly allowed", () => {
	assert.equal(
		loadConfig({ DEEPSEEK_SEARCH_BASE_URL: "http://proxy.example.com" }).baseUrl,
		DEFAULTS.baseUrl,
	);
	assert.equal(
		loadConfig({ DEEPSEEK_SEARCH_BASE_URL: "http://127.0.0.1:1234" }).baseUrl,
		"http://127.0.0.1:1234",
	);
	assert.equal(
		loadConfig({ DEEPSEEK_SEARCH_BASE_URL: "http://[::1]:1234" }).baseUrl,
		"http://[::1]:1234",
	);
	assert.equal(
		loadConfig({
			DEEPSEEK_SEARCH_BASE_URL: "http://proxy.example.com",
			DEEPSEEK_WEB_ALLOW_INSECURE_BASE_URL: "1",
		}).baseUrl,
		"http://proxy.example.com",
	);
	assert.equal(
		loadConfig({ DEEPSEEK_SEARCH_BASE_URL: "https://user:pass@proxy.example.com" }).baseUrl,
		DEFAULTS.baseUrl,
	);
});

test("loadConfig applies the same HTTPS guard to Exa", () => {
	assert.equal(loadConfig({ EXA_BASE_URL: "http://proxy.example.com" }).exaBaseUrl, DEFAULTS.exaBaseUrl);
	assert.equal(
		loadConfig({ EXA_BASE_URL: "http://127.0.0.1:1234" }).exaBaseUrl,
		"http://127.0.0.1:1234",
	);
	assert.equal(
		loadConfig({
			EXA_BASE_URL: "http://proxy.example.com",
			EXA_WEB_ALLOW_INSECURE_BASE_URL: "1",
		}).exaBaseUrl,
		"http://proxy.example.com",
	);
});

test("agentDir honors PI_CODING_AGENT_DIR", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
	assert.match(agentDir({}), /\.pi[\\/]agent$/);
});

test("resolveApiKey prefers the environment, then auth.json", async () => {
	assert.equal(resolveApiKey({ DEEPSEEK_API_KEY: "  env-key  " }), "env-key");

	const dir = await mkdtemp(join(tmpdir(), "pi-deepseek-config-"));
	const authPath = join(dir, "auth.json");
	await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "  file-key  " } }), "utf8");
	assert.equal(resolveApiKey({}, authPath), "file-key");
	assert.equal(resolveApiKey({ DEEPSEEK_API_KEY: "env-key" }, authPath), "env-key");

	await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "!security find-key" } }), "utf8");
	assert.equal(resolveApiKey({}, authPath), undefined);

	await writeFile(authPath, "{ not json", "utf8");
	assert.equal(resolveApiKey({}, authPath), undefined);

	assert.equal(resolveApiKey({}, join(dir, "missing.json")), undefined);
});

test("resolveApiKey reads Pi's agent directory through the environment", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-deepseek-agent-"));
	await writeFile(
		join(dir, "auth.json"),
		JSON.stringify({ deepseek: { type: "api_key", key: "agent-dir-key" } }),
		"utf8",
	);
	assert.equal(resolveApiKey({ PI_CODING_AGENT_DIR: dir }), "agent-dir-key");
});

test("resolveExaApiKey prefers the environment, then auth.json", async () => {
	assert.equal(resolveExaApiKey({ EXA_API_KEY: "  exa-env  " }), "exa-env");

	const dir = await mkdtemp(join(tmpdir(), "pi-exa-config-"));
	const authPath = join(dir, "auth.json");
	await writeFile(authPath, JSON.stringify({ exa: { type: "api_key", key: "  exa-file  " } }), "utf8");
	assert.equal(resolveExaApiKey({}, authPath), "exa-file");
	assert.equal(resolveExaApiKey({ EXA_API_KEY: "exa-env" }, authPath), "exa-env");

	await writeFile(authPath, JSON.stringify({ exa: { type: "api_key", key: "!security find-key" } }), "utf8");
	assert.equal(resolveExaApiKey({}, authPath), undefined);
	assert.equal(resolveExaApiKey({}, join(dir, "missing.json")), undefined);
});
