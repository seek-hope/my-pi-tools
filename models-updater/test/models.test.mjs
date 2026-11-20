import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, mkdir, rm, access } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshot, difference, scopeFor, endpointFor, discover, checkModels,
  reportText, noticeFingerprint, writePrivate
} from '../check-models.mjs';

const model = id => ({ id, contextWindow: 100, maxTokens: 20 });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const auth = { auth: { apiKey: 'PRIVATE_TEST_KEY' } };
const gateway = (models = ['old']) => ({ baseUrl: 'https://example.test/v1', api: 'openai-responses', models: models.map(model) });
function fixture(custom = {}, options = {}) {
  let native = [model('old-native')];
  const calls = [];
  return {
    calls,
    config: { getError: () => undefined, getProviderIds: () => Object.keys(custom), getProvider: id => custom[id] },
    runtime: {
      async refresh(args) {
        calls.push(args);
        if (args.allowNetwork) native = [model('new-native')];
        return { aborted: false, errors: args.allowNetwork ? options.errors ?? new Map() : new Map() };
      },
      getProviders: () => [{ id: 'native', refreshModels() {} }, { id: 'unconfigured', refreshModels() {} }],
      hasConfiguredAuth: id => id === 'native',
      getAllModels: () => native,
      getModels: () => [],
      getError: () => undefined,
      getAuth: async id => { calls.push({ authFor: id }); return auth; },
      settleCredentialWrites: async () => {}
    }
  };
}

test('snapshots ignore credentials and changes are ordering-independent', () => {
  const a = snapshot([{ id: 'a', cost: { input: 1, output: 2 }, headers: { Authorization: 'PRIVATE_TEST_KEY' } }]);
  const b = snapshot([{ id: 'a', cost: { output: 2, input: 1 } }]);
  assert.deepEqual(difference(a, b), { added: [], removed: [], changed: [] });
  assert.ok(!JSON.stringify(a).includes('PRIVATE_TEST_KEY'));
  assert.deepEqual(difference(a, snapshot([model('b')])), { added: ['b'], removed: ['a'], changed: [] });
  assert.deepEqual(difference(snapshot([model('a')]), snapshot([{ ...model('a'), contextWindow: 200 }])), { added: [], removed: [], changed: ['a'] });
});

test('only a uniform explicit namespace restricts gateway model families', () => {
  assert.equal(scopeFor([model('google/a'), model('google/b')]), 'google/');
  assert.equal(scopeFor([model('gpt-a'), model('gpt-b')]), '');
  assert.equal(scopeFor([model('google/a'), model('other/b')]), '');
  assert.equal(scopeFor([]), '');
});

test('model-list URLs allow HTTPS and literal loopback HTTP only', () => {
  assert.equal(endpointFor(gateway()).href, 'https://example.test/v1/models');
  assert.equal(endpointFor({ ...gateway(), api: 'anthropic-messages', baseUrl: 'https://example.test/' }).pathname, '/v1/models');
  assert.equal(endpointFor({ ...gateway(), baseUrl: 'http://127.0.0.1:8317/v1' }).protocol, 'http:');
  for (const baseUrl of ['http://example.test/v1', 'http://192.168.1.2/v1', 'https://user:secret@example.test/v1', 'https://example.test/v1?key=secret']) {
    assert.throws(() => endpointFor({ ...gateway(), baseUrl }));
  }
});

test('GET requests use bounded fetches, prohibit redirects, and keep auth out of results', async () => {
  const list = await discover(gateway(), auth, { fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.get('authorization'), 'Bearer PRIVATE_TEST_KEY');
    return json({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] });
  } });
  assert.deepEqual(list, [{ id: 'a' }, { id: 'b' }]);
  assert.ok(!JSON.stringify(list).includes('PRIVATE_TEST_KEY'));
});

test('server-echoed credential strings cannot become persisted model IDs', async () => {
  await assert.rejects(discover(gateway(), auth, { fetchImpl: async () => json({ data: [{ id: 'echo-PRIVATE_TEST_KEY' }] }) }), /invalid-model-id/u);
});

test('Google list pagination uses headers and normalizes model resource names', async () => {
  let page = 0;
  const list = await discover({ ...gateway(), api: 'google-generative-ai', baseUrl: 'https://example.test/v1beta' }, auth, { fetchImpl: async (url, options) => {
    assert.equal(options.headers.get('x-goog-api-key'), 'PRIVATE_TEST_KEY');
    assert.ok(!url.searchParams.has('key'));
    if (page++ === 0) return json({ models: [{ name: 'models/google/a' }], nextPageToken: 'next' });
    assert.equal(url.searchParams.get('pageToken'), 'next');
    return json({ models: [{ name: 'models/google/b' }] });
  } });
  assert.deepEqual(list, [{ id: 'google/a' }, { id: 'google/b' }]);
});

test('Anthropic list pagination preserves its own auth protocol', async () => {
  let page = 0;
  const list = await discover({ ...gateway(), api: 'anthropic-messages' }, auth, { fetchImpl: async (url, options) => {
    assert.equal(options.headers.get('x-api-key'), 'PRIVATE_TEST_KEY');
    assert.equal(options.headers.get('anthropic-version'), '2023-06-01');
    if (page++ === 0) return json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' });
    assert.equal(url.searchParams.get('after_id'), 'a');
    return json({ data: [{ id: 'b' }], has_more: false });
  } });
  assert.equal(list.length, 2);
});

test('invalid, empty, cyclic, oversized and error responses are rejected', async () => {
  const responses = [
    new Response('SECRET', { status: 403 }),
    new Response('not-json'),
    json({ data: [] }),
    json({ data: [{ id: 'bad\nid' }] }),
    json({ unexpected: [] }),
    new Response(' '.repeat(2 * 1024 * 1024 + 1))
  ];
  for (const response of responses) await assert.rejects(discover(gateway(), auth, { fetchImpl: async () => response }));
  await assert.rejects(discover(gateway(), auth, { fetchImpl: async () => json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }) }), /invalid-pagination/u);
});

test('checks refresh only configured native catalogs and observe custom differences', async () => {
  const f = fixture({ proxy: gateway(['old', 'retired']) });
  const result = await checkModels({ ...f, fetchImpl: async () => json({ data: [{ id: 'old' }, { id: 'new' }] }) });
  assert.deepEqual(f.calls.find(call => call.allowNetwork).providers, ['native']);
  const endpoint = result.providers.find(row => row.id === 'proxy');
  assert.deepEqual(endpoint.added, ['new']);
  assert.deepEqual(endpoint.removed, ['retired']);
  assert.deepEqual(endpoint.configuredNotListed, ['retired']);
  assert.equal(endpoint.baseline, true);
  assert.equal(result.summary.errors, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_KEY'));
});

test('insecure endpoints are skipped before credential resolution', async () => {
  const f = fixture({ insecure: { ...gateway(), baseUrl: 'http://example.test/v1' } });
  const result = await checkModels({ ...f, fetchImpl: async () => assert.fail('must not fetch') });
  assert.ok(!f.calls.some(call => call.authFor === 'insecure'));
  assert.equal(result.providers.find(row => row.id === 'insecure').reason, 'insecure-http');
  assert.equal(result.summary.skipped, 1);
});

test('namespace scoping does not report unrelated families as additions', async () => {
  const f = fixture({ proxy: gateway(['google/a']) });
  const result = await checkModels({ ...f, fetchImpl: async () => json({ data: [{ id: 'google/a' }, { id: 'google/b' }, { id: 'openai/c' }] }) });
  const row = result.providers.find(row => row.id === 'proxy');
  assert.equal(row.advertisedCount, 3);
  assert.equal(row.count, 2);
  assert.deepEqual(row.added, ['google/b']);
});

test('endpoint failures preserve successful snapshots and redact arbitrary errors', async () => {
  const f = fixture({ proxy: gateway() });
  const previous = { snapshots: { 'endpoint:proxy': [{ id: 'known-good' }] } };
  const result = await checkModels({ ...f, previous, fetchImpl: async () => { throw new Error('Bearer PRIVATE_TEST_KEY https://secret.test?key=SECRET'); } });
  assert.deepEqual(result.snapshots['endpoint:proxy'], previous.snapshots['endpoint:proxy']);
  assert.equal(result.providers.find(row => row.id === 'proxy').error, 'request-failed');
  assert.equal(result.summary.errors, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_KEY'));
  assert.ok(!reportText(result).includes('secret.test'));
});

test('empty CLIProxyAPI catalog is a skip only if management confirms all credentials disabled', async () => {
  const f = fixture({ cliproxy: { ...gateway(), baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions' } });
  const previous = { snapshots: { 'endpoint:cliproxy': [{ id: 'last-good' }] } };
  const common = { ...f, previous, fetchImpl: async () => json({ data: [] }) };
  const result = await checkModels({ ...common, getProxyCredentialState: async () => ({ files: [{ disabled: true, key: 'PRIVATE_TEST_KEY' }] }) });
  assert.deepEqual(result.providers.find(row => row.id === 'cliproxy'), {
    key: 'endpoint:cliproxy', id: 'cliproxy', kind: 'endpoint', status: 'skipped', reason: 'proxy-credentials-disabled'
  });
  assert.equal(result.summary.errors, 0);
  assert.deepEqual(result.snapshots['endpoint:cliproxy'], previous.snapshots['endpoint:cliproxy']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_KEY'));
  for (const getProxyCredentialState of [async () => ({ files: [] }), async () => ({ files: [{ disabled: true }, { disabled: false }] }),
    async () => { throw new Error('management API unavailable'); }]) {
    const failed = await checkModels({ ...common, getProxyCredentialState });
    assert.equal(failed.providers.find(row => row.id === 'cliproxy').error, 'empty-catalog');
    assert.equal(failed.summary.errors, 1);
  }
});

test('unrelated endpoints and nonempty proxy catalogs never query management state', async () => {
  const f = fixture({ cliproxy: gateway() });
  const opt = { ...f, getProxyCredentialState: async () => assert.fail('management key must only go to local CLIProxyAPI') };
  const result = await checkModels({ ...opt, fetchImpl: async () => json({ data: [] }) });
  assert.equal(result.summary.errors, 1);
  const loopback = fixture({ cliproxy: { ...gateway(), baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions' } });
  const recovered = await checkModels({ ...opt, ...loopback, fetchImpl: async () => json({ data: [{ id: 'new' }] }) });
  assert.equal(recovered.providers.find(row => row.id === 'cliproxy').status, 'ok');
  assert.equal(recovered.summary.errors, 0);
});

test('a valid list with no image models skips only image sync; invalid list remains an error', async () => {
  const f = fixture({ byteseek: gateway() });
  const base = { ...f, sync: true, fetchImpl: async () => json({ data: [{ id: 'chat' }] }) };
  const getRow = result => result.providers.find(item => item.id === 'byteseek-images');
  const skipped = await checkModels({ ...base, getImageCatalog: async () => [] });
  assert.equal(getRow(skipped).reason, 'no-image-models-advertised');
  assert.deepEqual(skipped.imagePlan, []);
  assert.equal(skipped.summary.errors, 0);
  const failed = await checkModels({ ...base, getImageCatalog: () => discover(gateway(), auth, { fetchImpl: async () => json({ data: [] }) }) });
  assert.equal(getRow(failed).error, 'empty-catalog');
  assert.equal(failed.summary.errors, 1);
  const recovered = await checkModels({ ...base, getImageCatalog: async () => ['gpt-image-2.6-flare'] });
  assert.equal(getRow(recovered).status, 'ok');
  assert.deepEqual(recovered.imagePlan, ['gpt-image-2.6-flare']);
});

test('native errors preserve snapshots and do not look like removals', async () => {
  const f = fixture({}, { errors: new Map([['native', new Error('PRIVATE_TEST_KEY')]]) });
  const previous = { snapshots: { 'native:native': [model('known-good')] } };
  const result = await checkModels({ ...f, previous });
  assert.deepEqual(result.snapshots['native:native'], previous.snapshots['native:native']);
  assert.equal(result.providers[0].status, 'error');
  assert.equal(result.summary.removed, 0);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_KEY'));
});

test('subsequent comparisons use the last successful observation, not curated config', async () => {
  const f = fixture({ proxy: gateway() });
  const previous = { snapshots: { 'endpoint:proxy': [{ id: 'catalog-old' }] } };
  const result = await checkModels({ ...f, previous, fetchImpl: async () => json({ data: [{ id: 'catalog-new' }] }) });
  const row = result.providers.find(row => row.id === 'proxy');
  assert.equal(row.baseline, false);
  assert.deepEqual(row.removed, ['catalog-old']);
  assert.deepEqual(row.added, ['catalog-new']);
});

test('notification identity ignores timestamps and first-run delta bookkeeping', async () => {
  const f = fixture({ proxy: gateway() });
  const first = await checkModels({ ...f, fetchImpl: async () => json({ data: [{ id: 'new' }] }) });
  const second = await checkModels({ ...f, previous: first, fetchImpl: async () => json({ data: [{ id: 'new' }] }) });
  assert.equal(noticeFingerprint(first), noticeFingerprint(second));
});

test('existing temporary files are preserved if exclusive creation fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-existing-'));
  try {
    const file = join(dir, 'status.json');
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, 'keep this file');
    await assert.rejects(writePrivate(file, 'new content'));
    assert.equal(await readFile(temporary, 'utf8'), 'keep this file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the public wrapper prevents concurrent checks with a kernel lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi models lock '));
  try {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const started = join(dir, 'started');
    await writeFile(join(bin, 'node'), '#!/bin/bash\nprintf started > "$STARTED"\nsleep 0.7\n', { mode: 0o755 });
    const wrapper = new URL('../bin/check-pi-models', import.meta.url).pathname;
    const env = { ...process.env, HOME: dir, XDG_STATE_HOME: join(dir, 'state'), PATH: `${bin}:${process.env.PATH}`, STARTED: started };
    const first = spawn('/bin/bash', [wrapper, '--help'], { env, stdio: 'ignore' });
    const exited = new Promise((resolve, reject) => { first.once('error', reject); first.once('exit', code => resolve(code)); });
    for (let i = 0; i < 100; i++) {
      if (await access(started).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(await readFile(started, 'utf8'), 'started');
    const second = spawnSync('/bin/bash', [wrapper, '--help'], { env });
    assert.equal(second.status, 1);
    assert.equal(await exited, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('private reports are atomic, private and leave no temporary files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-model-report-'));
  try {
    const file = join(dir, 'state/status.json');
    await writePrivate(file, '{"ok":true}\n');
    assert.equal(await readFile(file, 'utf8'), '{"ok":true}\n');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'state'))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(dir, 'state')), ['status.json']);
    await mkdir(join(dir, 'state/keep'));
    await assert.rejects(writePrivate(join(dir, 'state/keep'), 'do not replace directory'));
    assert.ok((await stat(join(dir, 'state/keep'))).isDirectory());
    assert.ok(!(await readdir(join(dir, 'state'))).some(name => name.endsWith('.tmp')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
