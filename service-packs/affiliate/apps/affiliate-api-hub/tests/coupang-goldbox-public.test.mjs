import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicCoupangGoldbox } from '../lib/coupang-goldbox-public.mjs';

const cookieSentinel = 'public-goldbox-cookie-sentinel';

function bootstrapResponse() {
  return new Response('<html><title>web-adapter-proxy</title>getLocalStorage</html>', {
    headers: { 'content-type': 'text/html; charset=utf-8',
      'set-cookie': `PCID=${cookieSentinel}; Domain=.coupang.com; Path=/; Secure` },
  });
}

test('a widget 403 stops the public catalog path without retrying or attempting offer fallbacks', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/n-api/web-adapter/proxy')) return bootstrapResponse();
    return new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  };

  const result = await fetchPublicCoupangGoldbox(2, {
    fetchImpl,
    widgetPageDelayMs: 0,
    publicOfferFallbackDelayMs: 0,
    shippingEnrichmentDelayMs: 0,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.receipt.widgetErrorCode, 'COUPANG_GOLDBOX_WIDGET_ACCESS_BLOCKED');
  assert.equal(result.receipt.retry, false);
  assert.equal(result.receipt.widget.pages[0].status, 403);
  assert.equal(result.receipt.publicOfferFallback.attempted, 0);
  assert.equal(result.receipt.publicOfferFallback.stopReason, 'widget_not_complete');
  assert.equal(result.receipt.visitorValuesPersisted, false);
  assert.equal(JSON.stringify(result).includes(cookieSentinel), false);
});

test('legacy browser WOW observations are rejected before any network request', async () => {
  let calls = 0;
  await assert.rejects(fetchPublicCoupangGoldbox(1, {
    fetchImpl: async () => { calls++; throw new Error('unexpected request'); },
    coupangWowObservation: { rows: [] },
  }), error => error.code === 'COUPANG_WOW_OBSERVATION_HTTP_ONLY');
  assert.equal(calls, 0);
});