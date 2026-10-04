import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmazonCreatorsClient, AmazonCreatorsApiError } from '../lib/commerce/amazon-creators.mjs';

const credentialId = 'test-credential-id';
const credentialSecret = 'test-only-secret-value';
const accessToken = 'test-only-access-token';
const fixedTime = Date.parse('2026-10-05T00:00:00.000Z');
const tokenResponse = () => ({ access_token: accessToken, token_type: 'bearer', scope: 'creatorsapi::default', expires_in: 3600 });

function item(asin = 'B012345678') {
  return {
    asin,
    detailPageURL: `https://www.amazon.com/dp/${asin}?tag=caller-tag-20&linkCode=ogi`,
    images: { primary: { medium: { height: 160, width: 160, url: 'https://m.media-amazon.com/images/I/sample.jpg' } } },
    itemInfo: { title: { displayValue: 'Sample item', label: 'Title', locale: 'en_US' } },
    offersV2: { listings: [{
      availability: { type: 'IN_STOCK', message: 'In Stock', minOrderQuantity: 1, maxOrderQuantity: 5 },
      condition: { value: 'New', subCondition: 'Unknown', conditionNote: '' },
      isBuyBoxWinner: true,
      merchantInfo: { name: 'Amazon.com' },
      price: {
        money: { amount: 14.99, currency: 'USD', displayAmount: '$14.99' },
        savingBasis: { money: { amount: 19.99, currency: 'USD', displayAmount: '$19.99' },
          savingBasisType: 'LIST_PRICE', savingBasisTypeLabel: 'List Price' },
        savings: { money: { amount: 5, currency: 'USD', displayAmount: '$5.00' }, percentage: 25 },
      },
    }] },
    parentASIN: 'B012345678',
  };
}

function makeClient(fetchImpl, options = {}) {
  return createAmazonCreatorsClient({ credentialId, credentialSecret, credentialVersion: '3.1',
    partnerTag: 'caller-tag-20', marketplace: 'www.amazon.com', fetchImpl, now: () => fixedTime, ...options });
}

function apiResponse(items, totalResultCount = items.length, errors = undefined) {
  return Response.json({ searchResult: { items, totalResultCount, searchURL: 'https://www.amazon.com/s?k=headphones',
    ...(errors === undefined ? {} : { errors }) } });
}

test('uses the documented LwA version endpoint and lowerCamelCase SearchItems payload, then keeps price basis semantics', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://api.amazon.com/auth/o2/token') {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.get('content-type'), 'application/json');
      assert.deepEqual(JSON.parse(init.body), {
        grant_type: 'client_credentials', client_id: credentialId,
        client_secret: credentialSecret, scope: 'creatorsapi::default',
      });
      return Response.json(tokenResponse());
    }
    assert.equal(String(url), 'https://creatorsapi.amazon/catalog/v1/searchItems');
    assert.equal(init.headers.get('authorization'), `Bearer ${accessToken}`);
    assert.equal(init.headers.get('x-marketplace'), 'www.amazon.com');
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('x-amz-date'), null);
    assert.equal(init.headers.get('x-amz-target'), null);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['itemCount', 'itemPage', 'keywords', 'marketplace', 'partnerTag', 'resources'].sort());
    assert.equal(body.keywords, 'headphones');
    assert.equal(body.itemCount, 10);
    assert.equal(body.itemPage, 1);
    assert.equal(body.marketplace, 'www.amazon.com');
    assert.equal(body.partnerTag, 'caller-tag-20');
    assert.ok(body.resources.includes('offersV2.listings.price'));
    assert.equal(Object.hasOwn(body, 'Keywords'), false);
    return apiResponse([item()], 21);
  };

  const result = await makeClient(fetchImpl).searchItems({ keywords: 'headphones' });
  assert.equal(calls.length, 2);
  assert.equal(result.items[0].asin, 'B012345678');
  assert.equal(result.items[0].title, 'Sample item');
  assert.deepEqual(result.items[0].offers[0].currentPrice, { amount: '14.99', currency: 'USD', displayAmount: '$14.99' });
  assert.deepEqual(result.items[0].offers[0].savingBasis, {
    money: { amount: '19.99', currency: 'USD', displayAmount: '$19.99' }, type: 'LIST_PRICE', label: 'List Price',
  });
  assert.equal(result.items[0].offers[0].availability.type, 'IN_STOCK');
  assert.equal(result.totalResultCount, 21);
  assert.equal(result.receipt.request.origin, 'https://creatorsapi.amazon');
  assert.equal(result.receipt.request.path, '/catalog/v1/searchItems');
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.request.credentialsUsed, true);
  assert.equal(result.receipt.expectedResultVerified, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(credentialSecret), false);
  assert.equal(serialized.includes(accessToken), false);
});

test('gets up to ten ASINs and binds each returned item ID to the request', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/auth/o2/token')) return Response.json(tokenResponse());
    assert.equal(String(url), 'https://creatorsapi.amazon/catalog/v1/getItems');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.itemIds, ['B012345678', 'B987654321']);
    assert.equal(body.itemIdType, 'ASIN');
    assert.equal(body.condition, 'Any');
    assert.equal(body.marketplace, 'www.amazon.com');
    assert.equal(body.partnerTag, 'caller-tag-20');
    return Response.json({ itemsResult: { items: [item('B012345678'), item('B987654321')] } });
  };
  const result = await makeClient(fetchImpl).getItems({ itemIds: ['B012345678', 'B987654321'] });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.items.map(value => value.asin), ['B012345678', 'B987654321']);
  assert.deepEqual(result.missingItemIds, []);
  assert.equal(result.receipt.expectedIdsMatched, true);
  assert.equal(result.receipt.expectedResultVerified, true);
  assert.deepEqual(result.items[1].offers[0].currentPrice, { amount: '14.99', currency: 'USD', displayAmount: '$14.99' });
});

test('preserves useful SearchItems results and sanitized errors while marking the result partial', async () => {
  const fetchImpl = async url => String(url).endsWith('/auth/o2/token')
    ? Response.json(tokenResponse())
    : apiResponse([item()], 18, [
      { code: 'ItemOfferUnavailable', message: 'Offer details were incomplete' },
      { message: 'A second partial response warning' },
    ]);
  const result = await makeClient(fetchImpl).searchItems({ keywords: 'headphones' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].asin, 'B012345678');
  assert.deepEqual(result.errors, [{ code: 'ItemOfferUnavailable' }, {}]);
  assert.equal(result.partial, true);
  assert.equal(result.receipt.schemaVerified, true);
  assert.equal(result.receipt.expectedResultVerified, false);
  assert.equal(Object.hasOwn(result.receipt, 'expectedIdsMatched'), false);
});

test('selects the official regional LwA token endpoint from the assigned credential version', async () => {
  const endpoints = new Map([
    ['3.1', 'https://api.amazon.com/auth/o2/token'],
    ['3.2', 'https://api.amazon.co.uk/auth/o2/token'],
    ['3.3', 'https://api.amazon.co.jp/auth/o2/token'],
  ]);
  for (const [credentialVersion, tokenEndpoint] of endpoints) {
    const seen = [];
    const client = makeClient(async url => {
      seen.push(String(url));
      return String(url) === tokenEndpoint
        ? Response.json(tokenResponse())
        : apiResponse([item()]);
    }, { credentialVersion });
    const result = await client.searchItems({ keywords: 'headphones', currencyOfPreference: 'USD' });
    assert.equal(result.items.length, 1);
    assert.deepEqual(seen, [tokenEndpoint, 'https://creatorsapi.amazon/catalog/v1/searchItems']);
  }
});

test('searchPages is sequential and bounded by the official ten-page, ten-items-per-page limits', async () => {
  const catalogPages = [];
  let tokenCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/auth/o2/token')) { tokenCalls++; return Response.json(tokenResponse()); }
    const body = JSON.parse(init.body);
    catalogPages.push(body.itemPage);
    const errors = body.itemPage === 2 ? [{ code: 'PartialPageResult' }] : undefined;
    return apiResponse([item(`B${String(body.itemPage).padStart(9, '0')}`)], 30, errors);
  };
  const result = await makeClient(fetchImpl).searchPages({ keywords: 'headphones', maxPages: 3, itemCount: 1 });
  assert.deepEqual(catalogPages, [1, 2, 3]);
  assert.equal(tokenCalls, 1);
  assert.equal(result.items.length, 3);
  assert.equal(result.pagination.fetchedPages, 3);
  assert.equal(result.pagination.maxPage, 10);
  assert.equal(result.pagination.maxItemsPerPage, 10);
  assert.equal(result.pagination.truncated, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.partialResponses, [{ itemPage: 2, errors: [{ code: 'PartialPageResult' }] }]);
  assert.equal(result.pages[1].receipt.expectedResultVerified, false);
});

test('reuses a token in memory and rejects out-of-range pages, oversized item lists, and legacy PA-API field casing before network', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls++;
    if (String(url).endsWith('/auth/o2/token')) return Response.json(tokenResponse());
    return apiResponse([item()]);
  };
  const client = makeClient(fetchImpl);
  await client.searchItems({ keywords: 'headphones' });
  await client.searchItems({ keywords: 'speakers' });
  assert.equal(calls, 3);
  assert.deepEqual(client.getTokenStatus(), { cached: true, expiresAt: new Date(fixedTime + 3_600_000).toISOString() });
  await assert.rejects(client.searchItems({ Keywords: 'headphones' }), error => error.code === 'AMAZON_CREATORS_SEARCH_FIELD_UNSUPPORTED');
  await assert.rejects(client.searchItems({ keywords: 'headphones', itemPage: 11 }), error => error.code === 'AMAZON_CREATORS_PAGE_INVALID');
  await assert.rejects(client.searchPages({ keywords: 'headphones', maxPages: 11 }), error => error.code === 'AMAZON_CREATORS_PAGE_INVALID');
  await assert.rejects(client.getItems({ itemIds: Array.from({ length: 11 }, (_, index) => `B${String(index).padStart(9, '0')}`) }),
    error => error.code === 'AMAZON_CREATORS_ITEM_IDS_INVALID');
  assert.equal(calls, 3);
});

test('credential version, marketplace, partner tag, OAuth scope, response IDs, and price schemas are checked', async () => {
  assert.throws(() => createAmazonCreatorsClient({ credentialId, credentialSecret, credentialVersion: 'PA-API', partnerTag: 'tag' }),
    error => error instanceof AmazonCreatorsApiError && error.code === 'AMAZON_CREATORS_CREDENTIAL_VERSION_UNSUPPORTED');
  assert.throws(() => createAmazonCreatorsClient({ credentialId, credentialSecret, credentialVersion: '3.1', partnerTag: 'tag', marketplace: 'www.amazon.invalid' }),
    error => error.code === 'AMAZON_CREATORS_MARKETPLACE_UNSUPPORTED');
  assert.throws(() => createAmazonCreatorsClient({ credentialId, credentialSecret, credentialVersion: '3.1', partnerTag: '' }),
    error => error.code === 'AMAZON_CREATORS_PARTNER_TAG_REQUIRED');

  let catalogCalls = 0;
  const badScope = makeClient(async () => Response.json({ ...tokenResponse(), scope: 'other' }));
  await assert.rejects(badScope.searchItems({ keywords: 'headphones' }), error => error.code === 'AMAZON_CREATORS_TOKEN_SCHEMA_INVALID');

  const wrongId = makeClient(async url => {
    if (String(url).endsWith('/auth/o2/token')) return Response.json(tokenResponse());
    catalogCalls++;
    return Response.json({ itemsResult: { items: [item('B999999999')] } });
  });
  await assert.rejects(wrongId.getItems({ itemIds: ['B012345678'] }), error => error.code === 'AMAZON_CREATORS_UNREQUESTED_ITEM');
  assert.equal(catalogCalls, 1);

  const badPrice = item();
  badPrice.offersV2.listings[0].price.money.amount = -1;
  const invalidPrice = makeClient(async url => String(url).endsWith('/auth/o2/token')
    ? Response.json(tokenResponse()) : apiResponse([badPrice]));
  await assert.rejects(invalidPrice.searchItems({ keywords: 'headphones' }), error => error.code === 'AMAZON_CREATORS_PRICE_SCHEMA_INVALID');
});
