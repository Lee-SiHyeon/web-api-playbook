import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readThreadsComments } from '../threads-social.mjs';
import { recordThreadsGraphqlCooldown } from '../lib/threads-graphql-throttle.mjs';
import { buildThreadsDirectRepliesVariables } from '../../affiliate-api-hub/scripts/sns/readers/threads-readback.mjs';

const OWNER = 'lifehack__ailab';
const OWNER_ID = '17824859444';
const POST_ID = '3996994421430736442';
const AUTHOR = 'sample_author';
const IDS = ['3996994421430736450', '3996994421430736451', '3996994421430736452'];

function root(count) {
  return { data: { media: { id: POST_ID, code: 'RootCode123', user: { username: AUTHOR },
    caption: { text: 'root' }, has_liked: false,
    text_post_app_info: { is_reply: false, can_reply: true, direct_reply_count: count } } } };
}

function reply(id, author = 'another_user') {
  return { node: { id, user: { pk: '10000000001', username: author }, caption: { text: id }, has_liked: false,
    text_post_app_info: { is_reply: true, can_reply: true, direct_reply_count: 0 } } };
}

function page(ids, hasNext = false, cursor = null, nested = false) {
  return { data: { media: { id: `${POST_ID}_${OWNER_ID}`, text_post_app_info: {
    direct_replies: { edges: ids.map(id => ({ node: { posts: {
      edges: [reply(id)], page_info: { has_next_page: nested, end_cursor: null },
    } } })), page_info: { has_next_page: hasNext, end_cursor: cursor } },
  } } } };
}

function dependencies({ count = 2, afterCount = count, pages = [], beforeQuery } = {}) {
  const modules = new Map([
    ['DTSGInitialData', { token: 'test-dtsg' }], ['LSD', { token: 'test-lsd' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
      __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
    ['RelayAPIConfigDefaults', { actorID: OWNER_ID, graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'test-app' } }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
  ]);
  const context = { service: 'threads', handle: OWNER, createdAt: Date.now(), requestCount: 0,
    bundle: { service: 'threads', owner: OWNER, ownerId: OWNER_ID, origin: 'https://www.threads.com',
      cookies: [{ name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true }] },
    document: { modules, route: { canonicalRouteName: 'comet.threads.BarcelonaProfileThreadsColumnRoute' } },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig value.charCodeAt(i)' }]]) };
  const operations = [];
  let rootReads = 0, pageReads = 0;
  const querySender = async (_, request) => {
    const operation = request.body.get('fb_api_req_friendly_name');
    const variables = JSON.parse(request.body.get('variables'));
    operations.push(operation);
    beforeQuery?.(operation, variables, request);
    const payload = operation === 'BarcelonaPostPageTargetQuery'
      ? root(rootReads++ === 0 ? count : afterCount) : pages[pageReads++];
    assert.ok(payload, 'unexpected extra query');
    return { payload, receipt: { operation, httpStatus: 200, path: '/api/graphql', bytes: 123 } };
  };
  return { context, querySender, operations };
}

for (const expiredAfter of ['initial', 'target', 'downward', 'continuation']) {
  test(`comments refresh an expired read context after ${expiredAfter} without repeating a page`, async () => {
    let ctx, refreshes = 0;
    const cursor = 'same-observed-cursor';
    const deps = dependencies({ pages: [page([IDS[0]], true, cursor), page([IDS[1]])],
      beforeQuery(operation, variables) {
        if (operation === 'BarcelonaPostPageDirectRepliesRefetchQuery') assert.equal(variables.after, cursor);
        if ((expiredAfter === 'target' && operation === 'BarcelonaPostPageTargetQuery')
          || (expiredAfter === 'downward' && operation === 'BarcelonaPostPageDownwardQuery')
          || (expiredAfter === 'continuation' && operation === 'BarcelonaPostPageDirectRepliesRefetchQuery')) {
          ctx.createdAt = Date.now() - 180_001;
        }
      } });
    ctx = deps.context;
    if (expiredAfter === 'initial') ctx.createdAt = Date.now() - 180_001;
    const result = await readThreadsComments(POST_ID, { ...deps, expectedAuthor: AUTHOR,
      contextLoader: async (service, handle, options) => {
        refreshes++;
        assert.equal(service, 'threads'); assert.equal(handle, OWNER);
        assert.equal(options.freshDocument, true);
        ctx = { ...ctx, createdAt: Date.now(), requestCount: 0, documentReceipt: { ownerVerified: true } };
        return ctx;
      } });
    assert.ok(refreshes > 0);
    assert.equal(result.page.fullList, true);
    assert.equal(result.page.pageCount, 2);
    assert.deepEqual(deps.operations, ['BarcelonaPostPageTargetQuery', 'BarcelonaPostPageDownwardQuery',
      'BarcelonaPostPageDirectRepliesRefetchQuery', 'BarcelonaPostPageTargetQuery']);
  });
}

test('expired comment contexts cannot renew through an active shared cooldown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-comments-expiry-'));
  try {
    const deps = dependencies({ pages: [page([IDS[0]])] });
    deps.context.throttleRoot = root;
    deps.context.createdAt = Date.now() - 180_001;
    await recordThreadsGraphqlCooldown({ response: new Response('{}', { status: 200 }), root,
      operation: 'BarcelonaPostPageDownwardQuery' });
    let refreshes = 0;
    await assert.rejects(readThreadsComments(POST_ID, { ...deps,
      contextLoader: async () => { refreshes++; return deps.context; } }), { code: 'META_GRAPHQL_THROTTLED' });
    assert.equal(refreshes, 0); assert.deepEqual(deps.operations, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('comment context renewal rejects a changed or unverified owner before continuing', async () => {
  for (const changed of [{ bundle: { ownerId: '17824859999' } }, { documentReceipt: { ownerVerified: false } }]) {
    const deps = dependencies({ pages: [page([IDS[0]])] });
    deps.context.createdAt = Date.now() - 180_001;
    await assert.rejects(readThreadsComments(POST_ID, { ...deps, contextLoader: async () => ({
      ...deps.context, createdAt: Date.now(), documentReceipt: { ownerVerified: true }, ...changed,
      bundle: { ...deps.context.bundle, ...changed.bundle },
    }) }), { code: 'THREADS_SOCIAL_OWNER_UNVERIFIED' });
    assert.deepEqual(deps.operations, []);
  }
});

test('comment context renewal propagates authentication refusals without retrying', async () => {
  const deps = dependencies({ pages: [page([IDS[0]])] });
  deps.context.createdAt = Date.now() - 180_001;
  let refreshes = 0;
  await assert.rejects(readThreadsComments(POST_ID, { ...deps, contextLoader: async () => {
    refreshes++; throw Object.assign(new Error('META_LOGIN_OR_BOOTSTRAP_REQUIRED'), { code: 'META_LOGIN_OR_BOOTSTRAP_REQUIRED' });
  } }), { code: 'META_LOGIN_OR_BOOTSTRAP_REQUIRED' });
  assert.equal(refreshes, 1); assert.deepEqual(deps.operations, []);
});

test('comments reader follows captured cursor requests and verifies terminal count without leaking cursors', async () => {
  const cursor = 'opaque-page-one';
  const deps = dependencies({ pages: [page([IDS[0]], true, cursor), page([IDS[1]])],
    beforeQuery(operation, variables, request) {
      if (operation !== 'BarcelonaPostPageDirectRepliesRefetchQuery') return;
      assert.equal(request.body.get('doc_id'), '28263344770004423');
      assert.equal(variables.after, cursor);
      assert.equal(variables.first, 4);
      assert.equal(variables.filterType, null);
      assert.equal(variables.postID, POST_ID);
      assert.equal(variables.sortOrder, 'TOP');
      assert.equal(variables.__relay_internal__pv__BarcelonaShouldFetchPostAuthorFullNamerelayprovider, true);
    } });
  const result = await readThreadsComments(POST_ID, { ...deps, expectedAuthor: AUTHOR });
  assert.equal(result.page.fullList, true);
  assert.equal(result.page.pageCount, 2);
  assert.equal(result.page.observedDirectReplies, 2);
  assert.equal(result.page.stableCount, true);
  assert.equal(result.receipt.comments.pages.length, 2);
  assert.equal(result.receipt.comments.browserUsed, false);
  assert.equal(JSON.stringify(result).includes(cursor), false);
  assert.deepEqual(deps.operations, ['BarcelonaPostPageTargetQuery', 'BarcelonaPostPageDownwardQuery',
    'BarcelonaPostPageDirectRepliesRefetchQuery', 'BarcelonaPostPageTargetQuery']);
});

test('terminal hidden or unavailable replies remain partial despite successful HTTP responses', async () => {
  const deps = dependencies({ count: 16, pages: [page([IDS[0], IDS[1]], true, 'opaque-next'), page([])] });
  const result = await readThreadsComments(POST_ID, deps);
  assert.equal(result.page.hasNextPage, false);
  assert.equal(result.page.fullList, false);
  assert.equal(result.page.countMatches, false);
  assert.equal(deps.operations.filter(op => op === 'BarcelonaPostPageTargetQuery').length, 1);
});

test('count changes during a traversal cannot prove absence of an earlier owner reply', async () => {
  const deps = dependencies({ afterCount: 3, pages: [page([IDS[0], IDS[1]])] });
  const result = await readThreadsComments(POST_ID, deps);
  assert.equal(result.page.countMatches, true);
  assert.equal(result.page.stableCount, false);
  assert.equal(result.page.fullList, false);
});

test('page limit stays partial and never dispatches a guessed continuation', async () => {
  const deps = dependencies({ pages: [page([IDS[0]], true, 'opaque-next')] });
  const result = await readThreadsComments(POST_ID, { ...deps, maxPages: 1 });
  assert.equal(result.page.truncatedByLimit, true);
  assert.equal(result.page.fullList, false);
  assert.equal(deps.operations.length, 2);
});

test('repeated and missing continuation cursors stop reads before another request', async () => {
  for (const cursor of [null, 'same-cursor']) {
    const deps = dependencies({ pages: cursor === null ? [page([IDS[0]], true, null)]
      : [page([IDS[0]], true, cursor), page([IDS[1]], true, cursor)] });
    await assert.rejects(readThreadsComments(POST_ID, deps),
      { code: cursor === null ? 'THREADS_SOCIAL_COMMENTS_CURSOR_MISSING' : 'THREADS_SOCIAL_COMMENTS_CURSOR_REPEATED' });
    assert.equal(deps.operations.length, cursor === null ? 2 : 3);
  }
});

test('identical overlapping pages deduplicate replies instead of inflating completeness', async () => {
  const deps = dependencies({ count: 3, pages: [page([IDS[0], IDS[1]], true, 'next-page'), page([IDS[1]])] });
  const result = await readThreadsComments(POST_ID, deps);
  assert.equal(result.comments.length, 2);
  assert.equal(result.page.fullList, false);
});

test('a conflicting repeated reply or another target ID rejects the traversal', async () => {
  const conflicting = page([IDS[0]]);
  conflicting.data.media.text_post_app_info.direct_replies.edges[0].node.posts.edges[0].node.caption.text = 'edited';
  await assert.rejects(readThreadsComments(POST_ID, dependencies({
    pages: [page([IDS[0]], true, 'next-page'), conflicting],
  })), { code: 'THREADS_SOCIAL_COMMENTS_CONFLICTING_REPLY' });
  const wrong = page([IDS[1]]);
  wrong.data.media.id = '2996994421430736442';
  await assert.rejects(readThreadsComments(POST_ID, dependencies({
    pages: [page([IDS[0]], true, 'next-page'), wrong],
  })), { code: 'THREADS_SOCIAL_COMMENTS_SCHEMA' });
});

test('nested continuations and descendants cannot fill a missing direct-reply count', async () => {
  const nested = page([IDS[0]], false, null, true);
  nested.data.media.text_post_app_info.direct_replies.edges[0].node.posts.edges.push(reply(IDS[1], OWNER));
  const result = await readThreadsComments(POST_ID, dependencies({ pages: [nested] }));
  assert.equal(result.comments.length, 2);
  assert.equal(result.page.observedDirectReplies, 1);
  assert.equal(result.page.nestedContinuationAvailable, true);
  assert.equal(result.page.fullList, false);
});

test('an owner reply returned on a later page keeps its exact parent identity', async () => {
  const next = page([IDS[1]]);
  next.data.media.text_post_app_info.direct_replies.edges[0].node.posts.edges[0].node.user.username = OWNER;
  const result = await readThreadsComments(POST_ID, dependencies({ pages: [page([IDS[0]], true, 'next'), next] }));
  assert.equal(result.comments.find(comment => comment.author === OWNER).directParentPostId, POST_ID);
});

test('missing or malformed nested pagination metadata cannot certify complete coverage', async () => {
  for (const info of [undefined, { has_next_page: 'false' }]) {
    const payload = page([IDS[0]]);
    payload.data.media.text_post_app_info.direct_replies.edges[0].node.posts.page_info = info;
    const result = await readThreadsComments(POST_ID, dependencies({ count: 1, pages: [payload] }));
    assert.equal(result.page.countMatches, true);
    assert.equal(result.page.nestedPaginationVerified, false);
    assert.equal(result.page.fullList, false);
  }
});

test('an empty thread is complete only after terminal pagination and two stable zero counts', async () => {
  const deps = dependencies({ count: 0, pages: [page([])] });
  const result = await readThreadsComments(POST_ID, deps);
  assert.equal(result.page.fullList, true);
  assert.equal(result.comments.length, 0);
  assert.equal(result.page.stableCount, true);
  assert.equal(deps.operations.filter(op => op === 'BarcelonaPostPageTargetQuery').length, 2);
  const changed = await readThreadsComments(POST_ID, dependencies({ count: 0, afterCount: 1, pages: [page([])] }));
  assert.equal(changed.page.fullList, false);
});

test('page limits and invalid opaque cursors fail before any request is constructed', async () => {
  for (const maxPages of [0, 26, 1.5]) {
    const deps = dependencies();
    await assert.rejects(readThreadsComments(POST_ID, { ...deps, maxPages }), { code: 'THREADS_SOCIAL_COMMENTS_PAGE_LIMIT_INVALID' });
    assert.equal(deps.operations.length, 0);
  }
  for (const cursor of ['', 'with space', 'x'.repeat(8193), null]) {
    assert.throws(() => buildThreadsDirectRepliesVariables(POST_ID, cursor), { code: 'THREADS_READBACK_CURSOR_INVALID' });
  }
});
