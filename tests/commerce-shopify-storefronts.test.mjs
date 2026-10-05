import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyStorefrontClient, createShopifyStorefronts } from '../lib/commerce/shopify-storefronts.mjs';

const PRODUCT_HANDLE = 'eeveelution-shadow-palette';
const product = (handle = PRODUCT_HANDLE) => ({
  id: 7593200615506,
  handle,
  title: 'Eeveelution',
  vendor: 'ColourPop',
  type: 'Shadow Palette',
  description: '<p>Product description</p>',
  featured_image: '//cdn.shopify.com/s/files/1/test/product.jpg?v=1',
  images: ['//cdn.shopify.com/s/files/1/test/product.jpg?v=1', 'https://cdn.shopify.com/s/files/1/test/detail.jpg?v=2'],
  options: [{ name: 'Shade', position: 1, values: ['Default Title'] }],
  tags: ['eyes', 'palette'],
  requires_selling_plan: false,
  url: `/products/${handle}`,
  available: true,
  price: 2400,
  price_min: 2400,
  price_max: 2400,
  variants: [
    { id: 41271264378960, title: 'Default Title', price: 2400, available: true,
      option1: 'Default Title', option2: null, option3: null, options: ['Default Title'],
      sku: 'CP-EEVEELUTION', compare_at_price: null, inventory_quantity: 409,
      inventory_management: 'shopify', inventory_policy: 'deny', weight: 119,
      requires_shipping: true, taxable: true, featured_image: null },
  ],
});
const js = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'text/javascript; charset=utf-8' },
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const cart = (currency = 'USD') => ({ token: 'cart-token-must-not-escape', currency, item_count: 0, items: [] });
const OKENDO_STORE_ID = '5419d3a5-7ff7-4bcf-ace6-31f3fa34803d';

function okendoReview(overrides = {}) {
  return {
    reviewId: 'review-1',
    title: 'Lovely colors',
    body: 'The palette looks wonderful.',
    rating: 5,
    dateCreated: '2026-09-29T03:24:36.061Z',
    dateUpdated: '2026-09-29T03:24:36.061Z',
    productId: 'shopify-7593200615506',
    productHandle: PRODUCT_HANDLE,
    reviewer: { displayName: 'Do not expose this name', isVerified: true },
    media: [{ type: 'image', fullSizeUrl: 'https://media-dynamic.okendo.io/images/store/review.jpg?d=1600x1600',
      thumbnailUrl: 'https://media-dynamic.okendo.io/images/store/review.jpg?d=120x120', alt: 'Palette in use' }],
    ...overrides,
  };
}

function okendoFetch({ productPayload = product(), reviews, nextUrl = null } = {}) {
  return async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers.cookie, undefined);
    if (url.origin === 'https://colourpop.com') {
      assert.equal(url.pathname, `/products/${PRODUCT_HANDLE}.js`);
      return js(productPayload);
    }
    assert.equal(url.origin, 'https://api.okendo.io');
    if (url.pathname.endsWith('/review_aggregate')) {
      return json({ reviewAggregate: {
        productId: 'shopify-7593200615506', reviewCount: 32, reviewRatingValuesTotal: 159,
      } });
    }
    assert.equal(url.pathname,
      `/v1/stores/${OKENDO_STORE_ID}/products/shopify-7593200615506/reviews`);
    return json({ areReviewsGrouped: false, reviews, nextUrl });
  };
}

function colourPopDetailFetch(handle, cartCurrency = 'USD') {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://colourpop.com');
    assert.equal(url.search, '');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.authorization, undefined);
    if (calls === 1) {
      assert.equal(url.pathname, `/products/${handle}.js`);
      return js(product(handle));
    }
    assert.equal(url.pathname, '/cart.js');
    return js(cart(cartCurrency));
  };
  return { fetchImpl, getCalls: () => calls };
}

test('ColourPop product reads return USD variant prices and an anonymous receipt', async () => {
  const { fetchImpl, getCalls } = colourPopDetailFetch(PRODUCT_HANDLE);
  const result = await createShopifyStorefrontClient({ store: 'colourpop', fetchImpl,
    now: () => Date.parse('2026-10-05T00:00:00Z') }).getProduct({ handle: PRODUCT_HANDLE });
  assert.equal(getCalls(), 2);
  assert.equal(result.store, 'colourpop');
  assert.equal(result.product.id, 7593200615506);
  assert.equal(result.product.canonicalUrl, `https://colourpop.com/products/${PRODUCT_HANDLE}`);
  assert.equal(result.product.price.amount, '24.00');
  assert.equal(result.product.price.currency, 'USD');
  assert.equal(result.product.variants[0].price.amount, '24.00');
  assert.equal(result.product.variants[0].available, true);
  assert.equal(result.product.descriptionHtml, '<p>Product description</p>');
  assert.deepEqual(result.product.images, [
    'https://cdn.shopify.com/s/files/1/test/product.jpg?v=1',
    'https://cdn.shopify.com/s/files/1/test/detail.jpg?v=2',
  ]);
  assert.deepEqual(result.product.options[0], { name: 'Shade', position: 1, values: ['Default Title'] });
  assert.equal(result.product.variants[0].sku, 'CP-EEVEELUTION');
  assert.equal(result.product.variants[0].inventoryQuantity, 409);
  assert.equal(result.product.variants[0].compareAtPrice, null);
  assert.equal(result.receipt.capabilityId, 'colourpop.catalog.product_detail');
  assert.equal(result.receipt.request.path, `/products/${PRODUCT_HANDLE}.js`);
  assert.equal(result.receipt.request.mime, 'text/javascript');
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.currencyRequest.path, '/cart.js');
  assert.equal(result.receipt.currencyRequest.currency, 'USD');
  assert.equal(JSON.stringify(result).includes('cart-token-must-not-escape'), false);
});

test('ColourPop review pages preserve supplier cursor and public content without author profile fields', async () => {
  const cursor = `/stores/${OKENDO_STORE_ID}/products/shopify-7593200615506/reviews?limit=2&orderBy=date%20desc&lastEvaluated=%7B%22reviewId%22%3A%22review-1%22%7D`;
  let reviewCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.origin === 'https://api.okendo.io' && url.pathname.endsWith('/reviews')) {
      reviewCalls++;
      assert.deepEqual([...url.searchParams.keys()].sort(), reviewCalls === 1
        ? ['limit', 'orderBy'] : ['lastEvaluated', 'limit', 'orderBy']);
      if (reviewCalls === 1) assert.equal(url.searchParams.get('orderBy'), 'date desc');
    }
    return okendoFetch({ reviews: [okendoReview()], nextUrl: cursor })(url, init);
  };
  const client = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl });
  const result = await client.getReviews({ handle: PRODUCT_HANDLE, pageSize: 2 });
  assert.equal(result.totalReviews, 32);
  assert.equal(result.averageRating, 4.97);
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].reviewId, 'review-1');
  assert.equal(result.reviews[0].body, 'The palette looks wonderful.');
  assert.equal(result.reviews[0].rating, 5);
  assert.equal(result.reviews[0].postedAt, '2026-09-29T03:24:36.061Z');
  assert.equal(result.reviews[0].verifiedPurchase, null);
  assert.equal(result.reviews[0].sourceVerification.value, true);
  assert.deepEqual(result.reviews[0].images, [{
    url: 'https://media-dynamic.okendo.io/images/store/review.jpg?d=1600x1600',
    thumbnailUrl: 'https://media-dynamic.okendo.io/images/store/review.jpg?d=120x120',
    alt: 'Palette in use',
  }]);
  assert.equal(result.nextCursor, cursor);
  assert.equal(result.receipt.paginationVerified, true);
  assert.equal(result.receipt.request.origin, 'https://api.okendo.io');
  assert.equal(result.receipt.request.path,
    `/v1/stores/${OKENDO_STORE_ID}/products/shopify-7593200615506/reviews`);
  assert.deepEqual(result.receipt.request.queryFields, ['limit', 'orderBy']);
  assert.equal(JSON.stringify(result).includes('Do not expose this name'), false);
  assert.equal(JSON.stringify(result).includes('displayName'), false);

  const next = await client.getReviews({ handle: PRODUCT_HANDLE, pageSize: 2, cursor: result.nextCursor });
  assert.equal(next.reviews[0].reviewId, 'review-1');
  assert.equal(reviewCalls, 2);
});

test('ColourPop review pagination only accepts same-store same-product cursors', async () => {
  let vendorCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.origin === 'https://api.okendo.io') vendorCalls++;
    return okendoFetch({ reviews: [okendoReview()] })(url, init);
  };
  const client = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl });
  for (const cursor of [
    'https://attacker.example/v1/stores/x/products/shopify-1/reviews?limit=2&orderBy=date%20desc&lastEvaluated=x',
    `/stores/${OKENDO_STORE_ID}/products/shopify-999/reviews?limit=2&orderBy=date%20desc&lastEvaluated=x`,
    `/stores/${OKENDO_STORE_ID}/products/shopify-7593200615506/reviews?limit=20&orderBy=date%20desc&lastEvaluated=x`,
  ]) {
    await assert.rejects(client.getReviews({ handle: PRODUCT_HANDLE, pageSize: 2, cursor }),
      { code: 'SHOPIFY_REVIEW_CURSOR_INVALID' });
  }
  assert.equal(vendorCalls, 0);
});

test('ColourPop product handles cannot alter the fixed path or origin', async () => {
  let calls = 0;
  const client = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: async () => {
    calls++;
    throw new Error('unexpected network call');
  } });
  for (const handle of ['', '../cart', 'x/y', 'x?currency=EUR', 'x#fragment',
    'https://attacker.example/item', 'x'.repeat(121), null, 2]) {
    await assert.rejects(client.getProduct({ handle }), { code: 'SHOPIFY_PRODUCT_HANDLE_INVALID' });
  }
  assert.equal(calls, 0);
});

test('response handle and product schema are bound to the requested ColourPop handle', async () => {
  const handle = 'eeveelution';
  const wrong = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: async () => js(product('other-item')) });
  await assert.rejects(wrong.getProduct({ handle }), { code: 'SHOPIFY_PRODUCT_SCHEMA_INVALID' });
  for (const mutate of [
    value => { value.price = -1; },
    value => { value.available = 'true'; },
    value => { value.variants[0].id = value.variants[0].id; value.variants.push({ ...value.variants[0] }); },
    value => { value.variants[0].available = 1; },
  ]) {
    const fixture = product(handle);
    mutate(fixture);
    const client = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: async () => js(fixture) });
    await assert.rejects(client.getProduct({ handle }), { code: 'SHOPIFY_PRODUCT_SCHEMA_INVALID' });
  }
});

test('ColourPop predictive search requests product suggestions at the declared limit and strips tracking', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://colourpop.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.authorization, undefined);
    if (calls === 1) {
      assert.equal(url.pathname, '/search/suggest.json');
      assert.deepEqual([...url.searchParams], [
        ['q', 'eeveelution'],
        ['resources[type]', 'product'],
        ['resources[limit]', '5'],
        ['resources[options][unavailable_products]', 'hide'],
      ]);
      return json({ resources: { results: { products: [{
        id: 7593200615506, handle: PRODUCT_HANDLE, title: 'Eeveelution', vendor: 'ColourPop',
        type: 'Shadow Palette', available: true, price: '24.00', price_min: '24.00', price_max: '24.00',
        url: `/products/${PRODUCT_HANDLE}?_pos=2&_psq=eeveelution&_psid=ephemeral-search-token`,
      }] } } });
    }
    assert.equal(url.pathname, '/cart.js');
    return js(cart());
  };
  const result = await createShopifyStorefrontClient({ store: 'colourpop', fetchImpl })
    .searchProducts({ query: ' eeveelution ', limit: 5 });
  assert.equal(calls, 2);
  assert.equal(result.query, 'eeveelution');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].price.amount, '24.00');
  assert.equal(result.products[0].price.currency, 'USD');
  assert.equal(result.products[0].canonicalUrl, `https://colourpop.com/products/${PRODUCT_HANDLE}`);
  assert.equal(result.products[0].canonicalUrl.includes('ephemeral-search-token'), false);
  assert.equal(result.receipt.capabilityId, 'colourpop.catalog.predictive_search');
  assert.equal(result.receipt.request.path, '/search/suggest.json');
  assert.deepEqual(result.receipt.request.queryFields,
    ['q', 'resources[type]', 'resources[limit]', 'resources[options][unavailable_products]']);
  assert.equal(JSON.stringify(result.receipt).includes('eeveelution'), false);
});

test('predictive search rejects unsafe inputs, unbound products, and more results than requested', async () => {
  let calls = 0;
  const client = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: async () => {
    calls++;
    throw new Error('unexpected network call');
  } });
  for (const query of ['', ' ', '\nquery', 'x'.repeat(101), null, 3]) {
    await assert.rejects(client.searchProducts({ query }), { code: 'SHOPIFY_SEARCH_INPUT_INVALID' });
  }
  for (const limit of [0, 11, 1.5, '5', null]) {
    await assert.rejects(client.searchProducts({ query: 'runner', limit }),
      { code: 'SHOPIFY_SEARCH_INPUT_INVALID' });
  }
  assert.equal(calls, 0);

  const base = { id: 1, handle: 'eeveelution', title: 'Eeveelution', vendor: 'ColourPop',
    type: 'Shadow Palette', available: true, price: '24.00', price_min: '24.00', price_max: '24.00',
    url: '/products/eeveelution' };
  for (const mutate of [
    item => { item.url = 'https://attacker.example/products/eeveelution'; },
    item => { item.url = '/products/other-item'; },
    item => { item.price = '24'; },
    item => { item.available = 1; },
  ]) {
    const fixture = { ...base };
    mutate(fixture);
    const invalid = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: async () =>
      json({ resources: { results: { products: [fixture] } } }) });
    await assert.rejects(invalid.searchProducts({ query: 'eeveelution' }),
      { code: 'SHOPIFY_SEARCH_SCHEMA_INVALID' });
  }
  const excess = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: async () =>
    json({ resources: { results: { products: Array.from({ length: 2 }, (_, i) => ({ ...base,
      id: i + 1, handle: `item-${i + 1}`, url: `/products/item-${i + 1}` })) } } }) });
  await assert.rejects(excess.searchProducts({ query: 'runner', limit: 1 }),
    { code: 'SHOPIFY_SEARCH_SCHEMA_INVALID' });
});

test('ColourPop responses reject redirects, HTML gates, wrong MIME types, and throttling', async () => {
  const handle = 'eeveelution';
  for (const [response, code] of [
    [new Response('<html>blocked</html>', { status: 403,
      headers: { 'content-type': 'text/html' } }), 'SHOPIFY_ACCESS_BLOCKED'],
    [new Response(null, { status: 302, headers: { location: 'https://colourpop.com/password' } }),
      'SHOPIFY_RESPONSE_INVALID'],
    [new Response('<html>blocked</html>', { status: 200,
      headers: { 'content-type': 'text/html' } }), 'SHOPIFY_RESPONSE_INVALID'],
    [new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
      'SHOPIFY_THROTTLED'],
    [new Response('{}', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'SHOPIFY_RESPONSE_INVALID'],
  ]) {
    const client = createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: async () => response });
    await assert.rejects(client.getProduct({ handle }), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.origin, 'https://colourpop.com');
      assert.equal(error.receipt.path, `/products/${handle}.js`);
      assert.equal(JSON.stringify(error.receipt).includes('blocked'), false);
      return true;
    });
  }
});

test('product price is rejected when the anonymous presentment currency is not verified USD', async () => {
  const unsupported = colourPopDetailFetch(PRODUCT_HANDLE, 'JPY');
  await assert.rejects(createShopifyStorefrontClient({ store: 'colourpop', fetchImpl: unsupported.fetchImpl })
    .getProduct({ handle: PRODUCT_HANDLE }), { code: 'SHOPIFY_CURRENCY_UNSUPPORTED' });
});

test('storefront facade delegates to the existing Allbirds client without changing its output shape', async () => {
  const handle = 'mens-runner';
  const allbirdsProduct = {
    id: 1, handle, title: 'Runner', vendor: 'Allbirds', type: 'Shoes', url: `/products/${handle}`,
    available: true, price: 10000, price_min: 10000, price_max: 10000,
    variants: [{ id: 2, title: '8', price: 10000, available: true, option1: '8', option2: null, option3: null }],
  };
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    if (calls === 1) return js(allbirdsProduct);
    return js({ currency: 'USD', item_count: 0, items: [] });
  };
  const result = await createShopifyStorefronts({ fetchImpl }).getProduct({ store: 'allbirds', handle });
  assert.equal(result.store, 'allbirds');
  assert.equal(result.product.price.amount, '100.00');
  assert.equal(result.product.canonicalUrl, `https://www.allbirds.com/products/${handle}`);
  assert.equal(result.receipt.service, 'shopify-storefronts');
  assert.equal(result.receipt.capabilityId, 'allbirds.catalog.product_detail');
  assert.deepEqual(createShopifyStorefronts().stores, ['allbirds', 'colourpop']);
});

test('Allbirds full reviews stay explicitly blocked while its Yotpo widget is disabled', async () => {
  let calls = 0;
  const client = createShopifyStorefronts({ fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  await assert.rejects(client.getReviews({ store: 'allbirds', handle: 'mens-runner' }), error => {
    assert.equal(error.code, 'SHOPIFY_REVIEW_SOURCE_DISABLED');
    assert.equal(error.receipt.capabilityId, 'allbirds.catalog.reviews');
    assert.match(error.receipt.blocker, /yotpoEnabled=false/);
    return true;
  });
  assert.equal(calls, 0);
});

test('storefront selection has a fixed, explicit provider allowlist', () => {
  assert.throws(() => createShopifyStorefrontClient({ store: 'example.com' }),
    { code: 'SHOPIFY_STORE_UNSUPPORTED' });
});
