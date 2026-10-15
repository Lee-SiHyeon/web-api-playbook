import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAmazonNavigation, amazonSecondLayerInput, amazonNavigationDestination, createAmazonNavigationClient } from '../lib/retail/amazon-navigation.mjs';
import { parseAmazonSearchStream } from '../lib/retail/amazon.mjs';
import { crawlAmazonSearch } from '../lib/retail/amazon-crawl.mjs';
const first = await readFile(new URL('./fixtures/amazon/menu-first.html', import.meta.url), 'utf8');
const second = await readFile(new URL('./fixtures/amazon/menu-second.html', import.meta.url), 'utf8');

test('observed menu graph binds returned IDs and preserves shared incoming edges', () => {
  const result = parseAmazonNavigation(first, second);
  assert.equal(result.menus.length, 37);
  assert.equal(result.returnedMenuReferencesResolved, true);
  assert.equal(result.completeCatalog, false);
  const electronics = result.menus.find(m => m.title === 'Electronics');
  const headphones = result.edges.find(e => e.from === electronics.id && e.label === 'Headphones');
  assert.equal(result.destinations.find(d => d.id === headphones.to).url, 'https://www.amazon.com/gp/browse.html?node=172541');
  assert.ok(result.edges.length > result.destinations.length);
  assert.equal(JSON.stringify(result).includes('nav_em_'), false);
});

test('menu request derives the second layer only from this first response', async () => {
  const calls = [];
  const client = createAmazonNavigationClient({ fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ data: calls.length === 1 ? first : second }), { headers: { 'content-type': 'application/json' } });
  } });
  const result = await client.getNavigation();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].url.searchParams.get('secondLayerTreeName').split('+'), amazonSecondLayerInput(first).names);
  assert.equal(calls.every(c => !new Headers(c.init.headers).has('cookie')), true);
  assert.equal(calls.some(c => c.url.searchParams.has('hashCustomerAndSessionId')), false);
  assert.equal(result.receipts.every(r => r.cookieSent === false), true);
});

test('menu declaration exposes only allowlisted public inputs and never executes source', () => {
  const html = `<script>$Nav.declare('HMenuSecondLayerVariables', {"isPrime":"0","isSmile":"0","secondLayerTreeName":["electronics"],"slt":"secret-fixture"}); throw new Error('must not execute');</script>`;
  assert.deepEqual(amazonSecondLayerInput(html), { names: ['electronics'], isPrime: '0', isSmile: '0' });
  assert.throws(() => amazonSecondLayerInput(html.replace('"electronics"', '"a+b"')), { code: 'AMAZON_MENU_INPUT_INVALID' });
  assert.throws(() => parseAmazonNavigation('<div>No menu</div>', second), { code: 'AMAZON_MENU_LAYOUT_CHANGED' });
  assert.equal(amazonNavigationDestination('https://other.test/account?token=secret').fetchAllowed, false);
  assert.equal(amazonNavigationDestination('javascript:alert(1)'), null);
});

test('menu challenge response fails once before a second request', async () => {
  let calls = 0;
  const client = createAmazonNavigationClient({ fetchImpl: async () => { calls++; return new Response('<h1>Challenge</h1>', { status: 200, headers: { 'content-type': 'text/html' } }); } });
  await assert.rejects(client.getNavigation(), { code: 'AMAZON_MENU_HTTP_FAILED' });
  assert.equal(calls, 1);
});

function stream(pagination) {
  return [
    ['dispatch', 'data-search-metadata', { metadata: { keywords: 'mouse', page: 1, marketplaceId: 'ATVPDKIKX0DER', asinOnPageCount: 0 } }],
    ['dispatch', 'data-title-and-meta', { title: 'Amazon: mouse' }],
    ['dispatch', 'data-main-slot', { html: pagination }],
  ].map(JSON.stringify).join('&&&');
}
test('pagination follows only the matching next link; explicit disabled control establishes termination', () => {
  const parse = html => parseAmazonSearchStream(stream(html), { query: 'mouse', page: 1 });
  assert.deepEqual(parse('<a class="s-pagination-next" href="/s?k=mouse&amp;page=2&amp;qid=discarded">Next</a>').pagination,
    { observed: true, hasNext: true, nextPage: 2, terminationVerified: false });
  assert.equal(parse('<span class="s-pagination-next s-pagination-disabled">Next</span>').paginationTerminationVerified, true);
  assert.equal(parse('<div>No pagination</div>').paginationTerminationVerified, false);
  for (const href of ['https://foreign.test/s?k=mouse&amp;page=2', '/s?k=other&amp;page=2', '/s?k=mouse&amp;page=1']) {
    assert.throws(() => parse(`<a class="s-pagination-next" href="${href}">Next</a>`), { code: 'AMAZON_SEARCH_PAGINATION_MISMATCH' });
  }
});

test('crawl saves and resumes an observed next page without refetching completed pages', async () => {
  const calls = [];
  const client = { async searchProducts({ query, page }) { calls.push(page); return { query, page, items: [{ asin: `B00000000${page}` }],
    mainResultFrameCountMatched: true, pagination: { hasNext: page < 3, nextPage: page < 3 ? page + 1 : null, terminationVerified: page === 3 } }; } };
  const firstRun = await crawlAmazonSearch({ query: 'mouse', maxPages: 2, client });
  assert.equal(firstRun.stopReason, 'request_budget');
  assert.equal(firstRun.nextPage, 3);
  const resumed = await crawlAmazonSearch({ query: 'mouse', checkpoint: firstRun.checkpoint, client });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(resumed.paginationTerminationVerified, true);
  assert.equal(resumed.wholeQueryMainCardsComplete, false);
  assert.equal(resumed.completeCatalog, false);
  await assert.rejects(crawlAmazonSearch({ query: 'other', checkpoint: firstRun.checkpoint, client }), { code: 'AMAZON_CRAWL_CHECKPOINT_INVALID' });
});

test('failed crawl keeps its failed page pending and does not retry', async () => {
  let calls = 0;
  const result = await crawlAmazonSearch({ query: 'mouse', client: { async searchProducts() { calls++; throw Object.assign(new Error(), { code: 'AMAZON_HTTP_FAILED', status: 403 }); } } });
  assert.equal(calls, 1); assert.equal(result.pagesRead, 0);
  assert.equal(result.checkpoint.nextPage, 1); assert.equal(result.stopReason, 'read_failed');
  assert.equal(result.failure.status, 403);
});
