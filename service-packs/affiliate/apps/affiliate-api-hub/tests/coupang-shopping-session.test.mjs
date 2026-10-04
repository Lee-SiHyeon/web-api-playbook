import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareShoppingSession, headersForShoppingSession, rotateShoppingCookies,
  validateCoupangQuantityInfoRequestUrl } from '../lib/shopping-session-store.mjs';

const requestUrl = 'https://www.coupang.com/np/search?q=%EB%83%89%EB%8F%99%EC%82%BC%EA%B2%B9%EC%82%B4&sorter=LOW_PRICE&_rsc=fixture';
const cookie = (name, value) => ({ name, value, domain: '.coupang.com', path: '/', secure: true, httpOnly: true, expires: -1 });
const input = {
  service: 'coupang-search', origin: 'https://www.coupang.com', requestUrl,
  headers: { cookie: 'ILOGIN=account-fixture; CT_AT=token-fixture', accept: '*/*', rsc: '1', 'next-url': '/srp' },
  cookies: [cookie('ILOGIN', 'account-fixture'), cookie('CT_AT', 'token-fixture')],
};

test('Coupang session keeps account cookies and RSC headers in the observed search scope', () => {
  const session = prepareShoppingSession(input);
  assert.deepEqual(session.cookies.map(c => c.name), ['ILOGIN', 'CT_AT']);
  const headers = headersForShoppingSession(session, requestUrl);
  assert.equal(headers.cookie, input.headers.cookie);
  assert.equal(headers.rsc, '1');
  assert.equal(headers['next-url'], '/srp');
  assert.throws(() => headersForShoppingSession(session, 'https://other.example/np/search'), { code: 'SESSION_ORIGIN_SCOPE' });
  assert.throws(() => headersForShoppingSession(session, 'https://www.coupang.com/vp/products/1'), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...input, requestUrl: 'https://www.coupang.com/vp/products/1' }), { code: 'SESSION_SCOPE' });
});

test('Coupang session rejects bot cookies and ignores their Set-Cookie rotation', () => {
  assert.throws(() => prepareShoppingSession({ ...input,
    headers: { ...input.headers, cookie: input.headers.cookie + '; bm_sv=bot-fixture' },
    cookies: [...input.cookies, cookie('bm_sv', 'bot-fixture')],
  }), { code: 'SESSION_COOKIE_SCOPE' });
  const session = prepareShoppingSession(input);
  assert.equal(rotateShoppingCookies(session, ['bm_sv=bot-new; Path=/; Secure'], requestUrl), false);
  assert.deepEqual(session.cookies.map(c => c.name), ['ILOGIN', 'CT_AT']);
});

const consumerProductUrl = 'https://www.coupang.com/vp/products/6159950381?itemId=11948008563&vendorItemId=3299873959';
const consumerReviewUrl = 'https://www.coupang.com/next-api/review?productId=6159950381&page=1&size=10&sortBy=DATE_DESC&ratingSummary=true&ratings=&market=';
const quantityUrl = 'https://www.coupang.com/next-api/products/quantity-info?productId=6159950381&vendorItemId=3299873959';
const sellersUrl = 'https://www.coupang.com/next-api/products/other-seller-info?productId=6159950381&selectedId=3299873959&itemId=11948008563';
const consumerInput = {
  service: 'coupang-consumer', origin: 'https://www.coupang.com', requestUrl: consumerProductUrl,
  headers: { cookie: 'CT_ATH=consumer-session-fixture; ILOGIN=account-fixture; CT_AT=token-fixture', accept: 'text/html' },
  cookies: [cookie('CT_ATH', 'consumer-session-fixture'), cookie('ILOGIN', 'account-fixture'), cookie('CT_AT', 'token-fixture')],
  inputs: { observedRequests: [
    { operation: 'product_document', url: consumerProductUrl, method: 'GET' },
    { operation: 'review_page', url: consumerReviewUrl, method: 'GET' },
  ] },
};

function jwtWithClaims(claims) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.${Buffer.from('signature-fixture').toString('base64url')}`;
}

function consumerInputWithAccessToken(token) {
  return {
    ...consumerInput,
    headers: { ...consumerInput.headers,
      cookie: `CT_ATH=consumer-session-fixture; ILOGIN=account-fixture; CT_AT=${token}` },
    cookies: consumerInput.cookies.map(row => row.name === 'CT_AT' ? { ...row, value: token } : row),
  };
}

test('consumer session is a separate DPAPI scope bound to exact observed product and review requests', () => {
  const session = prepareShoppingSession(consumerInput);
  assert.equal(session.service, 'coupang-consumer');
  assert.deepEqual(session.inputs.observedRequests, consumerInput.inputs.observedRequests);
  assert.equal(headersForShoppingSession(session, consumerProductUrl).cookie, consumerInput.headers.cookie);
  assert.equal(headersForShoppingSession(session, consumerReviewUrl, consumerProductUrl).cookie, consumerInput.headers.cookie);
  assert.equal(rotateShoppingCookies(session, ['CT_DPOP=rotated-proof-fixture; Path=/; Secure'], consumerReviewUrl), false);
  assert.equal(session.cookies.some(row => row.name === 'CT_DPOP'), false);
  assert.throws(() => headersForShoppingSession(session,
    consumerProductUrl.replace('6159950381', '6159950382')), { code: 'SESSION_SCOPE' });
  assert.throws(() => headersForShoppingSession(session,
    consumerProductUrl.replace('vendorItemId=3299873959', 'vendorItemId=1')), { code: 'SESSION_SCOPE' });
  assert.throws(() => headersForShoppingSession(session,
    consumerReviewUrl.replace('page=1', 'page=2'), consumerProductUrl), { code: 'SESSION_SCOPE' });
  assert.throws(() => headersForShoppingSession(session,
    consumerReviewUrl.replace('www.coupang.com', 'partners.coupang.com'), consumerProductUrl), { code: 'SESSION_ORIGIN_SCOPE' });
});

test('consumer CT_AT with a valid JWT expiry is rejected in memory after exp without exposing claims', () => {
  const now = Date.parse('2026-10-04T03:00:00.000Z');
  const expiredToken = jwtWithClaims({ sub: 'fixture-owner', exp: Math.floor(now / 1000) - 1 });
  const input = consumerInputWithAccessToken(expiredToken);
  assert.throws(() => prepareShoppingSession(input, now), error => {
    assert.equal(error.code, 'SESSION_ACCESS_TOKEN_EXPIRED');
    assert.deepEqual(error.details, {});
    assert.equal(error.message, 'SESSION_ACCESS_TOKEN_EXPIRED');
    const serialized = JSON.stringify({ message: error.message, code: error.code, details: error.details });
    assert.equal(serialized.includes(expiredToken), false);
    assert.equal(serialized.includes('fixture-owner'), false);
    assert.equal(serialized.includes(String(Math.floor(now / 1000) - 1)), false);
    return true;
  });
});

test('future or unknown CT_AT formats retain existing behavior and the preflight is consumer-only', t => {
  const now = Date.parse('2026-10-04T03:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const futureToken = jwtWithClaims({ exp: Math.floor(now / 1000) + 60 });
  assert.equal(prepareShoppingSession(consumerInputWithAccessToken(futureToken), now).service, 'coupang-consumer');
  assert.equal(prepareShoppingSession(consumerInputWithAccessToken('token-fixture'), now).service, 'coupang-consumer');
  assert.equal(prepareShoppingSession(consumerInputWithAccessToken(jwtWithClaims({ sub: 'no-exp' })), now).service,
    'coupang-consumer');
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const header of [{}, { alg: '' }, { alg: null }]) {
    const unknownThreePartToken = `${encode(header)}.${encode({ exp: 1 })}.c2lnbmF0dXJl`;
    const session = prepareShoppingSession(consumerInputWithAccessToken(unknownThreePartToken), now);
    assert.equal(session.service, 'coupang-consumer');
    assert.ok(headersForShoppingSession(session, consumerProductUrl).cookie.includes(unknownThreePartToken));
  }
  assert.equal(prepareShoppingSession({
    ...input,
    headers: { ...input.headers, cookie: `ILOGIN=account-fixture; CT_AT=${jwtWithClaims({ exp: 1 })}` },
    cookies: input.cookies.map(row => row.name === 'CT_AT' ? { ...row, value: jwtWithClaims({ exp: 1 }) } : row),
  }, now).service, 'coupang-search');
});

test('an already prepared in-memory consumer session also fails closed after CT_AT exp', () => {
  const systemNow = Date.now();
  const expiredAfterCapture = jwtWithClaims({ exp: Math.floor(systemNow / 1000) - 1 });
  const session = prepareShoppingSession(consumerInputWithAccessToken(expiredAfterCapture), systemNow - 5_000);
  assert.throws(() => headersForShoppingSession(session, consumerProductUrl), {
    code: 'SESSION_ACCESS_TOKEN_EXPIRED',
  });
  assert.equal(session.cookies.find(row => row.name === 'CT_AT').value, expiredAfterCapture);
});

test('consumer handoff accepts only bounded observed fields and excludes CT_DPOP and search-scope expansion', () => {
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    headers: { ...consumerInput.headers, cookie: `${consumerInput.headers.cookie}; CT_DPOP=bound-proof-fixture` },
    cookies: [...consumerInput.cookies, cookie('CT_DPOP', 'bound-proof-fixture')],
  }), { code: 'SESSION_COOKIE_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    headers: { ...consumerInput.headers, cookie: 'ILOGIN=account-fixture; CT_AT=token-fixture' },
    cookies: consumerInput.cookies.filter(row => row.name !== 'CT_ATH'),
  }), { code: 'SESSION_COOKIE_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    inputs: { observedRequests: [
      ...consumerInput.inputs.observedRequests,
      { operation: 'review_page', url: `${consumerReviewUrl}&traceId=fixture`, method: 'GET' },
    ] },
  }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    inputs: { observedRequests: [{ operation: 'review_page', url: consumerReviewUrl, method: 'POST' }] },
  }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    inputs: { observedRequests: [consumerInput.inputs.observedRequests[0]] },
  }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    inputs: { observedRequests: [
      consumerInput.inputs.observedRequests[0],
      { operation: 'review_page', url: consumerReviewUrl.replace('page=1', 'page=10001'), method: 'GET' },
    ] },
  }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    inputs: { observedRequests: [
      consumerInput.inputs.observedRequests[0],
      { operation: 'review_page', url: consumerReviewUrl.replace('productId=6159950381', 'productId=2'), method: 'GET' },
    ] },
  }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...consumerInput,
    inputs: { ...consumerInput.inputs, cookie: 'must-not-be-persisted' },
  }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...input,
    headers: { ...input.headers, cookie: `${input.headers.cookie}; CT_ATH=consumer-fixture` },
    cookies: [...input.cookies, cookie('CT_ATH', 'consumer-fixture')],
  }), { code: 'SESSION_COOKIE_SCOPE' });
});

test('quantity and seller observations are bound to the selected product, item and vendor', () => {
  const observations = [...consumerInput.inputs.observedRequests,
    { operation: 'quantity_info', url: quantityUrl, method: 'GET' },
    { operation: 'other_sellers', url: sellersUrl, method: 'GET' }];
  const session = prepareShoppingSession({ ...consumerInput, inputs: { observedRequests: observations } });
  assert.ok(headersForShoppingSession(session, quantityUrl, consumerProductUrl).cookie);
  assert.ok(headersForShoppingSession(session, sellersUrl, consumerProductUrl).cookie);
  for (const changed of [quantityUrl.replace('3299873959','1'), quantityUrl + '&quantity=2', sellersUrl.replace('11948008563','1')]) {
    assert.throws(() => prepareShoppingSession({ ...consumerInput, inputs: { observedRequests: [
      ...consumerInput.inputs.observedRequests,
      { operation: changed.includes('quantity-info') ? 'quantity_info' : 'other_sellers', url: changed, method: 'GET' },
    ] } }), { code: 'SESSION_SCOPE' });
  }
});

test('price-only consumer scope stores one exact product and quantity request without review or seller access', () => {
  const observations = [
    consumerInput.inputs.observedRequests[0],
    { operation: 'quantity_info', url: quantityUrl, method: 'GET' },
  ];
  const priceInput = { ...consumerInput, requestUrl: quantityUrl, inputs: { scopeMode: 'price', observedRequests: observations } };
  const session = prepareShoppingSession(priceInput);
  assert.equal(session.service, 'coupang-consumer');
  assert.equal(session.requestPath, '/next-api/products/quantity-info');
  assert.deepEqual(session.inputs, { scopeMode: 'price', observedRequests: observations });
  assert.equal(headersForShoppingSession(session, quantityUrl, consumerProductUrl).cookie, consumerInput.headers.cookie);
  assert.equal(headersForShoppingSession(session, consumerProductUrl).cookie, consumerInput.headers.cookie);
  assert.throws(() => headersForShoppingSession(session, consumerReviewUrl, consumerProductUrl), { code: 'SESSION_SCOPE' });
  assert.throws(() => headersForShoppingSession(session, sellersUrl, consumerProductUrl), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...priceInput, inputs: { scopeMode: 'price', observedRequests: [observations[0]] } }),
    { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...priceInput, inputs: { scopeMode: 'price', observedRequests: [
    observations[0], { ...observations[1], url: quantityUrl.replace('vendorItemId=3299873959', 'vendorItemId=1') },
  ] } }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...priceInput, inputs: { scopeMode: 'price', observedRequests: [
    ...observations, { operation: 'review_page', url: consumerReviewUrl, method: 'GET' },
  ] } }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...priceInput, inputs: { scopeMode: 'price', observedRequests: [
    ...observations, { operation: 'other_sellers', url: sellersUrl, method: 'GET' },
  ] } }), { code: 'SESSION_SCOPE' });
  assert.throws(() => prepareShoppingSession({ ...priceInput, inputs: { scopeMode: 'price', extra: true, observedRequests: observations } }),
    { code: 'SESSION_SCOPE' });
});

test('captured quantity query order is retained while unsupported or mismatched fields fail closed', () => {
  const captured = 'https://www.coupang.com/next-api/products/quantity-info?quantity=1&deliveryToggle=false&landingItemId=11948008560&landingVendorItemId=3299873958&vendorItemId=3299873959&productId=6159950381&landingProductId=6159950381';
  assert.equal(validateCoupangQuantityInfoRequestUrl(captured, {
    productId: '6159950381', vendorItemId: '3299873959',
  }), captured);
  const makeInput = quantity => ({ ...consumerInput, requestUrl: quantity,
    inputs: { scopeMode: 'price', observedRequests: [
      consumerInput.inputs.observedRequests[0],
      { operation: 'quantity_info', url: quantity, method: 'GET' },
    ] },
  });
  const session = prepareShoppingSession(makeInput(captured));
  assert.equal(session.inputs.observedRequests[1].url, captured);
  assert.equal(headersForShoppingSession(session, captured, consumerProductUrl).cookie, consumerInput.headers.cookie);

  const invalid = [
    captured.replace('quantity=1', 'quantity=2'),
    `${captured}&quantity=1`,
    `${captured}&traceId=not-observed`,
    captured.replace('deliveryToggle=false', 'deliveryToggle=0'),
    captured.replace('landingItemId=11948008560&', ''),
    captured.replace('landingProductId=6159950381', 'landingProductId=1'),
    captured.replace('vendorItemId=3299873959&productId', 'vendorItemId=1&productId'),
    captured.replace('productId=6159950381', 'productId=%36%31%35%39%39%35%30%33%38%31'),
    captured.replace('www.coupang.com', 'm.coupang.com'),
  ];
  for (const candidate of invalid) assert.throws(() => prepareShoppingSession(makeInput(candidate)), { code: /SESSION_(?:SCOPE|ORIGIN_SCOPE)/ });
});
