import { createHash } from 'node:crypto';
import { findOperation, operationReadiness } from './contracts.mjs';
import { fail } from './errors.mjs';
import { readJsonPointer } from './json-pointer.mjs';
import { ProtectedJsonStore } from './protected-json-store.mjs';
import { GROK_WEB_ORIGIN, GrokSessionStore } from './session.mjs';
import { ObservedHttpTransport } from './transport.mjs';

const refreshing = new WeakSet();

/** Verify a fresh provider handoff before replacing the active account's credentials. */
export async function renewGrokSession({ registry, sessionStore, ownerBindingToken, expectedIdentity,
  acquireSession, fetchImpl, timeoutMs } = {}) {
  if (!sessionStore || typeof acquireSession !== 'function' || typeof fetchImpl !== 'function'
    || typeof expectedIdentity !== 'string' || !expectedIdentity.trim()) throw fail('SESSION_RENEWAL_INPUT_INVALID');
  if (refreshing.has(sessionStore)) throw fail('SESSION_RENEWAL_IN_PROGRESS');
  const initial = await sessionStore.load();
  const identityDigest = await sessionStore.verifiedOwnerIdentityDigest();
  if (!identityDigest) throw fail('OWNER_VERIFICATION_REQUIRED');
  if (createHash('sha256').update(expectedIdentity, 'utf8').digest('hex') !== identityDigest) throw fail('IDENTITY_MISMATCH');
  const operation = findOperation(registry, registry.identityOperationId);
  if (operation.kind !== 'read' || operation.role !== 'identity' || operation.authMode !== 'session'
    || operation.evidence.source !== 'browser_network_capture' || !operationReadiness(operation).ready) {
    throw fail('IDENTITY_CONTRACT_NOT_CAPTURED');
  }
  if (refreshing.has(sessionStore)) throw fail('SESSION_RENEWAL_IN_PROGRESS');
  refreshing.add(sessionStore);
  const stagedStore = new GrokSessionStore({ store: new ProtectedJsonStore({ provider: 'memory' }) });
  try {
    const bundle = await acquireSession(Object.freeze({ serviceId: 'grok-web', origin: GROK_WEB_ORIGIN, ownerIdentityDigest: identityDigest }));
    await stagedStore.importBundle(bundle);
    const staged = await stagedStore.load();
    const transport = new ObservedHttpTransport({ registry, sessionStore: stagedStore, fetchImpl, timeoutMs });
    const response = await transport.request(operation, {}, { session: staged });
    const identity = readJsonPointer(response.data, operation.identityJsonPointer);
    if (identity !== expectedIdentity) throw fail('IDENTITY_MISMATCH');
    const verifiedSession = await stagedStore.load();
    const credentialChanged = initial.origins[0].cookies.length !== verifiedSession.origins[0].cookies.length
      || verifiedSession.origins[0].cookies.some(cookie => !initial.origins[0].cookies.some(old =>
        old.name === cookie.name && old.domain === cookie.domain && old.path === cookie.path && old.value === cookie.value));
    const rotationNames = new Set(operation.response.setCookieNames ?? []);
    const providerCookieRotationVerified = (operation.request.credentialBindings?.cookies ?? []).some(name =>
      rotationNames.has(name) && verifiedSession.origins[0].cookies.some(cookie => cookie.name === name
        && staged.origins[0].cookies.some(old => old.name === name && old.domain === cookie.domain
          && old.path === cookie.path && old.value !== cookie.value)));
    await sessionStore.importVerifiedBundle(ownerBindingToken, verifiedSession, {
      expectedGeneration: initial.generation, operationId: operation.id, httpStatus: response.status,
      identityMatched: true, identityDigest,
    });
    return Object.freeze({ renewed: true, ownerVerified: true,
      mechanism: 'fresh_session_handoff_and_direct_owner_verification',
      httpStatus: response.status, responseBytes: response.responseBytes ?? null, credentialChanged,
      providerCookieRotationVerified, expiredProviderSessionRecoveryVerified: false,
      mutationRetried: false });
  } finally {
    refreshing.delete(sessionStore);
    await stagedStore.clear();
  }
}
