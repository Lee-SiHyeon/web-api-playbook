import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DOMParser } from 'linkedom';

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
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new OverseasSitemapError('XML_INVALID');
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  if (!['urlset', 'sitemapindex'].includes(document.documentElement?.localName)) throw new OverseasSitemapError('XML_INVALID');
  return [...document.documentElement.children].filter(node => ['url', 'sitemap'].includes(node.localName))
    .map(node => ({ loc: [...node.children].find(child => child.localName === 'loc')?.textContent?.trim(),
      lastmod: [...node.children].find(child => child.localName === 'lastmod')?.textContent?.trim() ?? null }))
    .filter(row => typeof row.loc === 'string' && row.loc.length > 0 && row.loc.length <= 2000
      && (row.lastmod === null || row.lastmod.length <= 40));
}

export function createOverseasSitemapClient(source, { fetchImpl = fetch, minIntervalMs = 5000, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, maxBytes = 32 * 1024 * 1024 } = {}) {
  const cfg = SOURCES[source];
  if (!cfg) throw new OverseasSitemapError('SOURCE_UNSUPPORTED', UNSUPPORTED_KEYLESS[source] ?? source);
  if (typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new OverseasSitemapError('OPTIONS_INVALID');
  let last = 0; let stopped = null;
  const receipts = [];

  async function get(path) {
    if (stopped) throw new OverseasSitemapError('STOPPED', stopped);
    const url = new URL(path, cfg.origin);
    if (url.origin !== cfg.origin || url.username || url.password || url.search || url.hash
      || !(cfg.indexes.includes(url.pathname) || cfg.shard.test(url.pathname))) throw new OverseasSitemapError('PATH_NOT_ALLOWED', url.pathname);
    const wait = last + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    const receipt = { method: 'GET', origin: cfg.origin, path: url.pathname, checkedAt: new Date(now()).toISOString(),
      browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false };
    receipts.push(receipt);
    let res;
    try { res = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit',
      headers: { 'user-agent': UA, accept: 'application/xml,text/xml,*/*' }, signal: AbortSignal.timeout(20_000) }); }
    catch { throw new OverseasSitemapError('TRANSPORT_FAILED', url.pathname); }
    receipt.httpStatus = res.status;
    receipt.mime = res.headers?.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    if (res.status !== 200) {
      if ([401, 403, 429].includes(res.status)) stopped = `HTTP_${res.status} ${url.pathname}`;
      await res.body?.cancel().catch(() => {});
      throw new OverseasSitemapError(`HTTP_${res.status}`, url.pathname);
    }
    if (!res.body?.getReader) throw new OverseasSitemapError('BODY_UNREADABLE', url.pathname);
    const reader = res.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw new OverseasSitemapError('TOO_LARGE', url.pathname); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let buf = Buffer.concat(chunks, bytes);
    receipt.responseBytes = buf.length;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      try { buf = gunzipSync(buf, { maxOutputLength: maxBytes }); }
      catch { throw new OverseasSitemapError('GZIP_INVALID_OR_TOO_LARGE', url.pathname); }
    }
    receipt.decodedBytes = buf.length;
    const text = buf.toString('utf8');
    if (!/^\s*<\?xml|^\s*<(urlset|sitemapindex)/.test(text) || CHALLENGE.test(text.slice(0, 4000)) && !/<(urlset|sitemapindex)/.test(text.slice(0, 400))) {
      stopped = `CHALLENGE ${url.pathname}`;
      throw new OverseasSitemapError('CHALLENGE', url.pathname);
    }
    return text;
  }

  async function productsPage(shardPath, { limit = 1000, offset = 0, expectedSnapshotSha256 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset)
      || offset < 0 || offset > 1_000_000 || expectedSnapshotSha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(expectedSnapshotSha256)) throw new OverseasSitemapError('PAGE_INVALID');
    const xml = await get(shardPath);
    const snapshotSha256 = createHash('sha256').update(xml).digest('hex');
    if (expectedSnapshotSha256 !== undefined && expectedSnapshotSha256 !== snapshotSha256)
      throw new OverseasSitemapError('SITEMAP_SNAPSHOT_CHANGED', shardPath);
    const entries = locs(xml);
    const all = new Map();
    for (const e of entries) {
      const m = cfg.product.exec(e.loc);
      if (!m) continue;
      const row = source === 'iherb'
        ? { source, externalProductId: m[2], slug: m[1], url: e.loc, lastmod: e.lastmod }
        : { source, externalProductId: m[1], url: e.loc, lastmod: e.lastmod };
      all.set(row.externalProductId, row);
    }
    if (!all.size) throw new OverseasSitemapError('SITEMAP_PRODUCT_SCHEMA_CHANGED', shardPath);
    if (offset >= all.size) throw new OverseasSitemapError('PAGE_OUT_OF_RANGE');
    const items = [...all.values()].slice(offset, offset + limit);
    const nextOffset = offset + items.length < all.size ? offset + items.length : null;
    return { items, shardPath, offset, limit, snapshotSha256, totalInShard: all.size, nextOffset, shardComplete: nextOffset === null,
      completeCatalog: false, receipt: { ...receipts.at(-1), schemaVerified: true },
      coverage: 'public_product_identity_and_lastmod_only', priceVerified: false, stockVerified: false };
  }

  return {
    source,
    getReceipts() { return receipts.map(receipt => ({ ...receipt })); },
    async listShards() {
      const shards = [];
      for (const index of cfg.indexes) {
        for (const e of locs(await get(index))) {
          let u;
          try { u = new URL(e.loc); } catch { continue; }
          if (u.origin === cfg.origin && !u.username && !u.password && !u.search && !u.hash && cfg.shard.test(u.pathname)
            && !shards.some(row => row.path === u.pathname)) shards.push({ path: u.pathname, lastmod: e.lastmod });
        }
      }
      return shards;
    },
    async listProducts(shardPath, options) { return (await productsPage(shardPath, options)).items; },
    listProductsPage: productsPage,
  };
}
