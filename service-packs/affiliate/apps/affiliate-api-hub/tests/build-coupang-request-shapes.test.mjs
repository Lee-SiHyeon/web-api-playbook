import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestShapeRecord, requestShapeHints } from '../scripts/build-coupang-request-shapes.mjs';

test('request shape hints preserve names but never values or executability', () => {
  const shapes = requestShapeHints();
  const search = shapes.find(item => item.path === '/api/v1/search');
  assert.deepEqual(search.bodyFields, ['categoryId', 'deliveryTypes', 'filter', 'page.pageNumber', 'page.size']);
  assert.equal(search.valuesObserved, false);
  assert.equal(search.requestBodyValuesPersisted, false);
  assert.equal(search.executable, false);
  const record = buildRequestShapeRecord({ now: () => new Date('2026-09-19T00:00:00Z') });
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /private-value|cookie|authorization/i);
  assert.equal(record.executableCount, 0);
});
