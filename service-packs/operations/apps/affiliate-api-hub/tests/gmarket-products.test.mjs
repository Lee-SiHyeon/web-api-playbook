import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGmarketProductDocument, readGmarketProducts } from '../adapters/gmarket-products.mjs';

const row = (id, { ad = false, coupon = false } = {}) => ({ designName: 'ItemCardGeneral', viewModel: {
  itemNo: String(id), title: { title: { text: id === 1 ? '일반상품' : undefined } }, isSoldOut: false,
  commonItemInfo: { item: { text: `삼겹살 ${id} 500g`, link: `https://item.gmarket.co.kr/Item?goodscode=${id}${ad ? '&buyboxtype=ad' : ''}` },
    price: { binPrice: '12,000', beforePrice: coupon ? { text: '12,000' } : undefined,
      price: { text: coupon ? '10,000' : '12,000' }, assistText: coupon ? { text: '쿠폰적용가' } : undefined },
    score: { feedbackCount: { text: '45' }, payCount: { text: '1,000' }, avgStarScore: '4.9' },
    deliveryTags: [{ text: { text: '배송비 3,500원' } }] }, seller: { seller: { text: '테스트 판매자' } } } });

const document = () => {
  const modules = [
    { rows: [row(1, { coupon: true }), row(2, { ad: true }), row(1)] },
    { rows: [{ designName: 'Pagination', viewModel: { currentPageIndex: 1, lastPageIndex: 3, pageList: Array(3).fill({}) } }] },
  ];
  const data = { props: { pageProps: { initialStates: { curatorData: { regionsData: { content: { modules } } } } } } };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
};

test('parses embedded ordinary products, excludes ads and duplicates, and keeps coupon conditions', () => {
  const result = parseGmarketProductDocument(document(), { query: '삼겹살', count: 40 });
  assert.equal(result.productCount, 1);
  assert.equal(result.products[0].productId, '1');
  assert.equal(result.products[0].currentPriceKRW, 10000);
  assert.equal(result.products[0].priceRequiresCoupon, true);
  assert.equal(result.products[0].reviewCount, 45);
  assert.equal(result.products[0].shippingFeeKRW, 3500);
  assert.equal(result.pagination.nextPage, 2);
  assert.throws(() => parseGmarketProductDocument('<html>challenge</html>'), { code: 'GMARKET_SEARCH_SCHEMA' });
});

test('scoped session reaches the direct HTTP reader without exposing credentials in receipts', async () => {
  const session = { service: 'gmarket-search', origin: 'https://www.gmarket.co.kr',
    headers: { accept: 'text/html' }, cookies: [{ name: 'synthetic', value: 'fixture', domain: '.gmarket.co.kr',
      path: '/', secure: true, expires: -1 }] };
  let calls = 0;
  const result = await readGmarketProducts({ query: '삼겹살', session, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.origin, 'https://www.gmarket.co.kr');
    assert.equal(url.pathname, '/n/search');
    assert.equal(url.searchParams.get('keyword'), '삼겹살');
    assert.equal(options.headers.cookie, 'synthetic=fixture');
    return new Response(document(), { status: 200, headers: { 'content-type': 'text/html' } });
  } });
  assert.equal(calls, 1);
  assert.equal(result.productCount, 1);
  assert.equal(result.state.credential_propagated, true);
  assert.equal(result.state.live_replay, false);
  assert.doesNotMatch(JSON.stringify(result.receipt), /fixture/);
});
