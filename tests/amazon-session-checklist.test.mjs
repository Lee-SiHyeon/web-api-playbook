import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { auditCapabilityChecklist } from '../lib/capability-checklist.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const live = JSON.parse(await readFile(new URL('../verification/amazon-discovery-2026-10-15/product-lotion.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const base = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(base, 'amazon-checklist-'));
  assert.ok(root.startsWith(base + path.sep)); t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['lib', 'verification', 'checklists/services']) await mkdir(path.join(root, name), { recursive: true });
  const code = 'export function product() {}\n'; await writeFile(path.join(root, 'lib/product.mjs'), code);
  const entry = { kind: 'amazon-product-session-read-v1', origin: 'https://www.amazon.com', method: 'GET',
    path: '/-/ko/dp/B08KT2Z93D/', mime: 'text/html', readOnly: true,
    files: ['verification/proof.json', 'verification/execution.json'], hashPaths: ['lib/product.mjs'] };
  const cap = { id: 'catalog.options', title: 'Observed child-ASIN choices', priority: 'required', applicability: 'applicable', requirement: 'live',
    implementation: { files: [{ path: 'lib/product.mjs', exports: ['product'] }], tests: [] }, evidence: [entry], sourceEvidence: [] };
  const proof = { schema: 'web-api-amazon-session-read-receipt-v1', service: 'amazon', capabilityId: cap.id,
    checkedAt: live.data.receipt.checkedAt, secretsPersistedInEvidence: false, authenticated: false,
    credentialProvider: 'protected_store', initialBootstrap: 'browser_observed_public_session', sessionRenewalVerified: false,
    requestSha256: sha(JSON.stringify(live.data.receipt)), projectionSha256: sha(JSON.stringify(live.data)),
    implementation: { 'lib/product.mjs': sha(code) } };
  const save = async (execution = live, receipt = proof) => {
    await writeFile(path.join(root, 'checklists/services/amazon.json'), JSON.stringify({ schemaVersion: 1, service: 'amazon', capabilities: [cap] }));
    await writeFile(path.join(root, 'verification/execution.json'), JSON.stringify(execution));
    await writeFile(path.join(root, 'verification/proof.json'), JSON.stringify(receipt));
  };
  const audit = async () => (await auditCapabilityChecklist({ root, service: 'amazon' })).capabilities[0].status;
  await save(); return { save, audit, proof, cap };
}

test('session-backed public product is recorded without inventing account authentication', async t => {
  const f = await fixture(t); assert.equal(await f.audit(), 'recorded_live');
  for (const fields of [{ authenticated: true }, { credentialProvider: 'plaintext' }, { sessionRenewalVerified: true },
    { projectionSha256: 'a'.repeat(64) }, { secretsPersistedInEvidence: true }]) {
    await f.save(live, { ...f.proof, ...fields }); assert.equal(await f.audit(), 'evidence_invalid');
  }
});

test('200 without wire binding or option semantics never passes even with recomputed projection hashes', async t => {
  const f = await fixture(t);
  for (const mutate of [r => r.data.dimensions = [], r => r.data.receipt.credentialPropagated = false,
    r => r.data.receipt.cookieHeaderMatchedOnWire = false, r => r.data.asin = 'B000000000',
    r => r.data.receipt.authenticationVerified = true, r => r.browserUsed = true]) {
    const run = structuredClone(live); mutate(run);
    await f.save(run, { ...f.proof, requestSha256: sha(JSON.stringify(run.data.receipt)), projectionSha256: sha(JSON.stringify(run.data)) });
    assert.equal(await f.audit(), 'evidence_invalid');
  }
});
