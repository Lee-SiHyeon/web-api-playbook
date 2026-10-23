import { GeminiClientError } from './errors.mjs';
import { makeCookieHeader, validateSessionBundle } from './session.mjs';

const pendingRenewals = new WeakSet();

function cookieValuesChanged(previous, replacement) {
  const before = new Map(previous?.cookies?.map((cookie) => [cookie.name, cookie.value]) ?? []);
  return replacement.cookies.some((cookie) => before.get(cookie.name) !== cookie.value)
    || before.size !== replacement.cookies.length;
}

/**
 * Install a normally acquired session only after independent same-owner HTTPS
 * verification. This handoff does not mint cookies or replay a failed mutation.
 */
export async function renewGeminiSession({ client, expectedOwner, acquireSession, createCandidate } = {}) {
  if (!client?.transport?.session || !client.contract || typeof createCandidate !== 'function'
      || typeof acquireSession !== 'function' || typeof expectedOwner !== 'string'
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedOwner)) {
    throw new GeminiClientError('SESSION_RENEWAL_INPUT_INVALID', 'A current client, expected owner, and normal session-acquisition callback are required.');
  }
  const normalizedOwner = expectedOwner.trim().toLowerCase();
  if (client.verifiedOwner && client.verifiedOwner !== normalizedOwner) {
    throw new GeminiClientError('SESSION_RENEWAL_OWNER_MISMATCH', 'Session renewal cannot switch the verified account.');
  }
  if (pendingRenewals.has(client)) throw new GeminiClientError('SESSION_RENEWAL_IN_PROGRESS', 'Another same-client session handoff is already running.');
  const previous = client.transport.session;
  let localExpiryDetected = false;
  try { makeCookieHeader(previous, client.contract.origin); }
  catch (error) {
    if (error?.code !== 'SESSION_EXPIRED') throw error;
    localExpiryDetected = true;
  }
  pendingRenewals.add(client);
  let candidate;
  try {
    const acquired = await acquireSession(Object.freeze({ service: client.contract.service,
      origin: client.contract.origin, reason: localExpiryDetected ? 'local_cookie_expiry' : 'explicit_same_owner_handoff' }));
    const staged = validateSessionBundle(acquired, client.contract);
    candidate = createCandidate({ contract: client.contract, session: staged, fetchImpl: client.transport.fetch });
    const identity = await candidate.verifyOwner(normalizedOwner);
    if (identity.ownerMatched !== true || identity.anonymousOwnerAbsent !== true
        || identity.credentialPropagated !== true) {
      throw new GeminiClientError('SESSION_RENEWAL_OWNER_VERIFICATION_FAILED', 'The replacement session did not verify the expected authenticated owner.');
    }
    if (client.transport.session !== previous) {
      throw new GeminiClientError('SESSION_CHANGED_DURING_RENEWAL', 'The active session changed while the replacement was being verified.');
    }
    const replacement = candidate.transport.session;
    const credentialChanged = cookieValuesChanged(previous, replacement)
      || JSON.stringify(previous.headers) !== JSON.stringify(replacement.headers);
    // Commit only after every asynchronous check; failed candidates preserve
    // the active session, owner, selection, and request counter.
    client.transport.session = replacement;
    client.verifiedOwner = normalizedOwner;
    client.nextHistoryRequestId = Number(replacement.batchContext?.requestId ?? 0);
    return Object.freeze({ service: client.contract.service, operation: 'session_handoff',
      state: 'verified', ownerMatched: true, anonymousOwnerAbsent: true,
      identityHttpStatus: identity.httpStatus, identityResponseBytes: identity.responseBytes,
      identityResponseSha256: identity.responseSha256, credentialPropagated: true,
      credentialChanged, localExpiryDetected, localExpiryRecoveryVerified: localExpiryDetected,
      providerCookieRotationVerified: false, providerExpiredSessionRecoveryVerified: false,
      mutationReplayed: false, credentialsPersisted: false,
    });
  } finally {
    if (candidate?.transport) candidate.transport.session = null;
    pendingRenewals.delete(client);
  }
}
