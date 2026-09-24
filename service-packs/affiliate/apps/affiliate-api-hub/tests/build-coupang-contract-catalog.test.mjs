import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, classifyCapability } from '../scripts/build-coupang-contract-catalog.mjs';

test('catalog merges live and bundle evidence without becoming executable', () => {
  const netlog = { observedRequests: [{
    origin: 'https://partners.coupang.com', path: '/api/v1/search', methods: ['POST'],
    queryFields: [], statuses: [200], requestObserved: true, responseObserved: true,
  }] };
  const scripts = { candidates: [{
    origin: 'https://partners.coupang.com', path: '/api/v1/search', methods: ['POST'], queryFields: ['keyword'],
  }, {
    origin: 'https://partners.coupang.com', path: '/api/v1/url/any', methods: ['POST'], queryFields: ['coupangUrl'],
  }] };
  const shapes = { shapes: [{ path: '/api/v1/search', method: 'POST', bodyFields: ['filter', 'page.pageNumber'],
    queryFields: [], pathParameters: [], filterColumns: [], confidence: 'public_bundle_direct_call', valuesObserved: false }] };
  const record = buildCatalog(netlog, scripts, shapes, { now: () => new Date('2026-09-19T00:00:00Z') });
  assert.equal(record.contractCount, 2);
  const search = record.contracts.find(item => item.path === '/api/v1/search');
  assert.equal(search.liveObserved, true);
  assert.equal(search.response200Verified, true);
  assert.deepEqual(search.methodsObserved, ['POST']);
  assert.deepEqual(search.queryFields, ['keyword']);
  assert.deepEqual(search.bodyFieldHints, ['filter', 'page.pageNumber']);
  assert.equal(search.bodySchemaHinted, true);
  assert.equal(search.executable, false);
  assert.equal(record.sessionReuse.cookieValuesCopied, false);
  assert.equal(record.sessionReuse.sessionTokenValuesCopied, false);
});

test('capability classifier separates core affiliate families', () => {
  assert.equal(classifyCapability('/api/v1/search'), 'catalog.search_or_get');
  assert.equal(classifyCapability('/api/v1/url/any'), 'links.create_or_list');
  assert.equal(classifyCapability('/api/v1/report/daily'), 'reports.read');
  assert.equal(classifyCapability('/api/v1/report/payouts'), 'payouts.read');
  assert.equal(classifyCapability('/api/v1/subId/internal'), 'tracking_ids.manage_or_read');
});
