import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { controlEnvironment } from './process.ts';
import { SandboxError, type SandboxSettings } from './contract.ts';

export async function startWatchdog(
  root: string,
  name: string,
  settings: SandboxSettings,
): Promise<(cleaned: boolean) => void> {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./watchdog.mjs', import.meta.url)),
      root,
      name,
      settings.executable,
      String(settings.provisionTimeoutMs + settings.checkTimeoutMs + 90_000),
      String(settings.cleanupTimeoutMs),
    ],
    {
      detached: process.platform !== 'win32',
      env: controlEnvironment(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new SandboxError('Sandbox watchdog did not start'));
    }, 5000);
    const error = (cause: Error) => {
      clearTimeout(timer);
      reject(new SandboxError(`Cannot start sandbox watchdog: ${cause.message}`));
    };
    child.once('error', error);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new SandboxError('Sandbox watchdog exited before readiness'));
    });
    child.once('message', (message) => {
      clearTimeout(timer);
      if (message !== 'ready') {
        child.kill();
        reject(new SandboxError('Invalid watchdog handshake'));
      } else resolve();
    });
  });
  child.unref();
  child.channel?.unref();
  return (cleaned: boolean) => {
    if (child.connected) child.send(cleaned ? 'done' : 'cleanup', () => {});
  };
}
