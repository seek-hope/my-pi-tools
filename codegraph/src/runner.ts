import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CHILD_ENV } from "./config.ts";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface RunResult {
  code: number | null;
  output: string;
  logPath: string;
}
export type Runner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

function stopTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // No shell interpolation, including on Windows.
    execFile("taskkill", ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])], (error) => {
      if (!error) return;
      // taskkill may be unavailable or refuse; still try to stop the child.
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already exited */ }
    });
  } else {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { /* already exited */ }
  }
}

/** A bounded transcript plus a complete private log; stdout never buffers in memory. */
export const runCommand: Runner = async (command, args, options) => {
  options.signal?.throwIfAborted();
  const logPath = join(await mkdtemp(join(tmpdir(), "pi-codegraph-")), "command.log");
  const log = await open(logPath, "w+", 0o600);
  let failure: string | undefined;
  let code: number | null = null;
  try {
    options.signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...CHILD_ENV },
      stdio: ["ignore", log.fd, log.fd],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    await new Promise<void>((resolve) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: string) => {
        if (failure) return;
        failure = reason;
        stopTree(child, false);
        killTimer = setTimeout(() => stopTree(child, true), 1000);
      };
      const abort = () => stop("CodeGraph command cancelled.");
      const timer = setTimeout(() => stop(`CodeGraph command timed out after ${options.timeoutMs / 1000}s.`), options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error: NodeJS.ErrnoException) => {
        failure = error.code === "ENOENT"
          ? `Cannot start ${command}. Check the executable and project directory. Install @colbymchenry/codegraph or set PI_CODEGRAPH_COMMAND to an absolute executable path.`
          : error.message;
      });
      child.once("close", (exitCode, signal) => {
        code = exitCode;
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
          stopTree(child, true); // Also reap workers if their parent exited first.
        }
        options.signal?.removeEventListener("abort", abort);
        if (!failure && signal) failure = `CodeGraph terminated by ${signal}.`;
        resolve();
      });
      if (options.signal?.aborted) abort();
    });
    const { size } = await log.stat();
    const length = Math.min(size, 12_000);
    const bytes = Buffer.alloc(length);
    await log.read(bytes, 0, length, size - length);
    const output = (size > length ? "[Earlier output omitted; full output is in the log.]\n" : "")
      + stripVTControlCharacters(bytes.toString("utf8")).trim();
    if (failure) throw new Error(`${failure}\n${output}\nLog: ${logPath}`);
    return { code, output, logPath };
  } finally {
    await log.close();
  }
};
