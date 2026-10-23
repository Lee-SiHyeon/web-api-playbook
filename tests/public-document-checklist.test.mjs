import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditCapabilityChecklist } from '../lib/capability-checklist.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, mime) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch/tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'public-document-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['lib', 'checklists/services', 'verification']) await mkdir(path.join(root, dir), { recursive: true });
  const source = 'export function readDirectory() {}\n';
  await writeFile(path.join(root, 'lib/directory.mjs'), source);
  const request = { method: 'GET', origin: 'https://directory.example', path: '/items/123',
    checkedAt: '2026-10-23T10:00:00Z', httpStatus: 200, mime, responseBytes: 250,
    responseSha256: sha('synthetic response bytes'), browserUsed: false, anonymous: true, credentialsUsed: false };
  const data = { items: [{ id: '123', title: 'Synthetic service package', amount: '15000', currency: 'KRW' }] };
  const execution = { schema: 'web-api-public-document-result-v1', service: 'directory',
    ok: true, executionMode: 'pure_http', anonymous: true, credentialsUsed: false,
    browserUsed: false, writesSubmitted: 0, completeCatalog: false,
    fiveStates: { captured: false, live_replay: true }, data, dataSha256: sha(JSON.stringify(data)), requests: [request] };
  const receipt = { schema: 'web-api-public-read-receipt-v1', service: 'directory', capabilityId: 'catalog.detail',
    checkedAt: request.checkedAt, secretsPersistedInEvidence: false, anonymous: true,
    credentialsUsed: false, schemaVerified: true, expectedResultVerified: true,
    request, resultCount: 1, implementation: { 'lib/directory.mjs': sha(source) },
    contractProvenance: { kind: 'direct_http_observed', sourceURL: request.origin + request.path,
      responseFormat: mime === 'text/html' ? 'html_document' : 'json_response',
      sourceSha256: request.responseSha256, projectionSha256: execution.dataSha256 } };
  const manifest = { schemaVersion: 1, service: 'directory', capabilities: [{
    id: 'catalog.detail', title: 'Public directory detail', priority: 'required', applicability: 'applicable', requirement: 'live',
    implementation: { files: [{ path: 'lib/directory.mjs', exports: ['readDirectory'] }], tests: [] },
    evidence: [{ kind: 'http-public-read-v1', origin: request.origin, path: request.path, mime,
      files: ['verification/receipt.json', 'verification/execution.json'], hashPaths: ['lib/directory.mjs'] }], sourceEvidence: [],
  }] };
  await writeFile(path.join(root, 'checklists/services/directory.json'), JSON.stringify(manifest));
  const audit = async (proof = receipt, run = execution) => {
    await writeFile(path.join(root, 'verification/receipt.json'), JSON.stringify(proof));
    await writeFile(path.join(root, 'verification/execution.json'), JSON.stringify(run));
    return (await auditCapabilityChecklist({ root, service: 'directory' })).capabilities[0].status;
  };
  return { root, receipt, execution, audit };
}

test('public HTML and JSON projections bind normalized items and HTTP bytes without pretending to be XHR captures', async t => {
  for (const mime of ['text/html', 'application/json']) {
    const f = await fixture(t, mime);
    assert.equal(await f.audit(), 'recorded_live');
    await writeFile(path.join(f.root, 'lib/directory.mjs'), 'export function readDirectory() { return []; }\n');
    assert.equal(await f.audit(), 'needs_reverification');
  }
});

test('tampered response/projection hashes, identities, coverage claims and runtime provenance fail closed', async t => {
  const f = await fixture(t, 'text/html');
  for (const change of [
    { schema: 'arbitrary-200-response' }, { service: 'different' }, { completeCatalog: true },
    { browserUsed: true }, { credentialsUsed: true }, { writesSubmitted: 1 },
    { fiveStates: { captured: true, live_replay: true } },
    { dataSha256: sha('other projection') }, { data: { items: [{ title: 'missing identity' }] } },
    { requests: [{ ...f.receipt.request, responseSha256: sha('other response') }] },
  ]) assert.equal(await f.audit(f.receipt, { ...f.execution, ...change }), 'evidence_invalid', JSON.stringify(change));
  assert.equal(await f.audit({ ...f.receipt, resultCount: 2 }), 'evidence_invalid');
  assert.equal(await f.audit({ ...f.receipt, contractProvenance: {
    ...f.receipt.contractProvenance, sourceSha256: sha('other source'),
  } }), 'evidence_invalid');
  const empty = { items: [] }, hash = sha(JSON.stringify(empty));
  assert.equal(await f.audit({ ...f.receipt, resultCount: 0, contractProvenance: {
    ...f.receipt.contractProvenance, projectionSha256: hash,
  } }, { ...f.execution, data: empty, dataSha256: hash }), 'evidence_invalid');
});
