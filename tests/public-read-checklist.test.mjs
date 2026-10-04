import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditCapabilityChecklist } from '../lib/capability-checklist.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch/tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'public-read-checklist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['lib', 'checklists/services', 'verification']) await mkdir(path.join(root, dir), { recursive: true });
  const code = 'export function readProduct() {}\n';
  await writeFile(path.join(root, 'lib/product.mjs'), code);
  const entry = { kind: 'http-public-read-v1', origin: 'https://mall.test', path: '/api/product',
    files: ['verification/live.json'], hashPaths: ['lib/product.mjs'] };
  const manifest = { schemaVersion: 1, service: 'mall', capabilities: [{
    id: 'product.read', title: 'Anonymous product read', priority: 'required', applicability: 'applicable', requirement: 'live',
    implementation: { files: [{ path: 'lib/product.mjs', exports: ['readProduct'] }], tests: [] },
    evidence: [entry], sourceEvidence: [],
  }] };
  const receipt = { schema: 'web-api-public-read-receipt-v1', service: 'mall', capabilityId: 'product.read',
    checkedAt: '2026-10-05T00:00:00Z', anonymous: true, credentialsUsed: false,
    secretsPersistedInEvidence: false, schemaVerified: true, expectedResultVerified: true,
    request: { method: 'GET', origin: entry.origin, path: entry.path, httpStatus: 200,
      mime: 'application/json', responseBytes: 125, anonymous: true, browserUsed: false,
      checkedAt: '2026-10-05T00:00:00Z' },
    contractProvenance: { kind: 'browser_xhr_observed', sourceURL: 'https://mall.test/product/1' },
    implementation: { 'lib/product.mjs': sha(code) },
  };
  const save = async value => {
    await writeFile(path.join(root, 'verification/live.json'), JSON.stringify(value));
    await writeFile(path.join(root, 'checklists/services/mall.json'), JSON.stringify(manifest));
  };
  const audit = async () => (await auditCapabilityChecklist({ root, service: 'mall' })).capabilities[0].status;
  await save(receipt);
  return { root, receipt, manifest, entry, save, audit };
}

test('anonymous read requires a real response and current implementation hash', async t => {
  const f = await fixture(t);
  assert.equal(await f.audit(), 'recorded_live');
  await writeFile(path.join(f.root, 'lib/product.mjs'), 'export function readProduct() { return null; }\n');
  assert.equal(await f.audit(), 'needs_reverification');
});

test('auth, browser, wrong route, HTML gate and schema failure cannot pass as anonymous JSON', async t => {
  const f = await fixture(t);
  const cases = [
    { credentialsUsed: true }, { anonymous: false }, { authenticated: true },
    { schemaVerified: false }, { expectedResultVerified: false },
    ...[{ cookieSent: true }, { browserUsed: true }, { origin: 'https://other.test' },
      { path: '/login' }, { httpStatus: 403 }, { mime: 'text/html' }, { responseBytes: 0 }]
      .map(request => ({ request: { ...f.receipt.request, ...request } })),
  ];
  for (const changes of cases) {
    await f.save({ ...f.receipt, ...changes });
    assert.equal(await f.audit(), 'evidence_invalid', JSON.stringify(changes));
  }
});

test('source candidates and unverifiable bundle provenance cannot pass a live API receipt', async t => {
  const f = await fixture(t);
  for (const kind of ['ssr_document', 'source_candidate', 'first_party_bundle_contract']) {
    await f.save({ ...f.receipt, contractProvenance: { kind, sourceURL: 'https://mall.test/app.js' } });
    assert.equal(await f.audit(), 'evidence_invalid');
  }
  await f.save({ ...f.receipt, contractProvenance: { kind: 'first_party_bundle_contract',
    sourceURL: 'https://mall.test/app.js', sourceSha256: sha('observed source') } });
  assert.equal(await f.audit(), 'recorded_live');
});

test('POST reads require declared read-only semantics and exact observed streaming MIME', async t => {
  const f = await fixture(t);
  f.entry.method = 'POST';
  f.entry.mime = 'application/json-amazonui-streaming';
  const receipt = { ...f.receipt, request: { ...f.receipt.request, method: 'POST', mime: f.entry.mime } };
  await f.save(receipt);
  await assert.rejects(f.audit(), /CHECKLIST_SCHEMA_INVALID/);
  f.entry.readOnly = true;
  await f.save(receipt);
  assert.equal(await f.audit(), 'recorded_live');
});

test('a JSON Ajax endpoint served as JavaScript must match its declared MIME', async t => {
  const f = await fixture(t);
  const receipt = { ...f.receipt, request: { ...f.receipt.request, mime: 'text/javascript' } };
  await f.save(receipt);
  assert.equal(await f.audit(), 'evidence_invalid');
  f.entry.mime = 'text/javascript';
  await f.save(receipt);
  assert.equal(await f.audit(), 'recorded_live');
});

test('a required currency lookup is independently checked rather than trusting the product response', async t => {
  const f = await fixture(t);
  f.entry.companionReads = [{ key: 'currencyRequest', origin: 'https://mall.test', path: '/cart.js', mime: 'text/javascript' }];
  await f.save(f.receipt);
  assert.equal(await f.audit(), 'evidence_invalid');
  const currencyRequest = { ...f.receipt.request, path: '/cart.js', mime: 'text/javascript' };
  await f.save({ ...f.receipt, currencyRequest });
  assert.equal(await f.audit(), 'recorded_live');
  await f.save({ ...f.receipt, currencyRequest: { ...currencyRequest, httpStatus: 403 } });
  assert.equal(await f.audit(), 'evidence_invalid');
});
