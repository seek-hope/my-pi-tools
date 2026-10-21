import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { runCommand, type RunResult } from "../src/runner.ts";

async function cleanup(result: RunResult) {
  await rm(dirname(result.logPath), { recursive: true, force: true });
}

test("runs without a shell, preserves argv, sets child defaults and captures both streams", async () => {
  const dangerousArgument = "; echo SHOULD_NOT_EXECUTE $(pwd)";
  const result = await runCommand(process.execPath, ["-e", `
    console.log(JSON.stringify({argv:process.argv[1], telemetry:process.env.CODEGRAPH_TELEMETRY, dedup:process.env.CODEGRAPH_EXPLORE_DEDUP}));
    console.error("stderr marker");
  `, dangerousArgument], { cwd: process.cwd(), timeoutMs: 5000 });
  try {
    assert.equal(result.code, 0);
    assert.match(result.output, /stderr marker/);
    assert.match(result.output, /"telemetry":"0"/);
    assert.match(result.output, /"dedup":"0"/);
    assert.ok(result.output.includes(dangerousArgument));
    if (process.platform !== "win32") assert.equal((await stat(result.logPath)).mode & 0o777, 0o600);
  } finally { await cleanup(result); }
});

test("large output is bounded but complete in the private log", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    console.log("START" + "x".repeat(100000));
    console.log("\\x1b[31mEND\\x1b[0m");
  `], { cwd: process.cwd(), timeoutMs: 5000 });
  try {
    assert.ok(result.output.length < 12_200);
    assert.match(result.output, /Earlier output omitted/);
    assert.ok(result.output.endsWith("END"));
    assert.equal(result.output.includes("\x1b"), false);
    const full = await readFile(result.logPath, "utf8");
    assert.ok(full.startsWith("START"));
    assert.ok(full.length > 100_000);
  } finally { await cleanup(result); }
});

test("nonzero exit status is preserved", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exitCode = 7"], { cwd: process.cwd(), timeoutMs: 5000 });
  try { assert.equal(result.code, 7); } finally { await cleanup(result); }
});

test("missing executable gives install guidance", async () => {
  await assert.rejects(
    runCommand("/no-such-codegraph-binary", [], { cwd: process.cwd(), timeoutMs: 5000 }),
    /Install @colbymchenry\/codegraph/,
  );
});

test("timeout terminates a command that would otherwise never end", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeoutMs: 150 }),
    /timed out/,
  );
});

test("abort terminates in-flight work and pre-aborted work never starts", async () => {
  const controller = new AbortController();
  const running = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), timeoutMs: 5000, signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(running, /cancelled/); } finally { clearTimeout(timer); }
  await assert.rejects(runCommand(process.execPath, [], {
    cwd: process.cwd(), timeoutMs: 5000, signal: AbortSignal.abort(),
  }), { name: "AbortError" });
});
