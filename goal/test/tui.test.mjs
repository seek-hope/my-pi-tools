import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { applySpec, budgetReason, makeGoal, recordTurn, transition } from '../src/state.ts';
import { goalStatusText, renderGoalWidget } from '../src/tui.ts';

const theme = {
  fg(_color, text) {
    return `\u001b[38;5;39m${text}\u001b[39m`;
  },
  bold(text) {
    return `\u001b[1m${text}\u001b[22m`;
  },
};
const plain = (lines) => lines.map(stripTerminalSequences).join('\n');
const fixture = () => {
  const goal = makeGoal('Improve Unicode export and recovery');
  applySpec(goal, {
    objective: goal.objective,
    kind: 'coding',
    criteria: ['Unicode filenames work', 'Regression tests pass'],
    tasks: ['Reproduce the bug', 'Implement the fix'],
    checks: [],
  });
  transition(goal, 'active');
  goal.tasks[0].status = 'done';
  goal.tasks[1].status = 'active';
  goal.criteria[0].evidence.push('artifact.md:1');
  goal.nextStep = 'Run regression tests and submit for audit';
  return goal;
};

test('rounds and elapsed time remain counters, not caps, even for legacy goals', () => {
  const goal = fixture();
  for (let i = 0; i < 250; i++) recordTurn(goal, 1000, true);
  goal.epoch.seconds = 90_000;
  goal.limits.maxTurns = 200;
  goal.limits.maxSeconds = 43_200;
  assert.equal(budgetReason(goal), undefined);
  assert.deepEqual(makeGoal('Configured', { maxTurns: 1, maxSeconds: 1 }).limits, {
    maxTokens: null,
    maxAuditFailures: 3,
    noProgressWarn: 3,
    noProgressPause: 5,
  });
  const output = plain(renderGoalWidget(goal, '/tmp/project', false, theme, 100));
  assert.match(output, /Turns 250/);
  assert.match(output, /Time 25h/);
  assert.doesNotMatch(output, /250\/200|25h\/12h|undefined|NaN/);
  assert.match(goalStatusText(goal), /250 turns/);
  assert.doesNotMatch(goalStatusText(goal), /\/200/);
});

test('card separates task progress and evidence coverage from independent acceptance', () => {
  const goal = fixture();
  goal.tasks.forEach((t) => (t.status = 'done'));
  goal.criteria.forEach((c) => c.evidence.push('claimed evidence'));
  const output = plain(renderGoalWidget(goal, '/tmp/project', true, theme, 80));
  assert.match(output, /Active/);
  assert.match(output, /Tasks 2\/2/);
  assert.match(output, /Evidence 2\/2/);
  assert.doesNotMatch(output, /Verified|100%/);
  assert.match(output, /Next.*regression tests/);
  assert.match(output, /C1.*Evidence 2/);
});

test('all states fit zero, narrow and wide terminals including CJK, emoji and terminal control input', () => {
  const goal = fixture();
  goal.objective =
    '\x1b]0;bad-title\x07\x1b[31m中文 e\u0301 👩‍💻\n' + 'very long objective '.repeat(40);
  goal.nextStep = 'line1\rline2\n' + '行'.repeat(100);
  for (const status of [
    'draft',
    'queued',
    'active',
    'verifying',
    'paused',
    'blocked',
    'budget_limited',
    'complete',
    'skipped',
  ]) {
    goal.status = status;
    for (const width of [0, 1, 2, 10, 12, 24, 39, 40, 48, 64, 80, 120]) {
      for (const expanded of [false, true]) {
        const lines = renderGoalWidget(goal, '/tmp/project', expanded, theme, width, true);
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `${status}/${width}`,
        );
        assert.ok(lines.every((line) => !/[\r\n]/.test(line)));
        assert.doesNotMatch(lines.join(''), /bad-title|\x1b\[31m/);
        if (width >= 40) assert.equal(visibleWidth(lines[0]), width);
        if (width === 0) assert.deepEqual(lines, []);
      }
    }
  }
});

test('pending proposals and paused or blocked goals show approval and recovery guidance', () => {
  const goal = fixture();
  goal.pendingSpec = {
    objective: 'New proposed scope',
    kind: 'coding',
    tasks: ['New task'],
    criteria: ['New criterion'],
    checks: [],
  };
  goal.status = 'draft';
  let output = plain(renderGoalWidget(goal, '/tmp/project', true, theme, 80));
  assert.match(output, /New proposed scope/);
  assert.match(output, /goal approve/);
  assert.match(output, /Tasks 0\/1/);
  assert.match(output, /Evidence 0\/1/);
  assert.doesNotMatch(output, /Unicode filenames work/);
  delete goal.pendingSpec;
  goal.status = 'blocked';
  goal.reason = 'Missing experimental input file';
  output = plain(renderGoalWidget(goal, '/tmp/project', false, theme, 80));
  assert.match(output, /Missing experimental input/);
  goal.status = 'paused';
  assert.match(plain(renderGoalWidget(goal, '/tmp', false, theme, 80)), /goal resume/);
  assert.match(goalStatusText(goal, true), /read-only/);
});

test('expanded view prioritizes active tasks and keeps bounded height; unknown usage stays visible', () => {
  const goal = fixture();
  goal.tasks = Array.from({ length: 50 }, (_, i) => ({
    id: `T${i + 1}`,
    text: `Tasks ${i + 1}`,
    status: i === 49 ? 'active' : 'done',
    evidence: [],
  }));
  goal.criteria = Array.from({ length: 50 }, (_, i) => ({
    id: `C${i + 1}`,
    text: `Criterion ${i + 1}`,
    evidence: [],
  }));
  goal.usage.unknown = 1;
  for (const height of [6, 12, 13, 14, 15, 17, 40]) {
    const lines = renderGoalWidget(goal, '/tmp/project', true, theme, 80, false, height);
    assert.ok(lines.length <= Math.min(17, height));
    assert.match(plain(lines), /unknown/);
    if (height >= 13) assert.match(plain(lines), /T50/);
  }
});
