import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidatesFrom, assessCandidates, selectCandidates } from '../research/topic-fit.mjs';
import { JevSupervisor, jevConfig } from '../workflows/affiliate-content-e2e/jev-supervisor.mjs';

const evalCases = JSON.parse(readFileSync(new URL('../research/evaluations/collector-classifier-regression-v1.json', import.meta.url), 'utf8')).cases;
function fake(category, eligible = true) {
  return { evaluate: async ({ questions, fallbacks }) => ({ providerResult: 'ok',
    comparisons: Object.fromEntries(Object.keys(questions).map(k => [k, { eligible, confidence: eligible ? 0.95 : 0.1, remote: { choice: category } }])),
    adopted: Object.fromEntries(Object.keys(questions).map(k => [k, { choice: eligible ? category : fallbacks[k], source: eligible ? 'jev_active' : 'deterministic_fallback' }])) }) };
}
const candidate = { title: '호텔 비교', summary: '객실 비교', urls: ['https://example.com/info'] };
test('normalization deduplicates titles and rejects credential-bearing links', () => {
  const rows = candidatesFrom([{ ...candidate, urls: ['https://user:secret@example.com', 'javascript:alert(1)'] }, { ...candidate, title: ' 호텔  비교 ' }]);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].urls, ['https://example.com/info']);
});
test('expiry and duplicate checks override model relevance', async () => {
  const rows = candidatesFrom([{ ...candidate, expiresAt: '2020-01-01' }]);
  const [result] = await assessCandidates(rows, { supervisor: fake('travel'), existingTitles: ['호텔 비교'] });
  assert.equal(result.disposition, 'exclude');
  assert.deepEqual(result.reasons, ['existing_title_duplicate', 'expired']);
  assert.equal(result.publicationReady, false);
});
test('low confidence and missing sources never qualify', async () => {
  const [result] = await assessCandidates(candidatesFrom([{ title: '호텔' }]), { supervisor: fake('travel', false) });
  assert.equal(result.category, 'unknown'); assert.equal(result.disposition, 'needs_research');
});
test('provider off is explicitly unknown, never disguised as live classification', async () => {
  const supervisor = new JevSupervisor({ config: jevConfig({}, { mode: 'off' }) });
  const [result] = await assessCandidates(candidatesFrom([candidate]), { supervisor });
  assert.equal(result.providerResult, 'mode_off'); assert.equal(result.category, 'unknown');
});
test('valid finance candidate is a research shortlist, not verified advice', async () => {
  const [result] = await assessCandidates(candidatesFrom([candidate]), { supervisor: fake('finance') });
  assert.equal(result.disposition, 'shortlist_for_research'); assert.equal(result.evidenceVerified, false);
  assert.ok(result.additionalChecks.includes('primary_financial_sources'));
});
test('invalid expiry is held for research', async () => {
  const [result] = await assessCandidates(candidatesFrom([{ ...candidate, expiresAt: 'bad-date' }]), { supervisor: fake('deals') });
  assert.equal(result.disposition, 'needs_research'); assert.ok(result.reasons.includes('invalid_expiry'));
});

test('shadow response remains a visible suggestion and cannot change the adopted category or disposition', async () => {
  const sample = evalCases.shadowSuggestion;
  const supervisor = new JevSupervisor({
    config: jevConfig({}, { mode: 'shadow', provider: 'custom', customEndpoint: 'https://fixture.test', customKey: 'fixture' }),
    fetchImpl: async () => new Response(JSON.stringify({ answers: {
      item0: { type: 'choice', choice: sample.remoteChoice, confidence: sample.confidence },
    } }), { status: 200 }),
  });
  const [result] = await assessCandidates(candidatesFrom([{ title: sample.title, summary: sample.summary, urls: [sample.url] }]), { supervisor });
  assert.equal(result.category, sample.expectedAdopted);
  assert.equal(result.suggestedCategory, sample.expectedSuggestion);
  assert.equal(result.disposition, sample.expectedDisposition);
  assert.equal(result.confidence, null);
  assert.equal(result.suggestionConfidence, 0.99);
});

test('source-stratified limiting retains low-volume trend headlines and preserves collection provenance', () => {
  const sample = evalCases.sourceLimit;
  const rows = candidatesFrom({
    contentIdeas: Array.from({ length: sample.contentIdeaCount }, (_, i) => ({ keyword: `idea-${i}`, format: 'guide', score: 1 })),
    googleTrending: Array.from({ length: sample.trendHeadlineCount }, (_, i) => ({ title: `trend-${i}`, news: [{ title: 'headline details', url: `https://example.com/${i}` }] })),
  });
  const selected = selectCandidates(rows, sample.limit);
  assert.equal(selected.filter(row => row.sourceKind === 'trend_headlines').length, sample.expectedTrendHeadlines);
  assert.equal(selected.filter(row => row.sourceKind === 'search_signal').length, sample.expectedContentIdeas);
  const collected = candidatesFrom([{ id: 'c1', field: 'ai', fields: ['ai', 'travel'], sourceIds: ['s1'], evidenceLevel: 'feed_headline', title: 'Collected item' }]);
  assert.deepEqual(collected[0].fields, ['ai', 'travel']);
  assert.deepEqual(collected[0].sourceIds, ['s1']);
  assert.equal(collected[0].id, 'c1');
});
