// X video upload client retained by commit a4e0b02. One protected-session HTTP byte-upload replay succeeded on
// 2026-09-28; its sanitized phase receipt is in apps/social-actions/evidence/x-video-upload-live-2026-09-28.json.
// The original first-party chunk 68037 source excerpt and raw response bodies were not retained. The profile-picture
// route is separate. Future posts require the explicit processing state now checked below.
// Route: upload.x.com/i/media/upload.json
//   INIT     POST command=INIT&total_bytes&media_type=video/mp4&media_category=tweet_video
//   APPEND   POST command=APPEND&media_id&segment_index + multipart field "media" (one request per chunk)
//   FINALIZE POST command=FINALIZE&media_id
//   STATUS   GET  command=STATUS&media_id until processing_info.state is "succeeded" (wait check_after_secs)
// CreateTweet then carries media.media_entities [{media_id, tagged_users: []}] (main.js composer). Session cookies and
// headers come from the protected X state; the upload host is added to an in-memory copy only. No value is printed.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SOCIAL_REQUEST_TIMEOUTS } from '../../../../social-actions/lib/request-timeouts.mjs';
import { createBotDebugFetch } from '../../../../social-actions/lib/bot-debug-log.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { defaultJournalDir, journaledRequest } from './journal.mjs';

import { webApiPlaybookRoot } from '../../../adapters/web-auth-provider.mjs';
const PB = webApiPlaybookRoot();
const API = 'https://api.x.com', UPLOAD = 'https://upload.x.com';
const CHUNK = 2 * 1024 * 1024;
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

function imageDetails(input) {
  const file = typeof input === 'string' ? input : input?.path ?? input?.file;
  const bytes = Buffer.isBuffer(input) || input instanceof Uint8Array ? Buffer.from(input)
    : input?.bytes ? Buffer.from(input.bytes) : file ? readFileSync(file) : null;
  if (!bytes?.length) fail('X_IMAGE_INVALID');
  const filename = path.basename(String(input?.filename ?? file ?? 'image'));
  const extensionMime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(filename).toLowerCase()];
  const mimeType = input?.mimeType || extensionMime;
  if (!['image/png', 'image/jpeg'].includes(mimeType)) fail('X_IMAGE_TYPE_INVALID');
  const validSignature = mimeType === 'image/png'
    ? bytes.length >= 24 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a'
    : bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (!validSignature) fail('X_IMAGE_SIGNATURE_INVALID');
  return { bytes, filename, mimeType, sha256: sha256(bytes) };
}

function commandUrl(command, query = {}) {
  return `${UPLOAD}/i/media/upload.json?${new URLSearchParams({ command, ...query })}`;
}

// Plan only: no protected session is loaded and no request is sent. The phases
// mirror the public X composer upload helper in bundle chunk 68037.
export function buildXImageUploadPlan(input) {
  const image = imageDetails(input);
  const appendCount = Math.ceil(image.bytes.length / CHUNK);
  const requests = [{ method: 'POST', url: commandUrl('INIT', {
    total_bytes: String(image.bytes.length), media_type: image.mimeType, media_category: 'tweet_image',
  }), command: 'INIT' }];
  for (let segment = 0; segment < appendCount; segment += 1) {
    requests.push({ method: 'POST', url: commandUrl('APPEND', {
      media_id: '<media_id_string from INIT>', segment_index: String(segment),
    }), command: 'APPEND', contentType: `multipart/form-data; boundary=<generated>`,
    multipart: { field: 'media', mimeType: image.mimeType, byteLength: Math.min(CHUNK, image.bytes.length - segment * CHUNK) } });
  }
  requests.push({ method: 'POST', url: commandUrl('FINALIZE', { media_id: '<media_id_string from INIT>' }), command: 'FINALIZE' });
  return { operation: 'x_image_upload', endpoint: `${UPLOAD}/i/media/upload.json`, mediaCategory: 'tweet_image',
    mediaType: image.mimeType, filename: image.filename, bytes: image.bytes.length, imageSha256: image.sha256,
    attachedPostIndex: 0, requests };
}

export function parseXMediaResponse(stage, response, { allowEmpty = false } = {}) {
  const status = Number(response?.status);
  if (!Number.isFinite(status) || status < 200 || status >= 300) {
    fail(`X_MEDIA_${stage}_FAILED`, { httpStatus: Number.isFinite(status) ? status : null });
  }
  const raw = response?.raw == null ? Buffer.alloc(0) : Buffer.from(response.raw);
  if (!raw.length && allowEmpty) return null;
  if (!raw.length) fail(`X_MEDIA_${stage}_RESPONSE_INVALID`, { httpStatus: status });
  let json;
  try { json = JSON.parse(raw.toString('utf8')); }
  catch { fail(`X_MEDIA_${stage}_RESPONSE_INVALID`, { httpStatus: status }); }
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.errors?.length || json.error) {
    fail(`X_MEDIA_${stage}_REJECTED`, { httpStatus: status });
  }
  return json;
}

async function runXChunkedUploadProtocol(bytes, { sendRequest, sleep = ms => new Promise(r => setTimeout(r, ms)),
  maxWaitMs = 300000, journalDir = defaultJournalDir(), runKey, mediaType, mediaCategory, imageSha256 = null,
  allowImmediateFinalize = false } = {}) {
  if (typeof runKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runKey)) fail('SNS_RUN_KEY_REQUIRED');
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) fail('X_VIDEO_BYTES_INVALID');
  if (typeof sendRequest !== 'function') fail('X_MEDIA_TRANSPORT_REQUIRED');
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 10 * 60 * 1000) fail('X_MEDIA_WAIT_LIMIT_INVALID');
  if (typeof sleep !== 'function') fail('X_MEDIA_SLEEP_INVALID');
  bytes = Buffer.from(bytes);
  if (mediaCategory === 'tweet_video' && (bytes.length < 1000 || bytes.toString('ascii', 4, 8) !== 'ftyp')) fail('X_VIDEO_NOT_MP4');
  if (mediaCategory === 'tweet_image' && !['image/png', 'image/jpeg'].includes(mediaType)) fail('X_IMAGE_TYPE_INVALID');
  if (mediaCategory !== 'tweet_video' && mediaCategory !== 'tweet_image') fail('X_MEDIA_CATEGORY_INVALID');
  if (bytes.length > 512 * 1024 * 1024) fail('X_VIDEO_TOO_LARGE');
  const call = async (method, query, { body = null, contentType = null } = {}) => {
    const request = { method, url: `${UPLOAD}/i/media/upload.json?${new URLSearchParams(query)}`,
      headers: contentType ? { 'content-type': contentType } : {}, ...(body ? { body } : {}),
      ...(imageSha256 ? { assetSha256: imageSha256 } : {}) };
    return journaledRequest({ channel: 'x', runKey, journalDir, request, send: sendRequest });
  };
  const init = parseXMediaResponse('INIT', await call('POST', { command: 'INIT', total_bytes: String(bytes.length),
    media_type: mediaType, media_category: mediaCategory }));
  const mediaId = init.media_id_string;
  if (!/^\d{1,25}$/.test(mediaId ?? '')) fail('X_MEDIA_INIT_SCHEMA');
  for (let i = 0, seg = 0; i < bytes.length; i += CHUNK, seg++) {
    const boundary = `----xmedia${Date.now()}${seg}`;
    const part = bytes.subarray(i, i + CHUNK);
    const partMime = mediaType.startsWith('image/') ? mediaType : 'application/octet-stream';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="blob"\r\nContent-Type: ${partMime}\r\n\r\n`), part, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    parseXMediaResponse('APPEND', await call('POST', { command: 'APPEND', media_id: mediaId, segment_index: String(seg) },
      { body, contentType: `multipart/form-data; boundary=${boundary}` }), { allowEmpty: true });
  }
  const fin = parseXMediaResponse('FINALIZE', await call('POST', { command: 'FINALIZE', media_id: mediaId }));
  let info = fin.processing_info ?? null;
  if (allowImmediateFinalize && info == null) return { mediaId, bytes: bytes.length, processed: true,
    ...(imageSha256 ? { imageSha256 } : {}) };
  if (!info || typeof info.state !== 'string') fail('X_MEDIA_FINALIZE_SCHEMA');
  const started = Date.now();
  while (info.state !== 'succeeded') {
    if (info?.state === 'failed') fail('X_MEDIA_PROCESSING_FAILED', { error: info.error?.name ?? null });
    if (!['pending', 'in_progress'].includes(info.state)) fail('X_MEDIA_PROCESSING_STATE_INVALID');
    const remaining = maxWaitMs - (Date.now() - started);
    if (remaining <= 0) fail('X_MEDIA_PROCESSING_TIMEOUT');
    const delayMs = Math.max(1, Number(info?.check_after_secs) || 2) * 1000;
    await sleep(Math.min(delayMs, remaining));
    if (Date.now() - started >= maxWaitMs) fail('X_MEDIA_PROCESSING_TIMEOUT');
    const st = parseXMediaResponse('STATUS', await call('GET', { command: 'STATUS', media_id: mediaId }));
    info = st.processing_info ?? null;
    if (!info || typeof info.state !== 'string') fail('X_MEDIA_STATUS_SCHEMA');
  }
  return { mediaId, bytes: bytes.length, processed: true, ...(imageSha256 ? { imageSha256 } : {}) };
}

export async function runXVideoUploadProtocol(bytes, options = {}) {
  const video = Buffer.from(bytes || []);
  if (video.length < 1000 || video.toString('ascii', 4, 8) !== 'ftyp') fail('X_VIDEO_NOT_MP4');
  if (video.length > 512 * 1024 * 1024) fail('X_VIDEO_TOO_LARGE');
  return runXChunkedUploadProtocol(video, { ...options, mediaType: 'video/mp4', mediaCategory: 'tweet_video' });
}

export async function runXImageUploadProtocol(input, options = {}) {
  const image = imageDetails(input);
  return runXChunkedUploadProtocol(image.bytes, { ...options, mediaType: image.mimeType, mediaCategory: 'tweet_image',
    imageSha256: image.sha256, allowImmediateFinalize: true });
}

async function createXUploadTransport() {
  const { ProtectedStore } = await import(pathToFileURL(`${PB}/lib/protected-store.mjs`).href);
  const { ScopedSession } = await import(pathToFileURL(`${PB}/lib/scoped-session.mjs`).href);
  const { CookieJar } = createRequire(`${PB}/package.json`)('tough-cookie');
  const state = JSON.parse(new ProtectedStore().read('x-web-state'));
  const session = JSON.parse(JSON.stringify(state.session));
  session.allowedOrigins = [...new Set([...session.allowedOrigins, UPLOAD])];
  session.cookieOrigins = [...new Set([...session.cookieOrigins, UPLOAD])];
  session.timeoutMs = SOCIAL_REQUEST_TIMEOUTS.write;
  const baseHeaders = { ...session.headersByOrigin[API] };
  delete baseHeaders['x-client-transaction-id'];
  session.headersByOrigin[UPLOAD] = { ...baseHeaders, 'x-twitter-auth-type': 'OAuth2Session', referer: 'https://x.com/' };
  const fetchImpl = createBotDebugFetch(globalThis.fetch, { service: 'x' });
  let scoped = ScopedSession.fromJSON(session, { fetchImpl });
  const sendRequest = async request => {
    let csrf;
    try { csrf = CookieJar.deserializeSync(scoped.toJSON().cookieJar).getCookiesSync(`${API}/`).find(c => c.key === 'ct0')?.value; }
    catch { fail('X_SESSION_COOKIE_INVALID'); }
    if (!csrf) fail('X_REAUTH_REQUIRED');
    const active = scoped.toJSON();
    active.headersByOrigin[UPLOAD]['x-csrf-token'] = csrf;
    scoped = ScopedSession.fromJSON(active, { fetchImpl });
    const response = await scoped.request(request.url, { method: request.method,
      ...(request.body ? { body: request.body, headers: request.headers } : {}) });
    const rotated = scoped.toJSON();
    rotated.headersByOrigin[UPLOAD]['x-csrf-token'] = CookieJar.deserializeSync(rotated.cookieJar)
      .getCookiesSync(`${API}/`).find(c => c.key === 'ct0')?.value ?? csrf;
    scoped = ScopedSession.fromJSON(rotated, { fetchImpl });
    return response;
  };
  return sendRequest;
}

export async function uploadImage(input, { sleep, maxWaitMs, journalDir = defaultJournalDir(), runKey } = {}) {
  if (typeof runKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runKey)) fail('SNS_RUN_KEY_REQUIRED');
  const image = imageDetails(input);
  const sendRequest = await createXUploadTransport();
  return runXImageUploadProtocol({ ...image, bytes: image.bytes }, { sendRequest,
    ...(sleep ? { sleep } : {}), ...(maxWaitMs != null ? { maxWaitMs } : {}), journalDir, runKey });
}

export async function uploadVideo(file, { sleep, maxWaitMs, journalDir = defaultJournalDir(), runKey } = {}) {
  if (typeof runKey !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(runKey)) fail('SNS_RUN_KEY_REQUIRED');
  const bytes = readFileSync(file);
  const sendRequest = await createXUploadTransport();
  return runXVideoUploadProtocol(bytes, { sendRequest, ...(sleep ? { sleep } : {}), ...(maxWaitMs != null ? { maxWaitMs } : {}), journalDir, runKey });
}
