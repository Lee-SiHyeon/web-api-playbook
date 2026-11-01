// Optional, explicit bootstrap against the owner's existing first-party tab.
// Business operations live in google-maps.mjs and never attach a browser.
import { options, safeError } from '../lib/cli.mjs';
import { ProtectedStore } from '../lib/protected-store.mjs';
import { importMapsState, createGoogleMapsClient, MAPS_STORE } from '../lib/google-maps.mjs';

async function connect(url) {
  const u = new URL(url);
  if (u.protocol !== 'ws:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname)
      || !/^\/devtools\/page\/[A-Za-z0-9-]+$/.test(u.pathname) || u.username || u.password) throw Object.assign(new Error(), { code: 'MAPS_CDP_TARGET_INVALID' });
  const ws = new WebSocket(url); const pending = new Map(); let next = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(Object.assign(new Error(), { code: 'MAPS_CDP_TIMEOUT' })); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(Object.assign(new Error(), { code: 'MAPS_CDP_UNAVAILABLE' })); };
  });
  ws.onmessage = ({ data }) => {
    let message; try { message = JSON.parse(String(data)); } catch { return; }
    const job = pending.get(message.id); if (!job) return; pending.delete(message.id); clearTimeout(job.timer);
    if (message.error) job.reject(Object.assign(new Error(), { code: 'MAPS_CDP_COMMAND_FAILED' })); else job.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next; const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(), { code: 'MAPS_CDP_TIMEOUT' })); }, 10000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const close = () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Object.assign(new Error(), { code: 'MAPS_CDP_CLOSED' })); } pending.clear(); ws.close(); };
  return { send, close };
}

try {
  const args = options(process.argv.slice(2), ['cdp','tab','expected-email','expected-owner-id','store-dir']);
  if (Object.values(args).some(x => typeof x !== 'string') || !args.tab || !args['store-dir'] || !args['expected-email'] || !args['expected-owner-id']) throw Object.assign(new Error(), { code: 'MAPS_BOOTSTRAP_ARGUMENT_INVALID' });
  const endpoint = new URL(args.cdp || 'http://127.0.0.1:9333');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw Object.assign(new Error(), { code: 'MAPS_CDP_ENDPOINT_INVALID' });
  const listing = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(10000) });
  const targets = await listing.json();
  const target = targets.find(x => x.id === args.tab && x.type === 'page' && /^https:\/\/www\.google\.com\/maps(?:\/|\?|$)/.test(x.url));
  if (!target) throw Object.assign(new Error(), { code: 'MAPS_OWNED_TAB_REQUIRED' });
  const cdp = await connect(target.webSocketDebuggerUrl);
  try {
    const expression = `(() => {
      const ownerMatches=[...document.querySelectorAll('a[aria-label],button[aria-label]')].some(x=>/Google (계정|Account)/.test(x.getAttribute('aria-label')) && (x.getAttribute('aria-label').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi)||[]).some(email=>email.toLowerCase()===${JSON.stringify(args['expected-email'].toLowerCase())}));
      if(!ownerMatches) return {ownerMatches:false};
      const resources=performance.getEntriesByType('resource').map(x=>x.name);
      const list=resources.filter(x=>x.startsWith('https://www.google.com/maps/preview/entitylist/getlist?')).at(-1);
      const search=resources.filter(x=>x.startsWith('https://www.google.com/s?')).at(-1);
      if(!list || !search) return {ownerMatches:true, contextReady:false};
      const p=new URL(list).searchParams; const id=/^!1m4!1s([^!]+)/.exec(p.get('pb')||'')?.[1];
      return {ownerMatches:true,contextReady:true,listId:id,authuser:Number(p.get('authuser')),
        clientContext:APP_OPTIONS[11],xsrf:APP_OPTIONS[28]?.Ag?.[28],noteXsrf:APP_OPTIONS[28]?.Ag?.[30],searchParameters:Object.fromEntries(new URL(search).searchParams)};
    })()`;
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw Object.assign(new Error(), { code: 'MAPS_CDP_RUNTIME_FAILED' });
    const data = result?.result?.value;
    if (!data?.ownerMatches) throw Object.assign(new Error(), { code: 'MAPS_OWNER_MISMATCH' });
    if (!data.contextReady) throw Object.assign(new Error(), { code: 'MAPS_BOOTSTRAP_READ_CONTEXT_REQUIRED' });
    const cookies = await cdp.send('Network.getCookies', { urls: ['https://www.google.com/maps/'] });
    const state = importMapsState({ ...data, expectedEmail: args['expected-email'], expectedOwnerId: args['expected-owner-id'], cookies: cookies.cookies });
    let verifiedState = state;
    const client = createGoogleMapsClient({ state, saveState: s => { verifiedState = s; } }); const list = await client.readList();
    const store = new ProtectedStore({ directory: args['store-dir'] }); store.write(MAPS_STORE, JSON.stringify(verifiedState));
    console.log(JSON.stringify({ ok: true, imported: true, ownerVerified: true, itemCount: list.items.length,
      loginAcquisition: 'existing_browser_session', inputPreparation: 'explicit_cdp_bootstrap', businessMode: 'pure_http', renewalVerified: false }));
  } finally { cdp.close(); }
} catch (e) { console.error(JSON.stringify({ ok: false, code: safeError(e) })); process.exitCode = 1; }
