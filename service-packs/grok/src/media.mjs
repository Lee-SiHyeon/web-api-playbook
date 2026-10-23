import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, link } from 'node:fs/promises';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail } from './errors.mjs';

const SUPPORTED_MEDIA = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
]);

function normalizedMime(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function safeBaseName(value) {
  if (typeof value !== 'string' || !value.trim()) return 'grok-media';
  const result = value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').replace(/-+/g, '-').slice(0, 80);
  return result && result !== '.' && result !== '..' ? result : 'grok-media';
}

export function validateMediaPrefix(prefix, mimeType) {
  const mime = normalizedMime(mimeType);
  const extension = SUPPORTED_MEDIA.get(mime);
  if (!extension) throw fail('MEDIA_TYPE_UNSUPPORTED');
  const bytes = Buffer.from(prefix);
  let width;
  let height;
  let valid = false;
  if (mime === 'image/png') {
    valid = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && bytes.toString('ascii', 12, 16) === 'IHDR';
    if (valid) {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
      valid = width > 0 && height > 0 && width <= 100_000 && height <= 100_000 && width * height <= 1_000_000_000;
    }
  } else if (mime === 'image/jpeg') {
    valid = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } else if (mime === 'image/webp') {
    valid = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  } else if (mime === 'image/gif') {
    valid = bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
    if (valid) {
      width = bytes.readUInt16LE(6);
      height = bytes.readUInt16LE(8);
      valid = width > 0 && height > 0;
    }
  } else if (mime === 'video/mp4') {
    valid = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  } else if (mime === 'video/webm') {
    valid = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (!valid) throw fail('MEDIA_SIGNATURE_MISMATCH');
  return { mimeType: mime, extension, width, height };
}

export async function downloadValidatedMedia(response, {
  outputDir,
  suggestedName = 'grok-media',
  allowedMimeTypes,
  maxBytes,
} = {}) {
  if (!response || typeof response.status !== 'number' || response.status < 200 || response.status > 299
    || !response.body || typeof response.body.getReader !== 'function') throw fail('MEDIA_RESPONSE_INVALID');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || !Array.isArray(allowedMimeTypes)
    || !Number.isInteger(maxBytes) || maxBytes < 1) throw fail('MEDIA_OPTIONS_INVALID');
  const contentTypeHeader = response.headers?.get?.('content-type') ?? '';
  const mimeType = normalizedMime(contentTypeHeader);
  const expected = new Set(allowedMimeTypes.map(normalizedMime));
  if (!expected.has(mimeType) || !SUPPORTED_MEDIA.has(mimeType)) throw fail('MEDIA_TYPE_UNEXPECTED');
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) throw fail('MEDIA_SIZE_LIMIT');
  }

  await mkdir(outputDir, { recursive: true });
  const id = randomUUID();
  const tempPath = path.join(outputDir, `.grok-${id}.part`);
  const baseName = safeBaseName(suggestedName);
  let totalBytes = 0;
  let prefix = Buffer.alloc(64);
  let prefixLength = 0;
  const digest = createHash('sha256');
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        callback(fail('MEDIA_SIZE_LIMIT'));
        return;
      }
      if (prefixLength < prefix.length) {
        const count = Math.min(prefix.length - prefixLength, buffer.length);
        buffer.copy(prefix, prefixLength, 0, count);
        prefixLength += count;
      }
      digest.update(buffer);
      callback(null, buffer);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), validator, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    if (totalBytes === 0) throw fail('MEDIA_EMPTY');
    const media = validateMediaPrefix(prefix.subarray(0, prefixLength), mimeType);
    const filename = `${baseName}-${id}.${media.extension}`;
    const finalPath = path.join(outputDir, filename);
    await link(tempPath, finalPath);
    await rm(tempPath, { force: true });
    return {
      path: finalPath,
      bytes: totalBytes,
      mimeType: media.mimeType,
      width: media.width ?? null,
      height: media.height ?? null,
      sha256: digest.digest('hex'),
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    if (error?.code?.startsWith('MEDIA_')) throw error;
    throw fail('MEDIA_DOWNLOAD_FAILED');
  } finally {
    prefix.fill(0);
  }
}
