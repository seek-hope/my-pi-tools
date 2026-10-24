// Independent local watchdog. No project code or goal-state writes in this process.
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { LeaseStore, disposeSandbox } from './leases.ts';
import { commandRunner } from './process.ts';

const [root, name, executable, timeoutText, cleanupText] = process.argv.slice(2);
const timeoutMs = Number(timeoutText),
  cleanupMs = Number(cleanupText);
if (
  !root ||
  !/^goal-[a-f0-9-]{36}$/.test(name) ||
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs < 1000 ||
  !Number.isSafeInteger(cleanupMs) ||
  cleanupMs < 1000
)
  process.exit(2);
const store = new LeaseStore(root);
let cleaning = false;
async function clean() {
  if (cleaning) return;
  cleaning = true;
  clearTimeout(timer);
  try {
    const lease = JSON.parse(await readFile(store.path(name), 'utf8'));
    if (lease.version !== 1 || lease.name !== name || lease.host !== hostname())
      throw new Error('Invalid watchdog lease');
    await disposeSandbox(lease, store, commandRunner(executable), cleanupMs);
  } catch {
    // The durable intent/cleanup_pending lease remains for explicit recovery.
  } finally {
    process.exit(0);
  }
}
const timer = setTimeout(clean, timeoutMs);
process.on('disconnect', clean);
process.on('message', (message) => {
  if (message === 'done') {
    clearTimeout(timer);
    process.exit(0);
  }
  if (message === 'cleanup') void clean();
});
process.send?.('ready');
