import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  KmongReadError,
  createKmongClient,
  parseKmongCategories,
  parseKmongDetail,
  parseKmongHome,
  parseKmongReviews,
  parseKmongSearch,
} from '../lib/freelance/kmong.mjs';

const fixture = name => readFile(fileURLToPath(new URL('./fixtures/freelance/' + name, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-10-23T10:00:00.000Z');
const htmlResponse = body => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });

test('home and category parsers keep observed cards, price basis, and incomplete coverage distinct', async () => {
  const body = await fixture('kmong-home.html');
  const result = parseKmongHome(body, { observedAt: new Date(NOW).toISOString() });
  assert.deepEqual(result.items.map(item => item.id), ['70001', '70002']);
  assert.equal(result.items[0].startingPrice.amount, 50_000);
  assert.equal(result.items[0].startingPrice.currency, 'KRW');
  assert.equal(result.items[0].startingPrice.exactCheckoutAmount, false);
  assert.deepEqual(result.items[0].reviewSummary, { average: 4.9, count: 23, source: 'visible_gig_card' });
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.source, 'curated_home_sections');
  const categories = parseKmongCategories(body);
  assert.deepEqual(categories.categories.map(row => row.id), ['1', '6', '101']);
  assert.equal(categories.pagination.complete, false);
});

test('home 200 with no valid service cards is a schema error, not empty success', () => {
  assert.throws(() => parseKmongHome('<html><title>로그인</title><body></body></html>'), error =>
    error instanceof KmongReadError && error.code === 'KMONG_LOGIN_OR_CHALLENGE_PAGE');
  assert.throws(() => parseKmongHome('<html><body>no results</body></html>'), error =>
    error instanceof KmongReadError && error.code === 'KMONG_CATEGORY_SCHEMA_INVALID');
});

test('a search document containing only loading skeletons is not reported as an empty result set', async () => {
  const body = await fixture('kmong-home-empty.html');
  assert.throws(() => parseKmongHome(body, {
    url: 'https://kmong.com/',
    requests: [{ httpStatus: 200, mime: 'text/html' }],
  }), error => error instanceof KmongReadError && error.code === 'KMONG_HOME_SCHEMA_INVALID');
});

test('search parser normalizes exact public rows and keeps total matches distinct from one-page results', async () => {
  const body = JSON.parse(await fixture('kmong-search-page1.json'));
  const result = parseKmongSearch(body, { keyword: '상세페이지', page: 1, perPage: 40 });
  assert.deepEqual(result.items.map(row => row.id), ['678837', '189900']);
  assert.equal(result.items[0].startingPrice.amount, 5_000);
  assert.equal(result.items[0].startingPrice.exactCheckoutAmount, false);
  assert.equal(result.items[0].reviewSummary.average, 5);
  assert.equal(result.items[0].category.thirdCategoryId, '11301');
  assert.equal(result.pagination.totalItemCount, 1_200);
  assert.equal(result.pagination.lastPage, 30);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.nextPage, 2);
  assert.equal(JSON.stringify(result).includes('PRIVATE SELLER FIELD'), false);
  assert.equal(result.contractProvenance.kind, 'first_party_bundle');
});

test('search parser binds the returned page and does not confuse an empty shape with valid search JSON', async () => {
  const body = JSON.parse(await fixture('kmong-search-page1.json'));
  assert.throws(() => parseKmongSearch(body, { keyword: '상세페이지', page: 2 }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_SEARCH_PAGE_BINDING_INVALID');
  assert.throws(() => parseKmongSearch({ ...body, keyword: '다른 검색어' }, { keyword: '상세페이지' }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_SEARCH_KEYWORD_BINDING_INVALID');
  assert.throws(() => parseKmongSearch({ loading: true }, { keyword: '상세페이지' }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_SEARCH_SCHEMA_INVALID');
  const empty = parseKmongSearch({
    keyword: '없는 키워드', currentPage: 1, perPage: 40, lastPage: 0, totalItemCount: 0, gigs: [],
  }, { keyword: '없는 키워드' });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.pagination.complete, true);
  assert.equal(empty.pagination.endReached, true);
  const lastPage = parseKmongSearch({
    ...body, currentPage: 30, lastPage: 30, totalItemCount: 1200, gigs: body.gigs.slice(0, 2),
  }, { keyword: '상세페이지', page: 30 });
  assert.equal(lastPage.pagination.endReached, true);
  assert.equal(lastPage.pagination.nextPage, null);
  assert.equal(lastPage.pagination.complete, false);
});

test('detail parser binds ID and extracts exact package data and aggregate rating separately', async () => {
  const body = await fixture('kmong-detail.html');
  const result = parseKmongDetail(body, { id: '70001' });
  assert.equal(result.gig.title, '로고 디자인 의뢰');
  assert.deepEqual(result.gig.categories.map(row => row.id), ['1', '101']);
  assert.deepEqual(result.gig.reviewSummary, {
    average: 4.95, count: 23, source: 'product_json_ld_aggregate',
  });
  assert.deepEqual(result.gig.offerRange, {
    minimumAmount: 50_000, maximumAmount: 150_000, currency: 'KRW', basis: 'aggregate_offer_range',
  });
  assert.deepEqual(result.gig.packages.map(row => row.price.amount), [50_000, 90_000, 150_000]);
  assert.deepEqual(result.gig.packages.map(row => row.deliveryTime), ['2일', '3일', '5일']);
  assert.deepEqual(result.gig.packages.map(row => row.revisionLimit), ['1회', '3회', '5회']);
  assert.equal(result.gig.packages[0].description, '기본 로고');
  assert.equal(result.gig.packages[1].descriptionDetails, '시안 두 개');
  assert.match(result.reviewSource.url, /^https:\/\/api\.kmong\.com\/order-app\/order\/v1\/reviews\/gigs\/70001\?page=1/);
  assert.equal(result.contractProvenance.kind, 'first_party_document');
});

test('detail parser rejects mismatched SKU, unverified URL origins, and absent package schema', async () => {
  const body = await fixture('kmong-detail.html');
  assert.throws(() => parseKmongDetail(body, { id: '70002' }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_DETAIL_IDENTITY_MISMATCH');
  assert.throws(() => parseKmongDetail(body, { id: '70001', url: 'https://evil.example/gig/70001' }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_URL_ORIGIN_REJECTED');
  assert.throws(() => parseKmongDetail('<html><body><h1>no package table</h1></body></html>', { id: '70001' }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_DETAIL_IDENTITY_MISMATCH');
});

test('review parser binds requested page and gig ID and drops reviewer, seller, and order identifiers', async () => {
  const body = JSON.parse(await fixture('kmong-reviews-page1.json'));
  const result = parseKmongReviews(body, { id: '70001', page: 1 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].rating, 5);
  assert.equal(result.items[0].body, '완성도가 좋고 빠르게 진행됐습니다.');
  assert.equal(result.items[0].sellerResponse.body, '감사합니다. 다음에도 잘 부탁드립니다.');
  assert.equal(result.aggregateRating, null);
  assert.equal(result.pagination.page, 1);
  assert.equal(result.pagination.nextPage, 2);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.endReached, false);
  const serialized = JSON.stringify(result);
  for (const privateField of ['userId', 'nickname', 'thumbnail', 'reviewId', 'orderId', 'totalPrice']) {
    assert.equal(serialized.includes(privateField), false);
  }
  assert.equal(
    parseKmongReviews({
      reviewPage: {
        currentPage: 1, lastPage: 1, perPage: 5, totalItemCount: 1,
        items: [{
          buyerReview: { score: 4, comment: '문의: user@example.com 010-1234-5678', createdDateTime: '2026-10-22' },
          orderDetail: { gigId: 70001 },
        }],
      },
    }, { id: '70001' }).items[0].body,
    '문의: [contact removed] [contact removed]',
  );
  const internationalContact = parseKmongReviews({
    reviewPage: {
      currentPage: 1, lastPage: 1, perPage: 5, totalItemCount: 1,
      items: [{
        buyerReview: { score: 4, comment: 'Contact: +1 415 555 0123 or +44 20 7946 0958', createdDateTime: '2026-10-22' },
        orderDetail: { gigId: 70001 },
      }],
    },
  }, { id: '70001' });
  assert.equal(internationalContact.items[0].body, 'Contact: [contact removed] or [contact removed]');
  assert.throws(() => parseKmongReviews(body, { id: '70002', page: 1 }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_REVIEW_GIG_IDENTITY_MISMATCH');
  assert.throws(() => parseKmongReviews(body, { id: '70001', page: 2 }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_REVIEWS_PAGE_BINDING_INVALID');
  const lastReviewPage = parseKmongReviews({
    reviewPage: { ...body.reviewPage, currentPage: 3, lastPage: 3, items: body.reviewPage.items.slice(0, 2) },
  }, { id: '70001', page: 3 });
  assert.equal(lastReviewPage.pagination.endReached, true);
  assert.equal(lastReviewPage.pagination.nextPage, null);
  assert.equal(lastReviewPage.pagination.complete, false);
});

test('client sends bounded anonymous reads to observed same-origin routes only', async () => {
  const home = await fixture('kmong-home.html');
  const detail = await fixture('kmong-detail.html');
  const search = JSON.parse(await fixture('kmong-search-page1.json'));
  const reviews = JSON.parse(await fixture('kmong-reviews-page1.json'));
  const calls = [];
  const client = createKmongClient({
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const path = new URL(url).pathname;
      if (path === '/') return htmlResponse(home);
      if (path === '/gig-app/gig/v2/gigs/search') return jsonResponse(search);
      if (path === '/gig/70001') return htmlResponse(detail);
      if (path === '/order-app/order/v1/reviews/gigs/70001') return jsonResponse(reviews);
      throw new Error('unexpected route: ' + path);
    },
  });
  const homeResult = await client.home();
  const categories = await client.categories();
  const searchResult = await client.search({ keyword: '상세페이지' });
  const detailResult = await client.detail({ id: '70001' });
  const reviewResult = await client.reviews({ id: '70001' });
  assert.equal(homeResult.items.length, 2);
  assert.equal(categories.categories.length, 3);
  assert.equal(searchResult.items.length, 2);
  assert.equal(searchResult.items[0].id, '678837');
  assert.equal(detailResult.gig.id, '70001');
  assert.equal(reviewResult.items.length, 2);
  assert.equal(calls.length, 6);
  for (const call of calls) {
    const target = new URL(call.url);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.headers.cookie, undefined);
    assert.ok(['https://kmong.com', 'https://api.kmong.com'].includes(target.origin));
  }
  const reviewCall = calls.find(call => call.url.includes('/order-app/order/v1/reviews/gigs/'));
  assert.equal(new URL(reviewCall.url).origin, 'https://api.kmong.com');
  assert.equal(new URL(reviewCall.url).searchParams.get('page'), '1');
  assert.equal(new URL(reviewCall.url).searchParams.get('perPage'), '5');
  const searchCall = calls.find(call => call.url.includes('/gig/v2/gigs/search'));
  assert.equal(new URL(searchCall.url).origin, 'https://api.kmong.com');
  assert.equal(new URL(searchCall.url).searchParams.get('keyword'), '상세페이지');
  assert.equal(new URL(searchCall.url).searchParams.get('perPage'), '40');
});

test('client rejects redirects, login/challenge responses, and non-JSON review responses', async () => {
  const redirectClient = createKmongClient({
    now: () => NOW,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
  });
  await assert.rejects(redirectClient.home(), error =>
    error instanceof KmongReadError && error.code === 'KMONG_REDIRECT_REJECTED');
  const loginClient = createKmongClient({
    now: () => NOW,
    fetchImpl: async () => htmlResponse('<html><title>로그인</title><input type="password"></html>'),
  });
  await assert.rejects(loginClient.home(), error =>
    error instanceof KmongReadError && error.code === 'KMONG_LOGIN_OR_CHALLENGE_PAGE');
  const htmlApiClient = createKmongClient({
    now: () => NOW,
    fetchImpl: async (url) => new URL(url).origin === 'https://kmong.com'
      ? htmlResponse(await fixture('kmong-detail.html'))
      : htmlResponse('<html><title>로그인</title></html>'),
  });
  await assert.rejects(htmlApiClient.reviews({ id: '70001' }), error =>
    error instanceof KmongReadError && error.code === 'KMONG_CHALLENGE_OR_LOGIN_HTML');
});

