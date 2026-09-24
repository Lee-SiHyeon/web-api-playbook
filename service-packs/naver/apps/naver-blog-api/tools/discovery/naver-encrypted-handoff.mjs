import { createDecipheriv, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { createInterface } from 'node:readline';
import http from 'node:http';
import { normalizeNaverCookies, normalizeNaverUserAgent, naverCookieHeaderFor, storeNaverCookies } from '../../scripts/session-vault.mjs';

// One-use, in-memory bridge from an authorized browser tab to the Windows DPAPI store.
// Only the public key and sanitized status leave this process. Ciphertext arrives on stdin.
const actor = 'aicandoanything';
const target = `https://admin.blog.naver.com/${actor}`;
const startedAt = Date.now();
const expiresAt = startedAt + 120000;
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const rsaPublic = (await import('node:crypto')).createPublicKey(publicKey);
const rsaPrivate = (await import('node:crypto')).createPrivateKey(privateKey);

function decode64(value, maxBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > maxBytes * 2) {
    throw new Error('HANDOFF_ENVELOPE_INVALID');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error('HANDOFF_ENVELOPE_INVALID');
  return bytes;
}

function decryptEnvelope(envelope) {
  if (envelope?.version !== 1 || envelope?.service !== 'naver-blog' || envelope?.actor !== actor) {
    throw new Error('HANDOFF_SCOPE_INVALID');
  }
  const wrappedKey = decode64(envelope.wrappedKey, 512);
  const iv = decode64(envelope.iv, 12);
  const ciphertext = decode64(envelope.ciphertext, 131072);
  if (iv.length !== 12 || ciphertext.length < 17) throw new Error('HANDOFF_ENVELOPE_INVALID');
  const aesKey = privateDecrypt({ key: rsaPrivate, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
  try {
    if (aesKey.length !== 32) throw new Error('HANDOFF_ENVELOPE_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAAD(Buffer.from('naver-blog:aicandoanything:v1'));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    try {
      if (plaintext.length > 131072) throw new Error('HANDOFF_ENVELOPE_INVALID');
      return JSON.parse(plaintext.toString('utf8'));
    } finally { plaintext.fill(0); }
  } finally { aesKey.fill(0); }
}

async function main() {
  const timeout = setTimeout(() => { process.stderr.write('HANDOFF_TIMEOUT\n'); process.exit(2); }, 120000);
  try {
    if (process.argv.includes('--local-form')) { await serveLocalForm(); return; }
    console.log(JSON.stringify({ ready: true, service: 'naver-blog', actor, publicKey: rsaPublic.export({ format: 'jwk' }), expiresAt }));
    const lines = createInterface({ input: process.stdin, terminal: false });
    let received = false;
    for await (const line of lines) {
      if (received || Buffer.byteLength(line) > 262144 || Date.now() > expiresAt) throw new Error('HANDOFF_EXPIRED_OR_OVERSIZED');
      received = true;
      let bundle;
      try { bundle = decryptEnvelope(JSON.parse(line)); }
      catch { throw new Error('HANDOFF_DECRYPT_FAILED'); }
      if (bundle?.version !== 1 || bundle?.sourceOrigin !== 'https://admin.blog.naver.com'
        || bundle?.actor !== actor || !Number.isFinite(bundle.capturedAt)
        || bundle.capturedAt < startedAt - 10000 || bundle.capturedAt > Date.now() + 10000) {
        throw new Error('HANDOFF_SCOPE_INVALID');
      }
      const cookies = normalizeNaverCookies(bundle.cookies);
      naverCookieHeaderFor(cookies, target);
      await storeNaverCookies(cookies, { userAgent: normalizeNaverUserAgent(bundle.userAgent) });
      console.log(JSON.stringify({ stored: true, provider: 'windows_dpapi_current_user', actor,
        cookieCount: cookies.length, credentialValuesReturned: false, plaintextPersisted: false }));
      lines.close();
      return;
    }
    throw new Error('HANDOFF_INPUT_MISSING');
  } finally { clearTimeout(timeout); }
}

async function serveLocalForm() {
  let received = false;
  const server = http.createServer(async (request, response) => {
    const localOrigin = `http://127.0.0.1:${server.address().port}`;
    response.setHeader('cache-control', 'no-store');
    if (request.headers.host !== new URL(localOrigin).host) { response.writeHead(400); response.end(); return; }
    if (request.method === 'GET' && request.url === '/' && !received) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" });
      response.end('<!doctype html><title>Encrypted Naver session recovery</title><form method="post" action="/submit"><label>Encrypted session<textarea name="envelope" required></textarea></label><button>Restore verified session</button></form>');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/submit' || received || Date.now() > expiresAt
      || request.headers.origin !== localOrigin
      || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] || '')) {
      response.writeHead(404); response.end(); return;
    }
    received = true;
    let client; let result;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 262144) throw new Error('HANDOFF_OVERSIZED');
      }
      const fields = new URLSearchParams(body);
      if ([...fields.keys()].length !== 1 || !fields.has('envelope')) throw new Error('HANDOFF_INPUT_MISSING');
      const bundle = decryptEnvelope(JSON.parse(fields.get('envelope')));
      if (bundle?.version !== 1 || bundle.actor !== actor || bundle.sourceOrigin !== 'https://admin.blog.naver.com'
        || !Number.isFinite(bundle.capturedAt) || bundle.capturedAt < startedAt - 10000
        || bundle.capturedAt > Date.now() + 10000) throw new Error('HANDOFF_SCOPE_INVALID');
      const cookies = normalizeNaverCookies(bundle.cookies);
      const { SessionClient } = await import('../../scripts/session-client.mjs');
      const userAgent = normalizeNaverUserAgent(bundle.userAgent);
      client = new SessionClient({ cookies, ownerBlogId: actor, persistRotation: false,
        defaultHeaders: userAgent ? { 'user-agent': userAgent } : {} });
      await client.persistVerifiedSession();
      result = { stored: true, protectedOwnerRead: true, provider: 'windows_dpapi_current_user', actor,
        cookieCount: cookies.length, userAgentStored: !!userAgent, credentialValuesReturned: false, plaintextPersisted: false };
    } catch (error) {
      result = { stored: false, protectedOwnerRead: false, code: /^[A-Z_]+$/.test(error?.message || '') ? error.message : 'HANDOFF_FAILED' };
      process.exitCode = 2;
    } finally { client?.clear(); }
    console.log(JSON.stringify(result));
    response.writeHead(result.stored ? 200 : 422, { 'content-type': 'application/json' });
    response.once('finish', () => server.closeIdleConnections());
    response.end(JSON.stringify(result));
    server.close();
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  console.log(JSON.stringify({ ready: true, service: 'naver-blog', actor, publicKey: rsaPublic.export({ format: 'jwk' }), expiresAt,
    localForm: `http://127.0.0.1:${server.address().port}/` }));
  await new Promise(resolve => server.once('close', resolve));
}

main().catch(error => {
  const code = /^HANDOFF_[A-Z_]+$/.test(error?.message || '') ? error.message : 'HANDOFF_FAILED';
  console.error(code);
  process.exitCode = 2;
});
