import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoomgoClient } from '../lib/freelance/soomgo.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

const category = (id, title, slug) => ({ id, title, slug });
const categories = [category(59, '이사/청소', '이사-청소A')];
const subcategories = [{
  ...category(277, '이사', '이사A'),
  services: [category(728, '원룸/소형 이사', '원룸-소형-이사')],
}];

function provider(id, service = category(728, '원룸/소형 이사', '원룸-소형-이사')) {
  const serviceRecord = { id: service.id, name: service.title, slug: service.slug };
  return {
    id,
    mainService: serviceRecord,
    services: [serviceRecord],
    address: '서울 강남구',
    avgResponseTime: 300,
    career: 2,
    isSafePayment: true,
    hasApprovedLicenseBadge: false,
    canReserve: false,
    adDisplay: null,
    user: { id: 999, name: 'private display data', profileImage: 'https://example.invalid/avatar.jpg' },
    recentReview: { id: 1, contents: 'private review text', user: 'reviewer-id', rate: 5 },
  };
}

function searchResponse(results, { totalCount = results.length, cursor = '' } = {}) {
  return { code: 0, reason: '', request: '', response: { cursor, results, sortBy: 'review_count', totalCount } };
}

test('public provider missing-value sentinels do not invalidate a search page', async () => {
  const client = createSoomgoClient({ fetchImpl: async () => json(searchResponse([
    { ...provider(1234), address: '', avgResponseTime: -1 }, provider(1235),
  ])) });
  const result = await client.searchPros();
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].location, null);
  assert.equal(result.items[0].avgResponseTimeSeconds, null);
  assert.equal(result.items[1].avgResponseTimeSeconds, 300);
});

test('a missing cursor field cannot turn malformed search JSON into complete results', async () => {
  const source = searchResponse([provider(1234)]);
  delete source.response.cursor;
  const client = createSoomgoClient({ fetchImpl: async () => json(source) });
  await assert.rejects(client.searchPros(), { code: 'SOOMGO_SEARCH_SCHEMA_INVALID' });
});

test('a resumed collection detects its input cursor repeating without another fetch', async () => {
  let calls = 0;
  const client = createSoomgoClient({ fetchImpl: async () => {
    calls++; return json(searchResponse([provider(1234)], { totalCount: 20, cursor: 'resume-cursor' }));
  } });
  await assert.rejects(client.collectPros({ cursor: 'resume-cursor', limit: 1 }, { maxPages: 3 }),
    { code: 'SOOMGO_CURSOR_REPEATED' });
  assert.equal(calls, 1);
});

test('a terminal resumed collection does not claim that the earlier pages were read', async () => {
  const client = createSoomgoClient({ fetchImpl: async () => json(searchResponse([provider(1234)])) });
  const result = await client.collectPros({ cursor: 'resume-cursor' });
  assert.equal(result.pagination.nextCursor, null);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.reason, 'resumed_window_only');
});

test('listCategories validates and projects the anonymous first-party catalog response', async () => {
  let calls = 0;
  const client = createSoomgoClient({
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url.origin, 'https://api.soomgo.com');
      assert.equal(url.pathname, '/api2/categories/');
      assert.deepEqual([...url.searchParams], []);
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).get('cookie'), null);
      assert.equal(new Headers(init.headers).get('authorization'), null);
      return json(categories);
    },
    now: () => Date.parse('2026-10-23T11:00:00.000Z'),
  });

  const result = await client.listCategories();
  assert.deepEqual(result.items, [{ id: 59, slug: '이사-청소A', name: '이사/청소' }]);
  assert.deepEqual(result.pagination, { returned: 1, totalCount: 1, complete: true, nextCursor: null });
  assert.equal(result.requests[0].httpStatus, 200);
  assert.equal(result.requests[0].browserUsed, false);
  assert.equal(result.requests[0].anonymous, true);
  assert.equal(result.requests[0].credentialsUsed, false);
  assert.equal(result.requests[0].checkedAt, '2026-10-23T11:00:00.000Z');
  assert.equal(result.contractProvenance.sourceSha256,
    'f104e06ba62e83b3ecaa5857dc8975f222b4232a6cf9c8b29b115c8e32227729');
  assert.equal(calls, 1);
});

test('listSubcategories binds the slug to the single encoded first-party route', async () => {
  const client = createSoomgoClient({ fetchImpl: async (url) => {
    assert.equal(url.origin, 'https://api.soomgo.com');
    assert.equal(url.pathname, '/api2/categories/%EC%9D%B4%EC%82%AC-%EC%B2%AD%EC%86%8CA');
    return json(subcategories);
  } });
  const result = await client.listSubcategories({ category1Slug: '이사-청소A' });
  assert.deepEqual(result.items, [{
    id: 277, slug: '이사A', name: '이사',
    services: [{ id: 728, slug: '원룸-소형-이사', name: '원룸/소형 이사' }],
  }]);
  assert.equal(result.operation, 'subcategories');
});

test('searchPros uses category slugs, filters controls, and omits user and review content', async () => {
  const source = provider(1234);
  const client = createSoomgoClient({ fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://api.soomgo.com');
    assert.equal(url.pathname, '/v2/search/pro');
    assert.deepEqual([...url.searchParams], [
      ['category1', '이사-청소A'],
      ['category2', '이사A'],
      ['service_slug', '원룸-소형-이사'],
      ['address1', '서울특별시'],
      ['address2', '강남구'],
      ['sort', 'review_count'],
      ['keyword', '원룸 이사'],
      ['limit', '5'],
    ]);
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('cookie'), null);
    assert.equal(new Headers(init.headers).get('authorization'), null);
    return json(searchResponse([source], { totalCount: 12, cursor: 'opaque-next-cursor' }));
  } });

  const result = await client.searchPros({
    category1: '이사-청소A', category2: '이사A', serviceSlug: '원룸-소형-이사',
    address1: '서울특별시', address2: '강남구', keyword: '원룸 이사', sort: 'review_count', limit: 5,
  });
  assert.equal(result.operation, 'search_pros');
  assert.deepEqual(result.filters, {
    category1: '이사-청소A', category2: '이사A', serviceSlug: '원룸-소형-이사',
    address1: '서울특별시', address2: '강남구', keyword: '원룸 이사', sort: 'review_count',
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    providerId: '1234',
    profileUrl: 'https://soomgo.com/profile/users/999',
    mainService: { id: 728, slug: '원룸-소형-이사', name: '원룸/소형 이사' },
    services: [{ id: 728, slug: '원룸-소형-이사', name: '원룸/소형 이사' }],
    location: '서울 강남구',
    avgResponseTimeSeconds: 300,
    careerValue: 2,
    isSafePayment: true,
    hasApprovedLicenseBadge: false,
    canReserve: false,
    hasAdDisplay: false,
  });
  assert.equal(JSON.stringify(result).includes('private display data'), false);
  assert.equal(JSON.stringify(result).includes('private review text'), false);
  assert.equal(JSON.stringify(result).includes('reviewer-id'), false);
  assert.equal(JSON.stringify(result).includes('private display data'), false);
  assert.deepEqual(result.pagination, {
    limit: 5, returned: 1, totalCount: 12, sort: 'review_count',
    nextCursor: 'opaque-next-cursor', pages: 1, complete: false, reason: 'more_pages_available',
    requestedCursor: null,
  });
});

test('searchPros accepts only observed sort names and caller-supplied opaque cursors', async () => {
  let calls = 0;
  const client = createSoomgoClient({ fetchImpl: async (url) => {
    calls++;
    assert.deepEqual([...url.searchParams], [
      ['sort', 'last_login'], ['cursor', 'opaque-next-cursor'], ['limit', '5'],
    ]);
    return json(searchResponse([provider(987)], { totalCount: 10, cursor: '' }));
  } });
  const result = await client.searchPros({ cursor: 'opaque-next-cursor', sort: 'last_login' });
  assert.equal(result.pagination.requestedCursor, 'opaque-next-cursor');
  assert.equal(result.pagination.complete, false);
  assert.deepEqual(result.filters, { sort: 'last_login' });
  await assert.rejects(client.searchPros({ sort: 'relevance' }), { code: 'SOOMGO_SORT_INVALID' });
  assert.equal(calls, 1);
});

test('collectPros follows a bounded cursor chain and only calls it complete after count reconciliation', async () => {
  const calls = [];
  const pages = [
    searchResponse([provider(100)], { totalCount: 2, cursor: 'cursor-2' }),
    searchResponse([provider(101)], { totalCount: 2, cursor: '' }),
  ];
  const client = createSoomgoClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return json(pages[calls.length - 1]);
  } });
  const result = await client.collectPros({ category1: '이사-청소A', maxPages: 3 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ url }) => url.searchParams.get('cursor')), [null, 'cursor-2']);
  assert.deepEqual(result.items.map((item) => item.providerId), ['100', '101']);
  assert.equal(result.pagination.pages, 2);
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.reason, 'end_of_results');
  assert.equal(result.requests.length, 2);
  assert.equal(result.operation, 'collect_pros');
});

test('collectPros keeps a page-limited or count-mismatched result explicitly partial', async () => {
  const client = createSoomgoClient({ fetchImpl: async () => json(searchResponse(
    [provider(100)], { totalCount: 3, cursor: 'cursor-2' },
  )) });
  const result = await client.collectPros({ maxPages: 1 });
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.reason, 'page_limit_reached');
  assert.equal(result.pagination.nextCursor, 'cursor-2');
});

test('invalid inputs, wrong provider schemas, repeated cursors, and duplicates stop before false success', async () => {
  let calls = 0;
  const client = createSoomgoClient({ fetchImpl: async () => { calls++; return json(categories); } });
  await assert.rejects(client.listSubcategories({ category1Slug: '../private' }), { code: 'SOOMGO_CATEGORY_SLUG_INVALID' });
  await assert.rejects(client.searchPros({ category2: '이사A' }), { code: 'SOOMGO_CATEGORY_PARENT_REQUIRED' });
  await assert.rejects(client.searchPros({ address2: '강남구' }), { code: 'SOOMGO_ADDRESS_PARENT_REQUIRED' });
  await assert.rejects(client.searchPros({ limit: 100 }), { code: 'SOOMGO_LIMIT_INVALID' });
  assert.equal(calls, 0);

  const invalid = createSoomgoClient({ fetchImpl: async () => json({
    code: 0, response: { cursor: '', results: [{ id: 1, mainService: null }], totalCount: 1 },
  }) });
  await assert.rejects(invalid.searchPros(), { code: 'SOOMGO_PROVIDER_SCHEMA_INVALID' });

  const duplicatePages = [
    searchResponse([provider(111)], { totalCount: 2, cursor: 'repeat-me' }),
    searchResponse([provider(111)], { totalCount: 2, cursor: 'repeat-me' }),
  ];
  let index = 0;
  const duplicates = createSoomgoClient({ fetchImpl: async () => json(duplicatePages[index++]) });
  await assert.rejects(duplicates.collectPros({ maxPages: 3 }), { code: 'SOOMGO_PROVIDER_PAGE_DUPLICATE' });
});

test('profile URL identity uses the nested public user id, never the provider result id', async () => {
  const client = createSoomgoClient({ fetchImpl: async () => json(searchResponse([
    provider(123, category(11, '로고 디자인', '로고-디자인')),
  ])) });
  const result = await client.searchPros({ limit: 1 });
  assert.equal(result.items[0].providerId, '123');
  assert.equal(result.items[0].profileUrl, 'https://soomgo.com/profile/users/999');

  const noUser = provider(124);
  delete noUser.user;
  const withoutNestedUser = createSoomgoClient({ fetchImpl: async () => json(searchResponse([noUser])) });
  assert.equal((await withoutNestedUser.searchPros({ limit: 1 })).items[0].profileUrl, null);
});

test('transport, auth challenge, redirects, and MIME failures remain explicit', async () => {
  const cases = [
    [new Response(null, { status: 403 }), 'SOOMGO_AUTH_REJECTED'],
    [new Response(null, { status: 302, headers: { location: 'https://example.invalid/' } }), 'SOOMGO_REDIRECT_REJECTED'],
    [new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), 'SOOMGO_MIME_INVALID'],
    [json({ code: 12, reason: 'not available', response: { results: [], totalCount: 0, cursor: '' } }), 'SOOMGO_SEARCH_SCHEMA_INVALID'],
  ];
  for (const [reply, expectedCode] of cases) {
    const client = createSoomgoClient({ fetchImpl: async () => reply });
    await assert.rejects(client.searchPros({ category1: '이사-청소A' }), error => {
      assert.equal(error.code, expectedCode);
      assert.equal(JSON.stringify(error.receipt).includes('login</html>'), false);
      return true;
    });
  }
  const transport = createSoomgoClient({ fetchImpl: async () => { throw new Error('sensitive transport details'); } });
  await assert.rejects(transport.searchPros(), error => {
    assert.equal(error.code, 'SOOMGO_TRANSPORT_FAILED');
    assert.equal(JSON.stringify(error.receipt).includes('sensitive transport details'), false);
    return true;
  });
});
