import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildThreadsConfigureRequest } from '../affiliate-api-hub/scripts/sns/writers/threads.mjs';
import { sendTransport } from '../affiliate-api-hub/scripts/sns-publish.mjs';
import { boundedText, freshMetaAuthFields, openMetaContext, withMetaSessionLock } from './lib/meta-bootstrap.mjs';
import { inspectThreadsPost, readThreadsComments } from './threads-social.mjs';
import { protectThreadsReplyError } from './lib/threads-reply-error-store.mjs';
import { safeThreadsReplyRequestShape, threadsReplyWriteWasExplicitlyRefused } from './lib/threads-reply-refusal.mjs';
import { readThreadsQuotedReplyParent, prepareThreadsReplyLink } from './threads-reply-link.mjs';
import { recordThreadsHttp429Cooldown } from './lib/threads-graphql-throttle.mjs';
import { traceBotRequest, safeBotFailure, safeRequestDiagnostic } from './lib/bot-diagnostics.mjs';
import { SOCIAL_REQUEST_TIMEOUTS } from './lib/request-timeouts.mjs';

const OWNER = 'lifehack__ailab';
const ORIGIN = 'https://www.threads.com';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const safeCode = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code || '') ? error.code : 'THREADS_REPLY_FAILED';
const knownLocalReplyLinkFailures = new Set(['THREADS_REPLY_LINK_COUNT_UNSUPPORTED', 'THREADS_REPLY_LINK_SCOPE_UNSUPPORTED']);
function knownNoDispatchReplyLinkFailure(error, { execute, journal }) {
  const code = safeCode(error);
  if (!execute || journal !== null || !knownLocalReplyLinkFailures.has(code)) return error;
  return Object.assign(new Error(code), { code, preflightNoDispatch: true, preflightStage: 'link_composition',
    dispatchStarted: false, writeSent: false, journalCreated: false, writes: 0 });
}
const defaultJournalRoot = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'affiliate-content-operations', 'social-actions', 'threads-replies');

function normalizeInput(input = {}) {
  const postId = String(input.postId ?? '');
  const expectedAuthor = String(input.expectedAuthor ?? '');
  const message = input.message;
  const execute = input.execute === true;
  const reconcile = input.reconcile === true;
  const receiptKey = input.receiptKey;
  const linkMode = input.linkMode === undefined ? 'auto_quote' : input.linkMode;
  if (!/^\d{10,25}$/.test(postId) || !/^[A-Za-z0-9_.]{1,30}$/.test(expectedAuthor)
    || typeof message !== 'string' || !message.trim() || [...message].length > 500 || /\0/.test(message)
    || receiptKey !== undefined && !/^benefit-(?:base|bonus)-\d{1,25}$/.test(receiptKey)
    || !['auto_quote', 'plain_text'].includes(linkMode)
    || typeof input.execute !== 'undefined' && typeof input.execute !== 'boolean'
    || typeof input.reconcile !== 'undefined' && typeof input.reconcile !== 'boolean'
    || execute && reconcile) fail('THREADS_REPLY_INPUT_INVALID');
  return { postId, expectedAuthor, message, messageSha256: sha256(message), receiptKey: receiptKey ?? null, linkMode, execute, reconcile };
}

function verifiedOwnerContext(context) {
  if (context?.service !== 'threads' || context.handle?.toLowerCase() !== OWNER
    || context.bundle?.service !== 'threads' || context.bundle.owner?.toLowerCase() !== OWNER
    || !/^\d{1,25}$/.test(String(context.bundle.ownerId || '')) || context.bundle.origin !== ORIGIN
    || context.documentReceipt?.ownerVerified !== true) fail('THREADS_REPLY_OWNER_UNVERIFIED');
  return context.bundle;
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validBloksVersion = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value);
const validInstagramAjax = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const APP_HEADER_FAILURES = new Set(['THREADS_REPLY_APP_VERSION_DOCUMENT_MISSING',
  'THREADS_REPLY_APP_VERSION_DOCUMENT_INVALID', 'THREADS_REPLY_APP_VERSION_MISSING',
  'THREADS_REPLY_APP_VERSION_MALFORMED', 'THREADS_REPLY_APP_VERSION_AMBIGUOUS',
  'THREADS_REPLY_AJAX_HEADER_MISSING', 'THREADS_REPLY_AJAX_HEADER_MALFORMED',
  'THREADS_REPLY_AJAX_SOURCE_MISSING', 'THREADS_REPLY_AJAX_SOURCE_CHANGED']);

export function parseFreshThreadsReplyHeaders(context, html) {
  verifiedOwnerContext(context);
  if (typeof html !== 'string' || Buffer.byteLength(html) > 8_000_000) fail('THREADS_REPLY_APP_VERSION_DOCUMENT_INVALID');
  const rows = [];
  let nodes = 0;
  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object') return;
    if (depth > 70 || ++nodes > 180_000) fail('THREADS_REPLY_APP_VERSION_DOCUMENT_INVALID');
    if (Array.isArray(value) && value[0] === 'WebBloksVersioningID') rows.push(value);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const match of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    walk(value);
  }
  if (!rows.length) fail('THREADS_REPLY_APP_VERSION_MISSING');
  if (rows.length !== 1) fail('THREADS_REPLY_APP_VERSION_AMBIGUOUS');
  const row = rows[0];
  if (!Array.isArray(row[1]) || !isRecord(row[2])) fail('THREADS_REPLY_APP_VERSION_MALFORMED');
  const versioningID = row[2].versioningID;
  if (!validBloksVersion(versioningID)) fail('THREADS_REPLY_APP_VERSION_MALFORMED');
  // REST replies use BarcelonaNetworkUtils, whose current native Ajax getter
  // returns "0". InstagramWebPushInfo.rollout_hash belongs to another path.
  // Recheck the observed module in this fresh bootstrap; a future native change
  // must stop before reserving or sending rather than reuse a captured header.
  const networkSource = context.sources?.get?.('BarcelonaNetworkUtils')?.source;
  if (typeof networkSource !== 'string' || !networkSource) fail('THREADS_REPLY_AJAX_SOURCE_MISSING');
  if (!networkSource.startsWith('__d("BarcelonaNetworkUtils",')
    || !networkSource.includes('"InstagramAPIFetch"')
    || !/getAjaxHeader\s*:\s*function\s*\(\s*\)\s*\{\s*return\s*"0"\s*\}/.test(networkSource)
    || !/buildInstagramAPIFetch\("POST",/.test(networkSource)) fail('THREADS_REPLY_AJAX_SOURCE_CHANGED');
  return { 'X-BLOKS-VERSION-ID': versioningID, 'X-INSTAGRAM-AJAX': '0' };
}

export function createThreadsReplyContextLoader({ baseContextLoader = openMetaContext, fetchImpl = globalThis.fetch } = {}) {
  return async (service, handle) => {
    let profileRequestCount = 0, profileHtml = null, captureError = null;
    const scopedFetch = async (input, init = {}) => {
      const response = await fetchImpl(input, init);
      let url;
      try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input?.url); } catch {}
      const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
      if (service === 'threads' && String(handle).toLowerCase() === OWNER && method === 'GET'
        && url?.origin === ORIGIN && url.pathname === `/@${OWNER}/` && !url.search && !url.hash) {
        profileRequestCount += 1;
        if (profileRequestCount > 1) captureError = 'THREADS_REPLY_APP_VERSION_AMBIGUOUS';
        else if (response.status === 200 && /^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          try { profileHtml = await boundedText(response.clone(), 8_000_000); }
          catch { captureError = 'THREADS_REPLY_APP_VERSION_DOCUMENT_INVALID'; }
        }
      }
      return response;
    };
    const context = await baseContextLoader(service, handle, { fetchImpl: scopedFetch });
    if (service !== 'threads' || String(handle).toLowerCase() !== OWNER) return context;
    verifiedOwnerContext(context);
    try {
      if (captureError) fail(captureError);
      if (profileRequestCount !== 1 || profileHtml === null) fail('THREADS_REPLY_APP_VERSION_DOCUMENT_MISSING');
      return { ...context, replyHeaders: parseFreshThreadsReplyHeaders(context, profileHtml) };
    } catch (error) {
      const code = safeCode(error);
      return { ...context, replyHeaderErrorCode: APP_HEADER_FAILURES.has(code) ? code : 'THREADS_REPLY_APP_VERSION_DOCUMENT_INVALID' };
    }
  };
}

const defaultThreadsReplyContextLoader = createThreadsReplyContextLoader();

function requireFreshThreadsReplyHeaders(context) {
  if (APP_HEADER_FAILURES.has(context?.replyHeaderErrorCode)) fail(context.replyHeaderErrorCode);
  const headers = context?.replyHeaders;
  if (!isRecord(headers) || Object.keys(headers).length !== 2
    || !validBloksVersion(headers['X-BLOKS-VERSION-ID'])
    || !validInstagramAjax(headers['X-INSTAGRAM-AJAX'])
    || headers['X-INSTAGRAM-AJAX'] !== '0') fail('THREADS_REPLY_APP_VERSION_MALFORMED');
  return { 'X-BLOKS-VERSION-ID': headers['X-BLOKS-VERSION-ID'], 'X-INSTAGRAM-AJAX': headers['X-INSTAGRAM-AJAX'] };
}

function requestHasExactHeader(request, expectedName, expectedValue) {
  const matches = Object.entries(request?.headers || {}).filter(([name]) => name.toLowerCase() === expectedName.toLowerCase());
  return matches.length === 1 && matches[0][1] === expectedValue;
}

function verifyParent(parent, input) {
  if (String(parent?.id ?? '') !== input.postId
    || String(parent?.author ?? '').toLowerCase() !== input.expectedAuthor.toLowerCase()
    || typeof parent?.text !== 'string') fail('THREADS_REPLY_PARENT_MISMATCH');
  if (parent.canReply === false) fail('THREADS_REPLY_NOT_ALLOWED');
  return parent;
}

function replyJournalPath(root, ownerId, postId, receiptKey) {
  const scope = receiptKey ? `${OWNER}:${ownerId}:${postId}:${receiptKey}` : `${OWNER}:${ownerId}:${postId}`;
  return path.join(root, `${sha256(scope).slice(0, 40)}.json`);
}

function validateJournal(record, { ownerId, postId, expectedAuthor, messageSha256, receiptKey, linkMode }) {
  const verifiedNotSent = record?.status === 'not_sent_verified';
  if (record?.version !== 1 || record.service !== 'threads' || record.operation !== 'reply'
    || record.owner !== OWNER || record.ownerId !== ownerId || record.parentId !== postId
    || record.parentAuthor?.toLowerCase() !== expectedAuthor.toLowerCase()
    || (record.receiptKey ?? null) !== (receiptKey ?? null)
    || record.messageSha256 !== messageSha256 || ![0, 1].includes(record.attempts)
    || record.linkMode !== undefined && (!['auto_quote', 'plain_text'].includes(record.linkMode)
      || record.linkMode !== linkMode)
    || !['reserved', 'write_started', 'needs_reconciliation', 'succeeded', 'not_found_full_scan', 'already_present',
      'not_created_explicit_refusal', 'not_sent_verified'].includes(record.status)
    || verifiedNotSent && (record.attempts !== 0 || record.notSentVerified !== true
      || record.linkMode !== linkMode
      || record.writeSent !== false || record.dispatchStarted !== false || Object.hasOwn(record, 'writeStartedAt')
      || record.createdPostId != null || record.readbackVerified === true || record.requestShape != null)
    || record.createdPostId != null && !/^\d{10,25}$/.test(record.createdPostId)) fail('THREADS_REPLY_JOURNAL_MISMATCH');
  return record;
}

async function readJournal(file, identity) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (raw.length > 24_000) fail('THREADS_REPLY_JOURNAL_INVALID');
  let record;
  try { record = JSON.parse(raw); } catch { fail('THREADS_REPLY_JOURNAL_INVALID'); }
  if (identity) validateJournal(record, identity);
  return record;
}

async function saveJournal(file, record, { create = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (create) {
      // Hard-linking a complete journal reserves this owner/parent atomically.
      await link(temporary, file);
    } else await rename(temporary, file);
  } catch (error) {
    if (create && error.code === 'EEXIST') fail('THREADS_REPLY_RECONCILE_FIRST');
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function directReplies(comments, parentId) {
  if (comments?.postId !== parentId || typeof (comments?.postAuthor ?? comments?.author) !== 'string'
    || !Array.isArray(comments?.comments) || !comments?.page || typeof comments.page.fullList !== 'boolean') {
    fail('THREADS_REPLY_COMMENTS_SCHEMA');
  }
  return comments.comments.filter(item => item.directParentPostId === parentId);
}

function parentReplies(comments,parentId) {
  const direct=directReplies(comments,parentId);
  if(comments.selfThreadChildren!==undefined&&!Array.isArray(comments.selfThreadChildren)) fail('THREADS_REPLY_COMMENTS_SCHEMA');
  const rootThread=comments.rootSelfThreadInfo;
  const adjacent=(comments.selfThreadChildren||[]).filter(item=>item.directParentPostId===parentId
    && item.relationSource==='self_thread_adjacent_position' && item.isReply===true
    && String(item.author||'').toLowerCase()===OWNER && typeof item.text==='string'
    && item.selfThreadInfo?.id===rootThread?.id
    && Number.isSafeInteger(rootThread?.position) && rootThread.position>=1
    && Number.isSafeInteger(rootThread?.length) && rootThread.length>=rootThread.position
    && item.selfThreadInfo?.position===rootThread?.position+1
    && Number.isSafeInteger(item.selfThreadInfo?.length)
    && item.selfThreadInfo.length>=item.selfThreadInfo.position);
  const byId=new Map(direct.map(item=>[String(item.id),item]));
  for(const item of adjacent) {
    const existing=byId.get(String(item.id));
    if(existing&&(existing.text!==item.text||String(existing.author).toLowerCase()!==String(item.author).toLowerCase())) {
      fail('THREADS_REPLY_PARENT_READBACK_CONFLICT');
    }
    byId.set(String(item.id),existing||item);
  }
  return [...byId.values()];
}

function parentScanFull(comments) {
  return comments?.page?.fullList===true
    && (comments.selfThreadPage===undefined||comments.selfThreadPage?.fullList===true);
}

function exactMessageReplies(comments, parentId, messageSha256) {
  return parentReplies(comments,parentId).filter(item => String(item.author || '').toLowerCase() === OWNER
    && typeof item.text === 'string' && sha256(item.text) === messageSha256);
}

function replyParentUrl(value, expectedAuthor = null) {
  let url;
  try { url = new URL(value); } catch { fail('THREADS_REPLY_PARENT_URL_INVALID'); }
  const match = url.pathname.match(/^\/@([A-Za-z0-9_.]{1,30})\/post\/([A-Za-z0-9_-]{5,30})$/);
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash || !match
    || expectedAuthor && match[1].toLowerCase() !== expectedAuthor.toLowerCase()) {
    fail('THREADS_REPLY_PARENT_URL_INVALID');
  }
  return url.href;
}

function assertConfigureRequest(request, { postId, message, replyHeaders, quotedPostId = null, parentUrl }) {
  let url;
  try { url = new URL(request?.url); } catch { fail('THREADS_REPLY_CONFIG_REQUEST_INVALID'); }
  if (request.method !== 'POST' || url.origin !== ORIGIN || url.pathname !== '/api/v1/media/configure_text_only_post/'
    || !(request.body instanceof URLSearchParams)) fail('THREADS_REPLY_CONFIG_REQUEST_INVALID');
  const form = request.body;
  let appInfo;
  try { appInfo = JSON.parse(form.get('text_post_app_info') || ''); } catch { fail('THREADS_REPLY_CONFIG_REQUEST_INVALID'); }
  if (form.get('caption') !== message || form.get('barcelona_source_reply_id') !== postId
    || appInfo.reply_id !== postId || appInfo.text_with_entities?.text !== message
    || appInfo.entry_point !== 'create_reply' || appInfo.gif_media_id !== undefined || Object.hasOwn(appInfo, 'threads_draft_id')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appInfo.composer_session_id || '')
    || appInfo.quoted_post_id !== quotedPostId
    || form.has('cross_share_info') || form.has('is_threads') || !/^\d{10,16}$/.test(form.get('upload_id') || '')
    || form.get('publish_mode') !== 'text_post' || form.get('audience') !== 'default'
    || form.get('should_include_permalink') !== 'true' || form.get('is_upload_type_override_allowed') !== '1'
    || form.get('chain_id') !== '' || form.get('chain_index') !== '' || form.get('chain_length') !== ''
    || form.get('async_publish') !== '' || form.get('custom_accessibility_caption') !== ''
    || form.get('gen_ai_detection_method') !== '' || form.get('is_meta_only_post') !== ''
    || form.get('is_paid_partnership') !== '' || form.get('music_params') !== ''
    || form.get('jazoest') !== requestCsrfJazoest(request)
    || form.get('web_session_id') !== requestWebSessionId(request)
    || !requestHasExactHeader(request, 'Referer', parentUrl ? replyParentUrl(parentUrl) : `${ORIGIN}/`)) {
    fail('THREADS_REPLY_CONFIG_REQUEST_MISMATCH');
  }
  const expectedHeaders = requireFreshThreadsReplyHeaders({ replyHeaders });
  if (!requestHasExactHeader(request, 'X-BLOKS-VERSION-ID', expectedHeaders['X-BLOKS-VERSION-ID'])
    || !requestHasExactHeader(request, 'X-INSTAGRAM-AJAX', expectedHeaders['X-INSTAGRAM-AJAX'])) {
    fail('THREADS_REPLY_HEADER_MISMATCH');
  }
  return true;
}

export function threadsConfigureRequestShape(request, { postId, message, quotedPostId = null, parentUrl } = {}) {
  const app = JSON.parse(request.body.get('text_post_app_info'));
  const keys = value => Object.keys(value).filter(key => /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/.test(key)).sort();
  const types = value => Object.fromEntries(keys(value).map(key => [key, value[key] === null ? 'null' : Array.isArray(value[key]) ? 'array' : typeof value[key]]));
  const shape = { version: 3, method: 'POST', path: '/api/v1/media/configure_text_only_post/',
    formKeys: [...request.body.keys()].filter(key => /^[a-z_]{1,80}$/.test(key)).sort(),
    headerNames: keys(request.headers).map(key => key.toLowerCase()).sort(), appInfoTypes: types(app),
    textEntityTypes: types(app.text_with_entities || {}),
    parentIdsMatch: request.body.get('barcelona_source_reply_id') === postId && app.reply_id === postId,
    captionMatches: request.body.get('caption') === message && app.text_with_entities?.text === message,
    quotedPostPresent: app.quoted_post_id != null, quotedPostMatches: app.quoted_post_id === quotedPostId,
    refererMatches: requestHasExactHeader(request, 'Referer', parentUrl ? replyParentUrl(parentUrl) : `${ORIGIN}/`),
    csrfBodyMatchesHeader: request.body.get('jazoest') === requestCsrfJazoest(request),
    webSessionBodyMatchesHeader: request.body.get('web_session_id') === requestWebSessionId(request),
    nullDraftPresent: Object.hasOwn(app, 'threads_draft_id') && app.threads_draft_id === null,
    draftOmitted: !Object.hasOwn(app, 'threads_draft_id'),
    composerSessionPresent: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(app.composer_session_id || ''),
    crossSharingOmitted: !request.body.has('cross_share_info') && !request.body.has('is_threads') };
  return { ...shape, fingerprint: sha256(JSON.stringify(shape)) };
}

function requestCsrfJazoest(request) {
  const csrf = Object.entries(request?.headers || {}).find(([name]) => name.toLowerCase() === 'x-csrftoken')?.[1];
  if (typeof csrf !== 'string' || !csrf || csrf.length > 4096 || /[\r\n\0]/.test(csrf)) {
    fail('THREADS_REPLY_CSRF_HEADER_INVALID');
  }
  let sum = 0;
  for (let index = 0; index < csrf.length; index += 1) sum += csrf.charCodeAt(index);
  const checksum = `2${sum}`;
  if (!/^\d{1,12}$/.test(checksum)) fail('THREADS_REPLY_CSRF_CHECKSUM_INVALID');
  return checksum;
}

function requestWebSessionId(request) {
  const value = Object.entries(request?.headers || {}).find(([name]) => name.toLowerCase() === 'x-web-session-id')?.[1];
  if (typeof value !== 'string' || !value || value.length > 256 || /[^\x21-\x7e]/.test(value)) {
    fail('THREADS_REPLY_WEB_SESSION_INVALID');
  }
  return value;
}

export function buildObservedThreadsReplyRequest({ postId, message, session, requestContext, replyHeaders, quotedPostId = null,
  parentUrl = null, uploadId = String(Date.now()), selfThreadContextId = randomUUID(), composerSessionId = randomUUID() } = {}) {
  if (!/^\d{10,25}$/.test(String(postId ?? '')) || typeof message !== 'string'
    || !/^\d{10,16}$/.test(String(uploadId)) || typeof selfThreadContextId !== 'string' || !selfThreadContextId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(composerSessionId || '')
    || quotedPostId !== null && !/^\d{10,25}$/.test(quotedPostId)) {
    fail('THREADS_REPLY_CONFIG_REQUEST_INVALID');
  }
  const request = buildThreadsConfigureRequest({ caption: message, uploadId: String(uploadId), replyId: String(postId),
    chainId: '', chainIndex: '', chainLength: '', selfThreadContextId, requestContext, session });
  const form = request.body;
  let appInfo;
  try { appInfo = JSON.parse(form.get('text_post_app_info') || ''); } catch { fail('THREADS_REPLY_CONFIG_REQUEST_INVALID'); }
  appInfo.entry_point = 'create_reply';
  appInfo.quoted_post_id = quotedPostId;
  // Current native reply capture (2026-10-01) and useBarcelonaReplyToPostComposer
  // generate one uuidv4 per composer. This is a request context, not an auth ID.
  // BarcelonaComposerAPI JSON serialization omits an undefined new-draft ID.
  appInfo.composer_session_id = composerSessionId;
  delete appInfo.threads_draft_id;
  if (quotedPostId) delete appInfo.link_attachment_url;
  delete appInfo.gif_media_id;
  form.set('text_post_app_info', JSON.stringify(appInfo));
  form.set('chain_id', '');
  form.set('chain_index', '');
  form.set('chain_length', '');
  form.set('async_publish', '');
  form.set('custom_accessibility_caption', '');
  form.set('gen_ai_detection_method', '');
  form.set('is_meta_only_post', '');
  form.set('is_paid_partnership', '');
  form.set('music_params', '');
  form.set('jazoest', requestCsrfJazoest(request));
  form.set('web_session_id', requestWebSessionId(request));
  // Native composer source omits cross_share_info for null/no sharing. An
  // invented empty-destinations envelope is not the captured Threads-only form.
  form.delete('cross_share_info');
  form.delete('is_threads');
  if (parentUrl !== null) request.headers.Referer = replyParentUrl(parentUrl);
  Object.assign(request.headers, requireFreshThreadsReplyHeaders({ replyHeaders }));
  return request;
}

function stableCreatedReplyId(payload, ownerId) {
  if (payload?.status !== 'ok') fail('THREADS_REPLY_RESPONSE_STATUS_INVALID');
  const media = payload?.media ?? payload?.data?.media;
  let stableId = null;
  for (const value of [media?.pk, media?.id]) {
    const raw = String(value ?? '');
    if (!raw) continue;
    let candidate = /^\d{10,25}$/.test(raw) ? raw : null;
    const composite = raw.match(/^(\d{10,25})_(\d{1,25})$/);
    if (!candidate && composite && composite[2] === String(ownerId)) candidate = composite[1];
    if (!candidate || stableId && stableId !== candidate) fail('THREADS_REPLY_CREATED_ID_INVALID');
    stableId = candidate;
  }
  if (stableId) return stableId;
  fail('THREADS_REPLY_CREATED_ID_INVALID');
}

async function publishObservedThreadsReply(posts, { session, transport, replyId, requestContext, replyHeaders, quotedPostId = null, parentUrl = null } = {}) {
  if (!Array.isArray(posts) || posts.length !== 1 || typeof transport !== 'function') fail('THREADS_REPLY_PUBLISH_CONFIG_INVALID');
  const request = buildObservedThreadsReplyRequest({ postId: replyId, message: posts[0], session, requestContext, replyHeaders, quotedPostId, parentUrl });
  const response = await transport(request);
  const status = Number(response?.status ?? 200);
  if (response?.ok === false || status < 200 || status >= 300) {
    await response?.json?.().catch?.(() => null);
    throw Object.assign(new Error(`THREADS_HTTP_${status}`), { code: `THREADS_HTTP_${status}`, httpStatus: status });
  }
  let payload;
  try { payload = await response?.json?.(); } catch { fail('THREADS_REPLY_RESPONSE_INVALID'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('THREADS_REPLY_RESPONSE_INVALID');
  const id = stableCreatedReplyId(payload, session?.ownerId);
  return { ids: [id], permalinks: [null] };
}

function safeRateLimitFromResponse(response) {
  const result = {};
  const status = Number(response?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.httpStatus = status;
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter != null) {
    const numeric = Number(retryAfter);
    const seconds = Number.isFinite(numeric) && numeric >= 0 ? Math.ceil(numeric)
      : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000);
    if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400) result.retryAfterSeconds = seconds;
  }
  const rawReset = response?.headers?.get?.('x-ratelimit-reset') || response?.headers?.get?.('x-rate-limit-reset');
  const reset = rawReset == null ? NaN : Number(rawReset);
  if (Number.isSafeInteger(reset) && reset > 0 && reset <= 99_999_999_999_999) result.rateLimitReset = reset;
  return result;
}

function safeRateLimitFromError(error) {
  const result = {
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599
      ? { httpStatus: error.httpStatus } : {}),
    ...(Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 && error.retryAfterSeconds <= 86_400
      ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(Number.isSafeInteger(error?.rateLimitReset) && error.rateLimitReset > 0 && error.rateLimitReset <= 99_999_999_999_999
      ? { rateLimitReset: error.rateLimitReset } : {}),
  };
  if (Number.isSafeInteger(error?.retryAt) && error.retryAt > 0) result.retryAt = error.retryAt;
  if (typeof error?.cooldownPersisted === 'boolean') result.cooldownPersisted = error.cooldownPersisted;
  if (error?.rateLimited === true) result.rateLimited = true;
  if (error?.cooldownReason === 'http_429_rate_limit') result.cooldownReason = error.cooldownReason;
  if (['server_hint', 'local_fallback_15_minutes'].includes(error?.deadlineSource)) result.deadlineSource = error.deadlineSource;
  if (Number.isSafeInteger(error?.fallbackMilliseconds) && error.fallbackMilliseconds >= 0
    && error.fallbackMilliseconds <= 15 * 60_000) result.fallbackMilliseconds = error.fallbackMilliseconds;
  return result;
}

function safeProviderCategory(value) {
  if (typeof value !== 'string') return undefined;
  const category = value.trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(category)
    || /(?:access|refresh|csrf|cookie|session|token|bearer|secret|fb_dtsg|jazoest|lsd)/i.test(category)
    || category.length >= 32 && /^[A-Za-z0-9_-]+$/.test(category)) return undefined;
  return category;
}

const KNOWN_PROVIDER_REJECTION_MESSAGES = new Map([
  ['media blocked due to integrity.', 'integrity_blocked'],
  ['secfetch policy violation', 'sec_fetch_policy_violation'],
  ['login_required', 'login_required'],
  ['login required', 'login_required'],
  ['feedback_required', 'feedback_required'],
  ['feedback required', 'feedback_required'],
  ['checkpoint_required', 'checkpoint_required'],
  ['checkpoint required', 'checkpoint_required'],
  ['challenge_required', 'challenge_required'],
  ['challenge required', 'challenge_required'],
  ['csrf', 'csrf_rejected'],
  ['csrf_failed', 'csrf_rejected'],
  ['csrf failed', 'csrf_rejected'],
  ['csrf token invalid', 'csrf_rejected'],
  ['csrf token mismatch', 'csrf_rejected'],
]);

function providerRejectionCategory(message) {
  if (typeof message !== 'string') return 'unclassified';
  return KNOWN_PROVIDER_REJECTION_MESSAGES.get(message.trim().toLowerCase()) || 'unclassified';
}

function providerContentTypeClass(response) {
  const raw = response?.headers?.get?.('content-type');
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  const type = raw.split(';', 1)[0].trim().toLowerCase();
  if (type === 'application/json') return 'json';
  if (type === 'application/problem+json') return 'problem_json';
  if (type === 'text/plain') return 'text';
  if (type === 'text/html') return 'html';
  if (type === 'application/octet-stream') return 'binary';
  return 'other';
}

async function readBoundedResponseText(response, maxBytes = 8192) {
  let reader;
  try { reader = response?.clone?.().body?.getReader?.(); } catch { return null; }
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < maxBytes) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      const take = Math.min(chunk.length, maxBytes - size);
      if (take) chunks.push(chunk.subarray(0, take));
      size += take;
      if (take < chunk.length) { truncated = true; break; }
    }
    if (size >= maxBytes) truncated = true;
    if (truncated) await reader.cancel().catch(() => {});
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
}

async function safeProviderDiagnostics(response, protectError) {
  const metadata = safeRateLimitFromResponse(response);
  const status = metadata.httpStatus;
  if (!Number.isInteger(status) || status < 400) return metadata;
  const result = { ...metadata, providerContentTypeClass: providerContentTypeClass(response),
    providerRejectionCategory: 'unclassified' };
  const observed = await readBoundedResponseText(response);
  if (observed) {
    result.providerBodyBytes = Buffer.byteLength(observed.text);
    result.providerBodyHash = sha256(observed.text);
    result.providerBodyTruncated = observed.truncated;
  }
  if (observed && protectError) {
    try {
      Object.assign(result, safeProviderDiagnosticFields(await protectError({ body: observed.text, truncated: observed.truncated, httpStatus: status })));
    } catch {
      // Preserve the original write failure and reservation even if protection fails.
      result.providerErrorProtected = false;
    }
  }
  if (!observed || observed.truncated) return result;
  let payload;
  try { payload = JSON.parse(observed.text); } catch { payload = null; }
  const isRecord = payload && typeof payload === 'object' && !Array.isArray(payload);
  const keys = isRecord ? Object.keys(payload).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 24) : [];
  const message = isRecord && typeof payload.message === 'string' ? payload.message
    : typeof payload === 'string' ? payload : observed.text;
  const errorType = isRecord ? safeProviderCategory(payload.error_type) : undefined;
  const errorTitle = isRecord ? safeProviderCategory(payload.error_title) : undefined;
  return { ...result,
    providerRejectionCategory: providerRejectionCategory(message),
    ...(keys.length ? { providerTopLevelKeys: keys } : {}),
    ...(errorType ? { providerErrorType: errorType } : {}),
    ...(errorTitle ? { providerErrorTitle: errorTitle } : {}),
    ...(Number.isSafeInteger(payload?.error_code) && payload.error_code >= 0 ? { providerErrorCode: payload.error_code } : {}),
  };
}

function safeProviderDiagnosticFields(value) {
  const result = {};
  if (Number.isSafeInteger(value?.providerBodyBytes) && value.providerBodyBytes >= 0 && value.providerBodyBytes <= 8196) result.providerBodyBytes = value.providerBodyBytes;
  if (/^[0-9a-f]{64}$/.test(value?.providerBodyHash || '')) result.providerBodyHash = value.providerBodyHash;
  if (typeof value?.providerBodyTruncated === 'boolean') result.providerBodyTruncated = value.providerBodyTruncated;
  if (Number.isSafeInteger(value?.providerErrorCode) && value.providerErrorCode >= 0) result.providerErrorCode = value.providerErrorCode;
  if (typeof value?.providerErrorProtected === 'boolean') result.providerErrorProtected = value.providerErrorProtected;
  if (/^threads-reply-error-[a-f0-9]{40}$/.test(value?.providerErrorStoreKey || '')) {
    result.providerErrorStoreKey = value.providerErrorStoreKey;
  }
  if (['json', 'problem_json', 'text', 'html', 'binary', 'other', 'unknown'].includes(value?.providerContentTypeClass)) {
    result.providerContentTypeClass = value.providerContentTypeClass;
  }
  if (['sec_fetch_policy_violation', 'login_required', 'feedback_required', 'checkpoint_required',
    'challenge_required', 'csrf_rejected', 'integrity_blocked', 'unclassified'].includes(value?.providerRejectionCategory)) {
    result.providerRejectionCategory = value.providerRejectionCategory;
  }
  const errorType = safeProviderCategory(value?.providerErrorType);
  const errorTitle = safeProviderCategory(value?.providerErrorTitle);
  if (errorType) result.providerErrorType = errorType;
  if (errorTitle) result.providerErrorTitle = errorTitle;
  if (Array.isArray(value?.providerTopLevelKeys)) {
    const keys = value.providerTopLevelKeys.filter(key => typeof key === 'string'
      && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 24);
    if (keys.length) result.providerTopLevelKeys = keys;
  }
  return result;
}

async function readParentAndComments(input, context, deps) {
  const parent = verifyParent(await deps.postReader({ postId: input.postId, expectedAuthor: input.expectedAuthor }, {
    owner: OWNER, context, contextLoader: deps.contextLoader, querySender: deps.querySender,
  }), input);
  const comments = await deps.commentsReader(input.postId, { owner: OWNER, expectedAuthor: input.expectedAuthor,
    context, contextLoader: deps.contextLoader, querySender: deps.querySender });
  if (comments?.postId !== input.postId
    || String(comments?.postAuthor ?? comments?.author ?? '').toLowerCase() !== input.expectedAuthor.toLowerCase()) {
    fail('THREADS_REPLY_PARENT_MISMATCH');
  }
  parentReplies(comments,input.postId);
  return { parent, comments };
}

async function verifyWrittenReply({ createdPostId, input, parent, context, deps }) {
  if (!createdPostId) return { verified: false, reason: 'THREADS_REPLY_CREATED_ID_MISSING' };
  const created = await deps.postReader({ postId: createdPostId, expectedAuthor: OWNER }, {
    owner: OWNER, context, contextLoader: deps.contextLoader, querySender: deps.querySender,
  });
  const expectedText = input.quotedPostId ? input.message.trimEnd() : input.message;
  if (String(created?.id ?? '') !== createdPostId || String(created?.author ?? '').toLowerCase() !== OWNER
    || created?.text !== expectedText || created?.isReply!==true) return { verified: false, reason: 'THREADS_REPLY_CREATED_POST_MISMATCH' };
  if (input.quotedPostId && created.quotedPostId !== input.quotedPostId) return { verified: false, reason: 'THREADS_REPLY_QUOTE_READBACK_UNVERIFIED' };
  const comments = await deps.commentsReader(input.postId, { owner: OWNER, expectedAuthor: parent.author,
    context, contextLoader: deps.contextLoader, querySender: deps.querySender });
  if (comments?.postId !== input.postId
    || String(comments?.postAuthor ?? comments?.author ?? '').toLowerCase() !== input.expectedAuthor.toLowerCase()) {
    return { verified: false, reason: 'THREADS_REPLY_PARENT_READBACK_MISMATCH' };
  }
  const observed = parentReplies(comments,input.postId).find(item => item.id === createdPostId
    && String(item.author || '').toLowerCase() === OWNER && item.text === expectedText);
  if (!observed && input.quotedPostId && await readThreadsQuotedReplyParent({ created, parentId: input.postId, context })) {
    return { verified: true, relationSource: 'containing_thread_single_ancestor', created, comments };
  }
  return observed ? { verified: true, relationSource:observed.relationSource||'direct_replies', created, comments } : {
    verified: false,
    reason: parentScanFull(comments) ? 'THREADS_REPLY_PARENT_RELATION_MISSING' : 'THREADS_REPLY_PARENT_PAGE_INCOMPLETE',
    created,
    comments,
  };
}

function baseReceipt(input, parent, bundle, comments) {
  return {
    service: 'threads', operation: 'reply', owner: OWNER, ownerId: bundle.ownerId, ownerVerified: true,
    postId: input.postId, parentAuthor: parent.author, messageSha256: input.messageSha256,
    ...(input.receiptKey ? { receiptKey: input.receiptKey } : {}),
    canReply: typeof parent.canReply === 'boolean' ? parent.canReply : null,
    canReplyVerified: typeof parent.canReply === 'boolean',
    existingDirectRepliesObserved: directReplies(comments, input.postId).length,
    existingSelfThreadRepliesObserved: parentReplies(comments,input.postId).length-directReplies(comments,input.postId).length,
    commentsPageFull: comments.page.fullList,
    executionMode: 'pure_http', browserUsed: false,
    credentialProvider: 'windows_dpapi_current_user', credentialValuesRecorded: false,
    captured: true, requestEnvelopeEvidence: 'first-party external reply configure request captured and aborted before dispatch on 2026-09-30',
    client_exists: true, remnant_free: true, credential_propagated: false, live_replay: false,
    writes: 0, checkedAt: new Date().toISOString(),
  };
}

export async function replyToThreadsPost(input = {}, {
  contextLoader,
  querySender,
  postReader = inspectThreadsPost,
  commentsReader = readThreadsComments,
  publishClient = publishObservedThreadsReply,
  transport = sendTransport,
  errorProtector = transport === sendTransport ? protectThreadsReplyError : null,
  prepareLink = prepareThreadsReplyLink,
  http429CooldownRecorder = recordThreadsHttp429Cooldown,
  http429CooldownRoot,
  beforeWrite = async () => true,
  sessionLock = withMetaSessionLock,
  requestContextFactory = freshMetaAuthFields,
  journalRoot = defaultJournalRoot(),
} = {}) {
  const normalized = normalizeInput(input);
  if (typeof beforeWrite !== 'function') fail('THREADS_REPLY_BEFORE_WRITE_GUARD_INVALID');
  const effectiveContextLoader = !contextLoader || contextLoader === openMetaContext
    ? defaultThreadsReplyContextLoader : contextLoader;
  const deps = { contextLoader: effectiveContextLoader, querySender, postReader, commentsReader };
  return sessionLock('threads', async () => {
    const context = await effectiveContextLoader('threads', OWNER);
    const bundle = verifiedOwnerContext(context);
    const identity = { ownerId: bundle.ownerId, postId: normalized.postId,
      expectedAuthor: normalized.expectedAuthor, messageSha256: normalized.messageSha256,
      receiptKey: normalized.receiptKey, linkMode: normalized.linkMode };
    const journalPath = replyJournalPath(journalRoot, bundle.ownerId, normalized.postId, normalized.receiptKey);
    let journal = await readJournal(journalPath);
    let resumeNotSentVerified = false;
    if ((normalized.execute || normalized.reconcile) && journal) validateJournal(journal, identity);
    if (normalized.execute && journal) {
      resumeNotSentVerified = journal.status === 'not_sent_verified';
      if (!resumeNotSentVerified) fail('THREADS_REPLY_RECONCILE_FIRST');
    }
    let wire = normalized;
    if (journal?.linkComposition) {
      const composition = journal.linkComposition;
      const message = normalized.message.replace(composition.sourceUrl, '');
      if (typeof composition.sourceUrl !== 'string' || !normalized.message.includes(composition.sourceUrl)
        || !/^\d{10,25}$/.test(composition.quotedPostId || '') || sha256(message) !== composition.captionSha256) fail('THREADS_REPLY_COMPOSITION_JOURNAL_INVALID');
      wire = { ...normalized, message, messageSha256: composition.captionSha256, quotedPostId: composition.quotedPostId };
    }
    if (normalized.reconcile) {
      if (!journal) fail('THREADS_REPLY_JOURNAL_MISSING');
      if (journal.status === 'not_created_explicit_refusal' || threadsReplyWriteWasExplicitlyRefused(journal)) {
        journal = { ...journal, status: 'not_created_explicit_refusal',
          writeOutcome: 'not_created_explicit_refusal', readbackVerified: false,
          lastReconciledAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await saveJournal(journalPath, journal);
        return { service: 'threads', operation: 'reply', owner: OWNER, ownerVerified: true, postId: normalized.postId,
          parentAuthor: normalized.expectedAuthor, messageSha256: normalized.messageSha256,
          ...(normalized.receiptKey ? { receiptKey: normalized.receiptKey } : {}), status: journal.status,
          success: false, notCreated: true, writeOutcome: 'not_created_explicit_refusal', writes: journal.attempts,
          readbackVerified: false, reconciliationOnly: true, writeSent: false,
          writeAttemptAt: journal.writeStartedAt || null, writeResponseAt: journal.writeResponseAt || null,
          ...(Number.isInteger(journal.writeHttpStatus) ? { writeHttpStatus: journal.writeHttpStatus } : {}),
          ...(journal.writeFailureCode ? { code: journal.writeFailureCode } : {}),
          ...safeRateLimitFromError(journal), ...safeProviderDiagnosticFields(journal),
          ...(journal.requestFailure || journal.requestDiagnostic ? { diagnostic: journal.requestFailure || {
            name: 'Error', code: journal.writeFailureCode || null, frames: [], request: journal.requestDiagnostic } } : {}),
          journalPath, checkedAt: new Date().toISOString() };
      }
      const { parent, comments } = await readParentAndComments(normalized, context, deps);
      const candidates = exactMessageReplies(comments, normalized.postId,
        wire.quotedPostId ? sha256(wire.message.trimEnd()) : wire.messageSha256);
      let createdPostId = journal.createdPostId || null;
      if (!createdPostId && candidates.length === 1) createdPostId = candidates[0].id;
      let verification = { verified: false, reason: parentScanFull(comments)
        ? 'THREADS_REPLY_OWNER_TIMELINE_REQUIRED' : 'THREADS_REPLY_SCAN_INCOMPLETE' };
      if (createdPostId && (candidates.length === 0 && wire.quotedPostId || candidates.length === 1 && candidates[0].id === createdPostId)) {
        const freshContext = await effectiveContextLoader('threads', OWNER);
        verifiedOwnerContext(freshContext);
        verification = await verifyWrittenReply({ createdPostId, input: wire, parent, context: freshContext, deps });
      }
      const priorWriteFailureCode = journal.writeFailureCode || journal.code;
      const policyBlocked = journal.providerRejectionCategory === 'sec_fetch_policy_violation'
        || priorWriteFailureCode === 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED';
      const integrityBlocked = journal.providerRejectionCategory === 'integrity_blocked'
        || priorWriteFailureCode === 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED';
      const stopCode = integrityBlocked ? 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED'
        : policyBlocked ? 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED' : null;
      journal = { ...journal, ...(createdPostId ? { createdPostId } : {}),
        status: verification.verified ? 'succeeded' : 'needs_reconciliation',
        lastReconciledAt: new Date().toISOString(), readbackVerified: verification.verified,
        ...(verification.relationSource?{parentRelationSource:verification.relationSource}:{}),
        ...(verification.reason ? { code: verification.reason } : {}),
        ...(stopCode ? { writeFailureCode: stopCode } : {}) };
      await saveJournal(journalPath, journal);
      return { service: 'threads', operation: 'reply', owner: OWNER, ownerVerified: true, postId: normalized.postId,
        parentAuthor: parent.author, messageSha256: normalized.messageSha256,
        ...(normalized.receiptKey ? { receiptKey: normalized.receiptKey } : {}),
        status: journal.status, writes: journal.attempts, success: verification.verified,
        readbackVerified: verification.verified,
        ...(verification.relationSource?{parentRelationSource:verification.relationSource}:{}),
        ...(createdPostId ? { createdPostId } : {}), ...(verification.reason ? { code: verification.reason } : {}),
        parentPageFull: comments.page.fullList,selfThreadPageFull:comments.selfThreadPage?.fullList??null,reconciliationOnly: true,
        writeSent: false, writeAttemptAt: journal.writeStartedAt || null, writeResponseAt: journal.writeResponseAt || null,
        ...(Number.isInteger(journal.writeHttpStatus) ? { writeHttpStatus: journal.writeHttpStatus } : {}),
        reconciliationCode: verification.reason || null,
        ...(safeThreadsReplyRequestShape(journal.requestShape) ? { requestShape: safeThreadsReplyRequestShape(journal.requestShape) } : {}),
        captured: false, client_exists: true, remnant_free: true, credential_propagated: false, live_replay: false,
        ...(stopCode ? { code: stopCode } : {}),
        // Keep the original write response status through read-only reconciliation.
        ...safeRateLimitFromError(journal), ...safeProviderDiagnosticFields(journal),
        ...(journal.requestFailure || journal.requestDiagnostic ? { diagnostic: journal.requestFailure || { name: 'Error', code: stopCode,
          frames: [], request: journal.requestDiagnostic } } : {}),
        journalPath, checkedAt: new Date().toISOString() };
    }

    const { parent, comments } = await readParentAndComments(normalized, context, deps);
    const parentUrl = normalized.execute ? replyParentUrl(parent.url, normalized.expectedAuthor) : parent.url;
    let linkComposition = null;
    if (prepareLink && normalized.linkMode !== 'plain_text') {
      let composed;
      try { composed = await prepareLink(normalized.message, { context, parentUrl }); }
      catch (error) { throw knownNoDispatchReplyLinkFailure(error, { execute: normalized.execute, journal }); }
      if (composed.quotedPostId) {
        if (!/^\d{10,25}$/.test(composed.quotedPostId) || typeof composed.sourceUrl !== 'string'
          || normalized.message.replace(composed.sourceUrl, '') !== composed.caption) fail('THREADS_REPLY_COMPOSITION_INVALID');
        wire = { ...normalized, message: composed.caption, messageSha256: sha256(composed.caption), quotedPostId: composed.quotedPostId };
        linkComposition = { sourceUrl: composed.sourceUrl, quotedPostId: composed.quotedPostId, captionSha256: wire.messageSha256 };
      }
    }
    wire = { ...wire, parentUrl };
    const receipt = baseReceipt(normalized, parent, bundle, comments);
    if (!normalized.execute) return { ...receipt, status: 'prepared', ready: true };
    const replyHeaders = requireFreshThreadsReplyHeaders(context);
    requestWebSessionId({ headers: bundle.ownerRequest?.headers });

    const requestContext = requestContextFactory(context);
    if (!requestContext || typeof requestContext.lsd !== 'string' || !requestContext.lsd
      || /[\r\n\0]/.test(requestContext.lsd)) {
      fail('THREADS_REPLY_FRESH_CONTEXT_INVALID');
    }

    const priorMatches = exactMessageReplies(comments, normalized.postId,
      wire.quotedPostId ? sha256(wire.message.trimEnd()) : wire.messageSha256);
    if (priorMatches.length > 1) fail('THREADS_REPLY_EXISTING_MATCH_AMBIGUOUS');
    if (priorMatches.length === 1) {
      const match = priorMatches[0];
      const freshContext = await effectiveContextLoader('threads', OWNER);
      verifiedOwnerContext(freshContext);
      const verify = await verifyWrittenReply({ createdPostId: match.id, input: wire, parent, context: freshContext, deps });
      if (!verify.verified) fail(verify.reason || 'THREADS_REPLY_EXISTING_MATCH_UNVERIFIED');
      const now = new Date().toISOString();
      const reserved = resumeNotSentVerified
        ? { ...journal, ...(linkComposition ? { linkComposition } : {}), attempts: 0, createdPostId: match.id,
          status: 'already_present', readbackVerified: true, notSentVerified: false,
          updatedAt: now }
        : { version: 1, service: 'threads', operation: 'reply', owner: OWNER, ownerId: bundle.ownerId,
          parentId: normalized.postId, parentAuthor: normalized.expectedAuthor, messageSha256: normalized.messageSha256,
          ...(normalized.receiptKey ? { receiptKey: normalized.receiptKey } : {}), linkMode: normalized.linkMode,
          ...(linkComposition ? { linkComposition } : {}),
          attempts: 0, createdPostId: match.id, status: 'already_present', readbackVerified: true,
          createdAt: now, updatedAt: now };
      await saveJournal(journalPath, reserved, { create: !resumeNotSentVerified });
      return { ...receipt, status: 'already_present', noOp: true, ready: true, success: true,
        readbackVerified: true, createdPostId: match.id, journalPath };
    }

    if (!resumeNotSentVerified) {
      journal = { version: 1, service: 'threads', operation: 'reply', owner: OWNER, ownerId: bundle.ownerId,
        parentId: normalized.postId, parentAuthor: normalized.expectedAuthor, messageSha256: normalized.messageSha256,
        ...(normalized.receiptKey ? { receiptKey: normalized.receiptKey } : {}), linkMode: normalized.linkMode,
        attempts: 0, status: 'reserved', readbackVerified: false,
        ...(linkComposition ? { linkComposition } : {}),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await saveJournal(journalPath, journal, { create: true });
    }

    let sendCount = 0;
    let beforeWriteCalled = false;
    let providerDiagnostics = {};
    let requestFailure, requestDiagnostic;
    const oneShotTransport = async request => {
      if (sendCount !== 0 || beforeWriteCalled) fail('THREADS_REPLY_DUPLICATE_SEND_BLOCKED');
      assertConfigureRequest(request, { ...wire, replyHeaders });
      beforeWriteCalled = true;
      let beforeWriteResult;
      try {
        beforeWriteResult = await beforeWrite({ service: 'threads', operation: 'reply', owner: OWNER,
          ownerId: bundle.ownerId, postId: normalized.postId, expectedAuthor: normalized.expectedAuthor,
          messageSha256: normalized.messageSha256, receiptKey: normalized.receiptKey, journalPath });
      } catch {
        throw Object.assign(new Error('THREADS_REPLY_BEFORE_WRITE_STOPPED'), {
          code: 'THREADS_REPLY_BEFORE_WRITE_STOPPED', notSentVerifiedStop: true, guardResult: 'threw' });
      }
      if (beforeWriteResult === false) {
        throw Object.assign(new Error('THREADS_REPLY_BEFORE_WRITE_STOPPED'), {
          code: 'THREADS_REPLY_BEFORE_WRITE_STOPPED', notSentVerifiedStop: true, guardResult: 'stopped' });
      }
      sendCount = 1;
      const priorNotSentAt = resumeNotSentVerified ? journal.notSentVerifiedAt : null;
      journal = { ...journal, requestShape: threadsConfigureRequestShape(request, { ...wire, parentUrl }),
        attempts: 1, status: 'write_started', writeStartedAt: new Date().toISOString(),
        ...(resumeNotSentVerified ? { notSentVerified: false, priorNotSentVerifiedAt: priorNotSentAt } : {}),
        updatedAt: new Date().toISOString() };
      await saveJournal(journalPath, journal);
      const requestStartedAt = Date.now();
      return traceBotRequest({ method: 'POST', path: '/api/v1/media/configure_text_only_post/', operation: 'configure_text_only_post',
        timeoutMs: SOCIAL_REQUEST_TIMEOUTS.write, writeSent: true }, async trace => {
      const response = await transport(request); trace.stage('response_body', response);
       journal.writeResponseAt = new Date().toISOString();
      providerDiagnostics = await safeProviderDiagnostics(response, errorProtector
        ? detail => errorProtector({ ...detail, postId: normalized.postId, journalPath }) : null);
      requestDiagnostic = safeRequestDiagnostic({ method: 'POST', path: '/api/v1/media/configure_text_only_post/', operation: 'configure_text_only_post',
        stage: 'decode', httpStatus: Number(response.status ?? response.statusCode), timeoutMs: SOCIAL_REQUEST_TIMEOUTS.write,
        elapsedMs: Date.now() - requestStartedAt, writeSent: true,
        protectedDebugRecords:response.protectedDebugRecord?[response.protectedDebugRecord]:[] });
      const metadata = safeRateLimitFromResponse(response);
      if (Number.isInteger(metadata.httpStatus)) journal.writeHttpStatus = metadata.httpStatus;
      if (metadata.httpStatus === 429) {
        const cooldown = await http429CooldownRecorder({ response, operation: 'configure_text_only_post',
          ...(http429CooldownRoot ? { root: http429CooldownRoot } : {}) });
        throw Object.assign(new Error('THREADS_REPLY_HTTP_429'), { code: 'THREADS_REPLY_HTTP_429', ...metadata,
          retryAt: cooldown.retryAt, cooldownPersisted: cooldown.cooldownPersisted, rateLimited: cooldown.rateLimited,
          cooldownReason: cooldown.cooldownReason, deadlineSource: cooldown.deadlineSource,
          fallbackMilliseconds: cooldown.fallbackMilliseconds, dispatchStarted: true, writeSent: true });
      }
      return response;
      }).catch(error => { requestFailure = safeBotFailure(error); throw error; });
    };
    try {
      const result = await publishClient([wire.message], {
        session: bundle,
        transport: oneShotTransport,
        runKey: normalized.receiptKey
          ? `reply-${bundle.ownerId}-${normalized.postId}-${sha256(normalized.receiptKey).slice(0, 12)}`
          : `reply-${bundle.ownerId}-${normalized.postId}`,
        replyId: normalized.postId,
        requestContext,
        replyHeaders,
        quotedPostId: wire.quotedPostId ?? null,
        parentUrl,
        metaContextLoader: effectiveContextLoader,
        configureRetryTimeoutMs: 0,
        configureRetryStartMs: 0,
      });
      const ids = result?.ids;
      journal = { ...journal, ...providerDiagnostics, ...(requestDiagnostic ? { requestDiagnostic } : {}) };
      const createdPostId = Array.isArray(ids) && ids.length === 1 && /^\d{10,25}$/.test(String(ids[0]))
        ? String(ids[0]) : null;
      if (createdPostId) {
        journal = { ...journal, createdPostId, status: 'needs_reconciliation', updatedAt: new Date().toISOString() };
        await saveJournal(journalPath, journal);
      }
      const freshContext = await effectiveContextLoader('threads', OWNER);
      verifiedOwnerContext(freshContext);
      const verification = await verifyWrittenReply({ createdPostId, input: wire, parent,
        context: freshContext, deps });
      journal = { ...journal, status: verification.verified ? 'succeeded' : 'needs_reconciliation',
        readbackVerified: verification.verified,
        ...(verification.relationSource?{parentRelationSource:verification.relationSource}:{}),
        ...(verification.reason ? { code: verification.reason } : {}),
        updatedAt: new Date().toISOString() };
      await saveJournal(journalPath, journal);
      const realTransport = transport === sendTransport;
      return { ...receipt, status: journal.status, writes: sendCount,
        ...providerDiagnostics, writeAttemptAt: journal.writeStartedAt || null, writeResponseAt: journal.writeResponseAt || null,
        ...(Number.isInteger(journal.writeHttpStatus) ? { writeHttpStatus: journal.writeHttpStatus } : {}),
        ...(safeThreadsReplyRequestShape(journal.requestShape) ? { requestShape: safeThreadsReplyRequestShape(journal.requestShape) } : {}),
        ...(createdPostId ? { createdPostId } : {}), success: verification.verified,
        readbackVerified: verification.verified, credential_propagated: sendCount === 1 && realTransport,
        ...(verification.relationSource?{parentRelationSource:verification.relationSource}:{}),
        live_replay: verification.verified && realTransport,
        ...(verification.reason ? { code: verification.reason } : {}), journalPath,
        permalink: result?.permalinks?.[0] || null };
    } catch (error) {
      if (error?.notSentVerifiedStop === true && sendCount === 0) {
        const stoppedAt = new Date().toISOString();
        journal = { ...journal, attempts: 0, status: 'not_sent_verified', notSentVerified: true,
          notSentVerifiedAt: stoppedAt, beforeWriteGuardResult: error.guardResult,
          dispatchStarted: false, writeSent: false, readbackVerified: false,
          code: 'THREADS_REPLY_BEFORE_WRITE_STOPPED', updatedAt: stoppedAt };
        delete journal.writeStartedAt;
        delete journal.createdPostId;
        delete journal.requestShape;
        await saveJournal(journalPath, journal);
        return { ...receipt, status: 'not_sent_verified', success: false, notSentVerified: true,
          preflightNoDispatch: true, preflightStage: 'before_write_guard', dispatchStarted: false,
          writeSent: false, journalCreated: true, writes: 0, observedWrites: 0,
          code: 'THREADS_REPLY_BEFORE_WRITE_STOPPED', writeAttemptAt: null, writeResponseAt: null, journalPath };
      }
      const code = providerDiagnostics.providerRejectionCategory === 'sec_fetch_policy_violation'
        ? 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED'
        : providerDiagnostics.providerRejectionCategory === 'integrity_blocked'
          ? 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED' : safeCode(error);
      const explicitlyRefused = sendCount > 0 && threadsReplyWriteWasExplicitlyRefused({
        ...providerDiagnostics, httpStatus: providerDiagnostics.httpStatus ?? journal.writeHttpStatus });
      journal = { ...journal, status: explicitlyRefused ? 'not_created_explicit_refusal' : sendCount ? 'needs_reconciliation' : 'reserved',
        ...(sendCount ? { attempts: 1, ...providerDiagnostics, writeFailureCode: code } : {}),
        ...(explicitlyRefused ? { writeOutcome: 'not_created_explicit_refusal', readbackVerified: false } : {}),
        ...(requestDiagnostic ? { requestDiagnostic } : {}),
        ...(requestFailure ? { requestFailure } : {}), code, updatedAt: new Date().toISOString() };
      await saveJournal(journalPath, journal);
      return { ...receipt, status: explicitlyRefused ? 'not_created_explicit_refusal' : sendCount ? 'needs_reconciliation' : 'blocked', writes: sendCount,
        ...(explicitlyRefused ? { notCreated: true, writeOutcome: 'not_created_explicit_refusal', writeSent: true }
          : sendCount ? { needs_reconciliation: true } : { writeSent: false }),
        credential_propagated: sendCount === 1 && transport === sendTransport, code,
        ...(requestFailure || requestDiagnostic ? { diagnostic: requestFailure || { name: 'Error', code, frames: [], request: requestDiagnostic } } : {}),
        ...safeRateLimitFromError(error), ...providerDiagnostics, writeAttemptAt: journal.writeStartedAt || null,
        writeResponseAt: journal.writeResponseAt || null,
        ...(safeThreadsReplyRequestShape(journal.requestShape) ? { requestShape: safeThreadsReplyRequestShape(journal.requestShape) } : {}), journalPath };
    }
  });
}

export const THREADS_REPLY_HELP = `Threads reply client (HTTP/XHR contract only)

Input JSON on stdin: {"postId":"<numeric id>","expectedAuthor":"<handle>","message":"<up to 500 characters>","receiptKey":"benefit-base-<actor id>","linkMode":"plain_text"}
Prepare (read only): node threads-reply.mjs
Send exactly one reply: node threads-reply.mjs --execute
Reconcile an existing reservation without sending: node threads-reply.mjs --reconcile
Links use observed quote-card preparation by default. Explicit linkMode plain_text preserves the caption in the observed text-only request without URL-to-quote conversion.
Each default owner/parent pair can be reserved once. Optional benefit-base/benefit-bonus actor keys separate verified stages. An incomplete reply scan stays unresolved and is never resent.
`;

async function readStdinJson(limit = 20_000) {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > limit) fail('THREADS_REPLY_INPUT_TOO_LARGE');
  }
  try { return JSON.parse(raw); } catch { fail('THREADS_REPLY_INPUT_INVALID'); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const flag = process.argv[2];
  if (process.argv.length > 3 || flag && !['--execute', '--reconcile', '--help', 'help'].includes(flag)) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'THREADS_REPLY_INPUT_INVALID' }) + '\n');
    process.exitCode = 1;
  } else if (flag === '--help' || flag === 'help') process.stdout.write(THREADS_REPLY_HELP);
  else readStdinJson().then(input => replyToThreadsPost({ ...input,
    execute: flag === '--execute', reconcile: flag === '--reconcile' }))
    .then(result => { process.stdout.write(JSON.stringify(result) + '\n'); if (result.success === false) process.exitCode = 2; })
    .catch(error => { process.stdout.write(JSON.stringify({ ok: false, code: safeCode(error) }) + '\n'); process.exitCode = 1; });
}
