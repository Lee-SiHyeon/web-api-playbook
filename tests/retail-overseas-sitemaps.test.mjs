import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createOverseasSitemapClient } from '../lib/retail/overseas-sitemaps.mjs';

const resp = (status, body) => new Response(body, { status, headers: { 'content-type': 'application/xml' } });
const opts = (map, calls = []) => ({ minIntervalMs: 0, fetchImpl: async (u) => { calls.push(u); const v = map[new URL(u).pathname]; return v ? resp(...v) : resp(404, ''); } });

test('iherb sitemap index -> product ids', async () => {
  const c = createOverseasSitemapClient('iherb', opts({
    '/sitemap_index.xml': [200, '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.iherb.com/sitemaps/products-0-www-0.xml</loc><lastmod>2026-10-12</lastmod></sitemap><sitemap><loc>https://www.iherb.com/sitemaps/blog-0-www-0.xml</loc></sitemap></sitemapindex>'],
    '/sitemaps/products-0-www-0.xml': [200, '<?xml version="1.0"?><urlset><url><loc>https://www.iherb.com/pr/doctor-s-best-5-htp/1</loc><lastmod>2026-10-12</lastmod></url></urlset>'],
  }));
  const shards = await c.listShards();
  assert.deepEqual(shards.map(s => s.path), ['/sitemaps/products-0-www-0.xml']);
  const items = await c.listProducts(shards[0].path);
  assert.equal(items[0].externalProductId, '1');
  assert.equal(items[0].slug, 'doctor-s-best-5-htp');
});

test('aliexpress gz shard parsed', async () => {
  const c = createOverseasSitemapClient('aliexpress', opts({
    '/sitemap/en-https-item-item-2026-P0-0.xml.gz': [200, gzipSync('<?xml version="1.0"?><urlset><url><loc>https://www.aliexpress.com/item/10000000214274.html</loc></url></urlset>')],
  }));
  const items = await c.listProducts('/sitemap/en-https-item-item-2026-P0-0.xml.gz');
  assert.equal(items[0].externalProductId, '10000000214274');
});

test('403 stops client permanently and challenge page stops', async () => {
  const calls = [];
  const c = createOverseasSitemapClient('iherb', opts({ '/sitemap_index.xml': [403, 'no'] }, calls));
  await assert.rejects(c.listShards(), { code: 'HTTP_403' });
  await assert.rejects(c.listShards(), { code: 'STOPPED' });
  assert.equal(calls.length, 1);
  const d = createOverseasSitemapClient('iherb', opts({ '/sitemap_index.xml': [200, '<html>Just a moment...</html>'] }));
  await assert.rejects(d.listShards(), { code: 'CHALLENGE' });
});

test('temu/shein unsupported and foreign paths refused', async () => {
  assert.throws(() => createOverseasSitemapClient('temu'), { code: 'SOURCE_UNSUPPORTED' });
  assert.throws(() => createOverseasSitemapClient('shein'), { code: 'SOURCE_UNSUPPORTED' });
  const c = createOverseasSitemapClient('iherb', opts({}));
  await assert.rejects(c.listProducts('/pr/x/1'), { code: 'PATH_NOT_ALLOWED' });
});

test('page continuation reports the remaining shard instead of treating a limit as completion', async () => {
  const c = createOverseasSitemapClient('iherb', opts({
    '/sitemaps/products-0-www-0.xml': [200, '<urlset><url><lastmod>2026-10-12</lastmod><loc>https://www.iherb.com/pr/a/1</loc></url><url><loc>https://www.iherb.com/pr/b/2</loc></url><url><loc>https://www.iherb.com/pr/b/2</loc></url></urlset>'],
  }));
  const first = await c.listProductsPage('/sitemaps/products-0-www-0.xml', { limit: 1 });
  assert.equal(first.items[0].lastmod, '2026-10-12');
  assert.equal(first.totalInShard, 2);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.shardComplete, false);
  const second = await c.listProductsPage('/sitemaps/products-0-www-0.xml', { limit: 1, offset: first.nextOffset });
  assert.equal(second.items[0].externalProductId, '2');
  assert.equal(second.nextOffset, null);
  assert.equal(second.shardComplete, true);
  assert.equal(second.completeCatalog, false);
  assert.equal(second.priceVerified, false);
  assert.equal(c.getReceipts().length, 2);
  assert.equal(c.getReceipts()[0].httpStatus, 200);
  await assert.rejects(c.listProductsPage('/sitemaps/products-0-www-0.xml', { offset: 2 }), { code: 'PAGE_OUT_OF_RANGE' });
  await assert.rejects(c.listProductsPage('/sitemaps/products-0-www-0.xml', { offset: 1, expectedSnapshotSha256: '0'.repeat(64) }),
    { code: 'SITEMAP_SNAPSHOT_CHANGED' });
});

test('invalid paging and credential-bearing/query URLs fail before any request', async () => {
  const calls = [];
  const c = createOverseasSitemapClient('iherb', opts({}, calls));
  for (const options of [{limit: 0}, {limit: 1001}, {offset: -1}, {offset: 0.5}]) {
    await assert.rejects(c.listProductsPage('/sitemaps/products-0-www-0.xml', options), { code: 'PAGE_INVALID' });
  }
  await assert.rejects(c.listProducts('/sitemaps/products-0-www-0.xml?token=private'), { code: 'PATH_NOT_ALLOWED' });
  await assert.rejects(c.listProducts('https://user:pass@www.iherb.com/sitemaps/products-0-www-0.xml'), { code: 'PATH_NOT_ALLOWED' });
  assert.equal(calls.length, 0);
});

test('bounded streams, bounded decompression and unsafe XML fail closed', async () => {
  const c = createOverseasSitemapClient('iherb', { ...opts({ '/sitemap_index.xml': [200, 'x'.repeat(128)] }), maxBytes: 64 });
  await assert.rejects(c.listShards(), { code: 'TOO_LARGE' });
  const d = createOverseasSitemapClient('aliexpress', { ...opts({
    '/sitemap/en-https-item-item-2026-P0-0.xml.gz': [200, gzipSync('x'.repeat(1000))],
  }), maxBytes: 128 });
  await assert.rejects(d.listProducts('/sitemap/en-https-item-item-2026-P0-0.xml.gz'), { code: 'GZIP_INVALID_OR_TOO_LARGE' });
  const e = createOverseasSitemapClient('iherb', opts({ '/sitemap_index.xml': [200, '<?xml version="1.0"?><!DOCTYPE sitemapindex><sitemapindex/>'] }));
  await assert.rejects(e.listShards(), { code: 'XML_INVALID' });
  const f = createOverseasSitemapClient('iherb', opts({ '/sitemaps/products-0-www-0.xml': [200, '<urlset><url><loc>https://other.test/pr/a/1</loc></url></urlset>'] }));
  await assert.rejects(f.listProductsPage('/sitemaps/products-0-www-0.xml'), { code: 'SITEMAP_PRODUCT_SCHEMA_CHANGED' });
});
