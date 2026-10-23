import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCoupangGoldboxWidgetPrices,
  normalizeCoupangGoldboxWidgetRow,
} from '../adapters/coupang-goldbox-widget.mjs';

const cookieSentinel = 'widget-visitor-sentinel-not-for-output';
const markerSession = 'guest-session-sentinel-not-for-output';
const markerVisit = 'page-visit-sentinel-not-for-output';
const markerBottomVids = 'abc123ABC_-def456XYZ_89';
const a = { productId: '8174473713', itemId: '26504519093', vendorItemId: '91458195016' };
const b = { productId: '9171562099', itemId: '27031173509', vendorItemId: '93999717143' };
const firstUrl = 'https://www.coupang.com/vm/mlp/v1/newweb/mlp-widget-landing';

const firstTarget = () => {
  const url = new URL(firstUrl);
  for (const [key, value] of [
    ['widgetId', '43145'], ['isAsync', 'Y'], ['trafficType', 'organic'], ['landingId', '3712'],
    ['target', 'MLP_GOLDBOX'], ['productOffset', '0'], ['sourceType', 'gm_crm_goldbox'], ['isMLP', 'Y'],
    ['nextWidgetPageKey', '1'], ['categoryId', '0'], ['subSourceType', 'gm_crm_gwsrtcut'],
  ]) url.searchParams.set(key, value);
  return url.href;
};

function bootstrapResponse() {
  return new Response('<html><title>web-adapter-proxy</title>getLocalStorage</html>', {
    headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `PCID=${cookieSentinel}; Domain=.coupang.com; Path=/; Secure` },
  });
}

function row(ids = a, overrides = {}) {
  return {
    ...ids,
    productTitle: '제로, 350ml, 24개',
    finalPrice: { unitPriceText: '(100ml당 232원)', value: '19,480원' },
    originalPrice: '25,700원',
    wowPrice: { boxEnabled: true,
      iconUrl: 'https://thumbnail.coupangcdn.com/thumbnails/remote/q89/image/wow.png',
      label: '할인가', price: '15,480원', dimmed: false },
    ...overrides,
  };
}

function payload(list, dataUrl) {
  const data = { list };
  if (dataUrl !== undefined) data.dataUrl = dataUrl;
  return { rCode: 'RET0000', rData: { widgets: [{ type: 'product', props: {
    config: { id: '43145', pageId: 3712 }, data,
  } }] }, rMessage: null };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

test('reads the exact public widget contract and preserves its explicit WOW and general prices', async () => {
  const calls = [];
  const target = firstTarget();
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/n-api/web-adapter/proxy')) return bootstrapResponse();
    assert.equal(String(url), target);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.accept, 'application/json, text/plain, */*');
    assert.equal(options.headers['x-coupang-accept-language'], 'ko-KR');
    assert.equal(options.headers['coupang-app'], '');
    assert.equal(options.headers['modular-front'], '');
    assert.equal(options.headers.referer,
      'https://www.coupang.com/mlp/web/mlp-landing-page?landingId=3712&sourceType=gm_crm_goldbox&subSourceType=gm_crm_gwsrtcut');
    assert.ok(options.headers.cookie.includes(`PCID=${cookieSentinel}`));
    return jsonResponse(payload([
      row(),
      row({ ...a, vendorItemId: '91458195017' }, { wowPrice: { label: '할인가', price: '1원' } }),
      row({ ...a, itemId: '26504519094', vendorItemId: '91458195018' }, { wowPrice: { label: '할인가', price: '2원' } }),
    ], '/vm/mlp/v1/newweb/mlp-widget-landing?widgetId=43145&isAsync=Y&trafficType=organic&landingId=3712&target=MLP_GOLDBOX&productOffset=100&sourceType=gm_crm_goldbox&gbpSessionKey=opaqueMarker&isMLP=Y&pageVisitId=opaquePage&nextWidgetPageKey=2&categoryId=0&subSourceType=gm_crm_gwsrtcut'));
  };
  const result = await fetchCoupangGoldboxWidgetPrices({ productKeys: [a], fetchImpl, pageDelayMs: 0 });
  assert.equal(calls.length, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].productTitle, '제로, 350ml, 24개');
  assert.equal(result.rows[0].generalPrice.amount, 19480);
  assert.equal(result.rows[0].originalPrice.amount, 25700);
  assert.equal(result.rows[0].advertisedWowPrice.amount, 15480);
  assert.equal(result.rows[0].advertisedWowPrice.label, '할인가');
  assert.equal(result.rows[0].wowSalePrice, 15480);
  assert.equal(result.rows[0].conditionalCouponPrice, null);
  assert.equal(result.rows[0].memberPriceVerified, false);
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.receipt.coverage.exactSkuMismatchesExcluded, 2);
  assert.equal(result.receipt.pages[0].queryKeys.includes('gbpSessionKey'), false);
  assert.equal(JSON.stringify(result).includes(cookieSentinel), false);
  assert.equal(JSON.stringify(result).includes('opaqueMarker'), false);
  assert.equal(JSON.stringify(result).includes('opaquePage'), false);
});

test('follows the exact server-issued next URL and keeps its visit markers out of receipts', async () => {
  const calls = [];
  const target2 = new URL(firstUrl);
  for (const [key, value] of [
    ['widgetId', '43145'], ['isAsync', 'Y'], ['trafficType', 'organic'], ['landingId', '3712'],
    ['target', 'MLP_GOLDBOX'], ['productOffset', '100'], ['sourceType', 'gm_crm_goldbox'],
    ['gbpSessionKey', markerSession], ['isMLP', 'Y'], ['pageVisitId', markerVisit],
    ['gbpBottomVids', markerBottomVids],
    ['nextWidgetPageKey', '2'], ['categoryId', '0'], ['subSourceType', 'gm_crm_gwsrtcut'],
  ]) target2.searchParams.set(key, value);
  const nextUrl = target2.pathname + target2.search;
  const fetchImpl = async (url, options) => {
    const href = String(url);
    calls.push({ href, options });
    if (href.endsWith('/n-api/web-adapter/proxy')) return bootstrapResponse();
    if (calls.length === 2) return jsonResponse(payload([row(a)], nextUrl));
    assert.equal(href, nextUrl.startsWith('http') ? nextUrl : `https://www.coupang.com${nextUrl}`);
    assert.equal(new URL(href).searchParams.get('gbpSessionKey'), markerSession);
    assert.equal(new URL(href).searchParams.get('pageVisitId'), markerVisit);
    assert.equal(new URL(href).searchParams.get('productOffset'), '100');
    assert.equal(new URL(href).searchParams.get('nextWidgetPageKey'), '2');
    return jsonResponse(payload([row(b)]));
  };
  const result = await fetchCoupangGoldboxWidgetPrices({ productKeys: [a, b], fetchImpl, pageDelayMs: 0 });
  assert.equal(calls.length, 3);
  assert.equal(result.rows.length, 2);
  assert.equal(result.receipt.pageCount, 2);
  assert.equal(result.receipt.requestCount, 3);
  assert.equal(result.receipt.stopReason, 'all_requested_triples_matched');
  assert.equal(result.receipt.paginationExhausted, true);
  assert.equal(JSON.stringify(result).includes(markerSession), false);
  assert.equal(JSON.stringify(result).includes(markerVisit), false);
  assert.equal(JSON.stringify(result).includes(markerBottomVids), false);
});

test('explicit null dataUrl is a terminal page and reports catalog exhaustion separately', async () => {
  const fetchImpl = async url => String(url).endsWith('/n-api/web-adapter/proxy')
    ? bootstrapResponse() : jsonResponse(payload([row(a)], null));
  const result = await fetchCoupangGoldboxWidgetPrices({ productKeys: [a], fetchImpl, pageDelayMs: 0 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.receipt.coverage.candidateCoverageComplete, true);
  assert.equal(result.receipt.coverage.catalogScanComplete, true);
  assert.equal(result.receipt.paginationExhausted, true);
});

test('a later-page scope failure preserves exact prices already read and marks both coverages', async () => {
  const calls = [];
  const badNext = new URL(firstTarget());
  badNext.searchParams.set('productOffset', '100');
  badNext.searchParams.set('nextWidgetPageKey', '2');
  badNext.searchParams.set('extra', 'reject-this-contract');
  const fetchImpl = async url => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith('/n-api/web-adapter/proxy')) return bootstrapResponse();
    return jsonResponse(payload([row(a)], badNext.pathname + badNext.search));
  };
  await assert.rejects(fetchCoupangGoldboxWidgetPrices({ productKeys: [a, b], fetchImpl, pageDelayMs: 0 }), error => {
    assert.equal(error.code, 'COUPANG_GOLDBOX_WIDGET_NEXT_URL');
    assert.equal(error.partialRows.length, 1);
    assert.equal(error.partialRows[0].productId, a.productId);
    assert.equal(error.receipt.coverage.matchedTriples, 1);
    assert.equal(error.receipt.coverage.unmatchedTriples, 1);
    assert.equal(error.receipt.coverage.candidateCoverageComplete, false);
    assert.equal(error.receipt.coverage.catalogScanComplete, false);
    assert.equal(error.receipt.states.live_replay, false);
    assert.equal(JSON.stringify(error.receipt).includes('reject-this-contract'), false);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('keeps a 가입 쿠폰가 separate and never presents it as a verified or unconditional WOW sale price', async () => {
  const coupon = row(a, { wowPrice: { boxEnabled: true, label: '가입 쿠폰가', price: '14,480원', dimmed: false } });
  const fetchImpl = async url => String(url).endsWith('/n-api/web-adapter/proxy')
    ? bootstrapResponse() : jsonResponse(payload([coupon]));
  const result = await fetchCoupangGoldboxWidgetPrices({ productKeys: [a], fetchImpl, pageDelayMs: 0 });
  const found = result.rows[0];
  assert.equal(found.advertisedWowPrice.amount, 14480);
  assert.equal(found.advertisedWowPrice.conditional, true);
  assert.equal(found.wowSalePrice, null);
  assert.equal(found.conditionalCouponPrice.label, '가입 쿠폰가');
  assert.equal(found.conditionalCouponPrice.eligibilityVerified, false);
  assert.equal(found.memberPriceVerified, false);
});

test('returns ordinary final price and no WOW price when the exact SKU has no wowPrice field', async () => {
  const ordinary = row(b, { productTitle: '프라이팬 28cm', finalPrice: { text: '할인', unitPriceText: '(1개당 12,300원)', value: '12,300원' },
    originalPrice: '16,800원', wowPrice: undefined });
  const fetchImpl = async url => String(url).endsWith('/n-api/web-adapter/proxy')
    ? bootstrapResponse() : jsonResponse(payload([ordinary]));
  const result = await fetchCoupangGoldboxWidgetPrices({ productKeys: [b], fetchImpl, pageDelayMs: 0 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].generalPrice.amount, 12300);
  assert.equal(result.rows[0].generalPrice.unitPriceText, '(1개당 12,300원)');
  assert.equal(result.rows[0].advertisedWowPrice, null);
  assert.equal(result.rows[0].wowSalePrice, null);
  assert.equal(result.rows[0].conditionalCouponPrice, null);
  assert.equal(result.receipt.coverage.ordinaryWowPriceRows, 0);
});

test('preserves unknown advertised price labels without reclassifying them as sale or coupon prices', () => {
  const parsed = normalizeCoupangGoldboxWidgetRow(row(a, {
    wowPrice: { boxEnabled: true, label: '카드 혜택가', price: '14,480원', dimmed: false },
  }));

  assert.equal(parsed.advertisedWowPrice.amount, 14480);
  assert.equal(parsed.advertisedWowPrice.label, '카드 혜택가');
  assert.equal(parsed.advertisedWowPrice.conditional, false);
  assert.equal(parsed.advertisedWowPrice.eligibilityVerified, false);
  assert.equal(parsed.wowSalePrice, null);
  assert.equal(parsed.conditionalCouponPrice, null);
  assert.equal(parsed.memberPriceVerified, false);
});

test('keeps disabled and dimmed widget price flags alongside the unverified advertised amount', () => {
  const cases = [
    { boxEnabled: false, dimmed: false },
    { boxEnabled: true, dimmed: true },
    { boxEnabled: false, dimmed: true },
  ];

  for (const flags of cases) {
    const parsed = normalizeCoupangGoldboxWidgetRow(row(a, {
      wowPrice: { ...flags, label: '할인가', price: '15,480원' },
    }));
    assert.equal(parsed.advertisedWowPrice.amount, 15480);
    assert.equal(parsed.advertisedWowPrice.label, '할인가');
    assert.equal(parsed.advertisedWowPrice.boxEnabled, flags.boxEnabled);
    assert.equal(parsed.advertisedWowPrice.dimmed, flags.dimmed);
    assert.equal(parsed.advertisedWowPrice.eligibilityVerified, false);
    assert.equal(parsed.memberPriceVerified, false);
  }
});

test('rejects zero, malformed, unsafe-integer, and oversized general and advertised amounts', () => {
  const invalidAmounts = [
    '0원', '-1원', '1.5원', '무료', '9,007,199,254,740,992원', `${'9'.repeat(48)}원`,
  ];

  for (const amount of invalidAmounts) {
    const parsed = normalizeCoupangGoldboxWidgetRow(row(a, {
      finalPrice: { value: amount },
      originalPrice: amount,
      wowPrice: { label: '할인가', price: amount },
    }));
    assert.equal(parsed.generalPrice, null, `general amount ${amount}`);
    assert.equal(parsed.originalPrice, null, `original amount ${amount}`);
    assert.equal(parsed.advertisedWowPrice, null, `advertised amount ${amount}`);
    assert.equal(parsed.wowSalePrice, null, `WOW amount ${amount}`);
    assert.equal(parsed.conditionalCouponPrice, null, `coupon amount ${amount}`);
  }
});

test('a conflicting duplicate SKU price is excluded and cursor values stay out of the receipt', async () => {
  const cursor = new URL(firstUrl);
  cursor.searchParams.set('widgetId', '43145');
  cursor.searchParams.set('landingId', '3712');
  cursor.searchParams.set('gbpSessionKey', 'duplicate-conflict-session-sentinel');
  cursor.searchParams.set('pageVisitId', 'duplicate-conflict-visit-sentinel');
  const first = row(a, { finalPrice: { value: '19,480원' } });
  const conflicting = row(a, { finalPrice: { value: '19,481원' } });
  let widgetReads = 0;
  const fetchImpl = async url => {
    if (String(url).endsWith('/n-api/web-adapter/proxy')) return bootstrapResponse();
    widgetReads++;
    return jsonResponse(payload([first, conflicting], cursor.pathname + cursor.search));
  };

  const result = await fetchCoupangGoldboxWidgetPrices({ productKeys: [a], fetchImpl, pageDelayMs: 0 });
  assert.equal(widgetReads, 1);
  assert.deepEqual(result.rows, []);
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.receipt.stopReason, 'conflicting_duplicate_rows');
  assert.equal(result.receipt.coverage.duplicateConflicts, 1);
  assert.equal(result.receipt.coverage.matchedTriples, 0);
  assert.equal(result.receipt.coverage.unmatchedTriples, 1);
  assert.equal(result.receipt.coverage.candidateCoverageComplete, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('duplicate-conflict-session-sentinel'), false);
  assert.equal(serialized.includes('duplicate-conflict-visit-sentinel'), false);
});

test('page cap returns explicit partial coverage and does not synthesize another cursor', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    if (String(url).endsWith('/n-api/web-adapter/proxy')) return bootstrapResponse();
    return jsonResponse(payload([row(a)], '/vm/mlp/v1/newweb/mlp-widget-landing?widgetId=43145&isAsync=Y&trafficType=organic&landingId=3712&target=MLP_GOLDBOX&productOffset=100&sourceType=gm_crm_goldbox&isMLP=Y&nextWidgetPageKey=2&categoryId=0&subSourceType=gm_crm_gwsrtcut'));
  };
  const result = await fetchCoupangGoldboxWidgetPrices({ productKeys: [a, b], fetchImpl, maxPages: 1, pageDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.receipt.stopReason, 'page_cap');
  assert.equal(result.receipt.coverage.matchedTriples, 1);
  assert.equal(result.receipt.coverage.unmatchedTriples, 1);
  assert.equal(result.receipt.pages.length, 1);
});

test('rejects an off-origin or malformed server next URL without requesting it', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    return String(url).endsWith('/n-api/web-adapter/proxy') ? bootstrapResponse()
      : jsonResponse(payload([], 'https://example.invalid/vm/mlp/v1/newweb/mlp-widget-landing?nextWidgetPageKey=2'));
  };
  await assert.rejects(fetchCoupangGoldboxWidgetPrices({ productKeys: [a], fetchImpl, pageDelayMs: 0 }), error => {
    assert.equal(error.code, 'COUPANG_GOLDBOX_WIDGET_NEXT_URL');
    assert.equal(error.receipt.stopReason, 'invalid_next_url');
    assert.equal(JSON.stringify(error.receipt).includes('example.invalid'), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('429 stops after the one failed widget read and emits a sanitized receipt', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    return String(url).endsWith('/n-api/web-adapter/proxy') ? bootstrapResponse() : new Response(null, { status: 429 });
  };
  await assert.rejects(fetchCoupangGoldboxWidgetPrices({ productKeys: [a], fetchImpl, pageDelayMs: 0 }), error => {
    assert.equal(error.code, 'COUPANG_GOLDBOX_WIDGET_RATE_LIMITED');
    assert.equal(error.receipt.httpStatus, 429);
    assert.equal(error.receipt.retry, false);
    assert.equal(error.receipt.requestCount, 2);
    assert.equal(JSON.stringify(error.receipt).includes(cookieSentinel), false);
    return true;
  });
  assert.equal(calls, 2);
});

test('bootstrap 429 is counted as a failed public visitor request and prevents the widget call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(null, { status: 429 }); };
  await assert.rejects(fetchCoupangGoldboxWidgetPrices({ productKeys: [a], fetchImpl, pageDelayMs: 0 }), error => {
    assert.equal(error.code, 'COUPANG_VISITOR_RATE_LIMITED');
    assert.equal(error.receipt.httpStatus, undefined);
    assert.equal(error.receipt.requestCount, 1);
    assert.equal(error.receipt.visitorBootstraps.length, 1);
    assert.equal(error.receipt.visitorBootstraps[0].status, 429);
    assert.equal(error.receipt.visitorBootstraps[0].retry, undefined);
    assert.equal(JSON.stringify(error.receipt).includes(cookieSentinel), false);
    return true;
  });
  assert.equal(calls, 1);
});
