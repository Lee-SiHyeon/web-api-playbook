// MyRealTrip Partner (marketing partner) Open API client — https://docs.myrealtrip.com (cite when redistributing).
//   node myrealtrip-partner-api.mjs health | commission-rates [--category=CITY_TOUR]
//        | revenues --from=YYYY-MM-DD --to=YYYY-MM-DD [--type=SETTLEMENT|PAYMENT] [--flight]
//        | reservations --from=… --to=… [--type=RESERVATION_DATE] [--statuses=CONFIRM,FINISH] [--page=1] [--size=100]
//        | tna-search --keyword=… [--category=…] [--sort=selling_count_desc] [--min=…] [--max=…] [--page=1] [--size=20]
//        | tna-detail --gid=… | mylink --url=<MRT url> --approved
// The key lives only in the DPAPI ProtectedStore record `myrealtrip-partner-api-key`; it is sent only to
// partner-ext-api.myrealtrip.com as a Bearer header and is never printed. Attribution joins on linkId / utmContent.
// mylink creation is a write and follows the owner's link-approval rule: it refuses without --approved.
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { webApiPlaybookRoot } from './web-auth-provider.mjs';
const PLAYBOOK = webApiPlaybookRoot();
const ORIGIN = 'https://partner-ext-api.myrealtrip.com';
const STORE_NAME = 'myrealtrip-partner-api-key';
const MIN_GAP_MS = 1100;
const BACKOFF_MS = [1000, 2000, 4000];
const ALLOWED = new Set(['GET /health', 'GET /v1/revenues', 'GET /v1/revenues/flight', 'GET /v1/revenues/commission-rates', 'GET /v1/reservations',
  'GET /v1/reservations/flight', 'POST /v1/products/tna/search', 'POST /v1/products/tna/detail', 'POST /v1/products/tna/options', 'POST /v1/mylink']);
const MRT_TARGET = /^https:\/\/(?:[a-z0-9-]+\.)*myrealtrip\.com(?:[/?#]|$)/i;

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function defaultStore() {
  const { ProtectedStore } = await import(pathToFileURL(path.join(PLAYBOOK, 'lib', 'protected-store.mjs')).href);
  return new ProtectedStore();
}

export function createMyrealtripPartnerApi({ store = null, fetchImpl = globalThis.fetch, sleepImpl = sleep, now = () => Date.now() } = {}) {
  let storeP = store ? Promise.resolve(store) : null;
  let keyCache = null;
  let lastCallAt = 0;
  const readKey = async () => {
    if (keyCache) return keyCache;
    let raw; try { raw = (await (storeP ??= defaultStore())).read(STORE_NAME); } catch { fail('MRT_PARTNER_KEY_MISSING'); }
    let key = String(raw ?? '').trim();
    if (key.startsWith('{')) { try { key = String(JSON.parse(key).apiKey ?? ''); } catch { key = ''; } }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) fail('MRT_PARTNER_KEY_MISSING');
    return (keyCache = key);
  };

  async function call(method, p, { query = null, body = null } = {}) {
    if (!ALLOWED.has(`${method} ${p}`)) fail('MRT_PARTNER_ENDPOINT_NOT_ALLOWED');
    const url = new URL(ORIGIN + p);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    if (url.origin !== ORIGIN) fail('MRT_PARTNER_ORIGIN');
    const key = await readKey();
    let last = null;
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      const wait = lastCallAt + MIN_GAP_MS - now();
      if (wait > 0) await sleepImpl(wait);
      lastCallAt = now();
      const r = await fetchImpl(url, { method, headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'accept-language': 'ko-KR',
        'user-agent': 'affiliate-content-operations/1.0', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
      last = { method, path: url.pathname, httpStatus: r.status, rateLimitRemaining: r.headers.get('x-ratelimit-remaining'), checkedAt: new Date(now()).toISOString() };
      if (r.status === 429 && attempt < BACKOFF_MS.length) { await sleepImpl(BACKOFF_MS[attempt]); continue; }
      if (r.status === 401) fail('MRT_PARTNER_UNAUTHORIZED', { receipt: last });
      if (r.status === 403) fail('MRT_PARTNER_FORBIDDEN', { receipt: last });
      if (r.status === 429) fail('MRT_PARTNER_RATE_LIMITED', { receipt: last });
      let j = null; try { j = await r.json(); } catch {}
      if (!j) fail('MRT_PARTNER_NON_JSON', { receipt: last });
      // POST /v1/mylink answers 201 with result {status:201, code:'success'} (2026-10-05); both are success.
      const okStatus = s => s === 200 || s === 201;
      if (!okStatus(r.status) || (j.result && !okStatus(j.result.status))) fail(`MRT_PARTNER_${j.result?.code ?? 'HTTP_' + r.status}`, { receipt: last, reason: String(j.result?.message ?? '').slice(0, 200) });
      return { data: j.data ?? null, meta: j.meta ?? {}, receipt: last };
    }
    fail('MRT_PARTNER_FAILED', { receipt: last });
  }

  return {
    health: async () => (await call('GET', '/health')).receipt,
    commissionRates: async ({ category } = {}) => call('GET', '/v1/revenues/commission-rates', { query: { productCategory: category } }),
    revenues: async ({ from, to, type = 'SETTLEMENT', flight = false }) => call('GET', flight ? '/v1/revenues/flight' : '/v1/revenues', { query: { dateSearchType: type, startDate: from, endDate: to } }),
    reservations: async ({ from, to, type = 'RESERVATION_DATE', statuses, page = 1, size = 100 }) => call('GET', '/v1/reservations', { query: { dateSearchType: type, startDate: from, endDate: to, statuses, page, pageSize: size } }),
    tnaSearch: async ({ keyword, category, sort, min, max, page = 1, size = 20 }) => {
      if (!keyword) fail('MRT_PARTNER_INPUT');
      return call('POST', '/v1/products/tna/search', { body: { keyword, ...(category ? { category } : {}), ...(sort ? { sort } : {}), ...(min ? { minPrice: Number(min) } : {}), ...(max ? { maxPrice: Number(max) } : {}), page: Number(page), size: Number(size) } });
    },
    tnaDetail: async ({ gid }) => { if (!/^\d+$/.test(String(gid ?? ''))) fail('MRT_PARTNER_INPUT'); return call('POST', '/v1/products/tna/detail', { body: { gid: String(gid) } }); },
    mylink: async ({ url, approved = false }) => {
      if (approved !== true) fail('MRT_PARTNER_LINK_NEEDS_OWNER_APPROVAL');
      if (!MRT_TARGET.test(String(url ?? ''))) fail('MRT_PARTNER_INPUT');
      return call('POST', '/v1/mylink', { body: { targetUrl: url } });
    },
  };
}

function flags(argv) {
  const o = {};
  for (const a of argv) { const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a); if (m) o[m[1]] = m[2] ?? true; }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const api = createMyrealtripPartnerApi();
  const out = cmd === 'health' ? { receipt: await api.health() }
    : cmd === 'commission-rates' ? await api.commissionRates({ category: f.category })
    : cmd === 'revenues' ? await api.revenues({ from: f.from, to: f.to, type: f.type, flight: f.flight === true })
    : cmd === 'reservations' ? await api.reservations({ from: f.from, to: f.to, type: f.type, statuses: f.statuses, page: f.page, size: f.size })
    : cmd === 'tna-search' ? await api.tnaSearch({ keyword: f.keyword, category: f.category, sort: f.sort, min: f.min, max: f.max, page: f.page, size: f.size })
    : cmd === 'tna-detail' ? await api.tnaDetail({ gid: f.gid })
    : cmd === 'mylink' ? await api.mylink({ url: f.url, approved: f.approved === true })
    : fail('MRT_PARTNER_COMMAND');
  console.log(JSON.stringify({ ok: true, command: cmd, ...out }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code ?? 'MRT_PARTNER_FAILED', httpStatus: e.receipt?.httpStatus ?? null, reason: e.reason ?? null })); process.exitCode = 1; });
}
