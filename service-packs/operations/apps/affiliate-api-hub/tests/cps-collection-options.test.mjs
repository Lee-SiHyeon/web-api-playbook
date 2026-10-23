import assert from 'node:assert/strict';
import test from 'node:test';
import { appendMerchantReport, independentRefreshAllowed, parseCollectOptions } from '../scripts/cps-reverify.mjs';

test('only implemented merchant parameters are accepted with explicit bounds', () => {
  assert.deepEqual(parseCollectOptions('wconcept', ['--page=2', '--page-size=60', '--append']), { append: true, options: { page: 2, pageSize: 60 } });
  assert.deepEqual(parseCollectOptions('lfmall', ['--query=셔츠', '--limit=5', '--detail-limit=2', '--review-limit=5']), {
    append: false, options: { keyword: '셔츠', productLimit: 5, detailLimit: 2, reviewPageSize: 5 },
  });
  for (const [merchant, flags] of [['wconcept', ['--page=0']], ['wconcept', ['--page-size=61']], ['lfmall', ['--limit=41']], ['all', ['--query=셔츠']], ['coupang', ['--token=secret']]]) {
    assert.throws(() => parseCollectOptions(merchant, flags));
  }
});

test('appending a catalog page preserves earlier records and original receipts without crossing merchants', () => {
  const previous = { merchantId: 'merchant', checkedAt: '2026-09-27T00:00:00Z', records: [{ sourceLocalId: 'a', evidence: [{ receiptId: 'old' }] }], receipts: [{ id: 'old', observedAt: '2026-09-27T00:00:00Z' }], frontier: [{ page: 2 }] };
  const current = { merchantId: 'merchant', checkedAt: '2026-09-27T01:00:00Z', records: [{ sourceLocalId: 'b', evidence: [{ receiptId: 'new' }] }], receipts: [{ id: 'new', observedAt: '2026-09-27T01:00:00Z' }], frontier: [{ page: 3 }] };
  const combined = appendMerchantReport(previous, current);
  assert.deepEqual(combined.records.map(row => row.sourceLocalId), ['a', 'b']);
  assert.deepEqual(combined.receipts.map(row => row.observedAt), ['2026-09-27T00:00:00Z', '2026-09-27T01:00:00Z']);
  assert.equal(combined.retainedObservations.observationTimesPreserved, true);
  assert.throws(() => appendMerchantReport(previous, { ...current, merchantId: 'different' }), /CANNOT_APPEND_DIFFERENT_MERCHANT/);
});

test('a source can refresh its observed independent route without retrying a rejected origin', () => {
  const adapter = { refreshableAfterPublicBlockMerchants: ['coupang', 'nbtnaver', 'emart', 'unknown'] };
  const rejection = url => ({ receipts: [{ status: 403, requestUrl: url }] });
  assert.equal(independentRefreshAllowed('coupang', adapter, rejection('https://www.coupang.com/np/search')), true);
  assert.equal(independentRefreshAllowed('coupang', adapter, rejection('https://partners.coupang.com/api/v1/search')), false);
  assert.equal(independentRefreshAllowed('nbtnaver', adapter, rejection('https://smartstore.naver.com/inflow/outlink/product?p=1')), true);
  assert.equal(independentRefreshAllowed('nbtnaver', adapter, rejection('https://shopping.naver.com/promotion')), false);
  assert.equal(independentRefreshAllowed('unknown', adapter, rejection('https://example.com')), false);
  assert.equal(independentRefreshAllowed('emart', adapter, rejection('https://www.ssg.com/item/itemView.ssg')), true);
  assert.equal(independentRefreshAllowed('emart', adapter, rejection('https://search.ssg.com/api/item/all')), false);
  assert.equal(independentRefreshAllowed('nbtnaver', adapter, rejection('invalid')), false);
});
