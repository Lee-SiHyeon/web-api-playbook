import { createDecipheriv, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { openSync, writeFileSync, closeSync } from 'node:fs';
import http from 'node:http';
import { loginWithNaverPassword, NAVER_LOGIN_ACTOR, validateLoginIdentity } from '../../scripts/naver-login-http.mjs';
import { storeNaverLoginIdentity } from '../../scripts/naver-login-identity.mjs';
import { answerLoginChallengeWithCodex } from '../../scripts/naver-login-vision.mjs';
import { loadLoginControl, recordAccountProtection } from '../../scripts/naver-login-state.mjs';

// Optional one-time credential bootstrap. All Naver login traffic and SDK execution
// occur in Node. The browser transfers only an encrypted username/password envelope.
const actor = NAVER_LOGIN_ACTOR;
const service = 'naver-login-identity';
const startedAt = Date.now();
const expiresAt = startedAt + 120000;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const output = process.argv[2];
const identityOnly = process.argv[3] === '--identity-only';
if (!output || (process.argv.length !== 3 && !(process.argv.length === 4 && identityOnly))) throw new Error('IDENTITY_HANDOFF_OUTPUT_REQUIRED');
const outputFd = openSync(output, 'wx');
let received = false;
let completed = false;
let timer;

function decode(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('IDENTITY_HANDOFF_ENVELOPE_INVALID');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) throw new Error('IDENTITY_HANDOFF_ENVELOPE_INVALID');
  return bytes;
}

function decrypt(envelope) {
  if (envelope?.version !== 1 || envelope.service !== service || envelope.actor !== actor) throw new Error('IDENTITY_HANDOFF_SCOPE');
  const wrappedKey = decode(envelope.wrappedKey, 384);
  const iv = decode(envelope.iv, 12);
  const ciphertext = decode(envelope.ciphertext, 8192);
  if (iv.length !== 12 || ciphertext.length < 17) throw new Error('IDENTITY_HANDOFF_ENVELOPE_INVALID');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
  try {
    if (key.length !== 32) throw new Error('IDENTITY_HANDOFF_ENVELOPE_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`${service}:${actor}:v1`));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    try {
      const bundle = JSON.parse(plain.toString('utf8'));
      if (bundle?.version !== 1 || bundle.actor !== actor || bundle.sourceOrigin !== 'https://nid.naver.com'
        || !Number.isFinite(bundle.capturedAt) || bundle.capturedAt < startedAt - 10000
        || bundle.capturedAt > Date.now() + 10000) throw new Error('IDENTITY_HANDOFF_SCOPE');
      return validateLoginIdentity(bundle);
    } finally { plain.fill(0); }
  } finally { key.fill(0); }
}

function finish(result) {
  if (completed) return;
  completed = true;
  clearTimeout(timer);
  const safe = { ...result, identityBootstrap: 'browser_autofill_encrypted_once',
    credentialValuesReturned: false, plaintextPersisted: false };
  try { writeFileSync(outputFd, JSON.stringify(safe, null, 2) + '\n'); }
  finally { closeSync(outputFd); }
  console.log(JSON.stringify(safe));
  if (!safe.protectedOwnerRead || !safe.sessionStored || !safe.identityStored || safe.code) process.exitCode = 2;
}

const server = http.createServer(async (request, response) => {
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  response.setHeader('cache-control', 'no-store');
  if (request.headers.host !== new URL(localOrigin).host) { response.writeHead(400); response.end(); return; }
  if (request.method === 'GET' && request.url === '/' && !received) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" });
    response.end('<!doctype html><meta charset="utf-8"><title>Local encrypted Naver identity handoff</title><form method="post" action="/submit"><label>One-time encrypted identity<textarea name="envelope" required></textarea></label><button>Submit encrypted identity</button></form>');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/submit' || received || Date.now() > expiresAt
    || request.headers.origin !== localOrigin
    || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] || '')) {
    response.writeHead(404); response.end(); return;
  }
  received = true;
  let identity; let session; let result;
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > 32768) throw new Error('IDENTITY_HANDOFF_TOO_LARGE');
    }
    const fields = new URLSearchParams(body);
    if ([...fields.keys()].length !== 1 || !fields.has('envelope')) throw new Error('IDENTITY_HANDOFF_ENVELOPE_INVALID');
    identity = decrypt(JSON.parse(fields.get('envelope')));
    if (identityOnly) {
      const { loadNaverCookies } = await import('../../scripts/session-vault.mjs');
      const { SessionClient } = await import('../../scripts/session-client.mjs');
      const stored = await loadNaverCookies({ env: {} });
      session = new SessionClient({ cookies: stored.cookies, ownerBlogId: actor, persistRotation: false,
        defaultHeaders: stored.userAgent ? { 'user-agent': stored.userAgent } : {} });
      const verified = await session.verifyRoot();
      if (!verified.verified || !verified.actorMatched || !verified.adminShell) throw new Error('IDENTITY_OWNER_UNVERIFIED');
      result = { actor, executionMode: 'credential_bootstrap_after_observed_browser_login', freshLoginPerformed: false,
        protectedOwnerRead: true, sessionStored: stored.persisted, identityStored: storeNaverLoginIdentity(identity).stored,
        loginPostCount: 0, cookiesPersisted: false };
    } else {
      const control = loadLoginControl();
      if (control.blocked) throw new Error(control.code);
      const login = await loginWithNaverPassword(identity, {
        handleChallenge: answerLoginChallengeWithCodex,
      });
      result = login.receipt; session = login.session;
      if (result.code === 'ACCOUNT_PROTECTION_REQUIRED') recordAccountProtection();
      if (result.protectedOwnerRead) {
        result.sessionStored = (await session.persistVerifiedSession()).stored;
        result.cookiesPersisted = result.sessionStored;
        result.identityStored = storeNaverLoginIdentity(identity).stored;
      }
    }
  } catch (error) {
    result = { ...result, actor, code: /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'IDENTITY_HANDOFF_FAILED',
      protectedOwnerRead: result?.protectedOwnerRead === true };
  } finally {
    if (identity) { identity.username = ''; identity.password = ''; }
    session?.clear();
  }
  finish(result);
  response.writeHead(result.protectedOwnerRead && result.sessionStored && result.identityStored && !result.code ? 200 : 422,
    { 'content-type': 'application/json; charset=utf-8' });
  response.once('finish', () => server.closeIdleConnections());
  response.end(JSON.stringify(result));
  server.close();
});
server.requestTimeout = 110000;
server.headersTimeout = 10000;
timer = setTimeout(() => {
  finish({ actor, protectedOwnerRead: false, code: 'IDENTITY_HANDOFF_TIMEOUT' });
  server.closeAllConnections(); server.close();
}, 360000);
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({ ready: true, service, actor, expiresAt, publicKey: publicKey.export({ format: 'jwk' }),
  localForm: `http://127.0.0.1:${server.address().port}/` }));
