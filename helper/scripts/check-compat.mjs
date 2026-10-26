import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { supportedPi } from '../src/compatibility.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releases = resolve(process.argv[2] ?? join(homedir(), '.pi/agent/install/releases'));
let failed = false;
for (const version of [supportedPi.previous, supportedPi.current]) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-helper-compat-'));
  try {
    for (const file of [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'src',
      'extensions',
      'test',
    ])
      cpSync(join(root, file), join(cwd, file), { recursive: true });
    const host = join(releases, version, 'node_modules');
    const link = (name, target) => {
      if (!existsSync(join(target, 'package.json')))
        throw new Error(`Missing dependency: ${target}`);
      mkdirSync(dirname(join(cwd, 'node_modules', name)), { recursive: true });
      symlinkSync(target, join(cwd, 'node_modules', name), 'dir');
    };
    for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox']) {
      const target = join(host, name);
      if (
        name.startsWith('@earendil-works/') &&
        JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version !== version
      )
        throw new Error(`Host release mismatch: ${target}`);
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
        '__helper_compat_load__',
      ],
    ];
    for (const args of commands) {
      const result = spawnSync(process.execPath, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(cwd, 'agent'),
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
        },
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (
        result.error ||
        result.status !== 0 ||
        /Failed to load extension|Extension errors/i.test(output)
      )
        throw new Error(
          `${args.join(' ')}\n${output}\n${String(result.error ?? `exit ${result.status}`)}`,
        );
    }
    console.log(`PASS Pi ${version}: types, full Helper suite and isolated extension load`);
  } catch (error) {
    failed = true;
    console.error(`FAIL Pi ${version}: ${String(error)}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
if (failed) process.exitCode = 1;
