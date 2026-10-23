import { createHash } from 'node:crypto';
import { SOCIAL_REQUEST_TIMEOUTS } from './lib/request-timeouts.mjs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  metaFail, openMetaContext, withMetaSessionLock,
} from './lib/meta-bootstrap.mjs';
import { withSessionLock as withFileLock } from '../tistory-api/lib/lock.mjs';
import { loadMetaSession, metaCookieHeader, rotateMetaCookies } from '../naver-blog-api/scripts/meta-auth-session.mjs';
import { readInstagramPosts, readInstagramProfile } from './instagram-reader.mjs';

const MAX_FILE_BYTES = 250 * 1024 * 1024;
const MAX_POST_BYTES = 250 * 1024 * 1024;
const MAX_CAROUSEL_ITEMS = 10;
const MAX_CAPTION_CHARS = 2200;
const MAX_RECONCILE_PAGES = 20;
const POSTS_PAGE_LIMIT = 12;
const JOURNAL_ROOT = path.join(os.homedir(), '.config', 'affiliate-content-operations', 'instagram-write-journal');
let lastUploadId = 0;

function fail(code) { metaFail(code); }

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function newUploadId() {
  const now = Date.now();
  lastUploadId = now > lastUploadId ? now : lastUploadId + 1;
  return String(lastUploadId);
}

function integer(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

function dimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mimeType: 'image/png', mediaType: 'photo' };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (sof.has(marker) && segmentLength >= 7) {
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3),
          mimeType: 'image/jpeg', mediaType: 'photo' };
      }
      offset += segmentLength;
    }
    fail('INSTAGRAM_MEDIA_DIMENSIONS_UNREADABLE');
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3),
        mimeType: 'image/webp', mediaType: 'photo' };
    }
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    return { mimeType: 'video/mp4', mediaType: 'video' };
  }
  fail('INSTAGRAM_MEDIA_FORMAT_UNSUPPORTED');
}

function validateDimensions(info, code = 'INSTAGRAM_MEDIA_DIMENSIONS_INVALID') {
  return {
    width: integer(info.width, 1, 30_000, code),
    height: integer(info.height, 1, 30_000, code),
  };
}

function buildCaption(caption, hashtags) {
  if (typeof caption !== 'string' || caption.length > MAX_CAPTION_CHARS) fail('INSTAGRAM_CAPTION_INVALID');
  if (!Array.isArray(hashtags) || hashtags.length > 30) fail('INSTAGRAM_HASHTAGS_INVALID');
  const checked = [];
  for (const input of hashtags) {
    if (typeof input !== 'string') fail('INSTAGRAM_HASHTAGS_INVALID');
    const tag = input.replace(/^#/, '');
    if (!/^[\p{L}\p{N}_.]{1,64}$/u.test(tag)) fail('INSTAGRAM_HASHTAGS_INVALID');
    if (!checked.some(item => item.toLowerCase() === tag.toLowerCase())) checked.push(tag);
  }
  const suffix = checked.map(tag => '#' + tag).join(' ');
  const result = [caption.trim(), suffix].filter(Boolean).join(caption.trim() ? '\n\n' : '');
  if (result.length > MAX_CAPTION_CHARS) fail('INSTAGRAM_CAPTION_TOO_LONG');
  return result;
}

async function resolveUserTags(tags, owner) {
  if (!Array.isArray(tags) || tags.length > 20) fail('INSTAGRAM_USER_TAGS_INVALID');
  const resolved = [];
  const seen = new Set();
  for (const tag of tags) {
    if (!tag || typeof tag.username !== 'string' || !/^[A-Za-z0-9_.]{1,30}$/.test(tag.username)) {
      fail('INSTAGRAM_USER_TAGS_INVALID');
    }
    const x = tag.position?.[0];
    const y = tag.position?.[1];
    if (!Array.isArray(tag.position) || tag.position.length !== 2
      || !Number.isFinite(x) || x < 0 || x > 1 || !Number.isFinite(y) || y < 0 || y > 1) {
      fail('INSTAGRAM_USER_TAG_POSITION_INVALID');
    }
    const username = tag.username.toLowerCase();
    if (seen.has(username)) fail('INSTAGRAM_USER_TAG_DUPLICATE');
    seen.add(username);
    const profile = await readInstagramProfile({ handle: username });
    if (profile.profile.username.toLowerCase() === owner.toLowerCase()) fail('INSTAGRAM_USER_TAG_SELF');
    resolved.push({ userId: profile.profile.id, username, position: [x, y] });
  }
  return resolved;
}

async function inspectMediaFile(filePath, videoMetadata) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 4096) fail('INSTAGRAM_MEDIA_PATH_INVALID');
  const absolutePath = path.resolve(filePath);
  const bytes = await readFile(absolutePath);
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) fail('INSTAGRAM_MEDIA_SIZE_INVALID');
  const detected = dimensions(bytes);
  const basic = { mediaType: detected.mediaType, mimeType: detected.mimeType, byteLength: bytes.length,
    sha256: sha256(bytes), width: null, height: null, durationMs: null };
  if (detected.mediaType === 'photo') Object.assign(basic, validateDimensions(detected));
  else {
    if (detected.mimeType !== 'video/mp4' || !videoMetadata || typeof videoMetadata !== 'object') {
      fail('INSTAGRAM_VIDEO_METADATA_REQUIRED');
    }
    Object.assign(basic, validateDimensions(videoMetadata), {
      durationMs: integer(videoMetadata.durationMs, 1, 86_400_000, 'INSTAGRAM_VIDEO_METADATA_INVALID'),
    });
  }
  return { absolutePath, buffer: bytes, ...basic };
}

async function inspectReelCoverFile(filePath) {
  const cover = await inspectMediaFile(filePath);
  if (cover.mediaType !== 'photo' || cover.mimeType !== 'image/jpeg') {
    fail('INSTAGRAM_REEL_COVER_JPEG_REQUIRED');
  }
  return cover;
}

export async function inspectInstagramMedia({ filePath, videoMetadata, coverFilePath } = {}) {
  const media = await inspectMediaFile(filePath, videoMetadata);
  const isReel = media.mediaType === 'video';
  if (isReel && typeof coverFilePath !== 'string') fail('INSTAGRAM_REEL_COVER_REQUIRED');
  if (!isReel && coverFilePath != null) fail('INSTAGRAM_REEL_COVER_NOT_APPLICABLE');
  const cover = isReel ? await inspectReelCoverFile(coverFilePath) : null;
  return { mediaType: media.mediaType, mimeType: media.mimeType, bytes: media.byteLength,
    sha256: media.sha256, width: media.width, height: media.height, durationMs: media.durationMs,
    ...(cover ? { cover: { mimeType: cover.mimeType, bytes: cover.byteLength, sha256: cover.sha256,
      width: cover.width, height: cover.height } } : {}),
    receipt: { offline: true, browserUsed: false, noUploadSent: true, captured: false, client_exists: true } };
}

function appHeader(context, name) {
  const headers = context.document.modules.get('RelayAPIConfigDefaults')?.customHeaders || {};
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function asbdHeader(context) {
  const stored = context.bundle.ownerRequest.headers['x-asbd-id'];
  if (typeof stored === 'string' && /^\d{1,12}$/.test(stored)) return stored;
  const module = context.sources.get('BDHeaderConfig')?.source || '';
  if (!module.includes('ASBD_ID')) return null;
  return /var e="(\d{3,12})";i\.ASBD_ID=e/.exec(module)?.[1] || null;
}

function ajaxHeader(context) {
  const stored = context.bundle.ownerRequest.headers['x-instagram-ajax'];
  if (typeof stored === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(stored)) return stored;
  const config = context.document.modules.get('InstagramWebPushInfo');
  if (typeof config?.rollout_hash === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(config.rollout_hash)) {
    return config.rollout_hash;
  }
  fail('INSTAGRAM_WRITE_HEADERS_UNAVAILABLE');
}

function requestHeaders(context, { url, upload = false, contentType = null } = {}) {
  let target;
  try { target = new URL(url); } catch { fail('META_REQUEST_SCOPE_INVALID'); }
  if (upload ? target.origin !== 'https://i.instagram.com' : target.origin !== context.bundle.origin) {
    fail('META_REQUEST_SCOPE_INVALID');
  }
  const csrf = context.bundle.cookies.find(cookie => cookie.name === 'csrftoken')?.value;
  const appId = appHeader(context, 'x-ig-app-id') || context.bundle.ownerRequest.headers['x-ig-app-id'];
  const asbd = asbdHeader(context);
  if (!csrf || !appId || !asbd) fail('INSTAGRAM_WRITE_HEADERS_UNAVAILABLE');
  const headers = {
    accept: '*/*',
    cookie: metaCookieHeader(context.bundle, target.href),
    origin: context.bundle.origin,
    referer: context.url,
    'x-csrftoken': csrf,
    'x-ig-app-id': appId,
    'x-asbd-id': asbd,
  };
  const userAgent = context.bundle.ownerRequest.headers['user-agent'];
  if (typeof userAgent === 'string' && userAgent.length <= 1024 && !/[\r\n]/.test(userAgent)) {
    headers['user-agent'] = userAgent;
  }
  const webSessionId = context.bundle.ownerRequest.headers['x-web-session-id'];
  if (typeof webSessionId === 'string' && webSessionId.length <= 1024 && !/[\r\n]/.test(webSessionId)) {
    headers['x-web-session-id'] = webSessionId;
  }
  const claim = context.bundle.ownerRequest.headers['x-ig-www-claim'];
  if (!upload) headers['x-ig-www-claim'] = typeof claim === 'string' ? claim : '0';
  headers['x-instagram-ajax'] = ajaxHeader(context);
  if (contentType) headers['content-type'] = contentType;
  return headers;
}

function sprinkleForToken(context, token) {
  const config = context.document.modules.get('SprinkleConfig');
  const source = context.sources.get('DTSGUtils')?.source || '';
  if (!config || config.param_name !== 'jazoest' || config.version !== 2 || config.should_randomize !== false
    || typeof token !== 'string' || !token || token.length > 8192 || /[\x00-\x20\x7f]/.test(token)
    || !source.includes('.charCodeAt(') || !source.includes('SprinkleConfig')) {
    fail('INSTAGRAM_WRITE_SPRINKLE_CONTRACT_CHANGED');
  }
  let sum = 0;
  for (let index = 0; index < token.length; index++) sum += token.charCodeAt(index);
  return String(config.version) + String(sum);
}

function numericSprinkle(context) {
  return sprinkleForToken(context, context.document.modules.get('DTSGInitialData')?.token);
}

function restBody(context, values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  body.set('jazoest', numericSprinkle(context));
  return body;
}

async function readBounded(response, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) fail('INSTAGRAM_WRITE_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function buildInstagramUploadEnvelope(context, media, uploadId, { isSidecar = false, reelVideo = false,
  reelCover = false } = {}) {
  if (typeof uploadId !== 'string' || !/^\d{1,20}$/.test(uploadId)) fail('INSTAGRAM_UPLOAD_ID_INVALID');
  if (reelVideo && (media.mediaType !== 'video' || isSidecar || reelCover)) fail('INSTAGRAM_REEL_UPLOAD_INPUT_INVALID');
  if (reelCover && (media.mediaType !== 'photo' || media.mimeType !== 'image/jpeg' || isSidecar || reelVideo)) {
    fail('INSTAGRAM_REEL_COVER_JPEG_REQUIRED');
  }
  const uploadHost = 'https://i.instagram.com';
  const photoUploadSource = context.sources.get('PolarisAPIFbUploaderPhoto')?.source || '';
  const hasUploaderPrefix = photoUploadSource.includes('entityName:"fb_uploader_"');
  if ((reelVideo || reelCover) && !hasUploaderPrefix) fail('INSTAGRAM_UPLOAD_CONTRACT_CHANGED');
  const entityName = (reelVideo || reelCover || media.mediaType === 'photo' && hasUploaderPrefix)
    ? 'fb_uploader_' + uploadId : uploadId;
  const url = media.mediaType === 'photo'
    ? uploadHost + '/rupload_igphoto/' + encodeURIComponent(entityName)
    : uploadHost + '/rupload_igvideo/' + encodeURIComponent(entityName);
  let params;
  const headers = requestHeaders(context, { url, upload: true,
    contentType: reelCover ? 'image/jpeg' : reelVideo ? null : media.mimeType });
  headers.offset = '0';
  headers['x-entity-length'] = String(media.byteLength);
  headers['x-entity-name'] = entityName;
  if (media.mediaType === 'photo') {
    const source = context.sources.get('PolarisAPIRuploadPhoto')?.source || '';
    if (!source.includes('https://i.instagram.com/rupload_igphoto/')) fail('INSTAGRAM_UPLOAD_CONTRACT_CHANGED');
    if (reelCover) {
      headers['x-entity-type'] = 'image/jpeg';
      params = {
        media_type: 2,
        upload_id: uploadId,
        upload_media_height: media.height,
        upload_media_width: media.width,
      };
    } else {
      headers['x-entity-type'] = media.mimeType;
      params = {
        media_type: isSidecar ? 1 : '1',
        upload_id: uploadId,
        upload_media_height: media.height,
        upload_media_width: media.width,
      };
    }
  } else {
    const source = context.sources.get('PolarisAPIRuploadVideo')?.source || '';
    if (!source.includes('https://i.instagram.com/rupload_igvideo/')
      || !source.includes('is_sidecar:y?"1":"0"') || !source.includes('for_album:v===')) {
      fail('INSTAGRAM_UPLOAD_CONTRACT_CHANGED');
    }
    if (reelVideo && !source.includes('is_clips_video')) fail('INSTAGRAM_UPLOAD_CONTRACT_CHANGED');
    params = reelVideo ? {
      'client-passthrough': '1',
      is_clips_video: '1',
      for_album: false,
      is_sidecar: '0',
      media_type: 2,
      upload_id: uploadId,
      upload_media_duration_ms: media.durationMs,
      upload_media_height: media.height,
      upload_media_width: media.width,
      video_format: '',
      video_transform: null,
    } : {
      'client-passthrough': '1',
      is_unified_video: '1',
      for_album: !isSidecar,
      is_sidecar: isSidecar ? '1' : '0',
      media_type: '2',
      upload_id: uploadId,
      upload_media_duration_ms: media.durationMs,
      upload_media_height: media.height,
      upload_media_width: media.width,
      video_format: media.mimeType,
      video_transform: null,
    };
  }
  headers['x-instagram-rupload-params'] = JSON.stringify(params);
  return { url, headers, entityName, params };
}

async function sendUpload(context, media, uploadId, options = {}) {
  const { url, headers, entityName } = buildInstagramUploadEnvelope(context, media, uploadId, options);
  const response = await context.fetchImpl(url, {
    method: 'POST', headers, body: media.buffer, redirect: 'manual', signal: AbortSignal.timeout(180_000),
  });
  await (options.rotateCookies || rotateMetaCookies)(context.bundle, response);
  if (response.status < 200 || response.status >= 300) fail('INSTAGRAM_UPLOAD_HTTP_' + response.status);
  const text = await readBounded(response);
  let payload;
  try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); } catch { fail('INSTAGRAM_UPLOAD_RESPONSE_INVALID'); }
  if (!payload || typeof payload !== 'object' || payload.error || payload.status === 'fail') fail('INSTAGRAM_UPLOAD_REJECTED');
  return { uploadId, entityName, httpStatus: response.status };
}

export async function uploadInstagramReelMediaOnly({ filePath, videoMetadata, coverFilePath } = {}, {
  loadSession = loadMetaSession, readProfile = readInstagramProfile, contextLoader = openMetaContext,
  withSessionLock = withMetaSessionLock, rotateCookies = rotateMetaCookies, journalRoot = JOURNAL_ROOT,
} = {}) {
  const media = await inspectMediaFile(filePath, videoMetadata);
  if (media.mediaType !== 'video') fail('INSTAGRAM_REEL_VIDEO_REQUIRED');
  const cover = await inspectReelCoverFile(coverFilePath);
  if (media.byteLength + cover.byteLength > MAX_POST_BYTES) fail('INSTAGRAM_POST_SIZE_INVALID');
  const session = await loadSession('instagram');
  const owner = session?.owner;
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_.]{1,30}$/.test(owner)) fail('META_REAUTH_REQUIRED');
  const ownerCheck = await readProfile({ handle: owner });
  if (ownerCheck?.profile?.username?.toLowerCase() !== owner.toLowerCase()) fail('META_OWNER_MISMATCH');
  const journalPath = path.join(journalRoot, `media-upload-only-${media.sha256.slice(0, 20)}-${cover.sha256.slice(0, 12)}.json`);
  const record = {
    schemaVersion: 1, service: 'instagram', operation: 'reel_media_upload_only', owner,
    state: 'reserved', createdAt: new Date().toISOString(), writesSent: 0, postRequestsSent: 0,
    media: { video: { sha256: media.sha256, bytes: media.byteLength, width: media.width, height: media.height,
      durationMs: media.durationMs }, cover: { sha256: cover.sha256, bytes: cover.byteLength,
      width: cover.width, height: cover.height } },
  };
  await writeJournal(journalPath, record, true);
  try {
    const uploads = await withSessionLock('instagram', async () => {
      const context = await contextLoader('instagram', owner);
      if (context?.service !== 'instagram' || context.bundle?.owner?.toLowerCase() !== owner.toLowerCase()) {
        fail('META_DOCUMENT_OWNER_MISMATCH');
      }
      const uploadId = newUploadId();
      record.state = 'uploading_video';
      record.writesSent = 1;
      record.sourceSha256 = sha256((context.sources.get('PolarisAPIRuploadVideo')?.source || '') + '\n'
        + (context.sources.get('PolarisAPIRuploadPhoto')?.source || ''));
      await writeJournal(journalPath, record);
      const video = await sendUpload(context, media, uploadId, { reelVideo: true, rotateCookies });
      record.videoHttpStatus = video.httpStatus;
      record.state = 'video_uploaded';
      await writeJournal(journalPath, record);

      record.state = 'uploading_cover';
      record.writesSent = 2;
      await writeJournal(journalPath, record);
      const coverUpload = await sendUpload(context, cover, uploadId, { reelCover: true, rotateCookies });
      record.coverHttpStatus = coverUpload.httpStatus;
      record.state = 'uploaded_no_post';
      await writeJournal(journalPath, record);
      return [video.httpStatus, coverUpload.httpStatus];
    });
    return { service: 'instagram', operation: 'reel_media_upload_only', state: 'uploaded_no_post',
      ownerVerified: true, browserUsed: false, writesSent: 2, postRequestsSent: 0,
      uploadHttpStatuses: uploads, videoBytes: media.byteLength, coverBytes: cover.byteLength,
      videoSha256: media.sha256, coverSha256: cover.sha256, journal: journalPath,
      sourceSha256: record.sourceSha256 };
  } catch (error) {
    record.state = record.writesSent > 0 ? 'needs_reconciliation' : 'not_sent';
    record.failureCode = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'INSTAGRAM_UPLOAD_ONLY_FAILED';
    await writeJournal(journalPath, record).catch(() => {});
    throw error;
  }
}

export function buildInstagramConfigureBody({ uploadId, caption, userTags = [], disableComments = false,
  reel = false, genAiSelfDisclosure = false }) {
  if (typeof genAiSelfDisclosure !== 'boolean') fail('INSTAGRAM_GEN_AI_DISCLOSURE_INVALID');
  if (genAiSelfDisclosure && !reel) fail('INSTAGRAM_GEN_AI_DISCLOSURE_NOT_APPLICABLE');
  const tags = userTags.length ? JSON.stringify({ in: userTags.map(tag => ({
    position: tag.position,
    user_id: tag.userId,
  })) }) : null;
  if (reel) return {
    archive_only: 'false',
    caption,
    clips_share_preview_to_feed: '1',
    disable_comments: disableComments ? '1' : '0',
    disable_oa_reuse: 'false',
    ...(genAiSelfDisclosure ? {
      gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW',
      is_gen_ai_self_disclosure: 'true',
    } : {}),
    igtv_share_preview_to_feed: '1',
    is_unified_video: '1',
    like_and_view_counts_disabled: '0',
    media_share_flow: 'creation_flow',
    share_to_facebook: '',
    share_to_fb_destination_type: 'USER',
    source_type: 'library',
    upload_id: uploadId,
    video_subtitles_enabled: '0',
    usertags: tags,
  };
  return {
    archive_only: false,
    caption,
    clips_share_preview_to_feed: '1',
    disable_comments: disableComments ? '1' : '0',
    is_unified_video: 1,
    like_and_view_counts_disabled: '0',
    media_share_flow: 'creation_flow',
    source_type: 'library',
    upload_id: uploadId,
    usertags: tags,
  };
}

export function buildInstagramSidecarConfigureBody({ uploadIds, caption, userTagsByMedia, disableComments,
  clientSidecarId, genAiSelfDisclosure = false }) {
  if (typeof genAiSelfDisclosure !== 'boolean') fail('INSTAGRAM_GEN_AI_DISCLOSURE_INVALID');
  if (!Array.isArray(uploadIds) || !Array.isArray(userTagsByMedia) || userTagsByMedia.length !== uploadIds.length
    || userTagsByMedia.some(tags => !Array.isArray(tags) || tags.length > 0)) {
    fail('INSTAGRAM_SIDECAR_TAG_CONTRACT_UNVERIFIED');
  }
  if (uploadIds.length < 2 || uploadIds.length > MAX_CAROUSEL_ITEMS
    || uploadIds.some(id => typeof id !== 'string' || !/^\d{10,20}$/.test(id))
    || new Set(uploadIds).size !== uploadIds.length || typeof clientSidecarId !== 'string'
    || !/^\d{10,20}$/.test(clientSidecarId)) fail('INSTAGRAM_SIDECAR_INPUT_INVALID');
  if (typeof caption !== 'string' || caption.length > MAX_CAPTION_CHARS
    || disableComments !== true && disableComments !== false) fail('INSTAGRAM_SIDECAR_INPUT_INVALID');
  const childrenMetadata = uploadIds.map(uploadId => ({ upload_id: uploadId }));
  return {
    archive_only: false,
    caption,
    children_metadata: childrenMetadata,
    client_sidecar_id: clientSidecarId,
    disable_comments: disableComments ? '1' : '0',
    ...(genAiSelfDisclosure ? {
      gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW',
      is_gen_ai_self_disclosure: true,
    } : {}),
    is_open_to_public_submission: false,
    like_and_view_counts_disabled: 0,
    media_share_flow: 'creation_flow',
    share_to_facebook: '',
    share_to_fb_destination_type: 'USER',
    source_type: 'library',
  };
}

function readPublishContract(context, mediaType, sidecar = false) {
  const source = context.sources.get('PolarisCreationAPI')?.source || '';
  const requestSource = context.sources.get('PolarisInstajax')?.source || '';
  if (!requestSource.includes('r("InstagramWebPushInfo").rollout_hash')) {
    fail('INSTAGRAM_REQUEST_HEADER_CONTRACT_CHANGED');
  }
  if (!source.includes('media_share_flow:"creation_flow"')) fail('INSTAGRAM_PUBLISH_CONTRACT_CHANGED');
  if (sidecar) {
    if (!context.document.gkx.has('18382') || typeof context.document.gkx.get('18382') !== 'boolean'
      || context.document.gkx.get('18382') === true || !source.includes('children_metadata:x')
      || !source.includes('client_sidecar_id:$') || !source.includes('/api/v1/media/configure_sidecar/')) {
      fail('INSTAGRAM_SIDECAR_CONTRACT_CHANGED');
    }
    return { path: '/api/v1/media/configure_sidecar/', kind: 'sidecar', sha256: sha256(source) };
  }
  if (!source.includes('upload_id:F') || !source.includes('usertags:U')) fail('INSTAGRAM_PUBLISH_CONTRACT_CHANGED');
  const path = mediaType === 'video' ? '/api/v1/media/configure_to_clips/' : '/api/v1/media/configure/';
  if (mediaType === 'video') {
    const videoMerge = context.sources.get('polarisVideoMergeUtils')?.source || '';
    if (!source.includes('o("polarisVideoMergeUtils").CONFIGURE_TO_CLIPS_ENDPOINT') || !videoMerge.includes(path)) {
      fail('INSTAGRAM_PUBLISH_CONTRACT_CHANGED');
    }
  } else if (!source.includes(path)) fail('INSTAGRAM_PUBLISH_CONTRACT_CHANGED');
  return { path, kind: mediaType, sha256: sha256(source) };
}

async function sendConfigure(context, contract, body) {
  const url = context.bundle.origin + contract.path;
  const isSidecar = contract.kind === 'sidecar';
  const values = { ...body };
  const dtsg = context.document.modules.get('DTSGInitialData')?.token;
  if (typeof dtsg === 'string' && dtsg.length <= 8192) values.fb_dtsg = dtsg;
  if (isSidecar) values.jazoest = sprinkleForToken(context, dtsg);
  const response = await context.fetchImpl(url, {
    method: 'POST',
    headers: requestHeaders(context, { url, contentType: isSidecar ? 'application/json' : 'application/x-www-form-urlencoded' }),
    body: isSidecar ? JSON.stringify(values) : restBody(context, values),
    redirect: 'manual', signal: AbortSignal.timeout(SOCIAL_REQUEST_TIMEOUTS.write),
  });
  rotateMetaCookies(context.bundle, response);
  if (response.status < 200 || response.status >= 300) fail('INSTAGRAM_PUBLISH_HTTP_' + response.status);
  const text = await readBounded(response);
  let payload;
  try { payload = JSON.parse(text.replace(/^for \(;;\);\s*/, '')); } catch { fail('INSTAGRAM_PUBLISH_RESPONSE_INVALID'); }
  if (!payload || typeof payload !== 'object') fail('INSTAGRAM_PUBLISH_RESPONSE_INVALID');
  if (payload.status === 'fail' || payload.error || payload.message && payload.statusCode >= 400) fail('INSTAGRAM_PUBLISH_REJECTED');
  const returnedMedia = payload.media && typeof payload.media === 'object'
    ? payload.media
    : Array.isArray(payload.medias) ? payload.medias.find(item => item?.media_dict)?.media_dict : null;
  const mediaId = returnedMedia?.pk == null ? null : String(returnedMedia.pk);
  const shortcode = typeof returnedMedia?.code === 'string' ? returnedMedia.code : null;
  const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : null;
  const pending = response.status === 202 || status === 'pending'
    || Array.isArray(payload.posts) && payload.posts.some(item => item?.status === 'PENDING');
  if (!mediaId && !pending) fail('INSTAGRAM_PUBLISH_OUTCOME_UNCERTAIN');
  return { httpStatus: response.status, mediaId, shortcode, pending };
}

async function writeJournal(journalPath, record, create = false) {
  await mkdir(path.dirname(journalPath), { recursive: true });
  const text = JSON.stringify(record, null, 2) + '\n';
  if (create) {
    await writeFile(journalPath, text, { flag: 'wx' });
    return;
  }
  const temporary = journalPath + '.' + process.pid + '.tmp';
  await writeFile(temporary, text, { flag: 'wx' });
  await rename(temporary, journalPath);
}

function expectedMediaFields(mediaItems) {
  const kind = mediaItems.length > 1 ? 'carousel' : mediaItems[0].mediaType === 'video' ? 'reel' : 'photo';
  const readback = kind === 'carousel'
    ? { mediaType: 8, productType: 'carousel_container', carouselCount: mediaItems.length }
    : kind === 'reel'
      ? { mediaType: 2, productType: 'clips', carouselCount: 0 }
      : { mediaType: 1, productType: 'feed', carouselCount: 0 };
  return {
    kind,
    itemCount: mediaItems.length,
    ...readback,
    items: mediaItems.map(({ mediaType, sha256: fileSha256, width, height, durationMs }) => ({
      mediaType, fileSha256, width, height, durationMs,
    })),
  };
}

export function verifyInstagramReadback(post, { expectedCaptionSha256, expectedMedia } = {}) {
  const captionSha256 = typeof post?.caption === 'string' ? sha256(post.caption) : null;
  const captionMatched = typeof expectedCaptionSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(expectedCaptionSha256) && captionSha256 === expectedCaptionSha256;
  const mediaMatched = Number.isInteger(expectedMedia?.mediaType)
    && post?.mediaType === expectedMedia.mediaType
    && post?.productType === expectedMedia.productType
    && post?.carouselCount === expectedMedia.carouselCount
    && expectedMedia.itemCount >= 1;
  return { verified: captionMatched && mediaMatched, captionMatched, mediaMatched, captionSha256 };
}

function hasVerifiedReceipt(record) {
  return record?.state === 'published_readback_verified' && record.readbackVerified === true
    && typeof record.publicUrl === 'string' && record.publicUrl.length > 0;
}

function expectedJournalFields(mediaItems, caption) {
  return {
    expectedCaptionSha256: sha256(caption),
    expectedMedia: expectedMediaFields(mediaItems),
  };
}

export { expectedJournalFields as buildInstagramReadbackExpectation };

export function hashInstagramPublishIntent({ owner, media, reelCoverSha256, caption, disableComments,
  genAiSelfDisclosure } = {}) {
  if (typeof genAiSelfDisclosure !== 'boolean') fail('INSTAGRAM_GEN_AI_DISCLOSURE_INVALID');
  const intent = { owner, media,
    ...(reelCoverSha256 ? { reelCoverSha256 } : {}),
    caption, disableComments, genAiSelfDisclosure };
  return sha256(JSON.stringify(intent));
}

async function reserveJournal(owner, mediaItems, caption, userTagsByMedia, disableComments,
  genAiSelfDisclosure, cover = null, journalRoot = JOURNAL_ROOT) {
  const intentMedia = mediaItems.map((media, index) => ({
    mediaType: media.mediaType, fileSha256: media.sha256,
    userTags: userTagsByMedia[index].map(({ userId, position }) => ({ userId, position })),
  }));
  const payloadHash = hashInstagramPublishIntent({ owner, media: intentMedia,
    ...(cover ? { reelCoverSha256: cover.sha256 } : {}), caption, disableComments, genAiSelfDisclosure });
  const file = path.join(journalRoot, payloadHash + '.json');
  const record = { schemaVersion: 1, intentVersion: 2, service: 'instagram', owner, payloadHash,
    disableComments, genAiSelfDisclosure,
    ...expectedJournalFields(mediaItems, caption),
    ...(cover ? { reelCover: { fileSha256: cover.sha256, byteLength: cover.byteLength,
      width: cover.width, height: cover.height, mimeType: cover.mimeType } } : {}),
    media: mediaItems.map(({ mediaType, sha256, byteLength, width, height, durationMs }) => ({
      mediaType, sha256, byteLength, width, height, durationMs,
    })), createdAt: new Date().toISOString(), state: 'reserved',
    writesSent: 0, readbackVerified: false };
  try { await writeJournal(file, record, true); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous;
    try { previous = JSON.parse(await readFile(file, 'utf8')); } catch { fail('INSTAGRAM_POST_JOURNAL_INVALID'); }
    if (previous?.state !== 'not_sent' || previous?.writesSent !== 0) fail('INSTAGRAM_POST_DUPLICATE_OR_UNRESOLVED');
    record.retryOf = previous.createdAt;
    await writeJournal(file, record);
  }
  return { file, record };
}

function identifyReadback(posts, record) {
  const hasIdentity = typeof record.mediaId === 'string' && record.mediaId
    || typeof record.shortcode === 'string' && record.shortcode;
  if (hasIdentity) {
    const matches = posts.filter(candidate => (record.mediaId && candidate.id === record.mediaId)
      || (record.shortcode && candidate.shortcode === record.shortcode));
    if (!matches.length) return { post: null, reason: 'identity_not_found' };
    if (matches.length > 1) return { post: null, reason: 'ambiguous_identity' };
    const post = matches[0];
    const verification = verifyInstagramReadback(post, record);
    const identityMatched = (!record.mediaId || post.id === record.mediaId)
      && (!record.shortcode || post.shortcode === record.shortcode);
    return { post, verification,
      reason: !identityMatched ? 'identity_mismatch' : verification.verified ? null : 'readback_mismatch' };
  }

  const captionCandidates = posts.filter(candidate => typeof candidate.caption === 'string'
    && sha256(candidate.caption) === record.expectedCaptionSha256);
  const matching = captionCandidates.filter(candidate => verifyInstagramReadback(candidate, record).verified);
  if (matching.length === 1) return { post: matching[0], verification: verifyInstagramReadback(matching[0], record), reason: null };
  if (matching.length > 1) return { post: null, reason: 'ambiguous_match' };
  if (captionCandidates.length === 1) {
    const verification = verifyInstagramReadback(captionCandidates[0], record);
    return { post: captionCandidates[0], verification, reason: 'readback_mismatch' };
  }
  if (captionCandidates.length > 1) return { post: null, reason: 'ambiguous_caption_candidates' };
  return { post: null, reason: 'content_not_found' };
}

async function readRecentPostsForJournal(record, readPosts) {
  const posts = [];
  const seenCursors = new Set();
  let after = null;
  for (let pageIndex = 0; pageIndex < MAX_RECONCILE_PAGES; pageIndex++) {
    const page = await readPosts({ handle: record.owner, limit: POSTS_PAGE_LIMIT, after });
    if (!Array.isArray(page?.posts) || typeof page?.pagination?.hasNextPage !== 'boolean') {
      fail('INSTAGRAM_RECONCILE_READ_SCHEMA_INVALID');
    }
    posts.push(...page.posts);
    const identified = (record.mediaId || record.shortcode)
      && posts.some(candidate => (record.mediaId && candidate.id === record.mediaId)
        || (record.shortcode && candidate.shortcode === record.shortcode));
    const pagesScanned = pageIndex + 1;
    if (identified) return { posts, pagesScanned, identityFound: true, fullFeedScanned: false };
    if (page.pagination.hasNextPage === false) {
      return { posts, pagesScanned, identityFound: false, fullFeedScanned: true };
    }
    const cursor = page.pagination?.nextCursor;
    if (typeof cursor !== 'string' || !cursor || cursor === after || seenCursors.has(cursor)) {
      fail('INSTAGRAM_RECONCILE_CURSOR_INVALID');
    }
    seenCursors.add(cursor);
    after = cursor;
  }
  return { posts, pagesScanned: MAX_RECONCILE_PAGES, identityFound: false, fullFeedScanned: false,
    scanLimitReached: true };
}

function reconciliationResult(record, journalPath, post = null) {
  const details = record.readbackVerified === true
    ? record.readbackDetails || {}
    : record.lastReconciliation?.observed || record.readbackDetails || {};
  const scan = record.lastReconciliation?.scan || {};
  return {
    service: 'instagram', operation: 'reconcile', state: record.state,
    ...(record.mediaId ? { mediaId: record.mediaId } : {}),
    ...(record.shortcode ? { shortcode: record.shortcode } : {}),
    ...(post ? { post: { id: post.id, shortcode: post.shortcode, url: post.url,
      mediaType: post.mediaType, productType: post.productType, carouselCount: post.carouselCount } }
      : record.publicUrl ? { post: { id: record.mediaId, shortcode: record.shortcode, url: record.publicUrl,
        mediaType: details.mediaType ?? null, productType: details.productType ?? null,
        carouselCount: details.carouselCount ?? 0 } } : {}),
    journal: journalPath,
    journalId: record.payloadHash,
    lastReconciliation: record.lastReconciliation || null,
    receipt: {
      readbackVerified: record.readbackVerified === true,
      captionMatched: details.captionMatched === true,
      mediaMatched: details.mediaMatched === true,
      expectedCaptionSha256: record.expectedCaptionSha256,
      expectedMedia: record.expectedMedia,
      freshReadback: record.lastReconciliation?.status === 'verified',
      pagesScanned: Number.isInteger(scan.pagesScanned) ? scan.pagesScanned : null,
      fullFeedScanned: scan.fullFeedScanned === true,
      identityFound: scan.identityFound === true,
    },
  };
}

function safeObservedReadback(post, verification) {
  if (!post || !verification) return null;
  return {
    captionMatched: verification.captionMatched === true,
    mediaMatched: verification.mediaMatched === true,
    ...(typeof verification.captionSha256 === 'string' ? { captionSha256: verification.captionSha256 } : {}),
    mediaType: Number.isInteger(post.mediaType) ? post.mediaType : null,
    productType: typeof post.productType === 'string' ? post.productType : null,
    carouselCount: Number.isInteger(post.carouselCount) ? post.carouselCount : null,
    ...(typeof post.id === 'string' ? { mediaId: post.id } : {}),
    ...(typeof post.shortcode === 'string' ? { shortcode: post.shortcode } : {}),
  };
}

async function recordReadbackFailure(journalPath, record, status, reason, error = null,
  { scan = null, observed = null } = {}) {
  const preserve = hasVerifiedReceipt(record);
  if (!preserve) {
    record.state = 'needs_reconciliation';
    record.readbackVerified = false;
  }
  const code = error?.code;
  record.lastReconciliation = {
    checkedAt: new Date().toISOString(),
    status,
    reason,
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code) ? { failureCode: code } : {}),
    ...(scan ? { scan } : {}),
    ...(observed ? { observed } : {}),
    ...(preserve ? { previousReceiptPreserved: true } : {}),
  };
  await writeJournal(journalPath, record);
  return reconciliationResult(record, journalPath);
}

async function recordReadbackSuccess(journalPath, record, post, verification, scan = null) {
  record.state = 'published_readback_verified';
  record.readbackVerified = true;
  delete record.failureCode;
  record.mediaId = String(post.id);
  record.shortcode = post.shortcode;
  record.publicUrl = post.url;
  record.readbackDetails = {
    checkedAt: new Date().toISOString(),
    captionSha256: verification.captionSha256,
    captionMatched: true,
    mediaMatched: true,
    mediaType: post.mediaType,
    productType: post.productType,
    carouselCount: post.carouselCount,
  };
  record.lastReconciliation = { checkedAt: record.readbackDetails.checkedAt, status: 'verified',
    ...(scan ? { scan } : {}) };
  await writeJournal(journalPath, record);
  return reconciliationResult(record, journalPath, post);
}

function validateJournalRecord(record, payloadHash) {
  const media = record?.expectedMedia;
  const itemsValid = Array.isArray(media?.items) && media.items.length === media.itemCount
    && media.items.every(item => item && ['photo', 'video'].includes(item.mediaType)
      && /^[a-f0-9]{64}$/.test(item.fileSha256 || '')
      && Number.isSafeInteger(item.width) && item.width > 0
      && Number.isSafeInteger(item.height) && item.height > 0
      && (item.mediaType === 'photo' ? item.durationMs == null : Number.isSafeInteger(item.durationMs) && item.durationMs > 0));
  const storedMediaValid = Array.isArray(record?.media) && record.media.length === media?.itemCount
    && record.media.every((item, index) => item && item.mediaType === media.items[index]?.mediaType
      && item.sha256 === media.items[index]?.fileSha256 && Number.isSafeInteger(item.byteLength) && item.byteLength > 0
      && item.width === media.items[index]?.width && item.height === media.items[index]?.height);
  const mediaShapeValid = media?.kind === 'carousel'
    ? media.itemCount >= 2 && media.itemCount <= MAX_CAROUSEL_ITEMS && media.mediaType === 8
      && media.productType === 'carousel_container' && media.carouselCount === media.itemCount
    : media?.kind === 'photo'
      ? media.itemCount === 1 && media.mediaType === 1 && media.productType === 'feed'
        && media.carouselCount === 0 && media.items?.[0]?.mediaType === 'photo'
      : media?.kind === 'reel'
        ? media.itemCount === 1 && media.mediaType === 2 && media.productType === 'clips'
          && media.carouselCount === 0 && media.items?.[0]?.mediaType === 'video'
        : false;
  if (!record || record.schemaVersion !== 1 || record.service !== 'instagram'
    || record.payloadHash !== payloadHash || !/^[A-Za-z0-9_.]{1,30}$/.test(record.owner || '')
    || !/^[a-f0-9]{64}$/.test(record.expectedCaptionSha256 || '')
    || !Number.isInteger(media?.itemCount) || media.itemCount < 1 || !itemsValid || !storedMediaValid || !mediaShapeValid) {
    fail('INSTAGRAM_POST_JOURNAL_INVALID');
  }
}

export async function reconcileInstagramPublish({ payloadHash, journalRoot = JOURNAL_ROOT,
  readPosts = readInstagramPosts, loadSession = loadMetaSession } = {}) {
  if (typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) fail('INSTAGRAM_RECONCILE_ID_INVALID');
  const journalPath = path.join(journalRoot, payloadHash + '.json');
  let record;
  try { record = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') fail('INSTAGRAM_JOURNAL_NOT_FOUND');
    fail('INSTAGRAM_POST_JOURNAL_INVALID');
  }
  validateJournalRecord(record, payloadHash);
  if (!Number.isSafeInteger(record.writesSent) || record.writesSent < 1) fail('INSTAGRAM_RECONCILE_NOT_SENT');
  const current = loadSession('instagram');
  if (!current?.owner || current.owner.toLowerCase() !== record.owner.toLowerCase()) fail('META_OWNER_MISMATCH');

  let scan;
  try { scan = await readRecentPostsForJournal(record, readPosts); }
  catch (error) {
    const result = await recordReadbackFailure(journalPath, record, 'read_error', 'owner_read_failed', error);
    return { ...result, receipt: { ...result.receipt, freshReadback: false } };
  }
  if (!scan.fullFeedScanned && !scan.identityFound) {
    return recordReadbackFailure(journalPath, record, 'scan_incomplete', 'page_limit', null,
      { scan: { pagesScanned: scan.pagesScanned, fullFeedScanned: false, identityFound: false } });
  }
  const outcome = identifyReadback(scan.posts, record);
  if (!outcome.post || !outcome.verification?.verified) {
    return recordReadbackFailure(journalPath, record,
      outcome.reason === 'content_not_found' || outcome.reason === 'identity_not_found' ? 'not_found' : 'mismatch',
      outcome.reason || 'readback_mismatch', null, {
        scan: { pagesScanned: scan.pagesScanned, fullFeedScanned: scan.fullFeedScanned, identityFound: scan.identityFound },
        observed: safeObservedReadback(outcome.post, outcome.verification),
      });
  }
  return recordReadbackSuccess(journalPath, record, outcome.post, outcome.verification,
    { pagesScanned: scan.pagesScanned, fullFeedScanned: scan.fullFeedScanned, identityFound: scan.identityFound });
}

async function resumeInstagramSidecarConfigureLocked({ payloadHash, caption, hashtags = [], disableComments = false,
  genAiSelfDisclosure = false } = {}, dependencies = {}) {
  if (typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) fail('INSTAGRAM_RECONCILE_ID_INVALID');
  if (disableComments !== true && disableComments !== false) fail('INSTAGRAM_DISABLE_COMMENTS_INVALID');
  if (typeof genAiSelfDisclosure !== 'boolean') fail('INSTAGRAM_GEN_AI_DISCLOSURE_INVALID');
  const journalRoot = dependencies.journalRoot || JOURNAL_ROOT;
  const readPosts = dependencies.readPosts || readInstagramPosts;
  const loadSession = dependencies.loadSession || loadMetaSession;
  const withLock = dependencies.withLock || withMetaSessionLock;
  const openContext = dependencies.openContext || openMetaContext;
  const sendConfigureRequest = dependencies.sendConfigure || sendConfigure;
  const journalPath = path.join(journalRoot, payloadHash + '.json');
  let record;
  try { record = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') fail('INSTAGRAM_JOURNAL_NOT_FOUND');
    fail('INSTAGRAM_POST_JOURNAL_INVALID');
  }
  validateJournalRecord(record, payloadHash);
  const count = record.expectedMedia.itemCount;
  const uploadIds = record.uploadIds;
  const uploadEntities = record.uploadEntityNames;
  if (record.expectedMedia.kind !== 'carousel' || count < 2 || record.state !== 'needs_reconciliation'
    || record.failureCode !== 'INSTAGRAM_PUBLISH_HTTP_500' || record.writesSent !== count + 1
    || (record.configureAttemptCount != null && record.configureAttemptCount !== 1)
    || record.mediaId || record.shortcode || !Array.isArray(uploadIds) || uploadIds.length !== count
    || new Set(uploadIds).size !== count || uploadIds.some(id => typeof id !== 'string' || !/^\d{10,20}$/.test(id))
    || !Array.isArray(uploadEntities) || uploadEntities.length !== count
    || uploadEntities.some((entity, index) => entity !== 'fb_uploader_' + uploadIds[index])) {
    fail('INSTAGRAM_SIDECAR_RESUME_PRECONDITION_FAILED');
  }

  const finalCaption = buildCaption(caption, hashtags);
  if (sha256(finalCaption) !== record.expectedCaptionSha256) fail('INSTAGRAM_RESUME_CONTENT_MISMATCH');
  const noTagsMedia = record.media.map(media => ({ mediaType: media.mediaType, fileSha256: media.sha256, userTags: [] }));
  const isLegacyIntent = record.intentVersion == null || record.intentVersion === 1;
  if (isLegacyIntent) {
    if (genAiSelfDisclosure !== false || record.genAiSelfDisclosure != null && record.genAiSelfDisclosure !== false
      || record.disableComments != null && record.disableComments !== disableComments) {
      fail('INSTAGRAM_RESUME_CONTENT_MISMATCH');
    }
  } else if (record.intentVersion !== 2 || typeof record.genAiSelfDisclosure !== 'boolean'
    || record.genAiSelfDisclosure !== genAiSelfDisclosure || record.disableComments !== disableComments) {
    fail('INSTAGRAM_RESUME_CONTENT_MISMATCH');
  }
  const intent = { owner: record.owner, media: noTagsMedia, caption: finalCaption, disableComments,
    ...(isLegacyIntent ? {} : { genAiSelfDisclosure }) };
  const expectedPayloadHash = isLegacyIntent ? sha256(JSON.stringify(intent))
    : hashInstagramPublishIntent({ ...intent, genAiSelfDisclosure });
  if (expectedPayloadHash !== record.payloadHash) fail('INSTAGRAM_RESUME_CONTENT_MISMATCH');
  const current = loadSession('instagram');
  if (!current?.owner || current.owner.toLowerCase() !== record.owner.toLowerCase()) fail('META_OWNER_MISMATCH');

  const scan = await readRecentPostsForJournal(record, readPosts);
  const scanReceipt = { pagesScanned: scan.pagesScanned, fullFeedScanned: scan.fullFeedScanned,
    identityFound: scan.identityFound };
  if (!scan.fullFeedScanned) {
    const unresolved = await recordReadbackFailure(journalPath, record, 'scan_incomplete', 'page_limit', null,
      { scan: scanReceipt });
    return { ...unresolved, operation: 'resume_configure', configureSent: false };
  }

  const captionCandidates = scan.posts.filter(post => typeof post?.caption === 'string'
    && sha256(post.caption) === record.expectedCaptionSha256);
  const expectedMatches = captionCandidates.filter(post => verifyInstagramReadback(post, record).verified);
  if (expectedMatches.length === 1) {
    const verified = await recordReadbackSuccess(journalPath, record, expectedMatches[0],
      verifyInstagramReadback(expectedMatches[0], record), scanReceipt);
    return { ...verified, operation: 'resume_configure', configureSent: false, reason: 'already_published' };
  }
  if (expectedMatches.length > 1 || captionCandidates.length > 1) {
    const ambiguous = await recordReadbackFailure(journalPath, record, 'ambiguous', 'multiple_caption_candidates', null,
      { scan: scanReceipt, observed: safeObservedReadback(captionCandidates[0],
        captionCandidates[0] ? verifyInstagramReadback(captionCandidates[0], record) : null) });
    return { ...ambiguous, operation: 'resume_configure', configureSent: false };
  }

  const candidate = captionCandidates[0] || null;
  const candidateVerification = candidate ? verifyInstagramReadback(candidate, record) : null;
  await recordReadbackFailure(journalPath, record, candidate ? 'mismatch' : 'not_found',
    candidate ? 'caption_candidate_media_mismatch' : 'content_not_found', null,
    { scan: scanReceipt, observed: safeObservedReadback(candidate, candidateVerification) });
  record.resumeConfigurePreflight = {
    checkedAt: new Date().toISOString(),
    status: 'full_feed_no_expected_carousel_match',
    expectedMediaMatches: 0,
    captionCandidateCount: captionCandidates.length,
    originalClientSidecarId: typeof record.clientSidecarId === 'string' ? 'recorded' : 'not_recorded',
    recoveryUsesNewClientSidecarId: true,
    scan: scanReceipt,
  };
  if (isLegacyIntent) record.intentVersion = 1;
  record.disableComments = disableComments;
  record.genAiSelfDisclosure = genAiSelfDisclosure;
  await writeJournal(journalPath, record);

  const clientSidecarId = newUploadId();
  const body = buildInstagramSidecarConfigureBody({ uploadIds, caption: finalCaption,
    userTagsByMedia: Array.from({ length: count }, () => []), disableComments, clientSidecarId,
    genAiSelfDisclosure });
  let configureError = null;
  let configureResult = null;
  const attempt = { attempt: 2, clientSidecarId, requestBodySha256: sha256(JSON.stringify(body)),
    startedAt: new Date().toISOString(), state: 'sending', preflightScan: scanReceipt };
  try {
    await withLock('instagram', async () => {
      const context = await openContext('instagram', record.owner);
      const contract = readPublishContract(context, 'photo', true);
      if (contract.kind !== 'sidecar') fail('INSTAGRAM_SIDECAR_CONTRACT_CHANGED');
      record.firstConfigureFailureCode = record.firstConfigureFailureCode || record.failureCode;
      record.configureAttemptCount = 2;
      record.resumeConfigureAttempts = [...(record.resumeConfigureAttempts || []), attempt];
      record.state = 'resume_configuring';
      record.writesSent++;
      await writeJournal(journalPath, record);
      try { configureResult = await sendConfigureRequest(context, contract, body); }
      catch (error) {
        configureError = error;
        attempt.state = 'uncertain';
        attempt.failureCode = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'INSTAGRAM_POST_WRITE_UNCERTAIN';
        record.state = 'needs_reconciliation';
        record.failureCode = attempt.failureCode;
        await writeJournal(journalPath, record);
        return;
      }
      attempt.state = configureResult.pending ? 'pending_reconciliation' : 'submitted';
      attempt.httpStatus = configureResult.httpStatus;
      record.state = configureResult.pending ? 'pending_reconciliation' : 'submitted';
      record.mediaId = configureResult.mediaId;
      record.shortcode = configureResult.shortcode;
      record.configureStatus = configureResult.httpStatus;
      await writeJournal(journalPath, record);
    });
  } catch (error) {
    if (record.state === 'resume_configuring') {
      configureError = error;
      attempt.state = 'uncertain';
      attempt.failureCode = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'INSTAGRAM_POST_WRITE_UNCERTAIN';
      record.state = 'needs_reconciliation';
      record.failureCode = attempt.failureCode;
      await writeJournal(journalPath, record);
    } else throw error;
  }

  let afterScan;
  try { afterScan = await readRecentPostsForJournal(record, readPosts); }
  catch (error) {
    const unresolved = await recordReadbackFailure(journalPath, record, 'read_error', 'owner_read_failed', error);
    return { ...unresolved, operation: 'resume_configure', configureSent: true,
      configureFailureCode: configureError?.code || null };
  }
  const afterScanReceipt = { pagesScanned: afterScan.pagesScanned, fullFeedScanned: afterScan.fullFeedScanned,
    identityFound: afterScan.identityFound };
  if (!afterScan.fullFeedScanned && !afterScan.identityFound) {
    const unresolved = await recordReadbackFailure(journalPath, record, 'scan_incomplete', 'page_limit', null,
      { scan: afterScanReceipt });
    return { ...unresolved, operation: 'resume_configure', configureSent: true,
      configureFailureCode: configureError?.code || null };
  }
  const outcome = identifyReadback(afterScan.posts, record);
  if (!outcome.post || !outcome.verification?.verified) {
    const unresolved = await recordReadbackFailure(journalPath, record,
      outcome.reason === 'identity_not_found' || outcome.reason === 'content_not_found' ? 'not_found' : 'mismatch',
      outcome.reason || 'readback_mismatch', null, {
        scan: afterScanReceipt,
        observed: safeObservedReadback(outcome.post, outcome.verification),
      });
    return { ...unresolved, operation: 'resume_configure', configureSent: true,
      configureFailureCode: configureError?.code || null };
  }
  const verified = await recordReadbackSuccess(journalPath, record, outcome.post, outcome.verification, afterScanReceipt);
  return { ...verified, operation: 'resume_configure', configureSent: true,
    configureFailureCode: configureError?.code || null };
}

export async function resumeInstagramSidecarConfigure(input = {}, dependencies = {}) {
  const { payloadHash } = input;
  if (typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) fail('INSTAGRAM_RECONCILE_ID_INVALID');
  const journalRoot = dependencies.journalRoot || JOURNAL_ROOT;
  const lockPath = path.join(journalRoot, payloadHash + '.resume.lock');
  const withRecoveryLock = dependencies.withRecoveryLock || withFileLock;
  try {
    return await withRecoveryLock(() => resumeInstagramSidecarConfigureLocked(input,
      { ...dependencies, journalRoot }), { lockPath, timeoutMs: 0 });
  } catch (error) {
    if (error?.code === 'TISTORY_SESSION_BUSY') fail('INSTAGRAM_RESUME_LOCK_BUSY');
    throw error;
  }
}

function normalizeMediaItems({ filePath, filePaths, mediaItems, videoMetadata, userTags }) {
  let items;
  if (mediaItems != null) items = mediaItems;
  else if (Array.isArray(filePaths)) items = filePaths.map(value => typeof value === 'string' ? { filePath: value } : value);
  else items = [{ filePath, videoMetadata, userTags }];
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CAROUSEL_ITEMS) fail('INSTAGRAM_MEDIA_ITEMS_INVALID');
  if (items.length > 1 && items.some(item => !item || typeof item !== 'object' || typeof item.filePath !== 'string')) {
    fail('INSTAGRAM_MEDIA_ITEMS_INVALID');
  }
  if (items.length > 1 && Array.isArray(userTags) && userTags.length) fail('INSTAGRAM_CAROUSEL_TAGS_REQUIRE_PER_ITEM');
  return items.map(item => {
    if (!item || typeof item !== 'object') fail('INSTAGRAM_MEDIA_ITEMS_INVALID');
    return { filePath: item.filePath, videoMetadata: item.videoMetadata ?? (items.length === 1 ? videoMetadata : undefined),
      userTags: item.userTags ?? (items.length === 1 ? userTags : []) };
  });
}

export async function publishInstagramMedia({
  filePath, filePaths, mediaItems, videoMetadata, coverFilePath, genAiSelfDisclosure = false,
  caption = '', hashtags = [], userTags = [], disableComments = false,
} = {}) {
  if (disableComments !== true && disableComments !== false) fail('INSTAGRAM_DISABLE_COMMENTS_INVALID');
  if (typeof genAiSelfDisclosure !== 'boolean') fail('INSTAGRAM_GEN_AI_DISCLOSURE_INVALID');
  const items = normalizeMediaItems({ filePath, filePaths, mediaItems, videoMetadata, userTags });
  if (items.length > 1 && items.some(item => item.userTags?.length)) fail('INSTAGRAM_SIDECAR_TAG_CONTRACT_UNVERIFIED');
  const media = await Promise.all(items.map(item => inspectMediaFile(item.filePath, item.videoMetadata)));
  if (media.length > 1 && media.some(item => item.mediaType === 'video')) fail('INSTAGRAM_SIDECAR_VIDEO_CONTRACT_UNVERIFIED');
  const isReel = media.length === 1 && media[0].mediaType === 'video';
  if (isReel && typeof coverFilePath !== 'string') fail('INSTAGRAM_REEL_COVER_REQUIRED');
  if (!isReel && coverFilePath != null) fail('INSTAGRAM_REEL_COVER_NOT_APPLICABLE');
  if (genAiSelfDisclosure && !isReel && media.length === 1) fail('INSTAGRAM_GEN_AI_DISCLOSURE_NOT_APPLICABLE');
  const cover = isReel ? await inspectReelCoverFile(coverFilePath) : null;
  if (media.reduce((sum, item) => sum + item.byteLength, 0) + (cover?.byteLength || 0) > MAX_POST_BYTES) {
    fail('INSTAGRAM_POST_SIZE_INVALID');
  }
  if (new Set(media.map(item => item.sha256)).size !== media.length) fail('INSTAGRAM_MEDIA_DUPLICATE');
  const finalCaption = buildCaption(caption, hashtags);
  const contextOwner = loadMetaSession('instagram').owner;
  if (!contextOwner) fail('META_REAUTH_REQUIRED');
  const ownerCheck = await readInstagramProfile({ handle: contextOwner });
  if (ownerCheck.profile.username.toLowerCase() !== contextOwner.toLowerCase()) fail('META_OWNER_MISMATCH');
  const resolvedTags = [];
  for (const item of items) resolvedTags.push(await resolveUserTags(item.userTags || [], contextOwner));
  if (media.length > 1 && resolvedTags.some(tags => tags.length > 0)) fail('INSTAGRAM_SIDECAR_TAG_CONTRACT_UNVERIFIED');
  const journal = await reserveJournal(contextOwner, media, finalCaption, resolvedTags, disableComments,
    genAiSelfDisclosure, cover);
  let submitted = null;
  try {
    submitted = await withMetaSessionLock('instagram', async () => {
      const context = await openMetaContext('instagram', contextOwner);
      const contract = readPublishContract(context, media[0].mediaType, media.length > 1);
      const uploads = [];
      const reelUploadId = isReel ? newUploadId() : null;
      for (let index = 0; index < media.length; index++) {
        const uploadId = isReel ? reelUploadId : newUploadId();
        const uploadOptions = { isSidecar: media.length > 1, reelVideo: isReel };
        const uploadEnvelope = buildInstagramUploadEnvelope(context, media[index], uploadId, uploadOptions);
        journal.record.state = 'uploading';
        journal.record.writesSent++;
        journal.record.uploadIds = [...new Set([...uploads.map(item => item.uploadId), uploadId])];
        journal.record.uploadEntityNames = [...uploads.map(item => item.entityName), uploadEnvelope.entityName];
        await writeJournal(journal.file, journal.record);
        const uploaded = await sendUpload(context, media[index], uploadId, uploadOptions);
        uploads.push(uploaded);
        journal.record.state = 'uploaded';
        await writeJournal(journal.file, journal.record);
      }
      if (isReel) {
        const coverEnvelope = buildInstagramUploadEnvelope(context, cover, reelUploadId, { reelCover: true });
        journal.record.state = 'uploading_cover';
        journal.record.writesSent++;
        journal.record.reelCoverUpload = { uploadId: reelUploadId, entityName: coverEnvelope.entityName,
          state: 'sending' };
        journal.record.uploadEntityNames = [...journal.record.uploadEntityNames, coverEnvelope.entityName];
        await writeJournal(journal.file, journal.record);
        const coverUpload = await sendUpload(context, cover, reelUploadId, { reelCover: true });
        uploads.push(coverUpload);
        journal.record.reelCoverUpload.state = 'uploaded';
        journal.record.reelCoverUpload.httpStatus = coverUpload.httpStatus;
        journal.record.state = 'uploaded';
        await writeJournal(journal.file, journal.record);
      }
      journal.record.state = 'configuring';
      journal.record.writesSent++;
      const clientSidecarId = media.length > 1 ? newUploadId() : null;
      const body = media.length > 1
        ? buildInstagramSidecarConfigureBody({ uploadIds: uploads.map(item => item.uploadId), caption: finalCaption,
          userTagsByMedia: resolvedTags, disableComments, clientSidecarId, genAiSelfDisclosure })
        : buildInstagramConfigureBody({ uploadId: uploads[0].uploadId, caption: finalCaption,
          userTags: resolvedTags[0], disableComments, reel: isReel, genAiSelfDisclosure });
      if (clientSidecarId) journal.record.clientSidecarId = clientSidecarId;
      journal.record.configureAttemptCount = (journal.record.configureAttemptCount || 0) + 1;
      journal.record.configureBodySha256 = sha256(JSON.stringify(body));
      journal.record.configureStartedAt = new Date().toISOString();
      await writeJournal(journal.file, journal.record);
      const result = await sendConfigure(context, contract, body);
      journal.record.state = result.pending ? 'pending_reconciliation' : 'submitted';
      journal.record.mediaId = result.mediaId;
      journal.record.shortcode = result.shortcode;
      journal.record.configureStatus = result.httpStatus;
      await writeJournal(journal.file, journal.record);
      return { uploads, result, contract };
    });
  } catch (error) {
    if (journal.record.writesSent > 0) {
      journal.record.state = 'needs_reconciliation';
      journal.record.failureCode = /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'INSTAGRAM_POST_WRITE_UNCERTAIN';
      await writeJournal(journal.file, journal.record).catch(() => {});
      fail('INSTAGRAM_POST_WRITE_UNCERTAIN');
    }
    journal.record.state = 'not_sent';
    journal.record.failureCode = /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'INSTAGRAM_POST_NOT_SENT';
    await writeJournal(journal.file, journal.record).catch(() => {});
    throw error;
  }

  if (!submitted?.result?.mediaId) {
    return { service: 'instagram', operation: 'publish', state: 'pending_reconciliation',
      journal: journal.file, journalId: journal.record.payloadHash,
      receipt: { captured: false, client_exists: true, credential_propagated: true,
        live_replay: true, remnant_free: true, readbackVerified: false, captionMatched: false,
        mediaMatched: false, expectedCaptionSha256: journal.record.expectedCaptionSha256,
        expectedMedia: journal.record.expectedMedia, browserUsed: false,
        sourceSha256: submitted.contract.sha256 } };
  }

  let scan;
  try { scan = await readRecentPostsForJournal(journal.record, readInstagramPosts); }
  catch (error) {
    const result = await recordReadbackFailure(journal.file, journal.record, 'read_error', 'owner_read_failed', error);
    return { service: 'instagram', operation: 'publish', state: result.state,
      mediaId: submitted.result.mediaId, shortcode: submitted.result.shortcode,
      journal: journal.file, journalId: journal.record.payloadHash,
      receipt: { ...result.receipt, captured: false, client_exists: true, credential_propagated: true,
        live_replay: true, remnant_free: true, browserUsed: false, sourceSha256: submitted.contract.sha256 } };
  }
  if (!scan.fullFeedScanned && !scan.identityFound) {
    const result = await recordReadbackFailure(journal.file, journal.record, 'scan_incomplete', 'page_limit', null,
      { scan: { pagesScanned: scan.pagesScanned, fullFeedScanned: false, identityFound: false } });
    return { service: 'instagram', operation: 'publish', state: result.state,
      mediaId: submitted.result.mediaId, shortcode: submitted.result.shortcode,
      journal: journal.file, journalId: journal.record.payloadHash,
      receipt: { ...result.receipt, captured: false, client_exists: true, credential_propagated: true,
        live_replay: true, remnant_free: true, browserUsed: false, sourceSha256: submitted.contract.sha256 } };
  }
  const outcome = identifyReadback(scan.posts, journal.record);
  if (!outcome.post || !outcome.verification?.verified) {
    const result = await recordReadbackFailure(journal.file, journal.record,
      outcome.reason === 'identity_not_found' || outcome.reason === 'content_not_found' ? 'not_found' : 'mismatch',
      outcome.reason || 'readback_mismatch', null, {
        scan: { pagesScanned: scan.pagesScanned, fullFeedScanned: scan.fullFeedScanned, identityFound: scan.identityFound },
        observed: safeObservedReadback(outcome.post, outcome.verification),
      });
    return { service: 'instagram', operation: 'publish', state: result.state,
      mediaId: submitted.result.mediaId, shortcode: submitted.result.shortcode,
      journal: journal.file, journalId: journal.record.payloadHash,
      receipt: { ...result.receipt, captured: false, client_exists: true, credential_propagated: true,
        live_replay: true, remnant_free: true, browserUsed: false, sourceSha256: submitted.contract.sha256 } };
  }

  await recordReadbackSuccess(journal.file, journal.record, outcome.post, outcome.verification,
    { pagesScanned: scan.pagesScanned, fullFeedScanned: scan.fullFeedScanned, identityFound: scan.identityFound });
  return {
    service: 'instagram', operation: 'publish', state: 'published_readback_verified',
    post: { id: outcome.post.id, shortcode: outcome.post.shortcode, url: outcome.post.url,
      mediaType: outcome.post.mediaType, productType: outcome.post.productType,
      carouselCount: outcome.post.carouselCount },
    journal: journal.file, journalId: journal.record.payloadHash,
    receipt: { captured: false, client_exists: true, credential_propagated: true, live_replay: true,
      remnant_free: true, readbackVerified: true, captionMatched: true, mediaMatched: true,
      expectedCaptionSha256: journal.record.expectedCaptionSha256, expectedMedia: journal.record.expectedMedia,
      targetOwnerMatched: true, browserUsed: false,
      sourceSha256: submitted.contract.sha256, uploadStatuses: submitted.uploads.map(item => item.httpStatus),
      configureStatus: submitted.result.httpStatus },
  };
}

export const instagramPublishCapabilities = Object.freeze(['single_photo', 'single_video_reel', 'caption', 'hashtags',
  'people_tags', 'photo_carousel', 'reel_cover_jpeg', 'optional_reel_gen_ai_self_disclosure',
  'sidecar_json_configure', 'manual_sidecar_configure_recovery', 'disable_comments_at_publish', 'write_journal',
  'caption_and_media_readback_verification', 'journal_reconciliation', 'no_retry_after_uncertain_write',
  'sidecar_recovery_reuses_existing_uploads']);
