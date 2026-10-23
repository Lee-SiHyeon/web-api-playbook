import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchReviewSample} from '../src/review-client.mjs';

const review={reviewId:55,productId:1,itemId:2,vendorItemId:3,itemName:'Synthetic option',rating:1,vine:false,incentive:false,content:'Synthetic review body',title:'Synthetic title'};
const response={status:200,headers:new Headers({'content-type':'application/json'}),text:async()=>JSON.stringify({rCode:'RET0000',rData:{paging:{contents:[review]}}})};

test('review evidence call preserves selectors and does not emit raw review text',async()=>{
 let call;
 const result=await fetchReviewSample({productId:1,sample:'critical',page:1},{cookie:'synthetic-review-cookie',now:()=>new Date('2026-10-01T00:00:00Z'),fetchImpl:async(url,options)=>{call={url:new URL(url),options};return response;}});
 assert.equal(call.url.origin,'https://www.coupang.com');assert.equal(call.url.pathname,'/next-api/review');
 assert.deepEqual(Object.fromEntries(call.url.searchParams),{productId:'1',page:'1',size:'10',sortBy:'DATE_DESC',ratings:'1',ratingSummary:'true',market:''});
 assert.equal(call.options.headers.cookie,'synthetic-review-cookie');assert.equal(call.options.headers.referer,'https://www.coupang.com/vp/products/1');
 assert.equal(result.reviews[0].contentHash.length,64);assert.equal(Object.hasOwn(result.reviews[0],'text'),false);assert.equal(result.reviews[0].rating,1);
});

test('raw review text is returned only for explicit synthesis input and pagination stays bounded',async()=>{
 const result=await fetchReviewSample({productId:'1',sample:'best',page:2,mode:'synthesis-input'},{cookie:'c',fetchImpl:async()=>response});
 assert.equal(result.operation,'reviewsPage');assert.equal(result.reviews[0].text,review.content);assert.equal(result.reviews[0].title,review.title);
 let calls=0;
 await assert.rejects(fetchReviewSample({productId:'1',sample:'latest',page:2},{cookie:'c',fetchImpl:async()=>{calls++;return response;}}),/Unobserved pagination combination/);
 assert.equal(calls,0);
});
