import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sendMetaQuery } from '../lib/meta-bootstrap.mjs';
import { readThreadsComments } from '../threads-social.mjs';

const ORIGIN = 'https://www.threads.com';
const OWNER = 'lifehack__ailab';
const OWNER_ID = '17824859444';
const POST_ID = '3996994421430736442';
const AUTHOR = 'sample_author';
const DIRECT_REPLIES_OPERATION = 'BarcelonaPostPageDirectRepliesRefetchQuery';

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-partial-reply-read-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function fieldError(path, extra = {}) {
  return { code: 4686025, severity: 'ERROR', is_not_critical: true, requires_reauth: false,
    is_transient: false, is_silent: true, allow_user_retry: false, path, ...extra };
}

function partialPayload() {
  const path = ['media', 'text_post_app_info', 'direct_replies', 'edges', 0, 'node', 'posts', 'edges', 0,
    'node', 'text_post_app_info', 'share_info', 'quoted_post'];
  return {
    data: { media: { text_post_app_info: { direct_replies: { edges: [{ node: { posts: { edges: [{ node: {
      text_post_app_info: { share_info: { quoted_post: { text_post_app_info: {} } } },
    } }] } } }] } } } },
    errors: [
      fieldError([...path, 'text_post_app_info', 'is_ghost_post']),
      fieldError([...path, 'text_post_app_info', 'can_reply']),
    ],
  };
}

function manyGroupPartialPayload({ groupCount = 2, errorsPerGroup = 57, nullQuotedPost = false } = {}) {
  const edges = [];
  const errors = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const quote = nullQuotedPost ? null : { text_post_app_info: {} };
    edges.push({ node: { posts: { edges: [{ node: {
      text_post_app_info: { share_info: { quoted_post: quote } },
    } }] } } });
    for (let errorIndex = 0; errorIndex < errorsPerGroup; errorIndex += 1) {
      errors.push(fieldError(['media', 'text_post_app_info', 'direct_replies', 'edges', groupIndex, 'node',
        'posts', 'edges', 0, 'node', 'text_post_app_info', 'share_info', 'quoted_post',
        'text_post_app_info', `field_${errorIndex}`]));
    }
  }
  return { data: { media: { text_post_app_info: { direct_replies: { edges } } } }, errors };
}

function transportContext(root, payload, { service = 'threads', origin = ORIGIN } = {}) {
  let dispatches = 0;
  const context = { service, throttleRoot: root, readBudgetRoot: root,
    readBudgetLimits: { perMinute: 30, perHour: 100 },
    bundle: { service, origin, owner: OWNER, ownerId: OWNER_ID, cookies: [] },
    fetchImpl: async () => {
      dispatches += 1;
      const response = new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      Object.defineProperty(response, 'url', { value: origin + '/api/graphql' });
      return response;
    } };
  return { context, dispatches: () => dispatches };
}

function request(operation = DIRECT_REPLIES_OPERATION, origin = ORIGIN) {
  return { url: origin + '/api/graphql', method: 'POST', headers: {},
    body: new URLSearchParams({ fb_api_req_friendly_name: operation, variables: '{}' }) };
}

test('the captured noncritical quoted-post field errors yield metadata only, never their page payload', async () => {
  await withRoot(async root => {
    const fixture = transportContext(root, partialPayload());
    const result = await sendMetaQuery(fixture.context, request());
    assert.equal(fixture.dispatches(), 1);
    assert.equal(result.partialGraphqlRead, true);
    assert.equal(result.payload, null);
    assert.equal(result.receipt.operation, DIRECT_REPLIES_OPERATION);
    assert.equal(result.receipt.httpStatus, 200);
    assert.equal(result.receipt.partialGraphqlRead, true);
    assert.equal(result.receipt.providerErrorCode, 4686025);
    assert.equal(result.receipt.providerErrorCount, 2);
    assert.equal(JSON.stringify(result).includes('errors'), false);
  });
});

test('the same bounded error applies to both observed comment-page read operations', async () => {
  for (const operation of ['BarcelonaPostPageDownwardQuery', DIRECT_REPLIES_OPERATION]) {
    await withRoot(async root => {
      const fixture = transportContext(root, partialPayload());
      const result = await sendMetaQuery(fixture.context, request(operation));
      assert.equal(fixture.dispatches(), 1);
      assert.equal(result.partialGraphqlRead, true);
      assert.equal(result.payload, null);
      assert.equal(result.receipt.operation, operation);
      assert.equal(result.receipt.providerErrorCount, 2);
    });
  }
});

test('a missing quoted-post object is safe only for the exact noncritical quoted-field error page', async () => {
  await withRoot(async root => {
    const fixture = transportContext(root, manyGroupPartialPayload({ groupCount: 1, errorsPerGroup: 2, nullQuotedPost: true }));
    const result = await sendMetaQuery(fixture.context, request('BarcelonaPostPageDownwardQuery'));
    assert.equal(result.partialGraphqlRead, true);
    assert.equal(result.payload, null);
    assert.equal(result.receipt.providerErrorCount, 2);
  });
});

test('bounded partial handling supports repeated quote-field errors across multiple reply groups', async () => {
  await withRoot(async root => {
    const fixture = transportContext(root, manyGroupPartialPayload({ groupCount: 2, errorsPerGroup: 57 }));
    const result = await sendMetaQuery(fixture.context, request('BarcelonaPostPageDownwardQuery'));
    assert.equal(fixture.dispatches(), 1);
    assert.equal(result.partialGraphqlRead, true);
    assert.equal(result.payload, null);
    assert.equal(result.receipt.providerErrorCount, 114);
  });
});

test('partial handling rejects other operations, paths, flags, mixed errors and challenge responses', async () => {
  const cases = [
    { name: 'another operation', operation: 'BarcelonaPostPageTargetQuery', mutate: () => {}, code: 'META_GRAPHQL_REJECTED' },
    { name: 'mutation operation', operation: 'useTHCreateRepostMutation', mutate: () => {}, code: 'META_GRAPHQL_REJECTED' },
    { name: 'another field path', mutate: payload => { payload.errors[0].path[13] = 'user'; }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'mixed error codes', mutate: payload => { payload.errors.push({ code: 17, severity: 'ERROR' }); }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'critical provider flag', mutate: payload => { payload.errors[0].is_not_critical = false; }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'reauth requirement', mutate: payload => { payload.errors[0].requires_reauth = true; }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'transient error', mutate: payload => { payload.errors[0].is_transient = true; }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'challenge marker', mutate: payload => { payload.errors[0].message = 'checkpoint required'; }, code: 'META_INTERACTION_REQUIRED' },
    { name: 'authentication marker', mutate: payload => { payload.errors[0].message = 'login required'; }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'session expiry marker', mutate: payload => { payload.errors[0].message = 'SESSION_EXPIRED'; }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'login-required marker', mutate: payload => { payload.errors[0].message = 'LOGIN_REQUIRED'; }, code: 'META_GRAPHQL_REJECTED' },
    { name: 'top-level error', mutate: payload => { payload.error = { code: 4686025 }; }, code: 'META_GRAPHQL_REJECTED' },
  ];
  for (const item of cases) await withRoot(async root => {
    const payload = partialPayload();
    item.mutate(payload);
    const fixture = transportContext(root, payload);
    await assert.rejects(sendMetaQuery(fixture.context, request(item.operation)), { code: item.code }, item.name);
    assert.equal(fixture.dispatches(), 1, item.name);
  });
});

test('the same provider error remains a strict rejection for Instagram', async () => {
  await withRoot(async root => {
    const origin = 'https://www.instagram.com';
    const fixture = transportContext(root, partialPayload(), { service: 'instagram', origin });
    await assert.rejects(sendMetaQuery(fixture.context, request(DIRECT_REPLIES_OPERATION, origin)),
      { code: 'META_GRAPHQL_REJECTED' });
    assert.equal(fixture.dispatches(), 1);
  });
});

function ownerPost(count) {
  return { data: { media: { id: POST_ID, code: 'RootCode123', user: { username: AUTHOR }, caption: { text: 'root' },
    has_liked: false, text_post_app_info: { is_reply: false, can_reply: true, direct_reply_count: count } } } };
}

function downwardPage() {
  const reply = { id: '3996994421430736450', user: { pk: '10000000001', username: 'positive_actor' },
    caption: { text: 'observed reply' }, has_liked: false,
    text_post_app_info: { is_reply: true, can_reply: true, direct_reply_count: 0 } };
  return { data: { media: { id: `${POST_ID}_${OWNER_ID}`, text_post_app_info: { direct_replies: {
    edges: [{ node: { posts: { edges: [{ node: reply }], page_info: { has_next_page: false, end_cursor: null } } } }],
    page_info: { has_next_page: true, end_cursor: 'opaque-next' },
  } } } } };
}

function commentContext() {
  const modules = new Map([
    ['DTSGInitialData', { token: 'test-dtsg' }], ['LSD', { token: 'test-lsd' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
      __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
    ['RelayAPIConfigDefaults', { actorID: OWNER_ID, graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'test-app' } }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
  ]);
  return { service: 'threads', handle: OWNER, createdAt: Date.now(), requestCount: 0,
    bundle: { service: 'threads', owner: OWNER, ownerId: OWNER_ID, origin: ORIGIN,
      cookies: [{ name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true }] },
    document: { modules, route: { canonicalRouteName: 'comet.threads.BarcelonaProfileThreadsColumnRoute' } },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig value.charCodeAt(i)' }]]) };
}

test('a rejected continuation keeps prior parent-bound positives and returns incomplete coverage', async () => {
  const operations = [];
  let rootReads = 0;
  const querySender = async (_context, requestValue) => {
    const operation = requestValue.body.get('fb_api_req_friendly_name');
    operations.push(operation);
    if (operation === 'BarcelonaPostPageTargetQuery') return { payload: ownerPost(rootReads++ === 0 ? 2 : 2),
      receipt: { operation, httpStatus: 200 } };
    if (operation === 'BarcelonaPostPageDownwardQuery') return { payload: downwardPage(),
      receipt: { operation, httpStatus: 200 } };
    if (operation === DIRECT_REPLIES_OPERATION) return { payload: null, partialGraphqlRead: true,
      receipt: { operation, httpStatus: 200, partialGraphqlRead: true, providerErrorCode: 4686025, providerErrorCount: 57 } };
    assert.fail(`unexpected operation ${operation}`);
  };
  const result = await readThreadsComments(POST_ID, { expectedAuthor: AUTHOR, context: commentContext(), querySender });
  assert.deepEqual(operations, ['BarcelonaPostPageTargetQuery', 'BarcelonaPostPageDownwardQuery', DIRECT_REPLIES_OPERATION]);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].author, 'positive_actor');
  assert.equal(result.comments[0].directParentPostId, POST_ID);
  assert.equal(result.page.coverage, 'partial_direct_replies');
  assert.equal(result.page.graphqlIncomplete, true);
  assert.equal(result.page.fullList, false);
  assert.equal(result.page.stableCount, false);
  assert.equal(result.receipt.comments.pages.length, 2);
  assert.equal(result.receipt.comments.pages[1].partialGraphqlRead, true);
});

test('a partial initial page with zero or positive root count is incomplete, never evidence of absence', async () => {
  for (const count of [0, 2]) {
    const operations = [];
    const querySender = async (_context, requestValue) => {
      const operation = requestValue.body.get('fb_api_req_friendly_name');
      operations.push(operation);
      if (operation === 'BarcelonaPostPageTargetQuery') return { payload: ownerPost(count),
        receipt: { operation, httpStatus: 200 } };
      if (operation === 'BarcelonaPostPageDownwardQuery') return { payload: null, partialGraphqlRead: true,
        receipt: { operation, httpStatus: 200, partialGraphqlRead: true, providerErrorCode: 4686025, providerErrorCount: 57 } };
      assert.fail(`unexpected operation ${operation}`);
    };
    const result = await readThreadsComments(POST_ID, { expectedAuthor: AUTHOR, context: commentContext(), querySender });
    assert.deepEqual(operations, ['BarcelonaPostPageTargetQuery', 'BarcelonaPostPageDownwardQuery']);
    assert.equal(result.postId, POST_ID);
    assert.equal(result.postAuthor, AUTHOR);
    assert.equal(result.totalDirectReplyCount, count);
    assert.deepEqual(result.comments, []);
    assert.equal(result.page.coverage, 'partial_direct_replies');
    assert.equal(result.page.graphqlIncomplete, true);
    assert.equal(result.page.hasNextPage, null);
    assert.equal(result.page.countMatches, false);
    assert.equal(result.page.stableCount, false);
    assert.equal(result.page.fullList, false);
    assert.equal(result.selfThreadPage.fullList, false);
    assert.equal(result.receipt.comments.pages.length, 1);
    assert.equal(result.receipt.comments.pages[0].partialGraphqlRead, true);
  }
});
