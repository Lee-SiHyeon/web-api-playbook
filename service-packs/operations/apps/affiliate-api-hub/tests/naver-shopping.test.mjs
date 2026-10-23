import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductCandidate } from '../../../packages/contracts/src/index.mjs';
import { NaverShoppingClient, isVerificationChallenge, extractPreloadedState, normalizeProduct, normalizeReview, parseShoppingFeed, parseProductUrl, parseStoreUrl } from '../adapters/naver-shopping.mjs';
import { main } from '../scripts/naver-shopping.mjs';
import { readFile } from 'node:fs/promises';

const store = 'https://brand.naver.com/fixture-store';
const product = { id: 12001, productNo: 22001, name: '<b>Synthetic cushion</b>', salePrice: 60000, dispSalePrice: 60000,
  benefitsView: { dispDiscountedSalePrice: 54000 }, channel: { channelUid: 'fixturechannel', channelName: 'Synthetic seller', naverPaySellerNo: '33001' },
  productDeliveryInfo: { baseFee: 3000, freeConditionalAmount: 60000, deliveryFeeType: 'CONDITIONAL_FREE' },
  reviewAmount: { totalReviewCount: 3, averageReviewScore: 4.5 }, stockQuantity: 4 };
const document = state => '<script>window.__PRELOADED_STATE__=' + JSON.stringify(state) + ';</script>';
const response = (value, type = 'application/json') => new Response(type === 'text/html' ? value : JSON.stringify(value), { headers: { 'content-type': type } });
const doc = document({ channel: { channelUid: 'fixturechannel' } });
function transport(queue, calls = []) {
  return async (url, options) => { calls.push({ url: String(url), options }); const item = queue.shift(); if (!item) throw new Error('Unexpected request'); return item; };
}

test('URL boundary rejects credential-bearing URLs, unrelated hosts and malformed IDs before HTTP', async () => {
  for (const url of ['http://brand.naver.com/store', 'https://brand.naver.com.evil/store', 'https://user:password@brand.naver.com/store', 'https://brand.naver.com:8443/store', 'https://brand.naver.com/store?cookie=fixture', 'https://brand.naver.com/%2fprivate']) assert.throws(() => parseStoreUrl(url), { code: 'INPUT' });
  assert.throws(() => parseStoreUrl('https://smartstore.naver.com/fixture-store'), { code: 'INPUT' });
  assert.deepEqual(parseProductUrl(store + '/products/12001'), { storeUrl: store, productId: '12001' });
  let calls = 0;
  const client = new NaverShoppingClient({ fetchImpl: async () => { calls++; } });
  await assert.rejects(client.product({ storeUrl: store, productId: '1/../2' }), { code: 'INPUT' });
  await assert.rejects(client.request('https://127.0.0.1/private'), { code: 'INPUT' });
  await assert.rejects(client.request('https://search.naver.com/search.naver?where=blog&query=fixture'), { code: 'INPUT' });
  await assert.rejects(client.request('https://brand.naver.com/n/v1/keep-stores', { payload: { kept: true }, json: true }), { code: 'INPUT' });
  await assert.rejects(client.request('https://brand.naver.com/n/v1/contents/reviews/query-pages', { payload: { checkoutMerchantNo: 1, originProductNo: 2, page: 1, pageSize: 20, reviewSearchSortType: 'REVIEW_RANKING', actor: 'fixture' }, json: true }), { code: 'INPUT' });
  await assert.rejects(client.search({ query: 'cushion' }), { code: 'INPUT' });
  await assert.rejects(client.request('https://search.shopping.naver.com/search/all?query=fixture'), { code: 'INPUT' });
  assert.equal(calls, 0);
});

test('store state parsing handles undefined without executing source or rewriting strings', () => {
  assert.deepEqual(extractPreloadedState('<script>window.__PRELOADED_STATE__={"channel":{"channelUid":"fixture"},"empty":undefined,"title":"undefined"};</script>'), { channel: { channelUid: 'fixture' }, empty: null, title: 'undefined' });
  for (const html of ['<html>not a store</html>', 'window.__PRELOADED_STATE__={"x":(()=>{globalThis.pwned=true})()};', 'window.__PRELOADED_STATE__={"x":NaN};']) assert.throws(() => extractPreloadedState(html), { code: 'SCHEMA_CHANGED' });
  assert.equal(globalThis.pwned, undefined);
});

test('normalized product preserves listed discount, shipping condition and unknown checkout price', () => {
  const item = normalizeProduct(product, { storeUrl: store, checkedAt: '2026-09-30T00:00:00Z' });
  assert.equal(validateProductCandidate(item), true);
  assert.equal(item.productId, '12001'); assert.equal(item.originProductId, '22001');
  assert.equal(item.title, 'Synthetic cushion'); assert.equal(item.listingPriceKrw, 54000);
  assert.equal(item.basePriceKrw, 60000); assert.equal(item.shipping.freeConditionalAmountKrw, 60000);
  assert.equal(item.payablePriceVerified, false); assert.equal('payablePriceKrw' in item, false);
  const unknown = normalizeProduct({ id: 12001, name: 'Unknown price' }, { storeUrl: store });
  assert.equal(unknown.listingPriceKrw, null); assert.equal(unknown.reviewCount, null);
  assert.equal(normalizeProduct({ id: 12001, name: 'Explicit free item', salePrice: 0 }, { storeUrl: store }).listingPriceKrw, 0);
});

test('store search constructs only the observed q document route and validates keyword/empty/schema', async () => {
  const calls = [];
  const state = { keywordSearch: { keyword: '쿠션 & foundation', simpleProducts: [product], totalCount: 1, page: 1 } };
  const client = new NaverShoppingClient({ fetchImpl: transport([response(document(state), 'text/html')], calls) });
  const result = await client.search({ storeUrl: store, query: '쿠션 & foundation' });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/fixture-store/search'); assert.equal(url.searchParams.get('q'), '쿠션 & foundation');
  assert.equal(result.scope, 'single_naver_store'); assert.equal(result.paginationVerified, false);
  assert.equal(result.items[0].listingPriceKrw, 54000);
  const empty = new NaverShoppingClient({ fetchImpl: transport([response(document({ keywordSearch: { keyword: '없음', simpleProducts: [], totalCount: 0, page: 1 } }), 'text/html')]) });
  assert.equal((await empty.search({ storeUrl: store, query: '없음' })).items.length, 0);
  for (const invalid of [{}, { keywordSearch: { keyword: 'wrong', simpleProducts: [], totalCount: 0, page: 1 } }, { keywordSearch: { keyword: '쿠션', simpleProducts: [] } }]) {
    const bad = new NaverShoppingClient({ fetchImpl: transport([response(document(invalid), 'text/html')]) });
    await assert.rejects(bad.search({ storeUrl: store, query: '쿠션' }), { code: 'SCHEMA_CHANGED' });
  }
});

test('reviews query is a read POST using origin ID/merchant instead of channel product ID', async () => {
  const calls = [], review = { id: 'fixture-review-1', reviewScore: 4, reviewContent: '<script>evil()</script>좋아요 me@example.com 010-1234-5678', createDate: '2026-09-30T00:00:00Z', productOptionContent: '<b>23N</b>', writerId: 'private-fixture-user', writerMemberNo: 99, orderNo: 'private-fixture-order', originProductNo: 22001 };
  const client = new NaverShoppingClient({ fetchImpl: transport([response(doc, 'text/html'), response(product), response({ contents: [review], page: 2, size: 20, totalElements: 30, totalPages: 2 })], calls) });
  const result = await client.reviews({ storeUrl: store, productId: '12001', page: 2 });
  assert.equal(new URL(calls[1].url).pathname, '/n/v2/channels/fixturechannel/products/12001');
  assert.equal(new URL(calls[1].url).searchParams.get('withWindow'), 'false');
  assert.equal(new URL(calls[2].url).pathname, '/n/v1/contents/reviews/query-pages');
  assert.equal(calls[2].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].options.body), { checkoutMerchantNo: 33001, originProductNo: 22001, page: 2, pageSize: 20, reviewSearchSortType: 'REVIEW_RANKING' });
  assert.equal(result.selection, 'all_reviews'); assert.equal(result.reviews[0].productOption, '23N');
  assert.equal(result.reviews[0].text, '좋아요 [email removed] [phone removed]');
  assert.equal(result.reviews[0].originProductId, '22001');
  assert.ok(!JSON.stringify(result).includes('private-fixture')); assert.ok(!JSON.stringify(result.receipts).includes('좋아요'));
  assert.ok(result.receipts.every(x => x.browserUsed === false && /^[a-f0-9]{64}$/.test(x.responseSha256)));
});

test('reviews reject invalid paging before requests; product identity and review schema fail closed', async () => {
  const untouched = new NaverShoppingClient({ fetchImpl: () => { throw new Error('should not run'); } });
  await assert.rejects(untouched.reviews({ storeUrl: store, productId: '12001', page: 0 }), { code: 'INPUT' });
  await assert.rejects(untouched.reviews({ storeUrl: store, productId: '12001', pageSize: 100 }), { code: 'INPUT' });
  const mismatch = new NaverShoppingClient({ fetchImpl: transport([response(doc, 'text/html'), response({ ...product, id: 12002 })]) });
  await assert.rejects(mismatch.product({ storeUrl: store, productId: '12001' }), { code: 'SCHEMA_CHANGED' });
  const bad = new NaverShoppingClient({ fetchImpl: transport([response(doc, 'text/html'), response(product), response({ contents: [], page: 0, size: 20, totalElements: 0 })]) });
  await assert.rejects(bad.reviews({ storeUrl: store, productId: '12001' }), { code: 'SCHEMA_CHANGED' });
  for (const score of [0, 3.5, 10]) assert.throws(() => normalizeReview({ id: 1, reviewContent: 'invalid score', reviewScore: score }), { code: 'SCHEMA_CHANGED' });
});

test('WAF, rate limit, CAPTCHA, login, redirect and JSON failures are errors without retry or raw body disclosure', async () => {
  const cases = [[418, 'blocked fixture-private-cookie', 'WAF_BLOCKED'], [429, 'fixture-private-cookie', 'RATE_LIMITED'], [200, '<iframe src="https://ncpt.naver.com/challenge"></iframe>', 'CAPTCHA_REQUIRED'], [200, '<title>네이버 로그인</title>', 'AUTH_REQUIRED'], [503, 'unavailable', 'HTTP_STATUS'], [302, 'redirect', 'REDIRECT_REJECTED']];
  for (const [status, body, code] of cases) {
    let count = 0;
    const client = new NaverShoppingClient({ fetchImpl: async () => { count++; return new Response(body, { status, headers: { 'content-type': 'text/html', location: 'https://example.com/' } }); } });
    await assert.rejects(client.product({ storeUrl: store, productId: '12001' }), error => {
      assert.equal(error.code, code); assert.equal(error.receipt.httpStatus, status); assert.ok(!JSON.stringify(error).includes('fixture-private-cookie')); return true;
    });
    assert.equal(count, 1);
  }
  for (const [body, type, code] of [['<html>error</html>', 'text/html', 'CONTENT_TYPE'], ['{invalid', 'application/json', 'SCHEMA_CHANGED']]) {
    const client = new NaverShoppingClient({ fetchImpl: async () => new Response(body, { headers: { 'content-type': type } }) });
    await assert.rejects(client.request('https://brand.naver.com/n/v2/channels/fixturechannel/products/12001?withWindow=false', { json: true }), { code });
  }
});

test('bounded body rejects advertised and streamed over-budget responses; transport errors stay sanitized', async () => {
  for (const headers of [{ 'content-length': '1000' }, {}]) {
    const client = new NaverShoppingClient({ responseByteLimit: 10, fetchImpl: async () => new Response('x'.repeat(100), { headers }) });
    await assert.rejects(client.request(store + '/products/12001'), { code: 'SIZE_LIMIT' });
  }
  const client = new NaverShoppingClient({ fetchImpl: async () => { throw new Error('cookie=fixture-private-value'); } });
  await assert.rejects(client.request(store + '/products/12001'), error => error.code === 'TRANSPORT' && !String(error).includes('fixture-private-value'));
  const brokenStream = new NaverShoppingClient({ fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('fixture-private-stream-error')); } })) });
  await assert.rejects(brokenStream.request(store + '/products/12001'), error => error.code === 'TRANSPORT' && !String(error).includes('fixture-private-stream-error'));
});

function feedHtml(payload) {
  const flight = '0:' + JSON.stringify(payload) + '\n';
  return '<script>self.__next_f.push(' + JSON.stringify([1, flight]) + ')</script>';
}
test('shopping feed preserves promotion scope, genuine prices, missing values, IDs and no tracking links', async () => {
  const html = feedHtml({ items: [{ nvMid: '44001', title: 'Synthetic 텀블러', mallNm: 'Fixture mall', price: '36000', listPrice: 45000, reviewCount: '308', linkUrl: 'https://ader.naver.com/private-tracking-payload' }, { title: 'Promo banner', price: 0 }], products: [] });
  const items = parseShoppingFeed(html);
  assert.equal(items[0].listingPriceKrw, 36000); assert.equal(items[0].reviewCount, 308); assert.equal(items[0].url, null);
  assert.equal(items[1].listingPriceKrw, null); assert.ok(items[1].productId.startsWith('promotion:'));
  for (const x of items) assert.equal(validateProductCandidate(x), true);
  const calls = [];
  const client = new NaverShoppingClient({ fetchImpl: transport([new Response('0:' + JSON.stringify({ items: [{ nvMid: '44001', title: 'Synthetic 텀블러', price: '36000' }] }) + '\n', { headers: { 'content-type': 'text/x-component' } })], calls) });
  const result = await client.feed({ query: '텀블러' });
  assert.equal(result.items.length, 1); assert.equal(result.globalSearch, false); assert.equal(result.reviewBodiesIncluded, false);
  assert.equal(result.filtering, 'local_filter_of_current_feed');
  assert.equal(calls[0].options.headers.RSC, '1'); assert.equal(calls[0].options.headers['Next-Url'], '/promotion');
  assert.throws(() => parseShoppingFeed('<html>maintenance</html>'), { code: 'SCHEMA_CHANGED' });
  const conflicts = parseShoppingFeed(feedHtml({ items: [{ nvMid: '44001', title: 'Same product', price: 3000 }, { nvMid: '44001', title: 'Same product', price: 4000 }, { nvMid: '44001', title: 'Same product', price: 4000 }] }));
  assert.deepEqual(conflicts.map(x => x.listingPriceKrw), [3000, 4000]);
  const navigation = parseShoppingFeed(feedHtml({ items: [{ id: 'retailer-id', title: 'Mall banner' }] }))[0];
  assert.equal(navigation.idKind, 'derived_promotion_key'); assert.equal(navigation.recordType, 'promotion');
  assert.equal(parseShoppingFeed('0:{"items": [{"nvMid":"44001","title":"Whitespace fixture","price":1000}]}', { flightResponse: true })[0].listingPriceKrw, 1000);
});

test('CLI returns structured failures, validates operation-specific flags and never exposes unknown exceptions', async () => {
  const stdout = [], stderr = [], io = { stdout: x => stdout.push(x), stderr: x => stderr.push(x) };
  assert.equal(await main(['feed', '--proxy', 'fixture-secret'], io), 2);
  assert.equal(JSON.parse(stderr.at(-1)).error.code, 'INPUT'); assert.ok(!stderr.at(-1).includes('fixture-secret'));
  assert.equal(await main(['search', '--query', '쿠션'], io), 2);
  assert.equal(JSON.parse(stderr.at(-1)).error.code, 'INPUT');
  assert.equal(await main(['global_search', '--query', '쿠션'], io), 2);
  assert.equal(await main(['feed', '--page', '2'], io), 2);
  assert.equal(await main(['feed'], { ...io, client: { feed: () => { throw new Error('private-fixture'); } } }), 1);
  assert.ok(!stderr.at(-1).includes('private-fixture'));
  assert.equal(await main(['reviews', '--product-url', store + '/products/12001', '--store', store], io), 2);
});

test('catalog distinguishes observed browser requests, anonymous replay and unsupported global search', async () => {
  const output = [];
  assert.equal(await main(['catalog'], { stdout: x => output.push(x), stderr: assert.fail }), 0);
  const catalog = JSON.parse(output[0]).result;
  assert.equal(catalog.completionGatePassed, false); assert.equal(catalog.authenticatedReplayVerified, false);
  assert.equal(catalog.operations.find(x => x.name === 'reviews').state.live_replay, false);
  assert.equal(catalog.operations.some(x => x.name === 'global_search'), false);
  assert.equal(catalog.operations.find(x => x.name === 'feed').rscVariant.browserXhrObserved, false);
  const registry = JSON.parse(await readFile(new URL('../references/candidates.json', import.meta.url), 'utf8'));
  const retired = registry.candidates.find(x => x.id === 'naver-shopping-search-api');
  assert.equal(retired.priority, 'EXCLUDE'); assert.deepEqual(retired.capabilities, []);
  assert.ok(registry.candidates.some(x => x.id === retired.replacementCandidateId));
});

test('verification challenge detection ignores the ncaptcha widget config embedded in normal result pages', () => {
  const resultPage = '<html><head><title>효성팜 청도반시 : 네이버 검색</title></head><body><script>var c={"ncaptcha":{"hostname":"https://ncpt.naver.com","siteKey":{"nmap":"x"}}};</script></body></html>';
  assert.equal(isVerificationChallenge(resultPage), false);
  const configOnly = '<html><title>네이버쇼핑</title><script>{"ncaptcha":{"hostname":"https://ncpt.naver.com","siteKey":{}}}</script></html>';
  assert.equal(isVerificationChallenge(configOnly), false);
  assert.equal(isVerificationChallenge('<iframe src="https://ncpt.naver.com/challenge"></iframe>'), true);
  assert.equal(isVerificationChallenge('<html><title>네이버</title><script src="https://ncpt.naver.com/v1/wtm_captcha.js"></script></html>'), true);
});

test('a normal search result page with the ncaptcha config is not reported as CAPTCHA_REQUIRED', async () => {
  const body = '<html><head><title>노트북 : 네이버 검색</title></head><body><script>{"ncaptcha":{"hostname":"https://ncpt.naver.com"}}</script></body></html>';
  const client = new NaverShoppingClient({ fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } }) });
  const result = await client.request(new URL('https://search.naver.com/search.naver?where=nexearch&query=%EB%85%B8%ED%8A%B8%EB%B6%81'));
  assert.equal(result.receipt.httpStatus, 200);
});
