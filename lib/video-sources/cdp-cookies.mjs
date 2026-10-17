// Loopback Chrome DevTools helpers for a user-started automation profile (e.g. Chrome Canary on :9333).
// - readCdpCookies: Storage.getCookies on the browser target (no navigation, no page script).
// - createCdpPageFetcher: run a credentialed fetch() inside an existing first-party tab, so the request carries the
//   browser's own TLS fingerprint, cookies and risk tokens. Used where plain-HTTP replay of the same cookies is
//   challenged (AliExpress MTOP, 2026-10-17). It never clicks, solves challenges or reads page DOM.

export class CdpError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'CdpError'; this.code = code; this.detail = detail; }
}
export { CdpError as CdpCookieError };
const fail = (code, detail) => { throw new CdpError(code, detail); };

function loopbackBase(endpoint) {
  let base;
  try { base = new URL(endpoint); } catch { fail('CDP_ENDPOINT_INVALID'); }
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) fail('CDP_ENDPOINT_NOT_LOOPBACK');
  return base;
}
const LOOPBACK_WS = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/devtools\/(browser|page)\/[A-Za-z0-9-]+$/;

function cdpCall(wsUrl, method, params, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 20_000 } = {}) {
  if (typeof wsUrl !== 'string' || !LOOPBACK_WS.test(wsUrl)) fail('CDP_TARGET_INVALID');
  if (typeof WebSocketImpl !== 'function') fail('CDP_WEBSOCKET_UNAVAILABLE');
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new CdpError('CDP_TIMEOUT')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => { clearTimeout(timer); reject(new CdpError('CDP_TRANSPORT_FAILED')); };
    ws.onmessage = event => {
      let msg; try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer); try { ws.close(); } catch {}
      if (msg.error) reject(new CdpError('CDP_COMMAND_FAILED', { method, message: String(msg.error.message).slice(0, 200) }));
      else resolve(msg.result);
    };
  });
}

async function json(fetchImpl, url, init = {}) {
  try { const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), ...init }); return await r.json(); }
  catch { fail('CDP_UNAVAILABLE'); }
}

export async function readCdpCookies({ endpoint = 'http://127.0.0.1:9333', domainFilter, fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket, timeoutMs = 10_000 } = {}) {
  const base = loopbackBase(endpoint);
  if (!(domainFilter instanceof RegExp)) fail('CDP_DOMAIN_FILTER_REQUIRED');
  const version = await json(fetchImpl, new URL('/json/version', base));
  const result = await cdpCall(version?.webSocketDebuggerUrl, 'Storage.getCookies', {}, { WebSocketImpl, timeoutMs });
  if (!Array.isArray(result?.cookies)) fail('CDP_RESPONSE_INVALID');
  return {
    userAgent: typeof version['User-Agent'] === 'string' ? version['User-Agent'] : null,
    browser: typeof version.Browser === 'string' ? version.Browser : null,
    cookies: result.cookies.filter(c => typeof c?.domain === 'string' && domainFilter.test(c.domain))
      .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}) })),
  };
}

/** Fetch through an existing tab of `pageOrigin`; opens one at `openUrl` when none exists. */
export function createCdpPageFetcher({ endpoint = 'http://127.0.0.1:9333', pageOrigin, openUrl, allowedRequestOrigins,
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  const base = loopbackBase(endpoint);
  if (typeof pageOrigin !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(pageOrigin)) fail('CDP_PAGE_ORIGIN_INVALID');
  if (!Array.isArray(allowedRequestOrigins) || !allowedRequestOrigins.length) fail('CDP_REQUEST_ORIGINS_REQUIRED');
  async function pageTarget() {
    const list = await json(fetchImpl, new URL('/json/list', base));
    let target = Array.isArray(list) ? list.find(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(`${pageOrigin}/`)) : null;
    if (!target) {
      if (typeof openUrl !== 'string' || !openUrl.startsWith(`${pageOrigin}/`)) fail('CDP_PAGE_MISSING');
      target = await json(fetchImpl, new URL(`/json/new?${encodeURIComponent(openUrl)}`, base), { method: 'PUT' });
      await new Promise(r => setTimeout(r, 6000)); // let the first-party page set its cookies/risk tokens
    }
    return target;
  }
  return {
    async cookies(urls) {
      const target = await pageTarget();
      const result = await cdpCall(target.webSocketDebuggerUrl, 'Network.getCookies', { urls }, { WebSocketImpl });
      return Array.isArray(result?.cookies) ? result.cookies : [];
    },
    async fetchText(url, { timeoutMs = 25_000 } = {}) {
      const parsed = new URL(url);
      if (!allowedRequestOrigins.includes(parsed.origin)) fail('CDP_REQUEST_ORIGIN_NOT_ALLOWED');
      const target = await pageTarget();
      const expression = `(async () => { const r = await fetch(${JSON.stringify(parsed.href)}, { credentials: 'include' });
        const text = await r.text(); return JSON.stringify({ status: r.status, type: r.headers.get('content-type'), text: text.slice(0, ${maxResponseBytes}) }); })()`;
      const result = await cdpCall(target.webSocketDebuggerUrl, 'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: false }, { WebSocketImpl, timeoutMs });
      if (result?.exceptionDetails || typeof result?.result?.value !== 'string') fail('CDP_PAGE_FETCH_FAILED');
      return { ...JSON.parse(result.result.value), pageUrl: target.url.split('?')[0] };
    },
  };
}
