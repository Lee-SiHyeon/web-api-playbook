import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWalmartPublicClient, parseWalmartSearchDocument } from '../lib/retail/walmart.mjs';

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/walmart-search-observed.html', import.meta.url)), 'utf8');
const now = () => Date.parse('2026-10-15T16:00:00.000Z');

test('parses only query-bound product cards and keeps incomplete price coverage explicit', () => {
  const result = parseWalmartSearchDocument(fixture, { query: 'wireless earbuds' });
  assert.equal(result.query, 'wireless earbuds');
  assert.equal(result.pageTitle, 'wireless earbuds - Walmart.com');
  assert.equal(result.products.length, 2);
  assert.deepEqual(result.products[0], {
    id: '5355045930',
    sourceItemId: '5355045930',
    title: 'VEAT00L V6 Bluetooth Headphones Wireless Earbuds 88Hrs Playback Sport Ear Buds with Earhook Digital Display Charging Case IPX7 Waterproof Earbud Deep Bass Running Earphones for iOS Android Cellphone',
    productUrl: 'https://www.walmart.com/ip/VEAT00L-V6-Bluetooth-Headphones-Wireless-Earbuds-88Hrs-Playback-Sport-Ear-Buds-Earhook-Digital-Display-Charging-Case-IPX7-Waterproof-Earbud-Deep-Bass/5355045930',
    imageUrl: 'https://i5.walmartimages.com/seo/VEAT00L-V6-Bluetooth-Headphones-Wireless-Earbuds-88Hrs-Playback-Sport-Ear-Buds-Earhook-Digital-Display-Case-IPX7-Waterproof-Earbud-Deep-Bass_f587ba7b-85ac-45b3-8004-730b4b4574f0.1a09cf47083f31029fbd5d86c313d621.png?odnHeight=288&odnWidth=288&odnBg=FFFFFF',
    displayedPrice: {
      amount: '22.99', currencySymbol: '$', currencyCode: null,
      currencyCodeExplicit: false, displayText: 'current price Now $22.99, Was $179.95',
      compareAtAmount: '179.95',
    },
  });
  assert.equal(result.products[1].id, '510914820');
  assert.equal(result.products[1].sourceItemId, '20222OLQBJIF');
  assert.equal(result.products[1].displayedPrice, null);
  assert.equal(result.products[1].imageUrl, null);
  assert.deepEqual(result.coverage, {
    productCardCandidates: 2, productsReturned: 2, productsWithPrice: 1,
    productsWithImage: 1, unboundCardCount: 0, pageScope: 'one_observed_search_document',
    pagination: { observed: false, hasNext: null, completeCatalog: false }, partial: true,
  });
  assert.equal(result.completeCatalog, false);
});

test('does not bind a card with a mismatched item id or an off-origin destination', () => {
  const mismatchedId = fixture.replace('data-item-id="5355045930"', 'data-item-id="9999999999"');
  const mismatchResult = parseWalmartSearchDocument(mismatchedId, { query: 'wireless earbuds' });
  assert.equal(mismatchResult.products.some(item => item.id === '5355045930'), false);
  assert.equal(mismatchResult.coverage.unboundCardCount, 1);
  assert.equal(mismatchResult.coverage.partial, true);

  const offOrigin = fixture.replace('https://www.walmart.com/sp/track?rd=', 'https://attacker.example/sp/track?rd=');
  const offOriginResult = parseWalmartSearchDocument(offOrigin, { query: 'wireless earbuds' });
  assert.equal(offOriginResult.products.length, 1);
  assert.equal(offOriginResult.products[0].id, '510914820');
  assert.equal(offOriginResult.coverage.unboundCardCount, 1);
});

test('query binding and challenge documents fail before returning product data', () => {
  assert.throws(() => parseWalmartSearchDocument(fixture, { query: 'another query' }),
    { code: 'WALMART_SEARCH_QUERY_MISMATCH' });
  assert.throws(() => parseWalmartSearchDocument('<html><title>Robot or human?</title></html>',
    { query: 'wireless earbuds' }), { code: 'WALMART_CHALLENGE_RESPONSE' });
});

test('public search uses the exact successful direct HTTP headers and records response evidence', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, 'https://www.walmart.com/search?q=wireless+earbuds');
    assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    assert.equal(init.redirect, 'follow');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.authorization, undefined);
    return new Response(fixture, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const result = await createWalmartPublicClient({ fetchImpl, now }).searchProducts({ query: ' wireless   earbuds ' });
  assert.equal(calls, 1);
  assert.equal(result.products.length, 2);
  assert.equal(result.receipt.capabilityId, 'catalog.search');
  assert.equal(result.receipt.request.httpStatus, 200);
  assert.equal(result.receipt.request.mime, 'text/html');
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.request.credentialsUsed, false);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.request.userAgentProfile, 'explicit_chrome_131_direct_probe');
  assert.deepEqual(result.receipt.request.explicitHeadersSent, {
    accept: 'text/html,application/xhtml+xml',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  assert.equal(result.receipt.paginationObserved, false);
  assert.equal(result.receipt.completeCatalog, false);
  assert.match(result.receipt.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result.receipt).includes('wireless'), false);
});

test('search validates input, HTTP/MIME, redirects and result shell boundaries', async () => {
  let calls = 0;
  const neverFetch = createWalmartPublicClient({ fetchImpl: async () => { calls++; throw new Error('unexpected'); } });
  for (const query of ['', ' ', '\nwireless', 'x'.repeat(121), null, 5]) {
    await assert.rejects(neverFetch.searchProducts({ query }), { code: 'WALMART_SEARCH_QUERY_INVALID' });
  }
  assert.equal(calls, 0);

  const blocked = createWalmartPublicClient({ fetchImpl: async () =>
    new Response('blocked - redirecting', { status: 307, headers: {
      'content-type': 'text/plain', location: 'https://www.walmart.com/blocked?uuid=redacted',
    } }), now });
  await assert.rejects(blocked.searchProducts({ query: 'wireless earbuds' }), error => {
    assert.equal(error.code, 'WALMART_HTTP_FAILED');
    assert.equal(error.receipt.request.httpStatus, 307);
    assert.equal(error.receipt.request.mime, 'text/plain');
    return true;
  });

  const blockedDocument = new Response('<html><title>wireless earbuds - Walmart.com</title></html>', {
    headers: { 'content-type': 'text/html' },
  });
  Object.defineProperty(blockedDocument, 'url', { value: 'https://www.walmart.com/blocked' });
  await assert.rejects(createWalmartPublicClient({ fetchImpl: async () => blockedDocument, now })
    .searchProducts({ query: 'wireless earbuds' }), error => {
      assert.equal(error.code, 'WALMART_UNEXPECTED_ROUTE');
      assert.equal(error.receipt.finalPath, '/blocked');
      assert.equal(error.receipt.responseTitle, 'wireless earbuds - Walmart.com');
      assert.equal(error.receipt.challenge, false);
      assert.match(error.receipt.responseSha256, /^[a-f0-9]{64}$/);
      return true;
    });

  const challengeDocument = new Response('<html><title>Robot or human?</title></html>', {
    headers: { 'content-type': 'text/html' },
  });
  Object.defineProperty(challengeDocument, 'url', { value: 'https://www.walmart.com/blocked' });
  await assert.rejects(createWalmartPublicClient({ fetchImpl: async () => challengeDocument, now })
    .searchProducts({ query: 'wireless earbuds' }), error => {
      assert.equal(error.code, 'WALMART_CHALLENGE_RESPONSE');
      assert.equal(error.receipt.challenge, true);
      return true;
    });

  await assert.rejects(createWalmartPublicClient({ fetchImpl: async () =>
    new Response(fixture, { status: 200, headers: { 'content-type': 'application/json' } }), now })
    .searchProducts({ query: 'wireless earbuds' }), { code: 'WALMART_RESPONSE_INVALID' });

  await assert.rejects(createWalmartPublicClient({ fetchImpl: async () =>
    new Response('<html><title>wireless earbuds - Walmart.com</title></html>', {
      headers: { 'content-type': 'text/html' },
    }), now }).searchProducts({ query: 'wireless earbuds' }), { code: 'WALMART_SEARCH_SCHEMA_INVALID' });
});
