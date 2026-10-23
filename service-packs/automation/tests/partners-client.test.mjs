import test from 'node:test';
import assert from 'node:assert/strict';
import {requestPartnerOperation} from '../src/partners-client.mjs';

const response=(body,status=200,type='application/json')=>({status,headers:new Headers({'content-type':type}),text:async()=>JSON.stringify(body)});

test('Partners search preserves request contract and metadata-only default',async()=>{
 let call;
 const result=await requestPartnerOperation({operation:'search',payload:{filter:'desk',page:{pageNumber:0,size:36},deliveryTypes:[]}}, {cookie:'synthetic-cookie',xToken:'synthetic-token',now:()=>new Date('2026-10-01T00:00:00Z'),fetchImpl:async(url,options)=>{call={url,options};return response({rCode:'0',data:{products:[{productId:1}],total:1}});}});
 assert.equal(call.url,'https://partners.coupang.com/api/v1/search');assert.equal(call.options.method,'POST');
 assert.equal(call.options.headers.cookie,'synthetic-cookie');assert.equal(call.options.headers['x-token'],'synthetic-token');assert.equal(call.options.headers.referer,'https://partners.coupang.com/');
 assert.deepEqual(JSON.parse(call.options.body),{filter:'desk',page:{pageNumber:0,size:36},deliveryTypes:[]});assert.equal(call.options.redirect,'manual');
 assert.equal(result.productCount,1);assert.equal(result.checkedAt,'2026-10-01T00:00:00.000Z');assert.equal(Object.hasOwn(result,'data'),false);
});

test('dashboard and product-link contracts retain operation-specific checks',async()=>{
 let method;
 const dashboard=await requestPartnerOperation({operation:'dashboard'}, {cookie:'c',xToken:'t',fetchImpl:async(_url,options)=>{method=options.method;return response({rCode:'0',data:{dailyTrend:{},monthlyAggregation:{}}});}});
 assert.equal(method,'GET');assert.equal(dashboard.verified,true);
 const link=await requestPartnerOperation({operation:'productLink',payload:{product:{productId:1,itemId:2,vendorItemId:3}},evidenceOnly:false}, {cookie:'c',xToken:'t',fetchImpl:async(_url,options)=>{method=options.method;return response({rCode:'0',data:{shortUrl:'https://link.coupang.com/a/example'}});}});
 assert.equal(method,'POST');assert.equal(link.data.shortUrl,'https://link.coupang.com/a/example');
 await assert.rejects(requestPartnerOperation({operation:'productLink',payload:{product:{}}},{cookie:'c',xToken:'t',fetchImpl:async()=>response({rCode:'0',data:{shortUrl:'https://example.com/'}})}),/Unexpected affiliate link/);
});

test('invalid requests and unsuccessful application responses fail without data leakage',async()=>{
 let calls=0;
 await assert.rejects(requestPartnerOperation({operation:'search',payload:{filter:'x',page:{pageNumber:0,size:37},deliveryTypes:[]}},{cookie:'c',xToken:'t',fetchImpl:async()=>{calls++;}}),/Invalid captured search payload/);
 await assert.rejects(requestPartnerOperation({operation:'dashboard'},{cookie:'c',xToken:'t',fetchImpl:async()=>{calls++;return response({rCode:'401',message:'synthetic private body'});}}),/Service rejected operation/);
 assert.equal(calls,1);
});
