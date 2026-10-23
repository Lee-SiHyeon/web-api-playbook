import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegratedPriceCards, searchIntegratedPrices, summarizePriceObservations, filterPriceObservations } from '../adapters/naver-price-observations.mjs';
import { main } from '../scripts/naver-shopping.mjs';
import { validateProductCandidate } from '../../../packages/contracts/src/index.mjs';

// Synthetic DOM follows the observed price rows; no live HTML is committed.
function card({ id = '1001', title = 'Fixture 16GB laptop', listing = 598000, list = 959000, coupon = 597000, reviews = '1.4만', sellers = null, kind = 'outtit' } = {}) {
  return '<li><a data-nlog-area="shp_dig.a.outimg" href="https://cr3.shopping.naver.com/v2/bridge/searchGate?nv_mid=' + id + '&amp;h=fixture-tracking"></a>'
    + '<div><a data-nlog-area="shp_dig.a.' + kind + '" href="https://cr3.shopping.naver.com/v2/bridge/searchGate?nv_mid=' + id + '">' + title + '</a>'
    + (list === null ? '' : '<div class="YsimyBy5">할인 전 판매가 <span class="lfETsaia">' + list.toLocaleString('en-US') + '</span> 원</div>')
    + '<div class="lS3yrqWd"><span class="lfETsaia">' + listing.toLocaleString('en-US') + '</span> 원</div>'
    + (coupon === null ? '' : '<div class="hx15sCPH"><span class="lfETsaia">' + coupon.toLocaleString('en-US') + '</span> 원 쿠폰할인가</div>')
    + '<span class="WJ5FBx2j"><span class="mlLzqQ3t">4.77</span><span class="zZrIETI9">(' + reviews + ')</span></span>'
    + (sellers === null ? '<a data-nlog-area="shp_dig.a.outmall">Fixture seller</a>' : '<span>판매처 ' + sellers + '</span>')
    + '<div>적립 포인트 최대 9,999 원</div></div></li>';
}

test('AGY regression: listed current price is distinguished from the first list price and conditional coupon', () => {
  const items = parseIntegratedPriceCards('<ul>' + card() + card({ id: '1002', listing: 1257970, list: null, coupon: null, sellers: '160', kind: 'itemtit', reviews: '8,295' }) + '</ul>');
  assert.equal(items.length, 2); assert.equal(items[0].listingPriceKrw, 598000);
  assert.equal(items[0].listPriceKrw, 959000); assert.equal(items[0].conditionalCouponPriceKrw, 597000);
  assert.equal(items[0].couponEligibilityVerified, false); assert.equal(items[0].payablePriceVerified, false);
  assert.equal(items[0].sellersCount, null); assert.equal(items[1].sellersCount, 160);
  assert.equal(items[1].listingKind, 'catalog_comparison'); assert.equal(items[1].listingPriceKrw, 1257970);
  assert.ok(!JSON.stringify(items).includes('fixture-tracking'));
  items.forEach(x => assert.equal(validateProductCandidate(x), true));
});

test('abbreviated review counts stay approximate; missing seller/count/rating values are not invented', () => {
  const item = parseIntegratedPriceCards(card())[0];
  assert.equal(item.reviewCount, null); assert.equal(item.reviewCountApproximate, 14000);
  assert.equal(item.reviewCountDisplay, '1.4만'); assert.equal(item.reviewCountPrecision, 'abbreviated');
  assert.equal(item.averageRating, 4.77); assert.equal(item.sellersCount, null);
  const missing = parseIntegratedPriceCards(card().replace(/<span class="WJ5FBx2j">[\s\S]*?<\/span><\/span>/, ''))[0];
  assert.equal(missing.reviewCount, null); assert.equal(missing.averageRating, null);
  assert.equal(item.searchRank, null); assert.equal(item.adStatus, 'not_determined');
});

test('card grouping never borrows a sibling product price and exact repeats do not hide price conflicts', () => {
  const a = card({ id: '1001', listing: 1000 }), b = card({ id: '1002', listing: 3000 });
  assert.deepEqual(parseIntegratedPriceCards('<div>' + a + b + '</div>').map(x => x.listingPriceKrw), [1000, 3000]);
  assert.deepEqual(parseIntegratedPriceCards(a + a + card({ id: '1001', listing: 2000 })).map(x => x.listingPriceKrw), [1000, 2000]);
  assert.throws(() => parseIntegratedPriceCards(a.replace('class="lS3yrqWd"', 'class="changed-price-row"')), { code: 'SCHEMA_CHANGED' });
  assert.throws(() => parseIntegratedPriceCards(a.replace('shp_dig.a.outtit', 'changed-title')), { code: 'SCHEMA_CHANGED' });
});

test('unavailable shopping blocks and malformed money are errors rather than empty/zero reports', () => {
  assert.throws(() => parseIntegratedPriceCards('<html>ordinary search results</html>'), { code: 'SHOPPING_BLOCK_UNAVAILABLE' });
  assert.throws(() => parseIntegratedPriceCards(card().replace('598,000', 'unknown')), { code: 'SCHEMA_CHANGED' });
  assert.throws(() => parseIntegratedPriceCards(card(), { limit: 0 }), { code: 'INPUT' });
  assert.deepEqual(summarizePriceObservations([]), { scope: 'returned_cards_only', pricedItemCount: 0, lowest: null, highest: null, arithmeticMean: null, comparableVariantsVerified: false, checkoutPricesVerified: false });
});

test('price summaries apply only to returned observations and preserve source order separately from price order', async () => {
  const calls = [];
  const result = await searchIntegratedPrices({ query: '노트북 & 16GB', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(card({ id: '1001', listing: 3000 }) + card({ id: '1002', listing: 1000 }), { headers: { 'content-type': 'text/html' } });
  } });
  const url = new URL(calls[0].url);
  assert.equal(url.hostname, 'search.naver.com'); assert.equal(url.pathname, '/search.naver');
  assert.equal(url.searchParams.get('where'), 'nexearch'); assert.equal(url.searchParams.get('query'), '노트북 & 16GB');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.headers.cookie, undefined);
  assert.deepEqual(result.items.map(x => x.productId), ['1001', '1002']);
  assert.deepEqual(result.priceOrder.map(x => x.productId), ['1002', '1001']);
  assert.equal(result.observedPriceRangeKrw.arithmeticMean, 2000);
  assert.equal(result.catalogComplete, false); assert.equal(result.comparisonReady, false); assert.equal(result.reviewBodiesIncluded, false);
  assert.equal(result.receipt.browserUsed, false); assert.equal(result.receipt.credentialsUsed, null);
});

test('integrated HTTP/CLI propagate failures without retry or an empty success', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response('restricted', { status: 418 }); };
  await assert.rejects(searchIntegratedPrices({ query: '노트북', fetchImpl }), { code: 'WAF_BLOCKED' });
  assert.equal(requests, 1);
  const stderr = [], stdout = [];
  assert.equal(await main(['integrated-search', '--query', '노트북'], { client: { fetchImpl }, stdout: x => stdout.push(x), stderr: x => stderr.push(x) }), 1);
  assert.equal(stdout.length, 0); assert.equal(JSON.parse(stderr[0]).error.code, 'WAF_BLOCKED');
  await assert.rejects(searchIntegratedPrices({ query: '', fetchImpl }), { code: 'INPUT' });
  await assert.rejects(searchIntegratedPrices({ query: '노트북', limit: 100, fetchImpl }), { code: 'INPUT' });
});

test('AGY include/exclude and price-range filters apply locally to inspected prices and keep source positions', async () => {
  const items = [{ sourceOrder: 1, title: '아이폰 자급제 128GB', seller: null, listingPriceKrw: 930000 }, { sourceOrder: 2, title: '아이폰 자급제 256GB', seller: null, listingPriceKrw: 1050000 }, { sourceOrder: 3, title: '아이폰 케이스', seller: 'Fixture mall', listingPriceKrw: 9900 }];
  assert.deepEqual(filterPriceObservations(items, { includeRegex: '자급제.*(128|256)GB', excludeRegex: '케이스|필름', minPriceKrw: 1000000 }).map(x => x.sourceOrder), [2]);
  assert.equal(filterPriceObservations(items, { maxPriceKrw: 10000 }).length, 1);
  assert.equal(filterPriceObservations(items, { excludeRegex: '아이폰' }).length, 0);
  const result = await searchIntegratedPrices({ query: '노트북', minPriceKrw: 600000, fetchImpl: async () => new Response(card(), { headers: { 'content-type': 'text/html' } }) });
  assert.equal(result.inspectedCount, 1); assert.equal(result.matchedCount, 0);
  assert.equal(result.observedPriceRangeKrw.lowest, null); assert.equal(result.filtering, 'local_filter_of_inspected_cards');
  assert.equal(summarizePriceObservations([{ listingPriceKrw: Number.MAX_SAFE_INTEGER }, { listingPriceKrw: Number.MAX_SAFE_INTEGER }]).arithmeticMean, Number.MAX_SAFE_INTEGER);
  const stdout = [];
  const client = { fetchImpl: async () => new Response(card({ title: '아이폰 자급제 256GB', listing: 1050000, list: 1200000, coupon: 1049000 }), { headers: { 'content-type': 'text/html' } }) };
  assert.equal(await main(['integrated-search', '--query', '아이폰', '--regex', '자급제.*256GB', '--exclude', '케이스', '--min-price', '1000000'], { client, stdout: x => stdout.push(x), stderr: assert.fail }), 0);
  const cli = JSON.parse(stdout[0]).result;
  assert.equal(cli.items.length, 1); assert.equal(cli.filters.minPriceKrw, 1000000); assert.equal(cli.items[0].listingPriceKrw, 1050000);
});

test('unsafe/unbounded regex and invalid bounds fail before network access', async () => {
  let requests = 0; const fetchImpl = async () => { requests++; throw new Error('should not call'); };
  for (const includeRegex of ['(a+)+$', '(?=a)', '\\1', 'a.*b.*c', '(a){100000}', '[' ]) await assert.rejects(searchIntegratedPrices({ query: '노트북', includeRegex, fetchImpl }), { code: 'INPUT' });
  await assert.rejects(searchIntegratedPrices({ query: '노트북', minPriceKrw: -1, fetchImpl }), { code: 'INPUT' });
  await assert.rejects(searchIntegratedPrices({ query: '노트북', minPriceKrw: 2000, maxPriceKrw: 1000, fetchImpl }), { code: 'INPUT' });
  assert.equal(requests, 0);
});
