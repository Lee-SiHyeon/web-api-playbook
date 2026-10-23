import { projectTossFailureDiagnostics, type TossFailureDiagnostics } from './toss-session-core';
import { currentCoupangLinkLookupRevision } from './hub/collectors/coupang-issued-links';
import { parseHubCoupangLinkCandidates, type HubCoupangLinkCandidate } from './hub/collectors/coupang-hub-links';

import { createHash } from 'node:crypto';
import { getOperator, isOperatorEmail } from '@/lib/auth';
import { cronAuthorized } from '@/lib/request-guards';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import {
  decryptServiceSessionCredential,
  deriveServiceSessionOwnerDigest,
  encryptServiceSessionCredential,
  normalizeServiceSessionOrigins,
  SERVICE_SESSION_KEY_VERSION,
  SERVICE_SESSION_SERVICE,
  type ServiceCredentialKind,
  type ServiceSessionEnvelope,
  type ServiceSessionProvider,
} from '@/lib/service-session-crypto';
import {
  projectCoupangLoginRetryEvent,
  type CoupangLoginRetryEvent,
} from '@/lib/coupang-login-retry-core';

export type ServiceSessionStatus = 'unconfigured' | 'ready' | 'hold' | 'reauth_required' | 'disabled';
export type ServiceSessionHoldCode = 'HEALTH_CHECK_REQUIRED' | 'HEALTH_CHECK_FAILED' | 'OWNER_ACTION_REQUIRED'
  | 'SESSION_EXPIRED' | 'SOURCE_AUTH_REJECTED' | 'CREDENTIAL_REVOKED' | 'OPERATOR_PAUSED'
  | 'SOURCE_BLOCKED' | 'RATE_LIMITED';

export interface ServiceSessionMetadata {
  id: string;
  kind: ServiceCredentialKind;
  status: ServiceSessionStatus;
  revision: number;
  hasCredential: boolean;
  lastHealthAt: string | null;
  holdCode: ServiceSessionHoldCode | null;
  leaseBusy: boolean;
}

export interface ServiceSessionLease {
  readonly token: string;
  readonly fence: number;
  readonly expiresAt: string;
  readonly revision: number;
  toJSON(): never;
}

export interface ClaimedServiceSession {
  readonly metadata: ServiceSessionMetadata;
  readonly lease: ServiceSessionLease;
  /** Non-serializable secret handle. It can be consumed only by trusted Node code. */
  readonly credential: ServiceSessionCredential | null;
}

export interface AuthorizedCoupangUnknownLoginRetry {
  readonly attemptId: string;
  readonly sourceRevision: number;
  toJSON(): never;
}

export interface CoupangLoginRetryJournalEvent extends CoupangLoginRetryEvent {
  readonly sequence: number;
  readonly occurredAt: string;
}

export interface CoupangLoginRetryJournalRecord {
  readonly attemptId: string;
  readonly sourceRevision: number;
  readonly authorizedAt: string;
  readonly terminalOutcome: 'succeeded' | 'failed' | 'unknown' | null;
  readonly terminalAt: string | null;
  readonly events: readonly CoupangLoginRetryJournalEvent[];
}

export interface ServiceSessionCredential {
  withBytes<T>(operation: (credential: Buffer) => T | Promise<T>): Promise<T>;
  destroy(): void;
  toJSON(): never;
}

export interface ServiceSessionOwnerScope {
  readonly serviceId?: ServiceSessionProvider;
  readonly kind: ServiceCredentialKind;
  readonly allowedOrigins: readonly string[];
}

export interface ServiceSessionHealthProof {
  readonly checkedAt: string;
}

export interface ServiceSessionHealthEvidence {
  readonly outcome: 'verified';
  readonly ownerVerified: true;
  readonly readOnly: true;
}

export class ServiceSessionStoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ServiceSessionStoreError';
    this.code = code;
  }
}

type ScopeSecret = { ownerDigest: string; serviceId: ServiceSessionProvider };
type HealthProofSecret = { ownerDigest: string; kind: ServiceCredentialKind; originsKey: string; credentialDigest: string };
type RpcRecord = Record<string, unknown>;

const scopeSecrets = new WeakMap<object, ScopeSecret>();
const healthProofSecrets = new WeakMap<object, HealthProofSecret>();
const plaintextSecrets = new WeakMap<object, Buffer>();
const authorizedLoginRetrySecrets = new WeakMap<object, {
  readonly scope: ServiceSessionOwnerScope;
  readonly claim: ClaimedServiceSession;
}>();
const HOLD_CODES = new Set<ServiceSessionHoldCode>([
  'HEALTH_CHECK_REQUIRED', 'HEALTH_CHECK_FAILED', 'OWNER_ACTION_REQUIRED', 'SESSION_EXPIRED',
  'SOURCE_AUTH_REJECTED', 'CREDENTIAL_REVOKED', 'OPERATOR_PAUSED', 'SOURCE_BLOCKED', 'RATE_LIMITED',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createServiceSessionOwnerScope(input: {
  serviceId?: ServiceSessionProvider;
  kind: ServiceCredentialKind;
  allowedOrigins: readonly string[];
}): Promise<ServiceSessionOwnerScope | null> {
  if (!isProductionVercelRuntime()) return null;
  const operator = await getOperator();
  if (!operator) return null;
  const serviceId = input.serviceId ?? SERVICE_SESSION_SERVICE;
  const ownerEmail = configuredOwnerEmail(serviceId);
  if (!ownerEmail) return null;
  if (serviceId !== SERVICE_SESSION_SERVICE && operator.email !== ownerEmail) return null;
  return makeOwnerScope(ownerEmail, input.kind, input.allowedOrigins, serviceId);
}

/** The caller must still restrict this helper to its Vercel Cron route; identity never comes from request JSON.
 * `serviceId` defaults to the original single-service Coupang scope (unchanged for every existing caller); pass
 * it explicitly (e.g. 'naver_connect') to open a cron-callable scope for another provider's vault row. */
export function createCronServiceSessionOwnerScope(request: Request, input: {
  serviceId?: ServiceSessionProvider;
  kind: ServiceCredentialKind;
  allowedOrigins: readonly string[];
}): ServiceSessionOwnerScope | null {
  if (!isProductionVercelRuntime() || !cronAuthorized(request)) return null;
  const serviceId = input.serviceId ?? SERVICE_SESSION_SERVICE;
  const ownerEmail = configuredOwnerEmail(serviceId);
  if (!ownerEmail) return null;
  return makeOwnerScope(ownerEmail, input.kind, input.allowedOrigins, serviceId);
}

function configuredOwnerEmail(serviceId: ServiceSessionProvider = SERVICE_SESSION_SERVICE): string | null {
  const names = { coupang_partners: 'COUPANG_OWNER_EMAIL', naver_connect: 'NAVER_CONNECT_OWNER_EMAIL',
    toss_sharelink: 'TOSS_SHARELINK_OWNER_EMAIL' };
  const email = process.env[names[serviceId]]?.trim().toLowerCase();
  return email && isOperatorEmail(email) ? email : null;
}

/** Server-only public search/purchase path, AFTER its atomic DB budget/lease grant.
 * Fixed owner, credential kind and origins; never accepts visitor identity or opens a login/bootstrap path.
 */
export function createPublicPartnerSessionOwnerScope(serviceId: 'coupang_partners' | 'naver_connect'): ServiceSessionOwnerScope | null {
  if (!isProductionVercelRuntime()) return null;
  const email = configuredOwnerEmail(serviceId);
  if (!email) return null;
  return makeOwnerScope(email, 'web_session', serviceId === 'coupang_partners'
    ? ['https://login.coupang.com', 'https://partners.coupang.com'] : ['https://gw-brandconnect.naver.com'], serviceId);
}

function makeOwnerScope(ownerEmail: string, kind: ServiceCredentialKind, origins: readonly string[],
  serviceId: ServiceSessionProvider = SERVICE_SESSION_SERVICE): ServiceSessionOwnerScope {
  if (kind !== 'web_session' && kind !== 'open_api') {
    throw new ServiceSessionStoreError('SERVICE_SESSION_OWNER_SCOPE_INVALID');
  }
  const allowedOrigins = normalizeServiceSessionOrigins(origins, kind, serviceId);
  const scope: ServiceSessionOwnerScope = Object.freeze({
    ...(serviceId === SERVICE_SESSION_SERVICE ? {} : { serviceId }),
    kind,
    allowedOrigins: Object.freeze(allowedOrigins),
  });
  scopeSecrets.set(scope, { ownerDigest: deriveServiceSessionOwnerDigest(ownerEmail, serviceId), serviceId });
  return scope;
}

export async function ensureServiceSession(scope: ServiceSessionOwnerScope): Promise<ServiceSessionMetadata> {
  const secret = scopeSecret(scope);
  const { data, error } = await sessionRpc(scope, 'ensure_service_session', {
    p_credential_kind: scope.kind,
    p_owner_digest: secret.ownerDigest,
    p_allowed_origins: [...scope.allowedOrigins],
  });
  if (error) throw new ServiceSessionStoreError('SERVICE_SESSION_ENSURE_FAILED');
  return parseMetadata(data);
}

export async function readServiceSessionMetadata(scope: ServiceSessionOwnerScope): Promise<ServiceSessionMetadata | null> {
  const secret = scopeSecret(scope);
  const { data, error } = await sessionRpc(scope, 'service_session_metadata', {
    p_credential_kind: scope.kind,
    p_owner_digest: secret.ownerDigest,
  });
  if (error) throw new ServiceSessionStoreError('SERVICE_SESSION_METADATA_FAILED');
  return data === null ? null : parseMetadata(data);
}

export async function claimServiceSession(
  scope: ServiceSessionOwnerScope,
  expectedRevision: number,
  leaseSeconds = 120,
): Promise<ClaimedServiceSession | null> {
  const secret = scopeSecret(scope);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || !Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_CLAIM_INPUT_INVALID');
  }
  const { data, error } = await sessionRpc(scope, 'claim_service_session', {
    p_credential_kind: scope.kind,
    p_owner_digest: secret.ownerDigest,
    p_expected_revision: expectedRevision,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new ServiceSessionStoreError('SERVICE_SESSION_CLAIM_FAILED');
  const row = record(data);
  if (!row || row.claimed === false) return null;
  if (row.claimed !== true || !UUID.test(text(row.id)) || row.kind !== scope.kind
    || !isStatus(row.status) || positiveInteger(row.revision) !== expectedRevision
    || positiveInteger(row.keyVersion) !== SERVICE_SESSION_KEY_VERSION
    || typeof row.hasCredential !== 'boolean'
    || !Array.isArray(row.allowedOrigins) || !sameStrings(row.allowedOrigins, scope.allowedOrigins)
    || !isNullableString(row.ciphertext) || !isNullableString(row.nonce) || !isNullableString(row.authTag)
    || !isNullableTimestamp(row.lastHealthAt) || !isNullableHoldCode(row.holdCode)
    || !UUID.test(text(row.leaseToken)) || positiveInteger(row.leaseFence) === null
    || !isTimestamp(row.leaseExpiresAt)) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_CLAIM_RESPONSE_INVALID');
  }

  const ciphertext = nullableString(row.ciphertext);
  const nonce = nullableString(row.nonce);
  const authTag = nullableString(row.authTag);
  const allNull = ciphertext === null && nonce === null && authTag === null;
  const hasEnvelope = ciphertext !== null && nonce !== null && authTag !== null;
  if (!allNull && !hasEnvelope) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_CLAIM_RESPONSE_INVALID');
  }
  let credential: ServiceSessionCredential | null = null;
  if (row.status === 'ready') {
    if (!row.hasCredential || !hasEnvelope || !isTimestamp(row.lastHealthAt)) {
      throw new ServiceSessionStoreError('SERVICE_SESSION_CLAIM_RESPONSE_INVALID');
    }
    const envelope: ServiceSessionEnvelope = {
      serviceId: secret.serviceId,
      credentialKind: scope.kind,
      ownerDigest: secret.ownerDigest,
      keyVersion: SERVICE_SESSION_KEY_VERSION,
      revision: expectedRevision,
      allowedOrigins: [...scope.allowedOrigins],
      ciphertext,
      nonce,
      authTag,
    };
    try {
      credential = makeSecretCredential(decryptServiceSessionCredential(envelope));
    } catch {
      throw new ServiceSessionStoreError('SERVICE_SESSION_DECRYPT_FAILED');
    }
  } else if (hasEnvelope) {
    // Non-ready states cannot hand credentials to callers.
    throw new ServiceSessionStoreError('SERVICE_SESSION_CLAIM_RESPONSE_INVALID');
  }

  let metadata: ServiceSessionMetadata;
  try {
    metadata = parseMetadata({
      id: row.id,
      kind: row.kind,
      status: row.status,
      revision: row.revision,
      hasCredential: row.hasCredential,
      lastHealthAt: row.lastHealthAt,
      holdCode: row.holdCode,
      leaseBusy: true,
    });
  } catch (error) {
    credential?.destroy();
    throw error;
  }
  return {
    metadata,
    lease: makeLease({
      token: text(row.leaseToken),
      fence: positiveInteger(row.leaseFence) as number,
      expiresAt: text(row.leaseExpiresAt),
      revision: expectedRevision,
    }),
    credential,
  };
}

/** Atomically records the owner acknowledgement and claims the empty held web-session revision. */
export async function authorizeCoupangUnknownLoginRetry(input: {
  scope: ServiceSessionOwnerScope;
  expectedRevision: number;
  actorEmail: string;
}): Promise<AuthorizedCoupangUnknownLoginRetry | null> {
  const { scope, expectedRevision } = input;
  const secret = scopeSecret(scope);
  if (scope.kind !== 'web_session' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || typeof input.actorEmail !== 'string' || input.actorEmail.length > 320) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_INPUT_INVALID');
  }
  let actorDigest: string;
  try { actorDigest = deriveServiceSessionOwnerDigest(input.actorEmail.trim().toLowerCase()); }
  catch { throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_ACTOR_SCOPE_INVALID'); }
  if (actorDigest !== secret.ownerDigest) throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_ACTOR_SCOPE_INVALID');

  const { data, error } = await getSupabaseAdminClient().rpc('authorize_coupang_unknown_login_retry', {
    p_owner_digest: secret.ownerDigest,
    p_actor_digest: actorDigest,
    p_expected_revision: expectedRevision,
    p_lease_seconds: 300,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_AUTHORIZE_FAILED');
  const row = record(data);
  if (!row || row.authorized === false && Object.keys(row).length === 1) return null;
  if (row.authorized !== true || Object.keys(row).length !== 3
    || !UUID.test(text(row.attemptId))) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_AUTHORIZE_RESPONSE_INVALID');
  }
  const claim = parseAuthorizedUnknownLoginRetryClaim(scope, expectedRevision, row.claim);
  const authorization: AuthorizedCoupangUnknownLoginRetry = Object.freeze({
    attemptId: text(row.attemptId),
    sourceRevision: expectedRevision,
    toJSON(): never {
      throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_AUTHORIZATION_NOT_SERIALIZABLE');
    },
  });
  authorizedLoginRetrySecrets.set(authorization, { scope, claim });
  return authorization;
}

/** The preclaimed lease can only be recovered from the opaque authorization created above. */
export function getAuthorizedCoupangUnknownLoginRetryClaim(
  scope: ServiceSessionOwnerScope,
  authorization: AuthorizedCoupangUnknownLoginRetry,
): ClaimedServiceSession {
  const secret = authorization && typeof authorization === 'object'
    ? authorizedLoginRetrySecrets.get(authorization) : undefined;
  if (!secret || secret.scope !== scope || authorization.sourceRevision !== secret.claim.lease.revision) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_AUTHORIZATION_INVALID');
  }
  return secret.claim;
}

/** Append one credential-free event while the preclaimed owner retry lease is active. */
export async function recordCoupangUnknownLoginRetryEvent(input: {
  scope: ServiceSessionOwnerScope;
  authorization: AuthorizedCoupangUnknownLoginRetry;
  event: CoupangLoginRetryEvent;
}): Promise<boolean> {
  const { scope, authorization } = input;
  const authorizationSecret = authorization && typeof authorization === 'object'
    ? authorizedLoginRetrySecrets.get(authorization) : undefined;
  if (!authorizationSecret || authorizationSecret.scope !== scope) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_AUTHORIZATION_INVALID');
  }
  const event = projectCoupangLoginRetryEvent(input.event);
  if (!event || event.stage === 'owner_acknowledged') {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_EVENT_INVALID');
  }
  const secret = scopeSecret(scope);
  const claim = authorizationSecret.claim;
  validateLease(claim.lease);
  const { data, error } = await getSupabaseAdminClient().rpc('record_coupang_login_retry_event', {
    p_attempt_id: authorization.attemptId,
    p_owner_digest: secret.ownerDigest,
    p_expected_revision: claim.lease.revision,
    p_lease_token: claim.lease.token,
    p_lease_fence: claim.lease.fence,
    p_stage: event.stage,
    p_outcome: event.outcome,
    p_authentication_attempted: event.authenticationAttempted,
    p_safe_code: event.safeCode,
    p_http_status: event.httpStatus,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_EVENT_WRITE_FAILED');
  const row = record(data);
  if (!row || row.recorded === false && Object.keys(row).length === 1) return false;
  if (row.recorded !== true || Object.keys(row).length !== 2 || positiveInteger(row.eventSequence) === null) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_EVENT_RESPONSE_INVALID');
  }
  return true;
}

/** Read the latest safe owner retry receipt without exposing owner/actor digests or session data. */
export async function readLatestCoupangUnknownLoginRetry(
  scope: ServiceSessionOwnerScope,
): Promise<CoupangLoginRetryJournalRecord | null> {
  const secret = scopeSecret(scope);
  if (scope.kind !== 'web_session') throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_SCOPE_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('latest_coupang_login_retry_journal', {
    p_owner_digest: secret.ownerDigest,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_READ_FAILED');
  if (data === null) return null;
  const row = record(data);
  const keys = ['attemptId', 'sourceRevision', 'authorizedAt', 'terminalOutcome', 'terminalAt', 'events'];
  if (!row || Object.keys(row).length !== keys.length || Object.keys(row).some((key) => !keys.includes(key))
    || !UUID.test(text(row.attemptId)) || positiveInteger(row.sourceRevision) === null
    || !isTimestamp(row.authorizedAt)
    || !(row.terminalOutcome === null || ['succeeded', 'failed', 'unknown'].includes(String(row.terminalOutcome)))
    || !(row.terminalAt === null || isTimestamp(row.terminalAt))
    || !Array.isArray(row.events) || row.events.length < 1 || row.events.length > 32) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_READ_RESPONSE_INVALID');
  }
  const events: CoupangLoginRetryJournalEvent[] = [];
  for (let index = 0; index < row.events.length; index += 1) {
    const raw = record(row.events[index]);
    const eventKeys = ['sequence', 'stage', 'outcome', 'authenticationAttempted', 'safeCode', 'httpStatus', 'occurredAt'];
    if (!raw || Object.keys(raw).length !== eventKeys.length
      || Object.keys(raw).some((key) => !eventKeys.includes(key))
      || positiveInteger(raw.sequence) !== index + 1 || !isTimestamp(raw.occurredAt)) {
      throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_READ_RESPONSE_INVALID');
    }
    const projected = projectCoupangLoginRetryEvent({
      stage: raw.stage,
      outcome: raw.outcome,
      authenticationAttempted: raw.authenticationAttempted,
      safeCode: raw.safeCode,
      httpStatus: raw.httpStatus,
    });
    if (!projected) throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_READ_RESPONSE_INVALID');
    events.push(Object.freeze({ ...projected, sequence: index + 1, occurredAt: text(raw.occurredAt) }));
  }
  const terminalOutcome = row.terminalOutcome as CoupangLoginRetryJournalRecord['terminalOutcome'];
  const lastEvent = events.at(-1);
  if (events[0].stage !== 'owner_acknowledged' || events[0].outcome !== 'authorized'
    || (terminalOutcome === null) !== (row.terminalAt === null)
    || (terminalOutcome === null && lastEvent?.stage === 'attempt_finished')
    || (terminalOutcome !== null && (lastEvent?.stage !== 'attempt_finished' || lastEvent.outcome !== terminalOutcome))) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_READ_RESPONSE_INVALID');
  }
  return Object.freeze({
    attemptId: text(row.attemptId),
    sourceRevision: positiveInteger(row.sourceRevision) as number,
    authorizedAt: text(row.authorizedAt),
    terminalOutcome,
    terminalAt: row.terminalAt as string | null,
    events: Object.freeze(events),
  });
}

export async function renewServiceSessionLease(
  scope: ServiceSessionOwnerScope,
  lease: ServiceSessionLease,
  leaseSeconds = 120,
): Promise<ServiceSessionLease | null> {
  const secret = scopeSecret(scope);
  validateLease(lease);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_RENEW_INPUT_INVALID');
  }
  const { data, error } = await sessionRpc(scope, 'renew_service_session_lease', {
    p_credential_kind: scope.kind,
    p_owner_digest: secret.ownerDigest,
    p_expected_revision: lease.revision,
    p_lease_token: lease.token,
    p_lease_fence: lease.fence,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new ServiceSessionStoreError('SERVICE_SESSION_RENEW_FAILED');
  const row = record(data);
  if (!row || row.renewed === false) return null;
  if (row.renewed !== true || positiveInteger(row.revision) !== lease.revision || !isTimestamp(row.leaseExpiresAt)) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_RENEW_RESPONSE_INVALID');
  }
  return makeLease({ ...lease, expiresAt: text(row.leaseExpiresAt) });
}

export async function releaseServiceSessionLease(
  scope: ServiceSessionOwnerScope,
  lease: ServiceSessionLease,
): Promise<boolean> {
  const secret = scopeSecret(scope);
  validateLease(lease);
  const { data, error } = await sessionRpc(scope, 'release_service_session_lease', {
    p_credential_kind: scope.kind,
    p_owner_digest: secret.ownerDigest,
    p_lease_token: lease.token,
    p_lease_fence: lease.fence,
  });
  if (error) throw new ServiceSessionStoreError('SERVICE_SESSION_RELEASE_FAILED');
  const row = record(data);
  if (!row || typeof row.released !== 'boolean' || Object.keys(row).length !== 1) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_RELEASE_RESPONSE_INVALID');
  }
  return row.released;
}

/** Narrow service-role RPC bridge for the credential-free partner entry-check journal. */
export async function beginPartnerSessionEntryCheckRpc(
  scope: ServiceSessionOwnerScope,
  claim: ClaimedServiceSession,
): Promise<{ data: unknown; error: unknown }> {
  const args = partnerEntryCheckLeaseArgs(scope, claim);
  const { data, error } = await getSupabaseAdminClient().rpc('begin_partner_session_entry_check', args);
  return { data, error };
}

/** The database accepts completion only while this exact claimed lease is still live. */
export async function finishPartnerSessionEntryCheckRpc(input: {
  scope: ServiceSessionOwnerScope;
  claim: ClaimedServiceSession;
  checkId: string;
  safeResult: unknown;
}): Promise<{ data: unknown; error: unknown }> {
  const args = partnerEntryCheckLeaseArgs(input.scope, input.claim);
  if (!UUID.test(input.checkId)) throw new ServiceSessionStoreError('PARTNER_SESSION_CHECK_WRITER_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('finish_partner_session_entry_check', {
    ...args,
    p_check_id: input.checkId,
    p_safe_result: input.safeResult,
  });
  return { data, error };
}

export async function readLatestPartnerSessionEntryCheckRpc(
  scope: ServiceSessionOwnerScope,
): Promise<{ data: unknown; error: unknown }> {
  const secret = scopeSecret(scope);
  if (scope.kind !== 'web_session') throw new ServiceSessionStoreError('PARTNER_SESSION_CHECK_SCOPE_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('latest_partner_session_entry_check', {
    p_owner_digest: secret.ownerDigest,
  });
  return { data, error };
}

function partnerEntryCheckLeaseArgs(scope: ServiceSessionOwnerScope, claim: ClaimedServiceSession) {
  const secret = scopeSecret(scope);
  if (scope.kind !== 'web_session' || !claim || claim.metadata.kind !== 'web_session'
    || !UUID.test(claim.metadata.id) || claim.metadata.revision !== claim.lease.revision) {
    throw new ServiceSessionStoreError('PARTNER_SESSION_CHECK_SCOPE_INVALID');
  }
  validateLease(claim.lease);
  return {
    p_owner_digest: secret.ownerDigest,
    p_session_id: claim.metadata.id,
    p_expected_revision: claim.lease.revision,
    p_lease_token: claim.lease.token,
    p_lease_fence: claim.lease.fence,
  };
}

export async function verifyServiceSessionCredential(
  scope: ServiceSessionOwnerScope,
  credential: string | Uint8Array,
  // This trusted Node callback must prove the configured owner's identity and
  // perform a read-only health request; HTTP 200 by itself is insufficient.
  checkOwnerReadOnlyHealth: (
    credential: Buffer,
    acceptVerifiedCredential?: (updatedCredential: string | Uint8Array) => void,
  ) => Promise<unknown>,
): Promise<ServiceSessionHealthProof> {
  const secret = scopeSecret(scope);
  const input = typeof credential === 'string' ? Buffer.from(credential, 'utf8') : Buffer.from(credential);
  if (input.byteLength < 1 || input.byteLength > 512 * 1024) {
    input.fill(0);
    throw new ServiceSessionStoreError('SERVICE_SESSION_CREDENTIAL_INVALID');
  }
  const checkCopy = Buffer.from(input);
  const accepted = { credential: null as Buffer | null };
  let replacementRegistrationOpen = true;
  let evidence: unknown = null;
  try {
    evidence = await checkOwnerReadOnlyHealth(checkCopy, (updatedCredential) => {
      if (!replacementRegistrationOpen || accepted.credential) {
        throw new ServiceSessionStoreError('SERVICE_SESSION_HEALTH_PROOF_UPDATE_REJECTED');
      }
      const updated = typeof updatedCredential === 'string'
        ? Buffer.from(updatedCredential, 'utf8')
        : Buffer.from(updatedCredential);
      if (updated.byteLength < 1 || updated.byteLength > 512 * 1024) {
        updated.fill(0);
        throw new ServiceSessionStoreError('SERVICE_SESSION_CREDENTIAL_INVALID');
      }
      accepted.credential = updated;
    });
  } catch {
    evidence = null;
  } finally {
    replacementRegistrationOpen = false;
    checkCopy.fill(0);
  }
  if (!isVerifiedHealthEvidence(evidence)) {
    input.fill(0);
    accepted.credential?.fill(0);
    throw new ServiceSessionStoreError('SERVICE_SESSION_HEALTH_NOT_VERIFIED');
  }
  const checkedAt = new Date().toISOString();
  const proof: ServiceSessionHealthProof = Object.freeze({ checkedAt });
  const verifiedCredential = accepted.credential ?? input;
  healthProofSecrets.set(proof, {
    ownerDigest: secret.ownerDigest,
    kind: scope.kind,
    originsKey: JSON.stringify(scope.allowedOrigins),
    credentialDigest: createHash('sha256').update(verifiedCredential).digest('hex'),
  });
  input.fill(0);
  accepted.credential?.fill(0);
  return proof;
}

export async function casWriteServiceSession(input: {
  scope: ServiceSessionOwnerScope;
  lease: ServiceSessionLease;
  status: ServiceSessionStatus;
  credential?: string | Uint8Array | null;
  healthProof?: ServiceSessionHealthProof;
  holdCode?: ServiceSessionHoldCode | null;
}): Promise<ServiceSessionMetadata | null> {
  const { scope, lease } = input;
  const secret = scopeSecret(scope);
  validateLease(lease);
  const credentialBytes = input.credential == null
    ? null
    : typeof input.credential === 'string' ? Buffer.from(input.credential, 'utf8') : Buffer.from(input.credential);
  let envelope: ServiceSessionEnvelope | null = null;
  let lastHealthAt: string | null = null;
  const holdCode = input.holdCode ?? null;

  if (input.status === 'ready') {
    if (!credentialBytes || !input.healthProof || holdCode !== null) {
      credentialBytes?.fill(0);
      throw new ServiceSessionStoreError('SERVICE_SESSION_READY_REQUIRES_HEALTH_PROOF');
    }
    const proofSecret = healthProofSecrets.get(input.healthProof);
    if (!proofSecret || proofSecret.ownerDigest !== secret.ownerDigest || proofSecret.kind !== scope.kind
      || proofSecret.originsKey !== JSON.stringify(scope.allowedOrigins)
      || proofSecret.credentialDigest !== createHash('sha256').update(credentialBytes).digest('hex')
      || !isFreshHealthTimestamp(input.healthProof.checkedAt)) {
      credentialBytes.fill(0);
      throw new ServiceSessionStoreError('SERVICE_SESSION_HEALTH_PROOF_MISMATCH');
    }
    lastHealthAt = input.healthProof.checkedAt;
    try {
      envelope = encryptServiceSessionCredential({
        serviceId: secret.serviceId,
        credentialKind: scope.kind,
        ownerDigest: secret.ownerDigest,
        keyVersion: SERVICE_SESSION_KEY_VERSION,
        revision: lease.revision + 1,
        allowedOrigins: scope.allowedOrigins,
        plaintext: credentialBytes,
      });
    } finally {
      credentialBytes.fill(0);
    }
  } else {
    credentialBytes?.fill(0);
    if (input.credential != null || input.healthProof) {
      throw new ServiceSessionStoreError('SERVICE_SESSION_NONREADY_MUST_NOT_STORE_CREDENTIAL');
    }
    if (input.status === 'hold' || input.status === 'reauth_required') {
      if (!holdCode || !HOLD_CODES.has(holdCode)) throw new ServiceSessionStoreError('SERVICE_SESSION_HOLD_CODE_INVALID');
    } else if (holdCode !== null) {
      throw new ServiceSessionStoreError('SERVICE_SESSION_HOLD_CODE_INVALID');
    }
    if (input.status === 'unconfigured' && input.healthProof) {
      throw new ServiceSessionStoreError('SERVICE_SESSION_NONREADY_MUST_NOT_STORE_CREDENTIAL');
    }
  }

  const { data, error } = await sessionRpc(scope, 'cas_write_service_session', {
    p_credential_kind: scope.kind,
    p_owner_digest: secret.ownerDigest,
    p_expected_revision: lease.revision,
    p_lease_token: lease.token,
    p_lease_fence: lease.fence,
    p_allowed_origins: [...scope.allowedOrigins],
    p_key_version: SERVICE_SESSION_KEY_VERSION,
    p_ciphertext: envelope?.ciphertext ?? null,
    p_nonce: envelope?.nonce ?? null,
    p_auth_tag: envelope?.authTag ?? null,
    p_status: input.status,
    p_last_health_at: lastHealthAt,
    p_hold_code: holdCode,
  });
  if (error) throw new ServiceSessionStoreError('SERVICE_SESSION_CAS_WRITE_FAILED');
  const row = record(data);
  if (!row || row.written === false) return null;
  if (row.written !== true) throw new ServiceSessionStoreError('SERVICE_SESSION_CAS_RESPONSE_INVALID');
  const { written: _written, ...metadataRow } = row;
  return parseMetadata(metadataRow);
}

export type CoupangPartnerLinkIssueState = 'reserved' | 'write_started' | 'issued'
  | 'outcome_unknown' | 'rejected' | 'attached';

export interface CoupangPartnerLinkIssueRecord {
  readonly issueId: string;
  readonly state: CoupangPartnerLinkIssueState;
  readonly productIdentity: string;
  readonly productUrl: string;
  readonly shortUrl: string | null;
  readonly sourceHttpStatus: number | null;
  readonly safeCode: string | null;
  readonly destinationVerified: boolean | null;
  readonly attributionVerified: boolean | null;
  readonly partnerLinkId: string | null;
  readonly attachedOfferIds: readonly string[];
}

export async function listHubCoupangLinksPendingRpc(input: {
  scope: ServiceSessionOwnerScope; claim: ClaimedServiceSession; affiliateCodeDigest: string; itemId?: string;
}): Promise<HubCoupangLinkCandidate[]> {
  const { data, error } = await getSupabaseAdminClient().rpc(input.itemId ? 'hub_coupang_link_candidate' : 'hub_coupang_links_pending', {
    ...coupangPartnerIssueLeaseArgs(input.scope, input.claim), p_affiliate_code_digest: input.affiliateCodeDigest,
    ...(input.itemId ? { p_item_id: input.itemId } : { p_limit: 300 }),
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_HUB_LINK_LIST_FAILED');
  return parseHubCoupangLinkCandidates(data);
}

export async function reserveHubCoupangPartnerLinkIssueRpc(input: {
  scope: ServiceSessionOwnerScope; claim: ClaimedServiceSession; candidate: HubCoupangLinkCandidate; affiliateCodeDigest: string;
}): Promise<CoupangPartnerLinkIssueRecord> {
  const { data, error } = await getSupabaseAdminClient().rpc('reserve_hub_coupang_partner_link_issue', {
    ...coupangPartnerIssueLeaseArgs(input.scope, input.claim), p_hub_item_id: input.candidate.hub_item_id,
    p_target_snapshot: input.candidate.target_snapshot, p_product_url: input.candidate.product_url,
    p_product_identity: input.candidate.product_identity, p_affiliate_code_digest: input.affiliateCodeDigest,
  });
  if (error) throw new ServiceSessionStoreError(error.message?.includes('target_changed')
    ? 'COUPANG_HUB_TARGET_CHANGED' : 'COUPANG_PARTNER_ISSUE_RESERVE_FAILED');
  return parseCoupangPartnerLinkIssueRecord(data);
}

export async function attachHubCoupangPartnerLinkIssueRpc(input: {
  scope: ServiceSessionOwnerScope; claim: ClaimedServiceSession; candidate: HubCoupangLinkCandidate;
  issueId: string; affiliateCodeDigest: string;
}): Promise<boolean> {
  const { data, error } = await getSupabaseAdminClient().rpc('attach_hub_coupang_partner_link_issue', {
    ...coupangPartnerIssueLeaseArgs(input.scope, input.claim), p_hub_item_id: input.candidate.hub_item_id,
    p_target_snapshot: input.candidate.target_snapshot, p_issue_id: input.issueId, p_affiliate_code_digest: input.affiliateCodeDigest,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_HUB_LINK_ATTACH_FAILED');
  const row = record(data);
  if (!row || Object.keys(row).length !== 1 || typeof row.attached !== 'boolean') {
    throw new ServiceSessionStoreError('COUPANG_HUB_LINK_ATTACH_RESPONSE_INVALID');
  }
  return row.attached;
}

/** Bounded read-only reuse of fully verified receipts under the current owner/code and session lease. */
export async function lookupCoupangOwnedPartnerLinksRpc(input: {
  scope: ServiceSessionOwnerScope;
  claim: ClaimedServiceSession;
  affiliateCodeDigest: string;
  productIdentities: readonly string[];
}): Promise<unknown[]> {
  const args = coupangPartnerIssueLeaseArgs(input.scope, input.claim);
  if (!/^[a-f0-9]{64}$/.test(input.affiliateCodeDigest) || !Array.isArray(input.productIdentities)
    || input.productIdentities.length > 200 || input.productIdentities.some(id => typeof id !== 'string'
      || !/^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}:[1-9][0-9]{0,19}$/.test(id))) {
    throw new ServiceSessionStoreError('COUPANG_LINK_LOOKUP_INPUT_INVALID');
  }
  // Discovery persists verified cookie rotation through CAS before this read. It advances the
  // metadata revision without mutating the old claim; preserve its original token/fence.
  args.p_session_revision = currentCoupangLinkLookupRevision(await readServiceSessionMetadata(input.scope),
    input.claim.metadata.id, input.claim.lease.revision);
  const { data, error } = await getSupabaseAdminClient().rpc('lookup_coupang_owned_partner_links', {
    ...args, p_affiliate_code_digest: input.affiliateCodeDigest, p_product_identities: [...input.productIdentities],
  });
  if (error || !Array.isArray(data)) throw new ServiceSessionStoreError('COUPANG_LINK_LOOKUP_UNAVAILABLE');
  return data;
}

/** Reserves (or reads) the exact owner + canonical product-variant generation intent. */
export async function reserveCoupangPartnerLinkIssueRpc(input: {
  scope: ServiceSessionOwnerScope;
  claim: ClaimedServiceSession;
  offerId: string;
  productUrl: string;
  productIdentity: string;
  affiliateCodeDigest: string;
}): Promise<CoupangPartnerLinkIssueRecord> {
  const args = coupangPartnerIssueLeaseArgs(input.scope, input.claim);
  const { data, error } = await getSupabaseAdminClient().rpc('reserve_coupang_partner_link_issue', {
    ...args,
    p_offer_id: input.offerId,
    p_product_url: input.productUrl,
    p_product_identity: input.productIdentity,
    p_affiliate_code_digest: input.affiliateCodeDigest,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_RESERVE_FAILED');
  return parseCoupangPartnerLinkIssueRecord(data);
}

/** The only transition that permits the caller to dispatch the source GET. */
export async function startCoupangPartnerLinkIssueRpc(input: {
  scope: ServiceSessionOwnerScope;
  claim: ClaimedServiceSession;
  issueId: string;
}): Promise<boolean> {
  const args = coupangPartnerIssueLeaseArgs(input.scope, input.claim);
  if (!UUID.test(input.issueId)) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_INPUT_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('start_coupang_partner_link_issue', {
    ...args, p_issue_id: input.issueId,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_START_FAILED');
  const row = record(data);
  if (!row || Object.keys(row).length !== 1 || typeof row.started !== 'boolean') {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_START_RESPONSE_INVALID');
  }
  return row.started;
}

/** Stores the validated receipt before any offer attachment is attempted. */
export async function finishCoupangPartnerLinkIssueRpc(input: {
  scope: ServiceSessionOwnerScope;
  claim: ClaimedServiceSession;
  issueId: string;
  state: 'issued' | 'outcome_unknown' | 'rejected';
  shortUrl: string | null;
  sourceHttpStatus: number | null;
  safeCode: string | null;
  destinationVerified: boolean;
  attributionVerified: boolean;
}): Promise<CoupangPartnerLinkIssueRecord | null> {
  const args = coupangPartnerIssueLeaseArgs(input.scope, input.claim);
  if (!UUID.test(input.issueId)) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_INPUT_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('finish_coupang_partner_link_issue', {
    ...args,
    p_issue_id: input.issueId,
    p_state: input.state,
    p_short_url: input.shortUrl,
    p_source_http_status: input.sourceHttpStatus,
    p_safe_code: input.safeCode,
    p_destination_verified: input.destinationVerified,
    p_attribution_verified: input.attributionVerified,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_FINISH_FAILED');
  const row = record(data);
  if (!row || typeof row.finished !== 'boolean') {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_FINISH_RESPONSE_INVALID');
  }
  if (row.finished === false) {
    if (Object.keys(row).length !== 1) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_FINISH_RESPONSE_INVALID');
    return null;
  }
  return parseCoupangPartnerLinkIssueRecord(row);
}

/** Completes the journal only after the site projection independently reads back the exact link row. */
export async function attachCoupangPartnerLinkIssueRpc(input: {
  scope: ServiceSessionOwnerScope;
  claim: ClaimedServiceSession;
  issueId: string;
  offerId: string;
  partnerLinkId: string;
}): Promise<{ attached: boolean; issueId: string | null; partnerLinkId: string | null; offerIds: string[]; state: CoupangPartnerLinkIssueState | null }> {
  const args = coupangPartnerIssueLeaseArgs(input.scope, input.claim);
  if (!UUID.test(input.issueId) || !UUID.test(input.offerId) || !UUID.test(input.partnerLinkId)) {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_INPUT_INVALID');
  }
  const { data, error } = await getSupabaseAdminClient().rpc('attach_coupang_partner_link_issue', {
    ...args,
    p_issue_id: input.issueId,
    p_offer_id: input.offerId,
    p_partner_link_id: input.partnerLinkId,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTACH_FAILED');
  const row = record(data);
  if (!row || typeof row.attached !== 'boolean') {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTACH_RESPONSE_INVALID');
  }
  if (row.attached === false) {
    if (Object.keys(row).length !== 1) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTACH_RESPONSE_INVALID');
    return { attached: false, issueId: null, partnerLinkId: null, offerIds: [], state: null };
  }
  if (!UUID.test(text(row.issueId)) || !UUID.test(text(row.partnerLinkId)) || !Array.isArray(row.offerIds)
    || !row.offerIds.every((id) => typeof id === 'string' && UUID.test(id)) || row.state !== 'attached') {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTACH_RESPONSE_INVALID');
  }
  return {
    attached: true,
    issueId: text(row.issueId),
    partnerLinkId: text(row.partnerLinkId),
    offerIds: [...row.offerIds] as string[],
    state: 'attached',
  };
}

/** Persist attribution proof from a bounded unauthenticated short-link redirect. */
export async function verifyCoupangPartnerLinkIssueAttributionRpc(input: {
  scope: ServiceSessionOwnerScope;
  claim: ClaimedServiceSession;
  issueId: string;
  affiliateCodeDigest: string;
}): Promise<boolean> {
  const args = coupangPartnerIssueLeaseArgs(input.scope, input.claim);
  if (!UUID.test(input.issueId) || !/^[a-f0-9]{64}$/.test(input.affiliateCodeDigest)) {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_INPUT_INVALID');
  }
  const { data, error } = await getSupabaseAdminClient().rpc('verify_coupang_partner_link_issue_attribution', {
    ...args,
    p_issue_id: input.issueId,
    p_affiliate_code_digest: input.affiliateCodeDigest,
  });
  if (error) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTRIBUTION_WRITE_FAILED');
  const row = record(data);
  if (!row || typeof row.verified !== 'boolean') {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTRIBUTION_RESPONSE_INVALID');
  }
  if (row.verified === false) {
    if (Object.keys(row).length !== 1) throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTRIBUTION_RESPONSE_INVALID');
    return false;
  }
  if (!UUID.test(text(row.issueId)) || row.issueId !== input.issueId || row.state !== 'issued'
    || !/^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]{1,64}$/.test(text(row.shortUrl))
    || row.destinationVerified !== true || row.attributionVerified !== true
    || row.safeCode !== 'PUBLIC_REDIRECT_VERIFIED') {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_ATTRIBUTION_RESPONSE_INVALID');
  }
  return true;
}

function coupangPartnerIssueLeaseArgs(scope: ServiceSessionOwnerScope, claim: ClaimedServiceSession) {
  const secret = scopeSecret(scope);
  if (scope.kind !== 'web_session' || !claim || claim.metadata.kind !== 'web_session'
    || claim.metadata.status !== 'ready' || claim.metadata.hasCredential !== true
    || !UUID.test(claim.metadata.id) || claim.metadata.revision !== claim.lease.revision) {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_SCOPE_INVALID');
  }
  validateLease(claim.lease);
  return {
    p_owner_digest: secret.ownerDigest,
    p_session_id: claim.metadata.id,
    p_session_revision: claim.lease.revision,
    p_lease_token: claim.lease.token,
    p_lease_fence: claim.lease.fence,
  };
}

function parseCoupangPartnerLinkIssueRecord(value: unknown): CoupangPartnerLinkIssueRecord {
  const row = record(value);
  const states = new Set<CoupangPartnerLinkIssueState>([
    'reserved', 'write_started', 'issued', 'outcome_unknown', 'rejected', 'attached',
  ]);
  const uuidArray = Array.isArray(row?.attachedOfferIds)
    && row.attachedOfferIds.length <= 200
    && row.attachedOfferIds.every((id) => typeof id === 'string' && UUID.test(id));
  if (!row || !UUID.test(text(row.issueId)) || typeof row.state !== 'string' || !states.has(row.state as CoupangPartnerLinkIssueState)
    || typeof row.productIdentity !== 'string' || !/^[1-9][0-9]{0,19}:[1-9][0-9]{0,19}:[1-9][0-9]{0,19}$/.test(row.productIdentity)
    || typeof row.productUrl !== 'string' || row.productUrl.length > 512
    || !isNullableString(row.shortUrl) || !isNullableStatus(row.sourceHttpStatus)
    || !isNullableSafeCode(row.safeCode) || !isNullableBoolean(row.destinationVerified)
    || !isNullableBoolean(row.attributionVerified) || !isNullableString(row.partnerLinkId)
    || (row.partnerLinkId !== null && !UUID.test(row.partnerLinkId)) || !uuidArray) {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_RESPONSE_INVALID');
  }
  if ((row.state === 'issued' || row.state === 'attached')
      ? typeof row.shortUrl !== 'string' || !/^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]{1,64}$/.test(row.shortUrl)
      : row.shortUrl !== null) {
    throw new ServiceSessionStoreError('COUPANG_PARTNER_ISSUE_RESPONSE_INVALID');
  }
  return {
    issueId: text(row.issueId),
    state: row.state as CoupangPartnerLinkIssueState,
    productIdentity: row.productIdentity,
    productUrl: row.productUrl,
    shortUrl: row.shortUrl,
    sourceHttpStatus: row.sourceHttpStatus as number | null,
    safeCode: row.safeCode,
    destinationVerified: row.destinationVerified,
    attributionVerified: row.attributionVerified,
    partnerLinkId: row.partnerLinkId,
    attachedOfferIds: [...(row.attachedOfferIds as string[])],
  };
}

function isNullableStatus(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599);
}

function isNullableSafeCode(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value));
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function makeSecretCredential(bytes: Buffer): ServiceSessionCredential {
  const handle: ServiceSessionCredential = Object.freeze({
    async withBytes<T>(operation: (credential: Buffer) => T | Promise<T>): Promise<T> {
      const stored = plaintextSecrets.get(handle);
      if (!stored) throw new ServiceSessionStoreError('SERVICE_SESSION_CREDENTIAL_DESTROYED');
      const copy = Buffer.from(stored);
      try { return await operation(copy); }
      finally { copy.fill(0); }
    },
    destroy(): void {
      plaintextSecrets.get(handle)?.fill(0);
      plaintextSecrets.delete(handle);
    },
    toJSON(): never {
      throw new ServiceSessionStoreError('SERVICE_SESSION_CREDENTIAL_NOT_SERIALIZABLE');
    },
  });
  plaintextSecrets.set(handle, bytes);
  return handle;
}

function makeLease(fields: Omit<ServiceSessionLease, 'toJSON'>): ServiceSessionLease {
  return Object.freeze({
    ...fields,
    toJSON(): never {
      throw new ServiceSessionStoreError('SERVICE_SESSION_LEASE_NOT_SERIALIZABLE');
    },
  });
}

function scopeSecret(scope: ServiceSessionOwnerScope): ScopeSecret {
  if (!scope || typeof scope !== 'object') throw new ServiceSessionStoreError('SERVICE_SESSION_OWNER_SCOPE_INVALID');
  const secret = scopeSecrets.get(scope);
  if (!secret || (scope.kind !== 'web_session' && scope.kind !== 'open_api')
    || (scope.serviceId ?? SERVICE_SESSION_SERVICE) !== secret.serviceId
    || !sameStrings(scope.allowedOrigins, normalizeServiceSessionOrigins(scope.allowedOrigins, scope.kind, secret.serviceId))) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_OWNER_SCOPE_INVALID');
  }
  return secret;
}

/** Original Coupang RPCs and their argument shapes remain unchanged. */
export async function tossSharelinkJournalRpc(scope: ServiceSessionOwnerScope, claim: ClaimedServiceSession,
  action: 'lookup' | 'reserve' | 'finish', ids: readonly string[], state: string | null = null, shortUrl: string | null = null): Promise<unknown> {
  const secret = scopeSecret(scope);
  if (secret.serviceId !== 'toss_sharelink' || scope.kind !== 'web_session' || claim.metadata.kind !== 'web_session'
    || claim.metadata.status !== 'ready' || !claim.credential || !UUID.test(claim.metadata.id)
    || claim.metadata.revision !== claim.lease.revision || ids.length < 1 || ids.length > 500
    || ids.some(id => !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new ServiceSessionStoreError('TOSS_JOURNAL_SCOPE_INVALID');
  }
  validateLease(claim.lease);
  const { data, error } = await getSupabaseAdminClient().rpc('toss_sharelink_journal', {
    p_owner_digest: secret.ownerDigest, p_session_id: claim.metadata.id, p_expected_revision: claim.lease.revision,
    p_lease_token: claim.lease.token, p_lease_fence: claim.lease.fence,
    p_action: action, p_item_ids: [...ids], p_state: state, p_short_url: shortUrl,
  });
  if (error) throw new ServiceSessionStoreError('TOSS_JOURNAL_UNAVAILABLE');
  return data;
}

export type TossCollectorRunClaim = {
  claimed: true; status: 'claimed'; runId: string; leaseToken: string; leaseFence: number; startedAt: string;
  toJSON(): never;
} | { claimed: false; status: 'busy' | 'replayed'; runId?: string; fetched?: number; upserted?: number; persisted?: boolean; complete?: boolean; error?: string | null;
  diagnostics?: TossFailureDiagnostics | null };

export async function beginTossCollectorRun(scope: ServiceSessionOwnerScope, scheduledAt: string): Promise<TossCollectorRunClaim> {
  const secret = scopeSecret(scope);
  if (secret.serviceId !== 'toss_sharelink' || scope.kind !== 'web_session' || !isTimestamp(scheduledAt)) throw new ServiceSessionStoreError('TOSS_RUN_SCOPE_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('begin_toss_collector_run', {
    p_owner_digest: secret.ownerDigest, p_scheduled_at: scheduledAt,
  });
  const row = record(data);
  if (error || !row) throw new ServiceSessionStoreError('TOSS_RUN_UNAVAILABLE');
  if (row.claimed === false && row.status === 'busy') return { claimed: false, status: 'busy' };
  if (row.claimed === false && row.status === 'replayed' && UUID.test(text(row.runId))
    && Number.isSafeInteger(row.fetched) && Number(row.fetched) >= 0 && Number.isSafeInteger(row.upserted)
    && Number(row.upserted) >= 0 && typeof row.persisted === 'boolean'
    && (row.error === null || /^(PARTIAL_LIST:)?TOSS_[A-Z0-9_]{1,64}$/.test(text(row.error)))) {
    return { claimed: false, status: 'replayed', runId: text(row.runId), fetched: Number(row.fetched),
      upserted: Number(row.upserted), persisted: row.persisted, error: row.error as string | null,
      complete: row.complete === true,
      diagnostics: row.diagnostics == null ? null : projectTossFailureDiagnostics(row.diagnostics) };
  }
  if (row.claimed !== true || row.status !== 'claimed' || !UUID.test(text(row.runId))
    || !UUID.test(text(row.leaseToken)) || positiveInteger(row.leaseFence) === null || !isTimestamp(row.startedAt)) {
    throw new ServiceSessionStoreError('TOSS_RUN_RESPONSE_INVALID');
  }
  return Object.freeze({ claimed: true as const, status: 'claimed' as const, runId: text(row.runId),
    leaseToken: text(row.leaseToken), leaseFence: Number(row.leaseFence), startedAt: text(row.startedAt),
    toJSON(): never { throw new ServiceSessionStoreError('TOSS_RUN_LEASE_NOT_SERIALIZABLE'); } });
}

export async function pendingTossCollectorSlots(scope: ServiceSessionOwnerScope): Promise<string[]> {
  const secret = scopeSecret(scope);
  if (secret.serviceId !== 'toss_sharelink' || scope.kind !== 'web_session') throw new ServiceSessionStoreError('TOSS_RUN_SCOPE_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('pending_toss_collector_slots', { p_owner_digest: secret.ownerDigest });
  if (error || !Array.isArray(data) || data.length > 4 || data.some(value => !isTimestamp(value))) {
    throw new ServiceSessionStoreError('TOSS_RUN_PENDING_UNAVAILABLE');
  }
  return data as string[];
}

export async function finishTossCollectorRun(scope: ServiceSessionOwnerScope, run: Extract<TossCollectorRunClaim, { claimed: true }>,
  receipt: { fetched: number; upserted: number; blocked: boolean; error: string | null; persisted: boolean; complete: boolean;
    diagnostics?: TossFailureDiagnostics | null }): Promise<boolean> {
  const secret = scopeSecret(scope);
  if (secret.serviceId !== 'toss_sharelink' || scope.kind !== 'web_session' || !UUID.test(run.runId)
    || !UUID.test(run.leaseToken) || !Number.isSafeInteger(run.leaseFence) || run.leaseFence < 1) throw new ServiceSessionStoreError('TOSS_RUN_SCOPE_INVALID');
  const { data, error } = await getSupabaseAdminClient().rpc('finish_toss_collector_run', {
    p_owner_digest: secret.ownerDigest, p_run_id: run.runId, p_lease_token: run.leaseToken, p_lease_fence: run.leaseFence,
    p_fetched: receipt.fetched, p_upserted: receipt.upserted, p_blocked: receipt.blocked, p_error: receipt.error,
    p_persisted: receipt.persisted, p_complete: receipt.complete,
    p_diagnostics: receipt.diagnostics == null ? null : projectTossFailureDiagnostics(receipt.diagnostics),
  });
  if (error || typeof record(data)?.saved !== 'boolean') throw new ServiceSessionStoreError('TOSS_RUN_FINISH_UNAVAILABLE');
  return record(data)!.saved === true;
}

/** Original Coupang RPCs and their argument shapes remain unchanged. */
async function sessionRpc(scope: ServiceSessionOwnerScope, name: string, args: RpcRecord) {
  const { serviceId } = scopeSecret(scope);
  return getSupabaseAdminClient().rpc(serviceId === SERVICE_SESSION_SERVICE ? name : `provider_${name}`,
    serviceId === SERVICE_SESSION_SERVICE ? args : { p_service_id: serviceId, ...args });
}

function parseMetadata(value: unknown): ServiceSessionMetadata {
  const row = record(value);
  const allowed = ['id', 'kind', 'status', 'revision', 'hasCredential', 'lastHealthAt', 'holdCode', 'leaseBusy'];
  if (!row || Object.keys(row).length !== allowed.length || Object.keys(row).some((key) => !allowed.includes(key))
    || !UUID.test(text(row.id)) || (row.kind !== 'web_session' && row.kind !== 'open_api')
    || !isStatus(row.status) || positiveInteger(row.revision) === null
    || typeof row.hasCredential !== 'boolean' || !isNullableTimestamp(row.lastHealthAt)
    || !isNullableHoldCode(row.holdCode) || typeof row.leaseBusy !== 'boolean') {
    throw new ServiceSessionStoreError('SERVICE_SESSION_METADATA_RESPONSE_INVALID');
  }
  const hasCredential = row.hasCredential;
  if ((row.status === 'unconfigured' && hasCredential) || (row.status === 'ready' && !hasCredential)
    || ((row.status === 'hold' || row.status === 'reauth_required') && !row.holdCode)
    || (row.status === 'ready' && row.holdCode)) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_METADATA_RESPONSE_INVALID');
  }
  return {
    id: text(row.id),
    kind: row.kind,
    status: row.status,
    revision: positiveInteger(row.revision) as number,
    hasCredential,
    lastHealthAt: row.lastHealthAt as string | null,
    holdCode: row.holdCode as ServiceSessionHoldCode | null,
    leaseBusy: row.leaseBusy,
  };
}

function validateLease(lease: ServiceSessionLease): void {
  if (!lease || !UUID.test(lease.token) || !Number.isSafeInteger(lease.fence) || lease.fence < 1
    || !Number.isSafeInteger(lease.revision) || lease.revision < 1 || !isTimestamp(lease.expiresAt)) {
    throw new ServiceSessionStoreError('SERVICE_SESSION_LEASE_INVALID');
  }
}

function parseAuthorizedUnknownLoginRetryClaim(
  scope: ServiceSessionOwnerScope,
  expectedRevision: number,
  value: unknown,
): ClaimedServiceSession {
  const row = record(value);
  const allowed = ['claimed', 'id', 'kind', 'status', 'revision', 'keyVersion', 'allowedOrigins', 'hasCredential',
    'ciphertext', 'nonce', 'authTag', 'lastHealthAt', 'holdCode', 'leaseToken', 'leaseFence', 'leaseExpiresAt'];
  if (!row || Object.keys(row).length !== allowed.length || Object.keys(row).some((key) => !allowed.includes(key))
    || row.claimed !== true || !UUID.test(text(row.id)) || row.kind !== 'web_session' || row.status !== 'hold'
    || positiveInteger(row.revision) !== expectedRevision || positiveInteger(row.keyVersion) !== SERVICE_SESSION_KEY_VERSION
    || !sameStrings(row.allowedOrigins, scope.allowedOrigins) || row.hasCredential !== false
    || row.ciphertext !== null || row.nonce !== null || row.authTag !== null
    || !isNullableTimestamp(row.lastHealthAt) || row.holdCode !== 'OWNER_ACTION_REQUIRED'
    || !UUID.test(text(row.leaseToken)) || positiveInteger(row.leaseFence) === null
    || !isTimestamp(row.leaseExpiresAt)) {
    throw new ServiceSessionStoreError('COUPANG_LOGIN_RETRY_CLAIM_RESPONSE_INVALID');
  }
  const metadata = parseMetadata({
    id: row.id, kind: row.kind, status: row.status, revision: row.revision,
    hasCredential: false, lastHealthAt: row.lastHealthAt, holdCode: row.holdCode, leaseBusy: true,
  });
  return {
    metadata,
    lease: makeLease({
      token: text(row.leaseToken),
      fence: positiveInteger(row.leaseFence) as number,
      expiresAt: text(row.leaseExpiresAt),
      revision: expectedRevision,
    }),
    credential: null,
  };
}

function isFreshHealthTimestamp(value: string): boolean {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= Date.now() + 30_000 && Date.now() - at <= 10 * 60_000;
}

function isVerifiedHealthEvidence(value: unknown): value is ServiceSessionHealthEvidence {
  const row = record(value);
  return Boolean(row && Object.keys(row).length === 3
    && row.outcome === 'verified' && row.ownerVerified === true && row.readOnly === true);
}

function isProductionVercelRuntime(): boolean {
  return process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production';
}

function record(value: unknown): RpcRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RpcRecord : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return value === null || typeof value === 'string' ? value : null;
}

function isNullableHoldCode(value: unknown): value is ServiceSessionHoldCode | null {
  return value === null || (typeof value === 'string' && HOLD_CODES.has(value as ServiceSessionHoldCode));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStatus(value: unknown): value is ServiceSessionStatus {
  return value === 'unconfigured' || value === 'ready' || value === 'hold'
    || value === 'reauth_required' || value === 'disabled';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sameStrings(actual: unknown, expected: readonly string[]): actual is string[] {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => typeof value === 'string' && value === expected[index]);
}
