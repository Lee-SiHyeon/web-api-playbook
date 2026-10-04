import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCoupangFlashSaleInventory } from '../scripts/coupang-flash-sale-inventory.mjs';

const nativeFetch = globalThis.fetch;

test('flash-sale inventory stops on its first 403 and does not rotate visitors or retry', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('{"message":"blocked"}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const { report } = await collectCoupangFlashSaleInventory({ maxPages: 5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.equal(report.stopReason, 'http_403');
    assert.equal(report.pagesRequested, 1);
    assert.equal(report.requestPolicy.automaticRetry, false);
    assert.equal(report.requestPolicy.visitorContextUsed, false);
    assert.equal(report.complete, false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('flash-sale inventory keeps empty successful traversal distinct from price coverage', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ rCode: 'RET0000', rData: {
      curPage: 1, hasNextPage: false, totalCount: 0, categoryFilterList: [], productList: [],
    } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const { report } = await collectCoupangFlashSaleInventory({ maxPages: 1 });
    assert.equal(calls, 1);
    assert.equal(report.complete, true);
    assert.equal(report.inventoryTraversalComplete, true);
    assert.equal(report.observedPriceCoverageComplete, false);
    assert.equal(report.priceCoverageComplete, false);
    assert.equal(report.counts.uniqueTriples, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});