import { createWriteStream } from 'node:fs';
import { access, link, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ChatGPTWebError } from './errors.mjs';

const SIGNATURES = [
  { mime: 'image/png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) },
  { mime: 'image/webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/avif', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^(?:avif|avis)$/.test(b.toString('ascii', 8, 12)) },
  { mime: 'application/pdf', test: (b) => b.length >= 5 && b.toString('ascii', 0, 5) === '%PDF-' },
  { mime: 'video/mp4', test: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' },
  { mime: 'video/webm', test: (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { mime: 'audio/ogg', test: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS' },
  { mime: 'audio/wav', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { mime: 'audio/mpeg', test: (b) => b.length >= 3 && (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
];

const MIME_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'], ['audio/x-wav', 'audio/wav'], ['audio/mp3', 'audio/mpeg'],
  ['application/mp4', 'video/mp4'],
]);

export function normalizeMime(value) {
  const base = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return MIME_ALIASES.get(base) || base;
}

export function detectMediaType(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return SIGNATURES.find(({ test }) => test(buffer))?.mime || null;
}

export function validateMediaBytes(bytes, { contentType, contentTypes, maxBytes = 200_000_000 } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const declared = normalizeMime(contentType);
  const allowed = (contentTypes || []).map(normalizeMime);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || buffer.length < 1 || buffer.length > maxBytes) {
    throw new ChatGPTWebError('MEDIA_SIZE_REJECTED', { byteLength: buffer.length });
  }
  if (!declared || !allowed.includes(declared)) throw new ChatGPTWebError('MEDIA_MIME_REJECTED', { mimeType: declared });
  const detected = detectMediaType(buffer);
  const isGeneric = declared === 'application/octet-stream';
  if (!detected || !allowed.includes(detected) || (!isGeneric && detected !== declared)) {
    throw new ChatGPTWebError('MEDIA_SIGNATURE_MISMATCH', { mimeType: declared });
  }
  return { bytes: buffer.length, mimeType: declared, signatureVerified: true };
}

export function safeDispositionFilename(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const utf8 = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const regular = value.match(/filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
  let name;
  try { name = utf8 ? decodeURIComponent(utf8.trim()) : (regular?.[1] ?? regular?.[2] ?? ''); }
  catch { return null; }
  name = path.basename(name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 255) : null;
}

async function assertNotExists(target) {
  try { await access(target); throw new ChatGPTWebError('MEDIA_OUTPUT_EXISTS'); }
  catch (error) { if (error instanceof ChatGPTWebError) throw error; if (error?.code !== 'ENOENT') throw error; }
}

export async function downloadValidatedMedia(response, { outputPath, media, maxBytes, linkImpl = link }) {
  if (!response?.body || typeof outputPath !== 'string' || !media) throw new ChatGPTWebError('MEDIA_DOWNLOAD_INVALID');
  const contentType = normalizeMime(response.headers.get('content-type'));
  const accepted = (media.contentTypes || []).map(normalizeMime);
  if (!accepted.includes(contentType)) throw new ChatGPTWebError('MEDIA_MIME_REJECTED', { mimeType: contentType });
  const limit = Math.min(maxBytes ?? media.maxBytes ?? 200_000_000, media.maxBytes ?? 200_000_000);
  if (!Number.isInteger(limit) || limit < 1) throw new ChatGPTWebError('MEDIA_LIMIT_INVALID');
  const dispositionFilename = safeDispositionFilename(response.headers.get('content-disposition'));
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await assertNotExists(resolved);
  const temporary = `${resolved}.${randomUUID()}.part`;
  let total = 0;
  const limiter = new Transform({ transform(chunk, _encoding, callback) {
    total += chunk.length;
    if (total > limit) callback(new ChatGPTWebError('MEDIA_SIZE_REJECTED', { byteLength: total }));
    else callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (total < 1) throw new ChatGPTWebError('MEDIA_EMPTY');
    const declaredHeader = response.headers.get('content-length');
    const declaredLength = declaredHeader === null ? null : Number(declaredHeader);
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength >= 0 && declaredLength !== total) {
      throw new ChatGPTWebError('MEDIA_LENGTH_MISMATCH', { byteLength: total });
    }
    const handle = await open(temporary, 'r');
    let signature;
    try {
      signature = Buffer.alloc(Math.min(64, total));
      await handle.read(signature, 0, signature.length, 0);
    } finally { await handle.close(); }
    const detected = detectMediaType(signature);
    if (!detected || !accepted.includes(detected) || (contentType !== 'application/octet-stream' && detected !== contentType)) {
      throw new ChatGPTWebError('MEDIA_SIGNATURE_MISMATCH', { mimeType: contentType });
    }
    await assertNotExists(resolved);
    await linkImpl(temporary, resolved);
    await rm(temporary, { force: true }).catch(() => {});
    return { outputPath: resolved, bytes: total, mimeType: contentType, signatureVerified: true,
      filename: dispositionFilename };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (error instanceof ChatGPTWebError) throw error;
    if (error?.code === 'EEXIST') throw new ChatGPTWebError('MEDIA_OUTPUT_EXISTS');
    throw new ChatGPTWebError('MEDIA_DOWNLOAD_FAILED');
  }
}

export async function readMediaFileBounded(fileHandle, maxBytes, { chunkSize = 64 * 1024, initialSize } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 200_000_000
    || !Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024 * 1024) throw new ChatGPTWebError('MEDIA_LIMIT_INVALID');
  const chunks = [];
  const chunk = Buffer.alloc(Math.min(chunkSize, maxBytes + 1));
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const { bytesRead } = await fileHandle.read(chunk, 0, Math.min(chunk.length, remaining), null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new ChatGPTWebError('MEDIA_SIZE_REJECTED', { byteLength: total });
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  const finalInfo = await fileHandle.stat();
  if (total !== finalInfo.size || (initialSize !== undefined && total !== initialSize)) {
    throw new ChatGPTWebError('MEDIA_SIZE_CHANGED', { byteLength: total });
  }
  return Buffer.concat(chunks, total);
}

export async function prepareMediaUpload(filePath, mediaPolicy) {
  if (typeof filePath !== 'string' || !mediaPolicy) throw new ChatGPTWebError('MEDIA_UPLOAD_INVALID');
  const resolved = path.resolve(filePath);
  let file;
  try { file = await open(resolved, 'r'); } catch { throw new ChatGPTWebError('MEDIA_FILE_UNAVAILABLE'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > mediaPolicy.maxBytes) throw new ChatGPTWebError('MEDIA_SIZE_REJECTED', { byteLength: info.size });
    const bytes = await readMediaFileBounded(file, mediaPolicy.maxBytes, { initialSize: info.size });
    const detected = detectMediaType(bytes);
    const allowed = (mediaPolicy.contentTypes || []).map(normalizeMime);
    if (!detected || !allowed.includes(detected)) throw new ChatGPTWebError('MEDIA_SIGNATURE_MISMATCH', { mimeType: detected || 'unknown' });
    return { bytes, mimeType: detected, filename: path.basename(resolved), size: bytes.length,
      signatureVerified: true, sha256InputRequired: true };
  } finally { await file.close(); }
}
