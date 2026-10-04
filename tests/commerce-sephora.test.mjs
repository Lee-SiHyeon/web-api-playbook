import test from 'node:test';
import assert from 'node:assert/strict';
import { createSephoraPublicClient } from '../lib/commerce/sephora.mjs';

const product = ({ id, sku, name, price, onSaleData = 'NONE' }) => ({
  productId: id,
  productName: name,
  displayName: name,
  brandName: 'Beauty Brand',
  targetUrl: `/product/fixture-${id}?skuId=${sku}&icid2=tracking-only`,
  currentSku: { skuId: sku, listPrice: price, isNew: false },
  onSaleData,
});

function payload(page = 1) {
  const products = page === 1
    ? [
      product({ id: 'P12345', sku: '100001', name: 'Range Lipstick', price: '$16.00 - $25.00' }),
      product({ id: 'P12346', sku: '100002', name: 'Single Lipstick', price: '$26.00' }),
    ]
    : [product({ id: 'P12347', sku: '100003', name: 'Last Lipstick', price: '$9.50' })];
  return { keyword: 'lipstick', totalProducts: 3, products };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

test('Sephora anonymous search returns source-bound product IDs and normalized USD list prices', async () => {
  let received;
  const client = createSephoraPublicClient({
    now: () => Date.parse('2026-10-05T00:00:00Z'),
    fetchImpl: async (url, init) => {
      received = { url, init };
      return jsonResponse(payload());
    },
  });
  const result = await client.searchProducts({ query: ' lipstick ' });

  assert.equal(received.url.origin, 'https://www.sephora.com');
  assert.equal(received.url.pathname, '/api/v2/catalog/search/');
  assert.deepEqual([...received.url.searchParams], [
    ['type', 'keyword'], ['q', 'lipstick'], ['page', '60'], ['currentPage', '1'], ['countryCode', 'US'],
  ]);
  assert.equal(received.init.method, 'GET');
  assert.equal(received.init.redirect, 'manual');
  assert.equal(received.init.credentials, 'omit');
  assert.equal(received.init.headers.get('cookie'), null);
  assert.equal(received.init.headers.get('authorization'), null);
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].productId, 'P12345');
  assert.equal(result.products[0].variantId, '100001');
  assert.equal(result.products[0].productUrl,
    'https://www.sephora.com/product/fixture-P12345?skuId=100001');
  assert.equal(result.products[0].price, null);
  assert.deepEqual(result.products[0].priceRange, {
    min: { amount: '16.00', currency: 'USD' },
    max: { amount: '25.00', currency: 'USD' },
  });
  assert.equal(result.products[0].priceScope, 'product_range');
  assert.equal(result.products[0].listPriceText, '$16.00 - $25.00');
  assert.deepEqual(result.products[1].price, { amount: '26.00', currency: 'USD', kind: 'retail_list' });
  assert.equal(result.products[1].priceScope, 'current_sku');
  assert.equal(result.products[1].onSaleData, 'NONE');
  assert.equal(result.products[1].salePrice, undefined);
  assert.equal(result.totalProducts, 3);
  assert.equal(result.pageCount, 1);
  assert.equal(result.receipt.schema, 'web-api-public-read-receipt-v1');
  assert.equal(result.receipt.capabilityId, 'catalog.search');
  assert.equal(result.receipt.contractProvenance.kind, 'browser_xhr_observed');
  assert.equal(result.receipt.request.anonymous, true);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(JSON.stringify(result.receipt).includes('lipstick'), false);
});

test('Sephora pagination collects every verified page and refuses duplicates or count drift', async () => {
  const requestedPages = [];
  const client = createSephoraPublicClient({ fetchImpl: async url => {
    const page = Number(url.searchParams.get('currentPage'));
    requestedPages.push(page);
    return jsonResponse(payload(page));
  } });
  const all = await client.searchAllProducts({ query: 'lipstick', pageSize: 2 });
  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(all.complete, true);
  assert.equal(all.totalProducts, 3);
  assert.equal(all.pageCount, 2);
  assert.deepEqual(all.pages.map(page => page.returnedProducts), [2, 1]);
  assert.deepEqual(all.products.map(item => item.productId), ['P12345', 'P12346', 'P12347']);
  assert.equal(all.receipts.length, 2);

  const duplicate = createSephoraPublicClient({ fetchImpl: async url => {
    const page = Number(url.searchParams.get('currentPage'));
    const data = payload(page);
    if (page === 2) {
      data.products[0].productId = 'P12345';
      data.products[0].targetUrl = '/product/fixture-P12345?skuId=100003';
    }
    return jsonResponse(data);
  } });
  await assert.rejects(duplicate.searchAllProducts({ query: 'lipstick', pageSize: 2 }), {
    code: 'SEPHORA_PAGINATION_SCHEMA_INVALID',
  });
});

test('Sephora rejects unsafe inputs, non-US markets, invalid product IDs, and malformed prices', async () => {
  let calls = 0;
  const client = createSephoraPublicClient({ fetchImpl: async () => {
    calls++;
    return jsonResponse(payload());
  } });
  for (const params of [
    {}, { query: '' }, { query: 'x\n' }, { query: 'x'.repeat(121) },
    { query: 'lipstick', page: 0 }, { query: 'lipstick', pageSize: 61 },
    { query: 'lipstick', countryCode: 'CA' },
  ]) {
    await assert.rejects(client.searchProducts(params), { code: 'SEPHORA_SEARCH_INPUT_INVALID' });
  }
  assert.equal(calls, 0);

  for (const mutate of [
    data => { data.products[0].productId = 'foreign-id'; },
    data => { data.products[0].currentSku.skuId = '../100'; },
    data => { data.products[0].targetUrl = 'https://attacker.example/product/fixture-P12345'; },
    data => { data.products[0].targetUrl = '/product/fixture-P99999?skuId=100001'; },
    data => { data.products[0].targetUrl = '/product/fixture-P12345?skuId=999999'; },
    data => { data.products[0].currentSku.listPrice = 'Starting at $10'; },
    data => { data.products[0].currentSku.listPrice = '$30.00 - $20.00'; },
    data => { data.products.push(...Array.from({ length: 59 }, (_, i) =>
      product({ id: `P${20000 + i}`, sku: `${20000 + i}`, name: 'Extra', price: '$1.00' }))); },
  ]) {
    const fixture = payload();
    mutate(fixture);
    const invalid = createSephoraPublicClient({ fetchImpl: async () => jsonResponse(fixture) });
    await assert.rejects(invalid.searchProducts({ query: 'lipstick' }), {
      code: 'SEPHORA_SEARCH_SCHEMA_INVALID',
    });
  }
});

test('Sephora rejects redirects, access gates, non-JSON pages, and throttling', async () => {
  for (const [response, code] of [
    [new Response(null, { status: 302, headers: { location: 'https://www.sephora.com/login' } }),
      'SEPHORA_REDIRECT_REJECTED'],
    [new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
      'SEPHORA_AUTH_REJECTED'],
    [new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
      'SEPHORA_THROTTLED'],
    [new Response('<html>page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      'SEPHORA_MIME_INVALID'],
  ]) {
    const client = createSephoraPublicClient({ fetchImpl: async () => response });
    await assert.rejects(client.searchProducts({ query: 'lipstick' }), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.origin, 'https://www.sephora.com');
      assert.equal(error.receipt.path, '/api/v2/catalog/search/');
      return true;
    });
  }
});
