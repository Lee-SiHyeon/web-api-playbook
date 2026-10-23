import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAffiliateLink} from '../src/affiliate-link.mjs';

const product={productId:100,itemId:200,vendorItemId:300};
const credentials={COUPANG_COOKIE:'synthetic-cookie',COUPANG_X_TOKEN:'synthetic-token'};
const response={status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify({rCode:'0',data:{shortUrl:'https://coupa.ng/example'}})};

test('link request persists intent before one POST and reuses generated receipt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'automation-affiliate-link-'));let calls=0;
 try{
  const result=await createAffiliateLink(root,product,{env:credentials,uuid:()=> 'synthetic-temp',now:()=>new Date('2026-10-01T00:00:00Z'),fetchImpl:async(url,options)=>{
   calls++;const saved=JSON.parse(await readFile(join(root,'data/affiliate-links/100-200-300.json'),'utf8'));
   assert.equal(saved.status,'intent');assert.equal(options.method,'POST');assert.equal(url,'https://partners.coupang.com/api/v1/banner/iframe/url');
   assert.deepEqual(JSON.parse(options.body),{product});return response;
  }});
  assert.equal(result.status,'generated');assert.equal(result.destinationVerified,false);assert.equal(calls,1);
  const repeated=await createAffiliateLink(root,product,{env:credentials,fetchImpl:async()=>{calls++;throw Error('must not call');}});
  assert.equal(repeated.reused,true);assert.equal(repeated.shortUrl,'https://coupa.ng/example');assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('failed or interrupted link intent blocks automatic reissue',async()=>{
 const root=await mkdtemp(join(tmpdir(),'automation-link-reconcile-'));let calls=0;
 try{
  await assert.rejects(createAffiliateLink(root,product,{env:credentials,fetchImpl:async()=>{calls++;throw Error('synthetic timeout');}}),/Link request failed; reconcile saved intent/);
  const saved=JSON.parse(await readFile(join(root,'data/affiliate-links/100-200-300.json'),'utf8'));
  assert.equal(saved.status,'intent');
  await assert.rejects(createAffiliateLink(root,product,{env:credentials,fetchImpl:async()=>{calls++;return response;}}),/requires reconciliation/);
  assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
