import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmazonPublicClient, parseAmazonSearchStream } from '../lib/retail/amazon.mjs';

const MIME = 'application/json-amazonui-streaming';
const frame = (name, payload) => JSON.stringify(['dispatch', name, payload]);
const cardHtml = ({ asin = 'B004YAVF8I', title = 'Logitech M185 Wireless Mouse',
  currentPrice = 'KRW&nbsp;13,413' } = {}) =>
  `<div data-asin="${asin}"><h2><span>${title}</span></h2>` +
  `<a href="/dp/${asin}/ref=search?tag=removed-20">View</a>` +
  `<span class="a-price"><span class="a-offscreen">${currentPrice}</span></span>` +
  '<span class="a-price a-text-price"><span class="a-offscreen">KRW&nbsp;21,490</span></span>' +
  '<img class="s-image" src="https://m.media-amazon.com/images/I/example.jpg"></div>';

function stream({ asin = 'B004YAVF8I', hrefAsin = asin, page = 2, count = 1,
  currentPrice = 'KRW&nbsp;13,413' } = {}) {
  return [
    frame('data-search-metadata', { metadata: { keywords: 'wireless mouse', page,
      asinOnPageCount: count, totalResultCount: 33000, marketplaceId: 'ATVPDKIKX0DER', locale: 'en_US' } }),
    frame('data-title-and-meta', { title: 'Amazon.com: Wireless Mouse', html: '' }),
    frame('data-main-slot:search-result-1', { asin, index: 1,
      html: cardHtml({ asin: hrefAsin, currentPrice }), data: {} }),
  ].join('\n&&&\n');
}

test('parses product identity, displayed prices and thumbnail from observed streaming frame shape', () => {
  const result = parseAmazonSearchStream(stream(), { query: 'wireless mouse', page: 2 });
  assert.equal(result.resultCountVerified, true);
  assert.equal(result.reportedAsinsOnPage, 1);
  assert.deepEqual(result.items[0], {
    asin: 'B004YAVF8I', title: 'Logitech M185 Wireless Mouse',
    productUrl: 'https://www.amazon.com/dp/B004YAVF8I',
    thumbnailUrl: 'https://m.media-amazon.com/images/I/example.jpg',
    currentDisplayPrice: { displayText: 'KRW 13,413', amount: '13413', currencyCode: 'KRW', currencyCodeExplicit: true, currencyVerified: true },
    struckDisplayPrice: { displayText: 'KRW 21,490', amount: '21490', currencyCode: 'KRW', currencyCodeExplicit: true, currencyVerified: true },
    priceBasis: 'displayed_search_card',
    resultIndex: 1,
  });
});

test('mismatched card identity is partial and page metadata mismatch fails', () => {
  const mismatched = parseAmazonSearchStream(stream({ hrefAsin: 'B005EJH6Z4' }),
    { query: 'wireless mouse', page: 2 });
  assert.equal(mismatched.partial, true);
  assert.equal(mismatched.items.length, 0);
  assert.throws(() => parseAmazonSearchStream(stream({ page: 3 }),
    { query: 'wireless mouse', page: 2 }), { code: 'AMAZON_SEARCH_METADATA_MISMATCH' });
});

test('metadata may count additional page ASINs beyond validated main-result frames', () => {
  const result = parseAmazonSearchStream(stream({ count: 22 }), { query: 'wireless mouse', page: 2 });
  assert.equal(result.reportedAsinsOnPage, 22);
  assert.equal(result.namedResultFrameCount, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.mainResultFrameCountMatched, true);
  assert.equal(result.resultCountVerified, false);
  assert.equal(result.partial, true);
  assert.equal(result.allAsinsOnPageCovered, false);
});

test('an empty page is observed but does not prove terminal pagination', () => {
  const empty = [
    frame('data-search-metadata', { metadata: { keywords: 'wireless mouse', page: 20,
      asinOnPageCount: 0, totalResultCount: 89000, marketplaceId: 'ATVPDKIKX0DER' } }),
    frame('data-title-and-meta', { title: 'Amazon.com: Wireless Mouse', html: '' }),
  ].join('\n&&&\n');
  const result = parseAmazonSearchStream(empty, { query: 'wireless mouse', page: 20 });
  assert.equal(result.emptyPageObserved, true);
  assert.equal(result.paginationTerminationVerified, false);
  assert.equal(result.items.length, 0);
});

test('generic main slot cards do not enter product search results', () => {
  const generic = [
    frame('data-search-metadata', { metadata: { keywords: 'wireless mouse', page: 2,
      asinOnPageCount: 1, marketplaceId: 'ATVPDKIKX0DER' } }),
    frame('data-title-and-meta', { title: 'Amazon.com: Wireless Mouse', html: '' }),
    frame('data-main-slot', { asin: 'B004YAVF8I', html: cardHtml(), index: 1, data: {} }),
  ].join('\n&&&\n');
  const result = parseAmazonSearchStream(generic, { query: 'wireless mouse', page: 2 });
  assert.equal(result.items.length, 0);
  assert.equal(result.partial, true);
});

test('ambiguous currency and price ranges keep display text without invented currency or scalar amount', () => {
  const ambiguous = parseAmazonSearchStream(stream({ currentPrice: '$12.50' }),
    { query: 'wireless mouse', page: 2 }).items[0].currentDisplayPrice;
  assert.deepEqual(ambiguous, { displayText: '$12.50', amount: '12.50', currencyCode: null,
    currencyCodeExplicit: false, currencyVerified: false });
  const range = parseAmazonSearchStream(stream({ currentPrice: 'KRW 10,000 - KRW 20,000' }),
    { query: 'wireless mouse', page: 2 }).items[0].currentDisplayPrice;
  assert.deepEqual(range, { displayText: 'KRW 10,000 - KRW 20,000', amount: null,
    currencyCode: null, currencyCodeExplicit: false, currencyVerified: false });
  const unsupportedCode = parseAmazonSearchStream(stream({ currentPrice: 'ZZZ 12.50' }),
    { query: 'wireless mouse', page: 2 }).items[0].currentDisplayPrice;
  assert.deepEqual(unsupportedCode, { displayText: 'ZZZ 12.50', amount: '12.50',
    currencyCode: null, currencyCodeExplicit: true, currencyVerified: false });
});

test('client sends only the observed anonymous XHR contract', async () => {
  let called;
  const client = createAmazonPublicClient({ fetchImpl: async (url, init) => {
    called = { url, init };
    return new Response(stream(), { status: 200, headers: { 'content-type': MIME } });
  } });
  const result = await client.searchProducts({ query: 'wireless mouse', page: 2 });
  assert.equal(called.url, 'https://www.amazon.com/s/query?k=wireless+mouse&page=2');
  assert.equal(called.init.method, 'POST');
  assert.equal(called.init.redirect, 'manual');
  assert.equal(called.init.credentials, 'omit');
  assert.equal(called.init.body, '{"customer-action":"pagination"}');
  assert.equal(called.init.headers.accept, 'text/html,image/webp,*/*');
  assert.equal(called.init.headers.origin, 'https://www.amazon.com');
  assert.equal(Object.keys(called.init.headers).some(key => /cookie|authorization/i.test(key)), false);
  assert.equal(result.receipt.anonymous, true);
  assert.equal(result.receipt.expectedResultVerified, true);
  assert.equal(result.items.length, 1);
});

test('200 challenge HTML and invalid stream cannot count as application success', async () => {
  const challenge = createAmazonPublicClient({ fetchImpl: async () =>
    new Response('<title>Amazon.com</title>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(challenge.searchProducts({ query: 'wireless mouse' }),
    { code: 'AMAZON_RESPONSE_NOT_XHR' });
  assert.throws(() => parseAmazonSearchStream('[]&&&not-json', { query: 'wireless mouse', page: 2 }),
    { code: 'AMAZON_SEARCH_STREAM_INVALID' });
});

test('query and page limits reject unbounded anonymous requests', async () => {
  const client = createAmazonPublicClient({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(client.searchProducts({ query: '', page: 1 }), { code: 'AMAZON_SEARCH_QUERY_INVALID' });
  await assert.rejects(client.searchProducts({ query: 'mouse', page: 21 }), { code: 'AMAZON_SEARCH_PAGE_INVALID' });
});
