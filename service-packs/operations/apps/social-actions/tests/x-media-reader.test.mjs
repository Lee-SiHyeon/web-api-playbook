import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeXMedia } from '../../naver-blog-api/research/content-store/x-xhr.mjs';
import { selectXMediaAsset, identifyXMediaBytes, downloadXMedia, readXMedia } from '../x-media-reader.mjs';

const video = decodeXMedia({ extended_entities: { media: [{ id_str: '1234567890123456789', type: 'video', media_url_https: 'https://pbs.twimg.com/media/thumb.jpg',
  original_info: { width: 1080, height: 1920 }, ext_alt_text: 'caption', video_info: { duration_millis: 5300, aspect_ratio: [9, 16], variants: [
    { url: 'https://video.twimg.com/clip/low.mp4', content_type: 'video/mp4', bitrate: 800000 },
    { url: 'https://video.twimg.com/clip/high.mp4', content_type: 'video/mp4', bitrate: 2200000 },
    { url: 'https://video.twimg.com/clip/list.m3u8', content_type: 'application/x-mpegURL' },
    { url: 'https://evil.example/high.mp4', content_type: 'video/mp4', bitrate: 9999999 },
  ] } }] } })[0];
test('video dimensions, duration, alt text and MP4/HLS variants are decoded without foreign URLs', () => {
  assert.equal(video.id, '1234567890123456789'); assert.equal(video.durationMs, 5300);
  assert.deepEqual(video.aspectRatio, [9, 16]); assert.equal(video.variants.length, 3);
  assert.equal(selectXMediaAsset(video).url, 'https://video.twimg.com/clip/high.mp4');
  const photo = decodeXMedia({ entities: { media: [{ type: 'photo', id_str: '123', media_url_https: 'https://pbs.twimg.com/media/image.png' }] } })[0];
  assert.equal(selectXMediaAsset(photo).kind, 'image'); assert.equal(photo.durationMs, null);
});
test('download rejects login HTML masquerading as an image and HLS-only videos remain unsupported', () => {
  assert.throws(() => identifyXMediaBytes(Buffer.from('<html>login</html>'), 'image/jpeg'), { code: 'X_MEDIA_DOWNLOAD_FORMAT' });
  assert.throws(() => selectXMediaAsset({ type: 'video', variants: [{ url: 'https://video.twimg.com/list.m3u8', contentType: 'application/x-mpegURL' }] }), { code: 'X_MEDIA_DOWNLOAD_VARIANT_UNAVAILABLE' });
});
test('download verifies MIME plus file signature, and sends no account credentials', async () => {
  const jpg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);
  const result = await downloadXMedia({ type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg' }, { fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'manual'); assert.deepEqual(Object.keys(init.headers), ['accept']);
    return new Response(jpg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  } });
  assert.equal(result.extension, 'jpg'); assert.equal(result.receipt.magicVerified, true);
  assert.equal(result.receipt.live_replay, false); assert.equal(result.receipt.accountCredentialsSent, false);
});
test('unsafe URL, redirects and oversize bodies fail without a credential-bearing request', async () => {
  let calls = 0;
  await assert.rejects(downloadXMedia({ type: 'photo', url: 'https://pbs.twimg.com@evil.example/test.jpg' }, { fetchImpl: async () => { calls++; } }), { code: 'X_MEDIA_DOWNLOAD_SCOPE' });
  assert.equal(calls, 0);
  await assert.rejects(downloadXMedia({ type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg' }, { fetchImpl: async () => new Response(null, { status: 302 }) }), { code: 'X_MEDIA_DOWNLOAD_HTTP_302' });
  await assert.rejects(downloadXMedia({ type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg' }, { maxBytes: 1024,
    fetchImpl: async () => new Response(Buffer.alloc(2048), { headers: { 'content-type': 'image/jpeg' } }) }), { code: 'X_MEDIA_DOWNLOAD_LIMIT' });
});
test('protected profile blocks the media query before another user timeline can be read', async () => {
  let sends = 0;
  await assert.rejects(readXMedia('publicname', { withContext: async callback => callback({ ownerHandle: 'lifehack__ailab',
    lookupUser: async () => ({ userId: '1234', protected: true }), request: async () => { sends++; } }) }), { code: 'X_MEDIA_PRIVATE_PROFILE' });
  assert.equal(sends, 0);
});
