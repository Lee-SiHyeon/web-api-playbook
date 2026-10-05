import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { auditCapabilityChecklist, safeRelativePath } from '../lib/capability-checklist.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = text => createHash('sha256').update(text).digest('hex');
const time = '2026-10-05T00:00:00.000Z';
const later = '2026-10-05T00:00:01.000Z';

async function fixture(t, { kind = 'http-write-v1', source = false } = {}) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'capability-checklist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'checklists/services'), { recursive: true });
  await mkdir(path.join(root, 'lib'), { recursive: true });
  await mkdir(path.join(root, 'verification'), { recursive: true });
  const code = 'export function update() { return true; }\n';
  if (!source) await writeFile(path.join(root, 'lib/item.mjs'), code);
  const manifest = {
    schemaVersion: 1, service: 'demo', capabilities: [{
      id: 'item.update', title: 'Update and read back', priority: 'required', applicability: 'applicable', requirement: 'live',
      implementation: { files: [{ path: 'lib/item.mjs', exports: ['update'] }], cli: [], tests: [] },
      evidence: source ? [] : [{ kind, origin: 'https://example.test', method: 'POST', path: '/v1/item', readbackPath: '/v1/item',
        files: ['verification/item-live.json'], hashPaths: ['lib/item.mjs'] }],
      sourceEvidence: source ? [{ files: ['verification/source.json'] }] : [],
    }],
  };
  await writeFile(path.join(root, 'checklists/services/demo.json'), JSON.stringify(manifest));
  const receipt = {
    schema: 'web-api-capability-receipt-v1', service: 'demo', capabilityId: 'item.update', checkedAt: later,
    secretsPersistedInEvidence: false, authenticated: true, ownerVerified: true,
    writeSent: true, postAttempts: 1, beforeHash: sha('before'), afterHash: sha('after'),
    writeReceipt: { method: 'POST', origin: 'https://example.test', path: '/v1/item', httpStatus: 200,
      mime: 'application/json', responseBytes: 12, browserUsed: false, checkedAt: time },
    readback: { method: 'GET', origin: 'https://example.test', path: '/v1/item', httpStatus: 200,
      mime: 'application/json', responseBytes: 12, browserUsed: false, checkedAt: later, ownerMatched: true,
      fieldsMatched: true, stateChanged: true, matchedFields: ['title'] },
    implementation: { 'lib/item.mjs': sha(code) },
  };
  if (source) await writeFile(path.join(root, 'verification/source.json'), JSON.stringify({
    schema: 'inpock-feature-discovery-v1', sourceCandidateContracts: [{ evidence_level: 'public_source_candidate_not_replayed' }],
  }));
  else await writeFile(path.join(root, 'verification/item-live.json'), JSON.stringify(receipt));
  const audit = () => auditCapabilityChecklist({ root, service: 'demo' });
  const save = value => writeFile(path.join(root, 'verification/item-live.json'), JSON.stringify(value));
  return { root, manifest, receipt, audit, save };
}

test('source-only and missing implementation remain a required gap', async t => {
  const context = await fixture(t, { source: true });
  const result = await context.audit();
  assert.equal(result.capabilities[0].status, 'source_candidate');
  assert.deepEqual(result.summary.requiredGaps, ['item.update']);
});

test('public multi-status reads require explicit status, verified business data, and exact JSON origin', async t => {
  const context = await fixture(t, { kind: 'http-public-read-v1' });
  const evidence = context.manifest.capabilities[0].evidence[0];
  evidence.readOnly = true; evidence.mime = 'application/json';
  const saveManifest = () => writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  await saveManifest();
  const receipt = { schema: 'web-api-public-read-receipt-v1', service: 'demo', capabilityId: 'item.update',
    checkedAt: later, anonymous: true, credentialsUsed: false, authenticated: false,
    schemaVerified: true, expectedResultVerified: true, secretsPersistedInEvidence: false,
    contractProvenance: { kind: 'browser_xhr_observed', sourceURL: 'https://example.test/reviews' },
    request: { method: 'POST', origin: 'https://example.test', path: '/v1/item', httpStatus: 207,
      mime: 'application/json', responseBytes: 123, checkedAt: time, browserUsed: false, anonymous: true, cookieSent: false },
    implementation: context.receipt.implementation };
  await context.save(receipt);
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  evidence.acceptedStatuses = [207]; await saveManifest();
  assert.equal((await context.audit()).capabilities[0].status, 'recorded_live');
  await context.save({ ...receipt, expectedResultVerified: false });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  await context.save({ ...receipt, request: { ...receipt.request, mime: 'text/html' } });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  await context.save({ ...receipt, request: { ...receipt.request, httpStatus: 200 } });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  evidence.acceptedStatuses = [403]; await saveManifest();
  await assert.rejects(context.audit(), /CHECKLIST_SCHEMA_INVALID/);
});

test('full write and independent readback receipt is recorded only with matching code hash', async t => {
  const context = await fixture(t);
  assert.equal((await context.audit()).capabilities[0].status, 'recorded_live');
  await writeFile(path.join(context.root, 'lib/item.mjs'), 'export function update() { return false; }\n');
  const result = await context.audit();
  assert.equal(result.capabilities[0].status, 'needs_reverification');
  assert.equal(result.capabilities[0].evidence.reports[0].freshness.mismatches[0].reason, 'code_changed');
  assert.deepEqual(result.summary.requiredGaps, ['item.update']);
});

test('omitted optional CLI inventory is valid', async t => {
  const context = await fixture(t);
  delete context.manifest.capabilities[0].implementation.cli;
  await writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  assert.equal((await context.audit()).capabilities[0].status, 'recorded_live');
});

test('not_applicable needs an explicit applicability reason before it can pass', async t => {
  const context = await fixture(t);
  context.manifest.capabilities[0].applicability = 'not_applicable';
  const saveManifest = () => writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  await saveManifest();
  await assert.rejects(context.audit(), /CHECKLIST_SCHEMA_INVALID/);
  context.manifest.capabilities[0].applicabilityReason = '   ';
  await saveManifest();
  await assert.rejects(context.audit(), /CHECKLIST_SCHEMA_INVALID/);
  context.manifest.capabilities[0].applicabilityReason = 'This endpoint is absent from the service product.';
  await saveManifest();
  const result = await context.audit();
  assert.equal(result.capabilities[0].status, 'not_applicable');
  assert.equal(result.capabilities[0].gatePassed, true);
  assert.equal(result.capabilities[0].applicabilityReason, context.manifest.capabilities[0].applicabilityReason);
});

test('generic write accepts observed 2xx with JSON and the declared origin only', async t => {
  const context = await fixture(t);
  await context.save({ ...context.receipt, writeReceipt: { ...context.receipt.writeReceipt, httpStatus: 201 } });
  assert.equal((await context.audit()).capabilities[0].status, 'recorded_live');
  context.manifest.capabilities[0].evidence[0].acceptedStatuses = [200];
  await writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  context.manifest.capabilities[0].evidence[0].acceptedStatuses = [200, 201];
  await writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  assert.equal((await context.audit()).capabilities[0].status, 'recorded_live');
  await context.save({ ...context.receipt, writeReceipt: { ...context.receipt.writeReceipt, origin: 'https://wrong.test' } });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  await context.save({ ...context.receipt, writeReceipt: { ...context.receipt.writeReceipt, mime: 'text/html' } });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  context.manifest.capabilities[0].evidence[0].httpStatus = 200;
  await writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  await assert.rejects(context.audit(), /CHECKLIST_SCHEMA_INVALID/);
});

test('Inpock receipt rejects a different HTTPS API origin', async t => {
  const context = await fixture(t);
  context.manifest.capabilities[0].evidence = [{ kind: 'inpock-profile-read-v1',
    files: ['verification/item-live.json'], hashPaths: ['lib/item.mjs'] }];
  await writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  const profileReceipt = {
    schema: 'inpock-profile-verification-v1', secretsPersistedInEvidence: false,
    profileRead: { authenticated: true, ownerVerified: true, snapshotHash: sha('snapshot'),
      profileFieldNames: ['title'], actualRunner: 'scripts/inpock.mjs profile-get --credentials-stdin',
      receipt: { method: 'GET', origin: 'https://link-rest.inpock.co.kr', path: '/v2/users/design',
        httpStatus: 200, responseBytes: 24, browserUsed: false, checkedAt: time } },
    liveSavePerformed: false, liveSaveVerified: false, postAttempts: 0,
    unchangedEdit: { writeSent: false, postAttempts: 0 },
    states: { profileRead: { captured: true, client_exists: true, credential_propagated: true,
      remnant_free: true, live_replay: true }, profileEdit: { live_replay: false } },
    implementation: { 'lib/item.mjs': sha('export function update() { return true; }\n') },
  };
  await context.save(profileReceipt);
  assert.equal((await context.audit()).capabilities[0].status, 'recorded_live');
  await context.save({ ...profileReceipt, profileRead: { ...profileReceipt.profileRead,
    receipt: { ...profileReceipt.profileRead.receipt, origin: 'https://wrong.test' } } });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
});

test('a bare ok flag or no-op write is rejected as live evidence', async t => {
  const context = await fixture(t);
  await context.save({ ok: true });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  await context.save({ ...context.receipt, postAttempts: 0, writeSent: false });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
  await context.save({ ...context.receipt, readback: { ...context.receipt.readback, stateChanged: false } });
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
});

test('missing and corrupt receipts are explicit gaps', async t => {
  const context = await fixture(t);
  await rm(path.join(context.root, 'verification/item-live.json'));
  assert.equal((await context.audit()).capabilities[0].status, 'pending_live');
  await writeFile(path.join(context.root, 'verification/item-live.json'), '{bad');
  assert.equal((await context.audit()).capabilities[0].status, 'evidence_invalid');
});

test('unsafe manifest paths and missing export do not pass inventory', async t => {
  const context = await fixture(t);
  assert.equal(safeRelativePath('../outside.json'), false);
  context.manifest.capabilities[0].evidence[0].files = ['../outside.json'];
  await writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  await assert.rejects(context.audit(), /CHECKLIST_SCHEMA_INVALID/);
  context.manifest.capabilities[0].evidence[0].files = ['verification/item-live.json'];
  context.manifest.capabilities[0].implementation.files[0].exports = ['missingName'];
  await writeFile(path.join(context.root, 'checklists/services/demo.json'), JSON.stringify(context.manifest));
  const result = await context.audit();
  assert.equal(result.capabilities[0].status, 'partial_implementation');
});

test('Inpock checklist never credits source candidates or profile no-op as live edit', async () => {
  const manifest = JSON.parse(await readFile(path.join(repo, 'checklists/services/inpock.json'), 'utf8'));
  const edit = manifest.capabilities.find(cap => cap.id === 'profile.edit');
  assert.equal(edit.evidence[0].kind, 'http-write-v1');
  const result = await auditCapabilityChecklist({ root: repo, service: 'inpock' });
  const byId = Object.fromEntries(result.capabilities.map(cap => [cap.id, cap]));
  assert.notEqual(byId['profile.edit'].status, 'recorded_live');
  assert.equal(byId['collections.create'].status, 'source_candidate');
  assert.equal(byId['categories.contract'].status, 'scope_unknown');
  assert.equal(byId['categories.contract'].evidence.source[0].state, 'source_candidate');
  assert.equal(byId['categories.contract'].gatePassed, false);
  assert.equal(result.summary.strictPassed, false);
});
