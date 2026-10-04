import test from 'node:test';
import assert from 'node:assert/strict';
import { createEbayPublicClient } from '../lib/retail/ebay.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json;charset=utf-8' },
});

test('public suggestion request uses only the observed eBay origin and fields', async () => {
  let calls = 0;
  const client = createEbayPublicClient({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url.origin, 'https://autosug.ebay.com');
    assert.equal(url.pathname, '/autosug');
    assert.deepEqual([...url.searchParams], [['sId', '0'], ['fmt', 'osr'], ['kwd', 'usb cable']]);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { accept: 'application/json' });
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers.cookie, undefined);
    return json(['usb cable', ['usb cable type c', 'usb cable extension']]);
  }, now: () => Date.parse('2026-10-05T00:00:00Z') });
  const result = await client.suggestKeywords({ query: ' usb cable ' });
  assert.deepEqual(result.suggestions, ['usb cable type c', 'usb cable extension']);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.receipt.anonymous, true);
  assert.equal(result.receipt.suggestionCount, 2);
  assert.equal(JSON.stringify(result.receipt).includes('usb cable'), false);
  assert.equal(calls, 1);
});

test('first-party rich autocomplete returns category hints without account state', async () => {
  const client = createEbayPublicClient({ fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://autosug.ebay.com');
    assert.deepEqual([...url.searchParams], [
      ['kwd', 'usb cable'], ['sId', '0'], ['_richres', '1'], ['callback', '0'],
    ]);
    assert.equal(init.credentials, 'omit');
    return json({ prefix: 'usb cable', dict: '0', res: {}, richRes: { sug: [
      { kwd: 'usb cable type c', type: 's', categories: [
        { catId: '9394', catName: 'Cell Phone Accessories' },
        { catId: '182094', catName: 'Computer Cables & Connectors' },
      ] },
      { kwd: 'usb cable extension', type: 's' },
    ] } });
  } });
  const result = await client.suggestCatalogHints({ query: 'usb cable' });
  assert.deepEqual(result.suggestions, ['usb cable type c', 'usb cable extension']);
  assert.deepEqual(result.categoryHints, [
    { keyword: 'usb cable type c', id: '9394', name: 'Cell Phone Accessories' },
    { keyword: 'usb cable type c', id: '182094', name: 'Computer Cables & Connectors' },
  ]);
  assert.equal(result.receipt.categoryHintCount, 2);
});

test('bad input never sends a request', async () => {
  const client = createEbayPublicClient({ fetchImpl: () => assert.fail('must not send') });
  for (const query of ['', ' ', '\nscript', 'x'.repeat(101), null, 123]) {
    await assert.rejects(client.suggestKeywords({ query }), { code: 'EBAY_QUERY_INVALID' });
  }
});

test('challenge, throttling, redirects and malformed data stay explicit failures', async () => {
  const replies = [
    [json({}, 403), 'EBAY_ACCESS_BLOCKED'],
    [json({}, 429), 'EBAY_THROTTLED'],
    [new Response(null, { status: 302, headers: { location: 'https://signin.ebay.com/' } }), 'EBAY_RESPONSE_INVALID'],
    [new Response('<html>Challenge</html>', { headers: { 'content-type': 'text/html' } }), 'EBAY_RESPONSE_INVALID'],
    [json({ suggestions: [] }), 'EBAY_SCHEMA_INVALID'],
    [json(['usb', ['valid', null]]), 'EBAY_SCHEMA_INVALID'],
  ];
  for (const [reply, code] of replies) {
    const client = createEbayPublicClient({ fetchImpl: async () => reply });
    await assert.rejects(client.suggestKeywords({ query: 'usb' }), error => {
      assert.equal(error.code, code);
      assert.equal(error.receipt.browserUsed, false);
      assert.equal(JSON.stringify(error.receipt).includes('Challenge'), false);
      return true;
    });
  }
});

test('response body is bounded and transport errors omit raw cause details', async () => {
  const huge = new Response('x'.repeat(65 * 1024), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(createEbayPublicClient({ fetchImpl: async () => huge }).suggestKeywords({ query: 'usb' }),
    { code: 'EBAY_RESPONSE_TOO_LARGE' });
  await assert.rejects(createEbayPublicClient({ fetchImpl: async () => { throw new Error('private diagnostic'); } })
    .suggestKeywords({ query: 'usb' }), error => {
      assert.equal(error.code, 'EBAY_TRANSPORT_FAILED');
      assert.equal(JSON.stringify(error.receipt).includes('private diagnostic'), false);
      return true;
    });
});

test('rich autocomplete rejects malformed category hints instead of treating them as catalog entries', async () => {
  const client = createEbayPublicClient({ fetchImpl: async () => json({
    prefix: 'usb cable', dict: '0', res: {}, richRes: { sug: [
      { kwd: 'usb cable', categories: [{ catId: 'not-an-id', catName: 'Accessories' }] },
    ] },
  }) });
  await assert.rejects(client.suggestCatalogHints({ query: 'usb cable' }), { code: 'EBAY_SCHEMA_INVALID' });
});

test('both suggestion formats reject a response for a different query', async () => {
  const simple = createEbayPublicClient({ fetchImpl: async () => json(['different query', ['other result']]) });
  await assert.rejects(simple.suggestKeywords({ query: ' usb cable ' }), { code: 'EBAY_SCHEMA_INVALID' });
  const rich = createEbayPublicClient({ fetchImpl: async () => json({
    prefix: 'different query', dict: '0', res: {}, richRes: { sug: [{ kwd: 'other result' }] },
  }) });
  await assert.rejects(rich.suggestCatalogHints({ query: ' usb cable ' }), { code: 'EBAY_SCHEMA_INVALID' });
});
