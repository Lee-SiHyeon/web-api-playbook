import test from 'node:test';
import assert from 'node:assert/strict';
import { parseViews, parseAgeDays, parseSearch, classify, summarize } from '../research/content-store/youtube-hook-scout.mjs';
import { loadHookOntology, validateHookOntology } from '../research/content-store/hooks.mjs';

// ytInitialData shapes observed 2026-09-27 (trimmed).
const data = { contents: { list: [
  { videoRenderer: { videoId: 'aaaaaaaaaaa', title: { runs: [{ text: '레고 초보는 이거 절대 사지 마세요' }] }, viewCountText: { simpleText: '조회수 1,444,350회' },
    publishedTimeText: { simpleText: '3년 전' }, lengthText: { simpleText: '12:01' }, ownerText: { runs: [{ text: '채널' }] } } },
  { shortsLockupViewModel: { overlayMetadata: { primaryText: { content: '비싼 청소기가 필요없는 이유' }, secondaryText: { content: '조회수 421만회' } },
    onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'bbbbbbbbbbb' } } } } },
] } };
const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;

test('Korean view counts and ages', () => {
  assert.equal(parseViews('조회수 63,440회'), 63440);
  assert.equal(parseViews('421만회'), 4210000);
  assert.equal(parseViews('1.9만회'), 19000);
  assert.equal(parseViews('조회수 없음'), null);
  assert.equal(parseAgeDays('7일 전'), 7); assert.equal(parseAgeDays('2주 전'), 14); assert.equal(parseAgeDays('3개월 전'), 90);
});

test('search results: videos and Shorts with views, classified into hook patterns', () => {
  const o = loadHookOntology();
  const rows = parseSearch(html).map(v => ({ ...v, patterns: classify(v.title, o) }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].format, 'video'); assert.equal(rows[0].views, 1444350); assert.equal(rows[0].viewsPerDay, Math.round(1444350 / 1095));
  assert.equal(rows[1].format, 'short'); assert.equal(rows[1].url, 'https://www.youtube.com/shorts/bbbbbbbbbbb');
  assert.ok(rows[0].patterns.includes('negative_warning') && rows[0].patterns.includes('segment_specific'));
  assert.deepEqual(rows[1].patterns, ['curiosity_story']);
  const s = summarize(rows);
  assert.equal(s.find(r => r.format === 'short').medianViews, 4210000);
  assert.throws(() => parseSearch('<html>consent.youtube.com</html>'), /YOUTUBE_CHALLENGE/);
});

test('the ontology carries classifiers, YouTube examples and channel preferences', () => {
  const o = loadHookOntology();
  assert.deepEqual(validateHookOntology(o), []);
  assert.ok(o.hookPatterns.every(p => p.titleMatch));
  assert.ok(o.hookPatterns.some(p => p.examples.some(e => e.channel === 'youtube_shorts')));
  assert.ok(o.channelPreferences.feed.prefer.includes('curiosity_story'));
  assert.ok(o.channelPreferences.feed.avoidAsOpener.includes('price_anchor'));
});
