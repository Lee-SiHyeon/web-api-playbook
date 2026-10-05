import test from 'node:test';
import assert from 'node:assert/strict';
import { createUltaPublicClient } from '../lib/commerce/ulta.mjs';

const ORIGIN = 'https://www.ulta.com';
const UUID = '11111111-1111-4111-8111-111111111111';

function pageUrl(page, query = 'lipstick') {
  const url = new URL('/search', ORIGIN);
  url.searchParams.set('search', query);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function htmlBootstrap(page = 1, query = 'lipstick') {
  const target = new URL(pageUrl(page, query));
  const graphql = `query NonCachedPage( $stagingHost: String, $previewOptions: JSON, $moduleParams: JSON ) {\n` +
    ` Page: NonCachedPage( stagingHost:$stagingHost, previewOptions:$previewOptions, moduleParams:$moduleParams , ` +
    `url: { path: ${JSON.stringify(target.toString())} }, contentId: "${UUID}") { content customResponseAttributes meta }\n}`;
  const module = {
    id: UUID,
    type: 'ProductListingResults',
    moduleName: 'ProductListingResults',
    meta: { initAction: {
      graphql,
      method: 'GET',
      params: ['gti', 'loginStatus', 'retailerVisitorId', 'breakpoint'],
      customHeaders: [
        { key: 'X-ULTA-GRAPH-TYPE', value: 'query' },
        { key: 'X-ULTA-GRAPH-SUB-TYPE', value: 'noncachedpage' },
        { key: 'X-ULTA-GRAPH-MODULE-NAME', value: 'ProductListingResults' },
      ],
    } },
  };
  const state = { ROOT_QUERY: { 'Page({"url":{"path":"/search"})': { content: { modules: [module] } } } };
  return `<html><script id="apollo_state">window.__APOLLO_STATE__ = ${JSON.stringify(state)};\n` +
    `window.__APP_LOCALE__ = 'en-US'\n` +
    `window.__GRAPHQL_DOMAIN__ = 'https://www.ulta.com'\n` +
    `window.__GRAPHQL_GET_URI__ = 'dxl/graphql?ultasite=en-us&user-agent=gomez'\n` +
    `window.__REQUEST_HEADERS__ = {"X_ULTA_SITE":"CB"};</script></html>`;
}

const PRODUCT_ID = 'pimprod2057119';
const SKU_ID = '2648428';
const PRODUCT_URL = `${ORIGIN}/p/serum-lipstick-${PRODUCT_ID}?sku=${SKU_ID}`;

function productHtmlBootstrap({ productId = PRODUCT_ID, skuId = SKU_ID, productUrl = PRODUCT_URL } = {}) {
  const pageUrl = new URL(productUrl);
  const args = {
    url: { path: pageUrl.pathname },
    ...(skuId ? { moduleParams: { sku: skuId } } : {}),
  };
  const pageKey = `Page(${JSON.stringify(args)})`;
  const productReviews = {
    id: 'review-module-fixture',
    moduleName: 'ProductReviews',
    productId,
    productSku: skuId,
    locale: 'en-US',
    prApiKey: 'test-only-public-key',
    prMerchantId: '9001',
    enableLocalPowerReviewContent: true,
  };
  const state = { ROOT_QUERY: { [pageKey]: { content: { modules: [productReviews] } } } };
  return `<html><script id="apollo_state">window.__APOLLO_STATE__ = ${JSON.stringify(state)};\n` +
    `window.__APP_LOCALE__ = 'en-US'\n` +
    `window.__GRAPHQL_DOMAIN__ = 'https://www.ulta.com'\n` +
    `window.__GRAPHQL_GET_URI__ = 'dxl/graphql?ultasite=en-us&user-agent=gomez'\n` +
    `window.__REQUEST_HEADERS__ = {"X_ULTA_SITE":"CB"};</script>` +
    `<script src="/ux/assets/js/client.fa640546.js"></script>` +
    `<div>https://ui.powerreviews.com/stable/4.0/ui.js</div></html>`;
}

function product({ id, sku, name, listPrice, salePrice = null, sponsored = false }) {
  return {
    productId: id,
    skuId: sku,
    brandName: 'Beauty Brand',
    productName: name,
    rating: 4.7,
    reviewCount: 429,
    listPrice,
    salePrice,
    sponsored,
    action: { url: `/p/fixture-${id}?sku=${sku}&tracking=discarded` },
  };
}

function apiPayload(page = 1, loadMoreUrl = page < 2 ? pageUrl(page + 1) : null) {
  return {
    data: { Page: { content: {
      moduleName: 'ProductListingResults',
      page,
      pageSize: 64,
      resultCount: 128,
      items: page === 1
        ? [
          product({ id: 'pimprod2057119', sku: '2648428', name: 'Serum Lipstick', listPrice: '$9.99', salePrice: '$8.99' }),
          product({ id: 'pimprod2043355', sku: '2619358', name: 'Range Lipstick', listPrice: '$37.00 - $39.00', sponsored: true }),
        ]
        : [product({ id: 'pimprod2054938', sku: '2641200', name: 'Second Page Lipstick', listPrice: '$12.00' })],
      loadMoreUrl,
    } } },
  };
}

function productPagePayload({ productId = PRODUCT_ID, skuId = SKU_ID } = {}) {
  const image = `https://media.ulta.com/i/ulta/${skuId}`;
  return { data: { Page: { content: {
    type: 'Page',
    modules: [
      {
        moduleName: 'ProductInformation', productName: 'Serum Lipstick', rating: 4.7, reviewCount: 429,
      },
      {
        moduleName: 'ProductPricing', productId, skuId, brandName: 'Maybelline', productName: 'Serum Lipstick',
        listPrice: '$9.99', productListPrice: '$9.99', salePrice: null, productSalePrice: null,
        productCategory: 'Makeup:Lips:Lipstick', image: { name: 'Shade', imageUrl: image },
      },
      {
        moduleName: 'MediaGallery', skuId, items: [{ imageUrl: image, name: 'Main Image', altText: 'Serum lipstick',
          metaData: { mediaType: 'image', width: 1000, height: 1000 } }],
      },
      {
        moduleName: 'ProductVariant', variantType: 'Color', variants: [
          { productId, skuId, name: 'Bare Reveal', shadeDescription: 'Warm nude', selected: true, disabled: false,
            unavailable: false, listPrice: null, salePrice: null, mainImage: { imageUrl: image },
            swatchImage: { imageUrl: image }, smooshImage: null },
          { productId, skuId: '2648432', name: 'Warm Me Up', shadeDescription: 'Soft rose', selected: false,
            disabled: false, unavailable: false, listPrice: null, salePrice: null,
            mainImage: { imageUrl: 'https://media.ulta.com/i/ulta/2648432' }, swatchImage: null, smooshImage: null },
        ],
      },
      { moduleName: 'ProductDetail', description: 'Full public product description.', usage: 'Apply to lips.',
        ingredients: 'Water, pigment.', restrictions: null },
      { moduleName: 'ProductReviews', productId, productSku: skuId, priceCurrency: 'USD', rating: 4.7, reviewCount: 429 },
    ],
  } } } };
}

function review({ id, rating, body, created, media = [] }) {
  return {
    review_id: id,
    details: {
      comments: body,
      headline: 'Public review headline',
      nickname: 'private display name must not be returned',
      location: 'private location must not be returned',
      created_date: created,
      product_page_id: PRODUCT_ID,
      properties: [],
    },
    metrics: { rating, helpful_votes: 0 },
    media,
  };
}

function reviewPayload(page = 1) {
  return {
    name: 'reviews',
    paging: {
      total_results: 3,
      pages_total: 2,
      page_size: 2,
      current_page_number: page,
      next_page_url: page === 1
        ? `/m/9001/l/en_US/product/${PRODUCT_ID}/reviews?paging.from=2&paging.size=2`
        : null,
    },
    results: [{
      page_id: PRODUCT_ID,
      rollup: { review_count: 3, average_rating: 4 },
      reviews: page === 1
        ? [
          review({ id: 101, rating: 3, body: 'First public body', created: 1_790_456_518_282 }),
          review({ id: 102, rating: 5, body: 'Second public body', created: 1_790_456_518_282,
            media: [{ uri: '//res.cloudinary.com/powerreviews/image/upload/fixture.jpg', type: 'image' }] }),
        ]
        : [review({ id: 103, rating: 4, body: 'Last public body', created: 1_790_456_518_282 })],
    }],
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function harness({ mutatePayload, pageSize = 100 } = {}) {
  const calls = [];
  const client = createUltaPublicClient({
    now: () => Date.parse('2026-10-05T00:00:00Z'),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      calls.push({ url, init, headers });
      if (url.pathname === '/search') {
        const requestedPage = Number(url.searchParams.get('page') ?? 1);
        return new Response(htmlBootstrap(requestedPage, url.searchParams.get('search')), {
          status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      assert.equal(url.pathname, '/dxl/graphql');
      const variables = JSON.parse(url.searchParams.get('variables'));
      assert.deepEqual(Object.keys(variables.moduleParams).sort(), ['breakpoint', 'gti', 'loginStatus']);
      assert.equal(variables.moduleParams.gti, '');
      assert.equal(variables.moduleParams.loginStatus, 'anonymous');
      assert.equal(variables.moduleParams.breakpoint, 'desktop');
      const requestPage = Number(new URL(headers.get('referer')).searchParams.get('page') ?? 1);
      const payload = apiPayload(requestPage);
      mutatePayload?.(payload, requestPage);
      return jsonResponse(payload);
    },
  });
  return { client, calls, pageSize };
}

test('Ulta public search reads prices through the observed anonymous GraphQL XHR', async () => {
  const { client, calls } = harness();
  const result = await client.searchProducts({ query: ' lipstick ' });
  const apiCall = calls.find(call => call.url.pathname === '/dxl/graphql');

  assert.equal(calls.length, 2);
  assert.equal(apiCall.init.method, 'GET');
  assert.equal(apiCall.init.redirect, 'manual');
  assert.equal(apiCall.init.credentials, 'omit');
  assert.equal(apiCall.headers.get('cookie'), null);
  assert.equal(apiCall.headers.get('authorization'), null);
  assert.equal(apiCall.url.origin, ORIGIN);
  assert.equal(apiCall.url.searchParams.get('operationName'), 'NonCachedPage');
  assert.equal(apiCall.url.searchParams.get('ultasite'), 'en-us');
  assert.equal(apiCall.url.searchParams.get('user-agent'), 'gomez');
  assert.match(apiCall.url.searchParams.get('query'), /contentId:\s*"11111111-/);
  assert.equal(apiCall.headers.get('x-ulta-dxl-query-id'), 'NonCachedPage');
  assert.equal(apiCall.headers.get('x-ulta-graph-module-name'), 'ProductListingResults');
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 64);
  assert.equal(result.resultCount, 128);
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products[0].listPrice, {
    minAmount: '9.99', maxAmount: '9.99', currency: 'USD', kind: 'retail_list',
  });
  assert.deepEqual(result.products[0].salePrice, {
    minAmount: '8.99', maxAmount: '8.99', currency: 'USD', kind: 'retail_sale',
  });
  assert.equal(result.products[0].currentPrice.minAmount, '8.99');
  assert.deepEqual(result.products[0].price, { amount: '8.99', currency: 'USD', kind: 'retail_sale' });
  assert.deepEqual(result.products[1].listPrice, {
    minAmount: '37.00', maxAmount: '39.00', currency: 'USD', kind: 'retail_list',
  });
  assert.deepEqual(result.products[1].priceRange, {
    min: { amount: '37.00', currency: 'USD' },
    max: { amount: '39.00', currency: 'USD' },
    kind: 'retail_list',
  });
  assert.equal(result.products[1].productUrl,
    `${ORIGIN}/p/fixture-pimprod2043355?sku=2619358`);
  assert.equal(result.products[1].sponsored, true);
  assert.equal(result.products[0].rating, 4.7);
  assert.equal(result.products[0].reviewCount, 429);
  assert.equal(result.receipt.schema, 'web-api-public-read-receipt-v1');
  assert.equal(result.receipt.contractProvenance.kind, 'browser_xhr_observed');
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.request.authorizationSent, false);
  assert.equal(JSON.stringify(result.receipt).includes(UUID), false);
});

test('Ulta page 2 follows the first-party loadMoreUrl and rebinds its content ID', async () => {
  const { client, calls } = harness();
  const result = await client.searchProducts({ query: 'lipstick', page: 2, pageSize: 64 });
  assert.deepEqual(calls.map(call => call.url.pathname), ['/search', '/dxl/graphql', '/search', '/dxl/graphql']);
  assert.equal(calls[2].url.searchParams.get('page'), '2');
  assert.equal(calls[3].headers.get('referer'), pageUrl(2));
  assert.equal(result.page, 2);
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].productId, 'pimprod2054938');
  assert.equal(result.receipt.bootstrapRequests.length, 2);
});

test('Ulta rejects mismatched bootstrap URLs and never sends GraphQL for them', async () => {
  let calls = 0;
  const client = createUltaPublicClient({ fetchImpl: async () => {
    calls++;
    return new Response(htmlBootstrap(1, 'other'), {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  } });
  await assert.rejects(client.searchProducts({ query: 'lipstick' }), { code: 'ULTA_BOOTSTRAP_CONTRACT_INVALID' });
  assert.equal(calls, 1);
});

test('Ulta rejects untrusted continuation URLs from a GraphQL response', async () => {
  const { client, calls } = harness({ mutatePayload: payload => {
    payload.data.Page.content.loadMoreUrl = 'https://attacker.example/search?search=lipstick&page=2';
  } });
  await assert.rejects(client.searchProducts({ query: 'lipstick', page: 2 }), {
    code: 'ULTA_PAGINATION_CONTRACT_INVALID',
  });
  assert.equal(calls.filter(call => call.url.pathname === '/dxl/graphql').length, 1);
});

test('Ulta blocks redirects, access denials, and invalid pagination or search inputs', async () => {
  const blocked = createUltaPublicClient({ fetchImpl: async () => new Response('<html>blocked</html>', {
    status: 403, headers: { 'content-type': 'text/html' },
  }) });
  await assert.rejects(blocked.searchProducts({ query: 'lipstick' }), { code: 'ULTA_AUTH_REJECTED' });

  let calls = 0;
  const client = createUltaPublicClient({ fetchImpl: async () => {
    calls++;
    return new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  for (const input of [
    {}, { query: '' }, { query: 'x\n' }, { query: 'x'.repeat(121) },
    { query: 'lipstick', page: 0 }, { query: 'lipstick', page: 11 },
    { query: 'lipstick', pageSize: 101 },
  ]) await assert.rejects(client.searchProducts(input), { code: 'ULTA_SEARCH_INPUT_INVALID' });
  assert.equal(calls, 0);
});

test('Ulta product detail uses the first-party Page GraphQL query and binds options, images, description, and price', async () => {
  const calls = [];
  const client = createUltaPublicClient({
    now: () => Date.parse('2026-10-05T00:00:00Z'),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      calls.push({ url, init, headers });
      if (url.pathname.startsWith('/p/')) return new Response(productHtmlBootstrap(), {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      assert.equal(url.pathname, '/dxl/graphql');
      assert.equal(url.searchParams.get('operationName'), 'Page');
      const variables = JSON.parse(url.searchParams.get('variables'));
      assert.deepEqual(variables, { url: { path: new URL(PRODUCT_URL).pathname }, moduleParams: { sku: SKU_ID } });
      return jsonResponse(productPagePayload());
    },
  });
  const { product, receipt } = await client.getProduct({ productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL });
  const apiCall = calls.find(call => call.url.pathname === '/dxl/graphql');

  assert.equal(calls.length, 2);
  assert.equal(apiCall.init.method, 'GET');
  assert.equal(apiCall.init.redirect, 'manual');
  assert.equal(apiCall.init.credentials, 'omit');
  assert.equal(apiCall.headers.get('cookie'), null);
  assert.equal(apiCall.headers.get('authorization'), null);
  assert.equal(apiCall.headers.get('x-ulta-dxl-query-id'), `Page::${new URL(PRODUCT_URL).pathname}`);
  assert.equal(apiCall.headers.get('x-ulta-graph-module-name'), 'RouteContainer');
  assert.equal(product.productId, PRODUCT_ID);
  assert.equal(product.skuId, SKU_ID);
  assert.equal(product.productUrl, PRODUCT_URL);
  assert.equal(product.title, 'Serum Lipstick');
  assert.equal(product.currency, 'USD');
  assert.deepEqual(product.price, { amount: '9.99', currency: 'USD', kind: 'retail_list' });
  assert.equal(product.description, 'Full public product description.');
  assert.equal(product.ingredients, 'Water, pigment.');
  assert.equal(product.images.length, 1);
  assert.equal(product.images[0].imageUrl, 'https://media.ulta.com/i/ulta/2648428');
  assert.equal(product.options.length, 2);
  assert.equal(product.selectedVariant.skuId, SKU_ID);
  assert.equal(product.rating, 4.7);
  assert.equal(product.reviewCount, 429);
  assert.equal(receipt.productIdMatched, true);
  assert.equal(receipt.skuIdMatched, true);
  assert.equal(receipt.request.httpStatus, 200);
  assert.equal(JSON.stringify({ product, receipt }).includes('test-only-public-key'), false);
});

test('Ulta rejects an unsourced product URL or an API response bound to a different product', async () => {
  let calls = 0;
  const client = createUltaPublicClient({ fetchImpl: async input => {
    calls++;
    const url = new URL(input);
    if (url.pathname.startsWith('/p/')) return new Response(productHtmlBootstrap(), {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    const mismatched = productPagePayload();
    mismatched.data.Page.content.modules.find(module => module.moduleName === 'ProductPricing').productId = 'pimprod9999999';
    return jsonResponse(mismatched);
  } });
  await assert.rejects(client.getProduct({ productId: PRODUCT_ID, skuId: SKU_ID, productUrl: 'https://evil.example/p/serum-lipstick-pimprod2057119' }), {
    code: 'ULTA_PRODUCT_URL_INVALID',
  });
  await assert.rejects(client.getProduct({ productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL }), {
    code: 'ULTA_PRODUCT_BINDING_MISMATCH',
  });
  assert.equal(calls, 2);
});

test('Ulta PowerReviews direct reads return bound public review bodies, ratings, images, and server pagination', async () => {
  const calls = [];
  const client = createUltaPublicClient({
    now: () => Date.parse('2026-10-05T00:00:00Z'),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      calls.push({ url, init, headers });
      if (url.pathname.startsWith('/p/')) return new Response(productHtmlBootstrap(), {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      assert.equal(url.origin, 'https://display.powerreviews.com');
      assert.equal(url.pathname, `/m/9001/l/en_US/product/${PRODUCT_ID}/reviews`);
      assert.equal(url.searchParams.get('apikey'), 'test-only-public-key');
      assert.equal(url.searchParams.get('paging.size'), '2');
      const offset = Number(url.searchParams.get('paging.from') ?? 0);
      return jsonResponse(reviewPayload(offset === 0 ? 1 : 2));
    },
  });

  const first = await client.getReviews({ productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL, page: 1, pageSize: 2 });
  assert.equal(first.productIdMatched, true);
  assert.equal(first.paginationVerified, true);
  assert.equal(first.reviews.length, 2);
  assert.equal(first.reviews[0].reviewId, '101');
  assert.equal(first.reviews[0].body, 'First public body');
  assert.equal(first.reviews[0].rating, 3);
  assert.equal(first.reviews[0].postedAt, '2026-09-26T21:01:58.282Z');
  assert.deepEqual(first.reviews[1].images, [{
    url: 'https://res.cloudinary.com/powerreviews/image/upload/fixture.jpg', type: 'image',
  }]);
  assert.deepEqual(first.pagination, {
    page: 1, pageSize: 2, total: 3, pagesTotal: 2, hasMore: true, nextPage: 2, complete: false, verified: true,
  });
  assert.equal(first.receipts[0].request.httpStatus, 200);
  assert.equal(first.receipts[0].request.origin, 'https://display.powerreviews.com');
  assert.equal(first.receipts[0].request.method, 'GET');
  assert.equal(first.receipts[0].request.path, `/m/9001/l/en_US/product/${PRODUCT_ID}/reviews`);
  assert.equal(first.receipts[0].request.cookieSent, false);
  assert.equal(first.receipts[0].request.authorizationSent, false);
  assert.equal(JSON.stringify(first).includes('test-only-public-key'), false);
  assert.equal(JSON.stringify(first).includes('private display name'), false);
  assert.equal(JSON.stringify(first).includes('private location'), false);

  const second = await client.getReviews({ productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL, page: 2, pageSize: 2 });
  assert.equal(second.reviews.length, 1);
  assert.equal(second.reviews[0].reviewId, '103');
  assert.equal(second.pagination.complete, true);
  assert.equal(second.receipts.length, 1);
  assert.equal(calls.filter(call => call.url.origin === 'https://www.ulta.com' && call.url.pathname.startsWith('/p/')).length, 1);
  assert.equal(calls.filter(call => call.url.origin === 'https://display.powerreviews.com').length, 2);
  assert.equal(calls[2].url.searchParams.get('paging.from'), '2');
  assert.equal(calls[2].url.searchParams.get('apikey'), 'test-only-public-key');
  assert.equal(JSON.stringify(second).includes('test-only-public-key'), false);
});

test('Ulta rejects a cross-origin review continuation and invalid review page bounds', async () => {
  const client = createUltaPublicClient({ fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname.startsWith('/p/')) return new Response(productHtmlBootstrap(), {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    const payload = reviewPayload(1);
    payload.paging.next_page_url = 'https://attacker.example/reviews?paging.from=2&paging.size=2';
    return jsonResponse(payload);
  } });
  await assert.rejects(client.getReviews({
    productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL, page: 2, pageSize: 2,
  }), { code: 'ULTA_REVIEW_PAGINATION_INVALID' });
  for (const input of [
    { productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL, page: 0 },
    { productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL, page: 101 },
    { productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL, pageSize: 26 },
    { productId: PRODUCT_ID, skuId: SKU_ID, productUrl: PRODUCT_URL, pageSize: 101 },
  ]) await assert.rejects(client.getReviews(input), { code: 'ULTA_REVIEW_INPUT_INVALID' });
});
