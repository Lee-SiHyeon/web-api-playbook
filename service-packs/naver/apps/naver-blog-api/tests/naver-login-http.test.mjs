import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHash, createDecipheriv } from 'node:crypto';
import { classifyUnauthenticatedLoginResponse, loginWithNaverPassword, NAVER_LOGIN_ACTOR,
  requestedLoginChallengeMode } from '../scripts/naver-login-http.mjs';
import { createNaverKoopOptions, normalizeNaverLoginSdk } from '../scripts/naver-login-token-provider.mjs';

const identity = { username: 'fixture-user', password: 'fixture-only-한글' };
const actorUrl = `https://admin.blog.naver.com/${NAVER_LOGIN_ACTOR}`;
const loginUrl = 'https://nid.naver.com/nidlogin.login';
const sdkLoader = '<script src="https://ncpt.naver.com/static/ncaptcha-api.js?ncaptcha-onload=initNcaptcha"></script>';
const returnedProof = 'fixture-returned-form-proof';
const returnedDynamicKey = 'fixture-returned-form-dynamic-key';

function returnedLoginForm({ entries = null, method = 'post', action = loginUrl,
  buttons = '<button id="loginBtn_column" type="button">로그인</button>', loaders = sdkLoader, notice = '' } = {}) {
  const defaults = { dynamicKey: returnedDynamicKey, sessionKey: '', show_pk: 'true', wtoken: '',
    svctype: '1', bvsd: '', locale: 'ko_KR', url: actorUrl, eccpw: '', template_url: '/login/template',
    enctp: '19', next_step: 'false', template_type: 'V3_DESKTOP_DEFAULT', smart_LEVEL: '1', id: '', pw: '' };
  const fields = entries ?? [...Object.entries(defaults), ['chp', returnedProof]];
  const inputs = fields.map(([name, value]) => `<input name="${name}" value="${value}">`).join('');
  return `<form id="frmNIDLogin" method="${method}" action="${action}">${inputs}${buttons}</form>${loaders}${notice}`;
}

function responseAt(body, init, url) {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: new URL(url).href });
  return response;
}

function fixture({ accepted = true, token = 'fixture-sdk-result', postFailure = false,
  duplicateField = false, wrongActor = false, postStatus = 200, postLocation = null, postHtml = null } = {}) {
  const server = createECDH('prime256v1'); server.generateKeys();
  const sessionKey = 'fixture-session-key';
  const defaults = { dynamicKey: 'fixture-dynamic-key', sessionKey: '', show_pk: 'true', wtoken: '',
    svctype: '1', bvsd: '', locale: 'ko_KR', url: actorUrl, eccpw: '', template_url: '/login/template',
    enctp: '19', next_step: 'false', template_type: 'V3_DESKTOP_DEFAULT', smart_LEVEL: '1', id: '', pw: '' };
  const html = `<form id="frmNIDLogin" method="post" action="https://nid.naver.com/nidlogin.login">${Object.entries(defaults)
    .map(([name, value]) => `<input name="${name}" value="${value}">`).join('')}${duplicateField ? '<input name="dynamicKey" value="duplicate">' : ''}</form>`;
  const requests = [];
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw); requests.push({ url, init });
    if (init.method === 'POST') {
      if (postFailure) throw new Error('TRANSPORT');
      const fields = new URLSearchParams(init.body);
      assert.equal(fields.get('id'), ''); assert.equal(fields.get('pw'), '');
      assert.equal(fields.get('sessionKey'), ''); assert.equal(fields.get('wtoken'), token);
      assert.equal(fields.get('dynamicKey'), defaults.dynamicKey);
      // The server independently decrypts ECDH/AES and checks Unicode framing.
      const [ciphertext, iv, clientKey, sentSessionKey] = fields.get('eccpw').split(',');
      assert.equal(sentSessionKey, sessionKey);
      const shared = server.computeSecret(Buffer.from(clientKey, 'hex'));
      const key = createHash('sha256').update(shared.toString('hex')).digest();
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
      let offset = 0;
      const take = () => { const length = plaintext.charCodeAt(offset++); const value = plaintext.slice(offset, offset + length); offset += length; return value; };
      assert.deepEqual([take(), take(), take()], [sessionKey, identity.username, identity.password]);
      assert.equal(offset, plaintext.length);
      const headers = new Headers({ 'content-type': 'text/html' });
      if (postLocation) headers.set('location', postLocation);
      if (accepted) {
        headers.append('set-cookie', 'NID_AUT=fixture-auth; Domain=.naver.com; Path=/; Secure; HttpOnly');
        headers.append('set-cookie', 'NID_SES=fixture-session; Domain=.naver.com; Path=/; Secure; HttpOnly');
      }
      const html = postHtml ?? (accepted ? '<html>done</html>' : '<form id="frmNIDLogin"><input name="captcha"><img src="/captcha/image"></form>');
      return new Response(html, { status: postStatus, headers });
    }
    if (url.pathname.startsWith('/login/dynamicEcKey/')) return new Response(`${sessionKey},${server.getPublicKey('hex')}`);
    if (url.origin === 'https://admin.blog.naver.com') {
      assert.match(new Headers(init.headers).get('cookie'), /NID_AUT=fixture-auth/);
      const owner = wrongActor ? 'someone-else' : NAVER_LOGIN_ACTOR;
      return new Response(`<html><div id="lnbMenu"><a href="/${owner}/config/bloginfo">블로그 관리</a></div>${' '.repeat(1100)}</html>`,
        { headers: { 'content-type': 'text/html' } });
    }
    return new Response(html, { headers: { 'content-type': 'text/html', 'set-cookie': 'prelogin=fixture; Path=/; Secure; HttpOnly' } });
  };
  const tokenIssuer = async () => ({ token, receipt: { browserEngineUsed: false, serverTokenReceived: !!token } });
  return { fetchImpl, tokenIssuer, requests };
}

function continuationFixture({ continuationLoaders = sdkLoader, returnedResponseHtml = null, returnedResponseStatus = 200,
  returnedResponseUrl = loginUrl, returnedResponseContentType = 'text/html', thirdPostOutcome = 'login-form',
  returnedResponseAuthPair = false, thirdPostFailure = false, returnedKeyBody = null, tokenValues = null } = {}) {
  const server = createECDH('prime256v1'); server.generateKeys();
  const sessionKey = 'fixture-continuation-session-key';
  const defaults = { dynamicKey: 'fixture-continuation-dynamic-key', sessionKey: '', show_pk: 'true', wtoken: '',
    svctype: '1', bvsd: '', locale: 'ko_KR', url: actorUrl, eccpw: '', template_url: '/login/template',
    enctp: '19', next_step: 'false', template_type: 'V3_DESKTOP_DEFAULT', smart_LEVEL: '1', id: '', pw: '' };
  const proof = 'fixture-one-use-proof';
  const continuationUrl = new URL('https://nid.naver.com/nidlogin.login');
  continuationUrl.searchParams.set('mode', 'form');
  continuationUrl.searchParams.set('url', actorUrl);
  continuationUrl.searchParams.set('chp', proof);
  const requests = [];
  const tokenCalls = [];
  const events = [];
  const keyNames = [];
  let loginPostCount = 0;
  let challengePostCount = 0;
  let challengeHandlerCallCount = 0;

  function formHtml({ continuation = false } = {}) {
    const entries = [...Object.entries(defaults), ...(continuation ? [['chp', proof]] : [])];
    const inputs = entries.map(([name, value]) => `<input name="${name}" value="${value}">`).join('');
    return `<form id="frmNIDLogin" method="post" action="https://nid.naver.com/nidlogin.login">${inputs}</form>${continuation ? continuationLoaders : ''}`;
  }

  const fetchImpl = async (raw, init = {}) => {
    const url = new URL(raw);
    const method = String(init.method || 'GET').toUpperCase();
    const hasProof = url.searchParams.has('chp');
    requests.push({ path: url.pathname, method, hasProof });
    if (url.pathname === '/nidlogin.login' && method === 'GET') {
      events.push(hasProof ? 'continuation-form-get' : 'initial-form-get');
      return new Response(formHtml({ continuation: hasProof }), { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.startsWith('/login/dynamicEcKey/') && method === 'GET') {
      const keyName = decodeURIComponent(url.pathname.split('/').at(-1));
      keyNames.push(keyName);
      events.push('public-key-get');
      if (keyName === returnedDynamicKey && returnedKeyBody !== null) {
        return new Response(returnedKeyBody, { headers: { 'content-type': 'text/plain' } });
      }
      const keySession = keyName === returnedDynamicKey ? 'fixture-returned-form-session-key' : sessionKey;
      return new Response(`${keySession},${server.getPublicKey('hex')}`, { headers: { 'content-type': 'text/plain' } });
    }
    if (url.pathname === '/nidlogin.rcaptcha' && method === 'POST') {
      challengePostCount += 1;
      events.push('challenge-post');
      return new Response('', { status: 302, headers: { location: continuationUrl.href } });
    }
    if (url.pathname === '/nidlogin.login' && method === 'POST') {
      loginPostCount += 1;
      const fields = new URLSearchParams(init.body);
      assert.equal(fields.get('id'), '');
      assert.equal(fields.get('pw'), '');
      assert.equal(fields.get('wtoken'), `fixture-token-${loginPostCount}`);
      if (loginPostCount === 1) {
        events.push('initial-password-post');
        return responseAt('<form id="frmNIDLogin"><input name="captcha"><img src="/captcha/image"></form>',
          { headers: { 'content-type': 'text/html' } }, url.href);
      }
      if (loginPostCount === 2) {
        events.push('continuation-password-post');
        assert.equal(fields.get('chp'), proof);
        const headers = new Headers({ 'content-type': returnedResponseContentType });
        if (returnedResponseAuthPair) {
          headers.append('set-cookie', 'NID_AUT=fixture-returned-auth; Domain=.naver.com; Path=/; Secure; HttpOnly');
          headers.append('set-cookie', 'NID_SES=fixture-returned-session; Domain=.naver.com; Path=/; Secure; HttpOnly');
        }
        return responseAt(returnedResponseHtml ?? '<form id="frmNIDLogin"></form>',
          { status: returnedResponseStatus, headers }, returnedResponseUrl);
      }
      assert.equal(loginPostCount, 3, 'the returned-form login may be submitted only once');
      events.push('returned-form-password-post');
      assert.equal(fields.get('chp'), returnedProof);
      assert.equal(fields.get('dynamicKey'), returnedDynamicKey);
      assert.equal(new Headers(init.headers).get('referer'), loginUrl);
      if (thirdPostFailure) throw new Error('TRANSPORT');
      const headers = new Headers({ 'content-type': 'text/html' });
      if (thirdPostOutcome === 'success') {
        headers.append('set-cookie', 'NID_AUT=fixture-returned-auth; Domain=.naver.com; Path=/; Secure; HttpOnly');
        headers.append('set-cookie', 'NID_SES=fixture-returned-session; Domain=.naver.com; Path=/; Secure; HttpOnly');
      }
      const body = thirdPostOutcome === 'success' ? '<html>done</html>'
        : thirdPostOutcome === 'captcha' ? '<form id="frmNIDLogin"><input name="captcha"><img src="/captcha/image"></form>'
          : '<form id="frmNIDLogin"></form>';
      return responseAt(body, { headers }, url.href);
    }
    throw new Error('UNEXPECTED_FIXTURE_REQUEST');
  };
  const tokenIssuer = async options => {
    tokenCalls.push(options);
    const continuation = tokenCalls.length === 2;
    events.push(tokenCalls.length === 1 ? 'initial-token' : continuation ? 'continuation-token' : 'returned-form-token');
    const index = tokenCalls.length - 1;
    const token = tokenValues && Object.hasOwn(tokenValues, index) ? tokenValues[index] : `fixture-token-${tokenCalls.length}`;
    return { token, receipt: { browserEngineUsed: false, serverTokenReceived: typeof token === 'string' && !!token,
      fixtureCallIndex: tokenCalls.length } };
  };
  const handleChallenge = async ({ request, receipt }) => {
    challengeHandlerCallCount += 1;
    const response = await request('https://nid.naver.com/nidlogin.rcaptcha', { method: 'POST',
      headers: { origin: 'https://nid.naver.com', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'captcha=fixture-answer' });
    receipt.challengePostCount = 1;
    return response;
  };
  return { fetchImpl, tokenIssuer, handleChallenge, requests, tokenCalls, events,
    get loginPostCount() { return loginPostCount; }, get challengePostCount() { return challengePostCount; },
    get challengeHandlerCallCount() { return challengeHandlerCallCount; }, keyNames, continuationUrl: continuationUrl.href };
}

function assertStoppedBeforeReturnedSubmit(fixture, result, expectedCode) {
  assert.equal(result.receipt.code, expectedCode);
  assert.equal(fixture.loginPostCount, 2);
  assert.equal(fixture.challengePostCount, 1);
  assert.equal(fixture.challengeHandlerCallCount, 1);
  assert.equal(fixture.tokenCalls.length, 2);
  assert.equal(fixture.keyNames.length, 2);
  assert.equal(fixture.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'GET' && item.hasProof).length, 1);
  assert.equal(result.receipt.returnedFormSubmitCount ?? 0, 0);
}

test('fresh password login encrypts credentials and verifies owner without persisting cookies', async () => {
  const f = fixture(); const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.protectedOwnerRead, true);
  assert.equal(result.receipt.cookiesPersisted, false);
  assert.equal(result.receipt.states.remnant_free, true);
  assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 1);
  const safe = JSON.stringify(result.receipt);
  for (const secret of [identity.username, identity.password, 'fixture-auth', 'fixture-session', 'fixture-sdk-result']) assert.ok(!safe.includes(secret));
  result.session.clear();
});
test('missing or error token prevents password submission', async () => {
  for (const token of [null, 'timeout', 'error1|ReferenceError|SDK unavailable']) {
    const f = fixture({ token }); const result = await loginWithNaverPassword(identity, f);
    assert.equal(result.receipt.code, 'LOGIN_TOKEN_NOT_ISSUED');
    assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 0);
  }
});
test('HTTP 200 with CAPTCHA remains unauthenticated with no retry', async () => {
  const f = fixture({ accepted: false }); const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.code, 'IMAGE_CHALLENGE_REQUIRED');
  assert.equal(result.receipt.protectedOwnerRead, false);
  assert.equal(result.receipt.loginPostCount, 1);
  assert.equal(result.session, null);
});
test('challenge mode is opt-in and conflicting modes are rejected', () => {
  assert.equal(requestedLoginChallengeMode([]), null);
  assert.equal(requestedLoginChallengeMode(['--challenge-stdin']), 'stdin');
  assert.equal(requestedLoginChallengeMode(['--challenge-codex']), 'codex');
  assert.throws(() => requestedLoginChallengeMode(['--challenge-stdin', '--challenge-codex']),
    { message: 'LOGIN_CHALLENGE_MODE_CONFLICT' });
});
test('Location account-protection response is classified without persisting query values', async () => {
  const privateValue = 'opaque-private-test-value';
  const f = fixture({ accepted: false, postStatus: 302, postLocation:
    `http://nid.naver.com/user2/help/idSafetyRelease?token_help=${privateValue}&url=https%3A%2F%2Fadmin.blog.naver.com%2Faicandoanything`, postHtml: '' });
  const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.code, 'ACCOUNT_PROTECTION_REQUIRED');
  assert.equal(result.receipt.responseShape.redirectPaths[0].path, '/user2/help/idSafetyRelease');
  assert.deepEqual(result.receipt.responseShape.redirectPaths[0].queryNames, ['token_help', 'url']);
  assert.equal(result.receipt.responseShape.redirectPaths[0].source, 'location_header');
  assert.ok(!JSON.stringify(result.receipt).includes(privateValue));
  assert.equal(result.receipt.nextAction, 'complete_naver_account_recovery_before_another_login');
});
test('Location summaries redact opaque path segments and query values', async () => {
  const opaquePath = 'opaque-signed-path-value';
  const opaqueQuery = 'opaque-query-value';
  const f = fixture({ accepted: false, postStatus: 302, postLocation:
    `https://nid.naver.com/login/dynamicEcKey/${opaquePath}?token=${opaqueQuery}`, postHtml: '' });
  const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.code, 'LOGIN_REDIRECTED_UNVERIFIED');
  assert.equal(result.receipt.responseShape.redirectPaths[0].path, '/login/dynamicEcKey/[redacted]');
  const safe = JSON.stringify(result.receipt);
  assert.ok(!safe.includes(opaquePath));
  assert.ok(!safe.includes(opaqueQuery));
});
test('challenge input without a detected image still stops with a challenge classification', async () => {
  const f = fixture({ accepted: false, postHtml: '<form id="frmNIDLogin"><input name="chptcha"></form>' });
  const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.responseShape.captchaInputDetected, true);
  assert.equal(result.receipt.responseShape.imageChallengeDetected, false);
  assert.equal(result.receipt.code, 'IMAGE_CHALLENGE_REQUIRED');
});
test('known unauthenticated response shapes have distinct classifications', () => {
  assert.equal(classifyUnauthenticatedLoginResponse({ notices: { credentialsRejected: true } }, 200), 'LOGIN_CREDENTIALS_REJECTED');
  assert.equal(classifyUnauthenticatedLoginResponse({ notices: { temporaryRestriction: true } }, 200), 'LOGIN_TEMPORARILY_RESTRICTED');
  assert.equal(classifyUnauthenticatedLoginResponse({ additionalVerification: true }, 200), 'ADDITIONAL_VERIFICATION_REQUIRED');
  assert.equal(classifyUnauthenticatedLoginResponse({ loginForm: true, captchaInputDetected: false }, 200), 'LOGIN_FORM_RETURNED');
  assert.equal(classifyUnauthenticatedLoginResponse({ htmlLength: 0, redirectPaths: [] }, 302), 'LOGIN_REDIRECT_WITHOUT_LOCATION');
});
test('hidden login templates do not classify as credentials errors or verification prompts', async () => {
  const html = '<template><div class="error">아이디 또는 비밀번호를 확인해 주세요</div><div role="alert">2단계 인증</div></template>'
    + '<form id="frmNIDLogin"><input type="hidden" name="authcode"></form>';
  const f = fixture({ accepted: false, postHtml: html });
  const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.responseShape.notices.credentialsRejected, false);
  assert.equal(result.receipt.responseShape.additionalVerification, false);
  assert.equal(result.receipt.code, 'LOGIN_FORM_RETURNED');
});
test('visible additional-verification alert is classified', async () => {
  const f = fixture({ accepted: false, postHtml: '<div role="alert">2단계 인증을 진행해 주세요</div>' });
  const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.responseShape.additionalVerification, true);
  assert.equal(result.receipt.code, 'ADDITIONAL_VERIFICATION_REQUIRED');
});
test('challenge continuation reuses its parsed SDK loader without a second proof-page bootstrap', async () => {
  const f = continuationFixture();
  const result = await loginWithNaverPassword(identity, f);

  assert.equal(result.receipt.code, 'LOGIN_FORM_RETURNED');
  assert.deepEqual(result.receipt.loginPostStatuses, [200, 200]);
  assert.equal(result.receipt.challengePostStatus, 302);
  assert.equal(result.receipt.continuationBootstrapGetCount, 1);
  assert.equal(result.receipt.continuationSdkSource, 'observed_form_loader');
  assert.equal(f.loginPostCount, 2);
  assert.equal(f.challengePostCount, 1);
  assert.equal(f.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'GET' && item.hasProof).length, 1);
  assert.deepEqual(f.events, ['initial-form-get', 'public-key-get', 'initial-token', 'initial-password-post',
    'challenge-post', 'continuation-form-get', 'public-key-get', 'continuation-token', 'continuation-password-post']);
  assert.equal(f.tokenCalls[0].pageUrl, `https://nid.naver.com/nidlogin.login?mode=form&url=${encodeURIComponent(actorUrl)}`);
  assert.deepEqual(f.tokenCalls[0], { pageUrl: f.tokenCalls[0].pageUrl });
  assert.deepEqual(f.tokenCalls[1], { pageUrl: f.continuationUrl,
    sdk: { loaderUrl: 'https://ncpt.naver.com/static/ncaptcha-api.js?ncaptcha-onload=initNcaptcha', keyboardIds: ['id', 'pw'] } });
  assert.equal(Object.hasOwn(f.tokenCalls[1].sdk, 'siteKey'), false);
});
test('challenge continuation fails closed for missing or duplicate observed login SDK loaders', async () => {
  for (const continuationLoaders of ['',
    '<script src="https://ncpt.naver.com/static/ncaptcha-api.js"></script><script src="https://ncpt.naver.com/static/ncaptcha-api.js"></script>']) {
    const f = continuationFixture({ continuationLoaders });
    const result = await loginWithNaverPassword(identity, f);
    assert.equal(result.receipt.code, 'LOGIN_BOOTSTRAP_SDK_CHANGED');
    assert.equal(f.loginPostCount, 1);
    assert.equal(f.challengePostCount, 1);
    assert.equal(f.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'GET' && item.hasProof).length, 1);
    assert.equal(f.tokenCalls.length, 1);
  }
});

test('one returned native login form uses its response HTML, fresh key and token, and final response URL', async () => {
  const f = continuationFixture({ returnedResponseHtml: returnedLoginForm(), thirdPostOutcome: 'success' });
  const result = await loginWithNaverPassword(identity, { ...f,
    verifySession: async () => ({ verified: true, actorMatched: true, adminShell: true, httpStatus: 200 }) });

  assert.equal(result.receipt.protectedOwnerRead, true);
  assert.deepEqual(result.receipt.loginPostStatuses, [200, 200, 200]);
  assert.equal(result.receipt.loginPostCount, 3);
  assert.equal(result.receipt.challengePostCount, 1);
  assert.equal(result.receipt.challengePostStatus, 302);
  assert.equal(result.receipt.continuationBootstrapGetCount, 1);
  assert.equal(result.receipt.returnedFormSubmitCount, 1);
  assert.equal(result.receipt.returnedFormSource, 'known_login_post_response');
  assert.equal(result.receipt.returnedFormTokenIssuance.fixtureCallIndex, 3);
  assert.equal(f.loginPostCount, 3);
  assert.equal(f.challengePostCount, 1);
  assert.equal(f.challengeHandlerCallCount, 1);
  assert.deepEqual(f.keyNames, ['fixture-continuation-dynamic-key', 'fixture-continuation-dynamic-key', returnedDynamicKey]);
  assert.equal(f.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'GET' && item.hasProof).length, 1,
    'the response form is consumed directly; its one-use proof is not fetched again');
  assert.deepEqual(f.events, ['initial-form-get', 'public-key-get', 'initial-token', 'initial-password-post',
    'challenge-post', 'continuation-form-get', 'public-key-get', 'continuation-token', 'continuation-password-post',
    'public-key-get', 'returned-form-token', 'returned-form-password-post']);
  assert.equal(f.tokenCalls[2].pageUrl, loginUrl);
  assert.deepEqual(f.tokenCalls[2], { pageUrl: loginUrl,
    sdk: { loaderUrl: 'https://ncpt.naver.com/static/ncaptcha-api.js?ncaptcha-onload=initNcaptcha', keyboardIds: ['id', 'pw'] } });
  assert.equal(f.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'POST').length, 3);
  const safe = JSON.stringify(result.receipt);
  for (const opaque of [returnedProof, returnedDynamicKey, 'fixture-token-3', 'fixture-returned-form-session-key']) {
    assert.ok(!safe.includes(opaque), `receipt must not contain ${opaque}`);
  }
  result.session.clear();
});

test('a fresh auth pair from the returned-form response skips the extra submission and verifies owner', async () => {
  const f = continuationFixture({ returnedResponseHtml: returnedLoginForm(), returnedResponseAuthPair: true });
  const result = await loginWithNaverPassword(identity, { ...f,
    verifySession: async () => ({ verified: true, actorMatched: true, adminShell: true, httpStatus: 200 }) });

  assert.equal(result.receipt.protectedOwnerRead, true);
  assert.deepEqual(result.receipt.loginPostStatuses, [200, 200]);
  assert.equal(f.loginPostCount, 2);
  assert.equal(f.challengePostCount, 1);
  assert.equal(f.tokenCalls.length, 2);
  assert.equal(f.keyNames.length, 2);
  assert.equal(result.receipt.returnedFormSubmitCount, 0);
  result.session.clear();
});

test('returned-form third submission without a protected owner read is not success', async () => {
  const f = continuationFixture({ returnedResponseHtml: returnedLoginForm(), thirdPostOutcome: 'success' });
  const result = await loginWithNaverPassword(identity, { ...f,
    verifySession: async () => ({ verified: false, actorMatched: false, adminShell: false, httpStatus: 200 }) });

  assert.equal(result.receipt.protectedOwnerRead, false);
  assert.equal(result.receipt.code, 'LOGIN_PROTECTED_READ_FAILED');
  assert.deepEqual(result.receipt.loginPostStatuses, [200, 200, 200]);
  assert.equal(f.loginPostCount, 3);
  assert.equal(f.challengePostCount, 1);
  assert.equal(f.challengeHandlerCallCount, 1);
  assert.equal(f.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'POST').length, 3);
});

test('returned-form eligibility rejects unexpected response, location, notice, or native button without a third post', async () => {
  const valid = returnedLoginForm();
  const cases = [
    { name: 'non-200 response', options: { returnedResponseStatus: 403, returnedResponseHtml: valid }, code: 'LOGIN_FORM_RETURNED' },
    { name: 'non-html response', options: { returnedResponseContentType: 'application/json', returnedResponseHtml: valid }, code: 'LOGIN_FORM_RETURNED' },
    { name: 'wrong final response URL', options: { returnedResponseUrl: 'https://nid.naver.com/other', returnedResponseHtml: valid }, code: 'LOGIN_FORM_RETURNED' },
    { name: 'visible credential notice', options: { returnedResponseHtml: returnedLoginForm({ notice: '<div role="alert">비밀번호가 틀렸습니다</div>' }) }, code: 'LOGIN_CREDENTIALS_REJECTED' },
    { name: 'missing known button', options: { returnedResponseHtml: returnedLoginForm({ buttons: '' }) }, code: 'LOGIN_FORM_RETURNED' },
    { name: 'disabled known button', options: { returnedResponseHtml: returnedLoginForm({ buttons: '<button id="loginBtn_column" type="button" disabled>로그인</button>' }) }, code: 'LOGIN_FORM_RETURNED' },
    { name: 'hidden known button', options: { returnedResponseHtml: returnedLoginForm({ buttons: '<button id="loginBtn_row" type="button" hidden>로그인</button>' }) }, code: 'LOGIN_FORM_RETURNED' },
    { name: 'wrong button type', options: { returnedResponseHtml: returnedLoginForm({ buttons: '<button id="loginBtn_column" type="submit">로그인</button>' }) }, code: 'LOGIN_FORM_RETURNED' },
  ];
  for (const scenario of cases) {
    const f = continuationFixture(scenario.options);
    const result = await loginWithNaverPassword(identity, f);
    assertStoppedBeforeReturnedSubmit(f, result, scenario.code);
  }
});

test('eligible returned login button still fails closed on changed form schema or unobserved SDK loader', async () => {
  const valid = returnedLoginForm();
  const badChp = valid.replace(`<input name="chp" value="${returnedProof}">`, '');
  const duplicateChp = valid.replace('</form>', `<input name="chp" value="${returnedProof}"></form>`);
  const unknownField = valid.replace('</form>', '<input name="unexpected" value="x"></form>');
  const wrongActor = valid.replace(actorUrl, 'https://admin.blog.naver.com/not-the-owner');
  const emptyDynamicKey = valid.replace(`name="dynamicKey" value="${returnedDynamicKey}"`, 'name="dynamicKey" value=""');
  const cases = [
    { html: badChp, code: 'LOGIN_BOOTSTRAP_FORM_CHANGED' },
    { html: duplicateChp, code: 'LOGIN_BOOTSTRAP_FORM_CHANGED' },
    { html: unknownField, code: 'LOGIN_BOOTSTRAP_FORM_CHANGED' },
    { html: wrongActor, code: 'LOGIN_BOOTSTRAP_FORM_CHANGED' },
    { html: emptyDynamicKey, code: 'LOGIN_BOOTSTRAP_FORM_CHANGED' },
    { html: returnedLoginForm({ action: 'https://nid.naver.com/other' }), code: 'LOGIN_BOOTSTRAP_FORM_CHANGED' },
    { html: returnedLoginForm({ method: 'get' }), code: 'LOGIN_BOOTSTRAP_FORM_CHANGED' },
    { html: returnedLoginForm({ loaders: '' }), code: 'LOGIN_BOOTSTRAP_SDK_CHANGED' },
    { html: returnedLoginForm({ loaders: sdkLoader + sdkLoader }), code: 'LOGIN_BOOTSTRAP_SDK_CHANGED' },
    { html: returnedLoginForm({ loaders: '<script src="https://unobserved.example/ncaptcha.js"></script>' }), code: 'LOGIN_BOOTSTRAP_SDK_CHANGED' },
  ];
  for (const scenario of cases) {
    const f = continuationFixture({ returnedResponseHtml: scenario.html });
    const result = await loginWithNaverPassword(identity, f);
    assertStoppedBeforeReturnedSubmit(f, result, scenario.code);
  }
});

test('returned-form key and token failures stop before the third password POST', async () => {
  const returnedResponseHtml = returnedLoginForm();
  const badKey = continuationFixture({ returnedResponseHtml, returnedKeyBody: 'malformed-key-response' });
  const badKeyResult = await loginWithNaverPassword(identity, badKey);
  assert.equal(badKeyResult.receipt.code, 'LOGIN_BOOTSTRAP_KEY_SCHEMA');
  assert.equal(badKey.loginPostCount, 2);
  assert.equal(badKey.challengePostCount, 1);
  assert.equal(badKey.keyNames.length, 3);
  assert.equal(badKey.tokenCalls.length, 2);
  assert.equal(badKey.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'POST').length, 2);

  const badToken = continuationFixture({ returnedResponseHtml, tokenValues: { 2: '' } });
  const badTokenResult = await loginWithNaverPassword(identity, badToken);
  assert.equal(badTokenResult.receipt.code, 'LOGIN_TOKEN_NOT_ISSUED');
  assert.equal(badToken.loginPostCount, 2);
  assert.equal(badToken.challengePostCount, 1);
  assert.equal(badToken.keyNames.length, 3);
  assert.equal(badToken.tokenCalls.length, 3);
  assert.equal(badToken.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'POST').length, 2);
});

test('an uncertain returned-form password POST is never retried', async () => {
  const f = continuationFixture({ returnedResponseHtml: returnedLoginForm(), thirdPostFailure: true });
  const result = await loginWithNaverPassword(identity, f);

  assert.equal(result.receipt.outcome, 'login_response_unknown_no_retry');
  assert.equal(result.receipt.loginPostCount, 3);
  assert.deepEqual(result.receipt.loginPostStatuses, [200, 200]);
  assert.equal(f.loginPostCount, 3);
  assert.equal(f.challengePostCount, 1);
  assert.equal(f.challengeHandlerCallCount, 1);
  assert.equal(f.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'POST').length, 3);
});

test('a third login or CAPTCHA response stops without a fourth password post or another challenge', async () => {
  for (const [thirdPostOutcome, code] of [['login-form', 'LOGIN_FORM_RETURNED'], ['captcha', 'IMAGE_CHALLENGE_REQUIRED']]) {
    const f = continuationFixture({ returnedResponseHtml: returnedLoginForm(), thirdPostOutcome });
    const result = await loginWithNaverPassword(identity, f);
    assert.equal(result.receipt.code, code);
    assert.equal(result.receipt.loginPostCount, 3);
    assert.deepEqual(result.receipt.loginPostStatuses, [200, 200, 200]);
    assert.equal(f.loginPostCount, 3);
    assert.equal(f.challengePostCount, 1);
    assert.equal(f.challengeHandlerCallCount, 1);
    assert.equal(f.requests.filter(item => item.path === '/nidlogin.login' && item.method === 'POST').length, 3);
  }
});

test('login SDK accepts an omitted observed sitekey and omits it from Koop options', () => {
  const sdk = normalizeNaverLoginSdk({ loaderUrl: 'https://ncpt.naver.com/static/ncaptcha-api.js?ncaptcha-onload=initNcaptcha',
    keyboardIds: ['id', 'pw'] });
  assert.deepEqual(sdk, { loaderUrl: 'https://ncpt.naver.com/static/ncaptcha-api.js?ncaptcha-onload=initNcaptcha',
    keyboardIds: ['id', 'pw'] });
  assert.deepEqual(createNaverKoopOptions(sdk.keyboardIds, sdk), { keyboard: [{ id: 'id' }, { id: 'pw' }] });
  const observedKeySdk = normalizeNaverLoginSdk({ loaderUrl: sdk.loaderUrl, keyboardIds: ['captcha', 'chptcha'],
    siteKey: 'fixture-observed-sitekey' });
  assert.deepEqual(createNaverKoopOptions(observedKeySdk.keyboardIds, observedKeySdk),
    { keyboard: [{ id: 'captcha' }, { id: 'chptcha' }], siteKey: 'fixture-observed-sitekey' });
  assert.throws(() => normalizeNaverLoginSdk({ loaderUrl: sdk.loaderUrl, keyboardIds: ['id', 'pw'], siteKey: null }),
    { message: 'LOGIN_TOKEN_SDK_SCOPE' });
});
test('ambiguous login POST is not retried', async () => {
  const f = fixture({ postFailure: true }); const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.outcome, 'login_response_unknown_no_retry');
  assert.equal(result.receipt.loginPostCount, 1);
  assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 1);
});
test('duplicate dynamic form fields fail before token issue or login', async () => {
  const f = fixture({ duplicateField: true }); const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.code, 'LOGIN_BOOTSTRAP_FORM_CHANGED');
  assert.equal(result.receipt.loginPostCount, 0);
});
test('valid cookies without the expected owner do not complete login', async () => {
  const f = fixture({ wrongActor: true }); const result = await loginWithNaverPassword(identity, f);
  assert.equal(result.receipt.code, 'LOGIN_PROTECTED_READ_FAILED');
  assert.equal(result.receipt.states.live_replay, false);
  assert.equal(result.session, null);
});
