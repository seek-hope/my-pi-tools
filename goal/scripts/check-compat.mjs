import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { supportedPi } from '../src/compatibility.ts';
import { sourceHashes, sha256 } from './verification-sources.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releases = resolve(process.argv[2] ?? join(homedir(), '.pi/agent/install/releases'));
const hashes = sourceHashes();
const results = [];
const out = join(root, 'verification/results');
mkdirSync(out, { recursive: true });
for (const version of [supportedPi.previous, supportedPi.current]) {
  const host = join(releases, version, 'node_modules');
  const cwd = mkdtempSync(join(tmpdir(), 'my-pi-goal-compat-'));
  let output = '',
    ok = true;
  try {
    // Never relink a live user's workspace or read their agent settings/session data.
    for (const file of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      '.prettierrc.json',
      'src',
      'extensions',
      'test',
      'scripts',
      'verification',
    ])
      cpSync(join(root, file), join(cwd, file), {
        recursive: true,
        filter: (p) => !p.includes(`${join('verification', 'results')}`),
      });
    const link = (name, target) => {
      if (!existsSync(join(target, 'package.json'))) throw new Error(`Missing package: ${target}`);
      mkdirSync(dirname(join(cwd, 'node_modules', name)), { recursive: true });
      symlinkSync(target, join(cwd, 'node_modules', name), 'dir');
    };
    for (const name of [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-tui',
      '@earendil-works/pi-coding-agent',
      'typebox',
    ]) {
      const target = join(host, name);
      const declared = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version;
      if (name.startsWith('@earendil-works/') && declared !== version)
        throw new Error(`Mixed host dependencies for ${version}: ${name}@${declared}`);
      link(name, target);
    }
    for (const name of ['typescript', '@types/node', 'undici-types'])
      link(name, join(root, 'node_modules', name));
    const cli = JSON.parse(
      readFileSync(join(host, '@earendil-works/pi-coding-agent/package.json'), 'utf8'),
    ).bin.pi;
    const commands = [
      [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'],
      [
        '--test',
        ...readdirSync(join(cwd, 'test'))
          .filter((f) => f.endsWith('.test.mjs'))
          .sort()
          .map((f) => `test/${f}`),
      ],
      [
        join(host, '@earendil-works/pi-coding-agent', cli),
        '--offline',
        '--no-extensions',
        '-e',
        join(cwd, 'extensions/index.ts'),
        '--list-models',
        '__goal_compat_load__',
      ],
    ];
    for (const args of commands) {
      const r = spawnSync(process.execPath, args, {
        cwd,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(cwd, 'agent'),
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
        },
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      output += `$ node ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`;
      if (
        r.error ||
        r.status !== 0 ||
        r.signal ||
        /Failed to load extension|Extension errors/i.test(output)
      ) {
        ok = false;
        output += String(r.error ?? `exit ${r.status} signal ${r.signal}`);
        break;
      }
    }
  } catch (e) {
    ok = false;
    output += String(e);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const log = `compat-${version}.log`;
  writeFileSync(join(out, log), output);
  results.push({ version, ok, log, logSha256: sha256(output) });
  console.log(
    `${ok ? 'PASS' : 'FAIL'} Pi ${version}: types, full suite and isolated extension load`,
  );
}
const unchanged = JSON.stringify(hashes) === JSON.stringify(sourceHashes());
const passed = unchanged && results.every((r) => r.ok);
writeFileSync(
  join(out, 'compatibility.json'),
  JSON.stringify(
    {
      finishedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      supportedPi,
      sourceHashes: hashes,
      passed,
      results,
    },
    null,
    2,
  ) + '\n',
);
if (!passed) process.exitCode = 1;
