import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadObservedAsset, saveVerifiedMedia, validateMedia } from '../src/media.mjs';

function fakeMp4() {
  const data = Buffer.alloc(16);
  data.writeUInt32BE(16, 0);
  data.write('ftyp', 4, 'ascii');
  data.write('isom', 8, 'ascii');
  return data;
}

test('validates MIME and file signatures for image and video artifacts', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(validateMedia(png, 'image/png; charset=binary', 'image').kind, 'image');
  assert.equal(validateMedia(fakeMp4(), 'video/mp4', 'video').mime, 'video/mp4');
  assert.throws(() => validateMedia(fakeMp4(), 'image/png', 'image'), { code: 'MEDIA_FORMAT_INVALID' });
});

test('downloads only from an observed asset origin and validates the response', async () => {
  const bytes = fakeMp4();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  const result = await downloadObservedAsset('https://media.example/file', {
    assetOrigins: ['https://media.example'],
    expectedKind: 'video',
    fetchImpl,
  });
  assert.equal(result.bytes, bytes.length);
  await assert.rejects(downloadObservedAsset('https://unobserved.example/file', {
    assetOrigins: ['https://media.example'],
    expectedKind: 'video',
    fetchImpl,
  }), { code: 'ASSET_ORIGIN_BLOCKED' });
  assert.equal(calls, 1);
});

test('saves verified files without overwriting existing outputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gemini-media-'));
  const output = path.join(root, 'generated.mp4');
  const media = { body: fakeMp4(), mime: 'video/mp4', kind: 'video' };
  try {
    await saveVerifiedMedia(output, media);
    assert.deepEqual(await readFile(output), media.body);
    await assert.rejects(saveVerifiedMedia(output, media), { code: 'MEDIA_OUTPUT_EXISTS' });
    assert.deepEqual(await readFile(output), media.body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects redirects and oversized media without following a target', async () => {
  let calls = 0;
  await assert.rejects(downloadObservedAsset('https://media.example/file', {
    assetOrigins: ['https://media.example'],
    expectedKind: 'video',
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'https://other.example/file' } }); },
  }), { code: 'ASSET_REDIRECT_BLOCKED' });
  assert.equal(calls, 1);
});
