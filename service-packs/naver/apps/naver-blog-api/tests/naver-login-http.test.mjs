import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHash, createDecipheriv } from 'node:crypto';
import { loginWithNaverPassword, NAVER_LOGIN_ACTOR } from '../scripts/naver-login-http.mjs';

const identity = { username: 'fixture-user', password: 'fixture-only-한글' };
const actorUrl = `https://admin.blog.naver.com/${NAVER_LOGIN_ACTOR}`;
function fixture({ accepted = true, token = 'fixture-sdk-result', postFailure = false,
  duplicateField = false, wrongActor = false } = {}) {
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
      if (accepted) {
        headers.append('set-cookie', 'NID_AUT=fixture-auth; Domain=.naver.com; Path=/; Secure; HttpOnly');
        headers.append('set-cookie', 'NID_SES=fixture-session; Domain=.naver.com; Path=/; Secure; HttpOnly');
      }
      return new Response(accepted ? '<html>done</html>' : '<form id="frmNIDLogin"><input name="captcha"><img src="/captcha/image"></form>', { status: 200, headers });
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
