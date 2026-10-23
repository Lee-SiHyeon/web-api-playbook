const fail = code => { throw Object.assign(new Error(code), { code }); };
export const THREADS_WRITER_PREFLIGHT_IDENTITY_CODE = 'SOCIAL_WRITER_IDENTITY_UNAVAILABLE';
export const THREADS_BENEFIT_LEGACY_PROMOTION_ID = '3996994421430736442';
export const THREADS_BENEFIT_POLICY = Object.freeze({
  version: 1, owner: 'lifehack__ailab', legacyPromotionIds: [THREADS_BENEFIT_LEGACY_PROMOTION_ID],
  mainLink: 'https://www.threads.com/share/BBK7k3y_8E/',
  secondaryLink: 'https://t.me/lifehack_ailab',
  baseEntrances: ['positive_incoming_follow', 'direct_promotion_comment'],
  bonus: 'positive follow plus like and repost or quote on the same promotion',
  additionalLimit: 9, verificationBadgeRequired: false,
  retroactiveWaiver: false, betweenAccountsMilliseconds: 20000,
});
const validId = value => typeof value === 'string' && /^\d{1,25}$/.test(value);
const validHandle = value => typeof value === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(value);
const historyHoldCodes = new Set([
  'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
  'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED',
]);
function basicReactionReceiptVerified(actorId,record,operation,receipt) {
  return receipt?.readbackVerified===true && receipt.operation===operation
    && receipt.postId===record.pinnedPostId && receipt.target===record.handle
    && receipt.currentState?.authorId===actorId
    && receipt.currentState[operation==='like'?'liked':'reposted']===true;
}
export function threadsBasicReactionsVerified(actorId, record) {
  const stage=record?.basicReactions;
  return stage?.status==='verified' && stage.postId===record.pinnedPostId
    && ['like','repost'].every(operation=>basicReactionReceiptVerified(actorId,record,operation,stage.results?.[operation]));
}
function basicReactionPreflightWait(actorId,record) {
  const stage=record?.basicReactions,proof=stage?.lastPreflight;
  return stage?.status==='preflight_wait' && stage.postId===record.pinnedPostId
    && proof?.code==='THREADS_READ_BUDGET_WAIT' && proof.localBudget===true
    && proof.dispatchStarted===false && proof.writeSent===false && Number.isFinite(proof.retryAt)
    && stage.results && Object.entries(stage.results).every(([operation,receipt])=>
      ['like','repost'].includes(operation) && basicReactionReceiptVerified(actorId,record,operation,receipt));
}
function basicReactionReservationBeforeDispatch(actorId,record) {
  const stage=record?.basicReactions;
  return stage?.status==='reserved' && stage.postId===record.pinnedPostId
    && record?.currentOperation==null && stage.results && typeof stage.results==='object' && !Array.isArray(stage.results)
    && Object.entries(stage.results).every(([operation,receipt])=>
      ['like','repost'].includes(operation) && basicReactionReceiptVerified(actorId,record,operation,receipt));
}
function verifiedFollowReceipt(actorId,handle,receipt) {
  const confirmed=receipt?.mutationCount===1
    || receipt?.mutationCount===0 && receipt?.noOp===true && receipt?.status==='no_op';
  return receipt?.readbackVerified===true && receipt?.normalizedTarget===actorId
    && receipt?.target?.toLowerCase?.()===handle && confirmed
    && receipt?.currentState?.following===true && receipt.currentState.outgoingRequest!==true;
}
function verifiedBaseReaction(actorId,record,operation) {
  const receipt=record?.results?.[operation];
  return receipt?.readbackVerified===true && receipt.operation===operation
    && receipt.postId===record.pinnedPostId && receipt.target===record.handle
    && receipt.currentState?.authorId===actorId
    && receipt.currentState[operation==='like'?'liked':'reposted']===true;
}
function verifiedContextReply(record) {
  const receipt=record?.results?.reply;
  return receipt?.readbackVerified===true && receipt.postId===record.pinnedPostId
    && receipt.parentAuthor?.toLowerCase?.()===record.handle
    && validId(receipt.createdPostId);
}
/** Strictly recognize the two maintained no-dispatch receipt contracts. */
export function threadsBenefitNoDispatchVerified(receipt) {
  if(!receipt || typeof receipt!=='object' || Array.isArray(receipt)
    || receipt.notSentVerified!==true || receipt.success===true || receipt.readbackVerified===true
    || ['dispatchStarted','writeSent','dispatchConfirmed'].some(key=>Object.hasOwn(receipt,key)&&receipt[key]!==false)) return false;
  const counts=['writes','mutationCount'].filter(key=>Object.hasOwn(receipt,key));
  if(!counts.length || counts.some(key=>receipt[key]!==0)) return false;
  if(receipt.status==='not_sent') return true;
  return receipt.status==='not_sent_verified' && receipt.preflightNoDispatch===true
    && receipt.preflightStage==='before_write_guard' && receipt.journalCreated===true
    && receipt.writes===0 && receipt.observedWrites===0;
}
/** Allow only the exact unfinished operation from a same-actor, same-promotion no-send hold back into its stage. */
export function threadsBenefitOperationPreflightHoldVerified(actorId,record,activePromotionId,qualifiedPostId) {
  const hold=record?.operationPreflightHold,handle=String(record?.handle??'').toLowerCase();
  if(!validId(actorId)||!validId(activePromotionId)||!validHandle(handle)
    ||record?.activePromotionId!==activePromotionId||record?.currentOperation!=null
    ||hold?.version!==1||hold.status!=='not_sent_verified'||hold.actorId!==actorId||hold.handle!==handle
    ||hold.activePromotionId!==activePromotionId||hold.notSentVerified!==true||hold.noWrites!==true
    ||hold.writes!==0||hold.mutationCount!==0||hold.dispatchStarted!==false||hold.writeSent!==false
    ||hold.postId!==null&&!validId(hold.postId)||!Number.isFinite(Date.parse(hold.checkedAt||''))
    ||typeof hold.code!=='string'||!/^[A-Z][A-Z0-9_]{2,100}$/.test(hold.code)) return false;
  const results=record?.results;
  if(!results||typeof results!=='object'||Array.isArray(results)
    ||results.primaryPostId!==record.pinnedPostId) return false;
  if(hold.stage==='base') {
    if(record.baseStatus!=='preflight_wait'||record.bonusStatus!=='not_started'
      ||record.notices&&Object.keys(record.notices).length) return false;
    if(hold.operation==='follow'&&hold.followOnlyScope==='private') {
      return record.baseScope==='follow_only_private'&&record.pinnedPostId===null&&hold.postId===null
        &&results.primaryPostId===null&&Object.keys(results).length===1&&Object.hasOwn(results,'primaryPostId');
    }
    if(!validId(record.pinnedPostId)||!validId(hold.postId)||hold.postId!==record.pinnedPostId) return false;
    const prefixes={follow:['primaryPostId'],like:['primaryPostId','follow'],repost:['primaryPostId','follow','like'],
      contextual_reply:['primaryPostId','follow','like','repost']};
    const keys=prefixes[hold.operation];
    if(!keys||Object.keys(results).sort().join('|')!==[...keys].sort().join('|')) return false;
    if(keys.includes('follow')&&!verifiedFollowReceipt(actorId,handle,results.follow)) return false;
    if(keys.includes('like')&&!verifiedBaseReaction(actorId,record,'like')) return false;
    if(keys.includes('repost')&&!verifiedBaseReaction(actorId,record,'repost')) return false;
    return true;
  }
  if(hold.stage!=='bonus'||record.baseStatus!=='verified'||record.bonusStatus!=='preflight_wait'
    ||!validId(record.pinnedPostId)||!validId(hold.postId)
    ||qualifiedPostId!==hold.qualifyingPostId||record.qualifyingPostId!==hold.qualifyingPostId
    ||!validId(hold.qualifyingPostId)||!Array.isArray(record.additionalPostIds)
    ||record.additionalPostIds.length<1||record.additionalPostIds.length>9
    ||record.additionalPostIds.some(id=>!validId(id))||new Set(record.additionalPostIds).size!==record.additionalPostIds.length
    ||!Array.isArray(record.bonusResults)) return false;
  if(Object.keys(results).sort().join('|')!==['primaryPostId','follow','like','repost','reply'].sort().join('|')
    ||!verifiedFollowReceipt(actorId,handle,results.follow)
    ||!verifiedBaseReaction(actorId,record,'like')||!verifiedBaseReaction(actorId,record,'repost')
    ||!verifiedContextReply(record)) return false;
  const match=String(hold.operation||'').match(/^bonus_(like|repost)_(\d{10,25})$/);
  if(!match||match[2]!==hold.postId) return false;
  const index=record.additionalPostIds.indexOf(hold.postId);
  if(index<0||record.bonusResults.length!==index+1) return false;
  for(let i=0;i<index;i++) {
    const pair=record.bonusResults[i],postId=record.additionalPostIds[i];
    if(pair?.postId!==postId||!verifiedBonusReaction(actorId,handle,postId,'like',pair.like)
      ||!verifiedBonusReaction(actorId,handle,postId,'repost',pair.repost)) return false;
  }
  const current=record.bonusResults[index];
  if(current?.postId!==hold.postId) return false;
  if(match[1]==='like') return !Object.hasOwn(current,'like')&&!Object.hasOwn(current,'repost');
  return verifiedBonusReaction(actorId,handle,hold.postId,'like',current.like)&&!Object.hasOwn(current,'repost');
}
function verifiedBonusReaction(actorId,handle,postId,operation,receipt) {
  return receipt?.readbackVerified===true&&receipt.operation===operation&&receipt.postId===postId
    &&receipt.target===handle&&receipt.currentState?.authorId===actorId
    &&receipt.currentState[operation==='like'?'liked':'reposted']===true;
}
export function samePromotionQualification(id, followsOwner, snapshots) {
  if (!validId(id) || followsOwner !== true) return null;
  for (const snapshot of snapshots || []) {
    if (!validId(snapshot.postId) || !Array.isArray(snapshot.activities?.like) || !Array.isArray(snapshot.activities?.repost)) fail('THREADS_BENEFIT_PARTICIPATION_INVALID');
    if (snapshot.activities.quote != null && !Array.isArray(snapshot.activities.quote)) fail('THREADS_BENEFIT_PARTICIPATION_INVALID');
    if (snapshot.activities.like.some(u => u.id === id)
      && [...snapshot.activities.repost, ...(snapshot.activities.quote || [])].some(u => u.id === id)) return snapshot.postId;
  }
  return null;
}
export function isVerifiedThreadsFollowHistoryHoldRecord(actorId, record, activePromotionId) {
  const handle=String(record?.handle??'').toLowerCase(), receipt=record?.results?.follow;
  const confirmedFollow=receipt?.mutationCount===1
    || receipt?.mutationCount===0 && receipt?.noOp===true && receipt?.status==='no_op';
  return validId(actorId) && validId(activePromotionId) && validHandle(handle)
    && record?.baseStatus==='follow_verified_reward_held' && record?.bonusStatus==='not_started'
    && record?.activePromotionId===activePromotionId
    && ['positive_incoming_follow','direct_promotion_comment','legacy_direct_promotion_comment'].includes(record?.entrance)
    && record?.historyHold?.status==='follow_verified'
    && record.historyHold.promotionId===activePromotionId
    && historyHoldCodes.has(record.historyHold.code)
    && record.historyHold.followAttemptOperations===1
    && validId(record?.historyHold?.pinnedPostId)
    && record.historyHold.pinnedPostId===record?.pinnedPostId
    && record?.currentOperation==null && Number.isSafeInteger(record?.attemptedOperations)
    && record.attemptedOperations>=1
    && (!record.basicReactions || threadsBasicReactionsVerified(actorId,record)
      || basicReactionPreflightWait(actorId,record) || basicReactionReservationBeforeDispatch(actorId,record))
    && record?.results && Object.keys(record.results).length===2
    && Object.hasOwn(record.results,'primaryPostId') && record.results.primaryPostId===record.pinnedPostId
    && receipt?.readbackVerified===true && receipt?.normalizedTarget===actorId
    && receipt?.target?.toLowerCase?.()===handle && confirmedFollow
    && receipt?.currentState?.following===true && receipt.currentState.outgoingRequest!==true
    && (!record.notices || Object.keys(record.notices).length===0);
}

export function threadsBenefitStage(record, qualified, {actorId,activePromotionId}={}) {
  if (!record) return 'base';
  if (isVerifiedThreadsFollowHistoryHoldRecord(actorId,record,activePromotionId)) return 'base';
  if(record.baseStatus==='preflight_wait') return threadsBenefitOperationPreflightHoldVerified(actorId,record,activePromotionId,qualified)
    &&record.operationPreflightHold.stage==='base'?'base':'reconciliation';
  if(record.bonusStatus==='preflight_wait') return threadsBenefitOperationPreflightHoldVerified(actorId,record,activePromotionId,qualified)
    &&record.operationPreflightHold.stage==='bonus'?'bonus':'reconciliation';
  if (record.baseStatus === 'preflight_blocked' && hasRetryableWriterPreflightReceipt(record)) return 'base';
  if (record.baseStatus === 'pending_follow_request') return 'pending';
  if (record.baseStatus !== 'verified') return 'reconciliation';
  if (record.bonusStatus === 'verified') return 'complete';
  if (record.bonusStatus && record.bonusStatus !== 'not_started') return 'reconciliation';
  return qualified ? 'bonus' : 'waiting_for_participation';
}

function hasRetryableWriterPreflightReceipt(record) {
  const results=record?.results, receipt=results?.follow;
  return record?.code===THREADS_WRITER_PREFLIGHT_IDENTITY_CODE
    && record?.currentOperation == null && record?.attemptedOperations===1
    && results && Object.keys(results).length===2 && Object.hasOwn(results,'primaryPostId')
    && receipt?.operation==='follow' && receipt?.code===THREADS_WRITER_PREFLIGHT_IDENTITY_CODE
    && receipt?.status==='preflight_blocked' && receipt?.mutationCount===0
    && receipt?.dispatchStarted===false && receipt?.writeSent===false
    && (!record.notices || Object.keys(record.notices).length===0);
}

function applyWriterPreflightBlock(record, failedAt, migratedAt) {
  const failures=Array.isArray(record.preflightFailures)?record.preflightFailures:[];
  const failure={operation:'follow',code:THREADS_WRITER_PREFLIGHT_IDENTITY_CODE,
    mutationCount:0,dispatchStarted:false,writeSent:false,
    ...(typeof failedAt==='string' && Number.isFinite(Date.parse(failedAt))?{failedAt}:{}),
    ...(typeof migratedAt==='string' && Number.isFinite(Date.parse(migratedAt))?{migratedAt}:{})};
  if(!failures.some(row=>row?.operation==='follow'&&row?.code===failure.code&&row?.failedAt===failure.failedAt)) {
    failures.push(failure);
  }
  record.preflightFailures=failures;
  record.results.follow={service:'threads',operation:'follow',target:record.handle,status:'preflight_blocked',
    success:false,code:THREADS_WRITER_PREFLIGHT_IDENTITY_CODE,mutationCount:0,dispatchStarted:false,
    writeSent:false,readbackVerified:false,...(failure.failedAt?{checkedAt:failure.failedAt}:{})};
  record.currentOperation=null;
  delete record.currentOperationStartedAt;
  record.baseStatus='preflight_blocked';
  record.code=THREADS_WRITER_PREFLIGHT_IDENTITY_CODE;
  if(failure.failedAt) record.preflightBlockedAt=failure.failedAt;
}

/** Convert only the historical first-follow identity guard record, which proves no dispatch. */
export function migrateThreadsWriterIdentityPreflightFailures(state,{migratedAt=new Date().toISOString()}={}) {
  if(!state?.records || typeof state.records!=='object' || Array.isArray(state.records)) return false;
  let changed=false;
  for(const record of Object.values(state.records)) {
    if(record?.baseStatus!=='needs_reconciliation'
      || record?.code!==THREADS_WRITER_PREFLIGHT_IDENTITY_CODE
      || record?.currentOperation!=='follow' || record?.attemptedOperations!==1
      || !state.activePromotionId || record.activePromotionId!==state.activePromotionId
      || record?.notices && Object.keys(record.notices).length>0
      || !record?.results || Object.keys(record.results).length!==1
      || !Object.hasOwn(record.results,'primaryPostId')
      || record?.preflightFailures!=null && !Array.isArray(record.preflightFailures)) continue;
    const failedAt=record.currentOperationStartedAt || record.startedAt;
    applyWriterPreflightBlock(record,failedAt,migratedAt);
    changed=true;
  }
  return changed;
}

/** Preserve an exact same-run pre-send failure as retryable only before any action receipt exists. */
export function markThreadsWriterIdentityPreflightBlocked(record,{failedAt}={}) {
  if(record?.baseStatus!=='reserved'
    || record?.code && record.code!==THREADS_WRITER_PREFLIGHT_IDENTITY_CODE
    || record?.currentOperation!=='follow' || record?.attemptedOperations!==1
    || record?.preflightFailures!=null && !Array.isArray(record.preflightFailures)
    || record?.notices && Object.keys(record.notices).length>0
    || !record?.results || Object.keys(record.results).length!==1
    || !Object.hasOwn(record.results,'primaryPostId')) return false;
  applyWriterPreflightBlock(record,failedAt || record.currentOperationStartedAt || record.startedAt);
  return true;
}
export function buildThreadsBenefitPlan(profile, { previousPinId = null, now = Date.now() } = {}) {
  if (!profile || !Array.isArray(profile.posts) || typeof profile.handle !== 'string') fail('THREADS_BENEFIT_PROFILE_INVALID');
  const originals = [...new Map([...profile.posts,...(profile.pinnedPosts||[])].filter(p => p.author?.toLowerCase() === profile.handle.toLowerCase()
    && validId(p.id) && p.isReply === false && typeof p.text === 'string' && p.text.trim()).map(p => [p.id, p])).values()];
  const pins = originals.filter(p => p.isPinnedToProfile === true);
  if (pins.length > 1) fail('THREADS_BENEFIT_PIN_AMBIGUOUS');
  const pinAbsenceVerified = !pins.length && originals.every(post => post.isPinnedToProfile === false)
    && ![...profile.posts,...(profile.pinnedPosts||[])].some(post => post.isPinnedToProfile === true)
    && profile.pinState !== 'pinned_post_observed' && profile.pinState !== 'not_exposed'
    && (profile.pinState === 'no_pin_in_full_timeline' || profile.fullTimeline === true);
  const recent = originals.filter(post => Number.isFinite(Date.parse(post.publishedAt)) && Date.parse(post.publishedAt) <= now)
    .sort((a,b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.id.localeCompare(a.id));
  const primary = pins[0] || (pinAbsenceVerified ? recent[0] : null) || null;
  const additional = originals.filter(p => p.id !== primary?.id && p.id !== previousPinId)
    .sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || '')).slice(0, 9);
  const primarySource = pins.length ? 'pinned' : primary ? 'latest_original' : null;
  return { primary, primarySource, pinAbsenceVerified,
    primarySelection: primary ? { postId: primary.id, source: primarySource, pinAbsenceVerified } : null,
    primaryUnavailableReason: originals.length && !primary
      ? pinAbsenceVerified ? 'LATEST_POST_TIME_UNVERIFIED' : 'PIN_STATE_UNVERIFIED' : null,
    additional, active: originals.some(p => Number.isFinite(Date.parse(p.publishedAt))
    && now - Date.parse(p.publishedAt) >= 0 && now - Date.parse(p.publishedAt) <= 7 * 86400000),
    fullTimeline: profile.fullTimeline === true, coverage: profile.coverage || 'initial_document_window' };
}
export function observeThreadsRelationships(state, scan, checkedAt) {
  if (!Array.isArray(scan?.followers) || !scan.page || !Number.isFinite(Date.parse(checkedAt))) fail('THREADS_BENEFIT_SCAN_INVALID');
  state.relationships ||= {};
  const present = new Set();
  for (const user of scan.followers) {
    if (!validId(user.id) || present.has(user.id)) fail('THREADS_BENEFIT_SCAN_INVALID');
    present.add(user.id);
    const previous = state.relationships[user.id];
    state.relationships[user.id] = { ...previous, handle: user.username, followsOwner: user.followsOwner,
      following: user.following, pending: user.outgoingRequest, firstSeenAt: previous?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt, checkedAt, visibility: 'present', missingScans: 0,
      returnedAt: previous?.visibility === 'absent_confirmed' ? checkedAt : previous?.returnedAt };
  }
  // Positive observations are useful even on a partial page. Absence requires complete scans.
  if (scan.page.fullList === true) for (const [id, relation] of Object.entries(state.relationships)) {
    if (present.has(id) || relation.checkedAt === checkedAt) continue;
    relation.missingScans = (relation.missingScans || 0) + 1;
    relation.checkedAt = checkedAt;
    relation.visibility = relation.missingScans >= 2 ? 'absent_confirmed' : 'absence_pending';
  }
  return { complete: scan.page.fullList === true, observed: present.size };
}
function configuredLegacySnapshots(rows, previousPromotionIds, kind) {
  if (!Array.isArray(rows)) fail('THREADS_BENEFIT_LEGACY_READ_INVALID');
  const byId = new Map();
  for (const row of rows) {
    const snapshot = row?.[kind] ?? row;
    const promotionId = String(row?.promotionId ?? snapshot?.postId ?? '');
    if (!validId(promotionId) || !previousPromotionIds.includes(promotionId)
      || snapshot?.postId !== promotionId || byId.has(promotionId)) fail('THREADS_BENEFIT_LEGACY_READ_INVALID');
    if (kind === 'comments' && (snapshot.postAuthor?.toLowerCase() !== THREADS_BENEFIT_POLICY.owner
      || !Array.isArray(snapshot.comments) || !snapshot.page)) fail('THREADS_BENEFIT_LEGACY_READ_INVALID');
    if (kind === 'engagement' && (!Array.isArray(snapshot.activities?.like) || !Array.isArray(snapshot.activities?.repost)
      || snapshot.activities.quote != null && !Array.isArray(snapshot.activities.quote))) {
      fail('THREADS_BENEFIT_LEGACY_READ_INVALID');
    }
    byId.set(promotionId, { promotionId, [kind]: snapshot });
  }
  return [...byId.values()];
}

function positiveActorIds(snapshot) {
  const likes = new Set(snapshot.activities.like.map(row => String(row?.id ?? '')).filter(validId));
  const repostsOrQuotes = new Set([...snapshot.activities.repost, ...(snapshot.activities.quote || [])]
    .map(row => String(row?.id ?? '')).filter(validId));
  return [...likes].filter(id => repostsOrQuotes.has(id));
}

function mergeUniqueRows(rows, key) {
  const seen = new Set();
  return rows.filter(row => {
    const value = key(row);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function collectThreadsLegacyEvidence({ legacyEngagements = [], legacyComments = [], checkedAt = new Date().toISOString() } = {}) {
  const qualifications = [];
  for (const row of legacyEngagements) for (const actorId of positiveActorIds(row.engagement)) {
    qualifications.push({ actorId, promotionId: row.promotionId, checkedAt });
  }
  const completionResponses = [];
  for (const row of legacyComments) {
    completionResponses.push(...observedThreadsCompletionResponses(row.comments, { promotionId: row.promotionId }));
  }
  return {
    qualifications: mergeUniqueRows(qualifications, row => `${row.actorId}:${row.promotionId}`),
    completionResponses: mergeUniqueRows(completionResponses,
      row => `${row.promotionId}:${row.ownerReplyId}`),
  };
}

export function mergeThreadsLegacyEvidence(state, evidence) {
  state.legacyEvidence ||= { qualifications: {}, completionResponses: {} };
  state.legacyEvidence.qualifications ||= {};
  state.legacyEvidence.completionResponses ||= {};
  let changed = false;
  for (const row of evidence?.qualifications || evidence?.qualifyingActors || []) {
    if (!validId(row.actorId) || !validId(row.promotionId)) continue;
    const current = state.legacyEvidence.qualifications[row.actorId] || { promotionIds: [], evidence: [] };
    if (current.promotionIds.includes(row.promotionId)) continue;
    current.promotionIds.push(row.promotionId);
    current.evidence.push({ promotionId: row.promotionId, observedAt: row.checkedAt,
      source: 'same_promotion_positive_like_and_repost_or_quote' });
    state.legacyEvidence.qualifications[row.actorId] = current;
    changed = true;
  }
  for (const row of evidence?.completionResponses || []) {
    if (!validId(row.actorId) || !validId(row.promotionId) || !validId(row.ownerReplyId)) continue;
    const key = row.actorId;
    const current = state.legacyEvidence.completionResponses[key] || { handle: row.handle, responses: [] };
    if (current.responses.some(item => item.ownerReplyId === row.ownerReplyId)) continue;
    current.responses.push({ promotionId: row.promotionId, commentId: row.commentId, ownerReplyId: row.ownerReplyId,
      evidence: row.evidence, observedAt: row.checkedAt || null });
    state.legacyEvidence.completionResponses[key] = current;
    changed = true;
  }
  return changed;
}

export function buildThreadsBenefitQueue({ followers, engagement, comments, state = {}, activePromotionId,
  previousPromotionIds = [], legacyEngagements = [], legacyComments = [] }) {
  if (!validId(activePromotionId) || comments?.postId !== activePromotionId
    || comments.postAuthor?.toLowerCase() !== THREADS_BENEFIT_POLICY.owner
    || engagement?.postId !== activePromotionId || !Array.isArray(followers?.followers)) fail('THREADS_BENEFIT_PROMOTION_MISMATCH');
  const previousIds = [...new Set(previousPromotionIds)];
  if (previousIds.some(id => !validId(id) || id === activePromotionId)) fail('THREADS_BENEFIT_LEGACY_READ_INVALID');
  const oldEngagements = configuredLegacySnapshots(legacyEngagements, previousIds, 'engagement');
  const oldComments = configuredLegacySnapshots(legacyComments, previousIds, 'comments');
  const evidence = collectThreadsLegacyEvidence({ legacyEngagements: oldEngagements, legacyComments: oldComments });
  const byHandle = new Map();
  for (const user of followers.followers) {
    if (user.followsOwner === true) byHandle.set(user.username.toLowerCase(), { id: user.id, handle: user.username,
      followsOwner: true, private: user.private, entrance: 'positive_incoming_follow', commentId: null });
  }
  for (const comment of comments.comments || []) {
    if (comment.directParentPostId !== activePromotionId || comment.isReply !== true
      || comment.author.toLowerCase() === THREADS_BENEFIT_POLICY.owner) continue;
    const key = comment.author.toLowerCase(), existing = byHandle.get(key);
    if(existing?.id && comment.authorId && existing.id!==comment.authorId) fail('THREADS_BENEFIT_COMMENT_ACTOR_MISMATCH');
    byHandle.set(key, { ...existing, id: existing?.id || comment.authorId || null, handle: comment.author,
      followsOwner: existing?.followsOwner ?? null, private: existing?.private ?? null,
      entrance: 'direct_promotion_comment', commentId: comment.id });
  }
  // The old announcement remains an entrance for its already-public commenters.
  // New completion replies still target the active root unless they comment there.
  for (const row of oldComments) for (const comment of row.comments.comments || []) {
    if (comment.directParentPostId !== row.promotionId || comment.isReply !== true
      || comment.author?.toLowerCase() === THREADS_BENEFIT_POLICY.owner || !validId(String(comment.authorId ?? ''))) continue;
    const key=comment.author.toLowerCase(), existing=byHandle.get(key);
    if(existing?.id && existing.id!==String(comment.authorId)) fail('THREADS_BENEFIT_COMMENT_ACTOR_MISMATCH');
    if(existing) continue;
    byHandle.set(key,{id:String(comment.authorId),handle:comment.author,followsOwner:null,private:null,
      entrance:'legacy_direct_promotion_comment',commentId:comment.id,commentPromotionId:row.promotionId});
  }
  // A successfully journaled follow-only history hold is itself a durable, exact prior entrance.
  // Re-enqueue it so a partial follower/comment window cannot strand the later reward stage.
  for (const [actorId,record] of Object.entries(state.records||{})) {
    if (!isVerifiedThreadsFollowHistoryHoldRecord(actorId,record,activePromotionId)) continue;
    const handle=record.handle.toLowerCase(), existing=byHandle.get(handle);
    if (existing?.id && existing.id!==actorId) fail('THREADS_BENEFIT_COMMENT_ACTOR_MISMATCH');
    if (existing) { if (!existing.id) existing.id=actorId; continue; }
    byHandle.set(handle,{id:actorId,handle,followsOwner:null,private:null,
      entrance:'follow_verified_history_hold',commentId:null});
  }
  const persistedResponses = Object.entries(state.legacyEvidence?.completionResponses || {}).flatMap(([actorId, value]) =>
    (value.responses || []).map(row => ({ ...row, actorId, handle: value.handle })));
  const legacyResponses=mergeUniqueRows([
    ...observedThreadsCompletionResponses(comments, { promotionId: activePromotionId }),
    ...evidence.completionResponses,
    ...persistedResponses,
  ], row => `${row.promotionId}:${row.ownerReplyId}`);
  const classified = [...byHandle.values()].map(user => {
    const activeQualifyingPostId = user.id ? samePromotionQualification(user.id, user.followsOwner, [engagement]) : null;
    const persisted = user.id ? state.legacyEvidence?.qualifications?.[user.id]?.promotionIds || [] : [];
    const legacyQualifyingPromotionIds = user.followsOwner === true && user.id
      ? [...new Set([...persisted, ...oldEngagements.filter(row =>
        samePromotionQualification(user.id, true, [row.engagement]) === row.promotionId).map(row => row.promotionId)])]
        .filter(id => previousIds.includes(id)) : [];
    const qualifyingPostId = activeQualifyingPostId || legacyQualifyingPromotionIds[0] || null;
    const legacyResponse=legacyResponses.find(row => user.id && row.actorId === user.id
      || row.handle?.toLowerCase() === user.handle.toLowerCase());
    return { ...user, activePromotionId, activeQualifyingPostId, legacyQualifyingPromotionIds, qualifyingPostId,
      participation:activeQualifyingPostId?'positive_active_promotion':legacyQualifyingPromotionIds.length?'positive_legacy_promotion':'unknown',
      stage: legacyResponse && !state.records?.[user.id] ? 'legacy_review'
      : user.id ? threadsBenefitStage(state.records?.[user.id], qualifyingPostId,
        {actorId:user.id,activePromotionId}) : 'identity_lookup',
      ...(isVerifiedThreadsFollowHistoryHoldRecord(user.id,state.records?.[user.id],activePromotionId)
        && !threadsBasicReactionsVerified(user.id,state.records[user.id]) ? {basicReactionsPending:true,
          ...(basicReactionPreflightWait(user.id,state.records[user.id])
            ? {basicReactionsRetryAt:state.records[user.id].basicReactions.lastPreflight.retryAt} : {})} : {}),
      ...(legacyResponse?{legacyResponse}: {}) };
  });
  const queue=classified.filter(user => ['base', 'bonus', 'identity_lookup'].includes(user.stage));
  queue.sort((a,b) => (a.stage === 'bonus' ? 1 : 0) - (b.stage === 'bonus' ? 1 : 0));
  const legacyCoverage = previousIds.map(promotionId => ({ promotionId,
    engagementRead: oldEngagements.some(row => row.promotionId === promotionId),
    commentsRead: oldComments.some(row => row.promotionId === promotionId),
    commentsFullList: oldComments.find(row => row.promotionId === promotionId)?.comments.page.fullList === true,
  }));
  const legacyEvidence = { configuredPromotionIds: previousIds,
    attemptedPromotionIds: [...new Set([...oldEngagements.map(row => row.promotionId), ...oldComments.map(row => row.promotionId)])],
    coverage: legacyCoverage,
    qualifyingActors: evidence.qualifications,
    completionResponses: evidence.completionResponses,
  };
  return { queue, held:classified.filter(user=>!queue.includes(user)), coverage: { followersComplete: followers.page.fullList === true, commentsComplete: comments.page.fullList === true,
    engagementComplete: false, legacy: legacyCoverage }, policy: THREADS_BENEFIT_POLICY, legacyEvidence, writes: 0 };
}
export function observedThreadsCompletionResponses(comments, { promotionId = comments?.postId, owner = THREADS_BENEFIT_POLICY.owner } = {}) {
  const responses=[];let root=null;
  for(const comment of comments?.comments||[]) {
    if(comment.directParentPostId===promotionId) root=comment;
    else if(root && comment.author?.toLowerCase()===owner
      && /완료|스하리|맞팔|\bdone\b|\bfollowed\b/i.test(comment.text||'')) {
      responses.push({promotionId,actorId:root.authorId || null,handle:root.author,commentId:root.id,ownerReplyId:comment.id,
        evidence:'owner completion text in the observed reply group; action receipts unverified'});
    }
  }
  return responses;
}
export function threadsQuota(state, now = Date.now()) {
  const recent = (state.hourlyStarts || []).filter(s => Date.parse(s.startedAt) > now - 3600000 && Date.parse(s.startedAt) <= now)
    .sort((a,b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  return { remaining: null, used: recent.length, retryAt: null, unlimited: true };
}
export function reserveThreadsStart(state, user, now = Date.now()) {
  if (!validId(user.id) || !['base','bonus'].includes(user.stage)) fail('THREADS_BENEFIT_SLOT_INVALID');
  state.hourlyStarts = (state.hourlyStarts || []).filter(s => Date.parse(s.startedAt) > now - 86400000);
  state.hourlyStarts.push({ id: user.id, handle: user.handle, stage: user.stage, startedAt: new Date(now).toISOString() });
  return true;
}
