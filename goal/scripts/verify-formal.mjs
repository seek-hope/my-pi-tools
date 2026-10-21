import { sha256, sourceHashes } from './verification-sources.mjs';
import { runContracts, contractGroups } from './verify-contracts.mjs';
import { verifyCoverage } from './verify-coverage.mjs';
import { supportedPi } from '../src/compatibility.ts';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verification = join(root, 'verification');
export const tool = {
  release: '1.7.1',
  sha256: 'd532ba31aafe17afba1130f92410d9257454ff7393d1eb2fe032f0c07f352da5',
  url: 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.1/tla2tools.jar',
};
const jarPath = () =>
  resolve(
    process.env.TLA_TOOLS_JAR ??
      join(
        process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
        'my-pi-goal',
        'tla',
        tool.release,
        'tla2tools.jar',
      ),
  );

export function evaluateResult(entry, code, output, signal = null) {
  if (signal) return false;
  if (entry.expect === 'pass')
    return (
      code === 0 &&
      output.includes('Model checking completed. No error has been found.') &&
      /0 states left on queue\./.test(output)
    );
  if (entry.expect === 'invariant')
    return (
      code === 12 &&
      output.includes(`Error: Invariant ${entry.property} is violated.`) &&
      output.includes('State 1:')
    );
  if (entry.expect === 'temporal')
    return (
      code === 13 &&
      output.includes('Error: Temporal properties were violated.') &&
      output.includes('State 1:')
    );
  return false;
}

async function setup() {
  const jar = jarPath();
  if (existsSync(jar)) {
    if (sha256(readFileSync(jar)) !== tool.sha256) throw new Error(`TLC checksum mismatch: ${jar}`);
    console.log(`Pinned TLA+ tools ${tool.release} ready: ${jar}`);
    return;
  }
  const response = await fetch(tool.url);
  if (!response.ok) throw new Error(`TLA+ tools download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== tool.sha256) throw new Error('Downloaded TLC checksum mismatch');
  mkdirSync(dirname(jar), { recursive: true });
  const temporary = `${jar}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, jar);
  console.log(`Installed verified TLA+ tools ${tool.release}: ${jar}`);
}

function checkEvidence() {
  verifyCoverage();
  const summary = JSON.parse(readFileSync(join(verification, 'results/summary.json'), 'utf8'));
  if (!summary.passed || JSON.stringify(sourceHashes()) !== JSON.stringify(summary.sourceHashes))
    throw new Error('Formal evidence is failing or stale; rerun npm run verify:formal');
  const cases = JSON.parse(readFileSync(join(verification, 'cases.json'), 'utf8'));
  if (
    summary.results.length !== cases.length ||
    cases.some((c) => !summary.results.some((r) => r.name === c.name && r.ok))
  )
    throw new Error('Evidence does not cover the complete verification matrix');
  const contracts = JSON.parse(readFileSync(join(verification, 'results/contracts.json'), 'utf8'));
  if (
    !contracts.passed ||
    !summary.contractsSha256 ||
    sha256(JSON.stringify(contracts)) !== summary.contractsSha256 ||
    contracts.groups.length !== contractGroups.length ||
    contractGroups.some(
      (g) => !contracts.groups.some((r) => r.id === g.id && r.passed && r.assertions > 0),
    )
  )
    throw new Error('Missing or altered bounded implementation evidence');
  for (const result of summary.results) {
    const output = readFileSync(join(verification, result.log), 'utf8');
    const entry = cases.find((c) => c.name === result.name);
    if (
      sha256(output) !== result.logSha256 ||
      !evaluateResult(entry, result.code, output, result.signal)
    )
      throw new Error(`Invalid result evidence: ${result.name}`);
  }
  const compatibility = JSON.parse(
    readFileSync(join(verification, 'results/compatibility.json'), 'utf8'),
  );
  if (
    !compatibility.passed ||
    JSON.stringify(compatibility.sourceHashes) !== JSON.stringify(sourceHashes()) ||
    compatibility.results.length !== 2 ||
    Object.values(supportedPi).some(
      (v) => !compatibility.results.some((r) => r.version === v && r.ok),
    )
  )
    throw new Error('Compatibility evidence is missing or stale; run npm run check:compat');
  for (const r of compatibility.results)
    if (sha256(readFileSync(join(verification, 'results', r.log))) !== r.logSha256)
      throw new Error(`Altered compatibility log: ${r.version}`);
  console.log(
    `Current sources and ${summary.results.length} TLC receipts verified (${summary.finishedAt}).`,
  );
}

async function runCase(entry, jar, workers, logDirectory) {
  const cfg = readFileSync(join(verification, `${entry.name}.cfg`), 'utf8');
  if (entry.expect === 'temporal' && !cfg.includes(`PROPERTY ${entry.property}\n`))
    throw new Error(`Missing expected temporal property in ${entry.name}`);
  const metadata = mkdtempSync(join(tmpdir(), 'my-pi-goal-tlc-'));
  const args = [
    '-Xmx2g',
    '-XX:+UseParallelGC',
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    String(workers),
    '-seed',
    '1',
    '-fp',
    '0',
    '-config',
    `${entry.name}.cfg`,
    '-metadir',
    metadata,
    `${entry.module}.tla`,
  ];
  const started = Date.now();
  let output = '';
  try {
    const { code, signal } = await new Promise((resolveRun, reject) => {
      const child = spawn('java', args, { cwd: verification, stdio: ['ignore', 'pipe', 'pipe'] });
      const abort = () => child.kill('SIGTERM');
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.stderr.on('data', (data) => {
        output += data.toString();
      });
      const cleanup = () => {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
      };
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (code, signal) => {
        cleanup();
        resolveRun({ code, signal });
      });
    });
    const filename = `${entry.name}.log`;
    writeFileSync(join(logDirectory, filename), output);
    const counts = [
      ...output.matchAll(
        /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue\./g,
      ),
    ].at(-1);
    const result = {
      ...entry,
      code,
      signal,
      ok: evaluateResult(entry, code, output, signal),
      elapsedMs: Date.now() - started,
      generated: counts ? Number(counts[1]) : null,
      distinct: counts ? Number(counts[2]) : null,
      remaining: counts ? Number(counts[3]) : null,
      depth:
        Number(output.match(/The depth of the complete state graph search is (\d+)/)?.[1]) || null,
      log: `results/${filename}`,
      logSha256: sha256(output),
    };
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.expect}${entry.property ? ` ${entry.property}` : ''}; ${result.distinct ?? '?'} states, ${result.elapsedMs}ms`,
    );
    return result;
  } finally {
    rmSync(metadata, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--setup')) return setup();
  if (process.argv.includes('--check-evidence')) return checkEvidence();
  const jar = jarPath();
  if (!existsSync(jar))
    throw new Error(
      'TLC not installed. Run npm run verify:setup, or set TLA_TOOLS_JAR to the pinned jar.',
    );
  if (sha256(readFileSync(jar)) !== tool.sha256) throw new Error('TLC checksum mismatch');
  const workers = Number(process.env.TLC_WORKERS ?? 2);
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 8)
    throw new Error('TLC_WORKERS must be 1..8');
  const entries = JSON.parse(readFileSync(join(verification, 'cases.json'), 'utf8'));
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length)
    throw new Error('Duplicate verification case');
  const coverage = verifyCoverage();
  const hashes = sourceHashes();
  const contracts = runContracts();
  const results = [];
  const startedAt = new Date().toISOString();
  const logDirectory = join(verification, 'results');
  mkdirSync(logDirectory, { recursive: true });
  for (const entry of entries) {
    const result = await runCase(entry, jar, workers, logDirectory);
    results.push(result);
    if (!result.ok) break;
  }
  const unchanged = JSON.stringify(hashes) === JSON.stringify(sourceHashes());
  const passed =
    unchanged && results.length === entries.length && results.every((result) => result.ok);
  writeFileSync(join(logDirectory, 'contracts.json'), JSON.stringify(contracts, null, 2) + '\n');
  const report = {
    coverage,
    contractsSha256: sha256(JSON.stringify(contracts)),
    startedAt,
    finishedAt: new Date().toISOString(),
    passed,
    sourcesUnchanged: unchanged,
    tool,
    workers,
    jvmHeap: '2g',
    node: process.version,
    sourceHashes: hashes,
    results,
  };
  const temporary = join(logDirectory, 'summary.json.tmp');
  writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n');
  renameSync(temporary, join(logDirectory, 'summary.json'));
  if (!passed)
    throw new Error('Formal verification failed or sources changed; inspect verification/results');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
