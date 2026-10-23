import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../affiliate-api-hub/adapters/web-auth-provider.mjs';
import { loadTikTokSession, storeTikTokSessionState, TIKTOK_ORIGIN, TIKTOK_OWNER_HANDLE } from './lib/tiktok-auth-session.mjs';

const ENVELOPE_STORE = 'tiktok-post-envelope-v1';
const READ_ENVELOPE_STORE = 'tiktok-owner-list-envelope-v1';
const OWNER_LIST_PATH = '/tiktok/creator/manage/item_list/v1/';
const POST_PATH = '/tiktok/web/project/post/v1/';
const MAX_AGE_MS = 120_000;
const HEADER_NAMES = new Set(['accept', 'content-type', 'origin', 'referer', 'user-agent',
  'tt-ticket-guard-client-data', 'tt-ticket-guard-iteration-version', 'tt-ticket-guard-public-key',
  'tt-ticket-guard-version', 'tt-ticket-guard-web-version']);
const SIGNED_QUERY = ['msToken', 'X-Bogus', 'X-Gnarly'];
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeError = error => /^TIKTOK_[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'TIKTOK_OPERATION_FAILED';
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 60) : [];

async function runtime() {
  const root = webApiPlaybookRoot();
  const [{ ProtectedStore }, { ScopedSession }] = await Promise.all([
    import(pathToFileURL(path.join(root, 'lib/protected-store.mjs')).href),
    import(pathToFileURL(path.join(root, 'lib/scoped-session.mjs')).href),
  ]);
  return { store: new ProtectedStore(), ScopedSession };
}

export function validateTikTokEnvelope(envelope, { now = Date.now(), requireClosed = true } = {}) {
  if (envelope?.version !== 1 || envelope.ownerHandle !== TIKTOK_OWNER_HANDLE
    || envelope.origin !== TIKTOK_ORIGIN || envelope.browserWriteBlocked !== true
    || envelope.blockedReason !== 'inspector' || envelope.responseReceived !== false) fail('TIKTOK_ENVELOPE_PROVENANCE_INVALID');
  const age = now - Date.parse(envelope.observedAt);
  if (!Number.isFinite(age) || age < -5_000 || age > MAX_AGE_MS) fail('TIKTOK_ENVELOPE_STALE');
  if (requireClosed && envelope.helperClosed !== true) fail('TIKTOK_HELPER_NOT_CLOSED');
  const request = envelope.request;
  let url;
  try { url = new URL(request?.url); } catch { fail('TIKTOK_POST_URL_INVALID'); }
  if (request.method !== 'POST' || url.origin !== TIKTOK_ORIGIN || url.pathname !== POST_PATH
    || url.username || url.password || url.hash) fail('TIKTOK_POST_URL_INVALID');
  for (const name of SIGNED_QUERY) if (!url.searchParams.get(name) || url.searchParams.getAll(name).length !== 1) fail('TIKTOK_SIGNED_INPUT_MISSING');
  if (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 64 * 1024) fail('TIKTOK_POST_BODY_INVALID');
  let body;
  try { body = JSON.parse(request.body); } catch { fail('TIKTOK_POST_BODY_INVALID'); }
  if (!Array.isArray(body.feature_common_info_list) || body.feature_common_info_list.length !== 1
    || !Array.isArray(body.single_post_req_list) || body.single_post_req_list.length !== 1
    || typeof body.post_common_info?.creation_id !== 'string') fail('TIKTOK_POST_BODY_INVALID');
  const feature = body.feature_common_info_list[0];
  const post = body.single_post_req_list[0];
  const visibilityIntent = envelope.visibilityIntent ?? 'private';
  if (!['private', 'public'].includes(visibilityIntent)) fail('TIKTOK_VISIBILITY_INTENT_INVALID');
  const visibilityType = visibilityIntent === 'public' ? 0 : 1;
  if (feature.privacy_setting_info?.visibility_type !== visibilityType || feature.schedule_time) {
    fail('TIKTOK_VISIBILITY_INTENT_MISMATCH');
  }
  if (visibilityIntent === 'public' && (feature.aigc_info?.aigc_label_type !== 1
    || typeof feature.tcm_params !== 'string' || !feature.tcm_params)) fail('TIKTOK_PUBLIC_DISCLOSURES_MISSING');
  if (typeof post.video_id !== 'string' || !post.video_id || typeof post.single_post_feature_info?.text !== 'string'
    || post.single_post_feature_info.text.length > 4000) fail('TIKTOK_POST_BODY_INVALID');
  const headers = {};
  if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) fail('TIKTOK_POST_HEADERS_INVALID');
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAMES.has(name) || Object.hasOwn(headers, name) || typeof value !== 'string'
      || /[\r\n\0]/.test(value) || value.length > 32_768) fail('TIKTOK_POST_HEADERS_INVALID');
    headers[name] = value;
  }
  for (const name of ['tt-ticket-guard-client-data', 'tt-ticket-guard-public-key', 'tt-ticket-guard-version']) {
    if (!headers[name]) fail('TIKTOK_SIGNED_INPUT_MISSING');
  }
  let signingData;
  try { signingData = JSON.parse(Buffer.from(headers['tt-ticket-guard-client-data'], 'base64').toString('utf8')); }
  catch { fail('TIKTOK_SIGNED_INPUT_INVALID'); }
  const signedAt = Number(signingData.timestamp) * 1000;
  // TikTok's live SDK reused its own signing timestamp on a fresh blocked request.
  // Freshness applies to the observed envelope; do not invent a server signature TTL.
  if (!Number.isFinite(signedAt) || signedAt <= 0 || signedAt - now > 5_000
    || !signingData.req_sign || !signingData.ts_sign) fail('TIKTOK_SIGNED_INPUT_INVALID');
  if (!/^application\/json(?:;|$)/i.test(headers['content-type'] || '')) fail('TIKTOK_POST_HEADERS_INVALID');
  if (headers.origin !== TIKTOK_ORIGIN || headers.referer !== TIKTOK_ORIGIN + '/tiktokstudio/upload') fail('TIKTOK_POST_HEADERS_INVALID');
  return { body, headers, caption: post.single_post_feature_info.text, videoId: post.video_id,
    captionSha256: sha(post.single_post_feature_info.text), requestSha256: sha(request.body),
    visibilityIntent, visibilityType, executionMode: 'browser_assisted_http' };
}

export async function stageTikTokEnvelope(envelope) {
  const checked = validateTikTokEnvelope(envelope, { requireClosed: false });
  const { store } = await runtime();
  const receipt = store.write(ENVELOPE_STORE, JSON.stringify(envelope));
  if (!receipt.persistent) fail('TIKTOK_DPAPI_REQUIRED');
  return { staged: true, provider: receipt.provider, ownerHandle: TIKTOK_OWNER_HANDLE,
    visibilityIntent: checked.visibilityIntent, browserWriteBlocked: true, helperClosed: envelope.helperClosed === true };
}

export async function markTikTokEnvelopeHelperClosed() {
  const { store } = await runtime();
  let envelope;
  try { envelope = JSON.parse(store.read(ENVELOPE_STORE)); } catch { fail('TIKTOK_ENVELOPE_MISSING'); }
  validateTikTokEnvelope(envelope, { requireClosed: false });
  store.write(ENVELOPE_STORE, JSON.stringify({ ...envelope, helperClosed: true }));
  return { helperClosed: true };
}

export function validateTikTokOwnerListEnvelope(envelope, { now = Date.now() } = {}) {
  if (envelope?.version !== 1 || envelope.ownerHandle !== TIKTOK_OWNER_HANDLE
    || envelope.origin !== TIKTOK_ORIGIN || envelope.responseStatus !== 200
    || envelope.helperClosed !== true) fail('TIKTOK_OWNER_READ_PROVENANCE_INVALID');
  const age = now - Date.parse(envelope.observedAt);
  if (!Number.isFinite(age) || age < -5000 || age > MAX_AGE_MS) fail('TIKTOK_OWNER_READ_STALE');
  const request = envelope.request;
  let url, body;
  if (typeof request?.body !== 'string' || Buffer.byteLength(request.body) > 8192) fail('TIKTOK_OWNER_READ_INVALID');
  try { url = new URL(request.url); body = JSON.parse(request.body); } catch { fail('TIKTOK_OWNER_READ_INVALID'); }
  if (url.origin !== TIKTOK_ORIGIN || url.pathname !== OWNER_LIST_PATH || request.method !== 'POST'
    || url.username || url.password || url.hash || body.cursor !== 0 || body.size !== 50
    || !Array.isArray(body.query?.conditions) || body.query.conditions.length !== 0) fail('TIKTOK_OWNER_READ_INVALID');
  for (const name of SIGNED_QUERY) if (!url.searchParams.get(name) || url.searchParams.getAll(name).length !== 1) fail('TIKTOK_SIGNED_INPUT_MISSING');
  const allowed = new Set(['accept', 'content-type', 'origin', 'referer', 'user-agent', 'agw-js-conv',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'tt-csrf-token']);
  const headers = {};
  if (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers)) fail('TIKTOK_OWNER_READ_HEADERS_INVALID');
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name) || Object.hasOwn(headers, name) || typeof value !== 'string'
      || /[\r\n\0]/.test(value) || value.length > 8192) fail('TIKTOK_OWNER_READ_HEADERS_INVALID');
    headers[name] = value;
  }
  if (!headers['tt-csrf-token'] || !/^application\/json(?:;|$)/i.test(headers['content-type'] || '')
    || headers.origin !== TIKTOK_ORIGIN) fail('TIKTOK_OWNER_READ_HEADERS_INVALID');
  let referer;
  try { referer = new URL(headers.referer); } catch { fail('TIKTOK_OWNER_READ_HEADERS_INVALID'); }
  if (referer.origin !== TIKTOK_ORIGIN || referer.pathname !== '/tiktokstudio/content'
    || referer.username || referer.password || referer.hash) fail('TIKTOK_OWNER_READ_HEADERS_INVALID');
  return { headers };
}

export async function stageTikTokOwnerListEnvelope(envelope) {
  validateTikTokOwnerListEnvelope(envelope);
  const { store } = await runtime();
  const receipt = store.write(READ_ENVELOPE_STORE, JSON.stringify(envelope));
  if (!receipt.persistent || receipt.provider !== 'Windows DPAPI CurrentUser') fail('TIKTOK_DPAPI_REQUIRED');
  return { staged: true, operation: 'owner_post_list', provider: receipt.provider, helperClosed: true };
}

function journalPath(idempotencyKey) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(idempotencyKey || '')) fail('TIKTOK_IDEMPOTENCY_KEY_INVALID');
  if (!process.env.LOCALAPPDATA) fail('TIKTOK_JOURNAL_DIRECTORY_MISSING');
  return path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations', 'tiktok-publish', idempotencyKey + '.json');
}

async function saveJournal(file, journal) {
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function reserveTikTokRequest(directory, requestSha256, idempotencyKey) {
  if (!/^[a-f0-9]{64}$/.test(requestSha256) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(idempotencyKey || '')) fail('TIKTOK_RESERVATION_INVALID');
  const reservations = path.join(directory, 'request-reservations');
  await fs.mkdir(reservations, { recursive: true });
  let handle;
  try { handle = await fs.open(path.join(reservations, requestSha256 + '.json'), 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('TIKTOK_ENVELOPE_ALREADY_RESERVED'); throw error; }
  try { await handle.writeFile(JSON.stringify({ version: 1, idempotencyKey, requestSha256,
    ownerHandle: TIKTOK_OWNER_HANDLE, reservedAt: new Date().toISOString() }) + '\n'); }
  finally { await handle.close(); }
}

export function applyTikTokReadback(journal, readback, checkedAt = new Date().toISOString()) {
  // An expired read envelope must not erase a previously verified publication receipt.
  if (!readback.readbackVerified && ['published_private_verified', 'published_public_verified'].includes(journal.state)
    && journal.readback?.readbackVerified) {
    return { ...journal, lastRecheck: { checkedAt, ...readback }, freshReadback: false };
  }
  const { lastRecheck: _previousRecheck, ...previous } = journal;
  return { ...previous, readback, checkedAt, freshReadback: readback.readbackVerified === true,
    ...(readback.readbackVerified ? { verifiedAt: checkedAt } : {}),
    state: readback.readbackVerified
      ? (previous.visibilityIntent === 'public' ? 'published_public_verified' : 'published_private_verified')
      : 'needs_reconciliation' };
}

function decode(result) {
  if (result.status !== 200 || !/json/i.test(result.headers?.['content-type'] || '')) fail('TIKTOK_HTTP_RESPONSE_INVALID');
  let body;
  try { body = JSON.parse(result.raw); } catch { fail('TIKTOK_RESPONSE_NOT_JSON'); }
  return body;
}

async function verifiedSession() {
  const loaded = await loadTikTokSession();
  const response = await loaded.session.request(TIKTOK_ORIGIN + '/api/v1/user/profile/upload/');
  const data = decode(response);
  if (data.status_code !== 0 || data.user?.unique_id !== TIKTOK_OWNER_HANDLE) fail('TIKTOK_OWNER_NOT_VERIFIED');
  await storeTikTokSessionState(loaded.session);
  return loaded;
}

export async function readTikTokItem(itemId, { expectedCaptionSha256, visibilityIntent = 'private' } = {}) {
  if (!/^\d{10,30}$/.test(itemId || '')) fail('TIKTOK_ITEM_ID_INVALID');
  if (!['private', 'public'].includes(visibilityIntent)) fail('TIKTOK_VISIBILITY_INTENT_INVALID');
  const { store, ScopedSession } = await runtime();
  let envelope;
  try { envelope = JSON.parse(store.read(READ_ENVELOPE_STORE)); } catch { fail('TIKTOK_OWNER_READ_ENVELOPE_MISSING'); }
  const { headers } = validateTikTokOwnerListEnvelope(envelope);
  const loaded = await verifiedSession();
  validateTikTokOwnerListEnvelope(envelope);
  const original = loaded.session.toJSON();
  const readSession = ScopedSession.fromJSON({ ...original,
    headersByOrigin: { ...original.headersByOrigin, [TIKTOK_ORIGIN]: headers } });
  const response = await readSession.request(envelope.request.url, { method: 'POST', body: envelope.request.body });
  const data = decode(response);
  const item = Array.isArray(data.item_list) ? data.item_list.find(row => row.item_id === itemId) : null;
  const ownerVerified = true; // Same protected session verified immediately before this owner-only list.
  const idVerified = item?.item_id === itemId;
  const captionVerified = typeof item?.desc === 'string' && !!expectedCaptionSha256 && sha(item.desc) === expectedCaptionSha256;
  // First-party owner-list contract: private draft rows use 2. Public visibility 0
  // is admitted only for a separately approved and captured public publish intent.
  const expectedVisibility = visibilityIntent === 'public' ? 0 : 2;
  const visibilityVerified = item?.visibility === expectedVisibility;
  const serviceStatus = data.statusCode ?? data.status_code ?? null;
  const rotated = readSession.toJSON();
  await storeTikTokSessionState(ScopedSession.fromJSON({ ...rotated, headersByOrigin: original.headersByOrigin }));
  return {
    source: OWNER_LIST_PATH,
    httpStatus: response.status, serviceStatus,
    rootKeys: keys(data), itemKeys: keys(item), ownerVerified, idVerified, captionVerified,
    privateVerified: visibilityIntent === 'private' && visibilityVerified,
    publicVerified: visibilityIntent === 'public' && visibilityVerified,
    visibilityVerified,
    privacySignals: { visibility: item?.visibility ?? null, expectedVisibility, visibilityIntent },
    itemStatus: item?.status ?? null, inReview: item?.in_review ?? null,
    durationMs: item?.duration ?? null, playableSources: item?.play_addr?.length ?? 0,
    readbackVerified: serviceStatus === 0 && ownerVerified && idVerified && captionVerified && visibilityVerified,
  };
}

export async function reconcileTikTokPublish({ idempotencyKey } = {}) {
  const file = journalPath(idempotencyKey);
  let journal;
  try { journal = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('TIKTOK_JOURNAL_MISSING'); }
  if (journal.ownerHandle !== TIKTOK_OWNER_HANDLE) fail('TIKTOK_JOURNAL_OWNER_INVALID');
  if (!journal.itemId) return { state: journal.state, writeCount: journal.writeCount, needsReconciliation: true,
    code: 'TIKTOK_ITEM_ID_NOT_RETURNED', journalPath: file };
  let readback;
  try { readback = await readTikTokItem(journal.itemId, { expectedCaptionSha256: journal.captionSha256,
    visibilityIntent: journal.visibilityIntent ?? 'private' }); }
  catch (error) { readback = { readbackVerified: false, code: safeError(error) }; }
  journal = applyTikTokReadback(journal, readback);
  await saveJournal(file, journal);
  return { state: journal.state, itemId: journal.itemId, url: `${TIKTOK_ORIGIN}/@${TIKTOK_OWNER_HANDLE}/video/${journal.itemId}`,
    visibilityIntent: journal.visibilityIntent ?? 'private', writeCount: journal.writeCount, readback: journal.readback, journalPath: file,
    checkedAt: journal.checkedAt, freshReadback: journal.freshReadback,
    ...(journal.lastRecheck ? { lastRecheck: journal.lastRecheck } : {}),
    executionMode: 'browser_assisted_http', remnantFree: false, transportRemnantFree: true };
}

export async function publishCapturedTikTok({ idempotencyKey, expectedCaption, visibilityIntent = 'private', brandedTermsConsent = false } = {}) {
  if (typeof expectedCaption !== 'string' || !expectedCaption) fail('TIKTOK_EXPECTED_CAPTION_REQUIRED');
  if (!['private', 'public'].includes(visibilityIntent)) fail('TIKTOK_VISIBILITY_INTENT_INVALID');
  if (visibilityIntent === 'public' && brandedTermsConsent !== true) fail('TIKTOK_PUBLIC_TERMS_CONSENT_REQUIRED');
  const file = journalPath(idempotencyKey);
  try {
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    if (previous.captionSha256 !== sha(expectedCaption)) fail('TIKTOK_IDEMPOTENCY_CONTENT_MISMATCH');
    if (previous.ownerHandle !== TIKTOK_OWNER_HANDLE) fail('TIKTOK_JOURNAL_OWNER_INVALID');
    if (['published_private_verified', 'published_public_verified'].includes(previous.state)) return {
      state: previous.state, itemId: previous.itemId,
      url: `${TIKTOK_ORIGIN}/@${TIKTOK_OWNER_HANDLE}/video/${previous.itemId}`,
      visibilityIntent: previous.visibilityIntent ?? 'private', writeCount: previous.writeCount, readback: previous.readback,
      checkedAt: previous.checkedAt, alreadyCompleted: true, freshReadback: false, journalPath: file,
      executionMode: 'browser_assisted_http', remnantFree: false, transportRemnantFree: true,
    };
    return await reconcileTikTokPublish({ idempotencyKey });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { store, ScopedSession } = await runtime();
  let envelope;
  try { envelope = JSON.parse(store.read(ENVELOPE_STORE)); } catch { fail('TIKTOK_ENVELOPE_MISSING'); }
  const checked = validateTikTokEnvelope(envelope);
  if (checked.visibilityIntent !== visibilityIntent) fail('TIKTOK_VISIBILITY_INTENT_MISMATCH');
  if (checked.caption !== expectedCaption) fail('TIKTOK_ENVELOPE_CONTENT_MISMATCH');
  const loaded = await verifiedSession();
  validateTikTokEnvelope(envelope);
  const original = loaded.session.toJSON();
  const requestSession = ScopedSession.fromJSON({ ...original,
    headersByOrigin: { ...original.headersByOrigin, [TIKTOK_ORIGIN]: checked.headers } });
  let journal = { version: 1, idempotencyKey, ownerHandle: TIKTOK_OWNER_HANDLE,
    captionSha256: checked.captionSha256, requestSha256: checked.requestSha256,
    visibilityIntent, visibility: checked.visibilityType, brandedTermsConsent: visibilityIntent === 'public',
    aiDisclosureCaptured: checked.body.feature_common_info_list[0]?.aigc_info?.aigc_label_type === 1,
    state: 'prepared', writeCount: 0, createdAt: new Date().toISOString(),
    browserWriteBlocked: true, helperClosed: true, executionMode: 'browser_assisted_http' };
  await fs.mkdir(path.dirname(file), { recursive: true });
  // The request claim is atomic across different idempotency keys and processes.
  // Keep it even on interruption: uncertain writes must be reconciled, never resent.
  await reserveTikTokRequest(path.dirname(file), checked.requestSha256, idempotencyKey);
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(JSON.stringify(journal, null, 2) + '\n'); } finally { await handle.close(); }
  store.write(ENVELOPE_STORE, JSON.stringify({ version: 1, consumed: true, idempotencyKey, consumedAt: new Date().toISOString() }));
  journal.state = 'sending';
  journal.writeCount = 1;
  journal.sentAt = new Date().toISOString();
  await saveJournal(file, journal);
  let response;
  try {
    response = await requestSession.request(envelope.request.url, { method: 'POST', body: envelope.request.body });
  } catch (error) {
    journal.state = 'needs_reconciliation'; journal.code = safeError(error);
    await saveJournal(file, journal);
    return { state: journal.state, code: journal.code, writeCount: 1, journalPath: file };
  }
  journal.httpStatus = response.status;
  journal.responseMime = response.headers['content-type']?.split(';')[0] || null;
  let data;
  try { data = decode(response); } catch {
    journal.state = 'needs_reconciliation'; journal.code = 'TIKTOK_POST_RESPONSE_UNCONFIRMED';
    await saveJournal(file, journal); return { state: journal.state, code: journal.code, httpStatus: response.status, writeCount: 1, journalPath: file };
  }
  journal.serviceStatus = data.status_code ?? data.statusCode ?? null;
  journal.responseKeys = keys(data);
  const itemId = data.single_post_resp_list?.[0]?.item_id;
  if (journal.serviceStatus !== 0 || typeof itemId !== 'string' || !/^\d{10,30}$/.test(itemId)) {
    journal.state = journal.serviceStatus !== null && journal.serviceStatus !== 0 ? 'rejected' : 'needs_reconciliation';
    await saveJournal(file, journal);
    return { state: journal.state, httpStatus: response.status, serviceStatus: journal.serviceStatus,
      responseKeys: journal.responseKeys, writeCount: 1, journalPath: file };
  }
  journal.itemId = String(itemId);
  journal.projectId = String(data.project_id || '');
  journal.state = 'submitted';
  await saveJournal(file, journal);
  try {
    const rotated = requestSession.toJSON();
    await storeTikTokSessionState(ScopedSession.fromJSON({ ...rotated, headersByOrigin: original.headersByOrigin }));
  } catch (error) {
    journal.sessionRotationCode = safeError(error);
    await saveJournal(file, journal);
  }
  return reconcileTikTokPublish({ idempotencyKey });
}

export const tiktokPublishCapabilities = Object.freeze({
  privateCapturedPublication: true, approvedPublicCapturedPublication: true, directHttpSubmission: true, independentItemReadback: true,
  directMediaUpload: false, automaticSignatureIssuance: false, publicPublication: 'fresh-browser-observed-request-only',
  executionMode: 'browser_assisted_http', maxEnvelopeAgeMs: MAX_AGE_MS,
  ownerReadbackLimit: 50, retries: 0, unattendedReady: false,
});
