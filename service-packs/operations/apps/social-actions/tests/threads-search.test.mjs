import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildThreadsSearchUrl,
  decodeThreadsSearchDocument,
  searchThreadsPosts,
} from '../threads-search.mjs';

const OWNER = 'lifehack__ailab';
const OWNER_ID = '17824859444';
const ORIGIN = 'https://www.threads.com';

function post({ id, author, authorId, text, mediaType = 19, caption, imageVersions2,
  carouselMedia, originalWidth, originalHeight, isReply = false, canReply = true, takenAt = 1_790_000_000 }) {
  return {
    pk: id,
    user: { pk: authorId, username: author },
    text_post_app_info: { can_reply: canReply, is_reply: isReply },
    media_type: mediaType,
    caption: caption === undefined ? { text } : caption,
    ...(imageVersions2 === undefined ? {} : { image_versions2: imageVersions2 }),
    ...(carouselMedia === undefined ? {} : { carousel_media: carouselMedia }),
    ...(originalWidth === undefined ? {} : { original_width: originalWidth }),
    ...(originalHeight === undefined ? {} : { original_height: originalHeight }),
    taken_at: takenAt,
  };
}

function searchEdge(value) {
  return { node: { thread: { thread_items: [{ post: value }] } } };
}

function documentHtml({ owner = OWNER, ownerId = OWNER_ID, edges, hasNextPage = true,
  endCursor = hasNextPage ? 'test-next-cursor' : null } = {}) {
  const payload = {
    require: [['BarcelonaSharedData', [], { viewer: { username: owner, id: ownerId } }]],
    data: { searchResults: {
      edges,
      page_info: {
        has_next_page: hasNextPage,
        has_previous_page: false,
        end_cursor: endCursor,
        start_cursor: edges.length ? 'test-start-cursor' : null,
      },
    } },
  };
  return `<html><script type="application/json">${JSON.stringify(payload)}</script></html>`;
}

function fakeContext(fetchImpl) {
  return {
    service: 'threads',
    handle: OWNER,
    bundle: {
      service: 'threads', owner: OWNER, ownerId: OWNER_ID, origin: ORIGIN,
      cookies: [{ name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true }],
    },
    fetchImpl,
  };
}

function htmlResponse(html, url) {
  const response = new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function jsonResponse(payload, url) {
  const response = new Response(JSON.stringify(payload), { status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' } });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function paginationContext(fetchImpl) {
  const modules = new Map([
    ['DTSGInitialData', { token: 'test-dtsg-token' }],
    ['LSD', { token: 'test-lsd-token' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['SiteData', { haste_session: 'test-haste', pr: 1, client_revision: 12345, hsi: '67890',
      comet_env: 1, __spin_r: 123, __spin_b: 'trunk', __spin_t: 1_790_000_000 }],
    ['RelayAPIConfigDefaults', { actorID: OWNER_ID, customHeaders: { 'x-ig-app-id': 'test-app-id' } }],
    ['CurrentUserInitialData', { USER_ID: OWNER_ID }],
  ]);
  return {
    service: 'threads', handle: OWNER, createdAt: Date.now(), requestCount: 0,
    url: `${ORIGIN}/@${OWNER}/`, fetchImpl,
    sources: new Map([['DTSGUtils', { source: 'function tokenSum(){return token.charCodeAt(0)+SprinkleConfig.version}' }]]),
    document: { modules },
    bundle: { service: 'threads', owner: OWNER, ownerId: OWNER_ID, origin: ORIGIN,
      cookies: [
        { name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true },
        { name: 'ds_user_id', value: OWNER_ID, domain: '.threads.com', path: '/', secure: true },
      ] },
  };
}

function graphqlSearchResults({ edges, hasNextPage = false, endCursor = null } = {}) {
  return { data: { searchResults: {
    edges,
    page_info: { has_next_page: hasNextPage, has_previous_page: true,
      end_cursor: endCursor, start_cursor: 'page-start' },
  } } };
}

test('Threads search URLs use only observed query, search surface, and optional recent filter', () => {
  assert.equal(buildThreadsSearchUrl({ query: '스하리', mode: 'default' }),
    `${ORIGIN}/search?q=%EC%8A%A4%ED%95%98%EB%A6%AC&serp_type=default`);
  assert.equal(buildThreadsSearchUrl({ query: '스하리', mode: 'recent' }),
    `${ORIGIN}/search?q=%EC%8A%A4%ED%95%98%EB%A6%AC&serp_type=default&filter=recent`);
  assert.throws(() => buildThreadsSearchUrl({ query: '스하리', mode: 'popular' }),
    error => error.code === 'THREADS_SEARCH_MODE_INVALID');
  assert.throws(() => buildThreadsSearchUrl({ query: '  ' }),
    error => error.code === 'THREADS_SEARCH_QUERY_INVALID');
});

test('Threads SSR parser returns public post fields and preserves incomplete pagination metadata', () => {
  const html = documentHtml({ edges: [
    searchEdge(post({ id: '3995946527096977778', author: 'jji_ni_yo', authorId: '12345678901',
      text: '서로 힘낼수있게 스하리 어때??', takenAt: 1_790_000_000 })),
    searchEdge(post({ id: '3995944703807282385', author: 'jjang_gu93', authorId: '12345678902',
      text: '스하리=반하리', isReply: false })),
  ] });
  const result = decodeThreadsSearchDocument(html, { viewerId: OWNER_ID });
  assert.deepEqual(result.posts, [
    { id: '3995946527096977778', author: 'jji_ni_yo', authorId: '12345678901',
      text: '서로 힘낼수있게 스하리 어때??', canReply: true, isReply: false,
      publishedAt: new Date(1_790_000_000 * 1000).toISOString() },
    { id: '3995944703807282385', author: 'jjang_gu93', authorId: '12345678902',
      text: '스하리=반하리', canReply: true, isReply: false,
      publishedAt: new Date(1_790_000_000 * 1000).toISOString() },
  ]);
  assert.deepEqual(result.page, { hasNextPage: true, fullList: false });
});

test('Threads SSR parser retains valid photo and carousel media-only posts with sanitized empty text', () => {
  const imageVersions2 = { candidates: [{ width: 640, height: 640 }] };
  const html = documentHtml({ edges: [
    searchEdge(post({ id: '3995083028787607652', author: 'photo_actor', authorId: '12345678903',
      text: undefined, mediaType: 1, caption: null, imageVersions2, originalWidth: 640, originalHeight: 640 })),
    searchEdge(post({ id: '3997563861069844440', author: 'carousel_actor', authorId: '12345678904',
      text: undefined, mediaType: 8, caption: null, imageVersions2, originalWidth: 640,
      originalHeight: 640, carouselMedia: [{ media_type: 1 }, { media_type: 1 }] })),
  ] });
  const result = decodeThreadsSearchDocument(html, { viewerId: OWNER_ID });
  assert.deepEqual(result.posts.map(({ id, text, canReply, isReply, contentType }) => ({ id, text, canReply, isReply, contentType })), [
    { id: '3995083028787607652', text: '', canReply: true, isReply: false, contentType: 'media' },
    { id: '3997563861069844440', text: '', canReply: true, isReply: false, contentType: 'media' },
  ]);
  assert.equal(result.page.fullList, false);
});

test('Threads live reader replays the observed recent Document GET with DPAPI-scoped cookie and safe receipt', async () => {
  const seen = [];
  const context = fakeContext(async (url, init) => {
    seen.push({ url, init });
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.accept, 'text/html');
    assert.match(init.headers.cookie, /csrftoken=test-csrf/);
    assert.equal(init.redirect, 'manual');
    const html = documentHtml({ edges: [searchEdge(post({ id: '3995946527096977778',
      author: 'jji_ni_yo', authorId: '12345678901', text: '스하리 서로 반하리' }))] });
    return htmlResponse(html, url);
  });
  const result = await searchThreadsPosts({ query: ' 스하리 ', mode: 'recent' }, {
    context, coordinatorLockHeld: true,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${ORIGIN}/search?q=%EC%8A%A4%ED%95%98%EB%A6%AC&serp_type=default&filter=recent`);
  assert.deepEqual(result.posts.map(({ id, author, text }) => ({ id, author, text })), [
    { id: '3995946527096977778', author: 'jji_ni_yo', text: '스하리 서로 반하리' },
  ]);
  assert.deepEqual(result.page, { hasNextPage: true, fullList: false });
  assert.equal(result.receipt.ownerVerified, true);
  assert.equal(result.receipt.credential_propagated, true);
  assert.equal(result.receipt.live_replay, true);
  assert.equal(result.receipt.captured, false);
  assert.equal(result.receipt.browserNetworkEventsCaptured, false);
  assert.equal(result.receipt.credentialValuesRecorded, false);
  assert.equal(Object.hasOwn(result.page, 'endCursor'), false);
});

test('Threads cursor reader uses the captured GraphQL page contract and keeps its cursor private', async () => {
  const seen = [];
  const query = '스하리';
  const expectedReferer = `${ORIGIN}/search?q=%EC%8A%A4%ED%95%98%EB%A6%AC&serp_type=default&filter=recent`;
  const capturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../evidence/threads-search-pagination-capture-2026-09-30.json');
  const captured = JSON.parse(await readFile(capturePath, 'utf8'));
  const context = paginationContext(async (url, init) => {
    seen.push({ url, init });
    if (url.startsWith(`${ORIGIN}/search?`)) {
      const html = documentHtml({ edges: [searchEdge(post({ id: '3995946527096977778',
        author: 'jji_ni_yo', authorId: '12345678901', text: '스하리 첫 페이지' }))] });
      return htmlResponse(html, url);
    }
    assert.equal(url, `${ORIGIN}/graphql/query`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.referer, expectedReferer);
    assert.equal(init.headers.origin, ORIGIN);
    assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.match(init.headers.cookie, /csrftoken=test-csrf/);
    assert.equal(init.redirect, 'manual');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('fb_api_req_friendly_name'), 'BarcelonaSearchResultsRefetchableQuery');
    assert.equal(form.get('doc_id'), '28117118431294022');
    assert.equal(form.get('__crn'), 'comet.threads.BarcelonaSearchResultsColumnRoute');
    const variables = JSON.parse(form.get('variables'));
    const expectedVariables = structuredClone(captured.variablesTemplate);
    expectedVariables.after = 'test-next-cursor';
    expectedVariables.query = query;
    expectedVariables.recent = 1;
    assert.deepEqual(variables, expectedVariables);
    return jsonResponse(graphqlSearchResults({ edges: [searchEdge(post({ id: '3995944703807282385',
      author: 'jjang_gu93', authorId: '12345678902', text: '스하리 다음 페이지' }))] }), url);
  });

  const result = await searchThreadsPosts({ query, mode: 'recent', pages: 2 }, {
    context, coordinatorLockHeld: true,
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].url, `${ORIGIN}/graphql/query`);
  assert.deepEqual(result.posts.map(row => row.id), ['3995946527096977778', '3995944703807282385']);
  assert.deepEqual(result.page, { hasNextPage: false, fullList: true });
  assert.equal(result.receipt.pagesFetched, 2);
  assert.equal(result.receipt.paginationRequests.length, 1);
  assert.equal(result.receipt.paginationRequests[0].httpStatus, 200);
  assert.equal(result.receipt.paginationBrowserNetworkEventsCaptured, true);
  assert.equal(result.receipt.documentRequestCaptured, false);
  assert.equal(result.receipt.paginationRequestCaptured, true);
  assert.equal(result.receipt.live_replay, true);
  assert.equal(JSON.stringify(result).includes('test-next-cursor'), false);
  assert.equal(JSON.stringify(result).includes('test-csrf'), false);
});

test('Threads pagination chains only returned cursors, deduplicates stable posts, and stops at the requested page cap', async () => {
  const seenVariables = [];
  const context = paginationContext(async (url, init) => {
    if (url.startsWith(`${ORIGIN}/search?`)) return htmlResponse(documentHtml({ edges: [searchEdge(post({
      id: '3995946527096977778', author: 'jji_ni_yo', authorId: '12345678901', text: '스하리 첫 페이지',
    }))] }), url);
    const variables = JSON.parse(new URLSearchParams(init.body).get('variables'));
    seenVariables.push(variables);
    const page = seenVariables.length;
    const nextPost = post({ id: page === 1 ? '3995944703807282385' : '3995946527096977778',
      author: page === 1 ? 'jjang_gu93' : 'jji_ni_yo',
      authorId: page === 1 ? '12345678902' : '12345678901',
      text: page === 1 ? '스하리 둘째 페이지' : '스하리 첫 페이지' });
    return jsonResponse(graphqlSearchResults({ edges: [searchEdge(nextPost)],
      hasNextPage: page === 1, endCursor: page === 1 ? 'returned-cursor-two' : null }), url);
  });
  const result = await searchThreadsPosts({ query: '스하리', mode: 'default', pages: 3 }, {
    context, coordinatorLockHeld: true,
  });
  assert.equal(seenVariables.length, 2);
  assert.equal(seenVariables[0].after, 'test-next-cursor');
  assert.equal(seenVariables[1].after, 'returned-cursor-two');
  assert.equal(seenVariables[0].recent, 0);
  assert.equal(seenVariables[1].recent, 0);
  assert.deepEqual(result.posts.map(row => row.id), ['3995946527096977778', '3995944703807282385']);
  assert.deepEqual(result.page, { hasNextPage: false, fullList: true });
  assert.equal(result.receipt.pagesFetched, 3);
  assert.equal(JSON.stringify(result).includes('returned-cursor-two'), false);
});

test('Threads pagination validates its page bound before fetching', async () => {
  let requests = 0;
  const context = paginationContext(async () => { requests += 1; throw new Error('unexpected request'); });
  for (const pages of [0, 6, 1.5, '2']) {
    await assert.rejects(searchThreadsPosts({ query: '스하리', pages }, { context,
      coordinatorLockHeld: true }), error => error.code === 'THREADS_SEARCH_PAGES_INVALID');
  }
  assert.equal(requests, 0);
});

test('Threads search fails closed for wrong owner, malformed results, or unsafe inputs before HTTP', async () => {
  const context = fakeContext(async () => { throw new Error('unexpected request'); });
  await assert.rejects(searchThreadsPosts({ query: '\n' }, { context }),
    error => error.code === 'THREADS_SEARCH_QUERY_INVALID');
  await assert.rejects(searchThreadsPosts({ query: '스하리', mode: 'newest' }, { context }),
    error => error.code === 'THREADS_SEARCH_MODE_INVALID');
  await assert.rejects(searchThreadsPosts({ query: '스하리' }, {
    context: { ...context, handle: 'different_owner' },
    coordinatorLockHeld: true,
  }), error => error.code === 'THREADS_SEARCH_OWNER_UNVERIFIED');
  assert.throws(() => decodeThreadsSearchDocument(documentHtml({ owner: 'someone_else', edges: [] }), {
    viewerOwner: OWNER, viewerId: OWNER_ID,
  }), error => error.code === 'THREADS_SEARCH_VIEWER_MISMATCH');
  assert.throws(() => decodeThreadsSearchDocument('<html></html>', { viewerId: OWNER_ID }),
    error => error.code === 'THREADS_SEARCH_RESULTS_MISSING' || error.code === 'THREADS_SEARCH_VIEWER_MISMATCH');
  assert.throws(() => decodeThreadsSearchDocument(documentHtml({ edges: [searchEdge(post({
    id: '3995083028787607652', author: 'photo_actor', authorId: '12345678903', text: undefined,
    mediaType: 2, caption: null,
  }))] }), { viewerId: OWNER_ID }), error => error.code === 'THREADS_SEARCH_POST_SCHEMA');
  assert.throws(() => decodeThreadsSearchDocument(documentHtml({ edges: [searchEdge(post({
    id: '3995083028787607652', author: 'photo_actor', authorId: '12345678903', text: undefined,
    mediaType: 1, caption: null,
  }))] }), { viewerId: OWNER_ID }), error => error.code === 'THREADS_SEARCH_POST_SCHEMA');
  assert.throws(() => decodeThreadsSearchDocument(documentHtml({ edges: [searchEdge(post({
    id: '3997563861069844440', author: 'carousel_actor', authorId: '12345678904', text: undefined,
    mediaType: 8, caption: null, imageVersions2: { candidates: [{ width: 640, height: 640 }] },
    originalWidth: 640, originalHeight: 640,
  }))] }), { viewerId: OWNER_ID }), error => error.code === 'THREADS_SEARCH_POST_SCHEMA');
  assert.throws(() => decodeThreadsSearchDocument(documentHtml({ edges: [searchEdge(post({
    id: 'invalid-id', author: 'actor', authorId: '12345678905', text: '스하리',
  }))] }), { viewerId: OWNER_ID }), error => error.code === 'THREADS_SEARCH_POST_SCHEMA');
  assert.throws(() => decodeThreadsSearchDocument(documentHtml({ edges: [searchEdge(post({
    id: '3995083028787607652', author: 'actor', authorId: 'invalid-author-id', text: '스하리',
  }))] }), { viewerId: OWNER_ID }), error => error.code === 'THREADS_SEARCH_POST_SCHEMA');
});

test('Threads search skips one unrecognized result instead of failing the whole page', () => {
  const result = decodeThreadsSearchDocument(documentHtml({ edges: [
    searchEdge(post({ id: '3995946527096977778', author: 'jji_ni_yo', authorId: '12345678901', text: '스하리' })),
    searchEdge(post({ id: '3995083028787607652', author: 'video_actor', authorId: '12345678903', text: undefined,
      mediaType: 2, caption: null })),
  ] }), { viewerId: OWNER_ID });
  assert.deepEqual(result.posts.map(row => row.id), ['3995946527096977778']);
});

test('Threads search rejects conflicting SSR search result connections', () => {
  const first = { edges: [searchEdge(post({ id: '3995946527096977778', author: 'jji_ni_yo',
    authorId: '12345678901', text: '스하리' }))], page_info: {
    has_next_page: false, has_previous_page: false, end_cursor: null, start_cursor: 'first',
  } };
  const conflicting = structuredClone(first);
  conflicting.edges[0].node.thread.thread_items[0].post.caption.text = '다른 결과';
  const payload = {
    require: [['BarcelonaSharedData', [], { viewer: { username: OWNER, id: OWNER_ID } }]],
    first: { searchResults: first },
    second: { searchResults: conflicting },
  };
  const html = `<html><script type="application/json">${JSON.stringify(payload)}</script></html>`;
  assert.throws(() => decodeThreadsSearchDocument(html, { viewerId: OWNER_ID }),
    error => error.code === 'THREADS_SEARCH_RESULTS_AMBIGUOUS');
});
