import test from 'node:test';
import assert from 'node:assert/strict';
import {readFollowerPosts} from '../x-follower-posts.mjs';
import {timelineVariablesValid,timelineTogglesValid} from '../providers/x.mjs';
const user={id:'11',handle:'example'};
test('the real transport guard accepts the observed timeline envelope and rejects unrelated or duplicate inputs',()=>{
 const variables={userId:'11',count:20,includePromotedContent:true,withQuickPromoteEligibilityTweetFields:true,withVoice:false};
 assert.equal(timelineVariablesValid(variables),true);
 assert.equal(timelineVariablesValid({...variables,screen_name:'other'}),false);
 assert.equal(timelineVariablesValid({...variables,userId:'wrong'}),false);
 assert.equal(timelineVariablesValid({...variables,count:100}),false);
 assert.equal(timelineTogglesValid({withPayments:false,withArticlePlainText:false}),true);
 assert.equal(timelineTogglesValid({withPayments:false,withArticlePlainText:false,extra:true}),false);
 assert.equal(timelineTogglesValid({withPayments:true,withArticlePlainText:false}),false);
});
const payload={data:{user:{result:{timeline:{timeline:{instructions:[{entries:[{content:{itemContent:{tweet_results:{result:{
 __typename:'Tweet',rest_id:'1000000000',core:{user_results:{result:{rest_id:'11',core:{screen_name:'example'}}}},
 legacy:{full_text:'일과를 작은 기록으로 남겨요.',created_at:'Thu Oct 01 00:00:00 +0000 2026'}}}}}}]}]}}}}}};
function context(enabled=true){
 return {ownerHandle:'lifehack__ailab',apiTransitionEnabled:enabled,timelineWithVoice:false,
  timelineContract:{operation:'UserOriginalsTimeline',queryId:'observed-id',features:{observed:false},missing:[]},
  lookupUser:async()=>({userId:'11',protected:false,relation:{followsMe:true}})};
}
test('original timeline uses the observed source contract, authenticated route and exact follower identity',async()=>{
 for(const enabled of [true,false]){
  const c=context(enabled);c.request=async(method,route,url)=>{
   assert.equal(method,'GET');assert.match(route,/observed-id\/UserOriginalsTimeline$/);
   assert.equal(new URL(url).origin,enabled?'https://x.com':'https://api.x.com');
   assert.equal(JSON.parse(new URL(url).searchParams.get('variables')).userId,'11');
   assert.deepEqual(JSON.parse(new URL(url).searchParams.get('features')),{observed:false});
   return {status:200,headers:{'content-type':'application/json'},raw:JSON.stringify(payload)};
  };
  const result=await readFollowerPosts(user,{withContext:async fn=>fn(c)});
  assert.equal(result.items.length,1);assert.equal(result.items[0].publisherId,'11');assert.equal(result.writes,0);
 }
});
test('private or departed followers and missing source contracts never enter a timeline request',async()=>{
 let calls=0;
 const c=context();c.request=async()=>{calls++;};
 c.lookupUser=async()=>({userId:'11',protected:false,relation:{followsMe:false}});
 assert.equal((await readFollowerPosts(user,{withContext:async fn=>fn(c)})).skipped,'not_current_public_follower');
 c.timelineContract=null;
 await assert.rejects(readFollowerPosts(user,{withContext:async fn=>fn(c)}),{code:'X_TIMELINE_CURRENT_CONTRACT_UNAVAILABLE'});
 assert.equal(calls,0);
});
test('timeline throttling retains observed reset and stops without repeating the request',async()=>{
 let calls=0;const c=context();c.request=async()=>{calls++;return {status:429,headers:{'content-type':'application/json','x-rate-limit-reset':'1234'},raw:'{}'};};
 await assert.rejects(readFollowerPosts(user,{withContext:async fn=>fn(c)}),e=>e.code==='X_TIMELINE_READ_REJECTED'&&e.receipt.rateLimitReset===1234);
 assert.equal(calls,1);
});
