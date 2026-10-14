import { gunzipSync } from 'node:zlib';

/**
 * Keyless, read-only product discovery from public sitemaps (2026-10-14 probe).
 * - aliexpress: robots.txt -> item sitemap index -> .xml.gz shards (product id + lastmod).
 * - iherb: /sitemap_index.xml -> products-*.xml (slug + product id + lastmod).
 * - temu, shein: sitemap index returned 403 / bot page; not supported.
 * No price, stock or currency: sitemaps carry identity only. Requests are paced,
 * sent without cookies, and any 403/429/challenge page stops the client for good.
 */
const SOURCES = {
  aliexpress: {
    origin: 'https://www.aliexpress.com',
    indexes: [
      '/sitemap/en-https-item-item-2026-P0-sitemap-index.xml',
      '/sitemap/en-https-item-item-2026-P1-sitemap-index.xml',
    ],
    shard: /^\/sitemap\/en-https-item-item-[\w-]+\.xml(\.gz)?$/,
    product: /^https:\/\/www\.aliexpress\.com\/item\/([0-9]{8,20})\.html$/,
  },
  iherb: {
    origin: 'https://www.iherb.com',
    indexes: ['/sitemap_index.xml'],
    shard: /^\/sitemaps\/products-[\w-]+\.xml$/,
    product: /^https:\/\/www\.iherb\.com\/pr\/([a-z0-9-]{1,200})\/([0-9]{1,12})$/,
  },
};
export const UNSUPPORTED_KEYLESS = Object.freeze({
  temu: 'sitemap-index 403 (2026-10-14); official publisher API unverified',
  shein: 'sitemap-index 403 bot page (2026-10-14); use Awin feed after join',
});

export class OverseasSitemapError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'OverseasSitemapError'; this.code = code; this.detail = detail; }
}
const CHALLENGE = /just a moment|challenges\.cloudflare|captcha|punish|x5sec|access denied/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

function locs(xml) {
  const out = [];
  const re = /<(url|sitemap)>\s*<loc>([^<]{1,2000})<\/loc>(?:\s*<lastmod>([^<]{1,40})<\/lastmod>)?/g;
  let m;
  while ((m = re.exec(xml))) out.push({ loc: m[2].trim(), lastmod: m[3]?.trim() ?? null });
  return out;
}

export function createOverseasSitemapClient(source, { fetchImpl = fetch, minIntervalMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, maxBytes = 32 * 1024 * 1024 } = {}) {
  const cfg = SOURCES[source];
  if (!cfg) throw new OverseasSitemapError('SOURCE_UNSUPPORTED', UNSUPPORTED_KEYLESS[source] ?? source);
  let last = 0; let stopped = null;

  async function get(path) {
    if (stopped) throw new OverseasSitemapError('STOPPED', stopped);
    const url = new URL(path, cfg.origin);
    if (url.origin !== cfg.origin || !(cfg.indexes.includes(url.pathname) || cfg.shard.test(url.pathname))) throw new OverseasSitemapError('PATH_NOT_ALLOWED', url.pathname);
    const wait = last + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    const res = await fetchImpl(url.href, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'application/xml,text/xml,*/*' } });
    if (res.status !== 200) {
      if ([401, 403, 429].includes(res.status)) stopped = `HTTP_${res.status} ${url.pathname}`;
      throw new OverseasSitemapError(`HTTP_${res.status}`, url.pathname);
    }
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new OverseasSitemapError('TOO_LARGE', url.pathname);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf, { maxOutputLength: maxBytes });
    const text = buf.toString('utf8');
    if (!/^\s*<\?xml|^\s*<(urlset|sitemapindex)/.test(text) || CHALLENGE.test(text.slice(0, 4000)) && !/<(urlset|sitemapindex)/.test(text.slice(0, 400))) {
      stopped = `CHALLENGE ${url.pathname}`;
      throw new OverseasSitemapError('CHALLENGE', url.pathname);
    }
    return text;
  }

  return {
    source,
    async listShards() {
      const shards = [];
      for (const index of cfg.indexes) {
        for (const e of locs(await get(index))) {
          const u = new URL(e.loc);
          if (u.origin === cfg.origin && cfg.shard.test(u.pathname)) shards.push({ path: u.pathname, lastmod: e.lastmod });
        }
      }
      return shards;
    },
    async listProducts(shardPath, { limit = 1000 } = {}) {
      const items = [];
      for (const e of locs(await get(shardPath))) {
        const m = cfg.product.exec(e.loc);
        if (!m) continue;
        items.push(source === 'iherb'
          ? { source, externalProductId: m[2], slug: m[1], url: e.loc, lastmod: e.lastmod }
          : { source, externalProductId: m[1], url: e.loc, lastmod: e.lastmod });
        if (items.length >= limit) break;
      }
      return items;
    },
  };
}
