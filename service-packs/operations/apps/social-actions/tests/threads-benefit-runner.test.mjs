import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runThreadsBenefitTarget, prepareThreadsBenefitTarget, prepareThreadsBenefitBatch, discoverThreadsBenefits,
  refreshThreadsBenefitEvidence, canReuseThreadsDraftDiscovery, KNOWN_FOLLOWBACK_RECHECK_MS } from '../threads-benefit-runner.mjs';
import { THREADS_BENEFIT_POLICY as P, threadsBasicReactionsVerified } from '../threads-benefits.mjs';
import { readMetaRelationship } from '../providers/meta.mjs';
const promo='3997530329766474170', oldPromo=P.legacyPromotionIds[0];
const pin='3983580490905486164', extra='3983580490905486165';
function fixture() {
  const state={records:{}}, calls=[], saved=[], replyInputs=[];
  let now=Date.parse('2026-09-30T10:00:00Z');
  const promotion={id:promo,author:P.owner,url:'https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6',text:'댓글 달아주시면 스하리 후 완료 답글 달아드릴게요',isReply:false,isPinnedToProfile:true};
  const promotionConfig={owner:P.owner,activePromotionId:promo,url:promotion.url,readbackVerified:true,pinReadbackVerified:true,
    previousPromotionPinRemovedVerified:true,previousPromotionIds:[oldPromo]};
  const actor={id:'17824859400',username:'one',followsOwner:true,following:false,outgoingRequest:false,private:false};
  const post={id:pin,author:'one',text:'주말에는 책을 읽어요',isReply:false,isPinnedToProfile:true,publishedAt:'2026-09-30T09:00:00Z'};
  const engagement={postId:promo,activities:{like:[],repost:[]}};
  const rootComments={postId:promo,postAuthor:P.owner,comments:[{id:'3983580490905486166',author:'one',authorId:'17824859400',text:'신청',isReply:true,directParentPostId:promo}],page:{fullList:false}};
  const oldEngagement={postId:oldPromo,activities:{like:[],repost:[]}};
  const oldComments={postId:oldPromo,postAuthor:P.owner,comments:[],totalDirectReplyCount:0,page:{fullList:false}};
  const context={service:'threads',bundle:{owner:P.owner},documentReceipt:{ownerVerified:true},document:{profiles:[{pk:'17824859400',username:'one',friendship_status:{followed_by:true},text_post_app_is_private:false}]}};
  const options={state,root:process.env.TEMP,promotionConfig,lock:async task=>task(),saveState:async value=>saved.push(structuredClone(value)),now:()=>now,sleep:async()=>true,isStopRequested:async()=>false,
    followersReader:async()=>({followers:[actor],page:{fullList:false}}),engagementReader:async id=>id===promo?engagement:oldEngagement,
    commentsReader:async id=>id===promo?rootComments:id===oldPromo?oldComments:{postId:id,postAuthor:'one',comments:[],totalDirectReplyCount:0,page:{fullList:true}},
    contextLoader:async()=>context,relationshipReader:async()=>({id:'17824859400',state:{following:false,outgoingRequest:false}}),
    profileReader:async()=>({handle:'one',posts:[post,{...post,id:extra,isPinnedToProfile:false}],fullTimeline:false}),
    postReader:async()=>promotion,
    generate:async()=>{calls.push('ai');return {comments:[{accountId:'17824859400',postId:pin,postAuthor:'one',comment:'주말 독서 시간이 좋죠.'}],model:'gpt-6-luna',effort:'low'};},
    follow:async input=>{calls.push('follow');return {target:input.target,normalizedTarget:'17824859400',readbackVerified:true,
      currentState:{following:true,outgoingRequest:false},mutationCount:1};},
    reaction:async input=>{calls.push(`${input.operation}:${input.postId}`);return {...input,target:input.expectedAuthor,readbackVerified:true,currentState:{liked:true,reposted:true},writes:1};},
    reply:async input=>{replyInputs.push(input);calls.push(`reply:${input.postId}`);return {postId:input.postId,parentAuthor:input.expectedAuthor,readbackVerified:true,createdPostId:'3983580490905486170',writes:1};},
  };
  return {state,calls,saved,replyInputs,options,context,engagement,rootComments,oldComments,oldEngagement,promotionConfig,advance:()=>{now+=21000;}};
}
function twoActorBatchFixture(firstTargetError = 'THREADS_SOCIAL_COMMENT_ROW_SCHEMA') {
  const f=fixture(),secondId='17824859401',secondPostId='3983580490905486185';
  f.options.followersReader=async()=>({followers:[
    {id:'17824859400',username:'one',followsOwner:true,following:false,outgoingRequest:false,private:false},
    {id:secondId,username:'two',followsOwner:true,following:false,outgoingRequest:false,private:false},
  ],page:{fullList:false}});
  f.options.contextLoader=async(_service,handle)=>({
    ...f.context,
    document:{profiles:[{pk:handle==='two'?secondId:'17824859400',username:handle,
      friendship_status:{followed_by:true,following:false,outgoing_request:false},text_post_app_is_private:false}]},
  });
  f.options.relationshipReader=async context=>({id:String(context.document.profiles[0].pk),state:{following:false,outgoingRequest:false}});
  f.options.profileReader=async({handle})=>({handle,posts:[handle==='two'
    ? {id:secondPostId,author:'two',text:'저녁 산책이 좋아요',isReply:false,isPinnedToProfile:true,publishedAt:'2026-09-30T09:00:00Z'}
    : {id:pin,author:'one',text:'주말에는 책을 읽어요',isReply:false,isPinnedToProfile:true,publishedAt:'2026-09-30T09:00:00Z'}],fullTimeline:false});
  f.options.commentsReader=async(id,{expectedAuthor}={})=>{
    if(id===promo)return f.rootComments;
    if(id===oldPromo)return f.oldComments;
    if(expectedAuthor==='one'&&firstTargetError)throw Object.assign(new Error('target-local observed row/schema failure'),{
      code:firstTargetError,httpStatus:firstTargetError==='THREADS_SOCIAL_HTTP_429'?429:undefined});
    return {postId:id,postAuthor:expectedAuthor,comments:[],totalDirectReplyCount:0,page:{fullList:true}};
  };
  let generatedInputs=[];
  f.options.generate=async inputs=>{
    generatedInputs=inputs;
    return {comments:inputs.map(input=>({accountId:input.accountId,postId:input.post.id,postAuthor:input.post.author,
      comment:input.post.author==='two'?'저녁 산책 코스가 궁금하네요.':'주말 독서 시간이 좋죠.'})),model:'gpt-6-luna',effort:'low',provider:'authenticated_codex_cli'};
  };
  return {...f,secondId,generatedInputs:()=>generatedInputs};
}
test('preparation performs no drafting, reservation or writes',async()=>{
  const f=fixture(),r=await runThreadsBenefitTarget({handle:'one'},f.options);
  assert.equal(r.writes,0);assert.equal(r.user.stage,'base');assert.deepEqual(f.calls,[]);assert.equal(f.saved.length,0);
});

test('an unstable empty target-comment scan holds instead of treating a zero root count as proof of absence',async()=>{
  const f=fixture(),read=f.options.commentsReader;
  f.options.commentsReader=async(id,options)=>id===pin
    ? {postId:pin,postAuthor:'one',comments:[],totalDirectReplyCount:0,
      page:{fullList:false,countMatches:true,stableCount:false}}
    : read(id,options);
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'follow_verified_reward_held');
  assert.equal(result.code,'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE');
  assert.deepEqual(f.calls,['follow']);
  assert.equal(f.state.records['17824859400'].historyHold.code,'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE');
  assert.equal(f.saved.length>=2,true);
});

test('target-comment absence needs a complete scan while a positive owner reply remains decisive',async()=>{
  const cases=[
    {name:'partial zero count',comments:[],totalDirectReplyCount:0,page:{fullList:false},expected:null},
    {name:'complete empty scan',comments:[],totalDirectReplyCount:0,page:{fullList:true},expected:false},
    {name:'owner reply in partial scan',comments:[{author:P.owner,directParentPostId:pin}],
      totalDirectReplyCount:1,page:{fullList:false},expected:true},
  ];
  for(const scenario of cases) {
    const f=fixture(),read=f.options.commentsReader;
    f.options.commentsReader=async(id,options)=>id===pin
      ? {postId:pin,postAuthor:'one',comments:scenario.comments,totalDirectReplyCount:scenario.totalDirectReplyCount,page:scenario.page}
      : read(id,options);
    const prepared=await prepareThreadsBenefitTarget('one',f.state,f.options);
    assert.equal(prepared.priorOwnerReply,scenario.expected,scenario.name);
    assert.deepEqual(f.calls,[],scenario.name);
    assert.equal(f.saved.length,0,scenario.name);
  }
});

test('a failed completion notice does not downgrade already verified base benefits',async()=>{
  const f=fixture();
  f.options.reply=async input=>{
    f.calls.push(`reply:${input.postId}`);
    if(input.receiptKey) return {postId:input.postId,parentAuthor:input.expectedAuthor,status:'not_created_explicit_refusal',
      notCreated:true,writeOutcome:'not_created_explicit_refusal',writeSent:true,readbackVerified:false,writes:1,
      code:'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED'};
    return {postId:input.postId,parentAuthor:input.expectedAuthor,readbackVerified:true,
      createdPostId:'3983580490905486170',writes:1};
  };
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  const record=f.state.records['17824859400'];
  assert.equal(result.status,'needs_reconciliation');
  assert.equal(result.benefitStageVerified,true);
  assert.equal(result.noticeStatus,'not_created_explicit_refusal');
  assert.equal(record.baseStatus,'verified');
  assert.equal(record.notices.base.status,'not_created_explicit_refusal');
  assert.equal(record.results.follow.readbackVerified,true);
  assert.equal(record.results.like.readbackVerified,true);
  assert.equal(record.results.repost.readbackVerified,true);
  assert.equal(record.results.reply.readbackVerified,true);
  assert.equal(record.currentOperation,null);
});

test('a public account with verified no-pin coverage receives latest-original base actions and one contextual reply',async()=>{
  const f=fixture();
  const original=f.options.profileReader;
  f.options.profileReader=async args=>{
    const profile=await original(args);
    return {...profile,fullTimeline:true,pinState:'no_pin_in_full_timeline',
      posts:profile.posts.map(post=>({...post,isPinnedToProfile:false,
        publishedAt:post.id===pin?'2026-09-30T09:00:00Z':'2026-09-29T09:00:00Z'}))};
  };
  const originalReaction=f.options.reaction;
  f.options.reaction=async input=>{
    assert.equal(input.expectedActorId,'17824859400');
    return originalReaction(input);
  };
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'verified');
  assert.equal(result.baseVerified,true);
  assert.deepEqual(f.calls,['ai','follow',`like:${pin}`,`repost:${pin}`,`reply:${pin}`,'reply:3983580490905486166']);
  assert.equal(f.replyInputs.filter(input=>input.postId===pin).length,1);
});
test('base actions verify before contextual and exact-comment completion replies; late bonus never repeats base',async()=>{
  const f=fixture(),r=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(r.status,'verified');assert.equal(r.writes,5);
  assert.deepEqual(f.calls,['ai','follow',`like:${pin}`,`repost:${pin}`,`reply:${pin}`,'reply:3983580490905486166']);
  assert.ok(f.replyInputs[0].message.includes(f.promotionConfig.url));
  assert.ok(!f.replyInputs[0].message.includes('https://www.threads.com/share/BBK7k3y_8E/'));
  f.advance();f.engagement.activities.like.push({id:'17824859400'});f.engagement.activities.repost.push({id:'17824859400'});f.calls.length=0;
  const bonus=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(bonus.status,'verified');assert.equal(bonus.additionalCount,1);
  assert.deepEqual(f.calls,[`like:${extra}`,`repost:${extra}`,'reply:3983580490905486166']);
  assert.equal(f.state.records['17824859400'].bonusStatus,'verified');
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_RECONCILE_OR_WAIT'});
});
test('recurring promotion discovery bounds comment pages without claiming full historical coverage',async()=>{
  const f=fixture(),reads=[],original=f.options.commentsReader;
  f.options.commentsReader=async(id,options)=>{reads.push({id,maxPages:options?.maxPages});return original(id,options);};
  const discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.deepEqual(reads,[{id:promo,maxPages:1},{id:oldPromo,maxPages:1}]);
  assert.equal(discovery.comments.page.fullList,false);
  assert.equal(discovery.legacyComments[0].comments.page.fullList,false);
  assert.deepEqual(f.calls,[]);
});

test('uncertain reaction is persisted and blocks all later writes on the account',async()=>{
  const f=fixture();f.options.reaction=async input=>{f.calls.push(input.operation);return {...input,readbackVerified:input.operation==='like',writes:1,currentState:{liked:true,reposted:false}};};
  const r=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(r.status,'needs_reconciliation');assert.equal(f.state.records['17824859400'].baseStatus,'needs_reconciliation');
  assert.deepEqual(f.calls,['ai','follow','like','repost']);
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_RECONCILE_OR_WAIT'});
  assert.equal(f.calls.length,4);
});
test('private pending request grants no reactions, comment or completion claim',async()=>{
  const f=fixture();f.context.document.profiles[0].text_post_app_is_private=true;
  f.options.follow=async()=>{f.calls.push('follow');return {target:'one',mutationCount:1,readbackVerified:true,currentState:{following:false,outgoingRequest:true}};};
  const r=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(r.status,'pending_follow_request');assert.deepEqual(f.calls,['follow']);
});
test('invalid AI identity blocks; a verified existing owner reply permits only the safe follow hold',async()=>{
  const f=fixture();f.options.generate=async()=>({comments:[{accountId:'999',postId:pin,postAuthor:'one',comment:'hello'}]});
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_AI_IDENTITY_INVALID'});
  assert.equal(f.saved.length,0);assert.deepEqual(f.calls,[]);
  f.options.commentsReader=async id=>id===promo?f.rootComments:id===oldPromo?f.oldComments:{postId:id,postAuthor:'one',comments:[{author:P.owner,directParentPostId:pin}],totalDirectReplyCount:1,page:{fullList:true}};
  const held=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(held.status,'follow_verified_reward_held');assert.equal(held.writes,1);
  assert.deepEqual(f.calls,['follow']);
});
test('a bounded batch routes drafts once and reuses only matching account/post/text cache before writes',async()=>{
  const f=fixture();let generated=0;
  f.options.generate=async inputs=>{generated++;return {model:'gpt-6-luna',effort:'low',provider:'authenticated_codex_cli',
    comments:inputs.map(i=>({accountId:i.accountId,postId:i.post.id,postAuthor:i.post.author,comment:'주말 독서 시간이 좋죠.'}))};};
  const batch=await prepareThreadsBenefitBatch({limit:3},f.options);
  assert.equal(batch.prepared,1);assert.equal(batch.writes,0);assert.equal(generated,1);assert.equal(f.calls.length,0);
  const r=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(r.status,'verified');assert.equal(generated,1);assert.equal(f.calls[0],'follow');
});
test('a selected draft group never reads or drafts an unselected actor even when that actor would fail',async()=>{
  const f=twoActorBatchFixture();
  const result=await prepareThreadsBenefitBatch({candidateIds:[f.secondId]},f.options);
  assert.equal(result.prepared,1);assert.deepEqual(result.skippedTargets,[]);
  assert.deepEqual(f.generatedInputs().map(row=>row.accountId),[f.secondId]);
  assert.equal(f.state.draftCache['17824859400'],undefined);
  for(const candidateIds of [[],['invalid'],[f.secondId,f.secondId]]) {
    await assert.rejects(()=>prepareThreadsBenefitBatch({candidateIds},f.options),{code:'THREADS_BENEFIT_BATCH_INVALID'});
  }
});
test('target progress is emitted at real read and action transitions and preserves STOP before dispatch',async()=>{
  const f=fixture(),phases=[];let stopped=false;
  f.options.isStopRequested=async()=>stopped;
  f.options.onWorkProgress=async progress=>{phases.push(progress);if(progress.phase==='action_dispatch')stopped=true;};
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.writes,0);
  assert.deepEqual(phases.map(row=>row.phase),['coordinator_lock','target_revalidation','target_revalidation_completed','actor_preflight','action_dispatch']);
  assert.deepEqual(f.calls,['ai']);
  assert.equal(f.state.records['17824859400'].currentOperation,undefined);
});

test('same-cycle discovery is reused only for drafts; target execution still discovers fresh exactly once',async()=>{
  const f=fixture(); let discoveries=0;
  const followersReader=f.options.followersReader;
  f.options.followersReader=async()=>{discoveries++;return followersReader();};
  const discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.equal(canReuseThreadsDraftDiscovery(discovery,f.promotionConfig,f.options.now()),true);
  await prepareThreadsBenefitBatch({}, {...f.options,discovery});
  assert.equal(discoveries,1,'drafting no longer repeats the full discovery');
  const result=await runThreadsBenefitTarget({handle:'one',execute:true,requireCachedDraft:true,
    expectedTarget:{id:'17824859400',stage:'base',excludeBaseTargetIds:[]}}, {...f.options,discovery:{...discovery,queue:[]}});
  assert.equal(result.status,'verified'); assert.equal(discoveries,2,'actions ignore supplied discovery and run one fresh scan');
});

test('expired or differently bound draft snapshots fall back to a fresh discovery',async()=>{
  const f=fixture();let discoveries=0;
  const followersReader=f.options.followersReader;
  f.options.followersReader=async()=>{discoveries++;return followersReader();};
  const discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.equal(canReuseThreadsDraftDiscovery(discovery,{...f.promotionConfig,previousPromotionIds:[]},f.options.now()),false);
  assert.equal(canReuseThreadsDraftDiscovery(discovery,f.promotionConfig,f.options.now()+60_001),false);
  await prepareThreadsBenefitBatch({}, {...f.options,discovery:{...discovery,checkedAt:new Date(f.options.now()-60_001).toISOString()}});
  assert.equal(discoveries,2);
});

test('locked target queue gate skips an actor or stage that no longer matches before AI or writes',async()=>{
  for(const expectedTarget of [
    {id:'999',stage:'base',excludeBaseTargetIds:[]},
    {id:'17824859400',stage:'bonus',excludeBaseTargetIds:[]},
  ]) {
    const f=fixture(),phases=[];
    f.options.onWorkProgress=async progress=>phases.push(progress.phase);
    const result=await runThreadsBenefitTarget({handle:'one',execute:true,expectedTarget},f.options);
    assert.equal(result.status,'skipped_current_queue');assert.equal(result.writes,0);
    assert.equal(phases.at(-1),'target_revalidation_completed');
    assert.deepEqual(f.calls,[]);assert.deepEqual(f.state.records,{});
  }
});

test('a newly eligible base actor preempts bonus inside the fresh locked runner; held bases do not starve it',async()=>{
  const f=fixture(),baseId='17824859401',actorId='17824859400';
  const followersReader=f.options.followersReader;
  f.options.followersReader=async()=>{const result=await followersReader();return {...result,followers:[...result.followers,
    {id:baseId,username:'two',followsOwner:true,following:false,outgoingRequest:false}]};};
  f.state.records[actorId]={handle:'one',baseStatus:'verified',bonusStatus:'not_started',activePromotionId:promo,
    pinnedPostId:pin,results:{}};
  f.engagement.activities.like.push({id:actorId});f.engagement.activities.repost.push({id:actorId});
  const phases=[];f.options.onWorkProgress=async progress=>phases.push(progress.phase);
  const held=await runThreadsBenefitTarget({handle:'one',execute:true,
    expectedTarget:{id:actorId,stage:'bonus',excludeBaseTargetIds:[]}},f.options);
  assert.equal(held.status,'base_priority_pending');assert.deepEqual(f.calls,[]);
  assert.equal(phases.at(-1),'target_revalidation_completed');
  const prepared=await runThreadsBenefitTarget({handle:'one',
    expectedTarget:{id:actorId,stage:'bonus',excludeBaseTargetIds:[baseId]}},f.options);
  assert.equal(prepared.user.stage,'bonus');assert.deepEqual(f.calls,[]);
});

test('draft profile reads obey the account interval and a STOP interrupts before the next actor',async()=>{
  const f=twoActorBatchFixture(null),sleeps=[];
  f.options.sleep=async ms=>{sleeps.push(ms);return false;};
  await assert.rejects(prepareThreadsBenefitBatch({},f.options),{code:'THREADS_BENEFIT_STOPPED'});
  assert.deepEqual(sleeps,[20_000]);assert.deepEqual(f.calls,[]);assert.equal(f.state.draftCache,undefined);
});

test('a consolidated queue-read timeout has a typed read phase and sends no social action',async()=>{
  const f=fixture();f.options.followersReader=async()=>{throw new DOMException('read timeout','TimeoutError');};
  await assert.rejects(runThreadsBenefitTarget({handle:'one',execute:true},f.options),error=>{
    assert.equal(error.code,'THREADS_BENEFIT_READ_TIMEOUT');assert.equal(error.phase,'target_revalidation');return true;
  });
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.state.records,{});
});

test('draft reads and AI release the coordinator; cache commit merges into the current state',async()=>{
  const f=fixture();let current={records:{}},depth=0,progress=0;
  delete f.options.state;
  f.options.readState=async()=>structuredClone(current);
  f.options.saveState=async value=>{current=structuredClone(value);};
  f.options.lock=async task=>{assert.equal(depth,0);depth++;try{return await task();}finally{depth--;}};
  const profileReader=f.options.profileReader,generate=f.options.generate;
  f.options.profileReader=async input=>{assert.equal(depth,0);return profileReader(input);};
  f.options.onReadProgress=async()=>{assert.equal(depth,0);progress++;};
  f.options.generate=async input=>{
    assert.equal(depth,0);
    current.records['999']={handle:'another_actor',baseStatus:'needs_reconciliation',currentOperation:'follow'};
    current.fastFollowbacks={ '999':{readbackVerified:true} };
    return generate(input);
  };
  const result=await prepareThreadsBenefitBatch({},f.options);
  assert.equal(result.prepared,1);assert.equal(progress,2);
  assert.equal(current.records['999'].baseStatus,'needs_reconciliation');
  assert.equal(current.fastFollowbacks['999'].readbackVerified,true);
  assert.equal(current.draftCache['17824859400'].draft.postId,pin);
});

test('a target completed during draft generation keeps its new record and receives no cache override',async()=>{
  const f=fixture();let current={records:{}};
  delete f.options.state;f.options.readState=async()=>structuredClone(current);
  f.options.saveState=async value=>{current=structuredClone(value);};
  const generate=f.options.generate;
  f.options.generate=async input=>{
    current.records['17824859400']={handle:'one',baseStatus:'verified',bonusStatus:'verified',activePromotionId:promo,
      results:{follow:{readbackVerified:true}}};
    return generate(input);
  };
  await prepareThreadsBenefitBatch({},f.options);
  assert.equal(current.records['17824859400'].bonusStatus,'verified');assert.equal(current.draftCache['17824859400'],undefined);
});

test('STOP arriving in target discovery or actor preflight prevents reservation and writes',async()=>{
  for(const phase of ['followersReader','profileReader']) {
    const f=fixture();let stopped=false;
    f.options.isStopRequested=async()=>stopped;
    const read=f.options[phase];f.options[phase]=async(...args)=>{const result=await read(...args);stopped=true;return result;};
    await assert.rejects(runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_STOPPED'});
    assert.deepEqual(f.calls,[]);assert.deepEqual(f.state.records,{});
  }
});

test('STOP after a verified follow preserves its receipt and prevents the next reaction',async()=>{
  const f=fixture();let stopped=false;
  f.options.isStopRequested=async()=>stopped;
  const follow=f.options.follow;f.options.follow=async input=>{const result=await follow(input);stopped=true;return result;};
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.code,'THREADS_BENEFIT_STOPPED');
  assert.deepEqual(f.calls,['ai','follow']);assert.equal(result.writes,1);assert.equal(result.writeCountUnknown,false);
  assert.equal(f.state.records['17824859400'].results.follow.readbackVerified,true);
});
test('a verified outreach follow is tracked for a later incoming follow beyond the first follower page',async()=>{
  const f=fixture(),actorId='17824859400';
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.rootComments.comments=[];
  f.state.outreachFollows={[actorId]:{actorId,handle:'one',source:'outreach_invitation',readbackVerified:true,
    result:{normalizedTarget:actorId,target:'one',success:true,readbackVerified:true,currentState:{following:true,outgoingRequest:false}}}};
  const discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.equal(discovery.followbackScan.positive,1);
  assert.equal(discovery.followers.followers.find(row=>row.id===actorId)?.followsOwner,true);
  assert.equal(f.state.records[actorId],undefined,'outbound invitation actions do not themselves qualify benefits');
});
test('batch skips one target-local comment-row schema failure and drafts the next valid actor',async t=>{
  const f=twoActorBatchFixture();
  const root=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  f.options.root=root;
  const batch=await prepareThreadsBenefitBatch({},f.options);
  assert.equal(batch.prepared,1);assert.equal(batch.writes,0);
  assert.deepEqual(batch.skippedTargets,[{id:'17824859400',handle:'one',stage:'base',code:'THREADS_SOCIAL_COMMENT_ROW_SCHEMA'}]);
  assert.deepEqual(batch.drafts.map(row=>row.accountId),[f.secondId]);
  assert.deepEqual(f.generatedInputs().map(row=>row.accountId),[f.secondId]);
  assert.equal(f.calls.length,0);
  assert.deepEqual(Object.keys(f.state.draftCache),[f.secondId]);
});
test('a missing member relationship in an owner-verified document holds only that draft target',async t=>{
  const f=twoActorBatchFixture(null),root=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-batch-'));
  t.after(()=>rm(root,{recursive:true,force:true}));f.options.root=root;
  const contextLoader=f.options.contextLoader;
  f.options.contextLoader=async(service,handle)=>{
    const context=await contextLoader(service,handle);
    context.documentReceipt={...context.documentReceipt,httpStatus:200};
    if(handle==='one')context.document.profiles=[];
    return context;
  };
  f.options.relationshipReader=readMetaRelationship;
  const reserved={handle:'historic_member',baseStatus:'needs_reconciliation',bonusStatus:'not_started',
    currentOperation:'reply',attemptedOperations:{reply:true}};
  f.state.records['17824859999']=structuredClone(reserved);
  const batch=await prepareThreadsBenefitBatch({},f.options);
  assert.deepEqual(batch.skippedTargets,[{id:'17824859400',handle:'one',stage:'base',code:'THREADS_BENEFIT_ACTOR_UNVERIFIED'}]);
  assert.deepEqual(batch.drafts.map(row=>row.accountId),[f.secondId]);
  assert.deepEqual(Object.keys(f.state.draftCache),[f.secondId]);
  assert.deepEqual(f.state.records['17824859999'],reserved);
  assert.equal(f.state.records['17824859400'],undefined);
  assert.equal(batch.writes,0);assert.deepEqual(f.calls,[]);
});
test('a member losing its profile relationship before execution cannot reserve or dispatch benefits',async()=>{
  for(const profiles of [[],[{pk:'17824859400',username:'one',friendship_status:{followed_by:true}}]]) {
    const f=fixture();f.context.documentReceipt.httpStatus=200;f.context.document.profiles=profiles;
    f.options.relationshipReader=readMetaRelationship;
    await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_ACTOR_UNVERIFIED'});
    assert.deepEqual(f.state.records,{});assert.equal(f.state.lastAccountAttemptAt,undefined);
    assert.deepEqual(f.calls,[]);assert.equal(f.saved.length,0);
  }
});
test('missing member data does not mask an unverified owner or an unexpected relationship-reader failure',async()=>{
  const owner=fixture();owner.context.documentReceipt.ownerVerified=false;owner.context.document.profiles=[];
  owner.options.relationshipReader=readMetaRelationship;
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},owner.options),{code:'THREADS_BENEFIT_OWNER_UNVERIFIED'});
  assert.deepEqual(owner.calls,[]);
  const refusal=twoActorBatchFixture(null),error=Object.assign(new Error('relationship read refused'),
    {code:'META_TARGET_NOT_FOUND',httpStatus:403,needs_reconciliation:true});
  refusal.options.relationshipReader=async()=>{throw error;};
  await assert.rejects(()=>prepareThreadsBenefitBatch({},refusal.options),value=>value===error);
  assert.deepEqual(refusal.calls,[]);assert.equal(refusal.state.draftCache,undefined);
});
test('batch preserves an incomplete prior-owner-reply scan as a hold and never drafts that target',async t=>{
  const f=fixture(),root=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  f.options.root=root;let generated=0;
  f.options.commentsReader=async id=>id===promo?f.rootComments:id===oldPromo?f.oldComments
    :{postId:id,postAuthor:'one',comments:[],totalDirectReplyCount:3,page:{fullList:false}};
  f.options.generate=async()=>{generated++;return {comments:[]};};
  const batch=await prepareThreadsBenefitBatch({},f.options);
  assert.equal(batch.prepared,0);assert.equal(generated,0);assert.equal(batch.writes,0);
  assert.deepEqual(batch.skippedTargets,[]);
  assert.deepEqual(batch.followOnlyTargets,[{id:'17824859400',handle:'one',stage:'base',code:'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE'}]);
});
function setTargetReplyHistory(f,{existingOwnerReply=false,fullList=false}={}) {
  f.options.commentsReader=async id=>id===promo?f.rootComments:id===oldPromo?f.oldComments
    :{postId:id,postAuthor:'one',comments:existingOwnerReply
      ?[{id:'3983580490905486999',author:P.owner,text:'지난 답글',isReply:true,directParentPostId:id}]:[],
      totalDirectReplyCount:existingOwnerReply?1:fullList?0:3,page:{fullList,hasNextPage:!fullList}};
}
function setCurrentRelationship(f,following,outgoingRequest=false) {
  f.options.relationshipReader=async()=>({id:'17824859400',state:{following,outgoingRequest}});
}
async function seedNoOpFollowHistoryHold(f) {
  setTargetReplyHistory(f);setCurrentRelationship(f,true,false);
  f.options.follow=async input=>{f.calls.push('follow');return {target:input.target,normalizedTarget:'17824859400',
    readbackVerified:true,status:'no_op',noOp:true,mutationCount:0,currentState:{following:true,outgoingRequest:false}};};
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'follow_verified_reward_held');assert.equal(result.writes,0);
  f.advance();
  return result;
}
test('reply-history holds persist the first follow; a missing saved active trigger holds only its completion notice',async()=>{
  const f=fixture(),actorId='17824859400';setTargetReplyHistory(f,{existingOwnerReply:true});
  const held=await runThreadsBenefitTarget({handle:'one',execute:true,requireCachedDraft:true},f.options);
  assert.equal(held.status,'follow_verified_reward_held');assert.equal(held.code,'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED');
  assert.equal(held.writes,1);assert.equal(held.writeCountUnknown,false);
  assert.deepEqual(f.calls,['follow'],'history hold bypasses AI and never sends like, repost, or comments');
  const saved=f.state.records[actorId];
  assert.equal(saved.baseStatus,'follow_verified_reward_held');assert.notEqual(saved.baseStatus,'verified');
  assert.equal(saved.results.follow.readbackVerified,true);assert.equal(saved.results.follow.normalizedTarget,actorId);
  assert.deepEqual(Object.keys(saved.results),['primaryPostId','follow']);assert.equal(saved.notices,undefined);
  assert.equal(saved.historyHold.code,'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED');

  setTargetReplyHistory(f,{fullList:true});setCurrentRelationship(f,true,false);f.rootComments.comments=[];f.advance();f.calls.length=0;
  const completed=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(completed.status,'benefit_verified_notice_held');assert.equal(completed.writes,3);
  assert.equal(completed.benefitStageVerified,true);assert.equal(completed.noticeStatus,'held');
  assert.equal(f.calls.includes('follow'),false,'the verified prior follow is reused without replay');
  assert.deepEqual(f.calls,['ai',`like:${pin}`,`repost:${pin}`,`reply:${pin}`]);
  assert.equal(f.replyInputs.some(input=>input.postId===promo),false,'an aged-out active trigger is never retargeted to the root');
  assert.equal(f.state.records[actorId].baseStatus,'verified');
});
test('an incomplete reward-history scan follows a qualified direct participant only and records finite writes',async()=>{
  const f=fixture();f.context.document.profiles[0].friendship_status.followed_by=false;
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  setTargetReplyHistory(f);
  const result=await runThreadsBenefitTarget({handle:'one',execute:true,requireCachedDraft:true},f.options);
  assert.equal(result.status,'follow_verified_reward_held');
  assert.equal(result.code,'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE');
  assert.equal(result.writes,1);assert.equal(result.writeCountUnknown,false);
  assert.deepEqual(f.calls,['follow']);
  assert.equal(f.state.records['17824859400'].entrance,'direct_promotion_comment');
});
test('an existing verified follow no-op is persisted as a follow-only history hold without replay',async()=>{
  const f=fixture();await seedNoOpFollowHistoryHold(f);
  assert.deepEqual(f.calls,['follow']);
  f.calls.length=0;f.rootComments.comments=[];
  f.context.document.profiles[0].friendship_status.followed_by=null;
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  const repeated=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(repeated.status,'follow_verified_reward_held');assert.equal(repeated.writes,0);
  assert.deepEqual(f.calls,[],'a valid stored entrance and follow receipt survive partial follower/comment pages without replay');
});
test('batch skips only an exact verified no-op follow receipt while the fresh relationship is still following',async t=>{
  const f=fixture(),root=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  f.options.root=root;await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  f.rootComments.comments=[];f.context.document.profiles[0].friendship_status.followed_by=null;
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.options.generate=async()=>{throw new Error('history hold must not draft');};

  const batch=await prepareThreadsBenefitBatch({},f.options);

  assert.equal(batch.prepared,0);assert.equal(batch.writes,0);
  assert.deepEqual(batch.followOnlyTargets,[]);
  assert.deepEqual(batch.alreadyVerifiedFollowOnlyTargets,[{id:'17824859400',handle:'one',stage:'base',
    code:'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',status:'already_verified_follow_only_hold',activePromotionId:promo}]);
  assert.deepEqual(f.calls,[]);
});

test('a history-held basic reaction pass skips deep replies and AI, verifies both reactions, and preserves the reply hold',async()=>{
  const f=fixture();await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  const original=f.options.commentsReader;
  f.options.commentsReader=async id=>{assert.notEqual(id,pin,'reaction stage must not scan target reply history');return original(id);};
  f.options.reaction=async(input,guards)=>{
    assert.equal(await guards.beforeWrite(),true);f.calls.push(input.operation);
    return {...input,target:'one',readbackVerified:true,writes:1,currentState:{authorId:'17824859400',liked:true,reposted:true}};
  };
  const originalFollow=structuredClone(f.state.records['17824859400'].results.follow);
  let discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.equal(discovery.queue[0].basicReactionsPending,true);
  f.options.followersReader=async()=>{throw new Error('reaction stage must not enumerate followers');};
  f.options.engagementReader=async()=>{throw new Error('reaction stage must not reread unrelated bonus eligibility');};
  const result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.basicReactionsVerified,true);assert.equal(result.writes,2);
  assert.equal(result.status,'follow_verified_reward_held');assert.deepEqual(f.calls,['like','repost']);
  const record=f.state.records['17824859400'];
  assert.equal(threadsBasicReactionsVerified('17824859400',record),true);
  assert.deepEqual(record.results.follow,originalFollow);assert.equal(record.notices,undefined);
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.options.engagementReader=async id=>id===promo?f.engagement:f.oldEngagement;
  discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.equal(discovery.queue[0].basicReactionsPending,undefined);
  f.calls.length=0;
  await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.deepEqual(f.calls,[],'the completed partial stage must not resend');
});

test('an uncertain history-held reaction stops the pair and never rearms the actor',async()=>{
  const f=fixture();await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  f.options.reaction=async input=>{f.calls.push(input.operation);return {...input,target:'one',writes:1,readbackVerified:false};};
  const result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.status,'needs_reconciliation');assert.deepEqual(f.calls,['like']);
  assert.equal(f.state.records['17824859400'].basicReactions.status,'needs_reconciliation');
  const discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.equal(discovery.queue.length,0);
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options),
    {code:'THREADS_BENEFIT_RECONCILE_OR_WAIT'});
  assert.deepEqual(f.calls,['like']);
});

test('a proven pre-dispatch budget wait resumes only the missing reaction; dispatched uncertainty never gets this path',async()=>{
  const f=fixture();await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  let block=true;
  f.options.reaction=async input=>{
    f.calls.push(input.operation);
    if(input.operation==='repost' && block) throw Object.assign(new Error('local wait'),{
      code:'THREADS_READ_BUDGET_WAIT',dispatchStarted:false,writeSent:false,retryAt:f.options.now()+60000,
      receipt:{localBudget:true}});
    return {...input,target:'one',readbackVerified:true,writes:1,currentState:{authorId:'17824859400',liked:true,reposted:true}};
  };
  let result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.code,'THREADS_READ_BUDGET_WAIT');assert.equal(result.receipt.localBudget,true);
  assert.equal(result.writes,1);assert.equal(result.writeCountUnknown,false);
  assert.equal(f.state.records['17824859400'].currentOperation,null);
  assert.equal(f.state.records['17824859400'].basicReactions.status,'preflight_wait');
  assert.equal((await discoverThreadsBenefits(f.state,f.options)).queue[0].basicReactionsPending,true);
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options),
    {code:'THREADS_READ_BUDGET_WAIT'});
  block=false;f.advance();f.advance();f.advance();f.calls.length=0;
  result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.basicReactionsVerified,true);assert.deepEqual(f.calls,['repost']);

  const unknown=fixture();await seedNoOpFollowHistoryHold(unknown);
  unknown.options.reaction=async()=>{throw Object.assign(new Error('sent uncertainty'),{
    code:'THREADS_READ_BUDGET_WAIT',dispatchStarted:true,writeSent:true,retryAt:unknown.options.now()+60000,
    receipt:{localBudget:true}});};
  result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},unknown.options);
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.writeCountUnknown,true);
  assert.equal((await discoverThreadsBenefits(unknown.state,unknown.options)).queue.length,0);
});

test('a persisted reserved history-hold stage resumes when no reaction operation started',async()=>{
  const f=fixture();await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  f.state.records['17824859400'].basicReactions={status:'reserved',postId:pin,results:{}};
  f.options.reaction=async input=>{
    f.calls.push(input.operation);
    return {...input,target:'one',readbackVerified:true,writes:1,
      currentState:{authorId:'17824859400',liked:input.operation==='like',reposted:input.operation==='repost'}};
  };
  const result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.basicReactionsVerified,true);
  assert.deepEqual(f.calls,['like','repost']);
});

test('resuming an exact positive reconciled like preserves its failure history and sends only the unattempted repost',async()=>{
  const f=fixture();await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  const actorId='17824859400',record=f.state.records[actorId];
  const history=[{operation:'like',reconciledAt:'2026-09-30T09:59:59.000Z',
    priorResult:{status:'needs_reconciliation',readbackVerified:false,writes:1,code:'THREADS_READ_BUDGET_WAIT'}}];
  record.attemptedOperations=2;
  record.basicReactions={status:'reserved',postId:pin,reconciliationHistory:structuredClone(history),
    results:{like:{operation:'like',postId:pin,target:'one',readbackVerified:true,writes:1,
      currentState:{authorId:actorId,liked:true}}}};
  f.options.reaction=async input=>{
    f.calls.push(input.operation);
    return {...input,target:'one',readbackVerified:true,writes:1,
      currentState:{authorId:actorId,reposted:true}};
  };
  const result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.basicReactionsVerified,true);
  assert.deepEqual(f.calls,['repost']);
  assert.deepEqual(record.basicReactions.reconciliationHistory,history);
});

test('reaction-only mode preserves identity, current follow, primary post and STOP gates',async()=>{
  for(const gate of ['identity','relationship','post','stop']) {
    const f=fixture();await seedNoOpFollowHistoryHold(f);f.calls.length=0;
    if(gate==='identity') f.options.relationshipReader=async()=>({id:'999',state:{following:true,outgoingRequest:false}});
    if(gate==='relationship') setCurrentRelationship(f,false,false);
    if(gate==='post') f.options.profileReader=async()=>({handle:'one',posts:[],fullTimeline:true,pinState:'no_pin_in_full_timeline'});
    if(gate==='stop') f.options.isStopRequested=async()=>true;
    await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options));
    assert.deepEqual(f.calls,[]);assert.equal(f.state.records['17824859400'].basicReactions,undefined);
  }
});
test('a fresh unfollowed relationship repairs a stored no-op instead of suppressing the follow',async t=>{
  const f=fixture(),root=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  f.options.root=root;await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  f.rootComments.comments=[];f.context.document.profiles[0].friendship_status.followed_by=null;
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});setCurrentRelationship(f,false,false);
  f.options.follow=async input=>{f.calls.push('follow');return {target:input.target,normalizedTarget:'17824859400',
    readbackVerified:true,status:'succeeded',mutationCount:1,currentState:{following:true,outgoingRequest:false}};};

  const batch=await prepareThreadsBenefitBatch({},f.options);
  assert.deepEqual(batch.alreadyVerifiedFollowOnlyTargets,[]);
  assert.deepEqual(batch.followOnlyTargets,[{id:'17824859400',handle:'one',stage:'base',code:'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE'}]);
  const repaired=await runThreadsBenefitTarget({handle:'one',execute:true,requireCachedDraft:true},f.options);
  assert.equal(repaired.status,'follow_verified_reward_held');assert.equal(repaired.writes,1);
  assert.deepEqual(f.calls,['follow']);
  assert.equal(f.state.records['17824859400'].results.follow.mutationCount,1);
});
test('a repair blocked by an unresolved action reservation stays reconciliation-only',async()=>{
  const f=fixture();await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  setCurrentRelationship(f,false,false);
  f.options.follow=async()=>{f.calls.push('follow');return {success:false,status:'blocked',
    code:'SOCIAL_PENDING_ACTION_RECONCILE_FIRST',mutationCount:0,readbackVerified:false};};

  const repair=await runThreadsBenefitTarget({handle:'one',execute:true,requireCachedDraft:true},f.options);
  assert.equal(repair.status,'needs_reconciliation');assert.equal(repair.code,'SOCIAL_PENDING_ACTION_RECONCILE_FIRST');
  assert.equal(f.state.records['17824859400'].baseStatus,'needs_reconciliation');
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true,requireCachedDraft:true},f.options),
    {code:'THREADS_BENEFIT_RECONCILE_OR_WAIT'});
  assert.deepEqual(f.calls,['follow'],'an unresolved pending journal blocks every later repair send');
});
test('unknown fresh relationship or reconciliation record never gets the already-verified bypass',async t=>{
  const f=fixture(),root=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-batch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  f.options.root=root;await seedNoOpFollowHistoryHold(f);f.calls.length=0;
  f.rootComments.comments=[];f.context.document.profiles[0].friendship_status.followed_by=null;
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});setCurrentRelationship(f,null,false);

  const unknown=await prepareThreadsBenefitBatch({},f.options);
  assert.deepEqual(unknown.alreadyVerifiedFollowOnlyTargets,[]);
  assert.equal(unknown.followOnlyTargets.length,1,'an unknown current relation stays on the guarded follow path');

  f.state.records['17824859400'].currentOperation='follow';
  const reconciling=await prepareThreadsBenefitBatch({},f.options);
  assert.deepEqual(reconciling.alreadyVerifiedFollowOnlyTargets,[]);
  assert.deepEqual(reconciling.followOnlyTargets,[],'an in-flight record is excluded from both follow-only paths');
});
test('an uncertain or auth-blocked history-hold follow remains reconciliation-blocked and never replays',async()=>{
  for(const code of ['META_INTERACTION_REQUIRED','THREADS_FOLLOW_TRANSPORT_UNKNOWN']) {
    const f=fixture();setTargetReplyHistory(f);f.options.follow=async()=>{f.calls.push('follow');throw Object.assign(new Error(),{code});};
    const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
    assert.equal(result.status,'needs_reconciliation');assert.equal(result.code,code);
    assert.equal(result.writeCountUnknown,true);assert.equal(result.writes,null);
    assert.equal(f.state.records['17824859400'].currentOperation,'follow');
    await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),
      {code:'THREADS_BENEFIT_RECONCILE_OR_WAIT'});
    assert.deepEqual(f.calls,['follow']);
  }
});
test('history holds never follow an unverified profile identity or an unobserved entrance',async()=>{
  const unknownEntrance=fixture();setTargetReplyHistory(unknownEntrance);
  unknownEntrance.rootComments.comments=[];
  unknownEntrance.context.document.profiles[0].friendship_status.followed_by=null;
  unknownEntrance.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},unknownEntrance.options),
    {code:'THREADS_BENEFIT_ENTRANCE_NOT_OBSERVED'});
  assert.deepEqual(unknownEntrance.calls,[]);

  const unknownActor=fixture();setTargetReplyHistory(unknownActor);
  unknownActor.options.relationshipReader=async()=>({id:'17824859401',state:{following:false,outgoingRequest:false}});
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},unknownActor.options),
    {code:'THREADS_BENEFIT_ACTOR_UNVERIFIED'});
  assert.deepEqual(unknownActor.calls,[]);
});
test('batch propagates auth challenges and HTTP 429 instead of treating them as target-local',async t=>{
  for(const code of ['META_INTERACTION_REQUIRED','THREADS_SOCIAL_HTTP_429']) {
    const f=twoActorBatchFixture(code),root=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-batch-'));
    t.after(()=>rm(root,{recursive:true,force:true}));f.options.root=root;let generated=0;
    f.options.generate=async()=>{generated++;return {comments:[]};};
    await assert.rejects(()=>prepareThreadsBenefitBatch({},f.options),{code});
    assert.equal(generated,0);assert.equal(f.calls.length,0);
  }
});
test('a verified existing-follow no-op is rechecked and can qualify a late same-promotion bonus without base replay',async()=>{
  const f=fixture(),actorId='17824859400';
  f.state.records[actorId]={handle:'one',baseStatus:'verified',bonusStatus:'not_started',pinnedPostId:pin,
    results:{follow:{target:'one',normalizedTarget:actorId,readbackVerified:true,status:'no_op',noOp:true,mutationCount:0,
      currentState:{following:true,outgoingRequest:false}}}};
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.rootComments.comments=[];f.rootComments.totalDirectReplyCount=0;
  f.engagement.activities.like=[{id:actorId}];f.engagement.activities.repost=[{id:actorId}];
  const discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.equal(discovery.followbackScan.scanned,1);
  assert.equal(discovery.followbackScan.positive,1);
  assert.equal(discovery.followers.followers[0].following,undefined);
  assert.equal(discovery.followers.followers[0].outgoingRequest,undefined);
  assert.equal(discovery.followers.followers[0].verified,undefined);
  assert.deepEqual(discovery.queue.map(row=>row.id),[actorId]);
  assert.equal(discovery.queue[0].stage,'bonus');
  assert.equal(discovery.queue[0].qualifyingPostId,promo);
  assert.equal(f.state.records[actorId].baseStatus,'verified');
  assert.deepEqual(f.calls,[]);
});
test('pending or owner-following-only evidence never seeds a late bonus',async()=>{
  const f=fixture(),followingId='17824859400',pendingId='17824859402';
  f.state.records[followingId]={handle:'following_only',baseStatus:'verified',bonusStatus:'not_started',
    results:{follow:{target:'following_only',normalizedTarget:followingId,readbackVerified:true,mutationCount:1,
      currentState:{following:true,outgoingRequest:false}}}};
  f.state.records[pendingId]={handle:'pending_only',baseStatus:'pending_follow_request',
    results:{follow:{target:'pending_only',normalizedTarget:pendingId,readbackVerified:true,mutationCount:1,
      currentState:{following:false,outgoingRequest:true}}}};
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.options.contextLoader=async(_service,handle)=>({...f.context,handle,
    document:{profiles:[{pk:handle==='following_only'?followingId:pendingId,username:handle,
      friendship_status:{followed_by:false,following:handle==='following_only',outgoing_request:handle==='pending_only'},
      text_post_app_is_private:false}]}});
  f.options.relationshipReader=async context=>({id:String(context.document.profiles[0].pk),state:{following:true,outgoingRequest:false}});
  f.rootComments.comments=[];f.rootComments.totalDirectReplyCount=0;
  f.engagement.activities.like=[{id:followingId},{id:pendingId}];
  f.engagement.activities.repost=[{id:followingId},{id:pendingId}];
  const discovery=await discoverThreadsBenefits(f.state,f.options);
  assert.deepEqual(discovery.queue,[]);
  assert.equal(discovery.followbackScan.positive,0);
  assert.deepEqual(discovery.followbackScan.held,[]);
  assert.equal(discovery.followbackScan.scanned,1,'pending records are excluded from scan candidates');
});
test('tracked followback profile reads are bounded and rotate after the saved stable-id cursor',async()=>{
  const f=fixture(),state={records:{}},reads=[];
  for(let index=0;index<22;index++) {
    const id=String(17824859500+index),handle=`tracked_${String(index).padStart(2,'0')}`;
    state.records[id]={handle,baseStatus:'verified',bonusStatus:'not_started',results:{follow:{target:handle,
      normalizedTarget:id,readbackVerified:true,mutationCount:1,currentState:{following:true,outgoingRequest:false}}}};
  }
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.options.contextLoader=async(_service,handle)=>{
    const record=Object.entries(state.records).find(([,row])=>row.handle===handle);
    assert.ok(record);reads.push(record[0]);
    return {...f.context,handle,document:{profiles:[{pk:record[0],username:handle,
      friendship_status:{followed_by:false,following:true,outgoing_request:false},text_post_app_is_private:false}]}};
  };
  f.options.relationshipReader=async context=>({id:String(context.document.profiles[0].pk),state:{following:true,outgoingRequest:false}});
  f.rootComments.comments=[];f.rootComments.totalDirectReplyCount=0;
  const first=await discoverThreadsBenefits(state,f.options);
  assert.equal(first.followbackScan.scanned,20);
  assert.equal(first.followbackScan.eligible,22);
  assert.equal(new Set(reads).size,20);
  assert.equal(state.followbackScan.lastScannedActorId,reads.at(-1));
  reads.length=0;
  const second=await discoverThreadsBenefits(state,f.options);
  assert.equal(second.followbackScan.scanned,2,'recently answered actors are not re-read');
  assert.equal(second.followbackScan.cached,20);
  assert.deepEqual(reads,['17824859520','17824859521']);
  assert.equal(second.followbackScan.held.length,0);
  reads.length=0;
  const third=await discoverThreadsBenefits(state,f.options);
  assert.equal(reads.length,0);
  assert.equal(third.followbackScan.cached,22);
  const base=f.options.now();
  f.options.now=()=>base+KNOWN_FOLLOWBACK_RECHECK_MS+1000;
  await discoverThreadsBenefits(state,f.options);
  assert.equal(reads.length,20,'expired answers are re-read within the per-pass limit');
  assert.deepEqual(reads.slice(0,2),['17824859500','17824859501'],'the cursor advances across the wrapped batch');
});
test('cached tracked follow-back answers keep positive actors queued without a profile read',async()=>{
  const f=fixture(),state={records:{}},reads=[];
  const id='17824859600',handle='tracked_pos';
  state.records[id]={handle,baseStatus:'verified',bonusStatus:'not_started',results:{follow:{target:handle,
    normalizedTarget:id,readbackVerified:true,mutationCount:1,currentState:{following:true,outgoingRequest:false}}}};
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.options.contextLoader=async(_service,name)=>{reads.push(name);
    return {...f.context,handle:name,document:{profiles:[{pk:id,username:name,
      friendship_status:{followed_by:true,following:true,outgoing_request:false},text_post_app_is_private:false}]}};};
  f.options.relationshipReader=async()=>({id,state:{following:true,outgoingRequest:false}});
  f.rootComments.comments=[];f.rootComments.totalDirectReplyCount=0;
  const first=await discoverThreadsBenefits(state,f.options);
  assert.equal(first.followbackScan.positive,1);
  const second=await discoverThreadsBenefits(state,f.options);
  assert.equal(reads.length,1);
  assert.equal(second.followbackScan.positive,1);
  assert.ok(second.followers.followers.some(row=>row.id===id&&row.followsOwner===true));
  state.followbackChecks[id].handle='renamed';
  await discoverThreadsBenefits(state,f.options);
  assert.equal(reads.length,2,'a handle change invalidates the cached answer');
});
test('a cached incoming-follow answer cannot satisfy the fresh target entrance check',async()=>{
  const f=fixture(),id='17824859400',now=f.options.now();
  f.state.records[id]={handle:'one',baseStatus:'verified',bonusStatus:'not_started',activePromotionId:promo,pinnedPostId:pin,
    results:{primaryPostId:pin,follow:{target:'one',normalizedTarget:id,readbackVerified:true,mutationCount:1,
      currentState:{following:true,outgoingRequest:false}}}};
  f.state.followbackChecks={[id]:{handle:'one',result:'positive',checkedAt:new Date(now-1000).toISOString()}};
  f.options.followersReader=async()=>({followers:Array.from({length:20},(_,i)=>({id:String(20000000000+i),
    username:`other_${i}`,followsOwner:true,following:false,outgoingRequest:false,private:false})),page:{fullList:false,hasNextPage:true}});
  f.options.contextLoader=async()=>({...f.context,document:{profiles:[{pk:id,username:'one',
    friendship_status:{followed_by:null,following:true,outgoing_request:false},text_post_app_is_private:false}]}});
  f.options.relationshipReader=async()=>({id,state:{following:true,outgoingRequest:false}});
  f.options.engagementReader=async postId=>postId===promo
    ? {...f.engagement,activities:{like:[{id}],repost:[{id}],quote:[]}}:f.oldEngagement;
  f.rootComments.comments=[];f.rootComments.totalDirectReplyCount=0;
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),
    {code:'THREADS_BENEFIT_ENTRANCE_NOT_OBSERVED'});
  assert.deepEqual(f.calls,[],'stale positive cache cannot authorize bonus actions');
});

test('incomplete historic pin scans and mismatched comment IDs stop before public actions',async()=>{
  const f=fixture();
  f.options.commentsReader=async id=>id===promo?f.rootComments:id===oldPromo?f.oldComments:{postId:id,postAuthor:'one',comments:[],totalDirectReplyCount:30,page:{fullList:false}};
  const held=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(held.status,'follow_verified_reward_held');assert.equal(held.code,'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE');
  assert.deepEqual(f.calls,['follow']);
  f.rootComments.comments[0].authorId='17824859401';
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_COMMENT_ACTOR_MISMATCH'});
  f.rootComments.comments[0].authorId=null;
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_COMMENT_IDENTITY_UNVERIFIED'});
});
function seedDelayedBonus(f) {
  f.state.records['17824859400']={handle:'one',baseStatus:'verified',bonusStatus:'not_started',activePromotionId:promo,
    triggeringPromotionId:promo,triggeringCommentId:'3983580490905486169',pinnedPostId:pin,
    results:{primaryPostId:pin,follow:{target:'one',normalizedTarget:'17824859400',readbackVerified:true,
      mutationCount:1,currentState:{following:true,outgoingRequest:false}}}};
  f.rootComments.comments=[];
  f.rootComments.totalDirectReplyCount=8;
  f.rootComments.page={fullList:false,hasNextPage:true};
}
test('a delayed actively qualified bonus with an aged-out active trigger holds its notice without root retargeting',async()=>{
  const f=fixture();seedDelayedBonus(f);
  f.engagement.activities.like=[{id:'17824859400'}];f.engagement.activities.repost=[{id:'17824859400'}];
  const prepared=await prepareThreadsBenefitTarget('one',f.state,f.options);
  assert.equal(prepared.user.stage,'bonus');
  assert.equal(prepared.user.qualifyingPostId,promo);
  assert.equal(prepared.triggeringComment,null);
  assert.equal(prepared.writes,0);
  assert.deepEqual(f.calls,[]);
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'benefit_verified_notice_held');
  assert.equal(result.benefitStageVerified,true);assert.equal(result.noticeStatus,'held');
  assert.deepEqual(f.calls,[`like:${extra}`,`repost:${extra}`]);
  assert.equal(f.replyInputs.some(input=>input.postId===promo),false);
  assert.equal(f.state.records['17824859400'].bonusStatus,'verified');
});
test('a missing stored trigger still blocks a base-stage retry',async()=>{
  const f=fixture(),actorId='17824859400';
  f.state.records[actorId]={handle:'one',baseStatus:'preflight_blocked',bonusStatus:'not_started',activePromotionId:promo,
    triggeringPromotionId:promo,triggeringCommentId:'3983580490905486169',pinnedPostId:pin,
    code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',attemptedOperations:1,
    results:{primaryPostId:pin,follow:{operation:'follow',status:'preflight_blocked',code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',
      mutationCount:0,dispatchStarted:false,writeSent:false}}};
  f.rootComments.comments=[];f.rootComments.totalDirectReplyCount=8;f.rootComments.page={fullList:false,hasNextPage:true};
  f.engagement.activities.like=[{id:actorId}];f.engagement.activities.repost=[{id:actorId}];
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one'},f.options),{code:'THREADS_BENEFIT_TRIGGER_REVERIFY_REQUIRED'});
  assert.deepEqual(f.calls,[]);
});
test('a missing stored trigger is not waived without a positive follow and qualifying configured promotion',async()=>{
  const nonqualifying=fixture();seedDelayedBonus(nonqualifying);
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one'},nonqualifying.options),
    {code:'THREADS_BENEFIT_TRIGGER_REVERIFY_REQUIRED'});
  assert.deepEqual(nonqualifying.calls,[]);

  const noFollow=fixture();seedDelayedBonus(noFollow);
  noFollow.engagement.activities.like=[{id:'17824859400'}];noFollow.engagement.activities.repost=[{id:'17824859400'}];
  noFollow.context.document.profiles[0].friendship_status.followed_by=false;
  noFollow.options.followersReader=async()=>({followers:[{id:'17824859400',username:'one',followsOwner:false,
    following:false,outgoingRequest:false,private:false}],page:{fullList:false}});
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one'},noFollow.options),
    {code:'THREADS_BENEFIT_ENTRANCE_NOT_OBSERVED'});
  assert.deepEqual(noFollow.calls,[]);
});
test('a positively followed bonus qualified only on a configured previous promotion also uses the active root',async()=>{
  const f=fixture();seedDelayedBonus(f);
  f.oldEngagement.activities.like=[{id:'17824859400'}];f.oldEngagement.activities.repost=[{id:'17824859400'}];
  const prepared=await prepareThreadsBenefitTarget('one',f.state,f.options);
  assert.equal(prepared.user.stage,'bonus');
  assert.equal(prepared.user.qualifyingPostId,oldPromo);
  assert.deepEqual(prepared.user.legacyQualifyingPromotionIds,[oldPromo]);
  assert.equal(prepared.triggeringComment,null);
  assert.equal(prepared.writes,0);
  assert.deepEqual(f.calls,[]);
});
test('an old-promotion direct commenter is reverified and receives any new completion notice under the active root',async()=>{
  const f=fixture(), actorId='17824859499';
  f.options.followersReader=async()=>({followers:[],page:{fullList:false}});
  f.options.commentsReader=async id=>id===promo
    ? {postId:promo,postAuthor:P.owner,comments:[],totalDirectReplyCount:0,page:{fullList:false}}
    : id===oldPromo
      ? {postId:oldPromo,postAuthor:P.owner,comments:[{id:'3996994421430737991',author:'old_entrant',authorId:actorId,
        text:'여기 참여했어요',isReply:true,directParentPostId:oldPromo}],totalDirectReplyCount:1,page:{fullList:false}}
      : {postId:id,postAuthor:'old_entrant',comments:[],totalDirectReplyCount:0,page:{fullList:false}};
  f.options.contextLoader=async(_service,handle)=>({...f.context,document:{profiles:[{pk:actorId,username:handle,
    friendship_status:{followed_by:false},text_post_app_is_private:false}]}});
  f.options.relationshipReader=async context=>({id:context.document.profiles[0].pk,state:{following:false,outgoingRequest:false}});
  f.options.profileReader=async({handle})=>({handle,posts:[],fullTimeline:true});
  f.options.follow=async input=>{f.calls.push('follow');return {target:input.target,readbackVerified:true,currentState:{following:true},mutationCount:1};};
  const result=await runThreadsBenefitTarget({handle:'old_entrant',execute:true},f.options);
  assert.equal(result.status,'verified',JSON.stringify(result));
  assert.deepEqual(f.calls,['follow',`reply:${promo}`]);
  assert.equal(f.replyInputs[0].expectedAuthor,P.owner);
  assert.equal(f.state.records[actorId].baseStatus,'verified');
});
test('a sanitized HTTP 429 survives runner reconciliation for the worker cooldown',async()=>{
  const f=fixture();
  f.options.reaction=async input=>({ ...input,target:input.expectedAuthor,readbackVerified:false,writes:1,
    code:'THREADS_REACTION_HTTP_429',httpStatus:429,retryAfterSeconds:120,currentState:{liked:false,reposted:false} });
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'needs_reconciliation');
  assert.equal(result.code,'THREADS_REACTION_HTTP_429');
  assert.equal(result.httpStatus,429);
  assert.equal(result.retryAfterSeconds,120);
  assert.equal(result.writes,2);
});
test('a thrown transport cannot be reported as zero writes and its reserved stage stays blocked',async()=>{
  const f=fixture();f.options.reaction=async()=>{throw Object.assign(new Error(),{code:'THREADS_REACTION_OUTCOME_UNKNOWN'});};
  const r=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(r.writes,null);assert.equal(r.observedWrites,1);assert.equal(r.writeCountUnknown,true);
  assert.equal(f.state.records['17824859400'].currentOperation,'like');
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),{code:'THREADS_BENEFIT_RECONCILE_OR_WAIT'});
});
test('the exact pre-journal writer identity guard is a zero-dispatch hold and retries only on the next call',async()=>{
  const f=fixture(),actorId='17824859400';
  f.options.follow=async()=>{f.calls.push('follow');throw Object.assign(new Error(),{code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE'});};
  const first=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(first.status,'preflight_blocked');assert.equal(first.writes,0);assert.equal(first.observedWrites,0);
  assert.equal(first.writeCountUnknown,false);assert.equal(first.dispatchStarted,false);assert.equal(first.mutationCount,0);
  assert.deepEqual(f.calls,['ai','follow']);
  const blocked=f.state.records[actorId];
  assert.equal(blocked.baseStatus,'preflight_blocked');assert.equal(blocked.currentOperation,null);
  assert.equal(blocked.results.follow.code,'SOCIAL_WRITER_IDENTITY_UNAVAILABLE');
  assert.equal(blocked.results.follow.mutationCount,0);assert.equal(blocked.results.follow.dispatchStarted,false);
  assert.equal(blocked.results.follow.writeSent,false);
  const failedAt=blocked.preflightFailures[0].failedAt;
  assert.equal(failedAt,'2026-09-30T10:00:00.000Z');

  f.calls.length=0;f.advance();
  f.options.follow=async input=>{f.calls.push('follow');return {target:input.target,readbackVerified:true,
    currentState:{following:true},mutationCount:1};};
  const next=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(next.status,'verified');assert.equal(next.writes,5);
  assert.equal(f.calls[0],'ai');assert.equal(f.calls[1],'follow');
  assert.equal(f.state.records[actorId].preflightFailures[0].failedAt,failedAt);
  assert.equal(f.state.records[actorId].preflightFailures[0].mutationCount,0);
});
test('an opaque follow error remains outcome-unknown even with no observed earlier writes',async()=>{
  const f=fixture(),actorId='17824859400';
  f.options.follow=async()=>{f.calls.push('follow');throw Object.assign(new Error(),{code:'THREADS_FOLLOW_TRANSPORT_UNKNOWN'});};
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.writes,null);
  assert.equal(result.observedWrites,0);assert.equal(result.writeCountUnknown,true);
  assert.equal(f.state.records[actorId].currentOperation,'follow');
  assert.equal(f.state.records[actorId].preflightFailures,undefined);
});
test('coordinator refresh migrates only the exact prior first-follow identity failure and preserves timestamps',async()=>{
  const f=fixture(),actorId='17824859400',startedAt='2026-09-30T09:00:00.000Z',attemptAt='2026-09-30T09:59:59.000Z';
  f.state.activePromotionId=promo;f.state.activePromotionUrl=f.promotionConfig.url;f.state.lastAccountAttemptAt=attemptAt;
  f.state.records[actorId]={handle:'one',baseStatus:'needs_reconciliation',bonusStatus:'not_started',
    activePromotionId:promo,startedAt,code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',currentOperation:'follow',
    attemptedOperations:1,results:{primaryPostId:pin}};
  f.state.records['17824859401']={handle:'later',baseStatus:'needs_reconciliation',bonusStatus:'not_started',
    activePromotionId:promo,code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',currentOperation:'like',
    attemptedOperations:2,results:{primaryPostId:pin,follow:{mutationCount:1}}};
  let lockCalls=0;f.options.lock=async task=>{lockCalls++;return task();};
  const discovery=await refreshThreadsBenefitEvidence(f.options);
  assert.equal(lockCalls,1);
  assert.equal(discovery.queue.find(row=>row.id===actorId)?.stage,'base');
  const migrated=f.state.records[actorId];
  assert.equal(migrated.baseStatus,'preflight_blocked');assert.equal(migrated.currentOperation,null);
  assert.equal(migrated.startedAt,startedAt);assert.equal(f.state.lastAccountAttemptAt,attemptAt);
  assert.equal(migrated.preflightFailures[0].failedAt,startedAt);
  assert.equal(migrated.results.follow.mutationCount,0);assert.equal(migrated.results.follow.writeSent,false);
  assert.equal(f.state.records['17824859401'].currentOperation,'like');
  assert.equal(f.state.records['17824859401'].baseStatus,'needs_reconciliation');
  assert.deepEqual(f.calls,[]);
});
