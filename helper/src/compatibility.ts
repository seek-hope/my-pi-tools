import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const range: string = manifest.peerDependencies['@earendil-works/pi-coding-agent'];
const minimumMatch = /^>=(\d+\.\d+\.\d+)$/.exec(range);
if (!minimumMatch) throw new Error(`Expected a minimum Pi peer version; received: ${range}`);
export const minimumPiVersion = minimumMatch[1]!;
const minimum = minimumPiVersion.split('.').map(Number);

/** Stable releases only, matching the peer range's exclusion of prereleases. */
export function isSupportedPi(version: string): boolean {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      version,
    );
  if (!match || match[0] !== version) return false;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== minimum[i]) return parts[i]! > minimum[i]!;
  }
  return true;
}

export function assertSupportedPi(version: string) {
  if (!isSupportedPi(version))
    throw new Error(`my-pi-helper requires Pi ${range} (stable release); installed: ${version}`);
}
