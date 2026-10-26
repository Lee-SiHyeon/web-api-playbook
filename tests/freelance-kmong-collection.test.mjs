import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KmongCollectionError,
  createKmongCollector,
  validateKmongCollectionState,
} from '../lib/freelance/kmong-collection.mjs';

const NOW = Date.parse('2026-10-26T08:00:00.000Z');

function receipt(page, kind = 'search') {
  const path = kind === 'search'
    ? '/gig-app/gig/v2/gigs/search'
    : '/order-app/order/v1/reviews/gigs/70001';
  const origin = 'https://api.kmong.com';
  return {
    method: 'GET', origin, path,
    queryFields: kind === 'search' ? ['keyword', 'page', 'perPage'] : ['page', 'perPage', 'sortType'],
    observedAt: new Date(NOW + page * 1_000).toISOString(),
    browserUsed: false, authenticated: false, credentialsUsed: false, cookiesSent: false, readOnly: true,
    httpStatus: 200, mime: 'application/json', responseURL: origin + path, redirectFollowed: false,
    responseBytes: 300, responseSha256: String(page).repeat(64).slice(0, 64),
    contractProvenance: { kind: 'first_party_bundle', sourceURL: 'https://kmong.com/_next-market-desktop/_next/static/chunks/0g7pmw2wpij3i.js' },
  };
}

function gig(id) {
  return {
    id: String(id), title: '상세페이지 디자인 ' + id, url: 'https://kmong.com/gig/' + id,
    startingPrice: { amount: 50_000, currency: 'KRW', basis: 'displayed_starting_price', exactCheckoutAmount: false },
    reviewSummary: { average: 4.9, count: 23, source: 'search_gig_review_summary' },
    isPrime: false, isQualityGuaranteed: false, hasPackages: true, hasVideos: false,
  };
}

function searchPage({ page, lastPage, totalItemCount, items, keyword = '상세페이지', totalOverride }) {
  return {
    schemaVersion: 1, service: 'kmong', operation: 'search', observedAt: new Date(NOW + page * 1_000).toISOString(),
    keyword, items,
    pagination: {
      page, pageSize: 40, totalItemCount: totalOverride ?? totalItemCount, lastPage,
      complete: false, endReached: page === lastPage, nextPage: page === lastPage ? null : page + 1, pageWalked: false,
    },
    requests: [receipt(page)],
    contractProvenance: { kind: 'first_party_bundle' },
  };
}

function review(id, body, createdAt = '2026-10-20') {
  return { rating: 5, body, createdAt };
}

function reviewsPage({ page, lastPage, totalItemCount, items, gigId = '70001' }) {
  return {
    schemaVersion: 1, service: 'kmong', operation: 'reviews', observedAt: new Date(NOW + page * 1_000).toISOString(),
    gigId, items,
    pagination: {
      page, pageSize: 5, totalItemCount, lastPage, complete: false,
      endReached: page === lastPage, nextPage: page === lastPage ? null : page + 1, pageWalked: false,
    },
    requests: [
      { ...receipt(page, 'reviews'), origin: 'https://kmong.com', path: '/gig/' + gigId,
        responseURL: 'https://kmong.com/gig/' + gigId, mime: 'text/html',
        contractProvenance: { kind: 'first_party_document', sourceURL: 'https://kmong.com/gig/' + gigId } },
      receipt(page, 'reviews'),
    ],
    contractProvenance: { kind: 'first_party_document' },
  };
}

const quietCollector = client => createKmongCollector({ client, now: () => NOW, sleepImpl: async () => {} });
const fortyGigs = Array.from({ length: 40 }, (_, index) => gig(1000 + index));
const fiveReviews = Array.from({ length: 5 }, (_, index) => review(index, 'Review body ' + index));

test('collects a stable two-page search window and marks the catalogue boundary explicitly', async () => {
  const calls = [];
  const client = {
    search: async request => {
      calls.push(request.page);
      return request.page === 1
        ? searchPage({ page: 1, lastPage: 2, totalItemCount: 41, items: fortyGigs })
        : searchPage({ page: 2, lastPage: 2, totalItemCount: 41, items: [gig(2000)] });
    },
    reviews: async () => assert.fail('unexpected review request'),
  };
  const result = await quietCollector(client).collectSearch({ keyword: '상세페이지', maxPages: 2 });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.status, 'complete');
  assert.equal(result.items.length, 41);
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.sourceWindowComplete, true);
  assert.equal(result.pagination.completeCatalog, false);
  assert.equal(result.pagination.nextPage, null);
  assert.equal(result.state.complete, true);
  assert.equal(result.requests.length, 2);
  assert.equal(result.currentRequests.length, 2);
  assert.equal(result.newPages.length, 2);
  assert.equal(result.networkUsed, true);
  assert.equal(result.requests.every(request => request.cookiesSent === false && request.credentialsUsed === false), true);
});

test('resumes a partial search after a JSON roundtrip in a fresh collector instance', async () => {
  let secondPageCalls = 0;
  const client = {
    search: async request => {
      if (request.page === 1) return searchPage({ page: 1, lastPage: 2, totalItemCount: 41, items: fortyGigs });
      secondPageCalls++;
      return searchPage({ page: 2, lastPage: 2, totalItemCount: 41, items: [gig(2001)] });
    },
    reviews: async () => assert.fail('unexpected review request'),
  };
  const first = await quietCollector(client).collectSearch({ keyword: ' 상세페이지 ', maxPages: 1 });
  assert.equal(first.status, 'partial');
  assert.equal(first.pagination.nextPage, 2);
  assert.equal(first.state.scope.keyword, '상세페이지');
  const roundTripped = JSON.parse(JSON.stringify(first.state));
  assert.equal(validateKmongCollectionState(roundTripped, {
    operation: 'search', scope: { keyword: '상세페이지', pageSize: 40 },
  }), true);

  const resumed = await quietCollector(client).collectSearch({ keyword: '상세페이지', maxPages: 1, state: roundTripped });
  assert.equal(secondPageCalls, 1);
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.items.length, 41);
  assert.equal(resumed.pages.length, 2);
});

test('rejects cross-keyword and cross-gig checkpoints before any client request', async () => {
  let calls = 0;
  const client = {
    search: async request => {
      calls++;
      return searchPage({ page: request.page, lastPage: 2, totalItemCount: 41, items: fortyGigs });
    },
    reviews: async request => {
      calls++;
      return reviewsPage({ page: request.page, lastPage: 2, totalItemCount: 6, items: fiveReviews });
    },
  };
  const collector = quietCollector(client);
  const searchState = (await collector.collectSearch({ keyword: 'A', maxPages: 1 })).state;
  const reviewState = (await collector.collectReviews({ id: '70001', maxPages: 1 })).state;
  const priorCalls = calls;
  await assert.rejects(collector.collectSearch({ keyword: 'B', state: searchState }), error =>
    error instanceof KmongCollectionError && error.code === 'KMONG_COLLECTION_STATE_SCOPE_MISMATCH');
  await assert.rejects(collector.collectReviews({ id: '70002', state: reviewState }), error =>
    error instanceof KmongCollectionError && error.code === 'KMONG_COLLECTION_STATE_SCOPE_MISMATCH');
  assert.equal(calls, priorCalls);
});

test('stops incomplete on duplicate IDs, duplicate review fingerprints, or changing source totals', async () => {
  const duplicateGigClient = {
    search: async request => request.page === 1
      ? searchPage({ page: 1, lastPage: 2, totalItemCount: 41, items: fortyGigs })
      : searchPage({ page: 2, lastPage: 2, totalItemCount: 41, items: [fortyGigs[0]] }),
    reviews: async () => assert.fail('unexpected review request'),
  };
  const duplicateGig = await quietCollector(duplicateGigClient).collectSearch({ keyword: '상세페이지', maxPages: 2 });
  assert.equal(duplicateGig.status, 'unstable');
  assert.equal(duplicateGig.pagination.complete, false);
  assert.equal(duplicateGig.pagination.resumable, false);
  assert.ok(duplicateGig.issues.some(issue => issue.code === 'DUPLICATE_GIG_ID'));
  await assert.rejects(quietCollector(duplicateGigClient).collectSearch({
    keyword: '상세페이지', state: duplicateGig.state,
  }), error => error.code === 'KMONG_COLLECTION_RESUME_DISABLED');

  const driftClient = {
    search: async request => request.page === 1
      ? searchPage({ page: 1, lastPage: 2, totalItemCount: 41, items: fortyGigs })
      : searchPage({ page: 2, lastPage: 2, totalItemCount: 42, totalOverride: 42, items: [gig(3000)] }),
    reviews: async () => assert.fail('unexpected review request'),
  };
  const drift = await quietCollector(driftClient).collectSearch({ keyword: '상세페이지', maxPages: 2 });
  assert.equal(drift.status, 'unstable');
  assert.equal(drift.pagination.complete, false);
  assert.ok(drift.issues.some(issue => issue.code === 'SOURCE_PAGINATION_DRIFT'));

  const duplicateReviewClient = {
    search: async () => assert.fail('unexpected search request'),
    reviews: async request => request.page === 1
      ? reviewsPage({ page: 1, lastPage: 2, totalItemCount: 6, items: fiveReviews })
      : reviewsPage({ page: 2, lastPage: 2, totalItemCount: 6, items: [review(9, fiveReviews[0].body)] }),
  };
  const duplicateReview = await quietCollector(duplicateReviewClient).collectReviews({ id: '70001', maxPages: 2 });
  assert.equal(duplicateReview.status, 'unstable');
  assert.equal(duplicateReview.pagination.complete, false);
  assert.ok(duplicateReview.issues.some(issue => issue.code === 'DUPLICATE_REVIEW_FINGERPRINT'));
  assert.match(duplicateReview.limitations[0], /cannot prove global uniqueness or identify reviewers/);
});

test('keeps the successful checkpoint when a later page fails, then resumes at that page without replay loss', async () => {
  let pageTwoCalls = 0;
  const client = {
    search: async request => {
      if (request.page === 1) return searchPage({ page: 1, lastPage: 2, totalItemCount: 41, items: fortyGigs });
      pageTwoCalls++;
      if (pageTwoCalls === 1) {
        const error = new Error('do not expose raw error text');
        error.code = 'KMONG_HTTP_TIMEOUT';
        error.receipt = {
          method: 'GET', origin: 'https://api.kmong.com', path: '/gig-app/gig/v2/gigs/search',
          queryFields: ['keyword', 'page', 'perPage'], observedAt: new Date(NOW + 2_000).toISOString(),
          browserUsed: false, authenticated: false, credentialsUsed: false, cookiesSent: false, readOnly: true,
          contractProvenance: { kind: 'first_party_bundle', sourceURL: 'https://kmong.com/_next-market-desktop/_next/static/chunks/0g7pmw2wpij3i.js' },
          causeCode: 'TIMEOUT',
        };
        throw error;
      }
      return searchPage({ page: 2, lastPage: 2, totalItemCount: 41, items: [gig(4000)] });
    },
    reviews: async () => assert.fail('unexpected review request'),
  };
  const collector = quietCollector(client);
  const failed = await collector.collectSearch({ keyword: '상세페이지', maxPages: 2 });
  assert.equal(failed.status, 'partial');
  assert.equal(failed.error.code, 'KMONG_HTTP_TIMEOUT');
  assert.equal(failed.state.nextPage, 2);
  assert.equal(failed.state.pages.length, 1);
  assert.equal(failed.state.items.length, 40);
  assert.equal(failed.state.attempts.length, 1);
  assert.equal(failed.state.resumeAllowed, true);
  assert.equal(failed.state.requests[1].redirectFollowed, null);
  assert.equal(Object.hasOwn(failed.state.requests[1], 'httpStatus'), false, 'a transport failure has no fabricated response status');
  assert.equal(JSON.stringify(failed).includes('do not expose raw error text'), false);

  const resumed = await quietCollector(client).collectSearch({ keyword: '상세페이지', maxPages: 1, state: failed.state });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.items.length, 41);
  assert.equal(resumed.pages.length, 2);
  assert.equal(resumed.requests.length, 3);
});

test('a final page by itself cannot establish completion', async () => {
  const pageTwoOnly = {
    schemaVersion: 1, service: 'kmong', operation: 'search',
    scope: { keyword: '상세페이지', pageSize: 40 }, items: [gig(5000)],
    pages: [{ page: 2, pageSize: 40, totalItemCount: 41, lastPage: 2, itemCount: 1,
      observedAt: new Date(NOW).toISOString(), requestIndexes: [] }],
    requests: [], attempts: [], issues: [], nextPage: 3, totalItemCount: 41, lastPage: 2,
    complete: true, resumeAllowed: false,
  };
  let calls = 0;
  const collector = quietCollector({
    search: async () => { calls++; return null; },
    reviews: async () => assert.fail('unexpected review request'),
  });
  await assert.rejects(collector.collectSearch({ keyword: '상세페이지', state: pageTwoOnly }), error =>
    error instanceof KmongCollectionError && /^KMONG_COLLECTION_STATE_/.test(error.code));
  assert.equal(calls, 0);

  const firstPageOnly = await quietCollector({
    search: async () => searchPage({ page: 1, lastPage: 2, totalItemCount: 41, items: fortyGigs }),
    reviews: async () => assert.fail('unexpected review request'),
  }).collectSearch({ keyword: '상세페이지', maxPages: 1 });
  assert.equal(firstPageOnly.status, 'partial');
  assert.equal(firstPageOnly.pagination.complete, false);
  assert.equal(firstPageOnly.pagination.lastPage, 2);
});

test('collects and resumes bounded review pages while retaining no reviewer identifiers', async () => {
  const client = {
    search: async () => assert.fail('unexpected search request'),
    reviews: async request => request.page === 1
      ? reviewsPage({ page: 1, lastPage: 2, totalItemCount: 6, items: fiveReviews })
      : reviewsPage({ page: 2, lastPage: 2, totalItemCount: 6, items: [review(6, 'A separate review')] }),
  };
  const first = await quietCollector(client).collectReviews({ id: '70001', maxPages: 1 });
  assert.equal(first.status, 'partial');
  assert.equal(first.items.length, 5);
  assert.equal(first.pagination.complete, false);
  const resumed = await quietCollector(client).collectReviews({
    id: '70001', maxPages: 1, state: JSON.parse(JSON.stringify(first.state)),
  });
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.items.length, 6);
  assert.equal(resumed.newPages.length, 1);
  assert.equal(resumed.currentRequests.length, 2);
  assert.equal(resumed.networkUsed, true);
  assert.equal(JSON.stringify(resumed).includes('reviewerId'), false);
  assert.match(resumed.limitations[0], /cannot prove global uniqueness or identify reviewers/);
});

test('a caller supplied completed checkpoint makes no new live-observation claim', async () => {
  const original = await quietCollector({
    search: async () => searchPage({ page: 1, lastPage: 1, totalItemCount: 1, items: [gig(9000)] }),
    reviews: async () => assert.fail('unexpected review request'),
  }).collectSearch({ keyword: '상세페이지', maxPages: 1 });
  let calls = 0;
  const returned = await quietCollector({
    search: async () => { calls++; throw new Error('completed checkpoint must not fetch'); },
    reviews: async () => assert.fail('unexpected review request'),
  }).collectSearch({ keyword: '상세페이지', state: JSON.parse(JSON.stringify(original.state)) });
  assert.equal(calls, 0);
  assert.equal(returned.status, 'complete');
  assert.equal(returned.observedAt, null);
  assert.equal(returned.networkUsed, false);
  assert.equal(returned.checkpointProvenance, 'caller_supplied');
  assert.equal(returned.checkpointAuthenticated, false);
  assert.deepEqual(returned.newPages, []);
  assert.deepEqual(returned.currentRequests, []);
  assert.equal(returned.requests.length, 1);
});
