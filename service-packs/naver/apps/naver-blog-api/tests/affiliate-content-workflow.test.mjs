import test from 'node:test';
import assert from 'node:assert/strict';
import { topicCandidates } from '../workflows/affiliate-content-e2e/run.mjs';

test('topic candidates stay inside the requested seed family and preserve intent signals', () => {
  const trend = {
    seedExpansions: [{
      seed: '도킹형보조배터리',
      suggestions: [
        { keyword: '도킹형 보조배터리 추천', opportunityScore: 52, buyerIntent: true, problemIntent: false, semanticDrift: false, tags: ['buyer_intent'] },
        { keyword: '도킹형 보조배터리 기내', opportunityScore: 48, buyerIntent: false, problemIntent: true, semanticDrift: false, tags: ['problem_intent'] },
        { keyword: '무관한 키워드', opportunityScore: 99, semanticDrift: true, tags: [] },
      ],
    }],
  };
  const candidates = topicCandidates(trend, '도킹형보조배터리');
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].keyword, '도킹형 보조배터리 추천');
  assert.equal(candidates.some(candidate => candidate.problemIntent), true);
});

test('an explicit topic remains available even when the trend cache has no matching seed', () => {
  const candidates = topicCandidates({ seedExpansions: [] }, '감기몸살', '감기 몸살');
  assert.deepEqual(candidates.map(candidate => candidate.keyword), ['감기 몸살']);
});
