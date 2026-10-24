import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sandboxSettings } from '../src/verification/contract.ts';
import { DockerSandboxes } from '../src/verification/docker-sandboxes.ts';
import { prepareVerification } from '../src/verification/pipeline.ts';
import { requireSuccess } from '../src/verification/process.ts';
import { sourceHashes } from './verification-sources.mjs';

const [mode, file, startText = '0'] = process.argv.slice(2);
if (!['--doctor', '--run'].includes(mode) || !file)
  throw new Error(
    'Usage: node scripts/check-sandbox.mjs --doctor|--run /absolute/personal/my-pi-goal.json [startIndex]',
  );
const settings = sandboxSettings(JSON.parse(await readFile(resolve(file), 'utf8')).sandbox);
if (!settings) throw new Error('No sandbox profile configured');
const leaseRoot = join(dirname(resolve(file)), 'goal-sandboxes');
const backend = new DockerSandboxes(settings, leaseRoot);
await backend.doctor();
console.log('PASS: sbx control preflight');
if (mode === '--run') {
  const root = await mkdtemp(join(tmpdir(), 'goal-sbx-acceptance-'));
  try {
    const cwd = join(root, 'project');
    await mkdir(cwd);
    await writeFile(join(cwd, 'input.txt'), 'frozen');
    const outside = join(root, 'host-secret.txt');
    await writeFile(outside, 'must not cross the VM boundary');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const node = (code) => `node -e ${quote(code)}`;
    const request = (host, status) =>
      node(
        `const http=require('http'); const p=new URL(process.env.HTTP_PROXY); const r=http.get({hostname:p.hostname,port:p.port,path:'http://${host}/'},s=>{s.resume();s.on('end',()=>process.exit(s.statusCode===${status}?0:1))});r.on('error',e=>{console.error(e);process.exit(2)});r.setTimeout(15000,()=>{r.destroy();process.exit(3)});`,
      );
    const cases = [
      { name: 'readonly denies writes', command: 'echo changed > input.txt', fails: true },
      {
        name: 'ephemeral writes never affect host',
        workspace: 'ephemeral',
        command: 'echo changed > input.txt && test "$(cat input.txt)" = changed',
      },
      {
        name: 'host file, sockets and credentials absent',
        command: `test ! -e ${quote(outside)} && test ! -e /var/run/docker.sock && test -z "$SSH_AUTH_SOCK$MCP_GATEWAY_URL$OPENAI_API_KEY$ANTHROPIC_API_KEY" && test "$(id -u)" = 1000 && ! sudo -n true`,
      },
      {
        name: 'offline has no external TCP route',
        command: node(
          "const s=require('net').connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),2000)",
        ),
      },
      {
        name: 'allowlist permits HTTPS npm download with trusted CA',
        network: 'allowlist',
        allow: ['registry.npmjs.org:443'],
        command: 'npm view is-number@7.0.0 version --fetch-retries=0 --fetch-timeout=15000',
      },
      {
        name: 'allowlist blocks unrelated domain',
        network: 'allowlist',
        allow: ['example.com'],
        command: request('example.org', 403),
      },
      { name: 'open permits public HTTP', network: 'open', command: request('example.com', 200) },
      {
        name: 'deny takes precedence in open mode',
        network: 'open',
        deny: ['example.com'],
        command: `${request('example.com', 403)} && ${request('example.com.', 403)}`,
      },
      {
        name: 'online cannot bypass proxy using direct TCP or VM services',
        network: 'open',
        command: node(
          "const net=require('net');const host=new URL(process.env.HTTP_PROXY).hostname;let count=0;for(const [h,p] of [['1.1.1.1',443],[host,2375],[host,80]]){const s=net.connect({host:h,port:p});s.on('connect',()=>process.exit(1));s.on('error',()=>{if(++count===3)process.exit(0)})}setTimeout(()=>process.exit(0),2000)",
        ),
      },
      {
        name: 'online DNS cannot bypass proxy',
        network: 'open',
        command: node(
          "require('dns').resolve4('example.com',(e,a)=>process.exit(e?0:1));setTimeout(()=>process.exit(0),2000)",
        ),
      },
      {
        name: 'check stdout cannot forge supervisor success',
        command: 'printf \'{"version":1,"kind":"check","exitCode":0}\'; exit 7',
        fails: true,
        exitCode: 7,
      },
      { name: 'cancellation removes running VM', command: 'sleep 60 & wait', cancel: true },
      {
        name: 'output flood is bounded and cleaned',
        command: `node -e '(async()=>{const {once}=require("node:events");for(;;)if(!process.stdout.write("x".repeat(65536)))await once(process.stdout,"drain")})()'`,
        error: /output limit/,
      },
      {
        name: 'runner deadline failure cleans VM',
        command: 'sleep 60 & wait',
        timeout: 2000,
        error: /deadline/i,
      },
    ];
    const startIndex = Number(startText);
    if (!Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex >= cases.length)
      throw new Error('Invalid acceptance start index');
    const receipt = {
      startIndex,
      at: new Date().toISOString(),
      platform: process.platform,
      cliVersion: requireSuccess(
        await backend.run(['version'], { timeoutMs: 15000 }),
        'sbx version',
      ).trim(),
      sourceHashes: sourceHashes(),
      cases: [],
      settings: {
        template: settings.template,
        imageId: settings.imageId,
        imageArchiveSha256: settings.imageArchiveSha256,
      },
    };
    const receiptPath = join(
      dirname(resolve(file)),
      startIndex ? `acceptance-results-from-${startIndex}.json` : 'acceptance-results.json',
    );
    const saveReceipt = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    for (const entry of cases.slice(startIndex)) {
      const check = { id: 'K1', command: entry.command };
      const goal = {
        objective: entry.name,
        kind: 'coding',
        criteria: [],
        tasks: [],
        checks: [check],
        verification: {
          workspace: entry.workspace ?? 'readonly',
          network: entry.network ?? 'isolated',
          allow: entry.allow ?? [],
          deny: entry.deny ?? [],
          env: [],
        },
      };
      const context = await prepareVerification(
        cwd,
        goal,
        { ...settings, ...(entry.timeout ? { checkTimeoutMs: entry.timeout } : {}) },
        leaseRoot,
      );
      const abort = new AbortController();
      let timer,
        cancellationDeadline,
        observedRunning = false;
      try {
        // Wait for the supervisor exec phase, not just VM creation, before cancelling.
        if (entry.cancel) {
          timer = setInterval(async () => {
            try {
              const leases = await backend.leases.list();
              for (const lease of leases) {
                if (lease.phase !== 'running') continue;
                const result = await backend.run(
                  ['exec', lease.name, '--', 'pgrep', '-f', 'sleep 60'],
                  { timeoutMs: 3000 },
                );
                if (result.code === 0) {
                  observedRunning = true;
                  clearInterval(timer);
                  abort.abort();
                }
              }
            } catch {
              /* retry until execution starts */
            }
          }, 1000);
          cancellationDeadline = setTimeout(() => abort.abort(), 90000);
          cancellationDeadline.unref();
        }
        if (entry.cancel || entry.error) {
          await assert.rejects(context.check(check, abort.signal), entry.error ?? /cancelled/);
          if (entry.cancel)
            assert.equal(observedRunning, true, 'Cancellation must observe the running check');
        } else {
          const result = await context.check(check);
          assert.equal(
            entry.fails ? result.exitCode !== 0 : result.exitCode === 0,
            true,
            result.output,
          );
          if (entry.exitCode) assert.equal(result.exitCode, entry.exitCode);
          if (!entry.fails) await context.finish(true);
        }
      } finally {
        clearInterval(timer);
        clearTimeout(cancellationDeadline);
        await context.finish(false).catch((error) => {
          if (
            error.kind === 'cleanup' ||
            !(entry.cancel || entry.error || (entry.fails && error.kind === 'environment'))
          )
            throw error;
        });
      }
      assert.equal(await readFile(join(cwd, 'input.txt'), 'utf8'), 'frozen');
      assert.equal((await backend.leases.list()).length, 0, 'No sandbox leases may remain');
      receipt.cases.push({ name: entry.name, passed: true });
      await saveReceipt();
      console.log(`PASS: ${entry.name}`);
    }
    assert.deepEqual(
      sourceHashes(),
      receipt.sourceHashes,
      'Acceptance sources changed during the run',
    );
    receipt.completedAt = new Date().toISOString();
    receipt.passed = true;
    await saveReceipt();
    console.log(
      `PASS: real microVM acceptance cases ${startIndex + 1}..${cases.length}; bounded cases only, not a general isolation proof.`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
