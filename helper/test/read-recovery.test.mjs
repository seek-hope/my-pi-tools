import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/runner.ts';
import { defaults, validateSettings } from '../src/settings.ts';
import { fixture, message, call } from './fixtures.mjs';

const missing = "ENOENT: no such file or directory, access '/missing.txt'";
function failure(text, extra = {}) {
  return {
    toolCall: { id: 'nested-error' },
    isError: true,
    durationMs: 0,
    result: { content: [{ type: 'text', text }] },
    ...extra,
  };
}

for (const [name, text] of [
  ['read', missing],
  ['read', 'Offset 240 is beyond end of file (188 lines total)'],
  ['read', "ENOTDIR: not a directory, open '/file/child.txt'"],
  ['read', 'EISDIR: illegal operation on a directory, read'],
  ['ls', 'Not a directory: /file.txt'],
])
  test(`recoverable ${name} failure is fed back as an error without restarting: ${text}`, async () => {
    const f = fixture([
      message([call(name, {}, 'bad')], 'toolUse'),
      message([call('read', {}, 'corrected')], 'toolUse'),
      message('Corrected the lookup.'),
    ]);
    let count = 0;
    f.ctx.executeTool = async () =>
      ++count === 1
        ? failure(text)
        : {
            toolCall: { id: 'ok' },
            isError: false,
            durationMs: 0,
            result: { content: [{ type: 'text', text: 'correct file' }] },
          };
    const r = await runHelper({ task: 'Inspect the file' }, f.ctx, f.settings);
    assert.equal(r.status, 'answered');
    assert.equal(count, 2);
    assert.equal(r.turns, 3);
    assert.equal(r.usage.totalTokens, 30);
    assert.equal(f.contexts[1].messages.at(-1).isError, true);
    assert.equal(f.contexts[1].messages.at(-1).content[0].text, text);
    assert.equal(f.contexts[2].messages.at(-1).isError, false);
  });

for (const [name, outcome] of [
  // Host pathExists collapses missing paths and OS access failures into the same text.
  ['ls', failure('Path not found: /missing')],
  ['find', failure('Path not found: /missing')],
  ['grep', failure('Path not found: /missing')],
  ['read', failure(missing, { durationMs: undefined })],
  ['read', failure(missing, { durationMs: -1 })],
  ['read', failure(missing, { durationMs: NaN })],
  ['read', failure("EACCES: permission denied, open '/secret'")],
  ['read', failure("EPERM: operation not permitted, open '/secret'")],
  ['read', failure('Permission denied: ' + missing)],
  ['read', failure('Operation aborted')],
  ['read', failure('Unknown host failure')],
  ['bash', failure(missing)],
  ['write', failure(missing)],
  [
    'read',
    failure(missing, {
      result: {
        content: [
          { type: 'text', text: missing },
          { type: 'image', data: '', mimeType: 'image/png' },
        ],
      },
    }),
  ],
])
  test(`nonrecoverable ${name} failure stops with no model follow-up: ${JSON.stringify(outcome)}`, async () => {
    const f = fixture([message([call(name)], 'toolUse'), message('must not run')], {
      execute: () => outcome,
    });
    const r = await runHelper({ task: 'Inspect', mode: 'work' }, f.ctx, f.settings);
    assert.equal(r.status, 'error');
    assert.equal(f.contexts.length, 1);
    assert.equal(r.lastTool.isError, true);
  });

for (const stop of ['cancel', 'terminate'])
  test(`${stop} takes precedence over a recoverable read error`, async () => {
    const controller = new AbortController();
    const f = fixture([message([call('read')], 'toolUse')], {
      execute: () => {
        const outcome = failure(missing);
        if (stop === 'cancel') controller.abort();
        else outcome.result.terminate = true;
        return outcome;
      },
    });
    const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings, controller.signal);
    assert.equal(r.status, stop === 'cancel' ? 'cancelled' : 'terminated');
    assert.equal(f.contexts.length, 1);
    assert.equal(r.lastTool.output, missing);
  });

for (const limit of ['turns', 'tools'])
  test(`repeated recoverable failures consume the existing ${limit} budget`, async () => {
    const f = fixture((_context, _options, n) => message([call('read', {}, `r${n}`)], 'toolUse'), {
      execute: () => failure(missing),
    });
    const r = await runHelper({ task: 'Inspect' }, f.ctx, {
      ...f.settings,
      ...(limit === 'turns' ? { maxTurns: 3 } : { maxToolCalls: 2 }),
    });
    assert.equal(r.status, 'limited');
    assert.equal(r.turns, 3);
    assert.equal(r.toolCalls, 2);
    assert.equal(r.usage.totalTokens, 30);
    assert.equal(r.lastTool.output, missing);
  });

test('a recoverable error remains subject to the context limit', async () => {
  const f = fixture([message([call('read')], 'toolUse'), message('must not run')], {
    execute: () => failure(missing + 'x'.repeat(10000)),
  });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, maxContextChars: 6000 });
  assert.equal(r.status, 'limited');
  assert.match(r.reason, /context/);
  assert.equal(r.toolCalls, 1);
  assert.equal(r.turns, 1);
  assert.equal(r.usage.totalTokens, 10);
});

test('a late recoverable error does not start another request after the deadline', async () => {
  const f = fixture([message([call('read')], 'toolUse'), message('must not run')], {
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      return failure(missing);
    },
  });
  const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, timeoutSeconds: 1 });
  assert.equal(r.status, 'limited');
  assert.match(r.reason, /time limit/);
  assert.equal(r.turns, 1);
  assert.equal(r.lastTool.output, missing);
  assert.equal(r.usage.totalTokens, 10);
});

test('the model may explain the last lookup failure after the tool budget is exhausted', async () => {
  const f = fixture(
    [message([call('read')], 'toolUse'), message('The supplied file was not found.')],
    {
      execute: () => failure(missing),
    },
  );
  const r = await runHelper({ task: 'Inspect' }, f.ctx, { ...f.settings, maxToolCalls: 1 });
  assert.equal(r.status, 'answered');
  assert.equal(r.turns, 2);
  assert.equal(r.toolCalls, 1);
  assert.equal(f.contexts[1].messages.at(-1).isError, true);
});

test('default context budget is 2M characters and larger configuration is rejected', () => {
  assert.equal(defaults.maxContextChars, 2000000);
  assert.doesNotThrow(() => validateSettings({ ...defaults, maxContextChars: 2000000 }));
  assert.throws(() => validateSettings({ ...defaults, maxContextChars: 2000001 }));
});
for (const chars of [210000, 2000000])
  test(`accumulated helper responses are counted against the 2M default (${chars})`, async () => {
    const f = fixture([
      message([{ type: 'text', text: 'x'.repeat(chars) }, call('read')], 'toolUse'),
      message('Short final answer'),
    ]);
    const r = await runHelper({ task: 'Inspect' }, f.ctx, f.settings);
    assert.equal(r.status, chars === 210000 ? 'answered' : 'limited');
    assert.equal(r.turns, chars === 210000 ? 2 : 1);
  });
