import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Conversation } from '../src/conversation.ts';

export const agentPath = fileURLToPath(new URL('./fixture-agent.mjs', import.meta.url));
export async function until(condition, message = 'condition', timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export async function fixture(t, scenario = 'normal', cancelMs = 100) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-test-'));
  const remembered = [];
  const conversation = new Conversation(
    cwd,
    {
      command: process.execPath,
      args: [agentPath],
      env: {
        ACP_TEST_SCENARIO: scenario,
        GEMINI_API_KEY: 'must-not-pass',
        GOOGLE_API_KEY: 'must-not-pass',
      },
      stopMs: 100,
    },
    (id) => remembered.push(id),
    cancelMs,
  );
  t.after(async () => {
    await conversation.close();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, conversation, remembered };
}
