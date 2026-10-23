import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runThreadsBenefitTarget } from '../threads-benefit-runner.mjs';
import { THREADS_BENEFIT_POLICY as P, threadsBenefitStage } from '../threads-benefits.mjs';
import { writeThreadsPublicActor } from '../lib/threads-public-profile-cache.mjs';

const promo='3997530329766474170';
const oldPromo=P.legacyPromotionIds[0];
const actorId='17824859400';
const pin='3983580490905486164';
const extra='3983580490905486165';
const trigger='3983580490905486166';
const ownerId='17824859401';

function makeFixture({followsOwner=true,activeComments=[],engagementActors=[]}={}) {
  let now=Date.parse('2026-10-06T09:00:00.000Z');
  const state={service:'threads',owner:P.owner,policyVersion:P.version,records:{}};
  const calls=[],attempts=[],guardCalls=[],replies=[],saved=[];
  const promotion={id:promo,author:P.owner,url:'https://www.threads.com/@lifehack__ailab/post/Dd6FKe0lLG6',
    text:'참여해 주세요',isReply:false,isPinnedToProfile:true};
  const promotionConfig={owner:P.owner,activePromotionId:promo,url:promotion.url,readbackVerified:true,
    pinReadbackVerified:true,previousPromotionPinRemovedVerified:true,previousPromotionIds:[oldPromo]};
  const post={id:pin,author:'one',text:'오늘은 산책을 했어요',isReply:false,isPinnedToProfile:true,
    publishedAt:'2026-10-06T08:00:00.000Z'};
  const additional={id:extra,author:'one',text:'새로운 책을 읽었어요',isReply:false,isPinnedToProfile:false,
    publishedAt:'2026-10-05T08:00:00.000Z'};
  const actor={id:actorId,username:'one',followsOwner,following:true,outgoingRequest:false,private:false};
  const activeEngagement={postId:promo,activities:{like:engagementActors.map(id=>({id})),
    repost:engagementActors.map(id=>({id})),quote:[]}};
  const emptyOldEngagement={postId:oldPromo,activities:{like:[],repost:[],quote:[]}};
  const context={service:'threads',bundle:{owner:P.owner,ownerId},documentReceipt:{ownerVerified:true,httpStatus:200},
    document:{profiles:[{pk:actorId,username:'one',friendship_status:{followed_by:followsOwner,
      following:true,outgoing_request:false},text_post_app_is_private:false}]}};
  const options={
    state,root:os.tmpdir(),promotionConfig,lock:async task=>task(),saveState:async value=>saved.push(structuredClone(value)),
    now:()=>now,sleep:async()=>true,isStopRequested:async()=>false,
    followersReader:async()=>({followers:followsOwner?[actor]:[],page:{fullList:true}}),
    engagementReader:async id=>id===promo?activeEngagement:emptyOldEngagement,
    commentsReader:async id=>id===promo?{postId:promo,postAuthor:P.owner,comments:activeComments,page:{fullList:true}}
      :id===oldPromo?{postId:oldPromo,postAuthor:P.owner,comments:[],page:{fullList:true}}
        :{postId:id,postAuthor:'one',comments:[],totalDirectReplyCount:0,page:{fullList:true}},
    contextLoader:async()=>context,
    relationshipReader:async()=>({id:actorId,state:{following:true,outgoingRequest:false,blocking:false}}),
    profileReader:async()=>({handle:'one',posts:[post,additional],fullTimeline:true,pinState:'pinned_post_observed',coverage:'fixture'}),
    postReader:async()=>promotion,
    generate:async inputs=>({comments:inputs.map(input=>({accountId:input.accountId,postId:input.post.id,
      postAuthor:input.post.author,comment:'산책을 하며 생각을 정리하는 시간이 좋죠.'})),model:'gpt-6-luna',effort:'low'}),
    follow:async (input,options={})=>{attempts.push('follow');guardCalls.push('follow');await options.beforeWrite?.({});calls.push('follow');return {target:input.target,normalizedTarget:actorId,readbackVerified:true,
      mutationCount:1,currentState:{following:true,outgoingRequest:false}};},
    reaction:async(input,options={})=>{const name=`${input.operation}:${input.postId}`;attempts.push(name);guardCalls.push(name);await options.beforeWrite?.({});calls.push(name);return {...input,target:'one',readbackVerified:true,writes:1,
      currentState:{authorId:actorId,[input.operation==='like'?'liked':'reposted']:true}};},
    reply:async (input,options={})=>{const operation=input.receiptKey?'completion_reply':'contextual_reply';attempts.push(operation);guardCalls.push(operation);
      await options.beforeWrite?.({});replies.push(input);calls.push(`reply:${input.postId}`);return {postId:input.postId,
      parentAuthor:input.expectedAuthor,readbackVerified:true,createdPostId:'3983580490905486170',writes:1};},
  };
  return {state,calls,attempts,guardCalls,replies,saved,options,actor,context,promotion,post,additional,promotionConfig,activeEngagement,
    advance:ms=>{now+=ms;}};
}

function stoppedReactionReceipt(input,error) {
  return {...input,target:'one',status:'not_sent',notSentVerified:true,dispatchStarted:false,writeSent:false,
    writes:0,readbackVerified:false,code:error.code};
}
function stoppedReplyReceipt(error) {
  return {status:'not_sent_verified',success:false,notSentVerified:true,preflightNoDispatch:true,
    preflightStage:'before_write_guard',dispatchStarted:false,writeSent:false,journalCreated:true,
    writes:0,observedWrites:0,code:error.code};
}
function seedVerifiedBase(f) {
  f.options.followersReader=async()=>({followers:[f.actor],page:{fullList:true}});
  f.state.records[actorId]={handle:'one',baseStatus:'verified',bonusStatus:'not_started',activePromotionId:promo,
    pinnedPostId:pin,entrance:'direct_promotion_comment',triggeringPromotionId:promo,triggeringCommentId:trigger,
    qualifyingPostId:promo,legacyQualifyingPromotionIds:[],attemptedOperations:5,
    results:{primaryPostId:pin,follow:{operation:'follow',target:'one',normalizedTarget:actorId,readbackVerified:true,
      mutationCount:1,currentState:{following:true,outgoingRequest:false}},
      like:{operation:'like',postId:pin,target:'one',readbackVerified:true,currentState:{authorId:actorId,liked:true}},
      repost:{operation:'repost',postId:pin,target:'one',readbackVerified:true,currentState:{authorId:actorId,reposted:true}},
      reply:{postId:pin,parentAuthor:'one',readbackVerified:true,createdPostId:'3983580490905486170'}}};
  return f.state.records[actorId];
}

function seedFollowHistoryHold(f,{entrance='positive_incoming_follow',triggeringCommentId=trigger,
  triggeringPromotionId=promo}={}) {
  f.state.records[actorId]={handle:'one',baseStatus:'follow_verified_reward_held',bonusStatus:'not_started',
    activePromotionId:promo,pinnedPostId:pin,entrance,triggeringCommentId,triggeringPromotionId,
    attemptedOperations:1,results:{primaryPostId:pin,follow:{target:'one',normalizedTarget:actorId,readbackVerified:true,
      status:'no_op',noOp:true,mutationCount:0,currentState:{following:true,outgoingRequest:false}}},
    historyHold:{status:'follow_verified',promotionId:promo,code:'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
      pinnedPostId:pin,followAttemptOperations:1,checkedAt:'2026-10-06T08:00:00.000Z'}};
  return f.state.records[actorId];
}

function positiveReaction(input) {
  return {...input,target:'one',readbackVerified:true,writes:1,
    currentState:{authorId:actorId,[input.operation==='like'?'liked':'reposted']:true}};
}

test('STOP before a history-held reaction keeps the prior verified follow resumable',async()=>{
  const f=makeFixture();seedFollowHistoryHold(f);
  let stopped=false;
  f.options.isStopRequested=async()=>stopped;
  f.options.onWorkProgress=async event=>{if(event.phase==='action_dispatch'&&event.operation==='like')stopped=true;};
  f.options.reaction=async input=>{f.calls.push(input.operation);return positiveReaction(input);};

  const result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);

  assert.equal(result.status,'follow_verified_reward_held');
  assert.equal(result.writeCountUnknown,false);
  assert.equal(result.code,'THREADS_BENEFIT_STOPPED');
  assert.equal(f.state.records[actorId].baseStatus,'follow_verified_reward_held');
  assert.equal(f.state.records[actorId].basicReactions.status,'reserved');
  assert.equal(f.state.records[actorId].currentOperation??null,null);
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(result.noDispatchProof,{status:'not_sent_verified',operation:'like',notSentVerified:true,
    dispatchStarted:false,writeSent:false,writes:0,stopRequested:true,code:'THREADS_BENEFIT_STOPPED'});
});

test('STOP before repost preserves the positive like and resumes only the missing repost',async()=>{
  const f=makeFixture();seedFollowHistoryHold(f);
  let stopOnRepost=true,stopped=false;
  f.options.isStopRequested=async()=>stopped;
  f.options.onWorkProgress=async event=>{
    if(stopOnRepost&&event.phase==='action_dispatch'&&event.operation==='repost')stopped=true;
  };
  f.options.reaction=async(input)=>{f.calls.push(input.operation);return positiveReaction(input);};
  let result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.status,'follow_verified_reward_held');
  assert.equal(result.writes,1);
  assert.equal(result.writeCountUnknown,false);
  assert.equal(f.state.records[actorId].basicReactions.results.like.readbackVerified,true);
  assert.equal(f.state.records[actorId].basicReactions.results.repost,undefined);
  assert.equal(f.state.records[actorId].baseStatus,'follow_verified_reward_held');
  assert.deepEqual(result.noDispatchProof,{status:'not_sent_verified',operation:'repost',notSentVerified:true,
    dispatchStarted:false,writeSent:false,writes:0,stopRequested:true,code:'THREADS_BENEFIT_STOPPED'});

  stopped=false;stopOnRepost=false;f.calls.length=0;f.options.onWorkProgress=async()=>{};
  result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);
  assert.equal(result.basicReactionsVerified,true);
  assert.deepEqual(f.calls,['repost']);
});

test('an exact not-sent reaction receipt remains a known no-write hold, not unknown reconciliation',async()=>{
  const f=makeFixture();seedFollowHistoryHold(f);
  f.options.reaction=async input=>{
    f.calls.push(input.operation);
    return {...input,target:'one',status:'not_sent',notSentVerified:true,writes:0,dispatchStarted:false,writeSent:false,
      readbackVerified:false,code:'THREADS_BENEFIT_STOPPED'};
  };

  const result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);

  assert.equal(result.status,'follow_verified_reward_held');
  assert.equal(result.writeCountUnknown,false);
  assert.equal(result.code,'THREADS_BENEFIT_STOPPED');
  assert.equal(f.state.records[actorId].baseStatus,'follow_verified_reward_held');
  assert.equal(f.state.records[actorId].basicReactions.status,'reserved');
  assert.equal(f.state.records[actorId].basicReactions.results.like,undefined);
  assert.equal(f.state.records[actorId].basicReactions.lastPreflight.notSentVerified,true);
  assert.equal(f.state.records[actorId].currentOperation,null);
  assert.equal(result.noDispatchProof.status,'not_sent_verified');
  assert.equal(result.noDispatchProof.stopRequested,true);
});

test('a direct commenter without an incoming follow qualifies only while the exact saved active comment is freshly observed',async()=>{
  const exactComment={id:trigger,author:'one',authorId:actorId,text:'참여합니다',isReply:true,directParentPostId:promo};
  const f=makeFixture({followsOwner:false,activeComments:[exactComment]});
  seedFollowHistoryHold(f,{entrance:'direct_promotion_comment'});
  f.options.reaction=async input=>{f.calls.push(input.operation);return positiveReaction(input);};

  const result=await runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options);

  assert.equal(result.basicReactionsVerified,true);
  assert.deepEqual(f.calls,['like','repost']);
  assert.equal(f.replies.length,0);
});

test('a stale or mismatched direct-comment entrance cannot waive current incoming-follow proof',async()=>{
  const f=makeFixture({followsOwner:false,activeComments:[{id:'3983580490905486199',author:'one',authorId:actorId,
    text:'다른 댓글',isReply:true,directParentPostId:promo}]});
  seedFollowHistoryHold(f,{entrance:'direct_promotion_comment'});
  f.options.reaction=async input=>{f.calls.push(input.operation);return positiveReaction(input);};

  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true,basicReactionsOnly:true},f.options),
    {code:'THREADS_BENEFIT_ACTOR_UNVERIFIED'});
  assert.deepEqual(f.calls,[]);
});

test('execute revalidates profile and pin without a ten-minute cache hit while prepare may use the cache',async t=>{
  const cacheRoot=await mkdtemp(path.join(os.tmpdir(),'threads-benefit-fresh-profile-'));
  t.after(()=>rm(cacheRoot,{recursive:true,force:true}));
  const stalePin='3983580490905486190',freshPin='3983580490905486191';
  const stalePost={id:stalePin,author:'one',code:'StalePin01',url:'https://www.threads.com/@one/post/StalePin01',
    text:'기존 고정글',isReply:false,isPinnedToProfile:true,publishedAt:'2026-10-06T08:00:00.000Z'};
  const freshPost={id:freshPin,author:'one',code:'FreshPin01',url:'https://www.threads.com/@one/post/FreshPin01',
    text:'새 고정글',isReply:false,isPinnedToProfile:true,publishedAt:'2026-10-06T08:30:00.000Z'};
  const seedCache=async now=>writeThreadsPublicActor({handle:'one',id:actorId,ownerId,
    relationship:{following:false,outgoingRequest:false,blocking:false},followsOwner:true,private:false,
    profile:{handle:'one',posts:[stalePost],fullTimeline:true,pinState:'pinned_post_observed',coverage:'fixture'}},
  {root:cacheRoot,now});

  const prepared=makeFixture();
  prepared.options.actorCacheRoot=cacheRoot;
  let prepareProfileReads=0;
  prepared.options.profileReader=async()=>{prepareProfileReads++;return {handle:'one',posts:[freshPost],fullTimeline:true,
    pinState:'pinned_post_observed',coverage:'fresh-fixture'};};
  await seedCache(Date.parse('2026-10-06T09:00:00.000Z'));
  const draft=await runThreadsBenefitTarget({handle:'one'},prepared.options);
  assert.equal(draft.plan.primary.id,stalePin);
  assert.equal(prepareProfileReads,0,'draft preparation may reuse the bounded public cache');

  const executing=makeFixture();
  executing.options.actorCacheRoot=cacheRoot;
  let executeProfileReads=0;
  executing.options.profileReader=async()=>{executeProfileReads++;return {handle:'one',posts:[freshPost],fullTimeline:true,
    pinState:'pinned_post_observed',coverage:'fresh-fixture'};};
  executing.options.commentsReader=async id=>id===promo?{postId:promo,postAuthor:P.owner,comments:[],page:{fullList:true}}
    :id===oldPromo?{postId:oldPromo,postAuthor:P.owner,comments:[],page:{fullList:true}}
      :{postId:id,postAuthor:'one',comments:[],totalDirectReplyCount:0,page:{fullList:true}};
  await runThreadsBenefitTarget({handle:'one',execute:true},executing.options);
  assert.equal(executeProfileReads,1,'execution must bypass the profile cache');
  assert.equal(executing.calls.includes(`like:${freshPin}`),true);
  assert.equal(executing.calls.includes(`repost:${freshPin}`),true);
  assert.equal(executing.calls.some(call=>call.endsWith(`:${stalePin}`)),false);
});

test('a missing exact active trigger holds the completion reply instead of retargeting to the promotion root',async()=>{
  const f=makeFixture({engagementActors:[actorId]});
  const record=f.state.records[actorId]={handle:'one',baseStatus:'verified',bonusStatus:'not_started',activePromotionId:promo,
    pinnedPostId:pin,entrance:'direct_promotion_comment',triggeringPromotionId:promo,triggeringCommentId:trigger,
    qualifyingPostId:promo,legacyQualifyingPromotionIds:[],attemptedOperations:5,
    results:{primaryPostId:pin,follow:{target:'one',readbackVerified:true,currentState:{following:true}},
      like:{operation:'like',postId:pin,target:'one',readbackVerified:true,currentState:{liked:true}},
      repost:{operation:'repost',postId:pin,target:'one',readbackVerified:true,currentState:{reposted:true}},
      reply:{postId:pin,parentAuthor:'one',readbackVerified:true}}};
  f.options.followersReader=async()=>({followers:[f.actor],page:{fullList:true}});
  f.options.commentsReader=async id=>id===promo?{postId:promo,postAuthor:P.owner,comments:[],page:{fullList:false}}
    :id===oldPromo?{postId:oldPromo,postAuthor:P.owner,comments:[],page:{fullList:true}}
      :{postId:id,postAuthor:'one',comments:[],totalDirectReplyCount:0,page:{fullList:true}};
  f.options.reaction=async input=>{f.calls.push(`${input.operation}:${input.postId}`);return positiveReaction(input);};

  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);

  assert.equal(record.bonusStatus,'verified');
  assert.equal(result.benefitStageVerified,true);
  assert.equal(result.noticeStatus,'held');
  assert.equal(result.code,'THREADS_BENEFIT_TRIGGER_REVERIFY_REQUIRED');
  assert.equal(f.calls.some(call=>call.startsWith('reply:')),false);
  assert.deepEqual(f.calls.filter(call=>call.includes(`:${extra}`)),[`like:${extra}`,`repost:${extra}`]);
  assert.equal(f.replies.length,0);
});

test('typed reply link preflight holds a known no-dispatch base without losing verified actions',async()=>{
  const f=makeFixture();
  f.options.reply=async()=>{throw Object.assign(new Error('THREADS_REPLY_LINK_COUNT_UNSUPPORTED'),{
    code:'THREADS_REPLY_LINK_COUNT_UNSUPPORTED',preflightNoDispatch:true,preflightStage:'link_composition',
    dispatchStarted:false,writeSent:false,journalCreated:false,writes:0});};

  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  const record=f.state.records[actorId];

  assert.equal(result.status,'partial_held');
  assert.equal(result.writeCountUnknown,false);
  assert.equal(result.writes,3);
  assert.equal(result.dispatchStarted,false);
  assert.equal(record.baseStatus,'reply_preflight_held');
  assert.equal(record.currentOperation,null);
  assert.equal(record.results.follow.readbackVerified,true);
  assert.equal(record.results.like.readbackVerified,true);
  assert.equal(record.results.repost.readbackVerified,true);
  assert.equal(record.results.reply,undefined);
  assert.equal(record.replyPreflightHold.preflightNoDispatch,true);
  assert.deepEqual(f.calls,['follow',`like:${pin}`,`repost:${pin}`]);
});

test('reply errors without the exact no-dispatch marker remain unknown and reconciliation-held',async()=>{
  const f=makeFixture();
  f.options.reply=async()=>{throw Object.assign(new Error('unsupported link count'),{
    code:'THREADS_REPLY_LINK_COUNT_UNSUPPORTED',preflightNoDispatch:true,preflightStage:'link_composition',
    dispatchStarted:false});};

  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  const record=f.state.records[actorId];

  assert.equal(result.status,'needs_reconciliation');
  assert.equal(result.writeCountUnknown,true);
  assert.equal(result.code,'THREADS_REPLY_LINK_COUNT_UNSUPPORTED');
  assert.equal(record.baseStatus,'needs_reconciliation');
  assert.equal(record.currentOperation,'contextual_reply');
  assert.equal(record.replyPreflightHold,undefined);
  assert.deepEqual(f.calls,['follow',`like:${pin}`,`repost:${pin}`]);
});

test('plain-text link opt-in reaches only the contextual reply and preserves both producer links',async()=>{
  const f=makeFixture();
  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(result.status,'verified');
  assert.equal(f.replies.length,2);
  assert.equal(f.replies[0].linkMode,'plain_text');
  assert.equal(f.replies[0].message,'산책을 하며 생각을 정리하는 시간이 좋죠.\n\n스하리 기계 도착🚨\n기계는 뒷삭이 없다\n'
    +`반하리 와줘라 ${f.promotionConfig.url}\n\n부수입 정보는 텔레그램에서 👉 https://t.me/lifehack_ailab\n\n스하리 완료🚨`);
  assert.equal(f.replies[1].linkMode,undefined,'completion notices keep the default quote mode');
});

test('a STOP that arrives during normal-base preflight blocks dispatch and resumes only the missing action',async()=>{
  const f=makeFixture();let stopped=false,stopOnLike=true;
  f.options.sleep=async()=>true;
  f.options.isStopRequested=async()=>stopped;
  f.options.reaction=async(input,{beforeWrite}={})=>{
    const name=`${input.operation}:${input.postId}`;f.attempts.push(name);f.guardCalls.push(name);
    if(stopOnLike&&input.operation==='like') {stopOnLike=false;stopped=true;}
    try {await beforeWrite?.({});}
    catch(error) {return stoppedReactionReceipt(input,error);}
    f.calls.push(name);return positiveReaction(input);
  };

  const held=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  const record=f.state.records[actorId];
  assert.equal(held.status,'partial_held');
  assert.equal(held.writeCountUnknown,false);
  assert.equal(held.writes,1);
  assert.equal(record.baseStatus,'preflight_wait');
  assert.equal(record.operationPreflightHold.operation,'like');
  assert.equal(record.results.follow.readbackVerified,true);
  assert.equal(record.results.like,undefined);
  assert.equal(record.currentOperation,null);
  assert.deepEqual(f.calls,['follow'],'the STOP gate prevented the like mutation');
  assert.equal(f.guardCalls.includes('like:'+pin),true);

  stopped=false;f.calls.length=0;f.attempts.length=0;f.guardCalls.length=0;
  const resumed=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  const resumedRecord=f.state.records[actorId];
  assert.equal(resumed.status,'verified');
  assert.deepEqual(f.attempts,['like:'+pin,'repost:'+pin,'contextual_reply','completion_reply']);
  assert.equal(f.calls.includes('follow'),false,'the verified follow receipt was reused');
  assert.equal(resumedRecord.results.like.readbackVerified,true);
  assert.equal(resumedRecord.results.repost.readbackVerified,true);
  assert.equal(resumedRecord.results.reply.readbackVerified,true);
  assert.equal(resumedRecord.operationPreflightHold,undefined);
});

test('a STOP before a bonus repost preserves its like and resumes only that repost',async()=>{
  const exactComment={id:trigger,author:'one',authorId:actorId,text:'참여합니다',isReply:true,directParentPostId:promo};
  const f=makeFixture({activeComments:[exactComment],engagementActors:[actorId]});
  const record=seedVerifiedBase(f);let stopped=false,stopOnRepost=true;
  f.options.sleep=async()=>true;
  f.options.isStopRequested=async()=>stopped;
  f.options.reaction=async(input,{beforeWrite}={})=>{
    const name=`${input.operation}:${input.postId}`;f.attempts.push(name);f.guardCalls.push(name);
    if(stopOnRepost&&input.operation==='repost'&&input.postId===extra) {stopOnRepost=false;stopped=true;}
    try {await beforeWrite?.({});}
    catch(error) {return stoppedReactionReceipt(input,error);}
    f.calls.push(name);return positiveReaction(input);
  };

  const held=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(held.status,'partial_held');
  assert.equal(held.writeCountUnknown,false);
  assert.equal(held.writes,1);
  assert.equal(record.bonusStatus,'preflight_wait');
  assert.equal(record.operationPreflightHold.operation,`bonus_repost_${extra}`);
  assert.equal(record.bonusResults[0].like.readbackVerified,true);
  assert.equal(record.bonusResults[0].repost,undefined);
  assert.deepEqual(f.calls,[`like:${extra}`]);

  stopped=false;f.calls.length=0;f.attempts.length=0;f.guardCalls.length=0;
  const resumed=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  assert.equal(resumed.status,'verified');
  assert.deepEqual(f.attempts,[`repost:${extra}`,'completion_reply']);
  assert.equal(record.bonusResults[0].like.readbackVerified,true);
  assert.equal(record.bonusResults[0].repost.readbackVerified,true);
  assert.equal(record.bonusStatus,'verified');
  assert.equal(record.operationPreflightHold,undefined);
});

test('a STOP before completion reply is reported as held without claiming the notice',async()=>{
  const f=makeFixture();let stopped=false;
  f.options.isStopRequested=async()=>stopped;
  f.options.reply=async(input,{beforeWrite}={})=>{
    const completion=Boolean(input.receiptKey),operation=completion?'completion_reply':'contextual_reply';
    f.attempts.push(operation);f.guardCalls.push(operation);
    if(completion) stopped=true;
    try {await beforeWrite?.({});}
    catch(error) {return stoppedReplyReceipt(error);}
    f.replies.push(input);f.calls.push(`reply:${input.postId}`);
    return {postId:input.postId,parentAuthor:input.expectedAuthor,readbackVerified:true,
      createdPostId:'3983580490905486170',writes:1};
  };

  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  const record=f.state.records[actorId];
  assert.equal(result.status,'benefit_verified_notice_held');
  assert.equal(result.benefitStageVerified,true);
  assert.equal(result.noticeStatus,'held_no_dispatch');
  assert.equal(result.writeCountUnknown,false);
  assert.equal(result.writes,4);
  assert.equal(record.baseStatus,'verified');
  assert.equal(record.notices.base.status,'held_no_dispatch');
  assert.equal(record.notices.base.result.notSentVerified,true);
  assert.equal(record.notices.base.result.journalCreated,true);
  assert.equal(record.operationPreflightHold.stage,'completion');
  assert.equal(record.currentOperation,null);
  assert.equal(f.replies.length,1,'only the contextual pinned-post reply was sent');
  assert.equal(f.calls.includes(`reply:${promo}`),false,'no completion reply was dispatched');
  assert.equal(f.guardCalls.includes('completion_reply'),true);
});

test('a contradictory not-sent claim remains reconciliation-only with the operation reserved',async()=>{
  const f=makeFixture();
  f.options.reaction=async input=>({...input,target:'one',status:'not_sent',notSentVerified:true,
    dispatchStarted:true,writeSent:false,writes:0,readbackVerified:false,code:'THREADS_BENEFIT_STOPPED'});

  const result=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  const record=f.state.records[actorId];
  assert.equal(result.status,'needs_reconciliation');
  assert.equal(result.writeCountUnknown,true);
  assert.equal(record.baseStatus,'needs_reconciliation');
  assert.equal(record.currentOperation,'like');
  assert.equal(record.operationPreflightHold,undefined);
  assert.equal(record.results.like.status,'not_sent');
});

test('a private follow STOP resumes only while the fresh plan remains postless',async()=>{
  const f=makeFixture();
  f.actor.private=true;
  f.context.document.profiles[0].text_post_app_is_private=true;
  f.options.sleep=async()=>true;
  let stopped=false,stopFirstFollow=true,profileReads=0;
  f.options.isStopRequested=async()=>stopped;
  f.options.profileReader=async()=>{profileReads++;return {handle:'one',posts:[f.post],fullTimeline:true,
    pinState:'pinned_post_observed',coverage:'fixture'};};
  f.options.follow=async(input,{beforeWrite}={})=>{
    f.attempts.push('follow');f.guardCalls.push('follow');
    if(stopFirstFollow) {stopFirstFollow=false;stopped=true;}
    try {await beforeWrite?.({});}
    catch(error) {return {service:'threads',operation:'follow',target:input.target,status:'not_sent',
      notSentVerified:true,dispatchStarted:false,writeSent:false,mutationCount:0,code:error.code};}
    f.calls.push('follow');
    return {target:input.target,normalizedTarget:actorId,readbackVerified:true,mutationCount:1,
      currentState:{following:true,outgoingRequest:false}};
  };

  const held=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  let record=f.state.records[actorId];
  assert.equal(held.status,'partial_held');
  assert.equal(held.noDispatchProof.operation,'follow');
  assert.equal(record.baseScope,'follow_only_private');
  assert.equal(record.pinnedPostId,null);
  assert.equal(record.operationPreflightHold.postId,null);
  assert.equal(record.operationPreflightHold.followOnlyScope,'private');
  assert.equal(threadsBenefitStage(record,null,{actorId,activePromotionId:promo}),'base');
  assert.equal(profileReads,0,'a private profile remains postless on its initial read');

  stopped=false;f.actor.private=false;f.context.document.profiles[0].text_post_app_is_private=false;
  await assert.rejects(()=>runThreadsBenefitTarget({handle:'one',execute:true},f.options),
    {code:'THREADS_BENEFIT_OPERATION_RESUME_PLAN_CHANGED'});
  assert.deepEqual(f.calls,[],'a newly visible pin prevents the old private follow hold from dispatching');
  assert.equal(profileReads,1);

  f.actor.private=true;f.context.document.profiles[0].text_post_app_is_private=true;
  const resumed=await runThreadsBenefitTarget({handle:'one',execute:true},f.options);
  record=f.state.records[actorId];
  assert.equal(resumed.status,'verified');
  assert.equal(resumed.scope,'follow_only_private');
  assert.deepEqual(f.calls,['follow']);
  assert.equal(record.results.follow.readbackVerified,true);
  assert.equal(record.operationPreflightHold,undefined);
});
