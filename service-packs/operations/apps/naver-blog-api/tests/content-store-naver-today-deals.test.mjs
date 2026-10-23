import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNaverTodayDeals } from '../research/content-store/naver-today-deals.mjs';

// Trimmed from the public page's __NEXT_DATA__ and first auto-sort response on 2026-09-24.
// The three observed product rows are split across two fixture pages to exercise pagination.
const layoutId = 'I_6ab397451e70f728284ec57e';
const promotionHtml = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { waffleData: {
    pageLayout: { layers: [{
      meta: { title: '스페셜딜' },
      blocks: [{ items: [{ componentType: 'AUTO_SORT_PRODUCT', layoutId }] }],
    }] },
    pageData: { layers: [{ blocks: [{ items: [{
      itemLayoutId: layoutId,
      startDate: '2026-09-24T11:00:00',
      endDate: '2026-09-25T10:59:59',
      contents: [{ productPoolId: '2100850172557840436', productIds: ['6122455353', '4755872512', '12617301731'] }],
    }] }] }] },
  } } },
})}</script></html>`;

const observedProducts = [
  {
    productId: '6122455353',
    name: "[리센느's Pick] 나랑드사이다 제로 345ml CAN 24입 1박스 외 2종",
    landingUrl: 'https://smartstore.naver.com/main/products/6122455353',
    salePrice: 16500,
    discountedPrice: 11200,
    discountedRatio: 32,
    deliveryFee: 0,
    deliveryFeeType: 'FREE',
    isDeliveryFree: true,
    isSoldOut: false,
  },
  {
    productId: '4755872512',
    name: 'BNR17 비에날씬 다이어트 유산균 모유유래 체지방감소 캡슐 60캡슐, 3개',
    landingUrl: 'https://smartstore.naver.com/main/products/4755872512',
    salePrice: 297000,
    discountedPrice: 198000,
    discountedRatio: 33,
    deliveryFee: 0,
    deliveryFeeType: 'FREE',
    isDeliveryFree: true,
    isSoldOut: false,
  },
  {
    productId: '12617301731',
    name: '[냉장제품] 100% 앞다리! 수비드 공법 마스터 통 족발 1,200g 내외',
    landingUrl: 'https://smartstore.naver.com/main/products/12617301731',
    salePrice: 50900,
    discountedPrice: 13900,
    discountedRatio: 72,
    deliveryFee: 0,
    deliveryFeeType: 'FREE',
    isDeliveryFree: true,
    isSoldOut: false,
  },
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function htmlResponse(body = promotionHtml) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function page(pageNumber, hasNext, contents) {
  return { itemLayoutId: layoutId, page: pageNumber, hasNext, contents };
}

function pagedFetch({ page1, page2, html = promotionHtml }) {
  const requests = [];
  const fetchImpl = async url => {
    const parsed = new URL(url);
    requests.push(parsed);
    if (parsed.href === 'https://shopping.naver.com/promotion') return htmlResponse(html);
    if (parsed.searchParams.get('page') === '1') return jsonResponse(page1);
    if (parsed.searchParams.get('page') === '2' && page2) return jsonResponse(page2);
    throw new Error(`Unexpected request: ${parsed.href}`);
  };
  return { fetchImpl, requests };
}

test('discovers the layout from __NEXT_DATA__ and pages through hasNext=false', async () => {
  const soldOut = { ...observedProducts[2], isSoldOut: true };
  const { fetchImpl, requests } = pagedFetch({
    page1: page(1, true, observedProducts.slice(0, 2)),
    page2: page(2, false, [soldOut]),
  });

  const result = await fetchNaverTodayDeals(10, { fetchImpl });

  assert.equal(result.receipt.layoutId, layoutId);
  assert.equal(result.receipt.pages, 2);
  assert.equal(result.receipt.complete, true);
  assert.equal(result.receipt.observedItems, 3);
  assert.equal(result.receipt.httpStatus, 200);
  assert.match(result.receipt.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(requests[1].href, `https://vertical-api.shopping.naver.com/v1/waffle-maker/layouts/${layoutId}/auto-sort-products?first=&page=1&type=VIEW`);
  assert.equal(requests[2].href, `https://vertical-api.shopping.naver.com/v1/waffle-maker/layouts/${layoutId}/auto-sort-products?page=2&type=VIEW`);
  assert.deepEqual(result.items.map(item => item.deal.productId), ['6122455353', '4755872512', '12617301731']);
  assert.deepEqual(result.items.map(item => item.deal.soldOut), [false, false, true]);
  assert.equal(result.items[0].publisher, '네이버 오늘끝딜');
  assert.match(result.items[0].summary, /정가 16,500원 → 할인가 11,200원 · 무료배송/);
});

test('marks the result incomplete when maxPages stops while hasNext is true', async () => {
  const { fetchImpl } = pagedFetch({
    page1: page(1, true, observedProducts.slice(0, 2)),
    page2: page(2, false, [observedProducts[2]]),
  });

  const result = await fetchNaverTodayDeals(10, { fetchImpl, maxPages: 1 });

  assert.equal(result.receipt.pages, 1);
  assert.equal(result.receipt.complete, false);
  assert.equal(result.items.length, 2);
});

test('keeps an unknown delivery fee null', async () => {
  const unknownFee = { ...observedProducts[2] };
  delete unknownFee.deliveryFee;
  delete unknownFee.deliveryFeeType;
  delete unknownFee.isDeliveryFree;
  const { fetchImpl } = pagedFetch({
    page1: page(1, true, observedProducts.slice(0, 2)),
    page2: page(2, false, [unknownFee]),
  });

  const result = await fetchNaverTodayDeals(10, { fetchImpl });
  const item = result.items.find(entry => entry.deal.productId === '12617301731');

  assert.equal(item.deal.deliveryFee, null);
  assert.equal(item.summary, '정가 50,900원 → 할인가 13,900원');
});

test('rejects an API schema change with SCHEMA', async () => {
  const { fetchImpl } = pagedFetch({
    page1: { itemLayoutId: layoutId, page: 1, hasNext: false, contents: {} },
  });

  await assert.rejects(fetchNaverTodayDeals(10, { fetchImpl }), error => error.message === 'SCHEMA');
});

test('converts unzoned KST event dates to UTC', async () => {
  const { fetchImpl } = pagedFetch({
    page1: page(1, false, [observedProducts[0]]),
  });

  const result = await fetchNaverTodayDeals(1, { fetchImpl });

  assert.equal(result.items[0].publishedAt, '2026-09-24T02:00:00.000Z');
  assert.equal(result.items[0].deal.eventStart, '2026-09-24T02:00:00.000Z');
  assert.equal(result.items[0].deal.eventEnd, '2026-09-25T01:59:59.000Z');
});
