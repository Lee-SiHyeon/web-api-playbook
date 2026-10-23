import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectTodayDeals, koreanDate, parseDealPage, parsePromotionManifest } from '../adapters/naver-shopping-deals.mjs';

const layoutId = 'I_0123456789abcdef01234567';
const window = { startAt: '2026-09-20T02:00:00.000Z', endAt: '2026-09-21T01:59:59.000Z' };
const now = () => new Date('2026-09-20T18:00:00Z');
function manifest() {
  return '<script type="application/json" id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { waffleData: {
    pageLayout: { layers: [{ meta: { title: '스페셜딜' }, blocks: [{ items: [{ layoutId, componentType: 'AUTO_SORT_PRODUCT' }] }] }] },
    pageData: { layers: [{ items: [{ itemLayoutId: layoutId, startDate: '2026-09-20T11:00:00', endDate: '2026-09-21T10:59:59', lastModifiedBy: 'DO_NOT_EXPORT' }] }] },
  } } } }) + '</script>';
}
const product = id => ({ productId: id, name: '테스트 상품', isSoldOut: false, salePrice: 10000, discountedPrice: 8000, discountedRatio: 20, deliveryFee: null, landingUrl: 'https://smartstore.naver.com/example/products/' + id });
const page = (n, ids, hasNext = false) => ({ itemLayoutId: layoutId, page: n, hasNext, contents: ids.map(product) });
const response = (data, type = 'application/json', status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': type } });
const captured = JSON.parse(await readFile(new URL('./fixtures/naver-shopping-deals-2026-10-11.json', import.meta.url), 'utf8'));
const v3Now = () => new Date('2026-10-11T00:55:08Z');
const capturedTabs = captured.tabList.filter(t => captured.pages.some(p => p.pageCode === t.id));
const v3Manifest = (tabList = capturedTabs) => '<script type="application/json" id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { waffleData: null, tabList } } }) + '</script>';
const capturedBodies = [captured.pages[0], captured.layerBatches[0], captured.layerBatches[1], captured.pages[1], captured.layerBatches[2], ...captured.productPages];
function replayV3(calls = [], transform = data => data) {
  return async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers['accept-language'], 'ko-KR');
    assert.match(options.headers['user-agent'], /^Mozilla\/5\.0/);
    assert.equal(options.headers.referer, 'https://shopping.naver.com/promotion');
    if (String(url) === 'https://shopping.naver.com/promotion') return response(v3Manifest(), 'text/html');
    assert.equal(options.headers.accept, 'application/json');
    const index = captured.sourceRequests.findIndex(request => request.url === String(url));
    assert.notEqual(index, -1, `Uncaptured request: ${url}`);
    return response(transform(structuredClone(capturedBodies[index]), String(url)));
  };
}

test('manifest discovers the changing ID and discards editor metadata', () => {
  const parsed = parsePromotionManifest(manifest());
  assert.deepEqual(parsed.layouts[0], { layoutId, title: '스페셜딜', ...window });
  assert.equal(JSON.stringify(parsed).includes('DO_NOT_EXPORT'), false);
  assert.throws(() => parsePromotionManifest('<html>login</html>'), { code: 'MANIFEST_SCHEMA' });
});

test('Korean campaign expiry is exact; unknown shipping is not free', () => {
  assert.equal(koreanDate('2026-09-21T10:59:59'), window.endAt);
  const p = page(1, [123]);
  const active = parseDealPage(p, { layoutId, page: 1, window, checkedAt: window.endAt })[0];
  assert.equal(active.status, 'listed_active');
  assert.equal(active.deliveryFee, null);
  assert.equal(active.checkoutPriceVerified, false);
  assert.equal(parseDealPage(p, { layoutId, page: 1, window, checkedAt: '2026-09-21T02:00:00Z' })[0].status, 'expired');
});

test('pagination stops on hasNext false, deduplicates and never sends credentials', async () => {
  const calls = [];
  const result = await collectTodayDeals({ now, fetchImpl: async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.redirect, 'manual');
    if (calls.length === 1) return response(manifest(), 'text/html');
    return response(calls.length === 2 ? page(1, [123, 124], true) : page(2, [124, 125]));
  } });
  assert.equal(result.complete, true); assert.equal(result.productCount, 3); assert.equal(result.duplicateCount, 1);
  assert.equal(result.layouts[0].pages, 2);
  assert.match(calls[1], /first=&page=1&type=VIEW$/);
  assert.match(calls[2], /\?page=2&type=VIEW$/);
});

test('page budget is reported as incomplete, not a complete catalog', async () => {
  let calls = 0;
  const result = await collectTodayDeals({ now, maxPages: 1, fetchImpl: async () => ++calls === 1 ? response(manifest(), 'text/html') : response(page(1, [123], true)) });
  assert.equal(result.complete, false); assert.equal(result.layouts[0].stopReason, 'max_pages');
});

test('200 HTML challenge, 418 and wrong page/layout fail closed', async () => {
  for (const [type, status, code] of [['text/html', 200, 'HTTP_OR_CONTENT_TYPE'], ['text/html', 418, 'WAF_BLOCKED']]) {
    let calls = 0;
    await assert.rejects(collectTodayDeals({ now, fetchImpl: async () => ++calls === 1 ? response(manifest(), 'text/html') : response('<html>challenge</html>', type, status) }), { code });
  }
  assert.throws(() => parseDealPage(page(2, [123]), { layoutId, page: 1, checkedAt: now().toISOString(), window }), { code: 'PAGE_SCHEMA' });
  assert.throws(() => parseDealPage(page(1, [123]), { layoutId: 'wrong', page: 1, checkedAt: now().toISOString(), window }), { code: 'PAGE_SCHEMA' });
});

test('repeated nonterminal page cannot loop or report success', async () => {
  let calls = 0;
  await assert.rejects(collectTodayDeals({ now, fetchImpl: async () => {
    calls++;
    return calls === 1 ? response(manifest(), 'text/html') : response(page(calls - 1, [123], true));
  } }), { code: 'PAGINATION_NO_PROGRESS' });
  assert.equal(calls, 3);
});

test('real null-waffle manifest discovers all eight WAFFLE tabs and validates IDs', () => {
  const manifest = parsePromotionManifest(v3Manifest(captured.tabList));
  assert.equal(manifest.tabs.length, 8);
  assert.equal(manifest.tabs[0].title, '스페셜딜');
  assert.equal(manifest.layouts.length, 0);
  assert.throws(() => parsePromotionManifest(v3Manifest([{ ...capturedTabs[0], id: '../escape', uid: '../escape' }])), { code: 'TAB_SCHEMA' });
  assert.throws(() => parsePromotionManifest('<script id="__NEXT_DATA__">{"props":{}}</script>'), { code: 'MANIFEST_SCHEMA' });
});

test('captured V3 card fields preserve channel ID, prices, image, shipping and Korean expiry', () => {
  const data = captured.productPages[1];
  const options = { layoutId: '6abb35ecfbd22f2268829bef', page: 1, checkedAt: v3Now().toISOString(), window: { startAt: null, endAt: '2026-10-11T01:59:59.000Z', dataConditionType: 'AUTO_SORT', totalCount: 68 } };
  const items = parseDealPage(data, options);
  assert.equal(items[0].productId, '13413014188');
  assert.notEqual(items[0].productId, String(data.products[0].productMeta.productNo));
  assert.equal(items[0].salePrice, 79000);
  assert.equal(items[0].discountedPrice, 18900);
  assert.equal(items[0].displayDiscountPercent, 76);
  assert.equal(items[0].url, 'https://smartstore.naver.com/main/products/13413014188');
  assert.match(items[0].imageUrl, /^https:\/\/shop-phinf\.pstatic\.net\//);
  assert.equal(items[0].deliveryFee, 0);
  assert.equal(items[0].isDeliveryFree, true);
  const timed = items.find(p => p.saleEndAt);
  assert.equal(timed.productId, '12333638362');
  assert.equal(timed.saleEndAt, '2026-10-11T01:59:59.999Z');
  assert.equal(timed.campaignEndAt, '2026-10-11T01:59:59.000Z');
  assert.equal(timed.status, 'listed_active');
  assert.equal(parseDealPage(data, { ...options, checkedAt: '2026-10-11T02:00:00Z' })[0].status, 'expired');
  assert.throws(() => parseDealPage({ ...data, paginationInfo: { ...data.paginationInfo, pageNo: 2 } }, options), { code: 'PAGE_SCHEMA' });
  const unsafe = structuredClone(data); unsafe.products[0].productMeta.imageUrl = 'http://example.com/image.jpg';
  assert.throws(() => parseDealPage(unsafe, options), { code: 'PRODUCT_URL_SCHEMA' });
});

test('real responses replay special and brand tabs, deferred batches, manual cards and capped auto-sort pages', async () => {
  const calls = [];
  const result = await collectTodayDeals({ maxPages: 2, now: v3Now, fetchImpl: replayV3(calls) });
  assert.equal(calls.length, 10);
  assert.equal(result.productCount, 9);
  assert.equal(result.tabs.length, 2);
  assert.deepEqual(result.layouts.map(l => [l.dataConditionType, l.pages, l.returnedItems]), [['MANUAL', 1, 2], ['AUTO_SORT', 2, 5], ['AUTO_SORT', 1, 2]]);
  assert.equal(result.tabs[0].omittedLayerCount, 4);
  assert.equal(result.tabs[0].complete, false);
  assert.equal(result.tabs[1].complete, true);
  assert.equal(result.complete, false);
  assert.equal(result.layouts[1].stopReason, 'max_pages');
  for (const url of calls.filter(url => url.includes('/layers?'))) assert.ok(new URL(url).searchParams.get('layerCodes').split(',').length <= 3);
  assert.equal(result.products.every(p => p.imageUrl?.startsWith('https:')), true);
  assert.equal(result.products[0].itemGroupId, '6abdf46a14c78778b14fb040');
  assert.equal(result.scope, 'promotion_page_WAFFLE_tabs');
});

test('tab loop visits every discovered WAFFLE tab, retaining explicit empty-tab evidence', async () => {
  const requested = [];
  const all = captured.tabList.filter(t => t.tabType === 'WAFFLE');
  const result = await collectTodayDeals({ maxPages: 1, now: v3Now, fetchImpl: async (url, options) => {
    const value = String(url);
    if (value === 'https://shopping.naver.com/promotion') return response(v3Manifest(captured.tabList), 'text/html');
    if (value.includes('/pages/')) {
      const id = new URL(url).pathname.split('/').at(-1); requested.push(id);
      const page = structuredClone(captured.pages[0]); page.pageCode = id;
      page.layers = id === all[0].id ? page.layers.filter(l => l.bindStatus === 'BOUND') : [];
      return response(page);
    }
    return response(captured.productPages[0]);
  } });
  assert.deepEqual(requested, all.map(t => t.id));
  assert.equal(result.tabs.length, 8);
  assert.equal(result.tabs[1].stopReason, 'no_exposed_product_groups');
  assert.equal(result.productCount, 2);
});

test('cross-tab duplicates do not count as stalled pagination in a newly visited group', async () => {
  const calls = [];
  const base = replayV3(calls, (data, url) => {
    if (url.includes('6ac489ab07b88360a27a4ade/paginated-elements/')) {
      data.products = captured.productPages[1].products;
      data.paginationInfo.hasNext = true;
    }
    return data;
  });
  const result = await collectTodayDeals({ maxPages: 2, now: v3Now, fetchImpl: async (url, options) => {
    if (String(url).includes('6ac489ab07b88360a27a4ade/paginated-elements/') && new URL(url).searchParams.get('pageNo') === '2') {
      const data = structuredClone(captured.productPages[3]); data.paginationInfo.pageNo = 2;
      return response(data);
    }
    return base(url, options);
  } });
  assert.equal(result.duplicateCount, 3);
  assert.equal(result.productCount, 9);
  assert.equal(result.layouts[2].pages, 2);
});

test('an empty product group is skipped and named; malformed layers and a wholly empty catalog fail visibly', async () => {
  // One group answering an empty page with a positive total no longer drops every other group's deals (2026-10-11).
  const partial = await collectTodayDeals({ maxPages: 1, now: v3Now, fetchImpl: replayV3([], (data, url) => {
    if (url.includes('/manual-products?')) { data.products = []; data.paginationInfo.hasNext = false; }
    return data;
  }) }).catch(error => error);
  if (partial?.code) assert.equal(partial.code, 'EMPTY_DEALS'); // only when that group was the whole catalog
  else assert.ok(partial.layouts.some(layout => layout.stopReason === 'EMPTY_PRODUCT_PAGE'));
  await assert.rejects(collectTodayDeals({ maxPages: 1, now: v3Now, fetchImpl: replayV3([], (data, url) => {
    if (url.includes('/layers?')) return [{ ...captured.layerBatches[2][0], layoutId: '000000000000000000000000' }];
    return data;
  }) }), { code: 'LAYERS_SCHEMA' });
  await assert.rejects(collectTodayDeals({ now: v3Now, fetchImpl: async url => String(url).includes('/pages/') ? response({ ...captured.pages[0], layers: [] }) : response(v3Manifest([capturedTabs[0]]), 'text/html') }), { code: 'EMPTY_DEALS' });
});

test('2026-10-16 route: V3 requests use /v3/waffle-maker/v1, not the retired /v3/web/v1 or /v1/waffle-maker/layout', async () => {
  const calls = [];
  await collectTodayDeals({ maxPages: 1, now: v3Now, fetchImpl: replayV3(calls) });
  const api = calls.filter(url => url.startsWith('https://vertical-api.shopping.naver.com/'));
  assert.ok(api.length > 0);
  for (const url of api) assert.match(new URL(url).pathname, /^\/v3\/waffle-maker\/v1\/waffle-promotion\//);
});

test('WAF/rate-limit statuses stop the run without retries', async () => {
  for (const [status, code] of [[418, 'WAF_BLOCKED'], [429, 'RATE_LIMITED']]) {
    let apiCalls = 0;
    await assert.rejects(collectTodayDeals({ now: v3Now, fetchImpl: async url => {
      if (String(url) === 'https://shopping.naver.com/promotion') return response(v3Manifest(), 'text/html');
      apiCalls++; return response({}, 'application/json', status);
    } }), { code });
    assert.equal(apiCalls, 1);
  }
});

test('maxRequests caps the live request count', async () => {
  const calls = [];
  await assert.rejects(collectTodayDeals({ maxRequests: 2, now: v3Now, fetchImpl: replayV3(calls) }), { code: 'REQUEST_LIMIT' });
  assert.equal(calls.length, 2);
  await assert.rejects(collectTodayDeals({ maxRequests: 1 }), { code: 'REQUEST_LIMIT_INPUT' });
});
