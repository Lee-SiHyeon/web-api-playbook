import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveThreadsTopic, searchThreadsTopics } from '../threads-topics.mjs';

const OWNER = 'lifehack__ailab';
const ORIGIN = 'https://www.threads.com';

function fakeContext(fetchImpl) {
  const modules = new Map([
    ['DTSGInitialData', { token: 'fresh-test-dtsg' }],
    ['LSD', { token: 'fresh-test-lsd' }],
    ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
    ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1,
      __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
    ['RelayAPIConfigDefaults', { actorID: '17824859444', graphURI: '/api/graphql', customHeaders: { 'x-ig-app-id': 'test-app' } }],
    ['CurrentUserInitialData', { USER_ID: '0' }],
  ]);
  return { service: 'threads', handle: OWNER, createdAt: Date.now(), requestCount: 0,
    bundle: { service: 'threads', owner: OWNER, ownerId: '17824859444', origin: ORIGIN,
      cookies: [{ name: 'csrftoken', value: 'test-csrf', domain: '.threads.com', path: '/', secure: true }] },
    document: { modules, route: { canonicalRouteName: 'profile' } },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig value.charCodeAt(i)' }]]), fetchImpl };
}

function jsonResponse(payload, path) {
  const response = new Response(JSON.stringify(payload), { status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' } });
  Object.defineProperty(response, 'url', { value: `${ORIGIN}${path}` });
  return response;
}

test('Threads topic search replays the observed operation and returns normalized public topics', async () => {
  const seen = [];
  const context = fakeContext(async (url, init) => {
    seen.push({ url, init });
    const variables = JSON.parse(init.body.get('variables'));
    assert.deepEqual(variables, {
      query: '스하리 1000', disable_v1_tags: false, has_composer_flair: false,
      has_favicons: false, has_top_contributors: false, include_social_context: true,
    });
    assert.equal(init.body.get('doc_id'), '37565484953042725');
    assert.equal(init.body.get('fb_api_req_friendly_name'), 'useBarcelonaTagsMentionsGraphQLDataSourceQuery');
    return jsonResponse({ data: { xdt_text_app_tags_search: { edges: [
      { node: { entity: { display_text: '스하리 1000명 프로젝트', id: '18466046173000007' },
        search_result_subtitle: '', is_community: false,
        tag_info: { tag_name: '스하리 1000명 프로젝트', is_community: false, internal_value: 'omit' } } },
      { node: { entity: { display_text: '테스트 커뮤니티', id: '18466046173000008' },
        search_result_subtitle: '공개 검색 결과', is_community: true, tag_info: {} } },
      { node: { entity: { display_text: '', id: 'invalid' } } },
    ] } } }, '/api/graphql');
  });
  const result = await searchThreadsTopics(' 스하리 1000 ', { context });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${ORIGIN}/api/graphql`);
  assert.deepEqual(result.topics, [
    { displayText: '스하리 1000명 프로젝트', id: '18466046173000007', searchResultSubtitle: '',
      isCommunity: false, tagInfo: { tag_name: '스하리 1000명 프로젝트', is_community: false } },
    { displayText: '테스트 커뮤니티', id: '18466046173000008', searchResultSubtitle: '공개 검색 결과',
      isCommunity: true, tagInfo: null },
  ]);
  assert.equal(result.receipt.path, '/api/graphql');
  assert.equal(result.receipt.browserUsed, false);
});

test('Threads topic resolver uses the captured preflight operation and reports validity', async () => {
  const seen = [];
  const context = fakeContext(async (url, init) => {
    seen.push({ url, init });
    assert.equal(url, `${ORIGIN}/graphql/query`);
    assert.equal(init.body.get('doc_id'), '28370718605952935');
    assert.equal(init.body.get('fb_api_req_friendly_name'), 'BarcelonaTagsUtilsQuery');
    assert.deepEqual(JSON.parse(init.body.get('variables')), { tag_name: '스하리 1000명 프로젝트' });
    return jsonResponse({ data: { xdt_text_app_tags_validate: { is_sensitive: false, is_valid: true } } }, '/graphql/query');
  });
  const result = await resolveThreadsTopic({ displayText: '스하리 1000명 프로젝트', isCommunity: false }, { context });
  assert.equal(seen.length, 1);
  assert.deepEqual({ displayText: result.displayText, isValid: result.isValid, isSensitive: result.isSensitive },
    { displayText: '스하리 1000명 프로젝트', isValid: true, isSensitive: false });
  assert.deepEqual({ method: result.receipt.method, path: result.receipt.path, browserUsed: result.receipt.browserUsed },
    { method: 'POST', path: '/graphql/query', browserUsed: false });
});

test('Threads topic inputs fail closed before a request for invalid names and community topics', async () => {
  let calls = 0;
  const context = fakeContext(async () => { calls += 1; throw new Error('unexpected request'); });
  await assert.rejects(searchThreadsTopics('  ', { context }), error => error.code === 'THREADS_TOPIC_QUERY_INVALID');
  await assert.rejects(resolveThreadsTopic({ displayText: 'community', isCommunity: true }, { context }),
    error => error.code === 'THREADS_TOPIC_COMMUNITY_UNVERIFIED');
  assert.equal(calls, 0);
});
