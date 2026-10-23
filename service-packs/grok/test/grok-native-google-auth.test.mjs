import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGrokNativeGoogleAuthClient } from '../src/grok-native-google-auth.mjs';

const email = 'owner@example.test';
const digest = 'a'.repeat(64);

function makeClient({ emailValue = email, googleEmail = email, hasPassword = false, ownerVerified = true } = {}) {
  const calls = [];
  const client = {
    async verifyOwner(expectedIdentity) {
      calls.push({ method: 'verifyOwner', expectedIdentityMatched: expectedIdentity === email });
      return { ownerVerified };
    },
    async read(operationId, input, options) {
      calls.push({ method: 'read', operationId, input, options });
      return {
        status: 200,
        contentType: 'application/json',
        responseBytes: 648,
        requestDigest: digest,
        rawResponseDigest: 'b'.repeat(64),
        data: { session: { email: emailValue, googleEmail, hasPassword } },
      };
    },
  };
  return { client, calls };
}

test('native Google applicability reads only owner-bound booleans and digests', async () => {
  const { client, calls } = makeClient();
  const result = await createGrokNativeGoogleAuthClient({ client }).inspectCurrentAccount({ expectedIdentity: email });
  assert.deepEqual({
    ownerVerified: result.ownerVerified,
    ownerMatch: result.normalizedOwnerDigestMatchedExpected,
    googleMatch: result.googleEmailMatchesOwner,
    hasPassword: result.accountHasPassword,
    passwordApplicable: result.passwordLoginApplicableForCurrentAccount,
    path: result.loginApplicability,
    status: result.httpStatus,
    bytes: result.responseBytes,
    rawIdentityPersisted: result.rawIdentityPersisted,
    cookieValuesPersisted: result.cookieValuesPersisted,
  }, {
    ownerVerified: true,
    ownerMatch: true,
    googleMatch: true,
    hasPassword: false,
    passwordApplicable: false,
    path: 'native_google_for_current_account',
    status: 200,
    bytes: 648,
    rawIdentityPersisted: false,
    cookieValuesPersisted: false,
  });
  assert.deepEqual(calls.map(item => item.method), ['verifyOwner', 'read']);
  assert.equal(calls[1].operationId, 'auth.owner.read');
  assert.equal(calls[1].options.expectedOwnerScopeSha256,
    createHash('sha256').update(email, 'utf8').digest('hex'));
});

test('native Google applicability does not turn an unlinked or password-enabled account into Google-only', async () => {
  const unlinked = await createGrokNativeGoogleAuthClient({ client: makeClient({ googleEmail: 'other@example.test' }).client })
    .inspectCurrentAccount({ expectedIdentity: email });
  assert.equal(unlinked.googleEmailMatchesOwner, false);
  assert.equal(unlinked.loginApplicability, 'google_provider_not_confirmed');

  const linkedWithPassword = await createGrokNativeGoogleAuthClient({ client: makeClient({ hasPassword: true }).client })
    .inspectCurrentAccount({ expectedIdentity: email });
  assert.equal(linkedWithPassword.googleEmailMatchesOwner, true);
  assert.equal(linkedWithPassword.passwordLoginApplicableForCurrentAccount, true);
  assert.equal(linkedWithPassword.loginApplicability, 'google_linked_current_account');
});

test('native Google applicability requires exact owner verification before profile reads', async () => {
  const { client, calls } = makeClient({ ownerVerified: false });
  await assert.rejects(createGrokNativeGoogleAuthClient({ client }).inspectCurrentAccount({ expectedIdentity: email }),
    { code: 'NATIVE_GOOGLE_AUTH_OWNER_UNVERIFIED' });
  assert.deepEqual(calls.map(item => item.method), ['verifyOwner']);
});
