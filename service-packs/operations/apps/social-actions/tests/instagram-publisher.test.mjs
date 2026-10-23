import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  buildInstagramConfigureBody,
  hashInstagramPublishIntent,
  buildInstagramSidecarConfigureBody,
  buildInstagramUploadEnvelope,
  buildInstagramReadbackExpectation,
  inspectInstagramMedia,
  publishInstagramMedia,
  uploadInstagramReelMediaOnly,
  reconcileInstagramPublish,
  resumeInstagramSidecarConfigure,
  verifyInstagramReadback,
} from '../instagram-publisher.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const caption = '틱톡 한가위 룰렛으로 출금 직전까지 모인 이유?\n\n#틱톡 #앱테크';
const owner = 'lifehack__ailab';

function jpegBytes(width = 1080, height = 1920) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
}

function pngBytes(width = 1080, height = 1920) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fakeUploadContext(videoSource = 'https://i.instagram.com/rupload_igvideo/ is_sidecar:y?"1":"0" for_album:v=== is_clips_video') {
  return {
    url: 'https://www.instagram.com/',
    bundle: { service: 'instagram', origin: 'https://www.instagram.com', cookies: [
      { name: 'csrftoken', value: 'csrf-test', domain: 'instagram.com' },
      { name: 'sessionid', value: 'session-test', domain: '.instagram.com' },
      { name: 'foreign', value: 'foreign-test', domain: 'example.com' }],
      ownerRequest: { headers: { 'x-asbd-id': '123', 'x-instagram-ajax': 'rollout-test', 'x-ig-app-id': 'app-test',
        'user-agent': 'test-agent' } } },
    document: { modules: new Map([['RelayAPIConfigDefaults', { customHeaders: { 'x-ig-app-id': 'app-test' } }]]) },
    sources: new Map([
      ['PolarisAPIFbUploaderPhoto', { source: 'entityName:"fb_uploader_"' }],
      ['PolarisAPIRuploadPhoto', { source: 'https://i.instagram.com/rupload_igphoto/' }],
      ['PolarisAPIRuploadVideo', { source: videoSource }],
    ]),
  };
}

const freshDtsg = 'fresh-document-token';

function fakeSidecarContext(fetchImpl) {
  return {
    url: 'https://www.instagram.com/',
    bundle: { service: 'instagram', origin: 'https://www.instagram.com', owner: 'lifehack__ailab', cookies: [
      { name: 'csrftoken', value: 'csrf-test', domain: 'instagram.com' },
      { name: 'sessionid', value: 'session-test', domain: 'instagram.com' },
      { name: 'foreign', value: 'foreign-test', domain: 'example.com' },
    ], ownerRequest: { headers: { 'x-asbd-id': '123', 'x-instagram-ajax': 'rollout-test', 'x-ig-app-id': 'app-test' } } },
    document: { gkx: new Map([['18382', false]]), modules: new Map([
      ['RelayAPIConfigDefaults', { customHeaders: { 'x-ig-app-id': 'app-test' } }],
      ['DTSGInitialData', { token: freshDtsg }],
      ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ]) },
    sources: new Map([
      ['PolarisCreationAPI', { source: 'media_share_flow:"creation_flow" children_metadata:x client_sidecar_id:$ /api/v1/media/configure_sidecar/' }],
      ['PolarisInstajax', { source: 'r("InstagramWebPushInfo").rollout_hash' }],
      ['DTSGUtils', { source: 'getNumericValue .charCodeAt( SprinkleConfig' }],
    ]),
    fetchImpl,
  };
}

function photoItems(count = 1) {
  return Array.from({ length: count }, (_, index) => ({ mediaType: 'photo', sha256: String(index + 1).repeat(64),
    byteLength: 1024 + index, width: 1080, height: 1350, durationMs: null }));
}

function reelItems() {
  return [{ mediaType: 'video', sha256: 'b'.repeat(64), byteLength: 1024, width: 1080, height: 1920, durationMs: 33140 }];
}

function post({ id = '12345', shortcode = 'AbC123', text = caption, mediaType, productType, carouselCount = 0 } = {}) {
  return { id, shortcode, url: `https://www.instagram.com/${productType === 'clips' ? 'reel' : 'p'}/${shortcode}/`,
    caption: text, mediaType, productType, carouselCount };
}

function mediaPost(media) {
  const expected = buildInstagramReadbackExpectation(media, caption).expectedMedia;
  return post({ mediaType: expected.mediaType, productType: expected.productType, carouselCount: expected.carouselCount });
}

test('journals the exact caption hash and expected photo, Reel, or carousel shape without caption text', () => {
  const photo = buildInstagramReadbackExpectation(photoItems(), caption);
  const reel = buildInstagramReadbackExpectation(reelItems(), caption);
  const carousel = buildInstagramReadbackExpectation(photoItems(5), caption);

  assert.equal(photo.expectedCaptionSha256, hash(caption));
  assert.deepEqual({ kind: photo.expectedMedia.kind, itemCount: photo.expectedMedia.itemCount,
    mediaType: photo.expectedMedia.mediaType, productType: photo.expectedMedia.productType,
    carouselCount: photo.expectedMedia.carouselCount },
  { kind: 'photo', itemCount: 1, mediaType: 1, productType: 'feed', carouselCount: 0 });
  assert.deepEqual({ kind: reel.expectedMedia.kind, itemCount: reel.expectedMedia.itemCount,
    mediaType: reel.expectedMedia.mediaType, productType: reel.expectedMedia.productType,
    carouselCount: reel.expectedMedia.carouselCount },
  { kind: 'reel', itemCount: 1, mediaType: 2, productType: 'clips', carouselCount: 0 });
  assert.deepEqual({ kind: carousel.expectedMedia.kind, itemCount: carousel.expectedMedia.itemCount,
    mediaType: carousel.expectedMedia.mediaType, productType: carousel.expectedMedia.productType,
    carouselCount: carousel.expectedMedia.carouselCount },
  { kind: 'carousel', itemCount: 5, mediaType: 8, productType: 'carousel_container', carouselCount: 5 });
  assert.equal(JSON.stringify(carousel).includes(caption), false);
  assert.equal(carousel.expectedMedia.items.length, 5);
  assert.equal(carousel.expectedMedia.items[0].fileSha256, '1'.repeat(64));
});

test('publishing intent hashes distinguish explicit AI self-disclosure choices', () => {
  const base = { owner, media: [{ mediaType: 'photo', fileSha256: 'a'.repeat(64), userTags: [] }],
    caption, disableComments: false };
  const undisclosed = hashInstagramPublishIntent({ ...base, genAiSelfDisclosure: false });
  const disclosed = hashInstagramPublishIntent({ ...base, genAiSelfDisclosure: true });
  assert.match(undisclosed, /^[a-f0-9]{64}$/);
  assert.notEqual(undisclosed, disclosed);
});

test('readback requires an exact caption hash and the expected photo/Reel/carousel type and count', () => {
  for (const media of [photoItems(), reelItems(), photoItems(5)]) {
    const expected = buildInstagramReadbackExpectation(media, caption);
    assert.equal(verifyInstagramReadback(mediaPost(media), expected).verified, true);
    assert.equal(verifyInstagramReadback(mediaPost(media), { ...expected, expectedCaptionSha256: hash(caption + '!') }).verified, false);
    assert.equal(verifyInstagramReadback(mediaPost(media), expected).captionMatched, true);
  }

  const carousel = buildInstagramReadbackExpectation(photoItems(5), caption);
  assert.equal(verifyInstagramReadback(post({ mediaType: 8, productType: 'carousel_container', carouselCount: 4 }), carousel).mediaMatched, false);
  assert.equal(verifyInstagramReadback(post({ mediaType: 1, productType: 'feed', carouselCount: 0 }), carousel).mediaMatched, false);
  const reel = buildInstagramReadbackExpectation(reelItems(), caption);
  assert.equal(verifyInstagramReadback(post({ mediaType: 2, productType: 'feed', carouselCount: 0 }), reel).mediaMatched, false);
  const photo = buildInstagramReadbackExpectation(photoItems(), caption);
  assert.equal(verifyInstagramReadback(post({ mediaType: 2, productType: 'clips', carouselCount: 0 }), photo).mediaMatched, false);
});

test('Reel video and cover upload envelopes match the captured rupload contract and share one prefixed entity', () => {
  const context = fakeUploadContext();
  const uploadId = '17802411234567890';
  const video = { mediaType: 'video', mimeType: 'video/mp4', buffer: Buffer.from('video'), byteLength: 5,
    durationMs: 33139, width: 1080, height: 1920 };
  const cover = { mediaType: 'photo', mimeType: 'image/jpeg', buffer: jpegBytes(), byteLength: jpegBytes().length,
    width: 1080, height: 1920 };

  const videoRequest = buildInstagramUploadEnvelope(context, video, uploadId, { reelVideo: true });
  const coverRequest = buildInstagramUploadEnvelope(context, cover, uploadId, { reelCover: true });
  const videoParams = JSON.parse(videoRequest.headers['x-instagram-rupload-params']);
  const coverParams = JSON.parse(coverRequest.headers['x-instagram-rupload-params']);

  assert.equal(videoRequest.url, `https://i.instagram.com/rupload_igvideo/fb_uploader_${uploadId}`);
  assert.equal(coverRequest.url, `https://i.instagram.com/rupload_igphoto/fb_uploader_${uploadId}`);
  assert.equal(videoRequest.headers['x-entity-name'], `fb_uploader_${uploadId}`);
  assert.equal(coverRequest.headers['x-entity-name'], videoRequest.headers['x-entity-name']);
  assert.equal(videoRequest.headers.cookie.includes('sessionid=session-test'), true);
  assert.equal(videoRequest.headers.cookie.includes('foreign-test'), false);
  assert.equal('content-type' in videoRequest.headers, false);
  assert.equal('x-entity-type' in videoRequest.headers, false);
  assert.deepEqual(videoParams, {
    'client-passthrough': '1', is_clips_video: '1', for_album: false, is_sidecar: '0', media_type: 2,
    upload_id: uploadId, upload_media_duration_ms: 33139, upload_media_height: 1920,
    upload_media_width: 1080, video_format: '', video_transform: null,
  });
  assert.equal(coverRequest.headers['content-type'], 'image/jpeg');
  assert.equal(coverRequest.headers['x-entity-type'], 'image/jpeg');
  assert.deepEqual(coverParams, { media_type: 2, upload_id: uploadId,
    upload_media_height: 1920, upload_media_width: 1080 });
});

test('Reel upload keeps current static-module guards and does not fall back to an unobserved source branch', () => {
  const context = fakeUploadContext('https://i.instagram.com/rupload_igvideo/ is_sidecar:y?"1":"0" for_album:v===');
  assert.throws(() => buildInstagramUploadEnvelope(context, { mediaType: 'video', mimeType: 'video/mp4',
    durationMs: 1000, width: 1080, height: 1920 }, '17802411234567890', { reelVideo: true }),
  { code: 'INSTAGRAM_UPLOAD_CONTRACT_CHANGED' });
});

test('existing photo and carousel upload/configure contracts remain unchanged', () => {
  const context = fakeUploadContext();
  const photo = { mediaType: 'photo', mimeType: 'image/jpeg', buffer: jpegBytes(), byteLength: jpegBytes().length,
    width: 1080, height: 1350 };
  const photoRequest = buildInstagramUploadEnvelope(context, photo, '17802411234567890');
  assert.equal(photoRequest.url, 'https://i.instagram.com/rupload_igphoto/fb_uploader_17802411234567890');
  assert.equal(photoRequest.headers['content-type'], 'image/jpeg');
  assert.equal(photoRequest.headers['x-entity-type'], 'image/jpeg');
  assert.deepEqual(JSON.parse(photoRequest.headers['x-instagram-rupload-params']), {
    media_type: '1', upload_id: '17802411234567890', upload_media_height: 1350, upload_media_width: 1080,
  });

  assert.deepEqual(buildInstagramSidecarConfigureBody({ uploadIds: ['17802411234567890', '17802411234567891'], caption,
    userTagsByMedia: [[], []], disableComments: false, clientSidecarId: '17802411234567892', genAiSelfDisclosure: true }), {
    archive_only: false, caption, children_metadata: [{ upload_id: '17802411234567890' }, { upload_id: '17802411234567891' }],
    client_sidecar_id: '17802411234567892', disable_comments: '0', gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW',
    is_gen_ai_self_disclosure: true, is_open_to_public_submission: false, like_and_view_counts_disabled: 0,
    media_share_flow: 'creation_flow', share_to_facebook: '', share_to_fb_destination_type: 'USER', source_type: 'library',
  });
  assert.throws(() => buildInstagramSidecarConfigureBody({ uploadIds: ['17802411234567890', '17802411234567891'],
    caption, userTagsByMedia: [[{ userId: '10', position: [0.5, 0.5] }], []], disableComments: false,
    clientSidecarId: '17802411234567892' }), { code: 'INSTAGRAM_SIDECAR_TAG_CONTRACT_UNVERIFIED' });
  assert.deepEqual(JSON.parse(buildInstagramUploadEnvelope(context, photo, '17802411234567890', { isSidecar: true })
    .headers['x-instagram-rupload-params']), {
    media_type: 1, upload_id: '17802411234567890', upload_media_height: 1350, upload_media_width: 1080,
  });
});

test('Reel requires a validated JPEG cover before any publish session or write path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-reel-cover-'));
  const videoPath = path.join(root, 'reel.mp4');
  const jpegPath = path.join(root, 'cover.jpg');
  const pngPath = path.join(root, 'cover.png');
  await fs.writeFile(videoPath, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]));
  await fs.writeFile(jpegPath, jpegBytes());
  await fs.writeFile(pngPath, pngBytes());
  try {
    const valid = await inspectInstagramMedia({ filePath: videoPath,
      videoMetadata: { width: 1080, height: 1920, durationMs: 33139 }, coverFilePath: jpegPath });
    assert.equal(valid.cover.mimeType, 'image/jpeg');
    assert.equal(valid.cover.sha256, hash(jpegBytes()));
    assert.equal(Object.hasOwn(valid.cover, 'filePath'), false);
    await assert.rejects(() => inspectInstagramMedia({ filePath: videoPath,
      videoMetadata: { width: 1080, height: 1920, durationMs: 33139 } }), { code: 'INSTAGRAM_REEL_COVER_REQUIRED' });
    await assert.rejects(() => inspectInstagramMedia({ filePath: videoPath,
      videoMetadata: { width: 1080, height: 1920, durationMs: 33139 }, coverFilePath: pngPath }),
    { code: 'INSTAGRAM_REEL_COVER_JPEG_REQUIRED' });
    await assert.rejects(() => publishInstagramMedia({ filePath: videoPath,
      videoMetadata: { width: 1080, height: 1920, durationMs: 33139 } }),
    { code: 'INSTAGRAM_REEL_COVER_REQUIRED' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Reel media-only upload sends observed video and JPEG cover requests and stops before configure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-reel-media-only-'));
  const videoPath = path.join(root, 'reel.mp4');
  const coverPath = path.join(root, 'cover.jpg');
  const journalRoot = path.join(root, 'journal');
  const video = Buffer.alloc(32);
  video.write('ftyp', 4, 'ascii');
  await fs.writeFile(videoPath, video);
  await fs.writeFile(coverPath, jpegBytes());
  const context = fakeUploadContext();
  context.service = 'instagram';
  context.handle = owner;
  context.bundle.owner = owner;
  const requests = [];
  context.fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };
  try {
    const result = await uploadInstagramReelMediaOnly({ filePath: videoPath,
      videoMetadata: { width: 1080, height: 1920, durationMs: 33_140 }, coverFilePath: coverPath }, {
      loadSession: () => ({ owner }), readProfile: async ({ handle }) => ({ profile: { username: handle } }),
      contextLoader: async () => context, withSessionLock: async (_service, action) => action(),
      rotateCookies: async () => {}, journalRoot,
    });
    assert.equal(result.state, 'uploaded_no_post');
    assert.equal(result.ownerVerified, true);
    assert.equal(result.browserUsed, false);
    assert.equal(result.writesSent, 2);
    assert.equal(result.postRequestsSent, 0);
    assert.deepEqual(result.uploadHttpStatuses, [200, 200]);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /rupload_igvideo\/fb_uploader_/);
    assert.match(requests[1].url, /rupload_igphoto\/fb_uploader_/);
    assert.equal(requests[1].url.replace('rupload_igphoto', 'rupload_igvideo'), requests[0].url);
    const uploadId = requests[0].url.split('/').at(-1).replace('fb_uploader_', '');
    assert.deepEqual(JSON.parse(requests[0].init.headers['x-instagram-rupload-params']), {
      'client-passthrough': '1', is_clips_video: '1', for_album: false, is_sidecar: '0', media_type: 2,
      upload_id: uploadId, upload_media_duration_ms: 33140,
      upload_media_height: 1920, upload_media_width: 1080, video_format: '', video_transform: null,
    });
    assert.equal(requests[1].init.headers['content-type'], 'image/jpeg');
    const saved = JSON.parse(await fs.readFile(result.journal, 'utf8'));
    assert.equal(saved.state, 'uploaded_no_post');
    assert.equal(saved.postRequestsSent, 0);
    assert.equal(JSON.stringify(saved).includes(uploadId), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Reel configure fields match captured native form values and AI disclosure is opt-in', () => {
  const reel = buildInstagramConfigureBody({ uploadId: '17802411234567890', caption, reel: true,
    disableComments: false, genAiSelfDisclosure: true });
  assert.deepEqual(reel, {
    archive_only: 'false', caption, clips_share_preview_to_feed: '1', disable_comments: '0',
    disable_oa_reuse: 'false', gen_ai_detection_method: 'SELF_DISCLOSURE_FLOW',
    is_gen_ai_self_disclosure: 'true', igtv_share_preview_to_feed: '1', is_unified_video: '1',
    like_and_view_counts_disabled: '0', media_share_flow: 'creation_flow', share_to_facebook: '',
    share_to_fb_destination_type: 'USER', source_type: 'library', upload_id: '17802411234567890',
    video_subtitles_enabled: '0', usertags: null,
  });
  const withoutDisclosure = buildInstagramConfigureBody({ uploadId: '123', caption, reel: true });
  assert.equal(Object.hasOwn(withoutDisclosure, 'is_gen_ai_self_disclosure'), false);
  assert.equal(Object.hasOwn(withoutDisclosure, 'gen_ai_detection_method'), false);
  assert.throws(() => buildInstagramConfigureBody({ uploadId: '123', caption, genAiSelfDisclosure: true }),
    { code: 'INSTAGRAM_GEN_AI_DISCLOSURE_NOT_APPLICABLE' });
});

async function withJournal(record, operation) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instagram-publisher-reconcile-'));
  const expectedRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(root).startsWith(expectedRoot), 'temporary journal must stay under the OS temp directory');
  const file = path.join(root, `${record.payloadHash}.json`);
  await fs.writeFile(file, JSON.stringify(record));
  try { return await operation({ root, file }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function journalRecord(media, { payloadHash = 'a'.repeat(64), state = 'needs_reconciliation', writesSent = 2,
  mediaId = null, shortcode = null, verified = false } = {}) {
  return {
    schemaVersion: 1,
    service: 'instagram',
    owner,
    payloadHash,
    ...buildInstagramReadbackExpectation(media, caption),
    media: media.map(({ mediaType, sha256, byteLength, width, height, durationMs }) => ({
      mediaType, sha256, byteLength, width, height, durationMs,
    })),
    state,
    writesSent,
    readbackVerified: verified,
    ...(mediaId ? { mediaId } : {}),
    ...(shortcode ? { shortcode } : {}),
    ...(verified ? { publicUrl: `https://www.instagram.com/p/${shortcode}/`, readbackDetails: {
      captionSha256: hash(caption), captionMatched: true, mediaMatched: true,
      mediaType: 8, productType: 'carousel_container', carouselCount: media.length,
    } } : {}),
  };
}

function sidecarJournalRecord(media, { captionText = caption } = {}) {
  const payloadHash = hash(JSON.stringify({ owner, media: media.map(item => ({ mediaType: item.mediaType,
    fileSha256: item.sha256, userTags: [] })), caption: captionText, disableComments: false }));
  const record = journalRecord(media, { payloadHash, state: 'needs_reconciliation', writesSent: media.length + 1 });
  record.failureCode = 'INSTAGRAM_PUBLISH_HTTP_500';
  record.configureBodySha256 = 'c'.repeat(64);
  record.configureStartedAt = '2026-09-28T00:00:00.000Z';
  record.uploadIds = media.map((_, index) => String(17802411234567890n + BigInt(index)));
  record.uploadEntityNames = record.uploadIds.map(id => 'fb_uploader_' + id);
  record.configureAttemptCount = 1;
  return record;
}

test('reconciles an uncertain carousel from owner posts without resending and records verified fields only', async () => {
  const media = photoItems(5);
  const record = journalRecord(media);
  await withJournal(record, async ({ root, file }) => {
    let reads = 0;
    const result = await reconcileInstagramPublish({ payloadHash: record.payloadHash, journalRoot: root,
      loadSession: () => ({ owner }), readPosts: async input => {
        reads++;
        assert.deepEqual(input, { handle: owner, limit: 12, after: null });
        return { posts: [mediaPost(media)], pagination: { hasNextPage: false, nextCursor: null } };
      } });
    assert.equal(reads, 1);
    assert.equal(result.state, 'published_readback_verified');
    assert.equal(result.receipt.readbackVerified, true);
    assert.equal(result.receipt.captionMatched, true);
    assert.equal(result.receipt.mediaMatched, true);
    assert.equal(result.post.carouselCount, 5);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.writesSent, 2);
    assert.equal(saved.expectedCaptionSha256, hash(caption));
    assert.equal(saved.readbackDetails.captionSha256, hash(caption));
    assert.equal(await fs.readFile(file, 'utf8').then(text => text.includes(caption)), false);
  });
});

test('reconciliation follows owner pagination when a pending result has no returned id', async () => {
  const media = reelItems();
  const record = journalRecord(media);
  await withJournal(record, async ({ root }) => {
    const calls = [];
    const result = await reconcileInstagramPublish({ payloadHash: record.payloadHash, journalRoot: root,
      loadSession: () => ({ owner }), readPosts: async input => {
        calls.push(input.after);
        if (!input.after) return { posts: [], pagination: { hasNextPage: true, nextCursor: 'cursor-1' } };
        return { posts: [mediaPost(media)], pagination: { hasNextPage: false, nextCursor: null } };
      } });
    assert.deepEqual(calls, [null, 'cursor-1']);
    assert.equal(result.state, 'published_readback_verified');
    assert.equal(result.post.productType, 'clips');
  });
});

test('a caption or media-shape mismatch remains unresolved and never increments writes', async () => {
  const media = photoItems(5);
  const record = journalRecord(media, { mediaId: '12345', shortcode: 'AbC123' });
  await withJournal(record, async ({ root, file }) => {
    const result = await reconcileInstagramPublish({ payloadHash: record.payloadHash, journalRoot: root,
      loadSession: () => ({ owner }), readPosts: async () => ({ posts: [
        post({ id: '12345', shortcode: 'AbC123', text: caption + '!', mediaType: 8,
          productType: 'carousel_container', carouselCount: 5 }),
      ], pagination: { hasNextPage: false, nextCursor: null } }) });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(result.state, 'needs_reconciliation');
    assert.equal(result.receipt.readbackVerified, false);
    assert.equal(saved.writesSent, 2);
    assert.equal(saved.lastReconciliation.status, 'mismatch');
  });
});

test('readback reports caption true and media false as separate facts', async () => {
  const media = photoItems(5);
  const record = journalRecord(media, { mediaId: '12345', shortcode: 'AbC123' });
  await withJournal(record, async ({ root }) => {
    const result = await reconcileInstagramPublish({ payloadHash: record.payloadHash, journalRoot: root,
      loadSession: () => ({ owner }), readPosts: async () => ({ posts: [
        post({ id: '12345', shortcode: 'AbC123', text: caption, mediaType: 2,
          productType: 'clips', carouselCount: 0 }),
      ], pagination: { hasNextPage: false, nextCursor: null } }) });
    assert.equal(result.state, 'needs_reconciliation');
    assert.equal(result.receipt.captionMatched, true);
    assert.equal(result.receipt.mediaMatched, false);
    assert.equal(result.lastReconciliation.observed.captionMatched, true);
    assert.equal(result.lastReconciliation.observed.mediaMatched, false);
  });
});

test('sidecar recovery requires a complete fresh owner scan, reuses uploads, and sends one captured JSON configure', async () => {
  const media = photoItems(5);
  const record = sidecarJournalRecord(media);
  const originalUploadIds = [...record.uploadIds];
  const originalConfigureHash = record.configureBodySha256;
  const originalConfigureStartedAt = record.configureStartedAt;
  const configureRequests = [];
  let reads = 0;
  const context = fakeSidecarContext(async (url, init) => {
    configureRequests.push({ url, headers: init.headers, body: init.body });
    const payload = JSON.stringify({ status: 'ok', media: { pk: '900001', code: 'NewCarousel' } });
    return { status: 200, url, headers: { getSetCookie: () => [] }, body: Readable.from([Buffer.from(payload)]) };
  });

  await withJournal(record, async ({ root, file }) => {
    const result = await resumeInstagramSidecarConfigure({ payloadHash: record.payloadHash, caption,
      disableComments: false, genAiSelfDisclosure: false }, {
      journalRoot: root,
      loadSession: () => ({ owner }),
      readPosts: async input => {
        reads++;
        assert.equal(input.handle, owner);
        assert.equal(input.limit, 12);
        assert.equal(input.after, null);
        if (reads === 1) {
          return { posts: [post({ id: '800001', shortcode: 'PriorReel', text: caption, mediaType: 2,
            productType: 'clips', carouselCount: 0 })], pagination: { hasNextPage: false, nextCursor: null } };
        }
        return { posts: [post({ id: '900001', shortcode: 'NewCarousel', text: caption, mediaType: 8,
          productType: 'carousel_container', carouselCount: 5 })],
        pagination: { hasNextPage: false, nextCursor: null } };
      },
      withLock: (_service, operation) => operation(),
      openContext: async () => context,
    });

    assert.equal(result.state, 'published_readback_verified');
    assert.equal(result.operation, 'resume_configure');
    assert.equal(result.configureSent, true);
    assert.equal(reads, 2);
    assert.equal(configureRequests.length, 1);
    const request = configureRequests[0];
    assert.equal(request.url, 'https://www.instagram.com/api/v1/media/configure_sidecar/');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.cookie.includes('sessionid=session-test'), true);
    assert.equal(request.headers.cookie.includes('foreign-test'), false);
    const body = JSON.parse(request.body);
    assert.deepEqual(body.children_metadata, originalUploadIds.map(upload_id => ({ upload_id })));
    assert.equal(body.caption, caption);
    assert.equal(body.source_type, 'library');
    assert.equal(body.disable_comments, '0');
    assert.equal(body.fb_dtsg, freshDtsg);
    assert.equal(body.jazoest, '2' + [...freshDtsg].reduce((sum, character) => sum + character.charCodeAt(0), 0));
    assert.equal(typeof body.jazoest, 'string');
    assert.equal(Object.hasOwn(body, 'gen_ai_detection_method'), false);
    assert.equal(Object.hasOwn(body, 'is_gen_ai_self_disclosure'), false);

    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.writesSent, media.length + 2);
    assert.deepEqual(saved.uploadIds, originalUploadIds);
    assert.equal(saved.configureAttemptCount, 2);
    assert.equal(saved.configureBodySha256, originalConfigureHash);
    assert.equal(saved.configureStartedAt, originalConfigureStartedAt);
    assert.equal(saved.clientSidecarId, undefined);
    assert.equal(saved.resumeConfigurePreflight.originalClientSidecarId, 'not_recorded');
    assert.equal(saved.resumeConfigurePreflight.recoveryUsesNewClientSidecarId, true);
    assert.equal(saved.resumeConfigurePreflight.captionCandidateCount, 1);
    assert.equal(saved.firstConfigureFailureCode, 'INSTAGRAM_PUBLISH_HTTP_500');
    assert.equal(saved.genAiSelfDisclosure, false);
    assert.equal(saved.disableComments, false);
    assert.equal(saved.lastReconciliation.status, 'verified');
    await assert.rejects(() => resumeInstagramSidecarConfigure({ payloadHash: record.payloadHash, caption,
      disableComments: false, genAiSelfDisclosure: false }, {
      journalRoot: root,
      loadSession: () => ({ owner }),
      readPosts: async () => { throw new Error('a second resume must stop before another feed read'); },
      openContext: async () => { throw new Error('a second resume must never load a write context'); },
      sendConfigure: async () => { configureRequests.push({ unexpected: true }); },
    }), { code: 'INSTAGRAM_SIDECAR_RESUME_PRECONDITION_FAILED' });
    assert.equal(configureRequests.length, 1);
  });
});

test('sidecar recovery never configures when the complete owner scan cannot be proven', async () => {
  const media = photoItems(5);
  const record = sidecarJournalRecord(media);
  let configureCalls = 0;
  let reads = 0;
  await withJournal(record, async ({ root, file }) => {
    const result = await resumeInstagramSidecarConfigure({ payloadHash: record.payloadHash, caption,
      disableComments: false, genAiSelfDisclosure: false }, {
      journalRoot: root,
      loadSession: () => ({ owner }),
      readPosts: async input => {
        reads++;
        assert.equal(input.after, reads === 1 ? null : `cursor-${reads - 1}`);
        return { posts: [], pagination: { hasNextPage: true, nextCursor: `cursor-${reads}` } };
      },
      openContext: async () => { throw new Error('must not load a write context before a complete scan'); },
      sendConfigure: async () => { configureCalls++; },
    });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(reads, 20);
    assert.equal(configureCalls, 0);
    assert.equal(result.configureSent, false);
    assert.equal(result.lastReconciliation.status, 'scan_incomplete');
    assert.equal(saved.writesSent, media.length + 1);
    assert.deepEqual(saved.uploadIds, record.uploadIds);
  });
});

test('per-journal recovery lock allows only one concurrent configure attempt', async () => {
  const media = photoItems(5);
  const record = sidecarJournalRecord(media);
  let finishFirstScan;
  let firstScanStarted;
  const started = new Promise(resolve => { firstScanStarted = resolve; });
  const gate = new Promise(resolve => { finishFirstScan = resolve; });
  let reads = 0;
  let configureCalls = 0;
  const context = fakeSidecarContext(async (url) => {
    configureCalls++;
    return { status: 200, url, headers: { getSetCookie: () => [] },
      body: Readable.from([Buffer.from(JSON.stringify({ status: 'ok', media: { pk: '900002', code: 'LockedCarousel' } }))]) };
  });

  await withJournal(record, async ({ root }) => {
    const dependencies = {
      journalRoot: root,
      loadSession: () => ({ owner }),
      readPosts: async () => {
        reads++;
        if (reads === 1) {
          firstScanStarted();
          await gate;
          return { posts: [], pagination: { hasNextPage: false, nextCursor: null } };
        }
        return { posts: [post({ id: '900002', shortcode: 'LockedCarousel', mediaType: 8,
          productType: 'carousel_container', carouselCount: 5 })],
        pagination: { hasNextPage: false, nextCursor: null } };
      },
      withLock: (_service, operation) => operation(),
      openContext: async () => context,
    };
    const first = resumeInstagramSidecarConfigure({ payloadHash: record.payloadHash, caption,
      disableComments: false, genAiSelfDisclosure: false }, dependencies);
    await started;
    await assert.rejects(() => resumeInstagramSidecarConfigure({ payloadHash: record.payloadHash, caption,
      disableComments: false, genAiSelfDisclosure: false }, dependencies), { code: 'INSTAGRAM_RESUME_LOCK_BUSY' });
    finishFirstScan();
    const result = await first;
    assert.equal(result.state, 'published_readback_verified');
    assert.equal(configureCalls, 1);
    assert.equal(reads, 2);
  });
});

test('a later owner-read error preserves an already verified receipt', async () => {
  const media = photoItems(5);
  const record = journalRecord(media, { state: 'published_readback_verified', verified: true, shortcode: 'Known123' });
  await withJournal(record, async ({ root, file }) => {
    const result = await reconcileInstagramPublish({ payloadHash: record.payloadHash, journalRoot: root,
      loadSession: () => ({ owner }), readPosts: async () => { throw Object.assign(new Error(), { code: 'META_INTERACTION_REQUIRED' }); } });
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(result.state, 'published_readback_verified');
    assert.equal(result.receipt.readbackVerified, true);
    assert.equal(result.receipt.freshReadback, false);
    assert.equal(saved.publicUrl, record.publicUrl);
    assert.equal(saved.readbackVerified, true);
    assert.equal(saved.lastReconciliation.failureCode, 'META_INTERACTION_REQUIRED');
    assert.equal(saved.lastReconciliation.previousReceiptPreserved, true);
  });
});

test('reconciliation rejects invalid journal ids and refuses to inspect a foreign owner journal', async () => {
  await assert.rejects(() => reconcileInstagramPublish({ payloadHash: '../escape' }), { code: 'INSTAGRAM_RECONCILE_ID_INVALID' });
  const record = journalRecord(photoItems());
  await withJournal(record, async ({ root }) => {
    let reads = 0;
    await assert.rejects(() => reconcileInstagramPublish({ payloadHash: record.payloadHash, journalRoot: root,
      loadSession: () => ({ owner: 'another_owner' }), readPosts: async () => { reads++; return { posts: [] }; } }),
    { code: 'META_OWNER_MISMATCH' });
    assert.equal(reads, 0);
  });
});

test('CLI documents reconciliation as owner readback without a publish resend', () => {
  const cli = fileURLToPath(new URL('../instagram-content-cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /reconcile \(owner readback only; no publish resend\)/);
});
