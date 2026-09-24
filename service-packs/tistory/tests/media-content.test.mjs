import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeImageMarkup, nativeVideoAttachmentMarkup } from '../lib/media-content.mjs';

const attachment = { name: 'cover.png', key: 'mock/folder/id', filename: 'img.png',
  url: 'https://blog.kakaocdn.net/dna/mock/folder/id/img.png?credential=mock&expires=1&allow_ip=&allow_referer=&signature=mock' };
test('image shortcode retains native caption metadata and dimensions', () => {
  const html = nativeImageMarkup(attachment, { width: 1536, height: 1024, caption: 'Caption & source' });
  assert.ok(html.includes('kage@mock/folder/id/img.png?credential=mock&amp;expires=1'));
  assert.ok(html.includes('"caption":"Caption &amp; source"'));
  assert.ok(html.includes('"originWidth":1536,"originHeight":1024,"style":"alignCenter"'));
});
test('caption escapes shortcode delimiters and HTML markup', () => {
  const html = nativeImageMarkup(attachment, { width: 1, height: 1, caption: '[##_Image|<script>"' });
  assert.ok(html.includes('&#91;##_Image&#124;&lt;script&gt;&quot;'));
  assert.equal((html.match(/\[##_Image\|/g) || []).length, 1);
});
test('off-origin and inconsistent image references are rejected', () => {
  for (const url of [attachment.url.replace('blog.kakaocdn.net', 'example.com'), attachment.url.replace('/id/', '/other/'), attachment.url + '|inject']) {
    assert.throws(() => nativeImageMarkup({ ...attachment, url }, { width: 1, height: 1 }), { code: 'TISTORY_IMAGE_REFERENCE_INVALID' });
  }
});
test('invalid dimensions are rejected', () => {
  for (const width of [0, -1, 1.5, 65536, '1536']) assert.throws(() => nativeImageMarkup(attachment, { width, height: 1 }), { code: 'TISTORY_IMAGE_METADATA_INVALID' });
});

test('MP4 attachment generates the observed File shortcode, not a player', () => {
  const video = { ...attachment, name: 'comparison.mp4', filename: 'tfile.mp4',
    url: attachment.url.replace('img.png', 'tfile.mp4'), size: 1500693 };
  const html = nativeVideoAttachmentMarkup(video);
  assert.ok(html.startsWith('<p>[##_File|kage@mock/folder/id/tfile.mp4?'));
  assert.ok(html.includes('filename="comparison.mp4" size="1.43MB" data-ke-align="alignCenter"'));
  assert.ok(!html.includes('<video'));
});

test('non-MP4 and invalid attachment sizes are rejected', () => {
  assert.throws(() => nativeVideoAttachmentMarkup({ ...attachment, size: 100 }), { code: 'TISTORY_VIDEO_ATTACHMENT_INVALID' });
  const video = { ...attachment, filename: 'tfile.mp4', url: attachment.url.replace('img.png', 'tfile.mp4') };
  for (const size of [0, -1, 1.5, 10 * 1024 * 1024 + 1]) assert.throws(() => nativeVideoAttachmentMarkup({ ...video, size }), { code: 'TISTORY_VIDEO_ATTACHMENT_INVALID' });
});
