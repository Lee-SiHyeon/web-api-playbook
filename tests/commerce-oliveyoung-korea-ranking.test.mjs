import test from 'node:test';
import assert from 'node:assert/strict';
import { createOliveyoungKoreaRankingClient } from '../lib/commerce/oliveyoung-korea-ranking.mjs';

const GOODS1 = 'A000000268586';
const GOODS2 = 'A000000171423';
const SKINCARE = '10000010001';
const ROOT_CATEGORY = '900000100100001';

function card(rank, id, {
  title = '라네즈 네오쿠션 뮤이',
  brand = '라네즈',
  current = '46,200원 ~',
  reference = '47,000원 ~',
  flag = '',
} = {}) {
  return '<li><div class="prd_info">' +
    '<div class="prd_thumb"><span class="thumb_flag best">' + String(rank).padStart(2, '0') + '</span>' +
    '<a class="prd_thumb" href="/store/goods/getGoodsDetail.do?goodsNo=' + id +
      '&amp;dispCatNo=10000010001&amp;trackingCd=tracking-value">' + String(rank).padStart(2, '0') + '</a></div>' +
    '<div class="prd_name"><span class="tx_brand">' + brand + '</span>' +
      '<a href="/store/goods/getGoodsDetail.do?goodsNo=' + id + '"><p class="tx_name">' + title + '</p></a></div>' +
    '<p class="prd_price"><span class="tx_org">' + reference + '</span>' +
      '<span class="tx_cur">' + current + '</span></p>' +
    '<div class="prd_flag">' + flag + '</div></div></li>';
}

function pageHtml({ category = '', cards = [] } = {}) {
  return '<!doctype html><html><head><title>랭킹 | 올리브영</title></head><body>' +
    '<form id="initForm">' +
      '<input name="dispCatNo" value="' + ROOT_CATEGORY + '">' +
      '<input name="fltDispCatNo" value="' + category + '">' +
      '<input name="pageIdx" value="1"><input name="rowsPerPage" value="8">' +
    '</form><div class="best-area"><div class="common-menu"><ul>' +
      '<li><button data-ref-dispCatNo="">전체</button></li>' +
      '<li><button data-ref-dispCatNo="' + SKINCARE + '"' +
        (category === SKINCARE ? ' class="on"' : '') + '>스킨케어</button></li>' +
      '<li><button data-ref-dispCatNo="10000010002"' +
        (category === '10000010002' ? ' class="on"' : '') + '>메이크업</button></li>' +
      '</ul></div><ul class="TabsConts on">' + cards.join('') +
    '</ul></div></body></html>';
}

function createClient({ pages, now = () => new Date('2026-10-05T12:00:00.000Z') } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const response = pages.shift();
    assert.ok(response, 'unexpected ranking request ' + url.pathname);
    return response;
  };
  return {
    calls,
    client: createOliveyoungKoreaRankingClient({ fetchImpl, now }),
  };
}

const html = (value, status = 200, mime = 'text/html; charset=utf-8') =>
  new Response(value, { status, headers: { 'content-type': mime } });

test('default ranking parses explicit rank markers, binds same-card product IDs, and returns current/reference KRW prices', async () => {
  const cards = [
    card(2, GOODS2, { title: '어노브 딥 데미지 리페어 헤어 마스크', brand: '어노브',
      current: '27,900원 ~', reference: '42,000원 ~' }),
    card(1, GOODS1),
    ...Array.from({ length: 8 }, (_, index) => card(index + 3, 'A0000002685' + String(index).padStart(2, '0'),
      { title: '상품 ' + (index + 3), current: '15,900원', reference: '22,000원',
        flag: index === 7 ? '일시품절' : '' })),
    card(11, 'A000000268600', { title: '순위 11 상품' }),
  ];
  const { client, calls } = createClient({ pages: [html(pageHtml({ cards }))] });
  const result = await client.getRanking({ limit: 10 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://www.oliveyoung.co.kr');
  assert.equal(calls[0].url.pathname, '/store/main/getBestList.do');
  assert.deepEqual([...calls[0].url.searchParams], []);
  assert.equal(result.products.length, 10);
  assert.deepEqual(result.products.map(product => product.rank), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(result.topRanksVerified, true);
  assert.equal(result.products[0].productId, GOODS1);
  assert.equal(result.products[0].brand, '라네즈');
  assert.equal(result.products[0].price.amount, '46200');
  assert.equal(result.products[0].referencePrice.amount, '47000');
  assert.equal(result.products[0].price.currency, 'KRW');
  assert.equal(result.products[0].priceContext.optionRangeHint, true);
  assert.equal(result.products[9].availability, 'unavailable');
  assert.equal(result.products[8].availability, 'unknown');
  assert.equal(result.products[0].url, 'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + GOODS1);
  assert.deepEqual(result.categories, [
    { categoryId: SKINCARE, categoryName: '스킨케어' },
    { categoryId: '10000010002', categoryName: '메이크업' },
  ]);
  assert.equal(result.rankingContext.categoryId, null);
  assert.equal(result.rankingContext.categoryName, '전체');
  assert.equal(result.rankingContext.sourceAsOf, null);
  assert.equal(result.rankingContext.renderedRankCount, 11);
  assert.equal(result.checkedAt, '2026-10-05T12:00:00.000Z');
  assert.equal(result.executionMode, 'pure_http');
  assert.equal(result.sourceFormat, 'html_document');
  assert.equal(result.isXhr, false);
  assert.equal(result.receipt.httpStatus, 200);
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.receipt.mime, 'text/html');
});

test('category filter is sourced from a visible page control and must be reflected in returned form state', async () => {
  const baseCards = Array.from({ length: 10 }, (_, index) => card(index + 1,
    'A0000002685' + String(index).padStart(2, '0'), { title: '기본 ' + (index + 1) }));
  const filteredCards = Array.from({ length: 10 }, (_, index) => card(index + 1,
    'A0000001714' + String(index).padStart(2, '0'), { title: '스킨 ' + (index + 1) }));
  const { client, calls } = createClient({ pages: [
    html(pageHtml({ cards: baseCards })),
    html(pageHtml({ category: SKINCARE, cards: filteredCards })),
  ] });
  const result = await client.getRanking({ categoryId: SKINCARE, limit: 10 });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get('dispCatNo'), ROOT_CATEGORY);
  assert.equal(calls[1].url.searchParams.get('fltDispCatNo'), SKINCARE);
  assert.equal(calls[1].url.searchParams.get('pageIdx'), '1');
  assert.equal(calls[1].url.searchParams.get('rowsPerPage'), '8');
  assert.equal(result.rankingContext.categoryId, SKINCARE);
  assert.equal(result.rankingContext.categoryName, '스킨케어');
  assert.equal(result.rankingContext.filteredCategoryId, SKINCARE);
  assert.equal(result.products[0].title, '스킨 1');
  assert.equal(result.receipts.length, 2);
});

test('rejects unobserved category IDs and server responses that ignore the requested filter', async () => {
  const cards = Array.from({ length: 10 }, (_, index) => card(index + 1,
    'A0000002685' + String(index).padStart(2, '0')));
  const noCall = createClient({ pages: [html(pageHtml({ cards }))] });
  await assert.rejects(noCall.client.getRanking({ categoryId: '9999999999' }),
    { code: 'OLIVEYOUNG_RANKING_CATEGORY_UNOBSERVED' });
  assert.equal(noCall.calls.length, 1);

  const ignored = createClient({ pages: [
    html(pageHtml({ cards })),
    html(pageHtml({ cards })),
  ] });
  await assert.rejects(ignored.client.getRanking({ categoryId: SKINCARE }),
    { code: 'OLIVEYOUNG_RANKING_CATEGORY_FILTER_NOT_APPLIED' });
  assert.equal(ignored.calls.length, 2);
});

test('fails rather than synthesizing ranks when an explicit rank marker is missing or duplicated', async () => {
  const missing = '<!doctype html><html><head><title>랭킹</title></head><body>' +
    '<p class="sub_depth"><a data-ref-dispCatNo="' + SKINCARE + '">스킨케어</a></p>' +
    '<input name="dispCatNo" value="' + ROOT_CATEGORY + '"><input name="pageIdx" value="1">' +
    '<input name="rowsPerPage" value="8"><div class="best-area"><ul class="TabsConts on">' +
    card(1, GOODS1) + card(3, GOODS2) + '</ul></div></body></html>';
  const miss = createClient({ pages: [html(missing)] });
  await assert.rejects(miss.client.getRanking({ limit: 2 }),
    { code: 'OLIVEYOUNG_RANKING_TOP_N_INCOMPLETE' });
  const duplicate = createClient({ pages: [html(pageHtml({ cards: [card(1, GOODS1), card(1, GOODS2)] }))] });
  await assert.rejects(duplicate.client.getRanking({ limit: 1 }),
    { code: 'OLIVEYOUNG_RANKING_DUPLICATE_RANK' });
});

test('does not label arbitrary product flags as in stock and rejects product ID mismatches', async () => {
  const cards = [
    card(1, GOODS1, { flag: 'BEST' }),
    ...Array.from({ length: 9 }, (_, index) => card(index + 2, 'A0000002685' + String(index).padStart(2, '0'))),
  ];
  const { client } = createClient({ pages: [html(pageHtml({ cards }))] });
  const result = await client.getRanking({ limit: 10 });
  assert.equal(result.products[0].availability, 'unknown');

  const mismatched = pageHtml({ cards: [card(1, GOODS1).replace('goodsNo=' + GOODS1, 'goodsNo=A000000171423')] });
  const bad = createClient({ pages: [html(mismatched)] });
  await assert.rejects(bad.client.getRanking({ limit: 1 }),
    { code: 'OLIVEYOUNG_RANKING_PRODUCT_BINDING_INVALID' });
});

test('403 HTML remains a transport error and the receipt identifies a pure HTTP document read', async () => {
  const { client } = createClient({ pages: [html('<html>blocked</html>', 403)] });
  let error;
  try { await client.getRanking(); } catch (caught) { error = caught; }
  assert.equal(error.code, 'OLIVEYOUNG_RANKING_HTTP_BLOCKED');
  assert.equal(error.receipt.httpStatus, 403);
  assert.equal(error.receipt.mime, 'text/html');
  assert.equal(error.receipt.browserUsed, false);
  assert.equal(error.receipt.sourceFormat, 'html_document');
  assert.equal(error.receipt.isXhr, false);
  assert.equal(error.receipt.executionMode, 'pure_http');
});
