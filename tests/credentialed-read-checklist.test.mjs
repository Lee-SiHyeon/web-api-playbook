import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { auditCapabilityChecklist } from '../lib/capability-checklist.mjs';

async function fixture(t) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch/tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, 'catalog-checklist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['lib', 'checklists/services', 'verification']) await mkdir(path.join(root, dir), { recursive: true });
  const code = 'export function searchProducts() {}\n';
  await writeFile(path.join(root, 'lib/catalog.mjs'), code);
  const entry = { kind: 'http-credentialed-read-v1', origin: 'https://api.partner.test', path: '/catalog',
    files: ['verification/live.json'], hashPaths: ['lib/catalog.mjs'] };
  const manifest = { schemaVersion: 1, service: 'partner', capabilities: [{
    id: 'catalog.search', title: 'Partner products', priority: 'required', applicability: 'applicable', requirement: 'live',
    implementation: { files: [{ path: 'lib/catalog.mjs', exports: ['searchProducts'] }], tests: [] }, evidence: [entry], sourceEvidence: [],
  }] };
  const receipt = { schema: 'web-api-credentialed-read-receipt-v1', service: 'partner', capabilityId: 'catalog.search',
    checkedAt: '2026-10-05T00:00:00Z', secretsPersistedInEvidence: false, authenticated: true, credentialsUsed: true,
    credentialBindingVerified: true, schemaVerified: true, expectedResultVerified: true,
    credentialBinding: { source: 'process-memory', serviceMatched: true, originMatched: true, persisted: false },
    contractProvenance: { kind: 'first_party_documented_api', sourceURL: 'https://partner.test/docs' },
    request: { method: 'GET', origin: entry.origin, path: entry.path, httpStatus: 200, mime: 'application/json',
      responseBytes: 100, browserUsed: false, credentialsUsed: true, checkedAt: '2026-10-05T00:00:00Z' },
    implementation: { 'lib/catalog.mjs': createHash('sha256').update(code).digest('hex') },
  };
  const save = async value => {
    await writeFile(path.join(root, 'checklists/services/partner.json'), JSON.stringify(manifest));
    await writeFile(path.join(root, 'verification/live.json'), JSON.stringify(value));
  };
  const audit = async () => (await auditCapabilityChecklist({ root, service: 'partner' })).capabilities[0].status;
  await save(receipt);
  return { root, entry, manifest, receipt, save, audit };
}

test('catalog credentials can be verified without inventing an owner/profile read', async t => {
  const f = await fixture(t);
  assert.equal(await f.audit(), 'recorded_live');
  for (const fields of [{ authenticated: false }, { credentialsUsed: false }, { anonymous: true },
    { credentialBindingVerified: false }, { expectedResultVerified: false }]) {
    await f.save({ ...f.receipt, ...fields });
    assert.equal(await f.audit(), 'evidence_invalid');
  }
});

test('wrong-service credentials, persisted keys, auth errors and HTML gates cannot be credited', async t => {
  const f = await fixture(t);
  for (const binding of [{ serviceMatched: false }, { originMatched: false }, { persisted: true }]) {
    await f.save({ ...f.receipt, credentialBinding: { ...f.receipt.credentialBinding, ...binding } });
    assert.equal(await f.audit(), 'evidence_invalid');
  }
  for (const request of [{ httpStatus: 401 }, { browserUsed: true }, { credentialsUsed: false },
    { origin: 'https://other.test' }, { mime: 'text/html' }]) {
    await f.save({ ...f.receipt, request: { ...f.receipt.request, ...request } });
    assert.equal(await f.audit(), 'evidence_invalid');
  }
});

test('a documented public binary feed requires anonymous execution and the declared ZIP MIME', async t => {
  const f = await fixture(t);
  f.entry.kind = 'http-public-read-v1'; f.entry.mime = 'application/zip';
  const receipt = { ...f.receipt, schema: 'web-api-public-read-receipt-v1', authenticated: false,
    credentialsUsed: false, anonymous: true, contractProvenance: { kind: 'first_party_documented_feed', sourceURL: 'https://partner.test/help/export' },
    request: { ...f.receipt.request, credentialsUsed: false, anonymous: true, mime: 'application/zip' } };
  await f.save(receipt); assert.equal(await f.audit(), 'recorded_live');
  await f.save({ ...receipt, request: { ...receipt.request, credentialsUsed: true } });
  assert.equal(await f.audit(), 'evidence_invalid');
});

test('commerce collection requires matching native output counts and independent JSON/CSV readback',async t=>{
  const f=await fixture(t);f.entry.kind='commerce-collection-v1';f.entry.mime='application/zip';
  f.entry.files.push('verification/sample.json');
  const proof={schema:'web-api-commerce-collection-proof-v1',service:'partner',capabilityId:'catalog.search',checkedAt:'2026-10-05T00:00:00Z',
    secretsPersistedInEvidence:false,executionMode:'pure_http',browserUsed:false,credentialsUsed:false,
    sourceRequest:{...f.receipt.request,mime:'application/zip',anonymous:true,credentialsUsed:false},sampleOfferCount:1,fullOfferCount:10,csvDataRows:10,
    jsonReadbackMatched:true,csvReadbackMatched:true,fullJsonSha256:'a'.repeat(64),fullCsvSha256:'b'.repeat(64),
    actualRunner:{entrypoint:'scripts/commerce.mjs',exitStatus:0},implementation:f.receipt.implementation};
  const sample={schema:'web-api-product-price-snapshot-v1',executionMode:'pure_http',offers:[{
    schema:'web-api-product-offer-v1',productId:'1',title:'Observed product',price:{amount:'13.15',currency:'USD',kind:'retail_list'},priceRange:null,observedAt:'2026-10-05T00:00:00Z',
  }]};
  await writeFile(path.join(f.root,'verification/sample.json'),JSON.stringify(sample));
  await f.save(proof);assert.equal(await f.audit(),'recorded_live');
  for(const fields of [{csvReadbackMatched:false},{csvDataRows:9},{sampleOfferCount:2},{browserUsed:true}]){
    await f.save({...proof,...fields});assert.equal(await f.audit(),'evidence_invalid');
  }
});

test('commerce collection accepts valid price ranges and rejects malformed bounds or currencies',async t=>{
  const f=await fixture(t);f.entry.kind='commerce-collection-v1';f.entry.mime='application/zip';
  f.entry.files.push('verification/sample.json');
  const proof={schema:'web-api-commerce-collection-proof-v1',service:'partner',capabilityId:'catalog.search',checkedAt:'2026-10-05T00:00:00Z',
    secretsPersistedInEvidence:false,executionMode:'pure_http',browserUsed:false,credentialsUsed:false,
    sourceRequest:{...f.receipt.request,mime:'application/zip',anonymous:true,credentialsUsed:false},sampleOfferCount:1,fullOfferCount:10,csvDataRows:10,
    jsonReadbackMatched:true,csvReadbackMatched:true,fullJsonSha256:'a'.repeat(64),fullCsvSha256:'b'.repeat(64),
    actualRunner:{entrypoint:'scripts/commerce.mjs',exitStatus:0},implementation:f.receipt.implementation};
  const base={schema:'web-api-product-offer-v1',productId:'1',title:'Observed price range',price:null,
    priceRange:{min:{amount:'13.15',currency:'USD',kind:'retail_list'},max:{amount:'15.00',currency:'USD',kind:'retail_list'}},
    observedAt:'2026-10-05T00:00:00Z'};
  const saveOffer=async offer=>{
    await writeFile(path.join(f.root,'verification/sample.json'),JSON.stringify({schema:'web-api-product-price-snapshot-v1',executionMode:'pure_http',offers:[offer]}));
    await f.save(proof);
    return f.audit();
  };
  assert.equal(await saveOffer(base),'recorded_live');
  assert.equal(await saveOffer({...base,priceRange:{...base.priceRange,min:{...base.priceRange.min,amount:'16.00'}}}),'evidence_invalid');
  assert.equal(await saveOffer({...base,priceRange:{...base.priceRange,max:{...base.priceRange.max,currency:'CAD'}}}),'evidence_invalid');
  assert.equal(await saveOffer({...base,priceRange:{min:base.priceRange.min}}),'evidence_invalid');
});
