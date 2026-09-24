import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComparisonBrief } from '../research/build-product-comparison-brief.mjs';

test('multi-product brief explains why the selected product wins only on defined axes', () => {
  const product = (title, price) => ({
    title,
    salePriceKrw: price,
    capacityMah: 5000,
    powerW: null,
    connector: 'usb_c',
    fastChargeClaim: false,
  });
  const selected = product('selected', 6900);
  const record = {
    checkedAt: '2026-09-19T00:00:00Z',
    positioning: {
      selected,
      positioning: 'entry product',
      strengths: ['low price'],
      tradeoffs: ['not fastest'],
      recommendedFor: ['small bag'],
      notRecommendedFor: ['all-day use'],
      evidenceGaps: ['heat'],
      alternatives: {
        cheapest: product('cheap', 5000),
        fastCharge: { ...product('fast', 10000), powerW: 20, fastChargeClaim: true },
        allDayCapacity: { ...product('large', 16000), capacityMah: 10000 },
        bundleValue: { ...product('bundle', 9000), bundleQuantity: 2 },
      },
    },
  };
  const brief = buildComparisonBrief(record);
  assert.equal(brief.comparisonProducts.length, 5);
  assert.equal(brief.publishGate.mayClaimUniversalWinner, false);
  assert.equal(brief.publishGate.readyForPublication, false);
  assert.ok(brief.outline.some(value => /비교표/.test(value)));
  assert.ok(brief.communityResearchQuestions.some(value => /케이스/.test(value)));
});
