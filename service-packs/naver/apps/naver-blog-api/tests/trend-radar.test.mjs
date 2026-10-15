import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  bootstrapAnonymousNaverSession,
  collectShoppingTrends,
  fetchShoppingRanks,
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

test('Shopping Insight anonymous bootstrap requires and forwards only the observed NNB cookie', async () => {
  let requestedUrl;
  const session = await bootstrapAnonymousNaverSession({
    fetchImpl: async url => {
      requestedUrl = new URL(url);
      return {
        status: 200,
        headers: {
          getSetCookie: () => [
            'NNB=fixture-nnb; Domain=.naver.com; Path=/; Secure',
            'BUC=fixture-buc; Domain=.naver.com; Path=/; Secure',
            'LCS=fixture-lcs; Domain=lcs.naver.com; Path=/; Secure',
          ],
          get: () => 'image/gif',
        },
        text: async () => '',
      };
    },
  });
  assert.equal(requestedUrl.origin, 'https://lcs.naver.com');
  assert.equal(requestedUrl.pathname, '/m');
  assert.equal(session.cookieHeader, 'NNB=fixture-nnb');
  assert.deepEqual(session.evidence.cookieNamesPresent, ['BUC', 'LCS', 'NNB']);
  assert.deepEqual(session.evidence.requiredCookieNames, ['NNB']);
  assert.deepEqual(session.evidence.cookieNamesSent, ['NNB']);
  assert.equal(session.evidence.bucObserved, true);
  assert.equal(session.evidence.cookieValuesPersisted, false);

  await assert.rejects(() => bootstrapAnonymousNaverSession({
    fetchImpl: async () => ({
      status: 200,
      headers: { getSetCookie: () => ['BUC=fixture-buc; Path=/'], get: () => 'image/gif' },
      text: async () => '',
    }),
  }), { code: 'SESSION_BOOTSTRAP' });
});

test('Shopping Insight rank requests require NNB, allow observed BUC for comparison, and reject extra cookie scope', async () => {
  let request;
  const result = await fetchShoppingRanks({
    categoryId: '50000003',
    categoryName: '디지털/가전',
    timeUnit: 'date',
    cookieHeader: 'NNB=fixture-nnb',
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return new Response(JSON.stringify([
        { statusCode: 200, returnCode: 0, date: '2026/10/16', datetime: 'day1', range: '',
          ranks: [{ rank: 1, keyword: 'fixture rank' }] },
      ]), { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } });
    },
  });
  assert.equal(request.url.origin, 'https://datalab.naver.com');
  assert.equal(request.url.pathname, '/shoppingInsight/getKeywordRank.naver');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.cookie, 'NNB=fixture-nnb; _datalab_cid=50000003');
  assert.equal(result.periodCount, 1);
  assert.equal(result.periods[0].ranks[0].keyword, 'fixture rank');

  let comparisonCookie;
  await fetchShoppingRanks({
    categoryId: '50000003', categoryName: '디지털/가전', timeUnit: 'date',
    cookieHeader: 'NNB=fixture-nnb; BUC=fixture-buc',
    fetchImpl: async (_url, options) => {
      comparisonCookie = options.headers.cookie;
      return new Response(JSON.stringify([
        { statusCode: 200, returnCode: 0, date: '2026/10/16', datetime: 'day1', range: '',
          ranks: [{ rank: 1, keyword: 'fixture rank' }] },
      ]), { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } });
    },
  });
  assert.equal(comparisonCookie, 'NNB=fixture-nnb; BUC=fixture-buc; _datalab_cid=50000003');

  let sent = false;
  for (const cookieHeader of ['NNB=fixture-nnb; LCS=fixture-lcs', 'NNB=fixture-nnb; NNB=duplicate',
    'NNB=fixture-nnb\r\nX-Test: bad', 'BUC=fixture-buc']) {
    await assert.rejects(() => fetchShoppingRanks({
      categoryId: '50000003', categoryName: '디지털/가전', timeUnit: 'date', cookieHeader,
      fetchImpl: async () => { sent = true; throw new Error('must not send invalid cookie scope'); },
    }), { code: 'SESSION_MISSING' });
  }
  assert.equal(sent, false);
});

test('a missing anonymous bootstrap cookie records source failures and lets other trend sources continue', async () => {
  let requestCount = 0;
  const result = await collectShoppingTrends({
    categories: [
      { id: '50000003', name: '디지털/가전' },
      { id: '50000002', name: '화장품/미용' },
    ],
    timeUnits: ['date', 'week'],
    delayMs: 0,
    fetchImpl: async url => {
      requestCount++;
      assert.equal(new URL(url).origin, 'https://lcs.naver.com');
      return {
        status: 200,
        headers: { getSetCookie: () => ['BUC=fixture-buc; Path=/'], get: () => 'image/gif' },
        text: async () => '',
      };
    },
  });
  assert.equal(requestCount, 1);
  assert.equal(result.requestedContracts, 4);
  assert.equal(result.successfulContracts, 0);
  assert.deepEqual(result.failures.map(item => item.code), Array(4).fill('SESSION_BOOTSTRAP'));
  assert.deepEqual(result.failures.map(item => item.httpStatus), Array(4).fill(null));
  assert.equal(result.sessionEvidence.bootstrapCount, 0);
  assert.equal(result.sessionEvidence.bootstrapFailureCode, 'SESSION_BOOTSTRAP');
  assert.deepEqual(result.sessionEvidence.cookieNamesPresent, ['BUC']);
  assert.deepEqual(result.sessionEvidence.cookieNamesSent, []);
});

test('a failed refresh bootstrap preserves prior ranks and records the remaining contracts as source failures', async () => {
  let bootstrapCalls = 0;
  let rankCalls = 0;
  const result = await collectShoppingTrends({
    categories: [
      { id: '50000003', name: '디지털/가전' },
      { id: '50000002', name: '화장품/미용' },
      { id: '50000004', name: '가구/인테리어' },
    ],
    timeUnits: ['date'],
    delayMs: 0,
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.origin === 'https://lcs.naver.com') {
        bootstrapCalls++;
        if (bootstrapCalls > 1) return new Response('', { status: 503 });
        return {
          status: 200,
          headers: {
            getSetCookie: () => ['NNB=fixture-nnb; Path=/', 'BUC=fixture-buc; Path=/'],
            get: () => 'image/gif',
          },
          text: async () => '',
        };
      }
      rankCalls++;
      if (rankCalls === 1) {
        return new Response(JSON.stringify([
          { statusCode: 200, returnCode: 0, date: '2026/10/16', datetime: 'day1', range: '',
            ranks: [{ rank: 1, keyword: 'verified fixture rank' }] },
        ]), { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' } });
      }
      return new Response('<!doctype html><title>temporary fallback</title>', {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    },
  });

  assert.equal(bootstrapCalls, 3); // initial bootstrap plus the bounded HTTP retry for refresh
  assert.equal(rankCalls, 2); // the third contract is recorded as failed without a request
  assert.equal(result.requestedContracts, 3);
  assert.equal(result.successfulContracts, 1);
  assert.equal(result.results[0].categoryId, '50000003');
  assert.equal(result.results[0].periods[0].ranks[0].keyword, 'verified fixture rank');
  assert.deepEqual(result.failures, [
    {
      categoryId: '50000002', categoryName: '화장품/미용', timeUnit: 'date',
      code: 'SESSION_BOOTSTRAP', httpStatus: null, bootstrapHttpStatus: 503,
      failureStage: 'session_refresh', bootstrapFailureCode: 'HTTP_STATUS', rankFailureCode: 'APPLICATION_HTML',
    },
    {
      categoryId: '50000004', categoryName: '가구/인테리어', timeUnit: 'date',
      code: 'SESSION_BOOTSTRAP', httpStatus: null, bootstrapHttpStatus: 503,
      failureStage: 'session_unavailable_after_refresh_failure', bootstrapFailureCode: 'HTTP_STATUS',
    },
  ]);
  assert.equal(result.sessionEvidence.bootstrapCount, 1);
  assert.equal(result.sessionEvidence.bootstrapFailureCode, 'HTTP_STATUS');
  assert.equal(result.sessionEvidence.bootstrapFailureHttpStatus, 503);
  assert.deepEqual(result.sessionEvidence.cookieNamesPresent, ['BUC', 'NNB']);
  assert.equal(result.sessionEvidence.cookieValuesPersisted, false);
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
