import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeXSearch, searchXPosts } from '../x-search.mjs';
import { readRetryAt, recoveryDecision } from '../x-recovery.mjs';

test('incident empty web SearchTimeline 404 keeps the live worker and its held reservations',async()=>{
 const now=Date.parse('2026-10-04T14:21:22.807Z');
 let calls=0,observed;
 await assert.rejects(searchXPosts('diagnostic',{withContext:async work=>work({apiTransitionEnabled:true,request:async(method,route)=>{
  calls++;assert.equal(method,'GET');assert.match(route,/^\/i\/api\/graphql\/[^/]+\/SearchTimeline$/);
  return {status:404,headers:{'x-rate-limit-remaining':'41','x-rate-limit-reset':'1791124417'},raw:''};
 }})}),error=>{observed=error;return error.code==='X_SEARCH_REJECTED';});
 assert.equal(calls,1);
 assert.equal(readRetryAt(observed,{now,failures:4}),Date.parse('2026-10-04T14:51:22.807Z'));
 const state={records:{account:{handle:'example',status:'held',replyAttemptedAt:'2026-10-02T00:00:00Z'}}};
 const before=structuredClone(state);
 assert.deepEqual(recoveryDecision({status:{status:'waiting_for_search_read',workPhase:'read',code:observed.code,receipt:observed.receipt},state,alive:true,now}),{action:'observe'});
 assert.deepEqual(state,before);
});

test('observed empty SearchTimeline 404 preserves quota and backs off without an immediate resend',async()=>{
 let calls=0,observed;
 await assert.rejects(searchXPosts('diagnostic',{withContext:async work=>work({request:async()=>{
  calls++;return {status:404,headers:{'x-rate-limit-remaining':'46','x-rate-limit-reset':'1790909556'},raw:''};
 }})}),error=>{observed=error;return error.code==='X_SEARCH_REJECTED';});
 assert.equal(calls,1);
 assert.equal(observed.receipt.operation,'SearchTimeline');
 assert.equal(observed.receipt.mime,'');
 assert.equal(observed.receipt.bodyBytes,0);
 assert.equal(observed.receipt.rateLimitRemaining,46);
 const now=Date.parse('2026-10-02T02:38:37.614Z');
 assert.equal(readRetryAt(observed,{now,failures:3}),Date.parse('2026-10-02T02:58:37.614Z'));
 assert.equal(readRetryAt(observed,{now,phase:'write'}),null);
 assert.equal(readRetryAt({...observed,receipt:{...observed.receipt,writeSent:true}},{now}),null);
});

test('the observed transient search service error waits locally without a parser rewrite or another request',async()=>{
 let calls=0,observed;
 await assert.rejects(searchXPosts('diagnostic',{withContext:async work=>work({request:async()=>{
  calls++;return {status:200,headers:{'content-type':'application/json','x-rate-limit-remaining':'34','x-rate-limit-reset':'9999999999'},
   raw:JSON.stringify({data:{search_by_raw_query:{search_timeline:{}}},errors:[{message:'Something went wrong. Try again',path:['search_by_raw_query','search_timeline','timeline']}]})};
 }})}),error=>{observed=error;return error.code==='X_SEARCH_SERVICE_UNAVAILABLE'&&error.receipt.writeSent===false;});
 assert.equal(calls,1);
 assert.equal(readRetryAt(observed,{now:1000}),31000);
 assert.equal(readRetryAt(observed,{now:1000,phase:'write'}),null);
 assert.equal(readRetryAt({...observed,receipt:{...observed.receipt,writeSent:true}},{now:1000}),null);
 assert.equal(readRetryAt({...observed,receipt:{...observed.receipt,rateLimitRemaining:0,rateLimitReset:90}},{now:1000}),90000);
});

test('HTTP 200 without search instructions or numeric errors stays held without retry',async()=>{
 let calls=0;
 await assert.rejects(searchXPosts('diagnostic',{withContext:async work=>work({request:async()=>{
  calls++;return {status:200,headers:{'content-type':'application/json'},raw:JSON.stringify({data:{search_by_raw_query:null},errors:[]})};
 }})}),error=>error.code==='X_SEARCH_SCHEMA'&&error.receipt.httpStatus===200&&error.receipt.operation==='SearchTimeline'&&error.receipt.errorCodes.length===0);
 assert.equal(calls,1);
});
test('schema failures retain the safe search receipt and server codes without leaking the response',async()=>{
 let calls=0;
 for(const body of [{data:{}},{errors:[{code:32,message:'private authentication detail'}]},
  {errors:[{message:'Authentication failed. Try again',path:['search_by_raw_query','search_timeline','timeline']}]},null]) {
  await assert.rejects(searchXPosts('diagnostic',{withContext:async work=>work({request:async()=>{
   calls++;return {status:200,headers:{'content-type':'application/json','x-rate-limit-remaining':'7'},raw:JSON.stringify(body)};
  }})}),e=>e.code==='X_SEARCH_SCHEMA'&&e.receipt.operation==='SearchTimeline'&&e.receipt.httpStatus===200&&e.receipt.page===1&&e.receipt.rateLimitRemaining===7&&(!Number.isInteger(body?.errors?.[0]?.code)||e.receipt.errorCodes[0]===32)&&!JSON.stringify(e.receipt).includes('private authentication detail'));
 }
 assert.equal(calls,4);
});
const post=(id,blue=true,authorId='123')=>({content:{itemContent:{tweet_results:{result:{__typename:'Tweet',rest_id:id,core:{user_results:{result:{rest_id:authorId,core:{screen_name:'example'},is_blue_verified:blue,privacy:{protected:false}}}},legacy:{full_text:'교류할 분들 환영합니다',created_at:'Wed Sep 30 11:49:26 +0000 2026'}}}}}});
const payload=entries=>({data:{search_by_raw_query:{search_timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries}]}}}}});
test('search preserves stable author identity and actual blue verification; ads and invalid identities are excluded',()=>{
 const ad=post('3');ad.content.promotedMetadata={};
 const r=decodeXSearch(payload([post('1'),post('2',false),post('4',true,'bad'),ad]));
 assert.equal(r.items.length,2);assert.equal(r.items[0].authorId,'123');assert.equal(r.items[1].blueVerified,false);
 assert.throws(()=>decodeXSearch({data:{}}),{code:'X_SEARCH_SCHEMA'});
});
test('pagination sends the observed cursor, deduplicates posts and filters blue accounts after decoding',async()=>{
 let calls=0;
 const result=await searchXPosts('맞팔',{maxPages:2,blueOnly:true,withContext:async work=>work({ownerHandle:'owner',request:async(method,route,url)=>{
   assert.equal(method,'GET');assert.match(route,/SearchTimeline$/);
   const variables=JSON.parse(new URL(url).searchParams.get('variables'));
   const entries=++calls===1?[post('1'),post('2',false),{content:{cursorType:'Bottom',value:'cursor-one'}}]:[post('1'),post('3')];
   if(calls===2)assert.equal(variables.cursor,'cursor-one');
   return {status:200,headers:{'content-type':'application/json'},raw:JSON.stringify(payload(entries))};
 }})});
 assert.equal(calls,2);assert.equal(result.observedCount,3);assert.deepEqual(result.items.map(p=>p.id),['1','3']);assert.equal(result.fullSearch,false);
});
test('429 is reported without retrying the same request',async()=>{
 let calls=0;
 await assert.rejects(searchXPosts('맞팔',{withContext:async work=>work({request:async()=>{calls++;return {status:429,headers:{'content-type':'application/json','x-rate-limit-reset':'1234'},raw:'{}'};}})}),e=>e.code==='X_SEARCH_REJECTED'&&e.receipt.rateLimitReset===1234);
 assert.equal(calls,1);
});
test('current authenticated API transition uses the web GraphQL route without changing query or cursor',async()=>{
 for(const enabled of [true,false])await searchXPosts('맞팔',{withContext:async work=>work({apiTransitionEnabled:enabled,request:async(method,route,url)=>{
   assert.equal(new URL(url).origin,enabled?'https://x.com':'https://api.x.com');
   assert.match(route,enabled?/^\/i\/api\/graphql\//:/^\/graphql\//);
   assert.equal(JSON.parse(new URL(url).searchParams.get('variables')).rawQuery,'맞팔');
   return {status:200,headers:{'content-type':'application/json'},raw:JSON.stringify(payload([post('1')]))};
 }})});
});
test('failed search retains safe server code and page diagnostics without response bodies',async()=>{
 await assert.rejects(searchXPosts('맞팔',{withContext:async work=>work({request:async()=>({status:404,headers:{'content-type':'application/json'},raw:JSON.stringify({errors:[{code:34,message:'private runtime data must not be logged'}]})})})}),e=>e.receipt.page===1&&e.receipt.errorCodes[0]===34&&!JSON.stringify(e.receipt).includes('private runtime'));
});
test('source-current query ID replaces the saved discovery ID and missing source contract fails closed',async()=>{
 let calls=0;
 await searchXPosts('맞팔',{withContext:async work=>work({searchContract:{queryId:'source-current-id',features:{flag:false},missing:[]},request:async(method,route)=>{calls++;assert.match(route,/source-current-id\/SearchTimeline$/);return{status:200,headers:{'content-type':'application/json'},raw:JSON.stringify(payload([]))};}})});
 assert.equal(calls,1);
 await assert.rejects(searchXPosts('맞팔',{withContext:async work=>work({searchContract:null,request:async()=>{calls++;}})}),{code:'X_SEARCH_CURRENT_CONTRACT_UNAVAILABLE'});
 assert.equal(calls,1);
});
