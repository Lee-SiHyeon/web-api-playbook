import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runReferenceJevQuality } from '../workflows/republish/reference-jev-quality.mjs';
import { evaluateJevQualityEvidence } from '../workflows/republish/jev-quality.mjs';

const document = { blogId: 'testblog', logNo: '224417064414', title: 'AI model comparison', blocks: [
  { type: 'paragraph', text: 'Which model finishes the task for a useful cost?' },
  { type: 'table', columns: ['Model', 'Result'], rows: [['A', '40%'], ['B', '33%']] },
  { type: 'paragraph', text: 'The higher completion result may matter when recovery takes human work.' },
] };
const ledger = { claims: [{ claimId: 'c1', text: 'The values are from a public benchmark.', support: 'supports' }] };
const snapshot = () => ({ schemaVersion: 1, profile: 'korean_ai_comparison_editorial',
  selection: 'Three distinct published articles', checkedAt: new Date().toISOString(),
  references: [1, 2, 3].map(index => ({
    id: `yozm-example-${index}`, url: `https://yozm.wishket.com/magazine/detail/${index}/`,
    group: 'yozm-it', format: 'model_comparison', intendedUse: 'argument and flow',
    title: `Reference ${index}`, httpStatus: 200, checkedAt: new Date().toISOString(),
    bodySha256: String(index).repeat(64), paragraphCount: 12, bodyCharacters: 1500,
    extraction: 'public_body_paragraphs_sampled_at_opening_middle_end',
    sampledParagraphs: [0, 1, 2, 3, 4, 5].map(position =>
      ({ position, text: `Reference ${index} paragraph ${position} explains a specific reader decision.` })),
  })) });

test('reference-relative Jev gate accepts a fresh comparable draft and rejects changed content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-jev-'));
  try {
    const answers = {
      reference_1: { type: 'score', score: 2.8, confidence: 0.6 },
      reference_2: { type: 'score', score: 2.9, confidence: 0.6 },
      reference_3: { type: 'score', score: 3.1, confidence: 0.6 },
      next_action: { type: 'choice', choice: 'publish', confidence: 0.6 },
    };
    const result = await runReferenceJevQuality({ dir, document, ledger, snapshot: snapshot(), mode: 'active',
      config: { mode: 'active', provider: 'vercel', endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
        apiKey: 'fixture', model: 'typesafe-ai/jev', confidenceFloor: 0, timeoutMs: 8000 },
      fetchImpl: async () => new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers }),
        { status: 200, headers: { 'content-type': 'application/json' } }) });
    assert.equal(result.passed, true);
    assert.equal(result.medianReferenceRelativeScore, 2.9);
    assert.equal(evaluateJevQualityEvidence(result, { document, ledger }).passed, true);
    assert.equal(evaluateJevQualityEvidence(result, { document: { ...document, title: 'Changed' }, ledger }).passed, false);
    const revise = structuredClone(result);
    revise.receipt.comparisons.next_action.remote.choice = 'revise';
    assert.equal(evaluateJevQualityEvidence(revise, { document, ledger }).passed, false);
    const stale = structuredClone(result);
    stale.referenceSnapshot.references[0].checkedAt = '2020-01-01T00:00:00.000Z';
    assert.equal(evaluateJevQualityEvidence(stale, { document, ledger }).passed, false);
    assert.equal((await fs.stat(path.join(dir, 'jev-reference-quality.json'))).isFile(), true);
  } finally {
    assert.equal(path.resolve(path.dirname(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('reference-relative Jev gate fails closed when the provider is unavailable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-jev-unavailable-'));
  try {
    const result = await runReferenceJevQuality({ dir, document, ledger, snapshot: snapshot(), mode: 'active',
      config: { mode: 'active', provider: 'vercel', endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
        apiKey: 'fixture', model: 'typesafe-ai/jev', confidenceFloor: 0, timeoutMs: 8000 },
      fetchImpl: async () => new Response('', { status: 503 }) });
    assert.equal(result.status, 'provider_unavailable');
    assert.equal(result.providerResult, 'provider_http_503');
    assert.equal(result.passed, false);
    assert.equal(result.failedChecks.includes('providerSucceeded'), true);
  } finally {
    assert.equal(path.resolve(path.dirname(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
