import test from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { testKeys, testTheme } from './ui-fixtures.mjs';
import { ChatScreen } from '../src/ui.ts';
import { fixture, until } from './fixtures.mjs';

initTheme('dark', false);
const theme = testTheme;
const tui = () => ({ terminal: { rows: 30, columns: 90 }, requestRender() {} });

async function view(t, bindings = {}, scenario = 'normal', reviewer) {
  const keys = testKeys(t, bindings);
  const { conversation, ...rest } = await fixture(t, scenario, 1000, reviewer);
  let done = 0;
  const screen = new ChatScreen(conversation, tui(), theme, keys, () => done++);
  screen.focused = true;
  await conversation.start();
  return { ...rest, conversation, screen, done: () => done };
}

test('chat screen renders Chinese, emoji and multiline input at narrow widths with native cursor focus', async (t) => {
  const { conversation: c, screen } = await view(t);
  await c.prompt('中文');
  screen.handleInput('编辑 👋');
  for (const width of [1, 8, 30, 90]) {
    const lines = screen.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `overflow at ${width}`,
    );
  }
  assert.ok(screen.render(90).some((line) => line.includes(CURSOR_MARKER)));
  screen.focused = false;
  assert.ok(screen.render(90).every((line) => !line.includes(CURSOR_MARKER)));
});

test('native permission selector starts on cancel and never grants on an accidental Enter', async (t) => {
  const { conversation: c, screen } = await view(t);
  const prompt = c.prompt('permission');
  await until(() => c.permissions.length === 1);
  assert.match(screen.render(90).join('\n'), /Antigravity 请求授权/);
  screen.handleInput('\r');
  await prompt;
  assert.match(c.entries.at(-1).text, /cancelled/);
});

test('permission selection forwards the chosen option and Esc cancels all pending requests', async (t) => {
  const { conversation: c, screen } = await view(t);
  const prompt = c.prompt('permission');
  await until(() => c.permissions.length === 1);
  screen.handleInput('\x1b[B');
  screen.handleInput('\r');
  await prompt;
  assert.match(c.entries.at(-1).text, /"optionId":"allow"/);
  const next = c.prompt('permission-two');
  await until(() => c.permissions.length === 2);
  screen.handleInput('\x1b');
  await next;
  assert.equal(c.permissions.length, 0);
  assert.equal(c.state, 'ready');
});

test('Enter steers a running turn and an empty Ctrl+D cancels the entire turn before leaving', async (t) => {
  const { conversation: c, screen, done } = await view(t);
  const prompt = c.prompt('wait');
  await until(() => c.entries.some((entry) => entry.text.includes('Partial output')));
  screen.handleInput('steer');
  screen.handleInput('\r');
  await until(() => c.entries.some((entry) => entry.text.includes('Steering acknowledged')));
  assert.equal(c.state, 'running');
  screen.handleInput('\x04');
  await until(() => done() === 1);
  await prompt;
  assert.equal(c.state, 'closed');
});

test('model picker reflects live server options and updates through ACP', async (t) => {
  const { conversation: c, screen } = await view(t);
  screen.submit('/model');
  assert.match(screen.render(90).join('\n'), /Gemini Other/);
  screen.handleInput('\x1b[B');
  screen.handleInput('\r');
  await until(() => c.config[0].currentValue === 'gemini-other');
  assert.match(screen.render(90).join('\n'), /Gemini Other/);
});

test('Ctrl+D edits a nonempty draft, idle Esc preserves it, Ctrl+C clears then exits on a double press', async (t) => {
  const { screen, done } = await view(t);
  screen.handleInput('draft');
  screen.handleInput('\x01');
  screen.handleInput('\x04');
  assert.equal(screen.editor.getExpandedText(), 'raft');
  screen.handleInput('\x1b');
  assert.equal(screen.editor.getExpandedText(), 'raft');
  assert.equal(done(), 0);
  screen.handleInput('\x03');
  assert.equal(screen.editor.getExpandedText(), '');
  assert.equal(done(), 0);
  screen.handleInput('\x03');
  await until(() => done() === 1);
});

test('native command completion and autocomplete Escape do not cancel an active turn', async (t) => {
  const { conversation: c, screen } = await view(t);
  await c.prompt('commands');
  screen.handleInput('/off');
  await until(() => screen.editor.isShowingAutocomplete());
  assert.match(screen.render(90).join('\n'), /official-command/);
  screen.handleInput('\x1b');
  screen.editor.setText('');
  const turn = c.prompt('wait');
  screen.handleInput('/mod');
  await until(() => screen.editor.isShowingAutocomplete());
  screen.handleInput('\x1b');
  assert.equal(c.state, 'running');
  assert.equal(screen.editor.getText(), '/mod');
  await c.cancel();
  await turn;
});

test('models are searchable, the current value is selected, and hotkeys preserve the draft', async (t) => {
  const { conversation: c, screen } = await view(t);
  screen.handleInput('keep draft');
  screen.handleInput('\x0c');
  screen.handleInput('other');
  screen.handleInput('\r');
  await until(() => c.state === 'ready' && c.config[0].currentValue === 'gemini-other');
  assert.equal(screen.editor.getExpandedText(), 'keep draft');
  screen.handleInput('\x0c');
  screen.handleInput('\r');
  await until(() => c.state === 'ready');
  assert.equal(c.config[0].currentValue, 'gemini-other');
  screen.handleInput('\x1b[Z');
  await until(() => c.state === 'ready' && c.config[1].currentValue === 'low');
  screen.handleInput('\x10');
  await until(() => c.state === 'ready' && c.config[0].currentValue === 'gemini-test');
});

test('follow-ups wait for the full turn and can be restored with expanded paste content', async (t) => {
  const { conversation: c, screen } = await view(t);
  const first = c.prompt('wait');
  await until(() => c.entries.some((entry) => entry.text.includes('Partial output')));
  screen.handleInput('follow-up');
  screen.handleInput('\x1b\r');
  assert.match(screen.render(90).join('\n'), /待发送 1: follow-up/);
  assert.ok(!c.entries.some((entry) => entry.kind === 'user' && entry.text === 'follow-up'));
  screen.submit('steer');
  await until(() => c.entries.some((entry) => entry.text.includes('Steering acknowledged')));
  assert.ok(!c.entries.some((entry) => entry.kind === 'user' && entry.text === 'follow-up'));
  screen.submit('finish');
  await first;
  await until(
    () =>
      c.state === 'ready' &&
      c.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('follow-up')),
  );

  const wait = c.prompt('wait');
  const pasted = '多行原文\n'.repeat(40);
  screen.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  screen.handleInput('\x1b\r');
  screen.handleInput('draft');
  screen.handleInput('\x1b[1;3A');
  assert.equal(screen.editor.getExpandedText(), `${pasted}\n\ndraft`);
  await c.cancel();
  await wait;
});

test('cancelled turns never automatically run queued work', async (t) => {
  const { conversation: c, screen } = await view(t);
  const turn = c.prompt('wait');
  screen.handleInput('must stay queued');
  screen.handleInput('\x1b\r');
  screen.handleInput('\x1b');
  await turn;
  assert.equal(c.state, 'ready');
  assert.ok(!c.entries.some((entry) => entry.kind === 'user' && entry.text === 'must stay queued'));
  screen.submit('new unrelated task');
  await until(
    () =>
      c.state === 'ready' &&
      c.entries.some(
        (entry) => entry.kind === 'assistant' && entry.text.includes('new unrelated task'),
      ),
  );
  assert.ok(!c.entries.some((entry) => entry.kind === 'user' && entry.text === 'must stay queued'));
  screen.handleInput('\x1b[1;3A');
  assert.equal(screen.editor.getExpandedText(), 'must stay queued');
});

test('custom application and selector bindings control actions and appear in hints', async (t) => {
  const {
    conversation: c,
    screen,
    done,
  } = await view(t, {
    'app.model.select': 'ctrl+g',
    'app.interrupt': 'ctrl+x',
    'app.exit': 'ctrl+e',
    'tui.select.confirm': 'ctrl+n',
    'tui.select.cancel': 'ctrl+]',
  });
  assert.match(screen.render(90).join('\n'), /ctrl\+g 模型/);
  screen.handleInput('\x0c');
  assert.equal(screen.picker, undefined);
  screen.handleInput('\x07');
  assert.ok(screen.picker);
  screen.handleInput('other');
  screen.handleInput('\x0e');
  await until(() => c.config[0].currentValue === 'gemini-other');
  screen.handleInput('\x04');
  assert.equal(done(), 0);
  const turn = c.prompt('wait');
  screen.handleInput('\x18');
  await turn;
  screen.handleInput('\x05');
  await until(() => done() === 1);
});

test('resume searches current-project sessions and supports pagination', async (t) => {
  const { conversation: c, screen } = await view(t);
  screen.submit('/resume');
  await until(() => screen.picker !== undefined);
  assert.match(screen.render(90).join('\n'), /Saved research/);
  assert.doesNotMatch(screen.render(90).join('\n'), /Wrong project/);
  screen.handleInput('更多');
  screen.handleInput('\r');
  await until(() => screen.render(90).join('\n').includes('Earlier research'));
  screen.handleInput('Earlier');
  screen.handleInput('\r');
  await until(() => c.state === 'ready' && c.sessionId === 'older-session');
  assert.match(screen.render(90).join('\n'), /Earlier answer/);
});

test('tool output and thinking collapse independently; approval details always remain visible', async (t) => {
  const { conversation: c, screen } = await view(t);
  await c.prompt('hello');
  assert.doesNotMatch(screen.render(90).join('\n'), /考虑中/);
  screen.handleInput('\x14');
  assert.match(screen.render(90).join('\n'), /考虑中/);
  const turn = c.prompt('permission');
  await until(() => c.permissions.length === 1);
  assert.match(screen.render(90).join('\n'), /approved/);
  screen.handleInput('\r');
  await turn;
  screen.handleInput('\x0f');
  assert.equal(screen.transcript.expanded, true);
});

test('initial prompts survive authentication and message limits preserve the draft', async (t) => {
  const { conversation: c, screen } = await view(t, {}, 'auth');
  screen.enqueueInitial('first after login');
  screen.submit('/login');
  await until(
    () =>
      c.state === 'ready' &&
      c.entries.some(
        (entry) => entry.kind === 'assistant' && entry.text.includes('first after login'),
      ),
  );
  const tooLong = 'x'.repeat(120001);
  screen.editor.setText(tooLong);
  screen.handleInput('\r');
  assert.equal(screen.editor.getExpandedText(), tooLong);
});

test('native Enter preserves a rejected draft on disconnect and when the queue is full', async (t) => {
  const { conversation: c, screen } = await view(t, {}, 'auth');
  for (let i = 0; i < 32; i++) screen.submit(`queued ${i}`, true);
  screen.editor.setText('overflow draft');
  screen.handleInput('\r');
  assert.equal(screen.editor.getExpandedText(), 'overflow draft');
  await c.close();
  screen.handleInput('\r');
  assert.equal(screen.editor.getExpandedText(), 'overflow draft');
});

test('idle Escape does not prevent a later Alt+Enter from sending', async (t) => {
  const { conversation: c, screen } = await view(t);
  screen.handleInput('\x1b');
  screen.handleInput('after escape');
  screen.handleInput('\x1b\r');
  await until(
    () =>
      c.state === 'ready' &&
      c.entries.some((entry) => entry.kind === 'assistant' && entry.text.includes('after escape')),
  );
});

test('input queued during session discovery cannot run in the previous session', async (t) => {
  const { conversation: c, screen } = await view(t, {}, 'slow-list');
  const old = c.sessionId;
  screen.submit('/resume');
  screen.submit('question for the selected session');
  await until(() => screen.picker !== undefined);
  assert.ok(!c.entries.some((entry) => entry.kind === 'user'));
  screen.handleInput('\r');
  assert.equal(c.sessionId, old);
  assert.equal(screen.editor.getExpandedText(), 'question for the selected session');
  assert.ok(!c.entries.some((entry) => entry.kind === 'user'));
});

for (const message of ['failure', 'bad-response', 'crash', 'limited']) {
  test(`queued work stays editable after ${message}`, async (t) => {
    const { conversation: c, screen } = await view(t);
    const turn = c.prompt(message);
    screen.submit('keep for later', true);
    await turn;
    assert.ok(!c.entries.some((entry) => entry.kind === 'user' && entry.text === 'keep for later'));
    screen.handleInput('\x1b[1;3A');
    assert.equal(screen.editor.getExpandedText(), 'keep for later');
  });
}

test('automatic approval shows its Pi source without displaying a human prompt, and can be switched off', async (t) => {
  let finish;
  const reviewer = {
    label: 'offline/review-model',
    requests: 0,
    tokens: 0,
    review: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const { conversation: c, screen } = await view(t, {}, 'normal', reviewer);
  const turn = c.prompt('permission');
  await until(() => finish);
  assert.match(screen.render(90).join('\n'), /自动审核\(Pi\)/);
  assert.match(screen.render(90).join('\n'), /Pi 模型审核中/);
  assert.equal(screen.picker, undefined);
  finish({ approve: true, reason: '普通文件编辑' });
  await turn;
  assert.equal(c.autoApproved, 1);
  assert.ok(!c.entries.some((entry) => entry.text.includes('待授权操作')));
  screen.submit('/permissions');
  assert.match(screen.render(90).join('\n'), /offline\/review-model/);
  assert.match(screen.render(90).join('\n'), /会消耗该模型用量/);
  screen.handleInput('\x1b[B');
  screen.handleInput('\r');
  assert.equal(c.approvalMode, 'manual');
  assert.match(screen.render(90).join('\n'), /人工审核/);
});

test('changed pending operations reset the human selection and show the current details', async (t) => {
  const { conversation: c, screen } = await view(t);
  const turn = c.prompt('permission');
  await until(() => c.permissions.length === 1);
  screen.handleInput('\x1b[B');
  c.update({
    sessionId: c.sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      rawInput: { path: 'changed.txt', text: 'different' },
    },
  });
  assert.match(screen.render(90).join('\n'), /changed.txt/);
  screen.handleInput('\r');
  await turn;
  assert.match(c.entries.at(-1).text, /cancelled/);
});

for (const scenario of ['no-list', 'bad-list']) {
  test(`session list handles ${scenario} without selecting a different session`, async (t) => {
    const { conversation: c, screen } = await view(t, {}, scenario);
    const id = c.sessionId;
    await screen.resume();
    assert.equal(c.sessionId, id);
    assert.equal(screen.picker, undefined);
    assert.equal(c.state, scenario === 'no-list' ? 'ready' : 'disconnected');
    assert.match(
      c.entries.map((entry) => entry.text).join('\n'),
      scenario === 'no-list' ? /未提供会话列表/ : /Invalid ACP/,
    );
  });
}
