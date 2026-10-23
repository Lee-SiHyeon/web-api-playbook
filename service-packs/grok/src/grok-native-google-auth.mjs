import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

const OWNER_OPERATION_ID = 'auth.owner.read';
const MAX_IDENTITY_LENGTH = 512;

function normalizedIdentity(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTITY_LENGTH
    || /[\r\n\0]/.test(value)) throw fail('NATIVE_GOOGLE_AUTH_IDENTITY_INVALID');
  return value.trim().toLowerCase();
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Read owner-scoped Google linkage without returning identity values or starting
 * an OAuth flow. Google OAuth remains a native first-party browser operation.
 */
export function createGrokNativeGoogleAuthClient({ client } = {}) {
  if (!client || typeof client.verifyOwner !== 'function' || typeof client.read !== 'function') {
    throw fail('NATIVE_GOOGLE_AUTH_CLIENT_REQUIRED');
  }

  return Object.freeze({
    async inspectCurrentAccount({ expectedIdentity } = {}) {
      const expected = normalizedIdentity(expectedIdentity);
      const normalizedExpectedDigest = sha256(expected);
      const expectedOwnerScopeDigest = sha256(expectedIdentity);
      const ownerProof = await client.verifyOwner(expectedIdentity);
      if (ownerProof?.ownerVerified !== true) throw fail('NATIVE_GOOGLE_AUTH_OWNER_UNVERIFIED');

      const result = await client.read(OWNER_OPERATION_ID, {}, { expectedOwnerScopeSha256: expectedOwnerScopeDigest });
      const session = result?.data?.session;
      if (!Number.isInteger(result?.status) || result.status !== 200 || !session || typeof session !== 'object'
        || Array.isArray(session) || typeof session.email !== 'string') {
        throw fail('NATIVE_GOOGLE_AUTH_OWNER_RESPONSE_INVALID');
      }

      const ownerDigest = sha256(normalizedIdentity(session.email));
      if (ownerDigest !== normalizedExpectedDigest) throw fail('NATIVE_GOOGLE_AUTH_OWNER_MISMATCH');

      const googleEmail = typeof session.googleEmail === 'string' && session.googleEmail.trim()
        ? normalizedIdentity(session.googleEmail) : null;
      const googleEmailMatchesOwner = googleEmail !== null && sha256(googleEmail) === ownerDigest;
      const accountHasPassword = typeof session.hasPassword === 'boolean' ? session.hasPassword : null;
      const loginApplicability = googleEmailMatchesOwner
        ? accountHasPassword === false ? 'native_google_for_current_account' : 'google_linked_current_account'
        : 'google_provider_not_confirmed';

      return Object.freeze({
        operationId: OWNER_OPERATION_ID,
        ownerVerified: true,
        normalizedOwnerDigestMatchedExpected: true,
        googleEmailMatchesOwner,
        accountHasPassword,
        passwordLoginApplicableForCurrentAccount: accountHasPassword,
        loginApplicability,
        directOAuthStartPerformed: false,
        callbackCompleted: false,
        passwordSubmitted: false,
        challengeBypassUsed: false,
        httpStatus: result.status,
        contentType: result.contentType ?? null,
        responseBytes: Number.isInteger(result.responseBytes) ? result.responseBytes : null,
        requestDigest: typeof result.requestDigest === 'string' ? result.requestDigest : null,
        rawResponseDigest: typeof result.rawResponseDigest === 'string' ? result.rawResponseDigest : null,
        rawIdentityPersisted: false,
        cookieValuesPersisted: false,
      });
    },
  });
}
