import test from 'node:test';
import assert from 'node:assert/strict';
import { readShoppingProducts } from '../adapters/shopping-products.mjs';

function partnerResult({ reviewCount = 42 } = {}) {
  return {
    products: [{ productId: 'p-1', itemId: 'i-1', vendorItemId: 'v-1', title: 'Sample product',
      price: 12000, reviewCount, freeShipping: true, url: 'https://www.coupang.com/vp/products/p-1' }],
    total: 1,
    receipt: { credentialPropagated: true, checkedAt: '2026-09-28T00:00:00.000Z' },
  };
}

test('consumer Coupang stays blocked without calling the partner reader or HTTP', async () => {
  let partnerCalls = 0, httpCalls = 0;
  const result = await readShoppingProducts({ query: 'sample', sources: ['coupang'],
    coupangRead: async () => { partnerCalls++; return partnerResult(); },
    fetchImpl: async () => { httpCalls++; throw new Error('unexpected HTTP'); } });

  assert.equal(partnerCalls, 0);
  assert.equal(httpCalls, 0);
  assert.deepEqual(result.requestedSources, ['coupang']);
  assert.equal(result.sites.coupang.status, 'error');
  assert.equal(result.sites.coupang.error, 'COUPANG_CONSUMER_SEARCH_BLOCKED');
  assert.equal(result.sites.coupang.count, 0);
  assert.equal(result.sites.coupang.states.live_replay, false);
  assert.equal(result.ok, false);
  assert.equal(result.partial, false);
  assert.equal(result.execution, 'not_attempted');
  assert.equal(result.count, 0);
});

test('explicit coupang-partners calls the partner reader and preserves its source scope', async () => {
  let partnerCalls = 0, httpCalls = 0;
  const result = await readShoppingProducts({ query: 'sample', sources: ['coupang-partners'],
    coupangRead: async input => { partnerCalls++; assert.equal(input.query, 'sample'); return partnerResult(); },
    fetchImpl: async () => { httpCalls++; throw new Error('unexpected HTTP'); } });

  assert.equal(partnerCalls, 1);
  assert.equal(httpCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.sites['coupang-partners'].sourceScope, 'partners_web_catalog_first_page');
  assert.equal(result.items[0].source, 'coupang-partners');
  assert.equal(result.items[0].mall, 'coupang-partners');
  assert.match(result.items[0].id, /^coupang-partners:/);
});

test('consumer failure plus explicit partner success is an incomplete result', async () => {
  let partnerCalls = 0;
  const result = await readShoppingProducts({ query: 'sample', sources: ['coupang', 'coupang-partners'],
    coupangRead: async () => { partnerCalls++; return partnerResult(); },
    fetchImpl: async () => { throw new Error('unexpected HTTP'); } });

  assert.equal(partnerCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.deepEqual(result.failedSources, ['coupang']);
  assert.equal(result.sites.coupang.status, 'error');
  assert.equal(result.sites['coupang-partners'].status, 'ok');
  assert.equal(result.count, 1);
});

test('partner reviewCount remains partner metadata and never becomes consumer reviews', async () => {
  const result = await readShoppingProducts({ query: 'sample', sources: ['coupang-partners'],
    coupangRead: async () => partnerResult({ reviewCount: 1234 }) });

  assert.equal(result.items[0].reviews, null);
  assert.equal(result.items[0].reviewCount, undefined);
  assert.equal(result.items[0].partnerMetadata.reviewCount, 1234);
});
