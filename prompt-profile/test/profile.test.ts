import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import profile, { ROLE } from "../src/index.ts";

for (const mode of ["default", "custom", "forced"] as const) {
  test(`real Pi preserves tools/context and respects ${mode} prompt composition`, { timeout: 15000 }, async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-profile-"));
    const agentDir = join(cwd, "agent");
    const file = join(cwd, "sample.txt");
    const skill = join(cwd, "SKILL.md");
    writeFileSync(skill, "---\nname: fixture-skill\ndescription: a research skill\n---\nResearch instructions.\n");
    writeFileSync(file, "fixture evidence\n");
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false });
    let calls = 0;
    models.registerProvider("profile-fixture", {
      api: "openai-completions", apiKey: "offline", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple() {
        const stream = createAssistantMessageEventStream();
        const read = calls++ === 0;
        const message: AssistantMessage = {
          role: "assistant", api: "openai-completions", provider: "profile-fixture", model: "offline", timestamp: Date.now(),
          content: read ? [{ type: "toolCall", id: "fixture-read", name: "read", arguments: { path: file } }] : [{ type: "text", text: "ok" }],
          stopReason: read ? "toolUse" : "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: read ? "toolUse" : "stop", message });
        stream.end();
        return stream;
      },
    });
    const setup = (pi: ExtensionAPI) => pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.other_extension = "keep this section";
      if (mode === "forced") event.systemPromptOptions.forceSystemPrompt = "explicit opaque prompt";
    });
    // This handler runs after the profile: its tool rules must still be included.
    const prompts: string[] = [];
    const late = (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.promptGuidelines.push("late permission rule");
      });
      pi.on("agent_start", (_event, ctx) => { prompts.push(ctx.getSystemPrompt()); });
    };
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => mode === "custom" ? "explicit user identity" : undefined,
      appendSystemPromptOverride: () => ["keep appended instructions"],
      agentsFilesOverride: () => ({ agentsFiles: [{ path: join(cwd, "AGENTS.md"), content: "keep project constraints" }] }),
      additionalSkillPaths: [skill],
      extensionFactories: [setup, profile, late],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const errors: unknown[] = [];
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: models, model: models.getModel("profile-fixture", "offline"), thinkingLevel: "off", resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager: settings });
    t.after(async () => {
      await session.abort();
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      rmSync(cwd, { recursive: true, force: true });
    });
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
    await session.prompt("Read the fixture.");
    assert.deepEqual(errors, []);
    const readResult = session.messages.find(m => m.role === "toolResult" && m.toolName === "read");
    assert.ok(readResult && readResult.role === "toolResult");
    assert.equal(readResult.isError, false);
    assert.match(JSON.stringify(readResult.content), /fixture evidence/);
    const prompt = prompts[0]!;
    assert.ok(prompt);
    await session.prompt("Second turn.");
    assert.equal(prompts[1], prompt, "profile must not accumulate duplicate sections or rules");
    assert.deepEqual(session.getActiveToolNames().sort(), ["bash", "edit", "read", "write"]);
    if (mode === "forced") {
      assert.equal(prompt, "explicit opaque prompt");
    } else {
      for (const expected of ["keep project constraints", "keep appended instructions", "keep this section", "fixture-skill", "<response_style>"]) assert.ok(prompt.includes(expected), expected);
      if (mode === "default") {
        assert.ok(prompt.includes(ROLE));
        for (const expected of ["<tools>", "<rules>", "late permission rule", "<working_principles>", "<docs>"]) assert.ok(prompt.includes(expected), expected);
      } else {
        assert.ok(prompt.startsWith("explicit user identity"));
        assert.ok(!prompt.includes(ROLE));
        assert.ok(!prompt.includes("<docs>"));
      }
    }
    const callsBeforeCommand = calls;
    await session.prompt("/response-style");
    await session.prompt("/prompt-profile");
    assert.equal(calls, callsBeforeCommand, "inspection commands must not call a model");
  });
}
