import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServiceRegistry, listServiceOperations } from '../lib/service-operations/index.mjs';
import { createKmongCollector } from '../lib/freelance/kmong-collection.mjs';

const at = Date.parse('2026-10-23T10:00:00Z');
const fixture = name => readFile(fileURLToPath(new URL(`./fixtures/freelance/${name}`, import.meta.url)), 'utf8');
const html = value => new Response(value, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

test('freelance operations are in the inventory without fetching or prompting for credentials', async () => {
  let calls = 0;
  const listing = await listServiceOperations({ includeUnconnected: false });
  const service = listing.services.find(item => item.id === 'freelance-public');
  assert.ok(service);
  assert.deepEqual(service.operations.sort(), [
    'kmong-categories', 'kmong-detail', 'kmong-home', 'kmong-reviews', 'kmong-reviews-collect',
    'kmong-search', 'kmong-search-collect',
    'soomgo-address-options', 'soomgo-categories', 'soomgo-pro-collect', 'soomgo-pro-search',
    'soomgo-profile', 'soomgo-profile-contents', 'soomgo-profile-portfolios', 'soomgo-profile-portfolios-collect', 'soomgo-profile-reviews',
    'soomgo-profile-reviews-collect',
    'soomgo-request-form', 'soomgo-request-prepare', 'soomgo-subcategories',
    'upwork-collect', 'upwork-job', 'upwork-search',
  ]);
  const metadata = await createServiceRegistry('freelance-public', {
    bind: false,
    fetchImpl: () => { calls++; throw new Error('inventory cannot make requests'); },
    credentialProvider: () => { calls++; throw new Error('inventory cannot request credentials'); },
  });
  await metadata.close();
  assert.equal(calls, 0);
});

test('Kmong detail uses the exact requested public gig and returns package prices with incomplete catalog scope', async () => {
  const page = await fixture('kmong-detail.html');
  const requests = [];
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.cookie, undefined);
      return html(page);
    } });
  try {
    const result = await registry.execute('kmong-detail', { path: { id: '70001' } });
    assert.equal(result.data.service, 'kmong');
    assert.equal(result.data.gig.id, '70001');
    assert.deepEqual(result.data.gig.packages.map(item => item.price.amount), [50_000, 90_000, 150_000]);
    assert.equal(result.data.gig.packages[0].price.currency, 'KRW');
    assert.equal(result.data.contractProvenance.kind, 'first_party_document');
    assert.equal(result.receipt.networkUsed, false, 'a fixture replay is not a live proof');
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).href, 'https://kmong.com/gig/70001');
    await assert.rejects(registry.execute('kmong-detail', { path: { id: '70002' } }),
      { code: 'KMONG_DETAIL_IDENTITY_MISMATCH' });
  } finally { await registry.close(); }
});

test('Kmong search keeps source price basis, exact IDs and one-page pagination', async () => {
  const page = JSON.parse(await fixture('kmong-search-page1.json'));
  let called = 0;
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      called++;
      assert.equal(new URL(url).origin, 'https://api.kmong.com');
      assert.equal(new URL(url).pathname, '/gig-app/gig/v2/gigs/search');
      assert.equal(new URL(url).searchParams.get('keyword'), '상세페이지');
      assert.equal(new URL(url).searchParams.get('page'), '1');
      assert.equal(new URL(url).searchParams.get('perPage'), '40');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('cookie'), null);
      return json(page);
    } });
  try {
    const result = await registry.execute('kmong-search', { query: { keyword: '상세페이지' } });
    assert.equal(result.data.items.length, page.gigs.length);
    assert.equal(result.data.pagination.pageSize, 40);
    assert.equal(result.data.pagination.totalItemCount, 1200);
    assert.equal(result.data.pagination.complete, false);
    assert.equal(result.data.pagination.nextPage, 2);
    assert.equal(result.data.items[0].startingPrice.currency, 'KRW');
    assert.equal(result.receipt.networkUsed, false);
    assert.equal(called, 1);
  } finally { await registry.close(); }
});

function searchGig(gigId) {
  return {
    gigId, title: '페이지 디자인 ' + gigId, price: 50_000,
    review: { reviewAverage: 4.9, reviewCount: 12 },
    isPrime: false, isQualityGuaranteed: false, hasPackages: true, hasVideos: false,
  };
}

function searchPayload(page, gigs, { lastPage = 2, totalItemCount = 41, keyword = '상세페이지' } = {}) {
  return { keyword, currentPage: page, perPage: 40, lastPage, totalItemCount, gigs };
}

function reviewsPayload(id, page, items, { lastPage = 2, totalItemCount = 6 } = {}) {
  return { reviewPage: { currentPage: page, lastPage, perPage: 5, totalItemCount, items: items.map((comment, index) => ({
    buyerReview: { score: 5, comment, createdDateTime: `2026-10-${String(20 - page).padStart(2, '0')} 10:0${index}:00` },
    orderDetail: { gigId: Number(id), orderId: 9_000 + page * 10 + index },
  })) } };
}

test('Kmong collectors are bounded in the input schema and preserve checkpoint metadata across registry roundtrip', async () => {
  const searchCalls = [];
  let checkpoint;
  const createRegistry = () => createServiceRegistry('freelance-public', {
    now: () => at,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      const target = new URL(String(url));
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      if (target.pathname === '/gig-app/gig/v2/gigs/search') {
        const page = Number(target.searchParams.get('page'));
        const keyword = target.searchParams.get('keyword');
        searchCalls.push(page);
        const payload = page === 1
          ? searchPayload(1, Array.from({ length: 40 }, (_, index) => searchGig(10_000 + index)), { keyword })
          : searchPayload(2, [searchGig(20_000)], { keyword });
        return json(payload);
      }
      throw new Error('unexpected path: ' + target.pathname);
    },
  });

  const registry = await createRegistry();
  try {
    const searchSchema = registry.describe('kmong-search-collect').inputSchema;
    assert.deepEqual(searchSchema.properties.query.required, ['keyword']);
    assert.equal(searchSchema.properties.query.properties.maxPages.default, 1);
    assert.equal(searchSchema.properties.query.properties.maxPages.maximum, 5);
    const stateSchema = searchSchema.properties.body.properties.state;
    assert.equal(stateSchema.additionalProperties, false);
    assert.equal(stateSchema.properties.items.maxItems, 1_240, 'schema allows one over-bound checkpoint for a specific runtime error');
    assert.equal(stateSchema.properties.pages.maxItems, 31);
    assert.match(stateSchema.description, /stops at 30 pages/);

    const first = await registry.execute('kmong-search-collect', {
      query: { keyword: '상세페이지', maxPages: 1 },
    });
    checkpoint = JSON.parse(JSON.stringify(first.data.state));
    assert.equal(first.data.status, 'partial');
    assert.equal(first.data.pagination.nextPage, 2);
    assert.equal(first.data.networkUsed, true, 'the injected transport was called');
    assert.equal(first.receipt.networkUsed, false, 'an injected fixture is not live external proof');
    assert.equal(first.receipt.currentRequests.length, 1);
    assert.equal(first.receipt.requests, undefined);
    assert.equal(first.data.state.requests[0].cookiesSent, false, 'safe false cookie metadata survives the registry');

    const extraStateField = { ...JSON.parse(JSON.stringify(first.data.state)), unexpected: true };
    await assert.rejects(registry.execute('kmong-search-collect', {
      query: { keyword: '상세페이지' }, body: { state: extraStateField },
    }), { code: 'OPERATION_INPUT_INVALID' });
  } finally { await registry.close(); }

  const resumedRegistry = await createRegistry();
  try {
    const resumed = await resumedRegistry.execute('kmong-search-collect', {
      query: { keyword: '상세페이지', maxPages: 1 },
      body: { state: checkpoint },
    });
    assert.equal(resumed.data.status, 'complete');
    assert.equal(resumed.data.items.length, 41);
    assert.equal(resumed.data.newPages.length, 1);
    assert.equal(resumed.data.networkUsed, true);
    assert.equal(resumed.receipt.currentRequests.length, 1);
    assert.equal(resumed.data.state.requests.every(request => request.cookiesSent === false), true);
  } finally { await resumedRegistry.close(); }
  assert.deepEqual(searchCalls, [1, 2]);

  const omittedKeyword = await createRegistry();
  try {
    await assert.rejects(omittedKeyword.execute('kmong-search-collect', { query: { maxPages: 1 } }),
      { code: 'OPERATION_INPUT_REQUIRED' });
  } finally { await omittedKeyword.close(); }

  const omittedId = await createServiceRegistry('freelance-public', { fetchImpl: async () => assert.fail('must validate before fetch') });
  try {
    await assert.rejects(omittedId.execute('kmong-reviews-collect', { query: { maxPages: 1 } }),
      { code: 'OPERATION_INPUT_REQUIRED' });
    await assert.rejects(omittedId.execute('kmong-reviews-collect', { path: { id: '70001' }, query: { maxPages: 6 } }),
      { code: 'OPERATION_INPUT_INVALID' });
  } finally { await omittedId.close(); }
});

test('Kmong review collector resumes through the registry without losing checkpoint receipt flags', async () => {
  const detail = await fixture('kmong-detail.html');
  let calls = 0;
  const mockFetch = async url => {
    const target = new URL(String(url));
    calls++;
    if (target.origin === 'https://kmong.com' && target.pathname === '/gig/70001') return html(detail);
    if (target.pathname === '/order-app/order/v1/reviews/gigs/70001') {
      const page = Number(target.searchParams.get('page'));
      const comments = page === 1
        ? ['review one', 'review two', 'review three', 'review four', 'review five']
        : ['review six'];
      return json(reviewsPayload('70001', page, comments));
    }
    throw new Error('unexpected route: ' + target.href);
  };
  const firstRegistry = await createServiceRegistry('freelance-public', { now: () => at, sleepImpl: async () => {}, fetchImpl: mockFetch });
  let checkpoint;
  try {
    const first = await firstRegistry.execute('kmong-reviews-collect', {
      path: { id: '70001' }, query: { maxPages: 1 },
    });
    checkpoint = JSON.parse(JSON.stringify(first.data.state));
    assert.equal(first.data.items.length, 5);
    assert.equal(first.data.status, 'partial');
    assert.equal(first.receipt.currentRequests.length, 2);
    assert.equal(first.data.state.requests.every(request => request.cookiesSent === false), true);
  } finally { await firstRegistry.close(); }

  const beforeResume = calls;
  const secondRegistry = await createServiceRegistry('freelance-public', { now: () => at, sleepImpl: async () => {}, fetchImpl: mockFetch });
  try {
    const second = await secondRegistry.execute('kmong-reviews-collect', {
      path: { id: '70001' }, query: { maxPages: 1 }, body: { state: checkpoint },
    });
    assert.equal(second.data.status, 'complete');
    assert.equal(second.data.items.length, 6);
    assert.equal(second.data.newPages.length, 1);
    assert.equal(second.receipt.currentRequests.length, 2);
    assert.equal(second.receipt.networkUsed, false);
  } finally { await secondRegistry.close(); }
  assert.equal(calls - beforeResume, 2);

});

test('a completed caller-supplied collector checkpoint does not claim a new read', async () => {
  const firstRegistry = await createServiceRegistry('freelance-public', {
    now: () => at, sleepImpl: async () => {},
    fetchImpl: async () => json(searchPayload(1, [searchGig(40_001)], { lastPage: 1, totalItemCount: 1 })),
  });
  let checkpoint;
  try {
    const first = await firstRegistry.execute('kmong-search-collect', { query: { keyword: '상세페이지' } });
    assert.equal(first.data.status, 'complete');
    checkpoint = JSON.parse(JSON.stringify(first.data.state));
  } finally { await firstRegistry.close(); }

  let unexpectedCalls = 0;
  const importedRegistry = await createServiceRegistry('freelance-public', {
    fetchImpl: async () => { unexpectedCalls++; throw new Error('completed checkpoint should not fetch'); },
  });
  try {
    const imported = await importedRegistry.execute('kmong-search-collect', {
      query: { keyword: '상세페이지' }, body: { state: checkpoint },
    });
    assert.equal(unexpectedCalls, 0);
    assert.equal(imported.data.status, 'complete');
    assert.equal(imported.data.observedAt, null);
    assert.equal(imported.data.networkUsed, false);
    assert.equal(imported.data.checkpointProvenance, 'caller_supplied');
    assert.equal(imported.data.checkpointAuthenticated, false);
    assert.deepEqual(imported.data.newPages, []);
    assert.deepEqual(imported.receipt.currentRequests, []);
    assert.equal(imported.receipt.requests, undefined);
    assert.equal(imported.receipt.httpStatus, undefined);
    assert.equal(imported.receipt.networkUsed, false);
  } finally { await importedRegistry.close(); }
});

test('a no-response timeout checkpoint survives the common registry and resumes without inventing HTTP status', async () => {
  const firstFetch = async url => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    if (page === 1) return json(searchPayload(1,
      Array.from({ length: 40 }, (_, index) => searchGig(50_000 + index))));
    throw Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' });
  };
  const firstRegistry = await createServiceRegistry('freelance-public', { now: () => at, fetchImpl: firstFetch });
  let checkpoint;
  try {
    await assert.rejects(firstRegistry.execute('kmong-search-collect', {
      query: { keyword: '상세페이지', maxPages: 2 },
    }), error => {
      assert.equal(error.code, 'KMONG_HTTP_TIMEOUT');
      checkpoint = JSON.parse(JSON.stringify(error.receipt.collection.state));
      const failedReceipt = checkpoint.requests.at(-1);
      assert.equal(failedReceipt.cookiesSent, false);
      assert.equal(failedReceipt.browserUsed, false);
      assert.equal(failedReceipt.redirectFollowed, null);
      assert.equal(Object.hasOwn(failedReceipt, 'httpStatus'), false);
      assert.equal(error.receipt.networkUsed, false, 'injected transport is not live external proof');
      assert.equal(error.receipt.collection.networkUsed, true, 'the collector did attempt the failed page');
      assert.equal(error.receipt.collection.currentRequests.length, 2);
      assert.equal(checkpoint.resumeAllowed, true);
      return true;
    });
  } finally { await firstRegistry.close(); }

  let resumedCalls = 0;
  const resumedRegistry = await createServiceRegistry('freelance-public', {
    now: () => at, fetchImpl: async url => {
      resumedCalls++;
      const page = Number(new URL(String(url)).searchParams.get('page'));
      return json(searchPayload(page, [searchGig(60_000)]));
    },
  });
  try {
    const resumed = await resumedRegistry.execute('kmong-search-collect', {
      query: { keyword: '상세페이지' }, body: { state: checkpoint },
    });
    assert.equal(resumedCalls, 1);
    assert.equal(resumed.data.status, 'complete');
    assert.equal(resumed.data.items.length, 41);
    assert.equal(resumed.data.requests.length, 3);
    assert.equal(resumed.receipt.currentRequests.length, 1);
  } finally { await resumedRegistry.close(); }
});

test('common collectors stop at cumulative page caps and return native-only checkpoints without fetching past them', async () => {
  const collectedSearchGig = id => ({
    id: String(id), title: 'Gig ' + id, url: `https://kmong.com/gig/${id}`,
    startingPrice: { amount: 50_000, currency: 'KRW', basis: 'displayed_starting_price', exactCheckoutAmount: false },
    reviewSummary: { average: 5, count: 1, source: 'search_gig_review_summary' },
    isPrime: false, isQualityGuaranteed: false, hasPackages: true, hasVideos: false,
  });
  const collectedReview = (page, index) => ({
    rating: 5, body: `review-${page}-${index}`, createdAt: '2026-10-20',
  });
  const nativeCollector = createKmongCollector({
    now: () => at, sleepImpl: async () => {},
    client: {
      search: async ({ keyword, page }) => {
        const lastPage = 31;
        const items = page === lastPage ? [collectedSearchGig(90_000)]
          : Array.from({ length: 40 }, (_, index) => collectedSearchGig(1_000 + (page - 1) * 40 + index));
        return {
          service: 'kmong', operation: 'search', keyword, observedAt: new Date(at + page * 1_000).toISOString(), items,
          pagination: { page, pageSize: 40, totalItemCount: 1_201, lastPage, complete: false,
            endReached: page === lastPage, nextPage: page === lastPage ? null : page + 1 }, requests: [],
        };
      },
      reviews: async ({ id, page }) => {
        const lastPage = 101;
        const items = page === lastPage ? [collectedReview(page, 0)]
          : Array.from({ length: 5 }, (_, index) => collectedReview(page, index));
        return {
          service: 'kmong', operation: 'reviews', gigId: id, observedAt: new Date(at + page * 1_000).toISOString(), items,
          pagination: { page, pageSize: 5, totalItemCount: 501, lastPage, complete: false,
            endReached: page === lastPage, nextPage: page === lastPage ? null : page + 1 }, requests: [],
        };
      },
    },
  });
  async function stateAt(operation, targetPages, collector = nativeCollector) {
    let state;
    while ((state?.pages.length ?? 0) < targetPages) {
      const count = targetPages - (state?.pages.length ?? 0);
      const result = operation === 'search'
        ? await collector.collectSearch({ keyword: '상세페이지', maxPages: Math.min(5, count), ...(state ? { state } : {}) })
        : await collector.collectReviews({ id: '70001', maxPages: Math.min(5, count), ...(state ? { state } : {}) });
      state = result.state;
    }
    return state;
  }

  const detail = await fixture('kmong-detail.html');
  const reviewCheckpoint = await stateAt('reviews', 99);
  let reviewPageCalls = [];
  const reviewLimitRegistry = await createServiceRegistry('freelance-public', {
    now: () => at, sleepImpl: async () => {}, fetchImpl: async url => {
      const target = new URL(String(url));
      if (target.origin === 'https://kmong.com' && target.pathname === '/gig/70001') return html(detail);
      if (target.pathname === '/order-app/order/v1/reviews/gigs/70001') {
        const page = Number(target.searchParams.get('page'));
        reviewPageCalls.push(page);
        return json(reviewsPayload('70001', page,
          Array.from({ length: 5 }, (_, index) => `source-review-${page}-${index}`),
          { lastPage: 101, totalItemCount: 501 }));
      }
      throw new Error('unexpected review path');
    },
  });
  let reviewLimitState;
  try {
    await assert.rejects(reviewLimitRegistry.execute('kmong-reviews-collect', {
      path: { id: '70001' }, query: { maxPages: 2 }, body: { state: reviewCheckpoint },
    }), error => {
      assert.equal(error.code, 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED');
      assert.equal(error.partialResult.kind, 'kmong_read_only_collection');
      assert.equal(error.partialResult.operation, 'kmong-reviews-collect');
      assert.equal(error.partialResult.data.status, 'partial');
      assert.equal(error.partialResult.data.state.pages.length, 100);
      assert.equal(error.partialResult.data.pagination.nextPage, 101);
      assert.equal(error.partialResult.data.pagination.canResumeInCommonRegistry, false);
      assert.equal(error.partialResult.data.pagination.nativeCheckpointResumable, true);
      assert.equal(error.partialResult.data.networkUsed, true);
      assert.equal(error.partialResult.data.currentRequests.length, 2);
      reviewLimitState = JSON.parse(JSON.stringify(error.partialResult.data.state));
      return true;
    });
  } finally { await reviewLimitRegistry.close(); }
  assert.deepEqual(reviewPageCalls, [100], '99 pages plus maxPages 2 must fetch only page 100');

  let commonPastLimitFetches = 0;
  const atLimitRegistry = await createServiceRegistry('freelance-public', {
    fetchImpl: async () => { commonPastLimitFetches++; throw new Error('common cap must stop before fetch'); },
  });
  try {
    await assert.rejects(atLimitRegistry.execute('kmong-reviews-collect', {
      path: { id: '70001' }, query: { maxPages: 1 }, body: { state: reviewLimitState },
    }), error => {
      assert.equal(error.code, 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED');
      assert.equal(error.partialResult.data.networkUsed, false);
      assert.deepEqual(error.partialResult.data.currentRequests, []);
      assert.equal(error.partialResult.data.state.resumeAllowed, true, 'native checkpoint remains resumable');
      assert.equal(error.partialResult.data.pagination.canResumeInCommonRegistry, false);
      return true;
    });
  } finally { await atLimitRegistry.close(); }
  assert.equal(commonPastLimitFetches, 0);

  const nativeFinishedReviews = await nativeCollector.collectReviews({ id: '70001', maxPages: 1, state: reviewLimitState });
  assert.equal(nativeFinishedReviews.status, 'complete', 'the same checkpoint remains usable by the native collector');

  const over100Collector = createKmongCollector({
    now: () => at, sleepImpl: async () => {},
    client: {
      search: async () => assert.fail('unexpected search request'),
      reviews: async ({ id, page }) => {
        const items = page === 102 ? [collectedReview(page, 0)]
          : Array.from({ length: 5 }, (_, index) => collectedReview(page, index));
        return {
          service: 'kmong', operation: 'reviews', gigId: id, observedAt: new Date(at + page * 1_000).toISOString(), items,
          pagination: { page, pageSize: 5, totalItemCount: 506, lastPage: 102, complete: false,
            endReached: page === 102, nextPage: page === 102 ? null : page + 1 }, requests: [],
        };
      },
    },
  });
  const over100State = await stateAt('reviews', 101, over100Collector);
  let over100CommonFetches = 0;
  const over100CommonRegistry = await createServiceRegistry('freelance-public', {
    fetchImpl: async () => { over100CommonFetches++; throw new Error('oversized common checkpoint must not fetch'); },
  });
  try {
    await assert.rejects(over100CommonRegistry.execute('kmong-reviews-collect', {
      path: { id: '70001' }, query: { maxPages: 1 }, body: { state: over100State },
    }), error => {
      assert.equal(error.code, 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED');
      assert.equal(error.partialResult.data.state.pages.length, 101);
      assert.equal(error.partialResult.data.canResumeInCommonRegistry, false);
      assert.equal(error.partialResult.data.nativeCheckpointResumable, true);
      assert.equal(error.partialResult.data.networkUsed, false);
      return true;
    });
  } finally { await over100CommonRegistry.close(); }
  assert.equal(over100CommonFetches, 0);
  assert.equal((await over100Collector.collectReviews({ id: '70001', maxPages: 1, state: over100State })).status, 'complete');

  const searchCheckpoint = await stateAt('search', 29);
  let searchPageCalls = [];
  const searchLimitRegistry = await createServiceRegistry('freelance-public', {
    now: () => at, sleepImpl: async () => {}, fetchImpl: async url => {
      const target = new URL(String(url));
      const page = Number(target.searchParams.get('page'));
      searchPageCalls.push(page);
      return json(searchPayload(page, Array.from({ length: 40 }, (_, index) => searchGig(70_000 + index)),
        { lastPage: 31, totalItemCount: 1_201 }));
    },
  });
  let searchLimitState;
  try {
    await assert.rejects(searchLimitRegistry.execute('kmong-search-collect', {
      query: { keyword: '상세페이지', maxPages: 5 }, body: { state: searchCheckpoint },
    }), error => {
      assert.equal(error.code, 'KMONG_COLLECTION_COMMON_PAGE_LIMIT_REACHED');
      assert.equal(error.partialResult.data.state.pages.length, 30);
      assert.equal(error.partialResult.data.pagination.nextPage, 31);
      assert.equal(error.partialResult.data.pagination.canResumeInCommonRegistry, false);
      assert.equal(error.partialResult.data.pagination.nativeCheckpointResumable, true);
      searchLimitState = JSON.parse(JSON.stringify(error.partialResult.data.state));
      return true;
    });
  } finally { await searchLimitRegistry.close(); }
  assert.deepEqual(searchPageCalls, [30], '29 pages plus maxPages 5 must fetch only page 30');
  const nativeFinishedSearch = await nativeCollector.collectSearch({ keyword: '상세페이지', maxPages: 1, state: searchLimitState });
  assert.equal(nativeFinishedSearch.status, 'complete');
});

test('Kmong collection errors and unstable results do not return success and retain a checkpoint receipt', async () => {
  const denied = await createServiceRegistry('freelance-public', {
    fetchImpl: async () => new Response('denied', { status: 403, headers: { 'content-type': 'text/html' } }),
  });
  try {
    await assert.rejects(denied.execute('kmong-search-collect', { query: { keyword: '상세페이지' } }), error => {
      assert.equal(error.code, 'KMONG_HTTP_STATUS_INVALID');
      assert.equal(error.receipt.networkUsed, false, 'the injected 403 is not live external proof');
      assert.equal(error.receipt.collection.status, 'partial');
      assert.equal(error.receipt.collection.state.resumeAllowed, false);
      assert.equal(error.receipt.collection.currentRequests[0].httpStatus, 403);
      assert.equal(error.receipt.collection.checkpointAuthenticated, false);
      return true;
    });
  } finally { await denied.close(); }

  const duplicateFetch = async url => {
    const page = Number(new URL(String(url)).searchParams.get('page'));
    const gigs = page === 1
      ? Array.from({ length: 40 }, (_, index) => searchGig(30_000 + index))
      : [searchGig(30_000)];
    return json(searchPayload(page, gigs));
  };
  const unstable = await createServiceRegistry('freelance-public', { sleepImpl: async () => {}, fetchImpl: duplicateFetch });
  try {
    await assert.rejects(unstable.execute('kmong-search-collect', {
      query: { keyword: '상세페이지', maxPages: 2 },
    }), error => {
      assert.equal(error.code, 'KMONG_COLLECTION_UNSTABLE');
      assert.equal(error.receipt.collection.status, 'unstable');
      assert.equal(error.receipt.collection.pagination.complete, false);
      assert.equal(error.receipt.collection.state.resumeAllowed, false);
      assert.equal(error.receipt.collection.currentRequests.length, 2);
      return true;
    });
  } finally { await unstable.close(); }
});

test('Soomgo category and public pro-search operations use fixed origins and preserve partial search coverage', async () => {
  const requests = [];
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const target = new URL(String(url));
      assert.equal(target.origin, 'https://api.soomgo.com');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      if (target.pathname === '/api2/categories/') {
        return json([{ id: 1, slug: 'design', title: '디자인' }]);
      }
      if (target.pathname === '/api2/categories/design') {
        return json([{ id: 11, slug: 'logo', title: '로고', services: [{ id: 111, slug: 'logo', title: '로고 디자인' }] }]);
      }
      if (target.pathname === '/v2/search/pro') return json({ code: 0, reason: '', request: '',
        response: { cursor: 'next-secret-free', results: [{ id: 42,
          mainService: { id: 1, slug: 'design', name: '디자인' },
          services: [{ id: 11, slug: 'logo', title: '로고' }], address: '서울 마포구',
          avgResponseTime: 3600, career: 4, isSafePayment: true, hasApprovedLicenseBadge: false, canReserve: true,
        }], sortBy: 'review_rate', totalCount: 21 } });
      throw new Error('unexpected path');
    } });
  try {
    const categories = await registry.execute('soomgo-categories', {});
    assert.equal(categories.data.items[0].slug, 'design');
    const children = await registry.execute('soomgo-subcategories', { path: { category1Slug: 'design' } });
    assert.equal(children.data.items[0].services[0].name, '로고 디자인');
    const result = await registry.execute('soomgo-pro-search', { query: { serviceSlug: 'logo', limit: 1 } });
    assert.equal(result.data.items[0].providerId, '42');
    assert.equal(result.data.items[0].location, '서울 마포구');
    assert.equal(result.data.pagination.complete, false);
    assert.equal(result.receipt.networkUsed, false);
    assert.equal(requests.length, 3);
    assert.equal(new URL(requests[2].url).searchParams.get('service_slug'), 'logo');
  } finally { await registry.close(); }
});

test('Soomgo common request-form reads are bounded first-party GETs and preparation sends no request', async () => {
  const formFixture = JSON.parse(await fixture('soomgo-request-form-20261027.json'));
  const addressFixture = JSON.parse(await fixture('soomgo-addresses-area3-first-record.json'));
  const requests = [];
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      const target = new URL(String(url));
      requests.push({ url: target.href, init });
      assert.equal(target.origin, 'https://api.soomgo.com');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('cookie'), null);
      if (target.pathname === '/v2/services/%EA%B0%80%EC%A0%95-%EC%9D%B4%EC%82%AC-%ED%88%AC%EB%A3%B8-%EC%93%B0%EB%A6%AC%EB%A3%B8/form') {
        assert.equal(target.search, '');
        return json({ code: 0, reason: '', request: '', response: formFixture.form });
      }
      if (target.pathname === '/v1/requests/forms/addresses') {
        assert.deepEqual([...target.searchParams], [['depth', 'area3']]);
        return json({ code: 0, reason: '', request: '', response: { addresses: addressFixture.items } });
      }
      throw new Error('unexpected Soomgo request route');
    } });
  try {
    const depthSchema = registry.describe('soomgo-address-options').inputSchema.properties.query.properties.areaDepth;
    assert.deepEqual(depthSchema.enum, [3]);
    assert.equal(depthSchema.default, 3);
    const form = await registry.execute('soomgo-request-form', { query: {
      serviceId: 729, serviceSlug: '가정-이사-투룸-쓰리룸', serviceName: '가정이사(투룸 이상)',
    } });
    assert.equal(form.data.operation, 'service_request_form');
    assert.equal(form.data.form.serviceId, 729);
    assert.equal(form.data.dispatch.supported, false);
    assert.equal(form.receipt.networkUsed, false);
    assert.equal(form.receipt.writesSubmitted, 0);

    const addressOptions = await registry.execute('soomgo-address-options', { query: { areaDepth: 3 } });
    assert.equal(addressOptions.data.operation, 'address_options');
    assert.equal(addressOptions.data.items[0].addressRowid, 3);
    assert.equal(addressOptions.data.coverage.complete, false);
    const afterDepthThree = requests.length;
    await assert.rejects(registry.execute('soomgo-address-options', { query: { areaDepth: 2 } }),
      { code: 'OPERATION_INPUT_INVALID' });
    assert.equal(requests.length, afterDepthThree, 'unobserved address depths stop before transport');

    const beforePrepare = requests.length;
    const prepared = await registry.execute('soomgo-request-prepare', { body: { form: form.data } });
    assert.equal(requests.length, beforePrepare, 'preparation is local and never dispatches the service form');
    assert.equal(prepared.data.operation, 'prepare_request');
    assert.equal(prepared.data.status, 'prepared_only');
    assert.equal(prepared.data.networkUsed, false);
    assert.equal(prepared.data.writesSubmitted, 0);
    assert.equal(prepared.data.gates.dispatchSupported, false);
    assert.equal(prepared.data.gates.requestSent, false);
    assert.equal(prepared.data.gates.externallySubmitted, false);
    assert.equal(prepared.receipt.networkUsed, false);
    assert.equal(prepared.receipt.writesSubmitted, 0);
    assert.equal(prepared.receipt.httpStatus, undefined, 'the local preparation receipt has no provider HTTP status');
    assert.equal(requests.length, 2);
  } finally { await registry.close(); }
});

test('Soomgo profile, review and portfolio reads bind IDs, sanitize public text and omit reviewer details', async () => {
  const source = JSON.parse(await fixture('soomgo-profile.json'));
  const calls = [];
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      const target = new URL(String(url));
      calls.push(target);
      assert.equal(target.origin, 'https://api.soomgo.com');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('cookie'), null);
      assert.equal(new Headers(init.headers).get('authorization'), null);
      let response = target.pathname.endsWith('/profile') ? source.profile
        : target.pathname.endsWith('/profile-contents') ? source.contents
          : target.pathname.endsWith('/portfolios') ? source.portfolios : source.reviews;
      if (target.pathname.endsWith('/reviews/received')) {
        const cursor = target.searchParams.get('next_cursor');
        if (cursor !== null) {
          assert.deepEqual([...target.searchParams], [
            ['next_cursor', 'fixture-public-review-cursor'],
            ['is_photo_review', 'false'], ['is_pay_verified', 'false'], ['sort_type', 'latest'],
            ['size', '3'], ['role', 'provider'],
          ]);
        } else assert.deepEqual([...target.searchParams], [['size', '3'], ['role', 'provider']]);
        const page = cursor === null ? 1 : 2;
        response = structuredClone(source.reviews);
        response.items = Array.from({ length: 3 }, (_, index) => ({
          ...structuredClone(source.reviews.items[0]), id: `fixture-review-${page}-${index}`,
        }));
        response.pagination = {
          ...response.pagination, currentCount: page * 3, totalCount: 6,
          hasNextPage: page === 1, nextCursor: page === 1 ? 'fixture-public-review-cursor' : '',
        };
      }
      return json({ code: 0, reason: '', request: '', response });
    } });
  try {
    const profile = await registry.execute('soomgo-profile', { query: { userId: '7847767', expectedProviderId: '993707' } });
    assert.equal(profile.data.identity.userId, '7847767');
    assert.equal(profile.data.identity.providerId, '993707');
    assert.equal(profile.data.identity.providerMatchVerified, true);
    assert.equal(profile.data.identity.ownerVerified, false);
    assert.equal(profile.receipt.networkUsed, false);

    const contents = await registry.execute('soomgo-profile-contents', { query: { userId: '7847767' } });
    assert.equal(contents.data.operation, 'profile_contents');
    assert.equal(contents.data.items[0].hasContent, true);
    assert.equal(JSON.stringify(contents).includes('cdn.example.invalid'), false);

    const portfolio = await registry.execute('soomgo-profile-portfolios', { query: { userId: '7847767', size: 8 } });
    assert.equal(portfolio.data.operation, 'profile_portfolios');
    assert.equal(portfolio.data.items.length, 1);
    assert.equal(portfolio.data.pagination.complete, false);

    const reviews = await registry.execute('soomgo-profile-reviews', { query: { userId: '7847767' } });
    assert.equal(reviews.data.operation, 'profile_reviews');
    assert.equal(reviews.data.items.length, 3);
    assert.equal(reviews.data.pagination.nextCursor, 'fixture-public-review-cursor');
    const reviewSchema = registry.describe('soomgo-profile-reviews-collect').inputSchema.properties.query.properties;
    assert.equal(reviewSchema.maxPages.default, 1);
    assert.equal(reviewSchema.maxPages.maximum, 5);
    assert.equal(reviewSchema.nextCursor.type, 'string');
    const collectedReviews = await registry.execute('soomgo-profile-reviews-collect', {
      query: { userId: '7847767', maxPages: 2 },
    });
    assert.equal(collectedReviews.data.items.length, 6);
    assert.equal(collectedReviews.data.pagination.pages, 2);
    assert.equal(collectedReviews.data.pagination.complete, true);
    assert.equal(collectedReviews.data.pagination.nextCursor, null);
    assert.equal(collectedReviews.receipt.networkUsed, false);
    const beforeInvalidCap = calls.length;
    await assert.rejects(registry.execute('soomgo-profile-reviews-collect', {
      query: { userId: '7847767', maxPages: 6 },
    }), { code: 'OPERATION_INPUT_INVALID' });
    assert.equal(calls.length, beforeInvalidCap);
    const serialized = JSON.stringify({ profile, contents, portfolio, reviews, collectedReviews });
    for (const privateValue of [
      'PRIVATE_PROVIDER_SENTINEL', 'PRIVATE_CONTACT_SENTINEL', 'PRIVATE_PORTFOLIO_TEXT_SENTINEL',
      'REVIEWER_NAME_SENTINEL', 'reviewer@example.invalid', 'sample@example.invalid',
      '010-1111-2222', '+44 (0)20 7946 0958', '415-555-0100',
      'Private Exact Address', 'FINANCIAL_DATA_SENTINEL',
      'cdn.example.invalid/private-image',
    ]) assert.equal(serialized.includes(privateValue), false);
    assert.equal(portfolio.data.pagination.nextCursor, 'OPAQUE_PORTFOLIO_CURSOR_SENTINEL');
    assert.equal(JSON.stringify(portfolio.receipt).includes('OPAQUE_PORTFOLIO_CURSOR_SENTINEL'), false);
    assert.equal(serialized.includes('REVIEW_BODY_SENTINEL [redacted]'), true,
      'the public review body is retained after contact details are redacted');
    assert.deepEqual(calls.map(call => call.pathname), [
      '/v2/user/7847767/profile', '/v1/providers/7847767/profile-contents',
      '/v2/users/7847767/portfolios', '/v3/users/7847767/reviews/received',
      '/v3/users/7847767/reviews/received', '/v3/users/7847767/reviews/received',
    ]);
  } finally { await registry.close(); }
});

test('Soomgo portfolio operations replay size-8 next_cursor and collect at most five pages', async () => {
  const source = JSON.parse(await fixture('soomgo-profile.json'));
  const calls = [];
  let collectionActive = false;
  const pageFor = pageNumber => {
    const response = structuredClone(source.portfolios);
    const returned = pageNumber === 3 ? 4 : 8;
    response.items = Array.from({ length: returned }, (_, index) => ({
      ...structuredClone(source.portfolios.items[0]), id: `portfolio-${pageNumber}-${index}`,
    }));
    response.pagination = {
      ...response.pagination,
      currentCount: Math.min(pageNumber * 8, 20),
      size: 8,
      totalCount: 20,
      hasNextPage: pageNumber < 3,
      hasPrevPage: pageNumber > 1,
      nextCursor: pageNumber < 3 ? `portfolio-page-${pageNumber + 1}` : '',
    };
    return response;
  };
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    fetchImpl: async (url, init) => {
      const target = new URL(String(url));
      calls.push(target);
      assert.equal(target.origin, 'https://api.soomgo.com');
      assert.equal(target.pathname, '/v2/users/7847767/portfolios');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(new Headers(init.headers).get('cookie'), null);
      const cursor = target.searchParams.get('next_cursor');
      assert.equal(target.searchParams.get('size'), '8');
      if (!collectionActive) {
        assert.equal(cursor, 'direct-portfolio-cursor');
        return json({ code: 0, reason: '', request: '', response: source.portfolios });
      }
      if (cursor === null) return json({ code: 0, reason: '', request: '', response: pageFor(1) });
      assert.equal([...target.searchParams][1][0], 'next_cursor');
      if (cursor === 'portfolio-page-2') return json({ code: 0, reason: '', request: '', response: pageFor(2) });
      assert.equal(cursor, 'portfolio-page-3');
      return json({ code: 0, reason: '', request: '', response: pageFor(3) });
    } });
  try {
    const directSchema = registry.describe('soomgo-profile-portfolios').inputSchema.properties.query.properties;
    assert.equal(directSchema.nextCursor.type, 'string');
    const direct = await registry.execute('soomgo-profile-portfolios', {
      query: { userId: '7847767', size: 8, nextCursor: 'direct-portfolio-cursor' },
    });
    assert.equal(direct.data.pagination.resumedFromCursor, true);
    assert.deepEqual([...calls[0].searchParams], [['size', '8'], ['next_cursor', 'direct-portfolio-cursor']]);

    collectionActive = true;
    const collectSchema = registry.describe('soomgo-profile-portfolios-collect').inputSchema.properties.query.properties;
    assert.equal(collectSchema.maxPages.default, 1);
    assert.equal(collectSchema.maxPages.maximum, 5);
    assert.deepEqual(collectSchema.size.enum, [4, 8]);
    const collected = await registry.execute('soomgo-profile-portfolios-collect', {
      query: { userId: '7847767', size: 8, maxPages: 3 },
    });
    assert.equal(collected.data.operation, 'profile_portfolios_collect');
    assert.equal(collected.data.items.length, 20);
    assert.equal(collected.data.pagination.pages, 3);
    assert.equal(collected.data.pagination.complete, true);
    assert.equal(collected.data.pagination.nextCursor, null);
    assert.equal(collected.receipt.networkUsed, false);
    const beforeInvalid = calls.length;
    await assert.rejects(registry.execute('soomgo-profile-portfolios-collect', {
      query: { userId: '7847767', size: 8, maxPages: 6 },
    }), { code: 'OPERATION_INPUT_INVALID' });
    await assert.rejects(registry.execute('soomgo-profile-portfolios-collect', {
      query: { userId: '7847767', size: 4, maxPages: 2 },
    }), { code: 'SOOMGO_PROFILE_PORTFOLIO_CONTINUATION_UNVERIFIED' });
    assert.equal(calls.length, beforeInvalid, 'invalid limits and unverified size-4 continuation stop before transport');
  } finally { await registry.close(); }
});

test('Upwork reads require a caller token, use only the official API, and keep token values out of result receipts', async () => {
  const token = 'fixture-oauth-token-must-not-escape';
  const fixtureSearch = JSON.parse(await fixture('upwork-search.json'));
  const requests = [];
  let credentialReads = 0;
  const registry = await createServiceRegistry('freelance-public', { now: () => at,
    credentialProvider: async service => {
      credentialReads++;
      assert.equal(service, 'freelance-public');
      return { upworkAccessToken: token };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      assert.equal(url, 'https://api.upwork.com/graphql');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.get('authorization'), `Bearer ${token}`);
      return json(fixtureSearch);
    } });
  try {
    const result = await registry.execute('upwork-search', { query: { query: 'GraphQL migration', limit: 5 } });
    assert.equal(result.data.operation, 'search');
    assert.equal(result.data.access.liveVerification, 'pending_live');
    assert.equal(result.data.access.ownerVerified, false);
    assert.equal(result.data.jobs.length, 1);
    assert.equal(result.receipt.httpStatus, 200);
    assert.equal(result.receipt.networkUsed, false, 'an injected fetch mock is not external verification');
    assert.equal(credentialReads, 1);
    assert.equal(requests.length, 1);
    assert.equal(JSON.stringify(result).includes(token), false);
  } finally { await registry.close(); }
});

test('Upwork missing credentials fails before a request and abort signals reach public readers', async () => {
  let calls = 0;
  const registry = await createServiceRegistry('freelance-public', { fetchImpl: async () => {
    calls++; return json({ code: 0, reason: '', response: { cursor: '', results: [], totalCount: 0 } });
  } });
  try {
    await assert.rejects(registry.execute('upwork-search', { query: { query: 'design' } }),
      { code: 'UPWORK_APPROVED_API_CREDENTIALS_REQUIRED' });
    assert.equal(calls, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(registry.execute('soomgo-categories', {}, { signal: controller.signal }),
      { code: 'OPERATION_ABORTED' });
    assert.equal(calls, 0);
  } finally { await registry.close(); }
});

