import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {newCoupangFrontier,enqueueCoupang,applyCoupangResult,resourceUrl,coupangCoverage,normalizeCoupangFrontier,seedCoupangFrontier} from '../lib/retail/coupang-frontier.mjs';
import {projectCoupangTravel} from '../lib/retail/coupang-ontology.mjs';
test('default category aliases collapse while pages, filters and stay dates remain distinct',()=>{
 assert.equal(resourceUrl('https://trip.coupang.com/tp/categories/396471?channel=user&page=1&travelSearchType=DEFAULT&filters=sorting%3DCOUPANG_RATING%2CreviewRating%3D0'), 'https://trip.coupang.com/tp/categories/396471');
 assert.notEqual(resourceUrl('https://trip.coupang.com/tp/categories/396471?page=2'),resourceUrl('https://trip.coupang.com/tp/categories/396471'));
 assert.notEqual(resourceUrl('https://trip.coupang.com/tp/products/123?checkIn=2026-10-15'),resourceUrl('https://trip.coupang.com/tp/products/123?checkIn=2026-10-16'));
 assert.equal(resourceUrl('https://trip.coupang.com/tp/products/123?q=keyword'),resourceUrl('https://trip.coupang.com/tp/products/123'));
});

test('search continuation retains its observed JSON template and unsupported read routes remain pending',()=>{
 const f=newCoupangFrontier(),n=enqueueCoupang(f,'https://trip.coupang.com/tp/search?q=jeju&page=2');
 n.adapter='travel_search';n.templateRef='observed-search.json';
 applyCoupangResult(f,n,{ok:true,checkedAt:'2026-10-15T00:00:00Z',data:{kind:'travel_listing',products:[],pagination:{page:2,hasNext:true}}});
 const next=f.nodes.find(x=>x.id===n.continuation);assert.equal(next.templateRef,'observed-search.json');assert.equal(next.adapter,'travel_search');
 seedCoupangFrontier(f,{pages:[{url:'https://www.coupang.com/',links:[{href:'https://www.coupang.com/np/siteWideEvent?mlpPageId=5259',label:'promotion'}]}]},null);
 assert.equal(f.unresolvedRoutes.length,1);assert.equal(f.unresolvedRoutes[0].state,'pending_contract');
 assert.equal(new URL(f.unresolvedRoutes[0].url).searchParams.get('mlpPageId'),'5259');
});

test('rental listing descendants retain the selected vendor and rental interval',()=>{
 const f=newCoupangFrontier(),n=enqueueCoupang(f,'https://trip.coupang.com/tp/search?q=car&pickUpDate=2026-10-22&dropOffDate=2026-10-23&pickUpTime=08%3A00&dropOffTime=08%3A00&displayCategoryCode=32618');
 applyCoupangResult(f,n,{ok:true,checkedAt:'2026-10-15T00:00:00Z',data:{kind:'travel_listing',products:[{productType:'RENTAL_CAR',vendorItemId:'70000018401098',productUrl:'https://trip.coupang.com/tp/products/30000000754611',title:'rental'}]}});
 const detail=f.nodes.find(x=>x.stage==='product_detail'),u=new URL(detail.url);assert.equal(u.searchParams.get('pickUpDate'),'2026-10-22');
 assert.equal(u.searchParams.get('vendorItemId'),'70000018401098');assert.equal(detail.productType,'RENTAL_CAR');
});
test('HTTP list traversal enqueues details and next page without marking complete',()=>{
 const f=newCoupangFrontier(),n=enqueueCoupang(f,'https://trip.coupang.com/tp/categories/396471');
 applyCoupangResult(f,n,{ok:true,checkedAt:'2026-10-15T00:00:00Z',data:{kind:'travel_listing',products:[{title:'ticket',productUrl:'https://trip.coupang.com/tp/products/123'}],pagination:{page:1,hasNext:true,totalPages:3}}});
 assert.equal(f.nodes.length,3);assert.equal(coupangCoverage(f).pending,2);assert.equal(coupangCoverage(f).complete,false);
 normalizeCoupangFrontier(f);assert.equal(f.edges.length,2);
 applyCoupangResult(f,f.nodes.find(n=>n.stage==='product_detail'),{ok:true,checkedAt:'2026-10-15T00:00:00Z',data:{kind:'travel_detail',productId:'9',packageProductId:'123',completeOptions:false}});
 assert.equal(f.operations.filter(o=>o.state==='pending').length,2);
});
test('ontology projection rejects unverified or changed evidence and keeps price conditions',()=>{
 const data={kind:'travel_listing',context:{checkIn:'2026-10-15'},products:[{productId:'1',packageProductId:'2',title:'hotel',productType:'ACCOMMODATION',productUrl:'https://trip.coupang.com/tp/products/2',price:{salePrice:100,currency:'KRW',accountApplied:false,membershipCondition:'member_only'}}]};
 const run={schema:'web-api-coupang-public-result-v1',ok:true,executionMode:'pure_http',browserUsed:false,credentialsUsed:false,writesSubmitted:0,request:{origin:'https://trip.coupang.com',httpStatus:200,cookieSent:false},data,projectionSha256:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
 const out=projectCoupangTravel(run);assert.equal(out.databaseWrites,0);assert.equal(out.priceObservations[0].membershipCondition,'member_only');assert.equal(out.priceObservations[0].checkoutTotalVerified,false);
 run.data.products[0].price.salePrice=200;assert.throws(()=>projectCoupangTravel(run),{code:'COUPANG_ONTOLOGY_INPUT_INVALID'});
});
