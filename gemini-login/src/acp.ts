import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type InitializeRequest,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type PromptRequest,
  type PromptResponse,
  type SendRequestOptions,
} from '@agentclientprotocol/sdk';
import { validate, type Shape } from './protocol.ts';

interface Rpc {
  initialize: [InitializeRequest, InitializeResponse];
  authenticate: [AuthenticateRequest, AuthenticateResponse];
  'session/new': [NewSessionRequest, NewSessionResponse];
  'session/load': [LoadSessionRequest, LoadSessionResponse];
  'session/list': [ListSessionsRequest, ListSessionsResponse];
  'session/set_config_option': [SetSessionConfigOptionRequest, SetSessionConfigOptionResponse];
  'session/prompt': [PromptRequest, PromptResponse];
}
const responses: Record<keyof Rpc, Shape> = {
  initialize: 'InitializeResponse',
  authenticate: 'AuthenticateResponse',
  'session/new': 'NewSessionResponse',
  'session/load': 'LoadSessionResponse',
  'session/list': 'ListSessionsResponse',
  'session/set_config_option': 'SetSessionConfigOptionResponse',
  'session/prompt': 'PromptResponse',
};

export const VERSION = '0.3.0';
export const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/** Terminal text only: never replay control sequences from a subprocess. */
export function plain(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function errorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === -32000)
    return '需要 Google 登录。输入 /login 打开官方登录；SSH 环境请在终端运行 agy acp --login，然后重新打开此界面。';
  const text = plain(error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(
      /((?:access_token|refresh_token|id_token|code_verifier|authorization_code)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
      '$1[redacted]',
    )
    .replace(/([?&](?:code|key|token)=)[^\s&#"']+/gi, '$1[redacted]');
  return text.slice(0, 2000);
}

export interface AcpHooks {
  update(notification: SessionNotification): void;
  permission(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  disconnected(message: string): void;
}

export interface LaunchOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  stopMs?: number;
}

export async function executable(): Promise<string> {
  const configured = process.env.ANTIGRAVITY_ACP_COMMAND?.trim();
  if (configured) return configured;
  const local = join(homedir(), '.local', 'bin', 'agy');
  try {
    await access(local, constants.X_OK);
    return local;
  } catch {
    return 'agy';
  }
}

const MESSAGE_BYTES = 8 * 1024 * 1024;

/** Fail a broken stdio channel instead of leaving a prompt pending after a parse error. */
export function strictAcpInput(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (Buffer.byteLength(line) > MESSAGE_BYTES) throw new Error('ACP message exceeds 8 MiB');
          if (!line.trim()) continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw new Error('Malformed ACP JSON');
          }
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            !('jsonrpc' in value) ||
            value.jsonrpc !== '2.0' ||
            !('method' in value || 'result' in value || 'error' in value)
          )
            throw new Error('Malformed ACP message');
          if ('method' in value && value.method === 'session/update')
            validate('SessionNotification', 'params' in value ? value.params : undefined);
          if ('method' in value && value.method === 'session/request_permission')
            validate('RequestPermissionRequest', 'params' in value ? value.params : undefined);
        }
        if (Buffer.byteLength(pending) > MESSAGE_BYTES)
          throw new Error('ACP message exceeds 8 MiB');
        controller.enqueue(chunk);
      },
      flush() {
        pending += decoder.decode();
        if (pending.trim()) throw new Error('Truncated ACP message');
      },
    }),
  );
}

/** One owned ACP subprocess. It never opens or copies Google's credential files. */
export class AcpProcess {
  readonly connection: ClientConnection;
  readonly child: ChildProcessWithoutNullStreams;
  private readonly exited: Promise<void>;
  private readonly stopMs: number;
  private stopping?: Promise<void>;
  private closing = false;
  private failure?: Error;

  constructor(cwd: string, hooks: AcpHooks, options: LaunchOptions) {
    this.stopMs = options.stopMs ?? 2000;
    // This integration only offers personal OAuth. Do not inherit API keys as a fallback.
    const env = { ...process.env, ...options.env };
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    this.child = spawn(options.command, options.args ?? ['acp'], {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => resolve());
      this.child.once('error', (error) => {
        this.failure = new Error(
          'code' in error && error.code === 'ENOENT'
            ? '找不到 Antigravity CLI。请安装官方 agy，或用 ANTIGRAVITY_ACP_COMMAND 设置其完整路径。'
            : `Antigravity 启动失败：${errorText(error)}`,
        );
        resolve();
        this.connection?.close(this.failure);
      });
    });
    // Drain diagnostics, but do not copy auth URLs or credential-bearing logs into Pi.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin),
      strictAcpInput(Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>),
      { maxMessageBytes: MESSAGE_BYTES },
    );
    this.connection = client()
      .onNotification('session/update', ({ params }) => hooks.update(params))
      .onRequest('session/request_permission', ({ params, signal }) =>
        hooks.permission(params, signal),
      )
      .connect(stream);
    void this.connection.closed.then(() => {
      if (!this.closing) {
        hooks.disconnected(
          this.failure?.message ?? 'Antigravity 连接已断开；未完成的任务不能视为成功。',
        );
        void this.stop();
      }
    });
  }

  async request<K extends keyof Rpc>(
    method: K,
    params: Rpc[K][0],
    options?: SendRequestOptions,
  ): Promise<Rpc[K][1]> {
    options?.cancellationSignal?.throwIfAborted();
    let result: unknown;
    try {
      result = await this.connection.agent.request(method, params, options);
    } catch (error) {
      if (options?.cancellationSignal?.aborted) {
        this.failure = new Error(
          `ACP ${method} cancelled or timed out; the connection was stopped`,
        );
        this.connection.close(this.failure);
        throw this.failure;
      }
      throw error;
    }
    const value =
      (method === 'authenticate' || method === 'session/load') && result == null ? {} : result;
    try {
      validate(responses[method], value);
    } catch (error) {
      this.failure = error as Error;
      this.connection.close(error);
      throw error;
    }
    return value as Rpc[K][1];
  }

  async initialize(signal?: AbortSignal): Promise<InitializeResponse> {
    try {
      const result = await this.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'my-pi-gemini-login', title: 'Pi Antigravity ACP', version: VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: { configOptions: { boolean: {} }, notices: {} },
          },
        },
        requestOptions(signal),
      );
      if (result.protocolVersion !== PROTOCOL_VERSION)
        throw new Error(`不支持 ACP 协议版本 ${result.protocolVersion}`);
      return result;
    } catch (error) {
      await this.stop();
      throw this.failure ?? error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true;
    this.connection.close();
    this.stopping = (async () => {
      try {
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        this.child.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.stopMs);
          }),
        ]);
        clearTimeout(timer);
        if (this.child.exitCode === null && this.child.signalCode === null)
          this.child.kill('SIGKILL');
      } finally {
        // Descendants may inherit pipes even after the owned process exits.
        // Release our handles on every path, without killing unrelated processes.
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      }
    })();
    return this.stopping;
  }
}

export function requestOptions(signal?: AbortSignal, timeoutMs = 30_000) {
  return {
    cancellationSignal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]),
    stopWaitingOnCancel: true,
  };
}
