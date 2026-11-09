import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createGeminiProvider } from '../src/index.ts';
import { setupProject } from '../src/auth.ts';
import { BASE_URL, TOKEN_URL } from '../src/http.ts';
import { auth, json } from './fixtures.mjs';

const signal = () => new AbortController().signal;
const offered = (id = 'legacy-tier') => ({
  allowedTiers: [{ id, isDefault: true, userDefinedCloudaicompanionProject: true }],
});
const onboarded = { done: true, response: { cloudaicompanionProject: { id: 'managed-project' } } };

test('native login allows Google onboarding to resolve a project despite the tier hint', async () => {
  const requests = [];
  const provider = createGeminiProvider({
    pollMs: 1,
    fetch: async (url, init) => {
      requests.push(url);
      if (url === TOKEN_URL)
        return json({ access_token: auth.access, refresh_token: auth.refresh, expires_in: 3600 });
      if (url.endsWith(':loadCodeAssist')) return json(offered());
      if (url.endsWith(':onboardUser')) {
        const body = JSON.parse(init.body);
        assert.equal(body.tierId, 'legacy-tier');
        assert.equal(body.cloudaicompanionProject, undefined);
        assert.equal(body.metadata.duetProject, undefined);
        assert.equal(body.enabled_credit_types, undefined);
        return json({ name: 'operations/first-login' });
      }
      assert.equal(url, `${BASE_URL}/operations/first-login`);
      return json(onboarded);
    },
  });
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(provider);
  await models.login(provider.id, 'oauth', {
    signal: signal(),
    notify() {},
    prompt: async () => 'PRIVATE_AUTHORIZATION_CODE',
  });
  assert.equal(requests.length, 4);
  const stored = await credentials.read(provider.id);
  assert.equal(stored.projectId, 'managed-project');
  assert.equal(stored.refresh, auth.refresh);
  assert.equal((await models.getAvailable(provider.id)).length, 4);
});

test('free-tier onboarding ignores the project hint and requests a managed project', async () => {
  let calls = 0;
  const result = await setupProject(
    auth.access,
    {
      fetch: async (_url, init) => {
        if (++calls === 1) return json(offered('free-tier'));
        const body = JSON.parse(init.body);
        assert.equal(body.tierId, 'free-tier');
        assert.equal(body.cloudaicompanionProject, undefined);
        assert.equal(body.metadata.duetProject, undefined);
        return json(onboarded);
      },
    },
    signal(),
  );
  assert.equal(result.projectId, 'managed-project');
  assert.equal(calls, 2);
});

test('missing default tier uses the official CLI legacy fallback', async () => {
  for (const loaded of [{}, { allowedTiers: [] }, { allowedTiers: [{ id: 'standard-tier' }] }]) {
    let calls = 0;
    const result = await setupProject(
      auth.access,
      {
        fetch: async (_url, init) => {
          if (++calls === 1) return json(loaded);
          assert.equal(JSON.parse(init.body).tierId, 'legacy-tier');
          return json(onboarded);
        },
      },
      signal(),
    );
    assert.equal(result.projectId, 'managed-project');
    assert.equal(calls, 2);
  }
});

test('missing project is reported only after onboarding returns no project', async () => {
  let calls = 0;
  await assert.rejects(
    setupProject(
      auth.access,
      {
        fetch: async () => {
          if (++calls === 1) return json(offered('standard-tier'));
          return json({ done: true, response: {} });
        },
      },
      signal(),
    ),
    /did not return a Code Assist project.*GEMINI_LOGIN_PROJECT/,
  );
  assert.equal(calls, 2);
});

test('onboarding failures include safe eligibility reasons without echoing server secrets', async () => {
  let calls = 0;
  await assert.rejects(
    setupProject(
      auth.access,
      {
        fetch: async () => {
          if (++calls === 1)
            return json({
              ...offered(),
              ineligibleTiers: [
                { reasonCode: 'UNSUPPORTED_LOCATION', reasonMessage: auth.access },
                { reasonCode: auth.refresh, reasonMessage: auth.refresh },
              ],
            });
          return json({ error: { message: auth.access } }, 403);
        },
      },
      signal(),
    ),
    (error) => {
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /UNSUPPORTED_LOCATION/);
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('existing account with no project reports its eligibility restriction', async () => {
  let calls = 0;
  await assert.rejects(
    setupProject(
      auth.access,
      {
        fetch: async () => {
          calls++;
          return json({
            currentTier: { id: 'standard-tier' },
            ineligibleTiers: [{ reasonCode: 'RESTRICTED_AGE', reasonMessage: auth.access }],
          });
        },
      },
      signal(),
    ),
    (error) => {
      assert.match(error.message, /RESTRICTED_AGE/);
      assert.doesNotMatch(error.message, /PRIVATE_/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('explicit enterprise project is sent and retained when onboarding has no managed project', async () => {
  let calls = 0;
  const result = await setupProject(
    auth.access,
    {
      projectId: 'enterprise-project',
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.cloudaicompanionProject, 'enterprise-project');
        assert.equal(body.metadata.duetProject, 'enterprise-project');
        if (++calls === 1) return json(offered('standard-tier'));
        assert.equal(body.tierId, 'standard-tier');
        return json({ done: true, response: {} });
      },
    },
    signal(),
  );
  assert.equal(result.projectId, 'enterprise-project');
  assert.equal(calls, 2);
});
