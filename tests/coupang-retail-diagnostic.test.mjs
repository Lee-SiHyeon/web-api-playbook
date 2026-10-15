import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { runRetailDiagnostic } from '../scripts/coupang-retail-diagnostic.mjs';

const sentinel = 'PRIVATE_DIAGNOSTIC_VISITOR';
const rejected = 'REJECTED_RESPONSE_COOKIE';
const fixture = { data: { status: 200, title: 'Fixture', vendorItems: [{
  productId: 6247736560, itemId: 12646874013, vendorItemId: 79914317500, selected: true,
  hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: true,
  vendorItemSaleInfo: { itemId: 12646874013, vendorItemId: 79914317500, salePrice: 13200,
    i18nSalePrice: { amount: '13200', rawAmount: 13200, fractionDigits: 0, currency: 'KRW' }, originPrice: 19900 },
}] } };

function fixtureFetch({ status = 403, interactive = false } = {}) {
  const calls = [];
  const fetch = async (value, init) => {
    const url = new URL(value); calls.push({ url: value, init });
    if (url.pathname.endsWith('/web-adapter/proxy')) return new Response('<html>web-adapter-proxy getLocalStorage</html>',
      { headers: { 'content-type': 'text/html', 'set-cookie': `PCID=${sentinel}; Domain=.coupang.com; Path=/; Secure` } });
    assert.equal(init.headers.cookie, `PCID=${sentinel}`);
    if (url.pathname === '/next-api/offer-list') return new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } });
    channel('undici:request:create').publish({ request: { origin: url.origin, path: url.pathname + url.search,
      headers: Object.entries({ ...init.headers, 'user-agent': 'node' }).flat() } });
    return new Response('<title>Access Denied</title>', { status,
      headers: { 'content-type': 'text/html', server: 'AkamaiGHost', 'set-cookie': `PCID=${rejected}; Path=/`,
        ...(interactive ? { 'cf-mitigated': 'challenge' } : {}) } });
  };
  return { fetch, calls };
}

test('explicit 403 comparison keeps one identity, applies one-condition probes, and preserves working controls', async () => {
  const { fetch, calls } = fixtureFetch(); let h2 = 0;
  const report = await runRetailDiagnostic({ baseFetch: fetch, sleep: async () => {}, http2Read: async (url, init, observed) => {
    h2++; assert.equal(new URL(url).searchParams.get('sorter'), 'salePriceAsc');
    assert.equal(observed.cookie, `PCID=${sentinel}`); assert.equal(observed['user-agent'], 'node');
    return new Response('<title>Access Denied</title>', { status: 403, headers: { 'content-type': 'text/html', server: 'AkamaiGHost' } });
  } });
  assert.equal(report.runs.length, 9); assert.equal(report.bootstrapRequests, 1); assert.equal(h2, 1);
  assert.equal(report.identityPreserved, true); assert.equal(report.stopped, null); assert.equal(report.nativeNetwork, false);
  assert.deepEqual(report.runs.filter(x => x.ok).map(x => x.name), ['offer_control_before', 'offer_control_after']);
  assert.equal(calls.filter(x => x.init.headers.referer === 'https://www.coupang.com/').length, 1);
  assert.equal(report.networkRequests, 10);
  assert.equal(JSON.stringify(report).includes(sentinel), false); assert.equal(JSON.stringify(report).includes(rejected), false);
});

test('rate limits, authentication responses and interactive challenges stop comparison without a fresh visitor', async () => {
  for (const [status, interactive] of [[429, false], [401, false], [418, false], [403, true]]) {
    const { fetch, calls } = fixtureFetch({ status, interactive });
    const report = await runRetailDiagnostic({ baseFetch: fetch, sleep: async () => {}, http2Read: () => assert.fail('HTTP2 must not run') });
    assert.equal(report.stopped, 'search_sorted'); assert.equal(report.runs.length, 2); assert.equal(calls.length, 3);
    assert.equal(report.bootstrapRequests, 1); assert.equal(report.unattempted.length, 7);
  }
});
