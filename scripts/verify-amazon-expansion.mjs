#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { projectAmazonRetail } from '../lib/retail/amazon-ontology.mjs';
import { parseAmazonNavigation } from '../lib/retail/amazon-navigation.mjs';
import { parseAmazonProductDocument } from '../lib/retail/amazon-product.mjs';
import { auditCapabilityChecklist, safeRelativePath } from '../lib/capability-checklist.mjs';
import { verifyManifestImplementation } from '../lib/recorded-evidence-provenance.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = 'verification/amazon-discovery-2026-10-15/';
const sha = value => createHash('sha256').update(value).digest('hex');
async function bytes(file) { assert.ok(safeRelativePath(file)); return readFile(path.join(root, file)); }
const json = async file => JSON.parse((await bytes(file)).toString('utf8'));

// Refuse secret-bearing keys/headers/URLs, while permitting readiness booleans
// and query *names*. Output findings contain only the evidence filename.
function noRuntimeValues(value, key = '') {
  if (Array.isArray(value)) { value.forEach(v => noRuntimeValues(v, key)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(!/^(?:cookie|cookies|cookieJar|cookieHeader|authorization|set-cookie|access_token|refresh_token|sessionToken|hashCustomerAndSessionId|originalHttpReferer|slt|vs)$/i.test(k));
      noRuntimeValues(v, k);
    }
    return;
  }
  if (typeof value !== 'string') return;
  assert.ok(!/(?:session-id|session-token|aws-waf-token|sp-cdn|sst-main)=|Bearer\s+\S+|[?&](?:vs|slt|hashCustomerAndSessionId)=/i.test(value));
  if (/^https?:/.test(value)) {
    const u = new URL(value); assert.equal(u.username, ''); assert.equal(u.password, '');
    for (const field of u.searchParams.keys()) assert.ok(['node','rh','bbn','i','k'].includes(field), key);
  }
}

try {
  const manifest = await json(dir+'manifest.json');
  assert.ok(Number.isFinite(Date.parse(manifest.checkedAt)), 'Invalid historical checkedAt');
  const implementationVerification = await verifyManifestImplementation({
    implementation: manifest.implementation,
    readFile: bytes,
    sha256: sha,
    verificationToolKinds: {
      'lib/capability-checklist.mjs': 'evidence_validator',
      'scripts/verify-amazon-expansion.mjs': 'offline_verifier',
    },
  });
  for (const [file, expected] of Object.entries(manifest.files)) assert.equal(sha(await bytes(file)), expected, file);
  const nav = (await json(dir+'navigation.json')).data;
  const fixtureNav = parseAmazonNavigation((await bytes('tests/fixtures/amazon/menu-first.html')).toString(), (await bytes('tests/fixtures/amazon/menu-second.html')).toString());
  // Fixtures were captured in a separate read. One support link disappeared
  // and one extra incoming Artist Merch edge appeared in the later live read.
  for (const key of ['menus','unresolvedMenuIds']) assert.deepEqual(nav[key], fixtureNav[key], key);
  const catalogDestinations = graph => graph.destinations.filter(d => d.fetchAllowed).sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(catalogDestinations(nav), catalogDestinations(fixtureNav));
  const fixtureEdges = new Set(fixtureNav.edges.map(e=>JSON.stringify(e)));
  const liveEdges = new Set(nav.edges.map(e=>JSON.stringify(e)));
  assert.deepEqual(nav.edges.filter(e=>!fixtureEdges.has(JSON.stringify(e))).map(e=>[e.from,e.label,e.type]), [['menu:12','Artist Merch Shop','menu_to_listing']]);
  assert.deepEqual(fixtureNav.edges.filter(e=>!liveEdges.has(JSON.stringify(e))).map(e=>[e.from,e.label,e.type]), [['menu:1','Your Product Support','menu_to_other']]);
  assert.equal(nav.menus.length, 37); assert.equal(nav.destinations.length, 342); assert.equal(nav.edges.length, 418);
  assert.equal(nav.rootDiscoveryComplete, true); assert.equal(nav.returnedMenuReferencesResolved, true); assert.equal(nav.completeCatalog, false);
  assert.equal(nav.context.browserLocaleMatched, false);
  for (const receipt of nav.receipts) {
    assert.equal(receipt.httpStatus, 200); assert.equal(receipt.browserUsed, false); assert.equal(receipt.cookieSent, false);
    assert.equal(receipt.mime, 'application/json'); assert.ok(receipt.responseBytes > 0);
  }
  const browser = await json(dir+'browser-observation.json');
  assert.equal(browser.productDocumentNetworkCapture, false);
  assert.ok(browser.observations.every(o => o.requestResponsePaired && o.httpStatus === 200 && o.resourceType === 'XHR'));
  assert.equal(browser.twister.httpStatus, 200); assert.equal(browser.twister.recurringInputDerivationVerified, false);
  const crawl = await json(dir+'search-crawl.json'), resume = await json(dir+'search-resume.json');
  const pages = [...crawl.data.pages,...resume.data.pages];
  assert.deepEqual(pages.map(p => p.page), [1,2,3,4]); assert.deepEqual(resume.data.visitedPages, [1,2,3,4]);
  assert.deepEqual(crawl.data.checkpoint.visitedPages, [1,2,3]); assert.equal(crawl.data.checkpoint.nextPage, 4);
  assert.equal(resume.data.nextPage, 5); assert.equal(resume.data.checkpointIsBackgroundJob, false);
  assert.equal(resume.data.paginationTerminationVerified, false);
  assert.ok(pages.every(p => p.pagination.nextPage === p.page + 1));
  const asins = new Set(pages.flatMap(p => p.items.map(i => i.asin))); assert.equal(asins.size, 60);
  const productFiles = ['product-lotion.json','product-option.json','product-mouse.json','product-repeat.json'];
  const products = await Promise.all(productFiles.map(file => json(dir+file)));
  assert.equal(new Set(products.map(p => p.data.asin)).size, 3);
  for (const run of products) {
    assert.equal(run.ok, true); assert.equal(run.executionMode, 'pure_http'); assert.equal(run.browserUsed, false);
    const p = run.data, r = p.receipt;
    assert.equal(r.httpStatus, 200); assert.equal(r.mime, 'text/html'); assert.equal(r.credentialPropagated, true);
    assert.equal(r.cookieHeaderMatchedOnWire, true); assert.equal(r.sessionPersisted, true); assert.equal(r.sessionRenewalVerified, false);
    assert.equal(r.authenticationVerified, false); assert.equal(r.path, `/-/ko/dp/${p.asin}/`); assert.equal(p.coverage.identityVerified, true);
    assert.equal(p.coverage.completeGallery, false); assert.equal(p.coverage.optionOffersVerified, false); assert.equal(p.coverage.allReviews, false);
  }
  assert.ok(Date.parse(products[3].data.receipt.checkedAt) > Date.parse(products[0].data.receipt.checkedAt));
  const parsed = parseAmazonProductDocument((await bytes('tests/fixtures/amazon/product-lotion.html')).toString(), {asin:products[0].data.asin});
  for (const key of ['asin','title','features','displayedPrice','dimensions']) assert.deepEqual(parsed[key], products[0].data[key], key);
  const ontology = await json(dir+'ontology.json');
  const inputs = await Promise.all(ontology.inputs.map(async input => {
    const raw = await bytes(input.file); assert.equal(sha(raw),input.sha256,input.file); return JSON.parse(raw.toString());
  }));
  const {inputs:_,...projected} = ontology; assert.deepEqual(projected, projectAmazonRetail(inputs));
  assert.equal(ontology.offerings.length, 62); assert.equal(ontology.offers.length, 47); assert.equal(ontology.variants.length, 47);
  assert.equal(ontology.databaseWrites, 0); assert.equal(ontology.reviews.length, 0);
  const frontier = await json(dir+'frontier.json');
  assert.equal(frontier.complete, false); assert.equal(frontier.search.nextPage, 5);
  assert.equal(frontier.listingFrontier.length, 206); assert.equal(frontier.productFrontier.filter(p => p.state === 'pending').length, 114);
  assert.equal(frontier.productFrontier.filter(p => p.state === 'detail_verified').length, 3);
  assert.equal(frontier.excludedMenuDestinations.length, 97);
  const productFrontierIds = new Set(frontier.productFrontier.map(p => p.asin));
  for (const asin of [...asins,...nav.destinations.filter(d=>d.asin).map(d=>d.asin),...ontology.variants.map(v=>v.sourceLocalId)]) assert.ok(productFrontierIds.has(asin));
  assert.ok(frontier.nestedOperations.some(o=>o.operation==='reviews'&&o.state==='blocked_auth'));
  const probes = await json(dir+'followup-probes.json');
  assert.equal(probes.find(p=>p.operation==='reviews').httpStatus,302); assert.equal(probes.find(p=>p.operation==='reviews').redirect.path,'/ap/signin');
  assert.equal(probes.find(p=>p.operation==='twister').slots[0].asin,'B08KT2Z93D');
  const audit = await auditCapabilityChecklist({root,service:'amazon'});
  const verified = ['catalog.navigation','catalog.search','catalog.pagination','catalog.product','catalog.description','catalog.options','catalog.observed_images','catalog.displayed_offer'];
  for (const id of verified) assert.equal(audit.capabilities.find(c=>c.id===id)?.status,'recorded_live',id);
  assert.equal(audit.summary.strictPassed,false);
  const evidenceFiles = (await readdir(path.join(root,dir))).filter(f=>f.endsWith('.json'));
  for (const file of evidenceFiles) { try { noRuntimeValues(await json(dir+file)); } catch { throw new Error(`UNSAFE_EVIDENCE:${file}`); } }
  console.log(JSON.stringify({ok:true,status:'historical_recorded_evidence_revalidated',
    schema:'web-api-amazon-expansion-verifier-v1',checkedAt:new Date().toISOString(),recordedAt:manifest.checkedAt,
    networkUsed:false,liveState:'not_checked',protectedStoreRead:false,
    runtimeImplementationHashesMatched:implementationVerification.runtimeImplementationHashesMatched,
    evidenceHashesMatched:true,currentEvidenceValidation:true,
    verificationToolProvenance:implementationVerification.verificationToolProvenance,
    counts:manifest.counts,historicallyVerifiedCapabilities:verified,requiredGaps:audit.summary.requiredGaps,
    evidenceJsonFilesChecked:evidenceFiles.length,runtimeValueFindings:0,completeCatalog:false,sessionRenewalVerified:false},null,2));
} catch (error) {
  console.error(JSON.stringify({ok:false,code:'AMAZON_EVIDENCE_VERIFICATION_FAILED',detail:String(error.message).slice(0,500)}));
  process.exitCode=1;
}
