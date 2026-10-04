import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createShopeeAffiliateClient, ShopeeAffiliateError } from '../lib/commerce/shopee-affiliate.mjs';

const appId = '123456789';
const appSecret = 'unit-test-secret-only';
const fixedTime = Date.parse('2026-10-05T00:00:00.000Z');
const origin = 'https://open-api.affiliate.shopee.co.id';

function product(overrides = {}) {
  return {
    itemId: '44310514031',
    productName: 'Sample lip tint',
    price: '89000',
    priceMin: '79000',
    priceMax: '99000',
    commissionRate: '0.0123',
    sellerCommissionRate: '0.01',
    shopeeCommissionRate: '0.0023',
    appExistRate: '0.015',
    appNewRate: '0.02',
    webExistRate: '0.01',
    webNewRate: '0.018',
    commission: '1094.7',
    sales: 251,
    imageUrl: 'https://down-id.img.susercontent.com/file/sample.jpg',
    productLink: 'https://shopee.co.id/sample-product-i.33594331.44310514031',
    shopId: '33594331',
    shopName: 'Sample Store',
    productCatIds: [100001, 100002],
    ratingStar: '4.9',
    priceDiscountRate: 10,
    shopType: [1, 2],
    periodStartTime: 1791158400,
    periodEndTime: 1791763200,
    ...overrides,
  };
}

function response(value, status = 200, contentType = 'application/json; charset=utf-8') {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': contentType } });
}

function graph(products = [product()], pageInfo = { page: 1, limit: 20, hasNextPage: false, scrollId: '' }) {
  return { data: { productOfferV2: { nodes: products, pageInfo } } };
}

function makeClient(fetchImpl, options = {}) {
  return createShopeeAffiliateClient({ appId, appSecret, fetchImpl, now: () => fixedTime, ...options });
}

test('uses the official Indonesia GraphQL endpoint and signature over the exact serialized request body', async () => {
  let seen;
  const fetchImpl = async (input, init) => {
    seen = { url: String(input), init };
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('content-type'), 'application/json');
    const body = JSON.parse(init.body);
    assert.equal(body.query,
      'query { productOfferV2(listType: 0, keyword: "lip tint", sortType: 1, page: 1, limit: 20) { nodes { itemId productName price priceMin priceMax commissionRate sellerCommissionRate shopeeCommissionRate appExistRate appNewRate webExistRate webNewRate commission sales imageUrl productLink shopId shopName productCatIds ratingStar priceDiscountRate shopType periodStartTime periodEndTime } pageInfo { page limit hasNextPage } } }');
    const timestamp = String(Math.ceil(fixedTime / 1000));
    const signature = createHash('sha256').update(`${appId}${timestamp}${init.body}${appSecret}`).digest('hex');
    assert.equal(init.headers.get('authorization'),
      `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`);
    return response(graph());
  };

  const result = await makeClient(fetchImpl).searchProducts({ keyword: 'lip tint' });
  assert.equal(seen.url, `${origin}/graphql`);
  assert.equal(result.market, 'ID');
  assert.equal(result.currency, null);
  assert.equal(result.currencyCandidate, 'IDR');
  assert.equal(result.currencyVerified, false);
  assert.deepEqual(result.products[0].price, {
    amount: '89000', currency: null, currencyCandidate: 'IDR', currencyVerified: false,
    currencySource: 'market-inference', sourceField: 'price',
  });
  assert.deepEqual(result.products[0].priceRange, {
    min: '79000', max: '99000', currency: null, currencyCandidate: 'IDR',
    currencyVerified: false, currencySource: 'market-inference',
  });
  assert.deepEqual(result.products[0].commission, {
    amount: '1094.7', currency: null, currencyCandidate: 'IDR', currencyVerified: false,
    currencySource: 'market-inference', rate: '0.0123', ratePercent: '1.23',
    sellerRate: '0.01', shopeeRate: '0.0023', appExistingUserRate: '0.015',
    appNewUserRate: '0.02', webExistingUserRate: '0.01', webNewUserRate: '0.018',
  });
  assert.equal(result.products[0].itemId, '44310514031');
  assert.equal(result.products[0].sales, '251');
  assert.equal(result.request.browserUsed, false);
  assert.equal(result.request.credentialsUsed, true);
  assert.equal(result.request.appCredentialsSent, true);
  assert.equal(result.request.userSessionSent, false);
  assert.equal(result.request.cookieSent, false);
  assert.equal(result.request.httpStatus, 200);
  assert.equal(result.schemaVerified, true);
  assert.equal(result.expectedResultVerified, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(appSecret), false);
  assert.equal(serialized.includes(`Credential=${appId}`), false);
});

test('search accepts explicit category order, page size, and bounded keyword escaping', async () => {
  let actualQuery;
  const fetchImpl = async (_url, init) => {
    actualQuery = JSON.parse(init.body).query;
    return response(graph([], { page: 3, limit: 5, hasNextPage: true, scrollId: 'short-lived-page-cursor' }));
  };
  const result = await makeClient(fetchImpl).searchProducts({ keyword: 'lip "tint"', page: 3, limit: 5, sortType: 5 });
  assert.match(actualQuery, /keyword: "lip \\\"tint\\\""/);
  assert.match(actualQuery, /sortType: 5, page: 3, limit: 5/);
  assert.deepEqual(result.pageInfo, { page: 3, limit: 5, hasNextPage: true });
  assert.deepEqual(result.products, []);
});

test('gets one product by Int64 item ID and binds the response ID to that request', async () => {
  let actualQuery;
  const requestedId = '9007199254740993';
  const result = await makeClient(async (_url, init) => {
    actualQuery = JSON.parse(init.body).query;
    return response(graph([product({ itemId: requestedId })], { page: 1, limit: 1, hasNextPage: false }));
  }).getProductById({ itemId: requestedId });
  assert.match(actualQuery, /itemId: 9007199254740993, page: 1, limit: 1/);
  assert.equal(result.products[0].itemId, requestedId);
});

test('rejects missing developer credentials and invalid inputs before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(graph()); };
  assert.throws(() => createShopeeAffiliateClient({ appId, fetchImpl }),
    error => error instanceof ShopeeAffiliateError && error.code === 'SHOPEE_AFFILIATE_APP_CREDENTIALS_REQUIRED');
  const client = makeClient(fetchImpl);
  await assert.rejects(client.searchProducts({ keyword: '   ' }), error => error.code === 'SHOPEE_AFFILIATE_KEYWORD_INVALID');
  await assert.rejects(client.searchProducts({ keyword: 'a', limit: 21 }), error => error.code === 'SHOPEE_AFFILIATE_PAGINATION_INVALID');
  await assert.rejects(client.searchProducts({ keyword: 'a', sortType: 6 }), error => error.code === 'SHOPEE_AFFILIATE_PAGINATION_INVALID');
  await assert.rejects(client.getProductById({ itemId: '0' }), error => error.code === 'SHOPEE_AFFILIATE_ITEM_ID_INVALID');
  await assert.rejects(client.getProductById({ itemId: '1) { accountInfo } # ' }), error => error.code === 'SHOPEE_AFFILIATE_ITEM_ID_INVALID');
  assert.equal(calls, 0);
});

test('does not accept a success-looking HTTP 200 response with Shopee credential errors as a product result', async () => {
  const client = makeClient(async () => response({
    errors: [{ message: 'credentials omitted', extensions: { code: 10020 } }],
    data: null,
  }));
  await assert.rejects(client.searchProducts({ keyword: 'lip tint' }), error => {
    assert.equal(error.code, 'SHOPEE_AFFILIATE_REMOTE_ERROR');
    assert.equal(error.remoteCode, '10020');
    assert.equal(error.request.httpStatus, 200);
    assert.equal(error.request.credentialsUsed, true);
    assert.equal(error.request.expectedResultVerified, undefined);
    return true;
  });
});

test('rejects wrong IDs, malformed prices, invalid result URLs, and malformed GraphQL shapes', async () => {
  const wrongId = makeClient(async () => response(graph([product({ itemId: '44310514032' })])));
  await assert.rejects(wrongId.getProductById({ itemId: '44310514031' }),
    error => error.code === 'SHOPEE_AFFILIATE_ITEM_ID_MISMATCH');
  const missing = makeClient(async () => response(graph([])));
  await assert.rejects(missing.getProductById({ itemId: '44310514031' }), error => {
    assert.equal(error.code, 'SHOPEE_AFFILIATE_PRODUCT_NOT_FOUND');
    assert.equal(error.request.schemaVerified, true);
    assert.equal(error.request.expectedResultVerified, false);
    return true;
  });

  for (const badProduct of [
    product({ price: 'NaN' }),
    product({ productLink: 'https://example.com/item' }),
    product({ commissionRate: '1.2' }),
    product({ productCatIds: ['not-an-int'] }),
  ]) {
    await assert.rejects(makeClient(async () => response(graph([badProduct]))).searchProducts({ keyword: 'item' }),
      error => error.code === 'SHOPEE_AFFILIATE_SCHEMA_INVALID');
  }
  const malformed = makeClient(async () => response({ data: { productOfferV2: { nodes: [] } } }));
  await assert.rejects(malformed.searchProducts({ keyword: 'item' }),
    error => error.code === 'SHOPEE_AFFILIATE_SCHEMA_INVALID');
});

test('rejects redirects, non-JSON content, and transport failures without following them', async () => {
  const redirect = makeClient(async () => new Response('', { status: 302, headers: { location: 'https://example.com' } }));
  await assert.rejects(redirect.searchProducts({ keyword: 'item' }), error => {
    assert.equal(error.code, 'SHOPEE_AFFILIATE_REDIRECT_REJECTED');
    assert.equal(error.request.redirectsFollowed, false);
    return true;
  });

  const html = makeClient(async () => response('<html>login</html>', 200, 'text/html'));
  await assert.rejects(html.searchProducts({ keyword: 'item' }), error => error.code === 'SHOPEE_AFFILIATE_MIME_INVALID');

  const unavailable = makeClient(async () => { throw new TypeError('private transport detail'); });
  await assert.rejects(unavailable.searchProducts({ keyword: 'item' }), error => {
    assert.equal(error.code, 'SHOPEE_AFFILIATE_TRANSPORT_FAILED');
    assert.equal(error.message.includes('private transport detail'), false);
    return true;
  });
});

test('masks app credentials from receipts and response errors', async () => {
  const result = await makeClient(async (_url, init) => {
    assert.equal(init.headers.has('cookie'), false);
    return response(graph());
  }).searchProducts({ keyword: 'lip tint' });
  const serialized = JSON.stringify(result.request);
  for (const secret of [appId, appSecret, 'Signature=']) assert.equal(serialized.includes(secret), false);
});
