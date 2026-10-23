import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCoupangVisitorContext, prepareCoupangVisitorRead, revisitCoupangVisitorBootstrap, rotateCoupangVisitorCookies,
} from '../lib/coupang-visitor-context.mjs';
import {
  readCoupangConsumerSellers, readCoupangConsumerReviews, readCoupangConsumerProduct, readCoupangConsumerProfile,
  readCoupangConsumerOfferList,
} from '../adapters/coupang-consumer.mjs';

const url = 'https://www.coupang.com/vp/products/8174473713?itemId=26504519093&vendorItemId=91458195016';
const target = 'https://www.coupang.com/next-api/products/other-seller-info?productId=8174473713&selectedId=91458195016&itemId=26504519093';
const offerListTarget = 'https://www.coupang.com/next-api/offer-list?productId=8174473713&itemId=26504519093&selectedVendorItemId=91458195016';
const bridge = '<html><script>/* web-adapter-proxy getLocalStorage */</script></html>';
const visitorSentinel = 'visitor-private-sentinel';
const rejectedSentinel = 'rejected-private-sentinel';
const bootstrapResponse = (cookies = [`PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`], body = bridge) => {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  for (const line of cookies) headers.append('set-cookie', line);
  return new Response(body, { headers });
};
const sellers = { title: 'Fixture product', totalCount: 1, items: [{ vendorItemId: 91458195016,
  selected: true, vendorName: 'Fixture seller', price: '19,480', sellerStoreRating: null,
  i18nPrice: { amount: '19480', rawAmount: null, fractionDigits: 0, currency: 'KRW' } }] };
const offerList = { data: { status: 200, title: 'DO_NOT_EXPORT', offerConditions: ['DO_NOT_EXPORT'],
  ab24540IsB: false, ab24540Value: 'DO_NOT_EXPORT', vendorItems: [{
    productId: 8174473713, itemId: 26504519093, vendorItemId: 91458195016, selected: true,
    vendorId: 'DO_NOT_EXPORT', vendorName: 'DO_NOT_EXPORT', imageUrls: ['DO_NOT_EXPORT'],
    hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: true,
    vendorItemSaleInfo: { itemId: 26504519093, vendorItemId: 91458195016, salePrice: 19480,
      i18nSalePrice: { amount: '19480', rawAmount: 19480, fractionDigits: 0, currency: 'KRW' },
      originPrice: 25980, couponPrice: 'DO_NOT_EXPORT', couponDownloadUrl: 'DO_NOT_EXPORT' },
  }] } };

test('visitor bootstrap accepts only fresh HTTP visitor cookies and keeps values out of receipts', async () => {
  const calls = [];
  const fetchImpl = async (request, options) => {
    calls.push(request);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['user-agent'], undefined);
    if (request.endsWith('/web-adapter/proxy')) {
      assert.equal(options.headers.cookie, undefined);
      return bootstrapResponse([
        `PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure`,
        'x-coupang-target-market=KR; Domain=.coupang.com; Path=/',
        'x-coupang-accept-language=ko-KR; Domain=.coupang.com; Path=/',
        `ILOGIN=${rejectedSentinel}; Domain=.coupang.com; Path=/`,
        `CT_AT=${rejectedSentinel}; Domain=.coupang.com; Path=/`,
        `CT_DPOP=${rejectedSentinel}; Domain=.coupang.com; Path=/`,
        `ak_bmsc=${rejectedSentinel}; Domain=.coupang.com; Path=/`,
        `bm_sz=${rejectedSentinel}; Domain=.coupang.com; Path=/`,
      ]);
    }
    assert.equal(request, target);
    assert.ok(options.headers.cookie.includes(`PCID=${visitorSentinel}`));
    assert.equal(options.headers.cookie.includes(rejectedSentinel), false);
    assert.equal(options.headers.referer, url);
    return new Response(JSON.stringify(sellers), { headers: { 'content-type': 'application/json' } });
  };
  const result = await readCoupangConsumerSellers({ url, authentication: 'visitor', fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.offers[0].price.amount, 19480);
  assert.equal(result.receipt.authenticationMode, 'visitor');
  assert.equal(result.receipt.ownerCredentialUsed, false);
  assert.equal(result.receipt.credentialPropagated, false);
  assert.equal(result.receipt.visitorCookiesSent, true);
  assert.equal(result.receipt.visitorValuesPersisted, false);
  assert.equal(result.receipt.visitorBootstrap.transport, 'injected');
  assert.equal(result.receipt.visitorBootstrap.challengeConfirmed, false);
  assert.equal(result.states.live_replay, false);
  assert.equal(JSON.stringify(result).includes(visitorSentinel), false);
  assert.equal(JSON.stringify(result).includes(rejectedSentinel), false);
});

test('strong challenge on the initial 200 bootstrap stops a public price read before target request or cookie application', async () => {
  const calls = [];
  const challengeBodySentinel = 'INITIAL_BOOTSTRAP_CHALLENGE_BODY_CANARY';
  const fetchImpl = async (request, options) => {
    calls.push({ request, options });
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge' });
    headers.append('set-cookie', `PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`);
    return new Response(`${bridge}<title>${challengeBodySentinel}</title>`, { status: 200, headers });
  };

  await assert.rejects(readCoupangConsumerOfferList({ url, authentication: 'visitor', fetchImpl }), error => {
    assert.equal(error.code, 'COUPANG_VISITOR_CHALLENGE');
    assert.equal(error.receipt.visitorBootstrap.status, 200);
    assert.equal(error.receipt.visitorBootstrap.challengeConfirmed, true);
    const serialized = JSON.stringify(error.receipt);
    assert.equal(serialized.includes(visitorSentinel), false);
    assert.equal(serialized.includes(challengeBodySentinel), false);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request, 'https://www.coupang.com/n-api/web-adapter/proxy');
  assert.equal(calls[0].options.headers.cookie, undefined);
});

test('local memory expiry bootstraps on the next read without retrying the prior read', async () => {
  let now = 1000000, calls = 0;
  const fetchImpl = async () => { calls++; return bootstrapResponse(); };
  const context = createCoupangVisitorContext({ fetchImpl, now: () => now });
  const options = { context, target, operation: 'other_sellers', fetchImpl };
  const first = await prepareCoupangVisitorRead(options);
  assert.equal(first.bootstrapReceipt.status, 200);
  assert.equal(JSON.stringify(context).includes(visitorSentinel), false);
  now += 299999;
  assert.equal((await prepareCoupangVisitorRead(options)).bootstrapReceipt, null);
  now += 1;
  assert.equal((await prepareCoupangVisitorRead(options)).bootstrapReceipt.status, 200);
  assert.equal(calls, 2);
});

test('explicit long visitor context lifetime reuses one bootstrap before local and server expiry', async () => {
  let now = 1000000, calls = 0;
  const fetchImpl = async () => {
    calls++;
    return bootstrapResponse([`PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=900`]);
  };
  const context = createCoupangVisitorContext({ fetchImpl, now: () => now, maxAgeMs: 600000, allowRebootstrap: false });
  const options = { context, target, operation: 'other_sellers', fetchImpl };
  const first = await prepareCoupangVisitorRead(options);
  assert.equal(first.bootstrapReceipt.status, 200);
  now += 599999;
  const second = await prepareCoupangVisitorRead(options);
  assert.equal(second.bootstrapReceipt, null);
  assert.ok(second.cookie.includes(`PCID=${visitorSentinel}`));
  assert.equal(calls, 1);
});

test('non-rebootstrap visitor context fails before any target request when the server cookie expires', async () => {
  let now = 1000000, calls = 0;
  const fetchImpl = async request => {
    calls++;
    if (request.endsWith('/web-adapter/proxy'))
      return bootstrapResponse([`PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=60`]);
    return new Response(JSON.stringify(sellers), { headers: { 'content-type': 'application/json' } });
  };
  const visitorContext = createCoupangVisitorContext({ fetchImpl, now: () => now,
    maxAgeMs: 600000, allowRebootstrap: false });
  const options = { url, authentication: 'visitor', fetchImpl, visitorContext };
  const first = await readCoupangConsumerSellers(options);
  assert.equal(first.offers[0].price.amount, 19480);
  assert.equal(first.receipt.status, 200);
  assert.equal(calls, 2);
  now += 60000;
  await assert.rejects(readCoupangConsumerSellers(options), { code: 'COUPANG_VISITOR_CONTEXT_EXPIRED' });
  assert.equal(calls, 2);
});

test('visitor context lifetime options are bounded and typed', async () => {
  const fetchImpl = async () => bootstrapResponse();
  for (const options of [{ maxAgeMs: 999 }, { maxAgeMs: 1200001 }, { maxAgeMs: 1.5 },
    { allowRebootstrap: 0 }])
    assert.throws(() => createCoupangVisitorContext({ fetchImpl, ...options }), { code: 'COUPANG_VISITOR_INPUT' });
});

test('diagnostic bridge revisit sends and retains the same PCID with only allowlisted cookies', async () => {
  const calls = [];
  const fetchImpl = async (request, options) => {
    calls.push({ request, options });
    if (calls.length === 1) return bootstrapResponse([
      `PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`,
      'x-coupang-target-market=KR; Domain=.coupang.com; Path=/; Secure; Max-Age=3600',
      `CT_AT=${rejectedSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`,
    ]);
    return bootstrapResponse([
      `PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`,
      'x-coupang-accept-language=ko-KR; Domain=.coupang.com; Path=/; Secure; Max-Age=3600',
    ], `${bridge} HTML_CANARY`);
  };
  const context = createCoupangVisitorContext({ fetchImpl, maxAgeMs: 600000, allowRebootstrap: false });
  const initial = await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  assert.equal(initial.bootstrapReceipt.status, 200);
  const proof = await revisitCoupangVisitorBootstrap({ context, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request, 'https://www.coupang.com/n-api/web-adapter/proxy');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.credentials, 'omit');
  assert.equal(calls[1].options.redirect, 'manual');
  assert.equal(calls[1].options.headers.accept, 'text/html');
  assert.ok(calls[1].options.headers.cookie.includes(`PCID=${visitorSentinel}`));
  assert.ok(calls[1].options.headers.cookie.includes('x-coupang-target-market=KR'));
  assert.equal(calls[1].options.headers.cookie.includes(rejectedSentinel), false);
  assert.equal(proof.visitorCookiesSent, true);
  assert.deepEqual(proof.visitorCookieNames, ['PCID', 'x-coupang-target-market']);
  assert.deepEqual(proof.responseCookieNames, ['PCID', 'x-coupang-accept-language']);
  assert.equal(proof.cookieRotationApplied, true);
  assert.equal(proof.identityPreserved, true);
  assert.equal(proof.challengeConfirmed, false);
  assert.equal(proof.status, 200);
  assert.equal(Object.hasOwn(proof, 'responseSha256'), false);
  const after = await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  assert.deepEqual(after.cookieNames, ['PCID', 'x-coupang-accept-language', 'x-coupang-target-market']);
  const serialized = JSON.stringify(proof);
  for (const secret of [visitorSentinel, rejectedSentinel, 'HTML_CANARY']) assert.equal(serialized.includes(secret), false);
});

test('changed PCID invalidates context permanently before any later target request', async () => {
  let calls = 0;
  const replacement = 'replacement-visitor-canary';
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? bootstrapResponse()
      : bootstrapResponse([`PCID=${replacement}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`]);
  };
  const context = createCoupangVisitorContext({ fetchImpl });
  await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  await assert.rejects(revisitCoupangVisitorBootstrap({ context, fetchImpl }), error => {
    assert.equal(error.code, 'COUPANG_VISITOR_IDENTITY_CHANGED');
    assert.equal(error.receipt.identityPreserved, false);
    assert.deepEqual(error.receipt.visitorCookieNames, ['PCID']);
    assert.deepEqual(error.receipt.responseCookieNames, ['PCID']);
    assert.equal(JSON.stringify(error.receipt).includes(visitorSentinel), false);
    assert.equal(JSON.stringify(error.receipt).includes(replacement), false);
    return true;
  });
  assert.equal(calls, 2);
  await assert.rejects(prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl }),
    { code: 'COUPANG_VISITOR_CONTEXT_EXPIRED' });
  assert.equal(calls, 2);
});

test('expired visitor context refuses a bridge revisit without making a request', async () => {
  let now = 1000000, calls = 0;
  const fetchImpl = async () => {
    calls++;
    return bootstrapResponse([`PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=60`]);
  };
  const context = createCoupangVisitorContext({ fetchImpl, now: () => now, maxAgeMs: 600000, allowRebootstrap: false });
  await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  now += 60000;
  await assert.rejects(revisitCoupangVisitorBootstrap({ context, fetchImpl }), { code: 'COUPANG_VISITOR_CONTEXT_EXPIRED' });
  assert.equal(calls, 1);
});

test('rejected bridge revisit neither retries nor applies response cookies', async () => {
  let calls = 0;
  const rejectedCookie = 'rejected-new-visitor-canary';
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return bootstrapResponse();
    const headers = new Headers({ 'content-type': 'text/html' });
    headers.append('set-cookie', `PCID=${rejectedCookie}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`);
    headers.append('set-cookie', `UNEXPECTED=${rejectedSentinel}; Domain=.coupang.com; Path=/`);
    return new Response('DENIAL_BODY_CANARY', { status: 403, headers });
  };
  const context = createCoupangVisitorContext({ fetchImpl });
  await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  await assert.rejects(revisitCoupangVisitorBootstrap({ context, fetchImpl }), error => {
    assert.equal(error.code, 'COUPANG_VISITOR_HTTP_REJECTED');
    assert.equal(error.receipt.status, 403);
    assert.deepEqual(error.receipt.responseCookieNames, ['PCID']);
    assert.equal(error.receipt.cookieRotationApplied, false);
    assert.equal(error.receipt.identityPreserved, null);
    const serialized = JSON.stringify(error.receipt);
    for (const secret of [visitorSentinel, rejectedCookie, rejectedSentinel, 'DENIAL_BODY_CANARY'])
      assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('UNEXPECTED'), false);
    assert.equal(Object.hasOwn(error.receipt, 'responseSha256'), false);
    return true;
  });
  assert.equal(calls, 2);
  const stillCurrent = await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  assert.ok(stillCurrent.cookie.includes(`PCID=${visitorSentinel}`));
  assert.equal(calls, 2);
});

test('200 bridge challenge is rejected before any visitor cookie update is accepted', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return bootstrapResponse();
    const headers = new Headers({ 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
    headers.append('set-cookie', `PCID=${visitorSentinel}; Domain=.coupang.com; Path=/; Secure; Max-Age=3600`);
    headers.append('set-cookie', 'x-coupang-target-market=KR; Domain=.coupang.com; Path=/; Secure; Max-Age=3600');
    return new Response(`${bridge}<title>Just a moment...</title>`, { status: 200, headers });
  };
  const context = createCoupangVisitorContext({ fetchImpl, allowRebootstrap: false });
  await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  await assert.rejects(revisitCoupangVisitorBootstrap({ context, fetchImpl }), error => {
    assert.equal(error.code, 'COUPANG_VISITOR_CHALLENGE');
    assert.equal(error.receipt.status, 200);
    assert.equal(error.receipt.challengeConfirmed, true);
    assert.equal(error.receipt.cookieRotationApplied, false);
    assert.equal(error.receipt.identityPreserved, null);
    assert.equal(JSON.stringify(error.receipt).includes(visitorSentinel), false);
    assert.equal(JSON.stringify(error.receipt).includes('Just a moment'), false);
    return true;
  });
  assert.equal(calls, 2);
  const unchanged = await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  assert.deepEqual(unchanged.cookieNames, ['PCID']);
  assert.equal(calls, 2);
});

test('cookie expiry, deletion, Max-Age precedence and RFC default paths are respected', async () => {
  for (const cookie of [
    `PCID=${visitorSentinel}; Domain=example.com; Path=/`,
    `PCID=${visitorSentinel}; Domain=.coupang.com`,
    `PCID=${visitorSentinel}; Path=/next-api/products/other`,
    `PCID=${visitorSentinel}; Path=/; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT`,
    `PCID=${visitorSentinel}; Path=/; Expires=Fri, 01 Jan 2000 00:00:00 GMT`,
  ]) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return bootstrapResponse([cookie]); };
    const context = createCoupangVisitorContext({ fetchImpl });
    await assert.rejects(prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl }),
      { code: 'COUPANG_VISITOR_COOKIE_MISSING' });
    assert.equal(calls, 1);
  }
  const fetchImpl = async () => bootstrapResponse([
    `PCID=${visitorSentinel}; Path=/; Max-Age=3600; Expires=Fri, 01 Jan 2000 00:00:00 GMT`,
  ]);
  const context = createCoupangVisitorContext({ fetchImpl });
  const inputs = await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl });
  assert.ok(inputs.cookie.includes(visitorSentinel));
  rotateCoupangVisitorCookies(context, ['PCID=; Path=/; Max-Age=0'], target, 'other_sellers');
  assert.ok((await prepareCoupangVisitorRead({ context, target, operation: 'other_sellers', fetchImpl })).bootstrapReceipt);
});

test('visitor scope excludes owner actions, unobserved reads, URL credentials and duplicate fields', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return bootstrapResponse(); };
  const context = createCoupangVisitorContext({ fetchImpl });
  for (const bad of [target.replace('www.coupang.com', 'example.com'), target + '&itemId=1',
    target.replace('https://', 'https://owner:secret@'), target + '#fragment', url,
    'https://www.coupang.com/n-api/web-adapter/cart-count'])
    await assert.rejects(prepareCoupangVisitorRead({ context, target: bad, operation: 'other_sellers', fetchImpl }),
      { code: 'COUPANG_VISITOR_OPERATION_SCOPE' });
  await assert.rejects(readCoupangConsumerProduct({ url, authentication: 'visitor', fetchImpl }),
    { code: 'COUPANG_VISITOR_OPERATION_SCOPE' });
  assert.equal(calls, 0);
});

test('visitor scope permits only the exact public offer-list query', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return bootstrapResponse(); };
  const context = createCoupangVisitorContext({ fetchImpl });
  const prepared = await prepareCoupangVisitorRead({ context, target: offerListTarget, operation: 'offer_list', fetchImpl });
  assert.deepEqual(prepared.cookieNames, ['PCID']);
  for (const [bad, operation] of [
    [`${offerListTarget}&extra=1`, 'offer_list'],
    [offerListTarget.replace('selectedVendorItemId=91458195016', 'selectedVendorItemId=0'), 'offer_list'],
    [offerListTarget, 'other_sellers'],
  ]) await assert.rejects(prepareCoupangVisitorRead({ context, target: bad, operation, fetchImpl }),
    { code: 'COUPANG_VISITOR_OPERATION_SCOPE' });
  assert.equal(calls, 1);
});

test('visitor scope permits only the observed Goldbox widget contract and hides server cursors', async () => {
  const initial = new URL('https://www.coupang.com/vm/mlp/v1/newweb/mlp-widget-landing');
  for (const [key, value] of Object.entries({ widgetId: '43145', isAsync: 'Y', trafficType: 'organic', landingId: '3712',
    target: 'MLP_GOLDBOX', productOffset: '0', sourceType: 'gm_crm_goldbox', isMLP: 'Y', nextWidgetPageKey: '1',
    categoryId: '0', subSourceType: 'gm_crm_gwsrtcut' })) initial.searchParams.set(key, value);
  const next = new URL(initial);
  next.searchParams.set('productOffset', '100');
  next.searchParams.set('nextWidgetPageKey', '3');
  next.searchParams.set('gbpSessionKey', 'SERVER_SESSION_SENTINEL');
  next.searchParams.set('pageVisitId', 'SERVER_PAGE_VISIT_SENTINEL');
  next.searchParams.set('gbpBottomVids', 'abc123ABC_-def456XYZ_89');
  const emptyBottomVids = new URL(initial);
  emptyBottomVids.searchParams.set('gbpBottomVids', '');
  const tooLongBottomVids = new URL(next);
  tooLongBottomVids.searchParams.set('gbpBottomVids', 'x'.repeat(4097));
  const accumulatedBottomVids = new URL(next);
  const accumulatedMarker = 'SERVER_ACCUMULATED_MARKER_' + 'x'.repeat(200);
  accumulatedBottomVids.searchParams.set('gbpBottomVids', accumulatedMarker);
  const tooLongSession = new URL(next);
  tooLongSession.searchParams.set('gbpSessionKey', 'x'.repeat(129));
  let calls = 0;
  const fetchImpl = async () => { calls++; return bootstrapResponse(); };
  const context = createCoupangVisitorContext({ fetchImpl });
  const first = await prepareCoupangVisitorRead({ context, target: initial.href, operation: 'goldbox_widget_page', fetchImpl });
  const second = await prepareCoupangVisitorRead({ context, target: next.href, operation: 'goldbox_widget_page', fetchImpl });
  const third = await prepareCoupangVisitorRead({ context, target: emptyBottomVids.href, operation: 'goldbox_widget_page', fetchImpl });
  const fourth = await prepareCoupangVisitorRead({ context, target: accumulatedBottomVids.href, operation: 'goldbox_widget_page', fetchImpl });
  assert.equal(first.bootstrapReceipt.status, 200);
  assert.equal(second.bootstrapReceipt, null);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify([first, second, context]).includes('SERVER_SESSION_SENTINEL'), false);
  assert.equal(JSON.stringify([first, second, context]).includes('SERVER_PAGE_VISIT_SENTINEL'), false);
  assert.equal(JSON.stringify([first, second, third, context]).includes('abc123ABC_-def456XYZ_89'), false);
  assert.equal(fourth.bootstrapReceipt, null);
  assert.equal(JSON.stringify([first, second, third, fourth, context]).includes(accumulatedMarker), false);

  const invalid = [
    [`${initial.href}&extra=1`, 'extra query key'],
    [initial.href.replace('target=MLP_GOLDBOX', 'target=OTHER'), 'wrong landing target'],
    [initial.href.replace('productOffset=0', 'productOffset=100001'), 'out-of-range offset'],
    [initial.href.replace('nextWidgetPageKey=1', 'nextWidgetPageKey=bad%20cursor'), 'invalid page key'],
    [`${next.href.replace(/gbpBottomVids=[^&]+/, 'gbpBottomVids=123%2Cabc')}`, 'invalid bottom marker charset'],
    [tooLongBottomVids.href, 'oversized bottom marker'],
    [tooLongSession.href, 'other session cursor limit is unchanged'],
    [`${next.href.replace(/gbpBottomVids=[^&]+/, 'gbpBottomVids=1%2C2')}&gbpBottomVids=3`, 'duplicate bottom marker'],
    [`${initial.href}&productOffset=1`, 'duplicate query key'],
    [initial.href.replace('/vm/mlp/v1/newweb/mlp-widget-landing', '/next-api/offer-list'), 'wrong endpoint'],
  ];
  for (const [target, label] of invalid)
    await assert.rejects(prepareCoupangVisitorRead({ context, target, operation: 'goldbox_widget_page', fetchImpl }),
      error => error.code === 'COUPANG_VISITOR_OPERATION_SCOPE', label);
  await assert.rejects(prepareCoupangVisitorRead({ context, target: initial.href, operation: 'offer_list', fetchImpl }),
    { code: 'COUPANG_VISITOR_OPERATION_SCOPE' });
});

test('contexts cannot disguise injected bootstrap transport as a native replay', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return bootstrapResponse(); };
  const context = createCoupangVisitorContext({ fetchImpl });
  await assert.rejects(prepareCoupangVisitorRead({ context, target, operation: 'other_sellers' }),
    { code: 'COUPANG_VISITOR_CONTEXT' });
  await assert.rejects(prepareCoupangVisitorRead({ context: {}, target, operation: 'other_sellers', fetchImpl }),
    { code: 'COUPANG_VISITOR_CONTEXT' });
  assert.equal(calls, 0);
});

test('bootstrap failures and target 403/429 stop after one attempt without relogin or refresh', async () => {
  for (const status of [403, 429]) {
    let calls = 0;
    const bootstrapFail = async () => { calls++; return new Response(rejectedSentinel, { status }); };
    await assert.rejects(readCoupangConsumerSellers({ url, authentication: 'visitor', fetchImpl: bootstrapFail }), error => {
      assert.equal(error.code, status === 429 ? 'COUPANG_VISITOR_RATE_LIMITED' : 'COUPANG_VISITOR_HTTP_REJECTED');
      assert.equal(error.receipt.visitorBootstrap.status, status);
      assert.equal(JSON.stringify(error.receipt).includes(rejectedSentinel), false);
      return true;
    });
    assert.equal(calls, 1);
    calls = 0;
    const targetFail = async request => { calls++; return request.endsWith('/web-adapter/proxy')
      ? bootstrapResponse() : new Response(rejectedSentinel, { status }); };
    await assert.rejects(readCoupangConsumerSellers({ url, authentication: 'visitor', fetchImpl: targetFail }),
      { code: status === 429 ? 'COUPANG_CONSUMER_RATE_LIMITED' : 'COUPANG_CONSUMER_ACCESS_BLOCKED' });
    assert.equal(calls, 2);
  }
});

test('redirect and oversized bootstrap bodies never reach a product read', async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }),
    () => new Response('x'.repeat(65537), { headers: { 'content-type': 'text/html' } }),
  ]) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return response(); };
    await assert.rejects(readCoupangConsumerSellers({ url, authentication: 'visitor', fetchImpl }),
      error => ['COUPANG_VISITOR_REDIRECT', 'COUPANG_VISITOR_RESPONSE_SIZE'].includes(error.code));
    assert.equal(calls, 1);
  }
});

test('public review reads accept isLogin false and distinguish a DPoP challenge', async () => {
  let calls = 0;
  const fetchImpl = async request => {
    calls++;
    if (request.endsWith('/web-adapter/proxy')) return bootstrapResponse();
    return new Response(JSON.stringify({ rCode: 'RET0000', rData: { isLogin: false,
      paging: { page: 1, currentPage: 1, sizePerPage: 10, totalCount: 0, totalPage: 0, isNext: false, contents: [] } } }),
    { headers: { 'content-type': 'application/json' } });
  };
  const result = await readCoupangConsumerReviews({ url, authentication: 'visitor', fetchImpl });
  assert.equal(result.receipt.applicationAuthenticated, false);
  assert.equal(result.receipt.authenticatedOwnerVerified, false);
  assert.equal(result.count, 0);
  assert.equal(calls, 2);
  const dpopFetch = async request => request.endsWith('/web-adapter/proxy') ? bootstrapResponse()
    : new Response(null, { status: 401, headers: { 'www-authenticate': 'DPoP error="invalid_iat"' } });
  await assert.rejects(readCoupangConsumerSellers({ url, authentication: 'visitor', fetchImpl: dpopFetch }),
    { code: 'COUPANG_CONSUMER_DPOP_REQUIRED' });
});

test('profile counts each actual bootstrap when successful review rotation deletes PCID', async () => {
  const paths = [];
  const fetchImpl = async request => {
    const path = new URL(request).pathname;
    paths.push(path);
    if (path.endsWith('/web-adapter/proxy')) return bootstrapResponse();
    if (path.endsWith('/other-seller-info')) return new Response(JSON.stringify(sellers),
      { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ rCode: 'RET0000', rData: { isLogin: false,
      paging: { page: 1, currentPage: 1, sizePerPage: 10, totalCount: 0, totalPage: 0, isNext: false, contents: [] } } }),
    { headers: { 'content-type': 'application/json', 'set-cookie': 'PCID=; Domain=.coupang.com; Path=/; Max-Age=0' } });
  };
  const result = await readCoupangConsumerProfile({ url, authentication: 'visitor', fetchImpl });
  assert.deepEqual(paths, ['/n-api/web-adapter/proxy', '/next-api/review', '/n-api/web-adapter/proxy', '/next-api/products/other-seller-info']);
  assert.equal(result.receipt.requestCount, 4);
  assert.equal(result.receipt.visitorBootstraps.length, 2);
  assert.equal(result.receipt.visitorValuesPersisted, false);
  assert.equal(result.states.live_replay, false);
  assert.equal(JSON.stringify(result).includes(visitorSentinel), false);
});

test('invalid visitor transport inputs fail as typed adapter errors before HTTP', async () => {
  for (const read of [readCoupangConsumerSellers, readCoupangConsumerProfile])
    await assert.rejects(read({ url, authentication: 'visitor', fetchImpl: null }),
      error => error.name === 'CoupangConsumerError' && error.code === 'COUPANG_VISITOR_INPUT');
});

test('public offers uses only the observed visitor GET, validates safe prices, and omits seller data', async () => {
  const calls = [];
  const fetchImpl = async (request, options) => {
    calls.push({ request, options });
    if (request.endsWith('/web-adapter/proxy')) return bootstrapResponse();
    assert.equal(request, offerListTarget);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.accept, 'application/json, text/plain, */*');
    assert.equal(options.headers.referer, url);
    assert.ok(options.headers.cookie.includes(`PCID=${visitorSentinel}`));
    assert.equal(options.headers.cookie.includes(rejectedSentinel), false);
    assert.equal(options.headers['user-agent'], undefined);
    return new Response(JSON.stringify(offerList), { headers: { 'content-type': 'application/json' } });
  };
  const result = await readCoupangConsumerOfferList({ url, authentication: 'visitor', fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.selectedOffer.price.amount, 19480);
  assert.equal(result.selectedOffer.price.basis, 'public_offer_list');
  assert.equal(result.selectedOffer.couponFlags.hasCouponDownload, false);
  assert.equal(result.receipt.visitorCookiesSent, true);
  assert.equal(result.receipt.visitorValuesPersisted, false);
  assert.equal(result.receipt.ownerCredentialUsed, false);
  assert.equal(result.receipt.authenticatedOwnerVerified, false);
  assert.equal(result.receipt.applicationAuthenticated, null);
  assert.equal(result.receipt.credentialPropagated, false);
  assert.equal(result.states.live_replay, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(visitorSentinel), false);
  assert.equal(serialized.includes(rejectedSentinel), false);
  assert.equal(serialized.includes('DO_NOT_EXPORT'), false);
  assert.equal(result.offers.some(offer => Object.hasOwn(offer, 'wowPrice')), false);
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'not_exposed_by_public_offer_list');
});

test('public offers does not retry on a target 403 and never accepts an owner session', async () => {
  let calls = 0;
  await assert.rejects(readCoupangConsumerOfferList({ url, authentication: 'visitor', fetchImpl: async request => {
    calls++;
    return request.endsWith('/web-adapter/proxy') ? bootstrapResponse() : new Response('blocked', { status: 403 });
  } }), error => {
    assert.equal(error.code, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
    assert.equal(error.receipt.status, 403);
    assert.equal(error.receipt.retry, false);
    assert.equal(error.receipt.ownerCredentialUsed, false);
    assert.equal(error.receipt.applicationAuthenticated, null);
    return true;
  });
  assert.equal(calls, 2);
  await assert.rejects(readCoupangConsumerOfferList({ url, authentication: 'protected' }),
    { code: 'COUPANG_CONSUMER_OFFER_LIST_AUTH_SCOPE' });
  await assert.rejects(readCoupangConsumerOfferList({ url, authentication: 'visitor', session: {} }),
    { code: 'COUPANG_CONSUMER_OFFER_LIST_AUTH_SCOPE' });
});
