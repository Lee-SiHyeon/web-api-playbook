import test from 'node:test';
import assert from 'node:assert/strict';
import { readThreadsProfileTimeline } from '../threads-social.mjs';

const OWNER = 'lifehack__ailab';
const OWNER_ID = '17824859444';
const ORIGIN = 'https://www.threads.com';
const ROUTE = 'comet.threads.BarcelonaProfileThreadsColumnRoute';
const PROVIDER = '__relay_internal__pv__TestProviderrelayprovider';

function fakeContext(fetchImpl) {
  const modules = new Map([
    ['DTSGInitialData', { token: 'test-dtsg' }],
    ['LSD', { token: 'test-lsd' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
      __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
    ['RelayAPIConfigDefaults', { actorID: OWNER_ID, graphURI: '/api/graphql',
      customHeaders: { 'x-ig-app-id': 'test-app' } }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
  ]);
  return {
    service: 'threads', handle: OWNER, createdAt: Date.now(), requestCount: 0,
    url: `${ORIGIN}/@${OWNER}/`, bundle: { service: 'threads', owner: OWNER,
      ownerId: OWNER_ID, origin: ORIGIN,
      cookies: [{ name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true }] },
    document: { modules, route: { canonicalRouteName: ROUTE }, scriptUrls: [] },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig value.charCodeAt(i)' }]]), fetchImpl,
  };
}

function htmlResponseObject(html, url) {
  const response = new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function htmlResponse({ userId = OWNER_ID, first = 2, allowPageInfo = false } = {}) {
  const variables = {
    allow_page_info_for_lox_user: allowPageInfo,
    first,
    userID: OWNER_ID,
    [PROVIDER]: true,
  };
  const bootstrap = [
    ['BarcelonaSharedData', [], { viewer: { username: OWNER, id: OWNER_ID } }],
    {
      expectedPreloaders: [{}, { variables }],
      initialRouteInfo: { route: {
        canonicalRouteName: ROUTE,
        rootView: { props: { user_id: userId, initial_thread_count: first,
          max_thread_count: allowPageInfo ? 20 : null } },
      } },
    },
  ];
  return `<html><script type="application/json">${JSON.stringify(bootstrap)}</script></html>`;
}

function post(id, username, takenAt, { isReply = false, pinned = false } = {}) {
  return {
    id,
    code: `Code${id.slice(-6)}`,
    user: { username },
    caption: { text: `post ${id}` },
    taken_at: takenAt,
    has_liked: false,
    text_post_app_info: {
      is_reply: isReply,
      can_reply: true,
      direct_reply_count: 0,
      pinned_post_info: { is_pinned_to_profile: pinned },
    },
  };
}

function pagePayload(posts, hasNext, cursor) {
  return { data: { fetch__XDTUserDict: { mediaData: {
    edges: posts.map(value => ({ node: { thread_type: 'thread', thread_items: [{ post: value }] } })),
    page_info: { has_next_page: hasNext, end_cursor: cursor },
  } } } };
}

function sourceContractLoader() {
  return async () => ({
    operation: 'BarcelonaProfileThreadsTabDirectQuery',
    docId: '28699787826350282',
    providerNames: [PROVIDER],
    sourceFingerprint: 'current-source-fixture',
  });
}

function optionsFor({ pageHandler, documentHtml = htmlResponse(), beforeQuery } = {}) {
  const documentUrl = `${ORIGIN}/@${OWNER}/`;
  const fetchImpl = async (url, init) => {
    assert.equal(url, documentUrl);
    assert.equal(init.method, undefined);
    return htmlResponseObject(documentHtml, documentUrl);
  };
  const context = fakeContext(fetchImpl);
  const querySender = async (_, request) => {
    assert.equal(request.url, `${ORIGIN}/api/graphql`);
    assert.equal(request.method, 'POST');
    assert.equal(request.body.get('fb_api_req_friendly_name'), 'BarcelonaProfileThreadsTabDirectQuery');
    assert.equal(request.body.get('doc_id'), '28699787826350282');
    const variables = JSON.parse(request.body.get('variables'));
    beforeQuery?.(variables, request);
    return { payload: pageHandler(variables), receipt: { httpStatus: 200, bytes: 321 } };
  };
  return { context, querySender, fetchImpl, sourceContractLoader: sourceContractLoader() };
}

test('profile timeline follows the observed after cursor, preserves post fields, and stays partial at the limit', async () => {
  const cursors = ['opaque-cursor-page-1', 'opaque-cursor-page-2'];
  let page = 0;
  const deps = optionsFor({
    beforeQuery(variables) {
      assert.equal(variables.first, 2);
      assert.equal(variables.allow_page_info_for_lox_user, false);
      assert.equal(variables[PROVIDER], true);
      if (page === 0) assert.equal(Object.hasOwn(variables, 'after'), false);
      else assert.equal(variables.after, cursors[0]);
    },
    pageHandler() {
      page += 1;
      if (page === 1) return pagePayload([
        post('3996994421430736442', OWNER, 1_700_000_001, { pinned: true }),
        post('3996994421430736441', OWNER, 1_700_000_004, { isReply: true }),
      ], true, cursors[0]);
      return pagePayload([
        post('3996994421430736440', OWNER, 1_700_000_003),
        post('3996994421430736439', OWNER, 1_700_000_002),
      ], true, cursors[1]);
    },
  });

  const result = await readThreadsProfileTimeline({ handle: OWNER, limit: 3 }, deps);
  assert.equal(page, 2);
  assert.equal(result.posts.length, 3);
  assert.equal(result.posts[0].id, '3996994421430736441');
  assert.equal(result.posts[0].isReply, true);
  assert.equal(result.posts.some(item => item.id === '3996994421430736442'), false);
  assert.equal(result.pinnedPosts.length, 1);
  assert.equal(result.pinnedPosts[0].id, '3996994421430736442');
  assert.equal(result.pinnedPosts[0].isPinnedToProfile, true);
  assert.equal(result.pinnedPostIds[0], '3996994421430736442');
  assert.equal(result.pinState, 'pinned_post_observed');
  assert.equal(result.fullTimeline, false);
  assert.equal(result.page.hasNextPage, true);
  assert.equal(result.page.truncatedByLimit, true);
  assert.equal(result.page.pageCount, 2);
  assert.equal(result.receipt.targetIdVerifiedAgainstRoute, true);
  assert.equal(result.receipt.captured, false);
  assert.match(result.receipt.captureSource, /browser_next_page_request_not_captured/);
  assert.equal(result.receipt.pages[1].cursorFingerprint.length, 16);
  assert.equal(JSON.stringify(result).includes(cursors[0]), false);
});

test('profile timeline marks complete only after a terminal service page within the requested limit', async () => {
  const deps = optionsFor({
    pageHandler: () => pagePayload([
      post('3996994421430736442', OWNER, 1_700_000_004),
      post('3996994421430736441', OWNER, 1_700_000_003),
    ], false, null),
  });
  const result = await readThreadsProfileTimeline({ handle: OWNER, limit: 30 }, deps);
  assert.equal(result.page.pageCount, 1);
  assert.equal(result.page.hasNextPage, false);
  assert.equal(result.fullTimeline, true);
  assert.equal(result.coverage, 'complete_profile_threads_timeline');
});

test('profile timeline permits selected caption null while rejecting an absent caption field', async () => {
  const mediaOnly = post('3996994421430736442', OWNER, 1_700_000_004);
  mediaOnly.caption = null;
  const mediaResult = await readThreadsProfileTimeline({ handle: OWNER, limit: 30 }, optionsFor({
    pageHandler: () => pagePayload([mediaOnly], false, null),
  }));
  assert.equal(mediaResult.posts[0].text, '');
  assert.equal(mediaResult.fullTimeline, true);

  const unknownShape = post('3996994421430736442', OWNER, 1_700_000_004);
  delete unknownShape.caption;
  await assert.rejects(readThreadsProfileTimeline({ handle: OWNER, limit: 30 }, optionsFor({
    pageHandler: () => pagePayload([unknownShape], false, null),
  })), error => error.code === 'THREADS_SOCIAL_PROFILE_POST_SCHEMA');
});

test('profile timeline rejects mismatched route identity and out-of-range limits before GraphQL', async () => {
  let queries = 0;
  const deps = optionsFor({
    documentHtml: htmlResponse({ userId: '19999999999' }),
    pageHandler: () => { queries += 1; return pagePayload([], false, null); },
  });
  await assert.rejects(readThreadsProfileTimeline({ handle: OWNER, limit: 30 }, deps),
    error => error.code === 'THREADS_SOCIAL_PROFILE_PRELOAD_INVALID');
  await assert.rejects(readThreadsProfileTimeline({ handle: OWNER, limit: 101 }, deps),
    error => error.code === 'THREADS_SOCIAL_PROFILE_LIMIT_INVALID');
  assert.equal(queries, 0);
});
