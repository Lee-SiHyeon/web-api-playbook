import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCoupangRsc, readCoupangRsc, validateCoupangRscInput } from '../lib/retail/coupang-rsc.mjs';
const fixture = async () => JSON.parse(await readFile(new URL('./fixtures/coupang/retail-rsc-list.json', import.meta.url), 'utf8'));
const input = () => ({ url: 'https://www.coupang.com/np/search?q=mouse&channel=relate&sorter=salePriceAsc&_rsc=fixture',
  headers: { rsc: '1', 'next-url': '/srp', 'next-router-state-tree': encodeURIComponent('["",{"children":["srp",{"children":["__PAGE__",{},null,null]},null,null]},null,null,true]'),
    referer: 'https://www.coupang.com/np/search?q=mouse&channel=relate', accept: '*/*' } });
const frame = data => '3:I["module"]\nc:' + JSON.stringify(['$',null,null,data]) + '\n';

test('RSC extracts the 60 main results, preserves Korean and price conditions, and excludes tracking/recommendations', async () => {
  const data = await fixture(); data.searchId = 'PRIVATE_TRACKING'; data.preprocessedProducts = [{ title: 'NOT_MAIN_RESULT' }];
  data.products[0].properties = { session: 'PRIVATE_TRACKING' };
  const result = parseCoupangRsc(frame(data), input().url);
  assert.equal(result.products.length, 60); assert.equal(result.products[0].price.amount, 900);
  assert.equal(result.products[0].title, '무소음 무선 마우스 2.4GHz 좌우대칭 블랙, JD577, 1개');
  assert.equal(result.products[0].shippingLabel, '배송비 3,000원 조건부 무료배송');
  assert.equal(result.products[0].price.accountApplied, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE_TRACKING'), false);
  assert.equal(new URL(result.sourceUrl).searchParams.has('_rsc'), false);
  assert.equal(result.pagination.hasNext, null);
  assert.throws(() => parseCoupangRsc(frame({ a: data, b: data }), input().url), { code: 'COUPANG_RSC_LIST_MISSING_OR_AMBIGUOUS' });
  data.products[0].vendorItemId = 1;
  assert.throws(() => parseCoupangRsc(frame(data), input().url), { code: 'COUPANG_RSC_PRODUCT_SCHEMA' });
});

test('RSC inputs refuse credential headers, foreign scopes and guessed routing state before HTTP', async () => {
  assert.equal(validateCoupangRscInput(input()).headers.rsc, '1');
  const cases = [
    { ...input(), url: input().url.replace('www.coupang.com','other.test') },
    { ...input(), url: input().url + '&q=second' },
    { ...input(), headers: { ...input().headers, cookie: 'PRIVATE' } },
    { ...input(), headers: { ...input().headers, 'user-agent': 'IMPERSONATION' } },
    { ...input(), headers: { ...input().headers, 'next-url': '/account' } },
  ];
  for (const bad of cases) await assert.rejects(readCoupangRsc(bad, { fetchImpl: () => assert.fail('network') }));
});

test('visitor RSC uses only scoped HTTP-issued cookies and never claims an injected replay is live', async () => {
  const body = frame(await fixture()), sentinel = 'PRIVATE_VISITOR'; let calls = 0;
  const result = await readCoupangRsc(input(), { authentication: 'visitor', fetchImpl: async (url, init) => {
    calls++; assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    if (url.endsWith('/web-adapter/proxy')) return new Response('<html>web-adapter-proxy getLocalStorage</html>',
      { headers: { 'content-type': 'text/html', 'set-cookie': `PCID=${sentinel}; Domain=.coupang.com; Path=/; Secure` } });
    assert.equal(init.headers.cookie, `PCID=${sentinel}`); assert.equal(init.headers.rsc, '1');
    return new Response(body, { headers: { 'content-type': 'text/x-component' } });
  } });
  assert.equal(calls, 2); assert.equal(result.data.products.length, 60); assert.equal(result.receipt.cookieSent, true);
  assert.equal(result.states.live_replay, false); assert.equal(JSON.stringify(result).includes(sentinel), false);
  await assert.rejects(readCoupangRsc(input(), { fetchImpl: async () => new Response('<title>Access Denied</title>',
    { status: 403, headers: { server: 'AkamaiGHost', 'content-type': 'text/html' } }) }), error => {
    assert.equal(error.code, 'COUPANG_RSC_HTTP_403'); assert.equal(error.receipt.server, 'AkamaiGHost'); return true;
  });
});
