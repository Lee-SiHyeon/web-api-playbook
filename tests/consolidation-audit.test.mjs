import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditConsolidation } from '../lib/consolidation-audit.mjs';

test('the consolidation audit detects changed and missing installed code without loading it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'consolidation-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'pack'));
  const bytes = 'throw Error("must not execute this module");';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(root, 'pack/client.mjs'), bytes);
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    sources: [{ repository: 'owner/client', files: [{ path: 'pack/client.mjs', sha256 }] }],
  }));
  const options = { manifests: ['manifest.json'] };
  assert.equal((await auditConsolidation(root, options)).ok, true);
  await writeFile(path.join(root, 'pack/client.mjs'), 'changed');
  assert.equal((await auditConsolidation(root, options)).errors[0].code, 'CONSOLIDATION_HASH_MISMATCH');
  await rm(path.join(root, 'pack/client.mjs'));
  assert.equal((await auditConsolidation(root, options)).errors[0].code, 'CONSOLIDATION_FILE_UNREADABLE');
});

test('a source manifest cannot read outside the checkout', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'consolidation-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ files: [
    { path: '../outside', sha256: '0'.repeat(64) },
  ] }));
  const result = await auditConsolidation(root, { manifests: ['manifest.json'] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'CONSOLIDATION_MANIFEST_INVALID');
  assert.equal(result.files, 0);
});
