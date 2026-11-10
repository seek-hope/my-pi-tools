import { agent, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const scenario = process.env.ACP_TEST_SCENARIO ?? 'normal';
if (scenario === 'ignore-term') process.on('SIGTERM', () => {});
let authenticated = scenario !== 'auth';
let cwd;
let nextSession = 0;
const sessions = new Set(['saved-session', 'older-session']);
const waits = new Map();
let config = [
  {
    id: 'model',
    name: '模型',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-test',
    options: [
      {
        group: 'gemini',
        name: 'Gemini',
        options: [
          { value: 'gemini-test', name: 'Gemini Test' },
          { value: 'gemini-other', name: 'Gemini Other' },
        ],
      },
    ],
  },
  {
    id: 'thinking',
    name: '思考等级',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'high', name: 'High' },
      { value: 'low', name: 'Low' },
    ],
  },
  { id: 'example', name: '示例选项', type: 'boolean', currentValue: false },
];
const auth = () => {
  if (!authenticated) throw new RequestError(-32000, 'Authentication required');
};
const send = (client, sessionId, update) => client.notify('session/update', { sessionId, update });

const app = agent()
  .onRequest('initialize', async ({ params }) => {
    if (scenario === 'hang-init') return new Promise(() => {});
    if (scenario === 'slow-init') await new Promise((resolve) => setTimeout(resolve, 100));
    if (params.clientInfo.name !== 'my-pi-gemini-login')
      throw new Error('Client identity was not preserved');
    if (params.clientCapabilities.terminal || params.clientCapabilities.fs?.writeTextFile)
      throw new Error('Unexpected execution capability');
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
      throw new Error('API keys were inherited');
    return {
      protocolVersion: scenario === 'version' ? 9 : 1,
      agentInfo: { name: 'Test ACP agent', version: '1' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: scenario === 'no-list' ? {} : { list: {} },
      },
      authMethods: [{ id: 'oauth-personal', name: 'Google' }],
    };
  })
  .onRequest('authenticate', ({ params }) => {
    if (params.methodId !== 'oauth-personal') throw new Error('Unexpected auth method');
    authenticated = true;
    return {};
  })
  .onRequest('session/new', ({ params }) => {
    auth();
    cwd = params.cwd;
    if (params.mcpServers.length) throw new Error('Pi tools leaked to ACP');
    const sessionId = `session-${++nextSession}`;
    sessions.add(sessionId);
    return { sessionId, configOptions: config };
  })
  .onRequest('session/list', async ({ params }) => {
    if (scenario === 'slow-list') await new Promise((resolve) => setTimeout(resolve, 80));
    if (scenario === 'bad-list') return {};
    if (params.cwd !== cwd) throw new Error('Missing project filter');
    return params.cursor
      ? { sessions: [{ sessionId: 'older-session', cwd, title: 'Earlier research' }] }
      : {
          sessions: [
            { sessionId: 'saved-session', cwd, title: 'Saved research' },
            { sessionId: 'foreign', cwd: '/other', title: 'Wrong project' },
          ],
          nextCursor: 'page-two',
        };
  })
  .onRequest('session/load', async ({ params, client }) => {
    auth();
    cwd = params.cwd;
    if (!sessions.has(params.sessionId)) throw new RequestError(-32002, 'Session not found');
    await send(client, params.sessionId, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'Earlier user prompt' },
    });
    await send(client, params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Earlier answer' },
    });
    return { configOptions: config };
  })
  .onRequest('session/set_config_option', ({ params }) => {
    if (scenario === 'bad-config') return {};
    if (params.configId === 'example' && params.type !== 'boolean')
      throw new Error('Missing boolean discriminator');
    config = config.map((option) =>
      option.id === params.configId ? { ...option, currentValue: params.value } : option,
    );
    return { configOptions: config };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt[0].text;
    const id = params.sessionId;
    if (text === 'crash') {
      process.exit(7);
    }
    if (text === 'malformed') {
      process.stdout.write('not-json\n');
      return new Promise(() => {});
    }
    if (text === 'bad-response') return {};
    if (text === 'bad-notification') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: id,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 42 } },
          },
        }) + '\n',
      );
      return { stopReason: 'end_turn' };
    }
    if (text === 'images') {
      for (let n = 0; n < 6; n++)
        await send(client, id, {
          sessionUpdate: 'tool_call',
          toolCallId: `image-${n}`,
          title: 'Image',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'image', mimeType: 'image/png', data: 'a'.repeat(1_000_000) },
            },
          ],
        });
      return { stopReason: 'end_turn' };
    }
    if (text === 'steer') {
      await send(client, id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Steering acknowledged' },
      });
      return { stopReason: 'end_turn' };
    }
    if (text === 'finish') {
      for (const resolve of waits.get(id) ?? []) resolve({ stopReason: 'end_turn' });
      waits.delete(id);
      return { stopReason: 'end_turn' };
    }
    if (text === 'failure') throw new Error('Fixture prompt failed');
    if (text === 'commands')
      await send(client, id, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'official-command', description: 'Server command' }],
      });
    if (text === 'wait') {
      const pending = new Promise((resolve) => waits.set(id, [...(waits.get(id) ?? []), resolve]));
      await send(client, id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Partial output' },
      });
      return pending;
    }
    if (text.startsWith('permission')) {
      const tool = {
        toolCallId: 'edit-1',
        title: '写入 allowed.txt',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'allowed.txt', text: 'approved' },
        locations: [{ path: join(cwd, 'allowed.txt') }],
        content: [
          { type: 'diff', path: join(cwd, 'allowed.txt'), oldText: null, newText: 'approved' },
        ],
      };
      await send(client, id, {
        sessionUpdate: 'tool_call',
        ...tool,
        ...(text === 'permission-overrides'
          ? { rawInput: { path: 'cached.txt', text: 'different' } }
          : {}),
      });
      const ask = (toolCallId, sessionId = id) =>
        client.request('session/request_permission', {
          sessionId,
          toolCall: {
            toolCallId,
            title: tool.title,
            ...(text === 'permission-overrides' ? { rawInput: tool.rawInput } : {}),
          },
          options: [
            { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'deny', kind: 'reject_once', name: 'Deny once' },
          ],
        });
      const responses =
        text === 'permission-two'
          ? await Promise.all([ask('edit-1'), ask('edit-2')])
          : [await ask('edit-1', text === 'permission-foreign' ? 'foreign-session' : id)];
      if (
        responses.every((r) => r.outcome.outcome === 'selected' && r.outcome.optionId === 'allow')
      )
        await writeFile(join(cwd, 'allowed.txt'), 'approved');
      await send(client, id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        status: 'completed',
        rawInput: null,
        content: null,
      });
      await send(client, id, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(responses) },
      });
      return { stopReason: 'end_turn' };
    }
    if (text === 'unexpected-fs') {
      try {
        await client.request('fs/read_text_file', { sessionId: id, path: '/etc/passwd' });
      } catch (error) {
        await send(client, id, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Denied: ${error.code}` },
        });
      }
      return { stopReason: 'end_turn' };
    }
    if (text === 'large') {
      for (let n = 0; n < 12; n++)
        await send(client, id, {
          sessionUpdate: 'agent_message_chunk',
          messageId: String(n),
          content: { type: 'text', text: '中'.repeat(80_000) },
        });
      return { stopReason: 'end_turn' };
    }
    await send(client, 'foreign-session', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Do not show this' },
    });
    await send(client, id, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '考虑中' },
    });
    await send(client, id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Hello ${text} ` },
    });
    await send(client, id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '世界 👋' },
    });
    await send(client, id, {
      sessionUpdate: 'plan',
      entries: [{ content: '完成示例', priority: 'medium', status: 'completed' }],
    });
    return { stopReason: text === 'limited' ? 'max_tokens' : 'end_turn' };
  })
  .onNotification('session/cancel', ({ params }) => {
    if (scenario === 'ignore-cancel') return;
    const finish = () => {
      for (const resolve of waits.get(params.sessionId) ?? []) resolve({ stopReason: 'cancelled' });
      waits.delete(params.sessionId);
    };
    if (scenario === 'slow-cancel') setTimeout(finish, 100);
    else finish();
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await connection.closed;
