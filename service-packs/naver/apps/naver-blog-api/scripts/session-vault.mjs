import { credentialExists, readCredential, writeCredential } from './secure-credential-store.mjs';

export const NAVER_SESSION_ORIGINS = Object.freeze([
  'https://admin.blog.naver.com', 'https://blog.naver.com', 'https://blog.stat.naver.com',
  // Creator Advisor rotates NID_SES on /api/v6/accounts/channels (2026-10-03); accept and persist that rotation.
  'https://creator-advisor.naver.com',
]);
export const NAVER_SESSION_CREDENTIAL = 'naver-blog-session';
const requiredNaverCookies = ['NID_AUT', 'NID_SES'];
const naverDomain = /^(?:\.)?(?:[a-z0-9-]+\.)*naver\.com$/i;
const cookieName = /^[!#$%&'*+\-.^_|~0-9A-Za-z]+$/;
const cookieValue = /^[\x21-\x3a\x3c-\x7e]*$/;
const xValue = /^[\x21-\x7e]+$/;
const threadsValue = /^[\x21-\x7e]+$/;

export function parseNaverCookieHeader(header) {
  if (typeof header !== 'string' || !header.trim() || /[\r\n]/.test(header)) throw new Error('NAVER_COOKIE_INVALID');
  const cookies = [];
  for (const raw of header.split(';')) {
    const pair = raw.trim();
    const equal = pair.indexOf('=');
    if (equal < 1) continue;
    const name = pair.slice(0, equal).trim();
    const value = pair.slice(equal + 1).trim();
    if (!cookieName.test(name) || !cookieValue.test(value)) throw new Error('NAVER_COOKIE_INVALID');
    cookies.push({ name, value, domain: '.naver.com', path: '/', secure: true, expires: -1, httpOnly: false });
  }
  if (!requiredNaverCookies.every(name => cookies.some(cookie => cookie.name === name && cookie.value))) {
    throw new Error('NAVER_AUTH_COOKIES_MISSING');
  }
  return cookies;
}

function validNaverCookie(cookie) {
  return cookie && typeof cookie.name === 'string' && cookieName.test(cookie.name)
    && typeof cookie.value === 'string' && cookieValue.test(cookie.value)
    && typeof cookie.domain === 'string' && naverDomain.test(cookie.domain)
    && typeof cookie.path === 'string' && cookie.path.startsWith('/') && !/[\x00-\x20\x7f;]/.test(cookie.path)
    && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires);
}

export function normalizeNaverCookies(cookies, now = Date.now(), { requireAuthentication = true } = {}) {
  if (!Array.isArray(cookies) || cookies.length > 1024) throw new Error('NAVER_SESSION_INVALID');
  const normalized = cookies.filter(validNaverCookie).filter(cookie => cookie.expires === -1 || cookie.expires > now / 1000)
    .map(cookie => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain.toLowerCase(), path: cookie.path,
      secure: cookie.secure === true, expires: cookie.expires, httpOnly: cookie.httpOnly === true,
      ...(typeof cookie.sameSite === 'string' ? { sameSite: cookie.sameSite } : {}),
    }));
  if (requireAuthentication && !requiredNaverCookies.every(name => normalized.some(cookie => cookie.name === name && cookie.value))) {
    throw new Error('NAVER_AUTH_COOKIES_MISSING');
  }
  return normalized;
}

function cookieDomainMatches(host, domain) {
  const bare = domain.replace(/^\./, '');
  return host === bare || (domain.startsWith('.') && host.endsWith('.' + bare));
}

export function naverCookieHeaderFor(cookies, rawUrl, now = Date.now()) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('NAVER_SESSION_SCOPE'); }
  if (!NAVER_SESSION_ORIGINS.includes(url.origin) || url.username || url.password) throw new Error('NAVER_SESSION_SCOPE');
  const selected = normalizeNaverCookies(cookies, now).filter(cookie => cookieDomainMatches(url.hostname, cookie.domain)
    && (cookie.expires === -1 || cookie.expires > now / 1000)
    && (url.pathname === cookie.path || (url.pathname.startsWith(cookie.path)
      && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'))))
    .sort((a, b) => b.path.length - a.path.length);
  const header = selected.map(cookie => cookie.name + '=' + cookie.value).join('; ');
  const names = new Set(selected.map(cookie => cookie.name));
  if (!requiredNaverCookies.every(name => names.has(name))) throw new Error('NAVER_AUTH_COOKIES_MISSING');
  return header;
}

function mergeSetCookiesAtUrl(cookies, response, url, now) {
  let updated = normalizeNaverCookies(cookies, now, { requireAuthentication: false });
  let changed = false;
  for (const header of (response.headers.getSetCookie?.() || []).slice(0, 100)) {
    if (header.length > 8192 || /[\r\n]/.test(header)) continue;
    const [pair, ...attributes] = header.split(';');
    const equal = pair.indexOf('=');
    if (equal < 1) continue;
    const lastSlash = url.pathname.lastIndexOf('/');
    const cookie = {
      name: pair.slice(0, equal).trim(), value: pair.slice(equal + 1).trim(), domain: url.hostname,
      path: lastSlash > 0 ? url.pathname.slice(0, lastSlash) : '/', secure: false, expires: -1, httpOnly: false,
    };
    let maxAge = null;
    for (const attribute of attributes) {
      const index = attribute.indexOf('=');
      const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const value = index < 0 ? '' : attribute.slice(index + 1).trim();
      if (key === 'domain') cookie.domain = '.' + value.toLowerCase().replace(/^\./, '');
      if (key === 'path' && value.startsWith('/')) cookie.path = value;
      if (key === 'secure') cookie.secure = true;
      if (key === 'httponly') cookie.httpOnly = true;
      if (key === 'samesite') cookie.sameSite = value;
      if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value) / 1000;
      if (key === 'max-age' && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) maxAge = Number(value);
    }
    if (maxAge !== null) cookie.expires = maxAge <= 0 ? 0 : now / 1000 + maxAge;
    if (cookie.name.startsWith('__Secure-') && !cookie.secure) continue;
    if (cookie.name.startsWith('__Host-') && (!cookie.secure || cookie.path !== '/' || cookie.domain.startsWith('.'))) continue;
    if (!validNaverCookie(cookie) || !cookieDomainMatches(url.hostname, cookie.domain)) continue;
    const same = current => current.name === cookie.name && current.domain === cookie.domain && current.path === cookie.path;
    const existing = updated.find(same);
    if (cookie.expires === 0) {
      if (existing) { updated = updated.filter(current => !same(current)); changed = true; }
      continue;
    }
    if (!existing || existing.value !== cookie.value || existing.expires !== cookie.expires
      || existing.secure !== cookie.secure || existing.httpOnly !== cookie.httpOnly) changed = true;
    updated = updated.filter(current => !same(current));
    if ((cookie.expires === -1 || cookie.expires > now / 1000) && updated.length < 1024) updated.push(cookie);
  }
  return { cookies: normalizeNaverCookies(updated, now, { requireAuthentication: false }), changed };
}

function approvedUrl(rawUrl, origins) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('NAVER_SESSION_SCOPE'); }
  if (!origins.includes(url.origin) || url.username || url.password) throw new Error('NAVER_SESSION_SCOPE');
  return url;
}

export function mergeNaverSetCookies(cookies, response, rawUrl, now = Date.now()) {
  return mergeSetCookiesAtUrl(cookies, response, approvedUrl(rawUrl, NAVER_SESSION_ORIGINS), now);
}

// Login responses use nid.naver.com, while normal session requests remain scoped
// to NAVER_SESSION_ORIGINS. Keep this exact-origin path separate so accepting a
// login cookie rotation never widens the HTTP session's request destinations.
export function mergeNaverLoginSetCookies(cookies, response, rawUrl, now = Date.now()) {
  return mergeSetCookiesAtUrl(cookies, response, approvedUrl(rawUrl, ['https://nid.naver.com']), now);
}

export function normalizeNaverUserAgent(userAgent) {
  if (userAgent == null) return null;
  if (typeof userAgent !== 'string' || !userAgent.trim() || userAgent.length > 512
    || /[^\x20-\x7e]/.test(userAgent)) throw new Error('NAVER_SESSION_USER_AGENT_INVALID');
  return userAgent;
}

export async function storeNaverCookies(cookies, { allowIncomplete = false, userAgent } = {}) {
  const normalized = normalizeNaverCookies(cookies, Date.now(), { requireAuthentication: !allowIncomplete });
  return writeCredential(NAVER_SESSION_CREDENTIAL, JSON.stringify({ version: 1, cookies: normalized,
    userAgent: normalizeNaverUserAgent(userAgent) }));
}

export async function loadNaverCookies({ env = process.env, now = Date.now(), requireAuthentication = true } = {}) {
  const runtime = env.NAVER_COOKIE || '';
  if (runtime) {
    const cookies = parseNaverCookieHeader(runtime);
    return { cookies, provider: 'runtime_environment', persisted: false };
  }
  const saved = await readCredential(NAVER_SESSION_CREDENTIAL);
  if (!saved) return { cookies: [], provider: null, persisted: false };
  let bundle;
  try { bundle = JSON.parse(saved); } catch { throw new Error('NAVER_SESSION_INVALID'); }
  if (bundle?.version !== 1) throw new Error('NAVER_SESSION_INVALID');
  return { cookies: normalizeNaverCookies(bundle.cookies, now, { requireAuthentication }), userAgent: normalizeNaverUserAgent(bundle.userAgent),
    provider: 'windows_dpapi_current_user', persisted: true };
}

// Return only safe storage metadata. The credential string and cookie values stay
// in memory and are never included in this object.
export async function inspectNaverSessionStore({ now = Date.now() } = {}) {
  const provider = 'windows_dpapi_current_user';
  let stored;
  try { stored = credentialExists(NAVER_SESSION_CREDENTIAL); }
  catch (error) {
    return { provider: null, stored: null, usable: false, authCookieState: 'unknown',
      cookieCount: null, liveCookieCount: null, expiredCookieCount: null, userAgentPresent: false,
      code: safeStoreCode(error) };
  }
  if (!stored) return { provider: null, stored: false, usable: false, authCookieState: 'missing',
    cookieCount: 0, liveCookieCount: 0, expiredCookieCount: 0, userAgentPresent: false,
    code: 'NAVER_AUTH_COOKIES_MISSING' };

  let saved;
  try { saved = await readCredential(NAVER_SESSION_CREDENTIAL); }
  catch (error) {
    return { provider, stored: true, usable: false, authCookieState: 'unknown',
      cookieCount: null, liveCookieCount: null, expiredCookieCount: null, userAgentPresent: false,
      code: safeStoreCode(error) };
  }
  if (!saved) return { provider, stored: true, usable: false, authCookieState: 'invalid',
    cookieCount: 0, liveCookieCount: 0, expiredCookieCount: 0, userAgentPresent: false,
    code: 'NAVER_SESSION_INVALID' };

  let bundle;
  try { bundle = JSON.parse(saved); }
  catch { return { provider, stored: true, usable: false, authCookieState: 'invalid',
    cookieCount: null, liveCookieCount: null, expiredCookieCount: null, userAgentPresent: false,
    code: 'NAVER_SESSION_INVALID' }; }
  if (bundle?.version !== 1 || !Array.isArray(bundle.cookies) || bundle.cookies.length > 1024) {
    return { provider, stored: true, usable: false, authCookieState: 'invalid',
      cookieCount: Array.isArray(bundle?.cookies) ? bundle.cookies.length : null,
      liveCookieCount: null, expiredCookieCount: null, userAgentPresent: false,
      code: 'NAVER_SESSION_INVALID' };
  }

  const rawCookies = bundle.cookies;
  const rawAuth = new Map(requiredNaverCookies.map(name => [name, rawCookies.filter(cookie =>
    cookie?.name === name && typeof cookie.value === 'string' && cookie.value.length > 0)]));
  const nowSeconds = now / 1000;
  const expiredAuth = requiredNaverCookies.some(name => rawAuth.get(name).some(cookie =>
    typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) && cookie.expires !== -1
      && cookie.expires <= nowSeconds));
  let cookies;
  try { cookies = normalizeNaverCookies(rawCookies, now, { requireAuthentication: false }); }
  catch { return { provider, stored: true, usable: false, authCookieState: 'invalid',
    cookieCount: rawCookies.length, liveCookieCount: null, expiredCookieCount: null,
    userAgentPresent: false, code: 'NAVER_SESSION_INVALID' }; }
  const authCookiesPresent = requiredNaverCookies.every(name => cookies.some(cookie => cookie.name === name && cookie.value));
  const authCookieState = authCookiesPresent ? 'present'
    : requiredNaverCookies.some(name => rawAuth.get(name).length === 0) ? 'missing'
      : expiredAuth ? 'expired' : 'invalid';
  const expiredCookieCount = rawCookies.filter(cookie => cookie && typeof cookie.expires === 'number'
    && Number.isFinite(cookie.expires) && cookie.expires !== -1 && cookie.expires <= nowSeconds).length;
  return { provider, stored: true, usable: authCookiesPresent, authCookiesPresent, authCookieState,
    cookieCount: rawCookies.length, liveCookieCount: cookies.length, expiredCookieCount,
    userAgentPresent: typeof bundle.userAgent === 'string' && bundle.userAgent.length > 0,
    code: authCookiesPresent ? null : authCookieState === 'expired' ? 'NAVER_AUTH_COOKIES_EXPIRED'
      : authCookieState === 'missing' ? 'NAVER_AUTH_COOKIES_MISSING' : 'NAVER_SESSION_INVALID' };
}

function safeStoreCode(error) {
  const value = error?.code || error?.message || '';
  return /^[A-Z_]+$/.test(value) ? value : 'CREDENTIAL_STORE_UNREADABLE';
}

// The independent publisher passes cookies only through process memory. After
// its owner read succeeds, merge that verified runtime jar into the same DPAPI
// store without discarding unrelated Naver cookies saved by the login flow.
export async function persistNaverVerifiedSession(cookies, observedResponses = []) {
  const runtime = normalizeNaverCookies(cookies);
  if (!Array.isArray(observedResponses) || observedResponses.length > 16) throw Error('NAVER_SESSION_INVALID');
  const saved = await loadNaverCookies({ env: {}, requireAuthentication: false });
  let merged = saved.cookies;
  for (const item of observedResponses) {
    if (!item?.response || typeof item.rawUrl !== 'string') throw Error('NAVER_SESSION_INVALID');
    merged = mergeNaverSetCookies(merged, item.response, item.rawUrl).cookies;
  }
  const key = cookie => `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
  const existing = new Map(merged.map(cookie => [key(cookie), cookie]));
  const overlay = runtime.map(cookie => {
    const previous = existing.get(key(cookie));
    return previous?.value === cookie.value ? previous : cookie;
  });
  const runtimeKeys = new Set(runtime.map(key));
  merged = merged.filter(cookie => !runtimeKeys.has(key(cookie)) && !requiredNaverCookies.includes(cookie.name));
  const next = normalizeNaverCookies([...merged, ...overlay]);
  const ordered = list => [...list].sort((a, b) => key(a).localeCompare(key(b)));
  if (JSON.stringify(ordered(next)) === JSON.stringify(ordered(saved.cookies)))
    return { stored: false, unchanged: true };
  return storeNaverCookies(next, { userAgent: saved.userAgent });
}

// Called only after the publisher has verified the owner. The response itself
// is observed and origin checked by mergeNaverSetCookies; no cookie is logged.
export async function persistNaverObservedResponse(response, rawUrl) {
  const saved = await loadNaverCookies({ env: {}, requireAuthentication: false });
  const update = mergeNaverSetCookies(saved.cookies, response, rawUrl);
  if (!update.changed) return { stored: false, changed: false };
  await storeNaverCookies(update.cookies, { userAgent: saved.userAgent });
  return { stored: true, changed: true };
}

export async function storeXSession(session) {
  if (!session || typeof session.authToken !== 'string' || typeof session.csrfToken !== 'string'
    || !xValue.test(session.authToken) || !xValue.test(session.csrfToken)
    || session.authToken.length > 4096 || session.csrfToken.length > 4096 || /[;\r\n]/.test(session.authToken + session.csrfToken)) {
    throw new Error('X_SESSION_INVALID');
  }
  return writeCredential('x-session', JSON.stringify({ version: 1, authToken: session.authToken, csrfToken: session.csrfToken }));
}

export async function loadXSession({ env = process.env } = {}) {
  const authToken = env.X_AUTH_TOKEN || '';
  const csrfToken = env.X_CSRF_TOKEN || '';
  if (authToken || csrfToken) {
    if (!authToken || !csrfToken) throw new Error('X_SESSION_INVALID');
    const session = { authToken, csrfToken };
    await storeXSession(session);
    return { ...session, provider: 'runtime_environment', persisted: true };
  }
  const saved = await readCredential('x-session');
  if (!saved) return null;
  let session;
  try { session = JSON.parse(saved); } catch { throw new Error('X_SESSION_INVALID'); }
  if (session?.version !== 1) throw new Error('X_SESSION_INVALID');
  if (typeof session.authToken !== 'string' || typeof session.csrfToken !== 'string'
    || !xValue.test(session.authToken) || !xValue.test(session.csrfToken)
    || session.authToken.length > 4096 || session.csrfToken.length > 4096 || /[;\r\n]/.test(session.authToken + session.csrfToken)) {
    throw new Error('X_SESSION_INVALID');
  }
  return { authToken: session.authToken, csrfToken: session.csrfToken, provider: 'windows_dpapi_current_user', persisted: true };
}

function validThreadsBundle(session, handle, code, now) {
  if (!session || session.version !== 1 || session.handle !== handle || (session.code || null) !== (code || null)
    || typeof session.referer !== 'string' || typeof session.lsd !== 'string' || !threadsValue.test(session.lsd)
    || session.lsd.length > 4096 || typeof session.csrf !== 'string' || !threadsValue.test(session.csrf)
    || session.csrf.length > 4096 || session.cookie !== 'csrftoken=' + session.csrf
    || !session.site || typeof session.site !== 'object' || Array.isArray(session.site)
    || typeof session.expiresAt !== 'number' || session.expiresAt <= now || session.expiresAt > now + 86400000) return false;
  let url;
  try { url = new URL(session.referer); } catch { return false; }
  const expectedPath = '/@' + handle + (code ? '/post/' + code : '');
  if (url.origin !== 'https://www.threads.com' || url.pathname !== expectedPath || url.search || url.hash || url.username || url.password) return false;
  const contract = session.profileContract;
  return contract == null || (contract.name === 'BarcelonaProfileThreadsTabDirectQuery'
    && typeof contract.docId === 'string' && /^\d+$/.test(contract.docId)
    && contract.variables && typeof contract.variables === 'object' && !Array.isArray(contract.variables));
}

export async function storeThreadsSession(session, { now = Date.now(), ttlMs = 300000 } = {}) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(session?.handle || '')
    || (session.code != null && !/^[A-Za-z0-9_-]{5,30}$/.test(session.code))
    || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86400000) throw new Error('THREADS_SESSION_INVALID');
  const bundle = {
    version: 1, handle: session.handle, code: session.code || null, referer: session.referer,
    lsd: session.lsd, csrf: session.csrf, cookie: session.cookie, site: session.site,
    profileContract: session.profileContract || null, expiresAt: Math.min(session.expiresAt || now + ttlMs, now + ttlMs),
  };
  if (!validThreadsBundle(bundle, bundle.handle, bundle.code, now)) throw new Error('THREADS_SESSION_INVALID');
  return writeCredential('threads-anonymous-session', JSON.stringify(bundle));
}

export async function loadThreadsSession(handle, code = null, { now = Date.now() } = {}) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle || '')
    || (code != null && !/^[A-Za-z0-9_-]{5,30}$/.test(code))) throw new Error('THREADS_SESSION_INVALID');
  if (process.platform !== 'win32') return null;
  const saved = await readCredential('threads-anonymous-session');
  if (!saved) return null;
  let session;
  try { session = JSON.parse(saved); } catch { throw new Error('THREADS_SESSION_INVALID'); }
  if (!validThreadsBundle(session, handle, code, now)) return null;
  return { ...session, reusedSession: true };
}

export async function invalidateThreadsSession() {
  // Replace the protected bundle so a rejected or deleted CSRF token cannot be reused.
  return writeCredential('threads-anonymous-session', JSON.stringify({ version: 0 }));
}
