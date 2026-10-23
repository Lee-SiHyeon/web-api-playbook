import test from 'node:test';
import assert from 'node:assert/strict';
import { freshMetaAuthFields } from '../../social-actions/lib/meta-bootstrap.mjs';
import {
  buildThreadsDownwardVariables, buildThreadsTargetVariables,
  readThreadsPostsById, verifyThreadsChainReadback,
} from '../scripts/sns/readers/threads-readback.mjs';

const owner = 'lifehack__ailab';
const ownerId = '17824859444';
const ids = ['3995909021043553421', '3995909095316310859', '3995909206909914668'];

function fakeContext() {
  const modules = new Map([
    ['DTSGInitialData', { token: 'fresh-test-dtsg' }],
    ['LSD', { token: 'fresh-test-lsd' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
      __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
    ['RelayAPIConfigDefaults', { actorID: ownerId, graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'fake-app' } }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
  ]);
  return { service: 'threads', handle: owner, createdAt: Date.now(), requestCount: 0,
    bundle: { service: 'threads', owner, ownerId, origin: 'https://www.threads.com',
      cookies: [{ name: 'csrftoken', value: 'fake-csrf', domain: 'threads.com', path: '/', secure: true }] },
    document: { modules, route: { canonicalRouteName: 'profile' } },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig value.charCodeAt(i)' }]]) };
}

function post(id, position) {
  return { pk: id, id: `${id}_${ownerId}`, code: `code${position}`, user: { username: owner, id: ownerId },
    caption: { text: `post ${position}` }, text_post_app_info: { is_reply: position > 1,
      self_thread_info: { id: 'self-thread-123', post_position_in_self_thread: position, self_thread_length: 3 } } };
}

test('captured GraphQL variable builders preserve operation-specific fields', () => {
  const target = buildThreadsTargetVariables(ids[0]);
  const downward = buildThreadsDownwardVariables(ids[0]);
  assert.equal(target.postID, ids[0]);
  assert.equal(target.__relay_internal__pv__BarcelonaIsLoggedInrelayprovider, true);
  assert.equal(target.__relay_internal__pv__BarcelonaHasSportTeamAllegianceCardrelayprovider, true);
  assert.equal(Object.hasOwn(target, '__relay_internal__pv__BarcelonaHasSportTeamAllegiancerelayprovider'), false);
  assert.equal(downward.postID, ids[0]);
  assert.equal(downward.sortOrder, 'TOP');
  assert.equal(downward.__relay_internal__pv__BarcelonaHasPermalinkIndentationrelayprovider, true);
  assert.equal(downward.__relay_internal__pv__BarcelonaHasSportTeamAllegianceCardrelayprovider, true);
  assert.throws(() => buildThreadsDownwardVariables('not-an-id'), /THREADS_READBACK_POST_ID_INVALID/);
});

test('fresh Meta request auth fields require current bootstrap and use the observed utility', () => {
  const context = fakeContext();
  const auth = freshMetaAuthFields(context);
  assert.equal(auth.fbDtsg, 'fresh-test-dtsg');
  assert.equal(auth.jazoest, '2' + [...'fresh-test-dtsg'].reduce((sum, char) => sum + char.charCodeAt(0), 0));
  assert.equal(auth.lsd, 'fresh-test-lsd');
  context.sources.set('DTSGUtils', { source: 'unrelated module' });
  assert.throws(() => freshMetaAuthFields(context), /META_TOKEN_DERIVATION_CHANGED/);
});

test('Threads owner GraphQL target and downward queries read the exact linked post chain', async () => {
  const context = fakeContext();
  const requests = [];
  const postMap = new Map(ids.map((id, index) => [id, post(id, index + 1)]));
  const result = await readThreadsPostsById(ids.slice(0, 2), { context, querySender: async (_context, request) => {
    requests.push(request);
    assert.equal(new URL(request.url).pathname, '/api/graphql');
    assert.equal(request.method, 'POST');
    assert.equal(request.body instanceof URLSearchParams, true);
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    const operation = request.body.get('fb_api_req_friendly_name');
    const docId = request.body.get('doc_id');
    const variables = JSON.parse(request.body.get('variables'));
    const id = variables.postID;
    if (operation === 'BarcelonaPostPageTargetQuery') {
      assert.equal(docId, '28075442415461409');
      assert.equal(Object.keys(variables).includes('sortOrder'), false);
      return { payload: { data: { media: postMap.get(id) } }, receipt: { httpStatus: 200, operation, path: '/api/graphql', bytes: 10 } };
    }
    assert.equal(operation, 'BarcelonaPostPageDownwardQuery');
    assert.equal(docId, '28129600913406640');
    assert.equal(variables.sortOrder, 'TOP');
    const position = ids.indexOf(id);
    const child = postMap.get(ids[position + 1]);
    const children = child ? [child] : [];
    return { payload: { data: { media: { id: `${id}_${ownerId}`, text_post_app_info: {
      self_thread: { posts: { edges: children.map(node => ({ node })) } },
    } } } }, receipt: { httpStatus: 200, operation, path: '/api/graphql', bytes: 10 } };
  } });
  assert.equal(requests.length, 4);
  assert.deepEqual(result.posts.map(item => item.id), ids);
  assert.deepEqual(result.posts.map(item => item.position), [1, 2, 3]);
  assert.deepEqual(result.relations, [
    { parentId: ids[0], childIds: [ids[1]] },
    { parentId: ids[1], childIds: [ids[2]] },
  ]);
  assert.equal(result.ownerVerified, true);
  assert.equal(result.credentialProvider, 'windows_dpapi_current_user');
  assert.equal(result.liveReplay, true);
  assert.equal(JSON.stringify(result).includes('fresh-test-dtsg'), false);
  assert.equal(verifyThreadsChainReadback(result, ids, ['post 1', 'post 2', 'post 3']).verified, true);
  assert.deepEqual(verifyThreadsChainReadback(result, ids, ['wrong 1', 'wrong 2', 'wrong 3']), {
    verified: false, reason: 'THREADS_READBACK_CAPTION_MISMATCH',
  });
  assert.deepEqual(verifyThreadsChainReadback(result, ids), {
    verified: false, reason: 'THREADS_READBACK_SCHEMA',
  });
});
