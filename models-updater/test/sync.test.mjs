import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiLifeCatalog, appendModels, selectAdditions, publishModels, publishImages } from '../sync-models.mjs';
import { writePrivate } from '../check-models.mjs';

const parse = text => JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/gu, match => match.startsWith('//') ? '' : match)
  .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/gu, (match, end) => end ?? match));
const openai = { contextWindow: 100000, maxTokens: 8192, input: ['text', 'image'], reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }, headers: { x: 'secret' } };
const aiOrigin = 'http://example.test:3009';
const aiLife = { baseUrl: aiOrigin + '/v1', api: 'openai-responses', models: [{ id: 'gpt-5.6' }] };
const context = { lookup: id => id === 'gpt-6-sol' ? openai : undefined, publicOrigin: aiOrigin };

test('AI-Life public origin is exact, credentials are never sent, and catalog must advertise the chat protocol', async () => {
  const data = { success: true, data: [{ model_name: 'gpt-6-sol', supported_endpoint_types: ['openai'] },
    { model_name: 'gpt-image-2.6-flare', supported_endpoint_types: ['openai'] }],
  supported_endpoint: { openai: { path: '/v1/chat/completions', method: 'POST' } } };
  const opts = { publicOrigin: aiOrigin, readJSON: r => r.json(), fetchImpl: async (url, opts) => {
    assert.equal(url.href, aiOrigin + '/api/pricing');
    assert.deepEqual(opts.headers, { Accept: 'application/json' });
    assert.equal(opts.redirect, 'error');
    return Response.json(data);
  } };
  const rows = await aiLifeCatalog(aiLife, opts);
  const selected = selectAdditions('ai-life', aiLife, rows, context);
  assert.deepEqual(rows, [{ id: 'gpt-6-sol' }]);
  assert.equal(selected.models[0].api, 'openai-completions');
  assert.equal(selected.models[0].reasoning, true);
  assert.deepEqual(selected.models[0].thinkingLevelMap, { xhigh: 'xhigh' });
  assert.equal(selected.models[0].headers, undefined);
  assert.equal(selected.models[0].cost, undefined);
  await assert.rejects(aiLifeCatalog({ ...aiLife, baseUrl: 'http://other.test/v1' }, opts), /unsafe-endpoint/u);
  data.supported_endpoint.openai.path = '/v1/something-else';
  await assert.rejects(aiLifeCatalog(aiLife, opts), /invalid-catalog/u);
});

test('AI-Life does not invent reasoning capabilities or overwrite configured models', () => {
  const rows = [{ id: 'gpt-6-sol' }, { id: 'gpt-5.6' }, { id: 'gpt-99' }];
  for (const [reasoning, thinkingLevelMap] of [[false, undefined], [true, { xhigh: null }]]) {
    const plan = selectAdditions('ai-life', aiLife, rows, { ...context,
      lookup: id => id === 'gpt-6-sol' ? { ...openai, reasoning, thinkingLevelMap } : undefined });
    assert.deepEqual(plan.models.map(m => m.id), ['gpt-6-sol']);
    assert.equal(plan.models[0].reasoning, reasoning);
    assert.equal(plan.models[0].thinkingLevelMap, undefined);
    assert.deepEqual(plan.withheld, ['gpt-99']);
  }
});

test('CLIProxyAPI requires matching text metadata and respects output cap', () => {
  const provider = { baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', models: [] };
  const ids = ['gemini-text', 'gemini-image', 'gemini-unknown'].map(id => ({ id }));
  const meta = { context_length: 1048576, max_completion_tokens: 1048576, supportedInputModalities: ['text', 'audio', 'image'],
    supportedOutputModalities: ['text'], thinking: { levels: ['low', 'high', 'xhigh'] } };
  const plan = selectAdditions('cliproxy', provider, ids, { ...context, definitions: [
    { ...meta, id: 'gemini-text' }, { ...meta, id: 'gemini-image', supportedOutputModalities: ['image'] }
  ] });
  assert.equal(plan.models.length, 1);
  assert.equal(plan.models[0].maxTokens, 128000);
  assert.equal(plan.models[0].thinkingLevelMap.xhigh, 'xhigh');
  assert.deepEqual(plan.models[0].input, ['text', 'image']);
  assert.deepEqual(plan.withheld, ['gemini-image', 'gemini-unknown']);
  assert.equal(selectAdditions('cliproxy', { ...provider, baseUrl: 'http://127.0.0.1:9000/v1' }, ids, context).models.length, 0);
});

test('OrcaRouter checks namespace, exact protocol and output kind; classifier and image are not chat', () => {
  const provider = { baseUrl: 'https://api.orcarouter.ai/v1', api: 'openai-responses', models: [{ id: 'openai/existing' }] };
  const meta = { context_length: 400000, max_completion_tokens: 128000, endpoint_capabilities: ['openai_responses'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] } };
  const plan = selectAdditions('orcarouter-openai', provider, [
    { ...meta, id: 'openai/existing' }, { ...meta, id: 'openai/responses' }, { ...meta, id: 'google/responses' },
    { ...meta, id: 'openai/chat', endpoint_capabilities: ['chat_completions'] },
    { ...meta, id: 'openai/classifier', endpoint_capabilities: ['systemone'] },
    { ...meta, id: 'openai/image', architecture: { input_modalities: ['text'], output_modalities: ['image'] } }
  ], context);
  assert.deepEqual(plan.models.map(model => model.id), ['openai/responses']);
  assert.equal(plan.models[0].api, undefined);
  assert.equal(plan.withheld.length, 4);
});

test('ByteSeek separates image entries and requires exact known text metadata', () => {
  const provider = { baseUrl: 'https://tokens.byteseek.ai/v1', api: 'openai-responses', models: [] };
  const plan = selectAdditions('byteseek', provider, ['gpt-image-2.6-flare', 'gpt-6-sol', 'gpt-99-sol'].map(id => ({ id })), context);
  assert.deepEqual(plan.models.map(model => model.id), ['gpt-6-sol']);
  assert.deepEqual(plan.images, ['gpt-image-2.6-flare']);
  assert.deepEqual(plan.withheld, ['gpt-99-sol']);
});

test('model edit appends to exact provider arrays and preserves comments, key text, existing entries and settings', () => {
  const original = '{\n // "models": [] and ]\n "providers": {\n   "a": {"apiKey":"https://key.test//value", "models": [\n    {"id":"prior", "compat":{"supportsStore":false}} // prior model\n   ]},\n   "b": {"models":[{"id":"b-old"},]},\n   "c": {"models":[]},\n   "d": {"models":[{"id":"keep"}]}\n }\n}\n';
  const additions = new Map([['a', [{ id: 'a-new' }]], ['b', [{ id: 'b-new' }]], ['c', [{ id: 'c-new' }]]]);
  const updated = appendModels(original, additions, parse);
  const doc = parse(updated).providers;
  assert.deepEqual(doc.a.models, [{ id: 'prior', compat: { supportsStore: false } }, { id: 'a-new' }]);
  assert.deepEqual(doc.b.models, [{ id: 'b-old' }, { id: 'b-new' }]);
  assert.deepEqual(doc.c.models, [{ id: 'c-new' }]);
  assert.deepEqual(doc.d, parse(original).providers.d);
  assert.ok(updated.includes('} // prior model') || updated.includes('}, // prior model'));
  assert.ok(updated.includes('"apiKey":"https://key.test//value"'));
  assert.throws(() => appendModels(original, new Map([['missing', [{ id: 'new' }]]]), parse), /invalid-sync-target/u);
  assert.throws(() => appendModels(original, new Map([['a', [{ id: 'prior' }]]]), parse), /invalid-sync-target/u);
});

test('publishing validates first, preserves concurrent edits, and saves the prior version privately only on change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-sync-'));
  const path = join(dir, 'models.json');
  const stateDir = join(dir, 'state');
  const previous = join(stateDir, 'models.json.previous');
  const original = '{"providers":{"a":{"models":[]}}}';
  const options = { path, original, stateDir, additions: new Map([['a', [{ id: 'new' }]]]), parse, writePrivate };
  try {
    await writeFile(path, original);
    await assert.rejects(publishModels({ ...options, validate: async () => ({ getError: () => 'schema error' }) }), /invalid-sync-target/u);
    assert.equal(await readFile(path, 'utf8'), original);
    await assert.rejects(stat(previous), { code: 'ENOENT' });
    await assert.rejects(publishModels({ ...options, validate: async () => {
      await writeFile(path, 'manual concurrent edit');
      return { getError: () => undefined };
    } }), /concurrent-model-edit/u);
    assert.equal(await readFile(path, 'utf8'), 'manual concurrent edit');
    await writeFile(path, original);
    await symlink(path, join(dir, 'symlink'));
    await assert.rejects(publishModels({ ...options, path: join(dir, 'symlink') }), /invalid-sync-target/u);
    await publishModels({ ...options, validate: async () => ({ getError: () => undefined }) });
    assert.deepEqual(parse(await readFile(path, 'utf8')).providers.a.models, [{ id: 'new' }]);
    assert.equal(await readFile(previous, 'utf8'), original);
    assert.equal((await stat(previous)).mode & 0o777, 0o600);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('image state merges qualifying IDs without dropping older definitions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-images-'));
  const path = join(dir, 'images.json');
  try {
    const publish = imageIds => publishImages({ path, imageIds, writePrivate });
    assert.deepEqual(await publish(['gpt-image-2.6-flare', 'chat']), ['gpt-image-2.6-flare']);
    assert.deepEqual(await publish(['gpt-image-2.6-sunburst']), ['gpt-image-2.6-sunburst']);
    assert.deepEqual(await publish(['gpt-image-2.6-flare']), []);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
