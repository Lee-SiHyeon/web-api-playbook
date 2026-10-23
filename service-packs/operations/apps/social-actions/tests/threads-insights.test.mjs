import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadsInsightVariables, threadsInsightDateRange, decodeThreadsInsightResponse,
  cleanThreadsInsightData, createThreadsInsightsClient } from '../threads-insights.mjs';
import { metaRequest, sendMetaQuery } from '../lib/meta-bootstrap.mjs';

const range = { startDate: '2026-09-01', endDate: '2026-09-30' };
const owner = 'lifehack__ailab', postId = '3998034189039723903', code = 'Dd73umVlGV_';
const post = { pk: postId, code, user: { username: owner }, media_type: 19, like_count: 0,
  text_post_app_info: { impression_count: null, direct_reply_count: 1, repost_count: 0, quote_count: 0 } };
const postsPayload = () => ({ data: { viewer: { content_insights: { posts: {
  edges: [{ node: { post: structuredClone(post) } }], page_info: { has_next_page: true, end_cursor: 'opaque-next-page' },
} } } } });
const context = () => ({ service: 'threads', createdAt: Date.now(), requestCount: 0, url: 'https://www.threads.com/@' + owner + '/',
  bundle: { service: 'threads', origin: 'https://www.threads.com', owner, ownerId: '17824859444',
    cookies: [{ name: 'csrftoken', value: 'fixture-csrf', domain: '.threads.com' }] },
  document: { modules: new Map([
    ['DTSGInitialData', { token: 'fixture-dtsg' }], ['LSD', { token: 'fixture-lsd' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
    ['SiteData', { haste_session: 'fixture', pr: 1, client_revision: '1', hsi: '1', comet_env: '0', __spin_r: '1', __spin_b: 'trunk', __spin_t: '1' }],
    ['RelayAPIConfigDefaults', { actorID: '17824859444', customHeaders: { 'x-ig-app-id': 'fixture-app' } }],
  ]) }, sources: new Map([['DTSGUtils', { source: 'SprinkleConfig .charCodeAt(' }]]),
  documentReceipt: { httpStatus: 200, ownerVerified: true, browserUsed: false } });

test('date validation rejects normalized invalid dates, reversed ranges and unobserved large spans', () => {
  assert.deepEqual(threadsInsightDateRange(range), range);
  for (const dates of [ { startDate: '2026-02-30', endDate: '2026-03-01' },
    { startDate: '2026-10-01', endDate: '2026-09-01' }, { startDate: '2026-01-01', endDate: '2026-10-01' },
    { startDate: '2026-09-01T00:00Z', endDate: '2026-09-30' } ]) {
    assert.throws(() => threadsInsightDateRange(dates), { code: 'THREADS_INSIGHTS_DATE_INPUT' });
  }
});

test('timezone namespaces remain distinct across captured cards and post variables use numeric post ID', () => {
  assert.equal(buildThreadsInsightVariables('summary', range).timeZoneID, 'ASIA_SEOUL');
  assert.equal(buildThreadsInsightVariables('links', range).timeZoneName, 'Asia/Seoul');
  assert.equal(buildThreadsInsightVariables('aiSummary', range).timeZone, 'Asia/Seoul');
  assert.equal(buildThreadsInsightVariables('post', range, postId).mediaID, postId);
  assert.throws(() => buildThreadsInsightVariables('post', range, code), { code: 'THREADS_INSIGHTS_POST_INPUT' });
});

test('insufficient-follower status retains usable data and missing demographic values remain null', () => {
  const payload = { data: { xigTextAppViewer: { text_app_account_insights: {
    status: 'UNAVAILABLE_INSUFFICIENT_FOLLOWER_COUNT', data: { engagement_summary: { views: [{ value: 14132 }] },
      follower_demographics: null, viewers: { interests: [{ label: 'AI', community_favicon_url: 'https://cdn.example/signed?token=fixture' }] } },
  } } } };
  const result = decodeThreadsInsightResponse('audience', payload);
  assert.equal(result.status, 'UNAVAILABLE_INSUFFICIENT_FOLLOWER_COUNT');
  assert.equal(result.data.follower_demographics, null);
  assert.deepEqual(result.data.viewers.interests, [{ label: 'AI' }]);
  assert.deepEqual(decodeThreadsInsightResponse('aiSummary', { data: { xth_insights_ai_summary: null } }), { available: false, summary: null });
  assert.throws(() => decodeThreadsInsightResponse('summary', { data: {} }), { code: 'THREADS_INSIGHTS_SCHEMA' });
});

test('owner list keeps unknown impressions null, rejects another actor, and never claims pagination exhaustion', () => {
  const result = decodeThreadsInsightResponse('posts', postsPayload());
  assert.equal(result.posts[0].impressions, null);
  assert.equal(result.hasNextPage, true);
  assert.equal(result.fullInventory, false);
  assert.equal(result.paginationSupported, false);
  const foreign = postsPayload(); foreign.data.viewer.content_insights.posts.edges[0].node.post.user.username = 'somebody';
  assert.throws(() => decodeThreadsInsightResponse('posts', foreign), { code: 'THREADS_INSIGHTS_OWNER_MISMATCH' });
});

test('panel and rates reject the text-app namespace or mismatching post/actor identity', () => {
  const payload = { data: { media: { id: postId + '_17824859444', pk: postId, code,
    user: { username: owner }, text_post_app_info: { post_insights: { impressions_breakdown: { total: 59 } } } }, mediaInsights: {} } };
  assert.equal(decodeThreadsInsightResponse('post', payload, { postId, code }).metrics.impressions_breakdown.total, 59);
  payload.data.media.id = '18148528909557989_17824859444';
  assert.throws(() => decodeThreadsInsightResponse('postRates', payload, { postId, code }), { code: 'THREADS_INSIGHTS_POST_IDENTITY' });
});

test('shared GraphQL cooldown blocks bootstrap and query before any network request', async () => {
  let opens = 0;
  await assert.rejects(createThreadsInsightsClient({ ...range,
    openContext: async () => { opens++; return context(); },
    readCooldown: async () => ({ rateLimited: true, retryAt: Date.now() + 60_000, httpStatus: 200 }),
  }), { code: 'META_GRAPHQL_THROTTLED', httpStatus: 200 });
  assert.equal(opens, 0);
  let limited = false, sends = 0;
  const client = await createThreadsInsightsClient({ ...range, openContext: async () => context(),
    readCooldown: async () => limited ? { rateLimited: true, retryAt: Date.now() + 60_000 } : null,
    sendQuery: async () => { sends++; return { payload: postsPayload(), receipt: { httpStatus: 200 } }; } });
  limited = true;
  await assert.rejects(client.read('posts'), { code: 'META_GRAPHQL_THROTTLED' });
  assert.equal(sends, 0);
});

test('post reads require identity previously returned by the protected owner list', async () => {
  let sends = 0;
  const client = await createThreadsInsightsClient({ ...range, openContext: async () => context(), readCooldown: async () => null,
    sendQuery: async () => { sends++; return { payload: postsPayload(), receipt: { httpStatus: 200 } }; } });
  await assert.rejects(client.read('post', { id: postId, code }), { code: 'THREADS_INSIGHTS_POST_NOT_OBSERVED' });
  assert.equal(sends, 0);
  const list = await client.read('posts');
  assert.equal(list.receipt.live_replay, false);
  assert.equal(list.receipt.credential_propagated, false);
  await assert.rejects(client.read('post', { ...list.data.posts[0], code: 'wrong' }), { code: 'THREADS_INSIGHTS_POST_NOT_OBSERVED' });
  assert.equal(sends, 1);
});

test('new graph path keeps the old default and fails closed for any other origin or path', async () => {
  const ctx = context();
  assert.equal(metaRequest(ctx, 'fixture', '1234567890123', {}).url, 'https://www.threads.com/api/graphql');
  assert.equal(metaRequest(ctx, 'fixture', '1234567890123', {}, { graphPath: '/graphql/query' }).url, 'https://www.threads.com/graphql/query');
  assert.throws(() => metaRequest(ctx, 'fixture', '1234567890123', {}, { graphPath: '/evil' }), { code: 'META_REQUEST_SCOPE' });
  await assert.rejects(sendMetaQuery(ctx, { url: 'https://evil.example/api/graphql' }), { code: 'META_REQUEST_SCOPE' });
  const ig = { ...ctx, service: 'instagram' };
  assert.throws(() => metaRequest(ig, 'fixture', '1234567890123', {}, { graphPath: '/graphql/query' }), { code: 'META_REQUEST_SCOPE' });
  assert.deepEqual(cleanThreadsInsightData({ logging_info_token: 'fixture', views: null }), { views: null });
});

test('nested temporary URL parameters and token fields cannot escape through analytics output', () => {
  assert.deepEqual(cleanThreadsInsightData({ nested: { url: 'https://example.com/media?signature=fixture#key', access_token: 'fixture' } }),
    { nested: { url: 'https://example.com/media' } });
  const links = decodeThreadsInsightResponse('links', { data: { xdtTextAppViewer: { contentInsights: { links: { edges: [{ node: {
    click_count: '0', link: { id: '12345', raw_url: 'https://example.com/path?token=fixture#secret' },
  } }] } } } } });
  assert.equal(links[0].url, 'https://example.com/path');
});

test('known unavailable account data and nullable panel metrics preserve absence without inventing zero', () => {
  assert.deepEqual(decodeThreadsInsightResponse('summary', { data: { xigTextAppViewer: { text_app_account_insights: {
    status: 'UNAVAILABLE_INSUFFICIENT_FOLLOWER_COUNT', data: null,
  } } } }), { status: 'UNAVAILABLE_INSUFFICIENT_FOLLOWER_COUNT', available: false, data: null });
  const result = decodeThreadsInsightResponse('postRates', { data: { media: { id: postId + '_17824859444', text_post_app_info: { post_insights: null } } } }, { postId, code });
  assert.equal(result.metrics, null); assert.equal(result.available, false);
});
