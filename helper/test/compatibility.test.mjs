import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertSupportedPi, isSupportedPi, minimumPiVersion } from '../src/compatibility.ts';

const checker = fileURLToPath(new URL('../scripts/check-compat.mjs', import.meta.url));
function releases(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helper-releases-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the minimum peer range admits future stable releases without a ceiling', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(minimumPiVersion, '1.5.0');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-ai'], `>=${minimumPiVersion}`);
  assert.equal(
    manifest.peerDependencies['@earendil-works/pi-coding-agent'],
    `>=${minimumPiVersion}`,
  );
  for (const version of ['1.5.0', '1.5.1', '1.6.0', '1.10.0', '2.0.0', '10.0.0', '1.5.0+build.1']) {
    assert.equal(isSupportedPi(version), true, version);
    assert.doesNotThrow(() => assertSupportedPi(version));
  }
  for (const version of [
    '0.99.0',
    '1.4.99',
    '1.5.0-dev',
    '2.0.0-rc.1',
    '1.5',
    '01.5.0',
    '1.05.0',
    '1.5.0\n',
    'latest',
    '',
  ]) {
    assert.equal(isSupportedPi(version), false, version);
    assert.throws(() => assertSupportedPi(version), /requires Pi >=1\.5\.0/);
  }
});

test('compatibility checking fails when no supported release was installed', (t) => {
  const dir = releases(t);
  mkdirSync(join(dir, '1.4.0'));
  const result = spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No installed stable Pi releases >=1\.5\.0/);
});

test('compatibility checking discovers future releases and verifies their actual host version', (t) => {
  const dir = releases(t);
  const host = join(dir, '1.6.0/node_modules/@earendil-works/pi-ai');
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, 'package.json'), JSON.stringify({ version: '1.5.0' }));
  const result = spawnSync(process.execPath, [checker, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL Pi 1\.6\.0: Error: Host release mismatch/);
});
