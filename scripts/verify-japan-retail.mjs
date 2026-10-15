#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sha, japanDestination } from '../lib/retail/japan-http.mjs';
import { auditCapabilityChecklist, safeRelativePath } from '../lib/capability-checklist.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'verification/japan-retail-2026-10-15/';
const read = async file => {
  assert.ok(safeRelativePath(file));
  return readFile(path.join(root, file));
};
const json = async file => JSON.parse((await read(file)).toString('utf8'));
const nonSecret = value => {
  if (Array.isArray(value)) return value.forEach(nonSecret);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(?:cookie|cookies|authorization|accessToken|accessKey|appId|applicationId|refreshToken|crumb|remoteIp|maskYid|profiles|rawHtml|pageProps)$/i.test(key), 'Forbidden evidence field: ' + key);
    nonSecret(child);
  }
};
const validateRun = run => {
  assert.equal(run.schema, 'web-api-japan-retail-result-v1');
  assert.equal(run.ok, true); assert.equal(run.executionMode, 'pure_http');
  for (const key of ['browserUsed','credentialsUsed','completeCatalog','affiliateLinkVerified']) assert.equal(run[key], false);
  assert.equal(run.anonymous, true); assert.equal(run.writesSubmitted, 0);
  assert.equal(run.fiveStates.captured, false); assert.equal(run.fiveStates.live_replay, true);
  assert.equal(run.dataSha256, sha(JSON.stringify(run.data)));
  const site = run.service === 'rakuten-ichiba' ? 'rakuten' : run.service === 'yahoo-shopping-jp' ? 'yahoo' : null;
  assert.ok(site); assert.equal(japanDestination(site, run.url)?.url, run.url);
  const final = run.requests.at(-1);
  assert.equal(final.httpStatus, 200); assert.equal(final.mime, 'text/html'); assert.ok(final.responseBytes > 0);
  assert.match(final.responseSha256, /^[a-f0-9]{64}$/);
  for (const request of run.requests) {
    assert.equal(request.method, 'GET'); assert.equal(request.anonymous, true);
    assert.equal(request.cookieSent, false); assert.equal(request.credentialsUsed, false);
    assert.equal(request.browserUsed, false); assert.equal(request.authorizationSent, false);
    assert.equal(new URL(request.url).origin, request.origin); assert.equal(new URL(request.url).pathname, request.path);
  }
  if (run.operation === 'product') {
    const p = run.data.product;
    assert.equal(p.url, run.url); assert.equal(p.identityVerified, true); assert.ok(p.id && p.title);
    if (p.price) assert.equal(p.price.currency, 'JPY');
    for (const v of p.variants) {
      assert.ok(v.id); assert.ok(Array.isArray(v.options));
      if (v.price) { assert.equal(v.price.currency, 'JPY'); assert.match(v.price.amount, /^\d+$/); }
      else { assert.equal(site, 'yahoo'); assert.equal(v.selectedVariantPriceVerified, false); assert.equal(v.priceSource, null); }
    }
  }
  nonSecret(run);
};

try {
  const manifest = await json(folder + 'manifest.json');
  assert.equal(manifest.schema, 'web-api-japan-playbook-verification-v1');
  for (const [file, digest] of Object.entries(manifest.implementation)) assert.equal(sha(await read(file)), digest, 'Changed implementation: ' + file);
  for (const [file, digest] of Object.entries(manifest.artifacts)) {
    assert.equal(sha(await read(folder + file)), digest, 'Changed evidence: ' + file);
    nonSecret(await json(folder + file));
  }
  const executions = new Map();
  for (const file of manifest.executions) {
    const run = await json(folder + file); validateRun(run); executions.set(file, run);
  }
  for (const pair of manifest.readbacks) {
    const first = executions.get(pair[0]), second = executions.get(pair[1]);
    assert.notEqual(first.checkedAt, second.checkedAt);
    assert.equal(first.data.product.id, second.data.product.id);
    assert.deepEqual(first.data.product.variants.map(v=>v.id).sort(), second.data.product.variants.map(v=>v.id).sort());
  }
  const pages = manifest.searchPages.map(file => executions.get(file));
  const seen = new Set();
  pages.forEach((run, i) => {
    assert.equal(run.data.query.page, i + 1); assert.equal(run.data.query.keyword, 'マウス');
    assert.equal(run.data.query.categoryId, '100026');
    assert.ok(run.data.products.some(p=>!seen.has(p.id)));
    for (const p of run.data.products) { seen.add(p.id); assert.equal(p.price.currency, 'JPY'); assert.equal(p.selectedVariantPriceVerified, false); }
    if (i) assert.equal(pages[i-1].data.pagination.nextUrl, run.url);
  });
  const frontierSummaries = [];
  for (const pair of manifest.resumePairs) {
    const before = await json(folder + pair[0]), after = await json(folder + pair[1]);
    assert.equal(after.root, before.root); assert.equal(after.collection.completeCatalog, false);
    assert.ok(after.collection.pending > 0); assert.equal(after.collection.stopReason, 'page_budget');
    for (const node of before.nodes.filter(n=>n.state === 'replay_verified')) {
      const current = after.nodes.find(n=>n.url===node.url);
      assert.equal(current.state, node.state); assert.equal(current.attempts, node.attempts);
    }
    assert.ok(after.runs.length > before.runs.length);
    after.runs.forEach(validateRun);
    frontierSummaries.push({ service: after.service, ...after.collection });
  }
  for (const [service, ids] of Object.entries(manifest.recordedCapabilities)) {
    const audit = await auditCapabilityChecklist({ root, service });
    for (const id of ids) assert.equal(audit.capabilities.find(c=>c.id===id)?.status, 'recorded_live', service + ':' + id);
  }
  const diagnostic = await json(folder + 'yahoo-search-diagnostic.json');
  assert.equal(diagnostic.ok, false); assert.equal(diagnostic.request.httpStatus, 500);
  assert.equal(diagnostic.cause, 'unknown'); assert.equal(diagnostic.responseContractVerified, false);
  const reviews = await json(folder + 'rakuten-review-summary.json');
  assert.equal(reviews.productId, executions.get('rakuten-product-01.json').data.product.id);
  assert.equal(reviews.collection.pagesRead, 2); assert.equal(reviews.collection.paginationVerified, true);
  assert.equal(reviews.collection.complete, false);
  assert.ok(reviews.receipts.some(r=>r.path === '/review/itemshopreviewlist/get/v1' && r.httpStatus === 207));
  console.log(JSON.stringify({ ok: true, verifier: 'japan-retail-recorded-evidence', networkUsed: false,
    executions: executions.size, searchPages: pages.length, searchRows: pages.reduce((n,r)=>n+r.data.products.length,0),
    uniqueSearchProducts: seen.size, reviewCount: reviews.collection.count, frontierSummaries,
    publicReplay: true, browserCapture: false, affiliateLinksVerified: false,
    officialCredentialedReplay: false, completeCatalog: false }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, verifier: 'japan-retail-recorded-evidence',
    code: 'JAPAN_RECORDED_EVIDENCE_INVALID', detail: error.message?.slice(0, 300) }));
  process.exitCode = 1;
}
