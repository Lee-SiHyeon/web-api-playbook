import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { searchYanoljaAccommodation } from './seller-adapters/yanolja-search.mjs';

const fixture = await readFile(new URL('./fixtures/yanolja-hotel-search-results-gangneung-trimmed.html', import.meta.url), 'utf8');

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
    returnedItemCount: 1,
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
