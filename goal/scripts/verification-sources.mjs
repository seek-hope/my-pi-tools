import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function sourceHashes() {
  const files = [
    'package.json',
    'package-lock.json',
    'verification/README.md',
    'verification/COVERAGE.md',
    'verification/coverage.json',
    'verification/cases.json',
  ];
  const collect = (directory) => {
    for (const item of readdirSync(join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`;
      if (item.isDirectory()) collect(file);
      else if (/\.(ts|mjs)$/.test(item.name)) files.push(file);
    }
  };
  for (const directory of ['src', 'extensions', 'test', 'scripts']) collect(directory);
  for (const name of readdirSync(join(root, 'verification')))
    if (/\.(tla|cfg)$/.test(name)) files.push(`verification/${name}`);
  return Object.fromEntries(
    files.sort().map((file) => [file, sha256(readFileSync(join(root, file)))]),
  );
}
