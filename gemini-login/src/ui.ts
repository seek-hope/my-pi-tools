import {
  CustomEditor,
  getSelectListTheme,
  type KeybindingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  CombinedAutocompleteProvider,
  Loader,
  ScrollView,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
  type SelectItem,
  type SlashCommand,
} from '@earendil-works/pi-tui';
import type { SessionConfigOption, SessionInfo } from '@agentclientprotocol/sdk';
import { choices, toolText, type Conversation, type Permission } from './conversation.ts';
import { plain } from './acp.ts';
import { Picker } from './picker.ts';
import { Transcript } from './transcript.ts';

const STATES = {
  connecting: '连接中',
  loading: '载入中',
  login: '等待登录 /login',
  ready: '就绪',
  running: '执行中',
  cancelling: '取消中',
  busy: '处理中',
  disconnected: '连接已断开',
  closed: '已关闭',
};
const COMMANDS: SlashCommand[] = [
  { name: 'model', description: '选择模型' },
  { name: 'thinking', description: '选择思考等级' },
  { name: 'permissions', description: '自动审核或人工授权', argumentHint: '[auto|manual]' },
  { name: 'settings', description: '会话设置' },
  { name: 'config', description: '会话设置（/settings）' },
  { name: 'new', description: '新建 Antigravity 会话' },
  { name: 'resume', description: '搜索并恢复当前项目的会话' },
  { name: 'load', description: '用 ID 恢复会话', argumentHint: '<会话 ID>' },
  { name: 'login', description: '登录个人 Google 账号' },
  { name: 'cancel', description: '取消当前任务' },
  { name: 'status', description: '查看会话和项目' },
  { name: 'help', description: '命令和快捷键' },
  { name: 'hotkeys', description: '当前快捷键' },
  { name: 'exit', description: '返回 Pi' },
  { name: 'quit', description: '返回 Pi' },
];

export class ChatScreen implements Component, Focusable {
  private readonly conversation: Conversation;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: () => void;
  private readonly editor: CustomEditor;
  private readonly transcript: Transcript;
  private readonly scroll: ScrollView;
  private picker?: Picker;
  private permission?: Permission;
  private permissionRequest?: Permission['request'];
  private permissionReason?: string;
  private loader?: Loader;
  private commandKey = '';
  private lastClear = 0;
  private readonly queued: string[] = [];
  private queuePaused = false;
  private leaving = false;
  private leavePromise?: Promise<void>;
  private narrow = false;
  private focus = false;
  private height = 12;

  constructor(
    conversation: Conversation,
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    done: () => void,
  ) {
    this.conversation = conversation;
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.editor = new CustomEditor(
      tui,
      {
        borderColor: (text) => theme.fg('border', text),
        selectList: getSelectListTheme(),
      },
      keys,
    );
    this.editor.onSubmit = (text) => {
      // The native editor clears itself before invoking onSubmit. Restore the
      // draft first so rejected sends and a full queue cannot discard it.
      this.editor.setText(text);
      this.submit(text);
    };
    this.editor.onEscape = () => this.interrupt();
    this.editor.onCtrlD = () => {
      void this.leave();
    };
    this.editor.onAction('app.clear', () => {
      const now = Date.now();
      if (now - this.lastClear < 500) void this.leave();
      else {
        this.editor.setText('');
        this.lastClear = now;
      }
    });
    this.editor.onAction('app.model.select', () => this.config('model'));
    this.editor.onAction('app.model.cycleForward', () => this.cycle('model', 1));
    this.editor.onAction('app.model.cycleBackward', () => this.cycle('model', -1));
    this.editor.onAction('app.thinking.cycle', () => this.cycle('thought_level', 1));
    this.editor.onAction('app.tools.expand', () => {
      this.transcript.expanded = !this.transcript.expanded;
    });
    this.editor.onAction('app.thinking.toggle', () => {
      this.transcript.thinking = !this.transcript.thinking;
    });
    this.editor.onAction('app.message.followUp', () =>
      this.submit(this.editor.getExpandedText(), true),
    );
    this.editor.onAction('app.message.dequeue', () => this.restoreQueue());
    this.editor.onAction('app.session.new', () => this.open());
    this.editor.onAction('app.session.resume', () => {
      void this.resume();
    });
    this.editor.onPasteImage = () =>
      conversation.note(
        '当前界面支持文本粘贴；可用终端的粘贴快捷键，或输入文件路径让 agent 读取。',
      );
    this.transcript = new Transcript(conversation, theme);
    this.scroll = new ScrollView(this.transcript, { follow: 'end', scrollbar: 'hidden' });
    conversation.changed = () => {
      if (this.leaving) return;
      this.syncCommands();
      this.syncPermission();
      this.drainQueue();
      this.working();
      tui.requestRender();
    };
    this.syncCommands();
    this.working();
  }

  get focused() {
    return this.focus;
  }
  set focused(value: boolean) {
    this.focus = value;
    this.editor.focused = value && !this.picker;
    if (this.picker) this.picker.focused = value;
  }
  get capturesViewportInput() {
    return true;
  }

  private hint(key: Parameters<KeybindingsManager['getKeys']>[0], label: string) {
    const keys = this.keys.getKeys(key);
    return `${keys.length ? keys.join('/') : '未绑定'} ${label}`;
  }

  private working() {
    const busy =
      ['connecting', 'loading', 'running', 'cancelling', 'busy'].includes(
        this.conversation.state,
      ) && !this.permission;
    if (busy && !this.loader)
      this.loader = new Loader(
        this.tui,
        (s) => this.theme.fg('accent', s),
        (s) => this.theme.fg('muted', s),
      );
    if (!busy) {
      this.loader?.stop();
      this.loader = undefined;
    }
    this.loader?.setMessage(
      this.conversation.permissions.some((permission) => permission.reviewing)
        ? 'Pi 模型审核中'
        : STATES[this.conversation.state],
    );
  }

  private syncCommands() {
    const key = JSON.stringify(this.conversation.commands);
    if (key === this.commandKey) return;
    this.commandKey = key;
    const names = new Set(COMMANDS.map((command) => command.name));
    const local = COMMANDS.map((command): SlashCommand => ({
      ...command,
      ...(command.name === 'permissions'
        ? {
            getArgumentCompletions: (prefix: string) =>
              ['auto', 'manual']
                .filter((value) => value.startsWith(prefix))
                .map((value) => ({ value, label: value })),
          }
        : {}),
      ...(['model', 'thinking'].includes(command.name)
        ? {
            getArgumentCompletions: (prefix: string) => {
              const option = this.option(command.name === 'model' ? 'model' : 'thought_level');
              return option
                ? choices(option)
                    .filter((item) =>
                      `${item.value} ${item.name}`.toLowerCase().includes(prefix.toLowerCase()),
                    )
                    .map((item) => ({ value: item.value, label: plain(item.name) }))
                : [];
            },
          }
        : {}),
    }));
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [
          ...local,
          ...this.conversation.commands
            .filter((command) => !names.has(command.name))
            .map((command) => ({
              name: plain(command.name),
              description: plain(command.description),
            })),
        ],
        this.conversation.cwd,
      ),
    );
  }

  private choose(
    title: string,
    items: SelectItem[],
    select: (value: string) => void,
    options: { current?: string; query?: string; searchable?: boolean; cancel?: () => void } = {},
  ) {
    this.picker = new Picker(
      title,
      items,
      this.keys,
      this.theme,
      (value) => {
        this.picker = undefined;
        this.editor.focused = this.focus;
        select(value);
        this.syncPermission();
        this.tui.requestRender();
      },
      () => {
        this.picker = undefined;
        this.editor.focused = this.focus;
        options.cancel?.();
        this.syncPermission();
        this.tui.requestRender();
      },
      options.searchable,
      options.current,
      options.query,
    );
    this.picker.focused = this.focus;
    this.editor.focused = false;
    this.tui.requestRender();
  }

  private syncPermission() {
    const permission = this.conversation.permissions.find((item) => !item.reviewing);
    if (
      this.permission === permission &&
      this.permissionRequest === permission?.request &&
      this.permissionReason === permission?.reviewReason
    )
      return;
    if (this.permission) this.picker = undefined;
    this.permission = permission;
    this.permissionRequest = permission?.request;
    this.permissionReason = permission?.reviewReason;
    if (!permission) {
      this.editor.focused = this.focus;
      return;
    }
    const { request } = permission;
    this.choose(
      'Antigravity 请求授权',
      [
        { value: '', label: '取消此授权请求' },
        ...request.options.map((option, index) => ({
          value: String(index + 1),
          label: plain(option.name),
          description: {
            allow_once: '允许本次',
            allow_always: '持续允许',
            reject_once: '拒绝本次',
            reject_always: '持续拒绝',
          }[option.kind],
        })),
      ],
      (value) =>
        permission.answer(value ? request.options[Number(value) - 1]?.optionId : undefined),
      { searchable: false, cancel: () => permission.answer() },
    );
    // Approval details remain fully visible even when normal tool output is folded.
    this.conversation.note(
      `待授权操作：${permission.reviewReason ? `\n${permission.reviewReason}` : ''}\n${toolText(request.toolCall)}`,
    );
    this.scroll.scrollToEnd();
  }

  private option(category: 'model' | 'thought_level') {
    return this.conversation.config.find(
      (option) =>
        option.category === category || option.id === (category === 'model' ? 'model' : 'thinking'),
    );
  }

  private idle(): boolean {
    if (this.conversation.state === 'ready') return true;
    this.conversation.note('请先等待或取消当前任务；需要登录时请使用 /login。');
    return false;
  }

  private valueName(option: SessionConfigOption) {
    return plain(
      option.type === 'boolean'
        ? option.currentValue
          ? '开启'
          : '关闭'
        : (choices(option).find((item) => item.value === option.currentValue)?.name ??
            String(option.currentValue)),
    );
  }

  private config(category?: 'model' | 'thought_level', query = '') {
    if (!this.idle()) return;
    const option = category ? this.option(category) : undefined;
    const chooseValue = (item: SessionConfigOption, back?: () => void) => {
      const items =
        item.type === 'boolean'
          ? [
              { value: 'true', label: '开启' },
              { value: 'false', label: '关闭' },
            ]
          : choices(item).map((value) => ({
              value: value.value,
              label: plain(value.name),
              description: plain(
                `${value.value}${value.description ? ` · ${value.description}` : ''}`,
              ),
            }));
      this.choose(
        `${plain(item.name)} · 当前：${this.valueName(item)}`,
        items,
        (value) => {
          void this.conversation.configure(
            item,
            item.type === 'boolean' ? value === 'true' : value,
          );
        },
        { current: String(item.currentValue), query, cancel: back },
      );
    };
    if (category) {
      if (option) chooseValue(option);
      else this.conversation.note('官方服务没有提供这些设置。');
    } else
      this.choose(
        '会话设置',
        this.conversation.config.map((item) => ({
          value: item.id,
          label: plain(item.name),
          description: this.valueName(item),
        })),
        (id) => {
          const selected = this.conversation.config.find((item) => item.id === id);
          if (selected) chooseValue(selected, () => this.config());
        },
      );
  }

  private cycle(category: 'model' | 'thought_level', step: number) {
    if (!this.idle()) return;
    const option = this.option(category);
    if (!option) {
      this.conversation.note('官方服务没有提供这些设置。');
      return;
    }
    const values = choices(option);
    if (values.length < 2) return;
    const index = values.findIndex((value) => value.value === option.currentValue);
    const next = values[(Math.max(0, index) + step + values.length) % values.length]!;
    void this.conversation.configure(option, next.value);
  }

  private open(id?: string) {
    if (!['ready', 'login'].includes(this.conversation.state)) {
      this.idle();
      return;
    }
    if (this.queued.length) {
      this.restoreQueue();
      this.conversation.note('未发送的消息已取回草稿。编辑或清空后再切换会话。');
      return;
    }
    void this.conversation.open(id);
  }

  async resume(cursor?: string, sessions: SessionInfo[] = [], cursors = new Set<string>()) {
    if (!this.idle()) return;
    this.queuePaused = true;
    const result = await this.conversation.listSessions(cursor);
    if (!this.queued.length) this.queuePaused = false;
    if (!result || this.leaving) return;
    const combined = [
      ...new Map(
        [...sessions, ...result.sessions].map((session) => [session.sessionId, session]),
      ).values(),
    ].slice(0, 1000);
    const items: SelectItem[] = combined.map((session) => ({
      value: session.sessionId,
      label: plain(session.title || session.sessionId),
      description: plain(`${session.updatedAt ?? ''} · ${session.sessionId}`),
    }));
    const more = result.nextCursor;
    const canLoadMore = more && !cursors.has(more) && combined.length < 1000;
    if (canLoadMore) items.push({ value: '__more__', label: '加载更多会话…' });
    if (!items.length) {
      this.conversation.note('当前项目没有可恢复的会话。');
      return;
    }
    this.choose(
      '恢复 Antigravity 会话 · 当前项目',
      items,
      (id) => {
        if (id === '__more__' && canLoadMore) {
          cursors.add(more);
          void this.resume(more, combined, cursors);
        } else this.open(id);
      },
      { current: this.conversation.sessionId },
    );
  }

  private validMessage(text: string) {
    if (!text.trim()) return false;
    if (text.length <= 120_000) return true;
    this.conversation.note('单条消息超过 120,000 字符；草稿已保留，请缩短后发送。');
    return false;
  }

  enqueueInitial(text: string) {
    if (!this.validMessage(text)) {
      this.editor.setText(text);
      return;
    }
    this.enqueue(text);
  }

  private enqueue(text: string): boolean {
    if (
      this.queued.length >= 32 ||
      this.queued.reduce((size, item) => size + item.length, text.length) > 512_000
    ) {
      this.conversation.note('待发送消息过多，草稿已保留；请等待或取回队列后重试。');
      return false;
    }
    this.queued.push(text);
    this.tui.requestRender();
    return true;
  }

  private drainQueue() {
    const c = this.conversation;
    if (!this.queued.length || this.queuePaused || this.picker || c.state !== 'ready') return;
    if (c.lastStopReason && c.lastStopReason !== 'end_turn') {
      this.queuePaused = true;
      return;
    }
    const next = this.queued.shift()!;
    this.scroll.scrollToEnd();
    void c.prompt(next);
  }

  private restoreQueue() {
    if (!this.queued.length) return;
    const draft = this.editor.getExpandedText();
    this.editor.setText([...this.queued.splice(0), ...(draft ? [draft] : [])].join('\n\n'));
    this.queuePaused = false;
    this.tui.requestRender();
  }

  private interrupt() {
    if (['running', 'cancelling'].includes(this.conversation.state)) {
      this.queuePaused = true;
      void this.conversation.cancel();
    } else if (!['ready', 'login'].includes(this.conversation.state)) void this.leave();
  }

  submit(text: string, followUp = false) {
    const input = text.trim();
    if (!input || this.leaving || this.picker) return;
    const command = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input);
    const name = command?.[1],
      argument = command?.[2] ?? '';
    if (name && COMMANDS.some((item) => item.name === name)) {
      this.editor.setText('');
      this.editor.addToHistory(text);
      switch (name) {
        case 'exit':
        case 'quit':
          void this.leave();
          break;
        case 'cancel':
          this.interrupt();
          break;
        case 'help':
        case 'hotkeys':
          this.conversation.note(
            [
              ...COMMANDS.map((item) => `/${item.name} — ${item.description}`),
              '',
              this.hint('tui.input.submit', '发送；运行中补充指令'),
              this.hint('app.message.followUp', '排队后续消息'),
              this.hint('app.message.dequeue', '取回队列'),
              this.hint('app.model.select', '模型选择'),
              this.hint('app.model.cycleForward', '下一个模型'),
              this.hint('app.thinking.cycle', '切换思考等级'),
              this.hint('app.tools.expand', '展开/折叠工具输出'),
              this.hint('app.thinking.toggle', '显示/隐藏思考'),
              this.hint('app.interrupt', '取消任务；空闲时保留草稿'),
              this.hint('app.clear', '清空草稿；连按两次返回 Pi'),
              this.hint('app.exit', '空输入时返回 Pi'),
              '',
              ...this.conversation.commands.map((item) => `/${item.name} — ${item.description}`),
            ].join('\n'),
          );
          break;
        case 'status':
          this.conversation.note(
            `项目：${this.conversation.cwd}\n会话：${this.conversation.sessionId ?? '尚未创建'}\n${STATES[this.conversation.state]}\n授权：${this.conversation.approvalMode === 'auto' ? `自动审核 · Pi ${this.conversation.reviewer?.label ?? '不可用'}` : '人工审核'}\n本次打开：自动批准 ${this.conversation.autoApproved} 次；模型审核请求 ${this.conversation.reviewer?.requests ?? 0} 次；已返回 token ${this.conversation.reviewer?.tokens ?? 0}`,
          );
          break;
        case 'login':
          void this.conversation.login();
          break;
        case 'new':
          this.open();
          break;
        case 'resume':
          if (argument) this.open(argument);
          else void this.resume();
          break;
        case 'load':
          if (argument) this.open(argument);
          else void this.resume();
          break;
        case 'model':
          this.config('model', argument);
          break;
        case 'thinking':
          this.config('thought_level', argument);
          break;
        case 'permissions': {
          const c = this.conversation;
          const select = (mode: string) => {
            if (mode !== 'auto' && mode !== 'manual') return;
            c.setApprovalMode(mode);
            c.note(
              mode === 'auto'
                ? `自动审核：Pi ${c.reviewer?.label ?? '模型不可用'}。仅批准本次；高风险或无法判断时请你确认。审核消耗 Pi 模型用量。`
                : '人工审核：每个转交给客户端的授权请求都由你确认。',
            );
          };
          if (argument === 'auto' || argument === 'manual') select(argument);
          else
            this.choose(
              '授权模式',
              [
                {
                  value: 'auto',
                  label: '自动审核 · Pi 模型',
                  description: `${c.reviewer?.label ?? '模型不可用'}；会消耗该模型用量`,
                },
                { value: 'manual', label: '全部人工审核', description: '每个授权请求都由你确认' },
              ],
              select,
              { searchable: false, current: c.approvalMode },
            );
          break;
        }
        case 'settings':
        case 'config':
          this.config();
          break;
      }
    } else if (this.validMessage(text)) {
      const state = this.conversation.state;
      if (state === 'closed' || state === 'disconnected') {
        this.conversation.note('连接已断开；请返回 Pi 后重新打开 /antigravity。草稿仍在输入框中。');
        return;
      }
      if (followUp || !['ready', 'running'].includes(state)) {
        if (!this.enqueue(text)) return;
      } else {
        if (!this.queued.length) this.queuePaused = false;
        void this.conversation.prompt(text);
      }
      this.editor.setText('');
      this.editor.addToHistory(text);
      this.scroll.scrollToEnd();
      this.drainQueue();
    }
    this.tui.requestRender();
  }

  leave(): Promise<void> {
    if (this.leavePromise) return this.leavePromise;
    this.leaving = true;
    this.loader?.stop();
    this.permission?.answer();
    this.leavePromise = this.conversation.close().then(() => this.done());
    return this.leavePromise;
  }

  private scrollInput(data: string, details = false): boolean {
    const matches = (key: Parameters<KeybindingsManager['matches']>[1]) =>
      this.keys.matches(data, key);
    if (matches('tui.altScreen.top')) this.scroll.scrollBy(-this.scroll.scrollTop);
    else if (matches('tui.altScreen.bottom')) this.scroll.scrollToEnd();
    else if (matches(details ? 'tui.editor.pageUp' : 'tui.altScreen.pageUp'))
      this.scroll.scrollBy(-this.height);
    else if (matches(details ? 'tui.editor.pageDown' : 'tui.altScreen.pageDown'))
      this.scroll.scrollBy(this.height);
    else if (matches('tui.altScreen.halfPageUp'))
      this.scroll.scrollBy(-Math.max(1, Math.floor(this.height / 2)));
    else if (matches('tui.altScreen.halfPageDown'))
      this.scroll.scrollBy(Math.max(1, Math.floor(this.height / 2)));
    else if (matches('tui.altScreen.lineUp')) this.scroll.scrollBy(-1);
    else if (matches('tui.altScreen.lineDown')) this.scroll.scrollBy(1);
    else return false;
    return true;
  }

  handleInput(data: string) {
    if (this.leaving) return;
    if (this.narrow) {
      if (this.keys.matches(data, 'app.interrupt')) this.interrupt();
      else if (this.keys.matches(data, 'app.exit') && !this.editor.getText()) void this.leave();
    } else if (this.picker) {
      if (
        this.permission &&
        (this.keys.matches(data, 'app.interrupt') || this.keys.matches(data, 'tui.select.cancel'))
      )
        this.interrupt();
      else if (
        this.keys.matches(data, 'tui.select.pageUp') ||
        this.keys.matches(data, 'tui.select.pageDown')
      )
        this.picker.handleInput(data);
      else if (!this.scrollInput(data, true)) this.picker.handleInput(data);
    } else if (this.editor.isShowingAutocomplete() || !this.scrollInput(data))
      this.editor.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    this.narrow = width < 12;
    if (this.narrow)
      return ['Antigravity', '请加宽终端', this.hint('app.interrupt', '取消')].map((line) =>
        truncateToWidth(line, width),
      );
    const c = this.conversation;
    this.focused = this.focus;
    const input = this.picker ? this.picker.render(width) : this.editor.render(width);
    const model = this.option('model'),
      thinking = this.option('thought_level');
    const status = this.leaving ? '正在退出' : this.permission ? '等待授权' : STATES[c.state];
    const header = [
      'Antigravity',
      model && this.valueName(model),
      thinking && this.valueName(thinking),
      c.approvalMode === 'auto' ? '自动审核(Pi)' : '人工审核',
    ]
      .filter(Boolean)
      .join(' · ');
    const pending = this.queued
      .slice(0, 3)
      .map((text, index) =>
        this.theme.fg(
          'muted',
          `${this.queuePaused ? '已暂停' : '待发送'} ${index + 1}: ${plain(text).replace(/\s+/g, ' ')}`,
        ),
      );
    if (this.queued.length > 3)
      pending.push(this.theme.fg('dim', `… 还有 ${this.queued.length - 3} 条`));
    const hint = this.picker
      ? `${this.picker.searchable ? '输入搜索 · ' : ''}${this.hint('tui.select.confirm', '确认')} · ${this.hint('tui.select.cancel', '返回')}${this.permission ? ` · ${this.hint('tui.editor.pageUp', '查看前文')} · ${this.hint('tui.editor.pageDown', '查看后文')}` : ''}`
      : c.state === 'running'
        ? `${this.hint('tui.input.submit', '补充指令')} · ${this.hint('app.message.followUp', '排队')} · ${this.hint('app.interrupt', '取消')}`
        : `${this.hint('app.model.select', '模型')} · ${this.hint('app.thinking.cycle', '思考')} · ${this.hint('app.tools.expand', '工具')} · /help`;
    if (this.queued.length)
      pending.push(this.theme.fg('dim', this.hint('app.message.dequeue', '取回队列编辑')));
    const statusLines = this.loader ? this.loader.render(width) : [this.theme.fg('dim', status)];
    this.height = Math.max(
      1,
      this.tui.terminal.rows - input.length - pending.length - statusLines.length - 5,
    );
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
    const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
    return [
      this.theme.fg('accent', header),
      ...visible,
      ...Array.from({ length: Math.max(0, this.height - visible.length) }, () => ''),
      ...statusLines,
      ...pending,
      ...input,
      this.theme.fg('dim', hint),
      this.theme.fg('dim', `${plain(c.cwd)} · ${status}`),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate() {
    this.transcript.invalidate();
    this.editor.invalidate();
    this.picker?.invalidate();
    this.loader?.invalidate();
  }
  dispose() {
    this.loader?.stop();
    this.conversation.changed = () => {};
    void this.conversation.close();
  }
}
