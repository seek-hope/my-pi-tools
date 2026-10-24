import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { LeaseStore } from '../src/verification/leases.ts';
import { fixture } from './sandbox-fixtures.mjs';

test(
  'watchdog removes the exact leased VM after its parent exits without cleanup',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { root, settings } = await fixture(t);
    const store = new LeaseStore(join(root, 'leases'));
    const name = `goal-${randomUUID()}`;
    const statePath = join(root, 'fake-vms.json');
    const markerPath = join(root, 'removed');
    await writeFile(statePath, JSON.stringify([{ name, id: 'exact-vm-id' }]));
    const executable = join(root, 'sbx-fixture.mjs');
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const state = ${JSON.stringify(statePath)}, marker = ${JSON.stringify(markerPath)};
if (process.argv[2] === 'ls') process.stdout.write(readFileSync(state));
if (process.argv[2] === 'rm') { writeFileSync(state, '[]'); writeFileSync(marker, process.argv.at(-1)); }
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    await store.save({
      version: 1,
      name,
      id: 'exact-vm-id',
      createdAt: new Date().toISOString(),
      pid: process.pid,
      host: hostname(),
      phase: 'running',
    });
    const source = `import {startWatchdog} from ${JSON.stringify(new URL('../src/verification/watchdog.ts', import.meta.url).href)};
await startWatchdog(${JSON.stringify(store.root)}, ${JSON.stringify(name)}, ${JSON.stringify({ ...settings, executable })});
process.exit(0);`;
    const parent = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', source],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    parent.stderr.on('data', (data) => (stderr += data));
    await new Promise((resolve, reject) => {
      parent.once('error', reject);
      parent.once('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });
    let removed = false;
    for (let i = 0; i < 120; i++) {
      try {
        await access(markerPath);
        removed = true;
        break;
      } catch {
        await delay(25);
      }
    }
    assert.equal(removed, true, 'parent loss must trigger independent cleanup');
    assert.equal(await readFile(markerPath, 'utf8'), name);
    // Wait for the removal confirmation and final durable lease deletion.
    for (let i = 0; i < 120 && (await store.list()).length; i++) await delay(25);
    assert.deepEqual(await store.list(), []);
  },
);
