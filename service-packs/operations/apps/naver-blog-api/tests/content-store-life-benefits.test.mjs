import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseApplyhomeList, parseApplyhomeDetail, parseLhList, benefitProgram, collect } from '../research/content-store/life-benefits-snapshot.mjs';
import { detectHousingSchedule, detectNewBenefits } from '../research/content-store/event-detectors.mjs';
import { LIFE_SEEDS } from '../research/content-store/event-scan.mjs';

const NOW = Date.parse('2026-09-25T03:00:00Z'); // 12:00 KST, Friday
const td = cells => cells.map(c => `<td>${c}</td>`).join('');
const aptRow = (id, name, region, announced, window, winner, kind = '민영') => `<tr data-pbno="${id}" data-hmno="${id}" data-honm="${name}">${td([region, kind, '분양주택', name, '(주)건설', '☎ 1600-0000', announced, window, winner, '<a>신청현황</a>', '<a>경쟁률</a>'])}</tr>`;
const APT_LIST = `<table><tr id="listThead"></tr>${aptRow('2026000453', '광명 에듀하임', '경기', '2026-09-18', '2026-09-29 ~ 2026-10-02', '2026-10-12')}${aptRow('2026000300', '오래된 단지', '부산', '2026-07-01', '2026-07-10 ~ 2026-07-12', '2026-07-20')}</table>`;
const REMNDR_LIST = `<tr data-pbno="2026930040" data-hmno="2026930040" data-hsecd="06" data-honm="강변역 아이파크">${td(['서울', '불법행위 재공급', '강변역 아이파크', '(주)신탁', '2026-09-23', '2026-10-06 ~ 2026-10-06', '2026-10-12', '경쟁률'])}</tr>`;
const table = rows => `<table>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const DETAIL = `<h2>입주자모집공고 주요정보</h2>${table([['광명 에듀하임'], ['공급위치', '경기도 광명시 소하동'], ['공급규모', '426세대']])}
${table([['모집공고일', '2026-09-18 (신문)'], ['청약접수', '구분', '해당지역', '기타지역', '접수장소'], ['특별공급', '2026-09-29', '2026-09-29', '인터넷'], ['1순위', '2026-09-30', '2026-10-01', '인터넷'], ['2순위', '2026-10-02', '2026-10-02', '인터넷']])}
<p>당첨자 발표일 2026-10-12 계약일 2026-10-24 ~ 2026-10-26 * 특이사항 : 투기과열지구, 청약과열지역 * 특별공급 종류에 따라</p>
${table([['주택 구분', '주택형', '면적', '공급세대수', '주택관리번호(모델번호)'], ['일반', '특별', '계'], ['민영', '059.9742A', '78.5', '10', '11', '21', '2026000453(01)'], ['084.8481A', '109.1', '36', '50', '86', '2026000453(03)']])}
${table([['주택형', '공급세대수'], ['다자녀 가구', '신혼부부', '생애최초', '청년', '노부모 부양', '신생아', '기관추천', '이전기관', '기타', '계'], ['059.9742A', '2', '3', '1', '0', '1', '2', '2', '0', '0', '11'], ['084.8481A', '9', '13', '7', '0', '3', '9', '9', '0', '0', '50']])}
${table([['주택형', '공급금액(최고가 기준)', '2순위 청약금'], ['059.9742A', '87,900', '없음'], ['084.8481A', '118,500']])}`;
const LH_LIST = `<table><tbody><tr><td>98</td><td class="cate">행복주택</td><td class="bbs_tit"><a href="javascript:" data-id1="2015122300020822" data-id2="03" data-id3="06" data-id4="09" class="wrtancInfoBtn"><span>남동구 청년 행복주택 예비입주자 모집 <em class="day">1일전</em></span></a></td><td>인천광역시</td><td></td><td>2026.09.23</td><td>2026.10.06</td><td>공고중</td><td>1,807</td></tr></tbody></table>`;

test('청약홈 lists: notice id, schedule and kind-specific columns', () => {
  const [a] = parseApplyhomeList(APT_LIST, 'apt');
  assert.deepEqual([a.noticeId, a.name, a.region, a.houseType, a.supplyKind, a.announcedAt, a.receiptStart, a.receiptEnd, a.winnerDate],
    ['2026000453', '광명 에듀하임', '경기', '민영', '분양주택', '2026-09-18', '2026-09-29', '2026-10-02', '2026-10-12']);
  assert.match(a.url, /selectAPTLttotPblancDetail\.do\?houseManageNo=2026000453&pblancNo=2026000453$/);
  const [r] = parseApplyhomeList(REMNDR_LIST, 'remndr');
  assert.deepEqual([r.source, r.supplyKind, r.builder, r.receiptStart, r.winnerDate], ['applyhome-remndr', '불법행위 재공급', '(주)신탁', '2026-10-06', '2026-10-12']);
});

test('청약홈 detail: schedule, units, special supply by type and price range', () => {
  const d = parseApplyhomeDetail(DETAIL);
  assert.equal(d.location, '경기도 광명시 소하동');
  assert.equal(d.totalUnits, 426);
  assert.deepEqual(d.specialSupply, { local: '2026-09-29', other: '2026-09-29', place: '인터넷' });
  assert.deepEqual(d.rank1, { local: '2026-09-30', other: '2026-10-01', place: '인터넷' });
  assert.equal(d.winnerDate, '2026-10-12');
  assert.equal(d.contract, '2026-10-24 ~ 2026-10-26');
  assert.equal(d.regulation, '투기과열지구, 청약과열지역');
  assert.deepEqual(d.units, { general: 46, special: 61, total: 107 });
  assert.equal(d.specialByType.newlywed, 16);
  assert.equal(d.specialByType.newborn, 11);
  assert.equal(Object.values(d.specialByType).reduce((s, n) => s + n, 0), 61, 'types add up to the special total');
  assert.deepEqual(d.priceManwon, { min: 87900, max: 118500, basis: '공급금액(최고가 기준)' });
  assert.throws(() => parseApplyhomeDetail('<p>대기열</p>'), /APPLYHOME_DETAIL_UNEXPECTED/);
});

test('LH list: title without the age badge, dotted dates and a rebuilt detail link', () => {
  const [l] = parseLhList(LH_LIST);
  assert.deepEqual([l.name, l.houseType, l.region, l.announcedAt, l.receiptEnd, l.status], ['남동구 청년 행복주택 예비입주자 모집', '행복주택', '인천광역시', '2026-09-23', '2026-10-06', '공고중']);
  assert.equal(l.url, 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?panId=2015122300020822&ccrCnntSysDsCd=03&uppAisTpCd=06&aisTpCd=09&mi=1026');
});

test('collect: list pages stop at the age window, details only for open notices, redirects are never followed, no key → KEY_MISSING', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(String(url));
    assert.equal(opts.redirect, 'manual');
    const body = /selectAPTLttotPblancListView/.test(url) ? APT_LIST : /Remndr/.test(url) ? REMNDR_LIST : /Detail\.do/.test(url) ? DETAIL : LH_LIST;
    return { status: 200, text: async () => body };
  };
  const r = await collect({ fetchImpl, now: NOW, pauseMs: 0, store: { readCredential: () => null } });
  assert.equal(calls.filter(u => /selectAPTLttotPblancListView/.test(u)).length, 1, 'page 1 already reached notices older than 45 days');
  assert.deepEqual(r.housing.filter(h => h.source === 'applyhome-apt').map(h => h.name), ['광명 에듀하임']);
  assert.equal(r.housing.find(h => h.source === 'applyhome-apt').detail.totalUnits, 426);
  assert.equal(r.sources['gov24-benefits'].error, 'KEY_MISSING');
  assert.equal(r.benefits, null);
  const blocked = await collect({ fetchImpl: async () => ({ status: 302, text: async () => '' }), now: NOW, pauseMs: 0 });
  assert.equal(blocked.sources['applyhome-apt-list'].error, 'REDIRECTED');
  assert.equal(blocked.sources['lh-notice-list'].error, 'REDIRECTED');
});

test('collect: the 공공데이터포털 key goes in the Authorization header only', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    if (String(url).startsWith('https://api.odcloud.kr/')) {
      seen.push({ url: String(url), auth: opts.headers.authorization });
      return { status: 200, json: async () => ({ totalCount: 1, data: [{ 서비스ID: 'S1', 서비스명: '신혼부부 전세자금대출', 소관기관명: '국토교통부', 등록일시: '20260922000000', 조회수: '10' }] }) };
    }
    return { status: 200, text: async () => (/Detail\.do/.test(url) ? DETAIL : /Remndr/.test(url) ? REMNDR_LIST : /wrtanc/.test(url) ? LH_LIST : APT_LIST) };
  };
  const key = 'k'.repeat(40);
  const r = await collect({ fetchImpl, now: NOW, pauseMs: 0, store: { readCredential: () => JSON.stringify({ version: 1, serviceKey: key }) } });
  assert.equal(r.benefits.length, 1);
  assert.equal(seen[0].auth, `Infuser ${key}`);
  assert.ok(!seen[0].url.includes(key), 'key never in the URL');
  assert.ok(!JSON.stringify(r).includes(key), 'key never in the output');
  assert.deepEqual(benefitProgram({ 서비스ID: 7, 서비스명: 'x', 조회수: '1,234' }).views, 1234);
});

test('housing_schedule: one weekly roundup of notices opening in the next two weeks, 수도권 first, plus LH rentals', () => {
  const life = { checkedAt: 'x', housing: [
    { source: 'applyhome-apt', noticeId: '1', name: '광명', region: '경기', receiptStart: '2026-09-29', receiptEnd: '2026-10-02', url: 'u1', detail: { totalUnits: 426, specialByType: { newlywed: 64, firstHome: 30, newborn: 43 } } },
    { source: 'applyhome-apt', noticeId: '2', name: '부산', region: '부산', receiptStart: '2026-09-28', receiptEnd: '2026-09-30', url: 'u2', detail: { totalUnits: 900, specialByType: { newlywed: 10 } } },
    { source: 'applyhome-apt', noticeId: '3', name: '먼 미래', region: '서울', receiptStart: '2026-11-20', receiptEnd: '2026-11-22', url: 'u3', detail: { totalUnits: 50 } },
    { source: 'applyhome-apt', noticeId: '4', name: '마감', region: '서울', receiptStart: '2026-09-10', receiptEnd: '2026-09-12', url: 'u4', detail: { totalUnits: 50 } },
    { source: 'applyhome-remndr', noticeId: '5', name: '강변', region: '서울', receiptStart: '2026-10-06', receiptEnd: '2026-10-06', url: 'u5' },
    { source: 'applyhome-remndr', noticeId: '6', name: '지방 줍줍', region: '대구', receiptStart: '2026-10-06', receiptEnd: '2026-10-06', url: 'u6' },
    { source: 'lh', noticeId: '7', name: '남동구 청년 행복주택', region: '인천광역시', receiptEnd: '2026-10-06', url: 'u7' },
    { source: 'lh', noticeId: '8', name: '[정정공고]남동구 청년 행복주택', region: '인천광역시', receiptEnd: '2026-10-06', url: 'u8' },
    { source: 'lh', noticeId: '9', name: '영구임대 예비입주자', region: '경기도', receiptEnd: '2026-10-06', url: 'u9' },
  ] };
  const [e] = detectHousingSchedule(life, { now: NOW });
  assert.deepEqual(e.data.items.map(i => i.name), ['광명', '강변', '부산'], '수도권 first, then units; far-off, closed and non-capital 무순위 dropped');
  assert.deepEqual(e.data.rentals.map(r => r.name), ['남동구 청년 행복주택']);
  assert.equal(e.key, 'housing:2026-09-21', 'KST week start (Monday)');
  assert.match(e.headline, /청약 일정 3곳 \(1,326세대, 신혼부부 특공 74세대\) \+ LH 임대 1건/);
  assert.deepEqual(detectHousingSchedule({ housing: life.housing.slice(2, 4) }, { now: NOW }), [], 'fewer than 2 items → no event');
});

test('benefit_new: recent programs that match the ontology seeds, none without the API data', () => {
  assert.ok(LIFE_SEEDS.includes('신혼부부 전세자금대출') && LIFE_SEEDS.length >= 40, 'seeds come from life-benefits-ontology.json');
  const life = { benefits: [
    { serviceId: 'a', name: '신혼부부 전세자금대출', registeredAt: '2026-09-22 10:00:00', views: 5, url: 'https://www.gov.kr/a' },
    { serviceId: 'b', name: '어업인 지원', registeredAt: '2026-09-22 10:00:00', views: 50 },
    { serviceId: 'c', name: '부모급여', registeredAt: '2026-08-01 10:00:00', views: 90 },
  ] };
  assert.deepEqual(detectNewBenefits(life, { now: NOW, seeds: LIFE_SEEDS }).map(e => e.key), ['benefit:a']);
  assert.deepEqual(detectNewBenefits({ benefits: null }, { now: NOW, seeds: LIFE_SEEDS }), []);
});

test('ontology: every topic source is registered, keyed sources name their dataset', () => {
  const o = JSON.parse(readFileSync(new URL('../research/content-store/life-benefits-ontology.json', import.meta.url), 'utf8'));
  const ids = new Set(o.sources.map(s => s.id));
  for (const d of o.domains) for (const t of d.topics) for (const s of t.sources) assert.ok(ids.has(s), `${t.id} → ${s}`);
  for (const s of o.sources.filter(s => s.access === 'data_go_kr_key')) assert.match(s.dataset, /^https:\/\/www\.data\.go\.kr\/data\/\d+\/openapi\.do$/);
  const stages = new Set(o.lifeStages.map(s => s.id));
  for (const d of o.domains) for (const s of d.stages) assert.ok(stages.has(s), `${d.id} stage ${s}`);
});
