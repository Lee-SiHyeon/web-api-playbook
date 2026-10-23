#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCapabilityChecklist, safeRelativePath } from '../lib/capability-checklist.mjs';
import { verifyManifestImplementation } from '../lib/recorded-evidence-provenance.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const verifierPath = 'scripts/verify-overseas-retail.mjs';

// Read historical evidence without changing its bytes, dates or code binding.
// New runtime code needs a new observed execution, not a new hash on an old run.
export async function verifyOverseasRetailEvidence({ root = defaultRoot } = {}) {
  const bytes = async file => {
    assert.ok(safeRelativePath(file));
    return readFile(path.join(root, file));
  };
  const json = async file => JSON.parse((await bytes(file)).toString('utf8'));
  const records = [];
  for (const spec of [
    { service: 'shein', capabilityId: 'catalog.home_document', operation: 'home',
      resultFile: 'verification/retail-shein-home-cli-2026-10-15-v2.json', parser: 'lib/retail/shein.mjs', format: 'html_document' },
    { service: 'iherb', capabilityId: 'catalog.sitemap_products', operation: 'sitemap-products',
      resultFile: 'verification/retail-iherb-sitemap-cli-2026-10-15-v2.json', parser: 'lib/retail/overseas-sitemaps.mjs', format: 'xml_sitemap' },
  ]) {
    const proofFile = 'verification/retail-' + spec.service + '-direct-http-proof-2026-10-15.json';
    const proof = await json(proofFile);
    for (const file of [spec.parser, 'scripts/overseas-retail.mjs', verifierPath, 'lib/cli.mjs', 'package-lock.json', spec.resultFile]) {
      assert.match(proof.implementation?.[file] ?? '', /^[a-f0-9]{64}$/, 'Missing recorded binding: ' + file);
    }
    const provenance = await verifyManifestImplementation({ implementation: proof.implementation,
      readFile: bytes, sha256: hash, verificationToolKinds: { [verifierPath]: 'offline_evidence_verifier' } });
    const run = await json(spec.resultFile);
    assert.equal(run.schema, 'web-api-overseas-retail-result-v1');
    assert.equal(run.ok, true);
    assert.equal(run.service, spec.service);
    assert.equal(run.operation, spec.operation);
    assert.equal(run.executionMode, 'pure_http');
    assert.equal(run.browserUsed, false);
    assert.equal(run.credentialsUsed, false);
    assert.equal(run.fiveStates.captured, false);
    assert.equal(run.fiveStates.live_replay, true);
    assert.equal(proof.checkedAt, run.checkedAt);
    assert.equal(proof.actualRunner.entrypoint, 'scripts/overseas-retail.mjs');
    assert.equal(proof.actualRunner.operation, spec.operation);
    assert.equal(proof.actualRunner.exitStatus, 0);
    assert.equal(proof.contractProvenance.responseFormat, spec.format);
    assert.equal(proof.contractProvenance.projectionSha256, hash(JSON.stringify(run.data)));
    assert.deepEqual(proof.request, run.requests.at(-1));
    const rows = run.data.products ?? run.data.items;
    assert.ok(rows.length > 0);
    assert.equal(proof.resultCount, rows.length);
    assert.equal(new Set(rows.map(row => row.externalProductId)).size, rows.length);
    assert.ok(run.requests.every(request => request.method === 'GET' && request.httpStatus === 200
      && request.responseBytes > 0 && request.cookieSent === false && request.browserUsed === false));
    if (spec.service === 'shein') {
      assert.equal(run.data.context.currency, 'KRW');
      assert.ok(rows.every(row => row.title && /^\d+(?:\.\d+)?$/.test(row.salePrice.amount)
        && row.salePrice.currency === 'KRW' && row.salePrice.basis === 'displayed_home_card'
        && row.options === null && row.stock === null));
      assert.ok(run.data.navigation.length > 0);
      assert.equal(run.data.coverage.completeCatalog, false);
      const browserFile = 'verification/retail-shein-browser-dom-2026-10-15.json';
      const browserBytes = await bytes(browserFile);
      const browser = JSON.parse(browserBytes);
      const matched = rows.filter(row => browser.cards.some(card => card.title === row.title
        && card.displayPrice === row.salePrice.displayText)).length;
      const commonTitles = rows.filter(row => browser.cards.some(card => card.title === row.title)).length;
      assert.ok(matched > 0, 'No independently matched browser card');
      for (const [key, value] of Object.entries({ kind: 'rendered_dom_only', matched, total: rows.length,
        browserTotal: browser.cards.length, commonTitles,
        completeMatch: matched === rows.length && matched === browser.cards.length,
        evidenceFile: browserFile, evidenceSha256: hash(browserBytes), networkCaptured: false })) {
        assert.equal(proof.browserComparison?.[key], value, 'Changed browser comparison: ' + key);
      }
    } else {
      assert.ok(rows.every(row => row.url === 'https://www.iherb.com/pr/' + row.slug + '/' + row.externalProductId));
      assert.equal(run.data.priceVerified, false);
      assert.equal(run.data.completeCatalog, false);
      assert.ok(run.data.nextOffset === null || run.data.nextOffset === run.data.offset + rows.length);
    }
    const audit = await auditCapabilityChecklist({ root, service: spec.service });
    assert.equal(audit.capabilities.find(cap => cap.id === spec.capabilityId)?.status, 'recorded_live');
    records.push({ service: spec.service, capabilityId: spec.capabilityId, count: rows.length,
      proof: proofFile, recordedAt: proof.checkedAt, status: 'recorded_evidence_verified',
      browserCaptured: false, completeCatalog: false, ...provenance });
  }
  return { ok: true, verifier: 'overseas-retail-recorded-evidence', verifiedAt: new Date().toISOString(),
    networkUsed: false, liveReplaysExecuted: 0, evidenceFilesWritten: 0, records };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyOverseasRetailEvidence(), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ ok: false, verifier: 'overseas-retail-recorded-evidence',
      networkUsed: false, evidenceFilesWritten: 0, code: 'OVERSEAS_RECORDED_EVIDENCE_INVALID', detail: error.message?.slice(0, 300) }));
    process.exitCode = 1;
  }
}
