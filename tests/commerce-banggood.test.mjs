import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBanggoodClient, BanggoodApiError } from '../lib/commerce/banggood.mjs';

const CREDENTIALS = { apiKey: 'test-api-key', apiSecret: 'test-api-secret' };
const TOKEN = 'unit-test-access-token';
const NOW = Date.parse('2026-10-05T00:00:00.000Z');

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function setup(route) {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    assert.equal(url.origin, 'https://affapi.banggood.com');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.has('cookie'), false);
    if (url.pathname === '/getAccessToken') {
      return jsonResponse({ code: 200, result: { access_token: TOKEN, expires_in: 7200 }, msg: '' });
    }
    assert.equal(init.headers.get('access-token'), TOKEN);
    return route(url, init);
  };
  return { requests, fetchImpl };
}

function productDetail(productId = '1094163') {
  return {
    code: 200,
    result: {
      product_id: Number(productId),
      category_id: 6536,
      product_url: `https://www.banggood.com/widget-p-${productId}.html?p=publisher-tracking-value`,
      product_name: 'Example product',
      warehouse_list: [
        { warehouse: 'CN', warehouse_price: 19.95, market_price: 20.95,
          sale_price: 20.95,
          sale_date_start: '2018-09-06 14:55:14',
          sale_date_end: '2018-10-06 14:55:14' },
        { warehouse: 'USA', warehouse_price: 24, market_price: 29.99 },
      ],
      small_image: 'https://imgaz2.staticbg.com/thumb/gallery/example.jpg',
      list_grid_image: 'https://imgaz2.staticbg.com/thumb/view/example.jpg',
      view_image: 'https://imgaz3.staticbg.com/thumb/list_grid/example.jpg',
      modify_date: '2026-10-04 10:00:00',
    },
    msg: '',
  };
}

test('uses the documented Banggood MD5 token signature and keeps the API secret off the wire', async () => {
  const documented = createHash('md5').update(
    'api_key=EZrwQGmWOOjxIfBV&api_secret=yrTdFSKftSmxRmAZQbkHMnJLLfvEXlWI&noncestr=5K8264ILTKCH16CQ2502SI8ZNMTM67VS&timestamp=1577169825',
  ).digest('hex');
  assert.equal(documented, 'c0a217e73345bccebc45f2c18714a831');

  const mock = setup(url => {
    assert.equal(url.pathname, '/product/category');
    return jsonResponse({ code: 200, result: [], msg: '' });
  });
  const client = createBanggoodClient({ ...CREDENTIALS, fetchImpl: mock.fetchImpl,
    now: () => NOW, nonceFactory: () => 'unit-test-nonce' });
  const result = await client.listCategories();
  const auth = mock.requests[0].url;
  assert.deepEqual([...auth.searchParams.keys()], ['api_key', 'noncestr', 'timestamp', 'signature']);
  assert.equal(auth.searchParams.get('api_key'), CREDENTIALS.apiKey);
  assert.equal(auth.searchParams.get('noncestr'), 'unit-test-nonce');
  assert.equal(auth.searchParams.get('timestamp'), String(NOW / 1000));
  const signBase = [
    `api_key=${CREDENTIALS.apiKey}`,
    `api_secret=${CREDENTIALS.apiSecret}`,
    'noncestr=unit-test-nonce',
    `timestamp=${NOW / 1000}`,
  ].join('&');
  assert.equal(auth.searchParams.get('signature'), createHash('md5').update(signBase).digest('hex'));
  assert.equal(auth.href.includes(CREDENTIALS.apiSecret), false);
  assert.equal(JSON.stringify(result).includes(CREDENTIALS.apiSecret), false);
  assert.equal(mock.requests[1].init.headers.get('access-token'), TOKEN);
  assert.equal(result.receipt.authenticated, true);
  assert.equal(result.receipt.request.path, '/product/category');
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.credentialBinding.persisted, false);
});

test('reads a product detail and keeps warehouse amounts explicitly in USD', async () => {
  const mock = setup(url => {
    assert.equal(url.pathname, '/product/detail');
    assert.deepEqual([...url.searchParams.entries()], [
      ['product_id', '1094163'], ['currency', 'EUR'], ['lang', 'de-DE'],
    ]);
    return jsonResponse(productDetail());
  });
  const client = createBanggoodClient({ ...CREDENTIALS, fetchImpl: mock.fetchImpl,
    now: () => NOW, nonceFactory: () => 'nonce-1' });
  const result = await client.getProduct({ productId: '1094163', currency: 'EUR', lang: 'de-DE' });
  assert.equal(result.productId, '1094163');
  assert.equal(result.requestedCurrency, 'EUR');
  assert.equal(result.warehousePriceCurrency, 'USD');
  assert.equal(result.warehouses[0].warehouse, 'CN');
  assert.deepEqual(result.warehouses[0].warehousePrice, { amount: '19.95', currency: 'USD', unit: 'decimal' });
  assert.deepEqual(result.warehouses[0].marketPrice, { amount: '20.95', currency: 'USD', unit: 'decimal' });
  assert.equal(result.warehouses[0].salePrice, 20.95);
  assert.deepEqual(result.warehouses[0].saleWindow, {
    startRaw: '2018-09-06 14:55:14',
    endRaw: '2018-10-06 14:55:14',
    documentedSampleFormat: 'YYYY-MM-DD HH:mm:ss',
    timezone: null,
    activeAtRead: null,
  });
  assert.equal(Object.hasOwn(result.warehouses[1], 'salePrice'), false);
  assert.equal(Object.hasOwn(result.warehouses[1], 'saleWindow'), false);
  assert.equal(result.productUrl, 'https://www.banggood.com/widget-p-1094163.html');
  assert.equal(JSON.stringify(result).includes('publisher-tracking-value'), false);
  assert.equal(result.receipt.capabilityId, 'catalog.product_detail');
  assert.equal(result.receipt.result.salePriceValueCount, 1);
  assert.equal(result.receipt.result.saleWindowCount, 1);
  assert.equal(result.receipt.result.saleTimingInterpretation, 'not_inferred');
});

test('searches documented keyword/category filters and preserves decimal price units', async () => {
  const mock = setup(url => {
    assert.equal(url.pathname, '/product/list');
    assert.equal(url.searchParams.get('keyword'), 'usb & charger');
    assert.equal(url.searchParams.get('category_id'), '1367');
    assert.equal(url.searchParams.get('currency'), 'USD');
    assert.equal(url.searchParams.has('page'), false);
    return jsonResponse({ code: 200, result: {
      page_total: 3,
      product_list: [{
        product_id: 8255,
        product_url: 'https://www.banggood.com/charger-p-8255.html?p=affiliate-value',
        category_id: 1367,
        product_name: 'USB charger',
        product_price: 'US$1,234.50',
        product_coupon_price: 'US$1,200.00',
        commission: 'US$12.34',
        coupon_name: 'Spring deal',
        coupon_code: 'SAFE-CODE',
        small_image: 'https://imgaz2.staticbg.com/charger.jpg',
        list_grid_image: 'https://imgaz2.staticbg.com/charger-grid.jpg',
        view_image: 'https://imgaz3.staticbg.com/charger-view.jpg',
        modify_date: '2026-10-04 08:00:00',
      }],
    }, msg: '' });
  });
  const client = createBanggoodClient({ ...CREDENTIALS, fetchImpl: mock.fetchImpl,
    now: () => NOW, nonceFactory: () => 'nonce-2' });
  const result = await client.listProducts({ keyword: 'usb & charger', categoryId: 1367 });
  assert.equal(result.pageTotal, 3);
  assert.deepEqual(result.pagination, { pageParameterDocumented: false, continuationAvailable: false });
  assert.deepEqual(result.products[0].price, { amount: '1234.50', currency: 'USD', unit: 'decimal' });
  assert.deepEqual(result.products[0].couponPrice, { amount: '1200.00', currency: 'USD', unit: 'decimal' });
  assert.equal(result.products[0].productUrl, 'https://www.banggood.com/charger-p-8255.html');
  assert.equal(result.receipt.capabilityId, 'catalog.product_search');
});

test('reads category trees whether the optional category filter returns an array or a single object', async () => {
  const mock = setup(url => {
    assert.equal(url.pathname, '/product/category');
    assert.equal(url.searchParams.get('category_id'), '2365');
    return jsonResponse({ code: 200, result: {
      category_id: '2365', category_name: 'Accessories',
      children: [{ category_id: 2367, category_name: 'Chargers', children: null }],
    }, msg: '' });
  });
  const client = createBanggoodClient({ ...CREDENTIALS, fetchImpl: mock.fetchImpl,
    now: () => NOW, nonceFactory: () => 'nonce-3' });
  const result = await client.listCategories({ categoryId: '2365' });
  assert.deepEqual(result.categories, [{ categoryId: '2365', name: 'Accessories',
    children: [{ categoryId: '2367', name: 'Chargers', children: [] }] }]);
});

test('rejects expired-token metadata outside the documented maximum without exposing credentials', async () => {
  const requests = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requests.push(url);
    return jsonResponse({ code: 200, result: { access_token: 'temporary', expires_in: 7201 } });
  };
  const client = createBanggoodClient({ ...CREDENTIALS, fetchImpl,
    now: () => NOW, nonceFactory: () => 'nonce-4' });
  await assert.rejects(client.listCategories(), error => {
    assert.ok(error instanceof BanggoodApiError);
    assert.equal(error.code, 'BANGGOOD_TOKEN_SCHEMA_INVALID');
    assert.equal(JSON.stringify(error).includes(CREDENTIALS.apiSecret), false);
    assert.equal(error.message.includes(CREDENTIALS.apiSecret), false);
    return true;
  });
  assert.equal(requests.length, 1);
});

test('requires injected partner API credentials and rejects a mismatched formatted currency', async () => {
  assert.throws(() => createBanggoodClient(), error => error.code === 'BANGGOOD_API_KEY_REQUIRED');
  const mock = setup(url => {
    assert.equal(url.pathname, '/product/list');
    return jsonResponse({ code: 200, result: {
      page_total: 1,
      product_list: [{ product_id: 1, category_id: 1, product_name: 'Product',
        product_url: 'https://www.banggood.com/product-p-1.html', product_price: '€10.00' }],
    }, msg: '' });
  });
  const client = createBanggoodClient({ ...CREDENTIALS, fetchImpl: mock.fetchImpl,
    now: () => NOW, nonceFactory: () => 'nonce-5' });
  await assert.rejects(client.listProducts(), error => error.code === 'BANGGOOD_PRICE_SCHEMA_INVALID');
});
