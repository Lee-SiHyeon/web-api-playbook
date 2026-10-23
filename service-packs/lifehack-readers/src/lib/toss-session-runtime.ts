import { clearNativeHandoffMaterial, exactKeys, record } from './native-handoff-envelope';
import { TOSS_ORIGIN, TossSessionClient, TossSessionError, issueTossLinkOnce, tossErrorCode,
  tossFailureDiagnostics, tossHoldsSession, tossNeedsSecondFactor, tossId, tossShareUrl, tossStopsSession, validateTossBundle, warnTossFailure,
  type TossLinkJournal, type TossLinkRecord, type TossSessionState } from './toss-session-core';
import { collectTossCurations, enrichTossDetail, toTossHubItem, tossDeliveryShape, withTossDelivery, TOSS_DELIVERY_REUSE_MS, TOSS_DETAIL_CAP,
  TOSS_DETAIL_RESERVE, TOSS_LINK_CAP, orderTossDetailReads, type TossObservation } from './hub/collectors/toss-sharelink';
import type { HubItem } from './hub/types';
import { getSupabaseAdminClient } from './supabase/admin';
import { renewTossHttpSession } from './toss-session-renewal';
import { diagnoseTossWebSession } from './toss-web-session-diagnostics';
import { tossRuntimeHttpFetch } from './toss-direct-http';
import { clearTossCookieRecovery, loadTossCookieRecovery, saveTossCookieRecovery } from './toss-session-recovery';
import { requestTossAutomaticReauth, hasPendingTossAutomaticReauth } from './toss-automatic-reauth';
import { casWriteServiceSession, claimServiceSession, createCronServiceSessionOwnerScope, readServiceSessionMetadata,
  releaseServiceSessionLease, tossSharelinkJournalRpc, verifyServiceSessionCredential,
  type ClaimedServiceSession, type ServiceSessionOwnerScope } from './service-session-store';

export interface TossRuntimeCollection {
  items: HubItem[]; fetched: number; complete: boolean; errors: string[];
  sourceRequests: number; issued: number; skipped: number;
}
interface PriorTossDelivery { sellerName: string | null; feeKrw: number; freeThresholdKrw: number | null; readAt: string }
/** Delivery facts this collector stored for these items within TOSS_DELIVERY_REUSE_MS (hub_items.facts.toss). A failed read
 * only means every item is treated as unread. */
export async function loadPriorTossDelivery(ids: string[], now = Date.now(), staleOut?: Set<string>): Promise<Map<string, PriorTossDelivery>> {
  const out = new Map<string, PriorTossDelivery>();
  try {
    const db = getSupabaseAdminClient();
    for (let i = 0; i < ids.length && i < 2000; i += 100) {
      const { data, error } = await db.from('hub_items').select('id,facts').eq('source', 'toss').in('id', ids.slice(i, i + 100).map(id => 'toss:' + id));
      if (error || !Array.isArray(data)) break;
      for (const row of data as Array<{ id: string; facts: unknown }>) {
        const t = record(record(row.facts)?.toss);
        const fee = t?.displayedShippingFeeKrw, readAt = t?.shippingReadAt, threshold = t?.freeShippingThresholdKrw;
        if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 0 || typeof readAt !== 'string') continue;
        const age = now - Date.parse(readAt);
        if (!(age >= 0 && age <= TOSS_DELIVERY_REUSE_MS)) { staleOut?.add(String(row.id).replace(/^toss:/, '')); continue; }
        out.set(String(row.id).replace(/^toss:/, ''), { sellerName: typeof t?.sellerName === 'string' ? t.sellerName : null, feeKrw: fee,
          freeThresholdKrw: typeof threshold === 'number' && Number.isSafeInteger(threshold) && threshold > 0 ? threshold : null, readAt });
      }
    }
  } catch { /* reuse is an optimization */ }
  return out;
}
function parseState(bytes: Buffer): TossSessionState {
  let state: Record<string, unknown> | null;
  try { state = record(JSON.parse(bytes.toString('utf8'))); } catch { throw new TossSessionError('TOSS_STATE_INVALID'); }
  const owner = process.env.TOSS_SHARELINK_OWNER_EMAIL?.trim().toLowerCase();
  if (!state || !exactKeys(state, ['version', 'provider', 'ownerEmail', 'bundle']) || state.version !== 1
    || state.provider !== 'toss_sharelink' || !owner || state.ownerEmail !== owner) throw new TossSessionError('TOSS_STATE_INVALID');
  validateTossBundle(state.bundle);
  return state as unknown as TossSessionState;
}
function assertScope(scope: ServiceSessionOwnerScope): void {
  if (scope.serviceId !== 'toss_sharelink' || scope.kind !== 'web_session' || scope.allowedOrigins.length !== 1
    || scope.allowedOrigins[0] !== TOSS_ORIGIN) throw new TossSessionError('TOSS_REQUEST_SCOPE_REJECTED');
}
class VaultTossJournal implements TossLinkJournal {
  constructor(private scope: ServiceSessionOwnerScope, private claim: ClaimedServiceSession) {}
  async lookup(ids: string[]): Promise<Map<string, TossLinkRecord>> {
    const found = new Map<string, TossLinkRecord>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500), result = await tossSharelinkJournalRpc(this.scope, this.claim, 'lookup', batch);
      if (!Array.isArray(result) || result.length > batch.length) throw new TossSessionError('TOSS_JOURNAL_RESPONSE_INVALID');
      for (const raw of result) {
        const row = record(raw), id = tossId(row?.id);
        if (!id || !batch.includes(id) || !row) throw new TossSessionError('TOSS_JOURNAL_RESPONSE_INVALID');
        found.set(id, this.parse({ ...row, created: false }));
      }
    }
    return found;
  }
  async reserve(id: string): Promise<TossLinkRecord> {
    return this.parse(await tossSharelinkJournalRpc(this.scope, this.claim, 'reserve', [id]));
  }
  async finish(id: string, state: TossLinkRecord['state'], url: string | null): Promise<void> {
    const response = record(await tossSharelinkJournalRpc(this.scope, this.claim, 'finish', [id], state, url));
    if (response?.saved !== true) throw new TossSessionError('TOSS_JOURNAL_SAVE_FAILED');
  }
  private parse(value: unknown): TossLinkRecord {
    const row = record(value);
    if (!row || !['intent', 'issued', 'needs_reconciliation', 'rejected'].includes(String(row.state))
      || typeof row.created !== 'boolean' || (row.state === 'issued' ? !tossShareUrl(row.shortUrl) : row.shortUrl !== null)) {
      throw new TossSessionError('TOSS_JOURNAL_RESPONSE_INVALID');
    }
    return { state: row.state as TossLinkRecord['state'], shortUrl: row.shortUrl as string | null, created: row.created };
  }
}
/** Only the captured first issued-links page is used. Absence never clears an intent or authorizes a resend. */
async function readExistingLinks(client: TossSessionClient): Promise<Map<string, string>> {
  const body = await client.read(`${TOSS_ORIGIN}/api-public/v3/shopping/sharelink/issued-links?size=20`);
  const data = record(body.success)?.data;
  if (!Array.isArray(data) || data.length > 200) throw new TossSessionError('TOSS_RESPONSE_INVALID');
  const links = new Map<string, string>();
  for (const raw of data) {
    const row = record(raw), id = tossId(row?.tacaItemId), url = tossShareUrl(row?.shortUrl);
    if (id && url) links.set(id, url);
  }
  return links;
}
async function persistVerifiedState(scope: ServiceSessionOwnerScope, claim: ClaimedServiceSession,
  state: TossSessionState, stats = { sourceRequests: 0 }, fetchImpl?: typeof fetch): Promise<void> {
  // A new independent verifier also respects pacing relative to the preceding collection request.
  await new Promise(resolve => setTimeout(resolve, 400));
  const candidate = Buffer.from(JSON.stringify(state)), updated = { bytes: null as Buffer | null };
  let failure: TossSessionError | null = null;
  try {
    const proof = await verifyServiceSessionCredential(scope, candidate, async (bytes, accept) => {
      let checked: TossSessionState | null = null;
      try {
        checked = parseState(bytes);
        const client = new TossSessionClient(checked.bundle, { ...(fetchImpl ? { fetchImpl } : {}), maxRequests: 1, deadline: Date.now() + 15_000 });
        try { await client.verifyOwner(); } finally { stats.sourceRequests += client.sourceRequests; }
        updated.bytes = Buffer.from(JSON.stringify(checked));
        if (!accept) throw new TossSessionError('TOSS_HEALTH_PROOF_REQUIRED');
        accept(updated.bytes);
        return { outcome: 'verified', ownerVerified: true, readOnly: true };
      } catch (error) { failure = error instanceof TossSessionError ? error : new TossSessionError(tossErrorCode(error)); throw error; }
      finally {
        // A failing final read may rotate cookies too. Preserve that candidate
        // for quarantine before the verifier clears its private working copy.
        if (checked) state.bundle = structuredClone(checked.bundle);
        clearNativeHandoffMaterial(checked);
      }
    });
    if (!updated.bytes || !await casWriteServiceSession({ scope, lease: claim.lease, status: 'ready', credential: updated.bytes, healthProof: proof })) {
      throw new TossSessionError('TOSS_SESSION_PERSIST_FAILED');
    }
  } catch (error) { if (failure) throw failure; throw error; }
  finally { candidate.fill(0); updated.bytes?.fill(0); }
}
async function markRejected(scope: ServiceSessionOwnerScope, claim: ClaimedServiceSession, error: unknown,
  state: TossSessionState | null, recoveryExpiresAt?: number, fetchImpl?: typeof fetch): Promise<{
    recoveryRetained?: true; recoverySaveFailed?: true; sessionStateUnchanged?: true;
    sessionRetained?: true;
    reauthRequested?: boolean; reauthStatus?: string; reauthSourceRequests?: number; reauthErrorCode?: string;
  }> {
  // A rejected product query is not evidence that the login expired. Retain
  // response cookie rotations only after a fresh independent owner check.
  if (state && error instanceof TossSessionError && error.code === 'TOSS_HTTP_FAILED'
    && error.diagnostics.phase === 'read' && error.diagnostics.httpStatus === 400) {
    try { await persistVerifiedState(scope, claim, state, { sourceRequests: 0 }, fetchImpl); return { sessionRetained: true }; }
    catch { /* Preserve the existing fail-closed path if owner health cannot be verified. */ }
  }
  const code = tossErrorCode(error);
  let recoveryRetained = false;
  if (tossNeedsSecondFactor(error)) {
    const candidate = state ? Buffer.from(JSON.stringify(state)) : null;
    try {
      recoveryRetained = candidate !== null && await saveTossCookieRecovery(candidate, claim.lease.revision + 1,
        recoveryExpiresAt).catch(() => false);
    } finally { candidate?.fill(0); }
    // The provider rejected this operation, so the caller still stops. A failed
    // quarantine write must not destroy the only encrypted copy of a session
    // which can still be valid in its previously authenticated execution context.
    if (!recoveryRetained) return { recoverySaveFailed: true, sessionStateUnchanged: true };
  }
  const throttled = code === 'TOSS_THROTTLED';
  const hold = tossHoldsSession(code);
  const saved = await casWriteServiceSession({ scope, lease: claim.lease, status: throttled || hold ? 'hold' : 'reauth_required',
    holdCode: throttled ? 'RATE_LIMITED' : hold ? 'HEALTH_CHECK_FAILED' : code === 'TOSS_OWNER_MISMATCH' ? 'OWNER_ACTION_REQUIRED' : 'SOURCE_AUTH_REJECTED' });
  if (!saved) throw new TossSessionError('TOSS_SESSION_PERSIST_FAILED');
  const reauth = recoveryRetained && state && tossNeedsSecondFactor(error)
    ? await requestTossAutomaticReauth(scope, state, saved.revision, { fetchImpl })
      .catch(() => ({ reauthRequested: false, reauthStatus: 'unavailable' })) : {};
  return { ...(recoveryRetained ? { recoveryRetained: true as const } : {}), ...reauth };
}
/** Caller holds the persistent collector job; this separately claims the provider vault for the entire batch. */
export async function collectTossFromVercel(scope: ServiceSessionOwnerScope): Promise<TossRuntimeCollection> {
  assertScope(scope);
  const metadata = await readServiceSessionMetadata(scope);
  if (metadata?.status !== 'ready' || !metadata.hasCredential) throw new TossSessionError(metadata?.status === 'hold' ? 'TOSS_SESSION_HOLD' : 'TOSS_REAUTH_REQUIRED');
  const claim = await claimServiceSession(scope, metadata.revision, 300);
  if (!claim) throw new TossSessionError('TOSS_SESSION_BUSY');
  let state: TossSessionState | null = null;
  try {
    if (!claim.credential) throw new TossSessionError('TOSS_REAUTH_REQUIRED');
    state = await claim.credential.withBytes(parseState);
    const client = new TossSessionClient(state.bundle);
    await client.verifyOwner();
    const collection = await collectTossCurations(client);
    const errors = new Set(collection.errors);
    const stop = collection.errors.find(tossStopsSession);
    if (stop) throw new TossSessionError(stop);
    const journal = new VaultTossJournal(scope, claim);
    const records = await journal.lookup(collection.products.map(p => p.id));
    const links = new Map<string, string>();
    for (const [id, entry] of records) if (entry.state === 'issued' && entry.shortUrl) links.set(id, entry.shortUrl);
    const missing = collection.products.filter(p => !links.has(p.id) && p.linkAvailable !== false);
    if (missing.length) {
      try {
        for (const [id, url] of await readExistingLinks(client)) {
          if (!missing.some(p => p.id === id)) continue;
          await journal.reserve(id);
          await journal.finish(id, 'issued', url);
          links.set(id, url);
        }
      } catch (error) {
        const code = tossErrorCode(error);
        if (tossStopsSession(code)) throw error;
        errors.add(code);
      }
    }
    let issued = 0, attempts = 0;
    for (const item of missing) {
      if (links.has(item.id) || records.has(item.id)) continue;
      if (attempts >= TOSS_LINK_CAP) break;
      attempts++;
      try {
        client.assertRequestCapacity(); // Do not reserve a never-sendable intent when a read exhausted the budget.
        links.set(item.id, await issueTossLinkOnce(client, journal, item.id)); issued++;
      }
      catch (error) {
        const code = tossErrorCode(error); errors.add(code);
        if (tossStopsSession(code)) throw error;
        if (['TOSS_TIME_LIMIT', 'TOSS_REQUEST_LIMIT', 'TOSS_ISSUE_OUTCOME_UNKNOWN'].includes(code)) break;
      }
    }
    const items: HubItem[] = [];
    // Delivery facts read in the last 24 h are reused, so the detail reads (TOSS_DETAIL_CAP per run) move on to unread items
    // instead of re-reading the first ones every run. Detail reads are enrichment: running out of budget stops them quietly.
    const linked = collection.products.filter(p => links.has(p.id));
    const stale = new Set<string>();
    const prior = await loadPriorTossDelivery(linked.map(p => p.id), Date.now(), stale);
    const enriched = new Map<string, TossObservation>();
    for (const p of linked) {
      const known = prior.get(p.id);
      if (known) enriched.set(p.id, withTossDelivery({ ...p, facts: { ...p.facts, sellerName: p.facts.sellerName ?? known.sellerName } },
        known.feeKrw, known.freeThresholdKrw, known.readAt));
    }
    let details = 0, shapesLogged = 0;
    // Never-read, likely-posted items first; the rest rotate per half-hour slot (see orderTossDetailReads).
    for (const p of orderTossDetailReads(linked.filter(p => !enriched.has(p.id)), stale)) {
      if (details >= TOSS_DETAIL_CAP) break;
      if (!client.hasCapacity(TOSS_DETAIL_RESERVE, 20_000)) break;
      details++;
      try {
        const body = await client.read(`${TOSS_ORIGIN}/api-public/v3/shopping/sharelink/v2/products/${p.id}`);
        const detail = record(body.success);
        // Field discovery (2026-10-18): the delivery part of the first reads, keys and short scalar values only.
        if (detail && shapesLogged < 3 && process.env.NODE_ENV !== 'test') { shapesLogged++; console.info('[hub-toss] detail delivery shape', JSON.stringify(tossDeliveryShape(detail))); }
        enriched.set(p.id, enrichTossDetail(p, body));
      }
      catch (error) { const code = tossErrorCode(error); errors.add(code); if (tossStopsSession(code)) throw error; }
    }
    for (const p of linked) items.push(toTossHubItem(enriched.get(p.id) ?? p, links.get(p.id)!));
    const skipped = collection.products.length - items.length;
    if (skipped) errors.add('TOSS_LINK_COVERAGE_PARTIAL');
    await persistVerifiedState(scope, claim, state);
    return { items, fetched: collection.fetched, complete: collection.complete && errors.size === 0,
      errors: [...errors], sourceRequests: client.sourceRequests + 1, issued, skipped };
  } catch (error) {
    const code = tossErrorCode(error);
    if (tossStopsSession(code) || code === 'TOSS_COOKIE_SCOPE_REJECTED') {
      await markRejected(scope, claim, error, state).catch(warnTossFailure); // A failed status write must not hide the provider's answer.
    }
    throw error;
  } finally {
    clearNativeHandoffMaterial(state); claim.credential?.destroy();
    await releaseServiceSessionLease(scope, claim.lease).catch(() => false);
  }
}
export async function refreshTossSessionFromVercelCron(request: Request) {
  const scope = createCronServiceSessionOwnerScope(request, { serviceId: 'toss_sharelink', kind: 'web_session', allowedOrigins: [TOSS_ORIGIN] });
  if (!scope) return { status: 'configuration_required', sourceRequests: 0, errorCode: 'TOSS_OWNER_SCOPE_REQUIRED' };
  if (process.env.TOSS_SESSION_AUTO_REFRESH_ENABLED !== 'true') return {
    status: 'hold', sourceRequests: 0, errorCode: null, automaticRefreshEnabled: false,
  };
  const metadata = await readServiceSessionMetadata(scope);
  // Interactive login is eligible only while no verified credential is stored.
  // A cron must never consume its recovery candidate and advance that login's
  // source revision during the user's app-approval wait.
  if (metadata?.status !== 'ready' || !metadata.hasCredential) return {
    status: metadata?.status === 'hold' ? 'hold' : 'reauth_required', sourceRequests: 0,
    errorCode: metadata?.status === 'hold' ? null : 'TOSS_REAUTH_REQUIRED',
  };
  return refreshTossSessionFromVercel(scope, metadata.revision);
}

/** Owner-triggered diagnosis never writes a ready/rejected status or submits a provider mutation. */
export async function diagnoseTossSessionFromVercel(scope: ServiceSessionOwnerScope, fetchImpl: typeof fetch = tossRuntimeHttpFetch) {
  assertScope(scope);
  const metadata = await readServiceSessionMetadata(scope);
  const recovery = metadata?.status === 'reauth_required' && !metadata.hasCredential
    ? await loadTossCookieRecovery(metadata.revision).catch(() => null) : null;
  if (!metadata || !metadata.hasCredential && !recovery) return { code: 'TOSS_DIAGNOSIS_SESSION_UNAVAILABLE',
    ready: false, stored: false, ownerVerified: false, sourceRequests: 0, sessionStateChanged: false };
  const claim = await claimServiceSession(scope, metadata.revision, 45);
  if (!claim) { recovery?.bytes.fill(0); return { code: 'TOSS_SESSION_BUSY', ready: false, ownerVerified: false, sourceRequests: 0 }; }
  let state: TossSessionState | null = null;
  try {
    if (!claim.credential && !recovery) throw new TossSessionError('TOSS_REAUTH_REQUIRED');
    state = claim.credential ? await claim.credential.withBytes(parseState) : parseState(recovery!.bytes);
    const diagnosis = await diagnoseTossWebSession(state.bundle, fetchImpl);
    return { code: 'TOSS_SESSION_DIAGNOSIS', ...diagnosis, ready: metadata.status === 'ready' && diagnosis.ownerVerified,
      stored: metadata.hasCredential, revision: metadata.revision, recoveryCandidateUsed: !!recovery };
  } finally {
    recovery?.bytes.fill(0); clearNativeHandoffMaterial(state); claim.credential?.destroy();
    await releaseServiceSessionLease(scope, claim.lease).catch(() => false);
  }
}

export async function refreshTossSessionFromVercel(scope: ServiceSessionOwnerScope, expectedRevision?: number, fetchImpl?: typeof fetch) {
  assertScope(scope);
  const metadata = await readServiceSessionMetadata(scope);
  if (expectedRevision !== undefined && metadata?.revision !== expectedRevision) return { status: 'unavailable', sourceRequests: 0,
    errorCode: 'TOSS_SESSION_OBSERVATION_CHANGED' };
  if (metadata?.status === 'reauth_required' && !metadata.hasCredential && await hasPendingTossAutomaticReauth(scope)) {
    return { status: 'busy', sourceRequests: 0, errorCode: null, reauthRequested: false, reauthStatus: 'pending' };
  }
  const recovery = metadata?.status === 'reauth_required' && !metadata.hasCredential
    ? await loadTossCookieRecovery(metadata.revision).catch(() => null) : null;
  if (!recovery && (metadata?.status !== 'ready' || !metadata.hasCredential)) return { status: metadata?.status === 'hold' ? 'hold' : 'reauth_required', sourceRequests: 0,
    errorCode: metadata?.status === 'hold' ? 'TOSS_SESSION_HOLD' : 'TOSS_REAUTH_REQUIRED' };
  const claim = await claimServiceSession(scope, metadata!.revision, 60);
  if (!claim) { recovery?.bytes.fill(0); return { status: 'busy', sourceRequests: 0, errorCode: null }; }
  let state: TossSessionState | null = null;
  const stats = { sourceRequests: 0 };
  try {
    if (!claim.credential && !recovery) throw new TossSessionError('TOSS_REAUTH_REQUIRED');
    state = claim.credential ? await claim.credential.withBytes(parseState) : parseState(recovery!.bytes);
    recovery?.bytes.fill(0);
    const renewed = await renewTossHttpSession(state.bundle, fetchImpl, candidate => { state!.bundle = candidate; });
    state.bundle = renewed.bundle;
    stats.sourceRequests += renewed.sourceRequests;
    await persistVerifiedState(scope, claim, state, stats, fetchImpl);
    await clearTossCookieRecovery().catch(() => {});
    return { status: 'ready', sourceRequests: stats.sourceRequests, errorCode: null,
      cookiesRotated: renewed.cookiesRotated, cookieExpiryExtended: renewed.cookieExpiryExtended,
      renewalKind: renewed.cookiesRotated ? 'cookies_rotated' : renewed.cookieExpiryExtended ? 'expiry_extended' : 'sso_revalidated' };
  } catch (error) {
    if (error && typeof error === 'object' && 'sourceRequests' in error && typeof error.sourceRequests === 'number') stats.sourceRequests += error.sourceRequests;
    const code = tossErrorCode(error);
    const diagnostics = tossFailureDiagnostics(error);
    // A durable health receipt contains only the same closed fields as the HTTP receipt/runtime warning.
    await Promise.resolve(getSupabaseAdminClient().from('hub_collector_runs').insert({
      source: 'health:toss_sharelink', fetched: 0, upserted: 0, blocked: true, error: code, diagnostics,
    })).catch(() => null);
    const retained = tossStopsSession(code) ? await markRejected(scope, claim, error, state, recovery?.expiresAt, fetchImpl)
      .catch(failure => { warnTossFailure(failure); return {}; }) : {};
    return { status: tossHoldsSession(code) ? 'hold' : 'unavailable', sourceRequests: stats.sourceRequests, errorCode: code, ...diagnostics,
      ...retained };
  } finally {
    recovery?.bytes.fill(0); clearNativeHandoffMaterial(state); claim.credential?.destroy();
    await releaseServiceSessionLease(scope, claim.lease).catch(() => false);
  }
}

/** Issuance for a persisted Toss catalog identity. Existing intents are never resubmitted. */
export async function issueTossCatalogLinkFromVercel(scope: ServiceSessionOwnerScope, id: string) {
  assertScope(scope);
  if (!tossId(id)) throw new TossSessionError('TOSS_INPUT_INVALID');
  const db = getSupabaseAdminClient();
  const product = await db.from('hub_items').select('id,kind,category,title,store,price_krw,shipping_note,image_url,source,source_url,affiliate_url,target_url,posted_at,expires_at,comments,votes,tags,summary,ended,observed_at,updated_at,facts')
    .eq('id', 'toss:' + id).eq('source', 'toss').maybeSingle();
  if (product.error || !product.data) throw new TossSessionError('TOSS_CATALOG_TARGET_REQUIRED');
  const metadata = await readServiceSessionMetadata(scope);
  if (metadata?.status !== 'ready' || !metadata.hasCredential) throw new TossSessionError('TOSS_REAUTH_REQUIRED');
  const claim = await claimServiceSession(scope, metadata.revision, 120);
  if (!claim) throw new TossSessionError('TOSS_SESSION_BUSY');
  let state: TossSessionState | null = null;
  try {
    if (!claim.credential) throw new TossSessionError('TOSS_REAUTH_REQUIRED');
    state = await claim.credential.withBytes(parseState);
    const client = new TossSessionClient(state.bundle, { maxRequests: 8, deadline: Date.now() + 45_000 });
    await client.verifyOwner();
    const journal = new VaultTossJournal(scope, claim);
    const beforeIssue = client.sourceRequests;
    const shortUrl = await issueTossLinkOnce(client, journal, id);
    const issuePostCount = client.sourceRequests - beforeIssue;
    const saved = await db.rpc('hub_upsert_items', { p_items: [{ ...product.data, affiliate_url: shortUrl }], p_writer: null });
    if (saved.error) throw new TossSessionError('TOSS_HUB_LINK_SAVE_FAILED');
    const readback = await db.from('hub_items').select('affiliate_url').eq('id', product.data.id).single();
    if (readback.error || readback.data?.affiliate_url !== shortUrl) throw new TossSessionError('TOSS_HUB_LINK_SAVE_FAILED');
    await persistVerifiedState(scope, claim, state);
    return { itemId: product.data.id, shortUrl, issued: issuePostCount === 1, cached: issuePostCount === 0, issuePostCount,
      stored: true, ownerVerified: true, sourceRequests: client.sourceRequests + 1 };
  } catch (error) {
    const code = tossErrorCode(error);
    if (tossStopsSession(code)) await markRejected(scope, claim, error, state).catch(warnTossFailure);
    throw error;
  } finally {
    clearNativeHandoffMaterial(state); claim.credential?.destroy();
    await releaseServiceSessionLease(scope, claim.lease).catch(() => false);
  }
}
