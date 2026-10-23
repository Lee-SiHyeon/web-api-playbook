import { createECDH, createHash, createCipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const loginOrigin = 'https://nid.naver.com';
const loginUrl = `${loginOrigin}/nidlogin.login?mode=form&url=${encodeURIComponent('https://admin.blog.naver.com/aicandoanything')}`;
const maxBody = 1024 * 1024;

async function boundedText(response) {
  if (!response.body) throw new Error('LOGIN_BOOTSTRAP_BODY_MISSING');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBody) throw new Error('LOGIN_BOOTSTRAP_SIZE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function attribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return (match?.[1] ?? match?.[2] ?? '').replaceAll('&amp;', '&');
}

function inputByName(html, name) {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    if (attribute(match[0], 'id') === name || attribute(match[0], 'name') === name) return match[0];
  }
  return null;
}

function sameOriginCookies(response) {
  const pairs = [];
  for (const header of response.headers.getSetCookie?.() || []) {
    if (header.length > 8192 || /[\r\n]/.test(header)) continue;
    const pair = header.split(';', 1)[0];
    if (/^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/.test(pair)) pairs.push(pair);
  }
  return pairs.join('; ');
}

export async function observeLoginBootstrap({ fetchImpl = globalThis.fetch } = {}) {
  const page = await fetchImpl(loginUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { accept: 'text/html' } });
  const pageMime = page.headers.get('content-type') || '';
  if (page.status !== 200 || !/^text\/html(?:\s*;|$)/i.test(pageMime)) throw new Error('LOGIN_BOOTSTRAP_PAGE_REJECTED');
  const html = await boundedText(page);
  const form = [...html.matchAll(/<form\b[^>]*>/gi)].find(match => attribute(match[0], 'id') === 'frmNIDLogin')?.[0];
  const action = form && attribute(form, 'action');
  if (action !== `${loginOrigin}/nidlogin.login`) throw new Error('LOGIN_BOOTSTRAP_FORM_CHANGED');
  const dynamicKey = attribute(inputByName(html, 'dynamicKey') || '', 'value');
  if (!dynamicKey || dynamicKey.length > 512 || /[\r\n]/.test(dynamicKey)) throw new Error('LOGIN_BOOTSTRAP_KEY_MISSING');
  const keyUrl = `${loginOrigin}/login/dynamicEcKey/${encodeURIComponent(dynamicKey)}`;
  const keyResponse = await fetchImpl(keyUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { accept: 'text/plain,*/*;q=0.1', 'x-requested-with': 'XMLHttpRequest',
      ...(sameOriginCookies(page) ? { cookie: sameOriginCookies(page) } : {}) } });
  if (keyResponse.status !== 200) throw new Error('LOGIN_BOOTSTRAP_KEY_REJECTED');
  const parts = (await boundedText(keyResponse)).trim().split(',');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 512 || !/^04[0-9a-f]{128}$/i.test(parts[1])) {
    throw new Error('LOGIN_BOOTSTRAP_KEY_SCHEMA');
  }
  return {
    // Values remain in memory for a single login attempt; never log or persist this object.
    sessionKey: parts[0], serverPublicKey: parts[1],
    receipt: { actor: 'aicandoanything', pagePath: '/nidlogin.login', keyPath: '/login/dynamicEcKey/{dynamicKey}',
      pageStatus: page.status, keyStatus: keyResponse.status, formActionObserved: true,
      p256PublicKeyObserved: true, executionMode: 'pure_http', loginSubmitted: false,
      verificationTokenProvider: 'unverified_for_browserless_execution' },
  };
}

// Matches the observed public login script's P-256 ECDH → SHA-256 → AES-CBC form encoding.
// This prepares a one-time form field; it does not produce Naver's separate wtoken.
export function encryptLoginFields({ serverPublicKey, sessionKey, username, password }) {
  if (!/^04[0-9a-f]{128}$/i.test(serverPublicKey || '') || typeof sessionKey !== 'string' || !sessionKey
    || typeof username !== 'string' || !username || typeof password !== 'string' || !password
    || [sessionKey, username, password].some(value => value.length > 255 || /[\r\n\0]/.test(value))) {
    throw new Error('LOGIN_FIELDS_INVALID');
  }
  const ecdh = createECDH('prime256v1');
  const clientPublicKey = ecdh.generateKeys('hex', 'uncompressed');
  const shared = ecdh.computeSecret(Buffer.from(serverPublicKey, 'hex'));
  const aesKey = createHash('sha256').update(shared.toString('hex')).digest();
  const iv = randomBytes(16);
  const field = value => String.fromCharCode(value.length) + value;
  const plaintext = Buffer.from(field(sessionKey) + field(username) + field(password), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `${encrypted.toString('base64')},${iv.toString('base64')},${clientPublicKey},${sessionKey}`;
  } finally {
    shared.fill(0); aesKey.fill(0); plaintext.fill(0);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  observeLoginBootstrap().then(({ receipt }) => console.log(JSON.stringify(receipt))).catch(error => {
    console.error(/^[A-Z_]+$/.test(error?.message || '') ? error.message : 'LOGIN_BOOTSTRAP_FAILED');
    process.exitCode = 2;
  });
}
