import test from 'node:test';
import assert from 'node:assert/strict';
import { createSephoraPublicClient } from '../lib/commerce/sephora.mjs';

const product = ({ id, sku, name, price, onSaleData = 'NONE', salePrice, rating = '4.5' }) => ({
  productId: id,
  productName: name,
  displayName: name,
  brandName: 'Beauty Brand',
  rating,
  reviews: '1,234',
  heroImage: `https://www.sephora.com/productimages/sku/${sku}-hero.jpg`,
  image450: `https://www.sephora.com/productimages/sku/${sku}-450.jpg`,
  image250: `https://www.sephora.com/productimages/sku/${sku}-250.jpg`,
  image135: `https://www.sephora.com/productimages/sku/${sku}-135.jpg`,
  altImage: `https://www.sephora.com/productimages/sku/${sku}-alternate.jpg`,
  targetUrl: `/product/fixture-${id}?skuId=${sku}&icid2=tracking-only`,
  currentSku: { skuId: sku, listPrice: price, isNew: false, imageAltText: 'Fixture product image',
    ...(salePrice === undefined ? {} : { salePrice }) },
  onSaleData,
});

function payload(page = 1) {
  const products = page === 1
    ? [
      product({ id: 'P12345', sku: '100001', name: 'Range Lipstick', price: '$16.00 - $25.00', salePrice: '$12.00', rating: '4.54321' }),
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
  assert.equal(result.products[0].rating, 4.54321);
  assert.equal(result.products[0].reviewCount, 1234);
  assert.equal(result.products[0].images.length, 5);
  assert.deepEqual(result.products[0].salePrice, { amount: '12.00', currency: 'USD', kind: 'sale' });
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

test('Sephora search rejects missing rating, review count, and malformed explicit sale prices', async () => {
  for (const mutate of [
    item => { delete item.rating; },
    item => { delete item.reviews; },
    item => { item.currentSku.salePrice = 'not a price'; },
  ]) {
    const data = payload();
    mutate(data.products[0]);
    const client = createSephoraPublicClient({ fetchImpl: async () => jsonResponse(data) });
    await assert.rejects(client.searchProducts({ query: 'lipstick' }), {
      code: 'SEPHORA_SEARCH_SCHEMA_INVALID',
    });
  }
});

test('Sephora search preserves the product when its source supplies no same-origin image', async () => {
  const data = payload();
  Object.assign(data.products[0], {
    heroImage: 'https://example.com/product.jpg',
    image450: null,
    image250: null,
    image135: null,
    altImage: null,
  });
  const client = createSephoraPublicClient({ fetchImpl: async () => jsonResponse(data) });

  const result = await client.searchProducts({ query: 'lipstick' });

  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products[0].images, []);
});

test('Sephora records the observed 60-result page when the smaller page-size hint is ignored', async () => {
  let received;
  const data = {
    keyword: 'serum',
    totalProducts: 745,
    products: Array.from({ length: 60 }, (_, index) => product({
      id: `P${30000 + index}`,
      sku: String(200000 + index),
      name: `Fixture Serum ${index}`,
      price: '$1.00',
    })),
  };
  const client = createSephoraPublicClient({ fetchImpl: async (url, init) => {
    received = { url, init };
    return jsonResponse(data);
  } });

  const result = await client.searchProducts({ query: 'serum', page: 1, pageSize: 10 });

  assert.equal(received.url.searchParams.get('page'), '10');
  assert.equal(received.init.credentials, 'omit');
  assert.equal(result.requestedPageSize, 10);
  assert.equal(result.pageSize, 60);
  assert.equal(result.pageCount, 13);
  assert.equal(result.products.length, 60);
  assert.equal(result.receipt.queryMatched, true);
  assert.equal(result.receipt.request.schemaVerified, true);
  assert.equal(result.receipt.request.requestedPageSize, 10);
  assert.equal(result.receipt.request.pageSize, 60);
  assert.equal(result.receipt.request.productCount, 60);
});

test('Sephora pagination keeps the observed 60-result width on its final short page', async () => {
  const requestedPages = [];
  const requestedPageSizes = [];
  const client = createSephoraPublicClient({ fetchImpl: async url => {
    const page = Number(url.searchParams.get('currentPage'));
    requestedPages.push(page);
    requestedPageSizes.push(Number(url.searchParams.get('page')));
    const products = page === 1
      ? Array.from({ length: 60 }, (_, index) => product({
        id: `P${40000 + index}`,
        sku: String(300000 + index),
        name: `Fixture Serum ${index}`,
        price: '$1.00',
      }))
      : Array.from({ length: 25 }, (_, index) => product({
        id: `P${40060 + index}`,
        sku: String(300060 + index),
        name: `Final Fixture Serum ${index}`,
        price: '$1.00',
      }));
    return jsonResponse({ keyword: 'serum', totalProducts: 85, products });
  } });

  const all = await client.searchAllProducts({ query: 'serum', pageSize: 10, maxPages: 2 });

  assert.deepEqual(requestedPages, [1, 2]);
  assert.deepEqual(requestedPageSizes, [10, 60]);
  assert.equal(all.requestedPageSize, 10);
  assert.equal(all.pageSize, 60);
  assert.equal(all.totalProducts, 85);
  assert.equal(all.pageCount, 2);
  assert.equal(all.complete, true);
  assert.deepEqual(all.pages.map(page => page.pageSize), [60, 60]);
  assert.deepEqual(all.pages.map(page => page.returnedProducts), [60, 25]);
});

test('Sephora rejects a 60-row response when totalProducts claims fewer results', async () => {
  const data = {
    keyword: 'serum',
    totalProducts: 10,
    products: Array.from({ length: 60 }, (_, index) => product({
      id: `P${50000 + index}`,
      sku: String(400000 + index),
      name: `Fixture Serum ${index}`,
      price: '$1.00',
    })),
  };
  const client = createSephoraPublicClient({ fetchImpl: async () => jsonResponse(data) });

  await assert.rejects(client.searchProducts({ query: 'serum', pageSize: 10 }), {
    code: 'SEPHORA_SEARCH_SCHEMA_INVALID',
  });
});

test('Sephora does not carry an observed page width into an independent query', async () => {
  const client = createSephoraPublicClient({ fetchImpl: async url => {
    const query = url.searchParams.get('q');
    const products = query === 'serum'
      ? Array.from({ length: 60 }, (_, index) => product({
        id: `P${51000 + index}`,
        sku: String(410000 + index),
        name: `Fixture Serum ${index}`,
        price: '$1.00',
      }))
      : Array.from({ length: 10 }, (_, index) => product({
        id: `P${52000 + index}`,
        sku: String(420000 + index),
        name: `Fixture Blush ${index}`,
        price: '$1.00',
      }));
    return jsonResponse({ keyword: query, totalProducts: query === 'serum' ? 120 : 15, products });
  } });

  const first = await client.searchProducts({ query: 'serum', pageSize: 10 });
  const second = await client.searchProducts({ query: 'blush', pageSize: 10 });

  assert.equal(first.pageSize, 60);
  assert.equal(first.pageCount, 2);
  assert.equal(second.pageSize, 10);
  assert.equal(second.pageCount, 2);
  assert.equal(second.products.length, 10);
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

const variant = ({ skuId, listPrice = '$15.00', salePrice, outOfStock = false, color }) => ({
  skuId,
  targetUrl: `/product/fixture-P12345?skuId=${skuId}`,
  isOutOfStock: outOfStock,
  listPrice,
  ...(salePrice === undefined ? {} : { salePrice }),
  productName: 'Sample Plumping Gloss',
  brandName: 'Beauty Brand',
  displayName: `${skuId} ${color}`,
  variationValue: color,
  variationTypeDisplayName: 'Color',
  variationDesc: 'high shine',
  skuRefinements: [{ key: 'colorFamily', values: ['pink'] }],
  skuImages: { imageUrl: `https://www.sephora.com/productimages/sku/s${skuId}-main.jpg`,
    image250: `https://www.sephora.com/productimages/sku/s${skuId}-main.jpg?imwidth=250`,
    altText: `Sample gloss ${color}` },
  smallImage: `https://www.sephora.com/productimages/sku/s${skuId}+sw.jpg`,
});

function productDetail({ productId = 'P12345', currentSku, regularChildSkus, onSaleChildSkus } = {}) {
  return {
    productId,
    targetUrl: `/product/fixture-${productId}`,
    productDetails: { productId, displayName: 'Sample Plumping Gloss', brand: { displayName: 'Beauty Brand' } },
    currentSku,
    regularChildSkus,
    ...(onSaleChildSkus === undefined ? {} : { onSaleChildSkus }),
    skuSelectorType: 'Color',
    variationType: 'color',
    variationTypeDisplayName: 'Color',
  };
}

test('Sephora product detail returns identity-bound SKU options, list price, sale price, images and availability', async () => {
  const current = variant({ skuId: '123450', listPrice: '$15.00', salePrice: '$7.50', color: 'Coral Flash' });
  const regular = variant({ skuId: '123451', color: 'Universal Clear' });
  const fetchImpl = async (url, init) => {
    assert.equal(url.origin, 'https://www.sephora.com');
    assert.equal(url.pathname, '/gway/v1/dotcom/productservice/v3/catalog/products/P12345/lite');
    assert.deepEqual([...url.searchParams], [
      ['addCurrentSkuToProductChildSkus', 'true'], ['includeRegionsMap', 'true'],
      ['showContent', 'true'], ['includeConfigurableSku', 'true'], ['channel', 'RWD'],
      ['loc', 'en_US'], ['countryCode', 'US'], ['preferredSku', '123450'],
      ['removePersonalizedData', 'true'], ['includeReviewFilters', 'true'], ['includeReviewImages', 'true'],
    ]);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('authorization'), null);
    return jsonResponse(productDetail({ currentSku: current, regularChildSkus: [regular], onSaleChildSkus: [current] }));
  };
  const result = await createSephoraPublicClient({ fetchImpl }).getProduct({ productId: 'P12345', skuId: '123450' });
  assert.equal(result.product.productId, 'P12345');
  assert.equal(result.product.currentSku.skuId, '123450');
  assert.equal(result.product.description, null);
  assert.equal(result.product.descriptionStatus, 'not_returned_by_observed_product_api');
  assert.equal(result.product.currentSku.price.amount, '7.50');
  assert.equal(result.product.currentSku.price.kind, 'sale');
  assert.equal(result.product.currentSku.listPrice.amount, '15.00');
  assert.equal(result.product.currentSku.salePrice.amount, '7.50');
  assert.deepEqual(result.product.currentSku.options, [{ name: 'colorFamily', value: 'pink' }]);
  assert.equal(result.product.currentSku.images.length, 3);
  assert.equal(result.product.variants.length, 2);
  assert.equal(result.product.onSaleVariantCount, 1);
  assert.equal(result.product.variants.some(item => item.skuId === '123450' && item.salePrice?.amount === '7.50'), true);
  assert.equal(result.receipt.capabilityId, 'catalog.product_detail');
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.request.httpStatus, 200);
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.contractProvenance.kind, 'first_party_bundle_contract');
});

test('Sephora product detail rejects input and response identity mismatches', async () => {
  let calls = 0;
  const client = createSephoraPublicClient({ fetchImpl: async () => {
    calls++;
    return jsonResponse(productDetail({ productId: 'P99999', currentSku: variant({ skuId: '123450', color: 'Red' }),
      regularChildSkus: [variant({ skuId: '123450', color: 'Red' })] }));
  } });
  await assert.rejects(client.getProduct({ productId: 'bad-id' }), { code: 'SEPHORA_PRODUCT_INPUT_INVALID' });
  await assert.rejects(client.getProduct({ productId: 'P12345', skuId: '123450' }), {
    code: 'SEPHORA_PRODUCT_SCHEMA_INVALID',
  });
  assert.equal(calls, 1);
});
