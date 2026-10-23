import assert from 'node:assert/strict';
import test from 'node:test';
import { queryDataset } from '../scripts/cps-reverify.mjs';

function fixture() {
  return { ontologyId: 'test', generatedAt: '2026-09-27T00:00:00Z',
    coverage: [{ merchantId: 'empty', sourceId: 'source' }],
    entities: { commercialOfferings: [], offerObservations: [], ratingAggregates: [], productVariants: [], reviewObservations: [], fieldEvidence: [],
      evidenceReceipts: [{ id: 'blocked', sourceId: 'source', responseStatus: 403 }, { id: 'unrelated', sourceId: 'other' }],
      capabilityAssessments: [{ merchantId: 'empty', receiptIds: ['blocked'] }] } };
}

test('an empty or blocked query includes the receipts referenced by its assessment', () => {
  const result = queryDataset(fixture(), 'empty');
  assert.equal(result.total, 0);
  assert.deepEqual(result.receipts.map(row => row.id), ['blocked']);
  assert.equal(result.receipts[0].responseStatus, 403);
});

test('query receipt dependencies close transitively without exposing another source', () => {
  const dataset = fixture();
  dataset.entities.evidenceReceipts = [
    { id: 'data', sourceId: 'source', publicClientConfigReceiptId: 'config' },
    { id: 'config', sourceId: 'source', bootstrapReceiptId: 'bootstrap' },
    { id: 'bootstrap', sourceId: 'source' }, { id: 'unrelated', sourceId: 'other' },
  ];
  dataset.entities.capabilityAssessments[0].receiptIds = ['data'];
  const result = queryDataset(dataset, 'empty');
  assert.deepEqual(result.receipts.map(row => row.id), ['data', 'config', 'bootstrap']);
});
