import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateAffiliateLinkGate, verifyAffiliateRedirect } from '../scripts/gates/affiliate-link-gate.mjs';
import { publicationFixture, NOW } from './support/publication-fixture.mjs';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'affiliate-gate-'));
  t.after(()=>rm(dir,{recursive:true,force:true})); return publicationFixture(dir);
}
const location = 'https://www.coupang.com/vp/products/1000?itemId=2000&vendorItemId=3000&lptag=AF1234567';
for (const [name,mutate] of [
  ['missing link',j=>delete j.affiliate],
  ['metadata-only link',j=>{j.bodyBlocks=j.bodyBlocks.filter(b=>b.type!=='link');j.publicationBundle.document.blocks=j.bodyBlocks;}],
  ['link below body',j=>{const b=j.publicationBundle.document.blocks;b.push(b.splice(1,1)[0]);}],
  ['missing verification',j=>delete j.affiliate.verification],
  ['extra unverified affiliate link',j=>j.publicationBundle.document.blocks.push({type:'link',label:'extra',url:'https://link.coupang.com/a/unverified'} )],
  ['stale verification',j=>j.affiliate.verification.checkedAt='2026-09-20T08:00:00Z'],
  ['wrong offer',j=>j.commercialSnapshot.itemId='9999'],
  ['different verified URL',j=>j.affiliate.verification.url='https://link.coupang.com/a/other'],
]) test(`${name} fails before redirect fetch`,async t=>{
  const job=await fixture(t);mutate(job);let calls=0;
  const r=await verifyAffiliateRedirect(job,{now:NOW,accounts:{fixtureblog:'AF1234567'},fetchImpl:async()=>{calls++;}});
  assert.equal(r.passed,false);assert.equal(calls,0);
});
for (const [name,url,status] of [
  ['old attribution',location.replace('AF1234567','CFM99540746'),302],
  ['wrong product',location.replace('/1000?','/9999?'),302],
  ['wrong option',location.replace('itemId=2000','itemId=9999'),302],
  ['wrong vendor option',location.replace('vendorItemId=3000','vendorItemId=9999'),302],
  ['duplicate tracking key',location+'&lptag=AF999',302],
  ['foreign redirect',location.replace('www.coupang.com','evil.example'),302],
  ['plain success page',location,200],
]) test(`${name} cannot pass live attribution`,async t=>{
  const job=await fixture(t);let calls=0;
  const r=await verifyAffiliateRedirect(job,{now:NOW,accounts:{fixtureblog:'AF1234567'},fetchImpl:async(_,init)=>{
    calls++; assert.equal(init.redirect,'manual');assert.equal(init.credentials,'omit');assert.equal(new Headers(init.headers).has('cookie'),false);
    return new Response(null,{status,headers:{location:url}});
  }});assert.equal(r.passed,false);assert.equal(calls,1);
});
test('verified account and exact offer pass without following redirect',async t=>{
  const job=await fixture(t);assert.equal(evaluateAffiliateLinkGate(job,{now:NOW}).passed,true);
  assert.equal((await verifyAffiliateRedirect(job,{now:NOW,accounts:{fixtureblog:'AF1234567'},fetchImpl:async()=>new Response(null,{status:302,headers:{location}})})).passed,true);
});
test('article cannot replace the publisher account policy',async t=>{
  const job=await fixture(t);job.affiliate.accountId=job.affiliate.verification.accountId='AF999';let calls=0;
  assert.equal((await verifyAffiliateRedirect(job,{now:NOW,accounts:{fixtureblog:'AF1234567'},fetchImpl:async()=>{calls++;}})).code,'AFFILIATE_ACCOUNT_UNVERIFIED');assert.equal(calls,0);
});
test('network verification failure blocks instead of accepting cached pass',async t=>{
  const job=await fixture(t);
  assert.equal((await verifyAffiliateRedirect(job,{now:NOW,accounts:{fixtureblog:'AF1234567'},fetchImpl:async()=>{throw Error('offline');}})).passed,false);
});
