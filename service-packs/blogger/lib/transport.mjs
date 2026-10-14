// Origin-scoped HTTP transport. Cookies go only to https://www.blogger.com; bearer tokens only to
// https://www.googleapis.com; the public feed origin gets no credentials. Redirects are never followed.
export const BLOGGER_WEB_ORIGIN = 'https://www.blogger.com';
export const GOOGLE_API_ORIGIN = 'https://www.googleapis.com';
export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class BloggerError extends Error {
  constructor(code, detail = {}) { super(code); this.name = 'BloggerError'; this.code = code; Object.assign(this, detail); }
}

export function cookieHeaderFor(url, cookies) {
  const u = new URL(url);
  if (u.origin !== BLOGGER_WEB_ORIGIN) return null;
  const now = Date.now() / 1000;
  const sel = (cookies || []).filter(c => {
    const d = c.domain.replace(/^\./, '');
    const domOk = c.domain.startsWith('.') ? (u.hostname === d || u.hostname.endsWith(`.${d}`)) : u.hostname === d;
    return domOk && u.pathname.startsWith(c.path || '/') && (c.expires === -1 || c.expires > now);
  });
  return sel.length ? sel.map(c => `${c.name}=${c.value}`).join('; ') : null;
}

export function publicBlogOrigin(blogUrl) {
  const u = new URL(blogUrl);
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.blogspot\.com$/i.test(u.hostname)) throw new BloggerError('BLOGGER_PUBLIC_ORIGIN_NOT_ALLOWED');
  return u.origin;
}

export async function request(url, { method = 'GET', headers = {}, body, cookies, bearer, allowedOrigins, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const u = new URL(url);
  if (!allowedOrigins?.includes(u.origin)) throw new BloggerError('BLOGGER_ORIGIN_NOT_ALLOWED');
  const h = { 'accept-language': 'ko,en;q=0.8', ...headers };
  if (cookies) {
    const ch = cookieHeaderFor(u, cookies);
    if (!ch) throw new BloggerError('BLOGGER_AUTH_MISSING', { phase: 'request-input preparation' });
    h.cookie = ch;
  }
  if (bearer) {
    if (u.origin !== GOOGLE_API_ORIGIN) throw new BloggerError('BLOGGER_ORIGIN_NOT_ALLOWED');
    h.authorization = `Bearer ${bearer}`;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(u, { method, headers: h, body, redirect: 'manual', signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    // Timeout / network loss: for writes the outcome is UNKNOWN. Never retried here.
    throw new BloggerError(ctl.signal.aborted ? 'BLOGGER_TIMEOUT' : 'BLOGGER_TRANSPORT_FAILED', { outcome: 'unknown', phase: 'business request' });
  }
  let text;
  try { text = await res.text(); } catch { clearTimeout(timer); throw new BloggerError('BLOGGER_TRANSPORT_FAILED', { outcome: 'unknown', phase: 'business request' }); }
  clearTimeout(timer);
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new BloggerError('BLOGGER_RESPONSE_TOO_LARGE');
  const status = res.status;
  if (status >= 300 && status < 400) {
    const loc = res.headers.get('location') || '';
    throw new BloggerError(/accounts\.google\.com|ServiceLogin/.test(loc) ? 'BLOGGER_AUTH_EXPIRED' : 'BLOGGER_UNEXPECTED_REDIRECT', { status });
  }
  if (status === 401) throw new BloggerError('BLOGGER_AUTH_EXPIRED', { status });
  if (status === 403) throw new BloggerError('BLOGGER_FORBIDDEN_UNKNOWN_CAUSE', { status });
  if (status === 429) throw new BloggerError('BLOGGER_RATE_LIMITED', { status });
  if (status >= 500) throw new BloggerError('BLOGGER_SERVER_ERROR', { status, outcome: method === 'GET' ? 'failed' : 'unknown' });
  if (status === 404) throw new BloggerError('BLOGGER_NOT_FOUND', { status });
  if (status >= 400) throw new BloggerError('BLOGGER_HTTP_ERROR', { status });
  return { status, text, contentType: res.headers.get('content-type') || '' };
}
