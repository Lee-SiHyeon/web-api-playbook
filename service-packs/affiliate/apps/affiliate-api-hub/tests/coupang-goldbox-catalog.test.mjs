import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCoupangGoldboxWidgetPrices } from '../adapters/coupang-goldbox-widget.mjs';

const ORIGIN = 'https://www.coupang.com';
const PATH = '/vm/mlp/v1/newweb/mlp-widget-landing';

function detailUrl(productId, itemId, vendorItemId, extra = '') {
  return `${ORIGIN}/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}${extra}`;
}

function product(productId, itemId = productId + 1000, vendorItemId = productId + 2000, over = {}) {
  return {
    productId, itemId, vendorItemId,
    productTitle: `Product ${productId}`,
    detailUrl: detailUrl(productId, itemId, vendorItemId, '&sourceType=gm_crm_goldbox'),
    productImageUrl: '//thumbnail.coupangcdn.com/thumbnails/item.png',
    finalPrice: { value: '8,000원', unitPriceText: '(개당 8,000원)' },
    originalPrice: '10,000원',
    wowPrice: { boxEnabled: true, iconUrl: '//image.coupangcdn.com/wow.png', label: '할인가', price: '7,000원' },
    stockRemainingInfo: { isSoldOut: false, text: null },
    ...over,
  };
}

function nextPageUrl({ pageKey = '2', productOffset = '99' } = {}) {
  const url = new URL(PATH, ORIGIN);
  for (const [key, value] of [
    ['widgetId', '43145'], ['isAsync', 'Y'], ['trafficType', 'organic'], ['landingId', '3712'],
    ['target', 'MLP_GOLDBOX'], ['productOffset', productOffset], ['sourceType', 'gm_crm_goldbox'],
    ['isMLP', 'Y'], ['nextWidgetPageKey', pageKey], ['categoryId', '0'], ['subSourceType', 'gm_crm_gwsrtcut'],
  ]) url.searchParams.set(key, value);
  return url.href;
}

function widgetResponse(list, dataUrl = null) {
  return new Response(JSON.stringify({ rCode: 'RET0000', rData: { widgets: [{
    type: 'product', props: { config: { id: '43145', pageId: 3712 }, data: { list, dataUrl } },
  }] } }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function fetchFixture(pages, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.pathname === '/n-api/web-adapter/proxy') {
      return new Response('<html><title>web-adapter-proxy</title>getLocalStorage</html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'PCID=public-visitor; Domain=.coupang.com; Path=/; Secure; SameSite=Lax',
        },
      });
    }
    assert.equal(url.pathname, PATH);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.headers.cookie);
    assert.equal(Object.hasOwn(options.headers, 'user-agent'), false);
    const pageNumber = Number(url.searchParams.get('nextWidgetPageKey'));
    const page = pages[pageNumber - 1];
    if (!page) return new Response('missing fixture page', { status: 500 });
    return widgetResponse(page.rows, page.dataUrl ?? null);
  };
  return { fetchImpl, calls, status };
}

test('catalog mode reads a complete widget page and normalizes prices, URL, image, title, and stock', async () => {
  const item = product(101, 1101, 2101, { stockRemainingInfo: { isSoldOut: true, text: '판매 종료' } });
  const fixture = fetchFixture([{ rows: [item] }]);
  const result = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl: fixture.fetchImpl, pageDelayMs: 0 });

  assert.equal(fixture.calls.length, 2, 'one public bootstrap plus one widget page');
  const request = fixture.calls[1].options;
  assert.deepEqual(Object.keys(request.headers).sort(), ['accept', 'cookie', 'coupang-app', 'modular-front', 'referer', 'x-coupang-accept-language'].sort());
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.receipt.catalogMode, true);
  assert.equal(result.receipt.paginationExhausted, true);
  assert.equal(result.receipt.coverage.catalogPageRowsSeen, 1);
  assert.equal(result.receipt.coverage.catalogUniqueTriples, 1);
  assert.equal(result.receipt.coverage.catalogReturnedRows, 1);
  assert.equal(result.receipt.coverage.catalogCoverageComplete, true);
  assert.deepEqual(result.receipt.pages[0].queryKeys, [
    'widgetId', 'isAsync', 'trafficType', 'landingId', 'target', 'productOffset', 'sourceType', 'isMLP',
    'nextWidgetPageKey', 'categoryId', 'subSourceType',
  ]);
  assert.equal(Object.hasOwn(result.receipt.pages[0], 'dataUrl'), false);
  assert.equal(JSON.stringify(result.receipt).includes('public-visitor'), false);

  const row = result.rows[0];
  assert.equal(row.productTitle, 'Product 101');
  assert.equal(row.productUrl, `${ORIGIN}/vp/products/101?itemId=1101&vendorItemId=2101`);
  assert.equal(row.productUrlStatus, 'verified_consumer_url');
  assert.equal(row.imageUrl, 'https://thumbnail.coupangcdn.com/thumbnails/item.png');
  assert.equal(row.soldOut, true);
  assert.equal(Object.hasOwn(row, 'reviews'), false);
  assert.equal(Object.hasOwn(row, 'reviewRating'), false);
  assert.equal(row.generalPrice.amount, 8000);
  assert.equal(row.originalPrice.amount, 10000);
  assert.equal(row.wowSalePrice, 7000);
  assert.equal(row.advertisedWowPrice.label, '할인가');
});

test('catalog pagination follows only returned dataUrl, deduplicates exact triples, and excludes conflicts', async () => {
  const a = product(201, 1201, 2201);
  const b = product(202, 1202, 2202);
  const conflictingB = product(202, 1202, 2202, { finalPrice: { value: '9,000원' } });
  const trip = product(203, 1203, 2203, {
    productTitle: '', detailUrl: 'https://trip.coupang.com/redirect?ref=public',
    wowPrice: { boxEnabled: true, label: '가입 쿠폰가', price: '6,500원' },
  });
  const mismatched = product(204, 1204, 2204, {
    detailUrl: detailUrl(999, 1204, 2204),
  });
  const invalid = { productId: 0, itemId: 1, vendorItemId: 2, productTitle: 'invalid identity' };
  const fixture = fetchFixture([
    { rows: [a, { ...a }, b], dataUrl: nextPageUrl() },
    { rows: [conflictingB, trip, mismatched, invalid] },
  ]);
  const result = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl: fixture.fetchImpl, pageDelayMs: 0 });

  assert.equal(fixture.calls.filter(call => call.url.pathname === PATH).length, 2);
  assert.equal(fixture.calls[2].url.searchParams.get('nextWidgetPageKey'), '2');
  assert.equal(result.receipt.paginationExhausted, true);
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.receipt.coverage.catalogUniqueTriples, 4);
  assert.equal(result.receipt.coverage.catalogDuplicateRows, 2);
  assert.equal(result.receipt.coverage.catalogConflictingTriples, 1);
  assert.equal(result.receipt.coverage.invalidIdentityRows, 1);
  assert.deepEqual(result.rows.map(row => row.productId).sort(), ['201', '203', '204']);
  const tripRow = result.rows.find(row => row.productId === '203');
  assert.equal(tripRow.productTitle, null);
  assert.equal(tripRow.productUrl, null);
  assert.equal(tripRow.productUrlStatus, 'tracking_redirect_unresolved');
  assert.equal(tripRow.conditionalCouponPrice.amount, 6500);
  assert.equal(tripRow.wowSalePrice, null);
  assert.equal(result.rows.find(row => row.productId === '204').productUrl, null);
  assert.equal(result.rows.find(row => row.productId === '204').productUrlStatus, 'detail_url_identity_mismatch');
  assert.equal(JSON.stringify(result.receipt).includes('redirect?ref='), false);
});

test('catalog page cap returns bounded rows and marks inventory coverage partial', async () => {
  const fixture = fetchFixture([{ rows: [product(301)], dataUrl: nextPageUrl() }]);
  const result = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl: fixture.fetchImpl,
    maxPages: 1, pageDelayMs: 0 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.receipt.pageCount, 1);
  assert.equal(result.receipt.stopReason, 'page_cap');
  assert.equal(result.receipt.paginationExhausted, false);
  assert.equal(result.receipt.coverage.catalogScanComplete, false);
  assert.equal(result.receipt.coverage.catalogCoverageComplete, false);
  assert.equal(result.receipt.status, 'partial');
});

test('catalog distinguishes absent, malformed, and unclassified advertised WOW prices', async () => {
  const absent = product(401);
  delete absent.wowPrice;
  const emptyObject = product(402, 1402, 2402, { wowPrice: {} });
  const wrongType = product(403, 1403, 2403, { wowPrice: '6,000원' });
  const emptyLabel = product(404, 1404, 2404, { wowPrice: { label: '   ', price: '6,000원' } });
  const missingPrice = product(405, 1405, 2405, { wowPrice: { label: '할인가' } });
  const invalidAmount = product(406, 1406, 2406, { wowPrice: { label: '할인가', price: '0원' } });
  const unknownLabel = product(407, 1407, 2407, { wowPrice: { label: '특별 구성가', price: '6,000원' } });
  const fixture = fetchFixture([{ rows: [absent, emptyObject, wrongType, emptyLabel, missingPrice, invalidAmount, unknownLabel] }]);
  const result = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl: fixture.fetchImpl, pageDelayMs: 0 });
  const rows = new Map(result.rows.map(row => [row.productId, row]));

  assert.equal(rows.get('401').advertisedPriceReadStatus, 'absent');
  assert.equal(rows.get('401').advertisedWowPrice, null);
  for (const id of ['402', '403', '404', '405', '406']) {
    assert.equal(rows.get(id).advertisedPriceReadStatus, 'invalid');
    assert.equal(rows.get(id).advertisedWowPrice, null);
  }
  assert.equal(rows.get('407').advertisedPriceReadStatus, 'valid');
  assert.equal(rows.get('407').advertisedWowPrice.amount, 6000);
  assert.equal(rows.get('407').wowSalePrice, null);
  assert.equal(rows.get('407').conditionalCouponPrice, null);
  assert.equal(result.receipt.coverage.invalidAdvertisedPriceRows, 5);
  assert.equal(result.receipt.coverage.unclassifiedAdvertisedPriceRows, 1);
  assert.equal(result.receipt.coverage.catalogCoverageComplete, false);
  assert.equal(result.receipt.coverage.catalogSpecialPriceClassificationComplete, false);
  assert.equal(result.receipt.status, 'partial');
});

test('genuinely absent advertised WOW price is valid catalog coverage', async () => {
  const item = product(408);
  delete item.wowPrice;
  const fixture = fetchFixture([{ rows: [item] }]);
  const result = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl: fixture.fetchImpl, pageDelayMs: 0 });
  assert.equal(result.rows[0].advertisedPriceReadStatus, 'absent');
  assert.equal(result.receipt.coverage.invalidAdvertisedPriceRows, 0);
  assert.equal(result.receipt.coverage.unclassifiedAdvertisedPriceRows, 0);
  assert.equal(result.receipt.coverage.catalogSpecialPriceClassificationComplete, true);
  assert.equal(result.receipt.coverage.catalogCoverageComplete, true);
  assert.equal(result.receipt.status, 'complete');
});

test('unknown nonempty advertised label remains valid but exposes incomplete classification separately', async () => {
  const item = product(409, 1409, 2409, { wowPrice: { label: '오늘만 구성가', price: '6,000원' } });
  const fixture = fetchFixture([{ rows: [item] }]);
  const result = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl: fixture.fetchImpl, pageDelayMs: 0 });
  assert.equal(result.rows[0].advertisedPriceReadStatus, 'valid');
  assert.equal(result.rows[0].advertisedWowPrice.label, '오늘만 구성가');
  assert.equal(result.rows[0].wowSalePrice, null);
  assert.equal(result.receipt.coverage.invalidAdvertisedPriceRows, 0);
  assert.equal(result.receipt.coverage.unclassifiedAdvertisedPriceRows, 1);
  assert.equal(result.receipt.coverage.catalogCoverageComplete, true);
  assert.equal(result.receipt.coverage.catalogSpecialPriceClassificationComplete, false);
  assert.equal(result.receipt.status, 'complete');
});

test('catalog mode caps its returned public inventory at 1000 unique triples', async () => {
  const makeRows = start => Array.from({ length: 500 }, (_, i) => product(start + i, start + i + 10000, start + i + 20000));
  const fixture = fetchFixture([
    { rows: makeRows(1000), dataUrl: nextPageUrl({ pageKey: '2', productOffset: '500' }) },
    { rows: makeRows(1500), dataUrl: nextPageUrl({ pageKey: '3', productOffset: '1000' }) },
    { rows: makeRows(2000) },
  ]);
  const result = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl: fixture.fetchImpl, pageDelayMs: 0 });
  assert.equal(result.rows.length, 1000);
  assert.equal(result.receipt.pageCount, 3);
  assert.equal(result.receipt.stopReason, 'catalog_row_cap');
  assert.equal(result.receipt.coverage.catalogUniqueTriples, 1000);
  assert.equal(result.receipt.coverage.catalogScanComplete, false);
  assert.equal(result.receipt.status, 'partial');
});
