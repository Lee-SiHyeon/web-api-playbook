import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchThreadsXhr, decodeViews } from '../research/content-store/threads-xhr.mjs';
import { resetTestCredentialStore } from '../scripts/secure-credential-store.mjs';
import { loadThreadsSession } from '../scripts/session-vault.mjs';

test.beforeEach(resetTestCredentialStore);

const bootstrap = () => new Response(`<script type="application/json">${JSON.stringify([
  ['LSD', [], { token: 'local-test-token' }], ['SiteData', [], { server_revision: 1, haste_session: 'local', hsi: 'local', __spin_r: 1, __spin_b: 'trunk', __spin_t: 1 }],
  { queryName: 'BarcelonaProfileThreadsTabDirectQuery', queryID: '27794157166930260', variables: { userID: '63452224831', first: 4 } },
  { caption: { text: 'HTML MUST NOT BE COLLECTED' }, user: { username: 'choi.openai' }, code: 'Html1234', taken_at: 1 }
])}</script>`, { headers: { 'set-cookie': 'csrftoken=local-csrf; Secure; Path=/', 'content-type': 'text/html' } });

test('Threads source consumes GraphQL body, passes fresh scoped CSRF, and never falls back to HTML', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    if (calls === 1) return bootstrap();
    assert.equal(url, 'https://www.threads.com/api/graphql'); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.cookie, 'csrftoken=local-csrf');
    assert.equal(options.headers['x-fb-lsd'], 'local-test-token');
    assert.equal(options.body.get('doc_id'), '27794157166930260');
    return Response.json({ data: { post: { caption: { text: 'API content' }, user: { username: 'choi.openai' }, code: 'Api12345', taken_at: 1, like_count: 2 } } });
  };
  const result = await fetchThreadsXhr('choi.openai', 8, { fetchImpl });
  assert.equal(calls, 2); assert.equal(result.items[0].summary, 'API content');
  assert.equal(result.receipt.bodyMethod, 'graphql_json'); assert.equal(result.receipt.bootstrapContentUsed, false);
  assert.equal(result.receipt.requestedLimitMet, null);
  assert.equal(JSON.stringify(result).includes('local-test-token'), false);
  resetTestCredentialStore();
  calls = 0;
  await assert.rejects(fetchThreadsXhr('choi.openai', 8, { fetchImpl: async () => ++calls === 1 ? bootstrap() : new Response('Forbidden', { status: 403 }) }), /HTTP_403/);
  assert.equal(calls, 2);
});

test('Threads first page reports partial coverage when the next cursor exists', async () => {
  const result = await fetchThreadsXhr('choi.openai', 8, { fetchImpl: async (url, options) => options?.method === 'POST' ?
    Response.json({ data: { mediaData: { page_info: { has_next_page: true, end_cursor: 'opaque' }, edges: [
      { node: { thread_items: [{ post: { caption: { text: 'First' }, user: { username: 'choi.openai' }, code: 'First123', taken_at: 1 } }] } },
    ] } } }) : bootstrap() });
  assert.equal(result.items.length, 1);
  assert.equal(result.receipt.hasNextPage, true);
  assert.equal(result.receipt.requestedLimitMet, false);
  assert.equal(JSON.stringify(result.receipt).includes('opaque'), false);
});

test('a GraphQL partial error next to an intact timeline keeps the posts; errors without a timeline still fail', async () => {
  const merge = { message: 'A server error extended_type_merge_error occured. Check server logs for details.', severity: 'ERROR' };
  const timeline = { mediaData: { page_info: { has_next_page: false }, edges: [
    { node: { thread_items: [{ post: { caption: { text: 'Kept' }, user: { username: 'choi.openai' }, code: 'Kept1234', taken_at: 1 } }] } }] } };
  const result = await fetchThreadsXhr('choi.openai', 8, { fetchImpl: async (url, options) => options?.method === 'POST' ?
    Response.json({ data: timeline, errors: [merge] }) : bootstrap() });
  assert.equal(result.items[0].summary, 'Kept');
  assert.deepEqual(result.receipt.partialErrors, [merge.message]);
  resetTestCredentialStore();
  await assert.rejects(fetchThreadsXhr('choi.openai', 8, { fetchImpl: async (url, options) => options?.method === 'POST' ?
    Response.json({ data: { viewer: null }, errors: [merge] }) : bootstrap() }), /SERVICE_ERROR/);
});

test('Threads profile query rejects login HTML returned with HTTP 200', async () => {
  let calls = 0;
  await assert.rejects(fetchThreadsXhr('choi.openai', 8, { fetchImpl: async () => ++calls === 1 ? bootstrap() :
    new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }) }), /THREADS_XHR_MIME/);
  assert.equal(calls, 2);
});

test('Threads deleted CSRF invalidates protected cache before another read', async () => {
  let calls = 0;
  const fetchImpl = async () => ++calls === 1 ? bootstrap() : new Response('{}', { headers: {
    'content-type': 'application/json', 'set-cookie': 'csrftoken=; Max-Age=0; Path=/; Domain=www.threads.com',
  } });
  await assert.rejects(fetchThreadsXhr('choi.openai', 8, { fetchImpl }), /THREADS_CSRF_INVALIDATED/);
  assert.equal(calls, 2);
  assert.equal(await loadThreadsSession('choi.openai'), null);
});

test('rejected cached Threads session fails once and invalidates cache', { skip: process.platform !== 'win32' }, async () => {
  await fetchThreadsXhr('choi.openai', 8, { fetchImpl: async (url, options) => options?.method === 'POST' ?
    Response.json({ data: { post: { caption: { text: 'API content' }, user: { username: 'choi.openai' }, code: 'Api12345', taken_at: 1 } } }) : bootstrap() });
  let calls = 0;
  await assert.rejects(fetchThreadsXhr('choi.openai', 8, { fetchImpl: async () => {
    calls++;
    return new Response('Forbidden', { status: 403 });
  } }), /THREADS_XHR_HTTP_403/);
  assert.equal(calls, 1);
  assert.equal(await loadThreadsSession('choi.openai'), null);
});

test('server-null impression count is a successful unavailable metric, not zero or HTTP failure', () => {
  assert.deepEqual(decodeViews(JSON.stringify({ data: { media: { text_post_app_info: { impression_count: null } } } })), { views: null, availability: 'not_provided_by_server' });
  assert.equal(decodeViews(JSON.stringify({ data: { media: { text_post_app_info: { impression_count: 42 } } } })).views, 42);
  assert.throws(() => decodeViews('{"errors":[{}]}'), /SERVICE_ERROR/);
  assert.throws(() => decodeViews('{"data":{}}'), /SCHEMA_UNVERIFIED/);
});
