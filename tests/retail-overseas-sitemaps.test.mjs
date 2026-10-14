import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createOverseasSitemapClient } from '../lib/retail/overseas-sitemaps.mjs';

const resp = (status, body) => ({ status, arrayBuffer: async () => (typeof body === 'string' ? Buffer.from(body) : body) });
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
