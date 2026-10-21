import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  matchesKey,
  ScrollView,
  Text,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
} from '@earendil-works/pi-tui';
import type { GoalSpec, PermissionPolicy } from './state.ts';
import { permissionSummary } from './permissions.ts';

// Preserve text and explicit line breaks. Show controls literally instead of
// letting a proposal change terminal state, hide text or reorder its display.
const safeText = (value: string) =>
  value.replace(
    /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
const indent = (text: string, prefix: string) =>
  safeText(text)
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');

/** Complete, untruncated plain text, shared by TUI and RPC confirmation. */
export function formatPendingScope(spec: GoalSpec, policy: PermissionPolicy): string {
  const list = (title: string, values: string[]) =>
    [
      `${title} (${values.length})`,
      values.length
        ? values.map((value, i) => `  ${i + 1}. ${indent(value, '     ').slice(5)}`).join('\n')
        : '  None specified.',
    ].join('\n');
  return [
    'Objective\n' + indent(spec.objective || '(empty)', '  '),
    `Kind\n  ${{ coding: 'Coding', research: 'Research', general: 'General' }[spec.kind]}`,
    list('Acceptance criteria', spec.criteria),
    list('Tasks', spec.tasks),
    list(
      'Checks',
      spec.checks.map(({ command }) => command),
    ),
    'Execution permissions\n' + indent(permissionSummary(policy), '  '),
  ].join('\n\n');
}

/** Bounded overlay; ScrollView owns clamping/navigation, Text owns Unicode wrapping. */
export function createScopeReview(
  message: string,
  tui: Pick<TUI, 'terminal' | 'requestRender'>,
  theme: Pick<Theme, 'fg' | 'bold'>,
  keys: Pick<KeybindingsManager, 'matches' | 'getKeys'>,
  done: (accepted: boolean) => void,
): Component {
  const body = new Text(message, 0, 0);
  const scroll = new ScrollView(body, { follow: 'none', scrollbar: 'hidden' });
  let finished = false;
  let rendered = false;
  const finish = (value: boolean) => {
    if (!finished) {
      finished = true;
      done(value);
    }
  };
  const keyLabel = (action: 'tui.select.confirm' | 'tui.select.cancel', fallback: string) =>
    keys.getKeys(action).join('/') || fallback;
  return {
    render(width) {
      const rows = Math.max(0, tui.terminal.rows - 2);
      if (width < 12 || rows < 7) {
        rendered = false;
        return rows ? [truncateToWidth('Enlarge terminal to review; Esc cancels', width)] : [];
      }
      const inner = width - 4;
      const lines = scroll.render(inner);
      const height = Math.min(lines.length, rows - 6);
      // Overlays are rendered as line arrays in both Pi display modes. Feed
      // ScrollView the viewport and render its selected slice within fixed chrome.
      scroll.updateLayout(lines.length, height, () => tui.requestRender());
      rendered = true;
      const frame = (line: string) => `  ${line}`;
      const rule = theme.fg('borderMuted', '─'.repeat(width));
      return [
        rule,
        frame(theme.fg('accent', theme.bold(truncateToWidth('Review goal scope', inner)))),
        ...lines.slice(scroll.scrollTop, scroll.scrollTop + height).map(frame),
        rule,
        frame(
          theme.fg(
            'muted',
            truncateToWidth(
              `Lines ${scroll.scrollTop + 1}–${Math.min(lines.length, scroll.scrollTop + height)} / ${lines.length} · ↑↓ / PgUp PgDn scroll`,
              inner,
            ),
          ),
        ),
        frame(
          truncateToWidth(
            `${keyLabel('tui.select.confirm', 'Enter')}: approve · ${keyLabel('tui.select.cancel', 'Esc')}: cancel`,
            inner,
          ),
        ),
        rule,
      ];
    },
    handleInput(data) {
      if (finished) return;
      if (
        keys.matches(data, 'tui.select.cancel') ||
        matchesKey(data, 'escape') ||
        matchesKey(data, 'ctrl+c')
      )
        finish(false);
      else if (keys.matches(data, 'tui.select.confirm') && rendered) finish(true);
      else if (matchesKey(data, 'pageUp')) scroll.scrollBy(-Math.max(1, scroll.viewportHeight));
      else if (matchesKey(data, 'pageDown')) scroll.scrollBy(Math.max(1, scroll.viewportHeight));
      else if (matchesKey(data, 'home')) scroll.scrollToStart();
      else if (matchesKey(data, 'end')) scroll.scrollToEnd();
      else if (keys.matches(data, 'tui.select.up') || matchesKey(data, 'up')) scroll.scrollBy(-1);
      else if (keys.matches(data, 'tui.select.down') || matchesKey(data, 'down'))
        scroll.scrollBy(1);
    },
    invalidate() {
      body.invalidate();
    },
  };
}

export async function confirmPendingScope(
  ctx: ExtensionContext,
  spec: GoalSpec,
  policy: PermissionPolicy,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const message = formatPendingScope(spec, policy);
  if (ctx.mode !== 'tui') return ctx.ui.confirm('Approve goal scope', message);
  return (
    (await ctx.ui.custom<boolean>(
      (tui, theme, keys, done) => createScopeReview(message, tui, theme, keys, done),
      { overlay: true, overlayOptions: { width: '100%', margin: { top: 1, bottom: 1 } } },
    )) === true
  );
}
