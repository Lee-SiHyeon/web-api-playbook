import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {auditCapabilityChecklist} from '../lib/capability-checklist.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const live=JSON.parse(await readFile(new URL('../verification/coupang-recheck-2026-10-15/search.json',import.meta.url),'utf8'));

test('Coupang search audit selects the RSC session contract and rejects Document, preflight and unbound results',async t=>{
  const base=path.resolve(os.tmpdir()),root=await mkdtemp(path.join(base,'coupang-checklist-'));
  assert.ok(root.startsWith(base+path.sep));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const dir of ['lib','verification','checklists/services'])await mkdir(path.join(root,dir),{recursive:true});
  const code='export function search() {}\n';await writeFile(path.join(root,'lib/search.mjs'),code);
  const manifest=JSON.parse(await readFile(new URL('../checklists/services/coupang-retail.json',import.meta.url),'utf8'));
  const cap=manifest.capabilities[0];
  assert.equal(cap.implementation.cli[0].path,'scripts/coupang-retail-session.mjs');
  cap.implementation={files:[{path:'lib/search.mjs',exports:['search']}],tests:[]};
  cap.evidence[0].files=['verification/proof.json','verification/run.json'];cap.evidence[0].hashPaths=['lib/search.mjs'];
  await writeFile(path.join(root,'checklists/services/coupang-retail.json'),JSON.stringify(manifest));
  const audit=async run=>{
    const proof={schema:'web-api-coupang-retail-session-read-v1',service:'coupang-retail',capabilityId:'catalog.search',
      checkedAt:run.checkedAt,secretsPersistedInEvidence:false,opaqueContextRenewalVerified:false,
      actualRunner:'scripts/coupang-retail-session.mjs',productCount:run.data?.products?.length??0,
      executionSha256:sha(JSON.stringify(run)),implementation:{'lib/search.mjs':sha(code)}};
    await writeFile(path.join(root,'verification/run.json'),JSON.stringify(run));
    await writeFile(path.join(root,'verification/proof.json'),JSON.stringify(proof));
    return (await auditCapabilityChecklist({root,service:'coupang-retail'})).capabilities[0].status;
  };
  assert.equal(await audit(live),'recorded_live');
  for(const mutate of [r=>{r.ok=false;r.receipt.status=403;r.receipt.contentType='text/html';},
    r=>{r.ok=false;r.code='COUPANG_RETAIL_CONTEXT_REBOOTSTRAP_REQUIRED';r.receipt.requestCount=0;},
    r=>r.receipt.exactCookieHeaderSent=false,r=>r.states.credential_propagated=false,
    r=>r.storage.persistent=false,r=>r.storage.provider='memory',
    r=>r.receipt.headers={Cookie:'SYNTHETIC_COOKIE_VALUE'},
    r=>r.browserUsed=true,r=>r.ownerAuthenticationVerified=true,r=>r.renewal.opaqueContextRenewed=true,
    r=>{r.data.products=[];r.projectionSha256=sha(JSON.stringify(r.data));}]){
    const run=structuredClone(live);mutate(run);assert.equal(await audit(run),'evidence_invalid');
  }
});
