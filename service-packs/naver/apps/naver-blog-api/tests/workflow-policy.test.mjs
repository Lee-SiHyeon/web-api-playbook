import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessFreshness,
  assessTopicProductRelevance,
  assessTrendInput,
  classifyWorkflowRisk,
  compactTrendData,
} from '../workflows/affiliate-content-e2e/workflow-policy.mjs';

test('high-risk topics are routed away from the generic affiliate workflow', () => {
  assert.equal(classifyWorkflowRisk('감기 몸살 약 추천').allowed, false);
  assert.ok(classifyWorkflowRisk('감기 몸살 약 추천').matchedRules.includes('medical_or_health'));
  assert.equal(classifyWorkflowRisk('도킹형 보조배터리 추천').allowed, true);
});

test('freshness is explicit and bounded', () => {
  const now = new Date('2026-09-20T00:00:00Z');
  assert.equal(assessFreshness('2026-09-19T12:00:00Z', { now, maxAgeHours: 24 }).fresh, true);
  assert.equal(assessFreshness('2026-09-18T12:00:00Z', { now, maxAgeHours: 24 }).fresh, false);
  assert.equal(assessFreshness('invalid', { now, maxAgeHours: 24 }).validTimestamp, false);
});

test('trend input must be fresh and contain the requested seed', () => {
  const trend = {
    checkedAt: '2026-09-19T20:00:00Z',
    seedExpansions: [{ seed: '도킹형보조배터리', suggestions: [{ keyword: '도킹형 보조배터리 추천' }] }],
    coverage: { shoppingContractsSucceeded: 1 },
    browserUsedForNormalExecution: false,
  };
  const assessment = assessTrendInput(trend, '도킹형 보조배터리', { now: new Date('2026-09-20T00:00:00Z') });
  assert.equal(assessment.usable, true);
  assert.equal(assessTrendInput(trend, '행거', { now: new Date('2026-09-20T00:00:00Z') }).usable, false);
  const compact = compactTrendData(trend, '도킹형 보조배터리');
  assert.equal(compact.seedExpansions.length, 1);
  assert.equal(compact.seedExpansions[0].seed, '도킹형보조배터리');
});

test('topic and product comparison must share a specific product-family signal', () => {
  const comparison = {
    query: '도킹형 보조배터리',
    selectedProduct: { title: '스피디 C타입 도킹 보조배터리' },
    products: [{ title: '10,000mAh 도킹형 보조배터리' }],
  };
  assert.equal(assessTopicProductRelevance({ topic: '도킹형 보조배터리 기내', seed: '보조배터리', comparison }).relevant, true);
  assert.equal(assessTopicProductRelevance({ topic: '행거 추천', seed: '행거', comparison }).relevant, false);
});
