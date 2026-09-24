import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTodayDeals, koreanDate, parseDealPage, parsePromotionManifest } from '../adapters/naver-shopping-deals.mjs';

const layoutId = 'I_0123456789abcdef01234567';
const window = { startAt: '2026-09-20T02:00:00.000Z', endAt: '2026-09-21T01:59:59.000Z' };
const now = () => new Date('2026-09-20T18:00:00Z');
function manifest() {
  return '<script type="application/json" id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: { waffleData: {
    pageLayout: { layers: [{ meta: { title: '스페셜딜' }, blocks: [{ items: [{ layoutId, componentType: 'AUTO_SORT_PRODUCT' }] }] }] },
    pageData: { layers: [{ items: [{ itemLayoutId: layoutId, startDate: '2026-09-20T11:00:00', endDate: '2026-09-21T10:59:59', lastModifiedBy: 'DO_NOT_EXPORT' }] }] },
  } } } }) + '</script>';
}
const product = id => ({ productId: id, name: '테스트 상품', isSoldOut: false, salePrice: 10000, discountedPrice: 8000, discountedRatio: 20, deliveryFee: null, landingUrl: 'https://smartstore.naver.com/example/products/' + id });
const page = (n, ids, hasNext = false) => ({ itemLayoutId: layoutId, page: n, hasNext, contents: ids.map(product) });
const response = (data, type = 'application/json', status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'content-type': type } });

test('manifest discovers the changing ID and discards editor metadata', () => {
  const parsed = parsePromotionManifest(manifest());
  assert.deepEqual(parsed.layouts[0], { layoutId, title: '스페셜딜', ...window });
  assert.equal(JSON.stringify(parsed).includes('DO_NOT_EXPORT'), false);
  assert.throws(() => parsePromotionManifest('<html>login</html>'), { code: 'MANIFEST_SCHEMA' });
});

test('Korean campaign expiry is exact; unknown shipping is not free', () => {
  assert.equal(koreanDate('2026-09-21T10:59:59'), window.endAt);
  const p = page(1, [123]);
  const active = parseDealPage(p, { layoutId, page: 1, window, checkedAt: window.endAt })[0];
  assert.equal(active.status, 'listed_active');
  assert.equal(active.deliveryFee, null);
  assert.equal(active.checkoutPriceVerified, false);
  assert.equal(parseDealPage(p, { layoutId, page: 1, window, checkedAt: '2026-09-21T02:00:00Z' })[0].status, 'expired');
});

test('pagination stops on hasNext false, deduplicates and never sends credentials', async () => {
  const calls = [];
  const result = await collectTodayDeals({ now, fetchImpl: async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.redirect, 'manual');
    if (calls.length === 1) return response(manifest(), 'text/html');
    return response(calls.length === 2 ? page(1, [123, 124], true) : page(2, [124, 125]));
  } });
  assert.equal(result.complete, true); assert.equal(result.productCount, 3); assert.equal(result.duplicateCount, 1);
  assert.equal(result.layouts[0].pages, 2);
  assert.match(calls[1], /first=&page=1&type=VIEW$/);
  assert.match(calls[2], /\?page=2&type=VIEW$/);
});

test('page budget is reported as incomplete, not a complete catalog', async () => {
  let calls = 0;
  const result = await collectTodayDeals({ now, maxPages: 1, fetchImpl: async () => ++calls === 1 ? response(manifest(), 'text/html') : response(page(1, [123], true)) });
  assert.equal(result.complete, false); assert.equal(result.layouts[0].stopReason, 'max_pages');
});

test('200 HTML challenge, 418 and wrong page/layout fail closed', async () => {
  for (const [type, status] of [['text/html', 200], ['text/html', 418]]) {
    let calls = 0;
    await assert.rejects(collectTodayDeals({ now, fetchImpl: async () => ++calls === 1 ? response(manifest(), 'text/html') : response('<html>challenge</html>', type, status) }), { code: 'HTTP_OR_CONTENT_TYPE' });
  }
  assert.throws(() => parseDealPage(page(2, [123]), { layoutId, page: 1, checkedAt: now().toISOString(), window }), { code: 'PAGE_SCHEMA' });
  assert.throws(() => parseDealPage(page(1, [123]), { layoutId: 'wrong', page: 1, checkedAt: now().toISOString(), window }), { code: 'PAGE_SCHEMA' });
});

test('repeated nonterminal page cannot loop or report success', async () => {
  let calls = 0;
  await assert.rejects(collectTodayDeals({ now, fetchImpl: async () => {
    calls++;
    return calls === 1 ? response(manifest(), 'text/html') : response(page(calls - 1, [123], true));
  } }), { code: 'PAGINATION_NO_PROGRESS' });
  assert.equal(calls, 3);
});
