#!/usr/bin/env node
/** Refresh Pi catalogs and observe configured endpoints without editing model configuration. */
import { createHash } from 'node:crypto';
import { readFile, mkdir, open, rename, unlink, chmod, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { aiLifeCatalog, isAiLifePublic, loopbackProxy, selectAdditions, publishModels, publishImages } from './sync-models.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 10000;
const ID_PATTERN = /^[^\s\x00-\x1f\x7f]{1,512}$/u;
const MODEL_FIELDS = ['id', 'type', 'api', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'thinkingLevelMap', 'cost'];

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

export function snapshot(models, metadata = true) {
  const result = new Map();
  for (const model of models) {
    if (!model || typeof model.id !== 'string' || !ID_PATTERN.test(model.id)) throw new Error('invalid-model-id');
    result.set(model.id, metadata
      ? stable(Object.fromEntries(MODEL_FIELDS.filter(key => model[key] !== undefined).map(key => [key, model[key]])))
      : { id: model.id });
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function difference(before, after) {
  const a = new Map(before.map(model => [model.id, model]));
  const b = new Map(after.map(model => [model.id, model]));
  return {
    added: [...b.keys()].filter(id => !a.has(id)),
    removed: [...a.keys()].filter(id => !b.has(id)),
    changed: [...b.keys()].filter(id => a.has(id) && JSON.stringify(stable(a.get(id))) !== JSON.stringify(stable(b.get(id))))
  };
}

export function scopeFor(models) {
  const ids = models.map(model => model.id);
  const namespaces = new Set(ids.map(id => id.includes('/') ? id.slice(0, id.indexOf('/') + 1) : ''));
  return ids.length && namespaces.size === 1 ? [...namespaces][0] : '';
}

export function endpointFor(provider) {
  const url = new URL(provider.baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('unsafe-endpoint');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('insecure-http');
  const base = url.pathname.replace(/\/$/u, '');
  url.pathname = provider.api === 'anthropic-messages' && !base.endsWith('/v1')
    ? `${base}/v1/models` : `${base}/models`;
  return url;
}

async function readJSON(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`http-${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty-response');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) throw new Error('response-too-large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid-json'); }
}

export async function discover(provider, auth, { fetchImpl = fetch, signal, metadata = false } = {}) {
  const url = endpointFor(provider);
  const headers = new Headers(auth?.auth?.headers ?? {});
  headers.set('Accept', 'application/json');
  const key = auth?.auth?.apiKey;
  if (key) {
    if (provider.api === 'google-generative-ai') headers.set('x-goog-api-key', key);
    else if (provider.api === 'anthropic-messages') {
      headers.set('x-api-key', key);
      headers.set('anthropic-version', '2023-06-01');
    } else headers.set('Authorization', `Bearer ${key}`);
  }
  if (!key && ![...headers.keys()].some(name => /authorization|api-key/u.test(name))) throw new Error('no-auth');
  const secrets = [key, ...Object.values(auth?.auth?.headers ?? {}).flatMap(value =>
    typeof value === 'string' ? [value, value.replace(/^Bearer\s+/iu, '')] : []),
    headers.get('authorization')?.replace(/^Bearer\s+/iu, '')].filter(Boolean);
  const models = [];
  const cursors = new Set();
  for (let page = 0; page < 20; page++) {
    const data = await readJSON(await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal }));
    const entries = data.data ?? data.models;
    if (!Array.isArray(entries)) throw new Error('invalid-catalog');
    for (const entry of entries) {
      let id = entry?.id ?? entry?.name;
      if (provider.api === 'google-generative-ai' && typeof id === 'string') id = id.replace(/^models\//u, '');
      if (typeof id !== 'string' || !ID_PATTERN.test(id) ||
          secrets.some(secret => id === secret || (secret.length >= 8 && id.includes(secret)))) throw new Error('invalid-model-id');
      models.push(metadata ? { ...entry, id } : { id });
    }
    if (models.length > MAX_MODELS) throw new Error('too-many-models');
    let cursor;
    let parameter;
    if (data.nextPageToken) { cursor = data.nextPageToken; parameter = 'pageToken'; }
    else if (data.has_more === true) { cursor = data.last_id ?? entries.at(-1)?.id; parameter = 'after_id'; }
    if (!cursor) {
      if (data.has_more === true) throw new Error('invalid-pagination');
      if (!models.length) throw new Error('empty-catalog');
      return metadata ? [...new Map(models.map(row => [row.id, row])).values()] : snapshot(models, false);
    }
    if (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor)) throw new Error('invalid-pagination');
    cursors.add(cursor);
    url.searchParams.set(parameter, cursor);
  }
  throw new Error('too-many-pages');
}

function errorCode(error) {
  const known = /^(?:http-\d{3}|insecure-http|unsafe-endpoint|no-auth|empty-response|response-too-large|invalid-json|invalid-catalog|invalid-model-id|too-many-models|invalid-pagination|empty-catalog|too-many-pages)$/u;
  if (known.test(error?.message ?? '')) return error.message;
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return 'timeout';
  return 'request-failed'; // Never persist server text, URLs, headers, tokens or error stacks.
}

export function allProxyCredentialsDisabled(data) {
  return Array.isArray(data?.files) && data.files.length > 0 &&
    data.files.every(credential => credential?.disabled === true);
}

export async function checkModels({ runtime, config, previous = {}, fetchImpl = fetch, sync, getProxyDefinitions,
  getProxyCredentialState, getImageCatalog, publicOrigin }) {
  const providers = [];
  const plans = new Map();
  const observations = new Map();
  const imagePlan = [];
  const snapshots = { ...(previous.snapshots ?? {}) };
  if (config.getError()) throw new Error('invalid-model-configuration');
  const initial = await runtime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(10000) });
  if (initial.aborted) throw new Error('runtime-load-timeout');
  if (runtime.getError()) throw new Error('runtime-load-failed');
  const native = runtime.getProviders().filter(provider => provider.refreshModels && runtime.hasConfiguredAuth(provider.id));
  if (sync) {
    for (const id of ['openai-codex', 'kimi-coding', 'deepseek']) {
      if (!native.some(provider => provider.id === id)) {
        providers.push({ key: `native:${id}`, id, kind: 'native', status: 'skipped', reason: 'catalog-refresh-not-configured' });
      }
    }
  }
  const before = Object.fromEntries(native.map(provider => [provider.id, snapshot(runtime.getAllModels(provider.id))]));
  const refreshed = await runtime.refresh({ providers: native.map(provider => provider.id), allowNetwork: true, force: true, signal: AbortSignal.timeout(30000) });
  const trusted = new Map();
  if (sync) {
    for (const model of runtime.getModels('openai')) {
      trusted.set(model.id, model);
      trusted.set(`openai/${model.id}`, model);
    }
    for (const [provider, prefix] of [['google', 'google/'], ['anthropic', 'anthropic/']]) {
      for (const model of runtime.getModels(provider)) trusted.set(prefix + model.id, model);
    }
    for (const model of config.getProvider('byteseek')?.models ?? []) {
      if (!trusted.has(model.id)) trusted.set(model.id, model);
    }
  }
  for (const provider of native) {
    const id = provider.id;
    const key = `native:${id}`;
    if (refreshed.aborted || refreshed.errors.has(id)) {
      providers.push({ key, id, kind: 'native', status: 'error', error: refreshed.aborted ? 'timeout' : 'catalog-refresh-failed' });
      continue;
    }
    const models = snapshot(runtime.getAllModels(id));
    const old = previous.snapshots?.[key] ?? before[id];
    snapshots[key] = models;
    providers.push({ key, id, kind: 'native', status: 'ok', count: models.length, baseline: !previous.snapshots?.[key], ...difference(old, models) });
  }

  const checks = config.getProviderIds().map(async id => {
    const provider = config.getProvider(id);
    if (!provider.baseUrl || !provider.models?.length) return;
    const key = `endpoint:${id}`;
    const row = { key, id, kind: 'endpoint' };
    const supported = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
    if (!supported.includes(provider.api)) { providers.push({ ...row, status: 'skipped', reason: 'unsupported-api' }); return; }
    try {
      const signal = AbortSignal.timeout(20000);
      const publicCatalog = isAiLifePublic(id, provider, publicOrigin);
      let advertised;
      if (publicCatalog) {
        row.source = 'public-unauthenticated';
        advertised = await aiLifeCatalog(provider, { publicOrigin, fetchImpl, readJSON, signal });
      } else {
        const endpoint = endpointFor(provider); // Reject insecure endpoints before resolving credential sources.
        if (id === 'ai-life' && endpoint.protocol !== 'https:') throw new Error('insecure-http');
        const auth = await runtime.getAuth(id, { signal });
        advertised = await discover(provider, auth, { fetchImpl, signal, metadata: Boolean(sync) });
      }
      const scope = scopeFor(provider.models);
      const scoped = advertised.filter(model => !scope || model.id.startsWith(scope));
      const models = snapshot(scoped, false);
      if (sync) observations.set(id, { provider, advertised, scoped });
      const configured = snapshot(provider.models, false).filter(model => !scope || model.id.startsWith(scope));
      const old = previous.snapshots?.[key] ?? configured;
      snapshots[key] = models;
      const ids = new Set(models.map(model => model.id));
      providers.push({ ...row, status: 'ok', count: models.length, scope, advertisedCount: advertised.length,
        baseline: !previous.snapshots?.[key], configuredNotListed: configured.filter(model => !ids.has(model.id)).map(model => model.id),
        advertisedOnly: models.filter(model => !configured.some(item => item.id === model.id)).map(model => model.id),
        ...difference(old, models) });
    } catch (error) {
      const code = errorCode(error);
      let reason = ['insecure-http', 'unsafe-endpoint', 'no-auth'].includes(code) ? code : undefined;
      if (code === 'empty-catalog' && loopbackProxy(id, provider) && getProxyCredentialState) {
        try {
          if (allProxyCredentialsDisabled(await getProxyCredentialState(provider, AbortSignal.timeout(5000)))) {
            reason = 'proxy-credentials-disabled';
          }
        } catch { /* An unconfirmed cause must not turn an error into a skip. */ }
      }
      if (reason) providers.push({ ...row, status: 'skipped', reason });
      else providers.push({ ...row, status: 'error', error: code });
    }
  });
  await Promise.all(checks);
  const orca = observations.get('orcarouter-openai');
  const orcaMetadata = new Map((orca && /^https:\/\/api\.orcarouter\.ai\/v1\/?$/u.test(orca.provider.baseUrl)
    ? orca.advertised : []).map(item => [item.id, item]));
  await Promise.all([...observations].map(async ([id, { provider, scoped }]) => {
    const row = providers.find(item => item.key === `endpoint:${id}`);
    try {
      // Some protocol-specific listings omit capability metadata. Only enrich IDs
      // already present in that protocol's own listing, never import other IDs.
      const candidates = ['orcarouter-gemini', 'orcarouter-anthropic'].includes(id)
        ? scoped.map(item => orcaMetadata.get(item.id) ?? item) : scoped;
      const needsProxyMetadata = loopbackProxy(id, provider) && row.advertisedOnly.length > 0;
      const definitions = needsProxyMetadata ? await getProxyDefinitions(provider, AbortSignal.timeout(15000)) : [];
      const plan = selectAdditions(id, provider, candidates, { definitions, publicOrigin, lookup: key => trusted.get(key) });
      if (plan.models.length) plans.set(id, plan.models);
      if (plan.withheld.length) row.withheld = plan.withheld.sort();
    } catch {
      row.syncError = 'model-metadata-unavailable';
    }
  }));
  if (sync && !getImageCatalog && config.getProvider('byteseek')) {
    providers.push({ key: 'endpoint:byteseek-images', id: 'byteseek-images', kind: 'endpoint', status: 'skipped', reason: 'image-extension-not-configured' });
  }
  if (sync && getImageCatalog) {
    const row = { key: 'endpoint:byteseek-images', id: 'byteseek-images', kind: 'endpoint' };
    try {
      imagePlan.push(...await getImageCatalog());
      if (imagePlan.length) providers.push({ ...row, status: 'ok', count: imagePlan.length });
      else providers.push({ ...row, status: 'skipped', reason: 'no-image-models-advertised' });
    } catch (error) {
      providers.push({ ...row, status: 'error', error: errorCode(error) });
    }
  }
  await runtime.settleCredentialWrites();
  providers.sort((a, b) => a.key.localeCompare(b.key));
  const summary = {
    checked: providers.filter(row => row.status === 'ok').length,
    skipped: providers.filter(row => row.status === 'skipped').length,
    errors: providers.filter(row => row.status === 'error' || row.syncError).length,
    added: providers.reduce((n, row) => n + (row.added?.length ?? 0), 0),
    removed: providers.reduce((n, row) => n + (row.removed?.length ?? 0), 0),
    changed: providers.reduce((n, row) => n + (row.changed?.length ?? 0), 0)
  };
  return { version: 1, checkedAt: new Date().toISOString(), summary, providers, snapshots, ...(sync ? { plans, imagePlan } : {}) };
}

export function reportText(result) {
  const lines = [`Pi 模型目录检测 — ${result.checkedAt}`, '',
    `成功 ${result.summary.checked}，跳过 ${result.summary.skipped}，错误 ${result.summary.errors}`, '',
    result.sync ? '原生目录刷新缓存；自定义网关只追加通过筛选的模型，不改默认模型或已有条目。'
      : '原生目录刷新缓存；自定义网关仅检测。',
    '首次检测：原生与刷新前缓存比较，网关与 models.json 比较；以后与上次成功检测比较。',
    '网关未列出不等于已确认不可用；额外列出的 ID 也不保证适用于当前 API。', ''];
  for (const row of result.providers) {
    lines.push(`${row.kind}/${row.id}: ${row.status}${row.status === 'ok' ? ` (${row.count})` : ` (${row.error ?? row.reason})`}`);
    if (row.reason === 'proxy-credentials-disabled') lines.push('  本地代理的凭据均已停用；保留上次目录，需检查凭据状态。');
    if (row.reason === 'no-image-models-advertised') lines.push('  网关返回了有效目录，但未列出图像模型；保留已有图像列表。');
    if (row.scope) lines.push(`  仅比较命名空间: ${row.scope}`);
    if (row.source === 'public-unauthenticated') lines.push('  公开目录（未发送密钥，不代表账号授权）');
    if (row.syncError) lines.push(`  同步失败: ${row.syncError}`);
    if (row.withheld?.length) lines.push(`  类型、协议或元数据未满足同步条件 (${row.withheld.length}): ${row.withheld.join(', ')}`);
    if (row.written?.length) lines.push(`  已写入 (${row.written.length}): ${row.written.join(', ')}`);
    for (const [field, label] of [['added', row.baseline && row.kind === 'endpoint' ? '目录额外列出' : '新增'], ['removed', '目录不再列出'], ['changed', '元数据变化'], ['configuredNotListed', '已配置但目录未列出']]) {
      if (row[field]?.length) lines.push(`  ${label} (${row[field].length}): ${row[field].join(', ')}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function noticeFingerprint(result) {
  // Persistent configuration discrepancies remain visible; timestamps and first-run deltas do not spam notifications.
  return createHash('sha256').update(JSON.stringify(result.providers.map(row => ({ key: row.key, status: row.status,
    error: row.error, reason: row.reason, syncError: row.syncError, configuredNotListed: row.configuredNotListed, advertisedOnly: row.advertisedOnly,
    models: result.snapshots[row.key] })))).digest('hex');
}

export async function writePrivate(path, text, { chmodParent = true, beforeRename } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (chmodParent) await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  let handle;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(text);
    await handle.sync();
    await handle.close(); handle = undefined;
    await beforeRename?.();
    await rename(temporary, path);
  } finally {
    await handle?.close();
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function loadPi(agentDir, packageDir) {
  if (!packageDir) {
    const version = (await readFile(join(agentDir, 'install/current-version'), 'utf8')).trim();
    if (!/^[0-9][0-9A-Za-z.-]*$/u.test(version)) throw new Error('invalid-install-version');
    packageDir = join(agentDir, 'install/releases', version, 'node_modules/@earendil-works/pi-coding-agent');
  }
  const sdk = await import(pathToFileURL(join(packageDir, 'dist/index.js')).href);
  const { ModelConfig } = await import(pathToFileURL(join(packageDir, 'dist/core/model-config.js')).href);
  const { stripJsonComments } = await import(pathToFileURL(join(packageDir, 'dist/utils/json.js')).href);
  return {
    validate: path => ModelConfig.load(path),
    parse: text => JSON.parse(stripJsonComments(text.replace(/^\uFEFF/u, ''))),
    runtime: await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false }),
    config: await ModelConfig.load(join(agentDir, 'models.json'))
  };
}

async function proxyManagement(provider, path, signal) {
  if (!loopbackProxy('cliproxy', provider)) throw new Error('unsafe-endpoint');
  const keys = await readFile(join(homedir(), '.config/cliproxyapi/.keys'), 'utf8');
  const key = keys.match(/^\s*MGMT=([^\r\n]+)$/mu)?.[1]?.trim();
  if (!key) throw new Error('no-auth');
  const url = new URL(`/v8/management/${path}`, provider.baseUrl);
  return readJSON(await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal }));
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--notify', '--sync', '--help']);
  if (args.some(arg => !allowed.has(arg))) throw new Error('Unknown option; use --help');
  if (args.includes('--help')) {
    console.log('check-pi-models [--sync] [--notify]\nRefresh Pi native catalogs; --sync appends supported new gateway models.\nDoes not change existing entries or defaults. State: $XDG_STATE_HOME/pi-model-updates (default ~/.local/state).');
    return 0;
  }
  if (process.env.PI_OFFLINE !== undefined) throw new Error('PI_OFFLINE is set; model detection requires network access');
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent');
  if (!isAbsolute(configuredAgentDir)) throw new Error('Agent directory must be absolute');
  const agentDir = await realpath(configuredAgentDir);
  if (!process.env.ORCA_API_KEY && process.env.CREDENTIALS_DIRECTORY) {
    const key = await readFile(join(process.env.CREDENTIALS_DIRECTORY, 'orca-api-key'), 'utf8')
      .then(text => text.trim(), error => { if (error.code !== 'ENOENT') throw error; });
    if (key) process.env.ORCA_API_KEY = key;
  }
  const stateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'pi-model-updates');
  const publicOrigin = await readFile(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pi-model-updates/ai-life-origin'), 'utf8')
    .then(text => text.trim(), error => { if (error.code !== 'ENOENT') throw error; });
  let previous = {};
  try { previous = JSON.parse(await readFile(join(stateDir, 'status.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid previous model detection state'); }
  let runtime;
  let result;
  try {
    const sync = args.includes('--sync');
    const path = join(agentDir, 'models.json');
    const original = sync ? await readFile(path, 'utf8') : undefined;
    const loaded = await loadPi(agentDir, process.env.PI_MODELS_PACKAGE_DIR);
    runtime = loaded.runtime;
    const imageProvider = { baseUrl: 'https://tokens.byteseek.ai/v1', api: 'openai-completions' };
    const hasImageConsumer = sync && await readFile(join(agentDir, 'extensions/byteseek-images.ts'), 'utf8')
      .then(source => source.includes('byteseek-image-catalog.json'), () => false);
    if (hasImageConsumer) runtime.registerProvider('byteseek-images', imageProvider);
    result = await checkModels({ runtime, config: loaded.config, previous, sync, publicOrigin,
      getProxyCredentialState: (provider, signal) => proxyManagement(provider, 'credentials', signal),
      getProxyDefinitions: async (provider, signal) => {
        const data = await proxyManagement(provider, 'routing/model-definitions/antigravity', signal);
        if (!Array.isArray(data.models) || !data.models.length) throw new Error('invalid-catalog');
        return data.models;
      },
      getImageCatalog: hasImageConsumer ? async () => {
        const signal = AbortSignal.timeout(20000);
        const auth = await runtime.getAuth('byteseek-images', { signal });
        const rows = await discover(imageProvider, auth, { signal });
        const { images } = selectAdditions('byteseek', { ...imageProvider, models: [] }, rows, { lookup: () => undefined });
        return images;
      } : undefined });
    if (sync) {
      result.sync = true;
      const { plans, imagePlan } = result;
      delete result.plans;
      delete result.imagePlan;
      try {
        await publishModels({ path, original, additions: plans, parse: loaded.parse, validate: loaded.validate, stateDir, writePrivate });
        for (const row of result.providers) if (plans.has(row.id)) row.written = plans.get(row.id).map(model => model.id);
      } catch {
        result.summary.errors++;
        result.providers.push({ key: 'sync:models', id: 'models.json', kind: 'sync', status: 'error', error: 'model-config-not-written' });
      }
      if (imagePlan.length) {
        const row = result.providers.find(item => item.id === 'byteseek-images');
        try {
          row.written = await publishImages({ path: join(agentDir, 'byteseek-image-catalog.json'), imageIds: imagePlan, writePrivate });
        } catch {
          row.syncError = 'image-catalog-not-written';
          result.summary.errors++;
        }
      }
      result.summary.written = result.providers.reduce((n, row) => n + (row.written?.length ?? 0), 0);
    }
  } catch {
    result = { version: 1, checkedAt: new Date().toISOString(),
      summary: { checked: 0, skipped: 0, errors: 1, added: 0, removed: 0, changed: 0 },
      providers: [{ key: 'monitor', id: 'runtime', kind: 'monitor', status: 'error', error: 'monitor-failed' }],
      snapshots: previous.snapshots ?? {} };
  } finally { await runtime?.settleCredentialWrites(); }
  const report = reportText(result);
  const fingerprint = noticeFingerprint(result);
  result.noticeFingerprint = fingerprint;
  if (result.summary.written > 0) await writePrivate(join(stateDir, 'last-write-report.txt'), report);
  await writePrivate(join(stateDir, 'last-report.txt'), report);
  await writePrivate(join(stateDir, 'status.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(report);
  if (args.includes('--notify') && (previous.noticeFingerprint !== fingerprint || result.summary.written > 0)) {
    spawnSync('notify-send', ['-a', 'Pi Models', 'Pi 模型目录检测',
      `已同步 ${result.summary.written ?? 0}，新增/额外列出 ${result.summary.added}，未列出 ${result.summary.removed}，元数据变化 ${result.summary.changed}；跳过 ${result.summary.skipped}，错误 ${result.summary.errors}。详见 ${join(stateDir, 'last-report.txt')}`], { timeout: 5000, stdio: 'ignore' });
  }
  return result.summary.errors ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    // Credentials and server-controlled errors must never be logged, including on unexpected failures.
    console.error('模型目录检测失败；请检查 Pi 安装、models.json、认证及网络。已有成功快照未覆盖。');
    process.exitCode = 1;
  });
}
