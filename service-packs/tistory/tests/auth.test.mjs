import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_CONTRACT,
  followLoginRedirects,
  parseSimpleLogin,
  renewSession,
  verifySession,
} from '../lib/auth.mjs';
import { BLOG_ORIGIN } from '../lib/transport.mjs';

const expectedState = Buffer.from(LOGIN_CONTRACT.target).toString('base64');

function authorizeUrl(overrides = {}) {
  const url = new URL(LOGIN_CONTRACT.authorize);
  for (const [key, value] of Object.entries({
    client_id: LOGIN_CONTRACT.clientId,
    redirect_uri: LOGIN_CONTRACT.callback,
    response_type: 'code',
    state: expectedState,
    ...overrides,
  })) url.searchParams.set(key, value);
  return url.href;
}

function htmlResponse(raw, url) {
  return { status: 200, url, headers: { 'content-type': 'text/html; charset=utf-8' }, raw };
}

function jsonResponse(data, url) {
  return { status: 200, url, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(data) };
}

function simpleLoginHtml({ csrf, infos, continueUrl = authorizeUrl() }) {
  const payload = {
    page: '/login/simple_login',
    props: { pageProps: { pageContext: {
      commonContext: { _csrf: csrf },
      context: { simpleLoginInfos: infos, continueUrl },
    } } },
  };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`;
}

function mockSession(handler) {
  const calls = [];
  return {
    calls,
    async removeTistoryCookies() { return { removed: 2 }; },
    async request(url, options = {}) {
      const call = { url: String(url), options };
      calls.push(call);
      return handler(call, calls.length);
    },
  };
}

test('simple login uses fresh CSRF and sessionKey values from the current HTML response', async () => {
  const pageUrl = 'https://accounts.kakao.com/login/simple';
  const freshCsrf = 'synthetic-csrf-fresh-20260924';
  const freshSessionKey = 'synthetic-session-key-fresh-20260924';
  const selectedAccount = { displayId: 'user@example.test', sessionKey: freshSessionKey, accountType: 'synthetic' };
  let authorizeGets = 0;
  let simpleLoginPosts = 0;
  const session = mockSession((call) => {
    const url = new URL(call.url);
    if (url.hostname === 'www.tistory.com' && url.pathname === '/auth/login') {
      return htmlResponse(`<script>Kakao.init("${LOGIN_CONTRACT.clientId}")</script>`, call.url);
    }
    if (url.href === LOGIN_CONTRACT.simpleChange) {
      simpleLoginPosts++;
      const posted = JSON.parse(call.options.body);
      assert.deepEqual(posted, { _csrf: freshCsrf, loginInfo: selectedAccount, continueUrl: authorizeUrl() });
      return jsonResponse({ status: 0, continueUrl: authorizeUrl() }, call.url);
    }
    if (url.origin === 'https://kauth.kakao.com' && url.pathname === '/oauth/authorize') {
      authorizeGets++;
      if (authorizeGets === 1) return {
        status: 302, url: call.url, location: pageUrl,
        headers: { 'content-type': 'text/html', location: pageUrl }, raw: '',
      };
      return {
        status: 302, url: call.url,
        location: `${LOGIN_CONTRACT.callback}?code=synthetic-oauth-code&state=${encodeURIComponent(expectedState)}`,
        headers: { 'content-type': 'text/html', location: `${LOGIN_CONTRACT.callback}?code=synthetic-oauth-code&state=${encodeURIComponent(expectedState)}` },
        raw: '',
      };
    }
    if (url.href === pageUrl) return htmlResponse(simpleLoginHtml({ csrf: freshCsrf, infos: [selectedAccount] }), call.url);
    if (url.origin === 'https://www.tistory.com' && url.pathname === '/auth/kakao/redirect') {
      return { status: 302, url: call.url, location: `${BLOG_ORIGIN}/manage`,
        headers: { 'content-type': 'text/html', location: `${BLOG_ORIGIN}/manage` }, raw: '' };
    }
    if (url.href === `${BLOG_ORIGIN}/manage`) return htmlResponse('<html>manage</html>', call.url);
    if (url.href === 'https://www.tistory.com/api/v1/init') {
      return jsonResponse({ data: { user: { isLogin: true, id: 101, appUserId: 202 } } }, call.url);
    }
    if (url.href === `${BLOG_ORIGIN}/manage/setting/blog.json`) {
      return jsonResponse({ address: { primaryDomain: 'i-never-stop-study.tistory.com' }, info: { blogId: 303 } }, call.url);
    }
    assert.fail(`unexpected synthetic request: ${call.options.method || 'GET'} ${call.url}`);
  });

  const result = await renewSession(session, { expectedIdentity: { userId: 101, blogId: 303 } });
  assert.equal(result.identity.userId, 101);
  assert.equal(result.identity.blogId, 303);
  assert.equal(result.accountDisplayId, selectedAccount.displayId);
  assert.equal(simpleLoginPosts, 1);
  const safeTrace = JSON.stringify(result.trace);
  assert.doesNotMatch(safeTrace, /synthetic-csrf-fresh|synthetic-session-key-fresh|synthetic-oauth-code/);
});

test('simple login rejects an account hint that is absent from the fresh account list', () => {
  const html = simpleLoginHtml({ csrf: 'synthetic-csrf', infos: [
    { displayId: 'first@example.test', sessionKey: 'synthetic-first-key' },
    { displayId: 'second@example.test', sessionKey: 'synthetic-second-key' },
  ] });
  assert.throws(() => parseSimpleLogin(html, 'https://accounts.kakao.com/login/simple', 'other@example.test'), {
    code: 'TISTORY_ACCOUNT_SELECTION_REQUIRED',
  });
});

test('session verification rejects the wrong owner and wrong target blog', async () => {
  const goodUser = { isLogin: true, id: 101, appUserId: 202 };
  const goodBlog = { address: { primaryDomain: 'i-never-stop-study.tistory.com' }, info: { blogId: 303 } };
  const makeSession = ({ user = goodUser, blog = goodBlog } = {}) => mockSession(call => {
    if (call.url === 'https://www.tistory.com/api/v1/init') return jsonResponse({ data: { user } }, call.url);
    if (call.url === `${BLOG_ORIGIN}/manage/setting/blog.json`) return jsonResponse(blog, call.url);
    assert.fail(`unexpected synthetic request: ${call.url}`);
  });

  await assert.rejects(verifySession(makeSession(), { userId: 999, blogId: 303 }), { code: 'TISTORY_ACCOUNT_MISMATCH' });
  await assert.rejects(verifySession(makeSession(), { userId: 101, blogId: 999 }), { code: 'TISTORY_BLOG_MISMATCH' });
  await assert.rejects(verifySession(makeSession({ blog: {
    address: { primaryDomain: 'attacker.example' }, info: { blogId: 303 },
  } }), { userId: 101 }), { code: 'TISTORY_BLOG_MISMATCH' });
});

test('OAuth authorize requests reject wrong state, client ID, callback, and response type before network access', async () => {
  const invalid = [
    { state: 'synthetic-wrong-state' },
    { client_id: 'synthetic-wrong-client' },
    { redirect_uri: 'https://attacker.example/callback' },
    { response_type: 'token' },
  ];
  for (const query of invalid) {
    let calls = 0;
    const session = mockSession(() => { calls++; return assert.fail('invalid OAuth URL must not be requested'); });
    await assert.rejects(followLoginRedirects(session, authorizeUrl(query)), { code: 'TISTORY_OAUTH_SCOPE' });
    assert.equal(calls, 0);
  }
});

test('OAuth callback redirects must preserve the expected state', async () => {
  let calls = 0;
  const session = mockSession(call => {
    calls++;
    return {
      status: 302,
      url: call.url,
      location: `${LOGIN_CONTRACT.callback}?code=synthetic-code&state=synthetic-wrong-state`,
      headers: { location: `${LOGIN_CONTRACT.callback}?code=synthetic-code&state=synthetic-wrong-state` },
      raw: '',
    };
  });
  await assert.rejects(followLoginRedirects(session, authorizeUrl()), { code: 'TISTORY_OAUTH_STATE_MISMATCH' });
  assert.equal(calls, 1);
});

test('interactive Kakao password login page fails cleanly without a password submission', async () => {
  const session = mockSession(call => {
    const url = new URL(call.url);
    if (url.origin === 'https://www.tistory.com' && url.pathname === '/auth/login') {
      return htmlResponse(`<script>Kakao.init("${LOGIN_CONTRACT.clientId}")</script>`, call.url);
    }
    if (url.pathname === '/oauth/authorize') {
      return { status: 302, url: call.url, location: 'https://accounts.kakao.com/login/login',
        headers: { location: 'https://accounts.kakao.com/login/login' }, raw: '' };
    }
    if (url.href === 'https://accounts.kakao.com/login/login') {
      return htmlResponse('<form><input name="email"><input type="password" name="password"></form>', call.url);
    }
    assert.fail(`unexpected synthetic request: ${call.options.method || 'GET'} ${call.url}`);
  });

  await assert.rejects(renewSession(session), { code: 'TISTORY_KAKAO_REAUTH_REQUIRED' });
  assert.equal(session.calls.some(call => call.options.method === 'POST'), false);
});

test('login redirects stop after a finite maximum hop count', async () => {
  const session = mockSession(call => ({
    status: 302,
    url: call.url,
    location: 'https://accounts.kakao.com/login',
    headers: { location: 'https://accounts.kakao.com/login' },
    raw: '',
  }));
  await assert.rejects(followLoginRedirects(session, authorizeUrl()), { code: 'TISTORY_LOGIN_REDIRECT_LIMIT' });
  assert.equal(session.calls.length, 12);
});
