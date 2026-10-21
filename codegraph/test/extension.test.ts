import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCodegraph } from "../src/index.ts";
import type { Runner, RunResult } from "../src/runner.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Message = Parameters<ExtensionAPI["sendMessage"]>[0];
type Hook = (event: never) => unknown;
const result: RunResult = { code: 0, output: "ok", logPath: "/tmp/example.log" };

function harness(run: Runner = async () => result, env: NodeJS.ProcessEnv = {}) {
  const messages: Message[] = [];
  const servers: unknown[] = [];
  const hooks = new Map<string, Hook>();
  const tools: Array<{ name: string; exposure: string }> = [];
  let command: Command | undefined;
  let runs = 0;
  const calls: Array<Parameters<Runner>> = [];
  const api = {
    registerMcpServer: (name: string, config: unknown) => servers.push({ name, config }),
    registerCommand: (_name: string, options: Command) => { command = options; },
    on: (event: string, handler: Hook) => hooks.set(event, handler),
    getAllTools: () => tools,
    sendMessage: (message: Message, options: { triggerTurn?: boolean }) => {
      assert.equal(options.triggerTurn, false);
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  registerCodegraph(api, { env, run: async (...args) => {
    runs++;
    calls.push(args);
    return run(...args);
  } });
  const context = {
    cwd: "/workspace/project with spaces",
    hasUI: false,
    waitForIdle: async () => {},
    ui: { notify: () => { throw new Error("No UI in this context"); } },
  } as unknown as ExtensionCommandContext;
  return {
    messages, servers, tools, calls, context,
    runs: () => runs,
    command: command!,
    invoke: (args: string) => command!.handler(args, context),
    emit: (name: string, event: unknown = {}) => hooks.get(name)?.(event as never),
  };
}

test("loading only registers the server/command; no subprocess or automatic init", async () => {
  const h = harness();
  assert.equal(h.servers.length, 1);
  assert.equal(h.runs(), 0);
  assert.deepEqual((await h.command.getArgumentCompletions?.("s"))?.map((item) => item.value), ["status", "sync"]);
  assert.equal(await h.command.getArgumentCompletions?.("bad"), null);
});

test("missing native MCP API reports an actionable compatibility error", () => {
  assert.throws(() => registerCodegraph({} as ExtensionAPI), /native registerMcpServer/);
});

test("status works without UI and uses the session cwd, not process cwd", async () => {
  const h = harness();
  await h.invoke("");
  assert.deepEqual(h.calls[0]?.[1], ["status", "--json", h.context.cwd]);
  assert.equal(h.calls[0]?.[2].cwd, h.context.cwd);
  assert.equal(h.messages.length, 1);
  assert.match(String(h.messages[0]?.content), /Exit code: 0/);
});

test("init is explicit, non-interactive, bounded and never uses --force or install", async () => {
  const h = harness(undefined, { PI_CODEGRAPH_PROJECT: "../target" });
  await h.invoke("init");
  assert.deepEqual(h.calls[0]?.[1], ["init", "--yes", "/workspace/target"]);
  assert.equal(h.calls[0]?.[2].timeoutMs, 900_000);
  await h.invoke("sync");
  assert.deepEqual(h.calls[1]?.[1], ["sync", "/workspace/target"]);
});

test("help, malformed commands and arbitrary flags never reach a shell", async () => {
  const h = harness();
  await h.invoke("help");
  await h.invoke("init --force");
  await h.invoke("init; touch injected");
  assert.equal(h.runs(), 0);
  assert.match(String(h.messages[1]?.content), /Unknown/);
});

test("doctor distinguishes CLI availability from MCP connectivity and overrides", async () => {
  const h = harness();
  await h.invoke("doctor");
  assert.deepEqual(h.calls[0]?.[1], ["--version"]);
  const content = String(h.messages[0]?.content);
  assert.match(content, /\(none yet\)/);
  assert.match(content, /does not prove MCP connectivity/);
  assert.match(content, /mcp.json/);
});

test("nonzero exit and exceptions are surfaced, and a later command can retry", async () => {
  let count = 0;
  const h = harness(async () => {
    count++;
    if (count === 1) return { ...result, code: 3, output: "locked" };
    if (count === 2) throw new Error("missing executable");
    return result;
  });
  await h.invoke("sync");
  assert.deepEqual(h.messages[0]?.details, { isError: true });
  assert.match(String(h.messages[0]?.content), /locked/);
  await h.invoke("status");
  assert.match(String(h.messages[1]?.content), /missing executable/);
  await h.invoke("status");
  assert.deepEqual(h.messages[2]?.details, { isError: false });
});

test("commands serialize and shutdown cancels/awaits an in-flight command", async () => {
  const h = harness(async (_command, _args, { signal }) => {
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const first = h.invoke("status");
  await h.invoke("sync");
  assert.equal(h.runs(), 1);
  assert.match(String(h.messages[0]?.content), /already running/);
  await h.emit("session_shutdown");
  await first;
  assert.equal(h.calls[0]?.[2].signal?.aborted, true);
  assert.equal(h.messages.length, 1, "old contexts must not send messages after shutdown");
});

test("a new session gets a fresh cancellation signal", async () => {
  const h = harness();
  await h.emit("session_shutdown");
  await h.emit("session_start");
  await h.invoke("status");
  assert.equal(h.calls[0]?.[2].signal?.aborted, false);
});

test("guidelines preserve existing prompt text, do not duplicate, and skip hidden tools", () => {
  const h = harness();
  const event = { systemPromptOptions: { promptGuidelines: ["existing rule"] } };
  h.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, ["existing rule"]);
  h.tools.push({ name: "mcp__codegraph__codegraph_explore", exposure: "hidden" });
  h.emit("before_agent_start", event);
  assert.equal(event.systemPromptOptions.promptGuidelines.length, 1);
  h.tools[0]!.exposure = "codemode";
  h.emit("before_agent_start", event);
  h.emit("before_agent_start", event);
  assert.equal(event.systemPromptOptions.promptGuidelines.length, 2);
  assert.equal(event.systemPromptOptions.promptGuidelines[0], "existing rule");
  assert.match(event.systemPromptOptions.promptGuidelines[1]!, /stale-source/);

  // Withdraw the guidance when CodeGraph is no longer reachable.
  h.tools[0]!.exposure = "hidden";
  h.emit("before_agent_start", event);
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, ["existing rule"]);
});
