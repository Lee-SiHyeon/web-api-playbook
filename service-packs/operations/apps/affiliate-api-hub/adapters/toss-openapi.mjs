// 토스쇼핑 쉐어링크 Open API client (https://sharelink-docs.toss.im, 2026-09-30 docs).
//   node toss-openapi.mjs health | best [size] | today-deals [size] | categories | category-best <categoryId> [size]
//                         | detail <tacaItemId,...> | link <tacaItemId> | performance <YYYY-MM-DD> <YYYY-MM-DD>
// Keys live only in the DPAPI ProtectedStore record `toss-sharelink-openapi` (accessKey, secretKey, memberLinkId); the
// client_credentials token (valid ~1 year) is cached in the same record and reused. Nothing secret is printed.
// Terms: SNS/blog posting is allowed; a price-comparison site or a stored commerce catalogue is not, and price crawling is
// restricted — use list/detail reads for the posts being written, not as a price database.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { webApiPlaybookRoot } from './web-auth-provider.mjs';
const PLAYBOOK = webApiPlaybookRoot();
const BASE = 'https://sharelink.toss.im/openapi';
const TOKEN_URL = 'https://oauth2.cert.toss.im/token';
const STORE_NAME = 'toss-sharelink-openapi';
const LINK_CACHE = path.join(process.env.LOCALAPPDATA ?? '.', 'affiliate-content-operations', 'toss-openapi', 'links.json');
const RENEW_BEFORE_MS = 7 * 86400e3;
export const TOSS_SHORT_LINK = /^https:\/\/(?:toss\.im|toss\.shopping)\/_m\/[A-Za-z0-9_-]+$/;

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };

async function defaultStore() {
  const { ProtectedStore } = await import(pathToFileURL(path.join(PLAYBOOK, 'lib', 'protected-store.mjs')).href);
  return new ProtectedStore();
}

export function createTossOpenApi({ store = null, fetchImpl = globalThis.fetch, now = () => Date.now(), linkCacheFile = LINK_CACHE } = {}) {
  let storeP = store ? Promise.resolve(store) : null;
  const getStore = () => (storeP ??= defaultStore());
  const readRecord = async () => {
    let raw; try { raw = (await getStore()).read(STORE_NAME); } catch { fail('TOSS_OPENAPI_KEYS_MISSING'); }
    const r = JSON.parse(raw);
    if (!r?.accessKey || !r?.secretKey || !r?.memberLinkId) fail('TOSS_OPENAPI_KEYS_MISSING');
    return r;
  };

  async function token() {
    const rec = await readRecord();
    if (rec.token && Date.parse(rec.tokenExpiresAt) - now() > RENEW_BEFORE_MS) return rec.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: rec.accessKey, client_secret: rec.secretKey, scope: 'sharelink:read sharelink:write' });
    const r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(20000) });
    let j = null; try { j = await r.json(); } catch {}
    if (r.status !== 200 || typeof j?.access_token !== 'string' || !Number.isFinite(j?.expires_in)) fail('TOSS_OPENAPI_TOKEN_FAILED', { httpStatus: r.status });
    const next = { ...rec, token: j.access_token, tokenScope: j.scope ?? null, tokenExpiresAt: new Date(now() + j.expires_in * 1000).toISOString(), tokenIssuedAt: new Date(now()).toISOString() };
    (await getStore()).write(STORE_NAME, JSON.stringify(next));
    return next.token;
  }

  async function call(p, { method = 'GET', query = null, body = null } = {}) {
    const url = new URL(BASE + p);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const r = await fetchImpl(url, { method, headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const receipt = { method, path: url.pathname, httpStatus: r.status, checkedAt: new Date(now()).toISOString() };
    if (r.status === 401) fail('TOSS_OPENAPI_UNAUTHORIZED', { receipt });
    if (r.status === 403) fail('TOSS_OPENAPI_FORBIDDEN', { receipt });
    if (r.status === 429) fail('TOSS_OPENAPI_RATE_LIMITED', { receipt, retryAfter: r.headers.get('retry-after') });
    let j = null; try { j = await r.json(); } catch {}
    if (!j) fail('TOSS_OPENAPI_NON_JSON', { receipt });
    // HTTP 200 can still be a failure: resultType FAIL with error.errorCode (IP not allowed, quota, invalid argument).
    if (j.resultType !== 'SUCCESS') fail(`TOSS_OPENAPI_${j.error?.errorCode ?? 'FAIL'}`, { receipt, reason: String(j.error?.reason ?? '').slice(0, 200) });
    return { data: j.success, receipt };
  }

  const card = i => ({ tacaItemId: i.tacaItemId, tacaId: i.tacaId ?? null, title: i.displayName, price: i.displayPrice, originalPrice: i.originalPrice ?? null,
    discountRate: i.discountRate ?? null, soldOut: i.isSoldOut === true ? true : i.isSoldOut === false ? false : null,
    rating: i.reviewScore ?? null, reviewCount: i.reviewCount ?? null,
    categoryIds: i.categoryIds ?? [], productUrl: i.productUrl ?? null, rank: i.rank ?? null, priceIncludesShipping: true,
    // The seller's thumbnail (shopping.toss.im), used as the product photo in quick-fact posts.
    image: /^https:\/\/shopping\.toss\.im\//.test(String(i.thumbnailUrl ?? '')) ? i.thumbnailUrl : null });
  const list = async (p, query) => { const { data, receipt } = await call(p, { query }); return { items: (data.items ?? []).map(card), nextCursor: data.nextCursor ?? null, hasNext: data.hasNext === true ? true : data.hasNext === false ? false : null, receipt }; };

  const readLinks = () => { try { return JSON.parse(readFileSync(linkCacheFile, 'utf8')); } catch { return {}; } };

  return {
    health: async () => (await call('/health')).data,
    bestSelling: ({ size = 30, cursor } = {}) => list('/products/best-selling', { size, cursor }),
    todayDeals: ({ size = 30, cursor } = {}) => list('/products/today-deals', { size, cursor }),
    categoryBest: (categoryId, { size = 30, cursor } = {}) => list(`/products/best-categories/${Number(categoryId)}`, { size, cursor }),
    categories: async () => (await call('/categories')).data,
    detail: async ids => {
      const clean = [...new Set(ids.map(String))];
      if (!clean.length || clean.length > 30 || clean.some(x => !/^\d+$/.test(x))) fail('TOSS_OPENAPI_INPUT');
      const { data, receipt } = await call('/products/detail', { query: { tacaItemIds: clean.join(',') } });
      return { items: (data.items ?? []).map(card), notFoundIds: data.notFoundIds ?? [], receipt };
    },
    // Issuing is idempotent per tacaItemId (same link back, no quota); the local cache still avoids repeat calls.
    link: async tacaItemId => {
      const id = String(tacaItemId);
      if (!/^\d+$/.test(id)) fail('TOSS_OPENAPI_INPUT');
      const cache = readLinks();
      if (cache[id]?.shortUrl) return { ...cache[id], cached: true };
      const { memberLinkId } = await readRecord();
      const { data, receipt } = await call('/links', { method: 'POST', body: { tacaItemId: Number(id), publisherId: memberLinkId } });
      // Docs show toss.im/_m/…; issued links observed on 2026-09-28 were toss.shopping/_m/…. Both are tracking links.
      if (!TOSS_SHORT_LINK.test(String(data.shortUrl ?? ''))) fail('TOSS_OPENAPI_LINK_SCHEMA', { receipt, shortUrlHost: (() => { try { return new URL(data.shortUrl).host; } catch { return null; } })() });
      const entry = { tacaItemId: Number(id), shortUrl: data.shortUrl, issuedAt: receipt.checkedAt };
      mkdirSync(path.dirname(linkCacheFile), { recursive: true });
      writeFileSync(linkCacheFile, JSON.stringify({ ...readLinks(), [id]: entry }, null, 2));
      return { ...entry, cached: false };
    },
    performance: async (fromDate, toDate, { size = 50, cursor } = {}) => (await call('/performance', { query: { fromDate, toDate, size, cursor } })).data,
  };
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const api = createTossOpenApi();
  const out = cmd === 'health' ? await api.health()
    : cmd === 'best' ? await api.bestSelling({ size: Number(a ?? 30) })
    : cmd === 'today-deals' ? await api.todayDeals({ size: Number(a ?? 30) })
    : cmd === 'categories' ? await api.categories()
    : cmd === 'category-best' ? await api.categoryBest(a, { size: Number(b ?? 30) })
    : cmd === 'detail' ? await api.detail(String(a ?? '').split(','))
    : cmd === 'link' ? await api.link(a)
    : cmd === 'performance' ? await api.performance(a, b)
    : fail('TOSS_OPENAPI_COMMAND');
  console.log(JSON.stringify({ ok: true, command: cmd, ...out }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code ?? 'TOSS_OPENAPI_FAILED', httpStatus: e.receipt?.httpStatus ?? e.httpStatus ?? null, reason: e.reason ?? null, shortUrlHost: e.shortUrlHost ?? undefined })); process.exitCode = 1; });
}
