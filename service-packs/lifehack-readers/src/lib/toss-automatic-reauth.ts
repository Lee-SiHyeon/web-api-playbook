import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { CookieJar } from 'tough-cookie';
import { getSupabaseAdminClient } from './supabase/admin';
import { deriveServiceSessionOwnerDigest } from './service-session-crypto';
import { readServiceSessionMetadata, type ServiceSessionOwnerScope } from './service-session-store';
import { TOSS_ORIGIN, TOSS_MEMBER_PATH, validateTossBundle, type TossSessionState } from './toss-session-core';
import { exportTossCookieJar } from './toss-cookie-jar';
import { tossRuntimeHttpFetch } from './toss-direct-http';
import { loginTossSharelinkHttp, continueTossHttpOAuth, completeApprovedTossLoginHttp, restoreTossHttpPendingContext,
  validateExpectedOwner, TossHttpLoginError, type TossHttpLoginPendingHandle, type TossPendingContext } from './toss-http-login-core';
import { storeTossHttpLoginSession } from './partner-native-session-runtime';
import { clearTossCookieRecovery } from './toss-session-recovery';
import { TOSS_LOGIN_ATTEMPTS_TABLE as TABLE, tossApprovalBinding, sealTossLoginContext, openTossLoginContext,
  tossPendingContextForStorage } from './toss-login-journal';

const KIND = 'TOSS_AUTOMATIC_REAUTH';
const COOLDOWN_MS = 15 * 60_000;
const WAIT_MS = 180_000;
type Dependencies = { fetchImpl?: typeof fetch; schedule?: (work: () => Promise<void>) => void;
  waitMs?: number; sleep?: (ms: number) => Promise<void>; ownerRequestedRetry?: boolean };
type Receipt = Record<string, unknown>;
function enabled() { return process.env.TOSS_AUTO_REAUTH_ENABLED === 'true'
  && process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production'; }
function identity(scope: ServiceSessionOwnerScope) {
  const email = process.env.TOSS_SHARELINK_OWNER_EMAIL?.trim().toLowerCase();
  if (!email || scope.serviceId !== 'toss_sharelink' || scope.kind !== 'web_session'
    || scope.allowedOrigins.length !== 1 || scope.allowedOrigins[0] !== TOSS_ORIGIN) throw Error('TOSS_OWNER_SCOPE_REQUIRED');
  return { email, digest: deriveServiceSessionOwnerDigest(email, 'toss_sharelink') };
}
function safeCode(error: unknown) {
  const code = error instanceof TossHttpLoginError ? error.metadata.code : error instanceof Error ? error.message : null;
  return typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'TOSS_AUTO_REAUTH_FAILED';
}
function receipt(code: string, extra: Receipt = {}): Receipt {
  return { kind: KIND, code, trigger: 'TWO_FACTOR_REQUIRED', flow: 'web_signin', ready: false, stored: false, ownerVerified: false, ...extra };
}

/** Only callers with queued collection work request a fresh login from the stable owner baseline. */
export async function requestConfiguredTossReauthentication(scope: ServiceSessionOwnerScope) {
  const metadata = await readServiceSessionMetadata(scope);
  if (metadata?.status !== 'reauth_required' || metadata.hasCredential) return { reauthRequested: false, reauthStatus: 'state_changed' };
  let expectedOwner: unknown;
  try { expectedOwner = JSON.parse(process.env.TOSS_AUTO_REAUTH_EXPECTED_OWNER ?? ''); }
  catch { return { reauthRequested: false, reauthStatus: 'configuration_required' }; }
  return requestTossAutomaticLogin(scope, expectedOwner, metadata.revision);
}
async function continueCollectionAfterApproval(scope: ServiceSessionOwnerScope) {
  if (process.env.TOSS_COLLECTION_ENABLED !== 'true') return;
  const { resumePendingTossCollections } = await import('./toss-collector-service');
  return resumePendingTossCollections(scope);
}
async function expire(digest: string) {
  const result = await getSupabaseAdminClient().from(TABLE).update({ status: 'rejected', encrypted_context: {}, updated_at: new Date().toISOString() })
    .eq('owner_digest', digest).lt('expires_at', new Date().toISOString()).in('status', ['starting', 'pending', 'completing']);
  if (result.error) throw Error('TOSS_AUTO_REAUTH_STORAGE_UNAVAILABLE');
}

/** Called only after a genuine provider second-factor response and a successful vault rejection CAS. */
export async function requestTossAutomaticReauth(scope: ServiceSessionOwnerScope, state: TossSessionState, revision: number,
  dependencies: Dependencies = {}) {
  if (!enabled()) return { reauthRequested: false, reauthStatus: 'disabled' };
  const { email } = identity(scope);
  if (state.ownerEmail !== email || state.provider !== 'toss_sharelink' || state.version !== 1) throw Error('TOSS_REAUTH_OWNER_MISMATCH');
  validateTossBundle(state.bundle);
  return requestTossAutomaticLogin(scope, state.bundle.expectedOwner, revision, dependencies);
}
async function requestTossAutomaticLogin(scope: ServiceSessionOwnerScope, expectedOwner: unknown, revision: number,
  dependencies: Dependencies = {}) {
  if (!enabled()) return { reauthRequested: false, reauthStatus: 'disabled' };
  if (!process.env.TOSS_AUTO_REAUTH_PASSWORD) return { reauthRequested: false, reauthStatus: 'configuration_required' };
  const { email, digest } = identity(scope), owner = validateExpectedOwner(expectedOwner);
  if (!owner) throw Error('TOSS_LOGIN_OWNER_BASELINE_INVALID');
  const metadata = await readServiceSessionMetadata(scope);
  if (!metadata || metadata.revision !== revision || metadata.hasCredential || metadata.status !== 'reauth_required') {
    return { reauthRequested: false, reauthStatus: 'state_changed' };
  }
  const db = getSupabaseAdminClient();
  await expire(digest);
  const recent = await db.from(TABLE).select('status,receipt,created_at').eq('owner_digest', digest)
    .eq('receipt->>kind', KIND).gt('created_at', new Date(Date.now() - COOLDOWN_MS).toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (recent.error) throw Error('TOSS_AUTO_REAUTH_STORAGE_UNAVAILABLE');
  if (recent.data && !dependencies.ownerRequestedRetry) return { reauthRequested: false,
    reauthStatus: ['starting', 'pending', 'completing'].includes(recent.data.status) ? 'pending' : 'cooldown' };
  const id = randomUUID(), pollClaim = randomUUID();
  const intent = await db.from(TABLE).insert({ id, owner_digest: digest, session_revision: revision, status: 'starting',
    encrypted_context: {}, receipt: receipt('TOSS_AUTO_REAUTH_STARTING'), expires_at: new Date(Date.now() + COOLDOWN_MS).toISOString() });
  // The database's owner-wide unique active index also excludes manual login attempts.
  if (intent.error) return { reauthRequested: false, reauthStatus: intent.error.code === '23505' ? 'pending' : 'unavailable' };
  let sourceRequests = 0, notificationSent = false;
  const fetchImpl: typeof fetch = (input, init) => { sourceRequests++; return (dependencies.fetchImpl ?? tossRuntimeHttpFetch)(input, init); };
  try {
    // The app-verify bridge proves identity but did not restore the business login.
    // Use the same web sign-in and MULTI_FACTOR session as the verified manual flow.
    const started = await loginTossSharelinkHttp({ email, password: process.env.TOSS_AUTO_REAUTH_PASSWORD,
      expectedOwner: owner, includeBrowserSessionCookie: true, fetchImpl });
    if (started.status === 'authenticated') {
      const saved = await storeTossHttpLoginSession(scope, email, revision, started.session, undefined, fetchImpl);
      const finished = await db.from(TABLE).update({ status: 'completed', encrypted_context: {},
        receipt: receipt('TOSS_AUTO_REAUTH_READY', { ...saved, sourceRequests, notificationSent: false, loginPostCount: 1, completionPostCount: 0 }) })
        .eq('id', id).eq('owner_digest', digest).eq('status', 'starting').select('id').single();
      if (finished.error || !finished.data) throw Error('TOSS_LOGIN_RECEIPT_SAVE_FAILED');
      await clearTossCookieRecovery().catch(() => {});
      await continueCollectionAfterApproval(scope).catch(() => {});
      return { reauthRequested: false, reauthStatus: 'ready', reauthSourceRequests: sourceRequests };
    }
    let pending = started.pending;
    if (started.action === 'oauth_binding') pending = await continueTossHttpOAuth(pending, { fetchImpl });
    else if (started.action !== 'two_factor') throw Error(started.code);
    notificationSent = true;
    const context = await tossPendingContextForStorage(pending);
    const saved = await db.from(TABLE).update({ status: 'pending', encrypted_context: sealTossLoginContext(context, digest, id),
      receipt: receipt('TOSS_APP_APPROVAL_REQUIRED', { notificationSent: true, sourceRequests, pollClaim,
        pollUntil: new Date(Date.now() + WAIT_MS + 60000).toISOString() }), expires_at: new Date(context.expiresAt).toISOString(),
      updated_at: new Date().toISOString() }).eq('id', id).eq('owner_digest', digest).eq('status', 'starting').select('id').single();
    if (saved.error || !saved.data) throw Error('TOSS_LOGIN_PENDING_SAVE_FAILED');
    try { schedulePoll(scope, { id, digest, email, revision, pending, pollClaim }, dependencies); }
    catch {
      // A durable pending request can be resumed by the approval-only cron.
      await db.from(TABLE).update({ receipt: receipt('TOSS_APP_APPROVAL_PENDING', { notificationSent: true, sourceRequests,
        pollClaim, pollUntil: new Date(0).toISOString() }) }).eq('id', id).eq('owner_digest', digest).eq('status', 'pending');
    }
    return { reauthRequested: true, reauthStatus: 'pending', reauthSourceRequests: sourceRequests };
  } catch (error) {
    const code = safeCode(error);
    await db.from(TABLE).update({ status: 'needs_reconciliation', receipt: receipt(code, { sourceRequests, notificationSent }), updated_at: new Date().toISOString() })
      .eq('id', id).eq('owner_digest', digest).in('status', ['starting', 'pending']);
    return { reauthRequested: notificationSent, reauthStatus: 'unavailable', reauthErrorCode: code, reauthSourceRequests: sourceRequests };
  }
}

type Poll = { id: string; digest: string; email: string; revision: number; pending: TossHttpLoginPendingHandle; pollClaim: string };
function schedulePoll(scope: ServiceSessionOwnerScope, poll: Poll, dependencies: Dependencies) {
  (dependencies.schedule ?? after)(() => pollApproval(scope, poll, dependencies));
}
async function pollApproval(scope: ServiceSessionOwnerScope, poll: Poll, dependencies: Dependencies) {
  const db = getSupabaseAdminClient(), { id, digest, pollClaim } = poll;
  const fetchImpl = dependencies.fetchImpl ?? tossRuntimeHttpFetch;
  const until = Date.now() + (dependencies.waitMs ?? WAIT_MS);
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let completionClaimed = false;
  const update = (value: object, status: string) => db.from(TABLE).update({ ...value, updated_at: new Date().toISOString() })
    .eq('id', id).eq('owner_digest', digest).eq('status', status).eq('receipt->>pollClaim', pollClaim);
  try {
    while (true) {
      const current = await readServiceSessionMetadata(scope);
      if (!current || current.revision !== poll.revision || current.status !== 'reauth_required' || current.hasCredential) {
        await update({ status: 'rejected', encrypted_context: {}, receipt: receipt('TOSS_AUTO_REAUTH_STATE_CHANGED') }, 'pending'); return;
      }
      const completed = await completeApprovedTossLoginHttp(poll.pending, { binding: tossApprovalBinding, fetchImpl,
        completionEncoding: 'multipart', authorizationWaitMs: 30000,
        beforeCompletion: async () => {
          const claimed = await update({ status: 'completing' }, 'pending').gt('expires_at', new Date().toISOString()).select('id').single();
          if (claimed.error || !claimed.data) throw Error('TOSS_LOGIN_ALREADY_CLAIMED');
          completionClaimed = true;
        },
        onCompletionResponse: async (context, observation) => {
          const saved = await update({ encrypted_context: sealTossLoginContext({ ...context, cookieJar: context.cookieJar.serializeSync(),
            continuationUrl: context.continuationUrl?.href ?? null }, digest, id),
          receipt: receipt('TOSS_LOGIN_COMPLETION_RESPONSE', { ...observation, pollClaim, notificationSent: true }) }, 'completing').select('id').single();
          if (saved.error || !saved.data) throw Error('TOSS_LOGIN_COMPLETION_CONTEXT_SAVE_FAILED');
        } });
      if (completed.status === 'approval_pending') {
        if (Date.now() >= until) {
          await update({ receipt: receipt('TOSS_APP_APPROVAL_PENDING', { notificationSent: true, pollClaim,
            pollUntil: new Date(0).toISOString() }) }, 'pending'); return;
        }
        await sleep(Math.min(3000, Math.max(0, until - Date.now()))); continue;
      }
      const saved = await storeTossHttpLoginSession(scope, poll.email, poll.revision, completed.session, undefined, fetchImpl);
      const finished = await update({ status: 'completed', encrypted_context: {}, receipt: receipt('TOSS_AUTO_REAUTH_READY', {
        ...saved, notificationSent: true, completionPostCount: 1, loginPostCount: completed.loginPostCount }) }, 'completing').select('id').single();
      if (finished.error || !finished.data) throw Error('TOSS_LOGIN_RECEIPT_SAVE_FAILED');
      await clearTossCookieRecovery().catch(() => {});
      const collection = await continueCollectionAfterApproval(scope).catch(error => ({ status: 'unavailable', error: safeCode(error) }));
      if (collection) await db.from(TABLE).update({ receipt: receipt('TOSS_AUTO_REAUTH_READY', { ...saved,
        notificationSent: true, completionPostCount: 1, loginPostCount: completed.loginPostCount, collection }) })
        .eq('id', id).eq('owner_digest', digest).eq('status', 'completed');
      return;
    }
  } catch (error) {
    if (safeCode(error) === 'TOSS_LOGIN_ALREADY_CLAIMED') return;
    const terminal = ['TOSS_LOGIN_APPROVAL_NOT_AGREED', 'TOSS_LOGIN_PENDING_EXPIRED'].includes(safeCode(error));
    await update({ status: terminal ? 'rejected' : 'needs_reconciliation', ...(terminal ? { encrypted_context: {} } : {}),
      receipt: receipt(safeCode(error), { ...(error instanceof TossHttpLoginError ? { diagnostics: error.toJSON() } : {}),
        notificationSent: true, completionReserved: completionClaimed,
        completionPostSent: error instanceof TossHttpLoginError && error.metadata.completionPostSent === true }) }, completionClaimed ? 'completing' : 'pending');
  }
}

export async function readTossAutomaticReauthStatus(scope: ServiceSessionOwnerScope) {
  const { digest } = identity(scope);
  const metadata = await readServiceSessionMetadata(scope); // Validate the process-owned authorization scope before journal access.
  const found = await getSupabaseAdminClient().from(TABLE).select('status,receipt,created_at,expires_at')
    .eq('owner_digest', digest).eq('receipt->>kind', KIND).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (found.error) throw Error('TOSS_AUTO_REAUTH_STORAGE_UNAVAILABLE');
  const row = found.data;
  const ready = metadata?.status === 'ready' && metadata.hasCredential;
  return { code: 'TOSS_AUTO_REAUTH_STATE', enabled: enabled(), passwordConfigured: !!process.env.TOSS_AUTO_REAUTH_PASSWORD, status: row?.status ?? 'none',
    createdAt: row?.created_at ?? null, expiresAt: row?.expires_at ?? null,
    expired: row ? Date.parse(row.expires_at) <= Date.now() : false,
    notificationSent: row?.receipt?.notificationSent === true, ready, sessionStatus: metadata?.status ?? 'unconfigured',
    sessionRevision: metadata?.revision ?? null, ownerVerified: ready,
    resultCode: typeof row?.receipt?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(row.receipt.code) ? row.receipt.code : null };
}

/** Explicit owner retry starts a new login; it never repeats an uncertain completion POST. */
export async function retryTossAutomaticReauth(scope: ServiceSessionOwnerScope, expectedOwner?: unknown) {
  const { digest, email } = identity(scope), metadata = await readServiceSessionMetadata(scope);
  if (!metadata || metadata.status !== 'reauth_required' || metadata.hasCredential) return { code: 'TOSS_REAUTH_RETRY_NOT_ELIGIBLE' };
  // Owner identifiers are an expected identity, never authentication material.
  // A new password login and app approval are still required. Expired cookies
  // or approval contexts are not loaded when the owner supplies this baseline.
  if (expectedOwner !== undefined) return { code: 'TOSS_REAUTH_RETRY',
    ...await requestTossAutomaticLogin(scope, expectedOwner, metadata.revision, { ownerRequestedRetry: true }) };
  const found = await getSupabaseAdminClient().from(TABLE).select('id,encrypted_context,created_at,session_revision')
    .eq('owner_digest', digest).eq('receipt->>kind', KIND).eq('status', 'needs_reconciliation')
    .eq('session_revision', metadata.revision).gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (found.error || !found.data) return { code: 'TOSS_REAUTH_RETRY_NOT_ELIGIBLE' };
  const context = openTossLoginContext(found.data.encrypted_context, digest, found.data.id);
  const jar = CookieJar.deserializeSync(context.cookieJar);
  const bundle = validateTossBundle({ version: 1, service: 'toss-sharelink', allowedOrigin: TOSS_ORIGIN,
    capturedAt: found.data.created_at, cookies: exportTossCookieJar(jar), expectedOwner: context.expectedOwner,
    readRequests: { member: { method: 'GET', url: TOSS_ORIGIN + TOSS_MEMBER_PATH } } });
  try {
    return { code: 'TOSS_REAUTH_RETRY', ...await requestTossAutomaticReauth(scope, {
      version: 1, provider: 'toss_sharelink', ownerEmail: email, bundle,
    }, metadata.revision, { ownerRequestedRetry: true }) };
  } finally { jar.removeAllCookiesSync(); for (const cookie of bundle.cookies) cookie.value = ''; }
}

/** A repeated refresh must not advance the source revision of an approval already in flight. */
export async function hasPendingTossAutomaticReauth(scope: ServiceSessionOwnerScope): Promise<boolean> {
  if (!enabled()) return false;
  const { digest } = identity(scope);
  await readServiceSessionMetadata(scope);
  const found = await getSupabaseAdminClient().from(TABLE).select('id').eq('owner_digest', digest)
    .eq('receipt->>kind', KIND).in('status', ['starting', 'pending', 'completing'])
    .gt('expires_at', new Date().toISOString()).limit(1).maybeSingle();
  if (found.error) throw Error('TOSS_AUTO_REAUTH_STORAGE_UNAVAILABLE');
  return found.data !== null;
}

/** Resume only a previously requested approval. This cannot send another notification. */
export async function resumeTossAutomaticReauth(scope: ServiceSessionOwnerScope, dependencies: Dependencies = {}) {
  if (!enabled()) return { code: 'TOSS_AUTO_REAUTH_DISABLED', resumed: false };
  const { digest, email } = identity(scope), db = getSupabaseAdminClient();
  await readServiceSessionMetadata(scope);
  await expire(digest);
  const found = await db.from(TABLE).select('id,encrypted_context,receipt,session_revision')
    .eq('owner_digest', digest).eq('status', 'pending').eq('receipt->>kind', KIND)
    .gt('expires_at', new Date().toISOString()).lte('receipt->>pollUntil', new Date().toISOString()).limit(1).maybeSingle();
  if (found.error) throw Error('TOSS_AUTO_REAUTH_STORAGE_UNAVAILABLE');
  if (!found.data) return { code: 'TOSS_AUTO_REAUTH_IDLE', resumed: false };
  const row = found.data, pollClaim = randomUUID();
  const claimed = await db.from(TABLE).update({ receipt: { ...row.receipt, pollClaim,
    pollUntil: new Date(Date.now() + WAIT_MS + 60000).toISOString() } }).eq('id', row.id).eq('owner_digest', digest)
    .eq('status', 'pending').eq('receipt->>pollClaim', row.receipt.pollClaim).select('id').single();
  if (claimed.error || !claimed.data) return { code: 'TOSS_AUTO_REAUTH_BUSY', resumed: false };
  try {
    const context = openTossLoginContext(row.encrypted_context, digest, row.id);
    const pending = restoreTossHttpPendingContext({ ...context, cookieJar: CookieJar.deserializeSync(context.cookieJar),
      continuationUrl: new URL(context.continuationUrl) } as TossPendingContext);
    schedulePoll(scope, { id: row.id, digest, email, revision: row.session_revision, pending, pollClaim }, dependencies);
    return { code: 'TOSS_AUTO_REAUTH_RESUMED', resumed: true };
  } catch (error) {
    await db.from(TABLE).update({ status: 'needs_reconciliation', receipt: receipt(safeCode(error)), updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('owner_digest', digest).eq('status', 'pending').eq('receipt->>pollClaim', pollClaim);
    return { code: safeCode(error), resumed: false };
  }
}
