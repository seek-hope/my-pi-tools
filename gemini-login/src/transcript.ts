import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { Markdown, Text, type Component } from '@earendil-works/pi-tui';
import type { Conversation, Entry } from './conversation.ts';

/** Cache each message independently so streaming does not re-highlight history. */
export class Transcript implements Component {
  expanded = false;
  thinking = false;
  private readonly cache = new Map<Entry, { text: string; component: Component }>();

  private readonly conversation: Conversation;
  private readonly theme: Theme;

  constructor(conversation: Conversation, theme: Theme) {
    this.conversation = conversation;
    this.theme = theme;
  }

  render(width: number): string[] {
    const active = new Set(this.conversation.entries);
    for (const entry of this.cache.keys()) if (!active.has(entry)) this.cache.delete(entry);
    const lines: string[] = this.conversation.trimmed
      ? [this.theme.fg('dim', '[较早的显示内容已省略]'), '']
      : [];
    for (const entry of this.conversation.entries) {
      if (entry.kind === 'thinking' && !this.thinking) continue;
      let text = entry.text;
      if (entry.kind === 'tool' && !this.expanded) {
        const all = text.split('\n');
        text = all.slice(0, 6).join('\n');
        if (all.length > 6) text += `\n… 还有 ${all.length - 6} 行`;
      }
      let cached = this.cache.get(entry);
      if (!cached || cached.text !== text) {
        let component: Component;
        if (entry.kind === 'assistant' || entry.kind === 'plan')
          component = new Markdown(text, 1, 0, getMarkdownTheme());
        else if (entry.kind === 'user')
          component = new Text(text, 1, 1, (line) => this.theme.bg('userMessageBg', line));
        else if (entry.kind === 'tool')
          component = new Text(text, 1, 1, (line) =>
            this.theme.bg(
              entry.toolStatus === 'failed'
                ? 'toolErrorBg'
                : entry.toolStatus === 'completed'
                  ? 'toolSuccessBg'
                  : 'toolPendingBg',
              line,
            ),
          );
        else component = new Text(this.theme.fg('dim', text), 1, 0);
        cached = { text, component };
        this.cache.set(entry, cached);
      }
      lines.push(...cached.component.render(width), '');
    }
    return lines;
  }

  invalidate() {
    this.cache.clear();
  }
}
