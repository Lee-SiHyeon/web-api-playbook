import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireEbayAppToken, createEbayBrowseClient, ebayBrowseContract } from '../lib/commerce/ebay-browse.mjs';

const json = (value, status = 200, mime = 'application/json; charset=utf-8') =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': mime } });

const itemSummary = (overrides = {}) => ({
  itemId: 'v1|285012345678|0',
  title: 'USB-C charger 65W',
  itemWebUrl: 'https://www.ebay.com/itm/285012345678',
  price: { value: '24.99', currency: 'USD' },
  categories: [{ categoryId: '9394', categoryName: 'Cell Phone Accessories' }],
  shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '4.50', currency: 'USD' } }],
  ...overrides,
});

const itemPage = ({ query = 'usb-c charger', limit = 20, offset = 0, items = [itemSummary()], total = 21,
  categoryId, nextOffset = offset + limit, affiliate = false } = {}) => {
  const href = new URL(ebayBrowseContract.searchPath, ebayBrowseContract.apiOrigin);
  href.searchParams.set('q', query);
  href.searchParams.set('limit', String(limit));
  href.searchParams.set('offset', String(offset));
  href.searchParams.set('filter', 'buyingOptions:{FIXED_PRICE}');
  if (categoryId) href.searchParams.set('category_ids', categoryId);
  const next = nextOffset < total ? new URL(href) : null;
  if (next) next.searchParams.set('offset', String(nextOffset));
  const responseItems = affiliate ? items.map(item => ({ ...item,
    itemAffiliateWebUrl: 'https://rover.ebay.com/rover/1/123/1?mkcid=1&campid=1234567890&toolid=10001',
  })) : items;
  return { href: href.href, total, limit, offset, itemSummaries: responseItems,
    ...(next ? { next: next.href } : {}),
    categorySuggestions: [{ category: { categoryId: '293', categoryName: 'Electronics' } }],
  };
};

test('OAuth client credentials request uses eBay production endpoint, exact Browse scope, and memory-only token receipt', async () => {
  const secret = 'private-test-secret';
  let request;
  const result = await acquireEbayAppToken({ clientId: 'app-test-id', clientSecret: secret,
    now: () => Date.parse('2026-10-05T00:00:00Z'), fetchImpl: async (url, init) => {
      request = { url, init };
      assert.equal(url.origin, ebayBrowseContract.apiOrigin);
      assert.equal(url.pathname, ebayBrowseContract.tokenPath);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('app-test-id:' + secret).toString('base64')}`);
      assert.deepEqual([...new URLSearchParams(init.body)], [
        ['grant_type', 'client_credentials'],
        ['scope', 'https://api.ebay.com/oauth/api_scope'],
      ]);
      return json({ access_token: 'opaque-test-token', expires_in: 7200, token_type: 'Application Access Token' });
    } });
  assert.equal(result.accessToken, 'opaque-test-token');
  assert.equal(result.expiresIn, 7200);
  assert.equal(result.receipt.accessTokenPersisted, false);
  assert.equal(JSON.stringify(result.receipt).includes(secret), false);
  assert.equal(JSON.stringify(result.receipt).includes('opaque-test-token'), false);
  assert.equal(request.init.headers.authorization.startsWith('Basic '), true);
});

test('search validates a fixed-price page and preserves current item price separately from shipping', async () => {
  let calls = 0;
  const token = 'opaque-token-never-record-it';
  const client = createEbayBrowseClient({ accessToken: token, marketplaceId: 'EBAY_US',
    now: () => Date.parse('2026-10-05T01:00:00Z'), fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url.origin, 'https://api.ebay.com');
      assert.equal(url.pathname, ebayBrowseContract.searchPath);
      assert.deepEqual([...url.searchParams], [
        ['q', 'usb-c charger'], ['limit', '20'], ['offset', '0'], ['filter', 'buyingOptions:{FIXED_PRICE}'],
      ]);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.authorization, `Bearer ${token}`);
      assert.equal(init.headers['x-ebay-c-marketplace-id'], 'EBAY_US');
      assert.equal(init.headers.cookie, undefined);
      return json(itemPage());
    } });
  const result = await client.searchItems({ query: 'usb-c charger' });
  assert.equal(calls, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price.amount, '24.99');
  assert.equal(result.items[0].price.currency, 'USD');
  assert.equal(result.items[0].price.kind, 'retail_current');
  assert.equal(result.items[0].shippingOptions[0].shippingCost.amount, '4.50');
  assert.equal(result.items[0].shippingOptions[0].shippingCost.currency, 'USD');
  assert.equal('total' in result.items[0], false);
  assert.deepEqual(result.categories, [{ categoryId: '293', categoryName: 'Electronics' }]);
  assert.deepEqual(result.pagination, { total: 21, limit: 20, offset: 0, nextOffset: 20 });
  assert.equal(result.receipt.schema, 'web-api-credentialed-read-receipt-v1');
  assert.equal(result.receipt.request.marketplaceId, 'EBAY_US');
  assert.deepEqual(result.receipt.request.queryFields, ['q', 'limit', 'offset', 'filter']);
  assert.equal(result.receipt.queryMatched, true);
  assert.equal(result.receipt.authenticated, true);
  assert.equal(result.receipt.secretsPersistedInEvidence, false);
  assert.equal(JSON.stringify(result.receipt).includes('usb-c charger'), false);
  assert.equal(JSON.stringify(result.receipt).includes(token), false);
});

test('search accepts the official marketplace set, category query, and bounded price decimals', async () => {
  const client = createEbayBrowseClient({ accessToken: 'opaque-token' });
  for (const [marketplaceId, categoryId, currency, host] of [
    ['EBAY_US', '293', 'USD', 'www.ebay.com'],
    ['EBAY_GB', '293', 'GBP', 'www.ebay.co.uk'],
    ['EBAY_AU', '293', 'AUD', 'www.ebay.com.au'],
    ['EBAY_DE', '293', 'EUR', 'www.ebay.de'],
  ]) {
    const api = createEbayBrowseClient({ accessToken: 'opaque-token', marketplaceId,
      fetchImpl: async (url, init) => {
        assert.equal(url.searchParams.get('category_ids'), categoryId);
        assert.equal(init.headers['x-ebay-c-marketplace-id'], marketplaceId);
        return json(itemPage({ query: 'charger', categoryId, items: [itemSummary({
          itemWebUrl: `https://${host}/itm/285012345678`,
          price: { value: '00100.5'.replace(/^00/, ''), currency },
          shippingOptions: [],
        })], total: 1, nextOffset: 20 }));
      } });
    const page = await api.searchItems({ query: 'charger', categoryId });
    assert.equal(page.items[0].price.currency, currency);
    assert.equal(page.items[0].price.amount, '100.50');
    assert.equal(page.pagination.nextOffset, null);
  }
  assert.equal(Object.keys(ebayBrowseContract.marketplaces).length, 16);
  assert.equal(typeof client.searchItems, 'function');
});

test('detail read confirms the Browse ID and keeps item price and shipping separate', async () => {
  const requestedId = 'v1|285012345678|0';
  const payload = itemSummary({
    currentBidPrice: undefined,
    estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedRemainingQuantity: 4 }],
  });
  let calls = 0;
  const result = await createEbayBrowseClient({ accessToken: 'opaque-token', marketplaceId: 'EBAY_US',
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url.origin, ebayBrowseContract.apiOrigin);
      assert.equal(url.pathname, `${ebayBrowseContract.itemPath}/v1%7C285012345678%7C0`);
      assert.equal(url.search, '');
      assert.equal(init.headers.authorization, 'Bearer opaque-token');
      return json(payload);
    } }).getItem({ itemId: requestedId });
  assert.equal(calls, 1);
  assert.equal(result.item.itemId, requestedId);
  assert.equal(result.item.price.amount, '24.99');
  assert.equal(result.item.shippingOptions[0].shippingCost.amount, '4.50');
  assert.deepEqual(result.item.estimatedAvailabilities, [{ estimatedAvailabilityStatus: 'IN_STOCK',
    estimatedRemainingQuantity: 4 }]);
  assert.equal('allInTotal' in result.item, false);
  assert.equal(result.receipt.itemIdMatched, true);
});

test('an EPN campaign is only sent when supplied and only a matching returned affiliate URL is exposed', async () => {
  const campaign = '1234567890';
  const client = createEbayBrowseClient({ accessToken: 'opaque-token', affiliateCampaignId: campaign,
    affiliateReferenceId: 'catalog-42', fetchImpl: async (url, init) => {
      assert.equal(init.headers['x-ebay-c-enduserctx'],
        'affiliateCampaignId=1234567890,affiliateReferenceId=catalog-42');
      return json(itemPage({ items: [itemSummary()], affiliate: true, total: 1, nextOffset: 20 }));
    } });
  const result = await client.searchItems({ query: 'usb-c charger' });
  assert.equal(result.items[0].itemAffiliateWebUrl.includes('campid=1234567890'), true);

  const noCampaign = createEbayBrowseClient({ accessToken: 'opaque-token', fetchImpl: async () =>
    json(itemPage({ items: [itemSummary({ itemAffiliateWebUrl:
      'https://www.ebay.com/itm/285012345678?campid=1234567890' })], total: 1, nextOffset: 20 })) });
  const noAffiliate = await noCampaign.searchItems({ query: 'usb-c charger' });
  assert.equal('itemAffiliateWebUrl' in noAffiliate.items[0], false);
});

test('invalid marketplace, input, IDs and affiliate settings fail before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected network'); };
  assert.throws(() => createEbayBrowseClient({ accessToken: 'opaque-token', marketplaceId: 'EBAY_KR', fetchImpl }),
    { code: 'EBAY_MARKETPLACE_UNSUPPORTED' });
  assert.throws(() => createEbayBrowseClient({ accessToken: 'opaque-token', affiliateCampaignId: '123', fetchImpl }),
    { code: 'EBAY_AFFILIATE_CAMPAIGN_INVALID' });
  const client = createEbayBrowseClient({ accessToken: 'opaque-token', fetchImpl });
  for (const params of [
    { query: '' }, { query: '   ' }, { query: ' leading' }, { query: 'q'.repeat(1001) },
    { query: 'usb', limit: 0 }, { query: 'usb', limit: 201 }, { query: 'usb', offset: -1 },
    { query: 'usb', limit: 20, offset: 1 }, { query: 'usb', offset: 10_000 },
    { query: 'usb', categoryId: '../293' },
  ]) await assert.rejects(client.searchItems(params), { code: 'EBAY_SEARCH_INPUT_INVALID' });
  await assert.rejects(client.searchItems({ query: 'usb', marketplaceId: 'EBAY_KR' }),
    { code: 'EBAY_MARKETPLACE_UNSUPPORTED' });
  for (const itemId of ['', '285012345678', 'v1|285012345678|0/path', 'https://evil.test/v1|285012345678|0']) {
    await assert.rejects(client.getItem({ itemId }), { code: 'EBAY_ITEM_ID_INVALID' });
  }
  assert.equal(calls, 0);
});

test('wrong IDs, currencies, item URL origins and decimal formats fail closed', async () => {
  const client = createEbayBrowseClient({ accessToken: 'opaque-token' });
  for (const payload of [
    itemPage({ items: [itemSummary({ price: { value: '1e2', currency: 'USD' } })], total: 1, nextOffset: 20 }),
    itemPage({ items: [itemSummary({ price: { value: '-1.00', currency: 'USD' } })], total: 1, nextOffset: 20 }),
    itemPage({ items: [itemSummary({ price: { value: '1.001', currency: 'USD' } })], total: 1, nextOffset: 20 }),
    itemPage({ items: [itemSummary({ price: { value: '10.00', currency: 'ZZZ' } })], total: 1, nextOffset: 20 }),
    itemPage({ items: [itemSummary({ itemWebUrl: 'https://evil.test/item', price: { value: '1.00', currency: 'USD' } })],
      total: 1, nextOffset: 20 }),
  ]) await assert.rejects(createEbayBrowseClient({ accessToken: 'opaque-token', fetchImpl: async () => json(payload) })
    .searchItems({ query: 'usb-c charger' }));

  const wrongIdClient = createEbayBrowseClient({ accessToken: 'opaque-token', fetchImpl: async () =>
    json(itemSummary({ itemId: 'v1|999999999999|0' })) });
  await assert.rejects(wrongIdClient.getItem({ itemId: 'v1|285012345678|0' }),
    { code: 'EBAY_ITEM_SCHEMA_INVALID' });
});

test('pagination rejects a next link for another query or malformed continuation offset', async () => {
  const badQuery = itemPage();
  badQuery.next = badQuery.next.replace('usb-c+charger', 'other');
  await assert.rejects(createEbayBrowseClient({ accessToken: 'opaque-token', fetchImpl: async () => json(badQuery) })
    .searchItems({ query: 'usb-c charger' }), { code: 'EBAY_PAGINATION_INVALID' });
  const badOffset = itemPage();
  const nextUrl = new URL(badOffset.next);
  nextUrl.searchParams.set('offset', '11');
  badOffset.next = nextUrl.href;
  await assert.rejects(createEbayBrowseClient({ accessToken: 'opaque-token', fetchImpl: async () => json(badOffset) })
    .searchItems({ query: 'usb-c charger' }), { code: 'EBAY_PAGINATION_INVALID' });
});

test('OAuth and Browse errors reject redirects, gates, wrong MIME, malformed JSON, and oversized replies', async () => {
  for (const [reply, code] of [
    [new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }), 'EBAY_RESPONSE_INVALID'],
    [json({}, 401), 'EBAY_AUTH_REQUIRED'],
    [json({}, 403), 'EBAY_ACCESS_DENIED'],
    [json({}, 429), 'EBAY_RATE_LIMITED'],
    [new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }), 'EBAY_RESPONSE_INVALID'],
    [new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
      'EBAY_RESPONSE_TOO_LARGE'],
  ]) {
    const client = createEbayBrowseClient({ accessToken: 'opaque-token', fetchImpl: async () => reply });
    await assert.rejects(client.searchItems({ query: 'usb-c charger' }), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.request.browserUsed, false);
      return true;
    });
  }
  await assert.rejects(acquireEbayAppToken({ clientId: 'id', clientSecret: 'secret',
    fetchImpl: async () => json({ access_token: 'secret-token', expires_in: 2, token_type: 'Bearer' }) }),
  { code: 'EBAY_OAUTH_SCHEMA_INVALID' });
});
