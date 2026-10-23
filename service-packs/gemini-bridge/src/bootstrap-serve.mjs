import { createServer } from 'node:http';
import { createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { writeCredential } from '../../google-flow-api/src/secure-credential-store.mjs';

const origin = 'https://gemini.google.com';
const credentialName = 'google-gemini-session-v1';
const runId = randomUUID();
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
let consumed = false;
const info = { runId, publicKey: publicKey.toString('base64'), encryption: 'RSA-OAEP-SHA256+AES-256-GCM' };
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'; base-uri 'none'");
  if (req.method === 'GET' && req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Gemini encrypted session handoff</title><main><h1>Gemini encrypted session handoff</h1>'
      + '<p id="run-id">' + runId + '</p><p id="public-key">' + info.publicKey + '</p>'
      + '<form method="POST" action="/handoff"><label>Sealed envelope<textarea name="payload"></textarea></label>'
      + '<button>Store encrypted Gemini session</button></form></main>');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/handoff' || consumed) {
    res.writeHead(404).end(); return;
  }
  const expectedHost = '127.0.0.1:' + server.address().port;
  if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== 'http://' + expectedHost)) {
    res.writeHead(403).end(); return;
  }
  try {
    let raw = '', size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 200000) throw new Error('HANDOFF_TOO_LARGE');
      raw += chunk.toString('utf8');
    }
    const envelope = JSON.parse(req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
      ? new URLSearchParams(raw).get('payload') : raw);
    if (envelope?.version !== 1 || envelope.runId !== runId
        || typeof envelope.key !== 'string' || typeof envelope.iv !== 'string'
        || typeof envelope.ciphertext !== 'string') throw new Error('HANDOFF_ENVELOPE_INVALID');
    const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64'));
    const iv = Buffer.from(envelope.iv, 'base64');
    const sealed = Buffer.from(envelope.ciphertext, 'base64');
    if (key.length !== 32 || iv.length !== 12 || sealed.length < 17) throw new Error('HANDOFF_ENVELOPE_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(sealed.subarray(-16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    if (plain.length > 131072) throw new Error('HANDOFF_TOO_LARGE');
    const bundle = JSON.parse(plain.toString('utf8'));
    key.fill(0); plain.fill(0);
    if (bundle?.version !== 1 || bundle.origin !== origin || !Array.isArray(bundle.cookies)
        || bundle.cookies.length < 2 || bundle.cookies.length > 64) throw new Error('HANDOFF_SCOPE_INVALID');
    const cookies = bundle.cookies.map(cookie => {
      const domain = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase() : '';
      const host = new URL(origin).hostname;
      const scope = domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
      if (!scope || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,100}$/.test(cookie.name)
          || typeof cookie.value !== 'string' || !cookie.value || /[\r\n\0;]/.test(cookie.value)
          || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) throw new Error('HANDOFF_COOKIE_INVALID');
      return { name: cookie.name, value: cookie.value, domain, path: cookie.path,
        secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
        expires: Number.isFinite(cookie.expires) ? cookie.expires : -1 };
    });
    if (!cookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID')) throw new Error('HANDOFF_AUTH_COOKIE_MISSING');
    const stored = { version: 1, origin, cookies, capturedAt: new Date().toISOString() };
    writeCredential(credentialName, JSON.stringify(stored));
    consumed = true;
    const result = { stored: true, provider: 'Windows DPAPI CurrentUser', origin, cookieCount: cookies.length };
    console.log(JSON.stringify(result));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
    server.close();
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"stored":false,"code":"GEMINI_HANDOFF_REJECTED"}');
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ state: 'waiting_for_encrypted_handoff', port: server.address().port, ...info })));
setTimeout(() => server.close(), 600_000).unref();
