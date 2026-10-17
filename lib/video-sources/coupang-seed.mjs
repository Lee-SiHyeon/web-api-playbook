import { createCdpPageFetcher } from './cdp-cookies.mjs';
import { parseCoupangDocument } from '../retail/coupang-public.mjs';

// Coupang seeds for the video pipeline. Plain Node GET of /np/search returns 403 (2026-10-17), so both the search
// Document and the product Document are read inside a www.coupang.com tab of the automation profile. The search
// listing is parsed with the existing retail parser; the product page supplies og:title / og:image (640x640).

const WWW = 'https://www.coupang.com';

export class CoupangSeedError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'CoupangSeedError'; this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new CoupangSeedError(code, detail); };

export function parseCoupangProductSeed(html, url) {
  if (typeof html !== 'string' || html.length < 2000) fail('COUPANG_PRODUCT_INVALID');
  const meta = key => (html.match(new RegExp(`<meta[^>]+property="og:${key}"[^>]+content="([^"]+)"`))
    || html.match(new RegExp(`<meta[^>]+content="([^"]+)"[^>]+property="og:${key}"`)) || [])[1] ?? null;
  const decode = s => s?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const rawTitle = decode(meta('title'));
  const title = rawTitle?.replace(/\s*\|\s*쿠팡\s*$/, '').replace(/\s+-\s+[^-]+$/, '').trim() || null;
  let image = meta('image');
  if (image?.startsWith('//')) image = `https:${image}`;
  try { if (image && !/^thumbnail\d*\.coupangcdn\.com$/.test(new URL(image).hostname)) image = null; } catch { image = null; }
  const productId = /\/vp\/products\/(\d+)/.exec(url)?.[1] ?? null;
  if (!title || !productId) fail('COUPANG_PRODUCT_SCHEMA_INVALID');
  return { source: 'coupang', productId, title, rawTitle, image, productUrl: `${WWW}/vp/products/${productId}` };
}

export function createCoupangSeedClient({ cdpEndpoint = 'http://127.0.0.1:9333', createFetcher = createCdpPageFetcher, now = Date.now, minIntervalMs = 3000 } = {}) {
  const tab = createFetcher({ endpoint: cdpEndpoint, pageOrigin: WWW, openUrl: `${WWW}/`, allowedRequestOrigins: [WWW], maxResponseBytes: 8 * 1024 * 1024 });
  let last = 0;
  const pace = async () => { const w = last + minIntervalMs - now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = now(); };
  return {
    async search({ keyword, includeSponsored = false } = {}) {
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100) fail('COUPANG_INPUT_INVALID');
      await pace();
      const url = `${WWW}/np/search?q=${encodeURIComponent(keyword.trim())}&channel=user`;
      const r = await tab.fetchText(url);
      if (r.status !== 200) fail('COUPANG_SEARCH_FAILED', { status: r.status });
      const doc = parseCoupangDocument(r.text, url);
      if (doc.kind !== 'retail_listing') fail('COUPANG_RETAIL_LISTING_MISSING');
      return { keyword: keyword.trim(), products: (doc.products ?? []).filter(p => includeSponsored || !p.sponsored),
        receipt: { method: 'GET', origin: WWW, path: '/np/search', transport: 'browser_tab_fetch', httpStatus: r.status, checkedAt: new Date(now()).toISOString() } };
    },
    async productSeed({ url } = {}) {
      let u;
      try { u = new URL(url); } catch { fail('COUPANG_INPUT_INVALID'); }
      if (u.origin !== WWW || !/^\/vp\/products\/\d+$/.test(u.pathname)) fail('COUPANG_INPUT_INVALID');
      await pace();
      const r = await tab.fetchText(u.href);
      if (r.status !== 200) fail('COUPANG_PRODUCT_FAILED', { status: r.status });
      return { ...parseCoupangProductSeed(r.text, u.href), receipt: { method: 'GET', origin: WWW, path: u.pathname, transport: 'browser_tab_fetch', httpStatus: r.status } };
    },
  };
}
