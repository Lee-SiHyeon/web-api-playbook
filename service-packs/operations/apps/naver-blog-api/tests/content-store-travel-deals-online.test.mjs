import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SITES,
  fetchOnlineAgencyDeals,
  filterEndedDeals,
  parseKoreanDate,
  parseKoreanDateRange,
} from '../research/content-store/travel-deals-online.mjs';

const now = new Date('2026-09-24T12:00:00+09:00');

// Trimmed public response fragments observed from each live listing page.
const KYOWON_HTML = `
<div class="list-item" name="eventItem" data-seq="8147">
  <div class="item-info"><span class="category">호주</span><span class="tit">뉴질랜드/호주</span><span class="txt">대자연의 뉴질랜드, 시티투어의 호주</span></div>
</div>
<div class="list-item" name="eventItem" data-seq="8144">
  <div class="item-info"><span class="category">이집트</span><span class="tit">이집트 일주</span><span class="txt">올 겨울, 가장 특별한 이집트!</span></div>
</div>
<div class="list-item" name="eventItem" data-seq="8059">
  <div class="item-info"><span class="category">중국&amp;대만</span><span class="tit">부산출발 중국&amp;대만 여행</span><span class="txt">국적기의 품격 대한항공과 함께</span></div>
</div>`;

const LOTTE_HTML = `
<ul>
  <li class="bn1"><div class="item_dim"><a href="/promotion/3908" class="btn_go">자세히 보기</a></div><img src="//image1.lottetour.com/static/promotion/2026/09/3908/rec_h.jpg" alt="세계테마여행" /></li>
  <li class="bn2"><div class="item_dim"><a href="/promotion/2747" class="btn_go">자세히 보기</a></div><img src="//image1.lottetour.com/static/promotion/2024/05/2747/rec_w.jpg" alt="[비즈니스탑승] 아프리카" /></li>
  <li class="bn3"><div class="item_dim"><a href="/promotion/3241" class="btn_go">자세히 보기</a></div><img src="//image1.lottetour.com/static/promotion/2025/05/3241/rec_w.jpg" alt="프라이빗 우리만의 여행" /></li>
</ul>`;

// The airfare list response contained one row in its inline JSON array. Fields
// omitted here were not needed to check parsing; price remains unknown if absent.
const ONLINE_AIR_HTML = `<script>var dCairAllListStr = '[{"event_price_seq":"59051357","start_city_code":"ICN","end_city_code":"KLO","start_city_code_name2":"칼리보","dep_start_date":"20260930"}]';</script>`;
const ONLINE_PROMOTION_HTML = '<a href="/promotion/w/exhibition/view?idx=">상세보기</a>';

const WEBTOUR_HOME_HTML = `
<a href="//www2.webtour.com/gevent/dh/korfesta/2609/index.asp"></a>
<a href="//www2.webtour.com/gevent/festa/2609/index.asp"></a>`;

const WEBTOUR_FESTA_HTML = `
<a href="#this" onclick="goEvtGdsDetail_Pop('DG', 'G', 'DGI004584', 'blank');return false;" class="list">
  <span class="thumb"><img src="//img.webtour.com/WebUpload/GdsImg/DGI004584/2026090915073124980567.jpg" alt=""></span>
  <span class="info"><span class="name">[섬단풍 나리분지트레킹][전문인솔자]울릉도/독도3일</span>
  <span class="txt">타사비교필수! 전문인솔자동행 <br>나리분지 ~신령수길 숲길걷기<br>노쇼핑.노옵션.노팁!</span>
  <span class="price"><span class='m'><strong>535,000</strong>원~ </span><span class="dcp">599,000원</span> <span class='dc-p'>11%↓</span></span></span>
</a>
<a href="#this" onclick="goEvtGdsDetail_Pop('DJ', 'G', 'DGJ003559', 'blank');return false;" class="list">
  <span class="thumb"><img src="//img.webtour.com/WebUpload/GdsImg/DGJ003559/2026050814114429675841.jpg" alt=""></span>
  <span class="info"><span class="name">[♡체크인시 와인1병 제공♡] 파르나스 호텔_항공_렌터카_3일</span>
  <span class="txt">체크인시 와인 1병 제공<br>바다와 맞닿은 듯한 야외 인피니티풀 무료<br>전일정 자차보험포함</span>
  <span class="price"><span class='m'><strong>411,800</strong>원~ </span><span class="dcp">519,000원</span> <span class='dc-p'>21%↓</span></span></span>
</a>
<a href="#this" onclick="goEvtGdsDetail_Pop('DG', 'G', 'DGI003937', 'blank');return false;" class="list">
  <span class="thumb"><img src="//img.webtour.com/WebUpload/GdsImg/DGI003937/2026081210012864017923.jpg" alt=""></span>
  <span class="info"><span class="name">[프리미엄여행]다도해일주 3일(해남/청산도/완도/진도/정읍)</span>
  <span class="txt">지역별 특급호텔 이용, 전일정 식사제공<br>28석 우등버스&amp; 전문인솔가이드 동행<br>노팁! 노쇼핑! 노옵션!</span>
  <span class="price"><span class='m'><strong>760,000</strong>원~ </span><span class="dcp">860,000원</span> <span class='dc-p'>12%↓</span></span></span>
</a>`;

function htmlResponse(body, status = 200, contentType = 'text/html; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function fixtureFetch(overrides = {}) {
  const calls = [];
  const responses = new Map([
    [SITES.kyowontour.url, KYOWON_HTML],
    [SITES.lottetour.url, LOTTE_HTML],
    [SITES.onlinetourAir.airUrl, ONLINE_AIR_HTML],
    [SITES.onlinetourAir.promotionUrl, ONLINE_PROMOTION_HTML],
    [SITES.webtour.homeUrl, WEBTOUR_HOME_HTML],
    ['https://www2.webtour.com/gevent/festa/2609/index.asp', WEBTOUR_FESTA_HTML],
  ]);
  return {
    calls,
    fetchImpl: async (url, options) => {
      const href = String(url);
      calls.push({ href, options });
      if (overrides[href]) return overrides[href](url, options);
      if (!responses.has(href)) throw new Error('NO_FIXTURE');
      const body = responses.get(href);
      const charset = href === SITES.webtour.homeUrl ? 'text/html; charset=euc-kr' : 'text/html; charset=utf-8';
      return htmlResponse(body, 200, charset);
    },
  };
}

test('parses public listing fixtures and records each observed data source', async () => {
  const { fetchImpl, calls } = fixtureFetch();
  const result = await fetchOnlineAgencyDeals(30, { fetchImpl, now });

  assert.equal(calls.length, 6);
  assert.ok(calls.every(({ options }) => options.method === 'GET' && options.credentials === 'omit'));
  assert.ok(calls.every(({ options }) => !Object.keys(options.headers).some(key => /cookie|authorization/i.test(key))));
  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.items.length, 10);

  const kyowon = result.items.filter(item => item.publisher === '교원투어');
  const lotte = result.items.filter(item => item.publisher === '롯데관광');
  const online = result.items.filter(item => item.publisher === '온라인투어');
  const webtour = result.items.filter(item => item.publisher === '웹투어');
  assert.equal(kyowon.length, 3);
  assert.equal(lotte.length, 3);
  assert.equal(online.length, 1); // One airfare row was present in the fetched inline JSON.
  assert.equal(webtour.length, 3);

  assert.equal(kyowon[0].title, '[교원투어] 뉴질랜드/호주');
  assert.equal(kyowon[0].url, 'https://www.kyowontour.com/etc/promotion/promotionView?eventSeq=8147');
  assert.equal(kyowon[0].deal.destination, '호주');
  assert.equal(lotte[0].title, '[롯데관광] 세계테마여행');
  assert.equal(lotte[0].url, 'https://www.lottetour.com/promotion/3908');
  assert.equal(online[0].deal.destination, '칼리보');
  assert.equal(online[0].deal.travelStart, '2026-09-30');
  assert.equal(webtour[0].title, '[웹투어] [섬단풍 나리분지트레킹][전문인솔자]울릉도/독도3일');
  assert.equal(webtour[0].url, 'https://www2.webtour.com/dg/dg_detail.asp?GdsCode=DGI004584');
  assert.equal(webtour[0].deal.priceFrom, 535000);
  assert.equal(webtour[0].deal.priceText, '535,000원~');
  assert.equal(webtour[0].deal.destination, '울릉도/독도');

  const byUrl = new Map(result.receipt.perSite.map(row => [row.sourceUrl, row]));
  assert.equal(byUrl.get(SITES.kyowontour.url).dataSource, 'html');
  assert.equal(byUrl.get(SITES.lottetour.url).parsed, 3);
  assert.equal(byUrl.get(SITES.onlinetourAir.airUrl).dataSource, 'embedded_json');
  assert.equal(byUrl.get(SITES.onlinetourAir.promotionUrl).dataSource, 'html');
  assert.equal(byUrl.get('https://www2.webtour.com/gevent/festa/2609/index.asp').dataSource, 'html');
  assert.equal(byUrl.get('https://www2.webtour.com/gevent/festa/2609/index.asp').site, 'webtour');
  assert.ok(result.items.every(item => item.title.startsWith(`[${item.publisher}]`) && item.url.startsWith('https://')));
});

test('parses full, dotted, hyphenated, short weekday, and Korean month dates', () => {
  assert.equal(parseKoreanDate('2026.09.24', now), '2026-09-24');
  assert.equal(parseKoreanDate('2026-09-24', now), '2026-09-24');
  assert.equal(parseKoreanDate('09.24(목)', now), '2026-09-24');
  assert.equal(parseKoreanDate('9월 24일', now), '2026-09-24');
  assert.deepEqual(parseKoreanDateRange('9월 20일 ~ 9월 30일', now), {
    start: '2026-09-20', end: '2026-09-30',
  });
});

test('keeps a missing price as null instead of deriving one', async () => {
  const { fetchImpl } = fixtureFetch();
  const result = await fetchOnlineAgencyDeals(30, { fetchImpl, sites: ['kyowontour', 'lottetour'], now });
  const kyowon = result.items.find(item => item.publisher === '교원투어');
  const lotte = result.items.find(item => item.publisher === '롯데관광');
  assert.equal(kyowon.deal.priceFrom, null);
  assert.equal(kyowon.deal.priceText, null);
  assert.equal(lotte.deal.priceFrom, null);
  assert.equal(lotte.deal.priceText, null);
});

test('filters deals whose booking end date is before today in Seoul', () => {
  const kept = { url: 'https://example.test/current', deal: { bookingEnd: '2026-09-24' } };
  const expired = { url: 'https://example.test/ended', deal: { bookingEnd: '2026-09-23' } };
  const unknown = { url: 'https://example.test/unknown', deal: { bookingEnd: null } };
  assert.deepEqual(filterEndedDeals([kept, expired, unknown], now), [kept, unknown]);
});

test('isolates one site HTTP failure and continues collecting the other site', async () => {
  const { fetchImpl, calls } = fixtureFetch({
    [SITES.kyowontour.url]: () => htmlResponse('Unavailable', 503),
  });
  const result = await fetchOnlineAgencyDeals(10, {
    fetchImpl,
    sites: ['kyowontour', 'lottetour'],
    now,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.receipt.perSite[0].httpStatus, 503);
  assert.equal(result.receipt.perSite[0].skipped, 'HTTP_503');
  assert.equal(result.items.length, 3);
  assert.ok(result.items.every(item => item.publisher === '롯데관광'));
});

test('stops further requests to a site after HTTP 429', async () => {
  const { fetchImpl, calls } = fixtureFetch({
    [SITES.onlinetourAir.airUrl]: () => htmlResponse('Too many requests', 429),
  });
  const result = await fetchOnlineAgencyDeals(10, {
    fetchImpl,
    sites: ['onlinetourAir', 'lottetour'],
    now,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.href), [SITES.onlinetourAir.airUrl, SITES.lottetour.url]);
  assert.equal(result.receipt.perSite[0].httpStatus, 429);
  assert.equal(result.receipt.perSite[0].skipped, 'HTTP_429');
  assert.equal(result.items.length, 3);
});
