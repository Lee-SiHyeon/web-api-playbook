import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopedHttpSession, BLOG_ORIGIN } from '../lib/transport.mjs';

function response(body = 'ok', { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

test('browser cookies are scoped by domain, path, secure flag, and expiry', async () => {
  const sent = [];
  const session = ScopedHttpSession.fromBrowserCookies([
    { name: 'root', value: 'synthetic-root', domain: '.tistory.com', path: '/', expires: -1, secure: true },
    { name: 'manage', value: 'synthetic-path', domain: '.tistory.com', path: '/manage', expires: -1, secure: true },
    { name: 'expired', value: 'synthetic-expired', domain: '.tistory.com', path: '/', expires: 1, secure: true },
    { name: 'kakao', value: 'synthetic-kakao', domain: '.kakao.com', path: '/', expires: -1, secure: true },
  ], { now: () => 2_000, fetchImpl: async (url, init) => {
    sent.push({ url, cookie: new Headers(init.headers).get('cookie') });
    return response();
  } });

  await session.request(`${BLOG_ORIGIN}/manage/posts`);
  await session.request(`${BLOG_ORIGIN}/manager`);
  assert.match(sent[0].cookie, /root=synthetic-root/);
  assert.match(sent[0].cookie, /manage=synthetic-path/);
  assert.doesNotMatch(sent[0].cookie, /expired=|kakao=/);
  assert.match(sent[1].cookie, /root=synthetic-root/);
  assert.doesNotMatch(sent[1].cookie, /manage=|expired=|kakao=/);
});

test('browser-cookie import uses the default clock when no override is supplied', async () => {
  let sentCookie = '';
  const session = ScopedHttpSession.fromBrowserCookies([
    { name: 'sid', value: 'synthetic-default-clock', domain: '.tistory.com', path: '/', expires: Date.now() / 1000 + 3600, secure: true },
  ], { fetchImpl: async (_url, init) => {
    sentCookie = new Headers(init.headers).get('cookie') || '';
    return response();
  } });
  await session.request(BLOG_ORIGIN);
  assert.match(sentCookie, /sid=synthetic-default-clock/);
});

test('browser-cookie import rejects RFC cookie-octet violations', () => {
  for (const value of ['has"quote', 'has,comma', 'has\\backslash']) {
    assert.throws(() => ScopedHttpSession.fromBrowserCookies([
      { name: 'bad', value, domain: '.tistory.com', path: '/', expires: -1, secure: true },
    ]), { code: 'TISTORY_BROWSER_COOKIE_INVALID' });
  }
  assert.throws(() => ScopedHttpSession.fromBrowserCookies([
    { name: 'bad-expiry', value: 'synthetic', domain: '.tistory.com', path: '/', expires: Number.MAX_VALUE, secure: true },
  ]), { code: 'TISTORY_BROWSER_COOKIE_INVALID' });
});

test('observed Set-Cookie rotation and deletion affect only the allowed request jar', async () => {
  let calls = 0;
  const sent = [];
  const session = new ScopedHttpSession({ fetchImpl: async (_url, init) => {
    calls++;
    sent.push(new Headers(init.headers).get('cookie'));
    if (calls === 1) return response('', { headers: { 'set-cookie': 'sid=synthetic-rotated; Domain=.tistory.com; Path=/; Secure; HttpOnly' } });
    if (calls === 2) return response('', { headers: { 'set-cookie': 'sid=; Domain=.tistory.com; Path=/; Max-Age=0; Expires=Wed, 21 Oct 2037 07:28:00 GMT' } });
    return response();
  } });
  session.jar.setCookieSync('sid=synthetic-initial; Domain=.tistory.com; Path=/; Secure', BLOG_ORIGIN);

  await session.request(BLOG_ORIGIN);
  await session.request(BLOG_ORIGIN);
  await session.request(BLOG_ORIGIN);
  assert.match(sent[0], /sid=synthetic-initial/);
  assert.match(sent[1], /sid=synthetic-rotated/);
  assert.doesNotMatch(sent[2] || '', /sid=/);
});

test('redirects are returned to the caller and never followed automatically', async () => {
  const called = [];
  const session = new ScopedHttpSession({ fetchImpl: async (url, init) => {
    called.push({ url, redirect: init.redirect });
    return response('', { status: 302, headers: { location: 'https://accounts.kakao.com/login' } });
  } });
  const result = await session.request(BLOG_ORIGIN);
  assert.equal(result.status, 302);
  assert.equal(result.location, 'https://accounts.kakao.com/login');
  assert.deepEqual(called, [{ url: BLOG_ORIGIN + '/', redirect: 'manual' }]);
});

test('unsafe URL scopes and caller supplied cookies fail before transport', async () => {
  let calls = 0;
  const session = new ScopedHttpSession({ fetchImpl: async () => { calls++; return response(); } });
  for (const url of [
    'http://i-never-stop-study.tistory.com/',
    'https://evil.tistory.com/',
    'https://i-never-stop-study.tistory.com.attacker.test/',
    'https://user:pass@i-never-stop-study.tistory.com/',
    'https://i-never-stop-study.tistory.com/#fragment',
  ]) await assert.rejects(session.request(url), { code: 'TISTORY_SCOPE' });
  await assert.rejects(session.request(BLOG_ORIGIN, { headers: { cookie: 'synthetic=secret' } }), { code: 'TISTORY_REQUEST_HEADER_FORBIDDEN' });
  assert.equal(calls, 0);
});

test('transport errors do not expose fetch error text or credential values', async () => {
  const session = new ScopedHttpSession({ fetchImpl: async () => { throw new Error('synthetic-cookie-secret and query token'); } });
  await assert.rejects(session.request(BLOG_ORIGIN), error => {
    assert.equal(error.code, 'TISTORY_TRANSPORT_FAILED');
    assert.doesNotMatch(error.message, /synthetic-cookie-secret|query token/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('session JSON round trip keeps cookies private from metadata diagnostics', () => {
  const session = new ScopedHttpSession({ userAgent: 'Tistory test agent' });
  session.jar.setCookieSync('sid=synthetic-secret; Domain=.tistory.com; Path=/; Secure; HttpOnly', BLOG_ORIGIN);
  const metadata = session.cookieMetadata();
  assert.equal(metadata.count, 1);
  assert.equal(metadata.cookies[0].name, 'sid');
  assert.equal(JSON.stringify(metadata).includes('synthetic-secret'), false);

  const restored = ScopedHttpSession.fromJSON(session.toJSON(), { fetchImpl: async () => response() });
  assert.equal(restored.cookieMetadata().count, 1);
  assert.equal(restored.toJSON().userAgent, 'Tistory test agent');
});

test('removeTistoryCookies preserves Kakao cookies', async () => {
  const session = new ScopedHttpSession();
  session.jar.setCookieSync('blog=synthetic-blog; Domain=.tistory.com; Path=/; Secure', BLOG_ORIGIN);
  session.jar.setCookieSync('auth=synthetic-auth; Domain=.kakao.com; Path=/; Secure', 'https://accounts.kakao.com/');

  assert.deepEqual(await session.removeTistoryCookies(), { removed: 1 });
  const metadata = session.cookieMetadata();
  assert.deepEqual(metadata.cookies.map(cookie => cookie.name), ['auth']);
});

test('response bodies are bounded before being returned', async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { canceled = true; },
  });
  const session = new ScopedHttpSession({ fetchImpl: async () => ({
    status: 200,
    url: BLOG_ORIGIN + '/',
    headers: new Headers(),
    body,
  }) });
  await assert.rejects(session.request(BLOG_ORIGIN), { code: 'TISTORY_RESPONSE_TOO_LARGE' });
  assert.equal(canceled, true);
});
