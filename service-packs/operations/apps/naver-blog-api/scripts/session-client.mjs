import { createHash } from 'node:crypto';
import { ApiError, BLOG_ID, read, resolveRequest } from './client.mjs';
import { mergeNaverSetCookies, storeNaverCookies } from './session-vault.mjs';

export const SESSION_ORIGINS = Object.freeze([
  'https://admin.blog.naver.com', 'https://blog.naver.com', 'https://blog.stat.naver.com',
]);
export const PROTECTED_ROOT = `https://admin.blog.naver.com/${BLOG_ID}`;
const required = ['NID_AUT', 'NID_SES'];
// This bounds local proof reuse between the protected read and DPAPI write. It is
// a client freshness window, not a claim about Naver's server-side session TTL.
const FRESH_OWNER_VERIFICATION_MAX_AGE_MS = 30_000;
const validName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const validValue = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const sessionHeaderNames = new Set([
  'accept-language', 'cache-control', 'pragma', 'referer', 'sec-ch-ua', 'sec-ch-ua-mobile',
  'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'upgrade-insecure-requests', 'user-agent',
]);
const domainMatches = (host, domain) => host === domain.replace(/^\./, '')
  || (domain.startsWith('.') && host.endsWith(domain));
const live = (cookie, now) => cookie.expires === -1 || cookie.expires > now / 1000;

function destination(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new ApiError('SCOPE', 'Invalid session destination'); }
  if (!SESSION_ORIGINS.includes(url.origin) || url.username || url.password || url.hash) {
    throw new ApiError('SCOPE', 'Session destination is outside approved HTTPS origins');
  }
  return url;
}

function validCookie(cookie) {
  return cookie && typeof cookie.name === 'string' && validName.test(cookie.name)
    && typeof cookie.value === 'string' && validValue.test(cookie.value)
    && typeof cookie.domain === 'string'
    && /^(?:\.)?(?:[a-z0-9-]+\.)*naver\.com$/.test(cookie.domain)
    && typeof cookie.path === 'string' && cookie.path.startsWith('/')
    && !/[\x00-\x20\x7f;]/.test(cookie.path)
    && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires);
}

function normalizeSessionHeaders(input = {}) {
  let headers;
  try { headers = new Headers(input); }
  catch { throw new ApiError('INPUT', 'Invalid session headers'); }
  const normalized = new Headers();
  for (const [name, value] of headers) {
    if (!sessionHeaderNames.has(name) || value.length > 512 || /[\r\n]/.test(value)) {
      throw new ApiError('INPUT', 'Only bounded browser identity headers are accepted');
    }
    if (name === 'referer') destination(value);
    normalized.set(name, value);
  }
  return normalized;
}

function safeVerificationDetails(verification) {
  const details = {
    verified: verification.verified === true,
    actorMatched: verification.actorMatched === true,
    adminShell: verification.adminShell === true,
    loginHTML: verification.loginHTML === true,
  };
  for (const name of ['httpStatus', 'bytes', 'redirectCount']) {
    if (Number.isInteger(verification[name])) details[name] = verification[name];
  }
  if (typeof verification.mime === 'string') details.mime = verification.mime.split(';')[0].slice(0, 80);
  if (typeof verification.finalPath === 'string') {
    try {
      const url = new URL(verification.finalPath);
      if (SESSION_ORIGINS.includes(url.origin) || url.origin === 'https://nid.naver.com')
        details.finalPath = url.origin + url.pathname;
    } catch { /* Omit malformed paths from diagnostic metadata. */ }
  }
  return details;
}

export function selectCookieHeader(cookies, raw, now = Date.now()) {
  const url = destination(raw);
  return cookies.filter(cookie => validCookie(cookie) && domainMatches(url.hostname, cookie.domain)
    && live(cookie, now) && (url.pathname === cookie.path
      || (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'))))
    .sort((a, b) => b.path.length - a.path.length)
    .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

// No Playwright import, browser connection or environment dump. The live jar stays
// in memory; a separately encrypted DPAPI copy is updated only after observed rotation.
export class SessionClient {
  #cookies = [];
  #active = true;
  #fetchImpl;
  #now;
  #defaultHeaders;
  #persistRotation;
  #ownerBlogId;
  #ownerVerification = null;
  #requestRevision = 0;
  #jarRevision = 0;
  #externalActivityRevision = 0;
  #verificationGeneration = 0;
  #operation = null;
  constructor({ cookies, fetchImpl = globalThis.fetch, now = Date.now, defaultHeaders = {}, persistRotation = true, ownerBlogId = BLOG_ID } = {}) {
    if (!Array.isArray(cookies) || cookies.length > 1024 || typeof fetchImpl !== 'function' || typeof now !== 'function') {
      throw new ApiError('INPUT', 'Supply a bounded in-memory session');
    }
    this.#fetchImpl = fetchImpl; this.#now = now; this.#defaultHeaders = normalizeSessionHeaders(defaultHeaders);
    this.#persistRotation = persistRotation === true;
    if (typeof ownerBlogId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(ownerBlogId)) throw new ApiError('INPUT', 'Invalid owner blog ID');
    this.#ownerBlogId = ownerBlogId;
    this.#cookies = cookies.filter(validCookie).filter(c => live(c, now())).map(c => ({ ...c }));
  }
  #beginOperation() {
    if (this.#operation) throw new ApiError('SESSION_BUSY', 'Another operation is using this HTTP session');
    const token = Symbol('naver-session-operation');
    this.#operation = token;
    return token;
  }
  #assertOperation(token) {
    if (!token || this.#operation !== token) throw new ApiError('SESSION_BUSY', 'HTTP session operation ownership changed');
  }
  #endOperation(token) {
    if (this.#operation === token) this.#operation = null;
  }
  #cookieFor(raw) {
    if (!this.#active) throw new ApiError('AUTH_MISSING', 'HTTP session was cleared');
    const header = selectCookieHeader(this.#cookies, raw, this.#now());
    const names = new Set(header.split('; ').filter(Boolean).map(pair => pair.slice(0, pair.indexOf('='))));
    if (!required.every(name => names.has(name) && header.split('; ').some(pair => pair.startsWith(name + '=') && pair.length > name.length + 1))) {
      throw new ApiError('AUTH_MISSING', 'Current scoped authentication cookies are absent or expired');
    }
    return header;
  }
  cookieFor(raw) { return this.#cookieFor(raw); }
  acceptResponse(response, raw) {
    if (this.#operation) throw new ApiError('SESSION_BUSY', 'Another operation is using this HTTP session');
    if (!this.#active) throw new ApiError('AUTH_MISSING', 'HTTP session was cleared');
    const token = this.#beginOperation();
    try {
      this.#ownerVerification = null;
      this.#externalActivityRevision++;
      return this.#acceptResponse(response, raw, token);
    } finally { this.#endOperation(token); }
  }
  #acceptResponse(response, raw, token) {
    this.#assertOperation(token);
    try {
      const update = mergeNaverSetCookies(this.#cookies, response, raw, this.#now());
      this.#cookies = update.cookies;
      if (update.changed) {
        this.#jarRevision++;
        this.#ownerVerification = null;
      }
      return update.changed;
    } catch { throw new ApiError('SESSION_COOKIE_INVALID', 'Observed response cookies failed scope validation'); }
  }
  #takeFreshOwnerVerification() {
    const proof = this.#ownerVerification;
    if (!proof) return null;
    const now = this.#now();
    if (!this.#active || !Number.isFinite(now) || now < proof.verifiedAt
      || now - proof.verifiedAt > FRESH_OWNER_VERIFICATION_MAX_AGE_MS
      || proof.actor !== this.#ownerBlogId || proof.jarRevision !== this.#jarRevision
      || proof.requestRevision !== this.#requestRevision
      || proof.externalActivityRevision !== this.#externalActivityRevision) {
      this.#ownerVerification = null;
      return null;
    }
    try { this.#cookieFor(`https://admin.blog.naver.com/${this.#ownerBlogId}`); }
    catch { this.#ownerVerification = null; return null; }
    // Consume the private proof before any vault write can fail. Callers cannot
    // retry a stale authorization after an uncertain persistence result.
    this.#ownerVerification = null;
    return { ...proof.verification };
  }
  async persistVerifiedSession(options = {}) {
    const token = this.#beginOperation();
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new ApiError('INPUT', 'Fresh owner verification reuse must be explicitly enabled');
      }
      const reuseFreshOwnerVerification = options.reuseFreshOwnerVerification ?? false;
      if (reuseFreshOwnerVerification !== true && reuseFreshOwnerVerification !== false) {
        throw new ApiError('INPUT', 'Fresh owner verification reuse must be explicitly enabled');
      }
      let verification = reuseFreshOwnerVerification ? this.#takeFreshOwnerVerification() : null;
      let latestRead = null;
      if (!verification) {
        // Default persistence always performs a fresh GET. In opt-in mode, a
        // missing/stale proof also performs one under this same operation gate.
        latestRead = await this.#verifyRoot(token);
        // Use only the private proof minted by #verifyRoot after its await.
        // The returned report is retained only for safe failure diagnostics.
        verification = this.#takeFreshOwnerVerification();
      }
      this.#ownerVerification = null;
      if (!verification || !verification.verified || !verification.actorMatched || !verification.adminShell) {
        throw new ApiError('AUTH_UNVERIFIED', 'Only a verified owner session can be saved',
          safeVerificationDetails(verification || latestRead || {}));
      }
      this.#cookieFor(`https://admin.blog.naver.com/${this.#ownerBlogId}`);
      let stored;
      try { stored = await storeNaverCookies(this.#cookies, { userAgent: this.#defaultHeaders.get('user-agent') }); }
      catch {
        throw new ApiError('CREDENTIAL_STORE_WRITE_FAILED', 'Verified owner session could not be saved in the Windows DPAPI vault', {
          verification: safeVerificationDetails(verification),
        });
      }
      return { ...stored, verification: { ...verification } };
    } finally { this.#endOperation(token); }
  }
  async #fetch(raw, init = {}, token, duringOwnerVerification = false) {
    this.#assertOperation(token);
    this.#ownerVerification = null;
    this.#requestRevision++;
    if (!duringOwnerVerification) this.#externalActivityRevision++;
    const url = destination(raw);
    if ((init.method || 'GET') !== 'GET' || init.body != null || (init.redirect && init.redirect !== 'manual')) {
      throw new ApiError('READ_ONLY', 'HTTP session accepts manual-redirect GET requests only');
    }
    const requested = new Headers(init.headers);
    if (requested.has('authorization') || requested.has('proxy-authorization')) throw new ApiError('INPUT', 'Unrelated authorization headers are not accepted');
    requested.delete('cookie');
    const headers = new Headers(this.#defaultHeaders);
    for (const [name, value] of requested) headers.set(name, value);
    headers.set('cookie', this.#cookieFor(url.href));
    let response;
    try {
      response = await this.#fetchImpl(url.href, { ...init, method: 'GET', redirect: 'manual', headers });
    } catch (error) {
      throw new ApiError(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'TRANSPORT', 'HTTP session request failed; raw details omitted');
    }
    const rotated = this.#acceptResponse(response, url.href, token);
    if (rotated) {
      try { this.#cookieFor(`https://admin.blog.naver.com/${this.#ownerBlogId}`); }
      catch {
        try { await response.body?.cancel(); } catch { /* Preserve the sanitized auth failure. */ }
        this.#clearSession();
        throw new ApiError('AUTH_MISSING', 'The server rejected the stored Naver session; the vault was left unchanged');
      }
    }
    if (rotated && this.#persistRotation) {
      try { await storeNaverCookies(this.#cookies, { allowIncomplete: true,
        userAgent: this.#defaultHeaders.get('user-agent') }); }
      catch {
        this.#clearSession();
        throw new ApiError('CREDENTIAL_STORE_WRITE_FAILED', 'Rotated session could not be saved in the Windows DPAPI vault');
      }
    }
    return response;
  }
  async fetch(raw, init = {}) {
    const token = this.#beginOperation();
    try { return await this.#fetch(raw, init, token); }
    finally { this.#endOperation(token); }
  }
  async #verifyRoot(token) {
    this.#assertOperation(token);
    const verificationGeneration = ++this.#verificationGeneration;
    this.#ownerVerification = null;
    const externalActivityAtStart = this.#externalActivityRevision;
    const blogId = this.#ownerBlogId;
    const protectedRoot = `https://admin.blog.naver.com/${blogId}`;
    let current = protectedRoot;
    let response;
    let redirectCount = 0;
    for (; redirectCount <= 3; redirectCount++) {
      response = await this.#fetch(current, { headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        referer: `https://blog.naver.com/${blogId}`,
        'cache-control': 'no-cache', pragma: 'no-cache',
        'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site',
        'upgrade-insecure-requests': '1',
      }, signal: AbortSignal.timeout(20000) }, token, true);
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new ApiError('AUTH_UNVERIFIED', 'Protected root redirected without a usable destination', {
        httpStatus: response.status, redirectCount,
      });
      let next;
      try { next = new URL(location, current); }
      catch { throw new ApiError('AUTH_UNVERIFIED', 'Protected root returned an invalid redirect', { httpStatus: response.status, redirectCount }); }
      if (next.origin === 'https://nid.naver.com') {
        throw new ApiError('AUTH_UNVERIFIED', 'Protected root redirected back to Naver login', {
          httpStatus: response.status, redirectCount: redirectCount + 1, finalPath: next.origin + next.pathname,
        });
      }
      try { destination(next.href); }
      catch {
        throw new ApiError('AUTH_UNVERIFIED', 'Protected root redirected outside the approved Blog origins', {
          httpStatus: response.status, redirectCount: redirectCount + 1,
        });
      }
      current = next.href;
    }
    if (!response) throw new ApiError('AUTH_UNVERIFIED', 'Protected root verification did not receive a response');
    const mime = response.headers.get('content-type') || '';
    if (response.status !== 200 || !/^text\/html(?:;|$)/i.test(mime)) {
      await response.body?.cancel(); throw new ApiError('AUTH_UNVERIFIED', 'Protected root did not return expected HTML', {
        httpStatus: response.status, mime: mime.split(';')[0] || null, redirectCount,
      });
    }
    if (!response.body) throw new ApiError('SCHEMA', 'Protected root has no response body');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new ApiError('SIZE', 'Protected root exceeds response budget');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const html = bytes.toString('utf8');
    const actorMatched = html.includes(`/${blogId}/config/bloginfo`)
      || html.includes(`/${blogId}/stat/today`)
      || html.includes(`blogId=${blogId}`)
      || html.includes(`blogId%3D${blogId}`)
      || new RegExp(`["']blogId["']\\s*:\\s*["']?${blogId}["']?`).test(html);
    const adminShell = /Admin(?:UserBasic|Main)\.naver|adminMain\.|id=["']lnbMenu|블로그\s*(?:관리|글쓰기)/i.test(html);
    const strongAdminEvidence = actorMatched && adminShell;
    const passwordInput = /<input\b[^>]*type\s*=\s*["']password/i.test(html);
    const loginForm = /<form\b[^>]*action\s*=\s*["'][^"']*(?:nid\.naver\.com\/nidlogin|\/nidlogin\.login)/i.test(html);
    const directLoginRedirect = /(?:location(?:\.href)?\s*=|location\.replace\()\s*["']https:\/\/nid\.naver\.com\/nidlogin/i.test(html);
    // Authenticated admin pages may embed dormant login markup or login URLs in scripts. Treat
    // those strings as a live login document only when the response lacks strong actor-scoped
    // admin evidence. This preserves fail-closed behaviour for real login pages while avoiding
    // the false positive observed in the current 70 KiB management shell.
    const loginHTML = !strongAdminEvidence && (passwordInput || loginForm || directLoginRedirect);
    const substantialAdminDocument = bytes.length >= 1024 && adminShell;
    // The protected actor path plus a non-login admin document proves the browser session reached
    // the management surface. Literal menu links remain the strongest signal, while the substantial
    // admin-shell fallback tolerates Naver moving those links into hydrated script data.
    const verified = !loginHTML && (actorMatched || substantialAdminDocument);
    this.#cookieFor(protectedRoot); // A Set-Cookie deletion must not pass verification.
    const finalUrl = new URL(current);
    const verification = { verified, actor: blogId, actorMatched, adminShell, strongAdminEvidence, substantialAdminDocument, loginHTML,
      method: 'GET', url: protectedRoot, finalPath: finalUrl.origin + finalUrl.pathname,
      httpStatus: response.status, mime: 'text/html', bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'),
      redirectCount, userAgentApplied: this.#defaultHeaders.has('user-agent'),
      checkedAt: new Date(this.#now()).toISOString(), source: 'independent_node_fetch', browserUsedForHTTPRequest: false };
    if (verified && actorMatched && adminShell && this.#active
      && verificationGeneration === this.#verificationGeneration
      && externalActivityAtStart === this.#externalActivityRevision) {
      const verifiedAt = this.#now();
      if (Number.isFinite(verifiedAt)) {
        this.#ownerVerification = Object.freeze({
          actor: blogId,
          jarRevision: this.#jarRevision,
          requestRevision: this.#requestRevision,
          externalActivityRevision: this.#externalActivityRevision,
          verifiedAt,
          verification: Object.freeze({ ...verification }),
        });
      }
    }
    return { ...verification };
  }
  async verifyRoot() {
    const token = this.#beginOperation();
    try { return await this.#verifyRoot(token); }
    finally { this.#endOperation(token); }
  }
  async api(input) {
    const token = this.#beginOperation();
    try {
      const { url } = resolveRequest(input);
      this.#ownerVerification = null;
      this.#externalActivityRevision++;
      return await read(input, { cookie: this.#cookieFor(url.href),
        fetchImpl: (raw, init) => this.#fetch(raw, init, token), now: this.#now });
    } finally { this.#endOperation(token); }
  }
  #clearSession() {
    this.#ownerVerification = null;
    this.#jarRevision++;
    this.#cookies = [];
    this.#active = false;
  }
  clear() {
    if (this.#operation) throw new ApiError('SESSION_BUSY', 'Another operation is using this HTTP session');
    this.#clearSession();
  }
  status() { return { active: this.#active, sessionInMemory: this.#active && this.#cookies.some(c => live(c, this.#now())), browserRequired: false }; }
}
