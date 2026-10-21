// Capture the logged-in Instagram web session from the automation Canary (CDP 9333) into DPAPI via
// OPTIONAL external affiliate-content-operations integration: meta-auth-session storeMetaSession('instagram', …).
// Set ACO_ROOT to that checkout, or place it beside this repository. Nothing secret is printed.
//   node scripts/meta-session-from-canary.mjs [<instagramTabId>]
// The owner check uses the observed owner read GET /api/v1/accounts/edit/web_form_data/ (headers captured from the page's
// own request). 2026-10-19: @lifehack_ailab (new account; old lifehack__ailab IG deactivated).
// Login path that worked: instagram.com as the personal Meta account → 전환 → lifehack_ailab → password →
// email code (Gmail, "Verify your profile") → 정보 저장.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ACO = process.env.ACO_ROOT || fileURLToPath(new URL('../../affiliate-content-operations/', import.meta.url));
const failSetup = (code) => {
  console.error(JSON.stringify({ ok: false, code, integration: 'affiliate-content-operations',
    hint: 'Set ACO_ROOT to a checkout containing apps/naver-blog-api/scripts/meta-auth-session.mjs with storeMetaSession and loadMetaSession exports; this optional integration is not included in web-api-playbook.' }));
  process.exit(2);
};
let sessionHelper;
try { sessionHelper = await import(pathToFileURL(path.resolve(ACO, 'apps/naver-blog-api/scripts/meta-auth-session.mjs')).href); }
catch { failSetup('META_SESSION_HELPER_UNAVAILABLE'); }
const { storeMetaSession, loadMetaSession } = sessionHelper;
if (typeof storeMetaSession !== 'function' || typeof loadMetaSession !== 'function') failSetup('META_SESSION_HELPER_INVALID');
const CDP = process.env.META_CDP || 'http://127.0.0.1:9333';
const list = await (await fetch(`${CDP}/json/list`)).json();
const t = list.find((v) => v.id === process.argv[2]) || list.find((v) => v.type === 'page' && /^https:\/\/www\.instagram\.com\//.test(v.url));
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); let captured = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent' && /\/api\/v1\/accounts\/edit\/web_form_data\/$/.test(m.params.request.url)) captured = m.params.request.headers;
  if (m.method === 'Network.requestWillBeSentExtraInfo' && captured && m.params.headers?.['x-ig-app-id']) captured = { ...m.params.headers, ...captured };
  if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Network.enable');
// make the page issue the owner read with its own headers
const owner = await ev(`(async () => { const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1];
  const r = await fetch('/api/v1/accounts/edit/web_form_data/', { headers: { 'x-ig-app-id': '936619743392459', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest', 'x-asbd-id': '129477' } });
  const j = await r.json(); return j.form_data?.username || null; })()`);
await new Promise((r) => setTimeout(r, 800));
const ua = await ev('navigator.userAgent');
const ck = (await send('Network.getCookies', { urls: ['https://www.instagram.com', 'https://i.instagram.com'] })).result.cookies;
ws.close();
const cookies = ck.filter((c) => ['sessionid', 'csrftoken', 'ds_user_id', 'rur'].includes(c.name))
  .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.session ? -1 : c.expires }));
const headers = { ...(captured || {}), 'user-agent': ua, referer: 'https://www.instagram.com/' };
try {
  const r = await storeMetaSession('instagram', { version: 1, service: 'instagram', origin: 'https://www.instagram.com', owner, capturedAt: Date.now(),
    cookies, ownerRequest: { method: 'GET', url: 'https://www.instagram.com/api/v1/accounts/edit/web_form_data/', headers } });
  const back = loadMetaSession('instagram');
  console.log(JSON.stringify({ ok: true, owner, stored: !!back, cookieNames: (back?.cookies || []).map((c) => c.name), result: typeof r === 'object' ? Object.keys(r) : r }));
} catch (e) { console.log(JSON.stringify({ ok: false, owner, code: e.code || e.message })); process.exit(2); }
