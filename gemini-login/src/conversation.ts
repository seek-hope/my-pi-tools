import type {
  ContentBlock,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionNotification,
  SessionModeState,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import {
  AcpProcess,
  CANCELLED,
  errorText,
  plain,
  requestOptions,
  type LaunchOptions,
} from './acp.ts';

import type { ApprovalReviewer } from './approval.ts';

export interface Entry {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice' | 'plan';
  text: string;
  toolId?: string;
  toolStatus?: ToolCallUpdate['status'];
  messageId?: string | null;
}
export interface Permission {
  request: RequestPermissionRequest;
  answer(optionId?: string): void;
  reviewing: boolean;
  reviewReason?: string;
  review(): void;
  cancelReview(reason?: string): void;
}
export type State =
  | 'connecting'
  | 'loading'
  | 'login'
  | 'ready'
  | 'running'
  | 'cancelling'
  | 'busy'
  | 'disconnected'
  | 'closed';
const BLOCK_LIMIT = 64_000;
const DISPLAY_LIMIT = 512_000;
const TOOL_LIMIT = 2 * 1024 * 1024;

function cachedTool(tool: ToolCallUpdate): ToolCallUpdate {
  const compact = (value: unknown) => {
    if (value === undefined) return undefined;
    const json = JSON.stringify(value);
    return json.length <= BLOCK_LIMIT ? value : bounded(json);
  };
  return {
    toolCallId: tool.toolCallId,
    title: tool.title ? bounded(tool.title) : tool.title,
    status: tool.status,
    kind: tool.kind,
    rawInput: compact(tool.rawInput),
    rawOutput: compact(tool.rawOutput),
    locations: tool.locations?.slice(0, 100).map((location, index) => ({
      ...location,
      path:
        tool.locations!.length > 100 && index === 99 ? '[显示内容已截断]' : bounded(location.path),
    })),
    content: tool.content?.slice(0, 100).map((item, index) => {
      if (tool.content!.length > 100 && index === 99)
        return { type: 'content', content: { type: 'text', text: '[显示内容已截断]' } };
      if (item.type === 'content')
        return {
          type: 'content',
          content: { type: 'text', text: bounded(contentText(item.content)) },
        };
      if (item.type === 'diff')
        return {
          type: 'diff',
          path: bounded(item.path),
          oldText: item.oldText == null ? item.oldText : bounded(item.oldText),
          newText: bounded(item.newText),
        };
      return { type: 'terminal', terminalId: item.terminalId };
    }),
  };
}

function bounded(text: string): string {
  return text.length <= BLOCK_LIMIT ? text : `${text.slice(0, BLOCK_LIMIT)}\n[显示内容已截断]`;
}
export function contentText(content: ContentBlock): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'resource_link':
      return `${content.name}: ${content.uri}`;
    case 'resource':
      return 'text' in content.resource ? content.resource.text : `[资源：${content.resource.uri}]`;
    case 'image':
      return `[图片：${content.mimeType}]`;
    case 'audio':
      return `[音频：${content.mimeType}]`;
  }
}
export function toolText(tool: ToolCallUpdate): string {
  const sections = [tool.title ?? tool.toolCallId, `状态：${tool.status ?? 'pending'}`];
  if (tool.locations?.length)
    sections.push(tool.locations.map((l) => `${l.path}${l.line ? `:${l.line}` : ''}`).join('\n'));
  if (tool.rawInput !== undefined)
    sections.push(`输入：\n${JSON.stringify(tool.rawInput, null, 2)}`);
  for (const item of tool.content ?? []) {
    if (item.type === 'content') sections.push(contentText(item.content));
    else if (item.type === 'diff')
      sections.push(
        `文件：${item.path}\n修改前：\n${item.oldText ?? '(新文件)'}\n修改后：\n${item.newText}`,
      );
    else if (item.type === 'terminal') sections.push(`终端：${item.terminalId}`);
  }
  if (tool.rawOutput !== undefined && !tool.content?.length)
    sections.push(JSON.stringify(tool.rawOutput, null, 2));
  return bounded(plain(sections.join('\n\n')));
}
export function choices(option: SessionConfigOption): SessionConfigSelectOption[] {
  if (option.type === 'boolean') return [];
  return option.options.flatMap((item) => ('options' in item ? item.options : [item]));
}

/** ACP conversation state, independent of Pi's model and tool loop. */
export class Conversation {
  readonly cwd: string;
  readonly process: AcpProcess;
  readonly entries: Entry[] = [];
  readonly permissions: Permission[] = [];
  readonly lifetime = new AbortController();
  state: State = 'connecting';
  sessionId?: string;
  info?: InitializeResponse;
  config: SessionConfigOption[] = [];
  modes?: SessionModeState;
  commands: { name: string; description: string }[] = [];
  title = 'Antigravity';
  trimmed = false;
  revision = 0;
  changed: () => void = () => {};
  private readonly remember: (id: string) => void;
  private readonly tools = new Map<string, ToolCallUpdate>();
  private turn?: Promise<void>;
  private finishTurn?: () => void;
  private pendingPrompts = 0;
  lastStopReason?: string;
  private turnAbort?: AbortController;
  private stopPromise?: Promise<void>;
  private cancelPromise?: Promise<void>;
  private requestedSession?: string;
  private cancelMs: number;
  readonly reviewer?: ApprovalReviewer;
  approvalMode: 'auto' | 'manual';
  autoApproved = 0;
  approvalChanged: () => void = () => {};

  constructor(
    cwd: string,
    launch: LaunchOptions,
    remember: (id: string) => void,
    cancelMs = 5000,
    reviewer?: ApprovalReviewer,
  ) {
    this.reviewer = reviewer;
    this.approvalMode = reviewer ? 'auto' : 'manual';
    this.cwd = cwd;
    this.remember = remember;
    this.cancelMs = cancelMs;
    this.process = new AcpProcess(
      cwd,
      {
        update: (notification) => this.update(notification),
        permission: (request, signal) => this.permission(request, signal),
        disconnected: (message) => {
          if (this.state === 'closed') return;
          this.turnAbort?.abort();
          this.state = 'disconnected';
          this.note(message);
        },
      },
      launch,
    );
  }

  private emit() {
    this.revision++;
    this.changed();
  }
  note(text: string) {
    this.add({ kind: 'notice', text: plain(text) });
  }
  private add(entry: Entry) {
    entry.text = bounded(plain(entry.text));
    this.entries.push(entry);
    this.trim();
    this.emit();
  }
  private trim() {
    let size = this.entries.reduce((total, entry) => total + entry.text.length, 0);
    while ((size > DISPLAY_LIMIT || this.entries.length > 500) && this.entries.length > 1) {
      const removed = this.entries.shift()!;
      size -= removed.text.length;
      if (removed.toolId) this.tools.delete(removed.toolId);
      this.trimmed = true;
    }
  }
  private chunk(kind: Entry['kind'], text: string, messageId?: string | null) {
    const last = this.entries.at(-1);
    if (last?.kind === kind && last.messageId === messageId) {
      last.text = bounded(plain(last.text + text));
      this.trim();
      this.emit();
    } else this.add({ kind, text, messageId });
  }
  private failure(error: unknown) {
    if (this.state === 'closed') return;
    const authRequired =
      error && typeof error === 'object' && 'code' in error && error.code === -32000;
    this.state = this.process.connection.signal.aborted
      ? 'disconnected'
      : authRequired || !this.sessionId
        ? 'login'
        : this.turn
          ? 'running'
          : 'ready';
    this.note(errorText(error));
  }
  private reset() {
    this.entries.length = 0;
    this.tools.clear();
    this.config = [];
    this.modes = undefined;
    this.commands = [];
    this.title = 'Antigravity';
    this.trimmed = false;
    this.lastStopReason = undefined;
  }

  async start(sessionId?: string, loginFirst = false): Promise<void> {
    this.requestedSession = sessionId;
    try {
      this.info = await this.process.initialize(this.lifetime.signal);
      if (this.lifetime.signal.aborted) return;
      if (loginFirst) await this.login();
      else await this.open(sessionId);
    } catch (error) {
      this.failure(error);
    }
  }

  async login(): Promise<void> {
    if (
      this.lifetime.signal.aborted ||
      this.turn ||
      !this.info ||
      this.process.connection.signal.aborted
    )
      return;
    if (!this.info.authMethods?.some((method) => method.id === 'oauth-personal')) {
      this.note('官方服务未提供个人 Google 登录。请检查 agy 版本和账号支持范围。');
      return;
    }
    this.state = 'busy';
    this.note(
      '请在浏览器完成官方 Google 登录。若浏览器无法打开，请退出后在终端运行 agy acp --login，再重新打开。',
    );
    try {
      await this.process.request(
        'authenticate',
        { methodId: 'oauth-personal' },
        requestOptions(this.lifetime.signal, 300_000),
      );
      await this.open(this.requestedSession);
    } catch (error) {
      this.failure(error);
    }
  }

  async open(id?: string): Promise<void> {
    if (
      this.lifetime.signal.aborted ||
      this.turn ||
      !this.info ||
      this.process.connection.signal.aborted
    )
      return;
    this.requestedSession = id;
    this.state = 'loading';
    this.sessionId = id;
    this.reset();
    this.emit();
    try {
      if (id && !this.info.agentCapabilities?.loadSession)
        throw new Error('此版本不支持载入会话。输入 /new 创建新会话。');
      const response = id
        ? await this.process.request(
            'session/load',
            { sessionId: id, cwd: this.cwd, mcpServers: [] },
            requestOptions(this.lifetime.signal),
          )
        : await this.process.request(
            'session/new',
            { cwd: this.cwd, mcpServers: [] },
            requestOptions(this.lifetime.signal),
          );
      if (this.lifetime.signal.aborted) return;
      const returnedId = response && 'sessionId' in response ? response.sessionId : undefined;
      this.sessionId = id ?? (typeof returnedId === 'string' ? returnedId : undefined);
      if (!this.sessionId) throw new Error('官方服务没有返回会话 ID。');
      this.requestedSession = this.sessionId;
      this.config = response?.configOptions ?? this.config;
      this.modes = response?.modes ?? this.modes;
      this.remember(this.sessionId);
      this.state = 'ready';
      this.note(
        id
          ? '已载入 Antigravity 会话。上下文由官方客户端管理。'
          : '新会话已就绪。Antigravity 将在当前项目中执行任务。',
      );
    } catch (error) {
      this.sessionId = undefined;
      this.failure(error);
    }
  }

  async listSessions(cursor?: string) {
    if (this.state !== 'ready' || this.turn) return;
    if (!this.info?.agentCapabilities?.sessionCapabilities?.list) {
      this.note('官方服务未提供会话列表；可用 /resume <会话 ID> 载入。');
      return;
    }
    this.state = 'busy';
    this.emit();
    try {
      const response = await this.process.request(
        'session/list',
        { cwd: this.cwd, cursor },
        requestOptions(this.lifetime.signal),
      );
      if (this.lifetime.signal.aborted) return;
      this.state = 'ready';
      this.emit();
      return {
        ...response,
        sessions: response.sessions.filter(
          (session) => session.cwd === this.cwd && session.sessionId.length <= 1024,
        ),
      };
    } catch (error) {
      this.failure(error);
    }
  }

  async prompt(text: string): Promise<boolean> {
    if (!['ready', 'running'].includes(this.state) || !this.sessionId || !text.trim()) return false;
    if (text.length > 120_000) {
      this.note('单条消息超过 120,000 字符，请缩短后发送。');
      return false;
    }
    // Antigravity accepts another prompt as steering while the original turn is
    // still running. A quick steering acknowledgement must not finish that turn
    // or revoke its pending permissions.
    if (!this.turn) {
      this.turnAbort = new AbortController();
      this.lastStopReason = undefined;
      this.turn = new Promise<void>((resolve) => {
        this.finishTurn = resolve;
      });
    }
    this.pendingPrompts++;
    for (const permission of this.permissions)
      if (permission.reviewing) permission.cancelReview('用户指令已更新，请人工确认');
    this.state = 'running';
    this.add({ kind: 'user', text });
    try {
      const response = await this.process.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }],
      });
      if (this.lifetime.signal.aborted || this.process.connection.signal.aborted) return false;
      if (response.stopReason !== 'end_turn') {
        this.lastStopReason = response.stopReason;
        this.note(`本轮结束：${response.stopReason}`);
      } else this.lastStopReason ??= 'end_turn';
      return response.stopReason === 'end_turn';
    } catch (error) {
      this.lastStopReason = 'error';
      this.failure(error);
      return false;
    } finally {
      this.pendingPrompts--;
      if (!this.pendingPrompts) {
        const finish = this.finishTurn;
        this.turnAbort?.abort();
        this.turn = undefined;
        this.finishTurn = undefined;
        if (this.state === 'running' || this.state === 'cancelling') this.state = 'ready';
        finish?.();
      }
      this.emit();
    }
  }

  async configure(option: SessionConfigOption, value: string | boolean): Promise<void> {
    if (this.state !== 'ready' || !this.sessionId) return;
    const current = this.config.find((item) => item.id === option.id);
    if (
      !current ||
      (current.type === 'boolean'
        ? typeof value !== 'boolean'
        : !choices(current).some((item) => item.value === value))
    )
      return;
    this.state = 'busy';
    this.emit();
    try {
      const response = await this.process.request(
        'session/set_config_option',
        {
          sessionId: this.sessionId,
          configId: option.id,
          ...(typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value }),
        },
        requestOptions(this.lifetime.signal),
      );
      if (this.lifetime.signal.aborted) return;
      this.config = response.configOptions;
      this.state = 'ready';
      this.emit();
    } catch (error) {
      this.failure(error);
    }
  }

  private update({ sessionId, update }: SessionNotification) {
    if (this.lifetime.signal.aborted || sessionId !== this.sessionId) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.chunk('assistant', contentText(update.content), update.messageId);
        break;
      case 'agent_thought_chunk':
        this.chunk('thinking', contentText(update.content), update.messageId);
        break;
      case 'user_message_chunk':
        if (this.state === 'loading')
          this.chunk('user', contentText(update.content), update.messageId);
        break;
      case 'tool_call':
      case 'tool_call_update': {
        const previous = this.tools.get(update.toolCallId) ?? { toolCallId: update.toolCallId };
        for (const permission of this.permissions) {
          if (permission.request.toolCall.toolCallId !== update.toolCallId) continue;
          const changed = (['rawInput', 'locations', 'kind', 'title', 'content'] as const).some(
            (key) =>
              update[key] != null &&
              JSON.stringify(update[key]) !== JSON.stringify(permission.request.toolCall[key]),
          );
          if (changed) {
            permission.request = {
              ...permission.request,
              toolCall: {
                ...permission.request.toolCall,
                ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)),
              },
            };
            permission.cancelReview('操作参数已更新，请人工确认');
          }
        }
        const tool = { ...previous };
        // Null means unchanged in ACP partial tool updates.
        for (const [key, value] of Object.entries(update))
          if (value !== null && value !== undefined) Object.assign(tool, { [key]: value });
        const retained = cachedTool(tool);
        this.tools.set(tool.toolCallId, retained);
        let retainedBytes = [...this.tools.values()].reduce(
          (total, value) => total + Buffer.byteLength(JSON.stringify(value)),
          0,
        );
        while (retainedBytes > TOOL_LIMIT && this.tools.size) {
          const oldest = this.tools.entries().next().value!;
          retainedBytes -= Buffer.byteLength(JSON.stringify(oldest[1]));
          this.tools.delete(oldest[0]);
        }
        const entry = this.entries.find((item) => item.toolId === tool.toolCallId);
        if (entry) {
          entry.text = toolText(tool);
          entry.toolStatus = tool.status;
          this.trim();
          this.emit();
        } else
          this.add({
            kind: 'tool',
            toolId: tool.toolCallId,
            toolStatus: tool.status,
            text: toolText(tool),
          });
        break;
      }
      case 'plan':
        this.add({
          kind: 'plan',
          text: update.entries.map((entry) => `[${entry.status}] ${entry.content}`).join('\n'),
        });
        break;
      case 'config_option_update':
        this.config = update.configOptions;
        this.emit();
        break;
      case 'current_mode_update':
        if (this.modes) this.modes.currentModeId = update.currentModeId;
        this.emit();
        break;
      case 'available_commands_update':
        this.commands = update.availableCommands;
        this.emit();
        break;
      case 'session_info_update':
        if (update.title) this.title = plain(update.title);
        this.emit();
        break;
      case 'notice':
        this.note(JSON.stringify(update));
        break;
      // Usage is not added to Pi's model totals: this is a separate agent.
    }
  }

  setApprovalMode(mode: 'auto' | 'manual') {
    if (this.approvalMode === mode) return;
    this.approvalMode = mode;
    this.approvalChanged();
    for (const permission of this.permissions) {
      if (mode === 'manual') permission.cancelReview('已切换为人工审核');
      else permission.review();
    }
    this.emit();
  }

  private permission(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (
      request.sessionId !== this.sessionId ||
      !this.turnAbort ||
      this.turnAbort.signal.aborted ||
      this.lifetime.signal.aborted ||
      signal.aborted
    )
      return Promise.resolve(CANCELLED);
    const combined = AbortSignal.any([signal, this.lifetime.signal, this.turnAbort.signal]);
    return new Promise((resolve) => {
      let settled = false;
      let reviewController: AbortController | undefined;
      const permission: Permission = {
        reviewing: false,
        review: () => {
          if (settled || combined.aborted || this.approvalMode !== 'auto' || !this.reviewer) return;
          reviewController?.abort();
          const controller = (reviewController = new AbortController());
          const reviewSignal = AbortSignal.any([combined, controller.signal]);
          const snapshot = JSON.stringify(permission.request);
          permission.reviewing = true;
          permission.reviewReason = undefined;
          this.emit();
          const task = this.entries
            .filter((entry) => entry.kind === 'user')
            .slice(-6)
            .map((entry) => entry.text)
            .join('\n\n');
          void this.reviewer
            .review(structuredClone(permission.request), task, this.cwd, reviewSignal)
            .catch(() => ({ approve: false, reason: '自动审核不可用，请人工确认' }))
            .then((decision) => {
              if (settled || reviewSignal.aborted || reviewController !== controller) return;
              const unchanged = snapshot === JSON.stringify(permission.request);
              permission.reviewReason = unchanged
                ? plain(decision.reason)
                : '操作参数已更新，请人工确认';
              const option = request.options.find((item) => item.kind === 'allow_once');
              if (decision.approve && unchanged && this.approvalMode === 'auto' && option) {
                this.autoApproved++;
                this.note(
                  `自动批准本次：${permission.request.toolCall.title ?? permission.request.toolCall.toolCallId} · ${permission.reviewReason}`,
                );
                permission.answer(option.optionId);
              } else {
                permission.reviewing = false;
                this.emit();
              }
            });
        },
        cancelReview: (reason = '自动审核已取消，请人工确认') => {
          reviewController?.abort();
          permission.reviewing = false;
          permission.reviewReason = reason;
          this.emit();
        },
        request: {
          ...request,
          toolCall: {
            ...this.tools.get(request.toolCall.toolCallId),
            ...Object.fromEntries(
              Object.entries(request.toolCall).filter(
                ([, value]) => value !== null && value !== undefined,
              ),
            ),
            toolCallId: request.toolCall.toolCallId,
          },
        },
        answer: (optionId) => {
          if (settled) return;
          settled = true;
          permission.reviewing = false;
          reviewController?.abort();
          combined.removeEventListener('abort', cancelled);
          const index = this.permissions.indexOf(permission);
          if (index >= 0) this.permissions.splice(index, 1);
          const option = request.options.find((item) => item.optionId === optionId);
          resolve(
            !combined.aborted && option
              ? { outcome: { outcome: 'selected', optionId: option.optionId } }
              : CANCELLED,
          );
          this.emit();
        },
      };
      const cancelled = () => permission.answer();
      combined.addEventListener('abort', cancelled, { once: true });
      this.permissions.push(permission);
      if (this.approvalMode === 'auto' && this.reviewer) permission.review();
      else this.emit();
    });
  }

  cancel(): Promise<void> {
    if (this.cancelPromise) return this.cancelPromise;
    if (!this.turn || !this.sessionId) return Promise.resolve();
    this.cancelPromise = this.cancelTurn().finally(() => {
      this.cancelPromise = undefined;
    });
    return this.cancelPromise;
  }

  private async cancelTurn(): Promise<void> {
    const turn = this.turn!;
    this.state = 'cancelling';
    this.lastStopReason = 'cancelled';
    this.turnAbort?.abort();
    this.emit();
    void this.process.connection.agent
      .notify('session/cancel', { sessionId: this.sessionId! })
      .catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      turn.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.cancelMs);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      await this.process.stop();
      if (!this.lifetime.signal.aborted) {
        this.state = 'disconnected';
        this.note('取消未在期限内确认，已关闭本地 ACP 进程。请在官方客户端确认任务状态。');
      }
    }
  }

  close(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      await this.cancel();
      this.lifetime.abort();
      this.state = 'closed';
      await this.process.stop();
      this.emit();
    })();
    return this.stopPromise;
  }
}
