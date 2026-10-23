import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { definitions } from '../lib/service-operations/commerce.mjs';
import { createOperationRegistry, validateOperationValue } from '../lib/operation-registry.mjs';
import { COMMERCE_PROVIDERS } from '../lib/commerce/providers.mjs';
import { checkOperations } from '../lib/operation-health.mjs';

// Entirely deterministic local fixtures: these tests never call a live service.
const NOW = Date.parse('2026-10-20T00:00:00Z');
const byId = id => { const d = definitions.find(entry => entry.id === id); assert.ok(d, id); return d; };
const bind = (id, options = {}) => {
  const definition = byId(id), binding = definition.createAdapters({ now: () => NOW, ...options });
  return { ...createOperationRegistry(definition.profile, binding), close: binding.close };
};
const receipt = { method: 'GET', origin: 'https://fixture.example.invalid', path: '/products',
  httpStatus: 200, browserUsed: false, credentialsUsed: false, cookieSent: false };
const money = (amount = '10.00', currency = 'USD', kind = 'retail_current') => ({ amount, currency, kind });
const offer = { productId: 'product-1', title: 'Fixture product', url: null, price: money(), availability: 'unknown' };
const credentialProvider = async id => {
  const provider = id === 'printful' ? 'printful-api' : id === 'amazon' ? 'amazon-public' : id === 'shopee-affiliate-id' ? 'shopee-id' : id;
  const keys = COMMERCE_PROVIDERS[provider]?.credentials ?? (id === 'adpick' ? ['apiKey'] : ['appId']);
  return Object.fromEntries(keys.map(key => [key, key === 'session' ? { authorization: 'fixture_session_secret_only' } : `fixture_${key}_secret_only`]));
};
const assertFinite = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return; }
  assert.equal(typeof value, 'object');
  assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
  for (const item of Object.values(value)) assertFinite(item);
};

test('review output limit does not shrink the observed native page size', async () => {
  for (const [id, expected] of [['ulta', 20], ['shopify-storefronts', 5]]) {
    let observed;
    const registry = bind(id, { factories: { [id]: () => ({
      async getReviews(input) {
        observed = input;
        return { productId: 'fixture-product', reviews: [], productIdMatched: true,
          nextCursor: null, paginationVerified: true, totalReviews: 0, receipt };
      },
    }) } });
    try {
      await registry.execute('reviews', { path: { id: 'fixture-product' }, query: { limit: 1, maxPages: 1 } });
      assert.equal(observed.pageSize, expected, id);
    } finally { await registry.close(); }
  }
});

test('all 25 canonical profiles, aliases, defaults and check metadata are valid and lazy', async () => {
  assert.equal(definitions.length, 25);
  const names = new Set(); let network = 0, credentials = 0;
  for (const definition of definitions) {
    for (const name of [definition.id, ...(definition.aliases ?? [])]) { assert.ok(!names.has(name), name); names.add(name); }
    const registry = bind(definition.id, { fetchImpl: () => { network++; throw Error('fixture network forbidden'); },
      credentialProvider: () => { credentials++; throw Error('fixture credential forbidden'); } });
    assert.equal(registry.profile.schemaVersion, 2);
    assert.deepEqual(registry.profile.allowedOrigins, []);
    for (const entry of registry.list()) {
      assert.equal(entry.semantics, 'read');
      assert.ok(entry.evidence.includes('lib/commerce/') || entry.evidence.includes('lib/retail/amazon.mjs'));
      assertFinite(entry);
    }
    assertFinite(registry.tools()); assertFinite(registry.profile);
    const preceding = new Set();
    for (const check of definition.verificationChecks) {
      assert.equal(check.kind, 'live_read');
      let references = 0;
      const inspect = value => {
        if (!value || typeof value !== 'object') return;
        if (Object.hasOwn(value, '$result')) {
          references++; assert.deepEqual(Object.keys(value), ['$result']);
          assert.ok(preceding.has(value.$result.operation)); assert.ok(value.$result.pointer.startsWith('/'));
        } else for (const item of Object.values(value)) inspect(item);
      };
      inspect(check.input);
      if (!references) validateOperationValue(check.input, registry.describe(check.operation).inputSchema);
      assertFinite(check);
      preceding.add(check.operation);
    }
    await registry.close();
  }
  assert.deepEqual([network, credentials], [0, 0]);
  assert.deepEqual(byId('printful').aliases, ['printful-feed']);
  assert.deepEqual(byId('amazon').aliases, ['amazon-public']);
  assert.deepEqual(byId('shopee-affiliate-id').aliases, ['shopee-id']);
  assert.deepEqual(byId('ebay-partner').requires, ['accessToken']);
  assert.deepEqual(byId('adpick').requires, ['apiKey']);
  assert.deepEqual(byId('yahoo-shopping-jp').requires, ['appId']);
  assert.deepEqual(byId('oliveyoung-public').requires, []);
  for (const id of ['awin', 'sephora-affiliate', 'ulta-affiliate']) assert.deepEqual(byId(id).verificationChecks, []);
});

const affiliate = { productId: '123:1', variantId: 'sku-1', title: 'Fixture product', canonicalURL: null,
  affiliateURL: 'https://tracking.example.invalid/returned-link', price: money('30.00', 'USD', 'retail_list'),
  salePrice: money('25.00'), source: { advertiserId: '123' } };
const affiliateResult = { items: [affiliate], pagination: { page: 1, pageSize: 20, totalPages: 1, conservativeResultCap: 1000 }, receipt };
const globalProduct = { id: 'GA240824996', name: 'Fixture mask', url: 'https://global.oliveyoung.com/product/detail?prdtNo=GA240824996',
  price: money('13.50'), listPrice: money('27.00'), marketContext: { currencyVerified: true } };
const cases = [
  ['printful', 'printful-feed', 'getPublicCatalogFeed', { products: [{ variantId: 1, title: 'Fixture shirt', color: 'blue', size: 'L',
    categories: 'shirts', type: 'Shirt', productPrice: money() }], region: 'USA', receipt }, {}, 'regional_catalog_base'],
  ['shopify-storefronts', 'shopify-storefronts', 'searchProducts', { products: [{ id: 1, title: 'Fixture product', canonicalUrl: null,
    price: money(), available: true }], receipt }, {}, 'retail_current'],
  ['aliexpress-partner', 'aliexpress-partner', 'searchProducts', { products: [{ productId: '1', title: 'Fixture product', url: null,
    salePrice: money() }], page: 1, pageCount: 1, receipt }, {}, 'retail_current'],
  ['aliexpress-social', 'aliexpress-social', 'searchSocialProducts', { products: [{ productId: '1', title: 'Fixture product', url: null,
    salePrice: money() }], page: 1, pageSize: 20, totalCount: 1, receipt }, {}, 'retail_current'],
  ['ebay-partner', 'ebay-partner', 'searchItems', { items: [{ itemId: '1', title: 'Fixture product', itemWebUrl: null, price: money() }],
    marketplaceId: 'EBAY_US', pagination: { total: 1, nextOffset: null }, receipt }, {}, 'retail_current'],
  ['amazon-partner', 'amazon-partner', 'searchItems', { items: [{ asin: 'B004YAVF8I', title: 'Fixture product', url: null,
    offers: [{ currentPrice: money() }] }], totalResultCount: 1, partial: false, receipt }, {}, 'retail_current'],
  ['amazon', 'amazon-public', 'searchProducts', { page: 1, items: [{ asin: 'B004YAVF8I', title: 'Fixture product', productUrl: null,
    currentDisplayPrice: { amount: '13413', currencyCode: 'KRW', displayText: 'KRW 13,413' } }], receipt }, {}, 'retail_current'],
  ['cjdropshipping', 'cjdropshipping', 'searchProducts', { products: [{ productId: '1', title: 'Fixture product', price: { raw: '3.00-4.00', currency: 'USD' } }],
    pagination: { page: 1, totalPages: 1, totalRecords: 1 }, receipt }, {}, 'supplier_catalog'],
  ['banggood', 'banggood', 'listProducts', { products: [{ productId: '1', name: 'Fixture product', productUrl: null, price: money() }], receipt }, {}, 'retail_current'],
  ['awin', 'awin', 'searchProducts', { items: [offer], page: { page: 1, hasMore: false }, receipt }, { advertiserId: '123', locale: 'en_GB' }, 'retail_current'],
  ['impact', 'impact', 'searchProducts', { items: [offer], page: { page: 1, hasMore: false }, receipt }, {}, 'retail_current'],
  ['oliveyoung', 'oliveyoung', 'searchProducts', { products: [offer], receipt }, {}, 'retail_current'],
  ['oliveyoung-public', 'oliveyoung-public', 'searchProducts', { products: [{ ...offer, productId: 'A000000268586' }],
    pagination: { nextPage: null }, receipt }, {}, 'retail_current'],
  ['oliveyoung-global', 'oliveyoung-global', 'getBestSellers', { products: [globalProduct], marketContext: { currencyVerified: true }, receipt }, {}, 'retail_current'],
  ['shopee-affiliate-id', 'shopee-id', 'searchProducts', { products: [{ itemId: '1', title: 'Fixture product', price: money('15000', null),
    priceRange: { min: '10000', max: '15000' } }], pageInfo: { page: 1, hasNextPage: false }, request: receipt }, {}, 'retail_current'],
  ['rakuten-ichiba', 'rakuten-ichiba', 'searchItems', { products: [{ itemCode: 'shop:1', shopCode: 'shop', title: 'Fixture product',
    canonicalUrl: null, price: money('1000', 'JPY'), availability: 'unknown' }], pagination: { nextPage: null }, receipt }, {}, 'retail_current'],
  ['rakuten-advertising', 'rakuten-advertising', 'searchProducts', affiliateResult, {}, 'retail_list'],
  ['sephora-affiliate', 'sephora-affiliate', 'searchProducts', affiliateResult, { merchantId: '123' }, 'retail_list'],
  ['ulta-affiliate', 'ulta-affiliate', 'listProducts', { items: [offer], receipt }, { catalogId: '123' }, 'retail_current'],
  ['sephora', 'sephora', 'searchProducts', { page: 1, pageSize: 20, totalProducts: 1, products: [{ productId: 'P12345', variantId: '100001',
    brandName: 'Fixture', productName: 'Serum', productUrl: null, price: money(), priceScope: 'current_sku' }], receipt }, {}, 'retail_list'],
  ['ulta', 'ulta', 'searchProducts', { page: 1, pageCount: 1, products: [{ productId: 'pimprod2057119', variantId: '2648428',
    brandName: 'Fixture', productName: 'Serum', productUrl: null, price: money(), salePrice: money() }], receipt }, {}, 'retail_current'],
];
for (const [id, provider, method, native, extra, expectedKind] of cases) {
  test(`local native-reader fixture: ${id} executes concrete ${method} and preserves source/price scope`, async () => {
    let reads = 0, closed = 0; const calls = [];
    const registry = bind(id, { credentialProvider, factories: { [provider]: options => {
      assert.equal(typeof options.fetchImpl, 'function');
      return { [method]: async args => { reads++; calls.push(args); return structuredClone(native); }, close: async () => { closed++; } };
    } } });
    const operation = id === 'oliveyoung-global' ? 'collect' : 'search';
    const query = { ...(id === 'oliveyoung-global' ? {} : { query: id === 'printful' ? 'shirt' : 'serum' }), ...extra, limit: 20 };
    const result = await registry.execute(operation, { query });
    assert.equal(reads, 1); assert.equal(closed, 1);
    assert.ok(result.data.offers.length > 0);
    const first = result.data.offers[0];
    assert.equal((first.price ?? first.priceRange.min).kind, expectedKind);
    assert.equal(first.provider, provider); assert.ok(first.source);
    assert.equal(result.data.collection.pagesRead, 1);
    assert.equal(result.pageInfo.completeCatalog, false);
    assert.equal(result.receipt.networkUsed, false, 'client factory fixture is not live HTTP');
    if (id === 'amazon') { assert.equal(first.price.currency, 'KRW'); assert.equal(first.context.marketplace, 'www.amazon.com'); }
    if (id === 'shopee-affiliate-id') { assert.equal(first.price.currency, null); assert.equal(result.data.collection.complete, false); }
    if (id === 'rakuten-advertising') {
      assert.deepEqual(result.data.offers.map(item => item.price.kind), ['retail_list', 'reported_sale']);
      assert.equal(first.affiliateLink.attributionVerified, false);
    }
    if (id === 'shopify-storefronts') assert.equal(result.data.collection.coverage, 'predictive_sample');
    if (id === 'printful') assert.equal(first.context.region, 'USA');
    if (id === 'ulta') assert.equal(calls[0].pageSize, 100, 'upstream 64+sponsored card contract retained');
    assertFinite(result); assert.ok(!JSON.stringify(result).includes('_secret_only'));
    await registry.close(); assert.equal(closed, 1);
  });
}

test('protected adapters are lazy and missing providers never open clients or silently mint an eBay token', async () => {
  const providers = ['aliexpress-partner', 'aliexpress-social', 'ebay-partner', 'amazon-partner', 'cjdropshipping', 'banggood',
    'awin', 'impact', 'oliveyoung', 'shopee-affiliate-id', 'rakuten-ichiba', 'rakuten-advertising', 'sephora-affiliate', 'ulta-affiliate', 'adpick', 'yahoo-shopping-jp'];
  for (const id of providers) {
    let network = 0;
    const registry = bind(id, { fetchImpl: () => { network++; throw Error('forbidden'); } });
    const input = id === 'adpick' ? { q: 'serum' } : id === 'awin' ? { query: 'serum', advertiserId: '123', locale: 'en_GB' }
      : id === 'sephora-affiliate' ? { query: 'serum', merchantId: '123' }
        : id === 'ulta-affiliate' ? { query: 'serum', catalogId: '123' } : { query: 'serum' };
    await assert.rejects(registry.execute('search', { query: input }), { code: 'PROVIDER_MISSING' });
    assert.equal(network, 0); await registry.close();
  }
  const ebay = bind('ebay-partner', { credentialProvider: async () => ({ clientId: 'fixture-id', clientSecret: 'fixture-secret' }),
    fetchImpl: () => { throw Error('token mint forbidden'); } });
  await assert.rejects(ebay.execute('search', { query: { query: 'serum' } }), { code: 'PROVIDER_MISSING' }); await ebay.close();
});

test('concrete Olive Young suggestions route honors fetch injection, but never labels a fixture as live', async () => {
  const calls = [];
  const registry = bind('oliveyoung-global', { fetchImpl: async (input, init) => {
    const url = new URL(input); calls.push(url.pathname);
    assert.equal(url.pathname, '/api/v1/search/keywords/auto-complete'); assert.equal(url.searchParams.get('query'), 'toner');
    assert.equal(init.method, 'GET');
    return Response.json({ brands: [], categories: [], keywords: [{ keyword: 'Fixture toner' }] });
  } });
  const result = await registry.execute('suggest', { query: { query: 'toner' } });
  assert.deepEqual(result.data.data.keywords, ['Fixture toner']); assert.equal(result.data.data.containsProducts, false);
  assert.equal(result.receipt.networkUsed, false); assert.equal(result.receipt.transportCalls, 1);
  assert.equal(result.data.receipts[0].httpStatus, 200); assert.equal(calls.length, 1);
  assertFinite(result); await registry.close();
});

test('concrete Amazon streaming transport is used, preserving explicit KRW rather than inferred USD', async () => {
  const asin = 'B004YAVF8I', frame = (name, payload) => JSON.stringify(['dispatch', name, payload]);
  const frames = [frame('data-search-metadata', { metadata: { keywords: 'wireless mouse', page: 1, asinOnPageCount: 1,
    totalResultCount: 33000, marketplaceId: 'ATVPDKIKX0DER', locale: 'en_US' } }),
  frame('data-title-and-meta', { title: 'Fixture search', html: '' }), frame('data-main-slot:search-result-1', { asin, index: 1,
    html: `<div data-asin="${asin}"><h2><span>Fixture mouse</span></h2><a href="/dp/${asin}">view</a>` +
      '<span class="a-price"><span class="a-offscreen">KRW&nbsp;13,413</span></span></div>', data: {} })].join('\n&&&\n');
  let calls = 0;
  const registry = bind('amazon', { fetchImpl: async (url, init) => {
    calls++; assert.equal(new URL(url).origin, 'https://www.amazon.com'); assert.equal(init.method, 'POST');
    return new Response(frames, { headers: { 'content-type': 'application/json-amazonui-streaming' } });
  } });
  const result = await registry.execute('search', { query: { query: 'wireless mouse', limit: 1 } });
  assert.equal(calls, 1); assert.equal(result.data.offers[0].price.currency, 'KRW');
  assert.equal(result.data.offers[0].price.amount, '13413'); assert.equal(result.data.collection.coverage, 'provider_limited');
  assertFinite(result); await registry.close();
});

test('concrete Sephora search uses its existing JSON contract and keeps product-range identity', async () => {
  let calls = 0;
  const registry = bind('sephora', { fetchImpl: async url => {
    calls++; assert.equal(new URL(url).pathname, '/api/v2/catalog/search/');
    return Response.json({ keyword: 'lipstick', totalProducts: 1, products: [{ productId: 'P12345', productName: 'Fixture lipstick',
      displayName: 'Fixture lipstick', brandName: 'Fixture', rating: '4.5', reviews: '1',
      heroImage: 'https://www.sephora.com/productimages/sku/100001-hero.jpg', targetUrl: '/product/fixture-P12345?skuId=100001',
      currentSku: { skuId: '100001', listPrice: '$16.00 - $25.00', isNew: false }, onSaleData: 'NONE' }] });
  } });
  const result = await registry.execute('search', { query: { query: 'lipstick', limit: 1 } });
  const first = result.data.offers[0]; assert.equal(calls, 1); assert.equal(first.price, null); assert.equal(first.variantId, null);
  assert.equal(first.priceRange.min.currency, 'USD'); assert.equal(first.priceRange.min.kind, 'retail_list');
  assert.equal(first.context.priceBasis, 'product_range'); assertFinite(result); await registry.close();
});

test('concrete Ably categories bootstrap only an in-memory anonymous token and expose no raw state', async () => {
  const categories = JSON.parse(await readFile(new URL('./fixtures/ably/ranking-filters.json', import.meta.url), 'utf8'));
  const calls = [];
  const registry = bind('ably', { fetchImpl: async url => {
    const path = new URL(url).pathname; calls.push(path);
    return Response.json(path === '/api/v2/anonymous/token/' ? { token: 'fixture.anonymous.token' } : categories);
  } });
  const result = await registry.execute('categories');
  assert.deepEqual(calls, ['/api/v2/anonymous/token/', '/api/v2/goods/ranking-filters/']);
  assert.ok(result.data.data.verticals.length > 0); assert.equal(result.data.requests.length, 2);
  assert.equal(result.receipt.networkUsed, false); assert.ok(!JSON.stringify(result).includes('fixture.anonymous.token'));
  assertFinite(result); await registry.close();
});

test('concrete Adpick GET preserves sanctioned business output and redacts its key-bearing path', async () => {
  let calls = 0;
  const key = 'fixture_adpick_key_not_live';
  const registry = bind('adpick', { credentialProvider: async id => { assert.equal(id, 'adpick'); return { apiKey: key }; },
    fetchImpl: async (url, init) => { calls++; assert.equal(init.method, 'GET'); assert.ok(new URL(url).pathname.includes(key));
      return Response.json({ success: true, message: 'Fixture', data: [{ cp_code: 'FIXTURE', name: 'Fixture mall',
        icon: 'https://example.invalid/icon.png', title: 'Fixture title', commissionlink: '', commission_per: '3.0' }] }); } });
  const result = await registry.execute('malls');
  assert.equal(calls, 1); assert.equal(result.data.data[0].commission_per, '3.0');
  assert.equal(result.data.receipt.path, '/api/{redacted}/malls'); assert.equal(JSON.stringify(result).includes(key), false);
  assertFinite(result); await registry.close();
});

test('catalog preserves description/media/options while sanitized native reviews discard reviewer identities', async () => {
  const id = 'GA240824996'; let productCalls = 0, reviewCalls = 0;
  const registry = bind('oliveyoung-global', { factories: { 'oliveyoung-global': () => ({
    getProduct: async () => { productCalls++; return { product: { ...globalProduct, descriptionHtml: '<p>Fixture details</p>',
      images: ['https://example.invalid/photo.jpg'], options: [{ variantId: 'sku-1', name: 'Green', price: money('14.00') }] }, receipt }; },
    getReviews: async ({ pageNum }) => { reviewCalls++; assert.equal(pageNum, 1); return { productId: id, productIdMatched: true,
      reviews: [{ reviewId: 'review-1', body: 'Fixture body', rating: 5, optionName: 'Green', memberId: 'not-business-output',
        images: [{ video: false, imageUrl: 'https://example.invalid/review.jpg' }] }], nextCursor: 2, paginationVerified: true,
      totalReviews: 2, receipt }; },
  }) } });
  const product = await registry.execute('product', { path: { id } });
  assert.equal(productCalls, 1); assert.equal(product.data.data.product.descriptionHtml, '<p>Fixture details</p>');
  assert.equal(product.data.data.product.options[0].price.currency, 'USD');
  const reviews = await registry.execute('reviews', { path: { id }, query: { limit: 1 } });
  assert.equal(reviewCalls, 1); assert.equal(reviews.data.reviews[0].body, 'Fixture body');
  assert.equal(reviews.data.reviews[0].variantLabel, 'Green'); assert.equal(reviews.data.collection.complete, false);
  assert.equal(reviews.data.collection.nextCursor, 2); assert.equal(reviews.data.reviews[0].memberId, undefined);
  assertFinite(product); assertFinite(reviews); await registry.close();
});

test('domestic Olive Young reviews use the implemented anonymous cursor contract despite the runner readiness gate', async () => {
  const id = 'A000000268586'; let calls = 0;
  const registry = bind('oliveyoung-public', { factories: { 'oliveyoung-public': () => ({ getReviews: async input => {
    calls++; assert.equal(input.goodsNumber, id); assert.equal(input.continuation, null);
    return { productId: id, totalReviews: 2, continuation: { cursorId: 'next', cursorScore: 1, cursorCount: 1 }, loginRequiredIndicated: false,
      reviews: [{ reviewId: '1', body: 'Fixture domestic review', rating: 5, createdAt: '2026-10-01', optionName: 'Blue',
        productRelation: 'related_product', photos: [{ imagePath: 'https://example.invalid/review.jpg' }] }], receipts: [receipt] };
  } }) } });
  const result = await registry.execute('reviews', { path: { id }, query: { limit: 1 } });
  assert.equal(calls, 1); assert.equal(result.data.reviews[0].associatedProductReview, true);
  assert.equal(result.data.reviews[0].images.length, 1); assert.equal(result.data.collection.complete, false);
  assert.equal(typeof result.data.collection.continuation.cursor, 'string'); assertFinite(result); await registry.close();
});

test('bounded collection retains real pagination, partial results and null/unknown currencies', async () => {
  const calls = [];
  const registry = bind('amazon', { factories: { 'amazon-public': () => ({ searchProducts: async ({ page }) => {
    calls.push(page); return { page, partial: true, items: [{ asin: `B00000000${page}`, title: 'Fixture mouse', productUrl: null,
      currentDisplayPrice: { amount: '10.00', currencyCode: null, displayText: '$10.00' } }], receipt };
  } }) } });
  const result = await registry.execute('collect', { query: { query: 'mouse', maxPages: 2, limit: 10 } });
  assert.deepEqual(calls, [1, 2]); assert.equal(result.data.collection.pagesRead, 2);
  assert.equal(result.data.collection.partialResponses, 2); assert.equal(result.data.collection.currencyUnverifiedCount, 2);
  assert.equal(result.data.collection.complete, false); assert.equal(result.pageInfo.completeCatalog, false);
  await assert.rejects(registry.execute('collect', { query: { query: 'mouse', maxPages: 3 } }), { code: 'OPERATION_INPUT_INVALID' });
  await registry.close();
});

for (const status of [403, 429]) test(`HTTP ${status} stops after one request with no retries, bypass or response leakage`, async () => {
  let calls = 0;
  const registry = bind('oliveyoung-global', { fetchImpl: async () => { calls++; return new Response('fixture-sensitive-response',
    { status, headers: { 'content-type': 'application/json', 'set-cookie': 'fixture-never-expose' } }); } });
  await assert.rejects(registry.execute('suggest', { query: { query: 'toner' } }), error => {
    assert.equal(error.status, status); assert.equal(error.code, status === 403 ? 'COMMERCE_ACCESS_DENIED' : 'COMMERCE_RATE_LIMITED');
    assert.ok(!JSON.stringify(error).includes('fixture-sensitive')); assert.ok(!JSON.stringify(error).includes('fixture-never-expose')); return true;
  });
  assert.equal(calls, 1); await registry.close();
});

test('safe failures discard arbitrary provider exceptions, and success rejects non-finite native metadata', async () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const registry = bind('ably', { factories: { ably: () => ({ categories: async () => ({ invalid: value }), receipts: [] }) } });
    await assert.rejects(registry.execute('categories'), { code: 'COMMERCE_OUTPUT_INVALID' }); await registry.close();
  }
  const registry = bind('ably', { factories: { ably: () => ({ categories: async () => { throw Error('fixture credential secret'); } }) } });
  await assert.rejects(registry.execute('categories'), error => error.code === 'COMMERCE_READ_FAILED' && !error.stack.includes('fixture credential'));
  await registry.close();
});

test('finite native envelopes normalize optional undefined/Date and drop raw credential/provider state', async () => {
  const registry = bind('ably', { factories: { ably: () => ({ receipts: [], categories: async () => ({
    optional: undefined, observedAt: new Date(NOW), headers: { cookie: 'fixture-secret' }, providerState: { raw: 'fixture-state' },
    nextToken: 'business-pagination-token', price: { raw: '3.00-4.00' },
  }) }) } });
  const result = await registry.execute('categories');
  assert.equal(result.data.data.optional, null); assert.equal(result.data.data.observedAt, new Date(NOW).toISOString());
  assert.equal(result.data.data.nextToken, 'business-pagination-token'); assert.equal(result.data.data.price.raw, '3.00-4.00');
  assert.equal(result.data.data.headers, undefined); assert.equal(result.data.data.providerState, undefined);
  assertFinite(result); await registry.close();
});

test('abort before execution opens nothing, and abort between native reads prevents a subsequent request', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const before = bind('ably', { fetchImpl: () => { calls++; throw Error('forbidden'); } });
  await assert.rejects(before.execute('categories', {}, { signal: controller.signal }), { code: 'OPERATION_ABORTED' });
  assert.equal(calls, 0); await before.close();
  const during = new AbortController();
  const registry = bind('ably', { fetchImpl: async () => { calls++; during.abort(); return Response.json({ token: 'fixture.anonymous.token' }); } });
  await assert.rejects(registry.execute('categories', {}, { signal: during.signal }), { code: 'OPERATION_ABORTED' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1); await registry.close();
});

test('ranking transport closes on error, native status survives, and a closed binding rejects new reads', async () => {
  let closed = 0;
  const definition = byId('oliveyoung-public');
  const binding = definition.createAdapters({ factories: { 'oliveyoung-ranking': () => ({
    getRanking: async () => { throw Object.assign(new Error('fixture'), { code: 'OLIVEYOUNG_RANKING_HTTP_ERROR', receipt: { ...receipt, httpStatus: 403 } }); },
    close: async () => { closed++; },
  }) } });
  const registry = createOperationRegistry(definition.profile, binding);
  await assert.rejects(registry.execute('ranking', { query: { limit: 1 } }), { code: 'COMMERCE_ACCESS_DENIED', status: 403 });
  assert.equal(closed, 1); await binding.close(); assert.equal(closed, 1);
  await assert.rejects(registry.execute('search', { query: { query: 'serum' } }), { code: 'COMMERCE_ADAPTER_CLOSED' });
});

test('concrete Rakuten target resolver performs one document read, not an invented review payload', async () => {
  let calls = 0;
  const productUrl = 'https://item.rakuten.co.jp/kinujo/001/';
  const registry = bind('rakuten-public', { fetchImpl: async url => {
    calls++; assert.equal(String(url), productUrl);
    return new Response('<html><body><input name="shop_bid" value="319501"><input name="item_id" value="10000000">' +
      '<input name="shopurl" value="kinujo"><a href="https://review.rakuten.co.jp/item/1/319501_10000000/1.1/">reviews</a></body></html>',
    { headers: { 'content-type': 'text/html' } });
  } });
  const result = await registry.execute('review-target', { query: { productUrl, itemCode: 'kinujo:001' } });
  assert.equal(calls, 1); assert.equal(result.data.targetVerified, true); assert.equal(result.data.targetKey, '319501:10000000');
  assert.equal(result.data.reviews, undefined); assert.equal(result.receipt.networkUsed, false);
  assertFinite(result); await registry.close();
});

test('concrete Yahoo official search reuses the app-id client without exposing its query credential', async () => {
  let calls = 0; const appId = 'fixture_yahoo_registered_app_id';
  const registry = bind('yahoo-shopping-jp', { credentialProvider: async id => {
    assert.equal(id, 'yahoo-shopping-jp'); return { appId };
  }, fetchImpl: async input => {
    calls++; const url = new URL(input);
    assert.equal(url.pathname, '/ShoppingWebService/V3/itemSearch'); assert.equal(url.searchParams.get('appid'), appId);
    return Response.json({ totalResultsAvailable: 1, totalResultsReturned: 1, firstResultsPosition: 1, request: { query: 'shampoo' },
      hits: [{ code: 'fixture_shampoo', name: 'Fixture shampoo', seller: { sellerId: 'fixture' }, inStock: true, price: 1000,
        url: 'https://store.shopping.yahoo.co.jp/fixture/shampoo.html', image: {}, exImage: {} }] });
  } });
  const result = await registry.execute('search', { query: { query: 'shampoo', results: 1 } });
  assert.equal(calls, 1); assert.equal(result.data.items[0].price.currency, 'JPY');
  assert.equal(result.data.items[0].price.basis, 'official_api_listing'); assert.equal(result.data.items[0].identityVerified, true);
  assert.ok(!JSON.stringify(result).includes(appId)); assertFinite(result); await registry.close();
});

test('nested native failure statuses remain actionable, with credential-bearing receipt segments redacted', async () => {
  const sid = 'IRfixture_private_account_sid';
  const registry = bind('impact', { credentialProvider: async () => ({ accountSid: sid, authToken: 'fixture_auth_secret' }),
    factories: { impact: () => ({ listCatalogs: async () => { throw Object.assign(new Error('fixture'), {
      code: 'IMPACT_SCOPE_DENIED', receipt: { credentialsUsed: true, request: { ...receipt,
        path: `/Mediapartners/${sid}/Catalogs`, httpStatus: 403, headers: { authorization: 'fixture_auth_secret' } } },
    }); } }) } });
  await assert.rejects(registry.execute('catalogs'), error => {
    assert.equal(error.code, 'COMMERCE_ACCESS_DENIED'); assert.equal(error.status, 403);
    assert.equal(error.receipt.path, '/Mediapartners/{redacted}/Catalogs');
    assert.ok(!JSON.stringify(error).includes(sid)); assert.ok(!JSON.stringify(error).includes('fixture_auth_secret')); return true;
  });
  await registry.close();
});

test('credential reflection in otherwise valid native business output fails closed', async () => {
  const appId = 'fixture_reflected_application_secret';
  const registry = bind('yahoo-shopping-jp', { credentialProvider: async () => ({ appId }),
    factories: { 'yahoo-shopping-jp': () => ({ search: async () => ({ items: [], description: appId }) }) } });
  await assert.rejects(registry.execute('search', { query: { query: 'shampoo' } }), { code: 'COMMERCE_SECRET_IN_RESULT' });
  await registry.close();
});

const reviewPage = { productIdMatched: true, reviews: [{ reviewId: 'review-1', body: 'Fixture bound review', rating: 5, images: [] }],
  nextCursor: null, paginationVerified: true, totalReviews: 1, receipt };
for (const id of ['sephora', 'ulta', 'shopify-storefronts', 'oliveyoung-global', 'oliveyoung-public', 'ably', 'rakuten-public']) {
  test(`local verification chain: ${id} resolves fresh returned identities and actually dispatches supported dependent reads`, async () => {
    const definition = byId(id); const calls = [];
    let client;
    if (id === 'sephora' || id === 'ulta') {
      const entry = cases.find(row => row[0] === id), searchResult = structuredClone(entry[3]);
      const row = searchResult.products[0];
      const productUrl = id === 'ulta' ? `https://www.ulta.com/p/fixture-${row.productId}?sku=${row.variantId}`
        : `https://www.sephora.com/product/fixture-${row.productId}?skuId=${row.variantId}`;
      row.productUrl = productUrl;
      client = { searchProducts: async () => { calls.push('search'); return searchResult; },
        getProduct: async args => { calls.push('product'); assert.equal(args.productId, row.productId);
          if (id === 'ulta') assert.equal(args.productUrl, productUrl);
          return { product: { productId: row.productId, skuId: row.variantId, currentSku: { skuId: row.variantId }, productUrl }, receipt }; },
        getReviews: async args => { calls.push('reviews'); assert.equal(args.productId, row.productId); assert.equal(args.skuId, row.variantId);
          if (id === 'ulta') assert.equal(args.productUrl, productUrl);
          return structuredClone(reviewPage); } };
    } else if (id === 'shopify-storefronts') {
      client = { searchProducts: async ({ limit }) => { calls.push('search-native'); assert.equal(limit, 1);
        return { products: [{ id: 999, handle: 'fresh-returned-handle', title: 'Fixture palette' }], receipt }; },
      getProduct: async ({ handle }) => { calls.push('product'); assert.equal(handle, 'fresh-returned-handle');
        return { product: { id: 999, handle, title: 'Fixture palette', descriptionHtml: '<p>Fixture</p>' }, receipt }; },
      getReviews: async ({ handle }) => { calls.push('reviews'); assert.equal(handle, 'fresh-returned-handle'); return structuredClone(reviewPage); } };
    } else if (id === 'oliveyoung-global') {
      client = { getBestSellers: async () => { calls.push('best-sellers'); return { products: [globalProduct], receipt }; },
        getProduct: async ({ id }) => { calls.push('product'); assert.equal(id, globalProduct.id); return { product: globalProduct, receipt }; },
        getReviews: async ({ productId }) => { calls.push('reviews'); assert.equal(productId, globalProduct.id);
          return { ...structuredClone(reviewPage), reviews: [{ reviewId: 'review-1', body: 'Fixture global review', images: [] }] }; } };
    } else if (id === 'oliveyoung-public') {
      const native = structuredClone(cases.find(row => row[0] === id)[3]), productId = native.products[0].productId;
      client = { searchProducts: async () => { calls.push('search'); return native; },
        getReviews: async ({ goodsNumber }) => { calls.push('reviews'); assert.equal(goodsNumber, productId);
          return { productId, reviews: [{ reviewId: '1', body: 'Fixture domestic review', photos: [] }], continuation: null, totalReviews: 1, receipts: [receipt] }; },
        getReviewStats: async ({ goodsNumber }) => { calls.push('review-stats'); assert.equal(goodsNumber, productId); return { productId, totalReviews: 1 }; } };
    } else if (id === 'ably') {
      client = { receipts: [], ranking: async ({ limit }) => { calls.push('ranking'); assert.equal(limit, 1); return { items: [{ sno: 76822195, rank: 1 }] }; },
        product: async ({ id, options }) => { calls.push('product'); assert.equal(id, 76822195); assert.equal(options, false);
          return { sno: id, name: 'Fixture product', price: { sale: { amount: 1000, currency: 'KRW', kind: 'retail_current' } } }; } };
    } else {
      client = { resolveReviewTarget: async () => { calls.push('review-target'); return { shopId: '319501', itemId: '10000000', targetKey: '319501:10000000',
        reviewUrl: 'https://review.rakuten.co.jp/item/1/319501_10000000/1.1/' }; },
      getReviews: async ({ shopId, itemId, reviewUrl }) => { calls.push('reviews'); assert.equal(shopId, '319501'); assert.equal(itemId, '10000000');
        assert.equal(reviewUrl, 'https://review.rakuten.co.jp/item/1/319501_10000000/1.1/'); return { ...structuredClone(reviewPage),
          reviews: [{ reviewId: '1', identityKind: 'native_revSubkey', body: 'Fixture review', media: [], postDate: '2026/10/01' }] }; } };
    }
    const registry = bind(id, { factories: { [id]: options => {
      if (id === 'shopify-storefronts') assert.equal(options.store, 'colourpop'); return client;
    } } });
    const health = await checkOperations(definition.profile, { checks: definition.verificationChecks,
      execute: async (...args) => { const response = await registry.execute(...args); assert.equal(response.receipt.networkUsed, false); return response; } });
    assert.equal(health.verdict, 'ok', JSON.stringify(health));
    assert.deepEqual(calls, definition.verificationChecks.map(check => check.operation));
    assert.ok(calls.length >= 2 && calls.length <= 3); assertFinite(health); await registry.close();
  });
}

test('empty fresh search results skip product/review checks rather than inserting a guessed ID', async () => {
  let calls = 0;
  const registry = bind('sephora', { factories: { sephora: () => ({ searchProducts: async () => { calls++;
    return { products: [], page: 1, pageSize: 20, totalProducts: 0, receipt }; },
  getProduct: () => { throw Error('unbound product forbidden'); }, getReviews: () => { throw Error('unbound reviews forbidden'); } }) } });
  const health = await checkOperations(registry.profile, { checks: byId('sephora').verificationChecks, execute: registry.execute });
  assert.equal(calls, 1); assert.deepEqual(health.checks.map(check => check.outcome), ['ok', 'skipped', 'skipped']);
  assert.ok(health.checks.slice(1).every(check => check.code === 'RESULT_REFERENCE_UNRESOLVED')); await registry.close();
});
