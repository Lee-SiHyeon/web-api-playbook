import { Cookie, CookieJar } from 'tough-cookie';

export const BLOG_ORIGIN = 'https://i-never-stop-study.tistory.com';

export const ALLOWED_ORIGINS = Object.freeze([
  BLOG_ORIGIN,
  'https://www.tistory.com',
  'https://accounts.kakao.com',
  'https://kauth.kakao.com',
]);

const allowedOriginSet = new Set(ALLOWED_ORIGINS);
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_COOKIES = 1024;
const MAX_SET_COOKIE_HEADERS = 100;
const MAX_SET_COOKIE_LENGTH = 8192;
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookieValuePattern = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const userAgentPattern = /^[\x20-\x7e]{1,512}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateUserAgent(userAgent) {
  if (userAgent == null) return null;
  if (typeof userAgent !== 'string' || !userAgentPattern.test(userAgent) || !userAgent.trim()) {
    throw fail('TISTORY_USER_AGENT_INVALID');
  }
  return userAgent;
}

function scopedUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw fail('TISTORY_SCOPE'); }
  if (!allowedOriginSet.has(url.origin) || url.username || url.password || url.hash) throw fail('TISTORY_SCOPE');
  return url;
}

function allowedCookieDomain(domain) {
  if (typeof domain !== 'string' || !domain) return false;
  const normalized = domain.replace(/^\./, '').toLowerCase();
  return normalized === 'tistory.com' || normalized.endsWith('.tistory.com')
    || normalized === 'kakao.com' || normalized.endsWith('.kakao.com');
}

function domainMatches(host, domain) {
  const normalized = domain.replace(/^\./, '').toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

function normalizeBrowserCookie(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.name !== 'string' || !cookieNamePattern.test(input.name)
    || typeof input.value !== 'string' || input.value.length > MAX_SET_COOKIE_LENGTH || !cookieValuePattern.test(input.value)
    || typeof input.domain !== 'string' || !allowedCookieDomain(input.domain)
    || typeof input.path !== 'string' || !input.path.startsWith('/') || /[\x00-\x20\x7f;]/.test(input.path)
    || typeof input.expires !== 'number' || !Number.isFinite(input.expires)) {
    throw fail('TISTORY_BROWSER_COOKIE_INVALID');
  }
  if (input.expires > 0 && input.expires <= now / 1000) return null;
  const expires = input.expires > 0 ? new Date(input.expires * 1000) : null;
  if (expires && !Number.isFinite(expires.getTime())) throw fail('TISTORY_BROWSER_COOKIE_INVALID');
  const domain = input.domain.replace(/^\./, '').toLowerCase();
  const hostOnly = typeof input.hostOnly === 'boolean' ? input.hostOnly : !input.domain.startsWith('.');
  const sameSite = typeof input.sameSite === 'string' ? input.sameSite.toLowerCase() : undefined;
  if (sameSite != null && !['strict', 'lax', 'none'].includes(sameSite)) throw fail('TISTORY_BROWSER_COOKIE_INVALID');
  return new Cookie({
    key: input.name,
    value: input.value,
    domain,
    path: input.path,
    hostOnly,
    secure: input.secure === true,
    httpOnly: input.httpOnly === true,
    ...(expires ? { expires } : { expires: 'Infinity' }),
    ...(sameSite ? { sameSite } : {}),
  });
}

function validateSerializedJar(serialized) {
  if (!serialized || typeof serialized !== 'object' || Array.isArray(serialized)
    || !Array.isArray(serialized.cookies) || serialized.cookies.length > MAX_COOKIES) {
    throw fail('TISTORY_SESSION_INVALID');
  }
  for (const cookie of serialized.cookies) {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)
      || typeof cookie.key !== 'string' || !cookieNamePattern.test(cookie.key)
      || typeof cookie.value !== 'string' || cookie.value.length > MAX_SET_COOKIE_LENGTH || !cookieValuePattern.test(cookie.value)
      || typeof cookie.domain !== 'string' || !allowedCookieDomain(cookie.domain)
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || /[\x00-\x20\x7f;]/.test(cookie.path)) {
      throw fail('TISTORY_SESSION_INVALID');
    }
  }
}

function safeHeaders(responseHeaders) {
  const output = {};
  for (const [name, value] of responseHeaders) {
    const lower = name.toLowerCase();
    if (['set-cookie', 'cookie', 'authorization', 'proxy-authorization'].includes(lower)) continue;
    output[lower] = value;
  }
  return output;
}

async function readBoundedBody(response, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel().catch(() => {});
        throw fail('TISTORY_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code === 'TISTORY_RESPONSE_TOO_LARGE') throw error;
    if (signal.aborted) throw fail('TISTORY_TIMEOUT');
    throw fail('TISTORY_RESPONSE_READ_FAILED');
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export class ScopedHttpSession {
  #fetchImpl;
  #userAgent;

  constructor({ jar, userAgent, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw fail('TISTORY_FETCH_UNAVAILABLE');
    const activeJar = jar ?? new CookieJar();
    if (!(activeJar instanceof CookieJar) || activeJar.store?.synchronous !== true) throw fail('TISTORY_COOKIE_JAR_INVALID');
    const serialized = activeJar.serializeSync();
    validateSerializedJar(serialized);
    this.jar = activeJar;
    this.#userAgent = validateUserAgent(userAgent);
    this.#fetchImpl = fetchImpl;
  }

  static fromBrowserCookies(cookies, { userAgent, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    if (!Array.isArray(cookies) || cookies.length > MAX_COOKIES || typeof now !== 'function') {
      throw fail('TISTORY_BROWSER_COOKIE_INVALID');
    }
    const session = new ScopedHttpSession({ userAgent, fetchImpl });
    for (const item of cookies) {
      const cookie = normalizeBrowserCookie(item, now());
      if (!cookie) continue;
      const seedHost = cookie.domain;
      if (!allowedOriginSet.has(`https://${seedHost}`) && cookie.hostOnly) {
        // Host-only cookies for other allowed-origin aliases cannot be reused by
        // this session without a matching request origin.
        if (!ALLOWED_ORIGINS.some(origin => new URL(origin).hostname === seedHost)) continue;
      }
      const seedUrl = `https://${seedHost}/`;
      if (!domainMatches(new URL(seedUrl).hostname, cookie.domain)) continue;
      try {
        if (!session.jar.setCookieSync(cookie, seedUrl)) throw fail('TISTORY_BROWSER_COOKIE_INVALID');
      }
      catch { throw fail('TISTORY_BROWSER_COOKIE_INVALID'); }
    }
    return session;
  }

  static fromJSON(value, { fetchImpl = globalThis.fetch } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('jar' in value)) {
      throw fail('TISTORY_SESSION_INVALID');
    }
    validateSerializedJar(value.jar);
    let jar;
    try { jar = CookieJar.deserializeSync(value.jar); }
    catch { throw fail('TISTORY_SESSION_INVALID'); }
    return new ScopedHttpSession({ jar, userAgent: value.userAgent, fetchImpl });
  }

  toJSON() {
    return { jar: this.jar.serializeSync(), userAgent: this.#userAgent };
  }

  cookieMetadata() {
    const serialized = this.jar.serializeSync();
    return {
      count: serialized.cookies.length,
      cookies: serialized.cookies.map(cookie => ({
        name: cookie.key,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        sameSite: cookie.sameSite ?? null,
      })),
    };
  }

  async removeTistoryCookies() {
    const entries = this.jar.serializeSync().cookies.filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return domain === 'tistory.com' || domain.endsWith('.tistory.com');
    });
    for (const cookie of entries) {
      await new Promise((resolve, reject) => {
        this.jar.store.removeCookie(cookie.domain, cookie.path, cookie.key, error => error ? reject(error) : resolve());
      }).catch(() => { throw fail('TISTORY_COOKIE_JAR_INVALID'); });
    }
    return { removed: entries.length };
  }

  async request(rawUrl, { method = 'GET', headers = {}, body, referer } = {}) {
    const url = scopedUrl(rawUrl);
    if (typeof method !== 'string' || !/^[A-Za-z]{3,12}$/.test(method)) throw fail('TISTORY_REQUEST_INVALID');
    const normalizedMethod = method.toUpperCase();
    let requestHeaders;
    try { requestHeaders = new Headers(headers); } catch { throw fail('TISTORY_REQUEST_INVALID'); }
    if (requestHeaders.has('cookie') || requestHeaders.has('proxy-authorization')) throw fail('TISTORY_REQUEST_HEADER_FORBIDDEN');
    if (requestHeaders.has('referer')) scopedUrl(requestHeaders.get('referer'));
    if (referer != null) requestHeaders.set('referer', scopedUrl(referer).href);
    if (body != null && ['GET', 'HEAD'].includes(normalizedMethod)) throw fail('TISTORY_REQUEST_INVALID');
    if (this.#userAgent) requestHeaders.set('user-agent', this.#userAgent);

    let cookieHeader;
    try { cookieHeader = this.jar.getCookieStringSync(url.href); }
    catch { throw fail('TISTORY_COOKIE_JAR_INVALID'); }
    if (cookieHeader) requestHeaders.set('cookie', cookieHeader);

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await this.#fetchImpl(url.href, {
        method: normalizedMethod,
        headers: requestHeaders,
        ...(body == null ? {} : { body }),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fail('TISTORY_TIMEOUT');
      throw fail('TISTORY_TRANSPORT_FAILED');
    }

    if (!response || !Number.isInteger(response.status) || !response.headers) throw fail('TISTORY_RESPONSE_INVALID');
    if (response.url) {
      let responseUrl;
      try { responseUrl = scopedUrl(response.url); } catch { throw fail('TISTORY_REDIRECT_SCOPE'); }
      if (responseUrl.href !== url.href) throw fail('TISTORY_REDIRECT_FOLLOWED');
    }

    const setCookieHeaders = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const header of setCookieHeaders.slice(0, MAX_SET_COOKIE_HEADERS)) {
      if (typeof header !== 'string' || header.length > MAX_SET_COOKIE_LENGTH || /[\r\n]/.test(header)) continue;
      const cookie = Cookie.parse(header);
      if (!cookie || !cookieValuePattern.test(cookie.value)
        || !allowedCookieDomain(cookie.domain || url.hostname)
        || !domainMatches(url.hostname, cookie.domain || url.hostname)) continue;
      try { this.jar.setCookieSync(header, url.href, { ignoreError: true }); }
      catch { throw fail('TISTORY_COOKIE_ROTATION_FAILED'); }
    }

    const raw = await readBoundedBody(response, signal);
    const location = response.headers.get('location');
    return { status: response.status, url: url.href, headers: safeHeaders(response.headers), raw, location };
  }
}
