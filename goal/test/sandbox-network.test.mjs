import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { permitted, publicIPv4, startProxy } from '../src/verification/proxy.mjs';

const allow = {
  network: 'allowlist',
  allow: ['*.example.com:443', 'registry.npmjs.org'],
  deny: ['blocked.example.com'],
};
test('proxy policy enforces destination, port, wildcard boundary and deny precedence', () => {
  assert.equal(permitted(allow, 'api.example.com', 443), true);
  for (const [host, port] of [
    ['example.com', 443],
    ['evil-example.com', 443],
    ['api.example.com', 80],
    ['blocked.example.com', 443],
    ['127.0.0.1', 443],
    ['gateway.docker.internal', 3128],
  ])
    assert.equal(permitted(allow, host, port), false);
  assert.equal(permitted({ ...allow, network: 'open' }, 'unlisted.example.org', 8080), true);
  assert.equal(permitted({ ...allow, network: 'open' }, 'blocked.example.com', 443), false);
  assert.equal(permitted({ ...allow, network: 'isolated' }, 'registry.npmjs.org', 443), false);
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4('1.1.1.1'), true);
});
test('proxy canonicalizes fully qualified DNS names before applying deny rules', () => {
  const policy = { network: 'open', deny: ['blocked.example.com', '*.private.example.com'] };
  for (const host of [
    'blocked.example.com.',
    'api.private.example.com.',
    'gateway.docker.internal.',
  ])
    assert.equal(permitted(policy, host, 443), false, host);
  assert.equal(
    permitted({ network: 'allowlist', allow: ['example.com'] }, 'example.com.', 443),
    true,
  );
});
test('IPv4 policy blocks special-use subnets without excluding neighboring public ranges', () => {
  for (const ip of ['192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1'])
    assert.equal(publicIPv4(ip), false, ip);
  for (const ip of ['192.0.3.1', '198.51.99.1', '198.51.101.1', '203.0.112.1', '203.0.114.1'])
    assert.equal(publicIPv4(ip), true, ip);
});

test('proxy blocks denied, private and malformed destinations before contacting upstream', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.end('upstream fixture');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const proxy = await startProxy(
    { network: 'allowlist', allow: ['example.com', 'private.example.org'] },
    `http://127.0.0.1:${upstream.address().port}`,
    async (host) => [{ address: host === 'private.example.org' ? '127.0.0.1' : '1.1.1.1' }],
  );
  t.after(() => proxy.close());
  const request = (path) =>
    new Promise((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: proxy.port,
            path,
            headers: { 'Proxy-Authorization': 'must-not-forward', Host: 'attacker.example.org' },
          },
          (res) => {
            res.resume();
            res.once('end', () => resolve(res.statusCode));
          },
        )
        .once('error', reject);
    });
  assert.equal(await request('http://example.com/fixture'), 200);
  assert.equal(seen[0].headers.host, 'example.com');
  assert.equal(seen[0].headers['proxy-authorization'], undefined);
  for (const path of [
    'http://denied.example.org/',
    'http://private.example.org/',
    'http://user:password@example.com/',
    'https://example.com/',
    'http://127.0.0.1/',
    '/relative',
  ])
    assert.equal(await request(path), 403);
  assert.equal(seen.length, 1);
});
