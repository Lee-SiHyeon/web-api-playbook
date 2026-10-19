import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ABLY_API_ORIGIN, ablyGoodsLinks, createAblyClient, parseAffiliateGoods, parseGoodsBasic, parseGoodsDetailImages,
  parseMarketRanking, parseOptionLevel, parseOptionsBrief, parseOutfits, parseRankingFilters, parseRankingPage,
  parseRelatedOutfits, parseReviewSummary, parseSearchScreen, parseStyleContents, rankingQueryFor,
} from '../lib/commerce/ably.mjs';

const fixtures = new URL('./fixtures/ably/', import.meta.url);
const fx = async name => JSON.parse(await readFile(new URL(`${name}.json`, fixtures), 'utf8'));
const FAKE_TOKEN = 'aaa.bbb.ccc';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(routes, calls) {
  return async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers });
    if (u.pathname === '/api/v2/anonymous/token/') return json({ token: FAKE_TOKEN });
    for (const [match, reply] of routes) if (match(u)) return typeof reply === 'function' ? reply(u) : reply;
    return json({ detail: 'not found' }, 404);
  };
}
const clientWith = (routes, calls, extra = {}) => {
  let t = 0;
  return createAblyClient({ fetchImpl: fakeFetch(routes, calls), minIntervalMs: 3000, sleep: async ms => { t += ms; }, now: () => t, deviceId: 'dev-1', ...extra });
};

test('ranking filters build a category tree and resolve the observed ranking query', async () => {
  const tree = parseRankingFilters(await fx('ranking-filters'));
  const fashion = tree.verticals.find(v => v.sno === 1);
  assert.ok(fashion.categories.some(c => c.sno === 467 && c.name === '비치웨어' && c.children.some(x => x.sno === 468 && x.name === '비키니')));
  assert.deepEqual(tree.periods.map(p => p.value), ['daily', 'weekly', 'monthly']);
  assert.deepEqual(rankingQueryFor(tree, 467), { market_type_sno: 1, category_sno: 467, path: ['패션', '비치웨어'] });
  assert.deepEqual(rankingQueryFor(tree, '468').path, ['패션', '비치웨어', '비키니']);
  assert.throws(() => rankingQueryFor(tree, 999999), { code: 'ABLY_CATEGORY_UNKNOWN' });
});

test('ranking page keeps the displayed rank and KRW price kinds', async () => {
  const page = parseRankingPage(await fx('ranking-best-467'));
  assert.equal(page.items.length, 3);
  assert.deepEqual(page.items.map(i => i.rank), [1, 2, 3]);
  const first = page.items[0];
  assert.equal(first.price.currency, 'KRW');
  assert.equal(first.price.kind, 'retail_current');
  assert.equal(typeof first.market.name, 'string');
  assert.equal(first.links.web, `https://m.a-bly.com/goods/${first.sno}`);
  assert.throws(() => parseRankingPage({ goods: [{ sno: 1 }] }), { code: 'ABLY_RANK_MISSING' });
});

test('search screen yields goods cards, marks ads and keeps the continuation token', async () => {
  const page = parseSearchScreen(await fx('search-result'));
  assert.ok(page.items.length >= 3);
  assert.ok(page.items.some(i => i.isAd));
  assert.ok(page.items.every(i => Number.isSafeInteger(i.sno) && i.price?.currency === 'KRW'));
  assert.equal(typeof page.nextToken, 'string');
});

test('product parsers: basic, detail images, reviews, options, affiliate estimate', async () => {
  const basic = parseGoodsBasic(await fx('goods-basic'));
  assert.equal(basic.sno, 76822195);
  assert.equal(basic.market.name, '브랜드코리아');
  assert.equal(basic.brand.name, '스파오');
  assert.equal(basic.price.list.amount, 78000);
  assert.equal(basic.price.sale.amount, 68000);
  assert.equal(basic.coverImages.length, 4);
  const images = parseGoodsDetailImages(await fx('goods-detail'));
  assert.ok(images.length >= 1 && images.every(u => u.startsWith('https://')));
  assert.ok(!images.some(u => u.includes('/data/editor/2026101')), 'top-notice banners are excluded');
  assert.deepEqual(parseReviewSummary(await fx('review-summary')), { count: 6, positivePercent: 100 });
  const brief = parseOptionsBrief(await fx('options-brief'));
  assert.deepEqual(brief.names, ['색상', '사이즈']);
  const d1 = parseOptionLevel(await fx('options-depth1'));
  assert.equal(d1.values[0].name, 'Glossy White');
  const d2 = parseOptionLevel(await fx('options-depth2'));
  assert.equal(d2.values[0].price.amount, 68000);
  assert.deepEqual(d2.values[0].optionNames, ['Glossy White', 'S']);
  const aff = parseAffiliateGoods(await fx('affiliate-goods'));
  assert.equal(aff.isAffiliateMember, false);
  assert.equal(aff.settlementRatePercent, 2);
  assert.equal(aff.expectedRewardKrw, 1360);
});

test('influencer/style parsers drop member body data and keep tagged goods', async () => {
  const outfits = parseOutfits(await fx('outfits'));
  assert.equal(outfits.items.length, 2);
  const text = JSON.stringify(outfits);
  assert.ok(!/height|weight|writer|birth/.test(text), 'member identity/body fields are not emitted');
  assert.ok(outfits.items[0].taggedGoods[0].links.web.startsWith('https://m.a-bly.com/goods/'));
  assert.equal(typeof outfits.nextCursor, 'number');
  const related = parseRelatedOutfits(await fx('related-outfits'));
  assert.ok(related[0].webUrl.endsWith('/goods'));
  const style = parseStyleContents(await fx('style-contents'));
  assert.ok(style[0].webUrl.startsWith('https://m.a-bly.com/events/'));
  const markets = parseMarketRanking(await fx('market-ranking'));
  assert.equal(markets.items[0].rank, 1);
  assert.ok('instagram' in markets.items[0]);
});

test('client bootstraps one anonymous token, paces requests and paginates ranking by last_ranking/last_sno', async () => {
  const filters = await fx('ranking-filters');
  const best = await fx('ranking-best-467');
  const page2 = { ...best, goods: best.goods.map((g, i) => ({ ...g, sno: g.sno + 1000, ranking: 4 + i })) };
  const calls = [];
  const client = clientWith([
    [u => u.pathname === '/api/v2/goods/ranking-filters/', json(filters)],
    [u => u.pathname === '/api/v2/goods/' && !u.searchParams.has('last_ranking'), json(best)],
    [u => u.pathname === '/api/v2/goods/' && u.searchParams.get('last_ranking') === '3', json(page2)],
  ], calls);
  const out = await client.ranking({ categorySno: '467', period: 'weekly', limit: 5 });
  assert.deepEqual(out.items.map(i => i.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(out.category.path, ['패션', '비치웨어']);
  assert.equal(calls.filter(c => c.path === '/api/v2/anonymous/token/').length, 1);
  const rankCall = calls.find(c => c.path === '/api/v2/goods/');
  assert.deepEqual({ ...rankCall.query }, { filter: 'best', market_type_sno: '1', category_sno: '467', period: 'weekly' });
  assert.equal(rankCall.headers['X-Anonymous-Token'], FAKE_TOKEN);
  assert.equal(rankCall.headers.Cookie, undefined);
  assert.equal(calls[0].headers['X-Anonymous-Token'], undefined);
  assert.ok(client.receipts.every(r => r.origin === ABLY_API_ORIGIN && r.cookieSent === false && r.credentialsUsed === false));
  assert.ok(!JSON.stringify(client.receipts).includes(FAKE_TOKEN), 'token never appears in receipts');
});

test('client stops on 401/429 and Cloudflare challenge HTML without retrying', async () => {
  for (const [reply, code] of [
    [json({ detail: 'x' }, 401), 'ABLY_AUTH_REJECTED'],
    [json({ detail: 'slow down' }, 429), 'ABLY_RATE_LIMITED'],
    [new Response('<title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } }), 'ABLY_CHALLENGE'],
  ]) {
    const calls = [];
    const client = clientWith([[u => u.pathname.startsWith('/api/v3/goods/'), reply]], calls);
    await assert.rejects(client.product({ id: '123' }), { code });
    assert.equal(calls.filter(c => c.path.startsWith('/api/v3/goods/')).length, 1);
  }
});

test('input validation and link forms', async () => {
  const client = clientWith([], []);
  await assert.rejects(client.product({ id: '../x' }), { code: 'ABLY_ID_INVALID' });
  await assert.rejects(client.search({ query: '  ' }), { code: 'ABLY_QUERY_INVALID' });
  await assert.rejects(client.ranking({ limit: 500 }), { code: 'ABLY_LIMIT_INVALID' });
  await assert.rejects(client.ranking({ period: 'yearly' }), { code: 'ABLY_PERIOD_INVALID' });
  assert.deepEqual(ablyGoodsLinks(5), { web: 'https://m.a-bly.com/goods/5', appWeb: 'https://mobile.a-bly.com/goods/5', appDeeplink: 'ably://goods/5' });
});
