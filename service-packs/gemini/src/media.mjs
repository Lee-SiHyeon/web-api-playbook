import { mkdir, open, link, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GeminiClientError } from './errors.mjs';

const DEFAULT_MAX_BYTES = 80 * 1024 * 1024;
const SIGNATURES = Object.freeze({
  'image/png': (buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/webp': (buffer) => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP',
  'image/gif': (buffer) => buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6)),
  'video/mp4': (buffer) => buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp',
  'video/webm': (buffer) => buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
});

function normalizeMime(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function originOf(value) {
  let url;
  try { url = new URL(value); } catch { throw new GeminiClientError('ASSET_URL_INVALID', 'The media URL is invalid.'); }
  if (url.protocol !== 'https:') throw new GeminiClientError('ASSET_ORIGIN_BLOCKED', 'Media downloads require HTTPS.');
  return url;
}

export function validateMedia(buffer, contentType, expectedKind) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const mime = normalizeMime(contentType);
  const signature = SIGNATURES[mime];
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'other';
  if (!signature || !signature(buffer) || (expectedKind && kind !== expectedKind)) {
    throw new GeminiClientError('MEDIA_FORMAT_INVALID', 'The downloaded media did not match its declared MIME type and signature.');
  }
  return Object.freeze({ mime, kind, bytes: buffer.length });
}

export async function downloadObservedAsset(urlValue, {
  assetOrigins,
  expectedKind,
  fetchImpl = globalThis.fetch,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 30000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch-compatible function is required.');
  if (!Array.isArray(assetOrigins) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new GeminiClientError('ASSET_CONTRACT_NOT_CAPTURED', 'A captured media-origin allowlist and size limit are required.');
  }
  const url = originOf(urlValue);
  if (!assetOrigins.includes(url.origin)) throw new GeminiClientError('ASSET_ORIGIN_BLOCKED', 'The media host was not observed in the Gemini contract.');
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new GeminiClientError('ASSET_TRANSPORT_FAILED', 'The media download failed before a response was available.');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new GeminiClientError('ASSET_REDIRECT_BLOCKED', 'The media download returned a redirect and was not followed.');
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new GeminiClientError('ASSET_HTTP_REJECTED', 'The media download returned a non-success status.', { httpStatus: response.status });
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new GeminiClientError('ASSET_TOO_LARGE', 'The media response exceeded the configured size limit.');
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new GeminiClientError('ASSET_TOO_LARGE', 'The media response exceeded the configured size limit.');
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof GeminiClientError) throw error;
    throw new GeminiClientError('ASSET_READ_FAILED', 'The media response body could not be read.');
  }
  const body = Buffer.concat(chunks, length);
  const metadata = validateMedia(body, response.headers.get('content-type'), expectedKind);
  return Object.freeze({ body, ...metadata });
}

export async function saveVerifiedMedia(outputPath, media) {
  if (typeof outputPath !== 'string' || !outputPath || !Buffer.isBuffer(media?.body)) {
    throw new GeminiClientError('MEDIA_OUTPUT_INVALID', 'A target path and validated media buffer are required.');
  }
  validateMedia(media.body, media.mime, media.kind);
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = resolved + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(media.body);
    await handle.close();
    handle = null;
    await link(temporary, resolved);
    await unlink(temporary);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    if (error?.code === 'EEXIST') throw new GeminiClientError('MEDIA_OUTPUT_EXISTS', 'The output file already exists.');
    throw new GeminiClientError('MEDIA_WRITE_FAILED', 'The verified media could not be saved.');
  }
  return Object.freeze({ path: resolved, mime: media.mime, kind: media.kind, bytes: media.body.length });
}
