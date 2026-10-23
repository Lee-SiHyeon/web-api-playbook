import test from 'node:test';
import assert from 'node:assert/strict';
import { AIRLINES, fetchAirlinePromos, parseKoreanDateRange } from '../research/content-store/airline-promos.mjs';

const now = new Date('2026-09-24T12:00:00+09:00');

// Trimmed card markup copied from one anonymous 200 response per usable list page.
const FIXTURES = {
  asiana: [
    '<li><a href="./detail/CM202609150002530595" class="inner_box"><span class="list_info"><em class="title">동남아 미식여행</em><span class="date">2026-09-22 ~ 2026-10-16</span></span></a></li>',
    '<li><a href="./detail/CM202609070002530349" class="inner_box"><span class="list_info"><em class="title">설레는 유럽 여행의 시작</em><span class="date">2026-09-21 ~ 2026-10-18</span></span></a></li>',
    '<li><a href="./detail/CM202609100002530415" class="inner_box"><span class="list_info"><em class="title">카카오페이로 결제 시 즉시 할인 &amp; 항공권 할인 혜택</em><span class="date">2026-09-21 ~ 2026-09-30</span></span></a></li>',
  ].join('\n'),
  trinity: [
    '<li><a href="#" onclick="showEventContent(this);" data-eventSeq="2578" data-eventTitle="트리니티항공의 첫 프로모션" data-addInfo="+vaxeHVXldxDW7Blh8+EcA==" data-dday="D6"><strong><span>트리니티항공의 첫 프로모션</span></strong><p class="sbj_sub">항공권부터 기내까지, 특별한 혜택</p><p>2026-09-14 ~ 2026-09-30</p></a></li>',
    '<li><a href="#" onclick="showEventContent(this);" data-eventSeq="2340" data-eventTitle="9월 결제 할인 혜택" data-addInfo="xviQ8REe6TiP+P844vi3Pg==" data-dday="D6"><strong><span>9월 결제 할인 혜택</span></strong><p class="sbj_sub">항공권 예매 전 확인 필수!</p><p>2026-09-01 ~ 2026-09-30</p></a></li>',
    '<li><a href="#" onclick="showEventContent(this);" data-eventSeq="2460" data-eventTitle="신한카드 제휴 혜택" data-addInfo="CUnC6vJnTJgnP89miDMyZw==" data-dday="D37"><strong><span>신한카드 제휴 혜택</span></strong><p class="sbj_sub">16만원 혜택 + SOLpay 쿠폰 할인</p><p>2026-09-01 ~ 2026-10-31</p></a></li>',
  ].join('\n'),
  jejuair: [
    '<div class="main-carousel__item"><a href="/ko/event/eventDetail.do?eventNo=0000004322" class="event-banner-item"><span class="event-banner__text">🌕10~12월 출발🌕</span><p class="event-banner__title">연휴에도 풍성하게<br/>최대 55% 할인</p><span class="event-banner__date">2026.09.24&nbsp;~&nbsp;2026.09.27</span></a></div>',
    '<div class="main-carousel__item"><a href="/ko/event/eventDetail.do?eventNo=0000004309" class="event-banner-item"><span class="event-banner__text">함께 할인에 포인트를 더해요</span><p class="event-banner__title">J 멤버스<br/>더- 드림</p><span class="event-banner__date">2026.09.21&nbsp;~&nbsp;2026.10.04</span></a></div>',
    '<div class="search-result__item"><a href="/ko/event/eventDetail.do?eventNo=0000004230"><p class="search-result__text-large">마카오 50% 할인지금이 기회!</p><span class="search-result__text-sub date">2026.09.08 ~ 2026.09.23</span></a></div>',
  ].join('\n'),
};

function mockResponse(status, body, url) {
  return {
    status,
    url,
    headers: { get: name => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null },
    text: async () => body,
  };
}

function fixtureFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const entry = Object.entries(AIRLINES).find(([, config]) => config.url === url);
    const airline = entry?.[0];
    const override = overrides[airline];
    if (override) return override(url);
    if (!FIXTURES[airline]) throw new Error('NO_FIXTURE');
    return mockResponse(200, FIXTURES[airline], url);
  };
  return { fetchImpl, calls };
}

test('parses 2–3 event cards from each working airline fixture and filters ended items', async () => {
  const { fetchImpl } = fixtureFetch();
  const result = await fetchAirlinePromos(30, {
    fetchImpl,
    airlines: ['asiana', 'trinity', 'jejuair'],
    now,
  });

  assert.equal(result.receipt.browserUsed, false);
  assert.equal(result.items.length, 8);
  assert.ok(result.items.every(item => item.title.startsWith('[') && item.url.startsWith('https://')));
  assert.deepEqual(result.receipt.perAirline.map(row => [
    row.httpStatus, row.observedItems, row.parsed, row.skippedEnded, row.error,
  ]), [
    [200, 3, 3, 0, null],
    [200, 3, 3, 0, null],
    [200, 3, 3, 1, null],
  ]);

  const asiana = result.items.find(item => item.title.includes('동남아 미식여행'));
  assert.equal(asiana.title, '[아시아나항공] 동남아 미식여행');
  assert.equal(asiana.url, 'https://flyasiana.com/C/KR/KO/event/detail/CM202609150002530595');
  assert.equal(asiana.publishedAt, '2026-09-22');
  assert.deepEqual(asiana.deal, {
    airline: '아시아나항공',
    purchaseStart: '2026-09-22',
    purchaseEnd: '2026-10-16',
    travelStart: null,
    travelEnd: null,
    routes: [],
  });
  assert.match(asiana.summary, /구매 기간 2026\.09\.22~2026\.10\.16/);
  assert.match(asiana.summary, /탑승 기간 미표기/);

  const trinity = result.items.find(item => item.title.includes('첫 프로모션'));
  assert.equal(trinity.url, 'https://www.trinityairways.com/app/promotion/event/retrieve/-vaxeHVXldxDW7Blh8-EcA==/being/n');
  assert.equal(trinity.deal.purchaseEnd, '2026-09-30');
  assert.equal(result.items.some(item => item.url.includes('eventNo=0000004230')), false);
});

test('parses dotted and Korean weekday date ranges', () => {
  assert.deepEqual(
    parseKoreanDateRange('2026.09.16 ~ 2026.09.27', now),
    { start: '2026-09-16', end: '2026-09-27' },
  );
  assert.deepEqual(
    parseKoreanDateRange('09.16(화)~09.27(토)', now),
    { start: '2026-09-16', end: '2026-09-27' },
  );
});

test('isolates an airline HTTP failure and retains successful airlines', async () => {
  const { fetchImpl, calls } = fixtureFetch({
    trinity: url => mockResponse(403, 'Forbidden', url),
  });
  const result = await fetchAirlinePromos(30, {
    fetchImpl,
    airlines: ['asiana', 'trinity', 'jejuair'],
    now,
  });

  assert.equal(calls.length, 3);
  assert.equal(result.items.length, 5);
  assert.equal(result.receipt.perAirline[1].httpStatus, 403);
  assert.equal(result.receipt.perAirline[1].error, 'HTTP_403');
  assert.equal(result.receipt.perAirline[1].parsed, 0);
  assert.ok(result.items.some(item => item.publisher === '아시아나항공'));
  assert.ok(result.items.some(item => item.publisher === '제주항공'));
});

test('records Peach 200 redirect to the Japanese homepage as an unusable list response', async () => {
  const html = '<!doctype html><html><head><title>Peach home</title></head><body>Recommended information</body></html>';
  const result = await fetchAirlinePromos(10, {
    fetchImpl: async () => mockResponse(200, html, 'https://www.flypeach.com/'),
    airlines: ['peach'],
    now,
  });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.receipt.perAirline[0], {
    airline: '피치항공',
    httpStatus: 200,
    observedItems: 0,
    parsed: 0,
    skippedEnded: 0,
    error: 'UNEXPECTED_PAGE',
  });
});
