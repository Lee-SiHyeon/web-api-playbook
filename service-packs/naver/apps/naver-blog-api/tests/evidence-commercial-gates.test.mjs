import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClaimEvidenceGate } from '../scripts/gates/claim-evidence-gates.mjs';
import { evaluateCommercialSnapshot } from '../scripts/gates/commercial-snapshot-gates.mjs';

test('claim ledger resolves sources and rejects expired price claims', () => {
  const ledger = {
    schemaVersion: 1,
    evidence: { E1: { type: 'price_observation', checkedAt: '2026-09-20T00:00:00Z' } },
    claims: [{ claimId: 'C1', text: '가격은 10000원', support: 'supports', sources: ['E1'], expiresAt: '2026-09-20T01:00:00Z' }],
  };
  assert.equal(evaluateClaimEvidenceGate(ledger, { now: new Date('2026-09-20T00:30:00Z') }).passed, true);
  const expired = evaluateClaimEvidenceGate(ledger, { now: new Date('2026-09-20T02:00:00Z') });
  assert.equal(expired.passed, false);
  assert.ok(expired.failedChecks.includes('noExpiredClaims'));
});

test('unsupported publishable claims fail closed', () => {
  const gate = evaluateClaimEvidenceGate({
    schemaVersion: 1,
    evidence: { E1: { type: 'community_report', checkedAt: '2026-09-20T00:00:00Z' } },
    claims: [{ claimId: 'C1', text: '대부분 불만이다', support: 'uncertain', sources: ['E1'], publishable: true, claimType: 'uncertainty' }],
  }, { now: new Date('2026-09-20T00:30:00Z') });
  assert.equal(gate.passed, false);
  assert.ok(gate.failedChecks.includes('noUnsupportedPublishableClaims'));
});

test('commercial snapshot requires a fresh matching link verification', () => {
  const snapshot = {
    schemaVersion: 1,
    checkedAt: '2026-09-20T00:00:00Z',
    productTitle: '테스트 상품',
    payablePriceKrw: 10000,
    affiliateUrl: 'https://link.coupang.com/a/example123',
    variant: '기본',
    stockState: 'in_stock',
    credentialsPersisted: false,
    linkVerification: { passed: true, checkedAt: '2026-09-20T00:00:00Z', targetMatches: true },
  };
  assert.equal(evaluateCommercialSnapshot(snapshot, { now: new Date('2026-09-20T00:30:00Z') }).passed, true);
  const stale = evaluateCommercialSnapshot(snapshot, { now: new Date('2026-09-20T02:00:00Z') });
  assert.equal(stale.passed, false);
  assert.ok(stale.failedChecks.includes('fresh'));
});
