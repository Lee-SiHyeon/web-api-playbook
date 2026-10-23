import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlatformDeals, parseKoreanDate, SITES } from '../research/content-store/travel-deals-platforms.mjs';

const now = new Date('2026-09-24T12:00:00+09:00');

// Trimmed, anonymous public list data captured from the live pages; only deal fields remain.
const FIXTURES = {
  tripcom: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialState: { adsData: { adsList: [
      { title: '슈퍼 멤버스데이', canonicalUrl: 'https://kr.trip.com/sale/w/gdosspmbbp1re3fx/2026krmemberday.html?locale=ko-KR&transparentBar=1&wkp=1', category: '3' },
      { title: '신규 호텔 최대 20% 할인', canonicalUrl: 'https://kr.trip.com/sale/w/21947/super-new-opening-hotels.html?locale=ko-kr&curr=krw&transparentBar=1', category: '3' },
      { title: '항공과 호텔을 한 번에 예약하세요', canonicalUrl: 'https://kr.trip.com/sale/w/44626/bundle-guide.html?locale=ko-kr&curr=krw&transparentBar=1', category: '3' },
    ] } } } },
  })}</script>`,
  yeogi: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { dehydratedState: { queries: [{
      queryKey: ['web-home-event-banners', 1001],
      state: { data: { content: { items: [
        { title: '2026 숙박세일 페스타 섬지역편', scheme: '/event/6373/2026%20%EC%88%99%EB%B0%95%EC%84%B8%EC%9D%BC%20%ED%8E%98%EC%8A%A4%ED%83%80%20%EC%84%AC%EC%A7%80%EC%97%AD%ED%8E%B8/https://event.yeogi.com/pages/6373/index.html?aevno=6373', startDate: '2026-09-22T09:00:00', endDate: '2026-11-09T07:00:00' },
        { title: '9월 국내숙소 쿠폰팩', scheme: '/event/6354/9%EC%9B%94%20%EA%B5%AD%EB%82%B4%EC%88%99%EC%86%8C%20%EC%BF%A0%ED%8F%B0%ED%8C%A9/https://api3.goodchoice.kr/event3/web/adEventView?aevno=6354', startDate: '2026-09-01T00:00:00', endDate: '2026-09-30T23:59:59' },
      ] } } },
    }] } } },
  })}</script>`,
  nol: [
    '<a class="text-text-neutral-main" href="https://nol.yanolja.com/stay/overseas/TDP-161251">더 파리지앵 마카오 <span>165,502</span> 원~</a>',
    '<a class="text-text-neutral-main" href="https://nol.yanolja.com/stay/overseas/TDP-161262">콘래드 마카오 <span>196,156</span> 원~</a>',
    '<a class="text-text-neutral-main" href="https://nol.yanolja.com/stay/domestic/10063201">강릉 호텔벗 <span>53%</span> <span>184,050</span> 원~</a>',
  ].join('\n'),
  myrealtrip: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { dehydratedState: { queries: [{
      queryKey: ['main', 'contents', 'overseas'],
      state: { data: { rankProduct: { list: [{ cityName: '시드니', products: [
        { title: '시드니 블루마운틴 선셋+별보기 (소그룹, 1인출발)', productUrl: 'https://experiences.myrealtrip.com/products/3442336', cityName: '시드니', discountText: '67,048원', couponAppliedPrice: 67048, salePrice: 74498, discountPercent: '10%', tags: [{ text: '10월 특가' }, { text: '최저가보장제' }], adProduct: false },
        { title: '포트스테판 프리미엄 소그룹 투어 (최소 모객 1인)', productUrl: 'https://experiences.myrealtrip.com/products/3441573', cityName: '시드니', discountText: '91,777원', couponAppliedPrice: 91777, salePrice: 98685, discountPercent: '7%', tags: [{ text: '10월 특가' }], adProduct: false },
      ] }] } } },
    }] } } },
  })}</script>`,
  ttang: [
    '<a href="#none;" id="12706" class="shortCut">얼리버드 특가 [자유여행] 나트랑 빈펄이외 나트랑 에어텔 359,000원~</a>',
    '<a href="#none;" id="618" class="shortCut">얼리버드 특가 [패키지] 보라카이 4일 389,900원~</a>',
  ].join('\n'),
  agoda: '<!doctype html><html lang="ko"><head><title>Agoda</title></head><body>Search accommodations</body></html>',
};

function mockResponse(status, body, url) {
  return {
    status,
    url,
    headers: { get: () => null },
    text: async () => body,
  };
}

function fixtureFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const entry = Object.entries(SITES).find(([, config]) => config.sourceUrl === url)
      ?? (url === 'https://www.ttang.com/index.do' || SITES.ttang.urgentUrls.includes(url) ? ['ttang', SITES.ttang] : null);
    const site = entry?.[0];
    if (overrides[site]) return overrides[site](url, site);
    if (site === 'ttang') {
      return mockResponse(200, '<meta http-equiv="refresh" content="0; url=/index.do">', url);
    }
    return mockResponse(200, FIXTURES[site], url);
  };
  return { fetchImpl, calls };
}

test('parses consumer deals from offline fixtures for the four working public listings', async () => {
  const { fetchImpl } = fixtureFetch();
  const result = await fetchPlatformDeals(30, {
    fetchImpl,
    sites: ['tripcom', 'yeogi', 'nol', 'myrealtrip'],
    now,
  });

  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.items.length, 10);
  assert.ok(result.items.every(item => item.title.startsWith('[') && item.url.startsWith('https://')));
  assert.deepEqual(result.receipt.perSite.map(row => [row.site, row.httpStatus, row.dataSource, row.observedItems, row.parsed, row.skipped]), [
    ['tripcom', 200, 'embedded_json', 3, 3, null],
    ['yeogi', 200, 'embedded_json', 2, 2, null],
    ['nol', 200, 'html', 3, 3, null],
    ['myrealtrip', 200, 'embedded_json', 2, 2, null],
  ]);

  const tripcom = result.items.find(item => item.title.includes('슈퍼 멤버스데이'));
  assert.equal(tripcom.title, '[트립닷컴] 슈퍼 멤버스데이');
  assert.equal(tripcom.deal.priceFrom, null);
  assert.equal(tripcom.deal.priceText, null);
  assert.equal(tripcom.publishedAt, null);
  assert.match(tripcom.summary, /최저가 미확인/u);

  const yeogi = result.items.find(item => item.title.includes('숙박세일 페스타'));
  assert.equal(yeogi.publishedAt, '2026-09-22');
  assert.equal(yeogi.deal.bookingEnd, '2026-11-09');
  assert.match(yeogi.url, /\/event\/6373\//u);

  const nol = result.items.find(item => item.title.includes('강릉 호텔벗'));
  assert.equal(nol.deal.priceFrom, 184050);
  assert.deepEqual(nol.deal.badges, ['53%']);

  const myrealtrip = result.items.find(item => item.title.includes('블루마운틴'));
  assert.equal(myrealtrip.deal.destination, '시드니', JSON.stringify(myrealtrip));
  assert.equal(myrealtrip.deal.priceFrom, 67048);
  assert.ok(myrealtrip.deal.badges.includes('10%'));
});

test('parses Korean date forms without inventing a date for unsupported text', () => {
  assert.equal(parseKoreanDate('2026.09.24', now), '2026-09-24');
  assert.equal(parseKoreanDate('2026-09-24', now), '2026-09-24');
  assert.equal(parseKoreanDate('09.24(목)', now), '2026-09-24');
  assert.equal(parseKoreanDate('9월 24일', now), '2026-09-24');
  assert.equal(parseKoreanDate('2026.02.30', now), null);
  assert.equal(parseKoreanDate('추후 공지', now), null);
});

test('filters listings whose explicit booking end is before now', async () => {
  const { fetchImpl } = fixtureFetch();
  const result = await fetchPlatformDeals(10, {
    fetchImpl,
    sites: ['yeogi'],
    now: new Date('2026-10-01T12:00:00+09:00'),
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.receipt.perSite[0].parsed, 2);
  assert.equal(result.receipt.perSite[0].skippedEnded, 1);
  assert.equal(result.items[0].deal.bookingEnd, '2026-11-09');
});

test('one failed site is recorded without losing successful site results', async () => {
  const { fetchImpl, calls } = fixtureFetch({
    tripcom: url => mockResponse(403, 'Forbidden', url),
  });
  const result = await fetchPlatformDeals(10, { fetchImpl, sites: ['tripcom', 'yeogi'], now });

  assert.equal(calls.length, 2);
  assert.equal(result.receipt.perSite[0].httpStatus, 403);
  assert.equal(result.receipt.perSite[0].skipped, 'HTTP_403');
  assert.equal(result.receipt.perSite[0].parsed, 0);
  assert.equal(result.receipt.perSite[1].parsed, 2);
  assert.equal(result.items.length, 2);
});

// Trimmed real rows from the ttang airfare list and urgent package list (2026-09-24).
const TTANG_AIR = `<table><tr><td><p class="shortCut">인천</p></td><td><p class="shortCut">보홀(필리핀)</p></td><td class="line2 airlogo"><p><img src="/images/common/airlineLogo/LJ.png">진에어</p></td><td>직항</td><td> 2026.10.09~2026.10.11 </td><td>편도</td><td class="price"><a href="#none" class="js_tooltip_btn">140,000원∼</a></td><td><a href="#none;" data-adtFare="140000" data-adtQcharge="0" data-arrCity="TAG" data-depCity="ICN" data-gubun="VV" data-airlineCode="LJ" class="btnSty1">예약하기</a></td></tr></table>`;
const TTANG_URGENT = `<table><tr><td><p class="bd">09/30(수) 18:10</p><p class="fc_blk3">10/04(일) 06:30</p></td><td><p class="shortCut">인천</p></td><td><p class="shortCut">[태국]</p><p class="shortCut">치앙마이</p></td><td class="line2 airlogo"><p class="shortCut">제주항공</p></td><td>3박5일</td><td class="al"><a href="#none" class="shortCut" ddId="1313" pnum="ATP5195-2609307C00">치앙마이 5일 #감성카페</a></td><td class="price"><a href="#none" class="js_tooltip_btn">449,000원</a><div class="tooltip"><ul><li>기본운임: 449,000원</li><li>유류할증료: 193,000원 </li></ul></div></td><td><a href="#none" class="btnSty1" ddId="1313" pnum="ATP5195-2609307C00">예약하기</a></td></tr></table>`;

test('Ttang airfare and urgent-package tables become priced deals with fuel surcharges disclosed', async () => {
  const { fetchImpl } = fixtureFetch({
    ttang: url => mockResponse(200, url.includes('/ttangair/') ? TTANG_AIR : TTANG_URGENT, url),
  });
  const result = await fetchPlatformDeals(10, { fetchImpl, sites: ['ttang'], now });
  const air = result.items.find(i => i.url.includes('/ttangair/'));
  const pkg = result.items.find(i => i.url.includes('getGoodsInfo'));
  assert.equal(air.deal.priceFrom, 140000);
  assert.equal(air.deal.travelStart, '2026-10-09');
  assert.match(air.url, /arr0=TAG&dep0=ICN&srhCar=LJ/);
  assert.equal(pkg.deal.priceFrom, 449000);
  assert.match(pkg.deal.priceText, /유류할증료 별도 193,000원/);
  assert.match(pkg.url, /ddId=1313&pnum=ATP5195-2609307C00/);
  assert.equal(pkg.deal.travelStart, '2026-09-30');
  assert.equal(result.receipt.perSite[0].skipped, null);
});

test('Agoda without a confirmed embedded deal listing is recorded as skipped', async () => {
  const { fetchImpl } = fixtureFetch();
  const result = await fetchPlatformDeals(10, { fetchImpl, sites: ['agoda'], now });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.receipt.perSite[0], {
    site: 'agoda', sourceUrl: SITES.agoda.sourceUrl, httpStatus: 200, dataSource: null,
    observedItems: 0, parsed: 0, skippedEnded: 0, skipped: 'NO_VERIFIED_EMBEDDED_DEALS',
  });
});

test('stops after a public page returns a bot challenge marker', async () => {
  const { fetchImpl, calls } = fixtureFetch({
    agoda: url => mockResponse(200, '<html><body>Checking your browser __CF$cv$params</body></html>', url),
  });
  const result = await fetchPlatformDeals(10, { fetchImpl, sites: ['agoda'], now });

  assert.equal(calls.length, 1);
  assert.equal(result.items.length, 0);
  assert.equal(result.receipt.perSite[0].httpStatus, 200);
  assert.equal(result.receipt.perSite[0].skipped, 'CHALLENGE_PAGE');
});
