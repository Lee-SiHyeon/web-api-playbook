import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRakutenAdvertisingProductSearchClient,
  rakutenAdvertisingContract,
} from '../lib/commerce/rakuten-advertising.mjs';

const FIXED_NOW = Date.parse('2026-10-05T02:00:00.000Z');

function response(body, { status = 200, mime = 'application/xml; charset=utf-8', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': mime, ...headers } });
}

function productXml({ mid = '1234', linkId = 'link-42', sku = 'SKU-001', title = 'USB &amp; charger',
  currency = 'USD', price = '24.99', saleCurrency = currency, salePrice = '19.99',
  linkUrl = 'https://click.linksynergy.com/deep-link?id=example', imageUrl = 'https://merchant.example.test/item.jpg' } = {}) {
  const sale = salePrice === '' ? '' : '<saleprice currency="' + saleCurrency + '">' + salePrice + '</saleprice>';
  return '<item><mid>' + mid + '</mid><merchantname>Sephora US</merchantname><linkid>' + linkId +
    '</linkid><createdon>2026-10-04/05:30:32</createdon><sku>' + sku +
    '</sku><productname>' + title + '</productname><category><primary>Beauty</primary>' +
    '<secondary>Beauty~~Skin care</secondary></category><price currency="' + currency + '">' + price +
    '</price>' + sale + '<upccode>0001234567890</upccode><description><short>Short &amp; useful</short>' +
    '<long>Long description</long></description><keywords>serum,skin</keywords><linkurl>' + linkUrl +
    '</linkurl><imageurl>' + imageUrl + '</imageurl></item>';
}

function resultXml({ page = 1, totalPages = 1, totalMatches = 1, items = [productXml()] } = {}) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<result><TotalMatches>' + totalMatches + '</TotalMatches><TotalPages>' + totalPages +
    '</TotalPages><PageNumber>' + page + '</PageNumber>' + items.join('') + '</result>';
}

function makeClient(fetchImpl, overrides = {}) {
  return createRakutenAdvertisingProductSearchClient({
    accessToken: 'publisher-token-memory-only',
    now: () => FIXED_NOW,
    fetchImpl,
    ...overrides,
  });
}

test('Product Search maps retailer MID and link ID composite identity, SKU, currency and separate sale price', async () => {
  let called;
  const client = makeClient(async (input, init) => {
    called = { url: new URL(input), init };
    return response(resultXml());
  });
  const result = await client.searchProducts({ keyword: 'skin serum', advertiserMid: '1234',
    category: 'Beauty', language: 'en_US', page: 1, pageSize: 20 });

  assert.equal(result.provider, 'rakuten-advertising');
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    provider: 'rakuten-advertising',
    productId: '1234:link-42',
    variantId: 'SKU-001',
    title: 'USB & charger',
    affiliateURL: 'https://click.linksynergy.com/deep-link?id=example',
    canonicalURL: null,
    imageUrl: 'https://merchant.example.test/item.jpg',
    price: { amount: '24.99', currency: 'USD', kind: 'retail_list' },
    salePrice: { amount: '19.99', currency: 'USD', kind: 'retail_sale' },
    availability: 'unknown',
    observedAt: '2026-10-05T02:00:00.000Z',
    source: {
      network: 'rakuten-advertising',
      advertiserId: '1234',
      advertiserName: 'Sephora US',
      productLinkId: 'link-42',
      compositeProductKey: '["1234","link-42"]',
      sku: 'SKU-001',
      upc: '0001234567890',
      categories: { primary: 'Beauty', secondary: 'Beauty~~Skin care' },
      description: { short: 'Short & useful', long: 'Long description' },
      keywords: 'serum,skin',
      linkCreatedOn: '2026-10-04/05:30:32',
      priceFieldSemantics: 'price and saleprice are reported separately; sale activity dates are not returned by Product Search',
      stockSemantics: 'Product Search does not expose an on-hand inventory quantity',
    },
  });
  assert.equal(called.url.origin, 'https://api.linksynergy.com');
  assert.equal(called.url.pathname, '/productsearch/1.0');
  assert.equal(called.url.searchParams.get('keyword'), 'skin serum');
  assert.equal(called.url.searchParams.get('mid'), '1234');
  assert.equal(called.url.searchParams.get('cat'), 'Beauty');
  assert.equal(called.url.searchParams.get('language'), 'en_US');
  assert.equal(called.url.searchParams.get('max'), '20');
  assert.equal(called.url.searchParams.get('pagenumber'), '1');
  assert.equal(called.init.method, 'GET');
  assert.equal(called.init.redirect, 'manual');
  assert.equal(called.init.credentials, 'omit');
  assert.equal(called.init.headers.accept, 'application/xml');
  assert.equal(called.init.headers.authorization, 'Bearer publisher-token-memory-only');
  assert.equal(result.receipt.request.credentialsUsed, true);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.credentialBinding.source, 'process-memory');
  assert.equal(result.receipt.secretsPersistedInEvidence, false);
  assert.equal(JSON.stringify(result).includes('publisher-token-memory-only'), false);
});

test('search accepts root aliases and uses only the documented keyword/category/sort fields', async () => {
  let url;
  const client = makeClient(async input => {
    url = new URL(input);
    return response(resultXml({ items: [] }));
  });
  await client.searchProducts({ query: 'hydrating serum', category: 'Beauty',
    language: 'fr_FR', merchantId: '67890', sort: 'retailprice', sortType: 'asc', pageSize: 10 });
  assert.equal(url.searchParams.get('keyword'), 'hydrating serum');
  assert.equal(url.searchParams.has('exact'), false);
  assert.equal(url.searchParams.get('cat'), 'Beauty');
  assert.equal(url.searchParams.get('language'), 'fr_FR');
  assert.equal(url.searchParams.get('mid'), '67890');
  assert.equal(url.searchParams.get('sort'), 'retailprice');
  assert.equal(url.searchParams.get('sorttype'), 'asc');
  assert.equal(url.searchParams.has('one'), false);
});

test('collection follows declared pages, keeps MID and SKU identities and records a complete result set', async () => {
  let now = FIXED_NOW;
  const calls = [];
  const client = makeClient(async input => {
    const url = new URL(input);
    calls.push(url);
    const page = Number(url.searchParams.get('pagenumber'));
    const rows = page === 1
      ? Array.from({ length: 100 }, (_, index) => productXml({ linkId: 'p-' + index, sku: 's-' + index, salePrice: '' }))
      : Array.from({ length: 30 }, (_, index) => productXml({ linkId: 'p-' + (100 + index), sku: 's-' + (100 + index), salePrice: '' }));
    return response(resultXml({ page, totalPages: 2, totalMatches: 130, items: rows }));
  }, { now: () => now, sleepImpl: async milliseconds => { now += milliseconds; } });
  const result = await client.collectProducts({ keyword: 'cleanser', advertiserMid: '1234' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(url => url.searchParams.get('pagenumber')), ['1', '2']);
  assert.equal(result.items.length, 130);
  assert.equal(result.items[0].productId, '1234:p-0');
  assert.equal(result.items[129].variantId, 's-129');
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.pagesRead, 2);
  assert.equal(result.pagination.incompleteReason, undefined);
});

test('official 1,000 versus 5,000 documentation conflict is capped and never reported as exhausted', async () => {
  let now = FIXED_NOW;
  const client = makeClient(async input => {
    const page = Number(new URL(input).searchParams.get('pagenumber'));
    const rows = Array.from({ length: 100 }, (_, index) =>
      productXml({ linkId: 'p' + page + '-' + index, sku: 's' + page + '-' + index, salePrice: '' }));
    return response(resultXml({ page, totalPages: 25, totalMatches: 2_500, items: rows }));
  }, { now: () => now, sleepImpl: async milliseconds => { now += milliseconds; } });
  const result = await client.collectProducts({ keyword: 'serum' });
  assert.equal(result.items.length, 1_000);
  assert.equal(result.pagination.pagesRead, 10);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.sourceResultCapApplied, true);
  assert.equal(result.pagination.incompleteReason, 'official_result_limit_discrepancy_conservative_cap');
});

test('single-page response preserves the lower documented result cap as an explicit truncation signal', async () => {
  const client = makeClient(async () => response(resultXml({ totalPages: 25, totalMatches: 2_500 })));
  const result = await client.searchProducts({ keyword: 'serum', pageSize: 100 });
  assert.equal(result.pagination.totalMatches, 2_500);
  assert.equal(result.pagination.resultSetMayBeTruncated, true);
  assert.equal(result.pagination.conservativeResultCap, 1_000);
});

test('page metadata and returned advertiser identity are checked against the request', async () => {
  const wrongPage = makeClient(async () => response(resultXml({ page: 2, totalPages: 3, totalMatches: 30 })));
  await assert.rejects(wrongPage.searchProducts({ keyword: 'serum', page: 1 }), { code: 'RAKUTEN_PAGINATION_SCHEMA_INVALID' });
  const wrongMid = makeClient(async () => response(resultXml({ items: [productXml({ mid: '9999' })] })));
  await assert.rejects(wrongMid.searchProducts({ keyword: 'serum', advertiserMid: '1234' }),
    { code: 'RAKUTEN_PRODUCT_IDENTITY_INVALID' });
});

test('currency, amount, retailer URL and XML fields fail closed', async () => {
  for (const xml of [
    resultXml({ items: [productXml({ currency: 'US', salePrice: '' })] }),
    resultXml({ items: [productXml({ price: '1e4', salePrice: '' })] }),
    resultXml({ items: [productXml({ saleCurrency: 'EUR' })] }),
    resultXml({ items: [productXml({ linkUrl: 'javascript:alert(1)' })] }),
    '<result><TotalMatches>1</TotalMatches><TotalPages>1</TotalPages><PageNumber>1</PageNumber><item></result>',
  ]) {
    const client = makeClient(async () => response(xml));
    await assert.rejects(client.searchProducts({ keyword: 'serum' }));
  }
});

test('DTD, external entity, undeclared entity, malformed XML and oversized payload are rejected', async () => {
  const payloads = [
    '<!DOCTYPE result [<!ENTITY x "expanded">]><result/>',
    '<result><TotalMatches>&external;</TotalMatches></result>',
    '<result><TotalMatches>1</TotalMatches>',
  ];
  for (const payload of payloads) {
    const client = makeClient(async () => response(payload));
    await assert.rejects(client.searchProducts({ keyword: 'serum' }));
  }
  const large = makeClient(async () => response('<result>' + 'x'.repeat(2_000) + '</result>'),
    { maxResponseBytes: 1_000 });
  await assert.rejects(large.searchProducts({ keyword: 'serum' }), { code: 'RAKUTEN_RESPONSE_TOO_LARGE' });
});

test('redirects, HTML gates, JSON errors, authorization failures and throttling stay distinct', async () => {
  const cases = [
    [response('', { status: 302, mime: 'text/html' }), 'RAKUTEN_REDIRECT_REJECTED'],
    [response('<html>sign in</html>', { mime: 'text/html' }), 'RAKUTEN_RESPONSE_INVALID'],
    [response('{"error":"unauthorized"}', { status: 401, mime: 'application/json' }), 'RAKUTEN_AUTH_REQUIRED'],
    [response('{"error":"forbidden"}', { status: 403, mime: 'application/json' }), 'RAKUTEN_ACCESS_DENIED'],
    [response('{"error":"rate limited"}', { status: 429, mime: 'application/json' }), 'RAKUTEN_RATE_LIMITED'],
  ];
  for (const [reply, code] of cases) {
    const client = makeClient(async () => reply);
    await assert.rejects(client.searchProducts({ keyword: 'serum' }), { code });
  }
});

test('inputs and credentials are checked before sending a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('unexpected request'); };
  const client = makeClient(fetchImpl);
  for (const input of [
    {}, { keyword: 'x', exact: 'y' }, { keyword: ' bad' }, { keyword: 'wireless-mouse' },
    { keyword: 'a&b' }, { category: 'Beauty', pageSize: 101 }, { keyword: 'serum', page: 1001, pageSize: 1 },
    { keyword: 'serum', advertiserMid: '12/34' }, { keyword: 'serum', language: 'ja_JP' },
    { keyword: 'serum', sort: 'commission', sortType: 'asc' }, { id: 'sku-1' },
  ]) await assert.rejects(client.searchProducts(input));
  assert.throws(() => createRakutenAdvertisingProductSearchClient({ accessToken: 'has spaces', fetchImpl }),
    { code: 'RAKUTEN_ACCESS_TOKEN_REQUIRED' });
  assert.equal(calls, 0);
  const contract = rakutenAdvertisingContract();
  assert.equal(contract.apiOrigin, 'https://api.linksynergy.com');
  assert.equal(contract.productSearchPath, '/productsearch/1.0');
  assert.equal(contract.maxPageSize, 100);
});
