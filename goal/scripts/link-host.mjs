import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertSupportedPi } from '../src/compatibility.ts';

// Use the same host libraries as Pi. No package lifecycle scripts or runtime copies.
const version = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error('Unexpected Pi version');
const host = resolve(
  process.argv[2] ??
    join(homedir(), '.pi', 'agent', 'install', 'releases', version, 'node_modules'),
);
// Validate the selected host before changing any links.
const targetVersion = JSON.parse(
  readFileSync(join(host, '@earendil-works/pi-coding-agent/package.json'), 'utf8'),
).version;
assertSupportedPi(targetVersion);
for (const name of ['pi-ai', 'pi-tui']) {
  const other = JSON.parse(
    readFileSync(join(host, '@earendil-works', name, 'package.json'), 'utf8'),
  ).version;
  if (other !== targetVersion)
    throw new Error(`Mixed Pi host dependencies: ${name}@${other}, host@${targetVersion}`);
}
for (const name of [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
  'typebox',
]) {
  const target = join(host, name),
    link = resolve('node_modules', name);
  if (!existsSync(join(target, 'package.json')))
    throw new Error(
      `Missing host package: ${target}. Pass the host node_modules directory explicitly.`,
    );
  const existing = lstatSync(link, { throwIfNoEntry: false });
  // A Pi upgrade changes the host directory. Refresh only links, never replace installed directories.
  if (
    existing?.isSymbolicLink() &&
    (!existsSync(link) || realpathSync(link) !== realpathSync(target))
  ) {
    unlinkSync(link);
  } else if (existing) {
    console.log(`Already available: ${name}`);
    continue;
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(
    `Linked ${name}@${JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version}`,
  );
}
