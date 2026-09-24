import http from 'node:http';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { ScopedHttpSession, BLOG_ORIGIN } from '../lib/transport.mjs';
import { saveState, loadState } from '../lib/state.mjs';
import { verifySession } from '../lib/auth.mjs';
import { withSessionLock } from '../lib/lock.mjs';

// One-use local form carries only RSA-OAEP/AES-GCM ciphertext. Private key and
// decrypted cookies stay in this process, then Windows DPAPI CurrentUser.
const aad = 'tistory:i-never-stop-study:v1';
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const startedAt = Date.now();
const expiresAt = startedAt + 300000;
let used = false;
const codeOf = error => /^[A-Z][A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'TISTORY_HANDOFF_FAILED';
function bytes(text, min, max) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length > max * 2) throw new Error();
  const b = Buffer.from(text, 'base64');
  if (b.length < min || b.length > max || b.toString('base64') !== text) throw new Error();
  return b;
}
function decrypt(envelope) {
  if (envelope?.version !== 1 || envelope.service !== 'tistory-api') throw new Error();
  const wrapped = bytes(envelope.wrappedKey, 384, 384);
  const iv = bytes(envelope.iv, 12, 12);
  const ciphertext = bytes(envelope.ciphertext, 17, 131072);
  const key = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
  try {
    if (key.length !== 32) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    try { return JSON.parse(plain.toString('utf8')); } finally { plain.fill(0); }
  } finally { key.fill(0); }
}
const server = http.createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  response.setHeader('cache-control', 'no-store');
  if (request.headers.host !== new URL(origin).host) { response.writeHead(400).end(); return; }
  if (request.method === 'GET' && request.url === '/' && !used) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" });
    response.end('<!doctype html><title>Tistory encrypted session handoff</title><form method="post" action="/submit"><label>Encrypted session<textarea name="envelope" required></textarea></label><button>Store verified Tistory session</button></form>');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/submit' || used || Date.now() > expiresAt || request.headers.origin !== origin
    || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] || '')) { response.writeHead(404).end(); return; }
  used = true;
  let result;
  try {
    let body = '';
    for await (const part of request) { body += part.toString('utf8'); if (Buffer.byteLength(body) > 262144) throw new Error(); }
    const form = new URLSearchParams(body);
    if ([...form.keys()].length !== 1 || !form.has('envelope')) throw new Error();
    const bundle = decrypt(JSON.parse(form.get('envelope')));
    if (bundle?.version !== 1 || bundle.blogOrigin !== BLOG_ORIGIN || !Number.isFinite(bundle.capturedAt)
      || bundle.capturedAt < startedAt - 10000 || bundle.capturedAt > Date.now() + 10000) throw new Error();
    const session = ScopedHttpSession.fromBrowserCookies(bundle.cookies, { userAgent: bundle.userAgent, now: Date.now });
    const verified = await withSessionLock(async () => {
      const existing = loadState();
      const checked = await verifySession(session, existing?.identity);
      saveState({ version: 1, blogOrigin: BLOG_ORIGIN, session: session.toJSON(), identity: checked.identity,
        verifiedAt: checked.verifiedAt, login: { ...existing?.login, reauthRequired: false } });
      return checked;
    });
    result = { stored: true, provider: 'windows_dpapi_current_user', ...verified.receipt,
      cookieCount: session.cookieMetadata().count, plaintextPersisted: false, credentialValuesReturned: false };
  } catch (error) { result = { stored: false, code: codeOf(error) }; process.exitCode = 2; }
  console.log(JSON.stringify(result));
  response.writeHead(result.stored ? 200 : 422, { 'content-type': 'application/json' });
  response.end(JSON.stringify(result));
  server.close(); server.closeIdleConnections(); clearTimeout(timer);
});
await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const timer = setTimeout(() => { server.close(); server.closeAllConnections(); console.error('TISTORY_HANDOFF_TIMEOUT'); process.exitCode = 2; }, 300000);
console.log(JSON.stringify({ ready: true, service: 'tistory-api', publicKey: keys.publicKey.export({ format: 'jwk' }),
  localForm: `http://127.0.0.1:${server.address().port}/`, expiresAt }));
