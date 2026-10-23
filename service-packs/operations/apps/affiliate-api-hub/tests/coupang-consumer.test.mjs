import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coupangConsumerProductUrl, coupangConsumerReviewRequest, parseCoupangConsumerProduct,
  parseCoupangConsumerReviews, readCoupangConsumerProduct, readCoupangConsumerReviews, readCoupangConsumerProfile,
  readCoupangConsumerOffer, readCoupangConsumerOfferList, readCoupangConsumerSellers,
} from '../adapters/coupang-consumer.mjs';
import { prepareShoppingSession } from '../lib/shopping-session-store.mjs';

// Synthetic payloads use the observed keys. No browser session or raw review data.
const url = 'https://www.coupang.com/vp/products/6159950381?itemId=11948008563&vendorItemId=3299873959';
const quantityUrl = 'https://www.coupang.com/next-api/products/quantity-info?productId=6159950381&vendorItemId=3299873959';
const html = overrides => `<script type="application/ld+json">${JSON.stringify({
  '@type': 'Product', sku: '6159950381-11948008563', name: 'Fixture mouse', brand: { name: 'Fixture brand' },
  offers: { price: '25570', priceCurrency: 'KRW', url, availability: 'https://schema.org/InStock',
    shippingDetails: { shippingRate: { value: '0', currency: 'KRW' } } },
  aggregateRating: { ratingValue: 4.8, ratingCount: '25722' }, ...overrides,
})}</script>`;
const payload = () => ({ rCode: 'RET0000', rCookies: 'private-sentinel', rData: {
  isLogin: true, memberId: 'private-sentinel',
  ratingSummaryTotal: { ratingCount: 25722, ratingAverage: 5, ratingSummaries: [{ rating: 5, count: 22500, percentage: 88 }] },
  reviewTotalCount: 25722,
  paging: { page: 1, currentPage: 1, sizePerPage: 10, totalCount: 25724, totalPage: 2573, isNext: true, contents: [{
    reviewId: 123456789, productId: 6159950381, itemId: 11948008563, vendorItemId: 3299873959,
    rating: 5, reviewAt: Date.parse('2026-09-27T00:00:00Z'), helpfulCount: 0, commentCount: 1,
    content: 'private-sentinel', title: 'private-sentinel', member: { name: 'private-sentinel', email: 'private-sentinel' },
    displayName: 'private-sentinel', itemName: 'Fixture mouse, black', attachments: [], videoAttachments: [],
  }] },
} });

const protectedSession = () => {
  const requestUrl = coupangConsumerReviewRequest({ url }).target;
  return prepareShoppingSession({ service: 'coupang-consumer', origin: 'https://www.coupang.com', requestUrl,
    headers: { accept: 'application/json, text/plain, */*', cookie: 'ILOGIN=private-sentinel; CT_AT=private-sentinel; CT_ATH=private-sentinel' },
    cookies: ['ILOGIN', 'CT_AT', 'CT_ATH'].map(name => ({ name, value: 'private-sentinel', domain: '.coupang.com', path: '/', secure: true, expires: -1 })),
    inputs: { observedRequests: [
      { operation: 'product_document', method: 'GET', url },
      { operation: 'review_page', method: 'GET', url: requestUrl },
      { operation: 'quantity_info', method: 'GET', url: quantityUrl },
      { operation: 'other_sellers', method: 'GET', url: 'https://www.coupang.com/next-api/products/other-seller-info?productId=6159950381&selectedId=3299873959&itemId=11948008563' },
    ] },
  });
};

const protectedPriceSession = (capturedQuantityUrl = quantityUrl) => prepareShoppingSession({ service: 'coupang-consumer', origin: 'https://www.coupang.com', requestUrl: capturedQuantityUrl,
  headers: { accept: 'application/json, text/plain, */*', cookie: 'ILOGIN=private-sentinel; CT_AT=private-sentinel; CT_ATH=private-sentinel' },
  cookies: ['ILOGIN', 'CT_AT', 'CT_ATH'].map(name => ({ name, value: 'private-sentinel', domain: '.coupang.com', path: '/', secure: true, expires: -1 })),
  inputs: { scopeMode: 'price', observedRequests: [
    { operation: 'product_document', method: 'GET', url },
    { operation: 'quantity_info', method: 'GET', url: capturedQuantityUrl },
  ] },
});

const quantityPayload = [{ quantity: 1, priceUnit: '원', price: {
  salePrice: '25,570', couponPrice: '25,570', finalPrice: '25,570', originPrice: null,
  i18nSalePrice: { amount: '25570', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  i18nCouponPrice: { amount: '25570', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
}, shippingFee: { shippingFeeType: 'FREE', shippingFee: '0', originalShippingFee: '2,500원' } }];
const sellersPayload = { title: 'Other sellers', totalCount: 1, items: [{ vendorItemId: 3299873959,
  price: '25,570', selected: true, vendorName: 'Fixture seller', sellerStoreRating: null,
  i18nPrice: { amount: '25570', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
}] };
const offerListPayload = () => ({ data: { status: 200, vendorItems: [{
  productId: 6159950381, itemId: 11948008563, vendorItemId: 3299873959, selected: true,
  hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: true,
  vendorItemSaleInfo: { itemId: 11948008563, vendorItemId: 3299873959, salePrice: 25570,
    i18nSalePrice: { amount: '25570', rawAmount: 25570, fractionDigits: 0, currency: 'KRW' } },
}] } });

test('product JSON profile uses only the two verified reads and preserves title and stock uncertainty', async () => {
  const paths = [];
  const result = await readCoupangConsumerProfile({ url, session: protectedSession(), fetchImpl: async (target, options) => {
    const path = new URL(target).pathname; paths.push(path); assert.ok(options.headers.cookie);
    const body = path === '/next-api/review' ? payload() : path.endsWith('quantity-info') ? quantityPayload : sellersPayload;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(paths, ['/next-api/review', '/next-api/products/other-seller-info']);
  assert.equal(result.offer.price.amount, 25570);
  assert.equal(result.product.title, null);
  assert.equal(result.product.reviewedOptionLabel, 'Fixture mouse, black');
  assert.equal(result.product.availability, null);
  assert.equal(result.reviews.count, 1);
  assert.equal(result.sellers.count, 1);
  assert.equal(result.states.live_replay, false);
  assert.equal(result.receipt.requestCount, 2);
  assert.equal(JSON.stringify(result).includes('private-sentinel'), false);
});

test('price-only protected session reaches the exact quantity reader and rejects uncaptured review access', async () => {
  const session = protectedPriceSession();
  const calls = [];
  const result = await readCoupangConsumerOffer({ url, session, fetchImpl: async (target, options) => {
    calls.push(new URL(target).href);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.referer, url);
    assert.ok(options.headers.cookie.includes('CT_ATH=private-sentinel'));
    return new Response(JSON.stringify(quantityPayload), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(calls, [quantityUrl]);
  assert.equal(result.offer.price.amount, 25570);
  assert.equal(result.receipt.credentialSent, true);
  assert.equal(result.receipt.credentialPropagated, true);
  assert.equal(result.receipt.authenticatedOwnerVerified, false);
  assert.equal(result.receipt.sessionProvider, 'in_memory');

  calls.length = 0;
  await assert.rejects(readCoupangConsumerReviews({ url, session, fetchImpl: async target => {
    calls.push(new URL(target).href);
    return new Response(JSON.stringify(payload()), { headers: { 'content-type': 'application/json' } });
  } }), { code: 'SESSION_SCOPE' });
  assert.deepEqual(calls, []);
});

test('protected quantity read uses the exact validated captured query and rejects SKU drift before fetch', async () => {
  const captured = 'https://www.coupang.com/next-api/products/quantity-info?quantity=1&deliveryToggle=false&landingItemId=11948008560&landingVendorItemId=3299873958&vendorItemId=3299873959&productId=6159950381&landingProductId=6159950381';
  const calls = [];
  const result = await readCoupangConsumerOffer({ url, session: protectedPriceSession(captured), fetchImpl: async (target, options) => {
    calls.push(target);
    assert.equal(target, captured);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.referer, url);
    return new Response(JSON.stringify(quantityPayload), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(calls, [captured]);
  assert.equal(result.offer.quantity, 1);
  assert.equal(result.receipt.path, '/next-api/products/quantity-info');
  assert.equal(result.receipt.query.quantity, '1');
  assert.equal(result.receipt.query.deliveryToggle, 'false');

  const mismatched = protectedPriceSession(captured);
  mismatched.inputs.observedRequests[1].url = captured.replace('vendorItemId=3299873959', 'vendorItemId=1');
  calls.length = 0;
  await assert.rejects(readCoupangConsumerOffer({ url, session: mismatched, fetchImpl: async target => {
    calls.push(target);
    return new Response(JSON.stringify(quantityPayload), { headers: { 'content-type': 'application/json' } });
  } }), { code: 'COUPANG_CONSUMER_SESSION_SCOPE' });
  assert.deepEqual(calls, []);
});

test('protected quantity selection isolates the current SKU and rejects ambiguous captures before fetch', async () => {
  const otherProductUrl = 'https://www.coupang.com/vp/products/7000000000?itemId=7000000001&vendorItemId=7000000002';
  const otherQuantityUrl = 'https://www.coupang.com/next-api/products/quantity-info?productId=7000000000&vendorItemId=7000000002&quantity=1';
  const session = protectedSession();
  session.inputs.observedRequests.push(
    { operation: 'product_document', method: 'GET', url: otherProductUrl },
    { operation: 'quantity_info', method: 'GET', url: otherQuantityUrl },
  );
  const calls = [];
  await readCoupangConsumerOffer({ url, session, fetchImpl: async target => {
    calls.push(target);
    return new Response(JSON.stringify(quantityPayload), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(calls, [quantityUrl]);

  const ambiguous = protectedSession();
  ambiguous.inputs.observedRequests.push({ operation: 'quantity_info', method: 'GET', url: `${quantityUrl}&quantity=1` });
  calls.length = 0;
  await assert.rejects(readCoupangConsumerOffer({ url, session: ambiguous, fetchImpl: async target => {
    calls.push(target);
    return new Response(JSON.stringify(quantityPayload), { headers: { 'content-type': 'application/json' } });
  } }), { code: 'COUPANG_CONSUMER_SESSION_SCOPE' });
  assert.deepEqual(calls, []);
});

test('profile preserves successful reviews when sellers fail and never calls blocked paths', async () => {
  let calls = 0;
  const result = await readCoupangConsumerProfile({ url, session: protectedSession(), fetchImpl: async target => {
    calls++;
    assert.notEqual(new URL(target).pathname, '/next-api/products/quantity-info');
    return calls === 1 ? new Response(JSON.stringify(payload()), { headers: { 'content-type': 'application/json' } })
      : new Response('Forbidden', { status: 403 });
  } });
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.code, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
  assert.equal(result.reviews.count, 1);
  assert.equal(result.receipts[1].status, 403);
  assert.equal(result.states.live_replay, false);
  assert.equal(calls, 2);
});

test('consumer URLs are exact-origin product reads; observed tracking is dropped', () => {
  assert.equal(coupangConsumerProductUrl(`${url}&searchId=private-sentinel&traceId=private-sentinel#sdpReview`).url, url);
  for (const input of [url.replace('www.coupang.com', 'partners.coupang.com'), url.replace('www.coupang.com', 'www.coupang.com.evil.test'),
    url.replace('https:', 'http:'), `${url}&token=private-sentinel`, `${url}&itemId=1`, url.replace('/vp/products/', '/account/')])
    assert.throws(() => coupangConsumerProductUrl(input), { code: 'COUPANG_CONSUMER_URL_SCOPE' });
});

test('review input keeps the two observed sort values and fixed page size', () => {
  const target = new URL(coupangConsumerReviewRequest({ url, page: 2, sort: 'ORDER_SCORE_ASC' }).target);
  assert.equal(target.pathname, '/next-api/review');
  assert.equal(target.searchParams.get('sortBy'), 'ORDER_SCORE_ASC');
  assert.equal(target.searchParams.get('size'), '10');
  assert.equal(target.searchParams.get('page'), '2');
  assert.throws(() => coupangConsumerReviewRequest({ url, page: 0 }), { code: 'COUPANG_CONSUMER_REVIEW_INPUT' });
  assert.throws(() => coupangConsumerReviewRequest({ url, sort: 'guessed' }), { code: 'COUPANG_CONSUMER_REVIEW_INPUT' });
});

test('product identity matches SKU and selected offer; counts keep their meanings', () => {
  const result = parseCoupangConsumerProduct(html(), { url });
  assert.equal(result.price.amount, 25570);
  assert.equal(result.price.shippingAmount, 0);
  assert.equal(result.rating.value, 4.8);
  assert.equal(result.rating.ratingCount, 25722);
  assert.equal(result.rating.reviewCount, null);
  assert.equal(result.rating.bestRating, null);
  assert.throws(() => parseCoupangConsumerProduct(html({ sku: '999-11948008563' }), { url }), { code: 'COUPANG_CONSUMER_PRODUCT_IDENTITY' });
  assert.throws(() => parseCoupangConsumerProduct(html({ offers: { url: url.replace('3299873959', '999') } }), { url }), { code: 'COUPANG_CONSUMER_PRODUCT_IDENTITY' });
});

test('missing product price cannot be coerced into a free product', () => {
  assert.throws(() => parseCoupangConsumerProduct(html({ offers: { url, price: null, priceCurrency: 'KRW' } }), { url }),
    { code: 'COUPANG_CONSUMER_PRODUCT_SCHEMA' });
});

test('review metadata excludes reviewer identity, raw text and response credentials', () => {
  const result = parseCoupangConsumerReviews(payload(), { url });
  assert.equal(result.paging.totalCount, 25724);
  assert.equal(result.aggregate.ratingCount, 25722);
  assert.equal(result.aggregate.ratingAverage, 5);
  assert.equal(result.reviews[0].bodyAvailable, true);
  assert.equal(result.reviews[0].body, null);
  assert.equal(result.reviews[0].helpfulCount, 0);
  assert.equal(result.reviews[0].hasMedia, false);
  assert.equal(result.reviews[0].reviewedAt, '2026-09-27T00:00:00.000Z');
  assert.equal(JSON.stringify(result).includes('private-sentinel'), false);
  assert.equal(JSON.stringify(result).includes('123456789'), false);
});

test('review application errors, wrong product and stale page are rejected', () => {
  assert.throws(() => parseCoupangConsumerReviews({ ...payload(), rCode: 'LOGIN' }, { url }), { code: 'COUPANG_CONSUMER_REVIEW_APPLICATION' });
  const wrong = payload(); wrong.rData.paging.contents[0].productId = 1;
  assert.throws(() => parseCoupangConsumerReviews(wrong, { url }), { code: 'COUPANG_CONSUMER_REVIEW_IDENTITY' });
  assert.throws(() => parseCoupangConsumerReviews(payload(), { url, page: 2 }), { code: 'COUPANG_CONSUMER_REVIEW_SCHEMA' });
});

test('named JSON read omits credentials and does not claim fixture replay as live', async () => {
  let calls = 0;
  const result = await readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async (target, options) => {
    calls++;
    assert.equal(new URL(target).pathname, '/next-api/review');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers['user-agent'], undefined);
    assert.equal(options.headers.referer, url);
    return new Response(JSON.stringify(payload()), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.states.live_replay, false);
  assert.equal(result.receipt.credentialPropagated, false);
});

test('ordinary Coupang locale header is scoped only to the public offer-list operation', async () => {
  const seen = [];
  const fetchImpl = async (target, options) => {
    const path = new URL(target).pathname;
    seen.push({ path, headers: options.headers });
    const body = path === '/next-api/review' ? payload()
      : path.endsWith('/other-seller-info') ? sellersPayload : offerListPayload();
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  await readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl });
  await readCoupangConsumerSellers({ url, authentication: 'anonymous', fetchImpl });
  await readCoupangConsumerOfferList({ url, authentication: 'anonymous', fetchImpl });

  assert.deepEqual(seen.map(item => item.path), [
    '/next-api/review', '/next-api/products/other-seller-info', '/next-api/offer-list',
  ]);
  assert.equal(seen[0].headers['x-coupang-accept-language'], undefined);
  assert.equal(seen[1].headers['x-coupang-accept-language'], undefined);
  assert.equal(seen[2].headers['x-coupang-accept-language'], 'ko-KR');
  for (const request of seen) {
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['user-agent'], undefined);
  }
});

test('403 permission classification recognizes observed Korean permission-denied wording without storing body text', async () => {
  for (const phrase of ['사용권한이 없습니다', '사용권한이 제한된 페이지']) {
    await assert.rejects(readCoupangConsumerOfferList({ url, authentication: 'anonymous', fetchImpl: async () =>
      new Response(`<html><body>${phrase}</body></html>`, {
        status: 403, headers: { 'content-type': 'text/html', server: 'envoy' },
      }) }), error => {
      assert.equal(error.code, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
      assert.equal(error.receipt.status, 403);
      assert.equal(error.receipt.denialSignals.permissionDenied, true);
      assert.equal(error.receipt.bodyComplete, true);
      assert.equal(JSON.stringify(error.receipt).includes(phrase), false);
      return true;
    });
  }
});

test('403 receipt records only bounded response cookie counts and numeric Retry-After metadata', async () => {
  let calls = 0;
  const headers = new Headers({ 'content-type': 'text/html', server: 'AkamaiGHost', 'retry-after': '37' });
  headers.append('set-cookie', 'PCID=COOKIE_VALUE_SENTINEL_A; Path=/; Secure');
  headers.append('set-cookie', 'x-coupang-target-market=COOKIE_VALUE_SENTINEL_B; Path=/; Secure');
  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () => {
    calls++;
    return new Response('<html><body>BODY_SENTINEL</body></html>', { status: 403, headers });
  } }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
    assert.equal(error.receipt.status, 403);
    assert.equal(error.receipt.responseCookieHeadersAvailable, true);
    assert.equal(error.receipt.responseCookieCount, 2);
    assert.equal(error.receipt.retryAfterSeconds, 37);
    assert.ok(Number.isSafeInteger(error.receipt.durationMs));
    assert.ok(error.receipt.durationMs >= 0 && error.receipt.durationMs <= 120_000);
    assert.equal(error.receipt.cookieRotationApplied, false);
    const serialized = JSON.stringify(error.receipt);
    for (const secret of ['PCID', 'x-coupang-target-market', 'COOKIE_VALUE_SENTINEL', 'BODY_SENTINEL', 'retry-after', 'set-cookie'])
      assert.equal(serialized.includes(secret), false, secret);
    return true;
  });
  assert.equal(calls, 1);
});

test('Retry-After HTTP dates become bounded seconds and out-of-range values remain null', async () => {
  const retryDate = new Date(Date.now() + 300_000).toUTCString();
  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () =>
    new Response('<html>blocked</html>', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': retryDate } })
  }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_RATE_LIMITED');
    assert.ok(error.receipt.retryAfterSeconds >= 295 && error.receipt.retryAfterSeconds <= 300);
    assert.equal(error.receipt.responseCookieHeadersAvailable, false);
    assert.equal(error.receipt.responseCookieCount, 0);
    return true;
  });

  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () =>
    new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html', 'retry-after': '3601' } })
  }), error => {
    assert.equal(error.receipt.retryAfterSeconds, null);
    return true;
  });
});

test('403 receipt records the failure body and stops after one request', async () => {
  let calls = 0;
  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () => {
    calls++;
    return new Response('<html><title>Access Denied</title><body>private-sentinel</body></html>',
      { status: 403, headers: { 'content-type': 'text/html', server: 'AkamaiGHost' } });
  } }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
    assert.equal(error.receipt.status, 403);
    assert.equal(error.receipt.server, 'AkamaiGHost');
    assert.equal(error.receipt.challengeConfirmed, true);
    assert.equal(error.receipt.bodyComplete, true);
    assert.ok(error.receipt.bytes > 0);
    assert.equal(JSON.stringify(error.receipt).includes('private-sentinel'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('200 challenge HTML and wrong JSON MIME do not produce reviews', async () => {
  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () =>
    new Response('<html><title>Access Denied</title></html>', { headers: { 'content-type': 'text/html' } }) }),
  { code: 'COUPANG_CONSUMER_CHALLENGE' });
  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () =>
    new Response(JSON.stringify(payload()), { headers: { 'content-type': 'text/plain' } }) }),
  { code: 'COUPANG_CONSUMER_CONTENT_TYPE' });
});

test('large 403 and interrupted 429 bodies retain the known status classification', async () => {
  let calls = 0;
  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () => {
    calls++;
    return new Response('x'.repeat(65537), { status: 403, headers: { 'content-type': 'text/html' } });
  } }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
    assert.equal(error.receipt.status, 403);
    assert.equal(error.receipt.bodyComplete, false);
    assert.equal(error.receipt.bodyError, 'response_size');
    assert.equal(error.receipt.responseSha256, null);
    assert.ok(error.receipt.bytes > 65536);
    return true;
  });
  await assert.rejects(readCoupangConsumerReviews({ url, authentication: 'anonymous', fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private-sentinel')); } }),
      { status: 429, headers: { 'content-type': 'text/html' } });
  } }), error => error.code === 'COUPANG_CONSUMER_RATE_LIMITED' && error.receipt.status === 429 && !error.receipt.bodyComplete);
  assert.equal(calls, 2);
});

test('redirects are never followed; product parser cannot consume an unrelated document', async () => {
  let calls = 0;
  await assert.rejects(readCoupangConsumerProduct({ url, authentication: 'anonymous', fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
  } }), { code: 'COUPANG_CONSUMER_REDIRECT' });
  assert.equal(calls, 1);
  await assert.rejects(readCoupangConsumerProduct({ url, authentication: 'anonymous', fetchImpl: async () =>
    new Response(html({ sku: '1-2' }), { headers: { 'content-type': 'text/html' } }) }),
  { code: 'COUPANG_CONSUMER_PRODUCT_IDENTITY' });
});

test('protected credentials reach the actual request without leaking into output', async () => {
  let calls = 0;
  const result = await readCoupangConsumerReviews({ url, session: protectedSession(), fetchImpl: async (target, options) => {
    calls++;
    assert.equal(options.headers.cookie, 'ILOGIN=private-sentinel; CT_AT=private-sentinel; CT_ATH=private-sentinel');
    assert.equal(options.headers.accept, 'application/json, text/plain, */*');
    assert.equal(options.headers['user-agent'], undefined);
    assert.equal(options.headers['sec-ch-ua'], undefined);
    return new Response(JSON.stringify(payload()), { headers: { 'content-type': 'application/json',
      'set-cookie': 'CT_AT=rotated-sentinel; Domain=coupang.com; Path=/; Secure; HttpOnly' } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.receipt.authenticationMode, 'protected');
  assert.equal(result.receipt.credentialPropagated, true);
  assert.equal(result.receipt.applicationAuthenticated, true);
  assert.equal(result.receipt.responseCookieHeadersAvailable, true);
  assert.equal(result.receipt.responseCookieCount, 1);
  assert.equal(result.receipt.retryAfterSeconds, null);
  assert.ok(Number.isSafeInteger(result.receipt.durationMs));
  assert.equal(result.receipt.cookieRotationApplied, true);
  assert.equal(result.receipt.cookieRotationPersisted, false);
  assert.equal(result.states.credential_propagated, true);
  assert.equal(result.states.live_replay, false);
  assert.equal(/private-sentinel|rotated-sentinel|CT_AT/.test(JSON.stringify(result)), false);
});

test('expired account access-token hint stops the exact quantity request before HTTP and leaks no token', async () => {
  const session = protectedPriceSession();
  const segment = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const expiredToken = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({ exp: 1, fixture: 'expiry-private-sentinel' })}.c2lnbmF0dXJl`;
  session.cookies.find(row => row.name === 'CT_AT').value = expiredToken;
  let calls = 0;
  await assert.rejects(readCoupangConsumerOffer({ url, session, fetchImpl: async () => {
    calls++;
    throw new Error('HTTP must not run');
  } }), error => {
    assert.equal(error.code, 'SESSION_ACCESS_TOKEN_EXPIRED');
    assert.equal(error.receipt.status, null);
    assert.equal(error.receipt.credentialSent, false);
    assert.equal(error.receipt.credentialPropagated, false);
    assert.equal(error.receipt.authenticatedOwnerVerified, false);
    const serialized = JSON.stringify(error.receipt);
    assert.equal(serialized.includes(expiredToken), false);
    assert.equal(serialized.includes('expiry-private-sentinel'), false);
    return true;
  });
  assert.equal(calls, 0);
});

test('protected product schema must pass before response cookies rotate', async () => {
  const session = protectedSession();
  await assert.rejects(readCoupangConsumerProduct({ url, session, fetchImpl: async () =>
    new Response(html({ sku: 'wrong-product' }), { headers: { 'content-type': 'text/html',
      'set-cookie': 'CT_AT=rotated-sentinel; Domain=coupang.com; Path=/; Secure; HttpOnly' } }) }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_PRODUCT_IDENTITY');
    assert.equal(error.receipt.cookieRotationApplied, false);
    assert.equal(session.cookies.find(cookie => cookie.name === 'CT_AT').value, 'private-sentinel');
    return true;
  });
});

test('protected 403 records credential propagation and never falls back to anonymous', async () => {
  let calls = 0;
  await assert.rejects(readCoupangConsumerReviews({ url, session: protectedSession(), fetchImpl: async (target, options) => {
    calls++; assert.ok(options.headers.cookie);
    return new Response('<html><title>Blocked</title><body>Request blocked</body></html>', { status: 403, headers: { 'content-type': 'text/html' } });
  } }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
    assert.equal(error.receipt.credentialPropagated, true);
    assert.equal(error.receipt.denialSignals.requestBlocked, true);
    assert.equal(error.receipt.browserAuthEquivalent, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('transport failure records credentials as configured but not propagated', async () => {
  await assert.rejects(readCoupangConsumerReviews({ url, session: protectedSession(), fetchImpl: async () => {
    throw new Error('private-sentinel');
  } }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_TRANSPORT');
    assert.equal(error.receipt.credentialSent, true);
    assert.equal(error.receipt.credentialPropagated, false);
    assert.equal(JSON.stringify(error.receipt).includes('private-sentinel'), false);
    return true;
  });
});

test('a DPoP 401 does not invalidate an account session or rotate its cookies', async () => {
  const session = protectedSession();
  let calls = 0;
  await assert.rejects(readCoupangConsumerReviews({ url, session, fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 401, headers: { 'www-authenticate': 'DPoP error="invalid_iat"',
      'set-cookie': 'CT_AT=rotated-sentinel; Domain=coupang.com; Path=/; Secure' } });
  } }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_DPOP_REQUIRED');
    assert.equal(error.receipt.dpopChallengePresent, true);
    assert.equal(error.receipt.cookieRotationApplied, false);
    assert.equal(JSON.stringify(error.receipt).includes('rotated-sentinel'), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(session.invalidatedAt, undefined);
  assert.equal(session.cookies.find(cookie => cookie.name === 'CT_AT').value, 'private-sentinel');
});

test('protected session scope failures happen before HTTP and 200 logged-out JSON is rejected', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify(payload()), { headers: { 'content-type': 'application/json' } }); };
  const wrong = protectedSession(); wrong.service = 'coupang-search';
  await assert.rejects(readCoupangConsumerReviews({ url, session: wrong, fetchImpl }), { code: 'COUPANG_CONSUMER_SESSION_SCOPE' });
  assert.equal(calls, 0);
  const loggedOut = payload(); loggedOut.rData.isLogin = false;
  const rejectedSession = protectedSession();
  await assert.rejects(readCoupangConsumerReviews({ url, session: rejectedSession, fetchImpl: async () =>
    new Response(JSON.stringify(loggedOut), { headers: { 'content-type': 'application/json',
      'set-cookie': 'CT_AT=rotated-sentinel; Domain=coupang.com; Path=/; Secure; HttpOnly' } }) }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_REAUTH_REQUIRED');
    assert.equal(error.receipt.applicationAuthenticated, false);
    assert.equal(error.receipt.cookieRotationApplied, false);
    assert.equal(error.receipt.cookieRotationPersisted, false);
    assert.equal(rejectedSession.invalidatedAt !== undefined, true);
    assert.equal(rejectedSession.cookies.find(cookie => cookie.name === 'CT_AT').value, 'private-sentinel');
    assert.equal(JSON.stringify(error.receipt).includes('rotated-sentinel'), false);
    return true;
  });
  const invalid = payload(); invalid.rCode = 'LOGIN'; invalid.rData.isLogin = true;
  const schemaRejectedSession = protectedSession();
  await assert.rejects(readCoupangConsumerReviews({ url, session: schemaRejectedSession, fetchImpl: async () =>
    new Response(JSON.stringify(invalid), { headers: { 'content-type': 'application/json',
      'set-cookie': 'CT_AT=rotated-sentinel; Domain=coupang.com; Path=/; Secure; HttpOnly' } }) }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_REVIEW_APPLICATION');
    assert.equal(error.receipt.cookieRotationApplied, false);
    assert.equal(schemaRejectedSession.cookies.find(cookie => cookie.name === 'CT_AT').value, 'private-sentinel');
    return true;
  });
  for (const malformed of [null, { rCode: 'RET0000', rData: { ...payload().rData, isLogin: undefined } }]) {
    const unverifiedSession = protectedSession();
    await assert.rejects(readCoupangConsumerReviews({ url, session: unverifiedSession, fetchImpl: async () =>
      new Response(JSON.stringify(malformed), { headers: { 'content-type': 'application/json',
        'set-cookie': 'CT_AT=rotated-sentinel; Domain=coupang.com; Path=/; Secure; HttpOnly' } }) }), error => {
      assert.equal(error.code, 'COUPANG_CONSUMER_REVIEW_AUTH_UNVERIFIED');
      assert.equal(error.receipt.applicationAuthenticated, null);
      assert.equal(error.receipt.cookieRotationApplied, false);
      assert.equal(unverifiedSession.invalidatedAt, undefined);
      assert.equal(unverifiedSession.cookies.find(cookie => cookie.name === 'CT_AT').value, 'private-sentinel');
      return true;
    });
  }
});
