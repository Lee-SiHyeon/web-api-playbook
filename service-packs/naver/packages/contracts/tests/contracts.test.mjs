import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprint,
  validateRunManifest,
  validateProductCandidate,
  validateClaim,
  validateAdapterCandidate,
  createStepReceipt,
} from '../src/index.mjs';

test('fingerprints are stable across object key order', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
});

test('run manifest requires reproducibility hashes', () => {
  assert.equal(validateRunManifest({
    runId: 'run-1', goal: 'test', createdAt: '2026-09-20T00:00:00Z',
    codeHash: 'a', inputHash: 'b', templateHash: 'c', rubricHash: 'd',
  }), true);
  assert.throws(() => validateRunManifest({ runId: 'run-1' }), /goal/);
});

test('product and claim validation fail closed', () => {
  assert.equal(validateProductCandidate({ provider: 'fixture', productId: 'p1', title: 'Fixture', checkedAt: '2026-09-20T00:00:00Z' }), true);
  assert.throws(() => validateProductCandidate({ provider: 'fixture' }), /productId/);
  assert.equal(validateClaim({ claimId: 'c1', text: 'A supported fixture claim', support: 'supports', sources: ['e1'] }), true);
  assert.throws(() => validateClaim({ claimId: 'c1', text: 'Missing sources', support: 'supports', sources: [] }), /sources/);
});

test('step receipts carry a deterministic receipt hash', () => {
  const receipt = createStepReceipt({
    runId: 'run-1', step: 'evidence', state: 'evidence_collected',
    inputs: ['a'], outputs: ['b'], completionContract: 'fixture', version: '1',
  });
  assert.match(receipt.receiptHash, /^[a-f0-9]{64}$/);
});


test('adapter contracts fail closed and preserve verification boundaries', () => {
  const fixture = {
    id: 'fixture-travel', name: 'Fixture Travel',
    roles: ['inventory', 'monetization'], verticals: ['travel', 'lodging'],
    accessState: 'partner_approval', verification: 'official_docs_confirmed', priority: 'P1',
    capabilities: ['lodging.search', 'links.create'], officialSources: ['https://example.test/docs'],
  };
  assert.equal(validateAdapterCandidate(fixture), true);
  assert.throws(() => validateAdapterCandidate({ ...fixture, roles: ['unknown'] }), /roles/);
  assert.throws(() => validateAdapterCandidate({ ...fixture, officialSources: [] }), /officialSources/);
  assert.equal(validateAdapterCandidate({
    ...fixture, id: 'design-only', verification: 'design_only', officialSources: [],
  }), true);
});
