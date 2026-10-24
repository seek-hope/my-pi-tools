import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './verification-sources.mjs';
import { contractGroups } from './verify-contracts.mjs';
export function verifyCoverage(
  rows = JSON.parse(readFileSync(join(root, 'verification/coverage.json'), 'utf8')),
) {
  const cases = JSON.parse(readFileSync(join(root, 'verification/cases.json'), 'utf8'));
  const sourceFiles = ['extensions/index.ts'];
  const collect = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) collect(file);
      else if (/\.(ts|mjs)$/.test(entry.name)) sourceFiles.push(file);
    }
  };
  collect('src');
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'Duplicate coverage row');
  for (const source of sourceFiles)
    assert.ok(
      rows.some((r) => r.sources.includes(source)),
      `Unreviewed production module: ${source}`,
    );
  for (const row of rows) {
    assert.ok(
      row.boundary && row.behavior && row.sources.length,
      `Incomplete inventory: ${row.id}`,
    );
    for (const file of [...row.sources, ...row.tests])
      assert.ok(existsSync(join(root, file)), `Missing mapping: ${file}`);
    assert.ok(
      row.models.length || row.contracts.length || row.exclusion,
      `Uncovered behavior: ${row.id}`,
    );
    for (const id of row.contracts)
      assert.ok(
        contractGroups.some((g) => g.id === id),
        `Unknown bounded contract: ${id}`,
      );
    for (const name of row.models)
      assert.ok(
        cases.some((c) => c.module === name && c.expect === 'pass'),
        `Missing positive model: ${name}`,
      );
  }
  for (const g of contractGroups)
    assert.ok(
      rows.some((r) => r.contracts.includes(g.id)),
      `Unmapped implementation contract: ${g.id}`,
    );
  for (const c of cases) {
    assert.ok(
      rows.some((r) => r.models.includes(c.module)),
      `Unmapped model: ${c.module}`,
    );
    const model = readFileSync(join(root, 'verification', `${c.module}.tla`), 'utf8');
    const cfg = readFileSync(join(root, 'verification', `${c.name}.cfg`), 'utf8');
    if (c.property) {
      assert.ok(
        new RegExp(`^${c.property}\\s*==`, 'm').test(model),
        `Undefined property: ${c.property}`,
      );
      assert.ok(new RegExp(`\\b${c.property}\\b`).test(cfg), `Undeclared property: ${c.name}`);
    }
  }
  for (const f of readdirSync(join(root, 'verification'))) {
    if (f.endsWith('.tla'))
      assert.ok(
        cases.some((c) => `${c.module}.tla` === f),
        `Unexecuted model: ${f}`,
      );
    if (f.endsWith('.cfg'))
      assert.ok(
        cases.some((c) => `${c.name}.cfg` === f),
        `Unexecuted configuration: ${f}`,
      );
  }
  return {
    productionModules: sourceFiles.length,
    behaviorRows: rows.length,
    models: new Set(cases.map((c) => c.module)).size,
    configurations: cases.length,
    contracts: contractGroups.length,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(verifyCoverage(), null, 2));
