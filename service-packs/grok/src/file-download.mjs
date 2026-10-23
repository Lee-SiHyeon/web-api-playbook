import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail } from './errors.mjs';

const FILE_TYPES = new Map([
  ['application/zip', 'zip'],
  ['application/x-zip-compressed', 'zip'],
  ['text/csv', 'csv'],
]);

export function isFileDownloadMimeType(value) {
  return FILE_TYPES.has(normalizedMime(value));
}

function normalizedMime(value) {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function safeBaseName(value) {
  if (typeof value !== 'string' || !value.trim()) return 'grok-file';
  const result = value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').replace(/-+/g, '-').slice(0, 80);
  return result && result !== '.' && result !== '..' ? result : 'grok-file';
}

export async function downloadValidatedFile(response, {
  outputDir,
  suggestedName = 'grok-file',
  allowedMimeTypes,
  maxBytes,
  allowOctetStreamAsZip = false,
} = {}) {
  if (!response || response.status !== 200 || !response.body || typeof response.body.getReader !== 'function') {
    throw fail('FILE_RESPONSE_INVALID');
  }
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)
      || !Array.isArray(allowedMimeTypes) || !allowedMimeTypes.length
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw fail('FILE_DOWNLOAD_OPTIONS_INVALID');
  const responseMimeType = normalizedMime(response.headers?.get?.('content-type') ?? '');
  const allowed = allowedMimeTypes.map(normalizedMime);
  const octetStreamZip = allowOctetStreamAsZip === true
    && responseMimeType === 'application/octet-stream' && allowed.includes('application/zip');
  const mimeType = octetStreamZip ? 'application/zip' : responseMimeType;
  if (!allowed.includes(mimeType) || !FILE_TYPES.has(mimeType)) {
    await response.body?.cancel().catch(() => {});
    const actualMimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(responseMimeType)
      ? responseMimeType : 'unrecognized';
    throw fail('FILE_TYPE_UNEXPECTED', { actualMimeType,
      allowedMimeTypes: allowedMimeTypes.map(normalizedMime).filter(value => FILE_TYPES.has(value)) });
  }
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw fail('FILE_SIZE_LIMIT');
  }

  await mkdir(outputDir, { recursive: true });
  const token = randomUUID();
  const tempPath = path.join(outputDir, `.grok-file-${token}.part`);
  const extension = FILE_TYPES.get(mimeType);
  const finalPath = path.join(outputDir, `${safeBaseName(suggestedName)}-${token}.${extension}`);
  const digest = createHash('sha256');
  const prefix = Buffer.alloc(64);
  const decoder = mimeType === 'text/csv' ? new TextDecoder('utf-8', { fatal: true }) : null;
  let prefixLength = 0;
  let totalBytes = 0;
  let textValid = true;
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) return callback(fail('FILE_SIZE_LIMIT'));
      if (prefixLength < prefix.length) {
        const count = Math.min(prefix.length - prefixLength, bytes.length);
        bytes.copy(prefix, prefixLength, 0, count);
        prefixLength += count;
      }
      if (decoder) {
        try {
          if (decoder.decode(bytes, { stream: true }).includes('\0')) textValid = false;
        } catch { return callback(fail('FILE_TEXT_ENCODING_INVALID')); }
      }
      digest.update(bytes);
      callback(null, bytes);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), validator, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    if (totalBytes < 1) throw fail('FILE_EMPTY');
    let magicVerified = false;
    if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') {
      magicVerified = prefixLength >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b
        && prefix[2] === 0x03 && prefix[3] === 0x04;
      if (!magicVerified) throw fail('FILE_SIGNATURE_MISMATCH');
    } else {
      try {
        const tail = decoder.decode();
        if (tail.includes('\0')) textValid = false;
      } catch { textValid = false; }
      if (!textValid || !prefix.subarray(0, prefixLength).some(byte => byte === 0x2c)) {
        throw fail('FILE_CSV_FORMAT_INVALID');
      }
    }
    await link(tempPath, finalPath);
    await rm(tempPath, { force: true });
    return {
      path: finalPath,
      bytes: totalBytes,
      mimeType,
      responseMimeType,
      httpStatus: response.status,
      sha256: digest.digest('hex'),
      magicVerified,
      textEncodingVerified: decoder !== null,
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    if (typeof error?.code === 'string' && error.code.startsWith('FILE_')) throw error;
    throw fail('FILE_DOWNLOAD_FAILED');
  } finally {
    prefix.fill(0);
  }
}
