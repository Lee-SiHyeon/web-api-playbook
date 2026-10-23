import test from 'node:test';
import assert from 'node:assert/strict';
import { samePromotionQualification, threadsBenefitStage, buildThreadsBenefitPlan, observeThreadsRelationships,
  buildThreadsBenefitQueue, THREADS_BENEFIT_POLICY, THREADS_BENEFIT_LEGACY_PROMOTION_ID,
  isVerifiedThreadsFollowHistoryHoldRecord, reserveThreadsStart, threadsQuota, mergeThreadsLegacyEvidence,
  migrateThreadsWriterIdentityPreflightFailures } from '../threads-benefits.mjs';
const ACTIVE='3997000000000000123';
test('bonus requires positive follow and both reactions on the same promotion', () => {
  const snaps = [{ postId:'100',activities:{like:[{id:'1'}],repost:[]} },{postId:'101',activities:{like:[],repost:[{id:'1'}]} }];
  assert.equal(samePromotionQualification('1', true, snaps),null);
  snaps[0].activities.repost.push({id:'1'});
  assert.equal(samePromotionQualification('1', null, snaps),null);
  assert.equal(samePromotionQualification('1',true,snaps),'100');
});
test('quote counts as repost only beside a like on that same promotion',()=>{
  const quoteOnly=[{postId:'100',activities:{like:[{id:'1'}],repost:[],quote:[{id:'1'}]}}];
  assert.equal(samePromotionQualification('1',true,quoteOnly),'100');
  assert.equal(samePromotionQualification('1',false,quoteOnly),null);
  assert.equal(samePromotionQualification('1',null,quoteOnly),null);
  assert.equal(samePromotionQualification('1',true,[
    {postId:'100',activities:{like:[{id:'1'}],repost:[],quote:[]}},
    {postId:'101',activities:{like:[],repost:[],quote:[{id:'1'}]}},
  ]),null,'like and quote on separate promotions must not qualify');
  assert.equal(samePromotionQualification('1',true,[
    {postId:'100',activities:{like:[],repost:[],quote:[{id:'1'}]}},
  ]),null,'a quote without a like must not qualify');
  assert.throws(()=>samePromotionQualification('1',true,[
    {postId:'100',activities:{like:[{id:'1'}],repost:[],quote:{id:'1'}}},
  ]),{code:'THREADS_BENEFIT_PARTICIPATION_INVALID'});
});
test('separate stages retain once-only receipts when returning or qualifying late', () => {
  assert.equal(threadsBenefitStage(null,false),'base');
  assert.equal(threadsBenefitStage({baseStatus:'verified'},false),'waiting_for_participation');
  assert.equal(threadsBenefitStage({baseStatus:'verified'},true),'bonus');
  assert.equal(threadsBenefitStage({baseStatus:'verified',bonusStatus:'reserved'},true),'reconciliation');
  assert.equal(threadsBenefitStage({baseStatus:'verified',bonusStatus:'verified'},true),'complete');
});
test('a zero-dispatch preflight block is base-eligible only with its exact proof and a positive entrance',()=>{
  const record={handle:'member',baseStatus:'preflight_blocked',bonusStatus:'not_started',code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',
    attemptedOperations:1,currentOperation:null,results:{primaryPostId:'101',follow:{operation:'follow',code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',
      status:'preflight_blocked',mutationCount:0,dispatchStarted:false,writeSent:false}}};
  assert.equal(threadsBenefitStage(record,false),'base');
  assert.equal(threadsBenefitStage({...record,results:{...record.results,follow:{...record.results.follow,mutationCount:1}}},false),'reconciliation');
  const empty={followers:[],page:{fullList:false}},comments={postId:ACTIVE,postAuthor:THREADS_BENEFIT_POLICY.owner,
    comments:[],totalDirectReplyCount:0,page:{fullList:false}},engagement={postId:ACTIVE,activities:{like:[],repost:[]}};
  const queue=buildThreadsBenefitQueue({followers:empty,comments,engagement,activePromotionId:ACTIVE,
    state:{records:{'9':record}}});
  assert.equal(queue.queue.length,0);
});
test('a verified follow-only history hold requeues only under its exact actor and active promotion',()=>{
  const record={handle:'member',baseStatus:'follow_verified_reward_held',bonusStatus:'not_started',activePromotionId:ACTIVE,
    entrance:'positive_incoming_follow',pinnedPostId:'101',attemptedOperations:1,
    results:{primaryPostId:'101',follow:{target:'member',normalizedTarget:'1',readbackVerified:true,mutationCount:1,
      currentState:{following:true,outgoingRequest:false}}},
    historyHold:{status:'follow_verified',promotionId:ACTIVE,code:'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
      pinnedPostId:'101',followAttemptOperations:1}};
  assert.equal(isVerifiedThreadsFollowHistoryHoldRecord('1',record,ACTIVE),true);
  assert.equal(threadsBenefitStage(record,null,{actorId:'1',activePromotionId:ACTIVE}),'base');
  const comments={postId:ACTIVE,postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[],totalDirectReplyCount:4,page:{fullList:false}};
  const engagement={postId:ACTIVE,activities:{like:[],repost:[]}};
  const queued=buildThreadsBenefitQueue({followers:{followers:[],page:{fullList:false}},comments,engagement,
    state:{records:{'1':record}},activePromotionId:ACTIVE});
  assert.equal(queued.queue.length,1);
  assert.equal(queued.queue[0].stage,'base');
  assert.equal(queued.queue[0].entrance,'follow_verified_history_hold');
  assert.equal(isVerifiedThreadsFollowHistoryHoldRecord('2',record,ACTIVE),false);
  assert.equal(isVerifiedThreadsFollowHistoryHoldRecord('1',record,'999'),false);
  assert.equal(threadsBenefitStage({...record,results:{...record.results,follow:{...record.results.follow,normalizedTarget:'2'}}},
    null,{actorId:'1',activePromotionId:ACTIVE}),'reconciliation');
});
test('a reserved reaction stage resumes only when no operation crossed the dispatch boundary',()=>{
  const record={handle:'member',baseStatus:'follow_verified_reward_held',bonusStatus:'not_started',activePromotionId:ACTIVE,
    entrance:'positive_incoming_follow',pinnedPostId:'101',attemptedOperations:1,
    results:{primaryPostId:'101',follow:{target:'member',normalizedTarget:'1',readbackVerified:true,mutationCount:1,
      currentState:{following:true,outgoingRequest:false}}},
    historyHold:{status:'follow_verified',promotionId:ACTIVE,code:'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
      pinnedPostId:'101',followAttemptOperations:1},
    basicReactions:{status:'reserved',postId:'101',results:{}}};
  const comments={postId:ACTIVE,postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[],page:{fullList:false}};
  const engagement={postId:ACTIVE,activities:{like:[],repost:[]}};
  const queueFor=value=>buildThreadsBenefitQueue({followers:{followers:[],page:{fullList:false}},comments,engagement,
    state:{records:{'1':value}},activePromotionId:ACTIVE});
  const queued=queueFor(record);
  assert.equal(isVerifiedThreadsFollowHistoryHoldRecord('1',record,ACTIVE),true);
  assert.equal(queued.queue.length,1);assert.equal(queued.queue[0].basicReactionsPending,true);
  const dispatched={...record,currentOperation:'like'};
  assert.equal(isVerifiedThreadsFollowHistoryHoldRecord('1',dispatched,ACTIVE),false);
  assert.equal(queueFor(dispatched).queue.length,0,'a possibly dispatched reaction remains held');
});
test('only the exact first-follow no-dispatch historical record is migrated and original timestamps remain',()=>{
  const startedAt='2026-09-30T08:00:00.000Z',attemptAt='2026-09-30T09:59:59.000Z';
  const state={activePromotionId:ACTIVE,lastAccountAttemptAt:attemptAt,records:{
    '1':{handle:'one',baseStatus:'needs_reconciliation',activePromotionId:ACTIVE,startedAt,
      code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',currentOperation:'follow',attemptedOperations:1,results:{primaryPostId:'101'}},
    '2':{handle:'two',baseStatus:'needs_reconciliation',activePromotionId:ACTIVE,startedAt,
      code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',currentOperation:'follow',attemptedOperations:2,results:{primaryPostId:'101'}},
    '3':{handle:'three',baseStatus:'needs_reconciliation',activePromotionId:ACTIVE,startedAt,
      code:'SOCIAL_WRITER_IDENTITY_UNAVAILABLE',currentOperation:'follow',attemptedOperations:1,results:{primaryPostId:'101'},
      notices:{base:{result:{createdPostId:'102'}}}},
  }};
  assert.equal(migrateThreadsWriterIdentityPreflightFailures(state,{migratedAt:'2026-09-30T10:00:00.000Z'}),true);
  assert.equal(state.records['1'].baseStatus,'preflight_blocked');
  assert.equal(state.records['1'].currentOperation,null);assert.equal(state.records['1'].startedAt,startedAt);
  assert.equal(state.lastAccountAttemptAt,attemptAt);assert.equal(state.records['1'].preflightFailures[0].failedAt,startedAt);
  assert.equal(state.records['2'].currentOperation,'follow');assert.equal(state.records['2'].baseStatus,'needs_reconciliation');
  assert.equal(state.records['3'].currentOperation,'follow');assert.equal(state.records['3'].baseStatus,'needs_reconciliation');
});
test('partial observations cannot manufacture departures; returning members retain rewards', () => {
  const state={records:{'1':{baseStatus:'verified'}}}, user={id:'1',username:'one',followsOwner:true,following:true,outgoingRequest:false};
  const scan={followers:[user],page:{fullList:false}};
  observeThreadsRelationships(state,scan,'2026-09-30T00:00:00Z');
  observeThreadsRelationships(state,{followers:[],page:{fullList:false}},'2026-09-30T01:00:00Z');
  assert.equal(state.relationships['1'].missingScans,0);
  for (const at of ['02','03']) observeThreadsRelationships(state,{followers:[],page:{fullList:true}},`2026-09-30T${at}:00:00Z`);
  assert.equal(state.relationships['1'].visibility,'absent_confirmed');
  assert.equal(state.relationships['1'].followsOwner,true);
  observeThreadsRelationships(state,scan,'2026-09-30T04:00:00Z');
  assert.equal(state.records['1'].baseStatus,'verified');
});
test('bonus plan deduplicates originals, excludes old and current pins, never substitutes a reply for a pin', () => {
  const posts=Array.from({length:14},(_,i)=>({id:String(100+i),author:'one',text:'original',isReply:false,isPinnedToProfile:i===0,publishedAt:'2026-09-30T00:00:00Z'}));
  const plan=buildThreadsBenefitPlan({handle:'one',posts:[...posts,posts[2],{...posts[4],id:'300',isReply:true}],fullTimeline:false},{previousPinId:'101'});
  assert.equal(plan.primary.id,'100'); assert.equal(plan.additional.length,9);
  assert.ok(plan.additional.every(p=>!['100','101','300'].includes(p.id)));
  assert.equal(buildThreadsBenefitPlan({handle:'one',posts:[{...posts[0],isPinnedToProfile:false}]}).primary,null);
});
test('direct promotion commenters enter independently; nested replies and cross-post activity do not', () => {
  const followers={followers:[{id:'1',username:'one',followsOwner:true}],page:{fullList:false}};
  const comments={postId:ACTIVE,postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[
    {id:'200',author:'two',authorId:'2',isReply:true,directParentPostId:ACTIVE},
    {id:'201',author:'legacy_holder',authorId:'4',isReply:true,directParentPostId:ACTIVE},
    {id:'202',author:'nested',authorId:'3',isReply:true,directParentPostId:null}],page:{fullList:false}};
  const engagement={postId:ACTIVE,activities:{like:[],repost:[]}};
  const legacyEngagement={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,
    activities:{like:[{id:'1'},{id:'1'}],repost:[{id:'1'}]}};
  const oldComments={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,postAuthor:THREADS_BENEFIT_POLICY.owner,
    comments:[{id:'210',author:'legacy_holder',authorId:'4',isReply:true,directParentPostId:THREADS_BENEFIT_LEGACY_PROMOTION_ID},
      {id:'211',author:THREADS_BENEFIT_POLICY.owner,text:'스하리 완료',directParentPostId:null},
      {id:'212',author:'old_entrant',authorId:'5',isReply:true,directParentPostId:THREADS_BENEFIT_LEGACY_PROMOTION_ID}],page:{fullList:false}};
  const r=buildThreadsBenefitQueue({followers,comments,engagement,state:{},activePromotionId:ACTIVE,
    previousPromotionIds:[THREADS_BENEFIT_LEGACY_PROMOTION_ID],
    legacyEngagements:[{promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,engagement:legacyEngagement}],
    legacyComments:[{promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,comments:oldComments}]});
  assert.equal(r.queue.length,3);
  assert.equal(r.queue.find(user=>user.handle==='two').stage,'base');
  assert.equal(r.queue.find(user=>user.handle==='two').followsOwner,null);
  assert.equal(r.queue.find(user=>user.handle==='one').qualifyingPostId,THREADS_BENEFIT_LEGACY_PROMOTION_ID);
  assert.deepEqual(r.queue.find(user=>user.handle==='one').legacyQualifyingPromotionIds,[THREADS_BENEFIT_LEGACY_PROMOTION_ID]);
  assert.equal(r.queue.find(user=>user.handle==='old_entrant').entrance,'legacy_direct_promotion_comment');
  assert.equal(r.held.find(user=>user.handle==='legacy_holder').stage,'legacy_review');
  assert.equal(r.legacyEvidence.coverage[0].commentsFullList,false);
  assert.deepEqual(r.legacyEvidence.attemptedPromotionIds,[THREADS_BENEFIT_LEGACY_PROMOTION_ID]);
  assert.throws(()=>buildThreadsBenefitQueue({followers,comments,engagement:{...engagement,postId:'999'},activePromotionId:ACTIVE}),
    {code:'THREADS_BENEFIT_PROMOTION_MISMATCH'});
});
test('hourly stage count is informational only; inter-account pacing remains 20 seconds', () => {
  const now=Date.parse('2026-09-30T00:00:00Z'), state={};
  for(let i=0;i<14;i++) assert.equal(reserveThreadsStart(state,{id:String(i+1),handle:'one',stage:i%2?'base':'bonus'},now+i),true);
  const restored=JSON.parse(JSON.stringify(state));
  assert.equal(reserveThreadsStart(restored,{id:'99',handle:'one',stage:'base'},now+100),true);
  assert.deepEqual(threadsQuota(restored,now+3600010),{remaining:null,used:4,retryAt:null,unlimited:true});
  assert.equal(THREADS_BENEFIT_POLICY.betweenAccountsMilliseconds,20000);
});
test('same-promotion legacy qualification is append-only across later partial empty reads',()=>{
  const follower={id:'9',username:'legacy_pair',followsOwner:true};
  const followers={followers:[follower],page:{fullList:false}};
  const active={postId:ACTIVE,activities:{like:[],repost:[]}};
  const old={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,activities:{like:[{id:'9'}],repost:[{id:'9'}]}};
  const emptyOld={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,activities:{like:[],repost:[]}};
  const comments={postId:ACTIVE,postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[],page:{fullList:false}};
  const legacyComments={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[],page:{fullList:false}};
  const state={records:{}};
  const first=buildThreadsBenefitQueue({followers,comments,engagement:active,activePromotionId:ACTIVE,
    previousPromotionIds:[THREADS_BENEFIT_LEGACY_PROMOTION_ID],
    legacyEngagements:[{promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,engagement:old}],
    legacyComments:[{promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,comments:legacyComments}]});
  mergeThreadsLegacyEvidence(state,first.legacyEvidence);
  assert.deepEqual(state.legacyEvidence.qualifications['9'].promotionIds,[THREADS_BENEFIT_LEGACY_PROMOTION_ID]);
  const second=buildThreadsBenefitQueue({followers,comments,engagement:active,state,activePromotionId:ACTIVE,
    previousPromotionIds:[THREADS_BENEFIT_LEGACY_PROMOTION_ID],
    legacyEngagements:[{promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,engagement:emptyOld}],
    legacyComments:[{promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,comments:legacyComments}]});
  assert.equal(second.queue[0].qualifyingPostId,THREADS_BENEFIT_LEGACY_PROMOTION_ID);
  assert.equal(second.legacyEvidence.coverage[0].commentsFullList,false);
});
test('same-promotion like plus quote evidence remains append-only across later partial empty reads',()=>{
  const followers={followers:[{id:'9',username:'quote_member',followsOwner:true}],page:{fullList:false}};
  const active={postId:ACTIVE,activities:{like:[],repost:[],quote:[]}};
  const old={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,
    activities:{like:[{id:'9'}],repost:[],quote:[{id:'9'}]}};
  const emptyOld={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,
    activities:{like:[],repost:[],quote:[]}};
  const comments={postId:ACTIVE,postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[],page:{fullList:false}};
  const legacyComments={postId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,
    postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[],page:{fullList:false}};
  const options={followers,comments,engagement:active,activePromotionId:ACTIVE,
    previousPromotionIds:[THREADS_BENEFIT_LEGACY_PROMOTION_ID],
    legacyComments:[{promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,comments:legacyComments}]};
  const state={records:{}};
  const first=buildThreadsBenefitQueue({...options,legacyEngagements:[
    {promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,engagement:old}]});
  mergeThreadsLegacyEvidence(state,first.legacyEvidence);
  assert.deepEqual(state.legacyEvidence.qualifications['9'].promotionIds,[THREADS_BENEFIT_LEGACY_PROMOTION_ID]);
  const second=buildThreadsBenefitQueue({...options,state,legacyEngagements:[
    {promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,engagement:emptyOld}]});
  assert.equal(second.queue[0].qualifyingPostId,THREADS_BENEFIT_LEGACY_PROMOTION_ID);
  assert.throws(()=>buildThreadsBenefitQueue({...options,legacyEngagements:[{
    promotionId:THREADS_BENEFIT_LEGACY_PROMOTION_ID,
    engagement:{...old,activities:{...old.activities,quote:{id:'9'}}},
  }]}),{code:'THREADS_BENEFIT_LEGACY_READ_INVALID'});
});
test('a historic owner completion response holds the actor for reconciliation instead of repeating benefits',()=>{
  const followers={followers:[{id:'1',username:'one',followsOwner:true}],page:{fullList:false}};
  const comments={postId:ACTIVE,postAuthor:THREADS_BENEFIT_POLICY.owner,comments:[
    {id:'200',author:'one',authorId:'1',isReply:true,directParentPostId:ACTIVE},
    {id:'201',author:'lifehack__ailab',text:'완료🫡',directParentPostId:null}],page:{fullList:false}};
  const engagement={postId:ACTIVE,activities:{like:[],repost:[]}};
  const r=buildThreadsBenefitQueue({followers,comments,engagement,activePromotionId:ACTIVE});
  assert.equal(r.queue.length,0);assert.equal(r.held[0].stage,'legacy_review');
  assert.equal(r.held[0].legacyResponse.ownerReplyId,'201');
});
