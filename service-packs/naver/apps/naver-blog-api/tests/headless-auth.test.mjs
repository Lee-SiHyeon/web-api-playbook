import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HeadlessAuth, classifyAuthPage, classifyBrowserOpenError, credentialHeader, ADMIN_ROOT } from '../tools/discovery/headless-auth.mjs';

const cookie = (name, value, domain = '.naver.com', path = '/', expires = -1) => ({ name, value, domain, path, expires, secure: true });
const cookies = [cookie('NID_AUT', 'fixture-aut'), cookie('NID_SES', 'fixture-session')];

test('headless module imports without browser launch and empty session fails closed', async () => {
  const auth = new HeadlessAuth();
  assert.equal(auth.browser, null);
  assert.deepEqual(await auth.status(), { stage: 'not_started', browserOpen: false, headless: true });
  assert.throws(() => auth.cookieFor(ADMIN_ROOT), { code: 'AUTH_MISSING' });
  assert.deepEqual(await auth.close(), { browserClosed: true, sessionCleared: true });
});

test('visible login mode is opt-in while default remains headless', async () => {
  const defaultAuth = new HeadlessAuth();
  assert.equal(defaultAuth.headless, true);
  const visibleAuth = new HeadlessAuth({ headless: false });
  assert.equal(visibleAuth.headless, false);
  assert.deepEqual(await visibleAuth.status(), { stage: 'not_started', browserOpen: false, headless: false });
});

test('missing Playwright browser runtime produces an actionable bounded error', async () => {
  const auth = new HeadlessAuth({ loadChromium: async () => ({
    executablePath: () => 'C:\\definitely-missing\\playwright\\chrome.exe',
    launch: async () => assert.fail('Launch must not run without an executable'),
  }) });
  await assert.rejects(auth.open(), error => error.code === 'BROWSER_RUNTIME_MISSING'
    && /npm run setup:browser/.test(error.message) && !/definitely-missing/.test(error.message));
  assert.equal(auth.browser, null);
  assert.equal(auth.stage, 'open_failed');
});

test('browser and navigation failures are classified without raw private details', () => {
  assert.equal(classifyBrowserOpenError(Error('Executable does not exist at C:/private/chrome.exe')).code, 'BROWSER_RUNTIME_MISSING');
  assert.equal(classifyBrowserOpenError(Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://private/')).code, 'NAVIGATION_NETWORK');
  assert.equal(classifyBrowserOpenError(Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://private/')).code, 'NAVIGATION_CERTIFICATE');
  const generic = classifyBrowserOpenError(Error('synthetic-private-detail'));
  assert.equal(generic.code, 'BROWSER_OPEN_FAILED');
  assert.doesNotMatch(generic.message, /synthetic|private/);
});

test('cookie selection enforces approved hosts, TLS, expiry and path boundaries', () => {
  const jar = [...cookies,
    cookie('hostOnly', 'fixture-host', 'blog.naver.com'),
    cookie('pathOnly', 'fixture-path', '.naver.com', '/4053103'),
    cookie('expired', 'fixture-expired', '.naver.com', '/', 50),
    cookie('foreign', 'fixture-foreign', '.invalid.test'),
    cookie('malformed', 'fixture\r\nInjected: value'),
  ];
  assert.equal(credentialHeader(jar, ADMIN_ROOT, 100000), 'pathOnly=fixture-path; NID_AUT=fixture-aut; NID_SES=fixture-session');
  assert.ok(credentialHeader(jar, 'https://blog.naver.com/4053103/post', 100000).includes('hostOnly=fixture-host'));
  assert.ok(!credentialHeader(jar, 'https://blog.naver.com/40531030', 100000).includes('pathOnly'));
  for (const raw of ['not-a-url', 'http://blog.naver.com/', 'https://blog.naver.com:9000/', 'https://nid.naver.com/', 'https://blog.naver.com.invalid.test/', 'https://fixture@blog.naver.com/']) {
    assert.throws(() => credentialHeader(jar, raw, 100000), { code: 'SCOPE' });
  }
});

test('CAPTCHA and additional verification take precedence over cookie presence', () => {
  const base = { cookieNames: ['NID_AUT', 'NID_SES'], origin: 'https://admin.blog.naver.com' };
  assert.equal(classifyAuthPage({ ...base, text: '자동입력 방지 문자를 입력하세요' }), 'captcha_required');
  assert.equal(classifyAuthPage({ ...base, text: '', inputNames: ['captcha'] }), 'captcha_required');
  assert.equal(classifyAuthPage({ ...base, text: '2단계 인증을 완료하세요' }), 'additional_verification_required');
  assert.equal(classifyAuthPage({ ...base, text: '계정 보호조치가 적용되었습니다' }), 'account_protection');
  assert.equal(classifyAuthPage({ text: '아이디 또는 비밀번호를 확인하세요' }), 'credentials_rejected');
});

test('HTTP 200 and login-page cookies alone cannot establish account authentication', () => {
  assert.equal(classifyAuthPage({ text: '네이버 로그인' }), 'login_pending');
  assert.equal(classifyAuthPage({ cookieNames: ['NID_AUT', 'NID_SES'], origin: 'https://nid.naver.com' }), 'login_pending');
  assert.equal(classifyAuthPage({ cookieNames: ['NID_AUT', 'NID_SES'], origin: 'https://admin.blog.naver.com' }), 'session_issued_unverified');
});

test('login refuses unobserved pages and wrong actors without browser/network access', async () => {
  const auth = new HeadlessAuth();
  await assert.rejects(auth.login({ username: 'other-actor', password: 'synthetic-only' }), { code: 'INPUT' });
  await assert.rejects(auth.login({ username: '4053103', password: 'synthetic-only' }), { code: 'LOGIN_PAGE' });
  assert.equal(auth.submitted, false);
});

test('an observed challenge prevents credential filling and submission', async () => {
  for (const classification of ['captcha_required', 'additional_verification_required', 'account_protection']) {
    const auth = new HeadlessAuth();
    auth.page = { url: () => 'https://nid.naver.com/nidlogin.login', locator: () => assert.fail('Challenge must not be interacted with') };
    auth.status = async () => ({ classification });
    assert.deepEqual(await auth.login({ username: '4053103', password: 'synthetic-only' }), { classification });
    assert.equal(auth.submitted, false);
  }
});

test('current and legacy Naver login button ids are both accepted', async () => {
  for (const loginButtonId of ['loginBtn_row', 'log.login']) {
    const calls = [];
    const locator = selector => ({
      fill: async value => calls.push(['fill', selector, value]),
      click: async () => calls.push(['click', selector]),
    });
    const auth = new HeadlessAuth();
    auth.page = {
      url: () => 'https://nid.naver.com/nidlogin.login',
      locator,
      waitForTimeout: async () => {},
    };
    let statusCalls = 0;
    auth.status = async () => {
      statusCalls++;
      if (statusCalls === 1) {
        return {
          classification: 'login_pending',
          inputs: [{ id: 'id' }, { id: 'pw' }],
          buttons: [{ id: loginButtonId }],
        };
      }
      return { classification: 'credentials_rejected', inputs: [], buttons: [] };
    };
    const result = await auth.login({ username: '4053103', password: 'synthetic-only' });
    assert.equal(result.classification, 'credentials_rejected');
    assert.deepEqual(calls, [
      ['fill', '#id', '4053103'],
      ['fill', '#pw', 'synthetic-only'],
      ['click', `[id="${loginButtonId}"]`],
    ]);
  }
});

test('repeated login is refused and closing clears the in-memory session', async () => {
  const auth = new HeadlessAuth();
  auth.page = { url: () => 'https://nid.naver.com/nidlogin.login' };
  auth.submitted = true;
  await assert.rejects(auth.login({ username: '4053103', password: 'synthetic-only' }), { code: 'LOGIN_ONCE' });
  auth.cookies = [...cookies];
  assert.ok(auth.cookieFor(ADMIN_ROOT));
  await auth.close();
  assert.throws(() => auth.cookieFor(ADMIN_ROOT), { code: 'AUTH_MISSING' });
});

test('the headless helper has no existing Chrome connection or persistent authentication state', async () => {
  const source = await readFile(new URL('../tools/discovery/headless-auth.mjs', import.meta.url), 'utf8');
  assert.match(source, /headless = true/);
  assert.match(source, /chromium\.launch\(\{ headless: this\.headless/);
  assert.doesNotMatch(source, /connectOverCDP|launchPersistentContext|DevToolsActivePort|\.storageState\(/);
  const worker = await readFile(new URL('../tools/discovery/headless-worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /setRawMode\(true\)/);
  assert.doesNotMatch(worker, /console\.log\((?:input|line|buffer)\)/);
});
