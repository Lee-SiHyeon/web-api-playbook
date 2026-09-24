import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildVerticalBrief } from '../research/trend-radar/build-vertical-brief.mjs';

const profile = JSON.parse(
  await readFile(new URL('../research/trend-radar/verticals/travel.json', import.meta.url), 'utf8'),
);
const adapters = JSON.parse(
  await readFile(new URL('../../affiliate-api-hub/references/travel-adapters.json', import.meta.url), 'utf8'),
);

test('travel vertical maps opportunities to adapter coverage without browser dependence', () => {
  const trend = {
    checkedAt: '2026-09-20T00:00:00Z',
    mode: 'api_only_trend_radar',
    coverage: {},
    seedExpansions: [
      {
        seed: '유럽eSIM',
        suggestions: [{ keyword: '유럽 esim 추천', opportunityScore: 61, tags: ['buyer_intent'] }],
      },
      {
        seed: '바티칸예약',
        suggestions: [{ keyword: '바티칸 예약 공홈', opportunityScore: 50, tags: [] }],
      },
    ],
    contentIdeas: [],
  };
  const brief = buildVerticalBrief(profile, trend, adapters);
  assert.equal(brief.browserUsedForNormalExecution, false);
  assert.ok(brief.topOpportunities.some(item => item.keyword === '유럽 esim 추천'));
  const connectivity = brief.clusterResults.find(cluster => cluster.id === 'connectivity');
  assert.ok(connectivity.preferredAdapters.some(adapter => adapter.id === 'travelpayouts'));
  assert.equal(connectivity.hasVerifiedMonetizationPath, true);
  assert.equal(connectivity.readyForMonetizationIntegration, false);
  const activities = brief.clusterResults.find(cluster => cluster.id === 'activities');
  assert.ok(
    activities.capabilityCoverage['official_reservation.watch']
      .includes('official-attraction-reservation-watch'),
  );
});

test('insurance cluster remains account-gated instead of publish-ready', () => {
  const trend = {
    checkedAt: '2026-09-20T00:00:00Z',
    mode: 'api_only_trend_radar',
    coverage: {},
    seedExpansions: [
      {
        seed: '여행자보험',
        suggestions: [{ keyword: '여행자보험 추천', opportunityScore: 59, tags: ['buyer_intent'] }],
      },
    ],
    contentIdeas: [],
  };
  const brief = buildVerticalBrief(profile, trend, adapters);
  const insurance = brief.clusterResults.find(cluster => cluster.id === 'insurance');
  assert.equal(insurance.requiresAccountOrKey, true);
  assert.equal(insurance.readyForMonetizationIntegration, false);
  assert.ok(insurance.preferredAdapters.some(adapter => adapter.accessState === 'manual_review'));
});

test('travel vertical filters unrelated shopping ideas even when generic price words match', () => {
  const trend = {
    checkedAt: '2026-09-20T00:00:00Z',
    mode: 'api_only_trend_radar',
    coverage: {},
    seedExpansions: [],
    contentIdeas: [
      { keyword: '쌀 20kg 가격', score: 74, format: 'comparison', reason: [] },
      { keyword: '대마도 배편 가격', score: 64, format: 'comparison', reason: [] },
    ],
  };
  const brief = buildVerticalBrief(profile, trend, adapters);
  assert.ok(brief.topOpportunities.some(item => item.keyword === '대마도 배편 가격'));
  assert.ok(!brief.topOpportunities.some(item => item.keyword === '쌀 20kg 가격'));
});
