import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { checkExtensionLoad } from '../scripts/check-load.mjs';
import { supportedPi, assertSupportedPi } from '../src/compatibility.ts';
import { runContracts } from '../scripts/verify-contracts.mjs';
import { verifyCoverage } from '../scripts/verify-coverage.mjs';

test('rolling support window agrees with host peer dependencies and rejects other releases', () => {
  const p = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['pi-ai', 'pi-coding-agent', 'pi-tui']) {
    const versions = p.peerDependencies[`@earendil-works/${name}`].split(' || ');
    assert.deepEqual(versions.sort(), Object.values(supportedPi).sort());
  }
  for (const v of Object.values(supportedPi)) assert.doesNotThrow(() => assertSupportedPi(v));
  assert.throws(() => assertSupportedPi('1.0.3'), /supports Pi/);
  assert.throws(() => assertSupportedPi('1.0.4'), /supports Pi/);
  assert.throws(() => assertSupportedPi('1.1.0'), /supports Pi/);
  assert.throws(() => assertSupportedPi('1.2.0'), /supports Pi/);
  assert.throws(() => assertSupportedPi('1.5.0'), /supports Pi/);
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(lock.packages[''].peerDependencies, p.peerDependencies);
  assert.throws(() => assertSupportedPi('1.1.1'), /supports Pi/);
});
test('real package entry loads and registers commands/tools with the linked supported host', async () => {
  const loaded = await checkExtensionLoad();
  assert.equal(loaded.version, VERSION);
  assert.equal(loaded.command, 'goal');
  assert.equal(loaded.tools.length, 10);
});

test('load check rejects factory errors, missing registrations and mismatched CLI libraries', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'goal-load-negative-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bad = join(cwd, 'bad.ts'),
    empty = join(cwd, 'empty.ts');
  writeFileSync(bad, 'export default function () { throw new Error("fixture factory failed"); }');
  writeFileSync(empty, 'export default function () {}');
  await assert.rejects(checkExtensionLoad({ entry: bad }), /fixture factory failed/);
  await assert.rejects(checkExtensionLoad({ entry: empty }), /not registered/);
  const other = Object.values(supportedPi).find((v) => v !== VERSION);
  await assert.rejects(checkExtensionLoad({ expectedVersion: other }), /workspace libraries/);
});

test('reviewed coverage inventory rejects missing production mappings and unknown models', () => {
  const rows = JSON.parse(
    readFileSync(new URL('../verification/coverage.json', import.meta.url), 'utf8'),
  );
  assert.ok(verifyCoverage(rows).models >= 12);
  assert.throws(
    () =>
      verifyCoverage(
        rows.map((r) => ({ ...r, sources: r.sources.filter((f) => f !== 'src/tui.ts') })),
      ),
    /Unreviewed production module/,
  );
  rows[0].models.push('NonexistentProtocol');
  assert.throws(() => verifyCoverage(rows), /Missing positive model/);
});
test('finite implementation domains satisfy independent contract predicates', () => {
  const result = runContracts();
  assert.ok(result.passed);
  assert.ok(result.groups.every((g) => g.assertions > 0 && g.passed));
  assert.ok(result.groups.reduce((n, g) => n + g.assertions, 0) > 300000);
});
