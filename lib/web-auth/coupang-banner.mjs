// Coupang Partners official product banner (owner 2026-10-08: "쿠팡 일반 링크말고 배너발급 받아서 하는거" → "쓸수있게 만들어").
// Contract read from the portal's own client (https://partners.coupang.com/static/js/main.aefc650b.js, class ns + link
// generation page Xs): the search page sends the search result item as `product` with no group;
//   POST /api/v1/banner/iframe/url {product}                         → data {shortUrl, iframeHtmlTagBorderOn, iframeHtmlTagBorderOff, title, description, imageUrl}
//   POST /api/v1/banner/gen       {product, options:{border, shoppingButtonText}} → data {imageHtmlTag}   (the portal's "blogtag" option)
// The iframe call issues a tracking short URL (a write), so each product is issued once: a journal entry is written before
// the call, the result is cached, and an entry left without a result stops further attempts until it is reconciled.
// Session handling mirrors createCoupangAuth (coupang.mjs): same lock, owner check and filtered cookie persistence.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ScopedSession } from '../scoped-session.mjs';
import { ProtectedStore } from '../protected-store.mjs';
import { withSessionLock } from '../session-lock.mjs';
import { WebAuthError } from './myrealtrip.mjs';
import { coupangForbiddenCode } from './coupang-response.mjs';
import { assertCoupangOwnerBinding, COUPANG_AUTH_COOKIE_NAMES, COUPANG_PARTNERS_ORIGIN, COUPANG_ROUTING_COOKIE_NAMES,
  createCoupangServiceFetch, verifyCoupangBoundOwner } from './coupang-attested-session.mjs';

const ORIGIN = 'https://partners.coupang.com';
const ORIGINS = [ORIGIN, 'https://login.coupang.com'];
const NAME = 'coupang-web-state';
const fail = (code, extra = {}) => { throw Object.assign(new WebAuthError(code), extra); };
const DATA_DIR = path.join(process.env.LOCALAPPDATA ?? '.', 'affiliate-content-operations', 'coupang-partners');
export const BANNER_CACHE = path.join(DATA_DIR, 'banners.json');
const SHORT = /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/;
const ID = /^[1-9]\d{0,19}$/;

export function productKey(url) {
  let u; try { u = new URL(url); } catch { fail('BANNER_PRODUCT_URL_INVALID'); }
  const productId = /^\/vp\/products\/([1-9]\d{0,19})$/.exec(u.pathname)?.[1];
  const itemId = u.searchParams.get('itemId'), vendorItemId = u.searchParams.get('vendorItemId');
  if (u.origin !== 'https://www.coupang.com' || !productId || !ID.test(itemId ?? '') || !ID.test(vendorItemId ?? '')) fail('BANNER_PRODUCT_URL_INVALID');
  return { productId, itemId, vendorItemId, key: `${productId}:${itemId}:${vendorItemId}` };
}

// The banner fields the portal returns; HTML is kept as returned (it is the code the portal tells partners to paste).
export function parseBannerResponses(iframeData, imageData, key) {
  const shortUrl = iframeData?.shortUrl;
  if (!SHORT.test(shortUrl ?? '')) fail('BANNER_SHORT_URL_INVALID');
  const tag = v => (typeof v === 'string' && v.length <= 20000 ? v : null);
  // The portal stores the banner/gen payload itself as imageHtmlTag (reducer: link.imageHtmlTag = payload).
  const iframeOn = tag(iframeData.iframeHtmlTagBorderOn), iframeOff = tag(iframeData.iframeHtmlTagBorderOff), imageHtml = tag(typeof imageData === 'string' ? imageData : imageData?.imageHtmlTag);
  if (!iframeOn && !iframeOff) fail('BANNER_IFRAME_MISSING');
  const iframeSrc = /<iframe[^>]+src="([^"]+)"/i.exec(iframeOn ?? iframeOff)?.[1] ?? null;
  const imageSrc = imageHtml ? /<img[^>]+src="([^"]+)"/i.exec(imageHtml)?.[1] ?? null : null;
  const imageHref = imageHtml ? /<a[^>]+href="([^"]+)"/i.exec(imageHtml)?.[1] ?? null : null;
  const size = html => ({ width: Number(/width="(\d+)"/i.exec(html ?? '')?.[1]) || null, height: Number(/height="(\d+)"/i.exec(html ?? '')?.[1]) || null });
  return { key, shortUrl, title: iframeData.title ?? null, description: iframeData.description ?? null, productImageUrl: iframeData.imageUrl ?? null,
    iframe: { borderOn: iframeOn, borderOff: iframeOff, src: iframeSrc, ...size(iframeOn ?? iframeOff) },
    image: imageHtml ? { html: imageHtml, src: imageSrc, href: imageHref, hrefIsShortUrl: imageHref === shortUrl, ...size(imageHtml) } : null };
}

const readCache = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { schemaVersion: 1, banners: {} }; } };
const writeCache = (file, cache) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(cache, null, 2)); renameSync(file + '.tmp', file); };

export function createCoupangBanner({ store = new ProtectedStore(), fetchImpl = fetch, cacheFile = BANNER_CACHE } = {}) {
  const locked = fn => withSessionLock(fn, { root: path.join(store.directory, 'locks'), key: NAME });
  const serviceFetch = createCoupangServiceFetch(fetchImpl);
  const allowed = new Set([...COUPANG_AUTH_COOKIE_NAMES, ...COUPANG_ROUTING_COOKIE_NAMES]);
  const denied = new WeakSet();
  const safe = session => {
    const s = session.toJSON();
    if (!Array.isArray(s?.cookieJar?.cookies)) fail('AUTH_STATE_INVALID');
    s.cookieJar.cookies = s.cookieJar.cookies.filter(c => allowed.has(c?.key));
    return ScopedSession.fromJSON(s, { fetchImpl: serviceFetch });
  };
  const load = () => {
    const raw = store.read(NAME); if (!raw) fail('SESSION_MISSING');
    let state; try { state = JSON.parse(raw); } catch { fail('AUTH_STATE_INVALID'); }
    if (state.version === 1 && JSON.stringify(state.session?.allowedOrigins) === JSON.stringify(ORIGINS))
      return { state, session: ScopedSession.fromJSON(state.session, { fetchImpl: serviceFetch }) };
    if (state.version === 2 && JSON.stringify(state.session?.allowedOrigins) === JSON.stringify([COUPANG_PARTNERS_ORIGIN])) {
      const session = safe(ScopedSession.fromJSON(state.session, { fetchImpl: serviceFetch }));
      assertCoupangOwnerBinding(session, state);
      return { state, session };
    }
    fail('AUTH_STATE_INVALID');
  };
  const save = (state, session) => {
    if (denied.has(session)) return;
    let saved = session;
    if (state.version === 2) { saved = safe(session); assertCoupangOwnerBinding(saved, state); }
    store.write(NAME, JSON.stringify({ ...state, session: saved.toJSON(), updatedAt: new Date().toISOString() }));
  };
  const post = async (session, route, body) => {
    const r = await session.request(ORIGIN + route, body === undefined
      ? { method: 'GET', headers: { accept: 'application/json', lang: 'ko' } }
      : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', lang: 'ko' }, body: JSON.stringify(body) });
    if (r.status === 401) fail('REAUTH_REQUIRED');
    if (r.status === 403) { const code = coupangForbiddenCode(r); if (code === 'COUPANG_HTTP_ACCESS_DENIED') denied.add(session); fail(code); }
    if (r.status === 429) fail('AUTH_THROTTLED');
    if (r.status !== 200 || !/json/.test(r.headers['content-type'] ?? '')) fail('BANNER_RESPONSE_INVALID', { httpStatus: r.status });
    let b; try { b = JSON.parse(r.raw.toString('utf8')); } catch { fail('BANNER_RESPONSE_INVALID'); }
    if (b?.rCode !== '0') fail('BANNER_APPLICATION_REJECTED', { rMessage: String(b?.rMessage ?? '').slice(0, 200) });
    return b.data;
  };
  const owner = async (session, state) => {
    if (state.version === 2) { try { return await verifyCoupangBoundOwner(session, state); } catch (e) { denied.add(session); throw e; } }
    const r = await session.request(ORIGIN + '/api/v1/config');
    let b; try { b = JSON.parse(r.raw.toString('utf8')); } catch { fail('REAUTH_REQUIRED'); }
    if (b?.data?.affiliate?.affiliateCode !== state.affiliateCode) fail('OWNER_MISMATCH');
    return true;
  };

  // productUrl: the exact option; query: a search text that returns that option on the portal's first page.
  async function issue({ productUrl, query, border = true, shoppingButtonText = '쇼핑하기' }) {
    const target = productKey(productUrl);
    if (typeof query !== 'string' || !query.trim() || query.length > 120) fail('BANNER_QUERY_INVALID');
    return locked(async () => {
      const cache = readCache(cacheFile);
      const prior = cache.banners[target.key];
      if (prior?.status === 'issued' && prior.banner.image) return { ...prior.banner, cached: true };
      if (prior?.status === 'issued') {
        // Issued before the image payload was parsed: fetch only the blog image banner for the same product.
        const { state, session } = load();
        try {
          await owner(session, state);
          const found = await post(session, '/api/v1/search', { page: { pageNumber: 0, size: 36 }, filter: query.trim(), deliveryTypes: [] });
          const product = (found?.products ?? []).find(p => String(p?.productId) === target.productId && String(p?.itemId) === target.itemId && String(p?.vendorItemId) === target.vendorItemId);
          if (!product) fail('BANNER_PRODUCT_NOT_IN_SEARCH');
          const imageData = await post(session, '/api/v1/banner/gen', { product, options: { border, shoppingButtonText } });
          const image = parseBannerResponses({ ...prior.banner, iframeHtmlTagBorderOn: prior.banner.iframe.borderOn, iframeHtmlTagBorderOff: prior.banner.iframe.borderOff, imageUrl: prior.banner.productImageUrl }, imageData, target.key).image;
          const banner = { ...prior.banner, image };
          cache.banners[target.key] = { status: 'issued', banner };
          writeCache(cacheFile, cache);
          return { ...banner, cached: false };
        } finally { save(state, session); }
      }
      if (prior?.status === 'started') fail('BANNER_OUTCOME_UNCERTAIN_RECONCILE_FIRST');
      const { state, session } = load();
      try {
        await owner(session, state);
        const found = await post(session, '/api/v1/search', { page: { pageNumber: 0, size: 36 }, filter: query.trim(), deliveryTypes: [] });
        const product = (found?.products ?? []).find(p => String(p?.productId) === target.productId && String(p?.itemId) === target.itemId && String(p?.vendorItemId) === target.vendorItemId);
        if (!product) fail('BANNER_PRODUCT_NOT_IN_SEARCH');
        cache.banners[target.key] = { status: 'started', productUrl, at: new Date().toISOString() };
        writeCache(cacheFile, cache);
        let iframeData, imageData;
        try {
          iframeData = await post(session, '/api/v1/banner/iframe/url', { product });
          imageData = await post(session, '/api/v1/banner/gen', { product, options: { border, shoppingButtonText } });
        } catch (e) { e.bannerOutcome = 'uncertain'; throw e; }
        const banner = { ...parseBannerResponses(iframeData, imageData, target.key), productUrl, affiliateCode: state.affiliateCode, issuedAt: new Date().toISOString() };
        cache.banners[target.key] = { status: 'issued', banner };
        writeCache(cacheFile, cache);
        return { ...banner, cached: false };
      } finally { save(state, session); }
    });
  }
  // Owner-verified portal calls under the session lock: call(route) is a GET, call(route, body) a JSON POST; both return data.
  async function portal(fn) {
    return locked(async () => {
      const { state, session } = load();
      try {
        await owner(session, state);
        return await fn({ call: (route, body) => post(session, route, body), affiliateCode: state.affiliateCode });
      } finally { save(state, session); }
    });
  }
  return { issue, portal, cacheFile, cached: url => readCache(cacheFile).banners[productKey(url).key] ?? null };
}
