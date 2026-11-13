import { AGY_ORIGIN, AGY_API, AGY_STORE, AGY_AUTH_HEADERS, importAgyState, validateAgyState, createAgyRemoteClient } from './agy-remote.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const local = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
export function agyBrowserOwnerExpression(expectedEmail) {
  return `(() => [...document.querySelectorAll('[aria-label]')].some(x => { const label = x.getAttribute('aria-label') || ''; return /Google (Account|계정)/.test(label) && (label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi) || []).some(email => email.toLowerCase() === ${JSON.stringify(expectedEmail.toLowerCase())}); }))()`;
}
export async function waitAgyBrowserOwner(cdp, expectedEmail, { timeoutMs = 10000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  const expression = `(() => ({ matched: ${agyBrowserOwnerExpression(expectedEmail)}, identified: [...document.querySelectorAll('[aria-label]')].some(x => /Google (Account|계정)/.test(x.getAttribute('aria-label') || '') && /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i.test(x.getAttribute('aria-label') || '')) }))()`;
  for (;;) {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) fail('AGY_CDP_RUNTIME_FAILED');
    if (result.result?.value?.matched === true) return true;
    if (result.result?.value?.identified === true) fail('AGY_BROWSER_OWNER_MISMATCH');
    if (now() >= deadline) fail('AGY_BROWSER_OWNER_UNVERIFIED');
    await sleep(Math.min(100, deadline - now()));
  }
}
export function validateAgyCdpEndpoint(value) {
  let url; try { url = new URL(value); } catch { fail('AGY_CDP_ENDPOINT_INVALID'); }
  if (url.protocol !== 'http:' || !local(url.hostname) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) fail('AGY_CDP_ENDPOINT_INVALID');
  return url;
}
export function selectAgyTarget(targets, endpoint, tabId) {
  if (!Array.isArray(targets) || targets.length > 256) fail('AGY_CDP_TARGET_INVALID');
  const matches = targets.filter(t => {
    if (t.type !== 'page' || typeof t.url !== 'string' || tabId && t.id !== tabId) return false;
    try { return new URL(t.url).origin === AGY_ORIGIN; } catch { return false; }
  });
  if (matches.length !== 1) fail('AGY_CDP_OWNED_TAB_REQUIRED');
  const target = matches[0]; let ws;
  try { ws = new URL(target.webSocketDebuggerUrl); } catch { fail('AGY_CDP_TARGET_INVALID'); }
  if (ws.protocol !== 'ws:' || ws.hostname !== endpoint.hostname || ws.port !== endpoint.port || ws.username || ws.password
    || ws.search || ws.hash || !/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(ws.pathname)) fail('AGY_CDP_TARGET_INVALID');
  return target;
}

async function connect(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000 } = {}) {
  const ws = new WebSocketImpl(url), jobs = new Map(), listeners = new Set(); let id = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Object.assign(new Error(), { code: 'AGY_CDP_TIMEOUT' })); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(Object.assign(new Error(), { code: 'AGY_CDP_UNAVAILABLE' })); };
  });
  const close = () => {
    for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(Object.assign(new Error(), { code: 'AGY_CDP_CLOSED' })); }
    jobs.clear(); listeners.clear(); ws.close();
  };
  ws.onclose = () => {
    for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(Object.assign(new Error(), { code: 'AGY_CDP_CLOSED' })); }
    jobs.clear(); listeners.clear();
  };
  ws.onmessage = event => {
    let value; try { value = JSON.parse(String(event.data)); } catch { return; }
    if (!value.id) { for (const fn of listeners) fn(value); return; }
    const job = jobs.get(value.id); if (!job) return;
    jobs.delete(value.id); clearTimeout(job.timer);
    if (value.error) job.reject(Object.assign(new Error(), { code: 'AGY_CDP_COMMAND_FAILED' })); else job.resolve(value.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id; const timer = setTimeout(() => { jobs.delete(next); reject(Object.assign(new Error(), { code: 'AGY_CDP_TIMEOUT' })); }, timeoutMs);
    jobs.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  });
  return { send, close, onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
}

/** Explicit browser bootstrap only. It never submits a Google password or a business write. */
export async function bootstrapAgyRemote({ endpoint, tabId, expectedEmail, remote, store,
  autoSync = false, fetchImpl = globalThis.fetch, cdpFetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket, timeoutMs = 20000 } = {}) {
  const base = validateAgyCdpEndpoint(endpoint);
  if (typeof expectedEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail) || !store || !remote) fail('AGY_BOOTSTRAP_INPUT');
  let targets;
  try { const r = await cdpFetchImpl(new URL('/json/list', base), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); targets = await r.json(); }
  catch { fail('AGY_CDP_UNAVAILABLE'); }
  const target = selectAgyTarget(targets, base, tabId);
  const cdp = await connect(target.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs });
  let captured = {}, requestId = null, responseStatus = null;
  const unsubscribe = cdp.onEvent(event => {
    if (event.method === 'Network.requestWillBeSent') {
      const r = event.params?.request;
      if (r?.url === AGY_ORIGIN + AGY_API + 'ListInstances' && r.method === 'POST') {
        requestId = event.params.requestId; captured = { ...r.headers };
      }
    }
    if (event.method === 'Network.requestWillBeSentExtraInfo' && event.params.requestId === requestId)
      Object.assign(captured, event.params.headers);
    if (event.method === 'Network.responseReceived' && event.params.requestId === requestId)
      responseStatus = event.params.response.status;
  });
  async function checkOwner() {
    return waitAgyBrowserOwner(cdp, expectedEmail);
  }
  try {
    if (!await checkOwner()) fail('AGY_BROWSER_OWNER_MISMATCH');
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: AGY_ORIGIN + '/remote?path=%2Fview%2Fremote-control' });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const normalized = Object.fromEntries(Object.entries(captured).map(([k, v]) => [k.toLowerCase(), v]));
      if (responseStatus === 200 && normalized.authorization && normalized['x-goog-api-key']) { captured = normalized; break; }
      if (Date.now() >= deadline) fail('AGY_BROWSER_AUTH_CAPTURE_REQUIRED');
      await new Promise(r => setTimeout(r, 100));
    }
    if (!await checkOwner()) fail('AGY_BROWSER_OWNER_MISMATCH');
    const result = await cdp.send('Network.getCookies', { urls: [AGY_ORIGIN + '/'] });
    const headers = Object.fromEntries(Object.entries(captured).filter(([key]) => AGY_AUTH_HEADERS.includes(key)));
    let state = importAgyState({ expectedEmail, headers, cookies: result.cookies });
    if (autoSync) state.maintenance = { endpoint: base.href, tabId: target.id, ownerRemote: remote, maxAgeMs: 300000 };
    const client = createAgyRemoteClient({ state, fetchImpl, saveState: value => { state = value; } });
    const owner = await client.owner(remote);
    const stored = store.write(AGY_STORE, JSON.stringify(state));
    return { ok: true, imported: true, ownerVerified: true, email: owner.email, remote: owner.remote,
      storage: stored, acquisitionMode: 'existing_authenticated_browser_cdp', businessMode: 'pure_http',
      browserCookieMaintenanceConfigured: autoSync, automaticGoogleLogin: false };
  } finally { captured = {}; unsubscribe(); cdp.close(); }
}

/** Refresh copied device-bound cookies from Chrome's native signed-in session. No navigation or login. */
export async function refreshAgyRemoteSession({ state: input, remote, fetchImpl = globalThis.fetch,
  cdpFetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const current = validateAgyState(input);
  if (!current.maintenance) fail('AGY_MAINTENANCE_NOT_CONFIGURED');
  const base = validateAgyCdpEndpoint(current.maintenance.endpoint);
  let targets;
  try { const r = await cdpFetchImpl(new URL('/json/list', base), { redirect: 'error', signal: AbortSignal.timeout(10000) }); targets = await r.json(); }
  catch { fail('AGY_CDP_UNAVAILABLE'); }
  const oldTargetExists = Array.isArray(targets) && targets.some(x => x.id === current.maintenance.tabId);
  const target = selectAgyTarget(targets, base, oldTargetExists ? current.maintenance.tabId : undefined);
  const cdp = await connect(target.webSocketDebuggerUrl, { WebSocketImpl });
  let state;
  try {
    await waitAgyBrowserOwner(cdp, current.expectedEmail);
    const result = await cdp.send('Network.getCookies', { urls: [AGY_ORIGIN + '/'] });
    state = importAgyState({ expectedEmail: current.expectedEmail, headers: current.session.headersByOrigin[AGY_ORIGIN], cookies: result.cookies });
    if (current.authMode) { state.authMode = current.authMode; state.authSchemes = current.authSchemes; }
    state.maintenance = { ...current.maintenance, tabId: target.id };
  } finally { cdp.close(); }
  // The CDP helper is closed before independent HTTP verification and business work.
  const client = createAgyRemoteClient({ state, fetchImpl, saveState: value => { state = value; } });
  await client.owner(remote ?? current.maintenance.ownerRemote);
  return { state, receipt: { usedBrowser: true, kind: 'native_browser_cookie_sync', ownerVerified: true,
    navigated: false, automaticGoogleLogin: false, verifiedAt: new Date().toISOString() } };
}
