import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { webApiPlaybookRoot } from '../affiliate-api-hub/adapters/web-auth-provider.mjs';
import { loadMetaSession, metaCookieHeader, rotateMetaCookies } from '../naver-blog-api/scripts/meta-auth-session.mjs';
import { readInstagramProfile, readInstagramPosts } from './instagram-reader.mjs';
import { withSessionLock as withFileLock } from '../tistory-api/lib/lock.mjs';

const ORIGIN = 'https://www.instagram.com';
const OWNER = 'lifehack__ailab';
const STORE = 'instagram-native-publish-v1';
const JOURNAL_ROOT = path.join(os.homedir(), '.config', 'affiliate-content-operations', 'instagram-native-journal');
const PAGE_LIMIT = 12;
const MAX_READBACK_PAGES = 20;
const MAX_CAPTION_LENGTH = 2200;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const HEADERS = new Set(['accept', 'content-type', 'referer', 'origin', 'user-agent', 'x-asbd-id',
  'x-csrftoken', 'x-ig-app-id', 'x-ig-max-touch-points', 'x-ig-www-claim', 'x-instagram-ajax',
  'x-requested-with', 'x-web-session-id', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);

async function createProtectedStore() {
  const { ProtectedStore } = await import(pathToFileURL(path.join(webApiPlaybookRoot(), 'lib', 'protected-store.mjs')).href);
  return new ProtectedStore();
}

async function resolveStore(dependencies) {
  return dependencies.storeProvider ? dependencies.storeProvider() : createProtectedStore();
}

export function validateNativeInstagram(envelope, { now = Date.now() } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('INSTAGRAM_NATIVE_PROVENANCE_INVALID');
  const age = now - Date.parse(envelope.observedAt);
  if (envelope.version !== 1 || envelope.owner !== OWNER || envelope.helperClosed !== true
    || envelope.browserWriteBlocked !== true || envelope.blockedReason !== 'inspector'
    || envelope.responseReceived !== false || !Number.isFinite(age) || age < -5000 || age > 120000) {
    fail('INSTAGRAM_NATIVE_PROVENANCE_INVALID');
  }

  let url;
  try { url = new URL(envelope.request?.url); } catch { fail('INSTAGRAM_NATIVE_REQUEST_INVALID'); }
  if (envelope.request.method !== 'POST' || url.origin !== ORIGIN
    || url.pathname !== '/api/v1/media/configure_to_clips/' || url.search || url.hash
    || typeof envelope.request.body !== 'string' || Buffer.byteLength(envelope.request.body) > 65536) {
    fail('INSTAGRAM_NATIVE_REQUEST_INVALID');
  }

  const form = new URLSearchParams(envelope.request.body);
  const requiredFields = new Set(['archive_only', 'caption', 'clips_share_preview_to_feed', 'disable_comments',
    'disable_oa_reuse', 'gen_ai_detection_method', 'igtv_share_preview_to_feed', 'is_gen_ai_self_disclosure',
    'is_unified_video', 'like_and_view_counts_disabled', 'media_share_flow', 'share_to_facebook',
    'share_to_fb_destination_type', 'source_type', 'upload_id', 'video_subtitles_enabled', 'jazoest', 'fb_dtsg']);
  if (form.size !== requiredFields.size || [...form.keys()].some(key => !requiredFields.has(key)
    || form.getAll(key).length !== 1) || [...requiredFields].some(key => !form.has(key))) {
    fail('INSTAGRAM_NATIVE_CONTENT_INVALID');
  }
  const expectedValues = {
    archive_only: 'false',
    clips_share_preview_to_feed: '1',
    disable_comments: '0',
    disable_oa_reuse: 'false',
    gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW',
    igtv_share_preview_to_feed: '1',
    is_gen_ai_self_disclosure: 'true',
    is_unified_video: '1',
    like_and_view_counts_disabled: '0',
    media_share_flow: 'creation_flow',
    share_to_facebook: '',
    share_to_fb_destination_type: 'USER',
    source_type: 'library',
    video_subtitles_enabled: '0',
  };
  if (typeof envelope.expectedCaption !== 'string' || envelope.expectedCaption.length > MAX_CAPTION_LENGTH
    || form.get('caption') !== envelope.expectedCaption
    || Object.entries(expectedValues).some(([key, value]) => form.get(key) !== value)
    || !/^\d{10,20}$/.test(form.get('upload_id') || '')
    || !/^\d{1,12}$/.test(form.get('jazoest') || '')
    || typeof form.get('fb_dtsg') !== 'string' || !form.get('fb_dtsg') || form.get('fb_dtsg').length > 8192
    || /[\x00-\x20\x7f]/.test(form.get('fb_dtsg'))
    || !/^[a-f0-9]{64}$/.test(envelope.assetSha256 || '')) {
    fail('INSTAGRAM_NATIVE_CONTENT_INVALID');
  }

  const headers = {};
  for (const [name, value] of Object.entries(envelope.request.headers || {})) {
    const normalized = name.toLowerCase();
    if (!HEADERS.has(normalized) || Object.hasOwn(headers, normalized) || typeof value !== 'string'
      || /[\r\n\0]/.test(value) || value.length > 16384) fail('INSTAGRAM_NATIVE_HEADERS_INVALID');
    headers[normalized] = value;
  }
  let referer;
  try { referer = new URL(headers.referer); } catch { fail('INSTAGRAM_NATIVE_HEADERS_INVALID'); }
  if (headers.origin !== ORIGIN || referer.origin !== ORIGIN
    || !headers['x-csrftoken'] || !headers['x-ig-app-id'] || !headers['x-asbd-id']
    || !headers['x-instagram-ajax'] || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(headers['content-type'] || '')) {
    fail('INSTAGRAM_NATIVE_HEADERS_INVALID');
  }
  return { form, headers };
}

function assertPersistentStoreReceipt(receipt, code) {
  if (!receipt || receipt.persistent !== true || receipt.provider !== 'Windows DPAPI CurrentUser') fail(code);
}

export async function stageNativeInstagram(envelope, dependencies = {}) {
  validateNativeInstagram(envelope);
  const protectedStore = await resolveStore(dependencies);
  const priorRaw = protectedStore.read(STORE);
  if (priorRaw != null) {
    let prior;
    try { prior = JSON.parse(priorRaw); } catch { fail('INSTAGRAM_NATIVE_ENVELOPE_INVALID'); }
    if (prior?.consumed !== true) fail('INSTAGRAM_NATIVE_ENVELOPE_ALREADY_STAGED');
  }
  const receipt = protectedStore.write(STORE, JSON.stringify(envelope));
  assertPersistentStoreReceipt(receipt, 'INSTAGRAM_NATIVE_DPAPI_REQUIRED');
  return { staged: true, helperClosed: true };
}

function journalFileFor(key, journalRoot = JOURNAL_ROOT) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key || '')) fail('INSTAGRAM_NATIVE_JOB_INVALID');
  return path.join(journalRoot, key + '.json');
}

async function saveJournal(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}

function validateJournal(record, idempotencyKey) {
  if (!record || record.version !== 1 || record.idempotencyKey !== idempotencyKey || record.owner !== OWNER
    || !/^[a-f0-9]{64}$/.test(record.assetSha256 || '') || !/^[a-f0-9]{64}$/.test(record.captionSha256 || '')
    || !/^[a-f0-9]{64}$/.test(record.requestSha256 || '') || record.writeCount !== 1
    || typeof record.state !== 'string') fail('INSTAGRAM_NATIVE_JOURNAL_INVALID');
}

async function readExistingJournal(file, idempotencyKey, { assetSha256, expectedCaption }) {
  let bytes;
  try { bytes = await fs.readFile(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; fail('INSTAGRAM_NATIVE_JOURNAL_INVALID'); }
  if (bytes.length > 65536) fail('INSTAGRAM_NATIVE_JOURNAL_INVALID');
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { fail('INSTAGRAM_NATIVE_JOURNAL_INVALID'); }
  validateJournal(record, idempotencyKey);
  if (record.assetSha256 !== assetSha256 || record.captionSha256 !== hash(expectedCaption)) {
    fail('INSTAGRAM_NATIVE_CONTENT_MISMATCH');
  }
  return record;
}

function sessionCsrf(bundle) {
  return bundle?.cookies?.find(cookie => cookie.name === 'csrftoken')?.value || '';
}

async function sendNativeInstagramLocked({ idempotencyKey, assetSha256, expectedCaption } = {}, dependencies = {}) {
  if (!/^[a-f0-9]{64}$/.test(assetSha256 || '') || typeof expectedCaption !== 'string'
    || expectedCaption.length > MAX_CAPTION_LENGTH) fail('INSTAGRAM_NATIVE_CONTENT_INVALID');
  const file = journalFileFor(idempotencyKey, dependencies.journalRoot || JOURNAL_ROOT);
  const previous = await readExistingJournal(file, idempotencyKey, { assetSha256, expectedCaption });
  if (previous) return { ...previous, alreadyAttempted: true, retrySent: false, journalPath: file };

  const protectedStore = await resolveStore(dependencies);
  let envelope;
  try { envelope = JSON.parse(protectedStore.read(STORE)); } catch { fail('INSTAGRAM_NATIVE_ENVELOPE_MISSING'); }
  const contract = validateNativeInstagram(envelope);
  if (envelope.assetSha256 !== assetSha256 || envelope.expectedCaption !== expectedCaption) {
    fail('INSTAGRAM_NATIVE_CONTENT_MISMATCH');
  }
  const readProfile = dependencies.readProfile || readInstagramProfile;
  const owner = await readProfile({ handle: OWNER });
  if (owner.profile?.username?.toLowerCase() !== OWNER) fail('INSTAGRAM_NATIVE_OWNER_MISMATCH');
  const loadSession = dependencies.loadSession || loadMetaSession;
  const bundle = loadSession('instagram');
  if (bundle.owner !== OWNER || bundle.origin !== ORIGIN || bundle.service !== 'instagram') {
    fail('INSTAGRAM_NATIVE_OWNER_MISMATCH');
  }
  if (contract.headers['x-csrftoken'] !== sessionCsrf(bundle)) fail('INSTAGRAM_NATIVE_SESSION_MISMATCH');
  const scopedCookie = metaCookieHeader(bundle, envelope.request.url);
  if (!scopedCookie) fail('META_REAUTH_REQUIRED');

  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const requestSha256 = hash(envelope.request.body);
  const requestFingerprint = path.join(path.dirname(file), 'request-' + requestSha256 + '.json');
  try {
    await fs.writeFile(requestFingerprint, JSON.stringify({ idempotencyKey, requestSha256 }) + '\n',
      { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('INSTAGRAM_NATIVE_DUPLICATE_REQUEST');
    throw error;
  }

  const record = { version: 1, idempotencyKey, owner: OWNER, assetSha256, captionSha256: hash(expectedCaption),
    requestSha256, state: 'sending', writeCount: 1, executionMode: 'browser_assisted_http', helperClosed: true,
    browserWriteBlocked: true, sentAt: new Date().toISOString() };
  try { await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error?.code === 'EEXIST') fail('INSTAGRAM_NATIVE_JOURNAL_ALREADY_EXISTS');
    throw error;
  }

  const consumeReceipt = protectedStore.write(STORE, JSON.stringify({ consumed: true, idempotencyKey }));
  assertPersistentStoreReceipt(consumeReceipt, 'INSTAGRAM_NATIVE_DPAPI_REQUIRED');
  try {
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(envelope.request.url, {
      method: 'POST',
      headers: { ...contract.headers, cookie: scopedCookie },
      body: envelope.request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    const rotateCookies = dependencies.rotateCookies || rotateMetaCookies;
    rotateCookies(bundle, response);
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); } catch { /* response remains uncertain */ }
    const media = payload?.media ?? payload?.medias?.find(item => item?.media_dict)?.media_dict;
    const mediaId = media?.pk == null ? null : String(media.pk);
    Object.assign(record, {
      httpStatus: response.status,
      responseKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      status: typeof payload?.status === 'string' ? payload.status : null,
      ...(mediaId ? { mediaId } : {}),
      ...(typeof media?.code === 'string' ? { shortcode: media.code } : {}),
      state: response.status >= 200 && response.status < 300 && mediaId ? 'needs_readback' : 'needs_reconciliation',
    });
  } catch (error) {
    record.state = 'needs_reconciliation';
    record.code = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'INSTAGRAM_NATIVE_OUTCOME_UNCONFIRMED';
  }
  await saveJournal(file, record);
  return { ...record, journalPath: file };
}

export async function sendNativeInstagram(input = {}, dependencies = {}) {
  const file = journalFileFor(input.idempotencyKey, dependencies.journalRoot || JOURNAL_ROOT);
  const withJournalLock = dependencies.withJournalLock || withFileLock;
  try {
    return await withJournalLock(() => sendNativeInstagramLocked(input, dependencies), {
      lockPath: file + '.lock', timeoutMs: 0,
    });
  } catch (error) {
    if (error?.code === 'TISTORY_SESSION_BUSY') fail('INSTAGRAM_NATIVE_SEND_BUSY');
    throw error;
  }
}

async function scanNativeOwnerPosts(record, readPosts) {
  const posts = [];
  const seenCursors = new Set();
  let after = null;
  for (let pageIndex = 0; pageIndex < MAX_READBACK_PAGES; pageIndex++) {
    const page = await readPosts({ handle: OWNER, limit: PAGE_LIMIT, after });
    if (!Array.isArray(page?.posts) || typeof page?.pagination?.hasNextPage !== 'boolean') {
      fail('INSTAGRAM_NATIVE_READBACK_SCHEMA_INVALID');
    }
    posts.push(...page.posts);
    const matches = posts.filter(post => record.mediaId && post?.id === record.mediaId
      || record.shortcode && post?.shortcode === record.shortcode);
    if (matches.length > 1) return { posts, pagesScanned: pageIndex + 1, fullFeedScanned: false, identityFound: true, ambiguous: true };
    if (matches.length === 1) return { posts, pagesScanned: pageIndex + 1, fullFeedScanned: false, identityFound: true,
      match: matches[0] };
    if (page.pagination.hasNextPage === false) {
      return { posts, pagesScanned: pageIndex + 1, fullFeedScanned: true, identityFound: false, match: null };
    }
    const cursor = page.pagination.nextCursor;
    if (typeof cursor !== 'string' || !cursor || cursor === after || seenCursors.has(cursor)) {
      fail('INSTAGRAM_NATIVE_READBACK_CURSOR_INVALID');
    }
    seenCursors.add(cursor);
    after = cursor;
  }
  return { posts, pagesScanned: MAX_READBACK_PAGES, fullFeedScanned: false, identityFound: false, match: null };
}

function readbackDetails(post, record, scan) {
  const ownerMatched = post?.username?.toLowerCase() === record.owner;
  const identityMatched = Boolean(post && (!record.mediaId || post.id === record.mediaId)
    && (!record.shortcode || post.shortcode === record.shortcode));
  const captionMatched = Boolean(post && hash(post.caption || '') === record.captionSha256);
  const mediaMatched = Boolean(post && ownerMatched && post.mediaType === 2 && post.productType === 'clips'
    && post.carouselCount === 0);
  return {
    checkedAt: new Date().toISOString(),
    status: identityMatched && captionMatched && mediaMatched ? 'verified' : 'mismatch',
    identityMatched,
    ownerMatched,
    captionMatched,
    mediaMatched,
    mediaType: Number.isInteger(post?.mediaType) ? post.mediaType : null,
    productType: typeof post?.productType === 'string' ? post.productType : null,
    carouselCount: Number.isInteger(post?.carouselCount) ? post.carouselCount : null,
    ...(typeof post?.shortcode === 'string' ? { shortcode: post.shortcode } : {}),
    ...(typeof post?.url === 'string' ? { url: post.url } : {}),
    pagesScanned: scan.pagesScanned,
    fullFeedScanned: scan.fullFeedScanned,
    identityFound: scan.identityFound,
  };
}

function preserveVerifiedReceipt(record, check) {
  const previousVerified = record.readbackVerified === true && record.state === 'published_owner_verified'
    && typeof record.readback?.url === 'string';
  record.lastReadbackCheck = { ...check, ...(previousVerified ? { previousReceiptPreserved: true } : {}) };
  if (!previousVerified && check.status !== 'verified') {
    record.readbackVerified = false;
    record.state = 'needs_reconciliation';
  }
  if (check.status === 'verified') {
    record.readbackVerified = true;
    record.state = 'published_owner_verified';
    record.readback = {
      checkedAt: check.checkedAt,
      captionSha256: record.captionSha256,
      captionMatched: true,
      mediaMatched: true,
      identityMatched: true,
      ownerMatched: true,
      mediaType: check.mediaType,
      productType: check.productType,
      carouselCount: check.carouselCount,
      shortcode: check.shortcode,
      url: check.url,
    };
  }
  return record;
}

async function reconcileNativeInstagramLocked({ idempotencyKey } = {}, dependencies = {}) {
  const file = journalFileFor(idempotencyKey, dependencies.journalRoot || JOURNAL_ROOT);
  let record;
  try { record = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('INSTAGRAM_NATIVE_JOURNAL_INVALID'); }
  validateJournal(record, idempotencyKey);
  if (!record.mediaId && !record.shortcode) fail('INSTAGRAM_NATIVE_OUTCOME_UNKNOWN');
  const loadSession = dependencies.loadSession || loadMetaSession;
  const bundle = loadSession('instagram');
  if (bundle.owner !== OWNER || bundle.origin !== ORIGIN) fail('INSTAGRAM_NATIVE_OWNER_MISMATCH');
  const readPosts = dependencies.readPosts || readInstagramPosts;
  try {
    const scan = await scanNativeOwnerPosts(record, readPosts);
    const check = scan.ambiguous
      ? { checkedAt: new Date().toISOString(), status: 'ambiguous', pagesScanned: scan.pagesScanned,
        fullFeedScanned: false, identityFound: true }
      : scan.match ? readbackDetails(scan.match, record, scan)
        : { checkedAt: new Date().toISOString(), status: scan.fullFeedScanned ? 'not_found' : 'scan_incomplete',
          pagesScanned: scan.pagesScanned, fullFeedScanned: scan.fullFeedScanned, identityFound: false };
    preserveVerifiedReceipt(record, check);
  } catch (error) {
    const failureCode = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'INSTAGRAM_NATIVE_READBACK_FAILED';
    preserveVerifiedReceipt(record, { checkedAt: new Date().toISOString(), status: 'read_error', failureCode,
      pagesScanned: null, fullFeedScanned: false, identityFound: false });
  }
  await saveJournal(file, record);
  return record;
}

export async function reconcileNativeInstagram(input = {}, dependencies = {}) {
  const file = journalFileFor(input.idempotencyKey, dependencies.journalRoot || JOURNAL_ROOT);
  const withJournalLock = dependencies.withJournalLock || withFileLock;
  try {
    return await withJournalLock(() => reconcileNativeInstagramLocked(input, dependencies), {
      lockPath: file + '.lock', timeoutMs: 0,
    });
  } catch (error) {
    if (error?.code === 'TISTORY_SESSION_BUSY') fail('INSTAGRAM_NATIVE_RECONCILE_BUSY');
    throw error;
  }
}
