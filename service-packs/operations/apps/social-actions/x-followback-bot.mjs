import { mkdir, readFile, writeFile,readdir } from 'node:fs/promises';
import { acquireBotWorkerLease } from './lib/bot-worker-lease.mjs';
import { writeBotJson } from './lib/bot-json-store.mjs';
import { captureBotFailure, recordBotFailure, recordBotEvent } from './lib/bot-diagnostics.mjs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { readFollowers } from './x-followers.mjs';
import { followerSnapshot, participationSnapshots, confirmFollower } from './x-discovery-cache.mjs';
import { readEngagement } from './x-engagement.mjs';
import { rewardStage, quotedPromotions,baseMayResume,baseNeedsLatestFallback,baseMayRetry,baseRetryWaiting,baseRetryLimit,baseLatestPostChangeResumable,baseReactionHoldResumable } from './x-rewards.mjs';
import { reconcileReplyByReadback, retryableCreate200 } from './x-reply-reconcile.mjs';
import { retroactiveGrant, hasBonusQualification, burstActive, reserveRetroactiveBurst, retroactiveBurstUniqueActorCount } from './x-retroactive.mjs';
import { prioritizeTargets, queuePriority, hasUnservedBase } from './x-queue-priority.mjs';
import { readCooldown } from './x-read-cooldown.mjs';
import { reserveXWrite } from '../affiliate-api-hub/scripts/sns/writers/x-write-gate.mjs';
import { workerDeadline } from './x-lifetime.mjs';
import { nextCompletionNotice, sendCompletionNotice } from './x-completion-notices.mjs';
import { quota, reserveSlot, betweenAccountsMilliseconds } from './x-batch-pacing.mjs';
import { generateContextComments, validateContextComment, aiReplySettings } from './x-ai-reply.mjs';
import { postLanguage, detectLanguage } from './x-language.mjs';
import { localizedFooter } from './x-localized-copy.mjs';
import { withXReadContext } from './providers/x.mjs';
import { react, reactPair, inspectTweet } from './x-reactions.mjs';
import {assertReadCapacity} from './x-read-budget.mjs';
import { executeAction } from './index.mjs';
import { fetchXXhr } from '../naver-blog-api/research/content-store/x-xhr.mjs';
import { publishThread } from '../affiliate-api-hub/scripts/sns/writers/x.mjs';
import { replyTextMatches } from '../affiliate-api-hub/scripts/sns/writers/x-reply-readback.mjs';

const root = path.join(process.env.LOCALAPPDATA || process.cwd(), 'affiliate-content-operations', 'x-followback-bot');
const statusFile = path.join(root, 'status.json');
const stopFile = path.join(root, 'STOP');
const lockFile = path.join(root, 'worker.lock');
const stateFile = path.join(root, 'state.json');
const mainLink = 'https://x.com/lifehack__ailab/status/2105198250806726810';
const promotionIds = [mainLink.split('/').pop(), '2104967565558886629'];
const telegramChannelLink = 'https://t.me/lifehack_ailab';
const safeCode = e => /^[A-Z0-9_]+$/.test(e?.code || '') ? e.code : 'X_BOT_FAILED';
const fail = code => { throw Object.assign(new Error(code), { code }); };
function withFailureReceipt(error, additions = {}) {
  const wrapped = new Error(error?.message || 'X_BOT_FAILED', { cause: error instanceof Error ? error : undefined });
  if (error?.name) wrapped.name = error.name;
  if (error?.code) wrapped.code = error.code;
  if (error?.detail !== undefined) wrapped.detail = error.detail;
  if (error?.stack) wrapped.stack = error.stack;
  wrapped.receipt = { ...(error?.receipt && typeof error.receipt === 'object' ? error.receipt : {}), ...additions };
  return wrapped;
}
class XBaseResumeHold extends Error {
  constructor(user, reason) {
    super('X_BOT_RESUME_STATE_UNVERIFIED');
    this.code = 'X_BOT_RESUME_STATE_UNVERIFIED';
    this.actorId = user.id;
    this.handle = user.handle;
    this.reason = reason;
  }
}
export function recordLocalFailure(status,error) {
  if(!/^PROTECTED_STORE_/.test(error.code||'')||!error.detail)return;
  status.localFailure={stage:/^[a-z-]{1,32}$/.test(error.detail.stage||'')?error.detail.stage:null,timedOut:error.detail.timedOut===true,exitStatus:Number.isInteger(error.detail.exitStatus)?error.detail.exitStatus:null};
}
export function safeFailureReceipt(error) {
  const r=error.receipt||{},result={};
  for(const k of ['httpStatus','rateLimitLimit','rateLimitRemaining','rateLimitReset','retryAfterSeconds','mutationCount','readBudgetRetryAt'])if(Number.isFinite(r[k]))result[k]=r[k];
  // The SNS XClient reports HTTP status as `status`, unlike action readers.
  if(r.httpStatus==null&&Number.isInteger(r.status)&&r.status>=100&&r.status<=599)result.httpStatus=r.status;
  for(const k of ['writeSent','localBudget','replyOutcomeUncertain','replyReconciliationReadFailed'])if(typeof r[k]==='boolean')result[k]=r[k];
  if(/^[A-Za-z0-9_./-]{1,160}$/.test(r.operation||''))result.operation=r.operation;
  if(typeof r.mime==='string'&&/^[\w/+.-]+$/.test(r.mime))result.mime=r.mime;
  return result;
}
const twitterText = createRequire(import.meta.url)('twitter-text');
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function exists(file) { try { await readFile(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
const save = (file, value) => writeBotJson('x-followback-bot', file, value);

export function selectRecentPost(items, now = Date.now()) {
  return items.filter(p => !p.replyToPostId && typeof p.text === 'string' && p.text.trim() && Number.isFinite(Date.parse(p.publishedAt))
    && now - Date.parse(p.publishedAt) >= 0 && now - Date.parse(p.publishedAt) <= 7 * 86400000).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] || null;
}

export function buildEngagementPlan(items, pinnedPostIds = [], now = Date.now()) {
  const originals = items.filter(p => !p.replyToPostId && typeof p.text === 'string' && p.text.trim());
  const ordered=originals.filter(p=>Number.isFinite(Date.parse(p.publishedAt))&&Date.parse(p.publishedAt)<=now)
    .sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt));
  const pinned = originals.find(p => pinnedPostIds?.includes(p.id) || p.isPinned);
  const primary = pinned || ordered[0] || null;
  const additional = [...new Map(ordered.filter(p => p.id !== primary?.id).map(p => [p.id, p])).values()].slice(0, 9);
  return { active: Boolean(selectRecentPost(items, now)), primary, primarySource:pinned?'pinned':primary?'latest_original':null, additional };
}

export async function planFor(handle, { lookupUser = target => withXReadContext(context => context.lookupUser(target)), readTimeline = fetchXXhr, readPinned = inspectTweet, now = Date.now() } = {}) {
  const profile = await lookupUser(handle);
  if (profile.protected === true) return { active: false, primary: null, additional: [], protected: true };
  const timeline = await readTimeline(handle, 30);
  if (profile.pinnedPostIds?.length && !timeline.items.some(p => p.id === profile.pinnedPostIds[0])) {
    let pinned;
    try { pinned = (await readPinned(profile.pinnedPostIds[0])).tweet; }
    catch (error) {
      const httpStatus = error?.receipt?.httpStatus ?? error?.receipt?.status;
      if (error?.code !== 'X_TWEET_READ_REJECTED' || httpStatus !== 404) throw error;
      // A missing pin is safe to replace only with an independently visible
      // original post from this author's timeline. Never act on the dead ID.
      return buildEngagementPlan(timeline.items, [], now);
    }
    if (pinned.author.toLowerCase() !== handle.toLowerCase()) fail('X_BOT_PIN_OWNER_MISMATCH');
    timeline.items.push({ id: pinned.id, text: pinned.text, publishedAt: new Date(pinned.createdAt).toISOString(), replyToPostId: pinned.replyToId, format: { lang: detectLanguage(pinned.text, pinned.lang) }, isPinned: true });
  }
  return buildEngagementPlan(timeline.items, profile.pinnedPostIds, now);
}

export function assessPromotionParticipation(userId, snapshots = [], expectedIds = snapshots.map(row => row.tweetId)) {
  const byId = new Map(snapshots.map(row => [row.tweetId, row]));
  const engagementListsComplete = expectedIds.length > 0 && expectedIds.every(id => {
    const row = byId.get(id);
    return Boolean(row && (row.likesExhausted === true || row.serverListExhausted === true)
      && (row.repostsExhausted === true || row.serverListExhausted === true));
  });
  const possibleQuoteRows = expectedIds.map(id => byId.get(id)).filter(row => row?.likes?.includes(userId)
    && !row.reposts?.includes(userId) && !row.quotes?.includes(userId));
  const quoteCoverageComplete = possibleQuoteRows.every(row => row.quoteCoverage?.[userId] === true);
  const complete = engagementListsComplete && quoteCoverageComplete;
  for (const id of expectedIds) {
    const row = byId.get(id);
    if (row?.likes?.includes(userId) && (row.reposts?.includes(userId) || row.quotes?.includes(userId))) {
      return { postId: id, qualified: true, complete: engagementListsComplete };
    }
  }
  return { postId: null, qualified: complete ? false : null, complete };
}

export function prioritizePlanTargets(targets, state) {
  return [...targets].sort((a, b) => queuePriority(a, state) - queuePriority(b, state)
    || Number(state.records?.[a.id]?.status === 'waiting_for_primary_post')
      - Number(state.records?.[b.id]?.status === 'waiting_for_primary_post'));
}

export function composeReply(post, contextComment = null, retrospective = false, primarySource = 'pinned', footer = null) {
  // A short exact excerpt ties the comment to this post without inventing facts or endorsements.
  const cleaned = post.text.replace(/https?:\/\/\S+/g, '').replace(/@[A-Za-z0-9_]+/g, '').replace(/\s+/g, ' ').trim();
  const snippet = post.format.lang === 'ko' ? [...cleaned].slice(0, 24).join('') : cleaned.split(' ').slice(0, 8).join(' ').slice(0, 55);
  if (!snippet && !contextComment) fail('X_BOT_EMPTY_CONTEXT');
  if (retrospective) return post.format.lang === 'ko'
    ? `${contextComment ?? `“${snippet}” 잘 읽었습니다.`}\n\n안내 변경 죄송해요 🙏 기존 팔로워 혜택 소급 적용 💙\n맞팔·${primarySource==='latest_original'?'최신글':'고정글'} 좋아요·리포 완료`
    : `${contextComment ?? `Thanks for sharing your thoughts.`}\n\n${footer ?? `Sorry for the changing details. Existing followers get full benefits, no extra conditions 💙\nLiked, reposted & followed!\n${mainLink}`}`;
  return post.format.lang === 'ko'
    ? `${contextComment ?? `“${snippet}” 이야기 잘 읽었습니다. 앞으로도 소식 나눠요!`}\n\n파딱 좋아요 리포 맞팔 완료🚨\n우리오래가요\n${mainLink}\n\n부수입 정보 텔레그램: ${telegramChannelLink}`
    : `${contextComment ?? `Your point about “${snippet}” caught my eye. Glad to connect!`}\n\n${footer ?? `Done! Liked, Reposted & Followed fellow Blue checks 💙\nLet's stay connected and grow together! 🤝\n📌 Main: ${mainLink}`}`;
}

export function canRequeueNotSent(record, journal, handle) {
  return (record?.policyVersion === 2 || record?.policyVersion === 3 && record.status === 'blocked_before_write') && record.handle === handle
    && ['reserved', 'blocked_before_write'].includes(record.status)
    && Object.keys(record.results || {}).every(key => key === 'follow')
    && record.results?.follow?.writeSent !== true
    && journal?.status === 'blocked' && journal.input?.service === 'x'
    && journal.input.operation === 'follow' && journal.input.target === handle
    && journal.result?.writeSent === false && journal.result.mutationCount === 0 && journal.result.needs_reconciliation === false;
}

export function checkpointFollowerScan(status, followers, targets, participationUnknownCount = 0) {
  // Discovery succeeds even when there are no eligible benefits to dispatch.
  // Historical diagnostics remain available, but failures are no longer consecutive.
  status.consecutiveReadFailures = 0;
  Object.assign(status, { lastScanAt: followers.checkedAt,followerScanCached:followers.cached,followerScanTtlSeconds:120, followerCount: followers.followerCountRead, missingFollowbackCount: followers.notFollowingBackCount, blueMissingCount: followers.blueNotFollowingBackCount, candidateCount: targets.length,pendingBaseCount:targets.filter(u=>u.stage==='base').length,pendingBonusCount:targets.filter(u=>u.stage==='bonus').length, participationUnknownCount });
  if (followers.ownerHandle === 'lifehack__ailab' && followers.complete === true) status.initialDiscoveryComplete = true;
}

export async function confirmFollowerForProcessing(user, state, { confirm = confirmFollower, saveState = value => save(stateFile, value) } = {}) {
  try {
    return { status: 'confirmed', followsMe: await confirm(user, state), writes: 0 };
  } catch (error) {
    if (error?.code !== 'X_BOT_FOLLOWER_IDENTITY_CHANGED') throw error;
    delete state.followerSnapshot;
    if (state.relationships) delete state.relationships[user.id];
    if (state.aiDrafts) delete state.aiDrafts[user.id];
    await saveState(state);
    return { status: 'identity_changed', followsMe: false, writes: 0, code: error.code };
  }
}

async function discover(state) {
  const scan = await followerSnapshot(state);
  const followers={...scan,items:scan.items.map(u=>{const recent=state.relationships?.[u.id];return recent&&Date.parse(recent.checkedAt)>Date.parse(scan.checkedAt)?{...u,followsMe:recent.followsMe,following:recent.following,pending:recent.pending}:u;})};
  const skipParticipationRead = burstActive(state) || hasUnservedBase(followers.items, state);
  const snapshots = skipParticipationRead ? [] : await participationSnapshots(state,promotionIds,{reader:()=>withXReadContext(async context => {
    const result = [];
    for (const tweetId of promotionIds) {
      const options = { withContext: work => work(context) };
      const likes = await readEngagement(tweetId, 'likes', options);
      const reposts = await readEngagement(tweetId, 'reposts', options);
      result.push({ tweetId, likes: likes.items.map(u => u.id), reposts: reposts.items.map(u => u.id),
        likesExhausted: likes.serverListExhausted === true, repostsExhausted: reposts.serverListExhausted === true,
        checkedAt: reposts.checkedAt });
    }
    return result;
  })});
  if (!skipParticipationRead) {
    state.quoteObservations ||= {};
    for (const user of followers.items) {
      const assessment = assessPromotionParticipation(user.id, snapshots, promotionIds);
      const stage = rewardStage(state.records[user.id], assessment.qualified);
      if (!user.blueVerified || user.protected || retroactiveGrant(state, user)
        || !['waiting_for_participation', 'participation_unverified'].includes(stage)
        || assessment.qualified === true
        || !snapshots.some(s => s.likes.includes(user.id))) continue;
      const cached = state.quoteObservations[user.id];
      if (!cached || cached.handle !== user.handle || Date.now() - Date.parse(cached.checkedAt) >= 300000) {
        if (await exists(stopFile)) break;
        const timeline = await fetchXXhr(user.handle, 30);
        state.quoteObservations[user.id] = { handle: user.handle, checkedAt: new Date().toISOString(), promotionIds: quotedPromotions(timeline.items, user, promotionIds), scope: 'latest_30_visible_originals', fullTimeline: false };
      }
      for (const snapshot of snapshots) if (state.quoteObservations[user.id].promotionIds.includes(snapshot.tweetId)) {
        snapshot.quotes ||= []; snapshot.quotes.push(user.id);
      }
      for (const snapshot of snapshots) {
        snapshot.quoteCoverage ||= {};
        snapshot.quoteCoverage[user.id] = state.quoteObservations[user.id].fullTimeline === true;
      }
    }
  }
  if (!skipParticipationRead) state.promotionObservations = snapshots;
  let participationUnknownCount = 0;
  const targets = followers.items.filter(u => (u.blueVerified || retroactiveGrant(state, u)) && u.followsMe === true).map(u => {
    const grant = retroactiveGrant(state, u);
    const assessment = assessPromotionParticipation(u.id, snapshots, promotionIds);
    const user = { ...u, qualifyingPostId: assessment.postId };
    const stage = rewardStage(state.records[u.id], grant ? true : assessment.qualified);
    if (stage === 'participation_unverified') participationUnknownCount++;
    return { ...user, retroactiveGrant: grant, participationComplete: assessment.complete, stage };
  }).filter(u => ['base', 'bonus'].includes(u.stage));
  return { followers, targets: prioritizeTargets(targets, state), participationUnknownCount };
}

export async function pinReactionAttempted(postId,{journalRoot=path.join(process.env.LOCALAPPDATA||process.cwd(),'affiliate-content-operations','x-reactions')}={}) {
  if(postId===null)return false;
  if(!/^[0-9]{1,25}$/.test(postId||''))fail('X_BOT_PIN_ID_INVALID');
  const names=await readdir(journalRoot).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  return names.some(name=>name.endsWith('-like-'+postId+'.json')||name.endsWith('-repost-'+postId+'.json'));
}
export const baseRetryDelayMs = 20 * 60000;
export function deferBaseRetry(record, error, { now = Date.now(), delayMs = baseRetryDelayMs } = {}) {
  const attempts = (record.retry?.attempts || 0) + 1;
  if (attempts >= baseRetryLimit) return false;
  record.status = 'retry_wait'; delete record.code;
  record.retry = { attempts, reason: safeCode(error), after: new Date(now + delayMs).toISOString(), deferredAt: new Date(now).toISOString() };
  return true;
}
const retryableReactionFailure = error => error.receipt?.httpStatus !== 429 && (error.code === 'X_BOT_REACTION_UNVERIFIED'
  || error.code === 'X_REACTION_RECONCILIATION_REQUIRED' && error.receipt?.writeSent === true);
export async function processTarget(user, plan, state, { contextComment, footer = null, aiReceipt, reaction = react, pairedReaction = reaction === react ? reactPair : null, followAction = executeAction, publisher = publishThread, reader = inspectTweet, saveState = value => save(stateFile, value), isStopped = () => exists(stopFile), withReactionsContext = withXReadContext,pinAttempted=pinReactionAttempted, replyReadback = reconcileReplyByReadback, wait = delay, readbackDelayMs = 15000, retryDelayMs = baseRetryDelayMs, writeGate = process.env.NODE_TEST_CONTEXT ? async () => {} : reserveXWrite } = {}) {
  const existing=state.records[user.id];
  if(existing?.status==='retry_wait'&&!baseRetryWaiting(existing)
    &&(existing.replyAttemptedAt||existing.retry?.reason==='not_created_owner_timeline_proof')){
    existing.status='needs_reconciliation';existing.code='X_BOT_REPLY_RECONCILIATION_REQUIRED';await saveState(state);
    fail('X_BOT_REPLY_RECONCILIATION_REQUIRED');
  }
  const upgrading=baseNeedsLatestFallback(existing),retrying=baseMayRetry(existing),latestChanged=baseLatestPostChangeResumable(existing),
    reactionRelease=baseReactionHoldResumable(existing),
    resuming=baseMayResume(existing)||upgrading||retrying||latestChanged||reactionRelease;
  if (existing&&!resuming) fail('X_BOT_ACCOUNT_ALREADY_RECORDED');
  const persist = () => saveState(state);
  let post = plan.primary;
  let pinChanged=false;
  if(resuming){
    const relation=state.relationships?.[user.id],checkedAt=Date.parse(relation?.checkedAt);
    if(existing.handle.toLowerCase()!==user.handle.toLowerCase()
      ||relation?.handle?.toLowerCase()!==user.handle.toLowerCase()||relation.followsMe!==true||relation.following!==true
      ||!Number.isFinite(checkedAt)||checkedAt>Date.now()||Date.now()-checkedAt>300000)throw new XBaseResumeHold(user, 'relationship_unverified');
    if((post?.id||null)!==existing.pinnedPostId){
      // Without a pin the target is just their newest post, which moves whenever they post.
      // Once reactions started, finish on that same post (its reaction journals reconcile there).
      const prior=existing.primarySource==='latest_original'&&plan.primarySource==='latest_original'
        ? plan.additional?.find(row=>row.id===existing.pinnedPostId) : null;
      if(prior) post=prior;
      else if(await pinAttempted(existing.pinnedPostId))throw new XBaseResumeHold(user, 'pin_changed_after_attempt');
      else pinChanged=true;
    }
  }
  if (post && (!resuming||pinChanged) && !contextComment) fail('X_AI_DRAFT_REQUIRED');
  const text = resuming&&!pinChanged ? existing.replyText : post ? composeReply(post, validateContextComment(contextComment), Boolean(retroactiveGrant(state, user)),plan.primarySource,footer) : null;
  if(post&&(typeof text!=='string'||!text.trim()))fail('X_AI_DRAFT_REQUIRED');
  if (text && !twitterText.parseTweet(text).valid) fail('X_AI_REPLY_TOO_LONG');
  const record = existing || (state.records[user.id] = { handle: user.handle, pinnedPostId: post?.id || null, additionalPostIds: [], policyVersion: 3, status: 'reserved', startedAt: new Date().toISOString(), results: {} });
  if (post) record.primarySelectionVersion=1; else delete record.primarySelectionVersion;
  record.primarySource=post?(plan.primarySource||'pinned'):null;
  if(!resuming){
  await persist();
  if (post) { record.replyText = text; record.replyGeneration = aiReceipt; await persist(); }
  const follow = await followAction({ service: 'x', operation: 'follow', target: user.handle });
  record.results.follow = { readbackVerified: follow.readbackVerified, following: follow.currentState?.following, pending: follow.currentState?.outgoingRequest, code: follow.code, writeSent: follow.writeSent, journalPath: follow.journalPath };
  await persist();
  if (!follow.readbackVerified) {
    record.status = follow.writeSent === false ? 'blocked_before_write' : 'needs_reconciliation'; await persist();
    fail(follow.code || 'X_BOT_FOLLOW_UNVERIFIED');
  }
  if (!follow.currentState?.following && follow.currentState?.outgoingRequest) { record.status = 'follow_request_pending'; await persist(); return; }
  if (!follow.currentState?.following) fail('X_BOT_FOLLOW_UNVERIFIED');
  }else{
    delete record.resumeDeferredUntil; delete record.resumeHold;
    if(retrying){record.status='reserved';record.retry.startedAt=new Date().toISOString();}
    if(latestChanged){record.status='reserved';record.latestPostChangeResumedAt=new Date().toISOString();}
    if(reactionRelease){
      record.status='reserved';delete record.code;delete record.reconciliationHold;
      record.retry={attempts:(record.retry?.attempts||0)+1,reason:'reaction_hold_release',startedAt:new Date().toISOString()};
    }
    if(upgrading){
      record.followOnlyFinishedAt=record.finishedAt;record.latestFallbackStartedAt=new Date().toISOString();
      record.status='reserved';record.baseStatus='reserved';
    }
    if(pinChanged){
      if(record.pinnedPostId){record.supersededPins||=[];record.supersededPins.push({postId:record.pinnedPostId,pinWritesObserved:0,reason:'pin_changed_before_any_pin_attempt',checkedAt:new Date().toISOString()});}
      record.pinnedPostId=post?.id||null;record.replyText=text;record.replyGeneration=aiReceipt;
      if(post){record.status='reserved';record.baseStatus='reserved';delete record.waitingForPrimaryPostAt;}
    }
    record.resumedAfterConfirmedFollowAt=new Date().toISOString();await persist();
  }
  if(!post){
    // A verified follow is durable, but it does not complete the base benefit.
    // Keep the actor eligible until a visible original can receive the actions.
    record.pinnedPostId=null;record.primarySource=null;delete record.primarySelectionVersion;
    record.status='waiting_for_primary_post';record.baseStatus='waiting_for_primary_post';
    record.waitingForPrimaryPostAt ||= new Date().toISOString();
    await persist();
    return {status:'waiting_for_primary_post',writes:0};
  }
  try {
  for (const targetPost of post ? [post] : []) {
    if (await isStopped()) fail('X_BOT_STOPPED_DURING_ACCOUNT');
    record.results[targetPost.id] ||= {};
    // Fence resume durably before entering reactions, whose journals may already
    // hold an uncertain send even when no account receipt was checkpointed.
    await persist();
    const pair=pairedReaction?await pairedReaction({tweetId:targetPost.id,expectedAuthor:user.handle,execute:true},{withContext:withReactionsContext,isStopped,writeGate}):null;
    for (const operation of ['like', 'repost']) {
      const result = pair?pair[operation]:await reaction({ operation, tweetId: targetPost.id, expectedAuthor: user.handle, execute: true }, { withContext: withReactionsContext, isStopped, writeGate });
      record.results[targetPost.id][operation] = { readbackVerified: result.readbackVerified, writes: result.writes };
      await persist();
      if (!result.readbackVerified) fail('X_BOT_REACTION_UNVERIFIED');
    }
  }
  // Wait for the shared X write gate before marking a reply attempt, so a pause never leaves one half-recorded.
  if(post&&!record.results.reply)await writeGate({operation:'CreateTweet',isStopped});
  } catch(error) {
    // Stopped while waiting for the write gate: nothing was sent; resume later without using an attempt.
    if(post && record.results[post.id] && error.code==='X_WRITE_GATE_STOPPED') {
      record.status='retry_wait';
      record.retry={...record.retry,attempts:record.retry?.attempts||0,reason:'X_WRITE_GATE_STOPPED',after:new Date().toISOString(),deferredAt:new Date().toISOString()};
      await persist();
      throw error;
    }
    // Reaction journals reconcile themselves against a fresh readback on the next attempt.
    if(post && record.results[post.id] && retryableReactionFailure(error) && deferBaseRetry(record, error, { delayMs: retryDelayMs })) {
      await persist();
      return { status: 'retry_deferred', code: safeCode(error), attempts: record.retry.attempts };
    }
    if(post && record.results[post.id]) {
      record.status='needs_reconciliation';record.code=safeCode(error);await persist();
    }
    throw error;
  }
  if (post) {
  const runKey = `followbot-${user.id}-${post.id}`;
  const verifyReply = async id => {
    const readback = await reader(id);
    const actual = readback.tweet.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (readback.tweet.author !== readback.owner || !replyTextMatches({ text: actual, parentId: readback.tweet.replyToId }, text, post.id)) fail('X_BOT_REPLY_RECONCILIATION_REQUIRED');
  };
  const adopt = async found => {
    if (found.length !== 1) fail('X_BOT_REPLY_RECONCILIATION_REQUIRED');
    await verifyReply(found[0]);
    record.results.reply = { ids: found, readbackVerified: true, adoptedByOwnerReadback: true };
    await persist();
  };
  try {
  const knownAttempts=()=>Number.isInteger(record.replySendAttempts)?record.replySendAttempts:record.replyAttemptedAt?1:0;
  // A previously sent reply is reusable only from an exact positive readback.
  if(retrying&&record.replyAttemptedAt){
    const attempts=knownAttempts();
    const prior=await replyReadback({postId:post.id,runKey,text,allowResolved:true,
      journalIndex:Math.max(0,attempts-1),previousProof:record.retry?.proof});
    if(prior?.found.length)await adopt(prior.found);
    else fail('X_BOT_REPLY_RECONCILIATION_REQUIRED');
  }
  if(!record.results.reply){
    if(record.replyAttemptedAt)fail('X_BOT_REPLY_RECONCILIATION_REQUIRED');
    const attempts=knownAttempts();
    if(attempts>=3)fail('X_BOT_REPLY_RECONCILIATION_REQUIRED');
    record.replySendAttempts=attempts+1;
    record.replyAttemptedAt ||= new Date().toISOString();
    record.replyLastAttemptAt=new Date().toISOString();
    await persist();
  try {
  const reply = await publisher([text], { replyToId: post.id, runKey, writeGate: null });
  record.results.reply = { ids: reply.ids, readbackVerified: reply.readbackVerified };
  await persist();
  if (!reply.readbackVerified) {
    if (reply.ids.length !== 1) fail('X_BOT_REPLY_RECONCILIATION_REQUIRED');
    await verifyReply(reply.ids[0]);
    record.results.reply.readbackVerified = true;
  }
  } catch (error) {
    if (!retryableCreate200(error) && error.code !== 'SNS_JOURNAL_RECONCILIATION_REQUIRED') throw error;
    if (error.code !== 'SNS_JOURNAL_RECONCILIATION_REQUIRED') await wait(readbackDelayMs);
    let check;
    try { check = await replyReadback({ postId: post.id, runKey, text }); }
    catch(readbackError){
      const dispatched=error.receipt?.writeSent;
      const evidence={replyReconciliationReadFailed:true,
        ...(typeof dispatched==='boolean'?{writeSent:dispatched}:{}),
        ...(dispatched===true?{replyOutcomeUncertain:true}:{})};
      throw withFailureReceipt(readbackError,evidence);
    }
    if (check.found.length) await adopt(check.found);
    else throw error;
  }
  }
  }catch(error){record.status='needs_reconciliation';record.code=safeCode(error);await persist();throw error;}
  }
  record.status = 'verified'; record.baseStatus = 'verified'; record.finishedAt = new Date().toISOString();
  if(post&&record.latestFallbackStartedAt)record.latestFallbackFinishedAt=record.finishedAt;
  await persist();
}

// X answered a burst of ten like+repost pairs four seconds apart with error 226 ("looks like it might be
// automated", 2026-10-02), so extra-post reactions are spaced and the session lock is released between posts.
export const bonusReactionGapMs = () => process.env.NODE_TEST_CONTEXT ? 0 : 30000 + Math.floor(Math.random() * 10000);
export async function processBonus(user, plan, state, { reaction = react, pairedReaction = reaction === react ? reactPair : null, saveState = value => save(stateFile, value), isStopped = () => exists(stopFile), withReactionsContext = withXReadContext, reactionGap = bonusReactionGapMs, wait = interruptibleWait, writeGate = process.env.NODE_TEST_CONTEXT ? async () => {} : reserveXWrite } = {}) {
  const record = state.records[user.id];
  if (!hasBonusQualification(user, state) || rewardStage(record, true) !== 'bonus') fail('X_BOT_BONUS_INELIGIBLE');
  if (['needs_reconciliation', 'reserved'].includes(record.bonusStatus))
    record.bonusRetry = { ...record.bonusRetry, attempts: (record.bonusRetry?.attempts || 0) + 1, startedAt: new Date().toISOString() };
  record.bonusStatus = 'reserved'; record.bonusStartedAt = new Date().toISOString();
  record.qualifyingPostId = user.qualifyingPostId;
  record.bonusQualification = retroactiveGrant(state, user) || { type: 'same_promotion_participation', postId: user.qualifyingPostId };
  const additional = plan.additional.filter(p => p.id !== record.pinnedPostId).slice(0, 9);
  record.additionalPostIds = additional.map(p => p.id); record.results ||= {};
  await saveState(state);
  try {
    for (const [index, post] of additional.entries()) {
      if (index) { const gap = reactionGap(); if (gap > 0) await wait(gap); }
      if (await isStopped()) fail('X_BOT_STOPPED_DURING_ACCOUNT');
      record.results[post.id] ||= {};
      const pair=pairedReaction?await pairedReaction({tweetId:post.id,expectedAuthor:user.handle,execute:true},{withContext:withReactionsContext,isStopped,writeGate}):null;
      for (const operation of ['like', 'repost']) {
        const result = pair?pair[operation]:await reaction({ operation, tweetId: post.id, expectedAuthor: user.handle, execute: true }, { withContext: withReactionsContext, isStopped, writeGate });
        record.results[post.id][operation] = { readbackVerified: result.readbackVerified, writes: result.writes };
        await saveState(state);
        if (!result.readbackVerified) fail('X_BOT_REACTION_UNVERIFIED');
      }
    }
    record.bonusStatus = 'verified'; record.bonusFinishedAt = new Date().toISOString(); await saveState(state);
  } catch (e) {
    record.bonusStatus = 'needs_reconciliation';
    record.bonusRetry = { ...record.bonusRetry, attempts: record.bonusRetry?.attempts || 0, failedAt: new Date().toISOString(), code: safeCode(e) };
    await saveState(state); throw e;
  }
}
export async function processBenefitStage(user,plan,state,{base=processTarget,bonus=processBonus,...options}={}) {
  if(user.stage==='base')return base(user,plan,state,options);
  if(user.stage==='bonus')return bonus(user,plan,state,options);
  fail('X_BOT_STAGE_INVALID');
}

export async function checkpointBenefitProgress(state, status, { saveState, saveStatus, now = Date.now } = {}) {
  await saveState(state);
  status.lastProgressAt = new Date(now()).toISOString();
  await saveStatus(status);
}

export async function processBenefitStageSafely(user, plan, state, { saveState = value => save(stateFile, value), now = Date.now(), ...options } = {}) {
  try { return await processBenefitStage(user, plan, state, { ...options, saveState }); }
  catch (error) {
    const record=state.records[user.id];
    const replyOutcomeUnverified=retryableCreate200(error)||error.code==='X_BOT_REPLY_RECONCILIATION_REQUIRED'
      ||error.receipt?.replyOutcomeUncertain===true;
    const replyReadbackFailed=error.receipt?.replyReconciliationReadFailed===true&&Boolean(record?.replyAttemptedAt);
    const localJournalHold=error.code==='SNS_JOURNAL_RECONCILIATION_REQUIRED'
      ||replyOutcomeUnverified&&(Boolean(record?.replyAttemptedAt)||record?.retry?.reason==='not_created_owner_timeline_proof')
      ||replyReadbackFailed
      ||error.code==='X_REACTION_RECONCILIATION_REQUIRED'&&error.receipt?.journalReconciliationHold===true&&error.receipt.writeSent===false;
    if(localJournalHold&&record&&record.handle===user.handle
      &&(user.stage==='base'&&record.status==='needs_reconciliation'||user.stage==='bonus'&&record.bonusStatus==='needs_reconciliation')){
      const reason=replyOutcomeUnverified?'reply_outcome_unverified':replyReadbackFailed?'reply_readback_failed':'existing_journal';
      record.reconciliationHold={code:error.code,checkedAt:new Date(now).toISOString(),stage:user.stage,source:reason,retryAllowed:false};
      await saveState(state);
      return {status:'held_for_reconciliation',code:error.code,reason,writes:null,writeCountUnknown:true,error};
    }
    // These typed guards run before any current-account mutation. Unknown
    // errors and any post-dispatch failure still stop for existing reconciliation.
    if (!(error instanceof XBaseResumeHold) || user.stage !== 'base' || error.actorId !== user.id
      || error.handle !== user.handle || !state.records[user.id]) throw error;
    record.resumeHold = { code: error.code, reason: error.reason, checkedAt: new Date(now).toISOString(),
      priorPostId: record.pinnedPostId, selectedPostId: plan.primary?.id || null };
    if (error.reason === 'pin_changed_after_attempt') {
      // A latest-post hold reached here only when the prior post was not in the plan
      // (deleted or out of range); do not keep re-reading it every cycle.
      if (record.primarySource === 'latest_original') record.resumeHold.priorMissing = true;
      record.status = 'needs_reconciliation';
      delete record.resumeDeferredUntil;
    } else record.resumeDeferredUntil = new Date(now + 300_000).toISOString();
    await saveState(state);
    return { status: 'held_before_dispatch', code: error.code, reason: error.reason, writes: 0 };
  }
}

export async function main(command = 'status') {
  await mkdir(root, { recursive: true });
  if (command === 'status') { console.log(JSON.stringify(await readJson(statusFile, { status: 'not_started' }))); return; }
  if (command === 'stop') { await writeFile(stopFile, new Date().toISOString()); console.log(JSON.stringify({ stopRequested: true })); return; }
  if (!['probe', 'run', 'requeue-not-sent', 'grant-existing'].includes(command)) fail('X_BOT_COMMAND_INVALID');
  if(command==='run'&&await exists(stopFile))return;
  const state = await readJson(stateFile, { records: Object.fromEntries([
    ['1893912547402948608', 'kwang800121'], ['1926989324735668224', 'idaehye09819729'], ['1681135785440059393', 'Convergence_SH']
  ].map(([id, handle]) => [id, { handle, status: 'verified', startedAt: '2026-09-30T06:20:20.382Z', source: 'verified_manual_bootstrap' }])) });
  const bootstrapTimes = { '1893912547402948608': '2026-09-30T06:33:30.000Z', '1926989324735668224': '2026-09-30T06:38:33.000Z', '1681135785440059393': '2026-09-30T06:40:41.000Z' };
  for (const [id, timestamp] of Object.entries(bootstrapTimes)) if (state.records[id]?.source === 'verified_manual_bootstrap') state.records[id].startedAt = timestamp;
  if (command === 'grant-existing') {
    const activeLock = await readJson(lockFile, null);
    if (activeLock) { try { process.kill(activeLock.pid, 0); fail('X_BOT_ALREADY_RUNNING'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    if (state.retroactiveCohort) fail('X_RETROACTIVE_COHORT_ALREADY_EXISTS');
    const followers = await readFollowers();
    if (!followers.complete || followers.ownerHandle !== 'lifehack__ailab' || followers.items.some(u => u.followsMe !== true)) fail('X_RETROACTIVE_SCAN_UNVERIFIED');
    state.retroactiveCohort = { id: 'existing-followers-20260930', authorizedAt: new Date().toISOString(), checkedAt: followers.checkedAt, source: 'explicit_user_instruction', count: followers.items.length, members: Object.fromEntries(followers.items.map(u => [u.id, { handle: u.handle, blueVerified: u.blueVerified, protected: u.protected }])) };
    await save(stateFile, state);
    console.log(JSON.stringify({ registered: followers.items.length, blueRequired: false, reactionConditionsWaived: true, writes: 0 })); return;
  }
  if (command === 'requeue-not-sent') {
    const handle = process.argv[3]; const journalPath = path.resolve(process.argv[4] || '');
    const journalRoot = path.join(process.env.LOCALAPPDATA, 'affiliate-content-operations', 'social-actions', 'journals');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle || '') || path.dirname(journalPath).toLowerCase() !== journalRoot.toLowerCase() || !/^[0-9a-f-]{36}\.json$/.test(path.basename(journalPath))) fail('X_BOT_REQUEUE_REJECTED');
    const journal = await readJson(journalPath, null);
    const entry = Object.entries(state.records).find(([, r]) => r.handle === handle);
    if (!entry || !canRequeueNotSent(entry[1], journal, handle)) fail('X_BOT_REQUEUE_REJECTED');
    state.archive ||= []; state.archive.push({ ...entry[1], recovery: 'verified_journal_write_count_zero', journalPath });
    delete state.records[entry[0]];
    await save(stateFile, state);
    console.log(JSON.stringify({ requeued: handle, priorWrites: 0, writes: 0 })); return;
  }
  if (command === 'probe') {
    const { followers, targets } = await discover(state);
    const explicit = process.argv[3];
    if (explicit && !/^[A-Za-z0-9_]{1,15}$/.test(explicit)) fail('X_BOT_HANDLE_INVALID');
    const target = explicit ? { handle: explicit } : targets[0];
    const plan = target ? await planFor(target.handle) : null;
    console.log(JSON.stringify({ mode: 'probe', policyVersion: 3, writes: 0, followerCount: followers.followerCountRead, mutualCount: followers.mutualCount, missingFollowbackCount: followers.notFollowingBackCount, candidateCount: targets.length, bonusCandidateCount: targets.filter(u => u.qualifyingPostId).length, candidate: target?.handle || null, stage: target?.stage || null, qualifyingPostId: target?.qualifyingPostId || null, plan: plan ? { active: plan.active, pinnedPostId: plan.primary?.id || null, additionalPostIds: target?.qualifyingPostId ? plan.additional.map(p => p.id) : [], reply: target?.stage === 'bonus' ? null : plan.primary ? composeReply(plan.primary) : null } : null })); return;
  }
  const lease=await acquireBotWorkerLease(root,{script:'x-followback-bot.mjs'});
  if(!lease)fail('X_BOT_ALREADY_RUNNING');
  // STOP is cleared only by explicit runtime control, never worker startup.
  const start = Date.now();
  if (process.argv.includes('--unlimited')) state.processingLimits = { hourlyLimit: null, replyBatchMaximum: null, authorizedAt: new Date(start).toISOString(), source: 'explicit_user_instruction' };
  if(process.argv.includes('--indefinite')){state.processingLimits||={};state.processingLimits.indefinite=true;}
  if (process.argv.includes('--retroactive-first')) { state.processingLimits ||= {}; state.processingLimits.retroactiveFirst = true; }
  if (process.argv.includes('--newcomer-first')) { state.processingLimits ||= {}; state.processingLimits.retroactiveFirst = false; }
  if (process.argv.includes('--fast-gap')) { state.processingLimits ||= {}; state.processingLimits.betweenAccountsSeconds = 5; }
  const priorityHandle = process.argv.find(arg => arg.startsWith('--priority-handle='))?.split('=')[1];
  if (priorityHandle) {
    if (!/^[A-Za-z0-9_]{1,15}$/.test(priorityHandle)) fail('X_BOT_HANDLE_INVALID');
    const entry = Object.entries(state.relationships || {}).find(([, r]) => r.handle.toLowerCase() === priorityHandle.toLowerCase());
    if (!entry) fail('X_BOT_PRIORITY_IDENTITY_UNKNOWN');
    state.priorityAccount = { id: entry[0], handle: entry[1].handle, authorizedAt: new Date(start).toISOString() };
  }
  const burst = process.argv.includes('--existing-burst');
  if (burst && !state.retroactiveCohort) fail('X_RETROACTIVE_COHORT_REQUIRED');
  if (burst && !state.retroactiveBurst) state.retroactiveBurst = { cohortId: state.retroactiveCohort.id, authorizedAt: new Date(start).toISOString(), expiresAt: new Date(start + 600000).toISOString(), starts: [], hourlyLimitWaived: true, stopOnRateLimit: true };
  const deadline = workerDeadline({start,indefinite:state.processingLimits?.indefinite===true,burstExpiresAt:burst?state.retroactiveBurst.expiresAt:undefined});
  const priorStatus = await readJson(statusFile, null);
  await save(stateFile, state);
  const status = { status: 'running', pid: process.pid, policyVersion: 3, promotionId: promotionIds[0], startedAt: new Date(start).toISOString(), expiresAt: Number.isFinite(deadline)?new Date(deadline).toISOString():null,indefinite:!Number.isFinite(deadline), hourlyLimit: burst ? null : 10, pollSeconds: 300, betweenAccountsSeconds: burst ? 1 : 20, pacing: burst ? 'authorized_existing_follower_ten_minute_burst' : 'batch_until_hourly_quota', replyModel: aiReplySettings.model, replyReasoningEffort: aiReplySettings.effort, replyBatchMaximum: 3, pinnedCommentLimit: 1, additionalPostLimit: 9, bonusRequires: 'follow_and_same_promotion_like_and_repost_or_existing_follower_waiver', retroactiveCohortCount: state.retroactiveCohort?.count || 0, mode: 'pure_http', owner: 'lifehack__ailab', processedThisRun: 0, initialDiscoveryComplete: false, participationUnknownCount: 0, awaitingPrimaryPostCount: 0 };
  await save(statusFile, status);
  if (state.processingLimits?.hourlyLimit === null) {
    Object.assign(status, { hourlyLimit: null, replyBatchMaximum: null, pacing: 'continuous_no_local_account_cap' });
    await save(statusFile, status);
  }
  status.retroactiveFirst = state.processingLimits?.retroactiveFirst === true;
  status.priorityAccount = state.priorityAccount || null;
  // At least 30 s between accounts: faster cadences drew X error 226 (automation suspected) on 2026-10-02.
  const accountGapMilliseconds = burst ? 1000 : Math.max(30000, state.processingLimits?.betweenAccountsSeconds === 5 ? 5000 : betweenAccountsMilliseconds);
  status.betweenAccountsSeconds = accountGapMilliseconds / 1000;
  status.bonusRequires = 'follow_and_same_promotion_like_and_repost_or_quote_or_existing_follower_waiver';
  await save(statusFile, status);
  try {
    if (priorStatus?.httpStatus === 429 && priorStatus.finishedAt) {
      const resumeAt = Date.parse(priorStatus.retryAt) || Date.parse(priorStatus.finishedAt) + 15 * 60000;
      if (resumeAt > Date.now()) {
        status.status = 'cooldown'; status.httpStatus = 429; status.code = 'X_RATE_LIMITED'; status.retryAt = new Date(resumeAt).toISOString();
        await save(statusFile, status); await interruptibleWait(resumeAt - Date.now());
      }
    }
    while (Date.now() < deadline) {
      if (await exists(stopFile)) { status.status = 'stopped'; break; }
      let phase = 'read';
      try {
      status.status = 'running'; delete status.retryAt; delete status.code; delete status.httpStatus; delete status.errorCodes;delete status.receipt;delete status.failurePhase;delete status.failureOperation;delete status.localFailure;
      const { followers, targets, participationUnknownCount } = await discover(state);
      await save(stateFile, state);
      checkpointFollowerScan(status, followers, targets, participationUnknownCount);
      await save(statusFile, status);
      if (!status.pendingBaseCount && nextCompletionNotice(state)) {
        await assertReadCapacity('lifehack__ailab','TweetDetail',{needed:3});
        phase = 'read';status.workPhase='notice_read';
        delete status.currentNoticeBatchId;
        status.lastCompletionNotice = await sendCompletionNotice(state, { saveState: value => save(stateFile, value),beforePublish:async batch=>{phase='write';status.workPhase='notice_write';status.currentNoticeBatchId=batch.batchId;await save(statusFile,status);} });
        await save(statusFile, status);
        await interruptibleWait(betweenAccountsMilliseconds);
        continue;
      }
      const hourly = burstActive(state) ? { remaining: Math.max(0, 67 - retroactiveBurstUniqueActorCount(state)) } : quota(state);
      if (!hourly.remaining) { if (burst) { status.status = 'completed_burst_capacity'; break; } status.waitingForHourlyQuota = true; status.retryAt = new Date(hourly.retryAt).toISOString(); await save(stateFile, state); await save(statusFile, status); await interruptibleWait(Math.min(hourly.retryAt - Date.now(), deadline - Date.now())); continue; }
      status.waitingForHourlyQuota = false;
      const queue = [];
      let awaitingPrimaryPostCount = 0;
      const preparationStartedAt = Date.now();
      status.workPhase = 'preparing'; status.preparedAccounts = 0;
      await save(statusFile, status);
      const batchMaximum = state.processingLimits?.replyBatchMaximum === null ? targets.length : 3;
      const availableTargets = targets.filter(u => !burst || retroactiveGrant(state, u));
      const priorityTargets = state.processingLimits?.replyBatchMaximum === null && availableTargets.length
        ? availableTargets.filter(u => queuePriority(u, state) === queuePriority(availableTargets[0], state)) : availableTargets;
      for (const user of prioritizePlanTargets(priorityTargets, state).slice(0, Math.min(batchMaximum, hourly.remaining))) {
        if (await exists(stopFile)) break;
        if (queue.length && Date.now() - preparationStartedAt >= 60000) break;
        const plan = await planFor(user.handle);
        if (!plan.primary && state.records[user.id]?.status === 'waiting_for_primary_post') {
          awaitingPrimaryPostCount++;
          continue;
        }
        queue.push({ user, plan });
        status.preparedAccounts = queue.length; status.preparationElapsedMs = Date.now() - preparationStartedAt;
        await save(statusFile, status);
      }
      status.awaitingPrimaryPostCount = awaitingPrimaryPostCount;
      await save(statusFile, status);
      if (await exists(stopFile)) continue;
      queue.sort((a, b) => queuePriority(a.user, state) - queuePriority(b.user, state) || Number(b.plan.active) - Number(a.plan.active));
      state.aiDrafts ||= {};
      const draftInputs = queue.filter(({ user, plan }) => user.stage === 'base' && plan.primary
        && !(state.aiDrafts[user.id]?.postId === plan.primary.id && state.aiDrafts[user.id]?.model === aiReplySettings.model && state.aiDrafts[user.id]?.effort === aiReplySettings.effort)).map(({ user, plan }) => ({ id: user.id, post: plan.primary }));
      if (draftInputs.length) {
        status.workPhase = 'drafting'; await save(statusFile, status);
        const { comments, ...receipt } = await generateContextComments(draftInputs);
        for (const row of comments) {
          const post = draftInputs.find(input => input.id === row.id).post;
          const user = queue.find(entry => entry.user.id === row.id).user;
          const retro = Boolean(retroactiveGrant(state, user)), language = postLanguage(post);
          let footer = null, footerLanguage = null;
          if (!['ko', 'en'].includes(language)) {
            const block = await localizedFooter(language, retro);
            if (block.origin !== 'fallback_en' && twitterText.parseTweet(composeReply(post, row.comment, retro, 'pinned', block.text)).valid) { footer = block.text; footerLanguage = block.language; }
          }
          if (!twitterText.parseTweet(composeReply(post, row.comment, retro, 'pinned', footer)).valid) fail('X_AI_REPLY_TOO_LONG');
          state.aiDrafts[row.id] = { postId: post.id, comment: row.comment, footer, footerLanguage, ...receipt };
        }
        status.lastAiBatch = { model: receipt.model, effort: receipt.effort, accounts: comments.length, elapsedMs: receipt.elapsedMs };
        await save(stateFile, state); await save(statusFile, status);
      }
      for (const { user, plan } of queue) {
        if (await exists(stopFile) || Date.now() >= deadline) break;
        const fresh = await discover(state);
        checkpointFollowerScan(status, fresh.followers, fresh.targets, fresh.participationUnknownCount);
        if (await exists(stopFile) || Date.now() >= deadline) break;
        const eligible = fresh.targets.find(u => u.id === user.id);
        await save(stateFile, state);
        if (!eligible) continue;
        if(eligible.stage==='bonus'&&fresh.targets.some(u=>u.stage==='base'))break;
        if(eligible.handle.toLowerCase()!==user.handle.toLowerCase()){
          if(state.aiDrafts)delete state.aiDrafts[user.id];
          status.identityChangesObserved=(status.identityChangesObserved||0)+1;
          status.lastIdentityChange={id:user.id,queuedHandle:user.handle,currentHandle:eligible.handle,code:'X_BOT_FOLLOWER_IDENTITY_CHANGED'};
          await save(stateFile,state);await save(statusFile,status);phase='read';continue;
        }
        const confirmation=await confirmFollowerForProcessing(eligible,state);
        if(confirmation.status==='identity_changed'){
          status.identityChangesObserved=(status.identityChangesObserved||0)+1;
          status.lastIdentityChange={id:eligible.id,handle:eligible.handle,code:confirmation.code};
          await save(statusFile,status);phase='read';continue;
        }
        if(!confirmation.followsMe){await save(stateFile,state);continue;}
        await save(stateFile,state);
        await assertReadCapacity('lifehack__ailab','TweetDetail',{needed:eligible.stage==='base'?6:plan.additional.length*2+3});
        if (!(burst ? reserveRetroactiveBurst(state, eligible) : reserveSlot(state, eligible))) break;
        await save(stateFile, state);
        phase = 'write';
        const accountStartedAt = Date.now();
        status.workPhase = 'processing'; status.benefitPhase=eligible.stage;status.currentHandle = user.handle; await save(statusFile, status);
        const draft = state.aiDrafts[user.id];
        const saveBenefitState = value => checkpointBenefitProgress(value, status, {
          saveState: current => save(stateFile, current), saveStatus: current => save(statusFile, current),
        });
        const writeGate = options => reserveXWrite({ ...options,
          onWait: async waitInfo => {
            status.workPhase = 'waiting_for_write_budget';
            status.retryAt = waitInfo.retryAt;
            status.writeGateWait = { source: waitInfo.source, operation: waitInfo.operation, reason: waitInfo.reason, retryAt: waitInfo.retryAt };
            status.lastProgressAt = waitInfo.checkedAt;
            await save(statusFile, status);
          },
          onReady: async readyInfo => {
            status.workPhase = 'processing';
            delete status.retryAt; delete status.writeGateWait;
            status.lastProgressAt = readyInfo.checkedAt;
            await save(statusFile, status);
          },
        });
        const outcome = await processBenefitStageSafely(eligible, plan, state, { saveState: saveBenefitState, writeGate, contextComment: draft?.postId === plan.primary?.id ? draft?.comment : undefined, footer: draft?.postId === plan.primary?.id ? draft?.footer ?? null : null, aiReceipt: draft ? { model: draft.model, effort: draft.effort, provider: draft.provider, elapsedMs: draft.elapsedMs, usage: draft.usage } : undefined });
        if(outcome?.status==='waiting_for_primary_post'){
          status.awaitingPrimaryPostCount=(status.awaitingPrimaryPostCount||0)+1;
          status.lastAwaitingPrimaryPost={id:eligible.id,handle:eligible.handle,checkedAt:new Date().toISOString()};
          await save(statusFile,status);await interruptibleWait(accountGapMilliseconds);phase='read';continue;
        }
        if (['held_before_dispatch','held_for_reconciliation'].includes(outcome?.status)) {
          if(outcome.error)await recordBotFailure('x-followback-bot',root,outcome.error,{phase:'reconciliation',status:outcome.status,runStartedAt:status.startedAt,event:'target_hold_failure'});
          await recordBotEvent('x-followback-bot', root, { event: 'target_hold', code: outcome.code, phase: outcome.status==='held_before_dispatch'?'before_dispatch':'reconciliation', status: outcome.status, runStartedAt: status.startedAt });
          if(outcome.status==='held_before_dispatch')status.heldBeforeDispatch = (status.heldBeforeDispatch || 0) + 1;
          else status.heldForReconciliation=(status.heldForReconciliation||0)+1;
          status.lastTargetHold = { id: eligible.id, handle: eligible.handle, code: outcome.code, reason: outcome.reason };
          if(eligible.stage==='base')status.pendingBaseCount = Math.max(0, status.pendingBaseCount - 1);
          else status.pendingBonusCount=Math.max(0,status.pendingBonusCount-1);
          phase = 'read'; await save(statusFile, status); continue;
        }
        if (outcome?.status === 'retry_deferred') {
          await recordBotEvent('x-followback-bot', root, { event: 'target_retry_deferred', code: outcome.code, phase: 'write', status: outcome.status, runStartedAt: status.startedAt });
          status.retryDeferred = (status.retryDeferred || 0) + 1;
          status.lastRetryDeferred = { id: eligible.id, handle: eligible.handle, code: outcome.code, attempts: outcome.attempts };
          status.pendingBaseCount = Math.max(0, status.pendingBaseCount - 1);
          await save(statusFile, status); await interruptibleWait(accountGapMilliseconds); phase = 'read'; continue;
        }
        if (state.priorityAccount?.id === user.id && rewardStage(state.records[user.id], true) === 'complete') {
          delete state.priorityAccount; status.priorityAccount = null; await save(stateFile, state);
        }
        status.processedThisRun++; status.lastCompletedHandle = user.handle;status.consecutiveReadFailures=0;
        if(eligible.stage==='base')status.pendingBaseCount=Math.max(0,status.pendingBaseCount-1);
        else status.pendingBonusCount=Math.max(0,status.pendingBonusCount-1);
        status.lastAccountElapsedMs = Date.now() - accountStartedAt;
        // Completion mentions are batched after pending base benefits drain.
        await save(statusFile, status);
        await interruptibleWait(accountGapMilliseconds);
        phase = 'read';
      }
      if (!queue.length) { if (burst) { status.status = 'completed_available_cohort'; break; } await interruptibleWait(300000); }
      } catch (error) {
        captureBotFailure(status, error, phase);
        if (error.code === 'AUTH_THROTTLED' && !error.receipt?.httpStatus) error.receipt = { ...error.receipt, httpStatus: 429 };
        if (burst && error.receipt?.httpStatus === 429) throw error;
        const observedRead=['X_TWEET_READ_REJECTED','X_FOLLOWERS_READ_REJECTED','X_SEARCH_REJECTED','X_READ_BUDGET_WAIT'].includes(error.code);
        const failurePhase=observedRead&&error.receipt?.writeSent!==true?'read':phase;
        status.failurePhase=failurePhase;
        const readFailures = (status.consecutiveReadFailures || 0) + 1;
        const cooldown = readCooldown(error, failurePhase, Date.now(), readFailures);
        if (!cooldown) throw error;
        status.status = cooldown.status; status.code = safeCode(error); status.httpStatus = error.receipt?.httpStatus;
        status.receipt=safeFailureReceipt(error);
        if(error.code!=='X_READ_BUDGET_WAIT')status.consecutiveReadFailures=readFailures;
        status.failureOperation = /^[A-Za-z0-9_./-]{1,160}$/.test(error.receipt?.operation || '') ? error.receipt.operation : null;
        recordLocalFailure(status,error);
        status.retryAt = new Date(cooldown.retryAt).toISOString();
        await save(stateFile, state); await save(statusFile, status);
        await interruptibleWait(Math.min(cooldown.retryAt - Date.now(), deadline - Date.now(),error.code==='X_READ_BUDGET_WAIT'?60000:Infinity));
      }
    }
    if(await exists(stopFile))status.status='stopped';
    else if(Date.now()>=deadline)status.status='expired';
  } catch (error) { captureBotFailure(status, error); status.status = 'blocked'; status.code = safeCode(error); if (Number.isInteger(error.receipt?.httpStatus)) status.httpStatus = error.receipt.httpStatus; if (typeof error.receipt?.mime === 'string') status.mime = error.receipt.mime; if (Array.isArray(error.receipt?.errorCodes)) status.errorCodes = error.receipt.errorCodes;
    status.receipt=safeFailureReceipt(error);recordLocalFailure(status,error);
    if(error.code==='X_CREATE_SCHEMA') {status.schemaDiagnostic=error.detail;status.writeReceipt=error.receipt;}
    if(error.code==='X_AI_COMMENT_INVALID'&&error.detail)status.draftDiagnostic=error.detail;
  }
  finally { status.finishedAt = new Date().toISOString(); try{await save(statusFile, status);}finally{await lease.release();} }
}

async function interruptibleWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !await exists(stopFile)) await delay(Math.min(1000, end - Date.now()));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv[2]).catch(async error => { const logging = await recordBotFailure('x-followback-bot', root, error, { phase: 'worker_entry' }); console.log(JSON.stringify({ success: false, code: safeCode(error), logging, ...(Number.isInteger(error.receipt?.httpStatus) ? { httpStatus: error.receipt.httpStatus } : {}) })); process.exitCode = 2; });
