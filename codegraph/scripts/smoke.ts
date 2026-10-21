import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Real Pi -> native MCP -> installed CodeGraph. No model calls or API keys.
// Isolate settings/index/home and disable daemon sharing so no background daemon
// or personal CodeGraph configuration survives this test.
const root = await mkdtemp(join(tmpdir(), "pi-codegraph-smoke-"));
const cwd = join(root, "project with spaces");
const agentDir = join(root, "agent");
const home = join(root, "home");
await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(home)]);
const overrides: NodeJS.ProcessEnv = {
  HOME: home,
  USERPROFILE: home,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODEGRAPH_PROJECT: ".",
  PI_CODEGRAPH_EXPOSURE: "codemode",
  PI_CODEGRAPH_WATCH: "1",
  CODEGRAPH_NO_DAEMON: "1",
  CODEGRAPH_NO_WATCH: "0",
  CODEGRAPH_MCP_TOOLS: "explore",
  CODEGRAPH_TELEMETRY: "0",
  CODEGRAPH_NO_UPDATE_CHECK: "1",
};
const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, overrides);
const logs = new Set<string>();
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

function text(content: Array<{ type: string; text?: string }>): string {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

try {
  await writeFile(join(cwd, "math.ts"), "export function greet(name: string) { return 'before-' + name; }\n");
  await writeFile(join(cwd, "main.ts"), "import { greet } from './math';\nexport function welcome() { return greet('Pi'); }\n");
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts")],
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }), logPath: join(agentDir, "mcp.log") }),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  ({ session } = await createAgentSession({
    cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime,
    sessionManager: SessionManager.inMemory(cwd),
  }));
  const errors: string[] = [];
  session.extensionRunner.onError((error) => errors.push(error.error));
  await session.bindExtensions({});

  const command = async (action: string): Promise<string> => {
    const count = session!.messages.length;
    await session!.prompt(`/codegraph ${action}`);
    const message = session!.messages.slice(count).find((item) => item.role === "custom" && item.customType === "codegraph");
    assert.ok(message && message.role === "custom");
    const content = typeof message.content === "string" ? message.content : text(message.content);
    const log = /\nLog: (.+)/.exec(content)?.[1];
    if (log) logs.add(log);
    assert.notEqual((message.details as { isError?: boolean })?.isError, true, content);
    return content;
  };
  assert.match(await command("doctor"), /\n\d+\.\d+\.\d+\n/);
  assert.match(await command("status"), /"initialized":\s*false/);
  await assert.rejects(access(join(cwd, ".codegraph")), "Loading and status must not create an index");

  await command("init");
  assert.match(await command("status"), /"initialized":\s*true/);
  const name = "mcp__codegraph__codegraph_explore";
  for (let i = 0; i < 300 && !session.getAllTools().some((tool) => tool.name === name); i++) await delay(100);
  assert.ok(session.getAllTools().some((tool) => tool.name === name), `Missing MCP tool; errors: ${errors.join("; ")}`);
  assert.ok(session.getCallableToolNames().includes(name));
  assert.ok(!session.getActiveToolNames().includes(name), "default MCP exposure should remain codemode");

  // Seed a deterministic assistant tool-call fixture in the authoritative session
  // history. Nested tools require an issuing assistant message; no LLM is used.
  session.sessionManager.appendMessage({
    role: "assistant", api: "openai-completions", provider: "smoke", model: "fixture",
    content: [{ type: "toolCall", id: "smoke", name: "codemode", arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: Date.now(),
  });
  session.agent.state.messages = session.sessionManager.buildSessionProjection().messages;
  // Call through the real nested-tool pipeline, including hooks and validation.
  const context = session.extensionRunner.createToolContext("smoke", AbortSignal.timeout(60_000));
  const explore = async () => {
    const outcome = await context.executeTool(name, { query: "greet welcome", projectPath: cwd, maxFiles: 5 });
    assert.equal(outcome.isError, false, text(outcome.result.content));
    return text(outcome.result.content);
  };
  const first = await explore();
  assert.match(first, /before-/);
  assert.match(first, /welcome/);

  // Verify codemode discovery and result forwarding, without asking an LLM.
  const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
  assert.ok(codemode);
  const discovered = await codemode.execute("smoke-codemode", {
    code: `text(await searchTools("codegraph", { namespace: "mcp__codegraph" })); text(await tools.${name}({ query: "greet", projectPath: ${JSON.stringify(cwd)} }));`,
  }, AbortSignal.timeout(60_000));
  assert.notEqual(discovered.isError, true, text(discovered.content));
  assert.match(text(discovered.content), /before-/);

  // Refresh the startup-without-index schema and verify the server's default
  // project is the SDK session cwd, even though process.cwd() is this package.
  await session.prompt("/mcp reconnect codegraph");
  const defaultProject = await context.executeTool(name, { query: "greet" });
  assert.equal(defaultProject.isError, false, text(defaultProject.result.content));
  assert.match(text(defaultProject.result.content), /before-/);

  // Exercise the real watcher: no manual sync between the edit and retrieval.
  await writeFile(join(cwd, "math.ts"), "export function greet(name: string) { return 'after-watcher-' + name; }\n");
  let updated = "";
  for (let i = 0; i < 60; i++) {
    await delay(500);
    updated = await explore();
    if (updated.includes("after-watcher-") && !/pending re-index|edited since the last index|changed on disk after/i.test(updated)) break;
  }
  assert.match(updated, /after-watcher-/);
  assert.doesNotMatch(updated, /pending re-index|edited since the last index|changed on disk after/i);
  await command("sync");
  assert.deepEqual(errors, []);
  console.log("PASS: real Pi extension load, CLI status/init, MCP discovery/query, codemode, live sync, and manual sync.");
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  // Collecting logs is optional; all fixtures/indexes and private command logs
  // created by a successful smoke run are deleted, never user project data.
  for (const log of logs) {
    try { await readFile(log); await rm(dirname(log), { recursive: true, force: true }); } catch { /* already removed */ }
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}
