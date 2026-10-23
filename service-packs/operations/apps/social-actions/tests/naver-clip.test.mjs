import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNaverClipCookieHeader, createNaverClipClient, NAVER_CLIP_OPERATIONS, summarizeNaverClipOperation } from '../naver-clip.mjs';

const authCookies = () => [
  { name: 'NID_AUT', value: 'test-auth', domain: '.naver.com', path: '/', expires: -1 },
  { name: 'NID_SES', value: 'test-session', domain: '.naver.com', path: '/', expires: -1 },
  { name: 'blogOnly', value: 'not-for-clip', domain: '.blog.naver.com', path: '/', expires: -1 },
  { name: 'expired', value: 'expired', domain: '.naver.com', path: '/', expires: 1 },
];

test('builds a cookie header only for the two observed Clip API origins', () => {
  const endpoint = NAVER_CLIP_OPERATIONS.profileSelf;
  const cookie = buildNaverClipCookieHeader(authCookies(), endpoint.origin + endpoint.path, Date.now());
  assert.equal(cookie, 'NID_AUT=test-auth; NID_SES=test-session');
  assert.throws(() => buildNaverClipCookieHeader(authCookies(), 'https://blog.naver.com/', Date.now()),
    error => error.code === 'NAVER_CLIP_URL_OUT_OF_SCOPE');
  assert.throws(() => buildNaverClipCookieHeader(authCookies(), endpoint.origin + endpoint.path + '?x=1', Date.now()),
    error => error.code === 'NAVER_CLIP_URL_OUT_OF_SCOPE');
  const profileKey = 'A_Xa8mw1dacyQMJXnpsR';
  const contentUrl = `${NAVER_CLIP_OPERATIONS.contentList.origin}/studio/webapi/profiles/${profileKey}/contents/cursor?type=VOD&size=30`;
  assert.equal(buildNaverClipCookieHeader(authCookies(), contentUrl, Date.now()), 'NID_AUT=test-auth; NID_SES=test-session');
  assert.throws(() => buildNaverClipCookieHeader(authCookies(), contentUrl.replace('size=30', 'size=31'), Date.now()),
    error => error.code === 'NAVER_CLIP_URL_OUT_OF_SCOPE');
});

test('fails closed when the protected Naver authentication cookies are missing', () => {
  assert.throws(() => buildNaverClipCookieHeader([
    { name: 'NID_AUT', value: 'test', domain: '.naver.com', path: '/', expires: -1 },
  ], NAVER_CLIP_OPERATIONS.workingProgress.origin + NAVER_CLIP_OPERATIONS.workingProgress.path),
  error => error.code === 'NAVER_CLIP_AUTH_COOKIES_MISSING');
});

test('replays both observed Clip reads over direct HTTP with the protected session', async () => {
  const requests = [];
  const replies = [
    { status: 401, body: { message: 'blocked', status: 401, code: 'EP400', timestamp: 'ignored' } },
    { status: 403, body: { error: 'blocked', code: 'NOT_CLIP_PROFILE_USER', path: '/private', traceId: 'ignored' } },
  ];
  const client = createNaverClipClient({
    sessionProvider: async () => ({ provider: 'windows_dpapi_current_user', cookies: authCookies() }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const reply = replies.shift();
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });

  const profile = await client.readProfileSelf();
  const progress = await client.readWorkingProgress();
  assert.equal(profile.httpStatus, 401);
  assert.equal(profile.serviceCode, 'EP400');
  assert.equal(progress.httpStatus, 403);
  assert.equal(progress.serviceCode, 'NOT_CLIP_PROFILE_USER');
  assert.equal(requests[0].url, NAVER_CLIP_OPERATIONS.profileSelf.origin + NAVER_CLIP_OPERATIONS.profileSelf.path);
  assert.equal(requests[1].url, NAVER_CLIP_OPERATIONS.workingProgress.origin + NAVER_CLIP_OPERATIONS.workingProgress.path);
  for (const { options } of requests) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.origin, 'https://clipcreators.naver.com');
    assert.equal(options.headers.referer, 'https://clipcreators.naver.com/web/signup');
    assert.match(options.headers.cookie, /NID_AUT=/);
    assert.match(options.headers.cookie, /NID_SES=/);
    assert.doesNotMatch(options.headers.cookie, /blogOnly|expired/);
  }
});

test('reads the observed owner content cursor using profileKey and the fixed VOD query', async () => {
  const requests = [];
  const profileKey = 'A_Xa8mw1dacyQMJXnpsR';
  const replies = [
    { status: 200, body: [{ profileKey, nickname: '생활이득AI연구소' }] },
    { status: 200, body: { totalCount: 1, items: [{
      videoId: 'A8314239CCBCBBA3766A067B81E601E4E443', description: '대만 vs 홍콩 3박4일 동시 비교',
      userPublicStatusCode: 'PUBLIC_OPEN', systemExposureStatusCode: 'EXPOSURE', draft: false,
    }] } },
  ];
  const client = createNaverClipClient({
    sessionProvider: async () => ({ provider: 'windows_dpapi_current_user', cookies: authCookies() }),
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      const reply = replies.shift();
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });

  const result = await client.readContentList();
  assert.equal(result.operation, 'contentList');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.data.totalCount, 1);
  assert.equal(result.data.items[0].videoId, 'A8314239CCBCBBA3766A067B81E601E4E443');
  assert.deepEqual([...requests[1].url.searchParams.entries()], [['type', 'VOD'], ['size', '30']]);
  assert.equal(requests[1].url.pathname, `/studio/webapi/profiles/${profileKey}/contents/cursor`);
  assert.equal(requests[1].options.method, 'GET');
  assert.equal(requests[1].options.headers.referer, 'https://clipcreators.naver.com/web/contents/clips');
  assert.equal(Object.hasOwn(requests[1].options.headers, 'origin'), false);
  assert.equal(summarizeNaverClipOperation(result).publicOpenCount, 1);
  assert.equal(summarizeNaverClipOperation(result).itemCount, 1);
});

test('probe records safe readback evidence without exposing response bodies', async () => {
  const replies = [
    { status: 401, body: { message: 'private detail', code: 'EP400' } },
    { status: 403, body: { message: 'private detail', code: 'NOT_CLIP_PROFILE_USER' } },
  ];
  const client = createNaverClipClient({
    sessionProvider: async () => ({ provider: 'windows_dpapi_current_user', cookies: authCookies() }),
    fetchImpl: async () => {
      const reply = replies.shift();
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    },
  });
  const receipt = await client.probe();
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.executionMode, 'pure_http');
  assert.equal(receipt.browserUsed, false);
  assert.equal(receipt.credentialPropagated, true);
  assert.equal(receipt.operations[1].requiresClipProfile, true);
  assert.doesNotMatch(serialized, /private detail|NID_AUT=|test-session/);
});
