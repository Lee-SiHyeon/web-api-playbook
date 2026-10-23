import { mkdir, readFile, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withSessionLock } from '../tistory-api/lib/lock.mjs';
import { openMetaContext } from './lib/meta-bootstrap.mjs';
import { readMetaRelationship } from './providers/meta.mjs';
import { executeAction } from './index.mjs';
import { readThreadsFollowers, readThreadsEngagement, readThreadsComments, inspectThreadsPost, readThreadsProfileTimeline } from './threads-social.mjs';
import { reactThreads } from './threads-reactions.mjs';
import { replyToThreadsPost } from './threads-reply.mjs';
import { THREADS_BENEFIT_POLICY as POLICY, buildThreadsBenefitQueue, buildThreadsBenefitPlan,
  threadsBenefitStage, samePromotionQualification, observeThreadsRelationships, reserveThreadsStart,
  mergeThreadsLegacyEvidence, migrateThreadsWriterIdentityPreflightFailures,
  markThreadsWriterIdentityPreflightBlocked, THREADS_WRITER_PREFLIGHT_IDENTITY_CODE,
  isVerifiedThreadsFollowHistoryHoldRecord, threadsBasicReactionsVerified, threadsBenefitNoDispatchVerified,
  threadsBenefitOperationPreflightHoldVerified } from './threads-benefits.mjs';
import { threadsBenefitRuntimeRoot, resolveThreadsBenefitConfig, validateThreadsBenefitConfig,
  assertThreadsBenefitPromotionBinding, bindThreadsBenefitPromotion } from './threads-benefit-config.mjs';
import { composeThreadsBenefitReply, composeThreadsCompletionReply } from './threads-benefit-reply.mjs';
import { generateThreadsContextComments } from './threads-ai-reply.mjs';
import { isThreadsGraphqlThrottle } from './lib/threads-graphql-throttle.mjs';
import { readThreadsBenefitPhase } from './lib/threads-read-recovery.mjs';
import { readThreadsPublicActor, writeThreadsPublicActor, threadsPublicProfileCacheRoot } from './lib/threads-public-profile-cache.mjs';
import { threadsStopRequested } from './lib/threads-runtime-control.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code || '') ? error.code : 'THREADS_BENEFIT_FAILED';
const postDigest = post => createHash('sha256').update(JSON.stringify({id:post.id,author:post.author,text:post.text})).digest('hex');
const BATCH_TARGET_LOCAL_PREPARATION_CODES = new Set([
  'THREADS_SOCIAL_COMMENT_ROW_SCHEMA',
  'THREADS_SOCIAL_POST_SCHEMA',
  'THREADS_SOCIAL_PROFILE_POST_SCHEMA',
  'THREADS_SOCIAL_PROFILE_THREAD_SCHEMA',
  'THREADS_SOCIAL_PROFILE_THREAD_ITEM_SCHEMA',
  'THREADS_SOCIAL_PROFILE_POST_CONFLICT',
  'THREADS_SOCIAL_PROFILE_HTTP_404',
  'THREADS_SOCIAL_PROFILE_HTTP_410',
  'THREADS_BENEFIT_PRIMARY_POST_UNVERIFIED',
  'THREADS_BENEFIT_TARGET_INVALID',
  'THREADS_BENEFIT_ACTOR_UNVERIFIED',
  'THREADS_BENEFIT_ACTOR_AMBIGUOUS',
  'THREADS_BENEFIT_ACTOR_MISMATCH',
  'THREADS_BENEFIT_HANDLE_CHANGED_REVIEW_REQUIRED',
  'THREADS_BENEFIT_LEGACY_TRIGGER_REVERIFY_REQUIRED',
  'THREADS_BENEFIT_ENTRANCE_NOT_OBSERVED',
  'THREADS_BENEFIT_COMMENT_ACTOR_MISMATCH',
  'THREADS_BENEFIT_COMMENT_IDENTITY_UNVERIFIED',
  'THREADS_BENEFIT_TRIGGER_REVERIFY_REQUIRED',
  'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
  'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED',
]);
const KNOWN_FOLLOWBACK_SCAN_LIMIT = 20;
export const BENEFIT_PROFILE_POST_LIMIT = 12;
function isTargetLocalBatchPreparationError(error) {
  const code=safeCode(error), status=Number(error?.httpStatus);
  if([401,403,429].includes(status) || /(?:AUTH|LOGIN|CHALLENGE|CHECKPOINT|CAPTCHA|REAUTH|SESSION_REJECTED|OWNER_UNVERIFIED|INTERACTION_REQUIRED|BOOTSTRAP_REQUIRED)/i.test(code)
    || /(?:^|_)HTTP_(?:401|403|429)$/.test(code)) return false;
  return BATCH_TARGET_LOCAL_PREPARATION_CODES.has(code);
}
function skippedBatchTarget(candidate, code) {
  return {
    id: /^\d{1,25}$/.test(String(candidate?.id ?? '')) ? String(candidate.id) : null,
    handle: /^[A-Za-z0-9_.]{1,30}$/.test(candidate?.handle || '') ? candidate.handle.toLowerCase() : null,
    stage: candidate?.stage === 'base' ? 'base' : 'unknown',
    code: /^[A-Z][A-Z0-9_]{2,100}$/.test(code || '') ? code : 'THREADS_BENEFIT_TARGET_PREPARATION_HELD',
  };
}
const runtimeRoot = threadsBenefitRuntimeRoot;
async function readState(root) {
  try {
    const raw = await readFile(path.join(root,'state.json'),'utf8');
    if (raw.length > 5_000_000) fail('THREADS_BENEFIT_STATE_INVALID');
    const state = JSON.parse(raw);
    if (state.service !== 'threads' || state.owner !== POLICY.owner || state.policyVersion !== POLICY.version
      || !state.records || typeof state.records !== 'object') fail('THREADS_BENEFIT_STATE_INVALID');
    return state;
  } catch(error) {
    if (error.code === 'ENOENT') return { service:'threads',owner:POLICY.owner,policyVersion:POLICY.version,records:{} };
    throw error;
  }
}
async function saveState(root, state) {
  await mkdir(root,{recursive:true});
  const file = path.join(root,'state.json'), temporary = file + '.' + randomUUID() + '.tmp';
  const handle=await open(temporary,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(state,null,2)+'\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary,file);
}
export async function discoverThreadsBenefits(state = {}, {
  followersReader=readThreadsFollowers, engagementReader=readThreadsEngagement, commentsReader=readThreadsComments,
  promotionConfig, root, readFileFn, postReader=inspectThreadsPost,
  contextLoader=openMetaContext, relationshipReader=readMetaRelationship,
  now=Date.now, onDiscoveryProgress=async()=>{},
} = {}) {
  const config=await resolveThreadsBenefitConfig({promotionConfig,root,readFileFn});
  assertThreadsBenefitPromotionBinding(state,config);
  let completedReads=0;
  const phase=async name=>onDiscoveryProgress({phase:name,completedReads});
  await phase('promotion');
  const promotion=await verifyThreadsActivePromotion(config,{postReader});
  completedReads++; await phase('followers');
  // Keep all account reads sequential so credential rotation stays ordered.
  const followers=await followersReader();
  completedReads++; await phase('known_followbacks');
  const followback=await augmentTrackedFollowbacks(followers,state,{contextLoader,relationshipReader,now});
  completedReads++; await phase('active_engagement');
  const engagement=await engagementReader(config.activePromotionId);
  completedReads++; await phase('active_comments');
  // Discovery needs positive current entrances, not absence proof. Keep its
  // recurring window bounded; deeper traversal is reserved for target history.
  const comments=await commentsReader(config.activePromotionId,{expectedAuthor:config.owner,maxPages:1});
  completedReads++;
  if(engagement?.postId!==config.activePromotionId || comments?.postId!==config.activePromotionId
    || String(comments?.postAuthor??comments?.author??'').toLowerCase()!==config.owner.toLowerCase()) {
    fail('THREADS_BENEFIT_ACTIVE_PROMOTION_READBACK_MISMATCH');
  }
  const legacyEngagements=[],legacyComments=[];
  for(const promotionId of config.previousPromotionIds) {
    await phase('legacy_engagement');
    const previousEngagement=await engagementReader(promotionId);
    completedReads++;
    if(previousEngagement?.postId!==promotionId) fail('THREADS_BENEFIT_LEGACY_READ_INVALID');
    legacyEngagements.push({promotionId,engagement:previousEngagement});
    await phase('legacy_comments');
    const previousComments=await commentsReader(promotionId,{expectedAuthor:config.owner,maxPages:1});
    completedReads++;
    if(previousComments?.postId!==promotionId
      || String(previousComments?.postAuthor??previousComments?.author??'').toLowerCase()!==config.owner.toLowerCase()) {
      fail('THREADS_BENEFIT_LEGACY_READ_INVALID');
    }
    legacyComments.push({promotionId,comments:previousComments});
  }
  await phase('queue_build');
  const checkedAt=new Date(now()).toISOString();
  const queue=buildThreadsBenefitQueue({followers:followback.followers,engagement,comments,state,activePromotionId:config.activePromotionId,
    previousPromotionIds:config.previousPromotionIds,legacyEngagements,legacyComments});
  mergeThreadsLegacyEvidence(state,queue.legacyEvidence);
  const freshlyChecked=followback.followers.followers.filter(user=>followback.freshPositiveIds?.includes(user.id));
  observeThreadsRelationships(state,{...followback.followers,followers:[...followers.followers,...freshlyChecked]},checkedAt);
  const legacyEvidence={...queue.legacyEvidence,checkedAt};
  return {...queue,checkedAt,followers:followback.followers,rawFollowers:followers,followbackScan:followback.scan,
    engagement,comments,legacyEngagements,legacyComments,legacyEvidence,
    freshFollowbackPositiveIds:followback.freshPositiveIds||[],
    promotionConfig:config,activePromotionId:config.activePromotionId,promotion};
}

export async function refreshThreadsBenefitEvidence(options={}) {
  const root=options.root||runtimeRoot(),deps={...defaults,...options,root};
  await mkdir(root,{recursive:true});
  const lock=options.lock||((task)=>withSessionLock(task,{lockPath:path.join(root,'coordinator.lock'),timeoutMs:600000}));
  await deps.onDiscoveryProgress?.({phase:'state_lock',completedReads:0});
  return lock(async()=>{
    await deps.onDiscoveryProgress?.({phase:'state_read',completedReads:0});
    const state=options.state||await readState(root);
    if(migrateThreadsWriterIdentityPreflightFailures(state)) {
      const persist=options.saveState||((value)=>saveState(root,value));
      await persist(state);
    }
    const discovery=await discoverThreadsBenefits(state,deps);
    const persist=options.saveState||((value)=>saveState(root,value));
    await persist(state);
    return {...discovery,legacyEvidencePersisted:true};
  });
}

function comparableThreadsUrl(value) {
  try { const url=new URL(value);url.pathname=url.pathname.replace(/\/$/,'');return url.href; } catch { return ''; }
}

export async function verifyThreadsActivePromotion(promotionConfig, {postReader=inspectThreadsPost}={}) {
  const config=validateThreadsBenefitConfig(promotionConfig);
  const post=await postReader({postId:config.activePromotionId,expectedAuthor:config.owner});
  if(String(post?.id??'')!==config.activePromotionId
    || String(post?.author??'').toLowerCase()!==config.owner.toLowerCase()
    || post?.isReply!==false || post?.isPinnedToProfile!==true
    || comparableThreadsUrl(post?.url)!==comparableThreadsUrl(config.url)) {
    fail('THREADS_BENEFIT_ACTIVE_PROMOTION_READBACK_MISMATCH');
  }
  return post;
}
async function readActor(handle, deps) {
  if (deps.actorCacheRoot) {
    const cached = await readThreadsPublicActor(handle, { root: deps.actorCacheRoot, now: deps.now() });
    if (cached?.profile) return { id: cached.id, followsOwner: cached.followsOwner, private: cached.private,
      relationship: cached.relationship, profile: cached.profile };
  }
  const context=await deps.contextLoader('threads',handle);
  if (context?.service !== 'threads' || context.bundle?.owner !== POLICY.owner || context.documentReceipt?.ownerVerified !== true) fail('THREADS_BENEFIT_OWNER_UNVERIFIED');
  // A successful owner bootstrap can omit this member's relationship data.
  // Hold that actor before the shared reader raises META_TARGET_NOT_FOUND.
  if(context.documentReceipt.httpStatus===200 && Array.isArray(context.document?.profiles)
    && !context.document.profiles.some(row=>typeof row?.friendship_status?.following==='boolean'
      && typeof row?.friendship_status?.outgoing_request==='boolean')) fail('THREADS_BENEFIT_ACTOR_UNVERIFIED');
  const relationship=await deps.relationshipReader(context);
  const rows=context.document.profiles.filter(row=>String(row.pk??row.id)===relationship.id && row.username?.toLowerCase()===handle.toLowerCase());
  if (!rows.length) fail('THREADS_BENEFIT_ACTOR_UNVERIFIED');
  const followed=rows.map(row=>row.friendship_status?.followed_by).filter(v=>typeof v==='boolean');
  if (new Set(followed).size>1) fail('THREADS_BENEFIT_ACTOR_AMBIGUOUS');
  const privacy=rows.map(row=>row.text_post_app_is_private??row.is_private).filter(v=>typeof v==='boolean');
  if (new Set(privacy).size>1) fail('THREADS_BENEFIT_ACTOR_AMBIGUOUS');
  const privateAccount=privacy.length ? privacy[0] : null;
  const profile=privateAccount===true ? {handle,posts:[],fullTimeline:false,coverage:'private_profile_not_read'}
    // The plan uses the pin plus at most 9 recent originals, so 12 posts suffice; the reader's default of 30
    // cost 6-8 timeline pages per actor (2026-10-02), a large share of the 300/h read budget.
    : await deps.profileReader({handle,limit:BENEFIT_PROFILE_POST_LIMIT},{context});
  const actor = {id:relationship.id, followsOwner:followed.length?followed[0]:null, private:privateAccount,
    relationship:relationship.state,profile};
  if (deps.actorCacheRoot) await writeThreadsPublicActor({ handle, id: actor.id, ownerId: context.bundle.ownerId,
    relationship: actor.relationship, followsOwner: actor.followsOwner, private: actor.private, profile: actor.profile },
  { root: deps.actorCacheRoot, now: deps.now() });
  return actor;
}
function validStableActorId(value) { return typeof value==='string' && /^\d{1,25}$/.test(value); }
function currentFollowHistoryHold(actorId,record,activePromotionId,currentRelationship) {
  return isVerifiedThreadsFollowHistoryHoldRecord(actorId,record,activePromotionId)
    && currentRelationship?.following===true && currentRelationship?.outgoingRequest===false;
}
function alreadyVerifiedNoOpHistoryFollow(actorId,record,activePromotionId,currentRelationship) {
  const receipt=record?.results?.follow;
  return currentFollowHistoryHold(actorId,record,activePromotionId,currentRelationship)
    && receipt?.mutationCount===0 && receipt?.noOp===true && receipt?.status==='no_op';
}
function trackedVerifiedFollowReceipts(state) {
  const existing=Object.entries(state?.records||{}).flatMap(([actorId,record])=>{
    const handle=typeof record?.handle==='string'&&/^[A-Za-z0-9_.]{1,30}$/.test(record.handle)?record.handle.toLowerCase():null;
    const receipt=record?.results?.follow, current=receipt?.currentState;
    const confirmedFollow=receipt?.mutationCount===1
      ||receipt?.mutationCount===0&&receipt?.noOp===true&&receipt?.status==='no_op';
    if(!validStableActorId(actorId)||!handle||record.baseStatus!=='verified'
      ||record.bonusStatus==='verified'||(record.bonusStatus&&record.bonusStatus!=='not_started')
      ||receipt?.readbackVerified!==true||receipt?.normalizedTarget!==actorId
      ||receipt?.target?.toLowerCase?.()!==handle||!confirmedFollow
      ||current?.following!==true||current?.outgoingRequest===true) return [];
    return [{id:actorId,handle}];
  });
  const byId=new Map(existing.map(actor=>[actor.id,actor]));
  for(const [actorId,record] of Object.entries(state?.outreachFollows||{})) {
    const handle=typeof record?.handle==='string'&&/^[A-Za-z0-9_.]{1,30}$/.test(record.handle)?record.handle.toLowerCase():null;
    const receipt=record?.result,current=receipt?.currentState;
    if(!validStableActorId(actorId)||!handle||record.actorId!==actorId||record.source!=='outreach_invitation'
      ||record.readbackVerified!==true||receipt?.success!==true||receipt?.readbackVerified!==true
      ||receipt?.normalizedTarget!==actorId||receipt?.target?.toLowerCase?.()!==handle
      ||current?.following!==true||current?.outgoingRequest!==false
      ||state.records?.[actorId]?.bonusStatus==='verified') continue;
    if(!byId.has(actorId))byId.set(actorId,{id:actorId,handle});
  }
  return [...byId.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
function trackedActorReadHold(error) {
  const code=safeCode(error);
  if(error?.httpStatus===429||error?.httpStatus===401||error?.httpStatus===403
    ||/(?:AUTH|LOGIN|CHALLENGE|CHECKPOINT|CAPTCHA|REAUTH|SESSION_REJECTED|OWNER_UNVERIFIED|INTERACTION_REQUIRED|BOOTSTRAP_REQUIRED)/i.test(code)
    ||/(?:^|_)HTTP_(?:401|403|429)$/.test(code)) return false;
  return ['THREADS_BENEFIT_ACTOR_UNVERIFIED','THREADS_BENEFIT_ACTOR_AMBIGUOUS',
    'THREADS_SOCIAL_HTTP_404','THREADS_SOCIAL_HTTP_410','META_TARGET_NOT_FOUND',
    'META_PROFILE_STATE_AMBIGUOUS','META_RELATIONSHIP_UNVERIFIED'].includes(code);
}
async function readTrackedFollowback(actor,{contextLoader,relationshipReader}) {
  const context=await contextLoader('threads',actor.handle);
  if(context?.service!=='threads'||context.bundle?.owner!==POLICY.owner||context.documentReceipt?.ownerVerified!==true) {
    fail('THREADS_BENEFIT_OWNER_UNVERIFIED');
  }
  const relationship=await relationshipReader(context);
  if(!validStableActorId(relationship?.id)||relationship.id!==actor.id) fail('THREADS_BENEFIT_ACTOR_UNVERIFIED');
  const rows=(Array.isArray(context.document?.profiles)?context.document.profiles:[])
    .filter(row=>String(row?.pk??row?.id)===actor.id&&row?.username?.toLowerCase()===actor.handle);
  if(!rows.length) fail('THREADS_BENEFIT_ACTOR_UNVERIFIED');
  const statuses=rows.map(row=>row.friendship_status?.followed_by).filter(value=>typeof value==='boolean');
  if(new Set(statuses).size>1) fail('THREADS_BENEFIT_ACTOR_AMBIGUOUS');
  return statuses.length?statuses[0]:null;
}
// A tracked actor's follow-back answer is reused for this long. Discovery runs
// several times per cycle (poll, per-target revalidation, after-base), so
// without it the same profiles were re-fetched every ~2 minutes.
export const KNOWN_FOLLOWBACK_RECHECK_MS=30*60_000;
function cachedTrackedFollowback(state,actor,now) {
  const row=state.followbackChecks?.[actor.id];
  const at=Date.parse(row?.checkedAt||'');
  if(!row||row.handle!==actor.handle||!Number.isFinite(at)||at>now||now-at>=KNOWN_FOLLOWBACK_RECHECK_MS) return null;
  return ['positive','negative','unknown','held'].includes(row.result)?row:null;
}
async function augmentTrackedFollowbacks(followers,state,deps) {
  if(!Array.isArray(followers?.followers)||!followers.page) fail('THREADS_BENEFIT_SCAN_INVALID');
  const now=(deps.now||Date.now)();
  const scan={checkedAt:new Date(now).toISOString(),eligible:0,alreadyVisible:0,scanned:0,cached:0,positive:0,
    deferred:0,held:[],limit:KNOWN_FOLLOWBACK_SCAN_LIMIT,lastScannedActorId:null,
    coverage:'bounded_rotating_known_verified_follow_receipts'};
  const known=trackedVerifiedFollowReceipts(state);
  scan.eligible=known.length;
  const existingById=new Map(followers.followers.map(row=>[row.id,row]));
  scan.alreadyVisible=known.filter(actor=>existingById.has(actor.id)).length;
  if(followers.page.fullList===true) {
    state.followbackScan=scan;
    return {followers,scan,freshPositiveIds:[]};
  }
  const candidates=known.filter(actor=>!existingById.has(actor.id));
  if(!candidates.length) { state.followbackScan=scan; return {followers,scan,freshPositiveIds:[]}; }
  const priorCursor=state.followbackScan?.lastScannedActorId;
  const afterCursor=candidates.findIndex(row=>row.id>priorCursor);
  const start=afterCursor<0?0:afterCursor;
  const rotated=[...candidates.slice(start),...candidates.slice(0,start)];
  const augmented=[...followers.followers];
  const checks={},freshPositiveIds=[];
  const apply=(actor,result,code,{cached=false}={})=>{
    if(result==='positive') {
      const handleConflict=augmented.find(row=>row.username?.toLowerCase()===actor.handle&&row.id!==actor.id);
      if(handleConflict) { scan.held.push({id:actor.id,handle:actor.handle,code:'THREADS_BENEFIT_ACTOR_MISMATCH'}); return; }
      augmented.push({id:actor.id,username:actor.handle,followsOwner:true,private:null,
        source:cached?'tracked_followback_cached':'tracked_followback_profile_read'});
      if(!cached) freshPositiveIds.push(actor.id);
      scan.positive++;
    } else if(result==='unknown') scan.held.push({id:actor.id,handle:actor.handle,code:'THREADS_BENEFIT_FOLLOWBACK_UNKNOWN'});
    else if(result==='held') scan.held.push({id:actor.id,handle:actor.handle,code});
  };
  // Recently answered actors are applied from state; the read slots go to the
  // actors whose answer is missing or older than the recheck interval.
  for(const actor of rotated) {
    const cached=cachedTrackedFollowback(state,actor,now);
    if(cached) { scan.cached++;checks[actor.id]=cached;apply(actor,cached.result,cached.code,{cached:true});continue; }
    if(scan.scanned>=KNOWN_FOLLOWBACK_SCAN_LIMIT) { scan.deferred++;continue; }
    scan.scanned++;scan.lastScannedActorId=actor.id;
    let result,code;
    try {
      const followsOwner=await readTrackedFollowback(actor,deps);
      result=followsOwner===true?'positive':followsOwner===null?'unknown':'negative';
    } catch(error) {
      if(!trackedActorReadHold(error)) throw error;
      result='held';code=safeCode(error);
    }
    checks[actor.id]={handle:actor.handle,result,...(code?{code}:{}),checkedAt:new Date(now).toISOString()};
    apply(actor,result,code);
  }
  // Keep only answers for actors that are still tracked candidates.
  state.followbackChecks=checks;
  scan.lastScannedActorId??=priorCursor||null;
  state.followbackScan=scan;
  return {followers:{...followers,followers:augmented,followbackScan:scan},scan,freshPositiveIds};
}
const defaults = {
  contextLoader:openMetaContext,relationshipReader:readMetaRelationship,profileReader:readThreadsProfileTimeline,
  actorCacheRoot:process.env.NODE_TEST_CONTEXT ? null : threadsPublicProfileCacheRoot(),
  postReader:inspectThreadsPost,commentsReader:readThreadsComments,followersReader:readThreadsFollowers,
  engagementReader:readThreadsEngagement,follow:executeAction,reaction:reactThreads,reply:replyToThreadsPost,
  generate:generateThreadsContextComments,now:()=>Date.now(),
};
export async function prepareThreadsBenefitTarget(handle, state={}, dependencies={}) {
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle||'') || handle.toLowerCase()===POLICY.owner) fail('THREADS_BENEFIT_TARGET_INVALID');
  handle=handle.toLowerCase();
  const deps={...defaults,...dependencies};
  const discovery=dependencies.discovery||await discoverThreadsBenefits(state,deps);
  const config=discovery.promotionConfig||await resolveThreadsBenefitConfig({promotionConfig:dependencies.promotionConfig,
    root:dependencies.root,readFileFn:dependencies.readFileFn});
  assertThreadsBenefitPromotionBinding(state,config);
  // Retained records remain visible for a delayed bonus or reconciliation, even when absent from a partial page.
  const incoming=discovery.queue.find(user=>user.handle.toLowerCase()===handle.toLowerCase());
  let comment=discovery.comments.comments.find(c=>c.author.toLowerCase()===handle.toLowerCase()
    && c.directParentPostId===config.activePromotionId && c.isReply===true) || null;
  const legacyCandidate=incoming?.entrance==='legacy_direct_promotion_comment'
    ? discovery.legacyComments.find(row=>row.promotionId===incoming.commentPromotionId)?.comments.comments.find(c=>
      c.id===incoming.commentId && c.author.toLowerCase()===handle.toLowerCase()
      && c.directParentPostId===incoming.commentPromotionId && c.isReply===true)
    : null;
  const actor=await readActor(handle,deps);
  const freshIncoming=discovery.rawFollowers?.followers?.some(u=>u.id===actor.id&&u.followsOwner===true)
    ||discovery.freshFollowbackPositiveIds?.includes(actor.id)===true;
  const positiveFollow=actor.followsOwner===true || actor.followsOwner===null && freshIncoming;
  if (incoming?.id && incoming.id!==actor.id) fail('THREADS_BENEFIT_ACTOR_MISMATCH');
  const record=state.records?.[actor.id];
  if (record && record.handle.toLowerCase()!==handle.toLowerCase()) fail('THREADS_BENEFIT_HANDLE_CHANGED_REVIEW_REQUIRED');
  const persistedHistoryHold=isVerifiedThreadsFollowHistoryHoldRecord(actor.id,record,config.activePromotionId);
  if(incoming?.entrance==='legacy_direct_promotion_comment'
    && (!legacyCandidate || String(legacyCandidate.authorId??'')!==actor.id)) fail('THREADS_BENEFIT_LEGACY_TRIGGER_REVERIFY_REQUIRED');
  if (!positiveFollow && !comment && !legacyCandidate && !persistedHistoryHold) fail('THREADS_BENEFIT_ENTRANCE_NOT_OBSERVED');
  const activeDirectEntrance=record?.entrance==='direct_promotion_comment' && record.activePromotionId===config.activePromotionId;
  const storedActiveTrigger=Boolean(record?.triggeringCommentId && record.triggeringPromotionId===config.activePromotionId);
  if(storedActiveTrigger) {
    comment=discovery.comments.comments.find(c=>c.id===record.triggeringCommentId && c.author.toLowerCase()===handle.toLowerCase()
      && c.directParentPostId===config.activePromotionId && c.isReply===true) || null;
  }
  if(comment && (!comment.authorId || comment.authorId!==actor.id)) fail('THREADS_BENEFIT_COMMENT_IDENTITY_UNVERIFIED');
  const followsForQualification=positiveFollow?true:actor.followsOwner;
  const activeQualifyingPostId=samePromotionQualification(actor.id,followsForQualification,[discovery.engagement]);
  const persistedLegacy=state.legacyEvidence?.qualifications?.[actor.id]?.promotionIds||[];
  const currentLegacy=(discovery.legacyEngagements||[]).filter(row=>config.previousPromotionIds.includes(row.promotionId)
    && samePromotionQualification(actor.id,followsForQualification,[row.engagement])===row.promotionId)
    .map(row=>row.promotionId);
  const legacyQualifyingPromotionIds=followsForQualification===true
    ? [...new Set([...persistedLegacy,...currentLegacy])].filter(id=>config.previousPromotionIds.includes(id)) : [];
  const qualifyingPostId=activeQualifyingPostId||legacyQualifyingPromotionIds[0]||null;
  const legacyResponse=discovery.held.find(row=>row.handle.toLowerCase()===handle.toLowerCase() && row.stage==='legacy_review')?.legacyResponse;
  const persistedLegacyResponse=state.legacyEvidence?.completionResponses?.[actor.id]?.responses?.[0];
  const stage=!record&&(legacyResponse||persistedLegacyResponse)?'legacy_review':threadsBenefitStage(record,qualifyingPostId,
    {actorId:actor.id,activePromotionId:config.activePromotionId});
  let completionNoticeHoldCode=null;
  if((storedActiveTrigger || activeDirectEntrance) && !comment) {
    const verifiedBonus=stage==='bonus' && positiveFollow===true
      && typeof qualifyingPostId==='string'
      && [config.activePromotionId,...config.previousPromotionIds].includes(qualifyingPostId);
    if(!verifiedBonus && !persistedHistoryHold) fail('THREADS_BENEFIT_TRIGGER_REVERIFY_REQUIRED');
    // The exact active trigger is no longer observed. Never redirect its promised
    // completion response to the announcement root; the benefit stage can still finish.
    completionNoticeHoldCode='THREADS_BENEFIT_TRIGGER_REVERIFY_REQUIRED';
    comment=null;
  }
  const plan=buildThreadsBenefitPlan(actor.profile,{previousPinId:record?.pinnedPostId,now:deps.now()});
  if(stage==='base' && actor.private!==true && plan.primaryUnavailableReason) fail('THREADS_BENEFIT_PRIMARY_POST_UNVERIFIED');
  const promotion=discovery.promotion;
  // A known earlier owner comment prevents a second contextual comment. Unknown scan absence is not a proof of no historic reward.
  let priorOwnerReply=false;
  if (stage==='base' && plan.primary) {
    const pinComments=await deps.commentsReader(plan.primary.id,{expectedAuthor:handle});
    const observedOwner=pinComments.comments.some(c=>c.author.toLowerCase()===POLICY.owner && c.directParentPostId===plan.primary.id);
    priorOwnerReply=observedOwner ? true : pinComments.page.fullList===true ? false : null;
  }
  const entrance=comment?'direct_promotion_comment':legacyCandidate?'legacy_direct_promotion_comment'
    :persistedHistoryHold?record.entrance:'positive_incoming_follow';
  const followOnlyEligible=validStableActorId(actor.id)
    && (positiveFollow || Boolean(comment) || Boolean(legacyCandidate) || persistedHistoryHold)
    && ['positive_incoming_follow','direct_promotion_comment','legacy_direct_promotion_comment'].includes(entrance);
  return {user:{id:actor.id,handle,followsOwner:positiveFollow?true:actor.followsOwner,private:actor.private,protected:actor.private,
      stage,qualifyingPostId,activeQualifyingPostId,legacyQualifyingPromotionIds,activePromotionId:config.activePromotionId,
      entrance,
      commentId:comment?.id||legacyCandidate?.id||null},
    currentRelationship:{following:actor.relationship?.following,outgoingRequest:actor.relationship?.outgoingRequest},
    plan,promotion,promotionConfig:config,activePromotionId:config.activePromotionId,
    triggeringComment:comment?{...comment,postId:config.activePromotionId}:null,
    followOnlyEligible,
    ...(completionNoticeHoldCode?{completionNoticeHoldCode}:{}),
    priorOwnerReply,legacyResponse:legacyResponse||persistedLegacyResponse||null,legacyEvidence:discovery.legacyEvidence,
    coverage:discovery.coverage,preparedAt:new Date(deps.now()).toISOString(),writes:0};
}
function safeRateLimit(error) {
  const throttle = isThreadsGraphqlThrottle(error) ? error.receipt || error : null;
  return {
    ...(throttle ? { retryAt: throttle.retryAt, deadlineSource: throttle.deadlineSource,
      operation: throttle.operation, consecutiveThrottles: throttle.consecutiveThrottles,
      fallbackMilliseconds: throttle.fallbackMilliseconds } : {}),
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599
      ? { httpStatus: error.httpStatus } : {}),
    ...(Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 && error.retryAfterSeconds <= 86_400
      ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(Number.isSafeInteger(error?.rateLimitReset) && error.rateLimitReset > 0 && error.rateLimitReset <= 99_999_999_999_999
      ? { rateLimitReset: error.rateLimitReset } : {}),
  };
}
function mustVerify(result, fallbackCode) {
  if (result?.readbackVerified!==true) {
    const returnedCode=safeCode({code:result?.code});
    const error=Object.assign(new Error(),{code:returnedCode==='THREADS_BENEFIT_FAILED'?fallbackCode:returnedCode});
    Object.assign(error,safeRateLimit(result));
    throw error;
  }
  return result;
}
function countWrites(result) { return Number(result?.writes??result?.mutationCount??0); }
function verifiedOperationFollow(actorId,handle,receipt,currentRelationship) {
  const confirmed=receipt?.mutationCount===1||receipt?.mutationCount===0&&receipt?.noOp===true&&receipt?.status==='no_op';
  return receipt?.readbackVerified===true&&receipt?.normalizedTarget===actorId
    &&receipt?.target?.toLowerCase?.()===handle&&confirmed
    &&receipt?.currentState?.following===true&&receipt.currentState.outgoingRequest!==true
    &&currentRelationship?.following===true&&currentRelationship?.outgoingRequest===false;
}
function verifiedOperationReaction(actorId,handle,postId,operation,receipt) {
  return receipt?.readbackVerified===true&&receipt.operation===operation&&receipt.postId===postId
    &&receipt.target===handle&&receipt.currentState?.authorId===actorId
    &&receipt.currentState[operation==='like'?'liked':'reposted']===true;
}
function validResumeDraft(record,handle,postId) {
  const draft=record?.contextDraft;
  return draft?.postId===postId&&draft.postAuthor?.toLowerCase?.()===handle
    &&typeof draft.comment==='string'&&draft.comment.trim().length>0&&[...draft.comment].length<=300;
}
function sameIds(left,right) {
  return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length
    &&left.every((id,index)=>id===right[index]);
}
export async function prepareThreadsBenefitBatch({limit,candidateIds}={}, options={}) {
  if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1)) fail('THREADS_BENEFIT_BATCH_INVALID');
  if(candidateIds!==undefined&&(!Array.isArray(candidateIds)||!candidateIds.length
    || candidateIds.some(id=>!validStableActorId(id))||new Set(candidateIds).size!==candidateIds.length)) fail('THREADS_BENEFIT_BATCH_INVALID');
  const selected=candidateIds===undefined?null:new Set(candidateIds);
  const deps={...defaults,...options},root=options.root||runtimeRoot();
  const checkStop=async()=>{if(await (options.isStopRequested||(()=>threadsStopRequested(root)))()) fail('THREADS_BENEFIT_STOPPED');};
  await mkdir(root,{recursive:true});
  await checkStop();
  const lock=options.lock||((task)=>withSessionLock(task,{lockPath:path.join(root,'coordinator.lock'),timeoutMs:600000}));
  const loadState=()=>options.state||(options.readState||(()=>readState(root)))();
  const persist=options.saveState||((value)=>saveState(root,value));
  const {state,discovery}=await lock(async()=>{
    const state=await loadState();
    if(migrateThreadsWriterIdentityPreflightFailures(state)) await persist(state);
    const config = await resolveThreadsBenefitConfig({ promotionConfig: deps.promotionConfig, root });
    // A same-cycle read is sufficient for drafting, which sends no actions.
    // Actual target execution below always discovers again under its lock.
    const discovery=canReuseThreadsDraftDiscovery(options.discovery,config,deps.now())
      ? options.discovery : await discoverThreadsBenefits(state,{...deps,root});
    assertThreadsBenefitPromotionBinding(state,config);
    if (discovery !== options.discovery) await persist(state);
    return {state,discovery};
  });
    // Reads, account waits and AI generation do not reserve or dispatch actions.
    // Release the coordinator so followbacks/outreach can proceed concurrently.
    const prepared=[],followOnlyTargets=[],
      alreadyVerifiedFollowOnlyTargets=[],skippedTargets=[];
    let actorsRead = 0;
    for(const candidate of discovery.queue) {
      if(limit!==undefined&&prepared.length+followOnlyTargets.length+alreadyVerifiedFollowOnlyTargets.length>=limit) break;
      if(candidate.stage!=='base') continue;
      if(selected&&!selected.has(candidate.id)) continue;
      await checkStop();
      if (actorsRead++ > 0 && await (options.sleep || delay)(POLICY.betweenAccountsMilliseconds) === false) fail('THREADS_BENEFIT_STOPPED');
      await checkStop();
      await options.onReadProgress?.({ actorsRead, totalBaseActors: discovery.queue.filter(row=>row.stage==='base').length });
      let entry;
      try { entry=await prepareThreadsBenefitTarget(candidate.handle,state,{...deps,discovery}); }
      catch(error) {
        if(!isTargetLocalBatchPreparationError(error)) throw error;
        skippedTargets.push(skippedBatchTarget(candidate,safeCode(error)));
        continue;
      }
      if(entry.user.stage==='base' && entry.plan.primary && entry.user.protected===false) {
        if(entry.priorOwnerReply===false) prepared.push(entry);
        else {
          const code=entry.priorOwnerReply===true
            ?'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED':'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE';
          if(entry.followOnlyEligible && alreadyVerifiedNoOpHistoryFollow(entry.user.id,state.records?.[entry.user.id],
            discovery.promotionConfig.activePromotionId,entry.currentRelationship)) {
            alreadyVerifiedFollowOnlyTargets.push({id:entry.user.id,handle:entry.user.handle,stage:'base',code,
              status:'already_verified_follow_only_hold',activePromotionId:discovery.promotionConfig.activePromotionId});
          } else if(entry.followOnlyEligible) followOnlyTargets.push({id:entry.user.id,handle:entry.user.handle,stage:'base',code});
          else skippedTargets.push(skippedBatchTarget(candidate,code));
        }
      }
    }
    if(!prepared.length) return {prepared:0,drafts:[],followOnlyTargets,alreadyVerifiedFollowOnlyTargets,skippedTargets,
      coverage:discovery.coverage,writes:0,workerStarted:false};
    await checkStop();
    await options.onReadProgress?.({ actorsRead, totalBaseActors: discovery.queue.filter(row=>row.stage==='base').length, phase:'generation' });
    const result=await deps.generate(prepared.map(entry=>({accountId:entry.user.id,post:{...entry.plan.primary,
      format:{lang:/[가-힣]/.test(entry.plan.primary.text)?'ko':'en'}}})));
    if(result.comments?.length!==prepared.length || new Set(result.comments.map(row=>row.accountId)).size!==prepared.length) fail('THREADS_BENEFIT_AI_IDENTITY_INVALID');
    const draftCache = {};
    for(const entry of prepared) {
      const row=result.comments.find(value=>value.accountId===entry.user.id);
      if(!row || row.postId!==entry.plan.primary.id || row.postAuthor!==entry.user.handle) fail('THREADS_BENEFIT_AI_IDENTITY_INVALID');
      const draft={postId:row.postId,postAuthor:row.postAuthor,comment:row.comment};
      composeThreadsBenefitReply({target:entry.user,pinnedPost:entry.plan.primary,primarySelection:entry.plan.primarySelection,contextComment:draft,
        mainShareLink:discovery.promotionConfig.url});
      draftCache[entry.user.id]={draft,postDigest:postDigest(entry.plan.primary),createdAt:new Date(deps.now()).toISOString(),
        model:result.model,effort:result.effort,provider:result.provider,elapsedMs:result.elapsedMs};
    }
    await lock(async()=>{
      await checkStop();
      const current=await loadState();
      assertThreadsBenefitPromotionBinding(current,discovery.promotionConfig);
      current.draftCache ||= {};
      for (const entry of prepared) {
        const record=current.records?.[entry.user.id];
        if (record && (record.handle?.toLowerCase()!==entry.user.handle || threadsBenefitStage(record,entry.user.qualifyingPostId,
          {actorId:entry.user.id,activePromotionId:discovery.activePromotionId})!=='base')) continue;
        const newer=Date.parse(current.draftCache[entry.user.id]?.createdAt || '');
        if (Number.isFinite(newer) && newer>Date.parse(draftCache[entry.user.id].createdAt)) continue;
        current.draftCache[entry.user.id]=draftCache[entry.user.id];
      }
      await persist(current);
    });
    return {prepared:prepared.length,drafts:result.comments,model:result.model,effort:result.effort,elapsedMs:result.elapsedMs,
      generationAttempts:result.generationAttempts,transportChunks:result.transportChunks,
      followOnlyTargets,alreadyVerifiedFollowOnlyTargets,skippedTargets,
      activePromotionId:discovery.activePromotionId,legacyEvidence:discovery.legacyEvidence,
      coverage:discovery.coverage,writes:0,workerStarted:false};
}
export function canReuseThreadsDraftDiscovery(discovery, config, now=Date.now()) {
  const checkedAt = Date.parse(discovery?.checkedAt || '');
  if (!Number.isFinite(checkedAt) || now < checkedAt || now - checkedAt > 60_000) return false;
  try {
    const observed = validateThreadsBenefitConfig(discovery.promotionConfig);
    const desired = validateThreadsBenefitConfig(config);
    if (JSON.stringify(observed) !== JSON.stringify(desired)) return false;
  } catch { return false; }
  return discovery.activePromotionId === config.activePromotionId
    && discovery.promotion?.id === config.activePromotionId && discovery.promotion?.author === config.owner
    && discovery.promotion?.isPinnedToProfile === true && discovery.promotion?.isReply === false
    && comparableThreadsUrl(discovery.promotion?.url) === comparableThreadsUrl(config.url)
    && discovery.engagement?.postId === config.activePromotionId && discovery.comments?.postId === config.activePromotionId
    && String(discovery.comments?.postAuthor || '').toLowerCase() === config.owner
    && Array.isArray(discovery.queue) && Array.isArray(discovery.held) && Array.isArray(discovery.comments.comments)
    && Array.isArray(discovery.followers?.followers) && Array.isArray(discovery.legacyComments)
    && Array.isArray(discovery.legacyEngagements);
}

async function runHistoryHeldBasicReactions(handle,state,discovery,deps,{checkStop,persist,onWorkProgress,sleep,execute}) {
  const candidate=discovery.queue.find(row=>row.handle.toLowerCase()===handle.toLowerCase() && row.stage==='base');
  const record=state.records?.[candidate?.id],promotionId=discovery.activePromotionId;
  if(!candidate || !isVerifiedThreadsFollowHistoryHoldRecord(candidate.id,record,promotionId)) fail('THREADS_BENEFIT_RECONCILE_OR_WAIT');
  if(threadsBasicReactionsVerified(candidate.id,record)) return {status:'follow_verified_reward_held',stage:'base',writes:0,
    code:record.historyHold.code,basicReactionsVerified:true,workerStarted:false};
  await onWorkProgress?.({phase:'actor_preflight'});
  // This stage has no reply operation, so incomplete reply history cannot block it.
  const actor=await readThreadsBenefitPhase('actor_preflight',()=>readActor(handle,{...deps,actorCacheRoot:null}));
  if(actor.id!==candidate.id || actor.profile?.handle?.toLowerCase()!==handle.toLowerCase()) fail('THREADS_BENEFIT_ACTOR_MISMATCH');
  const incomingFollow=actor.followsOwner===true || actor.followsOwner===null
    && (discovery.rawFollowers||discovery.followers).followers.some(row=>row.id===actor.id && row.followsOwner===true);
  const currentDirectEntrance=record.entrance==='direct_promotion_comment'
    && record.triggeringPromotionId===promotionId
    && typeof record.triggeringCommentId==='string'
    && discovery.currentDirectComment?.id===record.triggeringCommentId
    && String(discovery.currentDirectComment?.authorId??'')===actor.id
    && discovery.currentDirectComment?.directParentPostId===promotionId
    && discovery.currentDirectComment?.isReply===true;
  if(actor.private!==false || (!incomingFollow && !currentDirectEntrance)
    || !currentFollowHistoryHold(actor.id,record,promotionId,actor.relationship)) fail('THREADS_BENEFIT_ACTOR_UNVERIFIED');
  const plan=buildThreadsBenefitPlan(actor.profile,{previousPinId:record.pinnedPostId,now:deps.now()});
  if(!plan.primary || plan.primary.id!==record.pinnedPostId) fail('THREADS_BENEFIT_PRIMARY_POST_UNVERIFIED');
  await checkStop();
  if(!execute) return {status:'prepared_basic_reactions',stage:'base',id:actor.id,writes:0,workerStarted:false};
  const lastAccountAt=Date.parse(state.lastAccountAttemptAt||state.lastFinishedAt||'');
  const wait=POLICY.betweenAccountsMilliseconds-(deps.now()-lastAccountAt);
  if(Number.isFinite(wait) && wait>0 && await sleep(wait)===false) fail('THREADS_BENEFIT_STOPPED');
  await checkStop();
  state.lastAccountAttemptAt=new Date(deps.now()).toISOString();
  const previousBasic=record.basicReactions;
  record.basicReactions={status:'reserved',postId:plan.primary.id,results:{...(previousBasic?.results||{})},
    ...(Array.isArray(previousBasic?.reconciliationHistory)
      ? {reconciliationHistory:previousBasic.reconciliationHistory} : {}),
    startedAt:previousBasic?.startedAt||new Date(deps.now()).toISOString()};
  await persist(state);
  let writes=0;
  try {
    for(const operation of ['like','repost']) {
      // These exact positive receipts survived a proven pre-send local wait.
      // The completed reaction is never dispatched again in this partial stage.
      if(record.basicReactions.results[operation]) continue;
      await checkStop();
      await onWorkProgress?.({phase:'action_dispatch',operation});
      await checkStop();
      record.currentOperation=operation;record.currentOperationStartedAt=new Date(deps.now()).toISOString();
      record.attemptedOperations++;await persist(state);
      const result=await deps.reaction({operation,postId:plan.primary.id,expectedAuthor:handle,expectedActorId:actor.id,execute:true},
        {beforeWrite:async()=>{await checkStop();return true;}});
      writes+=countWrites(result);
      if(result?.status==='not_sent' && result.notSentVerified===true && result.writes===0
        && result.dispatchStarted!==true && result.writeSent!==true && result.dispatchConfirmed!==true) {
        const code=safeCode(result);
        record.currentOperation=null;delete record.currentOperationStartedAt;
        record.basicReactions.status='reserved';
        record.basicReactions.lastPreflight={operation,postId:plan.primary.id,code,
          notSentVerified:true,dispatchStarted:false,writeSent:false,writes:0,checkedAt:new Date(deps.now()).toISOString()};
        await persist(state);
        return {status:'follow_verified_reward_held',stage:'base',id:actor.id,handle,writes,writeCountUnknown:false,
          code,basicReactionsPending:true,workerStarted:false,
          noDispatchProof:{status:'not_sent_verified',operation,notSentVerified:true,dispatchStarted:false,
            writeSent:false,writes:0,stopRequested:code==='THREADS_BENEFIT_STOPPED',code}};
      }
      record.basicReactions.results[operation]=result;
      record.currentOperation=null;delete record.currentOperationStartedAt;await persist(state);
      mustVerify(result,'THREADS_BENEFIT_REACTION_UNVERIFIED');
      await onWorkProgress?.({phase:'action_completed',operation});
    }
    record.basicReactions.status='verified';
    if(!threadsBasicReactionsVerified(actor.id,record)) fail('THREADS_BENEFIT_REACTION_UNVERIFIED');
    record.basicReactions.finishedAt=new Date(deps.now()).toISOString();await persist(state);
    return {status:'follow_verified_reward_held',stage:'base',id:actor.id,handle,writes,writeCountUnknown:false,
      basicReactionsVerified:true,code:record.historyHold.code,workerStarted:false};
  } catch(error) {
    if(error?.code==='THREADS_READ_BUDGET_WAIT' && error.dispatchStarted===false && error.writeSent===false
      && error.receipt?.localBudget===true && Number.isFinite(error.retryAt)) {
      record.currentOperation=null;delete record.currentOperationStartedAt;
      record.basicReactions.status='preflight_wait';
      record.basicReactions.lastPreflight={code:error.code,localBudget:true,dispatchStarted:false,writeSent:false,retryAt:error.retryAt};
      await persist(state);
      return {status:'follow_verified_reward_held',stage:'base',id:actor.id,handle,writes,writeCountUnknown:false,
        code:error.code,retryAt:error.retryAt,receipt:{localBudget:true,readBudgetRetryAt:error.retryAt},workerStarted:false};
    }
    if(error?.code==='THREADS_BENEFIT_STOPPED' && record.currentOperation==null
      && record.basicReactions?.status==='reserved'
      && Object.entries(record.basicReactions.results||{}).every(([operation,receipt])=>
        ['like','repost'].includes(operation) && receipt?.readbackVerified===true
          && receipt.operation===operation && receipt.postId===plan.primary.id && receipt.target===handle
          && receipt.currentState?.authorId===actor.id
          && receipt.currentState[operation==='like'?'liked':'reposted']===true)) {
      const missingOperation=['like','repost'].find(operation=>!record.basicReactions.results?.[operation]);
      if(!missingOperation) {
        record.basicReactions.status='verified';
        record.basicReactions.finishedAt=new Date(deps.now()).toISOString();
        if(!threadsBasicReactionsVerified(actor.id,record)) fail('THREADS_BENEFIT_REACTION_UNVERIFIED');
        await persist(state);
        return {status:'follow_verified_reward_held',stage:'base',id:actor.id,handle,writes,writeCountUnknown:false,
          basicReactionsVerified:true,workerStarted:false};
      }
      const checkedAt=new Date(deps.now()).toISOString();
      record.basicReactions.lastPreflight={operation:missingOperation,postId:plan.primary.id,code:'THREADS_BENEFIT_STOPPED',
        notSentVerified:true,dispatchStarted:false,writeSent:false,writes:0,checkedAt};
      record.basicReactions.status='reserved';
      await persist(state);
      return {status:'follow_verified_reward_held',stage:'base',id:actor.id,handle,writes,writeCountUnknown:false,
        code:'THREADS_BENEFIT_STOPPED',basicReactionsPending:true,workerStarted:false,
        noDispatchProof:{status:'not_sent_verified',operation:missingOperation,notSentVerified:true,
          dispatchStarted:false,writeSent:false,writes:0,stopRequested:true,code:'THREADS_BENEFIT_STOPPED'}};
    }
    record.basicReactions.status='needs_reconciliation';record.basicReactions.code=safeCode(error);
    record.baseStatus='needs_reconciliation';record.code=safeCode(error);await persist(state);
    return {status:'needs_reconciliation',stage:'base',id:actor.id,handle,writes:record.currentOperation?null:writes,
      observedWrites:writes,writeCountUnknown:Boolean(record.currentOperation),code:record.code,...safeRateLimit(error),workerStarted:false};
  }
}

async function discoverHistoryHeldBasicReactions(handle,state,deps) {
  const config=await resolveThreadsBenefitConfig({promotionConfig:deps.promotionConfig,root:deps.root});
  assertThreadsBenefitPromotionBinding(state,config);
  const matches=Object.entries(state.records||{}).filter(([id,record])=>record.handle?.toLowerCase()===handle.toLowerCase()
    && isVerifiedThreadsFollowHistoryHoldRecord(id,record,config.activePromotionId));
  if(matches.length!==1) fail('THREADS_BENEFIT_RECONCILE_OR_WAIT');
  const [id,record]=matches[0];
  const retryAt=record.basicReactions?.lastPreflight?.retryAt;
  if(record.basicReactions?.status==='preflight_wait' && retryAt>deps.now()) throw Object.assign(new Error('THREADS_READ_BUDGET_WAIT'),{
    code:'THREADS_READ_BUDGET_WAIT',retryAt,dispatchStarted:false,writeSent:false,
    receipt:{localBudget:true,readBudgetRetryAt:retryAt}});
  const promotion=await verifyThreadsActivePromotion(config,{postReader:deps.postReader});
  let currentDirectComment=null;
  if(record.entrance==='direct_promotion_comment' && record.triggeringPromotionId===config.activePromotionId
    && typeof record.triggeringCommentId==='string') {
    const comments=await deps.commentsReader(config.activePromotionId,{expectedAuthor:config.owner,maxPages:1});
    if(comments?.postId!==config.activePromotionId || String(comments?.postAuthor??comments?.author??'').toLowerCase()!==config.owner) {
      fail('THREADS_BENEFIT_ACTIVE_PROMOTION_READBACK_MISMATCH');
    }
    if(!Array.isArray(comments.comments)) fail('THREADS_SOCIAL_COMMENT_ROW_SCHEMA');
    currentDirectComment=comments.comments?.find(comment=>comment.id===record.triggeringCommentId
      && String(comment.authorId??'')===id && comment.author?.toLowerCase()===record.handle.toLowerCase()
      && comment.directParentPostId===config.activePromotionId && comment.isReply===true) || null;
  }
  // A durable, exact entrance plus the fresh incoming/outgoing actor checks
  // below suffice for this base-only stage. Bonus engagement and other actors'
  // comment history cannot affect its eligibility and need not be reread.
  return {activePromotionId:config.activePromotionId,promotionConfig:config,promotion,
    queue:[{id,handle:record.handle.toLowerCase(),stage:'base'}],rawFollowers:{followers:[]},currentDirectComment};
}

export async function runThreadsBenefitTarget({handle,execute=false,requireCachedDraft=false,basicReactionsOnly=false,expectedTarget}={}, options={}) {
  if(typeof execute!=='boolean'||typeof requireCachedDraft!=='boolean'||typeof basicReactionsOnly!=='boolean') fail('THREADS_BENEFIT_MODE_INVALID');
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(handle||'') || handle.toLowerCase()===POLICY.owner) fail('THREADS_BENEFIT_TARGET_INVALID');
  if (expectedTarget != null && (!validStableActorId(expectedTarget.id) || !['base','bonus'].includes(expectedTarget.stage)
    || !Array.isArray(expectedTarget.excludeBaseTargetIds) || expectedTarget.excludeBaseTargetIds.some(id => !validStableActorId(id)))) fail('THREADS_BENEFIT_TARGET_INVALID');
  const deps={...defaults,...options}, root=options.root||runtimeRoot();
  const checkStop=async()=>{if(await (options.isStopRequested||(()=>threadsStopRequested(root)))()) fail('THREADS_BENEFIT_STOPPED');};
  await mkdir(root,{recursive:true});
  const lock=options.lock||((task)=>withSessionLock(task,{lockPath:path.join(root,'coordinator.lock'),timeoutMs:600000}));
  await options.onWorkProgress?.({phase:'coordinator_lock'});
  return lock(async()=>{
    await checkStop();
    const state=options.state||await readState(root), persist=options.saveState||((value)=>saveState(root,value));
    if(migrateThreadsWriterIdentityPreflightFailures(state)) await persist(state);
    // Never reuse a draft discovery for actions. Queue, identity, stage and
    // bonus priority are checked once here, immediately before actor checks.
    await options.onWorkProgress?.({phase:'target_revalidation'});
    const discovery=await readThreadsBenefitPhase('target_revalidation',()=>basicReactionsOnly
      ? discoverHistoryHeldBasicReactions(handle,state,{...deps,root}) : discoverThreadsBenefits(state,{...deps,root}));
    await options.onWorkProgress?.({phase:'target_revalidation_completed'});
    await checkStop();
    if (expectedTarget) {
      const candidate=discovery.queue.find(row=>row.id===expectedTarget.id && row.handle?.toLowerCase()===handle?.toLowerCase() && row.stage===expectedTarget.stage);
      if (!candidate) return { status:'skipped_current_queue',writes:0,workerStarted:false };
      const excluded = new Set(expectedTarget.excludeBaseTargetIds);
      if (expectedTarget.stage==='bonus' && discovery.queue.some(row=>row.stage==='base' && !excluded.has(row.id))) {
        return { status:'base_priority_pending',writes:0,workerStarted:false };
      }
    }
    if(basicReactionsOnly) return runHistoryHeldBasicReactions(handle,state,discovery,deps,{checkStop,persist,
      onWorkProgress:options.onWorkProgress,sleep:options.sleep||delay,execute});
    await options.onWorkProgress?.({phase:'actor_preflight'});
    const prepared=await readThreadsBenefitPhase('actor_preflight',()=>prepareThreadsBenefitTarget(handle,state,{...deps,
      ...(execute?{actorCacheRoot:null}:{}),root,discovery})),
      {user,plan,promotion,promotionConfig,triggeringComment}=prepared;
    await checkStop();
    if (expectedTarget && (user.id !== expectedTarget.id || user.handle?.toLowerCase() !== handle.toLowerCase()
      || user.stage !== expectedTarget.stage)) return { status:'skipped_current_queue',writes:0,workerStarted:false };
    if(!execute) return {...prepared,mode:'prepare',workerStarted:false};
    if(!['base','bonus'].includes(user.stage)) fail('THREADS_BENEFIT_RECONCILE_OR_WAIT');
    const previousRecord=state.records?.[user.id];
    const operationPreflightResume=threadsBenefitOperationPreflightHoldVerified(user.id,previousRecord,
      promotionConfig.activePromotionId,user.qualifyingPostId);
    if(operationPreflightResume) {
      const hold=previousRecord.operationPreflightHold;
      if(hold.followOnlyScope==='private') {
        if(user.private!==true||plan.primary!=null||previousRecord.pinnedPostId!==null) {
          fail('THREADS_BENEFIT_OPERATION_RESUME_PLAN_CHANGED');
        }
      } else if(!plan.primary||plan.primary.id!==previousRecord.pinnedPostId) fail('THREADS_BENEFIT_OPERATION_RESUME_PIN_CHANGED');
      if(hold.stage==='bonus'&&!sameIds(previousRecord.additionalPostIds,plan.additional.map(post=>post.id))) {
        fail('THREADS_BENEFIT_OPERATION_RESUME_BONUS_PLAN_CHANGED');
      }
    }
    const historyHoldCode=prepared.priorOwnerReply===true?'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED'
      :prepared.priorOwnerReply===null?'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE':null;
    const historyHeldBase=user.stage==='base' && historyHoldCode!==null;
    if(historyHeldBase && !prepared.followOnlyEligible) fail(historyHoldCode);
    if(!historyHeldBase && prepared.priorOwnerReply===true) fail('THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED');
    if(!historyHeldBase && prepared.priorOwnerReply===null) fail('THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE');
    if(user.stage==='bonus' && !user.qualifyingPostId) fail('THREADS_BENEFIT_BONUS_INELIGIBLE');
    if(user.stage==='bonus' && plan.additional.length===0) fail('THREADS_BENEFIT_NO_ADDITIONAL_POSTS');
    const reusableFollow=currentFollowHistoryHold(user.id,previousRecord,promotionConfig.activePromotionId,prepared.currentRelationship);
    const reusablePreflightFollow=operationPreflightResume&&previousRecord.operationPreflightHold.stage==='base'
      &&verifiedOperationFollow(user.id,user.handle,previousRecord.results.follow,prepared.currentRelationship);
    const reusePriorContextDraft=operationPreflightResume&&previousRecord.operationPreflightHold.stage==='base'
      &&previousRecord.operationPreflightHold.operation==='contextual_reply'
      &&validResumeDraft(previousRecord,user.handle,plan.primary?.id);
    if(historyHeldBase && reusableFollow) return {status:'follow_verified_reward_held',stage:'base',id:user.id,handle:user.handle,
      writes:0,observedWrites:0,writeCountUnknown:false,code:historyHoldCode,workerStarted:false};
    const lastAccountAt=Date.parse(state.lastAccountAttemptAt||state.lastFinishedAt||'');
    if(Number.isFinite(lastAccountAt)) {
      const waitMilliseconds=POLICY.betweenAccountsMilliseconds-(deps.now()-lastAccountAt);
      if(waitMilliseconds>0) {
        const sleep=options.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
        if(await sleep(waitMilliseconds)===false) fail('THREADS_BENEFIT_STOPPED');
      }
    }
    // AI text is ready before reserving/sending any action. It cannot claim a completed operation.
    let draft=null, aiReceipt=null;
    if(!historyHeldBase && user.stage==='base' && plan.primary) {
      if(reusePriorContextDraft) draft={...previousRecord.contextDraft};
      else {
        const cached=state.draftCache?.[user.id];
        const cacheUsable=cached?.postDigest===postDigest(plan.primary) && cached.model==='gpt-6-luna' && cached.effort==='low'
          && deps.now()-Date.parse(cached.createdAt)>=0 && deps.now()-Date.parse(cached.createdAt)<600000;
        if(requireCachedDraft&&!cacheUsable) fail('THREADS_BENEFIT_DRAFT_CACHE_MISSING');
        const generation=cacheUsable ? {...cached,comments:[{accountId:user.id,...cached.draft}],cacheUsed:true}
          : await deps.generate([{accountId:user.id,post:{...plan.primary,format:{lang:/[가-힣]/.test(plan.primary.text)?'ko':'en'}}}]);
        const rows=generation.comments;
        if(rows?.length!==1 || rows[0].accountId!==user.id || rows[0].postId!==plan.primary.id || rows[0].postAuthor!==user.handle) fail('THREADS_BENEFIT_AI_IDENTITY_INVALID');
        draft={postId:rows[0].postId,postAuthor:rows[0].postAuthor,comment:rows[0].comment};
        aiReceipt={model:generation.model,effort:generation.effort,provider:generation.provider,elapsedMs:generation.elapsedMs};
      }
      const preflightMessage=composeThreadsBenefitReply({target:user,pinnedPost:plan.primary,primarySelection:plan.primarySelection,contextComment:draft,
        mainShareLink:promotionConfig.url});
      if(!preflightMessage.shouldReply) fail('THREADS_BENEFIT_REPLY_NOT_READY');
    }
    await checkStop();
    bindThreadsBenefitPromotion(state,promotionConfig,new Date(deps.now()).toISOString());
    state.lastAccountAttemptAt=new Date(deps.now()).toISOString();
    reserveThreadsStart(state,user,deps.now());
    state.records ||= {};
    const previousPreflightFailures=Array.isArray(previousRecord?.preflightFailures)
      ? previousRecord.preflightFailures.map(row=>({...row})) : [];
    const priorHistoryHold=previousRecord?.historyHold;
    const preservedBaseResults=operationPreflightResume&&previousRecord.operationPreflightHold.stage==='base'
      ? {...previousRecord.results} : {};
    const record=user.stage==='base' ? (state.records[user.id]={handle:user.handle,
      baseStatus:operationPreflightResume&&previousRecord.operationPreflightHold.stage==='base'?'preflight_wait':'reserved',bonusStatus:'not_started',
      activePromotionId:promotionConfig.activePromotionId,qualifyingPostId:user.qualifyingPostId,
      legacyQualifyingPromotionIds:user.legacyQualifyingPromotionIds,
      ...(user.private===true?{baseScope:'follow_only_private'}:{}),
      pinnedPostId:plan.primary?.id||null,entrance:user.entrance,
      triggeringPromotionId:triggeringComment?promotionConfig.activePromotionId:previousRecord?.triggeringPromotionId||null,
      triggeringCommentId:triggeringComment?.id||previousRecord?.triggeringCommentId||null,
      ...(previousPreflightFailures.length?{preflightFailures:previousPreflightFailures}:{}),
      ...(previousRecord?.basicReactions?{basicReactions:previousRecord.basicReactions}:{}),
      ...(priorHistoryHold?{historyHold:{...priorHistoryHold,status:'reward_history_rechecked',lastRecheckedAt:new Date(deps.now()).toISOString()}}:{}),
      attemptedOperations:previousRecord?.attemptedOperations||0,
      startedAt:previousRecord?.startedAt||new Date(deps.now()).toISOString(),
      results:{primaryPostId:plan.primary?.id||null,...(reusableFollow||reusablePreflightFollow?{follow:previousRecord.results.follow}:{}),
        ...Object.fromEntries(Object.entries(preservedBaseResults).filter(([key])=>key!=='primaryPostId'))}}) : state.records[user.id];
    if(user.stage==='bonus') {
      const resumingBonus=operationPreflightResume&&previousRecord.operationPreflightHold.stage==='bonus';
      if(!resumingBonus) record.bonusStatus='reserved';
      record.additionalPostIds=plan.additional.map(p=>p.id);
      if(!resumingBonus) record.bonusResults=[];
      if(!record.qualifyingPostId) record.qualifyingPostId=user.qualifyingPostId;
      if(!Array.isArray(record.legacyQualifyingPromotionIds)||!record.legacyQualifyingPromotionIds.length) {
        record.legacyQualifyingPromotionIds=user.legacyQualifyingPromotionIds;
      }
      record.activePromotionId ||= promotionConfig.activePromotionId;
    }
    if(draft) {record.contextDraft=draft;record.aiReceipt=aiReceipt;}
    await persist(state);
    let writes=0,benefitStageDurable=false,completionNotice=null;
    const clearResumedPreflightHold=async operation=>{
      if(record.operationPreflightHold?.operation===operation) {
        delete record.operationPreflightHold;
        await persist(state);
      }
    };
    const beforeWrite=async()=>{await checkStop();return true;};
    const step=async(name,invoke)=>{
      await checkStop();
      const operation=name.startsWith('bonus_like_')?'bonus_like':name.startsWith('bonus_repost_')?'bonus_repost':name;
      await options.onWorkProgress?.({phase:'action_dispatch',operation});
      await checkStop();
      if(name.startsWith('bonus_')) record.bonusStatus='reserved';
      else if(name!=='completion_reply') record.baseStatus='reserved';
      record.currentOperation=name;record.currentOperationStartedAt=new Date(deps.now()).toISOString();
      record.attemptedOperations=(record.attemptedOperations||0)+1;await persist(state);
      const result=await invoke({beforeWrite});
      if(threadsBenefitNoDispatchVerified(result)) {
        throw Object.assign(new Error('THREADS_BENEFIT_OPERATION_NOT_SENT_VERIFIED'),{
          code:'THREADS_BENEFIT_OPERATION_NOT_SENT_VERIFIED',operation:name,noDispatchReceipt:result});
      }
      writes+=countWrites(result);
      const malformedNoDispatchClaim=result?.notSentVerified===true
        ||['not_sent','not_sent_verified'].includes(result?.status);
      if(malformedNoDispatchClaim) {
        // A contradictory/malformed no-send claim is not proof that the write
        // stayed local. Keep the operation reserved for journal reconciliation.
        return result;
      }
      record.currentOperation=null;delete record.currentOperationStartedAt;
      await options.onWorkProgress?.({phase:'action_completed',operation});return result;
    };
    try {
      if(user.stage==='base') {
        if(!reusableFollow&&!reusablePreflightFollow) {
          record.results.follow=await step('follow',guard=>deps.follow({service:'threads',operation:'follow',target:user.handle},guard));
          await persist(state);
          mustVerify(record.results.follow,'THREADS_BENEFIT_FOLLOW_UNVERIFIED');
          await clearResumedPreflightHold('follow');
        }
        if(record.results.follow.currentState?.outgoingRequest===true && record.results.follow.currentState?.following!==true) {
          record.baseStatus='pending_follow_request';await persist(state);
          return {status:'pending_follow_request',writes,id:user.id,workerStarted:false};
        }
        if(record.results.follow.currentState?.following!==true) fail('THREADS_BENEFIT_FOLLOW_UNVERIFIED');
        if(historyHeldBase) {
          record.baseStatus='follow_verified_reward_held';
          record.historyHold={status:'follow_verified',promotionId:promotionConfig.activePromotionId,
            code:historyHoldCode,pinnedPostId:record.pinnedPostId,followAttemptOperations:1,
            checkedAt:new Date(deps.now()).toISOString()};
          if(!isVerifiedThreadsFollowHistoryHoldRecord(user.id,record,promotionConfig.activePromotionId)) {
            fail('THREADS_BENEFIT_FOLLOW_UNVERIFIED');
          }
          await persist(state);
          return {status:'follow_verified_reward_held',stage:'base',id:user.id,handle:user.handle,writes,
            observedWrites:writes,writeCountUnknown:false,code:historyHoldCode,workerStarted:false};
        }
        if(user.private===true) {
          record.baseStatus='verified';record.baseScope='follow_only_private';state.lastFinishedAt=new Date(deps.now()).toISOString();await persist(state);
          return {status:'verified',stage:'base',id:user.id,writes,scope:'follow_only_private',workerStarted:false};
        }
        if(plan.primary) {
          for(const operation of ['like','repost']) {
            if(verifiedOperationReaction(user.id,user.handle,plan.primary.id,operation,record.results[operation])) continue;
            const result=await step(operation,guard=>deps.reaction({operation,postId:plan.primary.id,
              expectedAuthor:user.handle,expectedActorId:user.id,execute:true},guard));
            record.results[operation]=result;await persist(state);
            mustVerify(result,'THREADS_BENEFIT_REACTION_UNVERIFIED');
            await clearResumedPreflightHold(operation);
          }
          const message=composeThreadsBenefitReply({target:user,pinnedPost:plan.primary,primarySelection:plan.primarySelection,contextComment:draft,
            receipts:record.results,mainShareLink:promotionConfig.url});
          if(!message.shouldReply || !message.text) fail('THREADS_BENEFIT_REPLY_NOT_READY');
          const existingContextReply=record.results.reply;
          if(!(existingContextReply?.readbackVerified===true&&existingContextReply.postId===plan.primary.id
            &&existingContextReply.parentAuthor?.toLowerCase?.()===user.handle
            &&/^\d{10,25}$/.test(existingContextReply.createdPostId||''))) {
            record.results.reply=await step('contextual_reply',guard=>deps.reply({postId:plan.primary.id,expectedAuthor:user.handle,
              message:message.text,execute:true,linkMode:'plain_text'},guard));
            await persist(state);
            mustVerify(record.results.reply,'THREADS_BENEFIT_REPLY_UNVERIFIED');
            await clearResumedPreflightHold('contextual_reply');
          }
        }
        record.baseStatus='verified';record.baseFinishedAt=new Date(deps.now()).toISOString();
      } else {
        const resumeBonus=operationPreflightResume&&previousRecord.operationPreflightHold.stage==='bonus';
        if(!resumeBonus) record.bonusResults=[];
        for(const post of plan.additional) {
          let pair=record.bonusResults.find(item=>item.postId===post.id);
          if(!pair) {pair={postId:post.id};record.bonusResults.push(pair);}
          for(const operation of ['like','repost']) {
            if(verifiedOperationReaction(user.id,user.handle,post.id,operation,pair[operation])) continue;
            const stepName=`bonus_${operation}_${post.id}`;
            pair[operation]=await step(stepName,guard=>deps.reaction({operation,postId:post.id,
              expectedAuthor:user.handle,expectedActorId:user.id,execute:true},guard));
            await persist(state);
            mustVerify(pair[operation],'THREADS_BENEFIT_BONUS_UNVERIFIED');
            await clearResumedPreflightHold(stepName);
          }
        }
        record.bonusStatus='verified';record.bonusFinishedAt=new Date(deps.now()).toISOString();
      }
      await persist(state);
      benefitStageDurable=true;
      if(prepared.completionNoticeHoldCode) {
        record.notices ||= {};
        record.notices[user.stage]={status:'held',code:prepared.completionNoticeHoldCode,
          reason:'EXACT_ACTIVE_TRIGGER_NOT_OBSERVED',checkedAt:new Date(deps.now()).toISOString()};
        record.code=prepared.completionNoticeHoldCode;
        await persist(state);
        return {status:'benefit_verified_notice_held',stage:user.stage,id:user.id,handle,writes,
          observedWrites:writes,writeCountUnknown:false,benefitStageVerified:true,noticeStatus:'held',
          code:prepared.completionNoticeHoldCode,workerStarted:false};
      }
      const notice=completionNotice=composeThreadsCompletionReply({promotionPost:promotion,triggeringComment,actorId:user.id,target:user,
        stage:user.stage,previousPromotionIds:promotionConfig.previousPromotionIds,
        receipts:{...record.results,bonusPairs:record.bonusResults||[],qualifyingPostId:user.qualifyingPostId}});
      if(!notice.shouldReply || !notice.text || !notice.replyToPostId) fail('THREADS_BENEFIT_NOTICE_NOT_READY');
      record.notices ||= {};record.notices[user.stage]={status:'reserved',parentId:notice.replyToPostId,receiptKey:notice.receiptKey,text:notice.text};
      await persist(state);
      const noticeResult=await step('completion_reply',guard=>deps.reply({postId:notice.replyToPostId,
        expectedAuthor:triggeringComment?.author||POLICY.owner,message:notice.text,receiptKey:notice.receiptKey,execute:true},guard));
      record.notices[user.stage]={...record.notices[user.stage],result:noticeResult};await persist(state);
      mustVerify(noticeResult,'THREADS_BENEFIT_NOTICE_UNVERIFIED');
      record.notices[user.stage].status='verified';state.lastFinishedAt=new Date(deps.now()).toISOString();await persist(state);
      return {status:'verified',stage:user.stage,id:user.id,handle:user.handle,writes,benefitStageVerified:true,noticeStatus:'verified',
        baseVerified:record.baseStatus==='verified',
        bonusVerified:record.bonusStatus==='verified',additionalCount:record.bonusResults?.length||0,completionReplyId:noticeResult.createdPostId,
        workerStarted:false,live_replay:false};
    } catch(error) {
      const exactOperationNoDispatch=error?.code==='THREADS_BENEFIT_OPERATION_NOT_SENT_VERIFIED'
        &&error?.operation===record.currentOperation&&threadsBenefitNoDispatchVerified(error?.noDispatchReceipt);
      if(exactOperationNoDispatch) {
        const operation=record.currentOperation,receipt=error.noDispatchReceipt;
        const attemptedAt=record.currentOperationStartedAt||new Date(deps.now()).toISOString();
        const stage=operation==='completion_reply'?'completion':operation.startsWith('bonus_')?'bonus':'base';
        const postId=stage==='completion'?record.notices?.[user.stage]?.parentId
          :stage==='bonus'?operation.match(/^bonus_(?:like|repost)_(\d{10,25})$/)?.[1]:plan.primary?.id||null;
        const code=safeCode(receipt);
        record.currentOperation=null;delete record.currentOperationStartedAt;
        record.code=code;
        record.operationPreflightHold={version:1,status:'not_sent_verified',stage,operation,actorId:user.id,
          handle:user.handle.toLowerCase(),activePromotionId:promotionConfig.activePromotionId,
          ...(user.qualifyingPostId?{qualifyingPostId:user.qualifyingPostId}:{}),postId,
          ...(stage==='base'&&operation==='follow'&&user.private===true&&postId===null?{followOnlyScope:'private'}:{}),
          notSentVerified:true,noWrites:true,writes:0,mutationCount:0,dispatchStarted:false,writeSent:false,
          receiptStatus:receipt.status,code,checkedAt:attemptedAt};
        if(stage==='base') record.baseStatus='preflight_wait';
        else if(stage==='bonus') record.bonusStatus='preflight_wait';
        else {
          record.notices ||= {};
          const prior=record.notices[user.stage]||{};
          record.notices[user.stage]={...prior,status:'held_no_dispatch',code,notSentVerified:true,
            dispatchStarted:false,writeSent:false,checkedAt:attemptedAt,
            result:{status:receipt.status,notSentVerified:true,preflightNoDispatch:receipt.preflightNoDispatch===true,
              preflightStage:receipt.preflightStage||'before_write_guard',dispatchStarted:false,writeSent:false,
              journalCreated:receipt.journalCreated===true,writes:0,observedWrites:0,code}};
        }
        await persist(state);
        if(stage==='completion') return {status:'benefit_verified_notice_held',stage:user.stage,id:user.id,handle:user.handle,
          benefitStageVerified:benefitStageDurable,noticeStatus:'held_no_dispatch',writes,observedWrites:writes,
          writeCountUnknown:false,dispatchStarted:false,code,workerStarted:false,
          noDispatchProof:{status:'not_sent_verified',operation,notSentVerified:true,dispatchStarted:false,
            writeSent:false,writes:0,stopRequested:['THREADS_BENEFIT_STOPPED','SOCIAL_ACTION_STOPPED_BEFORE_WRITE',
              'THREADS_REPLY_BEFORE_WRITE_STOPPED'].includes(code),code}};
        return {status:'partial_held',stage,id:user.id,handle:user.handle,writes,observedWrites:writes,
          writeCountUnknown:false,dispatchStarted:false,code,workerStarted:false,
          noDispatchProof:{status:'not_sent_verified',operation,notSentVerified:true,dispatchStarted:false,
            writeSent:false,writes:0,stopRequested:['THREADS_BENEFIT_STOPPED','SOCIAL_ACTION_STOPPED_BEFORE_WRITE',
              'THREADS_REPLY_BEFORE_WRITE_STOPPED'].includes(code),code}};
      }
      if(safeCode(error)===THREADS_WRITER_PREFLIGHT_IDENTITY_CODE && user.stage==='base' && writes===0
        && markThreadsWriterIdentityPreflightBlocked(record,{failedAt:record.currentOperationStartedAt})) {
        await persist(state);
        return {status:'preflight_blocked',stage:'base',id:user.id,writes:0,observedWrites:0,
          writeCountUnknown:false,dispatchStarted:false,mutationCount:0,code:THREADS_WRITER_PREFLIGHT_IDENTITY_CODE,
          workerStarted:false};
      }
      const exactReplyPreflightNoDispatch=error?.preflightNoDispatch===true
        && error?.preflightStage==='link_composition'
        && error?.dispatchStarted===false && error?.writeSent===false
        && error?.journalCreated===false && error?.writes===0
        && ['THREADS_REPLY_LINK_COUNT_UNSUPPORTED','THREADS_REPLY_LINK_SCOPE_UNSUPPORTED'].includes(safeCode(error))
        && ['contextual_reply','completion_reply'].includes(record.currentOperation);
      if(exactReplyPreflightNoDispatch) {
        const operation=record.currentOperation,attemptedAt=record.currentOperationStartedAt||new Date(deps.now()).toISOString();
        record.currentOperation=null;delete record.currentOperationStartedAt;
        record.code=safeCode(error);
        if(operation==='contextual_reply') record.baseStatus='reply_preflight_held';
        if(operation==='completion_reply') {
          const notice=record.notices?.[user.stage];
          if(notice) record.notices[user.stage]={...notice,status:'held_no_dispatch',code:record.code,
            preflightNoDispatch:true,dispatchStarted:false,writeSent:false,attemptedAt};
        }
        record.replyPreflightHold={status:'held_no_dispatch',operation,code:record.code,preflightNoDispatch:true,
          preflightStage:'link_composition',dispatchStarted:false,writeSent:false,attemptedAt};
        await persist(state);
        return {status:'partial_held',stage:user.stage,id:user.id,handle,
          ...(benefitStageDurable?{benefitStageVerified:true}:{}),
          ...(operation==='completion_reply'?{noticeStatus:'held_no_dispatch'}:{}),
          writes,observedWrites:writes,writeCountUnknown:false,dispatchStarted:false,code:record.code,workerStarted:false};
      }
      if(benefitStageDurable) {
        const noticeRecord=record.notices?.[user.stage];
        const explicitRefusal=noticeRecord?.result?.notCreated===true
          && noticeRecord.result.writeOutcome==='not_created_explicit_refusal';
        const noticeStatus=explicitRefusal?'not_created_explicit_refusal':'needs_reconciliation';
        record.notices ||= {};
        record.notices[user.stage]=noticeRecord
          ? {...noticeRecord,status:noticeStatus,code:safeCode(error)}
          : {status:'blocked',code:safeCode(error),reason:completionNotice?.reason||'NOTICE_COMPOSITION_FAILED'};
        record.code=safeCode(error);await persist(state);
        return {status:'needs_reconciliation',stage:user.stage,id:user.id,handle:user.handle,
          benefitStageVerified:true,noticeStatus,writes:record.currentOperation?null:writes,observedWrites:writes,
          writeCountUnknown:Boolean(record.currentOperation),code:record.code,...safeRateLimit(error),workerStarted:false};
      }
      if(user.stage==='base') record.baseStatus='needs_reconciliation'; else record.bonusStatus='needs_reconciliation';
      record.code=safeCode(error);await persist(state);
        return {status:'needs_reconciliation',stage:user.stage,id:user.id,writes:record.currentOperation?null:writes,
          observedWrites:writes,writeCountUnknown:Boolean(record.currentOperation),code:record.code,
          ...safeRateLimit(error),workerStarted:false};
    }
  });
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const [command='probe',handle,flag]=process.argv.slice(2);
  try {
    const state=await readState(runtimeRoot());
    if(command==='status' && !handle) console.log(JSON.stringify({service:'threads',workerStarted:false,records:state.records,policy:POLICY}));
    else if(command==='draft-batch' && !handle) console.log(JSON.stringify(await prepareThreadsBenefitBatch()));
    else if(command==='probe' && !handle) {
      const result=await discoverThreadsBenefits(state);
      console.log(JSON.stringify({queue:result.queue,held:result.held,coverage:result.coverage,policy:POLICY,writes:0,workerStarted:false}));
    } else if(['prepare','run'].includes(command) && handle && (!flag||flag==='--execute') && process.argv.length<=5) {
      const result=await runThreadsBenefitTarget({handle,execute:command==='run' && flag==='--execute'});
      console.log(JSON.stringify(result));if(result.status==='needs_reconciliation')process.exitCode=2;
    } else fail('THREADS_BENEFIT_COMMAND_INVALID');
  } catch(error) {console.log(JSON.stringify({ok:false,code:safeCode(error),workerStarted:false}));process.exitCode=1;}
}
