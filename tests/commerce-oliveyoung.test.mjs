import test from 'node:test';
import assert from 'node:assert/strict';
import { createOliveyoungCommerceClient } from '../lib/commerce/oliveyoung.mjs';

const SESSION = { authorization: 'synthetic-oliveyoung-token-for-tests' };
const GOOD = {
  goodsNumber: 'A000000123456',
  goodsName: '테스트 수분크림',
  originalPrice: 19_900,
  priceToPay: 15_900,
  discountRate: 20,
  soldOutFlag: false,
  displayCategory: { leafCategoryNumber: 10000010001 },
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function searchClient({ payload, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    return json(payload ?? { code: 200, data: [{ goods: GOOD, generatedActivity: null }], pagination: {} }, status);
  };
  return { calls, client: createOliveyoungCommerceClient({ session: SESSION, fetchImpl,
    now: () => new Date('2026-10-05T00:00:00.000Z') }) };
}

test('OliveYoung product search uses the existing Curator XHR contract and separates KRW current and list prices', async () => {
  const { calls, client } = searchClient();
  const result = await client.searchProducts({ keyword: '수분크림', pageNumber: 0, pageSize: 10 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://m.oliveyoung.co.kr');
  assert.equal(calls[0].url.pathname, '/review/api/affiliate/v1/activities/search');
  assert.deepEqual([...calls[0].url.searchParams], [
    ['keyword', '수분크림'], ['pageNumber', '0'], ['pageSize', '10'],
  ]);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Authorization, SESSION.authorization);
  assert.equal(calls[0].init.headers.Cookie, undefined);

  assert.deepEqual(result.products, [{
    productId: 'A000000123456',
    title: '테스트 수분크림',
    url: 'https://m.oliveyoung.co.kr/m/goods/getGoodsDetail.do?goodsNo=A000000123456',
    price: { amount: '15900', currency: 'KRW', minorUnitExponent: 0,
      kind: 'retail_current', sourceField: 'goods.priceToPay' },
    listPrice: { amount: '19900', currency: 'KRW', minorUnitExponent: 0,
      kind: 'retail_list', sourceField: 'goods.originalPrice' },
    discountRate: '20',
    availability: 'available',
    categoryNumber: '10000010001',
  }]);
  assert.deepEqual(result.requestedPage, { pageNumber: 0, pageSize: 10 });
  assert.equal(result.pagination, null);
  assert.equal(result.paginationVerified, false);
  assert.equal(result.receipt.request.httpStatus, 200);
  assert.equal(result.receipt.request.mime, 'application/json');
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.request.credentialsUsed, true);
  assert.equal(result.receipt.contractProvenance.kind, 'first_party_web_bundle_source');
  assert.equal(JSON.stringify(result.receipt).includes('수분크림'), false);
  assert.equal(JSON.stringify(result).includes(SESSION.authorization), false);
});

test('search accepts only bounded search inputs and requires a scoped session', async () => {
  assert.throws(() => createOliveyoungCommerceClient({}), { code: 'OLIVEYOUNG_SESSION_REQUIRED' });
  let calls = 0;
  const client = createOliveyoungCommerceClient({ session: SESSION, fetchImpl: async () => {
    calls++;
    throw new Error('unexpected request');
  } });
  for (const input of [
    { keyword: '' }, { keyword: '   ' }, { keyword: 'x'.repeat(201) },
    { keyword: '크림', pageNumber: -1 }, { keyword: '크림', pageSize: 0 },
    { keyword: '크림', pageSize: 51 },
  ]) await assert.rejects(client.searchProducts(input));
  assert.equal(calls, 0);
});

test('bad prices, unsafe product identifiers, and non-boolean stock flags fail closed', async () => {
  const cases = [
    { ...GOOD, priceToPay: '15,900' },
    { ...GOOD, priceToPay: -1 },
    { ...GOOD, goodsNumber: '../other' },
    { ...GOOD, soldOutFlag: 'false' },
  ];
  for (const goods of cases) {
    const { client } = searchClient({ payload: { code: 200, data: [{ goods }], pagination: {} } });
    await assert.rejects(client.searchProducts({ keyword: '크림' }), error =>
      ['OLIVEYOUNG_PRICE_SCHEMA_INVALID', 'OLIVEYOUNG_PRODUCT_SCHEMA_INVALID'].includes(error.code));
  }
});

test('detail, reviews, photos, pagination and link writes fail closed without observed contracts', async () => {
  let calls = 0;
  const client = createOliveyoungCommerceClient({ session: SESSION, fetchImpl: async () => {
    calls++;
    throw new Error('unexpected request');
  } });
  await assert.rejects(client.getProduct({ goodsNumber: 'A000000123456' }),
    { code: 'OLIVEYOUNG_PRODUCT_DETAIL_XHR_UNVERIFIED' });
  await assert.rejects(client.getReviews({ goodsNumber: 'A000000123456', pageNumber: 1 }),
    { code: 'OLIVEYOUNG_REVIEW_XHR_UNVERIFIED' });
  await assert.rejects(client.getReviewImages({ goodsNumber: 'A000000123456', reviewId: 'R123' }),
    { code: 'OLIVEYOUNG_REVIEW_IMAGES_XHR_UNVERIFIED' });
  await assert.rejects(client.searchAllProducts({ keyword: '크림', maxPages: 2 }),
    { code: 'OLIVEYOUNG_SEARCH_PAGINATION_XHR_UNVERIFIED' });
  await assert.rejects(client.createLink({ productId: 'A000000123456' }),
    { code: 'OLIVEYOUNG_ACTOR_BINDING_REQUIRED' });
  assert.equal(calls, 0);
});

test('unavailable and optional list prices stay distinct from current retail price', async () => {
  const goods = { ...GOOD, originalPrice: null, soldOutFlag: true, discountRate: null };
  const { client } = searchClient({ payload: { code: 200, data: [goods], pagination: {} } });
  const result = await client.searchProducts({ keyword: '크림' });
  assert.equal(result.products[0].price.amount, '15900');
  assert.equal(result.products[0].listPrice, null);
  assert.equal(result.products[0].discountRate, null);
  assert.equal(result.products[0].availability, 'unavailable');
});
