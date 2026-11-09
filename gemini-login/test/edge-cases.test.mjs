import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuth, setupProject } from '../src/auth.ts';
import { buildRequest, streamGemini } from '../src/stream.ts';
import { createGeminiProvider } from '../src/index.ts';
import { apiKey, auth, context, model, collect, response, frame, json } from './fixtures.mjs';

test('empty signature-bearing parts survive the next request as separate parts', async () => {
  const { result } = await collect(
    streamGemini(model, context(), { apiKey }, async () =>
      response([
        frame([{ text: 'answer' }]),
        frame([{ text: '', thoughtSignature: 'c2lnbmF0dXJl' }], 'STOP'),
      ]),
    ),
  );
  const request = buildRequest(model, context({ messages: [result] }), {}, 'project');
  const parts = request.request.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, 'answer');
  assert.deepEqual(parts[1], { text: '', thoughtSignature: 'c2lnbmF0dXJl' });
});

test('thinking requests clamp unsupported levels and use model-appropriate budgets', () => {
  const request = buildRequest(model, context(), { reasoning: 'max' }, 'project');
  assert.equal(request.request.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  const older = createGeminiProvider()
    .getModels()
    .find((m) => m.id === 'gemini-2.5-pro');
  const budget = buildRequest(older, context(), { reasoning: 'high' }, 'project');
  assert.equal(budget.request.generationConfig.thinkingConfig.thinkingBudget, 32768);
});

test('explicit request timeout stops transport and is reported as a timeout', async (t) => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const { result } = await collect(
    streamGemini(
      model,
      context(),
      { apiKey, timeoutMs: 10 },
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        }),
    ),
  );
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /timed out/);
});

test('refresh rotation preserves project and rejects unusable token lifetimes', async () => {
  const oauth = createOAuth({
    fetch: async () =>
      json({ access_token: 'NEXT_ACCESS', refresh_token: 'NEXT_REFRESH', expires_in: 3600 }),
  });
  const next = await oauth.refresh(auth, new AbortController().signal);
  assert.equal(next.projectId, auth.projectId);
  assert.equal(next.refresh, 'NEXT_REFRESH');
  for (const expires_in of [0, -1, '3600', 1e300]) {
    const invalid = createOAuth({
      fetch: async () =>
        json({ access_token: auth.access, refresh_token: auth.refresh, expires_in }),
    });
    await assert.rejects(
      invalid.refresh(auth, new AbortController().signal),
      /invalid token lifetime/,
    );
  }
});

test('cancelling onboarding interrupts the polling delay without another request', async () => {
  let count = 0;
  const controller = new AbortController();
  await assert.rejects(
    setupProject(
      auth.access,
      {
        pollMs: 60000,
        fetch: async () => {
          count++;
          if (count === 1) return json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] });
          queueMicrotask(() => controller.abort());
          return json({ name: 'operations/pending' });
        },
      },
      controller.signal,
    ),
  );
  assert.equal(count, 2);
});
