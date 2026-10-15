import { Cookie, CookieJar } from 'tough-cookie';

const SESSION_VERSION = 1;
const MAX_ORIGINS = 64;
const MAX_COOKIES = 1024;
const MAX_SET_COOKIE_HEADERS = 100;
const MAX_SET_COOKIE_BYTES = 8192;
const MAX_HEADER_COUNT = 128;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const SECRET_HEADER = /(?:cookie|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|session|csrf|xsrf|signature|private[-_]?key)/i;
const FORBIDDEN_HEADER = /^(?:host|content-length|transfer-encoding|connection|proxy-authorization|proxy-authenticate|set-cookie|set-cookie2)$/i;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
// RFC 6265 section 4.1.1 also permits a pair of surrounding DQUOTEs.
// Preserve them on the wire; arbitrary internal quotes or separators stay invalid.
const validCookieValue = value => COOKIE_VALUE.test(value)
  || value.startsWith('"') && value.endsWith('"') && value.length >= 2 && COOKIE_VALUE.test(value.slice(1, -1));
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactOrigin(value, allowLoopbackHttp = false) {
  if (typeof value !== 'string' || value.length > 512) throw fail('SCOPED_SESSION_ORIGIN_INVALID');
  let parsed;
  try { parsed = new URL(value); } catch { throw fail('SCOPED_SESSION_ORIGIN_INVALID'); }
  const localHttp = allowLoopbackHttp && parsed.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.origin !== value || (parsed.protocol !== 'https:' && !localHttp)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw fail('SCOPED_SESSION_ORIGIN_INVALID');
  }
  return value;
}

function allowedOriginList(value, allowLoopbackHttp = false) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ORIGINS) {
    throw fail('SCOPED_SESSION_ORIGINS_INVALID');
  }
  const normalized = value.map(origin => exactOrigin(origin, allowLoopbackHttp));
  if (new Set(normalized).size !== normalized.length) throw fail('SCOPED_SESSION_ORIGINS_INVALID');
  return normalized;
}

function scopedUrl(value, allowed) {
  let parsed;
  try { parsed = new URL(value); } catch { throw fail('SCOPED_SESSION_SCOPE'); }
  if (!allowed.has(parsed.origin) || parsed.username || parsed.password || parsed.hash) {
    throw fail('SCOPED_SESSION_SCOPE');
  }
  return parsed;
}

function headersFromObject(value, { rejectSecrets = false, rejectForbidden = true } = {}) {
  if (value == null) return new Headers();
  const entries = value instanceof Headers ? [...value.entries()] : plainObject(value) ? Object.entries(value) : null;
  if (!entries || entries.length > MAX_HEADER_COUNT) throw fail('SCOPED_SESSION_HEADERS_INVALID');
  let headers;
  try { headers = new Headers(); } catch { throw fail('SCOPED_SESSION_HEADERS_INVALID'); }
  let totalBytes = 0;
  for (const [name, item] of entries) {
    if (typeof item !== 'string' || /[\r\n\0]/.test(item)) throw fail('SCOPED_SESSION_HEADERS_INVALID');
    if (rejectForbidden && FORBIDDEN_HEADER.test(name)) throw fail('SCOPED_SESSION_HEADER_FORBIDDEN');
    if (rejectSecrets && SECRET_HEADER.test(name)) throw fail('SCOPED_SESSION_SECRET_HEADER_REQUIRES_ORIGIN_SCOPE');
    totalBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(item, 'utf8');
    if (totalBytes > MAX_HEADER_BYTES) throw fail('SCOPED_SESSION_HEADERS_TOO_LARGE');
    try { headers.set(name, item); } catch { throw fail('SCOPED_SESSION_HEADERS_INVALID'); }
  }
  return headers;
}

function serializeHeaders(headers) {
  return Object.fromEntries(headers.entries());
}

function normalizeCookieOrigins(value, allowed, allowLoopbackHttp = false) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ORIGINS) throw fail('SCOPED_SESSION_COOKIE_SCOPE_INVALID');
  const origins = value.map(origin => exactOrigin(origin, allowLoopbackHttp));
  if (new Set(origins).size !== origins.length) throw fail('SCOPED_SESSION_COOKIE_SCOPE_INVALID');
  if (origins.some(origin => !allowed.has(origin))) throw fail('SCOPED_SESSION_COOKIE_SCOPE_INVALID');
  return origins;
}

function validCookieJar(jar, cookieOrigins) {
  if (!(jar instanceof CookieJar) || jar.store?.synchronous !== true) {
    throw fail('SCOPED_SESSION_COOKIE_JAR_INVALID');
  }
  let serialized;
  try { serialized = jar.serializeSync(); } catch { throw fail('SCOPED_SESSION_COOKIE_JAR_INVALID'); }
  if (!Array.isArray(serialized.cookies) || serialized.cookies.length > MAX_COOKIES) {
    throw fail('SCOPED_SESSION_COOKIE_JAR_INVALID');
  }
  const hosts = cookieOrigins.map(origin => new URL(origin).hostname.toLowerCase());
  for (const cookie of serialized.cookies) {
    // tough-cookie leaves the value out of the serialized form when it is empty (YouTube sets __Secure-YEC= , 2026-09-28).
    if (cookie && cookie.value === undefined) cookie.value = '';
    if (!cookie || typeof cookie.key !== 'string' || typeof cookie.value !== 'string'
      || cookie.value.length > MAX_SET_COOKIE_BYTES || /[\r\n\0]/.test(cookie.value)
      || typeof cookie.domain !== 'string' || !cookie.domain || typeof cookie.path !== 'string'
      || !cookie.path.startsWith('/')) throw fail('SCOPED_SESSION_COOKIE_JAR_INVALID');
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    if (!hosts.some(host => host === domain || host.endsWith(`.${domain}`))) {
      throw fail('SCOPED_SESSION_COOKIE_SCOPE_INVALID');
    }
  }
  return serialized;
}

function seedBrowserCookie(jar, input, cookieOrigins) {
  if (!plainObject(input) || typeof input.name !== 'string' || !COOKIE_NAME.test(input.name)
    || typeof input.value !== 'string' || input.value.length > MAX_SET_COOKIE_BYTES || !validCookieValue(input.value)
    || typeof input.domain !== 'string' || !input.domain || typeof input.path !== 'string' || !input.path.startsWith('/')
    || /[\x00-\x20\x7f;]/.test(input.path)
    || input.hostOnly != null && typeof input.hostOnly !== 'boolean'
    || input.secure != null && typeof input.secure !== 'boolean'
    || input.httpOnly != null && typeof input.httpOnly !== 'boolean'
    || input.sameSite != null && typeof input.sameSite !== 'string') throw fail('SCOPED_SESSION_COOKIES_INVALID');
  const domain = input.domain.replace(/^\./, '').toLowerCase();
  const hostOnly = typeof input.hostOnly === 'boolean' ? input.hostOnly : !input.domain.startsWith('.');
  const origin = cookieOrigins.find(candidate => {
    const host = new URL(candidate).hostname.toLowerCase();
    return hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
  });
  if (!origin) throw fail('SCOPED_SESSION_COOKIE_SCOPE_INVALID');
  const expiresValue = input.expires ?? input.expirationDate;
  if (expiresValue != null && (typeof expiresValue !== 'number' || !Number.isFinite(expiresValue))) {
    throw fail('SCOPED_SESSION_COOKIES_INVALID');
  }
  if (expiresValue > 0 && expiresValue <= Date.now() / 1000) return;
  const expires = expiresValue > 0 ? new Date(expiresValue * 1000) : 'Infinity';
  if (expires instanceof Date && !Number.isFinite(expires.getTime())) throw fail('SCOPED_SESSION_COOKIES_INVALID');
  let sameSite = typeof input.sameSite === 'string' ? input.sameSite.toLowerCase() : null;
  if (sameSite === 'no_restriction') sameSite = 'none';
  if (sameSite === 'unspecified') sameSite = null;
  if (sameSite != null && !['strict', 'lax', 'none'].includes(sameSite)) throw fail('SCOPED_SESSION_COOKIES_INVALID');
  try {
    const cookie = new Cookie({
      key: input.name,
      value: input.value,
      domain,
      path: input.path,
      hostOnly,
      secure: input.secure === true,
      httpOnly: input.httpOnly === true,
      expires,
      ...(sameSite ? { sameSite } : {}),
    });
    if (!jar.setCookieSync(cookie, `${origin}/`)) throw fail('SCOPED_SESSION_COOKIES_INVALID');
  } catch { throw fail('SCOPED_SESSION_COOKIES_INVALID'); }
}

function normalizeOriginHeaders(value, allowed, allowLoopbackHttp = false) {
  if (value == null) return {};
  if (!plainObject(value)) throw fail('SCOPED_SESSION_HEADERS_INVALID');
  const output = {};
  for (const [rawOrigin, rawHeaders] of Object.entries(value)) {
    const origin = exactOrigin(rawOrigin, allowLoopbackHttp);
    if (!allowed.has(origin)) throw fail('SCOPED_SESSION_HEADER_SCOPE_INVALID');
    output[origin] = serializeHeaders(headersFromObject(rawHeaders));
  }
  return output;
}

function normalizedBodyBytes(body) {
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString(), 'utf8');
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  throw fail('SCOPED_SESSION_BODY_TYPE_UNSUPPORTED');
}

function sensitiveResponseHeader(name) {
  return SECRET_HEADER.test(name) || /^(?:set-cookie2?|www-authenticate|proxy-authenticate|location)$/i.test(name);
}

function safeResponseHeaders(headers) {
  const output = {};
  let totalBytes = 0;
  for (const [name, value] of headers) {
    if (!sensitiveResponseHeader(name)) {
      totalBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8');
      if (Object.keys(output).length >= MAX_HEADER_COUNT || totalBytes > MAX_HEADER_BYTES) {
        throw fail('SCOPED_SESSION_HEADERS_TOO_LARGE');
      }
      output[name.toLowerCase()] = value;
    }
  }
  return output;
}

function setCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const joined = headers.get('set-cookie');
  if (!joined) return [];
  if (/,[ \t]*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/.test(joined)) throw fail('SCOPED_SESSION_COOKIE_HEADERS_UNSUPPORTED');
  return [joined];
}

async function boundedResponseText(response, limit, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw fail('SCOPED_SESSION_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code === 'SCOPED_SESSION_RESPONSE_TOO_LARGE') throw error;
    if (signal.aborted) throw fail('SCOPED_SESSION_TIMEOUT');
    throw fail('SCOPED_SESSION_RESPONSE_READ_FAILED');
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function validateLimits(options) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  const maxRequestBytes = options.maxRequestBytes ?? 4 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 8;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_BODY_BYTES
    || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > MAX_BODY_BYTES
    || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw fail('SCOPED_SESSION_LIMITS_INVALID');
  }
  return { timeoutMs, maxResponseBytes, maxRequestBytes, maxRedirects };
}

export class ScopedSession {
  #allowedOrigins;
  #cookieOrigins;
  #allowLoopbackHttp;
  #defaultHeaders;
  #headersByOrigin;
  #jar;
  #fetchImpl;
  #limits;
  #retainExpiredCookieEvidence = false;

  constructor(options = {}) {
    if (!plainObject(options)) throw fail('SCOPED_SESSION_OPTIONS_INVALID');
    const allowLoopbackHttp = options.allowLoopbackHttp === true;
    if (options.allowLoopbackHttp != null && typeof options.allowLoopbackHttp !== 'boolean') {
      throw fail('SCOPED_SESSION_OPTIONS_INVALID');
    }
    const origins = allowedOriginList(options.allowedOrigins, allowLoopbackHttp);
    this.#allowedOrigins = new Set(origins);
    this.#allowLoopbackHttp = allowLoopbackHttp;
    this.#cookieOrigins = new Set(normalizeCookieOrigins(options.cookieOrigins, this.#allowedOrigins, allowLoopbackHttp));
    this.#defaultHeaders = headersFromObject(options.defaultHeaders, { rejectSecrets: true });
    this.#headersByOrigin = normalizeOriginHeaders(options.headersByOrigin, this.#allowedOrigins, allowLoopbackHttp);
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetchImpl !== 'function') throw fail('SCOPED_SESSION_FETCH_UNAVAILABLE');
    this.#limits = validateLimits(options);
    this.#jar = new CookieJar();
    const cookieSeeds = options.cookies ?? [];
    if (!Array.isArray(cookieSeeds) || cookieSeeds.length > MAX_COOKIES) throw fail('SCOPED_SESSION_COOKIES_INVALID');
    for (const seed of cookieSeeds) {
      if (plainObject(seed) && typeof seed.url === 'string' && typeof seed.setCookie === 'string') {
        if (seed.setCookie.length > MAX_SET_COOKIE_BYTES || /[\r\n\0]/.test(seed.setCookie)) {
          throw fail('SCOPED_SESSION_COOKIES_INVALID');
        }
        const url = scopedUrl(seed.url, this.#allowedOrigins);
        if (!this.#cookieOrigins.has(url.origin)) throw fail('SCOPED_SESSION_COOKIE_SCOPE_INVALID');
        try {
          const parsed = Cookie.parse(seed.setCookie);
          if (!parsed || !this.#jar.setCookieSync(seed.setCookie, url.href)) throw fail('SCOPED_SESSION_COOKIES_INVALID');
        } catch { throw fail('SCOPED_SESSION_COOKIES_INVALID'); }
      } else {
        seedBrowserCookie(this.#jar, seed, [...this.#cookieOrigins]);
      }
    }
    validCookieJar(this.#jar, [...this.#cookieOrigins]);
  }

  static fromJSON(value, options = {}) {
    if (!plainObject(value) || value.version !== SESSION_VERSION || !Array.isArray(value.allowedOrigins)
      || !Array.isArray(value.cookieOrigins) || !plainObject(value.cookieJar)) {
      throw fail('SCOPED_SESSION_STATE_INVALID');
    }
    if (typeof value.allowLoopbackHttp !== 'boolean') throw fail('SCOPED_SESSION_STATE_INVALID');
    const allowedOrigins = allowedOriginList(value.allowedOrigins, value.allowLoopbackHttp);
    const allowed = new Set(allowedOrigins);
    const cookieOrigins = normalizeCookieOrigins(value.cookieOrigins, allowed, value.allowLoopbackHttp);
    let jar;
    try { jar = CookieJar.deserializeSync(value.cookieJar); } catch { throw fail('SCOPED_SESSION_STATE_INVALID'); }
    validCookieJar(jar, cookieOrigins);
    const headersByOrigin = normalizeOriginHeaders(value.headersByOrigin, allowed, value.allowLoopbackHttp);
    const session = new ScopedSession({
      allowedOrigins,
      cookieOrigins,
      allowLoopbackHttp: value.allowLoopbackHttp,
      defaultHeaders: value.defaultHeaders,
      headersByOrigin,
      timeoutMs: value.timeoutMs,
      maxResponseBytes: value.maxResponseBytes,
      maxRequestBytes: value.maxRequestBytes,
      maxRedirects: value.maxRedirects,
      fetchImpl: options.fetchImpl,
    });
    session.#jar = jar;
    return session;
  }

  toJSON() {
    return {
      version: SESSION_VERSION,
      allowedOrigins: [...this.#allowedOrigins],
      cookieOrigins: [...this.#cookieOrigins],
      allowLoopbackHttp: this.#allowLoopbackHttp,
      defaultHeaders: serializeHeaders(this.#defaultHeaders),
      headersByOrigin: structuredClone(this.#headersByOrigin),
      cookieJar: this.#jar.serializeSync(),
      timeoutMs: this.#limits.timeoutMs,
      maxResponseBytes: this.#limits.maxResponseBytes,
      maxRequestBytes: this.#limits.maxRequestBytes,
      maxRedirects: this.#limits.maxRedirects,
    };
  }

  // An owner binding can attest the stored cookie snapshot. Preserve that
  // evidence without sending expired cookies; response cookies still update
  // the original jar and remain subject to the service's binding checks.
  retainExpiredCookieEvidence() {
    this.#retainExpiredCookieEvidence = true;
    return this;
  }

  async request(rawUrl, init = {}) {
    if (!plainObject(init)) throw fail('SCOPED_SESSION_REQUEST_INVALID');
    if (init.onCookiesApplied !== undefined && typeof init.onCookiesApplied !== 'function') {
      throw fail('SCOPED_SESSION_REQUEST_INVALID');
    }
    const methodPattern = /^[A-Za-z]{1,20}$/;
    let method = init.method ?? 'GET';
    if (typeof method !== 'string' || !methodPattern.test(method)) throw fail('SCOPED_SESSION_REQUEST_INVALID');
    method = method.toUpperCase();
    let url = scopedUrl(rawUrl, this.#allowedOrigins);
    let body = init.body ?? null;
    let stripBodyHeaders = false;
    if (body !== null && ['GET', 'HEAD'].includes(method)) throw fail('SCOPED_SESSION_REQUEST_INVALID');
    if (normalizedBodyBytes(body) > this.#limits.maxRequestBytes) throw fail('SCOPED_SESSION_REQUEST_TOO_LARGE');
    const requestHeaders = headersFromObject(init.headers);
    if (requestHeaders.has('cookie') || requestHeaders.has('authorization')
      || [...requestHeaders.keys()].some(name => SECRET_HEADER.test(name) || FORBIDDEN_HEADER.test(name))) {
      throw fail('SCOPED_SESSION_SECRET_HEADER_REQUIRES_ORIGIN_SCOPE');
    }
    const signal = AbortSignal.timeout(this.#limits.timeoutMs);
    for (let redirectCount = 0; ; redirectCount += 1) {
      const headers = new Headers(this.#defaultHeaders);
      const scopedHeaders = this.#headersByOrigin[url.origin];
      if (scopedHeaders) for (const [name, value] of new Headers(scopedHeaders)) headers.set(name, value);
      for (const [name, value] of requestHeaders) headers.set(name, value);
      if (stripBodyHeaders) {
        for (const header of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding']) headers.delete(header);
      }
      if (this.#cookieOrigins.has(url.origin)) {
        let cookieHeader;
        try {
          const requestJar = this.#retainExpiredCookieEvidence
            ? CookieJar.deserializeSync(this.#jar.serializeSync())
            : this.#jar;
          cookieHeader = requestJar.getCookieStringSync(url.href);
        } catch { throw fail('SCOPED_SESSION_COOKIE_JAR_INVALID'); }
        if (cookieHeader) headers.set('cookie', cookieHeader);
      }

      let response;
      try {
        response = await this.#fetchImpl(url.href, {
          method,
          headers,
          ...(body === null ? {} : { body }),
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fail('SCOPED_SESSION_TIMEOUT');
        throw fail('SCOPED_SESSION_TRANSPORT_FAILED');
      }
      if (!response || !Number.isInteger(response.status) || !response.headers
        || typeof response.headers.get !== 'function' || typeof response.headers[Symbol.iterator] !== 'function') {
        throw fail('SCOPED_SESSION_RESPONSE_INVALID');
      }
      if (response.url) {
        let responseUrl;
        try { responseUrl = scopedUrl(response.url, this.#allowedOrigins); } catch { throw fail('SCOPED_SESSION_REDIRECT_SCOPE'); }
        if (responseUrl.href !== url.href) throw fail('SCOPED_SESSION_REDIRECT_AUTO_FOLLOWED');
      }

      if (this.#cookieOrigins.has(url.origin)) {
        let setCookies;
        try { setCookies = setCookieValues(response.headers); } catch { throw fail('SCOPED_SESSION_COOKIE_ROTATION_FAILED'); }
        if (setCookies.length > MAX_SET_COOKIE_HEADERS) throw fail('SCOPED_SESSION_COOKIE_ROTATION_FAILED');
        const appliedCookies = [];
        for (const setCookie of setCookies) {
          if (typeof setCookie !== 'string' || setCookie.length > MAX_SET_COOKIE_BYTES || /[\r\n\0]/.test(setCookie)) {
            throw fail('SCOPED_SESSION_COOKIE_ROTATION_FAILED');
          }
          try {
            const cookie = this.#jar.setCookieSync(setCookie, url.href);
            if (init.onCookiesApplied && cookie) appliedCookies.push(cookie.toJSON());
          }
          catch { throw fail('SCOPED_SESSION_COOKIE_ROTATION_FAILED'); }
        }
        validCookieJar(this.#jar, [...this.#cookieOrigins]);
        // Transient service-internal evidence; never expose Set-Cookie values
        // in the public response headers or serialize this callback.
        init.onCookiesApplied?.({ origin: url.origin, path: url.pathname,
          status: response.status, cookies: appliedCookies });
      }

      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location');
        if (location) {
          if ((response.status === 307 || response.status === 308) && !['GET', 'HEAD'].includes(method)) {
            await response.body?.cancel().catch(() => {});
            throw fail('SCOPED_SESSION_WRITE_REDIRECT_BLOCKED');
          }
          if (redirectCount >= this.#limits.maxRedirects) {
            await response.body?.cancel().catch(() => {});
            throw fail('SCOPED_SESSION_REDIRECT_LIMIT');
          }
          let nextUrl;
          try { nextUrl = scopedUrl(new URL(location, url).href, this.#allowedOrigins); }
          catch {
            await response.body?.cancel().catch(() => {});
            throw fail('SCOPED_SESSION_REDIRECT_SCOPE');
          }
          if (response.body) await response.body.cancel().catch(() => {});
          const switchToGet = response.status === 303 && method !== 'HEAD'
            || (response.status === 301 || response.status === 302) && method === 'POST';
          if (switchToGet) {
            method = 'GET';
            body = null;
            stripBodyHeaders = true;
            for (const header of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding']) requestHeaders.delete(header);
          }
          if (nextUrl.origin !== url.origin) {
            requestHeaders.delete('origin');
            requestHeaders.delete('referer');
          }
          url = nextUrl;
          continue;
        }
      }

      const raw = await boundedResponseText(response, this.#limits.maxResponseBytes, signal);
      return { status: response.status, headers: safeResponseHeaders(response.headers), raw };
    }
  }
}

export const scopedSessionContract = Object.freeze({
  node: '>=24',
  dependency: 'tough-cookie@5.1.2',
  secrets: 'toJSON() contains cookies and origin-scoped headers; persist only with ProtectedStore and never log it',
  redirects: 'manual, bounded, and exact-origin checked before every hop',
  retries: 'none',
});
