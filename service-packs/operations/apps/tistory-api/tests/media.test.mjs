import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  MAX_IMAGE_BYTES,
  MEDIA_UPLOAD_URL,
  SUPPORTED_IMAGE_MIME_TYPES,
  loadStoredMedia,
  safeMediaError,
  uploadImage,
  uploadVideoAttachment,
} from '../lib/media.mjs';
import { BLOG_ORIGIN } from '../lib/transport.mjs';

const tempDirs = new Set();
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function newFixture(bytes = Buffer.concat([pngSignature, Buffer.from('mock-png-payload')]), filename = 'cover-v4.png') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tistory-media-test-'));
  tempDirs.add(dir);
  const file = path.join(dir, filename);
  const journal = path.join(dir, 'receipt.json');
  await writeFile(file, bytes);
  return { dir, file, journal, bytes };
}

afterEach(async () => {
  await Promise.all([...tempDirs].map(dir => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

function signedUrl({ firstSegmentLength = 5, filename = 'img.png' } = {}) {
  const key = `${'A'.repeat(firstSegmentLength)}/${'b'.repeat(11)}/${'c'.repeat(64)}`;
  const url = new URL(`https://blog.kakaocdn.net/dna/${key}/${filename}`);
  url.searchParams.set('credential', 'mock-credential');
  url.searchParams.set('expires', '9999999999');
  url.searchParams.set('allow_ip', '');
  url.searchParams.set('allow_referer', '');
  url.searchParams.set('signature', 'mock-signature');
  return { key, filename, url: url.href };
}

function createMocks({ sourceBytes, sourceName = 'cover-v4.png', sourceMime = 'image/png', cdnFilename = 'img.png',
  firstSegmentLength = 5, ackSize = sourceBytes.length, requestStatus = 200, readbackStatus = 200, readbackBytes = sourceBytes,
  readbackMime = sourceMime, requestFailure = null } = {}) {
  const stored = new Map();
  let postCount = 0;
  let capturedFileBytes;
  let capturedFileName;
  const store = {
    exists: id => stored.has(id),
    read: id => stored.get(id) ?? null,
    write: (id, value) => { stored.set(id, value); return { stored: true }; },
  };
  const { key, filename, url } = signedUrl({ firstSegmentLength, filename: cdnFilename });
  const ack = { name: sourceName, url, key, filename, size: ackSize };
  const withSession = async operation => operation({
    session: {
      async request(requestUrl, options) {
        postCount += 1;
        if (requestFailure) throw requestFailure;
        assert.equal(requestUrl === MEDIA_UPLOAD_URL, true, 'uses the observed attach endpoint');
        assert.equal(options.method, 'POST');
        assert.equal(options.referer, `${BLOG_ORIGIN}/manage/newpost/`);
        assert.equal(options.headers.accept, 'application/json');
        assert.equal(options.headers.origin, BLOG_ORIGIN);
        assert.equal(Object.keys(options.headers).some(name => name.toLowerCase() === 'content-type'), false,
          'fetch creates the multipart boundary');
        const fields = [...options.body.entries()];
        assert.equal(fields.length, 1);
        assert.equal(fields[0][0], 'file');
        capturedFileName = fields[0][1].name;
        capturedFileMime = fields[0][1].type;
        capturedFileBytes = Buffer.from(await fields[0][1].arrayBuffer());
        return {
          status: requestStatus,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          raw: requestStatus === 200 ? JSON.stringify(ack) : 'rejected response body must not be persisted',
        };
      },
    },
    state: {},
    receipt: { execution: 'mock' },
  });
  let fetched;
  let capturedFileMime;
  const fetchImpl = async (input, init) => {
    fetched = { sameUrl: input === url, init };
    return new Response(readbackBytes, {
      status: readbackStatus,
      headers: { 'content-type': readbackMime },
    });
  };
  return {
    stored, store, withSession, fetchImpl,
    get postCount() { return postCount; },
    get capturedFileBytes() { return capturedFileBytes; },
    get capturedFileName() { return capturedFileName; },
    get capturedFileMime() { return capturedFileMime; },
    get fetched() { return fetched; },
  };
}

test('multipart upload is acknowledged once, encrypted response is addressable, and public readback verifies bytes', async () => {
  const fixture = await newFixture();
  const mock = createMocks({ sourceBytes: fixture.bytes });
  const receipt = await uploadImage(fixture.file, {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.sourceBytes, fixture.bytes.length);
  assert.equal(receipt.remoteBytes, fixture.bytes.length);
  assert.equal(receipt.sourceSha256, receipt.remoteSha256);
  assert.equal(receipt.responseStatus, 200);
  assert.equal(receipt.credentialId.startsWith('tistory-media-'), true);
  assert.deepEqual(receipt.responseSchema, { name: 'string', url: 'string', key: 'string', filename: 'string', size: 'number' });
  assert.equal(mock.postCount, 1);
  assert.equal(mock.capturedFileName, 'cover-v4.png');
  assert.equal(mock.capturedFileBytes.equals(fixture.bytes), true);
  assert.equal(mock.fetched.sameUrl, true);
  assert.equal(mock.fetched.init.method, 'GET');
  assert.equal(mock.fetched.init.redirect, 'manual');
  assert.deepEqual(mock.fetched.init.headers, { referer: `${BLOG_ORIGIN}/manage/newpost/` });
  assert.equal(Object.keys(mock.fetched.init.headers).some(name => /cookie|authorization/i.test(name)), false);

  const journalText = await readFile(fixture.journal, 'utf8');
  const journal = JSON.parse(journalText);
  assert.equal(journal.status, 'verified');
  assert.equal(journal.credentialId, receipt.credentialId);
  assert.equal(journalText.includes('blog.kakaocdn.net'), false);
  assert.equal(journalText.includes('mock-signature'), false);
  assert.equal(journalText.includes('mock-credential'), false);

  const storedMedia = loadStoredMedia(receipt.credentialId, { credentialStore: mock.store });
  assert.deepEqual(storedMedia.key.split('/').map(part => part.length), [5, 11, 64]);
  assert.equal(storedMedia.size, fixture.bytes.length);
  assert.equal(storedMedia.url.includes('mock-signature'), true);
});

test('an existing journal blocks a second upload before authentication or network activity', async () => {
  const fixture = await newFixture();
  const mock = createMocks({ sourceBytes: fixture.bytes });
  const options = {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  };
  await uploadImage(fixture.file, options);
  let code;
  try { await uploadImage(fixture.file, options); } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_JOURNAL_ALREADY_EXISTS');
  assert.equal(mock.postCount, 1);
});

test('safeMediaError preserves only allowlisted codes from Error objects or strings', () => {
  const coded = Object.assign(new Error('private transport details'), { code: 'TISTORY_UPLOAD_OUTCOME_UNKNOWN' });
  assert.equal(safeMediaError(coded), 'TISTORY_UPLOAD_OUTCOME_UNKNOWN');
  assert.equal(safeMediaError('TISTORY_UPLOAD_REJECTED'), 'TISTORY_UPLOAD_REJECTED');
  assert.equal(safeMediaError(new Error('TISTORY_TIMEOUT')), 'TISTORY_TIMEOUT');
  assert.equal(safeMediaError(Object.assign(new Error('sensitive body'), { code: 'TISTORY_SECRET_COOKIE_VALUE' })), 'TISTORY_MEDIA_OPERATION_FAILED');
  assert.equal(safeMediaError('TISTORY_UPLOAD_OUTCOME_UNKNOWN?token=secret'), 'TISTORY_MEDIA_OPERATION_FAILED');
});

test('a timeout records safe unknown-outcome metadata and the same journal prevents a second POST', async () => {
  const fixture = await newFixture();
  const timeout = Object.assign(new Error('private mock timeout detail'), { name: 'TimeoutError', code: 'TISTORY_TIMEOUT' });
  const mock = createMocks({ sourceBytes: fixture.bytes, requestFailure: timeout });
  const options = {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  };
  let code;
  try {
    await uploadImage(fixture.file, options);
  } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_UPLOAD_OUTCOME_UNKNOWN');
  assert.equal(mock.postCount, 1);
  const journalText = await readFile(fixture.journal, 'utf8');
  const journal = JSON.parse(journalText);
  assert.equal(journal.status, 'outcome_unknown');
  assert.equal(journal.failureCode, 'TISTORY_TIMEOUT');
  assert.equal(journal.timedOut, true);
  assert.equal(Number.isFinite(Date.parse(journal.failedAt)), true);
  assert.equal(journalText.includes('private mock timeout detail'), false);
  assert.equal(journalText.includes('blog.kakaocdn.net'), false);
  assert.equal(journalText.includes('cookie'), false);
  code = undefined;
  try { await uploadImage(fixture.file, options); } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_JOURNAL_ALREADY_EXISTS');
  assert.equal(mock.postCount, 1);
});

test('a rejected response records only its safe code, time, and timeout flag', async () => {
  const fixture = await newFixture();
  const mock = createMocks({ sourceBytes: fixture.bytes, requestStatus: 403 });
  let code;
  try {
    await uploadImage(fixture.file, {
      journalPath: fixture.journal,
      withSession: mock.withSession,
      credentialStore: mock.store,
      fetchImpl: mock.fetchImpl,
    });
  } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_UPLOAD_REJECTED');
  assert.equal(mock.postCount, 1);
  const journalText = await readFile(fixture.journal, 'utf8');
  const journal = JSON.parse(journalText);
  assert.equal(journal.status, 'rejected');
  assert.equal(journal.failureCode, 'TISTORY_UPLOAD_REJECTED');
  assert.equal(journal.timedOut, false);
  assert.equal(Number.isFinite(Date.parse(journal.failedAt)), true);
  assert.equal(journalText.includes('rejected response body'), false);
  assert.equal(journalText.includes('blog.kakaocdn.net'), false);
});

test('a preflight failure records not-attempted without exposing its message', async () => {
  const fixture = await newFixture();
  const store = { exists: () => false, read: () => null, write: () => {} };
  let code;
  try {
    await uploadImage(fixture.file, {
      journalPath: fixture.journal,
      withSession: async () => { throw Object.assign(new Error('private login details'), { code: 'TISTORY_REAUTH_REQUIRED' }); },
      credentialStore: store,
      fetchImpl: async () => { throw new Error('readback must not run'); },
    });
  } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_REAUTH_REQUIRED');
  const journalText = await readFile(fixture.journal, 'utf8');
  const journal = JSON.parse(journalText);
  assert.equal(journal.status, 'not_attempted');
  assert.equal(journal.failureCode, 'TISTORY_REAUTH_REQUIRED');
  assert.equal(journal.timedOut, false);
  assert.equal(Number.isFinite(Date.parse(journal.failedAt)), true);
  assert.equal(journalText.includes('private login details'), false);
});

test('readback failure keeps the acknowledged response credential and a safe receipt', async () => {
  const fixture = await newFixture();
  const mock = createMocks({ sourceBytes: fixture.bytes, readbackStatus: 403 });
  const receipt = await uploadImage(fixture.file, {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'acknowledged_readback_failed');
  assert.equal(mock.stored.has(receipt.credentialId), true);
  assert.equal(loadStoredMedia(receipt.credentialId, { credentialStore: mock.store }).size, fixture.bytes.length);
  assert.equal(JSON.parse(await readFile(fixture.journal, 'utf8')).status, 'acknowledged_readback_failed');
});

test('a successful HTTP response with a size mismatch remains acknowledged but unverified', async () => {
  const fixture = await newFixture();
  const mock = createMocks({ sourceBytes: fixture.bytes, ackSize: fixture.bytes.length + 1 });
  const receipt = await uploadImage(fixture.file, {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'acknowledged_readback_failed');
  assert.equal(mock.postCount, 1);
  assert.equal(mock.fetched, undefined);
  assert.equal(mock.stored.has(receipt.credentialId), true);
});

test('local signature and size guards run before authenticated upload', async () => {
  const fixture = await newFixture(Buffer.from('not an image'));
  let called = false;
  let code;
  try {
    await uploadImage(fixture.file, {
      journalPath: fixture.journal,
      withSession: async () => { called = true; },
      credentialStore: { exists: () => false, read: () => null, write: () => {} },
      fetchImpl: async () => { called = true; },
    });
  } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_IMAGE_TYPE_UNSUPPORTED');
  assert.equal(called, false);

  const large = await newFixture();
  await truncate(large.file, MAX_IMAGE_BYTES + 1);
  code = undefined;
  try {
    await uploadImage(large.file, {
      journalPath: large.journal,
      withSession: async () => { called = true; },
      credentialStore: { exists: () => false, read: () => null, write: () => {} },
      fetchImpl: async () => { called = true; },
    });
  } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_IMAGE_TOO_LARGE');
  assert.equal(called, false);
});

test('PNG, JPEG, GIF, and WebP signatures reach the single upload attempt', async () => {
  const supported = [
    ['image/png', 'cover.png', Buffer.concat([pngSignature, Buffer.from('png')])],
    ['image/jpeg', 'cover.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00])],
    ['image/gif', 'cover.gif', Buffer.from('GIF89a-image')],
    ['image/webp', 'cover.webp', Buffer.from('RIFF0000WEBP-image')],
  ];
  assert.deepEqual(SUPPORTED_IMAGE_MIME_TYPES, supported.map(([mime]) => mime));
  for (const [, filename, bytes] of supported) {
    const fixture = await newFixture(bytes, filename);
    let posts = 0;
    let code;
    try {
      await uploadImage(fixture.file, {
        journalPath: fixture.journal,
        withSession: operation => operation({ session: { request: async () => { posts += 1; throw new Error('mock transport'); } } }),
        credentialStore: { exists: () => false, read: () => null, write: () => {} },
        fetchImpl: async () => { throw new Error('readback must not run'); },
      });
    } catch (error) { code = error.code; }
    assert.equal(code, 'TISTORY_UPLOAD_OUTCOME_UNKNOWN');
    assert.equal(posts, 1);
  }
});

test('CDN MIME and content mismatch do not count as verified', async () => {
  const fixture = await newFixture();
  const mock = createMocks({ sourceBytes: fixture.bytes, readbackMime: 'image/jpeg' });
  const receipt = await uploadImage(fixture.file, {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'acknowledged_readback_failed');
  assert.equal(mock.postCount, 1);
});

test('MP4 uploads as a downloadable attachment with video/mp4 and returns a distinct safe receipt', async () => {
  const mp4 = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.from([0x00, 0x00, 0x02, 0x00]),
    Buffer.from('isom'),
  ]);
  const originalName = 'pixel-wizard-compare2.mp4';
  const fixture = await newFixture(mp4, originalName);
  const mock = createMocks({
    sourceBytes: fixture.bytes,
    sourceName: originalName,
    sourceMime: 'video/mp4',
    cdnFilename: 'tfile.mp4',
    firstSegmentLength: 6,
  });
  const receipt = await uploadVideoAttachment(fixture.file, {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.schema, 'tistory-downloadable-video-attachment-receipt-v1');
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.sourceBytes, mp4.length);
  assert.equal(receipt.sourceSha256, receipt.remoteSha256);
  assert.equal(mock.postCount, 1);
  assert.equal(mock.capturedFileName, originalName);
  assert.equal(mock.capturedFileMime, 'video/mp4');
  assert.equal(mock.capturedFileBytes.equals(mp4), true);
  assert.equal(mock.fetched.init.headers.referer, `${BLOG_ORIGIN}/manage/newpost/`);
  assert.equal(loadStoredMedia(receipt.credentialId, { credentialStore: mock.store }).filename, 'tfile.mp4');
  const journal = JSON.parse(await readFile(fixture.journal, 'utf8'));
  assert.equal(journal.schema, 'tistory-downloadable-video-attachment-receipt-v1');
  assert.equal(JSON.stringify(journal).includes('blog.kakaocdn.net'), false);
});

test('MP4 signature and extension are required before any authenticated POST', async () => {
  const fixture = await newFixture(Buffer.from('not-mp4'), 'broken.mp4');
  let called = false;
  let code;
  try {
    await uploadVideoAttachment(fixture.file, {
      journalPath: fixture.journal,
      withSession: async () => { called = true; },
      credentialStore: { exists: () => false, read: () => null, write: () => {} },
      fetchImpl: async () => { called = true; },
    });
  } catch (error) { code = error.code; }
  assert.equal(code, 'TISTORY_VIDEO_ATTACHMENT_TYPE_UNSUPPORTED');
  assert.equal(called, false);
});

test('MP4 readback MIME is restricted to the observed video/mp4 value', async () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom0000')]);
  const originalName = 'clip.mp4';
  const fixture = await newFixture(mp4, originalName);
  const mock = createMocks({
    sourceBytes: fixture.bytes,
    sourceName: originalName,
    sourceMime: 'video/mp4',
    cdnFilename: 'tfile.mp4',
    readbackMime: 'application/octet-stream',
  });
  const receipt = await uploadVideoAttachment(fixture.file, {
    journalPath: fixture.journal,
    withSession: mock.withSession,
    credentialStore: mock.store,
    fetchImpl: mock.fetchImpl,
  });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.schema, 'tistory-downloadable-video-attachment-receipt-v1');
  assert.equal(receipt.status, 'acknowledged_readback_failed');
  assert.equal(mock.stored.has(receipt.credentialId), true);
});
