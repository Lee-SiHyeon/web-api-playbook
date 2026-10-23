import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, DanawaCollectorError, parseMallList, parseProductPage, parseTarget } from '../scripts/collectors/danawa.mjs';

const productHtml = `
<script>
var oGlobalSetting = {
  nProductCode: "18297722",
  sProductName: "삼성전자 990 PRO M.2 NVMe (2TB)",
  nCategoryCode1: "860",
  nCategoryCode2: "861",
};
var oPriceCompareSetting = {
  nProductCode: "18297722",
  sProductFullName: "삼성전자 990 PRO M.2 NVMe (2TB)",
};
</script>`;

const mallHtml = (shipping = '(배송비 2,750원)') => `
<h4>일반 전문몰 (10)</h4>
<div class="diff_item row" data-linkProduct="PCA04_123">
  <div class="d_mall"><img alt="메모리올"></div>
  <em class="prc_c">631,400</em>
  <span class="ship">${shipping}</span>
  <div class="info_line">삼성전자 990 PRO M.2 NVMe (2TB)</div>
</div>
<input type="hidden" value="end">`;

function response(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function job(sourceOfferId = 'danawa:18297722:PCA04') {
  return { id: '00000000-0000-4000-8000-000000000002', productId: '00000000-0000-4000-8000-000000000001',
    source: 'other', sourceOfferId, status: 'running', dueAt: '2026-10-07T22:00:00.000Z',
    attempts: 0, lastError: null, leaseToken: '00000000-0000-4000-8000-000000000003',
    leaseExpiresAt: '2026-10-07T22:10:00.000Z' };
}

test('Danawa target IDs require one exact product pcode and mall code', () => {
  assert.deepEqual(parseTarget('danawa:18297722:PCA04'), { pcode: '18297722', mallCode: 'PCA04' });
  for (const id of ['danawa:0:PCA04', 'danawa:18297722:', 'danawa:18297722:PCA04?url=x',
    'danawa:18297722:PCA04:other', 'https://prod.danawa.com/']) {
    assert.throws(() => parseTarget(id), (error) => error instanceof DanawaCollectorError && error.code === 'DANAWA_TARGET_INVALID');
  }
});

test('product and seller parsers preserve exact pcode, mall, price, and unknown shipping', () => {
  const product = parseProductPage(productHtml, '18297722');
  assert.equal(product.pcode, '18297722');
  assert.equal(product.name, '삼성전자 990 PRO M.2 NVMe (2TB)');
  assert.equal(product.form.pcode, '18297722');
  assert.throws(() => parseProductPage(productHtml, '18297723'), /DANAWA_PRODUCT_IDENTITY/);

  const known = parseMallList(mallHtml())[0];
  assert.equal(known.mall, '메모리올');
  assert.equal(known.mallCode, 'PCA04');
  assert.equal(known.price, 631400);
  assert.equal(known.shipping, 2750);
  assert.equal(known.couponRequired, false);

  const unknown = parseMallList(mallHtml('(배송비 별도)'))[0];
  assert.equal(unknown.shipping, null);
});

test('worker adapter reads only the exact product and mall, keeps shipping and stock evidence honest', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body, headers: init.headers });
    return response(calls.length === 1 ? productHtml : mallHtml());
  };
  const capturedIds = [];
  const outputs = await collect(job(), { signal: new AbortController().signal,
    createEventId: (base) => { capturedIds.push(base); return '00000000-0000-4000-8000-000000000004'; } },
  { fetchImpl, sleepImpl: async () => {}, now: () => new Date('2026-10-07T22:34:04.123Z') });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://prod.danawa.com/info/?pcode=18297722');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].url, 'https://prod.danawa.com/info/ajax/getAllPriceCompareMallList.ajax.php');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers.referer, 'https://prod.danawa.com/info/?pcode=18297722');
  assert.match(calls[1].body, /pcode=18297722/);
  assert.deepEqual(outputs[0], {
    eventId: '00000000-0000-4000-8000-000000000004',
    productId: '00000000-0000-4000-8000-000000000001', source: 'other',
    sourceOfferId: 'danawa:18297722:PCA04', seller: '메모리올', itemPrice: 631400,
    shipping: 2750, currency: 'KRW', conditions: [], stock: 'unknown',
    observedAt: '2026-10-07T22:34:04.123Z', validUntil: '2026-10-08T04:34:04.123Z',
    merchantUrl: 'https://prod.danawa.com/info/?pcode=18297722',
  });
  assert.equal(capturedIds.length, 1);
  assert.equal(capturedIds[0].shipping, 2750);
  assert.equal(capturedIds[0].stock, 'unknown');
});

test('adapter rejects ambiguous, coupon-only, and provider-blocked rows without fallback', async () => {
  await assert.rejects(collect(job(), { signal: new AbortController().signal,
    createEventId: () => '00000000-0000-4000-8000-000000000004' },
  { fetchImpl: async (_url, init) => response(init.method === 'GET' ? productHtml
      : '<h4>일반 전문몰</h4><div class="diff_item" data-linkProduct="PCA04_123"><div class="d_mall"><img alt="메모리올"></div><em class="prc_c">600,000</em><span class="ship">무료배송</span><div class="info_line">단품</div></div><div class="diff_item" data-linkProduct="PCA04_124"><div class="d_mall"><img alt="메모리올"></div><em class="prc_c">610,000</em><span class="ship">무료배송</span><div class="info_line">다른 조건</div></div>'),
    sleepImpl: async () => {}, now: () => new Date('2026-10-07T22:34:04.123Z') }),
    (error) => error instanceof DanawaCollectorError && error.code === 'DANAWA_OFFER_AMBIGUOUS');

  await assert.rejects(collect(job(), { signal: new AbortController().signal,
    createEventId: () => '00000000-0000-4000-8000-000000000004' },
  { fetchImpl: async (_url, _init) => response(_init.method === 'GET' ? productHtml
      : mallHtml().replace('<div class="info_line">', '<div class="coupon">쿠폰</div><div class="info_line">')),
    sleepImpl: async () => {}, now: () => new Date('2026-10-07T22:34:04.123Z') }),
  (error) => error instanceof DanawaCollectorError && error.code === 'DANAWA_GENERAL_OFFER_UNAVAILABLE');

  await assert.rejects(collect(job(), { signal: new AbortController().signal,
    createEventId: () => '00000000-0000-4000-8000-000000000004' },
  { fetchImpl: async (_url, init) => response(init.method === 'GET' ? productHtml : '', 429),
    sleepImpl: async () => {}, now: () => new Date('2026-10-07T22:34:04.123Z') }),
  (error) => error instanceof DanawaCollectorError && error.code === 'DANAWA_RATE_LIMITED');
});

test('refresh never merges equal-priced distinct marketplace listings into a successful offer', async () => {
  const equalPriced = mallHtml().replace('PCA04_123', 'PCA04_456');
  await assert.rejects(collect(job(), { signal: new AbortController().signal,
    createEventId: () => '00000000-0000-4000-8000-000000000004' },
  { fetchImpl: async (_url, init) => response(init.method === 'GET' ? productHtml : mallHtml() + equalPriced),
    sleepImpl: async () => {} }),
  (error) => error instanceof DanawaCollectorError && error.code === 'DANAWA_OFFER_AMBIGUOUS');
});

test('refresh deduplicates truly identical rows without changing observation evidence', async () => {
  const context = { signal: new AbortController().signal,
    createEventId: () => '00000000-0000-4000-8000-000000000004' };
  const result = await collect(job(), context, {
    fetchImpl: async (_url, init) => response(init.method === 'GET' ? productHtml : mallHtml() + mallHtml()),
    sleepImpl: async () => {},
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].itemPrice, 631400);
  assert.equal(result[0].shipping, 2750);
});
