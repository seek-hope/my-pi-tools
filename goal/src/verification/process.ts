import { spawn } from 'node:child_process';
import { SandboxError } from './contract.ts';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface ProcessOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes?: number;
  cwd?: string;
}
export type CommandRunner = (args: string[], options: ProcessOptions) => Promise<ProcessResult>;

/** No inherited provider keys, SSH socket, shell startup variables, or DOCKER_HOST. */
export function controlEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS',
      'SystemRoot',
    ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
  );
}
export function commandRunner(executable: string): CommandRunner {
  return async (args, options) => {
    options.signal?.throwIfAborted();
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        shell: false,
        cwd: options.cwd,
        env: controlEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stdout = Buffer.alloc(0),
        stderr = Buffer.alloc(0),
        failure: Error | undefined;
      const kill = () => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const fail = (error: Error) => {
        failure ??= error;
        kill();
      };
      const abort = () => fail(new SandboxError('Sandbox operation cancelled'));
      const timer = setTimeout(
        () => fail(new SandboxError(`Sandbox operation timed out after ${options.timeoutMs} ms`)),
        options.timeoutMs,
      );
      const limit = options.maxBytes ?? 256_000;
      const capture = (data: Buffer, stream: 'stdout' | 'stderr') => {
        if (stdout.length + stderr.length + data.length > limit) {
          fail(new SandboxError('Sandbox control output exceeded its byte limit'));
          return;
        }
        if (stream === 'stdout') stdout = Buffer.concat([stdout, data]);
        else stderr = Buffer.concat([stderr, data]);
      };
      child.stdout.on('data', (data) => capture(data, 'stdout'));
      child.stderr.on('data', (data) => capture(data, 'stderr'));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.on('error', (error) => {
        cleanup();
        reject(new SandboxError(`Cannot start ${executable}: ${error.message}`));
      });
      child.on('close', (code) => {
        cleanup();
        if (failure) reject(failure);
        else
          resolve({
            code: code ?? -1,
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
          });
      });
    });
  };
}

export function requireSuccess(result: ProcessResult, operation: string): string {
  if (result.code !== 0)
    throw new SandboxError(
      `${operation} failed (exit ${result.code}): ${result.stderr.slice(-2000)}`,
    );
  return result.stdout;
}
