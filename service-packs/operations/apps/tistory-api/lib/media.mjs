import { createHash, randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { BLOG_ORIGIN } from './transport.mjs';
import { withAuthenticatedSession } from './operations.mjs';
import {
  credentialExists,
  readCredential,
  writeCredential,
} from '../../naver-blog-api/scripts/secure-credential-store.mjs';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// Kept as an alias for callers that used the first image-only interface.
export const MAX_IMAGE_BYTES = MAX_UPLOAD_BYTES;
export const MEDIA_UPLOAD_URL = `${BLOG_ORIGIN}/manage/post/attach.json`;
export const MEDIA_RESPONSE_SCHEMA = Object.freeze({
  name: 'string',
  url: 'string',
  key: 'string',
  filename: 'string',
  size: 'number',
});

const MAX_JOURNAL_BYTES = 4096;
const MAX_STORED_RESPONSE_BYTES = 100 * 1024;
const READBACK_TIMEOUT_MS = 15_000;
const SAFE_MEDIA_HOST = 'blog.kakaocdn.net';
const SAFE_MEDIA_QUERY_KEYS = ['credential', 'expires', 'allow_ip', 'allow_referer', 'signature'];
const FAILURE_STATUSES = new Set(['outcome_unknown', 'rejected', 'not_attempted']);
const SAFE_MEDIA_ERROR_CODES = new Set([
  'TISTORY_ACCESS_DENIED', 'TISTORY_ACCOUNT_MISMATCH', 'TISTORY_ACCOUNT_SELECTION_REQUIRED',
  'TISTORY_AUTH_SESSION_INVALID', 'TISTORY_BLOG_MISMATCH', 'TISTORY_BROWSER_COOKIE_INVALID',
  'TISTORY_COOKIE_JAR_INVALID', 'TISTORY_COOKIE_ROTATION_FAILED', 'TISTORY_FETCH_UNAVAILABLE',
  'TISTORY_HTTP_FAILED', 'TISTORY_JSON_INVALID',
  'TISTORY_KAKAO_JSON_INVALID', 'TISTORY_KAKAO_LOGIN_FAILED', 'TISTORY_KAKAO_PAGE_CHANGED',
  'TISTORY_KAKAO_REAUTH_REQUIRED', 'TISTORY_LOGIN_CONTRACT_CHANGED', 'TISTORY_LOGIN_ENTRY_FAILED',
  'TISTORY_LOGIN_HTTP_FAILED', 'TISTORY_LOGIN_PAGE_UNEXPECTED', 'TISTORY_LOGIN_REDIRECT_INVALID',
  'TISTORY_LOGIN_REDIRECT_LIMIT', 'TISTORY_LOGIN_REDIRECT_SCOPE', 'TISTORY_MEDIA_CREDENTIAL_ID_UNAVAILABLE',
  'TISTORY_MEDIA_CREDENTIAL_INVALID', 'TISTORY_MEDIA_CREDENTIAL_MISSING', 'TISTORY_MEDIA_CREDENTIAL_STORE_FAILED',
  'TISTORY_MEDIA_CREDENTIAL_STORE_UNAVAILABLE', 'TISTORY_MEDIA_OPERATION_FAILED',
  'TISTORY_MEDIA_READBACK_CONTENT_MISMATCH', 'TISTORY_MEDIA_READBACK_FAILED', 'TISTORY_MEDIA_READBACK_HTTP_FAILED',
  'TISTORY_MEDIA_READBACK_INVALID', 'TISTORY_MEDIA_READBACK_MIME_MISMATCH', 'TISTORY_MEDIA_READBACK_TIMEOUT',
  'TISTORY_MEDIA_READBACK_TOO_LARGE', 'TISTORY_MIME_MISMATCH', 'TISTORY_OAUTH_SCOPE',
  'TISTORY_OAUTH_STATE_MISMATCH', 'TISTORY_PROVIDER_MISSING', 'TISTORY_RATE_LIMITED', 'TISTORY_REAUTH_REQUIRED',
  'TISTORY_REDIRECT_FOLLOWED', 'TISTORY_REDIRECT_SCOPE', 'TISTORY_REQUEST_HEADER_FORBIDDEN',
  'TISTORY_REQUEST_INVALID', 'TISTORY_REQUEST_SCOPE', 'TISTORY_RESPONSE_INVALID', 'TISTORY_RESPONSE_READ_FAILED',
  'TISTORY_RESPONSE_TOO_LARGE', 'TISTORY_SCOPE', 'TISTORY_SESSION_BUSY', 'TISTORY_SESSION_INVALID',
  'TISTORY_SESSION_LOCK_CALLBACK_REQUIRED', 'TISTORY_SESSION_LOCK_OPTIONS_INVALID', 'TISTORY_SESSION_LOCK_PATH_INVALID',
  'TISTORY_STATE_INVALID', 'TISTORY_TIMEOUT', 'TISTORY_TRANSPORT_FAILED', 'TISTORY_USER_AGENT_INVALID', 'TISTORY_UPLOAD_ACK_INVALID',
  'TISTORY_UPLOAD_ACK_RESPONSE_TOO_LARGE', 'TISTORY_UPLOAD_OUTCOME_UNKNOWN', 'TISTORY_UPLOAD_REJECTED',
  'TISTORY_WRITE_OUTCOME_UNKNOWN',
  ...['FILE_INVALID', 'TOO_LARGE', 'CHANGED_DURING_READ', 'TYPE_UNSUPPORTED'].flatMap(suffix => [
    `TISTORY_IMAGE_${suffix}`, `TISTORY_VIDEO_ATTACHMENT_${suffix}`,
  ]),
  ...['JOURNAL_ALREADY_EXISTS', 'JOURNAL_PATH_INVALID', 'JOURNAL_PATH_REQUIRED', 'JOURNAL_WRITE_FAILED'].map(code => `TISTORY_${code}`),
]);
const ALLOWED_IMAGE_TYPES = Object.freeze({
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
});
export const SUPPORTED_IMAGE_MIME_TYPES = Object.freeze(Object.keys(ALLOWED_IMAGE_TYPES));
export const SUPPORTED_VIDEO_ATTACHMENT_MIME_TYPES = Object.freeze(['video/mp4']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function detectVideoAttachmentMime(bytes) {
  return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : null;
}

function detectMime(bytes, kind) {
  return kind === 'video-attachment' ? detectVideoAttachmentMime(bytes) : detectImageMime(bytes);
}

function kindError(kind, suffix) {
  const prefix = kind === 'video-attachment' ? 'TISTORY_VIDEO_ATTACHMENT' : 'TISTORY_IMAGE';
  return `${prefix}_${suffix}`;
}

async function readUploadFile(filePath, kind) {
  const invalidCode = kindError(kind, 'FILE_INVALID');
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw fail(invalidCode);
  let info;
  try { info = await stat(filePath); } catch { throw fail(invalidCode); }
  if (!info.isFile() || info.size < 1) throw fail(invalidCode);
  // This 10 MiB limit is a local client guard, not a Tistory-published limit.
  if (info.size > MAX_UPLOAD_BYTES) throw fail(kindError(kind, 'TOO_LARGE'));

  let handle;
  try { handle = await open(filePath, 'r'); } catch { throw fail(invalidCode); }
  try {
    const chunks = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_UPLOAD_BYTES) throw fail(kindError(kind, 'TOO_LARGE'));
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (total !== info.size) throw fail(kindError(kind, 'CHANGED_DURING_READ'));
    const bytes = Buffer.concat(chunks, total);
    const mime = detectMime(bytes, kind);
    const filename = path.basename(filePath);
    const allowedTypes = kind === 'video-attachment'
      ? { 'video/mp4': ['.mp4'] }
      : ALLOWED_IMAGE_TYPES;
    if (!mime || !allowedTypes[mime]?.includes(path.extname(filename).toLowerCase())
      || filename.length > 255 || /[\x00-\x1f\x7f]/.test(filename)) {
      throw fail(kindError(kind, 'TYPE_UNSUPPORTED'));
    }
    return { bytes, mime, filename, sha256: digest(bytes) };
  } finally {
    await handle.close().catch(() => {});
  }
}

function validateJournalPath(journalPath) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) throw fail('TISTORY_JOURNAL_PATH_REQUIRED');
  if (path.extname(journalPath).toLowerCase() !== '.json' || /[\x00-\x1f\x7f]/.test(journalPath)) {
    throw fail('TISTORY_JOURNAL_PATH_INVALID');
  }
  return path.resolve(journalPath);
}

function makeJournalRecord({ status, kind, asset, credentialId, responseStatus, remoteSha256, remoteBytes,
  failureCode, failedAt, timedOut }) {
  const record = {
    schema: kind === 'video-attachment'
      ? 'tistory-downloadable-video-attachment-receipt-v1'
      : 'tistory-media-receipt-v1',
    status,
    credentialId,
    sourceSha256: asset.sha256,
    sourceBytes: asset.bytes.length,
    responseSchema: MEDIA_RESPONSE_SCHEMA,
    ...(Number.isInteger(responseStatus) ? { responseStatus } : {}),
    ...(typeof remoteSha256 === 'string' ? { remoteSha256 } : {}),
    ...(Number.isSafeInteger(remoteBytes) ? { remoteBytes } : {}),
  };
  if (FAILURE_STATUSES.has(status)) {
    record.failureCode = publicError(failureCode);
    record.failedAt = typeof failedAt === 'string' && Number.isFinite(Date.parse(failedAt))
      ? failedAt
      : new Date().toISOString();
    record.timedOut = timedOut === true;
  }
  return record;
}

function serializeJournal(record) {
  const output = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(output, 'utf8') > MAX_JOURNAL_BYTES) throw fail('TISTORY_JOURNAL_WRITE_FAILED');
  return output;
}

async function createFreshJournal(journalPath, intent) {
  let handle;
  try { handle = await open(journalPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw fail('TISTORY_JOURNAL_ALREADY_EXISTS');
    throw fail('TISTORY_JOURNAL_WRITE_FAILED');
  }
  try {
    await handle.writeFile(serializeJournal(intent), 'utf8');
    await handle.sync();
    return {
      async write(record) {
        const content = serializeJournal(record);
        await handle.truncate(0);
        await handle.write(content, 0, 'utf8');
        await handle.sync();
      },
      async close() { await handle.close(); },
    };
  } catch {
    await handle.close().catch(() => {});
    throw fail('TISTORY_JOURNAL_WRITE_FAILED');
  }
}

function safeCredentialStore(store) {
  if (!store || typeof store.exists !== 'function' || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw fail('TISTORY_MEDIA_CREDENTIAL_STORE_UNAVAILABLE');
  }
  return store;
}

const defaultCredentialStore = Object.freeze({
  exists: credentialExists,
  read: readCredential,
  write: writeCredential,
});

function newCredentialId(store) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = `tistory-media-${randomUUID()}`;
    if (!store.exists(id)) return id;
  }
  throw fail('TISTORY_MEDIA_CREDENTIAL_ID_UNAVAILABLE');
}

function parseResponse(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_STORED_RESPONSE_BYTES) {
    throw fail('TISTORY_UPLOAD_ACK_RESPONSE_TOO_LARGE');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw fail('TISTORY_UPLOAD_ACK_INVALID'); }
}

function validateSignedMediaResponse(value, { sourceName, sourceMime } = {}) {
  const keyParts = typeof value?.key === 'string' ? value.key.split('/') : [];
  const validKey = keyParts.length === 3 && keyParts[0].length >= 1 && keyParts[0].length <= 64
    && keyParts[1].length >= 1 && keyParts[1].length <= 64 && keyParts[2].length === 64
    && keyParts.every(part => /^[A-Za-z0-9_-]+$/.test(part));
  const filenameExt = typeof value?.filename === 'string' ? path.extname(value.filename).toLowerCase() : '';
  const allowedResponseExtensions = sourceMime
    ? (ALLOWED_IMAGE_TYPES[sourceMime] ?? (sourceMime === 'video/mp4' ? ['.mp4'] : []))
    : [...Object.values(ALLOWED_IMAGE_TYPES).flat(), '.mp4'];
  if (Object.keys(MEDIA_RESPONSE_SCHEMA).some(key => typeof value[key] !== MEDIA_RESPONSE_SCHEMA[key])
    || !value.name || value.name.length > 512 || !value.filename || value.filename.length > 512
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_UPLOAD_BYTES
    || !validKey || value.key.length > 194
    || !/^[A-Za-z0-9._-]{1,255}$/.test(value.filename) || value.filename === '.' || value.filename === '..'
    || !allowedResponseExtensions.includes(filenameExt)
    || (sourceName != null && value.name !== sourceName)
    ) {
    throw fail('TISTORY_UPLOAD_ACK_INVALID');
  }
  let url;
  try { url = new URL(value.url); } catch { throw fail('TISTORY_UPLOAD_ACK_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== SAFE_MEDIA_HOST || url.port || url.username || url.password
    || url.hash || url.pathname !== `/dna/${value.key}/${value.filename}` || url.pathname.length > 2048
    || SAFE_MEDIA_QUERY_KEYS.some(key => !url.searchParams.has(key))
    || !url.searchParams.get('credential') || !url.searchParams.get('expires') || !url.searchParams.get('signature')) {
    throw fail('TISTORY_UPLOAD_ACK_INVALID');
  }
  return value;
}

function decodeStoredMedia(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 131_072) throw fail('TISTORY_MEDIA_CREDENTIAL_INVALID');
  let record;
  try { record = JSON.parse(raw); } catch { throw fail('TISTORY_MEDIA_CREDENTIAL_INVALID'); }
  if (!record || record.version !== 1 || record.blogOrigin !== BLOG_ORIGIN || typeof record.responseRaw !== 'string') {
    throw fail('TISTORY_MEDIA_CREDENTIAL_INVALID');
  }
  return validateSignedMediaResponse(parseResponse(record.responseRaw));
}

async function saveAcknowledgement({ credentialStore, credentialId, raw }) {
  const envelope = JSON.stringify({ version: 1, blogOrigin: BLOG_ORIGIN, responseRaw: raw });
  if (envelope.length > 131_072) throw fail('TISTORY_UPLOAD_ACK_RESPONSE_TOO_LARGE');
  try { credentialStore.write(credentialId, envelope); }
  catch { throw fail('TISTORY_MEDIA_CREDENTIAL_STORE_FAILED'); }
}

async function readBounded(response) {
  if (!response?.body || typeof response.body.getReader !== 'function') throw fail('TISTORY_MEDIA_READBACK_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) {
        await reader.cancel().catch(() => {});
        throw fail('TISTORY_MEDIA_READBACK_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (/^TISTORY_MEDIA_READBACK_/.test(error?.code || '')) throw error;
    throw fail('TISTORY_MEDIA_READBACK_FAILED');
  }
  return Buffer.concat(chunks, total);
}

async function verifyReadback({ media, asset, kind, fetchImpl }) {
  const signal = AbortSignal.timeout(READBACK_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(media.url, {
      method: 'GET',
      headers: { referer: `${BLOG_ORIGIN}/manage/newpost/` },
      redirect: 'manual',
      signal,
    });
  } catch {
    throw fail(signal.aborted ? 'TISTORY_MEDIA_READBACK_TIMEOUT' : 'TISTORY_MEDIA_READBACK_FAILED');
  }
  if (!response || response.status !== 200) throw fail('TISTORY_MEDIA_READBACK_HTTP_FAILED');
  const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  // Video CDN response MIME has only been observed for video/mp4 so far.
  const expectedMime = kind === 'video-attachment' ? 'video/mp4' : asset.mime;
  if (contentType !== expectedMime) throw fail('TISTORY_MEDIA_READBACK_MIME_MISMATCH');
  const bytes = await readBounded(response);
  if (bytes.length !== asset.bytes.length || bytes.length !== media.size
    || detectMime(bytes, kind) !== expectedMime || digest(bytes) !== asset.sha256) {
    throw fail('TISTORY_MEDIA_READBACK_CONTENT_MISMATCH');
  }
  return { remoteSha256: digest(bytes), remoteBytes: bytes.length };
}

function publicReceipt(record, ok) {
  return { ok, ...record };
}

function errorCodeCandidate(error) {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;
  if (typeof error.code === 'string') return error.code;
  return error instanceof Error && typeof error.message === 'string' ? error.message : undefined;
}

function publicError(error) {
  const code = errorCodeCandidate(error);
  return SAFE_MEDIA_ERROR_CODES.has(code) ? code : 'TISTORY_MEDIA_OPERATION_FAILED';
}

function safeFailureCode(error, fallbackCode) {
  const code = publicError(error);
  return code === 'TISTORY_MEDIA_OPERATION_FAILED' ? fallbackCode : code;
}

function isTimeoutFailure(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    if (current.name === 'TimeoutError' || current.name === 'AbortError' || current.detail?.timedOut === true
      || ['TISTORY_TIMEOUT', 'TISTORY_MEDIA_READBACK_TIMEOUT'].includes(errorCodeCandidate(current))) return true;
  }
  return false;
}

async function uploadFile(filePath, {
  kind,
  journalPath,
  withSession = withAuthenticatedSession,
  credentialStore = defaultCredentialStore,
  fetchImpl = globalThis.fetch,
} = {}) {
  const safeJournalPath = validateJournalPath(journalPath);
  const asset = await readUploadFile(filePath, kind);
  const store = safeCredentialStore(credentialStore);
  const credentialId = newCredentialId(store);
  let journal;
  let postStarted = false;
  let ackReceived = false;
  let ackStored = false;
  let responseStatus;

  const intent = makeJournalRecord({ status: 'intent', kind, asset, credentialId });
  journal = await createFreshJournal(safeJournalPath, intent);
  const record = async (status, extra = {}) => {
    await journal.write(makeJournalRecord({ status, kind, asset, credentialId, responseStatus, ...extra }));
  };
  const recordFailure = async (status, error, fallbackCode) => record(status, {
    failureCode: safeFailureCode(error, fallbackCode),
    failedAt: new Date().toISOString(),
    timedOut: isTimeoutFailure(error),
  });

  try {
    let media;
    let responseRaw;
    try {
      await withSession(async active => {
        if (!active?.session || typeof active.session.request !== 'function') throw fail('TISTORY_AUTH_SESSION_INVALID');
        const form = new FormData();
        const fileBlob = new Blob([asset.bytes], { type: asset.mime });
        form.append('file', fileBlob, asset.filename);
        postStarted = true;
        const response = await active.session.request(MEDIA_UPLOAD_URL, {
          method: 'POST',
          headers: { accept: 'application/json', origin: BLOG_ORIGIN },
          referer: `${BLOG_ORIGIN}/manage/newpost/`,
          body: form,
        });
        responseStatus = response?.status;
        if (!response || !Number.isInteger(response.status)) throw fail('TISTORY_UPLOAD_OUTCOME_UNKNOWN');
        if (response.status !== 200) {
          if (response.status >= 500 || (response.status >= 300 && response.status < 400)) throw fail('TISTORY_UPLOAD_OUTCOME_UNKNOWN');
          throw fail('TISTORY_UPLOAD_REJECTED');
        }
        ackReceived = true;
        responseRaw = response.raw;
        // HTTP 200 is an acknowledgement boundary. Preserve its body in DPAPI
        // before interpreting fields or attempting independent CDN readback.
        await saveAcknowledgement({ credentialStore: store, credentialId, raw: responseRaw });
        ackStored = true;
        const responseMime = typeof response.headers?.get === 'function'
          ? response.headers.get('content-type')
          : response.headers?.['content-type'];
        if (typeof responseMime !== 'string' || !/^application\/json(?:\s*;|$)/i.test(responseMime)) {
          throw fail('TISTORY_UPLOAD_ACK_INVALID');
        }
        media = validateSignedMediaResponse(parseResponse(responseRaw), { sourceName: asset.filename, sourceMime: asset.mime });
      });
    } catch (error) {
      if (ackReceived && !ackStored) {
        await record('acknowledged_credential_store_failed').catch(() => {});
        if (error?.code === 'TISTORY_UPLOAD_ACK_RESPONSE_TOO_LARGE'
          || error?.code === 'TISTORY_MEDIA_CREDENTIAL_STORE_FAILED') throw error;
        throw fail('TISTORY_MEDIA_CREDENTIAL_STORE_FAILED');
      }
      if (ackStored) {
        await record('acknowledged_response_invalid').catch(() => {});
        throw fail('TISTORY_UPLOAD_ACK_INVALID');
      }
      if (postStarted) {
        const rejected = error?.code === 'TISTORY_UPLOAD_REJECTED';
        await recordFailure(rejected ? 'rejected' : 'outcome_unknown', error,
          rejected ? 'TISTORY_UPLOAD_REJECTED' : 'TISTORY_UPLOAD_OUTCOME_UNKNOWN').catch(() => {});
        if (error?.code === 'TISTORY_UPLOAD_REJECTED') throw error;
        throw fail('TISTORY_UPLOAD_OUTCOME_UNKNOWN');
      }
      await recordFailure('not_attempted', error, 'TISTORY_MEDIA_OPERATION_FAILED').catch(() => {});
      throw error;
    }

    await record('acknowledged');
    if (media.size !== asset.bytes.length) {
      await record('acknowledged_readback_failed');
      return publicReceipt(makeJournalRecord({ status: 'acknowledged_readback_failed', kind, asset, credentialId, responseStatus }), false);
    }

    try {
      const verified = await verifyReadback({ media, asset, kind, fetchImpl });
      const receipt = makeJournalRecord({ status: 'verified', kind, asset, credentialId, responseStatus, ...verified });
      await journal.write(receipt);
      return publicReceipt(receipt, true);
    } catch {
      const receipt = makeJournalRecord({ status: 'acknowledged_readback_failed', kind, asset, credentialId, responseStatus });
      await journal.write(receipt).catch(() => {});
      return publicReceipt(receipt, false);
    }
  } finally {
    await journal?.close().catch(() => {});
  }
}

/** Upload one PNG/JPEG/GIF/WebP image through the observed Tistory attachment contract. */
export async function uploadImage(filePath, options = {}) {
  return uploadFile(filePath, { ...options, kind: 'image' });
}

/**
 * Upload an MP4 as a downloadable file attachment. This does not create native
 * video playback or a video/iframe editor element.
 */
export async function uploadVideoAttachment(filePath, options = {}) {
  return uploadFile(filePath, { ...options, kind: 'video-attachment' });
}

/** Load an acknowledged response in memory for a publisher that needs its URL. */
export function loadStoredMedia(credentialId, { credentialStore = defaultCredentialStore } = {}) {
  if (typeof credentialId !== 'string' || !/^tistory-media-[0-9a-f-]{36}$/.test(credentialId)) {
    throw fail('TISTORY_MEDIA_CREDENTIAL_INVALID');
  }
  const store = safeCredentialStore(credentialStore);
  const raw = store.read(credentialId);
  if (!raw) throw fail('TISTORY_MEDIA_CREDENTIAL_MISSING');
  return decodeStoredMedia(raw);
}

export { publicError as safeMediaError };
