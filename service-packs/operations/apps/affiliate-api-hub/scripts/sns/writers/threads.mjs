import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadMetaSession, rotateMetaCookies } from '../../../../naver-blog-api/scripts/meta-auth-session.mjs';
import { freshMetaAuthFields, metaRequest, openMetaContext, sendMetaQuery } from '../../../../social-actions/lib/meta-bootstrap.mjs';
import { journaledRequest, defaultJournalDir, runKeyFor, reserveThreadsChain } from './journal.mjs';
import { readThreadsPostsById, verifyThreadsChainReadback } from '../readers/threads-readback.mjs';

const ORIGIN = 'https://www.threads.com';
const CREATE_STATUS = Object.freeze({ operation: 'BarcelonaChainUploadStatusPollerQuery', docId: '28367812772913170' });
const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_TIMEOUT_MS = 90_000;
const DEFAULT_CONFIGURE_RETRY_TIMEOUT_MS = 90_000;
const DEFAULT_CONFIGURE_RETRY_START_MS = 3_000;
const MAX_CONFIGURE_RETRY_INTERVAL_MS = 640_000;
export const THREADS_CREATE_STATUS_CONTRACT = CREATE_STATUS;
const fail = (code, detail) => { throw Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) }); };
let lastUploadId = 0;

function normalizeTopicForWrite(topic) {
  if (topic === undefined || topic === null) return null;
  let displayText;
  if (typeof topic === 'string') displayText = topic;
  else if (topic && typeof topic === 'object' && !Array.isArray(topic)) {
    if (topic.communityFlairId != null || topic.communityFlairID != null || topic.community_flair_id != null
      || topic.communityTagAttachment != null || topic.community_tag_attachment != null) {
      fail('THREADS_TOPIC_COMMUNITY_UNVERIFIED');
    }
    const isCommunity = topic.isCommunity ?? topic.is_community;
    if (isCommunity === true) fail('THREADS_TOPIC_COMMUNITY_UNVERIFIED');
    if (isCommunity !== false) fail('THREADS_TOPIC_COMMUNITY_STATUS_REQUIRED');
    if (topic.isValid === false || topic.is_valid === false) fail('THREADS_TOPIC_INVALID');
    displayText = topic.displayText ?? topic.display_text;
  } else fail('THREADS_TOPIC_NAME_INVALID');
  if (typeof displayText !== 'string' || !displayText.trim() || displayText.length > 160
    || /[\0-\x1f\x7f]/.test(displayText)) fail('THREADS_TOPIC_NAME_INVALID');
  return displayText.trim();
}

function topicsForPublish(topic, postCount) {
  const values = Array.isArray(topic) ? topic : Array(postCount).fill(topic);
  if (values.length !== postCount) fail('THREADS_TOPIC_COUNT_MISMATCH');
  return values.map(normalizeTopicForWrite);
}

function newUploadId() {
  const now = Date.now();
  lastUploadId = now > lastUploadId ? now : lastUploadId + 1;
  return String(lastUploadId);
}

function sessionCookie(session, name) {
  return session?.cookies?.find(cookie => cookie.name === name)?.value;
}

function sessionHeader(session, name) {
  const headers = session?.ownerRequest?.headers || {};
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function cookieHeader(session) {
  return (session.cookies || []).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function commonHeaders(session, requestContext) {
  if (!session || session.service !== 'threads') fail('META_SESSION_REQUIRED');
  const headers = {};
  for (const [source, target] of [
    ['x-ig-app-id', 'X-IG-App-ID'], ['x-fb-lsd', 'X-FB-LSD'],
    ['x-asbd-id', 'X-ASBD-ID'], ['x-web-session-id', 'X-Web-Session-ID'],
  ]) {
    const value = sessionHeader(session, source);
    if (value) headers[target] = value;
  }
  const csrf = sessionCookie(session, 'csrftoken');
  if (!csrf) fail('META_CSRF_MISSING');
  if (!headers['X-IG-App-ID']) fail('META_APP_ID_MISSING');
  if (!headers['X-FB-LSD']) fail('META_LSD_MISSING');
  if (requestContext?.lsd) headers['X-FB-LSD'] = requestContext.lsd;
  headers['X-CSRFToken'] = csrf;
  headers.cookie = cookieHeader(session);
  // Meta refuses API calls without the browser's fetch metadata ("SecFetch Policy violation", first live send 2026-09-28):
  // same-origin CORS fetch from the Threads web app, with its origin, referer and the session's user agent.
  Object.assign(headers, { Origin: ORIGIN, Referer: `${ORIGIN}/`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    'X-Requested-With': 'XMLHttpRequest' });
  const ua = sessionHeader(session, 'user-agent');
  if (ua) headers['User-Agent'] = ua;
  return headers;
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.set(key, value === null ? '' : String(value));
  }
  return body;
}

// Evidence: logged-in Threads excerpt key `function f(e){` (BarcelonaComposerAPI)
// emits these snake-case keys, the nested text_with_entities object, and JSON text.
export function buildTextPostAppInfo({ caption, linkPreviewURL, linkPreviewDefaultRenderStyle, replyControl, replyId,
  fediverseComposerEnabled, topic, selfThreadContextId = randomUUID() }) {
  if (typeof caption !== 'string') fail('THREADS_CAPTION_INVALID');
  if (typeof selfThreadContextId !== 'string' || !selfThreadContextId) fail('THREADS_CONTEXT_ID_INVALID');
  const topicText = normalizeTopicForWrite(topic);
  const info = {
    community_flair_id: null,
    entry_point: 'main_tab_bar',
    excluded_inline_media_ids: JSON.stringify([]),
    fediverse_composer_enabled: typeof fediverseComposerEnabled === 'boolean' ? fediverseComposerEnabled : true,
    gif_media_id: null,
    is_genai_invocation_post: false,
    is_reply_approval_enabled: false,
    is_spoiler_media: false,
    link_attachment_url: linkPreviewURL || null,
    link_preview_default_render_style: linkPreviewDefaultRenderStyle ?? null,
    quoted_post_id: null,
    ranking_info_token: null,
    reply_control: replyControl ?? 0,
    reply_id: replyId,
    self_thread_context_id: selfThreadContextId,
    snippet_attachment: null,
    special_effects_enabled_str: null,
    tag_header: topicText ? { display_text: topicText } : null,
    text_with_entities: { entities: [], text: caption },
  };
  return JSON.stringify(info);
}

// Evidence: logged-in Threads excerpt keys `configure_text_only_post`,
// `configure_text_post_app_feed`, `configure_text_post_app_sidecar`, and `chain_id`.
export function buildThreadsConfigureRequest({
  caption, uploadIds = [], uploadId, chainId, chainIndex, chainLength, replyId, asyncPublish,
  replyControl, linkPreviewURL, linkPreviewDefaultRenderStyle, fediverseComposerEnabled, creatorGeoGatingInfo,
  webSessionId, clientSidecarId, selfThreadContextId = randomUUID(), requestContext, session,
  crossShareInfo, customAccessibilityCaption, topic, communityFlairId, communityFlairID, community_flair_id,
  communityTagAttachment, community_tag_attachment, genAiInvocationPost = false, isMetaOnlyPost = false,
  isPaidPartnership = false, musicParams, allowTopicMedia = false,
}) {
  if (typeof caption !== 'string' || !caption.trim()) fail('THREADS_CAPTION_INVALID');
  if (!Array.isArray(uploadIds)) fail('THREADS_UPLOADS_INVALID');
  const topicText = normalizeTopicForWrite(topic);
  if (communityFlairId != null || communityFlairID != null || community_flair_id != null
    || communityTagAttachment != null || community_tag_attachment != null) fail('THREADS_TOPIC_COMMUNITY_UNVERIFIED');
  if (topicText && uploadIds.length > 0 && allowTopicMedia !== true) fail('THREADS_TOPIC_MEDIA_UNVERIFIED');
  const textPostInfo = buildTextPostAppInfo({ caption, linkPreviewURL, linkPreviewDefaultRenderStyle,
    replyControl, replyId, fediverseComposerEnabled, topic: topicText, selfThreadContextId });
  const childrenMetadata = uploadIds.map(value => {
    if (typeof value === 'string' || typeof value === 'number') return { upload_id: String(value) };
    if (!value || typeof value !== 'object') fail('THREADS_UPLOADS_INVALID');
    const childUploadId = value.uploadId ?? value.upload_id;
    if (childUploadId === undefined || childUploadId === null || !String(childUploadId)) fail('THREADS_UPLOADS_INVALID');
    return {
      ...(value.customAccessibilityCaption != null ? { custom_accessibility_caption: String(value.customAccessibilityCaption) } : {}),
      upload_id: String(childUploadId),
      ...(value.usertags != null ? { usertags: value.usertags } : {}),
    };
  });
  const commonOptional = {
    ...(asyncPublish === true ? { async_publish: '1' } : {}),
    ...(crossShareInfo != null ? { cross_share_info: JSON.stringify(crossShareInfo) } : {}),
    ...(genAiInvocationPost ? { gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW' } : {}),
    ...(isMetaOnlyPost ? { is_meta_only_post: '1' } : {}),
    ...(isPaidPartnership ? { is_paid_partnership: '1' } : {}),
    ...(musicParams != null ? { music_params: JSON.stringify(musicParams) } : {}),
  };
  const common = {
    audience: 'default',
    ...(replyId !== undefined && replyId !== null ? { barcelona_source_reply_id: String(replyId) } : {}),
    caption,
    ...(chainId ? { chain_id: chainId } : {}),
    ...(chainIndex !== undefined ? { chain_index: String(chainIndex) } : {}),
    ...(chainLength !== undefined ? { chain_length: String(chainLength) } : {}),
    creator_geo_gating_info: JSON.stringify({ whitelist_country_codes: creatorGeoGatingInfo ?? [] }),
    internal_features: '',
    should_include_permalink: true,
    text_post_app_info: textPostInfo,
    ...commonOptional,
    ...(webSessionId ? { web_session_id: webSessionId } : {}),
  };
  const authHeaders = commonHeaders(session, requestContext);
  if (uploadIds.length > 1) {
    const sidecar = {
      ...common,
      children_metadata: childrenMetadata,
      // BarcelonaComposerUploadID.createUploadID(): numeric, like the child upload ids.
      client_sidecar_id: clientSidecarId ?? newUploadId(),
      is_threads: true,
      is_upload_type_override_allowed: '1',
    };
    return {
      method: 'POST', url: `${ORIGIN}/api/v1/media/configure_text_post_app_sidecar/`,
      // Wire content type is text/plain;charset=UTF-8 with a raw JSON body: that is what the browser sends (2026-09-28 capture;
      // InstagramAPIFetch RequestContentType.JSON posts a JSON string without its own content type). application/json
      // (topic path since 2026-10-05) answered HTTP 400 on 2026-10-05 and at the 2026-10-17 11:00 KST box tick.
      headers: { ...authHeaders, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(sidecar),
    };
  }
  if (uploadIds.length === 1) {
    if (!requestContext || typeof requestContext.jazoest !== 'string' || !/^\d{1,12}$/.test(requestContext.jazoest)) {
      fail('THREADS_FRESH_REQUEST_CONTEXT_REQUIRED');
    }
    return {
      method: 'POST', url: `${ORIGIN}/api/v1/media/configure_text_post_app_feed/`,
      headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: formBody({ ...common, ...(childrenMetadata[0].custom_accessibility_caption !== undefined
        ? { custom_accessibility_caption: childrenMetadata[0].custom_accessibility_caption } : {}),
        ...(customAccessibilityCaption != null ? { custom_accessibility_caption: String(customAccessibilityCaption) } : {}),
        is_threads: true, is_upload_type_override_allowed: '1', jazoest: requestContext.jazoest,
        upload_id: childrenMetadata[0].upload_id,
        ...(childrenMetadata[0].usertags !== undefined ? { usertags: JSON.stringify(childrenMetadata[0].usertags) } : {}) }),
    };
  }
  if (!uploadId) fail('THREADS_UPLOAD_ID_REQUIRED');
  return {
    method: 'POST', url: `${ORIGIN}/api/v1/media/configure_text_only_post/`,
    headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: formBody({ ...common, is_threads: true, is_upload_type_override_allowed: '1',
      publish_mode: 'text_post', upload_id: uploadId }),
  };
}

// Evidence: logged-in Threads excerpt key `rupload_igphoto` supplies this route,
// entity naming, header set, and is_threads/is_sidecar/media_type parameters.
export function buildThreadsPhotoUploadRequest({ bytes, width, height, uploadId, entityName = `fb_uploader_${uploadId}`,
  mimeType = 'image/png', sidecar = false, requestContext, session }) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!body.length || !uploadId || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
    || !['image/png', 'image/jpeg'].includes(mimeType)) fail('THREADS_IMAGE_INVALID');
  const headers = commonHeaders(session, requestContext);
  headers['Content-Type'] = mimeType;
  headers.Offset = '0';
  headers['X-Entity-Length'] = String(body.length);
  headers['X-Entity-Name'] = entityName;
  headers['X-Entity-Type'] = mimeType;
  headers['X-Instagram-Rupload-Params'] = JSON.stringify({ is_sidecar: sidecar ? '1' : '0', is_threads: '1', media_type: 1,
    upload_id: uploadId, upload_media_height: height, upload_media_width: width });
  return { method: 'POST', url: `${ORIGIN}/rupload_igphoto/${encodeURIComponent(entityName)}`, headers, body };
}

// Evidence: logged-in Threads `BarcelonaComposerAPI` / `BarcelonaComposerUploadID`
// excerpts define `rupload_igvideo`, the fb_uploader entity, raw Blob body and
// extract_cover_frame/is_threads/media_type parameters. This deliberately stops
// after the upload response; no configure or post-creation request is made.
export function buildThreadsVideoUploadRequest({ bytes, width, height, uploadId, entityName = `fb_uploader_${uploadId}`,
  mimeType = 'video/mp4', sidecar = false, requestContext, session }) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!body.length || body.length > 500 * 1024 * 1024 || !/^\d{1,20}$/.test(String(uploadId)) || !Number.isInteger(width) || width < 1
    || !Number.isInteger(height) || height < 1 || mimeType !== 'video/mp4'
    || body.length < 12 || body.toString('ascii', 4, 8) !== 'ftyp') fail('THREADS_VIDEO_INVALID');
  const headers = commonHeaders(session, requestContext);
  headers['Content-Type'] = mimeType;
  headers.Offset = '0';
  headers['X-Entity-Length'] = String(body.length);
  headers['X-Entity-Name'] = entityName;
  headers['X-Entity-Type'] = mimeType;
  headers['X-Instagram-Rupload-Params'] = JSON.stringify({ extract_cover_frame: '1', is_sidecar: sidecar ? '1' : '0',
    is_threads: '1', media_type: 2, upload_id: uploadId, upload_media_height: height, upload_media_width: width });
  return { method: 'POST', url: `${ORIGIN}/rupload_igvideo/${encodeURIComponent(entityName)}`, headers, body };
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail('SNS_PNG_CONTRACT_MISSING');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes) {
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker) && length >= 7) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    offset += length;
  }
  fail('THREADS_IMAGE_DIMENSIONS_INVALID');
}

async function imageInput(input) {
  const file = typeof input === 'string' ? input : input?.path;
  const bytes = input?.bytes ? Buffer.from(input.bytes) : file ? await readFile(file) : Buffer.isBuffer(input) ? input : null;
  if (!bytes) fail('THREADS_IMAGE_INVALID');
  const ext = file ? path.extname(file).toLowerCase() : '';
  const detectedMime = bytes.toString('hex', 0, 8) === '89504e470d0a1a0a' ? 'image/png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : undefined;
  const mimeType = input?.mimeType || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[ext]) || detectedMime;
  if (!['image/png', 'image/jpeg'].includes(mimeType)) fail('THREADS_IMAGE_INVALID');
  const dimensions = Number.isInteger(input?.width) && Number.isInteger(input?.height) ? input
    : mimeType === 'image/png' ? pngDimensions(bytes) : jpegDimensions(bytes);
  return { bytes, width: dimensions.width, height: dimensions.height, mimeType,
    customAccessibilityCaption: input?.customAccessibilityCaption, usertags: input?.usertags };
}

async function videoInput(input) {
  const file = typeof input === 'string' ? input : input?.path;
  const bytes = input?.bytes ? Buffer.from(input.bytes) : file ? await readFile(file) : Buffer.isBuffer(input) ? input : null;
  if (!bytes || bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp' || bytes.length > 500 * 1024 * 1024) {
    fail('THREADS_VIDEO_INVALID');
  }
  const metadata = input?.videoMetadata ?? input;
  const { width, height, durationMs } = metadata || {};
  if (!Number.isInteger(width) || width < 1 || width > 30_000 || !Number.isInteger(height) || height < 1 || height > 30_000
    || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86_400_000) fail('THREADS_VIDEO_METADATA_REQUIRED');
  return { bytes, width, height, durationMs, mimeType: input?.mimeType || 'video/mp4' };
}

async function uploadThreadsImageData(data, { session, requestContext, sidecar = false, transport,
  rotateCookies = rotateMetaCookies, journalDir = defaultJournalDir(), runKey, uploadId = randomUUID() } = {}) {
  if (typeof transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const request = buildThreadsPhotoUploadRequest({ ...data, uploadId, sidecar, requestContext, session });
  request.assetSha256 = createHash('sha256').update(data.bytes).digest('hex');
  const response = await journaledRequest({ channel: 'threads', runKey, journalDir, request, send: transport });
  await rotateCookies(session, response);
  await assertResponse(response);
  const payload = await responseJson(response);
  const confirmedUploadId = payload?.upload_id ?? payload?.data?.upload_id;
  if (!confirmedUploadId) fail('THREADS_UPLOAD_SCHEMA');
  return { uploadId: String(confirmedUploadId), bytes: data.bytes.length };
}

async function uploadThreadsVideoData(data, { session, requestContext, sidecar = false, transport,
  rotateCookies = rotateMetaCookies, journalDir = defaultJournalDir(), runKey, uploadId = newUploadId() } = {}) {
  if (typeof transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const numericUploadId = String(uploadId);
  const request = buildThreadsVideoUploadRequest({ ...data, uploadId: numericUploadId, sidecar, requestContext, session });
  const response = await journaledRequest({ channel: 'threads', runKey, journalDir, request, send: transport });
  await rotateCookies(session, response);
  await assertResponse(response);
  const payload = await responseJson(response);
  const validVideoUpload = payload?.status === 'ok' && /^\d{1,30}$/.test(String(payload?.media_id || ''));
  if (!validVideoUpload) fail('THREADS_VIDEO_UPLOAD_SCHEMA');
  // BarcelonaMediaUploadAPI returns the client-generated upload ID for videos;
  // the numeric media_id in the rupload response validates completion only.
  return { uploadId: numericUploadId, bytes: data.bytes.length };
}

export async function uploadThreadsImageOnly(input, { session, loadSession = loadMetaSession,
  rotateCookies = rotateMetaCookies, transport, journalDir = defaultJournalDir(), runKey, runDir,
  sidecar = false, requestContext, metaContextLoader = openMetaContext, randomUUIDImpl = randomUUID } = {}) {
  const currentSession = await requireSession(session, loadSession);
  const run = runKey || (runDir && runKeyFor(runDir));
  if (!run) fail('SNS_RUN_KEY_REQUIRED');
  const data = await imageInput(input);
  const currentRequest = await currentRequestContext(currentSession, { requestContext, metaContextLoader });
  const result = await uploadThreadsImageData(data, { session: currentSession, requestContext: currentRequest,
    sidecar, transport, rotateCookies, journalDir, runKey: run, uploadId: randomUUIDImpl() });
  return { uploaded: true, bytes: result.bytes, width: data.width, height: data.height,
    mimeType: data.mimeType, uploadIdValidated: true, uploadIdValueRetained: false };
}

export async function uploadThreadsVideoOnly(input, { session, loadSession = loadMetaSession,
  rotateCookies = rotateMetaCookies, transport, journalDir = defaultJournalDir(), runKey, runDir,
  requestContext, metaContextLoader = openMetaContext, uploadIdFactory = newUploadId } = {}) {
  const currentSession = await requireSession(session, loadSession);
  const run = runKey || (runDir && runKeyFor(runDir));
  if (!run) fail('SNS_RUN_KEY_REQUIRED');
  if (typeof transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const data = await videoInput(input);
  const currentRequest = await currentRequestContext(currentSession, { requestContext, metaContextLoader });
  await uploadThreadsVideoData(data, { session: currentSession, requestContext: currentRequest,
    transport, rotateCookies, journalDir, runKey: run, uploadId: uploadIdFactory() });
  return { uploaded: true, bytes: data.bytes.length, width: data.width, height: data.height,
    durationMs: data.durationMs, mimeType: data.mimeType, uploadIdValueRetained: false,
    mediaIdValidated: true, mediaIdValueRetained: false };
}

function imageGroups(images, postCount) {
  if (!Array.isArray(images)) fail('THREADS_IMAGES_INVALID');
  const groups = Array.from({ length: postCount }, () => []);
  for (const [position, entry] of (images || []).entries()) {
    if (Array.isArray(entry)) {
      if (position >= postCount) fail('THREADS_IMAGE_INDEX_INVALID');
      groups[position].push(...entry);
      continue;
    }
    const postIndex = typeof entry === 'object' && !Buffer.isBuffer(entry) ? Number(entry.postIndex ?? 0) : 0;
    const file = typeof entry === 'object' && !Buffer.isBuffer(entry)
      ? (entry.file ?? entry.path ?? (entry.bytes || Number.isInteger(entry.width) ? entry : null)) : entry;
    if (!Number.isInteger(postIndex) || postIndex < 0 || postIndex >= postCount || !file) fail('THREADS_IMAGE_INDEX_INVALID');
    groups[postIndex].push(file);
  }
  return groups;
}

function videoGroups(videos, postCount) {
  if (!Array.isArray(videos)) fail('THREADS_VIDEOS_INVALID');
  const groups = Array.from({ length: postCount }, () => []);
  for (const entry of videos) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('THREADS_VIDEO_INDEX_INVALID');
    const postIndex = Number(entry.postIndex ?? 0);
    if (!Number.isInteger(postIndex) || postIndex < 0 || postIndex >= postCount || !entry.file) fail('THREADS_VIDEO_INDEX_INVALID');
    groups[postIndex].push(entry.file);
  }
  return groups;
}

async function responseJson(response) {
  if (typeof response?.text === 'function') {
    let text;
    try { text = await response.text(); }
    catch (error) {
      const status = Number(response?.status ?? 0);
      const mime = safeProviderText(response?.headers?.get?.('content-type') || 'unknown');
      const reason = safeProviderText(error?.name || error?.code || 'read_error');
      fail('THREADS_RESPONSE_BODY_UNREADABLE', `HTTP ${status}; content-type=${mime}; read=${reason}; body omitted`);
    }
    try { return JSON.parse(String(text).replace(/^for \(;;\);\s*/, '')); }
    catch (error) {
      const status = Number(response?.status ?? 0);
      const mime = safeProviderText(response?.headers?.get?.('content-type') || 'unknown');
      const reason = safeProviderText(error?.name || 'invalid_json');
      fail('THREADS_RESPONSE_BODY_UNREADABLE', `HTTP ${status}; content-type=${mime}; parse=${reason}; body omitted`);
    }
  }
  if (response?.body && typeof response.body === 'object') return response.body;
  if (response?.data && typeof response.data === 'object') return response.data;
  return response;
}

// A refused request carries Meta's own reason ({message, error_type}); it is kept (no request or session data in it) so a
// 400 can be fixed instead of guessed at (first live send 2026-09-28 answered 400).
function safeProviderText(value) {
  return String(value ?? '').replace(/[\r\n\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\b(fb_dtsg|jazoest|lsd|csrf(?:token)?|cookie|sessionid|authorization|access_token|refresh_token)\b\s*[:=]\s*[^\s,;"}]*/gi,
      '$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]').trim().slice(0, 180);
}

function safeKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).slice(0, 24).map(key => key.replace(/[^A-Za-z0-9_.-]/g, '?'));
}

function providerErrorDetail(status, errorInfo) {
  return [
    status ? `status=${safeProviderText(status)}` : null,
    safeProviderText(errorInfo?.error_type),
    safeProviderText(errorInfo?.message),
  ].filter(Boolean).join(' | ').slice(0, 300);
}

function rejectThreadsCreate(status, errorInfo, fallback = 'Threads rejected the create request') {
  fail('THREADS_CREATE_REJECTED', providerErrorDetail(status, errorInfo) || fallback);
}

function validateThreadsPostId(rawId, code = 'THREADS_CREATE_SCHEMA') {
  const id = String(rawId ?? '');
  if (!/^\d{10,25}$/.test(id)) fail(code, 'Threads did not return a valid published post id');
  return id;
}

function parseThreadsCreateResponse(payload, response) {
  const providerStatus = typeof payload?.status === 'string' ? payload.status.toLowerCase() : null;
  const providerError = payload?.error ?? (Array.isArray(payload?.errors) ? payload.errors[0] : null);
  // 2026-09-29: image posts answered HTTP 200 with {posts, medias, end_card_check, status} instead of {media}; the post
  // was not on the owner profile afterwards. Read an id from posts[0]/medias[0] when present; otherwise the schema
  // failure below reports only lengths and key names (no values) so the shape can be pinned down.
  const firstPost = Array.isArray(payload?.posts) ? payload.posts[0] : null;
  const firstMedia = Array.isArray(payload?.medias) ? payload.medias[0] : null;
  const firstPostStatus = String(firstPost?.status ?? '').toUpperCase();
  if (firstPostStatus === 'ERROR') rejectThreadsCreate(firstPostStatus, firstPost.error_info);
  const media = payload?.media ?? payload?.data?.media ?? firstPost?.media ?? firstPost?.post ?? firstPost ?? firstMedia;
  const rawId = media?.pk ?? media?.id ?? payload?.id;
  if (providerError || providerStatus && providerStatus !== 'ok') {
    rejectThreadsCreate(providerStatus, providerError ?? { error_type: payload?.error_type, message: payload?.message },
      'Threads returned a service-level create error');
  }
  if (firstPostStatus === 'PENDING') {
    const postClientId = String(firstPost?.post_client_id ?? '');
    if (!postClientId || postClientId.length > 200 || /[\r\n\0]/.test(postClientId)) {
      fail('THREADS_CREATE_SCHEMA', 'Pending Threads create response omitted a valid post_client_id');
    }
    return { pendingPostClientId: postClientId, permalink: null };
  }
  if (!/^\d{10,25}$/.test(String(rawId ?? ''))) {
    const contentType = safeProviderText(response?.headers?.get?.('content-type') || 'unknown');
    const shape = v => Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v;
    const detail = `HTTP ${Number(response?.status ?? 0)}; content-type=${contentType}; keys=${safeKeys(payload).join(',') || '-'}; dataKeys=${safeKeys(payload?.data).join(',') || '-'}; mediaKeys=${safeKeys(media).join(',') || '-'}`
      + `; post0Status=${safeProviderText(String(firstPost?.status ?? '-'))}; post0Error=${providerErrorDetail(firstPostStatus, firstPost?.error_info) || '-'}; post0MediaIds=${shape(firstPost?.media_ids)}`
      + `; posts=${shape(payload?.posts)}; medias=${shape(payload?.medias)}; post0Keys=${safeKeys(firstPost).join(',') || '-'}; media0Keys=${safeKeys(firstMedia).join(',') || '-'}; status=${safeProviderText(String(payload?.status ?? '-'))}; endCard=${shape(payload?.end_card_check)}`;
    fail('THREADS_CREATE_SCHEMA', detail.slice(0, 500));
  }
  const rawPermalink = media?.permalink ?? payload?.permalink;
  let permalink = null;
  try {
    const url = new URL(rawPermalink);
    if (url.origin === ORIGIN && /^\/@[A-Za-z0-9_.]{1,30}\/post\/[A-Za-z0-9_-]{5,30}\/?$/.test(url.pathname)
      && !url.search && !url.hash) permalink = url.href;
  } catch {}
  return { id: String(rawId), permalink };
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function waitForThreadsPostPublished(postClientId, {
  session, metaContextLoader = openMetaContext, querySender = sendMetaQuery,
  pollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS, timeoutMs = DEFAULT_STATUS_TIMEOUT_MS, sleepImpl = sleep,
} = {}) {
  const clientId = String(postClientId ?? '');
  if (!clientId || clientId.length > 200 || /[\r\n\0]/.test(clientId)) fail('THREADS_STATUS_CLIENT_ID_INVALID');
  if (!session || typeof metaContextLoader !== 'function' || typeof querySender !== 'function'
    || typeof sleepImpl !== 'function' || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 0
    || !Number.isFinite(timeoutMs) || timeoutMs < 1) fail('THREADS_STATUS_POLL_CONFIG_INVALID');
  const context = await metaContextLoader('threads', session.owner);
  if (context?.service !== 'threads' || context.handle?.toLowerCase() !== session.owner?.toLowerCase()
    || context.bundle?.service !== 'threads' || context.bundle.owner?.toLowerCase() !== session.owner?.toLowerCase()) {
    fail('THREADS_REQUEST_CONTEXT_OWNER_MISMATCH');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = metaRequest(context, CREATE_STATUS.operation, CREATE_STATUS.docId,
      { request_data: { post_client_id: clientId } });
    const result = await querySender(context, request);
    const payload = result?.payload ?? result;
    const statusResult = payload?.data?.xdt_get_upload_status ?? payload?.xdt_get_upload_status;
    const post = Array.isArray(statusResult?.posts) ? statusResult.posts[0] : null;
    const status = String(post?.status ?? '').toUpperCase();
    if (status === 'COMPLETED' || status === 'PENDING_DISTRIBUTION') {
      return validateThreadsPostId(post?.id, 'THREADS_CREATE_STATUS_SCHEMA');
    }
    if (status === 'ERROR') rejectThreadsCreate(status, post?.error_info);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    if (pollIntervalMs > 0) await sleepImpl(Math.min(pollIntervalMs, remainingMs));
  }
  fail('THREADS_CREATE_PENDING_TIMEOUT', 'Threads did not report a completed post before the status wait expired');
}

async function assertResponse(response) {
  const status = Number(response?.status ?? 200);
  if (response?.ok === false || status < 200 || status >= 300) {
    let detail = null;
    try {
      const text = await response.text();
      const parsed = JSON.parse(text);
      const parts = ['message', 'error_type', 'error_title'].map(key => safeProviderText(parsed?.[key])).filter(Boolean);
      detail = parts.join(' | ').slice(0, 300) || null;
    } catch {
      const contentType = safeProviderText(response.headers?.get?.('content-type') || 'unknown');
      detail = `response body omitted (${contentType})`;
    }
    throw Object.assign(new Error(`THREADS_HTTP_${status}`), { code: `THREADS_HTTP_${status}`, httpStatus: status, detail });
  }
}

async function requireSession(session, loadSession) {
  const value = session || await loadSession('threads');
  if (value?.service !== 'threads' || value.owner !== 'lifehack__ailab') fail('META_OWNER_MISMATCH');
  return value;
}

async function currentRequestContext(session, { requestContext, metaContextLoader = openMetaContext } = {}) {
  if (requestContext) {
    if (typeof requestContext.jazoest !== 'string' || !/^\d{1,12}$/.test(requestContext.jazoest)
      || typeof requestContext.lsd !== 'string' || !requestContext.lsd) fail('THREADS_FRESH_REQUEST_CONTEXT_INVALID');
    return requestContext;
  }
  const context = await metaContextLoader('threads', session.owner);
  if (context?.service !== 'threads' || context.handle?.toLowerCase() !== session.owner.toLowerCase()
    || context.bundle?.owner !== session.owner || context.bundle?.ownerId !== session.ownerId) {
    fail('THREADS_REQUEST_CONTEXT_OWNER_MISMATCH');
  }
  session.cookies = context.bundle.cookies;
  return freshMetaAuthFields(context);
}

export async function publishChain(posts, {
  images = [], videos = [], session, loadSession = loadMetaSession, rotateCookies = rotateMetaCookies,
  transport, journalDir, runKey, runDir, randomUUIDImpl = randomUUID,
  videoUploadIdFactory = newUploadId,
  imageUploadIdFactory = newUploadId,
  linkPreviewURL, replyControl, replyId, creatorGeoGatingInfo,
  fediverseComposerEnabled, requestContext, metaContextLoader = openMetaContext,
  selfThreadContextId, statusQuerySender = sendMetaQuery, statusPollIntervalMs = DEFAULT_STATUS_POLL_INTERVAL_MS,
  statusTimeoutMs = DEFAULT_STATUS_TIMEOUT_MS, statusSleep = sleep, statusWaiter = waitForThreadsPostPublished,
  configureRetryTimeoutMs = DEFAULT_CONFIGURE_RETRY_TIMEOUT_MS,
  configureRetryStartMs = DEFAULT_CONFIGURE_RETRY_START_MS,
  configureRetrySleep = sleep,
  topic,
  allowTopicMedia = false,
  readbackClient = readThreadsPostsById, readbackOptions = {},
} = {}) {
  if (!Array.isArray(posts) || posts.length < 1 || posts.some(post => typeof post !== 'string' || !post.trim())) fail('THREADS_POSTS_INVALID');
  if (selfThreadContextId !== undefined && (typeof selfThreadContextId !== 'string' || !selfThreadContextId)) fail('THREADS_CONTEXT_ID_INVALID');
  const topics = topicsForPublish(topic, posts.length);
  if (typeof transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const groupedImages = imageGroups(images, posts.length);
  const groupedVideos = videoGroups(videos, posts.length);
  for (let index = 0; index < posts.length; index += 1) {
    if (topics[index] && groupedVideos[index].length) fail('THREADS_TOPIC_MEDIA_UNVERIFIED');
    if (topics[index] && groupedImages[index].length && allowTopicMedia !== true) fail('THREADS_TOPIC_MEDIA_UNVERIFIED');
  }
  journalDir ??= defaultJournalDir();
  const currentSession = await requireSession(session, loadSession);
  const run = runKey || (runDir && runKeyFor(runDir));
  if (!run) fail('SNS_RUN_KEY_REQUIRED');
  const preparedImages = await Promise.all(groupedImages.map(group => Promise.all(group.map(imageInput))));
  const preparedVideos = await Promise.all(groupedVideos.map(group => Promise.all(group.map(videoInput))));
  const currentRequest = groupedImages.some(group => group.length) || groupedVideos.some(group => group.length)
    ? await currentRequestContext(currentSession, { requestContext, metaContextLoader }) : requestContext;
  if (!Number.isFinite(configureRetryTimeoutMs) || configureRetryTimeoutMs < 0
    || !Number.isFinite(configureRetryStartMs) || configureRetryStartMs < 0
    || typeof configureRetrySleep !== 'function') fail('THREADS_CONFIGURE_RETRY_CONFIG_INVALID');
  await reserveThreadsChain({ runKey: run, journalDir });
  const chainId = randomUUIDImpl();
  const sharedSelfThreadContextId = selfThreadContextId ?? randomUUIDImpl();
  const ids = [];
  const permalinks = [];
  const runOne = async request => {
    const { response, checkpoint } = await journaledRequest({ channel: 'threads', runKey: run, journalDir, request,
      send: async requestToSend => {
        const headers = { ...requestToSend.headers, cookie: cookieHeader(currentSession) };
        const csrf = sessionCookie(currentSession, 'csrftoken');
        if (csrf) headers['X-CSRFToken'] = csrf;
        // An accepted response is outcome-unknown until decoded/read back.
        // Preserve the journal and use status reads instead of resending create.
        const result = await transport({ ...requestToSend, headers });
        await rotateCookies(currentSession, result);
        return result;
      }, returnJournal: true });
    await assertResponse(response);
    const payload = await responseJson(response);
    return { response, payload, checkpoint };
  };
  // Chain metadata alone does not link posts in the rendered Threads timeline. A scalar replyId
  // seeds the first post; each later post replies to the previous returned create ID. An array
  // keeps the legacy per-post override semantics: null/undefined entries stay top-level.
  for (let index = 0; index < posts.length; index += 1) {
    const uploaded = [];
    const sidecar = groupedImages[index].length + groupedVideos[index].length > 1;
    for (const data of preparedImages[index]) {
      const result = await uploadThreadsImageData(data, { session: currentSession, requestContext: currentRequest,
        sidecar, transport, rotateCookies, journalDir, runKey: run,
        // Numeric createUploadID-style ids for every photo (the composer uses the same helper with or without a topic).
        uploadId: imageUploadIdFactory() });
      uploaded.push({ uploadId: result.uploadId,
        ...(data.customAccessibilityCaption != null ? { customAccessibilityCaption: data.customAccessibilityCaption } : {}),
        ...(data.usertags != null ? { usertags: data.usertags } : {}) });
    }
    for (const data of preparedVideos[index]) {
      const result = await uploadThreadsVideoData(data, { session: currentSession, requestContext: currentRequest,
        sidecar, transport, rotateCookies, journalDir, runKey: run, uploadId: videoUploadIdFactory() });
      uploaded.push({ uploadId: result.uploadId });
    }
    let postReplyId;
    if (Array.isArray(replyId)) postReplyId = replyId[index];
    else if (index === 0) postReplyId = replyId;
    else postReplyId = ids[index - 1];
    const request = buildThreadsConfigureRequest({ caption: posts[index], uploadIds: uploaded,
      ...(uploaded.length ? {} : { uploadId: randomUUIDImpl() }), chainId, chainIndex: index, chainLength: posts.length,
      replyId: postReplyId,
      replyControl: Array.isArray(replyControl) ? replyControl[index] : replyControl,
      linkPreviewURL: Array.isArray(linkPreviewURL) ? linkPreviewURL[index] : linkPreviewURL,
      fediverseComposerEnabled, creatorGeoGatingInfo, selfThreadContextId: sharedSelfThreadContextId,
      topic: topics[index],
      allowTopicMedia,
      requestContext: currentRequest,
      webSessionId: sessionHeader(currentSession, 'x-web-session-id'), session: currentSession });
    const { response, payload, checkpoint } = await runOne(request);
    let created = parseThreadsCreateResponse(payload, response);
    if (created.pendingPostClientId) {
      if (typeof statusWaiter !== 'function') fail('THREADS_STATUS_WAITER_REQUIRED');
      const postId = await statusWaiter(created.pendingPostClientId, { session: currentSession, metaContextLoader,
        querySender: statusQuerySender, pollIntervalMs: statusPollIntervalMs, timeoutMs: statusTimeoutMs,
        sleepImpl: statusSleep });
      created = { id: validateThreadsPostId(postId, 'THREADS_CREATE_STATUS_SCHEMA'), permalink: null };
    }
    await checkpoint({ kind: 'threads_post_created', postId: created.id, permalink: created.permalink });
    ids.push(created.id);
    permalinks.push(created.permalink);
  }
  let readback = null;
  let readbackVerified = false;
  let readbackReason = null;
  try {
    readback = await readbackClient(ids, readbackOptions, posts);
    const verification = verifyThreadsChainReadback(readback, ids, posts);
    readbackVerified = verification.verified;
    if (!readbackVerified) readbackReason = verification.reason;
    else readback = { ...readback, chain: verification };
  } catch (error) {
    readbackReason = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'THREADS_READBACK_FAILED';
  }
  return { ids, permalinks, readbackVerified, ...(readbackReason ? { readbackReason } : {}),
    ...(readback ? { readback } : {}) };
}
