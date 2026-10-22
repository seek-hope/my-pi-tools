import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, projectPath, serverConfig, SERVER_NAME } from "./config.ts";
import { runCommand, type Runner } from "./runner.ts";

const COMMANDS = ["help", "status", "init", "sync", "doctor"] as const;
const HELP = `CodeGraph commands:
  /codegraph status   Show index status (does not initialize).
  /codegraph init     Create the index in the configured project; may take time.
  /codegraph sync     Manually sync an existing index (normally automatic).
  /codegraph doctor   Show CLI version, project, registration and loaded tools.
  /mcp               Inspect the actual connection / configuration overrides.
  /mcp reconnect codegraph   Reconnect after fixing an error.

Configuration: PI_CODEGRAPH_COMMAND, PI_CODEGRAPH_PROJECT,
PI_CODEGRAPH_EXPOSURE, PI_CODEGRAPH_WATCH, PI_CODEGRAPH_TIMEOUT,
PI_CODEGRAPH_COMMAND_TIMEOUT. See the package README.
No automatic installation, initialization, or global configuration edits.`;

const GUIDANCE = "For indexed code, use mcp__codegraph's codegraph_explore to retrieve relevant source, call paths and change impact before broad file-by-file exploration. In codemode, discover it with searchTools and read describeNamespace('mcp__codegraph') for server instructions. If the project is unindexed or CodeGraph is unavailable, fall back to built-in tools; do not initialize without user authorization. Check stale-source warnings and verify affected files directly when needed; the graph does not replace tests.";

export function registerCodegraph(
  pi: ExtensionAPI,
  dependencies: { env?: NodeJS.ProcessEnv; run?: Runner } = {},
): void {
  if (typeof pi.registerMcpServer !== "function") {
    throw new Error("pi-codegraph requires Pi with native registerMcpServer support (tested on 1.4.0).");
  }
  const config = loadConfig(dependencies.env);
  const run = dependencies.run ?? runCommand;
  // Registration is declarative: Pi owns startup, transport, tool schemas,
  // cancellation, output truncation, reconnect, and MCP client shutdown.
  pi.registerMcpServer(SERVER_NAME, serverConfig(config));

  let shutdown = new AbortController();
  let pending: Promise<void> | undefined;
  pi.on("session_start", () => { shutdown = new AbortController(); });
  pi.on("session_shutdown", async () => {
    shutdown.abort();
    await pending;
  });
  pi.on("before_agent_start", (event) => {
    const available = pi.getAllTools().some((tool) =>
      tool.name.startsWith("mcp__codegraph__") && tool.exposure !== "hidden",
    );
    const guidelines = event.systemPromptOptions.promptGuidelines;
    const index = guidelines.indexOf(GUIDANCE);
    if (available && index === -1) guidelines.push(GUIDANCE);
    else if (!available && index !== -1) guidelines.splice(index, 1);
  });

  const report = (text: string, isError = false) => {
    pi.sendMessage({
      customType: "codegraph",
      content: text,
      display: true,
      details: { isError },
    }, { triggerTurn: false });
  };

  pi.registerCommand("codegraph", {
    description: "CodeGraph: help, status, init, sync, doctor",
    getArgumentCompletions: (prefix) => {
      const matches = COMMANDS.filter((command) => command.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "help") { report(HELP); return; }
      if (!COMMANDS.some((command) => command === action)) {
        report(`Unknown CodeGraph command: ${action}\n\n${HELP}`, true);
        return;
      }
      if (pending) { report("A CodeGraph command is already running. Wait for it to finish.", true); return; }
      // Capture this session's signal so a new session cannot revive old work.
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, shutdown.signal]) : shutdown.signal;
      const cwd = projectPath(config, ctx.cwd);
      pending = (async () => {
        try {
          if (action === "init" || action === "sync") await ctx.waitForIdle();
          signal.throwIfAborted();
          if (ctx.hasUI) ctx.ui.notify(`CodeGraph ${action}: ${cwd}`, "info");
          const cliArgs = action === "doctor" ? ["--version"]
            : action === "status" ? ["status", "--json", cwd]
            : action === "init" ? ["init", "--yes", cwd]
            : ["sync", cwd];
          const result = await run(config.command, cliArgs, {
            cwd, signal,
            timeoutMs: action === "init" || action === "sync" ? config.commandTimeoutMs : config.timeoutSeconds * 1000,
          });
          if (signal.aborted) return;
          const header = action === "doctor"
            ? [
                `Executable: ${config.command}`, `Project: ${cwd}`,
                `Requested MCP exposure: ${config.exposure}; watcher: ${config.watch}`,
                `Loaded tools: ${pi.getAllTools().filter((tool) => tool.name.startsWith("mcp__codegraph__") && tool.exposure !== "hidden").map((tool) => tool.name).join(", ") || "(none yet)"}`,
                "CLI success does not prove MCP connectivity. Use /mcp for connection status.",
                "A same-name mcp.json server overrides this registration; these CLI commands still use PI_CODEGRAPH_*.",
              ].join("\n")
            : `CodeGraph ${action} — ${cwd}`;
          report(`${header}\n\n${result.output || "(no output)"}\n\nExit code: ${result.code}\nLog: ${result.logPath}${action === "init" && result.code === 0 ? "\nThe MCP server should pick up the index; use /mcp reconnect codegraph if needed." : ""}`, result.code !== 0);
        } catch (error) {
          if (!signal.aborted) report(`CodeGraph ${action} failed: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      })();
      try { await pending; } finally { pending = undefined; }
    },
  });
}

export default function codegraphExtension(pi: ExtensionAPI): void {
  registerCodegraph(pi);
}
