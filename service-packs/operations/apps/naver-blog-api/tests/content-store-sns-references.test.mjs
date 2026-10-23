import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCount, parseYoutubeSubscribers, mergeDiscovery, measure } from '../research/content-store/sns-references.mjs';

test('counts in Korean and English units', () => {
  assert.equal(parseCount('74.8만명'), 748000);
  assert.equal(parseCount('약 1.2M followers (2026-08, Social Blade)'), 1200000);
  assert.equal(parseCount('12,345'), 12345);
  assert.equal(parseCount('3천'), 3000);
  assert.equal(parseCount(null), null);
  // A featured channel's count appears before the header on some pages (observed on @panibottle: 32.6만 vs 261만).
  assert.equal(parseYoutubeSubscribers('{"config":{"pageHeaderViewModel":{}}}' + ' '.repeat(9000) + '{"featured":"구독자 32.6만명"} {"pageHeaderViewModel":{"metadataParts":[{"text":{"content":"구독자 261만명"}}]}}'), 2610000);
  assert.equal(parseYoutubeSubscribers('<span>구독자 74.8만명</span>'), null, 'no header, no guess');
});

test('discovery files merge by platform and handle, keeping every evidence URL', () => {
  const a = { platform: 'youtube', handle: '@JoCoding', profile_url: 'https://www.youtube.com/@jocoding', display_name: '조코딩', field: 'ai', why_referenced: 'x', evidence_urls: ['https://news/1'], follower_hint: null, language: 'ko' };
  const merged = mergeDiscovery([{ accounts: [a] }, { accounts: [{ ...a, handle: 'jocoding', evidence_urls: ['https://news/2'], follower_hint: '70만' }] }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].evidenceUrls, ['https://news/1', 'https://news/2']);
  assert.equal(merged[0].followerHint, '70만');
});

test('YouTube is measured; other platforms keep the reported count and are never fetched', async () => {
  const calls = [];
  const fetchImpl = async url => { calls.push(url); return new Response('{"pageHeaderViewModel":{"content":"구독자 74.8만명"}}'); };
  const r = await measure([
    { platform: 'youtube', handle: 'jocoding', url: 'https://www.youtube.com/@jocoding', followerHint: '70만' },
    { platform: 'instagram', handle: 'a', url: 'https://www.instagram.com/a/', followerHint: '12만 팔로워' },
    { platform: 'tiktok', handle: 'b', url: 'https://www.tiktok.com/@b', followerHint: null }], { fetchImpl, delayMs: 0 });
  assert.deepEqual(calls, ['https://www.youtube.com/@jocoding']);
  assert.deepEqual(r.accounts.map(a => [a.handle, a.followers, a.followersSource]), [['jocoding', 748000, 'measured'], ['a', 120000, 'reported'], ['b', null, null]]);
  assert.deepEqual(r.coverage, { accounts: 3, droppedSmall: 0, measured: 1, reported: 1 });
  const small = await measure([{ platform: 'x', handle: 's', url: 'u', followerHint: '900' }, { platform: 'x', handle: 'n', url: 'u2', followerHint: null }], { fetchImpl, delayMs: 0, minFollowers: 1000 });
  assert.deepEqual(small.accounts.map(a => a.handle), ['n'], 'known below the floor is dropped, unknown stays');
  assert.deepEqual(small.droppedSmall, [{ platform: 'x', handle: 's', followers: 900 }]);
});
