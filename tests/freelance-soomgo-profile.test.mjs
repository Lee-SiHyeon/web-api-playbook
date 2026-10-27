import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoomgoProfileClient } from '../lib/freelance/soomgo-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(path.join(HERE, 'fixtures/freelance/soomgo-profile.json'), 'utf8'));
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const api = value => ({ code: 0, reason: '', request: '', response: value });

function profiles() {
  return {
    profile: api(fixture.profile),
    contents: api(fixture.contents),
    portfolios: api(fixture.portfolios),
    reviews: api(fixture.reviews),
  };
}

test('profile binds user route to the expected provider id and exposes only public profile fields', async () => {
  const requests = [];
  const client = createSoomgoProfileClient({ fetchImpl: async (url, init) => {
    requests.push({ url, init });
    assert.equal(url.origin, 'https://api.soomgo.com');
    assert.equal(url.pathname, '/v2/user/7847767/profile');
    assert.deepEqual([...url.searchParams], [['role', 'provider']]);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('authorization'), null);
    assert.equal(new Headers(init.headers).get('cookie'), null);
    return json(profiles().profile);
  }, now: () => Date.parse('2026-10-27T04:00:00Z') });

  const result = await client.getProfile({ userId: '7847767', expectedProviderId: '993707' });
  assert.deepEqual(result.identity, {
    userId: '7847767', providerId: '993707', expectedProviderId: '993707',
    providerMatchVerified: true, authenticated: false, ownerVerified: false,
  });
  assert.deepEqual(result.profile, {
    displayName: 'sample designer [redacted] [redacted]',
    role: 'provider',
    introduction: 'Email [redacted] or call [redacted]; [redacted]',
    serviceDescription: 'External contact [redacted]',
    mainService: { id: '728', name: 'Brand Design', slug: 'brand-design' },
    services: [
      { id: '728', name: 'Brand Design', slug: 'brand-design' },
      { id: '931', name: 'Logo Design', slug: 'logo-design' },
    ],
    avgResponseTimeSeconds: 300,
    reviewCount: 18,
    reviewTotalRatingSourceValue: 4.9,
    hireCount: 9,
    recentHireCount: 2,
    hasApprovedLicenseBadge: false,
  });
  const serialized = JSON.stringify(result);
  for (const sentinel of [
    'Private Exact Address', 'Private Employer', 'Private School', 'example@example.invalid',
    'sample@example.invalid', '010-1234-5678', 'FINANCIAL_DATA_SENTINEL',
    'PRIVATE_PROVIDER_SENTINEL', 'REVIEW_BODY_SENTINEL', 'REVIEWER_NAME_SENTINEL',
  ]) assert.equal(serialized.includes(sentinel), false);
  assert.equal(result.requests[0].authenticated, undefined);
  assert.equal(result.requests[0].ownerVerified, undefined);
  assert.equal(requests.length, 1);
});

test('profile marks provider matching unverified without an expected id and stops on a mismatch', async () => {
  const client = createSoomgoProfileClient({ fetchImpl: async () => json(profiles().profile) });
  const unbound = await client.getProfile({ userId: 7847767 });
  assert.equal(unbound.identity.providerMatchVerified, false);
  assert.equal(unbound.identity.expectedProviderId, null);
  await assert.rejects(client.getProfile({ userId: 7847767, expectedProviderId: 993706 }),
    { code: 'SOOMGO_PROFILE_PROVIDER_MISMATCH' });
});

test('profile contents project media metadata but exclude media URLs', async () => {
  const client = createSoomgoProfileClient({ fetchImpl: async (url) => {
    assert.equal(url.pathname, '/v1/providers/7847767/profile-contents');
    return json(profiles().contents);
  } });
  const result = await client.getProfileContents({ userId: 7847767 });
  assert.deepEqual(result.identity, {
    userId: '7847767', pathBound: true, authenticated: false, ownerVerified: false,
  });
  assert.deepEqual(result.items, [{
    contentId: 'content-77', contentType: 'image', sequence: 1, hasContent: true, hasThumbnail: true,
  }]);
  assert.deepEqual(result.coverage, {
    returned: 1, totalCount: null, complete: false, reason: 'pagination_not_reported',
  });
  assert.equal(JSON.stringify(result).includes('cdn.example.invalid'), false);
});

test('portfolio rows preserve public titles and source metrics while dropping contact, exact address and body data', async () => {
  const calls = [];
  const client = createSoomgoProfileClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(url.pathname, '/v2/users/7847767/portfolios');
    assert.deepEqual([...url.searchParams], [['size', '8']]);
    assert.equal(init.credentials, 'omit');
    return json(profiles().portfolios);
  } });
  const result = await client.getProfilePortfolios({ userId: '7847767', size: 8 });
  assert.deepEqual(result.items, [{
    portfolioId: '69aabbccddeeff0011223344',
    title: 'Brand package contact [redacted] [redacted] [redacted] [redacted] [redacted] dated 2026-10-27 at $50.00',
    mediaType: 'image',
    createdAt: '2026-09-01T10:00:00+09:00',
    updatedAt: '2026-09-02T12:00:00+09:00',
    service: { id: '728', name: 'Brand Design', slug: 'brand-design' },
    imageCount: 1,
    hasMainImage: true,
    hasVideo: false,
    likeCount: 10,
    viewCount: 99,
  }]);
  assert.equal(result.pagination.hasNextPage, true);
  assert.equal(result.pagination.nextCursorAvailable, true);
  assert.equal(result.pagination.nextCursor, 'OPAQUE_PORTFOLIO_CURSOR_SENTINEL');
  assert.equal(result.pagination.complete, false);
  assert.equal(JSON.stringify(result.requests).includes('OPAQUE_PORTFOLIO_CURSOR_SENTINEL'), false);
  const serialized = JSON.stringify(result);
  for (const sentinel of [
    'PRIVATE Exact Address', 'Private Exact Address',
    'PRIVATE_CONTACT_SENTINEL', 'PRIVATE_PORTFOLIO_TEXT_SENTINEL', 'PRIVATE_PROVIDER_SENTINEL',
    'FINANCIAL_DATA_SENTINEL', 'example.invalid/private-image',
  ]) assert.equal(serialized.includes(sentinel), false);
  assert.equal(calls.length, 1);
});

test('portfolio hasNext false does not prove completeness when totals disagree or are absent', async () => {
  const payload = profiles().portfolios;
  payload.response.pagination.hasNextPage = false;
  const client = createSoomgoProfileClient({ fetchImpl: async () => json(payload) });
  const result = await client.getProfilePortfolios({ userId: '7847767', size: 8 });
  assert.equal(result.pagination.hasNextPage, false);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.reason, 'count_mismatch');
});

test('portfolio completeness requires a terminal page and matching observed counts', async () => {
  const payload = profiles().portfolios;
  payload.response.pagination.hasNextPage = false;
  payload.response.pagination.currentCount = 1;
  payload.response.pagination.totalCount = 1;
  const client = createSoomgoProfileClient({ fetchImpl: async () => json(payload) });
  const result = await client.getProfilePortfolios({ userId: '7847767', size: 8 });
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.reason, 'end_of_results');
});

function portfolioPage({ page, returned, nextCursor = '', hasNextPage, totalCount = 20 } = {}) {
  const data = structuredClone(fixture.portfolios);
  const template = data.items[0];
  data.items = Array.from({ length: returned }, (_, index) => ({
    ...structuredClone(template), id: `portfolio-${page}-${index}`,
  }));
  data.pagination = {
    ...data.pagination,
    currentCount: Math.min(page * 8, totalCount),
    size: 8,
    totalCount,
    hasNextPage,
    nextCursor,
  };
  return { code: 0, reason: '', request: '', response: data };
}

test('portfolio continuation follows observed size and next_cursor fields and reconciles a full 8+8+4 walk', async () => {
  const replies = [
    portfolioPage({ page: 1, returned: 8, nextCursor: 'portfolio-cursor-2', hasNextPage: true }),
    portfolioPage({ page: 2, returned: 8, nextCursor: 'portfolio-cursor-3', hasNextPage: true }),
    portfolioPage({ page: 3, returned: 4, hasNextPage: false }),
  ];
  const calls = [];
  const client = createSoomgoProfileClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return json(replies[calls.length - 1]);
  } });
  const result = await client.collectProfilePortfolios({ userId: '7847767', size: 8, maxPages: 5 });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ url }) => [...url.searchParams]), [
    [['size', '8']],
    [['size', '8'], ['next_cursor', 'portfolio-cursor-2']],
    [['size', '8'], ['next_cursor', 'portfolio-cursor-3']],
  ]);
  assert.deepEqual(result.pages.map((page) => page.returned), [8, 8, 4]);
  assert.equal(result.items.length, 20);
  assert.equal(result.pagination.pages, 3);
  assert.equal(result.pagination.totalCount, 20);
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.nextCursor, null);
  assert.equal(JSON.stringify(result.requests).includes('portfolio-cursor-2'), false);
});

test('portfolio collection resumes at a cursor without claiming earlier pages', async () => {
  const reply = portfolioPage({ page: 3, returned: 4, hasNextPage: false });
  const client = createSoomgoProfileClient({ fetchImpl: async (url) => {
    assert.deepEqual([...url.searchParams], [['size', '8'], ['next_cursor', 'resume-portfolio']]);
    return json(reply);
  } });
  const result = await client.collectProfilePortfolios({ userId: '7847767', size: 8, maxPages: 2, nextCursor: 'resume-portfolio' });
  assert.equal(result.pagination.resumedFromCursor, true);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.reason, 'resumed_tail_only');
});

test('portfolio collection respects caps and rejects unsupported size 4 continuation', async () => {
  const capped = await createSoomgoProfileClient({ fetchImpl: async () => json(
    portfolioPage({ page: 1, returned: 8, nextCursor: 'next-portfolio-page', hasNextPage: true }),
  ) }).collectProfilePortfolios({ userId: '7847767', size: 8, maxPages: 1 });
  assert.equal(capped.pagination.complete, false);
  assert.equal(capped.pagination.nextCursor, 'next-portfolio-page');
  await assert.rejects(createSoomgoProfileClient({ fetchImpl: () => assert.fail('must not fetch') })
    .collectProfilePortfolios({ userId: '7847767', size: 4, maxPages: 2 }),
  { code: 'SOOMGO_PROFILE_PORTFOLIO_CONTINUATION_UNVERIFIED' });
});

test('size 4 portfolio reads stop at page 1 and do not return an unobserved continuation token', async () => {
  const client = createSoomgoProfileClient({ fetchImpl: async (url) => {
    assert.deepEqual([...url.searchParams], [['size', '4']]);
    return json(portfolioPage({ page: 1, returned: 4, nextCursor: 'server-cursor', hasNextPage: true }));
  } });
  const result = await client.collectProfilePortfolios({ userId: '7847767', size: 4, maxPages: 1 });
  assert.equal(result.items.length, 4);
  assert.equal(result.pagination.hasNextPage, true);
  assert.equal(result.pagination.nextCursor, null);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.reason, 'portfolio_cursor_requires_size_8');
});

test('review page includes sanitized public prose while omitting reviewer, booking and cursor data', async () => {
  const client = createSoomgoProfileClient({ fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/v3/users/7847767/reviews/received');
    assert.deepEqual([...url.searchParams], [['size', '3'], ['role', 'provider']]);
    assert.equal(init.credentials, 'omit');
    return json(profiles().reviews);
  } });
  const result = await client.getProfileReviews({ userId: 7847767 });
  assert.equal(result.items.length, 1);
  assert.equal(result.pagination.size, 3);
  assert.deepEqual(result.items[0], {
    rating: 5,
    createdAt: '2026-10-01T11:00:00+09:00',
    reviewText: 'REVIEW_BODY_SENTINEL [redacted] [redacted] [redacted] [redacted]',
    service: { id: '728', name: 'Brand Design', slug: 'brand-design' },
    verifiedPayment: { soomgoPay: false, singleMatch: true },
    imageCount: 1,
  });
  assert.equal(result.pagination.hasNextPage, true);
  assert.equal(result.pagination.nextCursorAvailable, true);
  assert.equal(result.pagination.nextCursor, 'OPAQUE_REVIEW_CURSOR_SENTINEL');
  assert.equal(result.pagination.complete, false);
  const serialized = JSON.stringify(result);
  for (const sentinel of [
    'REVIEW_ID_SENTINEL', 'BOOKING_ID_SENTINEL',
    'REVIEWER_NAME_SENTINEL', 'PRIVATE_REVIEW_COMMENT_SENTINEL',
    'PRIVATE_CLIENT_ANSWER_SENTINEL',
    'reviewer@example.invalid', '010-1111-2222', 'cdn.example.invalid/reviewer',
  ]) assert.equal(serialized.includes(sentinel), false);
});

test('review continuation uses exactly the browser-observed filters and returns the server cursor only in native output', async () => {
  const client = createSoomgoProfileClient({ fetchImpl: async (url, init) => {
    assert.equal(url.pathname, '/v3/users/7847767/reviews/received');
    assert.deepEqual([...url.searchParams], [
      ['next_cursor', 'opaque-cursor-input'],
      ['is_photo_review', 'false'],
      ['is_pay_verified', 'false'],
      ['sort_type', 'latest'],
      ['size', '3'],
      ['role', 'provider'],
    ]);
    assert.equal(init.credentials, 'omit');
    return json(profiles().reviews);
  } });
  const result = await client.getProfileReviews({ userId: '7847767', nextCursor: 'opaque-cursor-input' });
  assert.equal(result.pagination.resumedFromCursor, true);
  assert.equal(result.pagination.nextCursor, 'OPAQUE_REVIEW_CURSOR_SENTINEL');
  assert.equal(result.pagination.complete, false);
  assert.equal(JSON.stringify(result.requests).includes('OPAQUE_REVIEW_CURSOR_SENTINEL'), false);
  assert.equal(result.requests[0].queryFields.includes('next_cursor'), true);
  assert.equal(JSON.stringify(result.requests).includes('opaque-cursor-input'), false);
});

function reviewPage({ id, nextCursor = '', hasNextPage, currentCount = 3, totalCount } = {}) {
  const page = structuredClone(fixture.reviews);
  page.items[0].id = id;
  page.pagination.currentCount = currentCount;
  page.pagination.size = 3;
  page.pagination.hasNextPage = hasNextPage;
  page.pagination.nextCursor = nextCursor;
  if (totalCount === undefined) delete page.pagination.totalCount;
  else page.pagination.totalCount = totalCount;
  return api(page);
}

test('bounded review collection follows observed cursor parameters and guards resume completeness', async () => {
  const pages = [
    reviewPage({ id: 'review-page-one', nextCursor: 'opaque-page-two', hasNextPage: true, currentCount: 3 }),
    reviewPage({ id: 'review-page-two', hasNextPage: false, currentCount: 3 }),
  ];
  const calls = [];
  const client = createSoomgoProfileClient({ fetchImpl: async (url) => {
    calls.push([...url.searchParams]);
    return json(pages[calls.length - 1]);
  } });
  const result = await client.collectProfileReviews({ userId: '7847767', maxPages: 5 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [['size', '3'], ['role', 'provider']]);
  assert.deepEqual(calls[1], [
    ['next_cursor', 'opaque-page-two'], ['is_photo_review', 'false'],
    ['is_pay_verified', 'false'], ['sort_type', 'latest'], ['size', '3'], ['role', 'provider'],
  ]);
  assert.deepEqual(result.items.map((item) => item.rating), [5, 5]);
  assert.equal(result.pagination.pages, 2);
  assert.equal(result.pagination.returned, 2);
  assert.equal(result.pagination.hasNextPage, false);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.reason, 'total_count_not_reported');
  assert.equal(JSON.stringify(result.requests).includes('opaque-page-two'), false);

  const resumed = await createSoomgoProfileClient({ fetchImpl: async (url) => {
    assert.deepEqual([...url.searchParams], [
      ['next_cursor', 'opaque-resume'], ['is_photo_review', 'false'],
      ['is_pay_verified', 'false'], ['sort_type', 'latest'], ['size', '3'], ['role', 'provider'],
    ]);
    return json(reviewPage({ id: 'review-resumed', hasNextPage: false }));
  } }).collectProfileReviews({ userId: '7847767', maxPages: 2, nextCursor: 'opaque-resume' });
  assert.equal(resumed.pagination.resumedFromCursor, true);
  assert.equal(resumed.pagination.complete, false);
  assert.equal(resumed.pagination.reason, 'resumed_tail_only');
});

test('review collection respects page caps and rejects duplicate IDs or repeated cursors', async () => {
  const cappedPages = [
    reviewPage({ id: 'review-a', nextCursor: 'cursor-b', hasNextPage: true }),
    reviewPage({ id: 'review-b', nextCursor: 'cursor-c', hasNextPage: true }),
  ];
  let index = 0;
  const capped = await createSoomgoProfileClient({ fetchImpl: async () => json(cappedPages[index++]) })
    .collectProfileReviews({ userId: '7847767', maxPages: 1 });
  assert.equal(index, 1);
  assert.equal(capped.pagination.hasNextPage, true);
  assert.equal(capped.pagination.nextCursor, 'cursor-b');
  assert.equal(capped.pagination.reason, 'page_limit_reached');

  const duplicatePages = [
    reviewPage({ id: 'duplicate-review', nextCursor: 'cursor-b', hasNextPage: true }),
    reviewPage({ id: 'duplicate-review', hasNextPage: false }),
  ];
  index = 0;
  const duplicate = createSoomgoProfileClient({ fetchImpl: async () => json(duplicatePages[index++]) });
  await assert.rejects(duplicate.collectProfileReviews({ userId: '7847767', maxPages: 3 }),
    { code: 'SOOMGO_PROFILE_REVIEW_DUPLICATE' });

  const repeatedPages = [
    reviewPage({ id: 'review-one', nextCursor: 'same-cursor', hasNextPage: true }),
    reviewPage({ id: 'review-two', nextCursor: 'same-cursor', hasNextPage: true }),
  ];
  index = 0;
  const repeated = createSoomgoProfileClient({ fetchImpl: async () => json(repeatedPages[index++]) });
  await assert.rejects(repeated.collectProfileReviews({ userId: '7847767', maxPages: 3 }),
    { code: 'SOOMGO_PROFILE_REVIEW_CURSOR_REPEATED' });
});

test('invalid identifiers are rejected locally; profile challenges and malformed review rows fail closed', async () => {
  let calls = 0;
  const noCalls = createSoomgoProfileClient({ fetchImpl: async () => { calls++; return json({}); } });
  await assert.rejects(noCalls.getProfile({ userId: '../me' }), { code: 'SOOMGO_PROFILE_USER_ID_INVALID' });
  await assert.rejects(noCalls.getProfile({ userId: '7847767', expectedProviderId: '0' }),
    { code: 'SOOMGO_PROFILE_USER_ID_INVALID' });
  await assert.rejects(noCalls.getProfilePortfolios({ userId: '7847767', size: 20 }),
    { code: 'SOOMGO_PROFILE_PORTFOLIO_SIZE_INVALID' });
  assert.equal(calls, 0);

  const challenged = createSoomgoProfileClient({ fetchImpl: async () => new Response(null, { status: 403 }) });
  await assert.rejects(challenged.getProfile({ userId: '7847767' }), { code: 'SOOMGO_AUTH_REJECTED' });

  const malformed = structuredClone(profiles().reviews);
  malformed.response.items[0].rating = 'five';
  const badReview = createSoomgoProfileClient({ fetchImpl: async () => json(malformed) });
  await assert.rejects(badReview.getProfileReviews({ userId: '7847767' }),
    { code: 'SOOMGO_PROFILE_REVIEWS_SCHEMA_INVALID' });
});
