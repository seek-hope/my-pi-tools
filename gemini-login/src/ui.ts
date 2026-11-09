import {
  getMarkdownTheme,
  getSelectListTheme,
  type KeybindingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Editor,
  Markdown,
  ScrollView,
  SelectList,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from '@earendil-works/pi-tui';
import { choices, toolText, type Conversation, type Permission } from './conversation.ts';
import { plain } from './acp.ts';

const LABELS = {
  user: '你',
  assistant: 'Antigravity',
  thinking: '思考',
  tool: '工具',
  notice: '提示',
  plan: '计划',
};
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
const HELP =
  '输入消息开始对话。/new 新会话 · /model 模型 · /config 设置 · /login Google 登录 · /help 命令 · /exit 返回 Pi';

interface Picker {
  title: string;
  list: SelectList;
  permission?: Permission;
}

export class ChatScreen implements Component, Focusable {
  private readonly conversation: Conversation;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: () => void;
  private readonly editor: Editor;
  private readonly transcript: Markdown;
  private readonly scroll: ScrollView;
  private picker?: Picker;
  private revision = -1;
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
    this.editor = new Editor(tui, {
      borderColor: (text) => theme.fg('border', text),
      selectList: getSelectListTheme(),
    });
    this.editor.onSubmit = (text) => this.submit(text);
    this.transcript = new Markdown('', 0, 0, getMarkdownTheme());
    this.scroll = new ScrollView(this.transcript, { follow: 'end', scrollbar: 'hidden' });
    conversation.changed = () => {
      if (this.leaving) return;
      this.syncPermission();
      tui.requestRender();
    };
    conversation.note(HELP);
  }

  get focused() {
    return this.focus;
  }
  set focused(value: boolean) {
    this.focus = value;
    this.editor.focused = value && !this.picker;
  }
  get capturesViewportInput() {
    return true;
  }

  private syncPermission() {
    const permission = this.conversation.permissions[0];
    if (this.picker?.permission === permission) return;
    if (this.picker?.permission) this.picker = undefined;
    if (!permission) return;
    const { request } = permission;
    const options = [
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
    ];
    this.choose(
      'Antigravity 请求授权',
      options,
      (value) => {
        permission.answer(value ? request.options[Number(value) - 1]?.optionId : undefined);
      },
      () => permission.answer(),
    );
    this.picker!.permission = permission;
    this.conversation.note(`待授权操作：\n${toolText(request.toolCall)}`);
    this.scroll.scrollToEnd();
  }

  private choose(
    title: string,
    items: { value: string; label: string; description?: string }[],
    select: (value: string) => void,
    cancel?: () => void,
  ) {
    const list = new SelectList(items, 6, getSelectListTheme());
    list.onSelect = (item) => {
      this.picker = undefined;
      this.editor.focused = this.focus;
      select(item.value);
      this.syncPermission();
      this.tui.requestRender();
    };
    list.onCancel = () => {
      this.picker = undefined;
      this.editor.focused = this.focus;
      cancel?.();
      this.syncPermission();
      this.tui.requestRender();
    };
    this.picker = { title, list };
    this.editor.focused = false;
    this.tui.requestRender();
  }

  private config(modelOnly: boolean) {
    const options = this.conversation.config.filter(
      (option) => !modelOnly || option.category === 'model' || option.id === 'model',
    );
    if (!options.length) {
      this.conversation.note('官方服务没有提供这些设置。');
      return;
    }
    const chooseValue = (index: number) => {
      const option = options[index]!;
      const values =
        option.type === 'boolean'
          ? [
              { value: 'true', label: '开启' },
              { value: 'false', label: '关闭' },
            ]
          : choices(option).map((value) => ({
              value: value.value,
              label: plain(value.name),
              description: value.description ? plain(value.description) : undefined,
            }));
      this.choose(
        `${plain(option.name)} · 当前：${plain(String(option.currentValue))}`,
        values,
        (value) =>
          void this.conversation.configure(
            option,
            option.type === 'boolean' ? value === 'true' : value,
          ),
      );
    };
    if (options.length === 1) chooseValue(0);
    else
      this.choose(
        '会话设置',
        options.map((option, index) => ({
          value: String(index),
          label: plain(option.name),
          description: plain(String(option.currentValue)),
        })),
        (value) => chooseValue(Number(value)),
      );
  }

  submit(text: string) {
    const input = text.trim();
    if (!input || this.leaving || this.picker) return;
    if (input === '/exit') {
      void this.leave();
      return;
    }
    if (input === '/cancel') {
      void this.conversation.cancel();
      return;
    }
    if (input === '/help') {
      this.editor.setText('');
      this.conversation.note(
        `${HELP}\n\n/load <会话 ID> 载入官方会话。\nPageUp/PageDown 滚动，Ctrl+End 回到底部。Esc 取消任务，Ctrl+D 返回 Pi。\n\n官方命令：\n${this.conversation.commands.map((command) => `/${command.name} ${command.description}`).join('\n') || '(尚未提供)'}`,
      );
      return;
    }
    if (!['ready', 'login'].includes(this.conversation.state)) return;
    this.editor.setText('');
    this.editor.addToHistory(text);
    this.scroll.scrollToEnd();
    if (input === '/login') void this.conversation.login();
    else if (input === '/new') void this.conversation.open();
    else if (input.startsWith('/load ')) void this.conversation.open(input.slice(6).trim());
    else if (input === '/model' || input === '/config') {
      if (this.conversation.state === 'ready') this.config(input === '/model');
    } else if (this.conversation.state === 'ready') void this.conversation.prompt(text);
    else {
      this.editor.setText(text);
      this.conversation.note('请先输入 /login 完成 Google 登录，或 /new 重试创建会话。');
    }
    this.tui.requestRender();
  }

  leave(): Promise<void> {
    if (this.leavePromise) return this.leavePromise;
    this.leaving = true;
    this.picker?.permission?.answer();
    this.leavePromise = this.conversation.close().then(() => this.done());
    return this.leavePromise;
  }

  handleInput(data: string) {
    if (this.leaving) return;
    if (matchesKey(data, 'ctrl+d')) {
      void this.leave();
      return;
    }
    if (this.narrow) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) void this.conversation.cancel();
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.scroll.scrollBy(-this.height);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.scroll.scrollBy(this.height);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, 'ctrl+end')) {
      this.scroll.scrollToEnd();
      this.tui.requestRender();
      return;
    }
    if (this.picker) {
      if (
        this.picker.permission &&
        (this.keys.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+c'))
      )
        void this.conversation.cancel();
      else this.picker.list.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.keys.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+c')) {
      if (['running', 'cancelling'].includes(this.conversation.state))
        void this.conversation.cancel();
      else if (this.conversation.state !== 'ready' && this.conversation.state !== 'login')
        void this.leave();
      else if (this.editor.getText()) this.editor.setText('');
      else void this.leave();
    } else {
      this.editor.disableSubmit = !['ready', 'login'].includes(this.conversation.state);
      this.editor.handleInput(data);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    width = Math.max(1, width);
    this.narrow = width < 12;
    if (this.narrow)
      return ['Antigravity', '请加宽终端', 'Esc 取消 · Ctrl+D 退出'].map((line) =>
        truncateToWidth(line, width),
      );
    const c = this.conversation;
    if (this.revision !== c.revision) {
      this.revision = c.revision;
      const text = `${c.trimmed ? '[较早的显示内容已省略；官方会话上下文不受影响]\n\n' : ''}${c.entries.map((entry) => `**${LABELS[entry.kind]}**\n\n${entry.text}`).join('\n\n---\n\n')}`;
      this.transcript.setText(text);
    }
    const model = c.config.find((option) => option.category === 'model' || option.id === 'model');
    const header = `${plain(c.title)} · ${this.leaving ? '正在退出' : STATES[c.state]}${model ? ` · ${plain(String(model.currentValue))}` : ''}`;
    this.editor.focused = this.focus && !this.picker;
    const input = this.picker
      ? [this.theme.fg('warning', this.picker.title), ...this.picker.list.render(width)]
      : this.editor.render(width);
    this.height = Math.max(1, Math.min(40, this.tui.terminal.rows - input.length - 5));
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, this.height, () => this.tui.requestRender());
    const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.height);
    const footer = this.picker
      ? '↑↓ 选择 · Enter 确认 · Esc 取消授权/选择 · PageUp 查看操作详情 · Ctrl+D 返回 Pi'
      : 'Enter 发送 · Shift+Enter 换行 · Esc 取消 · PageUp/Down 滚动 · /help · Ctrl+D 返回 Pi';
    return [
      this.theme.fg('accent', header),
      this.theme.fg(
        'dim',
        `项目：${plain(c.cwd)}${c.sessionId ? ` · 会话：${plain(c.sessionId)}` : ''}`,
      ),
      ...visible,
      ...Array.from({ length: Math.max(0, this.height - visible.length) }, () => ''),
      ...input,
      this.theme.fg('dim', footer),
    ].map((line) => truncateToWidth(line, width));
  }

  invalidate() {
    this.revision = -1;
    this.transcript.invalidate();
    this.editor.invalidate();
    this.picker?.list.invalidate();
  }

  dispose() {
    this.conversation.changed = () => {};
    void this.conversation.close();
  }
}
