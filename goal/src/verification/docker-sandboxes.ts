import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { SandboxError, type SandboxSettings, type VerificationIdentity } from './contract.ts';
import { commandRunner, requireSuccess, type CommandRunner } from './process.ts';
import { disposeSandbox, LeaseStore, ownerAlive, parseSandboxList, type Lease } from './leases.ts';
import type { Snapshot } from './snapshot.ts';
import type { Check, CheckResult } from '../state.ts';
import type { VerificationEnvironment } from '../checks.ts';
import { environmentSignature, normalizeVerification, verificationVariables } from '../checks.ts';
import { startWatchdog } from './watchdog.ts';

export const SBX_VERSIONS = ['0.48.0', '0.49.2'];
export class DockerSandboxes {
  readonly run: CommandRunner;
  readonly leases: LeaseStore;
  private readonly watch: boolean;
  readonly settings: SandboxSettings;
  constructor(settings: SandboxSettings, stateDirectory: string, run?: CommandRunner) {
    this.settings = settings;
    this.watch = !run; // Injected transports are used only in isolated unit tests.
    this.run = run ?? commandRunner(settings.executable);
    this.leases = new LeaseStore(stateDirectory);
  }
  async doctor(signal?: AbortSignal): Promise<void> {
    const options = { timeoutMs: 15_000, signal };
    const version = requireSuccess(await this.run(['version'], options), 'sbx version');
    // Only explicitly reviewed CLI contracts; no daemon restarts or global settings changes.
    if (
      !SBX_VERSIONS.some((versionNumber) =>
        new RegExp(`^sbx version v?${versionNumber.replaceAll('.', '\\.')}(?: |$)`).test(
          version.trim(),
        ),
      )
    )
      throw new SandboxError(`This backend requires sbx ${SBX_VERSIONS.join(' or ')}`);
    // The trusted supervisor sees the template environment; project containers receive neither
    // host sockets nor integration credentials. Online access is limited to the VM proxy.

    parseSandboxList(requireSuccess(await this.run(['ls', '--json'], options), 'sbx ls'));
    const pending = (await this.leases.list()).filter(
      (lease) => lease.phase === 'cleanup_pending' || !ownerAlive(lease),
    );
    if (pending.length)
      throw new SandboxError(
        `Unreconciled sandbox leases: ${pending.map((x) => x.name).join(', ')}. Run /goal sandbox cleanup.`,
        'cleanup',
      );
  }
  validateEnvironment(environment: VerificationEnvironment) {
    if (!['isolated', 'allowlist', 'open'].includes(environment.network))
      throw new SandboxError('Unsupported verification network policy');
    normalizeVerification(environment);
    if (environment.env.length)
      throw new SandboxError(
        'Docker Sandboxes v1 does not pass host variables. Bake toolchains and non-secret defaults into the pinned check image.',
      );
  }
  async recover() {
    const recovered: string[] = [];
    for (const lease of await this.leases.list()) {
      if (lease.host !== hostname() || (ownerAlive(lease) && lease.phase !== 'cleanup_pending'))
        continue;
      // A different live process may still be cleaning; do not race it.
      if (ownerAlive(lease) && lease.pid !== process.pid) continue;
      await disposeSandbox(lease, this.leases, this.run, this.settings.cleanupTimeoutMs);
      recovered.push(lease.name);
    }
    return recovered;
  }
  async check(
    snapshot: Snapshot,
    controlRoot: string,
    check: Check,
    environment: VerificationEnvironment,
    identity: VerificationIdentity,
    signal?: AbortSignal,
  ): Promise<CheckResult> {
    this.validateEnvironment(environment);
    await this.doctor(signal);
    signal?.throwIfAborted();
    const runId = randomUUID();
    const name = `goal-${runId}`;
    const lease: Lease = {
      version: 1,
      name,
      createdAt: new Date().toISOString(),
      pid: process.pid,
      host: hostname(),
      phase: 'creating',
    };
    const base = `/tmp/${runId}`;
    const options = {
      timeoutMs: this.settings.provisionTimeoutMs,
      signal: AbortSignal.any([
        AbortSignal.timeout(this.settings.provisionTimeoutMs),
        ...(signal ? [signal] : []),
      ]),
    };
    const requestPath = join(controlRoot, `${runId}.json`);
    await writeFile(
      requestPath,
      JSON.stringify({
        version: 1,
        runId,
        imageId: this.settings.imageId,
        command: check.command,
        workspace: environment.workspace,
        network: environment.network,
        allow: environment.allow ?? [],
        deny: environment.deny ?? [],
        variables: verificationVariables(environment.variables),
        timeoutMs: this.settings.checkTimeoutMs,
        outputBytes: this.settings.outputBytes,
        memoryMiB: this.settings.memoryMiB,
        cpus: this.settings.cpus,
        pids: this.settings.pids,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const watchdog = this.watch
      ? await startWatchdog(this.leases.root, name, this.settings)
      : undefined;
    try {
      await this.leases.save(lease);
    } catch (error) {
      // Intent exists before the daemon can create anything.
      watchdog?.(true);
      throw error;
    }
    let cleaned = false;
    try {
      requireSuccess(
        await this.run(
          [
            'create',
            '--name',
            name,
            '--skills',
            'off',
            '--deny-network',
            '**',
            '--cpus',
            String(this.settings.cpus),
            '--memory',
            `${this.settings.memoryMiB}m`,
            '--template',
            this.settings.template,
            'shell',
          ],
          { ...options, cwd: controlRoot },
        ),
        'sbx create',
      );
      const rows = parseSandboxList(
        requireSuccess(await this.run(['ls', '--json'], options), 'sbx ls'),
      );
      const created = rows.find((row) => row.name === name);
      if (!created) throw new SandboxError('Created sandbox is missing from sbx ls');
      lease.id = created.id;
      lease.phase = 'running';
      await this.leases.save(lease);
      if (environment.network !== 'isolated') {
        const policy = JSON.parse(
          requireSuccess(
            await this.run(['policy', 'ls', name, '--type', 'network', '--json'], options),
            'read sandbox egress gate',
          ),
        );
        const gate = policy.rules?.find(
          (rule: { id: string; decision: string; resources: string[]; scope: string }) =>
            rule.scope === `sandbox:${name}` &&
            rule.decision === 'deny' &&
            rule.resources?.length === 1 &&
            rule.resources[0] === '**',
        );
        if (!gate || typeof gate.id !== 'string')
          throw new SandboxError('Cannot identify sandbox egress gate');
        const removeGate = async () =>
          requireSuccess(
            await this.run(
              ['policy', 'rm', 'network', '--sandbox', name, '--id', gate.id, '--force'],
              options,
            ),
            'open sandbox egress gate',
          );
        // sbx rejects allow ** while deny ** exists. No project code has been transferred or
        // started yet; the trusted template may have egress while the remaining rules install.
        if (environment.network === 'open') await removeGate();
        for (const destination of environment.network === 'open'
          ? ['**']
          : (environment.allow ?? []).filter(
              (destination) => !environment.deny?.includes(destination),
            )) {
          requireSuccess(
            await this.run(['policy', 'allow', 'network', '--sandbox', name, destination], options),
            'grant sandbox egress',
          );
        }
        for (const destination of environment.deny ?? []) {
          requireSuccess(
            await this.run(['policy', 'deny', 'network', '--sandbox', name, destination], options),
            'deny sandbox egress',
          );
        }
        // The inner proxy also enforces the goal policy when global/kit rules are broader.
        if (environment.network !== 'open') await removeGate();
      }
      requireSuccess(
        await this.run(['exec', name, '--', '/bin/mkdir', '-m', '700', base], options),
        'prepare control directory',
      );
      // cp has no archive extraction on the host. Source and destination are both explicit.
      const runner = join(controlRoot, 'runner.mjs');
      await writeFile(runner, await readFile(new URL('./runner.mjs', import.meta.url)), {
        mode: 0o600,
      });
      const proxy = join(controlRoot, 'proxy.mjs');
      await writeFile(proxy, await readFile(new URL('./proxy.mjs', import.meta.url)), {
        mode: 0o600,
      });
      for (const [source, target] of [
        [runner, `${base}/runner.mjs`],
        [proxy, `${base}/proxy.mjs`],
        [requestPath, `${base}/request.json`],
        [join(controlRoot, 'image.tar'), `${base}/image.tar`],
        [snapshot.root, `${base}/input`],
      ]) {
        requireSuccess(await this.run(['cp', source, `${name}:${target}`], options), 'sbx cp');
      }
      // sbx cp transfers as the sandbox user. Seal staging only after transfer,
      // before any project code runs; the root supervisor remains outside the check container.
      requireSuccess(
        await this.run(
          ['exec', '--user', 'root', name, '--', '/bin/chown', '-R', '0:0', base],
          options,
        ),
        'seal control ownership',
      );
      requireSuccess(
        await this.run(['exec', '--user', 'root', name, '--', '/bin/chmod', '700', base], options),
        'seal control permissions',
      );
      const text = requireSuccess(
        await this.run(
          [
            'exec',
            '--user',
            'root',
            name,
            '--',
            'node',
            `${base}/runner.mjs`,
            `${base}/request.json`,
          ],
          {
            signal,
            timeoutMs: this.settings.checkTimeoutMs + 45_000,
            maxBytes: this.settings.outputBytes * 6 + 16_000,
          },
        ),
        'sbx exec supervisor',
      );
      const result = JSON.parse(text);
      if (result.version !== 1 || result.runId !== runId)
        throw new SandboxError('Invalid supervisor response identity');
      if (result.kind === 'environment')
        throw new SandboxError(`Sandbox runner: ${String(result.message).slice(0, 2000)}`);
      if (
        result.kind !== 'check' ||
        !Number.isInteger(result.exitCode) ||
        result.exitCode < 0 ||
        result.exitCode > 255 ||
        typeof result.output !== 'string' ||
        Buffer.byteLength(result.output) > this.settings.outputBytes * 3 ||
        typeof result.truncated !== 'boolean'
      )
        throw new SandboxError('Invalid supervisor result');
      const hint =
        result.exitCode === 0
          ? undefined
          : environmentSignature(result.output, environment, result.exitCode);
      return {
        ...(hint ? { failure: 'environment' as const, hint } : {}),
        at: new Date().toISOString(),
        command: check.command,
        exitCode: result.exitCode,
        output:
          stripVTControlCharacters(result.output) +
          (result.truncated ? '\n[Output truncated]' : ''),
        environmentKey: identity.environmentDigest,
        verification: identity,
      };
    } finally {
      // A failed create with no known ID is retained for explicit reconciliation, never guessed.
      try {
        await disposeSandbox(lease, this.leases, this.run, this.settings.cleanupTimeoutMs);
        cleaned = true;
      } finally {
        watchdog?.(cleaned);
      }
    }
  }
}
