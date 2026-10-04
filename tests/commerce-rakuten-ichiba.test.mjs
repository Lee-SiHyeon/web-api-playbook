import test from 'node:test';
import assert from 'node:assert/strict';
import { createRakutenIchibaClient, RAKUTEN_ICHIBA_CONTRACT } from '../lib/commerce/rakuten-ichiba.mjs';

const APP_ID = 'test-rakuten-app-id-2026';
const ACCESS_KEY = 'test-rakuten-access-key-value-2026';
const AFFILIATE_ID = 'caller-owned-rakuten-affiliate-id';
const NOW = Date.parse('2026-10-05T00:00:00.000Z');

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function item(itemCode = 'shop-one:sku-100', extra = {}) {
  const slug = itemCode.split(':')[1];
  return {
    itemCode,
    shopCode: itemCode.split(':')[0],
    itemName: '日本語の商品名',
    itemPrice: 1980,
    itemPriceBaseField: 'item_price_min3',
    itemPriceMin1: 1500,
    itemPriceMax1: 3300,
    itemPriceMin2: 1700,
    itemPriceMax2: 2800,
    itemPriceMin3: 1980,
    itemPriceMax3: 2400,
    itemUrl: `https://item.rakuten.co.jp/${itemCode.split(':')[0]}/${slug}/?from=api&ref=discard`,
    genreId: 100,
    availability: 1,
    affiliateRate: 4.5,
    taxFlag: 0,
    postageFlag: 1,
    ...extra,
  };
}

function itemPage({ items = [item()], page = 1, hits = 30, count = items.length, pageCount = 1 } = {}) {
  return { count, page, first: (page - 1) * hits + 1, last: (page - 1) * hits + items.length,
    hits, pageCount, carrier: 0, items };
}

function harness(route, options = {}) {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    assert.equal(url.origin, 'https://openapi.rakuten.co.jp');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('accesskey'), ACCESS_KEY);
    assert.equal(url.searchParams.get('applicationId'), APP_ID);
    assert.equal(url.searchParams.has('accessKey'), false, 'accessKey must stay out of the URL');
    return route(url, init);
  };
  const client = createRakutenIchibaClient({ applicationId: APP_ID, accessKey: ACCESS_KEY,
    fetchImpl, now: () => NOW, ...options });
  return { client, requests };
}

test('uses the current documented v2026-07-01 item-search route and exact selectors, JPY prices, and paging', async () => {
  const mock = harness(url => {
    assert.equal(url.pathname, '/ichibams/api/IchibaItem/Search/20260701');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      applicationId: APP_ID,
      keyword: 'usb 充電器',
      shopCode: 'shop-one',
      genreId: '100',
      minPrice: '1000',
      maxPrice: '5000',
      format: 'json',
      formatVersion: '2',
      elements: 'itemName,catchcopy,itemCode,shopCode,itemPrice,itemPriceBaseField,itemPriceMin1,itemPriceMax1,itemPriceMin2,itemPriceMax2,itemPriceMin3,itemPriceMax3,itemUrl,affiliateUrl,genreId,availability,taxFlag,postageFlag,updateTimestamp,affiliateRate',
      hits: '2',
      page: '2',
      sort: '+itemPrice',
      availability: '1',
    });
    return jsonResponse(itemPage({ items: [item(), item('shop-one:sku-101', {
      itemName: 'もう一つの商品', itemPrice: '2500', itemUrl: 'https://item.rakuten.co.jp/shop-one/sku-101/',
    })], count: 7, page: 2, hits: 2, pageCount: 4 }));
  });
  const result = await mock.client.searchItems({ keyword: 'usb 充電器', shopCode: 'shop-one', genreId: 100,
    minPrice: 1000, maxPrice: 5000, hits: 2, page: 2, sort: '+itemPrice', availability: 1 });
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products[0].price, {
    amount: '1980', currency: 'JPY', unit: 'decimal', sourceField: 'itemPrice',
    basis: 'listing_level_api_item_price', selectedVariant: false,
  });
  assert.deepEqual(result.products[0].priceBasis, {
    field: 'item_price_min3', meaning: 'purchasable_item_price_minimum_basis',
  });
  assert.deepEqual(result.products[0].priceRanges, {
    all: { basis: 'all_items', min: { amount: '1500', currency: 'JPY', unit: 'decimal', sourceField: 'itemPriceMin1' },
      max: { amount: '3300', currency: 'JPY', unit: 'decimal', sourceField: 'itemPriceMax1' } },
    searchable: { basis: 'searchable_items', min: { amount: '1700', currency: 'JPY', unit: 'decimal', sourceField: 'itemPriceMin2' },
      max: { amount: '2800', currency: 'JPY', unit: 'decimal', sourceField: 'itemPriceMax2' } },
    purchasable: { basis: 'purchasable_items', min: { amount: '1980', currency: 'JPY', unit: 'decimal', sourceField: 'itemPriceMin3' },
      max: { amount: '2400', currency: 'JPY', unit: 'decimal', sourceField: 'itemPriceMax3' } },
  });
  assert.equal(result.products[0].itemCode, 'shop-one:sku-100');
  assert.equal(result.products[0].shopCode, 'shop-one');
  assert.equal(result.products[0].canonicalUrl, 'https://item.rakuten.co.jp/shop-one/sku-100/');
  assert.equal(result.products[0].availability, 'available');
  assert.equal(result.products[0].taxIncluded, true);
  assert.equal(result.products[0].postageIncluded, false);
  assert.deepEqual(result.products[0].affiliateRate, {
    percent: '4.5', sourceField: 'affiliateRate', basis: 'item_specific_api_value',
  });
  assert.deepEqual(result.pagination, { count: 7, page: 2, pageCount: 4, hits: 2, hasNextPage: true, nextPage: 3 });
  assert.equal(result.receipt.schema, 'web-api-credentialed-read-receipt-v1');
  assert.equal(result.receipt.service, 'rakuten-ichiba');
  assert.equal(result.receipt.capabilityId, 'catalog.search');
  assert.equal(result.receipt.credentialsUsed, true);
  assert.equal(result.receipt.request.path, RAKUTEN_ICHIBA_CONTRACT.itemSearch.path);
  assert.deepEqual(result.receipt.request.queryFields.includes('applicationId'), true);
  assert.equal(JSON.stringify(result).includes(APP_ID), false);
  assert.equal(JSON.stringify(result).includes(ACCESS_KEY), false);
  assert.equal(JSON.stringify(result).includes('from=api'), false);
});

test('itemCode detail lookup uses documented Item Search and binds both code and shop identity', async () => {
  const mock = harness(url => {
    assert.equal(url.pathname, '/ichibams/api/IchibaItem/Search/20260701');
    assert.equal(url.searchParams.get('itemCode'), 'shop-one:sku-100');
    assert.equal(url.searchParams.get('hits'), '1');
    assert.equal(url.searchParams.get('page'), '1');
    return jsonResponse(itemPage({ items: [item()], hits: 1, page: 1, pageCount: 1 }));
  });
  const result = await mock.client.getItem({ itemCode: 'shop-one:sku-100' });
  assert.equal(result.itemCode, 'shop-one:sku-100');
  assert.equal(result.shopCode, 'shop-one');
  assert.equal(result.price.amount, '1980');
  assert.equal(result.receipt.capabilityId, 'catalog.item_detail');
});

test('caller affiliate URL can supply a static pc target; target is verified without following the tracking URL', async () => {
  const affiliateUrl = `https://hb.afl.rakuten.co.jp/hgc/${AFFILIATE_ID}/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fshop-one%2Fsku-100%2F`;
  const mock = harness(url => {
    assert.equal(url.searchParams.get('affiliateId'), AFFILIATE_ID);
    return jsonResponse(itemPage({ items: [item('shop-one:sku-100', {
      itemUrl: affiliateUrl,
      affiliateUrl,
    })] }));
  }, { affiliateId: AFFILIATE_ID });
  const result = await mock.client.searchItems({ keyword: 'usb' });
  assert.equal(result.products[0].canonicalUrl, 'https://item.rakuten.co.jp/shop-one/sku-100/');
  assert.equal(result.products[0].targetVerified, true);
  assert.equal(result.products[0].canonicalUrlSource, 'api_itemUrl.pc');
  assert.equal(result.products[0].affiliateUrl, affiliateUrl);
  assert.equal(result.products[0].affiliateUrl.includes(AFFILIATE_ID), true);
  assert.equal(mock.requests.length, 1, 'no second request may follow the affiliate URL');
  assert.equal(JSON.stringify(result).includes(APP_ID), false);
  assert.equal(JSON.stringify(result).includes(ACCESS_KEY), false);
});

test('leaves a same-shop but nonmatching item target unverified without failing the API item', async () => {
  const affiliateUrl = `https://hb.afl.rakuten.co.jp/hgc/${AFFILIATE_ID}/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fshop-one%2Funmatched-product%2F`;
  const mock = harness(() => jsonResponse(itemPage({ items: [item('shop-one:sku-100', {
    itemUrl: affiliateUrl, affiliateUrl,
  })] })), { affiliateId: AFFILIATE_ID });
  const result = await mock.client.searchItems({ keyword: 'usb' });
  assert.equal(result.products[0].itemCode, 'shop-one:sku-100');
  assert.equal(result.products[0].shopCode, 'shop-one');
  assert.equal(result.products[0].canonicalUrl, null);
  assert.equal(result.products[0].targetVerified, false);
  assert.equal(result.products[0].affiliateUrl, affiliateUrl);
  assert.equal(mock.requests.length, 1);
});

test('accepts a matching static mobile target after exact itemCode and shopCode path checks', async () => {
  const affiliateUrl = `https://hb.afl.rakuten.co.jp/hgc/${AFFILIATE_ID}/?pc=https%3A%2F%2Fitem.rakuten.co.jp%2Fother-shop%2Fwrong%2F&m=https%3A%2F%2Fm.rakuten.co.jp%2Fshop-one%2Fsku-100%2F`;
  const mock = harness(() => jsonResponse(itemPage({ items: [item('shop-one:sku-100', {
    itemUrl: affiliateUrl, affiliateUrl,
  })] })), { affiliateId: AFFILIATE_ID });
  const result = await mock.client.searchItems({ keyword: 'usb' });
  assert.equal(result.products[0].canonicalUrl, 'https://m.rakuten.co.jp/shop-one/sku-100/');
  assert.equal(result.products[0].canonicalUrlSource, 'api_itemUrl.m');
  assert.equal(result.products[0].targetVerified, true);
  assert.equal(result.products[0].targetMatchBasis, 'shopCode_path_and_exact_itemCode_path_segment');
  assert.equal(result.products[0].itemCode, 'shop-one:sku-100');
  assert.equal(mock.requests.length, 1);
});

test('preserves documented itemPrice basis and all/searchable/purchasable ranges without selected-SKU claims', async () => {
  const mock = harness(() => jsonResponse(itemPage({ items: [item('shop-one:variant-group', {
    itemName: '상품 옵션을 고르는 상품',
    itemUrl: 'https://item.rakuten.co.jp/shop-one/options/',
    itemPrice: 1200,
    itemPriceBaseField: 'item_price_min1',
    itemPriceMin1: 1200,
    itemPriceMax1: 8400,
    itemPriceMin2: 1300,
    itemPriceMax2: 7500,
    itemPriceMin3: 1500,
    itemPriceMax3: 6900,
  })] })));
  const result = await mock.client.searchItems({ keyword: 'option product' });
  const product = result.products[0];
  assert.equal(product.canonicalUrl, null);
  assert.equal(product.targetVerified, false, 'a same-shop slug without an exact itemCode key stays unverified');
  assert.equal(product.price.amount, '1200');
  assert.equal(product.price.basis, 'listing_level_api_item_price');
  assert.equal(product.price.selectedVariant, false);
  assert.deepEqual(product.priceBasis, { field: 'item_price_min1', meaning: 'all_item_price_minimum_basis' });
  assert.deepEqual(Object.fromEntries(Object.entries(product.priceRanges).map(([key, range]) => [key,
    [range.min.amount, range.max.amount, range.basis]])), {
    all: ['1200', '8400', 'all_items'],
    searchable: ['1300', '7500', 'searchable_items'],
    purchasable: ['1500', '6900', 'purchasable_items'],
  });
});

test('genre lookup uses documented current genre endpoint and returns only the documented tree fields', async () => {
  const mock = harness(url => {
    assert.equal(url.pathname, '/ichibagt/api/IchibaGenre/Search/20260701');
    assert.equal(url.searchParams.get('genreId'), '100');
    return jsonResponse({
      ancestors: [{ genreId: 0, nameJa: '総合', level: 0 }],
      genre: { genreId: 100, nameJa: '家電', level: 1 },
      children: [{ genreId: 101, nameJa: 'PC周辺機器', level: 2, secretEcho: ACCESS_KEY }],
      unexpected: { apiKey: ACCESS_KEY },
    });
  });
  const result = await mock.client.getGenre({ genreId: 100 });
  assert.equal(result.genreId, '100');
  assert.deepEqual(result.data.genre, { genreId: 100, nameJa: '家電', level: 1 });
  assert.deepEqual(result.data.children, [{ genreId: 101, nameJa: 'PC周辺機器', level: 2 }]);
  assert.equal(JSON.stringify(result).includes(ACCESS_KEY), false);
  assert.equal(result.receipt.capabilityId, 'catalog.genre_lookup');
  assert.equal(result.receipt.contractProvenance.sourceURL, RAKUTEN_ICHIBA_CONTRACT.genreSearch.sourceURL ??
    'https://webservice.rakuten.co.jp/documentation/ichiba-genre-search');
});

test('rejects invalid bounds, incomplete identity, unsafe price, and mismatched detail records', async () => {
  const mock = harness(() => jsonResponse(itemPage()));
  for (const params of [
    {}, { keyword: 'x' }, { keyword: 'charger', hits: 31 }, { keyword: 'charger', page: 101 },
    { keyword: 'charger', minPrice: 100, maxPrice: 100 }, { keyword: 'charger', sort: '-itemName' },
    { itemCode: 'missing-colon' }, { shopCode: '../other' },
  ]) {
    await assert.rejects(mock.client.searchItems(params), error => error.code.startsWith('RAKUTEN_ICHIBA_'));
  }
  const mismatchedIdentity = harness(() => jsonResponse(itemPage({ items: [item('shop-one:sku-100', { shopCode: 'different-shop' })] })));
  await assert.rejects(mismatchedIdentity.client.searchItems({ keyword: 'charger' }), error => error.code === 'RAKUTEN_ICHIBA_ITEM_IDENTITY_MISMATCH');
  const badPrice = harness(() => jsonResponse(itemPage({ items: [item('shop-one:sku-100', { itemPrice: '1,980' })] })));
  await assert.rejects(badPrice.client.searchItems({ keyword: 'charger' }), error => error.code === 'RAKUTEN_ICHIBA_ITEM_PRICE_INVALID');
  const badDetail = harness(() => jsonResponse(itemPage({ items: [item('different-shop:sku-100')], hits: 1 })));
  await assert.rejects(badDetail.client.getItem({ itemCode: 'shop-one:sku-100' }), error => error.code === 'RAKUTEN_ICHIBA_ITEM_IDENTITY_MISMATCH');
});

test('API failures and echoed credentials are reduced to secret-free error metadata', async () => {
  const failed = harness(() => jsonResponse({ error: 'unauthorized', error_description: 'no access' }, 401));
  await assert.rejects(failed.client.searchItems({ keyword: 'charger' }), error => {
    assert.equal(error.message, 'RAKUTEN_ICHIBA_AUTH_REJECTED');
    assert.equal(JSON.stringify(error.receipt).includes(APP_ID), false);
    assert.equal(JSON.stringify(error.receipt).includes(ACCESS_KEY), false);
    assert.equal(JSON.stringify(error.receipt).includes('charger'), false);
    return true;
  });
  const echoed = harness(() => jsonResponse(itemPage({ items: [item('shop-one:sku-100', { itemName: ACCESS_KEY })] })));
  await assert.rejects(echoed.client.searchItems({ keyword: 'charger' }), error => {
    assert.equal(error.code, 'RAKUTEN_ICHIBA_RESPONSE_CONTAINS_CREDENTIAL');
    assert.equal(JSON.stringify(error.receipt).includes(ACCESS_KEY), false);
    return true;
  });
});

test('credentials are required in memory and never passed as query parameters', async () => {
  assert.throws(() => createRakutenIchibaClient({ accessKey: ACCESS_KEY }), error => error.code === 'RAKUTEN_ICHIBA_APPLICATION_ID_REQUIRED');
  assert.throws(() => createRakutenIchibaClient({ applicationId: APP_ID }), error => error.code === 'RAKUTEN_ICHIBA_ACCESS_KEY_REQUIRED');
});
