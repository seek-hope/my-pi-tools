import { readFileSync } from 'node:fs';

// The release pair is a maintenance decision, not an open-ended semver promise.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const supportedPi = Object.freeze(
  manifest.piCompatibility as {
    current: string;
    previous: string;
  },
);
export function assertSupportedPi(version: string) {
  if (![supportedPi.current, supportedPi.previous].includes(version))
    throw new Error(
      `my-pi-goal supports Pi ${supportedPi.current} and ${supportedPi.previous}. Installed: ${version}. Update the support window and run check:compat before using another release.`,
    );
}
