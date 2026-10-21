import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const SERVER_NAME = "codegraph";
export type Exposure = "codemode" | "direct" | "deferred" | "hidden";

export interface Config {
  command: string;
  project: string;
  exposure: Exposure;
  watch: boolean;
  timeoutSeconds: number;
  commandTimeoutMs: number;
}

// Apply only to children; never change the Pi process's environment.
// Existing shared CodeGraph daemons retain the environment they started with.
export const CHILD_ENV = {
  CODEGRAPH_TELEMETRY: "0",
  CODEGRAPH_NO_UPDATE_CHECK: "1",
  CODEGRAPH_EXPLORE_DEDUP: "0",
  NO_COLOR: "1",
};

function value(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!raw.trim() || /[\0\r\n]/.test(raw)) throw new Error(`${key} must be a non-empty single-line value.`);
  return raw.trim();
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = value(env, key, String(fallback));
  const number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${key} must be an integer from 1 to ${max}.`);
  }
  return number;
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const exposure = value(env, "PI_CODEGRAPH_EXPOSURE", "codemode");
  if (!["codemode", "direct", "deferred", "hidden"].includes(exposure)) {
    throw new Error("PI_CODEGRAPH_EXPOSURE must be codemode, direct, deferred, or hidden.");
  }
  const watch = value(env, "PI_CODEGRAPH_WATCH", "1");
  if (watch !== "0" && watch !== "1") throw new Error("PI_CODEGRAPH_WATCH must be 0 or 1.");
  const command = expandHome(value(env, "PI_CODEGRAPH_COMMAND", "codegraph"));
  // A bare name resolves on PATH. Paths must be absolute so CLI commands and MCP
  // agree even when the SDK session cwd differs from process.cwd().
  if (!isAbsolute(command) && (/[\\/]/.test(command) || /\s/.test(command))) {
    throw new Error("PI_CODEGRAPH_COMMAND must be a PATH executable name or absolute path, not a shell command.");
  }
  return {
    command,
    project: expandHome(value(env, "PI_CODEGRAPH_PROJECT", ".")),
    exposure: exposure as Exposure,
    watch: watch === "1",
    timeoutSeconds: integer(env, "PI_CODEGRAPH_TIMEOUT", 120, 3600),
    commandTimeoutMs: integer(env, "PI_CODEGRAPH_COMMAND_TIMEOUT", 900, 86400) * 1000,
  };
}

export function projectPath(config: Config, cwd: string): string {
  return resolve(cwd, config.project);
}

export function serverConfig(config: Config) {
  return {
    command: config.command,
    // Pi resolves relative cwd against the session cwd, NOT this package.
    cwd: config.project,
    args: ["serve", "--mcp", "--path", ".", ...(config.watch ? [] : ["--no-watch"])],
    env: { ...CHILD_ENV },
    exposure: config.exposure,
    timeout: config.timeoutSeconds,
    description: "CodeGraph: query indexed source, call paths and change impact with codegraph_explore; discover tools in mcp__codegraph. Never initialize an index without user authorization.",
  };
}
