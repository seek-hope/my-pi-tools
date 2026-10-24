import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VERIFICATION,
  environmentSignature,
  normalizeVerification,
  verificationKey,
  verificationSummary,
} from '../src/checks.ts';

test('network policies normalize destinations and migrate old host grants to offline', () => {
  assert.deepEqual(normalizeVerification(undefined), DEFAULT_VERIFICATION);
  assert.equal(normalizeVerification({ network: 'host' }).network, 'isolated');
  const policy = normalizeVerification({
    network: 'allowlist',
    allow: ['NPMJS.ORG:443', '*.example.com', 'npmjs.org:443'],
    deny: ['blocked.example.com'],
  });
  assert.deepEqual(policy.allow, ['*.example.com', 'npmjs.org:443']);
  assert.deepEqual(policy.deny, ['blocked.example.com']);
  for (const value of [
    { network: 'allowlist' },
    { network: 'none' },
    { allow: ['**'] },
    { allow: ['https://example.com'] },
    { allow: ['localhost'] },
    { allow: ['127.0.0.1'] },
    { allow: ['example.com:65536'] },
    { allow: ['example.com,evil.com'] },
    { workspace: 'rw' },
    { extra: true },
    { env: ['1INVALID'] },
  ])
    assert.throws(() => normalizeVerification(value));
});
test('verification identities bind the entire network policy without depending on list order', () => {
  const a = normalizeVerification({
    network: 'allowlist',
    allow: ['example.com', 'registry.npmjs.org'],
    deny: ['blocked.example.com'],
  });
  assert.equal(verificationKey(a), verificationKey({ ...a, allow: [...a.allow].reverse() }));
  assert.notEqual(verificationKey(a), verificationKey({ ...a, deny: [] }));
  assert.notEqual(verificationKey(a), verificationKey({ ...a, network: 'open' }));
  assert.match(verificationSummary(a), /allowlist via HTTP\/HTTPS proxy/);
  assert.match(verificationSummary(a), /host filesystem: not mounted/);
});
test('environment failure advice cannot turn failed checks into passes', () => {
  assert.match(environmentSignature('Proxy denied', DEFAULT_VERIFICATION, 1), /allowlist/);
  assert.match(environmentSignature('Read-only file system', DEFAULT_VERIFICATION, 1), /ephemeral/);
  assert.equal(
    environmentSignature(
      'Read-only file system',
      { ...DEFAULT_VERIFICATION, workspace: 'ephemeral' },
      1,
    ),
    undefined,
  );
  assert.match(
    environmentSignature('cc: command not found', DEFAULT_VERIFICATION, 127),
    /not found/,
  );
  assert.equal(environmentSignature('1 test failed', DEFAULT_VERIFICATION, 1), undefined);
});
