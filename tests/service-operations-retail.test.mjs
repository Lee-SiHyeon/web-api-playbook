import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { definitions } from '../lib/service-operations/retail.mjs';
import { createOperationRegistry } from '../lib/operation-registry.mjs';
import { ScopedSession } from '../lib/scoped-session.mjs';
import { createServiceRegistry } from '../lib/service-operations/index.mjs';
import { verifyServiceOperations } from '../lib/service-operations/verify.mjs';

// Every fetch below is an injected local fixture, never a live verification.
const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const [walmartHtml, sheinHtml, retailHtml, menuFirst, menuSecond, amazonProduct,
  travelSearch, travelRooms, travelOptions, travelReviews, rscList, vectors] = await Promise.all([
  'walmart-search-observed.html', 'retail/shein-home.html', 'coupang/retail-search-dom.html',
  'amazon/menu-first.html', 'amazon/menu-second.html', 'amazon/product-lotion.html',
  'coupang/travel-search.json', 'coupang/travel-rooms.json', 'coupang/travel-ticket-options.json',
  'coupang/travel-reviews.json', 'coupang/retail-rsc-list.json', 'coupang/signature-v3-vectors.json',
].map(fixture));
const NOW = Date.parse('2026-10-16T00:00:00Z');
const response = (body, type = 'text/html', status = 200) => new Response(body, { status, headers: { 'content-type': type } });
const xml = entries => '<?xml version="1.0"?><sitemapindex>'
  + entries.map(url => `<sitemap><loc>${url}</loc></sitemap>`).join('') + '</sitemapindex>';
const script = (id, value) => `<script id="${id}" type="application/json">${JSON.stringify(value)}</script>`;
const RURL = 'https://item.rakuten.co.jp/synthetic-shop/synthetic-item/';
const YURL = 'https://store.shopping.yahoo.co.jp/synthetic-shop/synthetic-item.html';
const rakHome = '<html><body><div id="side-navi"><div irc="GenreWidget" data-items="'
  + JSON.stringify([{ key: 'pc', items: [{ key: 'mouse', link: 'https://www.rakuten.co.jp/category/100026/' }] }]).replaceAll('"', '&quot;')
  + '"></div></div></body></html>';
const yahooHome = '<html><body>' + script('__NEXT_DATA__', { props: { pageProps: { categoryEntity: { bigCategories: [{
  categories: [{ gid: 1, name: 'Local category', link: 'https://shopping.yahoo.co.jp/category/1/recommend' }],
  childCategories: [],
}] }, token: 'PRIVATE_PAGE_TOKEN' } } }) + '</body></html>';

function japanProduct(service) {
  if (service === 'rakuten') return '<html><body><input name="shop_bid" value="123"><input name="item_id" value="456">'
    + '<input name="shopurl" value="synthetic-shop">' + script('item-page-app-data', {
      newApi: { itemInfoSku: { shopId: '123', itemId: 456, manageNumber: 'synthetic-item', title: 'Local item',
        sku: [], purchaseInfo: { sku: [] } } }, shop: {}, user: { token: 'PRIVATE_PAGE_TOKEN' },
    }) + '</body></html>';
  return '<html><body><link rel="canonical" href="' + YURL + '">' + script('__NEXT_DATA__', { props: { pageProps: {
    seller: { id: 'synthetic-shop', name: 'Local shop' }, item: { srid: 'synthetic-item', name: 'Local item',
      applicablePrice: 3000, images: { displayItemImageList: [] }, individualItemList: [], selectOptionList: [] },
    page: { crumb: 'PRIVATE_PAGE_TOKEN' },
  } } }) + '<script type="application/ld+json">' + JSON.stringify({ '@type': 'Product', offers: {
    price: 3000, priceCurrency: 'JPY', url: YURL } }) + '</script></body></html>';
}
function rakListing(query, page, categoryId) {
  return '<html><body><script>window.__INITIAL_STATE__ =' + JSON.stringify({ state: { data: {
    uiQuestion: { keywords: query, page, ...(categoryId === undefined ? {} : { category: categoryId }) }, ichibaSearch: { error: null,
      pagination: { numFound: 1, pageSize: 45 }, items: [{ code: '456', shop: { id: 123, urlCode: 'synthetic-shop' },
        name: 'Local mouse', originalItemUrl: RURL, price: 1200, images: [], hasPriceRange: true }] },
    myDataToken: { token: 'PRIVATE_PAGE_TOKEN' },
  } } }) + ';</script></body></html>';
}
function amazonStream(query, page, count = 22, next = false) {
  const asin = 'B004YAVF8I';
  return [
    ['dispatch', 'data-search-metadata', { metadata: { keywords: query, page,
      asinOnPageCount: count, marketplaceId: 'ATVPDKIKX0DER' } }],
    ['dispatch', 'data-title-and-meta', { title: `Amazon: ${query}` }],
    ['dispatch', 'data-main-slot:search-result-1', { asin, index: 1,
      html: `<div data-asin="${asin}"><h2><span>Local mouse</span></h2><a href="/dp/${asin}">item</a>`
        + '<span class="a-price"><span class="a-offscreen">$12.99</span></span></div>' }],
    ...(next ? [['dispatch', 'data-main-slot', { html: `<a class="s-pagination-next" href="/s?k=${encodeURIComponent(query)}&amp;page=${page + 1}">Next</a>` }]] : []),
  ].map(JSON.stringify).join('&&&');
}

function fixtureFetch({ amazonSession = false } = {}) {
  const calls = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw); calls.push({ url, init });
    const protectedProduct = url.hostname === 'www.amazon.com' && url.pathname.startsWith('/-/ko/dp/');
    assert.equal(new Headers(init.headers).has('cookie'), protectedProduct && amazonSession);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.ok(['GET', 'POST'].includes(init.method));
    if (url.hostname === 'ko.aliexpress.com') return Response.json({ code: 200, success: true, body: {
      title: ' - AliExpress ', description: 'Local SEO description', canonical:
        `<link rel="canonical" href="https://ko.aliexpress.com/item/${url.searchParams.get('productId')}.html" />`,
    } });
    if (url.hostname === 'www.aliexpress.com') return response(xml([
      'https://www.aliexpress.com/sitemap/en-https-item-item-local.xml.gz',
    ]), 'application/xml');
    if (url.hostname === 'www.iherb.com') return response(url.pathname === '/sitemap_index.xml'
      ? xml(['https://www.iherb.com/sitemaps/products-local.xml'])
      : '<?xml version="1.0"?><urlset><url><loc>https://www.iherb.com/pr/local-vitamin/123</loc></url>'
        + '<url><loc>https://www.iherb.com/pr/local-vitamin-b/124</loc><lastmod>2026-10-15</lastmod></url></urlset>', 'application/xml');
    if (url.hostname === 'www.amazon.com') {
      if (protectedProduct) {
        assert.equal(amazonSession, true);
        const asin = url.pathname.split('/')[4];
        return response(amazonProduct.replaceAll('B08KT2Z93D', asin));
      }
      if (url.pathname.includes('hMenuDesktopFirstLayer')) return Response.json({ data: menuFirst });
      if (url.pathname.includes('hamburgerMainContent')) return Response.json({ data: menuSecond });
      return response(amazonStream(url.searchParams.get('k'), Number(url.searchParams.get('page'))), 'application/json-amazonui-streaming');
    }
    if (url.hostname === 'autosug.ebay.com') return Response.json({ prefix: url.searchParams.get('kwd'), dict: 'local', res: {},
      richRes: { sug: [{ kwd: 'Local mouse', categories: [{ catId: '123', catName: 'Local category' }] }] } });
    if (url.hostname === 'www.walmart.com') return response(walmartHtml.replaceAll('wireless earbuds', url.searchParams.get('q')));
    if (url.hostname === 'www.allbirds.com') {
      if (url.pathname === '/cart.js') return Response.json({ currency: 'USD', item_count: 0, token: 'PRIVATE_CART_TOKEN', items: [] });
      if (url.pathname.endsWith('.js')) {
        const handle = url.pathname.split('/')[2].slice(0, -3);
        return Response.json({ id: 1, handle, title: 'Local runner', vendor: 'Allbirds', type: 'Shoes', available: true,
          price: 10500, price_min: 10500, price_max: 10500, url: '/products/' + handle,
          variants: [{ id: 2, title: 'Size 8', price: 10500, available: true, option1: '8' }] });
      }
      return Response.json({ resources: { results: { products: [{ id: 1, handle: 'local-runner', title: 'Local runner',
        vendor: 'Allbirds', type: 'Shoes', available: true, price: '105.00', price_min: '105.00', price_max: '105.00',
        url: '/products/local-runner?tracking=DROP' }] } } });
    }
    if (url.hostname === 'kr.shein.com') return response(sheinHtml.replace('"SiteUID":"kr"', '"sessionToken":"PRIVATE_PAGE_TOKEN","SiteUID":"kr"'));
    if (url.hostname === 'www.coupang.com') {
      if (url.pathname === '/n-api/web-adapter/category-list') return Response.json({ data: { gnb: { menu: [{
        name: 'Local category', linkUri: '/np/categories/123', linkCode: 123,
      }] } } });
      return response(retailHtml);
    }
    if (url.hostname === 'www.rakuten.co.jp') return response(url.pathname === '/' ? rakHome
      : rakListing(undefined, 1, Number(url.pathname.split('/')[2])));
    if (url.hostname === 'search.rakuten.co.jp') return response(rakListing(decodeURIComponent(url.pathname.split('/')[3]), Number(url.searchParams.get('p') ?? 1)));
    if (url.hostname === 'item.rakuten.co.jp') return response(japanProduct('rakuten'));
    if (url.hostname === 'shopping.yahoo.co.jp') return response(url.pathname === '/' ? yahooHome
      : '<html><body>' + script('__NEXT_DATA__', { props: { pageProps: { genreCategoryEntity: {} } } }) + '</body></html>');
    if (url.hostname === 'store.shopping.yahoo.co.jp') return response(japanProduct('yahoo'));
    assert.fail('Unrecognized fixture route: ' + url.origin + url.pathname);
  };
  return { fetchImpl, calls };
}
function registry(id, options = {}) {
  const definition = definitions.find(item => item.id === id);
  assert.ok(definition, id);
  const handle = definition.createAdapters({ minIntervalMs: 0, now: () => NOW, ...options });
  return { definition, handle, registry: createOperationRegistry(definition.profile, handle) };
}
function assertJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return; }
  assert.ok(value && typeof value === 'object');
  assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
  Object.values(value).forEach(assertJson);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}
async function temporaryDirectory(t) {
  const root = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(root, 'playbook-retail-operations-test-'));
  assert.ok(path.resolve(directory).startsWith(root + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('metadata registers all read adapters and checks without acquiring a provider or network', () => {
  const names = new Set(); let reads = 0;
  for (const item of definitions) {
    for (const name of [item.id, ...item.aliases]) { assert.ok(!names.has(name)); names.add(name); }
    assert.ok(item.aliases.every(alias => /^(retail|japan)-/.test(alias)));
    assertJson(item.profile); assertJson(item.verificationChecks); assertJson(item.checklistIds);
    const { registry: runtime, handle } = registry(item.id, { fetchImpl: () => reads++, credentialProvider: () => reads++ });
    for (const operation of runtime.list()) {
      assert.equal(operation.semantics, 'read'); assert.match(operation.evidence, /lib\/retail\//);
      assert.equal(typeof handle.adapters[operation.adapter], 'function');
      assertJson(runtime.describe(operation.id));
    }
    assert.ok(item.verificationChecks.length >= 1 && item.verificationChecks.length <= 2);
    assert.ok(item.verificationChecks.every(check => check.kind === 'live_read'));
    handle.close();
  }
  assert.equal(reads, 0);
  assert.equal(definitions.length, 10);
  assert.equal(definitions.reduce((count, item) => count + Object.keys(item.profile.operations).length, 0), 32);
  assert.equal(names.has('amazon-public'), false); assert.equal(names.has('rakuten-public'), false);
});

for (const item of definitions) test(`${item.id}: default check executes maintained clients with local fixtures only`, async () => {
  const fixture = fixtureFetch();
  const { registry: runtime, handle } = registry(item.id, { fetchImpl: fixture.fetchImpl,
    credentialProvider: () => assert.fail('public check acquired provider') });
  const probe = item.verificationChecks[0];
  const result = await runtime.execute(probe.operation, probe.input);
  assertJson(result);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.networkUsed, false, 'fixtures must never claim live network');
  assert.ok(fixture.calls.length >= 1 && fixture.calls.length <= 2, 'one or two read requests only');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PAGE_TOKEN|PRIVATE_CART_TOKEN|explicitHeadersSent/);
  if (item.id === 'retail-amazon') {
    assert.equal(result.data.partial, true); assert.equal(result.data.pagination.hasNext, null);
    assert.equal(result.data.items[0].currentDisplayPrice.currencyCode, null);
  }
  if (item.id === 'retail-shopify') assert.equal(result.data.products[0].price.amount, '105.00');
  if (item.id === 'retail-shein') assert.equal(result.data.sourceFormat, 'document_embedded_json');
  if (item.id === 'retail-walmart') assert.equal(result.data.coverage.partial, true);
  handle.close();
});

test('common loader aliases and central verifier execute result-bound fixtures without promoting them to live evidence', async t => {
  const fixture = fixtureFetch({ amazonSession: true });
  const directory = await temporaryDirectory(t);
  let providerCalls = 0;
  const session = new ScopedSession({ allowedOrigins: ['https://www.amazon.com'], cookieOrigins: ['https://www.amazon.com'],
    cookies: [{ name: 'session-id', value: 'PRIVATE_SESSION_VALUE', domain: '.amazon.com', path: '/', secure: true }], maxRedirects: 0 });
  const alias = await createServiceRegistry('retail-amazon-public', { definitions, bind: false });
  assert.equal(alias.profile.serviceId, 'retail-amazon'); await alias.close();
  const result = await verifyServiceOperations({ definitions, timeoutMs: 5000, fetchImpl: fixture.fetchImpl,
    minIntervalMs: 0, now: () => NOW, storeDirectory: directory, credentialProvider: async id => {
      assert.equal(id, 'retail-amazon'); providerCalls++;
      return { schema: 'amazon-retail-public-session-v1', capturedAt: new Date().toISOString(),
        session: session.toJSON(), lastSuccessfulReadAt: null, lastFailure: null };
    } });
  assert.equal(result.summary.checked, 10); assert.equal(result.summary.ok, 10);
  assert.equal(result.summary.liveReadChecksPassed, 0); assert.equal(fixture.calls.length, 16);
  assert.equal(providerCalls, 1);
  assert.equal(result.results.flatMap(row => row.checks).length, 14);
  assert.equal(fixture.calls.filter(call => call.url.pathname === '/-/ko/dp/B004YAVF8I/').length, 1);
  assert.equal(fixture.calls.filter(call => call.url.href === 'https://www.rakuten.co.jp/category/100026/').length, 1);
  assert.equal(fixture.calls.filter(call => call.url.href === 'https://shopping.yahoo.co.jp/category/1/recommend').length, 1);
  const coupangCalls = fixture.calls.filter(call => call.url.hostname === 'www.coupang.com');
  assert.equal(coupangCalls[0].url.pathname, '/np/search');
  assert.equal(coupangCalls[0].url.searchParams.get('q'), '무선 마우스');
  assert.equal(coupangCalls.length, 2);
  assert.ok(result.results.every(row => row.checks.every(check => check.liveReadVerified === false)));
  assertJson(result);
});

test('Coupang named plan attempts public SEARCH first and retains a 403 without bootstrap, retries, or detail claims', async () => {
  const calls = [];
  const result = await verifyServiceOperations({ definitions, services: ['coupang-retail'], fetchImpl: async (raw, init) => {
    const url = new URL(raw); calls.push(url);
    assert.equal(url.pathname, '/np/search'); assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).has('cookie'), false);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return response('<title>Access Denied</title>', 'text/html', 403);
  }, credentialProvider: () => assert.fail('public search acquired credentials') });
  const first = result.results[0].checks[0];
  assert.equal(first.operation, 'retail-search'); assert.equal(first.code, 'COUPANG_HTTP_403');
  assert.equal(first.outcome, 'unreachable'); assert.equal(calls.length, 1);
  assert.equal(result.summary.liveReadChecksPassed, 0);
  assert.equal(result.results[0].observations.length, 0);
  assert.ok(definitions.find(item => item.id === 'coupang-retail').verificationChecks
    .every(check => !['document', 'product', 'retail-search-session'].includes(check.operation)));
  assertJson(result);
});

test('Amazon search-to-product plan never substitutes a recorded ASIN on empty results or missing session provider', async () => {
  for (const empty of [true, false]) {
    const fixture = fixtureFetch(); let providerCalls = 0;
    const calls = [];
    const result = await verifyServiceOperations({ definitions, services: ['retail-amazon'], fetchImpl: async (raw, init) => {
      calls.push(new URL(raw));
      if (!empty) return fixture.fetchImpl(raw, init);
      return response([
        ['dispatch', 'data-search-metadata', { metadata: { keywords: 'wireless mouse', page: 1,
          asinOnPageCount: 0, marketplaceId: 'ATVPDKIKX0DER' } }],
        ['dispatch', 'data-title-and-meta', { title: 'Amazon: wireless mouse' }],
      ].map(JSON.stringify).join('&&&'), 'application/json-amazonui-streaming');
    }, credentialProvider: async () => { providerCalls++; return null; } });
    assert.equal(calls.length, 1); assert.equal(calls[0].pathname, '/s/query');
    assert.equal(calls[0].searchParams.get('page'), '1');
    const checks = result.results[0].checks;
    assert.equal(checks[0].outcome, 'ok'); assert.equal(checks[1].operation, 'product');
    assert.equal(checks[1].code, empty ? 'RESULT_REFERENCE_UNRESOLVED' : 'PROVIDER_MISSING');
    assert.equal(providerCalls, empty ? 0 : 1);
    assert.equal(result.summary.liveReadChecksPassed, 0); assertJson(result);
  }
});

test('Japanese navigation plans follow exactly one CURRENT category URL, not a recorded category ID', async () => {
  for (const [id, document, expected] of [
    ['japan-rakuten', rakHome.replaceAll('100026', '100027'), 'https://www.rakuten.co.jp/category/100027/'],
    ['retail-yahoo-shopping-jp', yahooHome.replaceAll('category/1/', 'category/2/').replace('"gid":1', '"gid":2'),
      'https://shopping.yahoo.co.jp/category/2/recommend'],
  ]) {
    const fixture = fixtureFetch(); const calls = [];
    const result = await verifyServiceOperations({ definitions, services: [id], fetchImpl: async (raw, init) => {
      const url = new URL(raw); calls.push(url.href);
      return url.pathname === '/' ? response(document) : fixture.fetchImpl(raw, init);
    }, credentialProvider: () => assert.fail('Japanese public navigation acquired credentials') });
    assert.equal(calls.length, 2); assert.equal(calls[1], expected);
    assert.deepEqual(result.results[0].checks.map(check => check.operation), ['home', 'page']);
    assert.ok(result.results[0].checks.every(check => check.outcome === 'ok'));
    assert.equal(result.summary.liveReadChecksPassed, 0); assertJson(result);
  }
});

test('Japanese category follow-ups are skipped when navigation has no valid result, without any guessed URL', async () => {
  for (const id of ['japan-rakuten', 'retail-yahoo-shopping-jp']) {
    let calls = 0;
    const result = await verifyServiceOperations({ definitions, services: [id], fetchImpl: async () => {
      calls++; return response('<html><body>Unrecognized navigation layout</body></html>');
    } });
    assert.equal(calls, 1); assert.notEqual(result.results[0].checks[0].outcome, 'ok');
    assert.equal(result.results[0].checks[1].operation, 'page');
    assert.equal(result.results[0].checks[1].code, 'RESULT_REFERENCE_UNRESOLVED');
    assert.equal(result.summary.liveReadChecksPassed, 0); assertJson(result);
  }
});

test('nested inputs/defaults validate before the provider or HTTP; no mutation operations are present', async () => {
  let calls = 0;
  const { registry: runtime } = registry('retail-amazon', { fetchImpl: () => calls++, credentialProvider: () => calls++ });
  for (const input of [{ query: 'mouse' }, { query: { query: 'mouse', page: 0 } }, { query: { query: 'mouse', unknown: true } }])
    await assert.rejects(runtime.execute('search', input), { code: 'OPERATION_INPUT_INVALID' });
  await assert.rejects(runtime.execute('product'), { code: 'OPERATION_INPUT_REQUIRED' });
  await assert.rejects(runtime.execute('affiliate-link', {}), { code: 'OPERATION_UNKNOWN' });
  assert.equal(calls, 0);
});

test('AliExpress SEO keeps unavailable title/price separate from sanitized raw SEO title', async () => {
  const fixture = fixtureFetch(); const { registry: runtime } = registry('retail-aliexpress', { fetchImpl: fixture.fetchImpl });
  const result = await runtime.execute('product-seo', { path: { productId: '1005011947482958' } });
  assert.equal(result.data.title, null); assert.equal(result.data.price, null); assert.equal(result.data.currency, null);
  assert.equal(result.data.seoTitleRaw, ' - AliExpress '); assert.equal(fixture.calls.length, 1);
  assertJson(result);
});

test('sitemap pages preserve exact snapshot resume and reject offset-only or arbitrary URLs before HTTP', async () => {
  const fixture = fixtureFetch(); const { registry: runtime } = registry('retail-iherb', { fetchImpl: fixture.fetchImpl });
  const input = { path: { shardPath: '/sitemaps/products-local.xml' }, query: { limit: 1 } };
  const first = await runtime.execute('sitemap-products', input);
  assert.equal(first.data.items.length, 1); assert.equal(first.pageInfo.nextOffset, 1);
  assert.equal(first.data.priceVerified, false); assert.equal(first.data.stockVerified, false);
  await assert.rejects(runtime.execute('sitemap-products', { ...input, query: { offset: 1 } }), { code: 'SNAPSHOT_REQUIRED_FOR_RESUME' });
  const next = await runtime.execute('sitemap-products', { ...input, query: { offset: 1, limit: 1, snapshotSha256: first.data.snapshotSha256 } });
  assert.equal(next.data.items[0].externalProductId, '124'); assert.equal(next.pageInfo.shardComplete, true);
  await assert.rejects(runtime.execute('sitemap-products', { path: { shardPath: 'https://foreign.test/' } }), { code: 'PATH_NOT_ALLOWED' });
  assert.equal(fixture.calls.length, 2); assertJson(next);
});

test('sitemap blocks preserve sanitized status and stop without a second index request', async () => {
  let calls = 0;
  const { registry: runtime } = registry('retail-aliexpress', { fetchImpl: async () => {
    calls++; return response('<title>Access Denied</title>', 'text/html', 403);
  } });
  await assert.rejects(runtime.execute('sitemap-index'), error => {
    assert.equal(error.code, 'HTTP_403'); assert.equal(error.receipt.httpStatus, 403);
    assert.equal(error.receipt.networkUsed, false); assertJson(error.receipt); return true;
  });
  assert.equal(calls, 1);
});

test('Amazon navigation executes its two observed calls; crawl returns JSON checkpoint without writes', async () => {
  const fixture = fixtureFetch(); const { registry: runtime } = registry('retail-amazon', { fetchImpl: fixture.fetchImpl });
  const navigation = await runtime.execute('navigation');
  assert.equal(fixture.calls.length, 2); assert.equal(navigation.data.completeCatalog, false);
  assert.equal(navigation.data.receipts.length, 2); assert.equal(navigation.data.returnedMenuReferencesResolved, true);
  const crawl = await runtime.execute('crawl', { query: { query: 'mouse', maxPages: 1 } });
  assert.equal(crawl.data.pagesRead, 1); assert.equal(crawl.data.partial, undefined);
  assert.equal(crawl.data.pages[0].partial, true); assert.equal(crawl.data.completeCatalog, false); assertJson(crawl);
});

test('Amazon crawl read failure is not success and retains completed-page evidence on the error', async () => {
  let calls = 0;
  const { registry: runtime } = registry('retail-amazon', { fetchImpl: async () => ++calls === 1
    ? response(amazonStream('mouse', 1, 1, true), 'application/json-amazonui-streaming')
    : response('blocked', 'text/html', 403) });
  await assert.rejects(runtime.execute('crawl', { query: { query: 'mouse', maxPages: 2 } }), error => {
    assert.equal(error.code, 'AMAZON_HTTP_FAILED'); assert.equal(error.partialResult.pagesRead, 1);
    assert.equal(error.partialResult.failure.page, 2); assert.equal(error.partialResult.completeCatalog, false);
    assertJson(error.partialResult); return true;
  });
  assert.equal(calls, 2);
});

test('Allbirds product preserves business price/variants but never cart token, headers, or cart contents', async () => {
  const fixture = fixtureFetch(); const { registry: runtime } = registry('retail-shopify', { fetchImpl: fixture.fetchImpl });
  const result = await runtime.execute('product', { path: { handle: 'local-runner' } });
  assert.equal(result.data.product.variants[0].price.amount, '105.00');
  assert.equal(fixture.calls.length, 2); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CART_TOKEN|"items"|"headers"/);
  assertJson(result);
});

test('Coupang document/retail search always use anonymous mode, preserve HTML limits, and never bootstrap', async () => {
  const fixture = fixtureFetch(); const { registry: runtime } = registry('coupang-retail', { fetchImpl: fixture.fetchImpl });
  const document = await runtime.execute('document', { path: { url: 'https://www.coupang.com/np/categories/178255' } });
  const search = await runtime.execute('retail-search', { query: { query: 'mouse', sorter: 'salePriceAsc', freeDelivery: true } });
  assert.equal(fixture.calls.length, 2); assert.equal(search.data.request.authenticationMode, 'anonymous');
  assert.equal(search.data.data.sourceFormat, 'document_html'); assert.equal(search.pageInfo.authRequiredForMore, true);
  assert.equal(search.data.data.coverage, 'received_html_cards_only'); assert.equal(search.data.states.live_replay, false);
  assert.equal(document.data.data.completeCatalog, false); assertJson(search);
  await assert.rejects(runtime.execute('document', { path: { url: 'https://www.coupang.com/api/cart' } }), { code: 'COUPANG_URL_SCOPE' });
  assert.equal(fixture.calls.length, 2);
});

test('Coupang challenge/schema failures stop once without visitor, browser, or invented products', async () => {
  for (const [body, status, code] of [['<title>Access Denied</title>', 403, 'COUPANG_HTTP_403'],
    ['<title>Just a moment</title>', 200, 'COUPANG_CHALLENGE'],
    ['<a href="/np/categories/1">category</a>', 200, 'COUPANG_RETAIL_LISTING_MISSING']]) {
    let calls = 0;
    const { registry: runtime } = registry('coupang-retail', { fetchImpl: async () => { calls++; return response(body, 'text/html', status); } });
    await assert.rejects(runtime.execute('retail-search', { query: { query: 'mouse' } }), error => {
      assert.equal(error.code, code); assert.equal(error.receipt.httpStatus, status); assertJson(error.receipt); return true;
    });
    assert.equal(calls, 1);
  }
});

test('Coupang travel adapters use observed read templates and retain exact decimal IDs, prices, and pagination', async () => {
  const rooms = JSON.parse(travelRooms), options = JSON.parse(travelOptions), reviews = JSON.parse(travelReviews);
  const calls = [];
  const { registry: runtime } = registry('coupang-retail', { fetchImpl: async (url, init) => {
    calls.push({ url, init }); assert.equal(new Headers(init.headers).has('cookie'), false);
    if (url.endsWith('/auto-complete')) return Response.json({ autoCompleteGroups: [{ title: 'Local suggestions', autoCompleteSuggestions: [{ id: '1', text: 'Local place', count: 1, autoCompleteType: 'REGION' }] }] });
    if (url.includes('/api/search/')) return response(travelSearch, 'application/json');
    if (url.endsWith('/rooms')) return response(travelRooms, 'application/json');
    if (url.endsWith('/vendor-items')) return response(travelOptions, 'application/json');
    return response(travelReviews, 'application/json');
  } });
  await runtime.execute('autocomplete', { query: { query: 'local' } });
  const search = await runtime.execute('search', { body: { template: { contextCondition: { sourcePage: 'TSRP' },
    searchCondition: { keyword: 'local', page: 1, productType: 'ACCOMMODATION', productDetailTypes: [],
      appliedFilters: [], searchType: { entitySearchType: 'DEFAULT' } } } }, query: { sort: 'LOWEST_PRICE', resultsOnly: true } });
  assert.equal(calls[1].url, 'https://trip.coupang.com/api/search/results-only');
  assert.equal(search.data.data.products.length, 24); assert.equal(search.pageInfo.page, 1);
  await runtime.execute('rooms', { body: { observed: { url: `https://trip.coupang.com/api/lodging/hotels/${rooms.productId}/rooms`, body: { action: 'selectorTrigger' } } } });
  const ticket = await runtime.execute('ticket-options', { body: { observed: { url: `https://trip.coupang.com/api/products/${options.productId}/vendor-items`,
    body: { vendorItemPackageId: '30000002620249', productType: 'TICKET', selectDate: null } } } });
  assert.equal(ticket.data.data.options[0].travelItemId, '1060746269980381184'); assertJson(ticket);
  const review = await runtime.execute('reviews', { path: { productId: String(reviews.result[0].productId) }, query: { page: reviews.pagination.page } });
  assert.equal(review.data.data.reviews.length, 3); assertJson(review);
  assert.equal(calls.length, 5); assert.ok(calls.slice(0, 4).every(call => call.init.method === 'POST'));
  await assert.rejects(runtime.execute('rooms', { body: { observed: { url: 'https://foreign.test/', body: {} } } }), { code: 'COUPANG_ROOM_INPUT' });
  assert.equal(calls.length, 5);
});

test('Japanese public product/page/search retain document source, JPY, and unverified offer boundaries', async () => {
  const fixture = fixtureFetch();
  for (const [id, url] of [['japan-rakuten', RURL], ['retail-yahoo-shopping-jp', YURL]]) {
    const { registry: runtime } = registry(id, { fetchImpl: fixture.fetchImpl });
    for (const operation of ['page', 'product']) {
      const result = await runtime.execute(operation, { path: { url } });
      assert.equal(result.data.contractProvenance.responseFormat, 'html_document');
      assert.equal(result.data.completeCatalog, false); assert.equal(result.data.affiliateLinkVerified, false);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PAGE_TOKEN/); assertJson(result);
    }
    await assert.rejects(runtime.execute('product', { path: { url: id === 'japan-rakuten' ? 'https://www.rakuten.co.jp/' : 'https://shopping.yahoo.co.jp/' } }), { code: 'JAPAN_PRODUCT_URL_REQUIRED' });
  }
  const { registry: runtime } = registry('japan-rakuten', { fetchImpl: fixture.fetchImpl });
  const result = await runtime.execute('search', { query: { query: 'mouse', page: 2 } });
  assert.equal(result.data.data.products[0].price.currency, 'JPY');
  assert.equal(result.data.data.products[0].selectedVariantPriceVerified, false);
  assert.equal(result.pageInfo.page, 2); assertJson(result);
});

test('Japanese crawl is bounded, returns resumable state, and reports blocked pages as failures', async () => {
  const fixture = fixtureFetch(); const { registry: runtime } = registry('japan-rakuten', { fetchImpl: fixture.fetchImpl });
  const first = await runtime.execute('crawl', {});
  assert.equal(first.data.collection.pagesReadThisRun, 1); assert.equal(first.data.collection.pending, 1);
  assert.equal(first.pageInfo.completeCatalog, false); assert.equal(fixture.calls.length, 1); assertJson(first);
  const { registry: blocked } = registry('japan-rakuten', { fetchImpl: async () => response('blocked', 'text/html', 403) });
  await assert.rejects(blocked.execute('crawl', {}), error => {
    assert.equal(error.code, 'JAPAN_HTTP_REJECTED'); assert.equal(error.receipt.httpStatus, 403);
    assert.equal(error.partialResult.collection.blocked, 1); assertJson(error.partialResult); return true;
  });
});

test('protected provider lookup is lazy and missing/error states are stable without leaking provider data', async t => {
  const directory = await temporaryDirectory(t);
  for (const [id, operation, input] of [['retail-amazon', 'product', { path: { asin: 'B08KT2Z93D' } }],
    ['coupang-retail', 'retail-search-session', { query: { query: 'mouse' } }]]) {
    let calls = 0;
    const { registry: runtime } = registry(id, { storeDirectory: directory, sessionName: 'local-fixture-session',
      fetchImpl: () => assert.fail('network without state'), credentialProvider: async actual => { calls++; assert.equal(actual, id); return null; } });
    assert.equal(calls, 0);
    await assert.rejects(runtime.execute(operation, input), { code: 'PROVIDER_MISSING' }); assert.equal(calls, 1);
    const { registry: bad } = registry(id, { credentialProvider: async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_TOKEN'),
      { receipt: { cookies: ['PRIVATE_PROVIDER_TOKEN'] } }); } });
    await assert.rejects(bad.execute(operation, input), error => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROVIDER_TOKEN/); return true;
    });
  }
});

test('Amazon protected read reuses the native injected session schema, not a fresh login', async t => {
  const directory = await temporaryDirectory(t); let providerCalls = 0, fetchCalls = 0;
  const session = new ScopedSession({ allowedOrigins: ['https://www.amazon.com'], cookieOrigins: ['https://www.amazon.com'],
    cookies: [{ name: 'session-id', value: 'PRIVATE_SESSION_VALUE', domain: '.amazon.com', path: '/', secure: true }], maxRedirects: 0 });
  const state = { schema: 'amazon-retail-public-session-v1', capturedAt: new Date().toISOString(),
    session: session.toJSON(), lastSuccessfulReadAt: null, lastFailure: null };
  const { registry: runtime, handle } = registry('retail-amazon', { storeDirectory: directory, sessionName: 'amazon-local-fixture',
    credentialProvider: async id => { providerCalls++; assert.equal(id, 'retail-amazon'); return state; },
    fetchImpl: async (url, init) => { fetchCalls++; assert.equal(init.method, 'GET');
      assert.equal(url, 'https://www.amazon.com/-/ko/dp/B08KT2Z93D/');
      assert.match(new Headers(init.headers).get('cookie'), /PRIVATE_SESSION_VALUE/); return response(amazonProduct); } });
  for (let i = 0; i < 2; i++) {
    const result = await runtime.execute('product', { path: { asin: 'B08KT2Z93D' } });
    assert.equal(result.data.asin, 'B08KT2Z93D'); assert.equal(result.data.receipt.authenticationVerified, false);
    assert.equal(result.receipt.networkUsed, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SESSION_VALUE|cookieJar|"storage"/); assertJson(result);
  }
  assert.equal(providerCalls, 1); assert.equal(fetchCalls, 2); handle.close();
  await assert.rejects(runtime.execute('product', { path: { asin: 'B08KT2Z93D' } }), { code: 'RETAIL_ADAPTER_CLOSED' });
});

test('Coupang protected RSC adapter preserves native business results but omits persistence state', async t => {
  const directory = await temporaryDirectory(t);
  const { renewCoupangSignature } = await import('../lib/retail/coupang-signature.mjs');
  const { createCoupangRetailState, RETAIL_COOKIE_NAMES } = await import('../lib/retail/coupang-retail-session.mjs');
  const now = Date.now();
  const signature = renewCoupangSignature(JSON.parse(vectors).vectors[0].encoded, { now, nonce: 'b'.repeat(32) });
  const state = createCoupangRetailState(RETAIL_COOKIE_NAMES.map(name => ({ name,
    value: name === 'x-cp-s' ? signature.value : 'PRIVATE_' + name, domain: '.coupang.com', path: '/',
    secure: true, httpOnly: false, expires: (now + 600000) / 1000 })));
  let calls = 0;
  const { registry: runtime } = registry('coupang-retail', { storeDirectory: directory,
    credentialProvider: async () => state, fetchImpl: async (_url, init) => {
      calls++; assert.equal(init.method, 'GET'); assert.match(new Headers(init.headers).get('cookie'), /PRIVATE_PCID/);
      return response('c:' + JSON.stringify(['$', null, null, JSON.parse(rscList)]) + '\n', 'text/x-component');
    } });
  const result = await runtime.execute('retail-search-session', { query: { query: 'mouse' } });
  assert.equal(calls, 1); assert.equal(result.data.data.products.length, 60); assert.equal(result.data.states.live_replay, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|cookieJar|"storage"/); assertJson(result);
});

test('AbortSignal is forwarded into native HTTP and cancellation cannot return success', async () => {
  const controller = new AbortController(); let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { registry: runtime } = registry('retail-ebay', { fetchImpl: async (_url, init) => {
    started(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  } });
  const request = runtime.execute('suggest', { query: { query: 'mouse' } }, { signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(request, { code: 'OPERATION_ABORTED' });
  const handle = definitions[0].createAdapters({ fetchImpl: () => assert.fail('pre-aborted network') });
  await assert.rejects(handle.adapters['retail-aliexpress.sitemap-index']({}, { signal: controller.signal }), { code: 'OPERATION_ABORTED' });
});
