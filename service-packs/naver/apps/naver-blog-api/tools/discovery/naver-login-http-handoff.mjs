import { createDecipheriv, createPublicKey, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { normalizeNaverCookies } from '../../scripts/session-vault.mjs';
import { hasFreshAuthenticationCookies, mergeLoginResponseCookies } from './naver-login-http-handoff-utils.mjs';

// One-use browser-prepared form handoff. The browser prepares its normal ncaptcha
// and encrypted credential fields; this process alone submits the observed POST.
const actor = 'aicandoanything';
const origin = 'https://nid.naver.com';
const loginUrl = `${origin}/nidlogin.login`;
const adminUrl = `https://admin.blog.naver.com/${actor}`;
const start = Date.now();
const expiry = start + 120000;
const keys = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privateKey = (await import('node:crypto')).createPrivateKey(keys.privateKey);
const publicKey = createPublicKey(keys.publicKey);

function b64(value, limit) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > limit * 2) throw new Error('LOGIN_HANDOFF_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== value) throw new Error('LOGIN_HANDOFF_INVALID');
  return bytes;
}

function decrypt(input) {
  if (input?.version !== 1 || input?.service !== 'naver-login' || input?.actor !== actor) throw new Error('LOGIN_HANDOFF_SCOPE');
  const wrapped = b64(input.wrappedKey, 512);
  const iv = b64(input.iv, 12);
  const ciphertext = b64(input.ciphertext, 131072);
  if (iv.length !== 12 || ciphertext.length < 17) throw new Error('LOGIN_HANDOFF_INVALID');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
  try {
    if (key.length !== 32) throw new Error('LOGIN_HANDOFF_INVALID');
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`naver-login:${actor}:v1`));
    cipher.setAuthTag(ciphertext.subarray(-16));
    const plain = Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
    try { return JSON.parse(plain.toString('utf8')); }
    finally { plain.fill(0); }
  } finally { key.fill(0); }
}

function scopedCookieHeader(cookies, target) {
  const url = new URL(target);
  return cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '');
    return (url.hostname === domain || (cookie.domain.startsWith('.') && url.hostname.endsWith('.' + domain)))
      && (cookie.path === '/' || url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/'));
  }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function validateBundle(bundle) {
  if (bundle?.version !== 1 || bundle?.actor !== actor || bundle?.sourceOrigin !== origin
    || bundle?.action !== loginUrl || !Number.isFinite(bundle.capturedAt)
    || bundle.capturedAt < start - 10000 || bundle.capturedAt > Date.now() + 10000
    || typeof bundle.form !== 'string' || bundle.form.length > 32768 || /[\r\n]/.test(bundle.form)
    || typeof bundle.userAgent !== 'string' || bundle.userAgent.length > 512 || /[\r\n]/.test(bundle.userAgent)) {
    throw new Error('LOGIN_HANDOFF_SCOPE');
  }
  let sourcePage;
  try { sourcePage = new URL(bundle.sourcePage); } catch { throw new Error('LOGIN_HANDOFF_SCOPE'); }
  if (sourcePage.origin !== origin || sourcePage.pathname !== '/nidlogin.login') throw new Error('LOGIN_HANDOFF_SCOPE');
  const params = new URLSearchParams(bundle.form);
  const names = [...params.keys()];
  const expected = ['dynamicKey', 'sessionKey', 'show_pk', 'wtoken', 'svctype', 'bvsd', 'locale', 'url', 'eccpw',
    'template_url', 'enctp', 'next_step', 'template_type', 'smart_LEVEL', 'id', 'pw'];
  if (names.length !== expected.length || expected.some(name => !params.has(name) || params.getAll(name).length !== 1)
    || !params.get('dynamicKey') || !params.get('eccpw') || !params.get('wtoken')
    || /^(?:timeout|error\d*\|)/i.test(params.get('wtoken'))
    || params.get('id') || params.get('pw') || params.get('bvsd')) throw new Error('LOGIN_FORM_CHANGED');
  let returnUrl;
  try { returnUrl = new URL(params.get('url')); } catch { throw new Error('LOGIN_RETURN_SCOPE'); }
  if (!['https://www.naver.com', 'https://admin.blog.naver.com'].includes(returnUrl.origin)) throw new Error('LOGIN_RETURN_SCOPE');
  if (returnUrl.origin === 'https://admin.blog.naver.com' && returnUrl.pathname !== `/${actor}`) throw new Error('LOGIN_RETURN_SCOPE');
  const cookies = normalizeNaverCookies(bundle.cookies, Date.now(), { requireAuthentication: false });
  return { cookies, params };
}

async function boundedBody(response) {
  if (!response.body) return '';
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 256 * 1024) throw new Error('LOGIN_RESPONSE_OVERSIZED');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function submit(bundle) {
  const { cookies } = validateBundle(bundle);
  const response = await fetch(loginUrl, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'content-type': 'application/x-www-form-urlencoded', origin, referer: bundle.sourcePage,
      'user-agent': bundle.userAgent, 'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1', cookie: scopedCookieHeader(cookies, loginUrl) },
    body: bundle.form });
  const html = await boundedBody(response);
  const update = mergeLoginResponseCookies(cookies, response);
  const fresh = hasFreshAuthenticationCookies(cookies, update.cookies, actor);
  const { summarizeNaverLoginResponse, classifyUnauthenticatedLoginResponse } = await import('../../scripts/naver-login-http.mjs');
  const responseShape = summarizeNaverLoginResponse(html, response);
  const receipt = { actor, mode: 'browser_prepared_http_submit', browserSubmittedLogin: false,
    httpPostStatus: response.status, freshAuthCookies: fresh,
    imageChallengeDetected: !fresh && responseShape.imageChallengeDetected, responseShape,
    protectedOwnerRead: false, stored: false };
  if (!fresh) return { ...receipt, code: classifyUnauthenticatedLoginResponse(responseShape, response.status) };
  process.env.NAVER_BLOG_ID = actor;
  const { SessionClient } = await import('../../scripts/session-client.mjs');
  const client = new SessionClient({ cookies: update.cookies, ownerBlogId: actor,
    defaultHeaders: { 'user-agent': bundle.userAgent }, persistRotation: false });
  try {
    let persistence;
    try { persistence = await client.persistVerifiedSession(); }
    catch (error) {
      if (error?.code === 'AUTH_UNVERIFIED' || error?.code === 'AUTH_MISSING') {
        return { ...receipt, code: 'LOGIN_PROTECTED_READ_FAILED' };
      }
      throw error;
    }
    const verification = persistence?.verification;
    receipt.protectedOwnerRead = verification?.verified === true
      && verification.actorMatched === true && verification.adminShell === true;
    receipt.userAgentApplied = verification?.userAgentApplied === true;
    receipt.stored = persistence?.stored === true;
  } finally { client.clear(); }
  if (!receipt.protectedOwnerRead) return { ...receipt, code: 'LOGIN_PROTECTED_READ_FAILED' };
  if (!receipt.stored) return { ...receipt, code: 'CREDENTIAL_STORE_UNVERIFIED' };
  return receipt;
}

async function main() {
  const timeout = setTimeout(() => { console.error('LOGIN_HANDOFF_TIMEOUT'); process.exit(2); }, 120000);
  try {
    if (process.argv.includes('--local-form')) {
      await serveLocalForm();
      return;
    }
    console.log(JSON.stringify({ ready: true, service: 'naver-login', actor,
      publicKey: publicKey.export({ format: 'jwk' }), expiresAt: expiry }));
    const lines = createInterface({ input: process.stdin, terminal: false });
    try {
      for await (const line of lines) {
        if (Date.now() > expiry || Buffer.byteLength(line) > 262144) throw new Error('LOGIN_HANDOFF_EXPIRED');
        let bundle;
        try { bundle = decrypt(JSON.parse(line)); } catch { throw new Error('LOGIN_HANDOFF_DECRYPT_FAILED'); }
        const result = await submit(bundle);
        console.log(JSON.stringify(result));
        if (!result.protectedOwnerRead) process.exitCode = 2;
        return;
      }
      throw new Error('LOGIN_HANDOFF_INPUT_MISSING');
    } finally {
      lines.close();
    }
  } finally { clearTimeout(timeout); }
}

async function serveLocalForm() {
  let received = false;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'" });
      response.end('<!doctype html><meta charset="utf-8"><title>Naver encrypted login handoff</title><form method="post" action="/submit"><label>One-time encrypted envelope<textarea name="envelope" required></textarea></label><button>Submit encrypted envelope</button></form>');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/submit' || received || Date.now() > expiry
      || request.headers.origin !== `http://127.0.0.1:${server.address().port}`
      || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] || '')) {
      response.writeHead(404, { 'content-type': 'text/plain' }); response.end('UNAVAILABLE'); return;
    }
    received = true;
    let result;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 262144) throw new Error('LOGIN_HANDOFF_OVERSIZED');
      }
      const fields = new URLSearchParams(body);
      const sealed = fields.get('envelope');
      if (!sealed || [...fields.keys()].length !== 1) throw new Error('LOGIN_HANDOFF_INPUT_MISSING');
      let bundle;
      try { bundle = decrypt(JSON.parse(sealed)); } catch { throw new Error('LOGIN_HANDOFF_DECRYPT_FAILED'); }
      result = await submit(bundle);
      if (!result.protectedOwnerRead) process.exitCode = 2;
    } catch (error) {
      result = { actor, protectedOwnerRead: false,
        code: /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'LOGIN_HTTP_FAILED' };
      process.exitCode = 2;
    }
    console.log(JSON.stringify(result));
    response.writeHead(result.protectedOwnerRead ? 200 : 422, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(result));
    server.close();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  console.log(JSON.stringify({ ready: true, service: 'naver-login', actor,
    publicKey: publicKey.export({ format: 'jwk' }), expiresAt: expiry,
    localForm: `http://127.0.0.1:${server.address().port}/` }));
  await new Promise(resolve => server.once('close', resolve));
}

main().catch(error => {
  console.error(/^[A-Z_]+$/.test(error?.message || '') ? error.message : 'LOGIN_HTTP_FAILED');
  process.exitCode = 2;
});
