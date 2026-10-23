import test from 'node:test';
import assert from 'node:assert/strict';
import { resetTestCredentialStore } from '../../naver-blog-api/scripts/secure-credential-store.mjs';
import { loadState, saveState } from '../lib/state.mjs';
import { ScopedHttpSession, BLOG_ORIGIN } from '../lib/transport.mjs';
import { LOGIN_CONTRACT } from '../lib/auth.mjs';
import { login } from '../lib/operations.mjs';

function fixture(reauthRequired = false) {
  return { version: 1, blogOrigin: BLOG_ORIGIN,
    session: ScopedHttpSession.fromBrowserCookies([{ name: 'fixture', value: 'private-fixture-cookie',
      domain: '.tistory.com', path: '/', expires: -1 }]).toJSON(),
    identity: { userId: 101, blogId: 303 },
    login: { reauthRequired, accountDisplayId: 'private-fixture-account',
      lastRenewedAt: '2026-10-04T22:38:51.496Z', failedAt: reauthRequired ? '2026-10-06T03:22:33.340Z' : null,
      lastFailure: reauthRequired ? 'TISTORY_KAKAO_REAUTH_REQUIRED' : null } };
}

async function withMockFetch(operation) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (raw, options) => {
    const url = new URL(raw);
    calls.push({ path: url.pathname, method: options.method });
    assert.equal(options.method, 'GET', 'password pages must never cause an automatic auth POST');
    if (url.pathname === '/api/v1/init') return Response.json({ data: { user: { isLogin: false } } });
    if (url.pathname === '/auth/login') return new Response(`<script>Kakao.init("${LOGIN_CONTRACT.clientId}")</script>`, { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/oauth/authorize') return new Response('', { status: 302, headers: { location: 'https://accounts.kakao.com/login' } });
    if (url.hostname === 'accounts.kakao.com') return new Response('<script id="__NEXT_DATA__">{"page":"/login/login"}</script>', { headers: { 'content-type': 'text/html' } });
    assert.fail('unexpected fixture request');
  };
  try { await operation(calls); } finally { globalThis.fetch = original; resetTestCredentialStore(); }
}

function renewalState() {
  const state = fixture(true);
  state.session = ScopedHttpSession.fromBrowserCookies([
    { name: 'old_tistory', value: 'private-old-tistory-cookie', domain: '.tistory.com', path: '/', expires: -1 },
    { name: 'kakao_saved', value: 'private-kakao-cookie', domain: '.kakao.com', path: '/', expires: 0 },
  ]).toJSON();
  state.login.failureDiagnostic = {
    reason: 'saved_account_rejected', pageType: '/login/simple_login',
    savedAccountCount: 1, pinnedSelectorMatched: true, stage: 'kakao_saved_account_post',
  };
  return state;
}

async function withSuccessfulRenewalFetch({ userId = 101, blogId = 303 } = {}, operation) {
  const original = globalThis.fetch;
  const expectedState = Buffer.from(LOGIN_CONTRACT.target).toString('base64');
  const authorize = new URL(LOGIN_CONTRACT.authorize);
  authorize.search = new URLSearchParams({
    client_id: LOGIN_CONTRACT.clientId,
    redirect_uri: LOGIN_CONTRACT.callback,
    response_type: 'code',
    state: expectedState,
  });
  const calls = [];
  let initCalls = 0;
  let authorizeCalls = 0;
  globalThis.fetch = async (raw, options = {}) => {
    const url = new URL(raw);
    const headers = new Headers(options.headers);
    const call = { origin: url.origin, path: url.pathname, method: options.method || 'GET', cookie: headers.get('cookie') || '' };
    calls.push(call);

    if (url.origin === 'https://www.tistory.com' && url.pathname === '/api/v1/init') {
      initCalls++;
      return Response.json({ data: { user: { isLogin: initCalls > 1, id: userId, appUserId: 202 } } });
    }
    if (url.origin === 'https://www.tistory.com' && url.pathname === '/auth/login') {
      return new Response(`<script>Kakao.init("${LOGIN_CONTRACT.clientId}")</script>`, { headers: { 'content-type': 'text/html' } });
    }
    if (url.origin === 'https://kauth.kakao.com' && url.pathname === '/oauth/authorize') {
      authorizeCalls++;
      const location = authorizeCalls === 1
        ? 'https://accounts.kakao.com/login/simple'
        : `${LOGIN_CONTRACT.callback}?code=synthetic-oauth-code&state=${encodeURIComponent(expectedState)}`;
      return new Response('', { status: 302, headers: { location } });
    }
    if (url.origin === 'https://accounts.kakao.com' && url.pathname === '/login/simple') {
      assert.match(call.cookie, /(?:^|; )kakao_saved=private-kakao-cookie(?:;|$)/,
        'forced renewal must retain the Kakao saved-account cookie');
      const payload = {
        page: '/login/simple_login',
        props: { pageProps: { pageContext: {
          commonContext: { _csrf: 'synthetic-fresh-csrf' },
          context: { simpleLoginInfos: [{ displayId: 'private-fixture-account', sessionKey: 'synthetic-fresh-session-key' }], continueUrl: authorize.href },
        } } },
      };
      return new Response(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`,
        { headers: { 'content-type': 'text/html' } });
    }
    if (url.origin === 'https://accounts.kakao.com' && url.pathname === '/api/v2/simple_login/change.json') {
      assert.equal(call.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body._csrf, 'synthetic-fresh-csrf');
      assert.equal(body.loginInfo.displayId, 'private-fixture-account');
      return Response.json({ status: 0, continueUrl: authorize.href });
    }
    if (url.origin === 'https://www.tistory.com' && url.pathname === '/auth/kakao/redirect') {
      return new Response('', { status: 302, headers: {
        location: `${BLOG_ORIGIN}/manage`,
        'set-cookie': 'tistory_rotated=synthetic-rotated-cookie; Domain=.tistory.com; Path=/; Secure; HttpOnly',
      } });
    }
    if (url.origin === BLOG_ORIGIN && url.pathname === '/manage') {
      return new Response('<html>manage</html>', { headers: { 'content-type': 'text/html' } });
    }
    if (url.origin === BLOG_ORIGIN && url.pathname === '/manage/setting/blog.json') {
      return Response.json({ address: { primaryDomain: 'i-never-stop-study.tistory.com' }, info: { blogId } });
    }
    assert.fail(`unexpected synthetic request: ${call.method} ${url.origin}${url.pathname}`);
  };
  try { await operation(calls); } finally { globalThis.fetch = original; resetTestCredentialStore(); }
}

test('latched reauthentication exposes its first failure without another Kakao request', async () => {
  resetTestCredentialStore(); saveState(fixture(true));
  await withMockFetch(async calls => {
    await assert.rejects(login(), error => {
      assert.equal(error.code, 'TISTORY_KAKAO_REAUTH_REQUIRED');
      assert.equal(error.authHealth.reauthRequired, true);
      assert.equal(error.authHealth.failedAt, '2026-10-06T03:22:33.340Z');
      assert.doesNotMatch(JSON.stringify(error.authHealth), /private-fixture/);
      return true;
    });
    assert.deepEqual(calls.map(c => c.path), ['/api/v1/init']);
  });
});

test('first failed renewal stores only the sanitized reason, then prevents a retry', async () => {
  resetTestCredentialStore(); saveState(fixture());
  const originalSession = loadState().session;
  await withMockFetch(async calls => {
    await assert.rejects(login(), error => {
      assert.equal(error.authHealth.reauthRequired, true);
      assert.equal(error.authHealth.failureDiagnostic.reason, 'password_login_required');
      return true;
    });
    const stored = loadState();
    assert.deepEqual(stored.session, originalSession, 'a failed renewal preserves the previous jar');
    assert.equal(stored.login.failureDiagnostic.reason, 'password_login_required');
    const kakaoRequestCount = calls.filter(c => c.path !== '/api/v1/init').length;
    await assert.rejects(login(), { code: 'TISTORY_KAKAO_REAUTH_REQUIRED' });
    assert.equal(calls.filter(c => c.path !== '/api/v1/init').length, kakaoRequestCount);
  });
});

test('a forced renewal failure leaves the protected provider unchanged', async () => {
  resetTestCredentialStore(); saveState(fixture());
  const original = loadState();
  await withMockFetch(async () => {
    await assert.rejects(login({ renew: true }), error => {
      assert.equal(error.code, 'TISTORY_KAKAO_REAUTH_REQUIRED');
      assert.equal(error.authHealth.failureDiagnostic.reason, 'password_login_required');
      return true;
    });
    assert.deepEqual(loadState(), original);
  });
});

test('explicit renewal rechecks a latched failure once and preserves it when the fresh flow fails', async () => {
  resetTestCredentialStore(); saveState(fixture(true));
  const original = loadState();
  await withMockFetch(async calls => {
    await assert.rejects(login({ renew: true }), error => {
      assert.equal(error.code, 'TISTORY_KAKAO_REAUTH_REQUIRED');
      assert.equal(error.authHealth.failureDiagnostic.reason, 'password_login_required');
      return true;
    });
    assert.equal(calls.filter(c => c.path === '/auth/login').length, 1);
    assert.equal(calls.filter(c => c.path === '/oauth/authorize').length, 1);
    assert.deepEqual(loadState(), original);
    const count = calls.length;
    await assert.rejects(login(), { code: 'TISTORY_KAKAO_REAUTH_REQUIRED' });
    assert.equal(calls.length, count + 1, 'the next automatic caller performs only the protected init read');
  });
});

test('successful explicit renewal clears the latch only after owner and blog verification and saves rotated cookies', async () => {
  resetTestCredentialStore(); saveState(renewalState());
  const original = loadState();
  await withSuccessfulRenewalFetch({}, async calls => {
    const receipt = await login({ renew: true });
    assert.equal(receipt.mode, 'kakao_simple_login');
    assert.equal(receipt.ownerVerified, true);
    assert.deepEqual(receipt.probes, ['account-init', 'blog-settings']);
    assert.equal(receipt.authHealth.reauthRequired, false);

    const stored = loadState();
    assert.equal(stored.login.reauthRequired, false);
    assert.equal(stored.login.lastFailure, null);
    assert.equal(stored.login.failedAt, null);
    assert.equal(stored.login.failureDiagnostic, null);
    assert.equal(stored.login.accountDisplayId, 'private-fixture-account');
    assert.notEqual(stored.login.lastRenewedAt, original.login.lastRenewedAt);
    assert.equal(stored.identity.userId, 101);
    assert.equal(stored.identity.blogId, 303);
    const cookies = stored.session.jar.cookies;
    assert.ok(cookies.some(cookie => cookie.key === 'kakao_saved' && cookie.domain.replace(/^\./, '') === 'kakao.com'),
      'the pre-existing Kakao cookie survives renewal');
    assert.ok(cookies.some(cookie => cookie.key === 'tistory_rotated' && cookie.domain.replace(/^\./, '') === 'tistory.com'),
      'the observed Tistory Set-Cookie rotation is persisted');
    assert.equal(cookies.some(cookie => cookie.key === 'old_tistory'), false,
      'stale Tistory cookies are replaced during explicit renewal');
    assert.equal(calls.filter(call => call.path === '/api/v1/init').length, 2);
    assert.equal(calls.filter(call => call.path === '/manage/setting/blog.json').length, 1);
    assert.equal(calls.filter(call => call.path === '/api/v2/simple_login/change.json').length, 1);
  });
});

test('explicit renewal never clears or persists a session for a different Kakao owner', async () => {
  resetTestCredentialStore(); saveState(renewalState());
  const original = loadState();
  await withSuccessfulRenewalFetch({ userId: 999 }, async calls => {
    await assert.rejects(login({ renew: true }), { code: 'TISTORY_ACCOUNT_MISMATCH' });
    assert.deepEqual(loadState(), original);
    assert.equal(calls.filter(call => call.path === '/api/v1/init').length, 2);
    assert.equal(calls.filter(call => call.path === '/manage/setting/blog.json').length, 0);
  });
});

test('explicit renewal never clears or persists a session for a different target blog', async () => {
  resetTestCredentialStore(); saveState(renewalState());
  const original = loadState();
  await withSuccessfulRenewalFetch({ blogId: 999 }, async calls => {
    await assert.rejects(login({ renew: true }), { code: 'TISTORY_BLOG_MISMATCH' });
    assert.deepEqual(loadState(), original);
    assert.equal(calls.filter(call => call.path === '/api/v1/init').length, 2);
    assert.equal(calls.filter(call => call.path === '/manage/setting/blog.json').length, 1);
  });
});
