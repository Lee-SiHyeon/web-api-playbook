import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectOffer,searchOffers,collectPrices} from '../src/price-maintenance.mjs';

const offer={productId:1,itemId:2,vendorItemId:3,query:'stand',baseline:{displayedAmount:5900,checkedAt:'2026-09-06',evidenceRef:'synthetic-baseline'}};

test('price checks bind exact options and do not infer stock or delivery price',()=>{
 assert.equal(inspectOffer(offer,[{productId:1,itemId:2,vendorItemId:4,salesPrice:100}]).status,'not_observed');
 const changed=inspectOffer(offer,[{...offer,salesPrice:6900,isSoldOut:false}]);
 assert.equal(changed.delta,1000);assert.equal(changed.status,'displayed_price_changed');assert.equal(changed.deliveredAmount,null);
 assert.equal(inspectOffer(offer,[{...offer,salesPrice:5900,isSoldOut:true}]).status,'reported_sold_out');
 assert.equal(inspectOffer(offer,[{...offer,salesPrice:5900},{...offer,salesPrice:6100}]).status,'conflicting_observations');
});

test('price search preserves the first-page Partners contract',async()=>{
 let call;
 const result=await searchOffers('stand',{COUPANG_COOKIE:'c',COUPANG_X_TOKEN:'t'},{fetchImpl:async(url,options)=>{
  call={url,options};return {status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify({rCode:'0',data:{products:[{productId:1}],total:1}})};
 }});
 assert.equal(call.url,'https://partners.coupang.com/api/v1/search');assert.equal(call.options.method,'POST');
 assert.deepEqual(JSON.parse(call.options.body),{filter:'stand',page:{pageNumber:0,size:36},deliveryTypes:[]});
 assert.equal(call.options.headers.referer,'https://partners.coupang.com/');assert.equal(result.products.length,1);assert.equal(result.total,1);
});

test('same query is cached and transport failure stops remaining offers without saving raw error text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automation-price-check-'));let calls=0;
 try{
  const result=await collectPrices({offers:[offer,{...offer,productId:4}]},dir,{uuid:()=> 'synthetic',search:async()=>{calls++;return {products:[{...offer,salesPrice:6900}],total:1,httpStatus:200,responseHash:'synthetic-hash'};}});
  assert.equal(calls,1);assert.equal(result.results.length,2);assert.equal(result.reviewRequired,true);
  const blocked=await collectPrices({offers:[offer,{...offer,productId:4}]},dir,{uuid:()=> 'blocked',search:async()=>{throw Object.assign(Error('synthetic private response body'),{code:'http_failure',httpStatus:403});}});
  assert.equal(blocked.status,'blocked');assert.equal(blocked.remainingOffers.length,2);
  const raw=await readFile(blocked.file,'utf8');assert.equal(raw.includes('synthetic private response body'),false);assert.equal(JSON.parse(raw).failure.httpStatus,403);
 }finally{await rm(dir,{recursive:true,force:true});}
});
