import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyOverseasRetailEvidence } from '../scripts/verify-overseas-retail.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'overseas-evidence-test-'));
  t.after(async () => {
    const target = await realpath(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('overseas-evidence-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const files = new Set();
  for (const [service, id] of [['shein', 'catalog.home_document'], ['iherb', 'catalog.sitemap_products']]) {
    const manifestFile = 'checklists/services/' + service + '.json';
    const manifest = JSON.parse(await readFile(path.join(source, manifestFile), 'utf8'));
    manifest.capabilities = manifest.capabilities.filter(cap => cap.id === id);
    const cap = manifest.capabilities[0];
    for (const item of [...cap.implementation.files, ...cap.implementation.cli]) files.add(item.path);
    for (const file of cap.implementation.tests) files.add(file);
    for (const item of cap.evidence) {
      for (const file of [...item.files, ...item.hashPaths]) files.add(file);
      const proof = JSON.parse(await readFile(path.join(source, item.files[0]), 'utf8'));
      for (const file of Object.keys(proof.implementation)) files.add(file);
      if (proof.browserComparison) files.add(proof.browserComparison.evidenceFile);
    }
    await mkdir(path.dirname(path.join(root, manifestFile)), { recursive: true });
    await writeFile(path.join(root, manifestFile), JSON.stringify(manifest));
  }
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(source, file), path.join(root, file));
  }
  const proofFiles = [...files].filter(file => /verification\/.+-direct-http-proof-/.test(file));
  const snapshot = async () => Promise.all(proofFiles.map(file => readFile(path.join(root, file), 'utf8')));
  return { root, snapshot };
}

test('offline verification preserves original receipts and observation dates', async t => {
  const f = await fixture(t), before = await f.snapshot();
  const result = await verifyOverseasRetailEvidence({ root: f.root });
  assert.equal(result.networkUsed, false);
  assert.equal(result.liveReplaysExecuted, 0);
  assert.equal(result.evidenceFilesWritten, 0);
  assert.deepEqual(result.records.map(record => record.recordedAt), before.map(raw => JSON.parse(raw).checkedAt));
  assert.ok(result.records.every(record => record.status === 'recorded_evidence_verified'));
  assert.deepEqual(await f.snapshot(), before);
});

test('changed runtime code is rejected without binding old evidence to new code', async t => {
  const f = await fixture(t), before = await f.snapshot();
  await appendFile(path.join(f.root, 'lib/retail/shein.mjs'), '\n// changed parser\n');
  await assert.rejects(() => verifyOverseasRetailEvidence({ root: f.root }));
  assert.deepEqual(await f.snapshot(), before);
});

test('changed historical response and projection are rejected without rewriting proof', async t => {
  const f = await fixture(t), before = await f.snapshot();
  const file = path.join(f.root, 'verification/retail-shein-home-cli-2026-10-15-v2.json');
  const run = JSON.parse(await readFile(file, 'utf8'));
  run.data.products = [];
  await writeFile(file, JSON.stringify(run));
  await assert.rejects(() => verifyOverseasRetailEvidence({ root: f.root }));
  assert.deepEqual(await f.snapshot(), before);
});

test('verification-tool changes are provenance, while current validators still reject bad proof', async t => {
  const f = await fixture(t);
  await appendFile(path.join(f.root, 'scripts/verify-overseas-retail.mjs'), '\n// current offline verifier\n');
  const result = await verifyOverseasRetailEvidence({ root: f.root });
  assert.equal(result.records.length, 2);
  const file = path.join(f.root, 'verification/retail-shein-direct-http-proof-2026-10-15.json');
  const proof = JSON.parse(await readFile(file, 'utf8'));
  proof.schemaVerified = false;
  await writeFile(file, JSON.stringify(proof));
  await assert.rejects(() => verifyOverseasRetailEvidence({ root: f.root }));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVerified, false);
});
