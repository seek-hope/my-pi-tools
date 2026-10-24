// Runs as root INSIDE the disposable VM. Never invoke this on the host.
// Project code runs only in a separate, unprivileged container without the Docker socket.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startProxy } from './proxy.mjs';
import { stripVTControlCharacters } from 'node:util';

const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (
  request.version !== 1 ||
  !/^[a-f0-9-]{36}$/.test(request.runId) ||
  !/^sha256:[a-f0-9]{64}$/.test(request.imageId) ||
  !['readonly', 'ephemeral'].includes(request.workspace) ||
  typeof request.command !== 'string' ||
  !Number.isSafeInteger(request.timeoutMs) ||
  request.timeoutMs < 1000 ||
  request.timeoutMs > 3600000 ||
  !Number.isSafeInteger(request.outputBytes) ||
  request.outputBytes < 1024 ||
  request.outputBytes > 1000000 ||
  !Number.isSafeInteger(request.memoryMiB) ||
  request.memoryMiB < 512 ||
  request.memoryMiB > 65536 ||
  !Number.isSafeInteger(request.pids) ||
  request.pids < 16 ||
  request.pids > 4096 ||
  !Number.isSafeInteger(request.cpus) ||
  request.cpus < 1 ||
  request.cpus > 32
)
  throw new Error('Invalid goal runner request');

const variables = request.variables ?? {};
if (
  !variables ||
  typeof variables !== 'object' ||
  Array.isArray(variables) ||
  Object.keys(variables).length > 32 ||
  Object.entries(variables).some(
    ([name, value]) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      typeof value !== 'string' ||
      value.includes('\u0000') ||
      Buffer.byteLength(value) > 4096,
  )
)
  throw new Error('Invalid goal runner environment');

const base = `/tmp/${request.runId}`;
const volume = `goal-${randomUUID()}`;
const job = `goal-${randomUUID()}`;
const seed = `goal-${randomUUID()}`;
let createdVolume = false,
  createdJob = false,
  createdSeed = false;
let output = Buffer.alloc(0),
  outputBytes = 0;
const deadline = Date.now() + request.timeoutMs;
const docker = (args, { capture = false, cleanup = false, executable = 'docker' } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Do not let sandbox/project variables redirect the supervisor to a remote daemon.
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' },
    });
    let text = '',
      errorText = '',
      failure;
    const timer = setTimeout(
      () => {
        failure = new Error('Runner deadline exceeded');
        child.kill('SIGKILL');
      },
      cleanup ? 10000 : Math.max(1, deadline - Date.now()),
    );
    const collect = (data, stderr) => {
      if (capture) {
        outputBytes += data.length;
        output = Buffer.concat([output, data]).subarray(-request.outputBytes);
        if (outputBytes > request.outputBytes * 32) {
          failure = new Error('Check total output limit exceeded');
          child.kill('SIGKILL');
        }
      } else {
        if (text.length + errorText.length + data.length > 256000) {
          failure = new Error('Docker control output exceeded limit');
          child.kill('SIGKILL');
        } else if (stderr) errorText += data.toString();
        else text += data.toString();
      }
    };
    child.stdout.on('data', (data) => collect(data, false));
    child.stderr.on('data', (data) => collect(data, true));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, text, errorText });
    });
  });
const ok = async (args, options) => {
  const result = await docker(args, options);
  if (result.code !== 0)
    throw new Error(`Docker supervisor operation failed: ${result.errorText.slice(-1000)}`);
  return result.text;
};

let result,
  proxy,
  checkNetwork,
  bridge,
  proxyEnvironment = [],
  caMount = [];
try {
  // Template must include a functioning private Docker engine; never pull during a check.
  await ok(['load', '--input', `${base}/image.tar`]);
  const images = JSON.parse(await ok(['image', 'inspect', request.imageId]));
  if (images.length !== 1 || images[0].Id !== request.imageId)
    throw new Error('Check image identity mismatch');
  // Image-defined volumes would create writable or hidden paths outside our declared layout.
  if (Object.keys(images[0].Config?.Volumes ?? {}).length)
    throw new Error('Check image must not declare VOLUME');
  await ok(['volume', 'create', volume]);
  createdVolume = true;
  await ok([
    'create',
    '--name',
    seed,
    '--network',
    'none',
    '--user',
    '0:0',
    '--mount',
    `type=volume,src=${volume},dst=/workspace,volume-nocopy`,
    '--entrypoint',
    '/bin/chown',
    request.imageId,
    '-R',
    '1000:1000',
    '/workspace',
  ]);
  createdSeed = true;
  await ok(['cp', `${base}/input/.`, `${seed}:/workspace/`]);
  // Trusted image command only; no project code or image ENTRYPOINT is executed during setup.
  await ok(['start', '--attach', seed]);
  const seeded = JSON.parse(await ok(['inspect', seed]));
  if (seeded[0]?.State?.ExitCode !== 0) throw new Error('Cannot initialize check workspace');
  await ok(['rm', seed]);
  createdSeed = false;
  // Host snapshot files were sealed. Links were canonicalized to selected internal targets;
  // GNU chmod -R does not traverse symlinked directories encountered during recursion.
  if (request.workspace === 'ephemeral') {
    await ok([
      'create',
      '--name',
      seed,
      '--network',
      'none',
      '--user',
      '0:0',
      '--mount',
      `type=volume,src=${volume},dst=/workspace,volume-nocopy`,
      '--entrypoint',
      '/bin/chmod',
      request.imageId,
      '-R',
      'u+rwX',
      '/workspace',
    ]);
    createdSeed = true;
    await ok(['start', '--attach', seed]);
    const changed = JSON.parse(await ok(['inspect', seed]));
    if (changed[0]?.State?.ExitCode !== 0) throw new Error('Cannot prepare ephemeral workspace');
    await ok(['rm', seed]);
    createdSeed = false;
  }
  if (!['isolated', 'allowlist', 'open'].includes(request.network))
    throw new Error('Invalid network policy');
  if (request.network !== 'isolated') {
    // Only this VM's private network is changed. The check can reach the supervisor proxy,
    // but neither VM services nor direct egress; embedded Docker DNS forwards to loopback.
    checkNetwork = `goal-${randomUUID()}`;
    bridge = `g${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await ok([
      'network',
      'create',
      '--internal',
      '--opt',
      `com.docker.network.bridge.name=${bridge}`,
      checkNetwork,
    ]);
    const networkInfo = JSON.parse(await ok(['network', 'inspect', checkNetwork]));
    const gateway = networkInfo[0].IPAM.Config[0].Gateway;
    proxy = await startProxy(request, process.env.HTTP_PROXY ?? process.env.http_proxy);
    await ok(['-I', 'INPUT', '1', '-i', bridge, '-j', 'DROP'], { executable: 'iptables' });
    await ok(
      [
        '-I',
        'INPUT',
        '1',
        '-i',
        bridge,
        '-p',
        'tcp',
        '--dport',
        String(proxy.port),
        '-j',
        'ACCEPT',
      ],
      { executable: 'iptables' },
    );
    const url = `http://${gateway}:${proxy.port}`;
    proxyEnvironment = [
      `HTTP_PROXY=${url}`,
      `HTTPS_PROXY=${url}`,
      `http_proxy=${url}`,
      `https_proxy=${url}`,
      'NO_PROXY=localhost,127.0.0.1',
      'no_proxy=localhost,127.0.0.1',
    ];
    const caPath = process.env.NODE_EXTRA_CA_CERTS;
    if (!caPath || !caPath.startsWith('/'))
      throw new Error('Sandbox proxy CA certificate is missing');
    caMount = ['--mount', `type=bind,src=${caPath},dst=/etc/goal-proxy-ca.pem,readonly`];
    proxyEnvironment.push(
      'NODE_EXTRA_CA_CERTS=/etc/goal-proxy-ca.pem',
      'SSL_CERT_FILE=/etc/goal-proxy-ca.pem',
      'REQUESTS_CA_BUNDLE=/etc/goal-proxy-ca.pem',
      'NPM_CONFIG_CAFILE=/etc/goal-proxy-ca.pem',
    );
  }
  await ok([
    'create',
    '--name',
    job,
    '--network',
    checkNetwork ?? 'none',
    ...(checkNetwork ? ['--dns', '127.0.0.1'] : []),
    ...caMount,
    '--user',
    '1000:1000',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(request.pids),
    '--memory',
    `${request.memoryMiB}m`,
    '--memory-swap',
    `${request.memoryMiB}m`,
    '--cpus',
    String(request.cpus),
    '--log-driver',
    'none',
    '--ulimit',
    'core=0',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs',
    '/run:rw,nosuid,nodev,size=16m,mode=1777',
    '--mount',
    `type=volume,src=${volume},dst=/workspace,volume-nocopy${request.workspace === 'readonly' ? ',readonly' : ''}`,
    '--workdir',
    '/workspace',
    '--entrypoint',
    '/usr/bin/env',
    request.imageId,
    '-i',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/tmp',
    'TMPDIR=/tmp',
    'LANG=C.UTF-8',
    ...Object.entries(request.variables ?? {}).map(([name, value]) => `${name}=${value}`),
    ...proxyEnvironment,
    '/bin/bash',
    '--noprofile',
    '--norc',
    '-c',
    request.command,
  ]);
  createdJob = true;
  // start --attach's status is not trusted as the command exit code; inspect the actual container.
  await docker(['start', '--attach', job], { capture: true });
  const rows = JSON.parse(await ok(['inspect', job]));
  const state = rows[0]?.State;
  if (
    !state ||
    state.Running ||
    !Number.isInteger(state.ExitCode) ||
    state.StartedAt.startsWith('0001')
  )
    throw new Error('Check has no final container exit status');
  if (state.OOMKilled) throw new Error('Check exceeded its memory limit');
  result = {
    version: 1,
    runId: request.runId,
    kind: 'check',
    exitCode: state.ExitCode,
    output: stripVTControlCharacters(output.toString('utf8')),
    truncated: outputBytes > request.outputBytes,
  };
} catch (error) {
  result = { version: 1, runId: request.runId, kind: 'environment', message: String(error) };
} finally {
  try {
    if (createdJob) await ok(['rm', '--force', job], { cleanup: true });
    if (createdSeed) await ok(['rm', '--force', seed], { cleanup: true });
    if (createdVolume) await ok(['volume', 'rm', volume], { cleanup: true });
    await proxy?.close();
    if (bridge && proxy) {
      await ok(
        ['-D', 'INPUT', '-i', bridge, '-p', 'tcp', '--dport', String(proxy.port), '-j', 'ACCEPT'],
        { executable: 'iptables', cleanup: true },
      );
      await ok(['-D', 'INPUT', '-i', bridge, '-j', 'DROP'], {
        executable: 'iptables',
        cleanup: true,
      });
    }
    if (checkNetwork) await ok(['network', 'rm', checkNetwork], { cleanup: true });
  } catch (error) {
    result = {
      version: 1,
      runId: request.runId,
      kind: 'environment',
      message: `Inner cleanup failed: ${String(error)}`,
    };
  }
}
process.stdout.write(JSON.stringify(result));
