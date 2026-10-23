import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAgencyDeals, parseKoreanDate, parseKoreanDateRange, SITES } from '../research/content-store/travel-deals-agencies.mjs';

const now = new Date('2026-09-24T12:00:00+09:00');

// Trimmed fields from the anonymous 모두투어 __NEXT_DATA__ response.
const MODE_ROWS = [
  {
    specialExhibitionTitle: '[오사카] 100배 즐기기',
    lowestPrice: null,
    contentMappingLinkUrl: '/promotion/9d3a6ce6-b814-4fef-9370-08dc20644e07',
    specialExhibitionCategorys: [{ categoryName: '일본' }],
  },
  {
    specialExhibitionTitle: '매력, [큐슈] 맛있게 잘 놀다갑니다.',
    lowestPrice: null,
    contentMappingLinkUrl: 'https://www.modetour.com/promotion/51',
    specialExhibitionCategorys: [{ categoryName: '일본' }],
  },
  {
    specialExhibitionTitle: '자연이 보내준 선물 [일본 가을 단풍]',
    lowestPrice: null,
    contentMappingLinkUrl: 'https://www.modetour.com/promotion/478',
    specialExhibitionCategorys: [{ categoryName: '일본' }],
  },
];

function modeFixture(rows = MODE_ROWS) {
  const data = {
    page: '/special-exhibition',
    props: {
      pageProps: {
        initialState: {
          api: {
            queries: {
              'getSpecialExhibitionGetSpecialExhibition({"chkLayout":"Y","departureAreaTypeCode":"","productGroupTypeCode":"","specialExhibitionTypeCode":"SETExhibition"})': {
                data: { result: rows },
              },
            },
          },
        },
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
}

// Trimmed actual promotion-detail anchors present in 노랑풍선's public homepage HTML.
const YB_FIXTURE = [
  '<a href="https://pkg.ybtour.co.kr/promotion/promotionDetail.yb?mstNo=20000032648">감사페스타</a>',
  '<a href="https://pkg.ybtour.co.kr/promotion/promotionDetail.yb?mstNo=20000032703">옐로Pick</a>',
  '<a href="https://pkg.ybtour.co.kr/promotion/promotionDetail.yb?mstNo=20000028710">긴급특가</a>',
  '<a href="https://pkg.ybtour.co.kr/promotion/promotionDetail.yb?mstNo=20000028710&amp;tabId=tab_01">긴급 특가! 지금 바로 유럽 예약!</a>',
].join('\n');

// Trimmed product cards from the public 참좋은여행 /Event/EventPlanReview page.
const VERYGOOD_FIXTURE = `
<div class="right_body_div" data-no="EPP3767">
  <span class="fav" data-region="유럽" data-price="2390000" data-product-name="[한번에 담다] 이탈리아 핵심 일주 9일"></span>
  <span class="title">[한번에 담다] 이탈리아 핵심 일주 9일 #밀라노,피사 #나폼소 #감성소도시</span>
  <span class="des">밀라노아울렛자유시간제공</span>
  <div class="price_div"><span class="price">2,390,000</span>원~</div>
  <div class="det_button" onclick="location.href='/Product/PackageDetail?masterCode=EPP3767'"></div>
  <div class="right_prod_div" data-code="EPP3767-261028TW">
    <span class="event_badge orange">이벤트</span>
    <span desc="event_badge orange">2026-10-28 [한번에 담다] 이탈리아 핵심 일주</span>
  </div>
</div>
<div class="right_body_div" data-no="EPP3752">
  <span class="fav" data-region="유럽" data-price="2390000" data-product-name="[여유롭게 즐기는] 나만의 이탈리아 일주 9일"></span>
  <span class="title">[여유롭게 즐기는] 나만의 이탈리아 일주 9일 #최적의 일정 #티볼리 #아말피,포지타노</span>
  <span class="des">밀라노IN-로마OUT 최고의 동선</span>
  <div class="price_div"><span class="price">2,390,000</span>원~</div>
  <div class="det_button" onclick="location.href='/Product/PackageDetail?masterCode=EPP3752'"></div>
  <div class="right_prod_div" data-code="EPP3752-261015">
    <span class="event_badge orange">이벤트</span>
    <span desc="event_badge orange">2026-10-15 [여유롭게 즐기는] 나만의 이탈리아 일주</span>
  </div>
</div>`;

function response(body, status = 200, url = '') {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function fixtureFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (Object.hasOwn(overrides, url)) return overrides[url](url);
    if (url === SITES.hanatour.url) return response('<html><title>하나투어</title><body>핫딜</body></html>');
    if (url === SITES.modetour.url) return response(modeFixture());
    if (url === SITES.modetour.urls[1]) return response('<html><body>이벤트</body></html>');
    if (url === SITES.ybtour.url) return response(YB_FIXTURE);
    if (url === SITES.verygoodtour.url) return response(VERYGOOD_FIXTURE);
    throw new Error('NO_FIXTURE');
  };
  return { fetchImpl, calls };
}

test('parses trimmed public fixtures from each working agency and records unsupported static data', async () => {
  const { fetchImpl } = fixtureFetch();
  const result = await fetchAgencyDeals(30, { fetchImpl, now });

  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.items.length, 8);
  assert.deepEqual(result.items.slice(0, 3).map(item => item.publisher), ['모두투어', '노랑풍선', '참좋은여행']);
  assert.equal(result.items[0].title, '[모두투어] [오사카] 100배 즐기기');
  assert.equal(result.items.find(item => item.publisher === '노랑풍선').title, '[노랑풍선] 감사페스타');
  assert.equal(result.items.find(item => item.publisher === '참좋은여행').title,
    '[참좋은여행] [한번에 담다] 이탈리아 핵심 일주 9일 #밀라노,피사 #나폼소 #감성소도시');
  assert.deepEqual(result.receipt.perSite.map(row => [
    row.site, row.httpStatus, row.dataSource, row.observedItems, row.parsed, row.skippedEnded, row.skipped,
  ]), [
    ['hanatour', 200, null, 0, 0, 0, 'NO_PUBLIC_DEAL_DATA'],
    ['modetour', 200, 'embedded_json', 3, 3, 0, null],
    ['ybtour', 200, 'html', 4, 3, 0, null],
    ['verygoodtour', 200, 'html', 2, 2, 0, null],
  ]);

  const italy = result.items.find(item => item.publisher === '참좋은여행');
  assert.equal(italy.deal.destination, '이탈리아');
  assert.equal(italy.deal.priceFrom, 2390000);
  assert.equal(italy.deal.travelStart, '2026-10-28');
  assert.equal(italy.deal.bookingStart, null);
});

test('parses Korean date forms without guessing an unspecified year', () => {
  for (const value of ['2026.09.24', '2026-09-24', '09.24(목)', '9월 24일']) {
    assert.equal(parseKoreanDate(value, now), '2026-09-24');
  }
  assert.deepEqual(parseKoreanDateRange('2026.09.01 ~ 2026-09-24', now), {
    start: '2026-09-01', end: '2026-09-24',
  });
  assert.equal(parseKoreanDate('02.30', now), null);
});

test('filters deals whose booking end is before today and leaves missing prices null', async () => {
  const endedRows = [
    {
      ...MODE_ROWS[0],
      salePeriod: { startDate: '2026-09-01', endDate: '2026-09-23' },
    },
    {
      ...MODE_ROWS[1],
      salePeriod: { startDate: '2026-09-20', endDate: '2026-09-30' },
    },
  ];
  const { fetchImpl } = fixtureFetch({
    [SITES.modetour.url]: () => response(modeFixture(endedRows)),
  });
  const result = await fetchAgencyDeals(10, { fetchImpl, sites: ['modetour', 'ybtour'], now });

  assert.equal(result.receipt.perSite[0].parsed, 2);
  assert.equal(result.receipt.perSite[0].skippedEnded, 1);
  assert.equal(result.items.some(item => item.url.endsWith('/promotion/9d3a6ce6-b814-4fef-9370-08dc20644e07')), false);
  const ybDeal = result.items.find(item => item.publisher === '노랑풍선');
  assert.equal(ybDeal.deal.priceFrom, null);
  assert.equal(ybDeal.deal.priceText, null);
  assert.equal(ybDeal.publishedAt, null);
});

test('isolates a blocked agency and makes no retry or follow-up request for it', async () => {
  const blockedUrl = SITES.modetour.url;
  const { fetchImpl, calls } = fixtureFetch({
    [blockedUrl]: () => response('Forbidden', 429),
  });
  const result = await fetchAgencyDeals(10, { fetchImpl, sites: ['modetour', 'ybtour'], now });

  assert.equal(calls.filter(url => url === blockedUrl).length, 1);
  assert.equal(calls.includes(SITES.modetour.urls[1]), false);
  assert.equal(result.receipt.perSite[0].httpStatus, 429);
  assert.equal(result.receipt.perSite[0].skipped, 'HTTP_429');
  assert.equal(result.items.length, 3);
  assert.ok(result.items.every(item => item.publisher === '노랑풍선'));
});
