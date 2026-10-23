import test from 'node:test';
import assert from 'node:assert/strict';
import { load, mapSnapshot } from '../scripts/hub-ontology/opportunity.mjs';
import { fromRevu, parseWevityDetail } from '../../naver-blog-api/research/content-store/apply-opportunities.mjs';
import { validateHubItem } from '../scripts/hub-ontology/contract.mjs';

const now = new Date('2026-10-11T03:00:00Z');
const checkedAt = '2026-10-11T00:07:47.583Z';
const revu = fromRevu({ id: 1409327, item: '공개 제품 체험단', category: ['뷰티', '배송형'],
  venue: { name: '제공업체' }, requestEndedOn: '2026-10-12', campaignData: { reward: '제품 1개', point: 0 },
  campaignStats: { requestCount: 41 }, reviewerLimit: 23, status: 'REQUEST', media: 'blog', enableRequest: true }, checkedAt);
const detail = parseWevityDetail('<li><span class="tit">접수기간</span>2026-10-01 ~ 2026-10-11</li><li><span class="tit">주최/주관</span>공개 기관</li>');
const wevity = { id: 'wevity:100', source: 'wevity', title: '공모전', host: detail.host,
  url: 'https://www.wevity.com/?c=find&s=1&gbn=view&ix=100', checkedAt, open: true,
  schedule: { applyEnd: detail.applyEnd }, reward: { raw: '총 상금 100만원' }, competition: null, categories: ['기획/아이디어'] };

test('opportunity fixture reuses normalized collector output and validates every produced item', async () => {
  const items = await load({ now, documents: [{ checkedAt, opportunities: [revu, revu, wevity,
    { ...revu, id: 'revu:expired', schedule: { applyEnd: '2026-10-10' }, open: true },
    { ...revu, id: 'revu:closed', open: false },
    { ...revu, id: 'revu:unknown', schedule: { applyEnd: null } },
    { ...revu, id: 'revu:no-url', url: undefined },
    { ...revu, id: 'brandconnect:123', source: 'brandconnect', url: 'https://brandconnect.naver.com/997881506414144/campaign/search' },
  ] }] });
  assert.equal(items.length, 2);
  for (const item of items) assert.deepEqual(validateHubItem(item), [], item.id);
  const campaign = items.find(item => item.source === 'revu');
  assert.equal(campaign.sourceUrl, revu.url);
  assert.equal(campaign.shippingNote, '모집 23명 · 신청 41명');
  assert.equal(campaign.store, '제공업체');
  assert.equal(campaign.expiresAt, '2026-10-12T14:59:59.999Z');
  assert.equal(campaign.summary, '제품 1개');
  assert.equal(campaign.priceKrw, null);
  assert.equal(campaign.affiliateUrl, null);
});

test('timestamp deadlines preserve their explicit time; work period cannot replace recruitment deadline', () => {
  const items = mapSnapshot({ checkedAt, opportunities: [{ ...revu, schedule: { applyEnd: '2026-10-11T13:00:00+09:00' } },
    { ...wevity, id: 'wevity:work-only', schedule: { workTo: '2026-12-31' } }] }, { now });
  assert.equal(items.length, 1);
  assert.equal(items[0].expiresAt, '2026-10-11T04:00:00.000Z');
  assert.equal(mapSnapshot({ opportunities: [{ ...revu, schedule: { applyEnd: '2026-10-11T11:00:00+09:00' } }] }, { now }).length, 0);
});

test('limits contract strings and output to 200 while preserving zero recruitment/applicant values', () => {
  const items = mapSnapshot({ checkedAt, opportunities: Array.from({ length: 210 }, (_, i) => ({ ...revu,
    id: `revu:${i}`, url: `${revu.url}?fixture=${i}`, title: '가'.repeat(350) + i,
    host: '나'.repeat(80), categories: Array.from({ length: 20 }, (_, j) => '다'.repeat(40) + j),
    competition: { slots: 0, applicants: 0 }, reward: { raw: '라'.repeat(500) } })) }, { now });
  assert.equal(items.length, 200);
  for (const item of items) {
    assert.deepEqual(validateHubItem(item), []);
    assert.equal(item.shippingNote, '모집 0명 · 신청 0명');
    assert.equal(item.summary.length, 400);
  }
});
