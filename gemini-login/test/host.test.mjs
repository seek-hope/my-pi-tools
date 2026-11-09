import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import geminiLogin, { createGeminiProvider } from '../src/index.ts';
import { auth, frame, response } from './fixtures.mjs';

test('extension registers a native provider with no login side effects', () => {
  const providers = [];
  geminiLogin({ registerProvider: (provider) => providers.push(provider) });
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'gemini-login');
  assert.equal(typeof providers[0].streamSimple, 'function');
  assert.equal(typeof providers[0].auth.oauth.login, 'function');
});

test('native extension loader resolves Pi public subpaths', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-gemini-load-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, 'agent'),
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
});

for (const viaCodemode of [false, true])
  test(
    `real Pi session: Gemini calls ${viaCodemode ? 'codemode → read' : 'read'} and completes the next model turn`,
    { timeout: 15000 },
    async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), 'pi-gemini-login-'));
      const agentDir = join(cwd, 'agent');
      let session,
        calls = 0;
      t.after(async () => {
        if (session) {
          await session.abort();
          session.dispose();
        }
        await rm(cwd, { recursive: true, force: true });
      });
      await writeFile(join(cwd, 'sample.txt'), 'Verified 中文 content');
      const credentials = new InMemoryCredentialStore();
      await credentials.modify('gemini-login', async () => auth);
      const runtime = await ModelRuntime.create({
        credentials,
        modelsPath: null,
        modelsStorePath: join(agentDir, 'models.json'),
        refreshOnCreate: false,
      });
      const provider = createGeminiProvider({
        fetch: async (_url, init) => {
          const request = JSON.parse(init.body);
          calls++;
          assert.ok(calls <= 2, 'unexpected extra model request');
          assert.equal(init.headers.get('Authorization'), `Bearer ${auth.access}`);
          if (calls === 1) {
            assert.match(JSON.stringify(request.request.tools), viaCodemode ? /codemode/ : /read/);
            return response([
              frame(
                [
                  {
                    functionCall: {
                      name: viaCodemode ? 'codemode' : 'read',
                      args: viaCodemode
                        ? { code: "text(await tools.read({path: 'sample.txt'}))" }
                        : { path: 'sample.txt' },
                    },
                    thoughtSignature: 'c2lnbmF0dXJl',
                  },
                ],
                'STOP',
              ),
            ]);
          }
          assert.match(JSON.stringify(request), /Verified 中文 content/);
          assert.match(JSON.stringify(request), /c2lnbmF0dXJl/);
          return response([frame([{ text: 'Verified successfully' }], 'STOP')]);
        },
      });
      runtime.registerNativeProvider(provider);
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        telemetry: { enabled: false },
        defaultTools: ['read', ...(viaCodemode ? ['codemode'] : [])],
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => 'Read sample.txt and answer.',
        extensionFactories: [
          ...(viaCodemode ? [createCodemodeExtension({ mode: 'on' })] : []),
          (pi) => pi.registerProvider(provider),
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model: runtime.getModel('gemini-login', 'gemini-3.1-pro-preview'),
        thinkingLevel: 'low',
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(cwd),
      }));
      const errors = [];
      await session.bindExtensions({ mode: 'json', onError: (error) => errors.push(error) });
      await session.prompt('Please inspect sample.txt');
      assert.equal(calls, 2);
      assert.deepEqual(errors, []);
      const answer = session.messages.filter((message) => message.role === 'assistant').at(-1);
      assert.equal(answer.stopReason, 'stop');
      assert.equal(answer.content[0].text, 'Verified successfully');
    },
  );
