import test from 'node:test';
import assert from 'node:assert/strict';
import { streamGemini, buildRequest } from '../src/stream.ts';
import { createGeminiProvider } from '../src/index.ts';
import { BASE_URL } from '../src/http.ts';
import { apiKey, auth, model, context, frame, response, json, collect } from './fixtures.mjs';

const finish = (parts = [{ text: 'Hello' }]) =>
  frame(parts, 'STOP', {
    promptTokenCount: 20,
    cachedContentTokenCount: 5,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 3,
    totalTokenCount: 27,
  });

test('streams split UTF-8, preserves signatures and reports usage without pricing subscription tokens', async () => {
  const hooks = [];
  const { events, result } = await collect(
    streamGemini(
      model,
      context(),
      {
        apiKey,
        reasoning: 'high',
        sessionId: 'conversation-1',
        onPayload(payload) {
          payload.request.generationConfig.temperature = 0.1;
          return payload;
        },
        onResponse(value) {
          hooks.push(value);
        },
        onProviderStreamEvent(value) {
          hooks.push(value);
        },
      },
      async (url, init) => {
        assert.equal(url, `${BASE_URL}:streamGenerateContent?alt=sse`);
        assert.equal(init.headers.get('Authorization'), `Bearer ${auth.access}`);
        assert.equal(init.redirect, 'error');
        const body = JSON.parse(init.body);
        assert.equal(body.project, auth.projectId);
        assert.equal(body.request.session_id, 'conversation-1');
        assert.equal(body.request.generationConfig.temperature, 0.1);
        assert.equal(body.request.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
        assert.equal(body.enabled_credit_types, undefined);
        assert.equal(body.request.systemInstruction.parts[0].text, 'Inspect only');
        return response(
          [
            frame([{ text: 'Reasoning', thought: true, thoughtSignature: 'thought-sig' }]),
            frame([{ text: '你好 🌏', thoughtSignature: 'text-sig-1' }]),
            finish([{ text: 'Done', thoughtSignature: 'text-sig-2' }]),
          ],
          true,
        );
      },
    ),
  );
  assert.equal(result.stopReason, 'stop');
  assert.deepEqual(
    result.content.map((b) => b.type),
    ['thinking', 'text', 'text'],
  );
  assert.equal(result.content[0].thinkingSignature, 'thought-sig');
  assert.equal(result.content[1].textSignature, 'text-sig-1');
  assert.equal(result.content[2].textSignature, 'text-sig-2');
  assert.equal(result.content[1].text, '你好 🌏');
  assert.equal(result.usage.input, 15);
  assert.equal(result.usage.output, 7);
  assert.equal(result.usage.cacheRead, 5);
  assert.equal(result.usage.reasoning, 3);
  assert.equal(result.usage.totalTokens, 27);
  assert.equal(result.usage.cost.total, 0);
  assert.equal(result.usage.cost.totalFromProvider, false);
  assert.equal(events[0].type, 'start');
  assert.equal(hooks[0].status, 200);
  assert.equal(hooks.length, 4);
});

test('function calls round-trip through Pi with signed arguments, tool results and images', async () => {
  const callPart = {
    functionCall: { id: 'call-id', name: 'inspect', args: { path: '中文.txt' } },
    thoughtSignature: 'dG9vbC1zaWduYXR1cmU=',
  };
  const { result } = await collect(
    streamGemini(model, context(), { apiKey }, async () =>
      response([finish([callPart, callPart])]),
    ),
  );
  assert.equal(result.stopReason, 'toolUse');
  assert.notEqual(result.content[0].id, result.content[1].id);
  const tool = {
    name: 'inspect',
    description: 'Inspect a file',
    parameters: {
      type: 'object',
      properties: { path: { const: '中文.txt', type: 'string' } },
      required: ['path'],
    },
  };
  const next = context({
    tools: [tool],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        timestamp: 1,
      },
      result,
      ...result.content.map((call) => ({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [
          { type: 'text', text: 'Found' },
          { type: 'image', data: 'BBBB', mimeType: 'image/png' },
        ],
        isError: false,
        timestamp: 2,
      })),
    ],
  });
  const request = buildRequest(model, next, {}, 'project');
  const wire = JSON.stringify(request);
  assert.match(wire, /dG9vbC1zaWduYXR1cmU=/);
  assert.match(wire, /functionResponse/);
  assert.match(wire, /inlineData/);
  assert.match(wire, /AAAA/);
  assert.match(wire, /BBBB/);
  assert.doesNotMatch(JSON.stringify(request.request.tools), /"const"/);
});

test('cross-provider history is converted by Pi and unsupported signatures are not replayed', () => {
  const other = {
    role: 'assistant',
    provider: 'other',
    model: 'other',
    api: 'anthropic-messages',
    content: [
      { type: 'thinking', thinking: 'Thought', thinkingSignature: 'FOREIGN_PRIVATE_SIG' },
      { type: 'text', text: 'Earlier answer' },
    ],
    timestamp: 1,
    stopReason: 'stop',
    usage: {},
  };
  const request = buildRequest(
    model,
    context({ messages: [{ role: 'user', content: 'Question', timestamp: 0 }, other] }),
    {},
    'project',
  );
  assert.match(JSON.stringify(request), /Earlier answer/);
  assert.doesNotMatch(JSON.stringify(request), /FOREIGN_PRIVATE_SIG/);
});

for (const [name, events, expected] of [
  ['empty normal response', [finish([])], 'stop'],
  ['output limit', [frame([{ text: 'Partial' }], 'MAX_TOKENS')], 'length'],
  ['missing finish', [frame([{ text: 'Partial' }])], 'error'],
  ['blocked answer', [frame([], 'SAFETY')], 'error'],
  ['upstream error event', [{ error: { code: 429, message: auth.access } }], 'error'],
])
  test(name, async () => {
    const { result } = await collect(
      streamGemini(model, context(), { apiKey }, async () => response(events)),
    );
    assert.equal(result.stopReason, expected);
    assert.doesNotMatch(result.errorMessage ?? '', /PRIVATE_/);
  });

test('malformed or truncated SSE preserves prior text and closes the response body', async () => {
  for (const suffix of ['data: {broken}\n\n', 'data: {"unfinished":']) {
    const prefix = `data: ${JSON.stringify(frame([{ text: 'Partial findings' }]))}\n\n`;
    const { result } = await collect(
      streamGemini(
        model,
        context(),
        { apiKey },
        async () =>
          new Response(prefix + suffix, { headers: { 'content-type': 'text/event-stream' } }),
      ),
    );
    assert.equal(result.stopReason, 'error');
    assert.equal(result.content[0].text, 'Partial findings');
  }
});

test('context overflow, quota errors and token failures are distinct and secret-free', async () => {
  for (const [status, message, pattern] of [
    [400, 'Input token count exceeds maximum context limit', /context_length_exceeded/],
    [429, 'Quota exhausted', /quota or rate limit/],
    [401, auth.access, /Sign in again/],
    [403, auth.refresh, /eligibility/],
  ]) {
    const { result } = await collect(
      streamGemini(model, context(), { apiKey }, async () => json({ error: { message } }, status)),
    );
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage, pattern);
    assert.doesNotMatch(result.errorMessage, /PRIVATE_/);
    if (status !== 400) assert.doesNotMatch(result.errorMessage, /context_length_exceeded/);
  }
});

test('caller cancellation reaches fetch and does not discard partial output', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const { result } = await collect(
    streamGemini(model, context(), { apiKey, signal: controller.signal }, async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(frame([{ text: 'Partial' }]))}\n\n`),
            );
            init.signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                stream.error(new Error(auth.access));
              },
              { once: true },
            );
            setTimeout(() => controller.abort(), 10);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  assert.equal(cancelled, true);
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.content[0].text, 'Partial');
  assert.doesNotMatch(result.errorMessage, /PRIVATE_/);
});

test('custom fetch and instrumentation failures release response bodies without exposing errors', async () => {
  let cancelled = false;
  const { result } = await collect(
    streamGemini(
      model,
      context(),
      {
        apiKey,
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        onResponse() {
          throw new Error(auth.access);
        },
      },
      async () => {
        throw new Error('wrong transport');
      },
    ),
  );
  assert.equal(cancelled, true);
  assert.equal(result.stopReason, 'error');
  assert.doesNotMatch(result.errorMessage, /PRIVATE_/);
});

test('catalog uses concrete chat models with zero estimated subscription cost and no shared mutable state', () => {
  const provider = createGeminiProvider();
  const list = provider.getModels();
  assert.equal(list.length, 4);
  assert.equal(provider.auth.oauth.isSubscription, true);
  assert.ok(
    list.every((m) => m.provider === 'gemini-login' && m.cost.input === 0 && m.cost.output === 0),
  );
  list[0].cost.input = 500;
  assert.equal(provider.getModels()[0].cost.input, 0);
});
