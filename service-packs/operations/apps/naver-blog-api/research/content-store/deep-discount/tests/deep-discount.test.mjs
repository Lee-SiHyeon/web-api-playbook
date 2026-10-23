import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadOntology, loadSources, validateSources, classifyCondition, conditionMatches, parseExpiry, compareAgainstNew,
  checkPostCompliance, partnerPathFor, usableSources, parseEmart24Events, fetchEmart24Events,
} from '../deep-discount-sources.mjs';

const fx = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('registry validates and never marks a blocked source usable', () => {
  assert.ok(validateSources(loadSources()).length >= 15);
  const bad = structuredClone(loadSources());
  bad.sites[0].capabilities[0].access = 'blocked'; bad.sites[0].capabilities[0].decision = 'use';
  assert.throws(() => validateSources(bad), { code: /BLOCKED_USED/ });
});

test('usable sources are exactly the ones observed over public HTTP', () => {
  assert.deepEqual(usableSources().sort(), ['bunjang', 'emart24_event', 'hellomarket', 'joongna']);
  assert.equal(partnerPathFor('coupang_return_market').path, 'none');
  assert.equal(partnerPathFor('lotteon_refurb').path, 'linkprice');
  assert.equal(partnerPathFor('lotteon_refurb').approved, true);
  assert.equal(partnerPathFor('elevenst_refurb').approved, false);
});

test('every rule carries sources except the stated-assumption rule; sources are URLs', () => {
  const o = loadOntology();
  for (const r of o.rules) {
    if (r.id === 'R9_real_cost_assumptions_stated') { assert.deepEqual(r.sources, []); continue; }
    assert.ok(r.sources.length > 0, r.id);
    for (const s of r.sources) assert.match(s.url, /^(https:\/\/|apps\/)/);
  }
  assert.deepEqual(['R1_label_condition', 'R2_show_expiry_for_near_expiry_food', 'R3_no_refurb_vs_new_as_same_product'].filter(id => !o.rules.some(r => r.id === id)), []);
});

test('classifyCondition finds grades and keeps ordinary titles new', () => {
  assert.equal(classifyCondition('삼성 갤럭시 북 리퍼 제품').grade, 'refurbished');
  assert.equal(classifyCondition('LG 냉장고 전시상품 특가').grade, 'display');
  assert.equal(classifyCondition('[반품마켓] 에어프라이어').grade, 'returned');
  assert.equal(classifyCondition('못난이 사과 5kg').grade, 'b_grade');
  assert.equal(classifyCondition('우유 소비기한 임박 떨이').grade, 'near_expiry');
  assert.equal(classifyCondition('아이폰 15 중고 256GB').grade, 'used');
  assert.equal(classifyCondition('삼다수 2L 12병').grade, 'new');
  assert.equal(classifyCondition('Apple Refurbished iPad').grade, 'refurbished');
});

test('conditionMatches replaces the B급 regex: same grade only', () => {
  assert.equal(conditionMatches('못난이 사과 5kg', '흠과 사과 3kg'), true);
  assert.equal(conditionMatches('못난이 사과 5kg', '사과 5kg'), false);
});

test('parseExpiry reads dates after the label and counts KST days', () => {
  const now = new Date('2026-10-05T03:00:00Z');
  assert.deepEqual(parseExpiry('소비기한 2026.10.12까지', now), { date: '2026-10-12', kind: '소비기한', daysLeft: 7 });
  assert.deepEqual(parseExpiry('유통기한: 26-10-06', now), { date: '2026-10-06', kind: '유통기한', daysLeft: 1 });
  assert.equal(parseExpiry('소비기한 10/9', now).date, '2026-10-09');
  assert.equal(parseExpiry('소비기한 2026.13.40', now), null);
  assert.equal(parseExpiry('임박 특가', now), null);
});

test('R3: a 리퍼 price is not compared with a new price as the same product', () => {
  const r = compareAgainstNew({ title: '맥북 에어 리퍼' }, { title: '맥북 에어 신품' });
  assert.equal(r.allowed, false);
  assert.match(r.mustSay, /리퍼\(재생\)상품/);
  assert.equal(compareAgainstNew({ title: '사과 5kg' }, { title: '사과 5kg' }).allowed, true);
});

test('post compliance: label, expiry date, comparison, warranty, coupang 반품마켓 link', () => {
  const items = [{ title: '요거트 소비기한 임박 떨이' }];
  let r = checkPostCompliance('요거트 임박 특가, 최저가!', items);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => v.rule === 'R2_show_expiry_for_near_expiry_food'));
  assert.ok(r.violations.some(v => v.rule === 'R3_no_refurb_vs_new_as_same_product'));
  r = checkPostCompliance('요거트 소비기한 임박 상품입니다. 소비기한 2026.10.12까지. 보증 해당 없음.', items);
  assert.equal(r.ok, true, JSON.stringify(r.violations));

  const refurb = [{ title: '에어팟 리퍼', warrantyKnown: true }];
  assert.ok(checkPostCompliance('에어팟 싸게 나왔어요', refurb).violations.some(v => v.rule === 'R1_label_condition'));
  assert.equal(checkPostCompliance('에어팟 리퍼 상품입니다. 새상품 가격은 참고용입니다.', refurb).ok, true);

  const rm = checkPostCompliance('쿠팡 반품마켓 상품 https://link.coupang.com/a/abc 반품 상품', [{ title: '청소기 반품상품', sourceId: 'coupang_return_market', warrantyKnown: true }]);
  assert.ok(rm.violations.some(v => v.rule === 'R10_partner_link_gate'));
});

test('emart24 event parser reads promo badges, prices and NEW flags from the SSR fixture', () => {
  const rows = parseEmart24Events(fx('emart24-event.html'));
  assert.ok(rows.length >= 6);
  assert.ok(rows.every(r => r.sourceId === 'emart24_event' && Number.isSafeInteger(r.price) && r.title));
  assert.deepEqual([...new Set(rows.map(r => r.promoType))].sort(), ['1+1', '2+1', '골라담기', '할인'].filter(p => rows.some(r => r.promoType === p)).sort());
  assert.ok(rows.some(r => r.promoType === '2+1' && r.title === '질러)볼케이노육포30g' && r.price === 4200));
  assert.ok(rows.every(r => r.conditionGrade === 'new' && r.expiryDate === null));
  assert.throws(() => parseEmart24Events('<html></html>'), { code: 'EMART24_EVENT_SCHEMA' });
});

test('fetchEmart24Events rejects non-200 and non-HTML without parsing', async () => {
  const mk = (status, type, body = '') => async () => new Response(body, { status, headers: { 'content-type': type } });
  await assert.rejects(fetchEmart24Events({ fetchImpl: mk(403, 'text/html') }), { code: 'EMART24_EVENT_HTTP_403' });
  await assert.rejects(fetchEmart24Events({ fetchImpl: mk(200, 'application/json', '{}') }), { code: 'EMART24_EVENT_MIME' });
  assert.ok((await fetchEmart24Events({ fetchImpl: mk(200, 'text/html; charset=utf-8', fx('emart24-event.html')) })).length >= 6);
});
