import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHookOntology, validateHookOntology, parseNewsResults, namesKeyword, keywordContext, readPromotion, probeWhyNow, suggestHooks, hookQuestion }
  from '../research/content-store/hooks.mjs';
import { enrichWithHooks, buildBrief } from '../research/content-store/event-scan.mjs';

const NOW = Date.parse('2026-09-27T05:00:00Z'); // 14:00 KST
const result = (headline, url, snippet) => `<div><a href="${url}" class="x"><span class="sds-comps-text-type-headline1">${headline}</span></a>`
  + `<div><span class="sds-comps-text-type-body1">${snippet}</span></div></div>`;
// Observed shapes (2026-09-27): a headline naming the keyword, a roundup mentioning it once, and a different entity.
const NEWS = [
  result("내달 11일까지 '해피 토이저러스데이'…레고 등 할인 판매", 'https://www.newsis.com/a',
    "스테디셀러 브랜드를 엄선해 할인 판매한다. 레고는 260여 종에 대해 최대 40% 저렴하게 선보이고, '헬로카봇'과 '포켓몬스터' 시리즈는 최대 50%, 30% 할인한다."),
  result('11번가, 추석 상품권·외식 e쿠폰 27일까지 할인', 'https://example.com/b', '상품권을 최대 20% 할인한다. 완구 기획전에는 레고 등 인기 브랜드가 들어간다.'),
  result('레고랜드 가을축제 개막', 'https://example.com/c', '레고랜드가 10월 31일까지 축제를 연다.'),
].join('');
const fetchNews = async () => ({ status: 200, text: async () => NEWS });
const event = { kind: 'shopping_trend', key: 'trend:레고:2026-09-27', genre: 'deal_roundup', field: 'deals', headline: '쇼핑 검색 급상승: 레고 (출산/육아, 모멘텀 +77%)',
  urls: [], expiresAt: new Date(NOW + 3 * 864e5).toISOString(), data: { keyword: '레고', category: '출산/육아', momentum: 0.77 } };

test('the ontology is well formed and every hook pattern has a measured example with a URL', () => {
  const o = loadHookOntology();
  assert.deepEqual(validateHookOntology(o), []);
  assert.ok(o.hookPatterns.length >= 10);
  assert.equal(o.hookPatterns.find(p => p.id === 'own_use_proof').defaultAllowed, false);
});

test('news parsing and keyword scope: 레고 and 레고코리아 count, 레고랜드 does not; roundups lend only the keyword sentence', () => {
  const rows = parseNewsResults(NEWS);
  assert.equal(rows.length, 3); assert.equal(rows[0].url, 'https://www.newsis.com/a'); assert.match(rows[0].snippet, /최대 40%/);
  assert.ok(namesKeyword('레고코리아, 추석 행사', '레고') && namesKeyword('레고·포켓몬 할인', '레고'));
  assert.ok(!namesKeyword('레고랜드 가을축제', '레고'));
  assert.match(keywordContext(rows[1], '레고'), /레고 등 인기 브랜드/);
  assert.doesNotMatch(keywordContext(rows[1], '레고'), /27일까지|20%/);
  assert.equal(keywordContext(rows[2], '레고'), '');
});

test('promotion wording: ranges, next month, bare day, top discount', () => {
  assert.equal(readPromotion('내달 11일까지 할인', NOW).endsAt, '2026-10-11T14:59:59.000Z');
  assert.equal(readPromotion('9월 11일부터 27일까지 최대 40% 할인', NOW).endsAt, '2026-09-27T14:59:59.000Z');
  assert.equal(readPromotion('9월 11일부터 27일까지 최대 40% 할인', NOW).maxDiscountPct, 40);
  assert.equal(readPromotion('22일 마감', NOW).endsAt, '2026-09-22T14:59:59.000Z');
  assert.deepEqual(readPromotion('상시 판매', NOW), { endsAt: null, maxDiscountPct: null });
});

test('probe: the promotion trigger stands on the headline article, with 레고 40% (not 헬로카봇 50%) and its end date', async () => {
  const w = await probeWhyNow('레고', { fetchImpl: fetchNews, now: NOW, delayMs: 0 });
  const promo = w.triggers.find(t => t.kind === 'promotion');
  assert.equal(promo.url, 'https://www.newsis.com/a'); assert.equal(promo.maxDiscountPct, 40); assert.equal(promo.endsAt, '2026-10-11T14:59:59.000Z');
  assert.ok(!w.items.some(a => a.url === 'https://example.com/c'));
});

test('hooks: deadline first with the sourced date and discount; evergreen only when no trigger; no own-use claims', async () => {
  const w = await probeWhyNow('레고', { fetchImpl: fetchNews, now: NOW, delayMs: 0 });
  const h = suggestHooks(event, w, { now: NOW });
  assert.equal(h.candidates[0].patternId, 'deadline_loss');
  assert.match(h.candidates[0].title, /^레고 해피 토이저러스데이 10월 11일까지｜최대 40%/);
  assert.match(h.candidates[0].opening, /^해피 토이저러스데이가 10월 11일 끝납니다/);
  assert.deepEqual(h.candidates[0].basis, ['https://www.newsis.com/a']);
  assert.match(hookQuestion(event, h), /10월 11일에 끝나는데/);
  const none = suggestHooks(event, { triggers: [] }, { now: NOW });
  assert.equal(none.noTrigger, true); assert.equal(hookQuestion(event, none), null);
  assert.ok(none.candidates.every(c => !['deadline_loss', 'price_anchor', 'timing_insight', 'own_use_proof'].includes(c.patternId)));
  assert.ok(none.candidates.some(c => c.patternId === 'segment_specific' && /권장 연령/.test(c.opening)));
});

test('event enrichment: reason in the headline, hook question, trigger URL, expiry never later than the deadline; a failed probe says 원인 미확인', async () => {
  const e = await enrichWithHooks(event, { probe: (kw, o) => probeWhyNow(kw, { ...o, fetchImpl: fetchNews, delayMs: 0 }), now: NOW });
  assert.match(e.headline, /— 원인: 내달 11일까지 '해피 토이저러스데이'…레고 등 할인 판매 \(10\/11까지\)$/);
  assert.match(e.readerQuestion, /실제로 싼 건/); assert.ok(e.urls.includes('https://www.newsis.com/a'));
  assert.equal(e.expiresAt, event.expiresAt); // 3-day trend expiry comes before 10/11
  const { brief } = buildBrief(e, { now: NOW, root: 'C:/tmp' });
  assert.equal(brief.readerQuestion, e.readerQuestion); assert.equal(brief.hooks.candidates[0].patternId, 'deadline_loss');
  assert.ok(brief.draftingNotes.some(n => /첫 3문단/.test(n)));
  const failed = await enrichWithHooks(event, { probe: async () => { throw Object.assign(new Error('x'), { code: 'NEWS_CHALLENGE' }); }, now: NOW });
  assert.match(failed.headline, /원인 미확인$/); assert.equal(failed.whyNow.error, 'NEWS_CHALLENGE');
  const other = await enrichWithHooks({ ...event, kind: 'ai_news' }, { probe: fetchNews, now: NOW });
  assert.equal(other.hooks, undefined);
});
