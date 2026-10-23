import test from 'node:test';
import assert from 'node:assert/strict';
import { load, mapSnapshot, mapHousing, mapLiveMembership } from '../scripts/hub-ontology/benefit.mjs';
import { readFile } from 'node:fs/promises';
import { parseNaverCardPromotion } from '../../naver-blog-api/research/content-store/membership-campaigns/membership-campaigns.mjs';
import { parseHtml, textContent } from '../../naver-blog-api/research/content-store/gov-discount-events/html-public.mjs';
import { validateHubItem } from '../scripts/hub-ontology/contract.mjs';
import { isoTime, anonymousFetch } from '../scripts/hub-ontology/benefit-opportunity-utils.mjs';

const now = new Date('2026-10-11T03:00:00Z');
const checkedAt = '2026-10-11T00:00:00Z';
const housing = {
  source: 'applyhome-apt', noticeId: '2026000492', name: '청주 가경 아이파크 8단지',
  region: '충북', announcedAt: '2026-10-08', receiptStart: '2026-10-19', receiptEnd: '2026-10-21',
  builder: '아이파크현대산업개발 주식회사', supplyKind: '분양주택',
  url: 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=2026000492&pblancNo=2026000492',
  detail: { totalUnits: 1128, priceManwon: { min: 52460 } },
};
const document = { checkedAt, housing: [housing, { ...housing },
  { ...housing, noticeId: 'expired', receiptEnd: '2026-10-10' },
  { ...housing, noticeId: 'unknown', receiptEnd: null },
  { ...housing, noticeId: 'bad-url', url: null },
  { ...housing, source: 'lh', noticeId: '123', name: 'LH 임대주택 모집', builder: 'LH',
    receiptEnd: '2026-10-11', url: 'https://apply.lh.or.kr/lhapply/apply/wt/wrtanc/selectWrtancInfo.do?panId=123' }],
  events: [{ id: 'festival', name: '공개 할인행사', periodEnd: '2026-11-15', periodRaw: '2026-10-29 ~ 2026-11-15',
    operatorMinistry: '중소벤처기업부', sourceIds: ['release'], checkedAt }],
  sourceRegistry: [{ id: 'release', url: 'https://www.mss.go.kr/site/smba/ex/bbs/View.do?bcIdx=1069642&cbIdx=288' }],
};

test('benefit fixture maps housing and observed government URLs, filters expiry, validates all fields', async () => {
  const items = await load({ now, documents: [document] });
  assert.equal(items.length, 3);
  for (const item of items) assert.deepEqual(validateHubItem(item), [], item.id);
  const apt = items.find(item => item.id === 'applyhome:2026000492');
  assert.equal(apt.sourceUrl, housing.url);
  assert.equal(apt.expiresAt, '2026-10-21T14:59:59.999Z');
  assert.equal(apt.postedAt, '2026-10-07T15:00:00.000Z');
  assert.equal(apt.priceKrw, null); // housing price range is not an offer price
  assert.equal(apt.affiliateUrl, null);
  assert.match(apt.summary, /공급 1128세대/);
  assert.equal(items.find(item => item.source === 'lh').expiresAt, '2026-10-11T14:59:59.999Z');
});

test('membership only includes dated, unretracted facts with a concrete observed public URL', () => {
  const membership = { checkedAt, sourceRegistry: [{ sourceId: 'card', name: '카드 행사', url: 'https://mkt.naver.com/naverhyundaicard3', checkedAt }],
    membershipPrograms: [{ id: 'plus', name: '네이버플러스 멤버십' }], facts: [
      { id: 'valid', programId: 'plus', availability: 'open', fact: '전월실적 40만원 조건.', period: { end: '2027-07-31' }, sourceIds: ['card'] },
      { id: 'unknown', availability: 'unknown', fact: '미확인.', period: { end: '2027-07-31' }, sourceIds: ['card'] },
      { id: 'retracted', availability: 'open', fact: '과거 안내.', recheck: { checkedAt }, period: { end: '2027-07-31' }, sourceIds: ['card'] },
    ] };
  const items = mapSnapshot(membership, { now });
  assert.equal(items.length, 1);
  assert.equal(items[0].summary, '전월실적 40만원 조건.');
  assert.deepEqual(validateHubItem(items[0]), []);
  assert.equal(mapSnapshot({ ...membership, sourceRegistry: [{ sourceId: 'card', url: 'https://example.com/{campaign}' }] }, { now }).length, 0);
});

test('membership existing public HTML fixture supplies the live campaign period and facts', async () => {
  const html = await readFile(new URL('../../naver-blog-api/research/content-store/membership-campaigns/fixtures/naver-card-promo.html', import.meta.url), 'utf8');
  const parsed = parseNaverCardPromotion(html);
  const item = mapLiveMembership(parsed, { sourceUrl: 'https://mkt.naver.com/naverhyundaicard3', checkedAt,
    store: '네이버플러스 멤버십', body: textContent(parseHtml(html)) });
  assert.ok(item);
  assert.deepEqual(validateHubItem(item), []);
  assert.equal(item.expiresAt, '2027-07-31T14:59:59.999Z');
  assert.match(item.summary, /카드 적립 최대 5%/);
  assert.equal(mapLiveMembership({ title: '기간 없는 안내', mentions: [] }, { sourceUrl: item.sourceUrl, checkedAt }), null);
});

test('benefit keeps Korean end-of-day boundaries, rejects invalid dates, caps at 200', () => {
  assert.equal(isoTime('2026-02-30', { end: true }), null);
  assert.equal(isoTime('2026-02-30T12:00:00+09:00'), null);
  assert.equal(isoTime('2026-10-11T12:00:00'), null);
  const sameDay = { checkedAt, housing: [{ ...housing, receiptEnd: '2026-10-11' }] };
  assert.equal(mapSnapshot(sameDay, { now: new Date('2026-10-11T14:59:59.998Z') }).length, 1);
  assert.equal(mapSnapshot(sameDay, { now: new Date('2026-10-11T15:00:00Z') }).length, 0);
  const items = mapSnapshot({ checkedAt, housing: Array.from({ length: 205 }, (_, i) => ({ ...housing,
    noticeId: String(i), url: `${housing.url}&fixture=${i}`, name: `${housing.name} ${i}` })) }, { now });
  assert.equal(items.length, 200);
  for (const item of items) assert.deepEqual(validateHubItem(item), []);
  assert.equal(mapHousing({ ...housing, status: '종료' }, checkedAt), null);
});

test('transport never forwards credentials, mutations, or redirects', async () => {
  let calls = 0;
  const read = anonymousFetch([], async (_, options) => { calls++; assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit'); return { status: 307 }; });
  await assert.rejects(read('https://example.com/', { method: 'POST' }), /PUBLIC_GET_ONLY/);
  await assert.rejects(read('https://example.com/', { headers: { cookie: 'fixture' } }), /PUBLIC_GET_ONLY/);
  await assert.rejects(read('https://example.com/?serviceKey=fixture'), /PUBLIC_GET_ONLY/);
  await assert.rejects(read('https://example.com/'), /REDIRECT_STOPPED/);
  assert.equal(calls, 1);
});
