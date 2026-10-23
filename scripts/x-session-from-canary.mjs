// Import the logged-in X web session from the automation Canary (CDP 9333) into the DPAPI store, via lib/web-auth/x.mjs
// importSession. Nothing secret is printed: cookies and the web bearer go from CDP straight into importSession in-process.
//   node scripts/x-session-from-canary.mjs [<targetId>]     (defaults to the first x.com tab)
// Login itself: x.com/i/flow/login -> "Google 계정으로 계속하기" -> account chooser popup (click the account's
// [data-identifier] element with JS; a mouse click on the popup did nothing) -> x.com/home. 2026-10-19 @lifehack__ailab.
import { createXAuth } from '../lib/web-auth/x.mjs';
const CDP = process.env.X_CDP || 'http://127.0.0.1:9333';
const list = await (await fetch(`${CDP}/json/list`)).json();
const t = list.find((v) => v.id === process.argv[2]) || list.find((v) => v.type === 'page' && /^https:\/\/x\.com\//.test(v.url));
if (!t) { console.log(JSON.stringify({ ok: false, code: 'NO_X_TAB' })); process.exit(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); let auth = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent' && !auth) {
    const h = m.params.request.headers || {}; const a = h.authorization || h.Authorization;
    if (/^https:\/\/(api\.)?x\.com\/(i\/api\/)?(graphql|1\.1)\//.test(m.params.request.url) && a && /^Bearer /.test(a)) auth = a;
  }
  if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Network.enable');
await send('Page.reload', {});
for (let k = 0; k < 60 && !auth; k++) await new Promise((r) => setTimeout(r, 250));
const ua = (await send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })).result.result.value;
let handle = '';
for (let k = 0; k < 40 && !handle; k++) { handle = ((await send('Runtime.evaluate', { expression: "(document.querySelector('[data-testid=AppTabBar_Profile_Link]')||{}).href||''", returnByValue: true })).result.result.value || '').split('/').pop(); if (!handle) await new Promise((r) => setTimeout(r, 300)); }
const ck = (await send('Network.getCookies', { urls: ['https://x.com', 'https://api.x.com'] })).result.cookies;
ws.close();
const cookies = ck.filter((c) => ['auth_token', 'ct0', 'twid'].includes(c.name)).map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expires }));
if (!auth || !handle || cookies.length < 2) { console.log(JSON.stringify({ ok: false, code: 'CAPTURE_INCOMPLETE', bearer: !!auth, handle: !!handle, cookies: cookies.map((c) => c.name) })); process.exit(2); }
try {
  const r = await createXAuth().importSession({ ownerUrl: "https://api.x.com/1.1/account/settings.json", handle, cookies, authorization: auth, userAgent: ua });
  console.log(JSON.stringify({ ok: true, handle, stored: r.stored, receipt: Object.fromEntries(Object.entries(r).filter(([k]) => !/token|cookie|auth/i.test(k))) }));
} catch (e) { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exit(2); }
