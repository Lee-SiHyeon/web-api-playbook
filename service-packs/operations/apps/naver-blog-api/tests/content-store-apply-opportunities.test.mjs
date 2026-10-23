import test from 'node:test';
import assert from 'node:assert/strict';
import { fromRevu, fromBrandconnect, collectBrandconnect, parseWevityList, parseWevityDetail, wevityEligibility, parseLinkareerList, parseLinkareerDetail, fromLinkareer, validateOpportunity, assessFit, buildDigest, loadOntology } from '../research/content-store/apply-opportunities.mjs';

const ONTOLOGY = loadOntology();
const PROFILE = { channels: [{ id: 'blog', platform: 'naver_blog' }], topics: ['AI', '웹/모바일/IT', '생활'], region: null, ageGroup: null, isStudent: null, hasBusiness: null, teamAvailable: null };
const NOW = '2026-09-26T07:00:00Z';
const revu = (extra = {}) => ({ id: 1, item: '[브랜드] 생활 가전', media: 'blog', category: ['배송형', '생활'], status: 'REQUEST', enableRequest: true, active: true,
  requestEndedOn: '2026-09-28', entryAnnouncedOn: '2026-09-29', postingStartedOn: '2026-09-30', postingEndedOn: '2026-10-12', requiredPostCount: 1, reviewerLimit: 10,
  campaignData: { point: 0, reward: '가전 1개' }, campaignStats: { requestCount: 25 }, campaignOptions: { minimumInfluenceCount: null }, ...extra });

test('레뷰 campaign → opportunity: mode from category labels, reward raw kept, disclosure obligation, competition', () => {
  const o = fromRevu(revu(), NOW);
  assert.equal(o.deliveryMode, 'delivery');
  assert.equal(o.reward.raw, '가전 1개');
  assert.ok(o.obligations.some(x => x.type === 'disclosure_required'));
  assert.deepEqual(o.competition, { applicants: 25, slots: 10 });
  assert.deepEqual(validateOpportunity(o, ONTOLOGY), []);
  assert.equal(fromRevu(revu({ category: ['기자단형', '기자단_제품'] }), NOW).deliveryMode, 'reporter');
  const visit = fromRevu(revu({ category: ['숙박', '방문형'], venue: { name: '호텔', addressFirst: '경기 광명시 철산동 1' }, campaignData: { point: 0, reward: '숙박권' } }), NOW);
  assert.equal(visit.reward.type, 'lodging');
  assert.equal(visit.location.region, '경기 광명시');
});

test('위비티 list and detail parsing', () => {
  const list = parseWevityList('<ul class="list"><li class="top"><div class="tit">공모전명</div></li><li ><div class="tit"> <a href="?c=find&s=1&gbn=view&gp=1&ix=111">AI 공모전 <span class=\'stat spec\'>SPECIAL</span> </a> <div class="sub-tit">분야 : 기획/아이디어, 웹/모바일/IT</div> </div> <div class="organ">과학기술정보통신부</div> <div class="day"> D-6 <span class="dday soon">마감임박</span> </div> <div class="read">1,234</div> </li></ul>');
  assert.deepEqual(list, [{ ix: '111', title: 'AI 공모전', fields: ['기획/아이디어', '웹/모바일/IT'], host: '과학기술정보통신부', dday: 'D-6', status: '마감임박', views: 1234 }]);
  const d = parseWevityDetail('<ul class="cd-info-list"><li> <span class="tit">분야</span> 웹/모바일/IT </li><li> <span class="tit">응모대상</span> 대학생 </li><li class="dday-area"> <span class="tit">접수기간</span> 2026-09-01 ~ 2026-10-07 <span class="cil-dday">D-11</span> </li><li> <span class="tit">총 상금</span> 1천만원이하 </li><li> <span class="tit">홈페이지</span> <a href="https://x.example" target="_blank">x</a> </li></ul><div>상세내용 만 19세이상 35세이하 청년으로 구성된 팀(3~5명)</div>');
  assert.equal(d.applyEnd, '2026-10-07');
  assert.equal(d.homepage, 'https://x.example');
  const el = wevityEligibility(d);
  assert.deepEqual(el.flags.map(f => f.flag).sort(), ['age_limited', 'students_only', 'team_required']);
  assert.deepEqual(wevityEligibility({ target: '청소년', body: '' }).flags.map(f => f.flag), ['age_limited']);
  assert.deepEqual(wevityEligibility({ target: '일반인', body: '참가비 1만원을 납부' }).risks, ['participation_fee']);
  assert.deepEqual(wevityEligibility({ target: '일반인', body: '참가비 없음' }).risks, []);
});

test('fit: unknown profile values give watch, mismatches skip, closed items skip, never one merged score', () => {
  const today = '2026-09-26';
  const ok = assessFit(fromRevu(revu(), NOW), PROFILE, { today });
  assert.equal(ok.decision, 'notify');
  assert.equal(ok.axes.competition, 2.5);
  const insta = assessFit(fromRevu(revu({ media: 'instagram' }), NOW), PROFILE, { today });
  assert.equal(insta.decision, 'skip');
  const visit = assessFit(fromRevu(revu({ category: ['방문형'], venue: { addressFirst: '부산 해운대구 우동 1' } }), NOW), PROFILE, { today });
  assert.equal(visit.decision, 'watch');
  assert.equal(assessFit(fromRevu(revu({ category: ['방문형'], venue: { addressFirst: '부산 해운대구 우동 1' } }), NOW), { ...PROFILE, region: '서울 동작구' }, { today }).decision, 'skip');
  assert.equal(assessFit(fromRevu(revu({ status: 'CLIENT_PICK' }), NOW), PROFILE, { today }).decision, 'skip');
  const student = { id: 'wevity:1', source: 'wevity', kind: 'contest', title: 'AI 공모전', url: 'https://www.wevity.com/x', checkedAt: NOW, categories: ['웹/모바일/IT'], deliveryMode: 'online',
    reward: { type: 'prize_money', raw: null }, obligations: [{ type: 'submission' }], eligibility: [{ flag: 'students_only' }], schedule: { applyEnd: '2026-10-07' }, open: true, risks: [] };
  assert.equal(assessFit(student, PROFILE, { today }).decision, 'watch');
  assert.equal(assessFit(student, { ...PROFILE, isStudent: false }, { today }).decision, 'skip');
  assert.equal(assessFit({ ...student, eligibility: [{ flag: 'anyone' }], risks: ['participation_fee'] }, PROFILE, { today }).decision, 'skip');
});

test('digest lists the least crowded campaigns first and reminds of the disclosure duty', () => {
  const today = '2026-09-26';
  const items = [revu({ id: 1, campaignStats: { requestCount: 900 } }), revu({ id: 2, item: '[B] 생활 제품', campaignStats: { requestCount: 5 } })]
    .map(c => fromRevu(c, NOW)).map(o => ({ o, f: assessFit(o, PROFILE, { today }) }));
  const text = buildDigest(items, { today });
  assert.ok(text.indexOf('campaign/2') < text.indexOf('campaign/1'));
  assert.match(text, /제공받아 작성/);
  assert.equal(buildDigest([], { today }), null);
});

const bc = (extra = {}) => ({ id: 1001310749359842, name: '[프롬비] 프리미엄 극세사 토끼털 대형 전기담요', campaignType: 'RECRUITMENT', commonStatus: 'PRE_PROCEEDING',
  contents: [{ submissionType: 'REQUIRED', contentChannelType: 'NBLOG', cashReward: 65200, submissionStartAt: '2026-10-06', submissionEndAt: '2026-10-12' }],
  products: [{ name: '전기담요', price: 168000, amount: 1, offerType: 'PROVIDED' }], recruitmentTargetCount: 15, recruitmentApplyCount: 2,
  recruitmentStartAt: '2026-09-30', recruitmentEndAt: '2099-10-04T23:59:59', ...extra });

test('브랜드커넥트 campaign → opportunity: cash + product reward, blog channel, competition, visit by name', () => {
  const o = fromBrandconnect(bc(), NOW);
  assert.deepEqual(validateOpportunity(o, ONTOLOGY), []);
  assert.deepEqual([o.media, o.deliveryMode, o.reward.type, o.reward.amount, o.reward.productValue], ['blog', 'delivery', 'cash', 65200, 168000]);
  assert.equal(o.reward.raw, '원고료 65,200원 + 상품 168,000원 상당');
  assert.deepEqual(o.competition, { applicants: 2, slots: 15 });
  assert.equal(assessFit(o, PROFILE).axes.channel, 'match');
  const insta = fromBrandconnect(bc({ contents: [{ submissionType: 'REQUIRED', contentChannelType: 'INSTAGRAM', cashReward: 0 }] }), NOW);
  assert.equal(assessFit(insta, PROFILE).axes.channel, 'mismatch');
  const hotel = fromBrandconnect(bc({ name: '[경주] 지지호텔 블로그 체험단 (10월)' }), NOW);
  assert.deepEqual([hotel.deliveryMode, hotel.location.region], ['visit', '경주']);
  assert.equal(assessFit(hotel, PROFILE).decision, 'watch', 'region is not set in the profile');
});

test('브랜드커넥트 collector pages until the cursor ends and reports a failed read', () => {
  const pages = [{ ok: true, data: { data: [bc()], paging: { total: 2, nextCursor: 2 } } }, { ok: true, data: { data: [bc({ id: 2 })], paging: { total: 2, nextCursor: null } } }];
  const r = collectBrandconnect({ run: () => pages.shift(), checkedAt: NOW });
  assert.deepEqual([r.total, r.opportunities.length, r.error], [2, 2, undefined]);
  assert.equal(collectBrandconnect({ run: () => ({ ok: false, code: 'SESSION_EXPIRED' }) }).error, 'SESSION_EXPIRED');
});

const lkPage = state => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script></html>`;
test('링커리어 list and detail: prize in 만원, target from Apollo refs, apply link, KST deadline', () => {
  const act = { __typename: 'Activity', id: '353938', title: '고속철도 통합 기념 영상 공모전', organizationName: '한국철도산업협회', activityTypeID: 3, type: 3, status: 'OPEN',
    recruitCloseAt: 1793372399999, recruitStartAt: 1790089200000, tenThousandUnitOfReward: 250, applyDetail: 'https://www.korass.or.kr/x', homepageURL: 'https://www.korass.or.kr/y',
    targets: { __ref: 'ActivityTarget:4' }, benefits: { __ref: 'Benefit:18' }, categories: { __ref: 'Category:28' }, interests: { __ref: 'Interest:17' }, detailText: { __ref: 'ActivityText:1' } };
  const state = { 'Activity:353938': act, 'ActivityTarget:4': { name: '대상 제한 없음' }, 'Benefit:18': { name: '상장 수여' }, 'Category:28': { name: '기획/아이디어' }, 'Interest:17': { name: '콘텐츠' },
    'ActivityText:1': { text: '<p>시상금 총 250만원</p><p>관심있는 분, 누구나 참여 가능</p>' } };
  const list = parseLinkareerList(lkPage({ props: { pageProps: { activityItems: [{ url: 'https://linkareer.com/activity/353938', name: 'x' }, { url: 'https://linkareer.com/activity/1', name: 'no state' }], __APOLLO_STATE__: state } } }));
  assert.deepEqual(list, [{ id: '353938', title: '고속철도 통합 기념 영상 공모전', org: '한국철도산업협회', typeId: 3, closeAt: '2026-10-30' }]);
  const d = parseLinkareerDetail(lkPage({ props: { pageProps: { __APOLLO_STATE__: state } } }), '353938');
  assert.equal(d.prizeTotalMan, 250);
  assert.deepEqual(d.targets, ['대상 제한 없음']);
  assert.equal(d.applyUrl, 'https://www.korass.or.kr/x');
  const o = fromLinkareer('353938', d, NOW, '2026-10-01');
  assert.equal(o.reward.raw, '총 상금 250만원 (링커리어 표기), 혜택 상장 수여');
  assert.equal(o.reward.amount, 2500000);
  assert.deepEqual(o.eligibility, [{ flag: 'anyone' }]);
  assert.equal(o.open, true);
  assert.deepEqual(validateOpportunity(o, ONTOLOGY), []);
  assert.equal(parseLinkareerDetail('<html></html>', '1'), null);
  assert.equal(fromLinkareer('1', { ...d, targets: ['대학생'], status: 'CLOSED' }, NOW, '2026-10-01').eligibility[0].flag, 'students_only');
});