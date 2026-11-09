import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createGeminiProvider } from '../src/index.ts';
import { createOAuth, setupProject, REDIRECT_URI } from '../src/auth.ts';
import { TOKEN_URL, BASE_URL } from '../src/http.ts';
import { auth, json } from './fixtures.mjs';

function interaction() {
  const notifications = [];
  return {
    notifications,
    signal: new AbortController().signal,
    notify: (event) => notifications.push(event),
    prompt: async () => 'PRIVATE_AUTHORIZATION_CODE',
  };
}

test('native /login uses PKCE, resolves the paid project and stores credentials through Pi', async () => {
  const ui = interaction();
  const requests = [];
  const provider = createGeminiProvider({
    fetch: async (url, init) => {
      requests.push(url);
      assert.equal(init.redirect, 'error');
      if (url === TOKEN_URL) {
        const fields = new URLSearchParams(init.body);
        const login = new URL(ui.notifications.find((event) => event.type === 'auth_url').url);
        assert.equal(login.origin, 'https://accounts.google.com');
        assert.equal(login.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(
          login.searchParams.get('code_challenge'),
          createHash('sha256').update(fields.get('code_verifier')).digest('base64url'),
        );
        assert.equal(fields.get('code'), 'PRIVATE_AUTHORIZATION_CODE');
        assert.equal(fields.get('redirect_uri'), REDIRECT_URI);
        return json({ access_token: auth.access, refresh_token: auth.refresh, expires_in: 3600 });
      }
      assert.equal(url, `${BASE_URL}:loadCodeAssist`);
      assert.equal(init.headers.Authorization, `Bearer ${auth.access}`);
      return json({
        currentTier: { id: 'standard-tier' },
        paidTier: { id: 'google-one-pro' },
        cloudaicompanionProject: 'managed-project',
      });
    },
  });
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(provider);
  assert.equal((await models.getAvailable('gemini-login')).length, 0);
  const result = await models.login('gemini-login', 'oauth', ui);
  assert.equal(result.projectId, 'managed-project');
  assert.equal(result.tier, 'google-one-pro');
  assert.equal((await credentials.read('gemini-login')).refresh, auth.refresh);
  assert.equal((await models.getAvailable('gemini-login')).length, 4);
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(ui.notifications), /PRIVATE_(ACCESS|REFRESH|AUTHORIZATION)/);
  const resolved = await models.getAuth('gemini-login');
  assert.deepEqual(JSON.parse(resolved.auth.apiKey), {
    access: auth.access,
    projectId: 'managed-project',
  });
  await models.logout('gemini-login');
  assert.equal(await credentials.read('gemini-login'), undefined);
});

test('native refresh is serialized and retains project and unrotated refresh token', async () => {
  let count = 0;
  const provider = createGeminiProvider({
    fetch: async (url, init) => {
      count++;
      assert.equal(url, TOKEN_URL);
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), auth.refresh);
      return json({ access_token: 'NEW_ACCESS', expires_in: 3600 });
    },
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider.id, async () => ({ ...auth, expires: 0 }));
  const models = createModels({ credentials });
  models.setProvider(provider);
  const results = await Promise.all([models.getAuth(provider.id), models.getAuth(provider.id)]);
  assert.equal(count, 1);
  for (const result of results)
    assert.equal(JSON.parse(result.auth.apiKey).projectId, auth.projectId);
  const stored = await credentials.read(provider.id);
  assert.equal(stored.refresh, auth.refresh);
  assert.equal(stored.access, 'NEW_ACCESS');
});

test('first login onboards only the offered default tier and polls the returned operation', async () => {
  const requests = [];
  const result = await setupProject(
    auth.access,
    {
      projectId: 'explicit-project',
      pollMs: 1,
      fetch: async (url, init) => {
        requests.push(url);
        if (url.endsWith(':loadCodeAssist'))
          return json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] });
        if (url.endsWith(':onboardUser')) {
          const body = JSON.parse(init.body);
          assert.equal(body.cloudaicompanionProject, undefined);
          assert.equal(body.metadata.duetProject, undefined);
          assert.equal(body.tierId, 'free-tier');
          return json({ name: 'operations/onboarding-1' });
        }
        assert.equal(url, `${BASE_URL}/operations/onboarding-1`);
        return json({
          done: true,
          response: { cloudaicompanionProject: { id: 'new-managed-project' } },
        });
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.projectId, 'new-managed-project');
  assert.equal(requests.length, 3);
});

test('account verification, invalid setup responses and unexpected operation paths stop onboarding', async () => {
  for (const payload of [
    { ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] },
    { currentTier: { id: 'standard-tier' } },
    { allowedTiers: [{ isDefault: true }] },
  ]) {
    let requests = 0;
    await assert.rejects(
      setupProject(
        auth.access,
        {
          fetch: async () => {
            requests++;
            return json(payload);
          },
        },
        new AbortController().signal,
      ),
    );
    assert.equal(requests, 1);
  }
  let count = 0;
  await assert.rejects(
    setupProject(
      auth.access,
      {
        fetch: async () =>
          json(
            ++count === 1
              ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] }
              : { name: '../steal' },
          ),
      },
      new AbortController().signal,
    ),
    /invalid onboarding operation/,
  );
  assert.equal(count, 2);
});

test('login validates pasted redirect state and never exchanges an unrelated code', async () => {
  const oauth = createOAuth({
    fetch: async () => {
      throw new Error('MUST_NOT_CALL');
    },
  });
  const ui = interaction();
  ui.prompt = async () => `${REDIRECT_URI}?code=SECRET&state=wrong`;
  await assert.rejects(oauth.login(ui), /does not match/);
});

test('login and refresh honor cancellation; upstream errors do not expose credentials', async () => {
  const controller = new AbortController();
  controller.abort();
  const oauth = createOAuth({
    fetch: async () => {
      throw new Error('MUST_NOT_CALL');
    },
  });
  await assert.rejects(oauth.login({ ...interaction(), signal: controller.signal }), /cancelled/);
  await assert.rejects(oauth.refresh(auth, controller.signal), /cancelled/);
  const failed = createOAuth({
    fetch: async () => json({ error: auth.access, refresh_token: auth.refresh }, 400),
  });
  await assert.rejects(failed.refresh(auth, new AbortController().signal), (error) => {
    assert.match(error.message, /HTTP 400/);
    assert.doesNotMatch(error.message, /PRIVATE_/);
    return true;
  });
  const inFlight = new AbortController();
  const pending = createOAuth({
    fetch: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error(auth.access)), { once: true });
        queueMicrotask(() => inFlight.abort());
      }),
  });
  await assert.rejects(pending.refresh(auth, inFlight.signal), /cancelled/);
});
