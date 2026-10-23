import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readCoupangRetailSearch, readCoupangDocument, readCoupangTravelAutocomplete } from '../lib/retail/coupang-public.mjs';
import { createCoupangVisitorContext, prepareCoupangVisitorRead } from '../service-packs/affiliate/apps/affiliate-api-hub/lib/coupang-visitor-context.mjs';

const bridgeUrl = 'https://www.coupang.com/n-api/web-adapter/proxy';
const bridge = '<html>web-adapter-proxy getLocalStorage</html>';
const sentinel = 'PRIVATE_VISITOR_TEST_VALUE';
const headers = { 'content-type': 'text/html', 'set-cookie': `PCID=${sentinel}; Domain=.coupang.com; Path=/; Secure` };
const html = () => readFile(new URL('./fixtures/coupang/retail-search-dom.html', import.meta.url), 'utf8');

test('default retail search reuses one visitor for search and category without credentials or persisted values', async () => {
  const body = await html(), calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers['user-agent'], undefined);
    if (url === bridgeUrl) {
      assert.equal(init.headers.cookie, undefined);
      return new Response(bridge, { headers });
    }
    assert.equal(init.headers.cookie, `PCID=${sentinel}`);
    return new Response(body, { headers: { 'content-type': 'text/html' } });
  };
  const visitorContext = createCoupangVisitorContext({ fetchImpl, allowRebootstrap: false });
  const search = await readCoupangRetailSearch('무선 마우스', { sorter: 'salePriceAsc', freeDelivery: true, visitorContext, fetchImpl });
  const category = await readCoupangDocument('https://www.coupang.com/np/categories/178255?page=2',
    { authentication: 'visitor', visitorContext, fetchImpl });
  assert.equal(calls.length, 3); assert.equal(calls.filter(x => x === bridgeUrl).length, 1);
  for (const result of [search, category]) {
    assert.equal(result.request.authenticationMode, 'visitor'); assert.equal(result.request.cookieSent, true);
    assert.deepEqual(result.request.visitorCookieNames, ['PCID']); assert.equal(result.credentialsUsed, false);
    assert.equal(result.states.live_replay, false); assert.equal(result.data.products.length, 3);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
  assert.equal(category.request.visitorBootstrap, null);
});

test('visitor search rejection preserves bootstrap evidence and does not retry or follow a redirect', async () => {
  for (const status of [302, 403, 418, 429]) {
    let calls = 0;
    await assert.rejects(readCoupangRetailSearch('mouse', { fetchImpl: async (url, init) => {
      calls++;
      if (url === bridgeUrl) return new Response(bridge, { headers });
      assert.equal(init.headers.cookie, `PCID=${sentinel}`);
      return new Response('<title>Access Denied</title>', { status,
        headers: { 'content-type': 'text/html', location: 'https://www.coupang.com/np/categories/178255' } });
    } }), error => {
      assert.equal(error.code, `COUPANG_HTTP_${status}`);
      assert.equal(error.receipt.cookieSent, true); assert.equal(error.receipt.visitorBootstrap.status, 200);
      assert.equal(JSON.stringify(error.receipt).includes(sentinel), false);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test('bootstrap rejection sends no retail request and preserves the failed stage', async () => {
  let calls = 0;
  await assert.rejects(readCoupangRetailSearch('mouse', { fetchImpl: async url => {
    calls++; assert.equal(url, bridgeUrl); return new Response('', { status: 403 });
  } }), error => {
    assert.equal(error.code, 'COUPANG_VISITOR_HTTP_REJECTED'); assert.equal(error.receipt.cookieSent, false);
    assert.equal(error.receipt.httpStatus, null); assert.equal(error.receipt.visitorBootstrap.status, 403); return true;
  });
  assert.equal(calls, 1);
});

test('new visitor Document scopes reject RSC, unsupported filter shapes, duplicates and foreign hosts before bootstrap', async () => {
  const fetchImpl = () => assert.fail('no request'), context = createCoupangVisitorContext({ fetchImpl });
  const invalid = [
    ['https://www.coupang.com/np/search?q=mouse&channel=user&_rsc=runtime', 'retail_search_document'],
    ['https://www.coupang.com/np/search?q=mouse&q=other&channel=user', 'retail_search_document'],
    ['https://www.coupang.com/np/search?q=mouse&channel=user&filterType=free', 'retail_search_document'],
    ['https://www.coupang.com/np/search?q=mouse&channel=user&page=1001', 'retail_search_document'],
    ['https://trip.coupang.com/np/search?q=mouse&channel=user', 'retail_search_document'],
    ['https://www.coupang.com/np/categories/178255?token=runtime', 'retail_category_document'],
    ['https://www.coupang.com/login', 'retail_category_document'],
  ];
  for (const [target, operation] of invalid)
    await assert.rejects(prepareCoupangVisitorRead({ context, target, operation, fetchImpl }), { code: 'COUPANG_VISITOR_OPERATION_SCOPE' });
  await assert.rejects(readCoupangTravelAutocomplete('제주', { authentication: 'visitor', fetchImpl }), { code: 'COUPANG_VISITOR_OPERATION_SCOPE' });
});

test('cookie-free diagnostic is explicit and a visitor navigation shell never counts as a listing', async () => {
  const body = await html(); let calls = 0;
  const result = await readCoupangRetailSearch('mouse', { authentication: 'anonymous', fetchImpl: async (url, init) => {
    calls++; assert.notEqual(url, bridgeUrl); assert.equal(init.headers.cookie, undefined);
    return new Response(body, { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal(calls, 1); assert.equal(result.request.cookieSent, false);
  await assert.rejects(readCoupangRetailSearch('mouse', { fetchImpl: async url => url === bridgeUrl
    ? new Response(bridge, { headers })
    : new Response('<a href="/np/categories/178255">category</a>', { headers: { 'content-type': 'text/html' } }) }),
  { code: 'COUPANG_RETAIL_LISTING_MISSING' });
});
