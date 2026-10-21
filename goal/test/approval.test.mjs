import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesKey, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { formatPendingScope, createScopeReview, confirmPendingScope } from '../src/approval.ts';
import { permissionDefaults } from '../src/state.ts';
import { permissionSummary } from '../src/permissions.ts';

const spec = {
  objective: 'Fix CSV export for 中文 filenames',
  kind: 'coding',
  criteria: ['Keep Unicode filenames', 'Keep all rows'],
  tasks: ['Fix export', 'Run regression tests'],
  checks: [{ command: 'npm test' }],
};
const theme = { fg: (_c, s) => s, bold: (s) => s };
const keys = {
  getKeys: (action) =>
    ({
      'tui.select.confirm': ['enter'],
      'tui.select.cancel': ['escape'],
      'tui.select.up': ['up'],
      'tui.select.down': ['down'],
    })[action] ?? [],
  matches(data, action) {
    return this.getKeys(action).some((key) => matchesKey(data, key));
  },
};
const plain = (lines) => lines.map(stripTerminalSequences).join('\n');

test('approval summary presents complete sections, counts and policy without JSON serialization', () => {
  const before = structuredClone(spec);
  const output = formatPendingScope(spec, permissionDefaults());
  assert.match(output, /Objective\n  Fix CSV export/);
  assert.match(output, /Kind\n  Coding/);
  assert.match(
    output,
    /Acceptance criteria \(2\)\n  1\. Keep Unicode filenames\n  2\. Keep all rows/,
  );
  assert.match(output, /Tasks \(2\)\n  1\. Fix export/);
  assert.match(output, /Checks \(1\)\n  1\. npm test/);
  assert.ok(output.includes(permissionSummary(permissionDefaults())));
  assert.doesNotMatch(output, /"objective"|"criteria"|"command"|\{\n|\[\n/);
  assert.deepEqual(spec, before);
});
test('approval summary retains long, multiline and literal command content and shows controls safely', () => {
  const long = '中文👩‍💻e\u0301'.repeat(1000) + 'TAIL';
  const command = 'python - <<\'PY\'\nprint("$HOME \\n")\n  # indented\nPY';
  const proposal = {
    ...spec,
    objective: long,
    criteria: ['first\n\nlast'],
    tasks: [],
    checks: [{ command }],
  };
  const output = formatPendingScope(proposal, permissionDefaults('confirm'));
  assert.ok(output.includes(long));
  assert.match(output, /Tasks \(0\)\n  None specified\./);
  assert.ok(output.includes(command.split('\n').join('\n     ')));
  assert.match(output, /first\n     \n     last/);
  assert.match(
    formatPendingScope({ ...spec, checks: [] }, permissionDefaults()),
    /Checks \(0\)\n  None specified\./,
  );
  const controls = formatPendingScope(
    { ...spec, objective: 'x\x1b[2J\r\t\u202ehidden' },
    permissionDefaults(),
  );
  assert.doesNotMatch(controls, /[\x00-\x09\x0b-\x1f\u202e]/);
  assert.match(controls, /\\u001b\[2J\\u000d\\u0009\\u202ehidden/);
});
test('approval viewport supports complete scrolling, narrow Unicode layout, resize and cancellation', () => {
  const message = formatPendingScope(
    {
      ...spec,
      tasks: Array.from({ length: 50 }, (_, i) => `Task ${i} 中文👩‍💻 ${'word '.repeat(12)}`),
    },
    permissionDefaults(),
  );
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const decisions = [];
  const view = createScopeReview(message, tui, theme, keys, (v) => decisions.push(v));
  let lines = view.render(48);
  assert.ok(lines.length <= 22 && lines.every((l) => visibleWidth(l) <= 48));
  assert.match(plain(lines), /Objective/);
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    for (const line of view.render(48)) seen.add(stripTerminalSequences(line));
    view.handleInput('\x1b[B');
  }
  const all = [...seen].join('\n');
  for (let i = 0; i < 50; i++) assert.ok(all.includes(`Task ${i} `), `scroll reaches task ${i}`);
  assert.match(all, /Execution permissions/);
  view.handleInput('\x1b[H');
  assert.match(plain(view.render(48)), /Objective/);
  view.handleInput('\x1b[6~');
  assert.doesNotMatch(plain(view.render(48)), /\n  Objective\n/);
  view.handleInput('\x1b[5~');
  assert.match(plain(view.render(48)), /Objective/);
  for (const width of [0, 1, 8, 12, 24, 48, 80, 120])
    for (const rows of [0, 6, 9, 16, 24, 40]) {
      tui.terminal.rows = rows;
      lines = view.render(width);
      assert.ok(lines.length <= Math.max(0, rows - 2));
      assert.ok(
        lines.every((l) => visibleWidth(l) <= width),
        `${width}/${rows}`,
      );
    }
  tui.terminal.rows = 24;
  view.render(80);
  view.handleInput('\x1b[F');
  assert.match(plain(view.render(80)), /Execution permissions/);
  view.handleInput('\x1b');
  view.handleInput('\r');
  assert.deepEqual(decisions, [false]);
});
test('approval respects host confirm bindings, blocks invisible acceptance, and preserves RPC/non-UI routing', async () => {
  const decisions = [];
  const tui = { terminal: { rows: 4 }, requestRender() {} };
  const rebound = {
    ...keys,
    getKeys: (action) => (action === 'tui.select.confirm' ? ['ctrl+y'] : keys.getKeys(action)),
  };
  const view = createScopeReview('Objective\n  Example', tui, theme, rebound, (v) =>
    decisions.push(v),
  );
  view.render(80);
  view.handleInput('\x19');
  assert.deepEqual(decisions, []);
  tui.terminal.rows = 24;
  view.render(80);
  view.handleInput('\r');
  assert.deepEqual(decisions, []);
  view.handleInput('\x19');
  assert.deepEqual(decisions, [true]);
  let shown;
  const ctx = {
    hasUI: true,
    mode: 'rpc',
    ui: {
      confirm: async (title, message) => {
        shown = { title, message };
        return true;
      },
      custom() {
        assert.fail('RPC cannot show custom UI');
      },
    },
  };
  assert.equal(await confirmPendingScope(ctx, spec, permissionDefaults()), true);
  assert.equal(shown.message, formatPendingScope(spec, permissionDefaults()));
  ctx.hasUI = false;
  shown = undefined;
  assert.equal(await confirmPendingScope(ctx, spec, permissionDefaults()), false);
  assert.equal(shown, undefined);
});
