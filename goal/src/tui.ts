import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import type { Goal } from './state.ts';

export type GoalTheme = Pick<Theme, 'fg' | 'bold'>;
const META: Record<Goal['status'], { label: string; symbol: string; color: ThemeColor }> = {
  draft: { label: 'Awaiting approval', symbol: '◇', color: 'warning' },
  queued: { label: 'Queued', symbol: '·', color: 'muted' },
  active: { label: 'Active', symbol: '◆', color: 'accent' },
  verifying: { label: 'Auditing', symbol: '◈', color: 'accent' },
  paused: { label: 'Paused', symbol: 'Ⅱ', color: 'warning' },
  blocked: { label: 'Needs input', symbol: '!', color: 'warning' },
  budget_limited: { label: 'Budget reached', symbol: '!', color: 'error' },
  complete: { label: 'Verified', symbol: '✓', color: 'success' },
  skipped: { label: 'Skipped', symbol: '—', color: 'muted' },
};
const clean = (text: string) =>
  stripTerminalSequences(text)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const number = (value: number) =>
  value < 1000
    ? String(value)
    : value < 1_000_000
      ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
const duration = (seconds: number) =>
  seconds < 60
    ? `${Math.floor(seconds)}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : `${(seconds / 3600).toFixed(1).replace(/\.0$/, '')}h`;

export function goalStatusText(goal: Goal, readOnly = false) {
  const meta = META[goal.status];
  return `${meta.symbol} ${meta.label} · ${goal.epoch.turns} turns${readOnly ? ' · read-only' : ''}`;
}

function guidance(goal: Goal, readOnly: boolean): string {
  if (readOnly)
    return 'Another Pi instance is using this session; ownership is acquired automatically when available';
  if (goal.pendingSpec) return 'Review the scope with /goal approve';
  switch (goal.status) {
    case 'draft':
      return 'Inspect and plan read-only, then wait for scope approval';
    case 'paused':
      return `${goal.reason ?? 'Progress saved'} · /goal resume`;
    case 'blocked':
      return `${goal.reason ?? 'Your input is needed'} · /goal for details`;
    case 'budget_limited':
      return `${goal.reason ?? 'Token budget exhausted'} · adjust /goal budget, then /goal resume`;
    case 'complete':
      return 'Independent audit passed; results saved';
    case 'verifying':
      return 'Checking artifacts against acceptance criteria';
    case 'skipped':
      return 'History retained';
    case 'queued':
      return 'Waiting for the preceding goal';
    default:
      return goal.nextStep || goal.reason || 'Working; waiting for the next progress update';
  }
}

/** Pure, bounded rendering: no journal reads or mutations on the TUI render path. */
export function renderGoalWidget(
  goal: Goal | undefined,
  directory: string,
  expanded: boolean,
  theme: GoalTheme,
  width: number,
  readOnly = false,
  maxLines = 17,
): string[] {
  width = Math.max(0, Math.floor(width));
  if (!goal || !width) return [];
  const meta = META[goal.status];
  const c = (color: ThemeColor, text: string) => theme.fg(color, text);
  const clip = (text: string, columns = width) => truncateToWidth(text, columns, '…');
  const objective = clean(goal.pendingSpec?.objective ?? goal.objective);
  const hint = clean(guidance(goal, readOnly));
  if (width < 12) return [clip(`${meta.symbol} ${meta.label} ${objective}`)];

  // Pending proposals must not inherit completed tasks or evidence from the old specification.
  const tasks = goal.pendingSpec
    ? goal.pendingSpec.tasks.map((text, i) => ({
        id: `T${i + 1}`,
        text,
        status: 'pending' as const,
      }))
    : goal.tasks;
  const criteria = goal.pendingSpec
    ? goal.pendingSpec.criteria.map((text, i) => ({
        id: `C${i + 1}`,
        text,
        evidence: [] as string[],
      }))
    : goal.criteria;
  const done = tasks.filter((t) => t.status === 'done').length;
  const covered = criteria.filter((item) => item.evidence.length > 0).length;
  const tokens = `${number(goal.usage.tokens + goal.usage.auditTokens)}${goal.limits.maxTokens === null ? '' : `/${number(goal.limits.maxTokens)}`}${goal.usage.unknown ? ' + unknown' : ''}`;
  const status = c(meta.color, `${meta.symbol} ${meta.label}${readOnly ? ' · read-only' : ''}`);
  const rounds = `Turns ${goal.epoch.turns}`;
  if (width < 40) {
    return [
      status,
      objective,
      c('muted', rounds),
      c('muted', `token ${tokens}`),
      c('muted', hint),
    ].map((line) => clip(line));
  }

  const inner = width - 4;
  const frame = (text: string) => c('borderMuted', text);
  const row = (text: string) =>
    `${frame('│')} ${truncateToWidth(text, inner, '…', true)} ${frame('│')}`;
  const id = width >= 72 ? c('dim', ` ${goal.id.slice(0, 8)} `) : '';
  const header = clip(
    ` ${theme.bold(c('accent', 'my-pi-goal'))}  ${status} `,
    width - 3 - visibleWidth(id),
  );
  const lines = [
    frame('╭─') +
      header +
      frame('─'.repeat(Math.max(0, width - 3 - visibleWidth(header) - visibleWidth(id)))) +
      id +
      frame('╮'),
  ];
  lines.push(row(theme.bold(c('text', objective))));
  const taskCount = tasks.length ? `Tasks ${done}/${tasks.length}` : 'Tasks —';
  const cells = inner >= 60 ? 12 : 8;
  const filled = tasks.length ? Math.round((done / tasks.length) * cells) : 0;
  const bar = tasks.length
    ? `${c('accent', '━'.repeat(filled))}${c('borderMuted', '─'.repeat(cells - filled))} `
    : '';
  // Evidence coverage is explicitly labelled; it is not an independent acceptance verdict.
  lines.push(
    row(`${bar}${c('muted', taskCount)}   ${c('muted', `Evidence ${covered}/${criteria.length}`)}`),
  );
  const time = `Time ${duration(goal.epoch.seconds)}`;
  lines.push(
    row(
      `${c('muted', rounds)} · ${c('muted', `token ${tokens}`)}${inner >= 64 ? ` · ${c('dim', time)}` : ''}`,
    ),
  );
  const hintLabel = goal.status === 'active' ? 'Next' : 'Hint';
  lines.push(row(`${c('muted', `${hintLabel} `)}${c(meta.color, hint)}`));

  if (expanded && maxLines >= 13) {
    const limit = Math.min(3, Math.floor((maxLines - 11) / 2));
    const section = (label: string) =>
      row(
        c('borderMuted', `── ${label} ${'─'.repeat(Math.max(0, inner - visibleWidth(label) - 4))}`),
      );
    lines.push(section('Tasks'));
    const prioritized = [...tasks].sort(
      (a, b) =>
        ({ active: 0, pending: 1, done: 2 })[a.status] -
        { active: 0, pending: 1, done: 2 }[b.status],
    );
    for (const task of prioritized.slice(0, limit)) {
      const mark =
        task.status === 'done'
          ? c('success', '✓')
          : task.status === 'active'
            ? c('accent', '›')
            : c('dim', '○');
      lines.push(row(`${mark} ${c('dim', task.id)} ${c('text', clean(task.text))}`));
    }
    if (!tasks.length) lines.push(row(c('dim', 'No tasks recorded')));
    if (tasks.length > limit)
      lines.push(
        row(
          c(
            'dim',
            `${tasks.length - limit} more ${tasks.length - limit === 1 ? 'task' : 'tasks'} in the full record`,
          ),
        ),
      );
    lines.push(section('Criteria and evidence'));
    for (const criterion of criteria.slice(0, limit)) {
      // A dot denotes submitted evidence. Only the goal status can say "Verified".
      const mark = criterion.evidence.length ? c('accent', '●') : c('dim', '○');
      const label = `${mark} ${c('dim', criterion.id)} ${c('muted', `[Evidence ${criterion.evidence.length}]`)} `;
      lines.push(row(label + c('text', clean(criterion.text))));
    }
    if (!criteria.length) lines.push(row(c('dim', 'Waiting for acceptance criteria')));
    if (criteria.length > limit)
      lines.push(
        row(
          c(
            'dim',
            `${criteria.length - limit} more ${criteria.length - limit === 1 ? 'criterion' : 'criteria'} in the full record`,
          ),
        ),
      );
    lines.push(row(c('dim', `Record ${clean(directory)}/STATUS.md`)));
  }
  const footer =
    width >= 72
      ? ` /goal panel ${expanded ? 'compact' : 'expand'} · /goal panel hide `
      : ' /goal panel hide ';
  lines.push(frame(`╰─${footer}${'─'.repeat(Math.max(0, width - 3 - visibleWidth(footer)))}╯`));
  return lines;
}
