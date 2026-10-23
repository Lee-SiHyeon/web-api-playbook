import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectMediaType, downloadValidatedMedia, prepareMediaUpload, readMediaFileBounded,
  safeDispositionFilename, validateMediaBytes } from '../src/media.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const MP4 = Buffer.from('000000186674797069736f6d00000000', 'hex');

test('media uploads and downloads check MIME, byte limit, length, and file signature', async () => {
  assert.equal(detectMediaType(PNG), 'image/png');
  assert.equal(detectMediaType(MP4), 'video/mp4');
  assert.deepEqual(validateMediaBytes(PNG, { contentType: 'image/png', contentTypes: ['image/png'], maxBytes: 128 }),
    { bytes: PNG.length, mimeType: 'image/png', signatureVerified: true });
  assert.throws(() => validateMediaBytes(PNG, { contentType: 'image/jpeg', contentTypes: ['image/jpeg'] }),
    (error) => error.code === 'MEDIA_SIGNATURE_MISMATCH');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-media-'));
  try {
    const source = path.join(directory, 'source.png');
    const output = path.join(directory, 'output.png');
    await writeFile(source, PNG);
    const upload = await prepareMediaUpload(source, { maxBytes: 128, contentTypes: ['image/png'] });
    assert.equal(upload.mimeType, 'image/png');
    assert.equal(upload.size, PNG.length);
    const response = new Response(PNG, { status: 200, headers: { 'content-type': 'image/png',
      'content-length': String(PNG.length), 'content-disposition': 'attachment; filename="../safe.png"' } });
    const result = await downloadValidatedMedia(response, { outputPath: output,
      media: { maxBytes: 128, contentTypes: ['image/png'] } });
    assert.equal(result.signatureVerified, true);
    assert.equal(result.filename, 'safe.png');
    assert.deepEqual(await readFile(output), PNG);
    await assert.rejects(downloadValidatedMedia(new Response(PNG, { status: 200,
      headers: { 'content-type': 'image/png' } }), { outputPath: output,
      media: { maxBytes: 128, contentTypes: ['image/png'] } }), (error) => error.code === 'MEDIA_OUTPUT_EXISTS');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid Content-Disposition encoding is ignored before the output is committed', async () => {
  assert.equal(safeDispositionFilename("attachment; filename*=UTF-8''%E0%A4%A"), null);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-media-header-'));
  try {
    const output = path.join(directory, 'image.png');
    const response = new Response(PNG, { status: 200, headers: { 'content-type': 'image/png',
      'content-disposition': "attachment; filename*=UTF-8''%E0%A4%A" } });
    const result = await downloadValidatedMedia(response, { outputPath: output,
      media: { maxBytes: 128, contentTypes: ['image/png'] } });
    assert.equal(result.filename, null);
    assert.deepEqual(await readFile(output), PNG);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bounded upload read stops on file growth and detects a changed size', async () => {
  let offset = 0;
  const growing = {
    async read(buffer, _start, length) {
      const source = Buffer.from('0123456789');
      const count = Math.min(length, source.length - offset);
      source.copy(buffer, 0, offset, offset + count);
      offset += count;
      return { bytesRead: count };
    },
    async stat() { return { size: 10 }; },
  };
  await assert.rejects(readMediaFileBounded(growing, 4, { initialSize: 4, chunkSize: 2 }),
    (error) => error.code === 'MEDIA_SIZE_REJECTED');

  offset = 0;
  const changed = {
    async read(buffer, _start, length) {
      const source = Buffer.from('12345');
      const count = Math.min(length, source.length - offset);
      source.copy(buffer, 0, offset, offset + count);
      offset += count;
      return { bytesRead: count };
    },
    async stat() { return { size: 5 }; },
  };
  await assert.rejects(readMediaFileBounded(changed, 10, { initialSize: 4, chunkSize: 3 }),
    (error) => error.code === 'MEDIA_SIZE_CHANGED');
});

test('media downloads reject login HTML even if the transport succeeded', async () => {
  await assert.rejects(downloadValidatedMedia(new Response('<html>login</html>', { status: 200,
    headers: { 'content-type': 'text/html' } }), { outputPath: path.join(os.tmpdir(), 'not-media.bin'),
    media: { maxBytes: 128, contentTypes: ['image/png'] } }), (error) => error.code === 'MEDIA_MIME_REJECTED');
});

test('atomic download commit preserves a destination created in the final-check race', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-media-race-'));
  try {
    const output = path.join(directory, 'race.png');
    const concurrentBytes = Buffer.from('created concurrently');
    const response = new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    const raceLink = async (temporary, destination) => {
      await writeFile(destination, concurrentBytes);
      await link(temporary, destination);
    };
    await assert.rejects(downloadValidatedMedia(response, { outputPath: output,
      media: { maxBytes: 128, contentTypes: ['image/png'] }, linkImpl: raceLink }),
    (error) => error.code === 'MEDIA_OUTPUT_EXISTS');
    assert.deepEqual(await readFile(output), concurrentBytes);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.part')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
