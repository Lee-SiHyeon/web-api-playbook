import { lstat, open } from 'node:fs/promises';
import { fail } from './errors.mjs';

const MAX_MP4_BYTES = 512 * 1024 * 1024;
const MAX_TOP_LEVEL_BOXES = 4096;

async function readExact(handle, length, position) {
  if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(position) || position < 0) {
    throw fail('MP4_CONTAINER_INVALID');
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw fail('MP4_CONTAINER_INVALID');
  return buffer;
}

async function readBox(handle, offset, parentEnd) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(parentEnd) || offset + 8 > parentEnd) {
    throw fail('MP4_CONTAINER_INVALID');
  }
  const head = await readExact(handle, 8, offset);
  let size = head.readUInt32BE(0);
  const type = head.toString('ascii', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    const extended = await readExact(handle, 8, offset + 8);
    const large = extended.readBigUInt64BE(0);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('MP4_CONTAINER_INVALID');
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = parentEnd - offset;
  }
  if (size < headerSize || offset + size > parentEnd) throw fail('MP4_CONTAINER_INVALID');
  return { type, size, headerSize, payloadOffset: offset + headerSize, end: offset + size };
}

async function durationFromMovieBox(handle, moov) {
  let offset = moov.payloadOffset;
  let found = null;
  let count = 0;
  while (offset < moov.end) {
    if (++count > MAX_TOP_LEVEL_BOXES) throw fail('MP4_CONTAINER_INVALID');
    const box = await readBox(handle, offset, moov.end);
    if (box.type === 'mvhd') {
      if (found) throw fail('MP4_CONTAINER_INVALID');
      found = box;
    }
    offset = box.end;
  }
  if (!found) throw fail('MP4_DURATION_NOT_FOUND');
  const fixed = await readExact(handle, Math.min(found.size - found.headerSize, 32), found.payloadOffset);
  if (fixed.length < 20) throw fail('MP4_CONTAINER_INVALID');
  const version = fixed[0];
  let timescale;
  let duration;
  if (version === 0) {
    timescale = fixed.readUInt32BE(12);
    duration = BigInt(fixed.readUInt32BE(16));
  } else if (version === 1) {
    if (fixed.length < 32) throw fail('MP4_CONTAINER_INVALID');
    timescale = fixed.readUInt32BE(20);
    duration = fixed.readBigUInt64BE(24);
  } else {
    throw fail('MP4_VERSION_UNSUPPORTED');
  }
  if (!Number.isInteger(timescale) || timescale < 1 || duration < 1n || duration === 0xffffffffffffffffn) {
    throw fail('MP4_DURATION_INVALID');
  }
  const seconds = Number(duration) / timescale;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 60 * 60) throw fail('MP4_DURATION_INVALID');
  return Math.round(seconds * 1000) / 1000;
}

export async function readMp4DurationFromFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.startsWith('/') || /[\r\n\0]/.test(filePath)) {
    throw fail('MP4_PATH_INVALID');
  }
  let handle;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 16 || info.size > MAX_MP4_BYTES) {
      throw fail('MP4_FILE_INVALID');
    }
    handle = await open(filePath, 'r');
    const first = await readExact(handle, 8, 0);
    if (first.readUInt32BE(0) < 8 || first.toString('ascii', 4, 8) !== 'ftyp') throw fail('MP4_FTYP_MISSING');
    let offset = 0;
    let count = 0;
    let movie = null;
    while (offset < info.size) {
      if (++count > MAX_TOP_LEVEL_BOXES) throw fail('MP4_CONTAINER_INVALID');
      const box = await readBox(handle, offset, info.size);
      if (box.type === 'moov') {
        if (movie) throw fail('MP4_CONTAINER_INVALID');
        movie = box;
      }
      offset = box.end;
    }
    if (!movie) throw fail('MP4_DURATION_NOT_FOUND');
    return await durationFromMovieBox(handle, movie);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('MP4_')) throw error;
    throw fail('MP4_FILE_READ_FAILED');
  } finally {
    await handle?.close().catch(() => {});
  }
}
