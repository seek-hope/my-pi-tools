import { lstat, readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const imageId = /^gpt-image-\d+(?:\.\d+)?(?:-[a-z0-9]+)*$/u;
const textId = /^[a-z0-9][a-z0-9./_-]{0,159}$/u;
const gptId = /^gpt-\d+(?:\.\d+)?(?:-(?:nano|mini|pro|luna|sol|terra|astra|codex|\d{4}-\d{2}-\d{2}))*$/u;
const orcaChannels = {
  'orcarouter-openai': ['openai/', 'openai-responses', 'openai_responses'],
  'orcarouter-anthropic': ['anthropic/', 'anthropic-messages', 'anthropic_messages'],
  'orcarouter-gemini': ['google/', 'google-generative-ai', 'gemini_generate'],
  'orcarouter-cyber': ['orca/', 'openai-completions', 'chat_completions']
};
const has = (values, key) => Array.isArray(values) && values.includes(key);
const limit = (...values) => values.find(n => Number.isSafeInteger(n) && n > 0 && n <= 10_000_000);

export function isAiLifePublic(id, provider, publicOrigin) {
  if (id !== 'ai-life' || !publicOrigin) return false;
  try {
    const origin = new URL(publicOrigin);
    return origin.protocol === 'http:' && origin.origin === publicOrigin &&
      [origin.origin + '/v1', origin.origin + '/v1/'].includes(provider.baseUrl);
  } catch { return false; }
}

export async function aiLifeCatalog(provider, { publicOrigin, fetchImpl, readJSON, signal }) {
  if (!isAiLifePublic('ai-life', provider, publicOrigin)) throw new Error('unsafe-endpoint');
  const url = new URL('/api/pricing', provider.baseUrl);
  const response = await readJSON(await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal }));
  const endpoint = response?.supported_endpoint?.openai;
  if (response?.success !== true || !Array.isArray(response.data) || response.data.length > 10000 ||
      endpoint?.path !== '/v1/chat/completions' || endpoint?.method !== 'POST') throw new Error('invalid-catalog');
  const models = response.data.filter(row => gptId.test(row?.model_name ?? '') && has(row.supported_endpoint_types, 'openai'))
    .map(({ model_name }) => ({ id: model_name }));
  if (!models.length) throw new Error('empty-catalog');
  return models;
}

export function loopbackProxy(id, provider) {
  return id === 'cliproxy' && /^http:\/\/127\.0\.0\.1:8317\/v1\/?$/u.test(provider.baseUrl) &&
    provider.api === 'openai-completions';
}

function definition(id, source, fallback) {
  const contextWindow = limit(source.context_length, source.top_provider?.context_length, fallback?.contextWindow);
  const output = limit(source.max_completion_tokens, source.top_provider?.max_completion_tokens, fallback?.maxTokens);
  if (!contextWindow || !output) return;
  const modalities = source.architecture?.input_modalities ?? source.supportedInputModalities ?? fallback?.input;
  if (!has(modalities, 'text')) return;
  const price = source.pricing;
  const number = value => value == null || value === '' ? NaN : Number(value);
  const amounts = [price?.prompt, price?.completion].map(number);
  const cost = amounts.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
    ? { input: amounts[0] * 1e6, output: amounts[1] * 1e6,
      cacheRead: Math.max(0, Math.min(number(price.input_cache_read) || 0, 1)) * 1e6,
      cacheWrite: Math.max(0, Math.min(number(price.input_cache_write) || 0, 1)) * 1e6 } : undefined;
  const permitted = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none']);
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const supported = source.thinking?.levels;
  const thinkingLevelMap = Array.isArray(supported)
    ? Object.fromEntries(levels.map(level => [level, has(supported, level) ? level : has(supported, 'low') && ['off', 'minimal'].includes(level) ? 'low' : null]))
    : Object.fromEntries(levels.flatMap(level => {
      const value = fallback?.thinkingLevelMap?.[level];
      return value === null || permitted.has(value) ? [[level, value]] : [];
    }));
  const reasoning = Boolean(fallback?.reasoning) || Array.isArray(supported) && supported.length > 0 ||
    has(source.supported_parameters, 'reasoning') || has(source.supported_parameters, 'reasoning_effort');
  return { id, name: id, contextWindow,
    maxTokens: Math.min(output, contextWindow, 128000), input: ['text', ...(has(modalities, 'image') ? ['image'] : [])], reasoning,
    ...(Object.keys(thinkingLevelMap).length ? { thinkingLevelMap } : {}), ...(cost ? { cost } : {}) };
}

export function selectAdditions(id, provider, advertised, { lookup, definitions = [], publicOrigin }) {
  const existing = new Set(provider.models.map(model => model.id));
  const models = [];
  const withheld = [];
  const images = [];
  const seen = new Set();
  for (const row of advertised) {
    const modelId = row.id;
    if (!textId.test(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    if (id === 'byteseek' && /^https:\/\/tokens\.byteseek\.ai\/v1\/?$/u.test(provider.baseUrl) && imageId.test(modelId)) {
      images.push(modelId);
      continue;
    }
    if (existing.has(modelId)) continue;
    let model;
    if (loopbackProxy(id, provider)) {
      const metadata = definitions.find(item => item?.id === modelId);
      if (metadata && has(metadata.supportedOutputModalities, 'text') &&
          !metadata.supportedOutputModalities.some(value => value !== 'text')) {
        model = definition(modelId, metadata);
        if (model?.reasoning) model.compat = { supportsReasoningEffort: true, supportsUsageInStreaming: true };
      }
    } else if (Object.hasOwn(orcaChannels, id) && /^https:\/\/api\.orcarouter\.ai(?:\/v1(?:beta)?)?\/?$/u.test(provider.baseUrl)) {
      const [prefix, api, capability] = orcaChannels[id];
      const output = row.architecture?.output_modalities;
      if (provider.api === api && modelId.startsWith(prefix) && has(row.endpoint_capabilities, capability) &&
          (!Array.isArray(output) || output.length === 1 && output[0] === 'text')) {
        model = definition(modelId, row, lookup(modelId));
      }
    } else if (isAiLifePublic(id, provider, publicOrigin)) {
      if (gptId.test(modelId)) {
        model = definition(modelId, {}, lookup(modelId));
        if (model) {
          model.api = 'openai-completions';
          // Only xhigh is confirmed beyond Pi's standard Chat Completions levels.
          const xhigh = model.reasoning && model.thinkingLevelMap?.xhigh === 'xhigh';
          delete model.thinkingLevelMap;
          if (xhigh) model.thinkingLevelMap = { xhigh: 'xhigh' };
        }
      }
    } else if (provider.api === 'openai-responses' && (id === 'byteseek' && /^https:\/\/tokens\.byteseek\.ai\/v1\/?$/u.test(provider.baseUrl) ||
        id === 'ai-life' && new URL(provider.baseUrl).protocol === 'https:')) {
      if (gptId.test(modelId)) model = definition(modelId, {}, lookup(modelId));
    } else {
      continue; // Unmanaged provider: observe without editing.
    }
    if (model) models.push(model);
    else withheld.push(modelId);
  }
  return { models, withheld, images };
}

// Walk only the validated JSONC syntax to find each array's last element boundary.
// Tokens inside strings/comments cannot be mistaken for keys or brackets.
export function appendModels(original, additions, parse) {
  const expected = parse(original);
  const tokens = Array.from(original.matchAll(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|[{}\[\]:,]|[^\s{}\[\]:,\uFEFF]+/gu)).filter(m => !m[0].startsWith('//'));
  let i = 0;
  const edits = [];
  const matched = new Set();
  function take(expectedToken) {
    const token = tokens[i++];
    if (!token || expectedToken !== undefined && token[0] !== expectedToken) throw new Error('invalid-sync-target');
    return token;
  }
  function value(path) {
    const token = take();
    let last = token;
    if (token[0] === '{') {
      while (tokens[i]?.[0] !== '}') {
        const key = JSON.parse(take()[0]);
        take(':');
        value([...path, key]);
        if (tokens[i]?.[0] !== ',') break;
        take(',');
      }
      return take('}');
    }
    if (token[0] === '[') {
      while (tokens[i]?.[0] !== ']') {
        last = value([...path, 0]);
        if (tokens[i]?.[0] !== ',') break;
        take(',');
      }
      const trailingComma = tokens[i - 1]?.[0] === ',';
      const end = take(']');
      if (path.length === 3 && path[0] === 'providers' && path[2] === 'models' && additions.has(path[1])) {
        if (matched.has(path[1])) throw new Error('invalid-sync-target');
        matched.add(path[1]);
        const entries = additions.get(path[1]);
        const prior = expected.providers[path[1]].models;
        if (!Array.isArray(prior) || entries.some(entry => prior.some(model => model.id === entry.id))) throw new Error('invalid-sync-target');
        const indent = '        ';
        const insert = entries.map(entry => JSON.stringify(entry, null, 2).split('\n').map(line => indent + line).join('\n')).join(',\n');
        if (last !== token && !trailingComma) edits.push({ offset: last.index + last[0].length, insert: ',' });
        const lineStart = original.lastIndexOf('\n', end.index - 1) + 1;
        const ownLine = /^[ \t]*$/u.test(original.slice(lineStart, end.index));
        edits.push({ offset: ownLine ? lineStart : end.index,
          insert: `${ownLine ? '' : '\n'}${insert}${trailingComma ? ',' : ''}\n${ownLine ? '' : '      '}` });
        prior.push(...entries);
      }
      return end;
    }
    return last;
  }
  value([]);
  if (i !== tokens.length || matched.size !== additions.size) throw new Error('invalid-sync-target');
  let updated = original;
  for (const { offset, insert } of edits.sort((a, b) => b.offset - a.offset)) updated = updated.slice(0, offset) + insert + updated.slice(offset);
  if (!isDeepStrictEqual(parse(updated), expected)) throw new Error('invalid-sync-target');
  return updated;
}

export async function publishModels({ path, original, additions, parse, validate, stateDir, writePrivate }) {
  if (!additions.size) return;
  const updated = appendModels(original, additions, parse);
  if (!(await lstat(path)).isFile()) throw new Error('invalid-sync-target');
  const dir = await mkdtemp(join(dirname(path), '.model-sync-'));
  try {
    const staged = join(dir, 'models.json');
    await writePrivate(staged, updated);
    if ((await validate(staged)).getError()) throw new Error('invalid-sync-target');
    if (!(await lstat(path)).isFile() || await readFile(path, 'utf8') !== original) throw new Error('concurrent-model-edit');
    await writePrivate(join(stateDir, 'models.json.previous'), original);
    await writePrivate(path, updated, { chmodParent: false, beforeRename: async () => {
      if (!(await lstat(path)).isFile() || await readFile(path, 'utf8') !== original) throw new Error('concurrent-model-edit');
    } });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function publishImages({ path, imageIds, writePrivate }) {
  const prior = await readFile(path, 'utf8').then(text => JSON.parse(text), error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!Array.isArray(prior) || prior.some(id => typeof id !== 'string' || !imageId.test(id))) throw new Error('invalid-image-catalog');
  const added = [...new Set(imageIds)].filter(id => imageId.test(id) && !prior.includes(id)).sort();
  if (added.length) await writePrivate(path, JSON.stringify([...prior, ...added], null, 2) + '\n', { chmodParent: false });
  return added;
}
