import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { searchYanoljaAccommodation } from './seller-adapters/yanolja-search.mjs';

const fixture = await readFile(new URL('./fixtures/yanolja-hotel-search-results-gangneung-trimmed.html', import.meta.url), 'utf8');

function missingTitleFixture({ keepValidCard = false } = {}) {
  const document = new JSDOM(fixture).window.document;
  const card = document.querySelector('a[href*="/stay/domestic/"]');
  assert.ok(card, 'fixture contains an observed accommodation card');
  const validCard = keepValidCard ? card.cloneNode(true) : null;
  if (validCard) {
    const url = new URL(validCard.getAttribute('href'), 'https://nol.yanolja.com');
    url.pathname = url.pathname.replace(/\/\d+\/?$/, '/99999999');
    validCard.setAttribute('href', url.href);
  }
  card.removeAttribute('aria-label');
  for (const node of card.querySelectorAll('[aria-label^="상품명 "]')) node.removeAttribute('aria-label');
  for (const node of card.querySelectorAll('div[class*="mb-4"][class*="line-clamp-1"], div[class*="pc:px-4"] > div')) node.remove();
  if (validCard) document.body.append(validCard);
  return document.documentElement.outerHTML;
}

function currentTitleDomFixture() {
  const document = new JSDOM(fixture).window.document;
  const expectedTitleHashes = [];
  for (const card of document.querySelectorAll('a[href*="/stay/domestic/"]')) {
    const titleNode = [...card.querySelectorAll('[aria-label]')]
      .find(node => node.getAttribute('aria-label')?.startsWith('상품명 '));
    const title = titleNode?.getAttribute('aria-label')?.replace(/^상품명\s*/, '') ?? '';
    assert.ok(title, 'fixture title is sourced from an observed product-name label');
    expectedTitleHashes.push(createHash('sha256').update(title).digest('hex'));
    card.removeAttribute('aria-label');
    for (const node of card.querySelectorAll('[aria-label^="상품명 "]')) node.removeAttribute('aria-label');
    for (const node of card.querySelectorAll('div[class*="mb-4"][class*="line-clamp-1"], div[class*="pc:px-4"] > div')) node.remove();
    const titleSpan = document.createElement('span');
    titleSpan.className = 'line-clamp-2 typography-subtitle-16-bold';
    titleSpan.textContent = title;
    card.append(titleSpan);
  }
  return { html: document.documentElement.outerHTML, expectedTitleHashes };
}

test('search API returns the observed q-only anonymous Document results and a bounded receipt', async () => {
  let call;
  const result = await searchYanoljaAccommodation({
    keyword: ' 강릉 ',
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(fixture, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  const requested = new URL(call.url);

  assert.deepEqual(Object.keys(result).sort(), ['items', 'receipt', 'source']);
  assert.equal(result.source.sourceId, 'yanolja-accommodation-search-document');
  assert.equal(result.source.authentication, 'anonymous');
  assert.equal(requested.origin, 'https://nol.yanolja.com');
  assert.equal(requested.pathname, '/discovery/list/search/PRODUCT_CATEGORY_KOREA_ACCOMMODATION');
  assert.deepEqual([...requested.searchParams.keys()], ['q']);
  assert.equal(requested.searchParams.get('q'), '강릉');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.headers.cookie, undefined);
  assert.equal(call.options.headers.authorization, undefined);
  assert.equal(call.options.headers['user-agent'], undefined);

  assert.equal(result.receipt.status, 'usable_html');
  assert.deepEqual(result.receipt.counts, {
    totalResultCount: 898,
    sourceItemCount: 1,
    returnedItemCount: 1,
    excludedInvalidItemCount: 0,
    invalidItemReasons: {},
    pricedItemCount: 1,
    discountedItemCount: 1,
  });
  assert.deepEqual(result.receipt.coverage, {
    page: 1,
    totalPages: 45,
    isLastPage: false,
    fetchedPages: [1],
    paginationReplayed: false,
    pageTwoStatus: 'not requested; page request contract not captured',
    sourceItemCount: 1,
    returnedValidItemCount: 1,
    excludedInvalidItemCount: 0,
    schemaPartial: false,
    schemaPartialReasons: [],
    completeCatalog: false,
  });
  assert.deepEqual(result.receipt.schemaValidation, {
    inputScope: 'parsed_product_cards_after_url_filter',
    sourceItemCount: 1,
    validItemCount: 1,
    excludedInvalidItemCount: 0,
    invalidReasons: {},
  });
  assert.equal(result.receipt.request.explicitDates, false);
  assert.equal(result.receipt.request.explicitTravellerCounts, false);
  assert.equal(result.receipt.observedResultContext.checkInDate, '2026-10-05');
  assert.equal(result.receipt.observedResultContext.checkOutDate, '2026-10-06');
  assert.equal(result.receipt.observedResultContext.adultCount, 2);
  assert.equal(result.receipt.observedResultContext.childCount, null);
  assert.equal(result.receipt.priceSemantics.totalVsNightly, 'unknown');
  assert.equal(result.receipt.priceSemantics.taxesIncluded, null);
  assert.equal(result.receipt.priceSemantics.feesIncluded, null);
  assert.equal(result.receipt.apiCandidates.accommodationListV2.xhrCaptured, false);
  assert.equal(result.receipt.apiCandidates.autocomplete.usableEndpointCaptured, false);
  assert.equal(result.receipt.challengeScan.performed, true);
  assert.equal(result.receipt.challengeScan.detected, false);
  assert.match(result.receipt.challengeSignals, /none detected/);
  assert.equal(result.items[0].detailUrl, 'https://nol.yanolja.com/stay/domestic/3013417?adultCount=2&checkInDate=2026-10-05&checkOutDate=2026-10-06&srpKeyword=%EA%B0%95%EB%A6%89');
  assert.equal(result.items[0].prices[0].taxesIncluded, null);
});

test('current observed product-name span is parsed without title inference from other fields', async () => {
  const { html, expectedTitleHashes } = currentTitleDomFixture();
  const result = await searchYanoljaAccommodation({
    keyword: '강릉',
    fetchImpl: async () => new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });

  assert.equal(result.receipt.status, 'usable_html');
  assert.equal(result.receipt.counts.sourceItemCount, expectedTitleHashes.length);
  assert.equal(result.receipt.counts.returnedItemCount, expectedTitleHashes.length);
  assert.deepEqual(result.items.map(item => createHash('sha256').update(item.title).digest('hex')), expectedTitleHashes);
});

test('one card without a title is excluded while valid cards remain as a partial read', async () => {
  const result = await searchYanoljaAccommodation({
    keyword: '강릉',
    fetchImpl: async () => new Response(missingTitleFixture({ keepValidCard: true }), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });

  assert.equal(result.receipt.response.status, 200);
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.items.length, 1);
  assert.equal(typeof result.items[0].title, 'string');
  assert.deepEqual(result.receipt.schemaValidation, {
    inputScope: 'parsed_product_cards_after_url_filter',
    sourceItemCount: 2,
    validItemCount: 1,
    excludedInvalidItemCount: 1,
    invalidReasons: { title_missing: 1 },
  });
  assert.equal(result.receipt.coverage.schemaPartial, true);
  assert.deepEqual(result.receipt.coverage.schemaPartialReasons, ['invalid_cards_excluded']);
  assert.equal(result.receipt.coverage.completeCatalog, false);
});

test('all-invalid cards fail with numeric schema diagnostics rather than an empty success', async () => {
  await assert.rejects(
    searchYanoljaAccommodation({
      keyword: '강릉',
      fetchImpl: async () => new Response(missingTitleFixture(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    }),
    error => error.code === 'YANOLJA_SEARCH_SCHEMA_INVALID'
      && error.metadata.status === 200
      && error.metadata.schemaValidation.sourceItemCount === 1
      && error.metadata.schemaValidation.validItemCount === 0
      && error.metadata.schemaValidation.excludedInvalidItemCount === 1
      && error.metadata.schemaValidation.invalidReasons.title_missing === 1,
  );
});

test('an empty result document remains a failure instead of being reported as usable', async () => {
  const document = new JSDOM(fixture).window.document;
  for (const card of document.querySelectorAll('a[href*="/stay/domestic/"]')) card.remove();
  const countHeading = [...document.querySelectorAll('h1,h2,h3,h4')]
    .find(node => /^\d[\d,]*개\s*검색결과$/.test(node.textContent.trim()));
  if (countHeading) countHeading.textContent = '0개 검색결과';

  await assert.rejects(
    searchYanoljaAccommodation({
      keyword: '강릉',
      fetchImpl: async () => new Response(document.documentElement.outerHTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    }),
    error => error.code === 'HTML_LAYOUT_CHANGED',
  );
});

test('an HTTP rejection remains a blocked request with its safe status metadata', async () => {
  await assert.rejects(
    searchYanoljaAccommodation({
      keyword: '강릉',
      fetchImpl: async () => new Response('blocked', {
        status: 403,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    }),
    error => error.code === 'YANOLJA_HOTEL_DOCUMENT_UNAVAILABLE'
      && error.metadata.status === 403
      && error.metadata.challengeScan.performed === false,
  );
});

test('search refuses unsupported date, traveller, and paging inputs instead of ignoring them', async () => {
  let requested = false;
  await assert.rejects(
    searchYanoljaAccommodation({ keyword: '강릉', checkInDate: '2026-10-20', adultCount: 1,
      fetchImpl: async () => { requested = true; return new Response(fixture); } }),
    error => error.code === 'YANOLJA_SEARCH_OPTION_UNSUPPORTED',
  );
  await assert.rejects(
    searchYanoljaAccommodation({ keyword: '강릉', page: 2 }),
    error => error.code === 'YANOLJA_SEARCH_OPTION_UNSUPPORTED',
  );
  assert.equal(requested, false);
});

test('search enforces the observed input limit and the bounded HTTP timeout', async () => {
  await assert.rejects(searchYanoljaAccommodation({ keyword: '가'.repeat(51) }),
    error => error.code === 'YANOLJA_SEARCH_KEYWORD_TOO_LONG');
  await assert.rejects(searchYanoljaAccommodation({ keyword: '😀'.repeat(26) }),
    error => error.code === 'YANOLJA_SEARCH_KEYWORD_TOO_LONG');
  await assert.rejects(searchYanoljaAccommodation({ keyword: '강릉', timeoutMs: 30_001 }),
    error => error.code === 'YANOLJA_SEARCH_OPTION_INVALID');
});
