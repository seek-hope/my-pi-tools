import assert from 'node:assert/strict';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createGeminiProvider } from '../src/index.ts';

export const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
export const auth = {
  type: 'oauth',
  access: 'PRIVATE_ACCESS_TOKEN',
  refresh: 'PRIVATE_REFRESH_TOKEN',
  expires: Date.now() + 3600000,
  projectId: 'managed-project',
};
export const apiKey = JSON.stringify({ access: auth.access, projectId: auth.projectId });
export const context = (extra = {}) =>
  normalizeContext({
    systemPrompt: 'Inspect only',
    messages: [{ role: 'user', content: 'Hello 世界', timestamp: 1 }],
    ...extra,
  });
export const model = createGeminiProvider()
  .getModels()
  .find((m) => m.id === 'gemini-3.1-pro-preview');
export const frame = (parts, finishReason, usageMetadata) => ({
  response: {
    candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
    ...(usageMetadata ? { usageMetadata } : {}),
  },
});
export const sseText = (events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
export function response(events, byteChunks = false) {
  const bytes = new TextEncoder().encode(sseText(events));
  return new Response(
    new ReadableStream({
      start(controller) {
        if (byteChunks) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
export async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(structuredClone(event));
  const result = await stream.result();
  assert.equal(events.filter((event) => ['done', 'error'].includes(event.type)).length, 1);
  for (const kind of ['text', 'thinking', 'toolcall']) {
    assert.equal(
      events.filter((event) => event.type === `${kind}_start`).length,
      events.filter((event) => event.type === `${kind}_end`).length,
    );
  }
  return { events, result };
}
