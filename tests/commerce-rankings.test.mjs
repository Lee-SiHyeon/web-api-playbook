import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingSnapshot, rankingCsv } from '../lib/commerce/rankings.mjs';

const checkedAt = '2026-10-05T06:40:00.000Z';
const product = (rank, extra = {}) => ({ rank, productId: `A${rank}`, title: `Product ${rank}`,
  price: { amount: '9900', currency: 'KRW', kind: 'retail_current' },
  url: `https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=A${rank}`,
  availability: 'available', ...extra });
const result = products => ({ checkedAt, executionMode: 'pure_http', products, sourceFormat: 'html_document', isXhr: false,
  rankingContext: { categoryId: '', categoryName: '전체', rankingType: 'sales', sourceAsOf: null },
  receipt: { method: 'GET', httpStatus: 200, browserUsed: false, credentialsUsed: false } });

test('top ten requires ten source ranks, and preserves sold out ranked products', () => {
  const values = Array.from({ length: 10 }, (_, i) => product(i + 1));
  values[8].availability = 'unavailable';
  const snapshot = rankingSnapshot(result(values.reverse()));
  assert.deepEqual(snapshot.products.map(p => p.rank), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(snapshot.products[8].availability, 'unavailable');
  assert.equal(snapshot.collection.topRanksVerified, true);
  assert.equal(snapshot.collection.catalogComplete, false);
  assert.equal(snapshot.rankingContext.sourceAsOf, null);
});

test('gaps and missing rank markers never become inferred positions', () => {
  const snapshot = rankingSnapshot(result([product(3), product(1)]), { limit: 3 });
  assert.deepEqual(snapshot.products.map(p => p.rank), [1,3]);
  assert.equal(snapshot.collection.topRanksVerified, false);
  assert.throws(() => rankingSnapshot(result([{ ...product(1), rank: undefined }])), { code: 'RANKING_IDENTITY_INVALID' });
  assert.throws(() => rankingSnapshot(result([product(1), product(1)])), { code: 'RANKING_IDENTITY_INVALID' });
});

test('requested top ten excludes rank eleven without substituting it for a gap', () => {
  const snapshot = rankingSnapshot(result([product(1), product(11)]));
  assert.deepEqual(snapshot.products.map(p => p.rank), [1]);
  assert.equal(snapshot.collection.topRanksVerified, false);
});

test('displayed starting prices survive JSON normalization and CSV export', () => {
  const snapshot = rankingSnapshot(result([product(1, {
    price: { amount: '46200', currency: 'KRW', kind: 'retail_current', displayText: '46,200원 ~' },
    priceContext: { optionRangeHint: true },
    referencePrice: { amount: '47000', currency: 'KRW', displayText: '47,000원 ~', optionRangeHint: true },
  })]));
  assert.equal(snapshot.products[0].context.priceBasis, 'displayed_starting_price');
  assert.equal(snapshot.products[0].price.display, '46,200원 ~');
  assert.match(rankingCsv(snapshot), /"displayed_starting_price","46,200원 ~","47000","47,000원 ~","true"/);
});

test('CSV preserves rank, KRW, category and observation time and escapes formulas', () => {
  const snapshot = rankingSnapshot(result([product(7, { title: '=HYPERLINK("example")', availability: 'unavailable' })]));
  const csv = rankingCsv(snapshot);
  assert.match(csv, /"7","A7","'=HYPERLINK\(""example""\)"/);
  assert.match(csv, /"9900","KRW"/);
  assert.match(csv, /"전체","sales","","2026-10-05T06:40:00.000Z"/);
});

test('browser observations cannot be relabeled as independent HTTP ranking snapshots', () => {
  assert.throws(() => rankingSnapshot({ ...result([product(1)]), executionMode: 'browser_discovery' }), { code: 'RANKING_RESULT_INVALID' });
  assert.throws(() => rankingSnapshot({ ...result([product(1)]), receipt: { browserUsed: true } }), { code: 'RANKING_RESULT_INVALID' });
  assert.throws(() => rankingSnapshot({ ...result([product(1)]), isXhr: true }), { code: 'RANKING_RESULT_INVALID' });
  assert.throws(() => rankingSnapshot({ ...result([product(1)]), receipt: undefined }), { code: 'RANKING_RESULT_INVALID' });
});
