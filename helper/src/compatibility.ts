import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const supportedPi = Object.freeze(
  manifest.piCompatibility as { current: string; previous: string },
);
export function assertSupportedPi(version: string) {
  if (![supportedPi.current, supportedPi.previous].includes(version))
    throw new Error(
      `my-pi-helper supports Pi ${supportedPi.current} and ${supportedPi.previous}; installed: ${version}`,
    );
}
