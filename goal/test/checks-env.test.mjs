import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VERIFICATION,
  environmentSignature,
  normalizeVerification,
  verificationKey,
  verificationSummary,
} from '../src/checks.ts';

import { makeGoal } from '../src/state.ts';

test('network policies normalize destinations and migrate old host grants to offline', () => {
  assert.deepEqual(normalizeVerification(undefined), {
    ...DEFAULT_VERIFICATION,
    workspace: 'readonly',
  });
  assert.equal(makeGoal('Build the project').verification.workspace, 'ephemeral');
  assert.equal(normalizeVerification({ workspace: 'readonly' }).workspace, 'readonly');
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
test('explicit variables are canonical, identity-bound and cannot inherit credentials or change proxy controls', () => {
  const first = normalizeVerification({ variables: { TZ: 'UTC', CI: '1' } });
  const second = normalizeVerification({ variables: { CI: '1', TZ: 'UTC' } });
  assert.equal(verificationKey(first), verificationKey(second));
  assert.notEqual(verificationKey(first), verificationKey({ ...first, variables: { CI: '0' } }));
  assert.match(verificationSummary(first), /CI, TZ/);
  for (const name of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'no_proxy',
    'PATH',
    'HOME',
    'NODE_EXTRA_CA_CERTS',
    'NPM_CONFIG_CAFILE',
    'API_KEY',
    'AWS_ACCESS_KEY_ID',
    'OPENAI_API_KEY',
    'MY_TOKEN',
    'LD_PRELOAD',
    'BASH_ENV',
  ])
    assert.throws(
      () => normalizeVerification({ variables: { [name]: 'not allowed' } }),
      /reserved|credential/,
    );
  for (const variables of [
    [],
    { CI: 1 },
    { CI: 'a\u0000b' },
    { CI: 'a'.repeat(4097) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`FLAG_${i}`, '1'])),
  ])
    assert.throws(() => normalizeVerification({ variables }));
});

test('environment failure advice cannot turn failed checks into passes', () => {
  assert.match(environmentSignature('Proxy denied', DEFAULT_VERIFICATION, 1), /allowlist/);
  assert.match(
    environmentSignature(
      'Read-only file system',
      { ...DEFAULT_VERIFICATION, workspace: 'readonly' },
      1,
    ),
    /ephemeral/,
  );
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
