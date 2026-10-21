import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { CHILD_ENV, loadConfig, projectPath, serverConfig } from "../src/config.ts";

test("defaults register a session-relative native MCP server, without indexing", () => {
  const config = loadConfig({});
  assert.equal(config.exposure, "codemode");
  assert.equal(config.commandTimeoutMs, 900_000);
  const server = serverConfig(config);
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.args, ["serve", "--mcp", "--path", "."]);
  assert.equal(server.timeout, 120);
  assert.deepEqual(server.env, CHILD_ENV);
  assert.equal(projectPath(config, "/session/work"), resolve("/session/work"));
});

test("configuration supports spaces, home expansion, relative projects and no-watch", () => {
  const config = loadConfig({
    PI_CODEGRAPH_COMMAND: "~/tools with spaces/codegraph",
    PI_CODEGRAPH_PROJECT: "../another project",
    PI_CODEGRAPH_EXPOSURE: "direct",
    PI_CODEGRAPH_WATCH: "0",
    PI_CODEGRAPH_TIMEOUT: "30",
    PI_CODEGRAPH_COMMAND_TIMEOUT: "1800",
  });
  assert.equal(config.command, resolve(homedir(), "tools with spaces/codegraph"));
  assert.equal(projectPath(config, "/session/work"), resolve("/session/another project"));
  assert.equal(config.commandTimeoutMs, 1_800_000);
  assert.equal(serverConfig(config).exposure, "direct");
  assert.equal(serverConfig(config).args.at(-1), "--no-watch");
  assert.equal(loadConfig({ PI_CODEGRAPH_PROJECT: "~" }).project, homedir());
});

test("accepts every documented exposure and forwards it to the MCP server", () => {
  for (const exposure of ["codemode", "direct", "deferred", "hidden"] as const) {
    const config = loadConfig({ PI_CODEGRAPH_EXPOSURE: exposure });
    assert.equal(config.exposure, exposure);
    assert.equal(serverConfig(config).exposure, exposure);
  }
});

for (const [key, value] of [
  ["PI_CODEGRAPH_EXPOSURE", "unknown"],
  ["PI_CODEGRAPH_WATCH", "true"],
  ["PI_CODEGRAPH_COMMAND", "npx -y codegraph"],
  ["PI_CODEGRAPH_COMMAND", "./bin/codegraph"],
  ["PI_CODEGRAPH_PROJECT", ""],
  ["PI_CODEGRAPH_PROJECT", "foo\nbar"],
  ["PI_CODEGRAPH_PROJECT", "foo\0bar"],
  ["PI_CODEGRAPH_TIMEOUT", "0"],
  ["PI_CODEGRAPH_TIMEOUT", "1.5"],
  ["PI_CODEGRAPH_TIMEOUT", "Infinity"],
  ["PI_CODEGRAPH_TIMEOUT", "3601"],
  ["PI_CODEGRAPH_COMMAND_TIMEOUT", "86401"],
] as const) {
  test(`reject invalid ${key}=${JSON.stringify(value)}`, () => {
    assert.throws(() => loadConfig({ [key]: value }), new RegExp(key));
  });
}

test("child defaults do not mutate the environment or leak shared config objects", () => {
  const env = { CODEGRAPH_TELEMETRY: "1" };
  const a = serverConfig(loadConfig(env));
  a.env.CODEGRAPH_TELEMETRY = "changed";
  assert.equal(serverConfig(loadConfig({})).env.CODEGRAPH_TELEMETRY, "0");
  assert.deepEqual(env, { CODEGRAPH_TELEMETRY: "1" });
});
