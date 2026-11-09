import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuth, setupProject } from '../src/auth.ts';
import { CONSUMER_DEPRECATION_URL, eligibilityFailure } from '../src/diagnostics.ts';
import { TOKEN_URL } from '../src/http.ts';
import { auth, json } from './fixtures.mjs';

const unsupported = {
  reasonCode: 'UNSUPPORTED_CLIENT',
  tierId: 'free-tier',
  reasonMessage:
    'This client is no longer supported for Gemini Code Assist for individuals. Please migrate to Antigravity.',
};

test('retired consumer client is reported by name and does not attempt onboarding', async () => {
  let calls = 0;
  await assert.rejects(
    setupProject(
      auth.access,
      {
        fetch: async () => {
          calls++;
          return json({
            allowedTiers: [{ id: 'legacy-tier', isDefault: true }],
            ineligibleTiers: [unsupported],
          });
        },
      },
      new AbortController().signal,
    ),
    (error) => {
      assert.match(error.message, /loadCodeAssist/);
      assert.match(error.message, /UNSUPPORTED_CLIENT/);
      assert.match(error.message, /no longer supported/);
      assert.match(error.message, /2026-06-18/);
      assert.ok(error.message.includes(CONSUMER_DEPRECATION_URL));
      assert.doesNotMatch(error.message, /UNKNOWN/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('future reason codes and explicit UNKNOWN keep the server explanation and failing phase', async () => {
  for (const code of ['NEW_ACCOUNT_REQUIREMENT', 'UNKNOWN']) {
    let calls = 0;
    await assert.rejects(
      setupProject(
        auth.access,
        {
          fetch: async () => {
            if (++calls === 1)
              return json({
                allowedTiers: [{ id: 'legacy-tier', isDefault: true }],
                ineligibleTiers: [
                  {
                    reasonCode: code,
                    reasonMessage: 'Ask your administrator to enable access. Status code: 3501.',
                  },
                ],
              });
            return json({ done: true, response: {} });
          },
        },
        new AbortController().signal,
      ),
      (error) => {
        assert.ok(error.message.includes(code));
        assert.match(error.message, /Ask your administrator to enable access/);
        assert.match(error.message, /Status code: 3501/);
        assert.match(error.message, /after onboardUser/);
        assert.doesNotMatch(error.message, /Antigravity/);
        return true;
      },
    );
    assert.equal(calls, 2);
  }
});

test('native OAuth error redacts access, refresh, authorization code, project, bearer and email', async () => {
  const code = 'PRIVATE_AUTHORIZATION_CODE';
  const projectId = 'private-project';
  const withoutProject = createOAuth({
    fetch: async (url) => {
      if (url === TOKEN_URL)
        return json({ access_token: auth.access, refresh_token: auth.refresh, expires_in: 3600 });
      return json({
        currentTier: { id: 'standard-tier' },
        ineligibleTiers: [
          {
            reasonCode: 'UNRECOGNIZED_ACCOUNT_RULE',
            reasonMessage: `Account policy refused access. ${auth.access} ${auth.refresh} ${code} person@example.com Bearer foreign-credential https://example.com/?code=url-secret`,
          },
        ],
      });
    },
  });
  await assert.rejects(
    withoutProject.login({
      signal: new AbortController().signal,
      notify() {},
      prompt: async () => code,
    }),
    (error) => {
      assert.match(error.message, /after loadCodeAssist/);
      assert.match(error.message, /Account policy refused access/);
      assert.doesNotMatch(
        error.message,
        /PRIVATE_|person@example.com|foreign-credential|url-secret/,
      );
      return true;
    },
  );
  const text = eligibilityFailure(
    {
      ineligibleTiers: [
        { reasonCode: 'UNKNOWN', reasonMessage: `Project ${projectId} is unavailable` },
      ],
    },
    [projectId],
  );
  assert.doesNotMatch(text, /private-project/);
  assert.equal(withoutProject.name, 'Google Code Assist (legacy)');
  assert.doesNotMatch(withoutProject.loginLabel, /Pro|Ultra/);
});

test('diagnostics strip controls and redact full values before truncating long messages', () => {
  const secret = 'long-secret-' + 'x'.repeat(600);
  const output = eligibilityFailure(
    {
      ineligibleTiers: Array.from({ length: 20 }, (_, index) => ({
        reasonCode: `REASON_${index}`,
        reasonMessage: `\u001b[31m${secret}\u001b[0m Contact user@example.com. ${'detail '.repeat(200)}`,
      })),
    },
    [secret],
  );
  assert.doesNotMatch(output, /long-secret|xxx|user@example.com|\u001b/);
  assert.ok(output.length < 3000);
  assert.match(output, /REASON_0/);
  assert.doesNotMatch(output, /REASON_5/);
});

test('ineligible consumer tier does not block an eligible organization project', async () => {
  const result = await setupProject(
    auth.access,
    {
      fetch: async () =>
        json({
          currentTier: { id: 'standard-tier' },
          cloudaicompanionProject: 'organization-project',
          ineligibleTiers: [unsupported],
        }),
    },
    new AbortController().signal,
  );
  assert.equal(result.projectId, 'organization-project');
});

test('missing and malformed eligibility entries remain diagnosable', () => {
  assert.equal(eligibilityFailure({}, []), undefined);
  const output = eligibilityFailure(
    { ineligibleTiers: [null, {}, { reasonCode: 'toString' }, { reasonCode: 'UNKNOWN' }] },
    [],
  );
  assert.match(output, /UNRECOGNIZED_CODE/);
  assert.match(output, /UNKNOWN: Google did not provide a reason message/);
  assert.doesNotMatch(output, /function|\[object Object\]/);
});
