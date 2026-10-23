import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadMetaSession, rotateMetaCookies } from '../../../../naver-blog-api/scripts/meta-auth-session.mjs';
import { freshMetaAuthFields, openMetaContext } from '../../../../social-actions/lib/meta-bootstrap.mjs';
import { buildInstagramUploadEnvelope } from '../../../../social-actions/instagram-publisher.mjs';
import { journaledRequest, defaultJournalDir, runKeyFor } from './journal.mjs';

const IG_ORIGIN = 'https://www.instagram.com';
const IG_RUPLOAD_ORIGIN = 'https://i.instagram.com';
const fail = code => { throw Object.assign(new Error(code), { code }); };
let lastInstagramUploadId = 0;

function newInstagramUploadId(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 1) fail('INSTAGRAM_UPLOAD_ID_INVALID');
  lastInstagramUploadId = now > lastInstagramUploadId ? now : lastInstagramUploadId + 1;
  return String(lastInstagramUploadId);
}

function sessionCookie(session, name) {
  return session?.cookies?.find(cookie => cookie.name === name)?.value;
}

function sessionHeader(session, name) {
  const headers = session?.ownerRequest?.headers || {};
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function sessionHeaders(session) {
  if (!session || session.service !== 'instagram') fail('META_SESSION_REQUIRED');
  const headers = {};
  // Evidence: logged-in Instagram excerpt key `PolarisInstajaxRequestHeader`.
  for (const [source, target] of [
    ['x-instagram-ajax', 'X-Instagram-AJAX'], ['x-ig-app-id', 'X-IG-App-ID'], ['x-asbd-id', 'X-ASBD-ID'],
    ['x-ig-www-claim', 'X-IG-WWW-Claim'], ['x-web-session-id', 'X-Web-Session-ID'],
    ['x-web-device-id', 'X-Web-Device-Id'], ['x-mid', 'X-Mid'], ['x-bloks-version-id', 'X-BLOKS-VERSION-ID'],
  ]) {
    const value = sessionHeader(session, source);
    if (value) headers[target] = value;
  }
  const csrf = sessionCookie(session, 'csrftoken');
  if (!csrf) fail('META_CSRF_MISSING');
  if (!headers['X-IG-App-ID']) fail('META_APP_ID_MISSING');
  headers['X-CSRFToken'] = csrf;
  headers.cookie = (session.cookies || []).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  headers.Accept = '*/*';
  headers.Origin = IG_ORIGIN;
  headers.Referer = `${IG_ORIGIN}/`;
  const userAgent = sessionHeader(session, 'user-agent');
  if (userAgent) headers['User-Agent'] = userAgent;
  headers['X-Requested-With'] = sessionHeader(session, 'x-requested-with') || 'XMLHttpRequest';
  return headers;
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

function assertImage(bytes, width, height, mimeType) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!data.length || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !mimeType) fail('INSTAGRAM_IMAGE_INVALID');
  return data;
}

// Evidence: Instagram excerpt key `__d("PolarisAPIRuploadPhoto"` confirms
// the rupload path, offsets, entity headers, parameter names, and raw file body.
export function buildInstagramPhotoUploadRequest({ bytes, width, height, mimeType = 'image/png', uploadId,
  entityName = uploadId, session }) {
  const data = assertImage(bytes, width, height, mimeType);
  if (!uploadId || !entityName) fail('INSTAGRAM_UPLOAD_ID_REQUIRED');
  const params = { media_type: 1, upload_id: uploadId, upload_media_height: height, upload_media_width: width };
  return {
    method: 'POST', url: `${IG_RUPLOAD_ORIGIN}/rupload_igphoto/${encodeURIComponent(entityName)}`,
    headers: { ...sessionHeaders(session), Offset: '0', 'X-Entity-Length': String(data.length),
      'X-Entity-Name': entityName, 'X-Entity-Type': mimeType, 'X-Instagram-Rupload-Params': JSON.stringify(params) },
    body: data,
  };
}

// Dry-run mirror of the captured Reel upload envelope. Real sends use the
// current source-guarded buildInstagramUploadEnvelope below.
export function buildInstagramVideoUploadRequest({ bytes, width, height, durationMs, mimeType = 'video/mp4', uploadId,
  entityName = `fb_uploader_${uploadId}`, session }) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!data.length || !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
    || !Number.isFinite(durationMs) || durationMs <= 0 || !/^\d{1,20}$/.test(String(uploadId))
    || entityName !== `fb_uploader_${uploadId}` || mimeType !== 'video/mp4'
    || data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp') fail('INSTAGRAM_VIDEO_INVALID');
  const params = {
    'client-passthrough': '1', is_clips_video: '1', for_album: false, is_sidecar: '0', media_type: 2,
    upload_id: String(uploadId), upload_media_duration_ms: Math.round(durationMs), upload_media_height: height,
    upload_media_width: width, video_format: '', video_transform: null,
  };
  return {
    method: 'POST', url: `${IG_RUPLOAD_ORIGIN}/rupload_igvideo/${encodeURIComponent(entityName)}`,
    headers: { ...sessionHeaders(session), Offset: '0', 'X-Entity-Length': String(data.length), 'X-Entity-Name': entityName,
      'X-Instagram-Rupload-Params': JSON.stringify(params) },
    body: data,
  };
}

export function buildInstagramReelCoverUploadRequest({ bytes, width, height, uploadId, entityName = `fb_uploader_${uploadId}`, session }) {
  const data = assertImage(bytes, width, height, 'image/jpeg');
  if (data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
    fail('INSTAGRAM_REEL_COVER_JPEG_REQUIRED');
  }
  if (!/^\d{1,20}$/.test(String(uploadId)) || entityName !== `fb_uploader_${uploadId}`) fail('INSTAGRAM_UPLOAD_ID_INVALID');
  const params = { media_type: 2, upload_id: String(uploadId), upload_media_height: height, upload_media_width: width };
  return {
    method: 'POST', url: `${IG_RUPLOAD_ORIGIN}/rupload_igphoto/${encodeURIComponent(entityName)}`,
    headers: { ...sessionHeaders(session), 'Content-Type': 'image/jpeg', Offset: '0', 'X-Entity-Length': String(data.length),
      'X-Entity-Name': entityName, 'X-Entity-Type': 'image/jpeg', 'X-Instagram-Rupload-Params': JSON.stringify(params) },
    body: data,
  };
}

// Browser capture 2026-09-28: JSON application body, with fresh first-party
// fb_dtsg/jazoest fields. The final browser request was blocked before send.
export function buildInstagramCarouselConfigureRequest({ caption, uploadIds, clientSidecarId = randomUUID(), requestContext, session }) {
  if (typeof caption !== 'string' || !caption.trim() || !Array.isArray(uploadIds) || uploadIds.length < 2 || uploadIds.length > 10) {
    fail('INSTAGRAM_CAROUSEL_INVALID');
  }
  if (typeof requestContext?.fbDtsg !== 'string' || !requestContext.fbDtsg || requestContext.fbDtsg.length > 8192
    || /[\x00-\x20\x7f]/.test(requestContext.fbDtsg) || typeof requestContext.jazoest !== 'string'
    || !/^\d{1,12}$/.test(requestContext.jazoest)) fail('INSTAGRAM_FRESH_REQUEST_CONTEXT_REQUIRED');
  return {
    method: 'POST', url: `${IG_ORIGIN}/api/v1/media/configure_sidecar/`,
    headers: { ...sessionHeaders(session), 'Content-Type': 'application/json' },
    body: { archive_only: false, caption, children_metadata: uploadIds.map(upload_id => ({ upload_id: String(upload_id) })),
      client_sidecar_id: clientSidecarId, disable_comments: '0', fb_dtsg: requestContext.fbDtsg,
      is_open_to_public_submission: false, jazoest: requestContext.jazoest, like_and_view_counts_disabled: 0,
      media_share_flow: 'creation_flow', share_to_facebook: '', share_to_fb_destination_type: 'USER', source_type: 'library' },
  };
}

export async function loadInstagramRequestContext(session, { contextLoader = openMetaContext } = {}) {
  if (session?.service !== 'instagram' || session.owner !== 'lifehack__ailab') fail('META_OWNER_MISMATCH');
  const context = await contextLoader('instagram', session.owner);
  if (context?.service !== 'instagram' || context.handle?.toLowerCase() !== session.owner.toLowerCase()
    || context.bundle?.owner?.toLowerCase() !== session.owner.toLowerCase()) fail('INSTAGRAM_REQUEST_CONTEXT_OWNER_MISMATCH');
  return freshMetaAuthFields(context);
}

// Evidence: Instagram excerpt keys `"/api/v1/media/configure_to_clips/"` and
// contracts.json operation `reels_configure_to_clips` exposes the remaining fields.
export function buildInstagramReelConfigureRequest({ caption, uploadId, sourceType, videoSubtitlesEnabled = false,
  clipsAudioMetadata, musicParams, session }) {
  if (typeof caption !== 'string' || !caption.trim() || !uploadId) fail('INSTAGRAM_REEL_INVALID');
  if (typeof sourceType !== 'string' || !sourceType.trim()) fail('NOT_IMPLEMENTED_CONTRACT_MISSING');
  if (clipsAudioMetadata !== undefined && clipsAudioMetadata !== null && typeof clipsAudioMetadata !== 'string') fail('INSTAGRAM_CLIPS_AUDIO_METADATA_MUST_BE_JSON');
  if (musicParams !== undefined && musicParams !== null && typeof musicParams !== 'string') fail('INSTAGRAM_MUSIC_PARAMS_MUST_BE_JSON');
  return {
    method: 'POST', url: `${IG_ORIGIN}/api/v1/media/configure_to_clips/`,
    headers: { ...sessionHeaders(session), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({ upload_id: String(uploadId), caption, source_type: sourceType,
      video_subtitles_enabled: videoSubtitlesEnabled ? '1' : '0', clips_audio_metadata: clipsAudioMetadata, music_params: musicParams }),
  };
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail('SNS_PNG_CONTRACT_MISSING');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('INSTAGRAM_JPEG_INVALID');
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (sof.has(marker) && segmentLength >= 7) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    offset += segmentLength;
  }
  fail('INSTAGRAM_JPEG_DIMENSIONS_UNREADABLE');
}

async function imageBytes(input) {
  const bytes = Buffer.isBuffer(input) ? input : input?.bytes ? Buffer.from(input.bytes) : await readFile(input?.path ?? input);
  const file = typeof input === 'string' ? input : input?.path;
  const mimeType = input?.mimeType || (file && /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png');
  const dimensions = Number.isInteger(input?.width) && Number.isInteger(input?.height) ? input
    : mimeType === 'image/jpeg' ? jpegDimensions(bytes) : pngDimensions(bytes);
  return { bytes, width: dimensions.width, height: dimensions.height, mimeType };
}

async function videoBytes(input) {
  if (input?.bytes) return Buffer.from(input.bytes);
  if (Buffer.isBuffer(input)) return input;
  return readFile(input);
}

async function responseJson(response) {
  if (typeof response?.text === 'function') {
    const text = (await response.text()).replace(/^for \(;;\);\s*/, '');
    try { return JSON.parse(text); } catch { fail('SNS_RESPONSE_NOT_JSON'); }
  }
  if (typeof response?.json === 'function') return response.json();
  if (response?.body && typeof response.body === 'object') return response.body;
  if (response?.data && typeof response.data === 'object') return response.data;
  return response;
}

function safeProviderText(value) {
  return String(value ?? '').replace(/[\r\n\0-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\b(fb_dtsg|jazoest|lsd|csrf(?:token)?|cookie|sessionid|authorization|access_token|refresh_token)\b\s*[:=]\s*[^\s,;"}]*/gi,
      '$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]').trim().slice(0, 180);
}

async function assertResponse(response) {
  const status = Number(response?.status ?? 200);
  if (response?.ok === false || status < 200 || status >= 300) {
    let detail = null;
    try {
      const parsed = JSON.parse(await response.text());
      const parts = ['message', 'error_type', 'error_title'].map(key => safeProviderText(parsed?.[key])).filter(Boolean);
      detail = parts.join(' | ').slice(0, 300) || null;
    } catch {
      const contentType = safeProviderText(response.headers?.get?.('content-type') || 'unknown');
      detail = `response body omitted (${contentType})`;
    }
    throw Object.assign(new Error(`INSTAGRAM_HTTP_${status}`), { code: `INSTAGRAM_HTTP_${status}`, httpStatus: status, detail });
  }
}

function mediaReceipt(payload) {
  const media = payload?.media ?? payload?.data?.media ?? payload?.media_info;
  const id = media?.pk ?? media?.strong_id__ ?? media?.id ?? payload?.id;
  if (!id) fail('INSTAGRAM_CREATE_SCHEMA');
  return { id: String(id), permalink: media?.permalink ?? null };
}

async function requireSession(session, loadSession) {
  const value = session || await loadSession('instagram');
  if (value?.service !== 'instagram' || value.owner !== 'lifehack__ailab') fail('META_OWNER_MISMATCH');
  return value;
}

function scopeOptions(options, channel = 'instagram') {
  const runKey = options.runKey || (options.runDir && runKeyFor(options.runDir));
  if (!runKey) fail('SNS_RUN_KEY_REQUIRED');
  return { channel, runKey, journalDir: options.journalDir || undefined };
}

export async function publishCarousel(pngFiles, caption, options = {}) {
  if (!Array.isArray(pngFiles) || pngFiles.length < 2 || pngFiles.length > 10) fail('INSTAGRAM_CAROUSEL_INVALID');
  if (typeof caption !== 'string' || !caption.trim()) fail('INSTAGRAM_CAPTION_INVALID');
  if (typeof options.transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const session = await requireSession(options.session, options.loadSession || loadMetaSession);
  const requestContext = options.requestContext || await (options.loadRequestContext || loadInstagramRequestContext)(session,
    { contextLoader: options.metaContextLoader || openMetaContext });
  const rotate = options.rotateCookies || rotateMetaCookies;
  const uuid = options.randomUUIDImpl || randomUUID;
  const scope = scopeOptions(options);
  const uploadIds = [];
  for (const file of pngFiles) {
    const image = await imageBytes(file);
    const uploadId = uuid();
    const request = buildInstagramPhotoUploadRequest({ ...image, uploadId, session });
    const response = await journaledRequest({ ...scope, request, send: options.transport });
    await rotate(session, response);
    await assertResponse(response);
    const payload = await responseJson(response);
    const id = payload?.upload_id ?? payload?.data?.upload_id;
    if (!id) fail('INSTAGRAM_UPLOAD_SCHEMA');
    uploadIds.push(String(id));
  }
  const configure = buildInstagramCarouselConfigureRequest({ caption, uploadIds, clientSidecarId: uuid(), requestContext, session });
  const response = await journaledRequest({ ...scope, request: configure, send: options.transport });
  await rotate(session, response);
  await assertResponse(response);
  const receipt = mediaReceipt(await responseJson(response));
  return { id: receipt.id, permalink: receipt.permalink, readbackVerified: false,
    readbackReason: 'INSTAGRAM_READBACK_CONTRACT_MISSING' };
}

async function uploadInstagramVideo(mp4, options = {}) {
  if (typeof options.transport !== 'function') fail('SNS_TRANSPORT_REQUIRED');
  const videoInfo = options.videoInfo;
  if (!videoInfo || !Number.isInteger(videoInfo.width) || !Number.isInteger(videoInfo.height)
    || !Number.isFinite(videoInfo.durationMs) || videoInfo.durationMs <= 0) fail('NOT_IMPLEMENTED_CONTRACT_MISSING');
  const session = await requireSession(options.session, options.loadSession || loadMetaSession);
  const rotate = options.rotateCookies || rotateMetaCookies;
  const scope = scopeOptions(options);
  const bytes = await videoBytes(mp4);
  if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') fail('INSTAGRAM_VIDEO_INVALID');
  const coverInput = options.cover ?? options.coverFilePath ?? videoInfo.cover;
  if (!coverInput) fail('INSTAGRAM_REEL_COVER_REQUIRED');
  const cover = await imageBytes(coverInput);
  if (cover.mimeType !== 'image/jpeg') fail('INSTAGRAM_REEL_COVER_JPEG_REQUIRED');
  const uploadId = String((options.uploadIdImpl || newInstagramUploadId)());
  if (!/^\d{1,20}$/.test(uploadId)) fail('INSTAGRAM_UPLOAD_ID_INVALID');

  const context = await (options.metaContextLoader || openMetaContext)('instagram', session.owner);
  if (context?.service !== 'instagram' || context.handle?.toLowerCase() !== session.owner.toLowerCase()
    || context.bundle?.owner?.toLowerCase() !== session.owner.toLowerCase()) fail('INSTAGRAM_UPLOAD_CONTEXT_OWNER_MISMATCH');
  const videoMedia = { mediaType: 'video', mimeType: 'video/mp4', byteLength: bytes.length,
    width: videoInfo.width, height: videoInfo.height, durationMs: videoInfo.durationMs, buffer: bytes };
  const coverMedia = { mediaType: 'photo', mimeType: 'image/jpeg', byteLength: cover.bytes.length,
    width: cover.width, height: cover.height, buffer: cover.bytes };
  const videoEnvelope = buildInstagramUploadEnvelope(context, videoMedia, uploadId, { reelVideo: true });
  const coverEnvelope = buildInstagramUploadEnvelope(context, coverMedia, uploadId, { reelCover: true });
  const uploadRequest = (envelope, body) => ({ method: 'POST', url: envelope.url, headers: envelope.headers, body });
  const videoResponse = await journaledRequest({ ...scope, request: uploadRequest(videoEnvelope, bytes), send: options.transport });
  await rotate(context.bundle, videoResponse);
  await assertResponse(videoResponse);
  const videoResult = await responseJson(videoResponse);
  if (!videoResult || typeof videoResult !== 'object' || videoResult.error || videoResult.status === 'fail') fail('INSTAGRAM_UPLOAD_REJECTED');

  const coverResponse = await journaledRequest({ ...scope, request: uploadRequest(coverEnvelope, cover.bytes), send: options.transport });
  await rotate(context.bundle, coverResponse);
  await assertResponse(coverResponse);
  const coverResult = await responseJson(coverResponse);
  if (!coverResult || typeof coverResult !== 'object' || coverResult.error || coverResult.status === 'fail') fail('INSTAGRAM_UPLOAD_REJECTED');
  return { session: context.bundle, scope, uploadId, bytes: bytes.length, coverBytes: cover.bytes.length,
    uploadHttpStatuses: [Number(videoResponse.status), Number(coverResponse.status)], ownerVerified: true,
    sourceGuardPassed: true, videoInfo, rotate };
}

export async function uploadInstagramVideoOnly(mp4, options = {}) {
  const result = await uploadInstagramVideo(mp4, options);
  return { uploaded: true, bytes: result.bytes, width: result.videoInfo.width,
    height: result.videoInfo.height, durationMs: result.videoInfo.durationMs,
    coverBytes: result.coverBytes, mediaType: 2, writesSent: 2, uploadIdValidated: true, uploadIdValueRetained: false,
    postRequestsSent: 0, uploadHttpStatuses: result.uploadHttpStatuses, ownerVerified: result.ownerVerified,
    sourceGuardPassed: result.sourceGuardPassed, browserUsed: false };
}

export async function publishReel(mp4, caption, options = {}) {
  if (typeof caption !== 'string' || !caption.trim()) fail('INSTAGRAM_CAPTION_INVALID');
  if (typeof options.sourceType !== 'string' || !options.sourceType.trim()) fail('NOT_IMPLEMENTED_CONTRACT_MISSING');
  const upload = await uploadInstagramVideo(mp4, options);
  const configure = buildInstagramReelConfigureRequest({ caption, uploadId: upload.uploadId, session: upload.session,
    sourceType: options.sourceType, videoSubtitlesEnabled: options.videoSubtitlesEnabled ?? false,
    clipsAudioMetadata: options.clipsAudioMetadata, musicParams: options.musicParams });
  const response = await journaledRequest({ ...upload.scope, request: configure, send: options.transport });
  await upload.rotate(upload.session, response);
  await assertResponse(response);
  const receipt = mediaReceipt(await responseJson(response));
  return { id: receipt.id, permalink: receipt.permalink, readbackVerified: false,
    readbackReason: 'INSTAGRAM_READBACK_CONTRACT_MISSING' };
}
