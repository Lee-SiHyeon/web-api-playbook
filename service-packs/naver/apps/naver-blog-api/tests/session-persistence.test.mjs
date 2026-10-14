import test from 'node:test';
import assert from 'node:assert/strict';
import { runNaverSessionHealth } from '../scripts/naver-session-health.mjs';
import { inspectNaverSessionStore, mergeNaverLoginSetCookies, loadNaverCookies,
  persistNaverObservedResponse, storeNaverCookies } from '../scripts/session-vault.mjs';
import { resetTestCredentialStore, writeCredential } from '../scripts/secure-credential-store.mjs';
import { SessionClient, PROTECTED_ROOT } from '../scripts/session-client.mjs';
import { acceptAndPersistNaverCookies } from '../tools/discovery/http-session-rotation.mjs';

test.beforeEach(resetTestCredentialStore);

const cookie = (name, value, extra = {}) => ({ name, value, domain: '.naver.com', path: '/', secure: true, expires: -1, ...extra });
const authCookies = () => [cookie('NID_AUT', 'synthetic-aut'), cookie('NID_SES', 'synthetic-session')];
const rootHTML = '<div id="lnbMenu">블로그 관리</div><a href="/aicandoanything/config/bloginfo">settings</a><a href="/aicandoanything/stat/today">statistics</a>';
const rootResponse = headers => new Response(rootHTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

test('runtime cookie loading stays in memory and preserves the full protected jar and User-Agent', async () => {
  const savedCookies = [...authCookies(), cookie('NAC', 'synthetic-nac'),
    cookie('blog_skin', 'synthetic-skin', { domain: 'blog.naver.com', path: '/' })];
  await storeNaverCookies(savedCookies, { userAgent: 'SyntheticBrowser/1.0' });

  const runtime = await loadNaverCookies({ env: {
    NAVER_COOKIE: 'NID_AUT=runtime-aut; NID_SES=runtime-session',
  } });
  assert.equal(runtime.provider, 'runtime_environment');
  assert.equal(runtime.persisted, false);
  assert.equal(runtime.cookies.length, 2);
  assert.equal(runtime.cookies.find(item => item.name === 'NID_AUT')?.value, 'runtime-aut');
  assert.equal(runtime.cookies.find(item => item.name === 'NID_SES')?.value, 'runtime-session');

  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.provider, 'windows_dpapi_current_user');
  assert.equal(saved.persisted, true);
  assert.deepEqual(saved.cookies.map(item => [item.name, item.value, item.domain, item.path]),
    savedCookies.map(item => [item.name, item.value, item.domain, item.path]));
  assert.equal(saved.userAgent, 'SyntheticBrowser/1.0');
});

test('invalid runtime cookie input is rejected before the protected bundle can change', async () => {
  const savedCookies = [...authCookies(), cookie('NAC', 'synthetic-nac')];
  await storeNaverCookies(savedCookies, { userAgent: 'SyntheticBrowser/1.0' });

  await assert.rejects(loadNaverCookies({ env: {
    NAVER_COOKIE: 'NID_AUT=runtime-aut\r\nInjected: value',
  } }), { message: 'NAVER_COOKIE_INVALID' });

  const saved = await loadNaverCookies({ env: {} });
  assert.deepEqual(saved.cookies.map(item => [item.name, item.value, item.domain, item.path]),
    savedCookies.map(item => [item.name, item.value, item.domain, item.path]));
  assert.equal(saved.userAgent, 'SyntheticBrowser/1.0');
});

test('health reports a present DPAPI bundle when its auth cookies are missing', async () => {
  await storeNaverCookies([cookie('NAC', 'synthetic-non-auth')], { allowIncomplete: true });
  const result = await runNaverSessionHealth({ createClient: () => assert.fail('No protected request should start without auth cookies') });
  assert.equal(result.provider, 'windows_dpapi_current_user');
  assert.equal(result.stored, true);
  assert.equal(result.storedAuthCookiesPresent, false);
  assert.equal(result.storedAuthCookieState, 'missing');
  assert.equal(result.storedCookieCount, 1);
  assert.equal(result.protectedOwnerRead, false);
  assert.equal(result.code, 'NAVER_AUTH_COOKIES_MISSING');
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
});

test('health leaves an absent DPAPI session accurately marked as absent without a network request', async () => {
  const result = await runNaverSessionHealth();
  assert.equal(result.provider, null);
  assert.equal(result.stored, false);
  assert.equal(result.storedAuthCookieState, 'missing');
  assert.equal(result.protectedOwnerRead, false);
  assert.equal(result.code, 'AUTH_MISSING');
});

test('health propagates safe login-page evidence and does not verify twice', async () => {
  const receipt = { verified: true, actorMatched: true, adminShell: true, loginHTML: false,
    httpStatus: 200, mime: 'text/html', bytes: 1200, redirectCount: 0, checkedAt: 'synthetic-time' };
  let persistenceCalls = 0;
  const healthy = await runNaverSessionHealth({
    inspectStore: async () => ({ provider: 'windows_dpapi_current_user', stored: true,
      authCookiesPresent: true, authCookieState: 'present', cookieCount: 2, expiredCookieCount: 0, userAgentPresent: true }),
    loadSession: async () => ({ cookies: authCookies(), provider: 'windows_dpapi_current_user', persisted: true,
      userAgent: 'SyntheticBrowser/1.0' }),
    createClient: () => ({ persistVerifiedSession: async () => {
      persistenceCalls++;
      return { stored: true, verification: receipt };
    }, clear() {} }),
  });
  assert.equal(persistenceCalls, 1);
  assert.equal(healthy.protectedOwnerRead, true);
  assert.equal(healthy.sessionStoredAfterRead, true);
  assert.equal(healthy.httpStatus, 200);

  const loginPage = await runNaverSessionHealth({
    inspectStore: async () => ({ provider: 'windows_dpapi_current_user', stored: true,
      authCookiesPresent: true, authCookieState: 'present', cookieCount: 2, expiredCookieCount: 0 }),
    loadSession: async () => ({ cookies: authCookies(), provider: 'windows_dpapi_current_user', persisted: true }),
    createClient: () => ({ persistVerifiedSession: async () => {
      throw Object.assign(new Error('safe fixture'), { code: 'AUTH_UNVERIFIED', details: {
        verified: false, actorMatched: false, adminShell: false, loginHTML: true, httpStatus: 200,
      } });
    }, clear() {} }),
  });
  assert.equal(loginPage.protectedOwnerRead, false);
  assert.equal(loginPage.loginHTML, true);
  assert.equal(loginPage.httpStatus, 200);
  assert.equal(loginPage.code, 'AUTH_UNVERIFIED');
});

test('store inspection distinguishes expired authentication cookies without exposing values', async () => {
  await writeCredential('naver-blog-session', JSON.stringify({ version: 1,
    cookies: [cookie('NID_AUT', 'synthetic-expired-aut', { expires: 1 }),
      cookie('NID_SES', 'synthetic-expired-ses', { expires: 1 })], userAgent: 'SyntheticBrowser/1.0' }));
  const result = await inspectNaverSessionStore();
  assert.equal(result.stored, true);
  assert.equal(result.usable, false);
  assert.equal(result.authCookieState, 'expired');
  assert.equal(result.expiredCookieCount, 2);
  assert.equal(result.code, 'NAVER_AUTH_COOKIES_EXPIRED');
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
});

test('auth-cookie deletion fails closed and leaves the protected bundle unchanged', async () => {
  await storeNaverCookies(authCookies(), { userAgent: 'SyntheticBrowser/1.0' });
  const client = new SessionClient({ cookies: authCookies(), fetchImpl: async () => new Response('', {
    headers: { 'set-cookie': 'NID_SES=; Domain=.naver.com; Path=/; Max-Age=0' },
  }) });
  await assert.rejects(client.fetch(PROTECTED_ROOT), { code: 'AUTH_MISSING' });
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.cookies.find(item => item.name === 'NID_AUT')?.value, 'synthetic-aut');
  assert.equal(saved.cookies.find(item => item.name === 'NID_SES')?.value, 'synthetic-session');
  assert.equal(saved.userAgent, 'SyntheticBrowser/1.0');
});

test('wrong-owner verification exposes safe details and does not save a rotated jar', async () => {
  await storeNaverCookies(authCookies(), { userAgent: 'SyntheticBrowser/old' });
  const client = new SessionClient({ cookies: authCookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    defaultHeaders: { 'user-agent': 'SyntheticBrowser/new' },
    fetchImpl: async () => new Response('<div id="lnbMenu">관리</div><a href="/someone-else/config/bloginfo">settings</a>', {
      headers: { 'content-type': 'text/html',
        'set-cookie': 'NID_SES=synthetic-unverified-rotation; Domain=.naver.com; Path=/; Secure' },
    }) });
  await assert.rejects(client.persistVerifiedSession(), error => {
    assert.equal(error.code, 'AUTH_UNVERIFIED');
    assert.equal(error.details.actorMatched, false);
    assert.equal(error.details.adminShell, true);
    assert.equal(error.details.loginHTML, false);
    assert.ok(!JSON.stringify(error.details).includes('synthetic-unverified-rotation'));
    return true;
  });
  client.clear();
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.cookies.find(item => item.name === 'NID_SES')?.value, 'synthetic-session');
  assert.equal(saved.userAgent, 'SyntheticBrowser/old');
});

test('HTTP discovery session does not replace the vault or its in-memory jar after auth-cookie deletion', async () => {
  await storeNaverCookies(authCookies(), { userAgent: 'SyntheticBrowser/1.0' });
  const jar = authCookies();
  const response = new Response('', { headers: { 'set-cookie': 'NID_SES=; Domain=.naver.com; Path=/; Max-Age=0' } });
  await assert.rejects(acceptAndPersistNaverCookies(jar, response,
    'https://admin.blog.naver.com/4053103/config/bloginfo', { userAgent: 'SyntheticBrowser/1.0' }),
  { message: 'NAVER_AUTH_COOKIES_MISSING' });
  assert.equal(jar.find(item => item.name === 'NID_SES')?.value, 'synthetic-session');
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.cookies.find(item => item.name === 'NID_SES')?.value, 'synthetic-session');
});

test('HTTP discovery session persists a valid cookie rotation', async () => {
  await storeNaverCookies(authCookies(), { userAgent: 'SyntheticBrowser/1.0' });
  const jar = authCookies();
  const response = new Response('', { headers: {
    'set-cookie': 'NID_SES=synthetic-http-rotated; Domain=.naver.com; Path=/; Secure',
  } });
  assert.equal(await acceptAndPersistNaverCookies(jar, response,
    'https://admin.blog.naver.com/4053103/config/bloginfo', { userAgent: 'SyntheticBrowser/1.0' }), true);
  assert.equal(jar.find(item => item.name === 'NID_SES')?.value, 'synthetic-http-rotated');
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.cookies.find(item => item.name === 'NID_SES')?.value, 'synthetic-http-rotated');
  assert.equal(saved.userAgent, 'SyntheticBrowser/1.0');
});

test('persistNaverObservedResponse refuses an incomplete jar and leaves the vault unchanged', async () => {
  await storeNaverCookies(authCookies(), { userAgent: 'SyntheticBrowser/1.0' });
  const response = new Response('', { headers: { 'set-cookie': 'NID_SES=; Domain=.naver.com; Path=/; Max-Age=0' } });
  await assert.rejects(persistNaverObservedResponse(response, 'https://admin.blog.naver.com/4053103/config/bloginfo'),
    { message: 'NAVER_AUTH_COOKIES_MISSING' });
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.cookies.find(item => item.name === 'NID_AUT')?.value, 'synthetic-aut');
  assert.equal(saved.cookies.find(item => item.name === 'NID_SES')?.value, 'synthetic-session');
  assert.equal(saved.userAgent, 'SyntheticBrowser/1.0');
});

test('observed authenticated rotation is persisted and verification receipt accompanies the stored result', async () => {
  const client = new SessionClient({ cookies: authCookies(), ownerBlogId: 'aicandoanything', persistRotation: false,
    defaultHeaders: { 'user-agent': 'SyntheticBrowser/2.0' },
    fetchImpl: async () => rootResponse({ 'set-cookie': 'NID_SES=synthetic-rotated; Domain=.naver.com; Path=/; Secure' }) });
  const persisted = await client.persistVerifiedSession();
  assert.equal(persisted.stored, true);
  assert.equal(persisted.verification.verified, true);
  assert.equal(persisted.verification.actorMatched, true);
  const saved = await loadNaverCookies({ env: {} });
  assert.equal(saved.cookies.find(item => item.name === 'NID_SES')?.value, 'synthetic-rotated');
  assert.equal(saved.userAgent, 'SyntheticBrowser/2.0');
  const metadata = await inspectNaverSessionStore();
  assert.equal(metadata.usable, true);
  assert.equal(metadata.authCookieState, 'present');
  assert.equal(metadata.userAgentPresent, true);
});

test('login Set-Cookie merge accepts only the exact login origin', () => {
  const response = { headers: { getSetCookie: () => ['NID_AUT=synthetic-login; Domain=.naver.com; Path=/; Secure'] } };
  const update = mergeNaverLoginSetCookies([], response, 'https://nid.naver.com/nidlogin.login');
  assert.equal(update.changed, true);
  assert.equal(update.cookies[0].name, 'NID_AUT');
  assert.throws(() => mergeNaverLoginSetCookies([], response, 'https://evil.naver.com/nidlogin.login'), { message: 'NAVER_SESSION_SCOPE' });
  assert.throws(() => mergeNaverLoginSetCookies([], response, 'https://nid.naver.com.evil.test/nidlogin.login'), { message: 'NAVER_SESSION_SCOPE' });
});
