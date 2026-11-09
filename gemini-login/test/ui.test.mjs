import test from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, CURSOR_MARKER, matchesKey } from '@earendil-works/pi-tui';
import { ChatScreen } from '../src/ui.ts';
import { fixture, until } from './fixtures.mjs';

initTheme('dark', false);
const keys = {
  matches: (data, action) => action === 'tui.select.cancel' && matchesKey(data, 'escape'),
};
const theme = { fg: (_color, text) => text };
const tui = () => ({ terminal: { rows: 30, columns: 90 }, requestRender() {} });

async function view(t) {
  const { conversation, ...rest } = await fixture(t, 'normal', 1000);
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

test('typed draft survives Enter while the agent is busy and Ctrl+D tears down the process', async (t) => {
  const { conversation: c, screen, done } = await view(t);
  const prompt = c.prompt('wait');
  await until(() => c.entries.some((entry) => entry.text.includes('Partial output')));
  screen.handleInput('keep draft');
  screen.handleInput('\r');
  assert.match(screen.render(90).join('\n'), /keep draft/);
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
  assert.match(screen.render(90).join('\n'), /gemini-other/);
});
