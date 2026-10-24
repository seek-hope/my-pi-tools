import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager, VERSION } from '@earendil-works/pi-coding-agent';
import { assertSupportedPi } from '../src/compatibility.ts';

// --list-models can exit successfully even when an extension factory failed.
// Inspect the public loader's results and actual registrations instead.
export async function checkExtensionLoad({
  entry = fileURLToPath(new URL('../extensions/index.ts', import.meta.url)),
  expectedVersion = VERSION,
} = {}) {
  assertSupportedPi(expectedVersion);
  if (VERSION !== expectedVersion)
    throw new Error(
      `Pi CLI is ${expectedVersion}, but workspace libraries are ${VERSION}; run npm run dev:link-host`,
    );
  const cwd = mkdtempSync(join(tmpdir(), 'goal-load-check-'));
  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [resolve(entry)],
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    if (errors.length) throw new Error(JSON.stringify(errors));
    if (extensions.length !== 1) throw new Error('Expected exactly one Goal extension');
    const extension = extensions[0];
    const tools = [
      'goal_status',
      'goal_evidence',
      'goal_create',
      'goal_resume',
      'goal_plan',
      'goal_check',
      'goal_reply',
      'goal_progress',
      'goal_wait',
      'goal_submit',
    ];
    if (!extension.commands.has('goal') || tools.some((name) => !extension.tools.has(name)))
      throw new Error('Goal command or tools were not registered');
    return { version: VERSION, tools, command: 'goal' };
  } finally {
    // No session was started, so there are no timers, real journals or model calls.
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const expectedVersion = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
    const result = await checkExtensionLoad({ expectedVersion });
    console.log(
      `PASS Pi ${result.version}: Goal entry loaded; /goal and ${result.tools.length} tools registered`,
    );
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
