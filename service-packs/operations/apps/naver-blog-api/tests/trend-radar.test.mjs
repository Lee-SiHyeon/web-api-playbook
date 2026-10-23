import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseShoppingRankResponse,
  SHOPPING_CATEGORIES,
} from '../research/trend-radar/sources/naver-shopping-insight.mjs';
import { parseJsonp } from '../research/trend-radar/sources/naver-autocomplete.mjs';
import { parseApproxTraffic, parseGoogleTrendsRss } from '../research/trend-radar/sources/google-trends-rss.mjs';
import {
  scoreRankSeries,
  scoreShoppingTrends,
  classifyAutocomplete,
  buildLongTailOpportunities,
} from '../research/trend-radar/scoring.mjs';

test('shopping insight parser validates application schema without retaining values outside ranks', () => {
  const parsed = parseShoppingRankResponse(JSON.stringify([
    { statusCode: 200, returnCode: 0, date: '2026/09/18', datetime: 'day1', range: '', ranks: [
      { rank: 1, keyword: '보조배터리', linkId: 'secret-not-needed' },
      { rank: 2, keyword: '충전기', linkId: 'secret-not-needed' },
    ] },
  ]), { categoryId: '50000003', categoryName: '디지털/가전', timeUnit: 'date' });
  assert.equal(parsed.periods[0].ranks[0].keyword, '보조배터리');
  assert.equal('linkId' in parsed.periods[0].ranks[0], false);
  assert.throws(() => parseShoppingRankResponse('<html>blocked</html>', {
    categoryId: '50000003', categoryName: '디지털/가전', timeUnit: 'date',
  }), { code: 'APPLICATION_HTML' });
});

test('autocomplete JSONP parser requires the exact callback', () => {
  const parsed = parseJsonp('cb({"items":[[["보조배터리 추천","0"]]]})', 'cb');
  assert.equal(parsed.items[0][0][0], '보조배터리 추천');
  assert.throws(() => parseJsonp('other({})', 'cb'), { code: 'SCHEMA' });
});

test('Google Trends RSS parser extracts traffic and news without HTML execution', () => {
  const xml = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item>
    <title>축의금</title><ht:approx_traffic>5K+</ht:approx_traffic><pubDate>today</pubDate>
    <ht:news_item><ht:news_item_title>sample &amp; news</ht:news_item_title><ht:news_item_url>https://example.test/a</ht:news_item_url><ht:news_item_source>source</ht:news_item_source></ht:news_item>
  </item></channel></rss>`;
  const parsed = parseGoogleTrendsRss(xml);
  assert.equal(parsed[0].keyword, '축의금');
  assert.equal(parsed[0].approxTraffic, 5000);
  assert.equal(parsed[0].news[0].title, 'sample & news');
  assert.equal(parseApproxTraffic('100+'), 100);
});

test('rank scoring rewards persistence and recent improvement', () => {
  const periods = [
    { ranks: [] },
    { ranks: [{ rank: 9, keyword: '보조배터리' }] },
    { ranks: [{ rank: 5, keyword: '보조배터리' }] },
    { ranks: [{ rank: 2, keyword: '보조배터리' }] },
  ];
  const score = scoreRankSeries(periods, '보조배터리');
  assert.equal(score.momentum > 0, true);
  assert.equal(score.score > 40, true);
  assert.equal(score.latestRank, 2);
});

test('shopping aggregation and autocomplete produce explainable opportunities', () => {
  const collection = { results: [
    { categoryId: '50000003', categoryName: '디지털/가전', timeUnit: 'date', periods: [
      { ranks: [{ rank: 2, keyword: '보조배터리' }] },
      { ranks: [{ rank: 1, keyword: '보조배터리' }] },
    ] },
  ] };
  const shopping = scoreShoppingTrends(collection);
  const autocomplete = { results: [{ seed: '보조배터리', suggestions: [
    { rank: 1, keyword: '보조배터리 추천' },
    { rank: 2, keyword: '보조배터리 기내반입' },
  ] }] };
  const tails = buildLongTailOpportunities(autocomplete, shopping, { explicitSeeds: ['보조배터리'] });
  assert.equal(tails[0].opportunityScore > 0, true);
  assert.ok(tails.some(item => item.buyerIntent));
  assert.ok(tails.some(item => item.problemIntent));
  assert.equal(classifyAutocomplete('보조배터리 추천', '보조배터리', 1).buyerIntent, true);
  assert.equal(classifyAutocomplete('안전화', '안전화', 1).problemIntent, false);
});

test('fashion autocomplete rejects anime semantic drift for the ambiguous word 원피스', () => {
  const shopping = [{
    keyword: '원피스', score: 80,
    categories: [{ id: '50000000', name: '패션의류', score: 80 }],
  }];
  const autocomplete = { results: [{ seed: '원피스', suggestions: [
    { rank: 1, keyword: '원피스 여름 롱' },
    { rank: 2, keyword: '원피스 애니 840화' },
  ] }] };
  const tails = buildLongTailOpportunities(autocomplete, shopping);
  assert.equal(tails.find(item => item.keyword.includes('애니')).semanticDrift, true);
  assert.equal(tails.find(item => item.keyword.includes('여름')).semanticDrift, false);
});

test('normal trend radar implementation contains no browser automation imports', async () => {
  const files = [
    '../research/trend-radar/run.mjs',
    '../research/trend-radar/sources/naver-shopping-insight.mjs',
    '../research/trend-radar/sources/naver-autocomplete.mjs',
    '../research/trend-radar/sources/google-trends-rss.mjs',
    '../research/trend-radar/sources/naver-search-trend.mjs',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /playwright|connectOverCDP|chromium\.launch|DevToolsActivePort/);
  }
  assert.equal(SHOPPING_CATEGORIES.length, 12);
});

test('Exploding Topics tiles become keyword, volume and growth; Pro tiles are skipped', async () => {
  const { parseExplodingTopics, parseVolume } = await import('../research/trend-radar/sources/exploding-topics.mjs');
  const tile = (slug, kw, vol, growth, desc) => `<div class="tileStyle cardHover"><a class="tileLink" href="/topic/${slug}"><div class="tileKeyword">${kw}</div>`
    + `<div class="scoreTag scoreTag--volume"><div class="scoreTagTop">${vol}</div><div class="scoreTagBottom">Volume</div></div>`
    + `<div class="scoreTag last"><div class="scoreTagTop growth scoreTagGradient">${growth}</div></div><div class="tileDescription">${desc}</div></a></div>`;
  const html = tile('pdrn-serum-nLoLq6tz', 'Pdrn  serum', '110K', '+6000%', 'Skincare with PDRN.')
    + '<div class="tileStyle cardHover"><a class="tileLink" href="/pricing"><div>Pro</div></a></div>'
    + tile('glp1', 'GLP1', '1.5M', '+900%', 'Weight-loss drugs &amp; peptides.') + tile('mitti-labs', 'Mitti labs', '0-100', '+99X+', '');
  const rows = parseExplodingTopics(html);
  assert.deepEqual(rows.map(r => [r.keyword, r.volume, r.growthPct]), [['Pdrn serum', 110000, 6000], ['GLP1', 1500000, 900], ['Mitti labs', null, null]]);
  assert.equal(rows[0].url, 'https://explodingtopics.com/topic/pdrn-serum-nLoLq6tz');
  assert.equal(rows[1].description, 'Weight-loss drugs & peptides.');
  assert.equal(parseVolume('1.83M'), 1830000);
  assert.throws(() => parseExplodingTopics('<html>Sign in</html>'), /no topic tiles/);
});
