#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Local readback only. Does not retry blocked services or make network requests.
const root = new URL('../', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const records = [];
for (const spec of [
  { service: 'shein', capabilityId: 'catalog.home_document',
    resultFile: 'verification/retail-shein-home-cli-2026-10-15-v2.json', parser: 'lib/retail/shein.mjs', format: 'html_document' },
  { service: 'iherb', capabilityId: 'catalog.sitemap_products',
    resultFile: 'verification/retail-iherb-sitemap-cli-2026-10-15-v2.json', parser: 'lib/retail/overseas-sitemaps.mjs', format: 'xml_sitemap' },
]) {
  const run = JSON.parse(await readFile(new URL(spec.resultFile, root), 'utf8'));
  assert.equal(run.ok, true);
  assert.equal(run.service, spec.service);
  assert.equal(run.executionMode, 'pure_http');
  assert.equal(run.browserUsed, false);
  assert.equal(run.credentialsUsed, false);
  assert.equal(run.fiveStates.captured, false);
  const rows = run.data.products ?? run.data.items;
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map(row => row.externalProductId)).size, rows.length);
  assert.ok(run.requests.every(request => request.httpStatus === 200 && request.responseBytes > 0 && request.cookieSent === false));
  let browserComparison = null;
  if (spec.service === 'shein') {
    assert.equal(run.data.context.currency, 'KRW');
    assert.ok(rows.every(row => row.title && /^\d+(?:\.\d+)?$/.test(row.salePrice.amount)
      && row.salePrice.currency === 'KRW' && row.salePrice.basis === 'displayed_home_card'
      && row.options === null && row.stock === null));
    assert.ok(run.data.navigation.length > 0);
    assert.equal(run.data.coverage.completeCatalog, false);
    const browserFile = 'verification/retail-shein-browser-dom-2026-10-15.json';
    const browserBytes = await readFile(new URL(browserFile, root));
    const browser = JSON.parse(browserBytes);
    const matched = rows.filter(row => browser.cards.some(card => card.title === row.title
      && card.displayPrice === row.salePrice.displayText)).length;
    const commonTitles = rows.filter(row => browser.cards.some(card => card.title === row.title)).length;
    assert.ok(matched > 0, 'No independently matched browser card');
    browserComparison = { kind: 'rendered_dom_only', matched, total: rows.length, browserTotal: browser.cards.length,
      commonTitles, completeMatch: matched === rows.length && matched === browser.cards.length,
      note: 'Separate dated requests may return different recommendation members. Only exact title-and-price matches count.',
      evidenceFile: browserFile, evidenceSha256: hash(browserBytes), networkCaptured: false };
  } else {
    assert.ok(rows.every(row => row.url === `https://www.iherb.com/pr/${row.slug}/${row.externalProductId}`));
    assert.equal(run.data.priceVerified, false);
    assert.equal(run.data.completeCatalog, false);
    assert.ok(run.data.nextOffset === null || run.data.nextOffset === run.data.offset + rows.length);
  }
  const implementation = {};
  for (const file of [spec.parser, 'scripts/overseas-retail.mjs', 'scripts/verify-overseas-retail.mjs',
    'lib/cli.mjs', 'package-lock.json', spec.resultFile]) implementation[file] = hash(await readFile(new URL(file, root)));
  const request = run.requests.at(-1);
  const proof = { schema: 'web-api-public-read-receipt-v1', service: spec.service, capabilityId: spec.capabilityId,
    checkedAt: run.checkedAt, verifiedAt: new Date().toISOString(), anonymous: true, authenticated: false,
    credentialsUsed: false, browserUsed: false, secretsPersistedInEvidence: false,
    schemaVerified: true, expectedResultVerified: true, resultCount: rows.length, request,
    contractProvenance: { kind: 'direct_http_observed', sourceURL: request.origin + request.path,
      responseFormat: spec.format, projectionSha256: hash(JSON.stringify(run.data)),
      browserNetworkCaptured: false }, implementation,
    actualRunner: { entrypoint: 'scripts/overseas-retail.mjs', operation: run.operation, exitStatus: 0 },
    fiveStates: run.fiveStates, browserComparison, fullCatalogVerified: false };
  const out = `verification/retail-${spec.service}-direct-http-proof-2026-10-15.json`;
  await writeFile(new URL(out, root), JSON.stringify(proof, null, 2) + '\n');
  records.push({ service: spec.service, count: rows.length, proof: out, browserCaptured: false });
}
console.log(JSON.stringify({ ok: true, networkUsed: false, records }));
