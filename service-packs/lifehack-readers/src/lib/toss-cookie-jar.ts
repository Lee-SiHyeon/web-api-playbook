import { Cookie, CookieJar } from 'tough-cookie';
import type { TossCookie } from './toss-session-core';

export const TOSS_COOKIE_NAMES = ['TGSID', 'TBIZAUTH', 'TAUTH'] as const;
export const TOSS_COOKIE_HOSTS = ['toss.im', 'sharelink.toss.im', 'business.toss.im',
  'business-accounts.toss.im', 'oauth2.cert.toss.im'] as const;
export const TOSS_COOKIE_LIMIT = TOSS_COOKIE_NAMES.length * TOSS_COOKIE_HOSTS.length;
const names = new Set<string>(TOSS_COOKIE_NAMES), hosts = new Set<string>(TOSS_COOKIE_HOSTS);
export class TossCookieJarError extends Error {
  constructor(readonly code: 'TOSS_COOKIE_SCOPE_REJECTED' | 'TOSS_COOKIE_REVOKED') { super(code); }
}
export function tossCookieKey(cookie: Pick<TossCookie, 'name' | 'domain' | 'path'>): string {
  return `${cookie.name}\n${cookie.domain.replace(/^\./, '').toLowerCase()}\n${cookie.path}`;
}
/** Restore against the cookie's own host so host-only scope is never widened. */
export function restoreTossCookieJar(cookies: readonly TossCookie[], now = Date.now()): CookieJar {
  const jar = new CookieJar();
  for (const c of cookies) {
    if (c.expires !== undefined && c.expires !== -1 && c.expires * 1000 <= now) continue;
    const host = c.domain.replace(/^\./, '').toLowerCase();
    if (!names.has(c.name) || !hosts.has(host) || c.path !== '/' || !c.secure || !c.httpOnly) throw new TossCookieJarError('TOSS_COOKIE_SCOPE_REJECTED');
    const cookie = new Cookie({ key: c.name, value: c.value, domain: host, path: '/',
      hostOnly: c.hostOnly === true, secure: true, httpOnly: true,
      expires: c.expires === undefined || c.expires === -1 ? 'Infinity' : new Date(c.expires * 1000),
      sameSite: c.sameSite?.toLowerCase() as 'strict' | 'lax' | 'none' | undefined });
    try { jar.setCookieSync(cookie, `https://${host}/`, { now: new Date(now) }); }
    catch { throw new TossCookieJarError('TOSS_COOKIE_SCOPE_REJECTED'); }
  }
  return jar;
}
/** Preserve auth-host cookies for SSO; callers obtain request cookies from the jar by URL. */
export function exportTossCookieJar(jar: CookieJar, now = Date.now()): TossCookie[] {
  const result: TossCookie[] = [];
  for (const raw of jar.serializeSync()?.cookies ?? []) {
    const c = Cookie.fromJSON(raw);
    if (!c || !names.has(c.key)) continue;
    const expires = c.expiryTime() ?? Infinity;
    if (expires <= now) continue;
    if (!c.domain || !hosts.has(c.domain) || c.path !== '/' || !c.secure || !c.httpOnly
      || !c.value || c.value.length > 16384 || /[;\r\n\0]/.test(c.value)) throw new TossCookieJarError('TOSS_COOKIE_SCOPE_REJECTED');
    const sameSite = c.sameSite ? ({ strict: 'Strict', lax: 'Lax', none: 'None' } as const)[c.sameSite] : undefined;
    result.push({ name: c.key, value: c.value, domain: c.hostOnly ? c.domain : '.' + c.domain,
      path: '/', secure: true, httpOnly: true, hostOnly: c.hostOnly === true,
      expires: expires === Infinity ? -1 : expires / 1000, ...(sameSite ? { sameSite } : {}) });
  }
  if (result.length > TOSS_COOKIE_LIMIT) throw new TossCookieJarError('TOSS_COOKIE_SCOPE_REJECTED');
  return result;
}
export function tossCookieHeader(jar: CookieJar, url: string, now = Date.now()): string {
  return jar.getCookiesSync(url, { expire: false, sort: true })
    .filter(c => (c.expiryTime() ?? Infinity) > now).map(c => c.cookieString()).join('; ');
}
/** Set-Cookie applies independently of the response's application result. */
export function applyTossResponseCookies(jar: CookieJar, headers: Headers, url: string, now = Date.now()): void {
  let revoked = false;
  for (const line of headers.getSetCookie()) {
    const c = Cookie.parse(line);
    if (!c || !names.has(c.key)) continue;
    const host = (c.domain ?? new URL(url).hostname).replace(/^\./, '').toLowerCase();
    const expiry = c.expiryTime(new Date(now)) ?? Infinity;
    const deleting = !c.value || expiry <= now;
    if (!hosts.has(host) || (c.path !== undefined && c.path !== '/')
      || (!deleting && (!c.secure || !c.httpOnly)) || c.value.length > 16384 || /[;\r\n\0]/.test(c.value)) throw new TossCookieJarError('TOSS_COOKIE_SCOPE_REJECTED');
    const existed = (jar.serializeSync()?.cookies ?? []).some(old => old.key === c.key && old.domain === host && old.path === (c.path ?? '/'));
    // Fix Max-Age at response time; cookie reads must not slide its expiration.
    if (c.maxAge != null) { c.maxAge = null; c.expires = expiry === Infinity ? 'Infinity' : new Date(Math.max(0, expiry)); }
    try { jar.setCookieSync(c, url, { now: new Date(now) }); }
    catch { throw new TossCookieJarError('TOSS_COOKIE_SCOPE_REJECTED'); }
    revoked ||= deleting && existed;
  }
  // Store deletions before reporting them; no caller may reuse a revoked cookie.
  exportTossCookieJar(jar, now);
  if (revoked) throw new TossCookieJarError('TOSS_COOKIE_REVOKED');
}
