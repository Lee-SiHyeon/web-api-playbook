import { JSDOM, CookieJar } from 'jsdom';
import { encryptLoginFields } from '../tools/discovery/naver-login-bootstrap.mjs';
import { issueLoginTokenInWorker } from './naver-login-token-client.mjs';
import { NAVER_NODE_USER_AGENT } from './naver-login-token-provider.mjs';

export const NAVER_LOGIN_ACTOR = 'aicandoanything';
const origin = 'https://nid.naver.com';
const loginUrl = `${origin}/nidlogin.login`;
const adminUrl = `https://admin.blog.naver.com/${NAVER_LOGIN_ACTOR}`;
const pageUrl = `${loginUrl}?mode=form&url=${encodeURIComponent(adminUrl)}`;
const fieldNames = ['dynamicKey', 'sessionKey', 'show_pk', 'wtoken', 'svctype', 'bvsd', 'locale', 'url', 'eccpw',
  'template_url', 'enctp', 'next_step', 'template_type', 'smart_LEVEL', 'id', 'pw'];

export function validateLoginIdentity(identity) {
  if (!identity || ![identity.username, identity.password].every(value => typeof value === 'string'
    && value.length > 0 && value.length <= 255 && !/[\r\n\0]/.test(value))
    || identity.username !== identity.username.trim()) throw new Error('LOGIN_IDENTITY_INVALID');
  return { username: identity.username, password: identity.password };
}

async function readBody(response) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('LOGIN_RESPONSE_SIZE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sessionCookies(jar) {
  return jar.getCookiesSync(adminUrl).map(cookie => ({ name: cookie.key, value: cookie.value,
    domain: cookie.hostOnly ? cookie.domain : '.' + cookie.domain, path: cookie.path,
    secure: cookie.secure, httpOnly: cookie.httpOnly,
    expires: cookie.expires === 'Infinity' ? -1 : new Date(cookie.expires).getTime() / 1000,
  }));
}

function responseShape(html) {
  const dom = new JSDOM(html, { url: loginUrl });
  try {
    const doc = dom.window.document;
    const fields = [...doc.querySelectorAll('input[name]')].map(input => input.name)
      .filter(name => /^[A-Za-z0-9_-]{1,64}$/.test(name)).slice(0, 50);
    const captchaInput = fields.some(name => /^(?:captcha|chptcha|captcha_value|captchaAnswer)$/i.test(name));
    const captchaImage = [...doc.images].some(img => /captcha|캡차|자동입력/i.test([img.id, img.className, img.src, img.alt].join(' ')));
    const receiptChallenge = [...doc.scripts].some(script => {
      try { const url = new URL(script.src); return url.origin === 'https://rcaptcha.nid.naver.com' && url.pathname === '/rcapt.js'; }
      catch { return false; }
    });
    const redirectPaths = [...html.matchAll(/(?:location(?:\.href)?\s*=|location\.replace\()\s*["']([^"'\r\n]+)["']/g)]
      .slice(0, 10).flatMap(match => {
        try {
          const url = new URL(match[1].replaceAll('&amp;', '&'), loginUrl);
          if (url.origin !== origin || !/^\/[A-Za-z0-9_./-]{1,120}$/.test(url.pathname)) return [];
          return [{ origin: url.origin, path: url.pathname, queryNames: [...url.searchParams.keys()]
            .filter(key => /^[A-Za-z0-9_]{1,64}$/.test(key)).slice(0, 20) }];
        } catch { return []; }
      });
    return { inputNames: fields, imageChallengeDetected: captchaInput && (captchaImage || receiptChallenge),
      loginForm: !!doc.getElementById('frmNIDLogin'),
      additionalVerification: fields.some(name => /otp|authcode|verification/i.test(name)),
      finalizeReference: /signin\/v3\/finalize/.test(html), htmlLength: html.length, redirectPaths,
      notices: {
        credentialsRejected: /아이디.{0,40}비밀번호.{0,40}(?:확인|잘못|일치)|비밀번호가.{0,30}(?:틀|잘못)/.test(doc.body?.textContent || ''),
        temporaryRestriction: /(?:접속|요청|로그인).{0,40}(?:제한|차단)|잠시.{0,15}(?:후|뒤).{0,30}다시/.test(doc.body?.textContent || ''),
        additionalVerification: /추가.{0,15}인증|2단계.{0,15}인증/.test(doc.body?.textContent || ''),
      } };
  } finally { dom.window.close(); }
}

function challengeContinuation(response, html) {
  const candidates = [response.headers.get('location')];
  for (const match of html.matchAll(/(?:location(?:\.href)?\s*=|location\.replace\()\s*["']([^"'\r\n]+)["']/g)) {
    candidates.push(match[1].replaceAll('&amp;', '&'));
  }
  const accepted = candidates.filter(Boolean).flatMap(raw => {
    try {
      const url = new URL(raw, loginUrl);
      // Observed legacy Location uses HTTP; Chrome upgrades this host via HSTS.
      // Apply the same HTTPS-only upgrade locally without sending a plaintext request.
      if (url.protocol === 'http:' && url.hostname === 'nid.naver.com' && !url.port && url.pathname === '/nidlogin.login') {
        url.protocol = 'https:';
      }
      const proof = url.searchParams.get('chp');
      return url.origin === origin && url.pathname === '/nidlogin.login' && !url.username && !url.password && !url.hash
        && url.searchParams.get('mode') === 'form' && url.searchParams.get('url') === adminUrl
        && typeof proof === 'string' && proof.length > 0 && proof.length <= 512 && !/[\r\n\0]/.test(proof)
        && [...url.searchParams.keys()].every(key => url.searchParams.getAll(key).length === 1) ? [url.href] : [];
    } catch { return []; }
  });
  const unique = [...new Set(accepted)];
  if (unique.length > 1) throw new Error('LOGIN_CHALLENGE_CONTINUATION_AMBIGUOUS');
  return unique[0] || null;
}

export async function loginWithNaverPassword(identity, { fetchImpl = globalThis.fetch,
  tokenIssuer = issueLoginTokenInWorker, verifySession, handleChallenge } = {}) {
  let { username, password } = validateLoginIdentity(identity);
  const jar = new CookieJar();
  let challengeRequestCount = 0;
  const receipt = { actor: NAVER_LOGIN_ACTOR, checkedAt: new Date().toISOString(), executionMode: 'pure_http',
    sdkRuntime: 'node_jsdom_wasm', browserEngineUsed: false, credentialEncryption: 'node_crypto', imageModelInvoked: false,
    loginPostCount: 0, loginPostStatuses: [], freshAuthCookies: false, protectedOwnerRead: false, cookiesPersisted: false,
    states: { captured: true, client_exists: true, credential_propagated: false, remnant_free: true, live_replay: false } };
  async function request(url, init = {}) {
    const target = new URL(url);
    const loginPath = target.origin === origin && (['/nidlogin.login', '/nidlogin.rcaptcha'].includes(target.pathname)
      || /^\/login\/dynamicEcKey\/[^/]+$/.test(target.pathname));
    const challengePath = target.origin === 'https://rcaptcha.nid.naver.com'
      && ['/rcapt.js', '/rcaptUi', '/question', '/verifyJs'].includes(target.pathname) && (init.method || 'GET') === 'GET';
    if (target.username || target.password || !(loginPath || challengePath)) {
      throw new Error('LOGIN_REQUEST_SCOPE');
    }
    if (target.pathname === '/nidlogin.rcaptcha' && init.method === 'POST' && ++challengeRequestCount > 1) {
      throw new Error('LOGIN_CHALLENGE_RETRY_FORBIDDEN');
    }
    const headers = new Headers({ 'user-agent': NAVER_NODE_USER_AGENT, 'accept-language': 'ko-KR,ko;q=0.9', ...init.headers });
    const cookies = jar.getCookieStringSync(url);
    if (cookies) headers.set('cookie', cookies);
    const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000), headers });
    for (const line of (response.headers.getSetCookie?.() || []).slice(0, 100)) {
      if (line.length <= 8192) jar.setCookieSync(line, url, { ignoreError: true });
    }
    return response;
  }
  let params;
  async function submitPassword(currentPageUrl, afterChallenge = false) {
    if (receipt.loginPostCount >= (afterChallenge ? 2 : 1)) throw new Error('LOGIN_RETRY_FORBIDDEN');
    const page = await request(currentPageUrl, { headers: { accept: 'text/html' } });
    if (page.status !== 200 || !/^text\/html(?:;|$)/i.test(page.headers.get('content-type') || '')) throw new Error('LOGIN_BOOTSTRAP_PAGE_REJECTED');
    const dom = new JSDOM(await readBody(page), { url: currentPageUrl });
    try {
      const form = dom.window.document.getElementById('frmNIDLogin');
      if (form?.action !== loginUrl || form.method.toLowerCase() !== 'post') throw new Error('LOGIN_BOOTSTRAP_FORM_CHANGED');
      params = new URLSearchParams([...new dom.window.FormData(form)]);
      const expected = afterChallenge ? [...fieldNames, 'chp'] : fieldNames;
      if ([...params.keys()].length !== expected.length
        || expected.some(name => params.getAll(name).length !== 1)
        || (afterChallenge && params.get('chp') !== new URL(currentPageUrl).searchParams.get('chp'))
        || params.get('url') !== adminUrl || !params.get('dynamicKey')) throw new Error('LOGIN_BOOTSTRAP_FORM_CHANGED');
    } finally { dom.window.close(); }
    const key = await request(`${origin}/login/dynamicEcKey/${encodeURIComponent(params.get('dynamicKey'))}`,
      { headers: { accept: 'text/plain,*/*;q=0.1', 'x-requested-with': 'XMLHttpRequest' } });
    if (key.status !== 200) throw new Error('LOGIN_BOOTSTRAP_KEY_REJECTED');
    const parts = (await readBody(key)).trim().split(',');
    if (parts.length !== 2 || !parts[0] || !/^04[0-9a-f]{128}$/i.test(parts[1])) throw new Error('LOGIN_BOOTSTRAP_KEY_SCHEMA');
    ({ username, password } = validateLoginIdentity(identity));
    params.set('eccpw', encryptLoginFields({ sessionKey: parts[0], serverPublicKey: parts[1], username, password }));
    username = ''; password = '';
    params.set('id', ''); params.set('pw', ''); params.set('sessionKey', '');
    if (params.get('bvsd')) throw new Error('LOGIN_BOOTSTRAP_FORM_CHANGED');
    const tokenResult = await tokenIssuer({ pageUrl: currentPageUrl });
    receipt[afterChallenge ? 'continuationTokenIssuance' : 'tokenIssuance'] = tokenResult.receipt;
    if (typeof tokenResult.token !== 'string' || !tokenResult.token || tokenResult.token.length > 8192
      || /[\r\n\0]/.test(tokenResult.token) || /^(?:timeout|error\d*\|)/i.test(tokenResult.token)) {
      throw new Error('LOGIN_TOKEN_NOT_ISSUED');
    }
    params.set('wtoken', tokenResult.token); tokenResult.token = null;
    receipt.loginPostCount += 1;
    const response = await request(loginUrl, { method: 'POST',
      headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', origin, referer: currentPageUrl },
      body: params.toString() });
    params = null;
    receipt.loginPostStatuses.push(response.status);
    return response;
  }
  try {
    let response = await submitPassword(pageUrl);
    receipt.httpStatus = response.status;
    let html = await readBody(response);
    receipt.responseShape = responseShape(html);
    if (handleChallenge && receipt.responseShape.inputNames.includes('chptcha')) {
      receipt.responseShape.imageChallengeDetected = true;
      response = await handleChallenge({ html, pageUrl: loginUrl, request, tokenIssuer, receipt });
      receipt.challengePostStatus = response.status;
      receipt.httpStatus = response.status;
      html = await readBody(response);
      receipt.responseShape = responseShape(html);
      if (response.headers.has('location')) {
        const redirect = new URL(response.headers.get('location'), loginUrl);
        let returnUrl; try { returnUrl = new URL(redirect.searchParams.get('url')); } catch {}
        receipt.challengeRedirect = { origin: redirect.origin, path: redirect.pathname,
          queryNames: [...redirect.searchParams.keys()], mode: redirect.searchParams.get('mode'),
          proofPresent: !!redirect.searchParams.get('chp'), proofLength: redirect.searchParams.get('chp')?.length || 0,
          returnOrigin: returnUrl?.origin, returnPath: returnUrl?.pathname };
      }
      const continuation = challengeContinuation(response, html);
      if (continuation) {
        receipt.challengeProofReceived = true;
        response = await submitPassword(continuation, true);
        receipt.httpStatus = response.status;
        html = await readBody(response);
        receipt.responseShape = responseShape(html);
      }
    }
    const cookies = sessionCookies(jar);
    const names = new Set(cookies.filter(cookie => cookie.value).map(cookie => cookie.name));
    receipt.freshAuthCookies = ['NID_AUT', 'NID_SES'].every(name => names.has(name));
    if (!receipt.freshAuthCookies) {
      const protectedAccount = receipt.responseShape.redirectPaths.some(url => url.path === '/user2/help/idSafetyRelease');
      receipt.code = protectedAccount ? 'ACCOUNT_PROTECTION_REQUIRED'
        : receipt.responseShape.imageChallengeDetected ? 'IMAGE_CHALLENGE_REQUIRED'
        : receipt.responseShape.additionalVerification ? 'ADDITIONAL_VERIFICATION_REQUIRED' : 'LOGIN_NOT_VERIFIED';
      if (protectedAccount) receipt.nextAction = 'complete_naver_account_recovery_before_another_login';
      return { receipt, session: null };
    }
    receipt.states.credential_propagated = true;
    const { SessionClient } = await import('./session-client.mjs');
    const session = new SessionClient({ cookies, fetchImpl, persistRotation: false,
      ownerBlogId: NAVER_LOGIN_ACTOR, defaultHeaders: { 'user-agent': NAVER_NODE_USER_AGENT } });
    try {
      const result = verifySession ? await verifySession(session) : await session.verifyRoot();
      receipt.protectedOwnerRead = result.verified === true && result.actorMatched === true && result.adminShell === true;
      receipt.protectedReadStatus = result.httpStatus;
      if (!receipt.protectedOwnerRead) throw new Error('LOGIN_PROTECTED_READ_FAILED');
      receipt.states.live_replay = true;
      return { receipt, session };
    } catch (error) { session.clear(); throw error; }
  } catch (error) {
    const code = error?.code || error?.message || '';
    receipt.code = /^[A-Z_]+$/.test(code) ? code : 'LOGIN_HTTP_FAILED';
    if (receipt.challengePostCount === 1 && receipt.challengePostStatus == null) receipt.outcome = 'challenge_response_unknown_no_retry';
    if (receipt.loginPostStatuses.length < receipt.loginPostCount) receipt.outcome = 'login_response_unknown_no_retry';
    return { receipt, session: null };
  } finally { username = ''; password = ''; params = null; jar.removeAllCookiesSync(); }
}
