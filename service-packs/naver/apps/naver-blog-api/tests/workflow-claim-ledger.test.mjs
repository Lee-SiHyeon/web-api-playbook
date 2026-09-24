import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowClaimLedger } from '../workflows/affiliate-content-e2e/claim-ledger.mjs';
import { evaluateStageGate } from '../workflows/affiliate-content-e2e/stage-gates.mjs';

test('workflow claim ledger records price freshness and direct-experience boundary', () => {
  const ledger = buildWorkflowClaimLedger({
    productReceipt: {
      comparison: { checkedAt: '2026-09-20T00:00:00Z' },
      brief: {
        selectedProduct: { title: '테스트 상품', salePriceKrw: 10000 },
        comparisonProducts: [1, 2, 3, 4].map(index => ({ title: `상품${index}`, salePriceKrw: 10000 + index })),
      },
      sourceDigests: { comparison: 'a'.repeat(64) },
    },
    communityReceipt: { data: { checkedAt: '2026-09-20T00:00:00Z', articleCount: 10 } },
    referenceReceipt: { data: { checkedAt: '2026-09-20T00:00:00Z', summary: { postCount: 5 } } },
    trendReceipt: { data: { checkedAt: '2026-09-20T00:00:00Z', mode: 'api_only_trend_radar' } },
  });
  assert.ok(ledger.claims.some(claim => claim.claimId === 'C_SELECTED_PRICE' && claim.expiresAt));
  assert.ok(ledger.claims.some(claim => claim.claimId === 'C_DIRECT_EXPERIENCE' && claim.publishable === false));
  const gate = evaluateStageGate('05a-claim-evidence', {
    checkedAt: '2026-09-20T00:30:00Z',
    ledger,
  });
  assert.equal(gate.passed, true);
});
