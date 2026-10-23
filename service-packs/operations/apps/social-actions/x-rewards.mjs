export function baseMayResume(record) {
  return record?.policyVersion===3 && ['reserved','waiting_for_primary_post'].includes(record.status)
    && record.results?.follow?.readbackVerified===true && record.results.follow.following===true
    && !record.replyAttemptedAt && !record.results.reply
    && Object.keys(record.results).every(key=>key==='follow');
}
export function baseNeedsLatestFallback(record) {
  return record?.policyVersion===3 && record.status==='verified' && record.baseStatus==='verified'
    && record.pinnedPostId===null && (record.primarySelectionVersion==null||record.primarySelectionVersion===1&&record.primarySource==null) && !record.bonusStatus
    && record.results?.follow?.readbackVerified===true && record.results.follow.following===true
    && !record.replyAttemptedAt && !record.results.reply
    && Object.keys(record.results).every(key=>key==='follow');
}
export const baseRetryLimit = 3;
export function baseRetryWaiting(record) {
  const replyAttempts=Number.isInteger(record?.replySendAttempts)?record.replySendAttempts:record?.replyAttemptedAt?1:0;
  const beforeReplyDispatch=!record?.replyAttemptedAt&&replyAttempts===0
    &&record?.retry?.reason!=='not_created_owner_timeline_proof';
  return record?.policyVersion===3 && record.status==='retry_wait'
    && record.results?.follow?.readbackVerified===true && record.results.follow.following===true
    && !record.results.reply && Number.isInteger(record.retry?.attempts) && record.retry.attempts < baseRetryLimit
    // Retry is safe only before a reply dispatch has been recorded. Negative
    // owner-history evidence cannot rearm a possibly applied CreateTweet.
    && Number.isFinite(Date.parse(record.retry.after))&&beforeReplyDispatch;
}
// A latest-post target whose newest post changed after the first reaction attempt.
// Held only for that selection change; the resume goes back to the prior post.
export function baseLatestPostChangeResumable(record) {
  return record?.policyVersion===3 && record.status==='needs_reconciliation' && record.primarySource==='latest_original'
    && record.resumeHold?.reason==='pin_changed_after_attempt' && record.resumeHold.priorMissing!==true
    && /^\d{1,25}$/.test(record.pinnedPostId||'') && record.resumeHold.priorPostId===record.pinnedPostId
    && record.results?.follow?.readbackVerified===true && record.results.follow.following===true
    && !record.replyAttemptedAt && !record.results.reply;
}
// A base stage stopped only by an unsettled like/repost journal, before any reply was sent.
// Reaction journals now settle on their own (true readback, or one resend after 2 min),
// so the account is retried every 20 minutes, at most baseRetryLimit times in total.
export const REACTION_HOLD_RETRY_MS = 20 * 60_000;
export function baseReactionHoldResumable(record, now = Date.now()) {
  const code=record?.reconciliationHold?.code||record?.code;
  const checkedAt=Date.parse(record?.reconciliationHold?.checkedAt||record?.retry?.deferredAt||record?.startedAt||'');
  return record?.policyVersion===3 && record.status==='needs_reconciliation' && code==='X_REACTION_RECONCILIATION_REQUIRED'
    && record.results?.follow?.readbackVerified===true && record.results.follow.following===true
    && !record.replyAttemptedAt && !record.results.reply && !record.resumeHold
    && (record.retry?.attempts||0) < baseRetryLimit
    && Number.isFinite(checkedAt) && now-checkedAt >= REACTION_HOLD_RETRY_MS;
}
// The bonus stage is likes/reposts only (the completion notice is a separate batch), and reaction
// journals settle on their own, so a stopped or failed bonus is retried: 20 min after a failure
// (30 min for a 'reserved' one, which may still be running), at most baseRetryLimit attempts.
export function bonusRetryDue(record, now = Date.now()) {
  if (!['needs_reconciliation', 'reserved'].includes(record?.bonusStatus) || record.policyVersion !== 3) return false;
  if (record.status !== 'verified' || (record.bonusRetry?.attempts || 0) >= baseRetryLimit) return false;
  const last = Math.max(Date.parse(record.bonusRetry?.failedAt || '') || 0, Date.parse(record.bonusStartedAt || '') || 0);
  const wait = record.bonusStatus === 'reserved' ? 30 * 60_000 : REACTION_HOLD_RETRY_MS;
  return last > 0 && now - last >= wait;
}
export function baseMayRetry(record, now = Date.now()) {
  return baseRetryWaiting(record) && Date.parse(record.retry.after) <= now;
}
export function rewardStage(record, qualified, now = Date.now()) {
  if (!record) return 'base';
  if (Number.isFinite(Date.parse(record.resumeDeferredUntil)) && Date.parse(record.resumeDeferredUntil) > now) return 'deferred';
  if (baseRetryWaiting(record)) return baseMayRetry(record, now) ? 'base' : 'deferred';
  if (baseMayResume(record)||baseNeedsLatestFallback(record)||baseLatestPostChangeResumable(record)||baseReactionHoldResumable(record, now)) return 'base';
  if (record.status === 'follow_request_pending') return 'pending';
  if (record.status !== 'verified') return 'reconciliation';
  const legacyFull = record.policyVersion === 2 && Array.isArray(record.additionalPostIds)
    && record.additionalPostIds.every(id => record.results?.[id]?.like?.readbackVerified && record.results?.[id]?.repost?.readbackVerified);
  if (record.bonusStatus === 'verified' || legacyFull) return 'complete';
  if (bonusRetryDue(record, now)) return qualified===null?'participation_unverified':qualified ? 'bonus' : 'waiting_for_participation';
  if (['reserved', 'needs_reconciliation'].includes(record.bonusStatus)) return 'reconciliation';
  if (qualified===null) return 'participation_unverified';
  return qualified ? 'bonus' : 'waiting_for_participation';
}
export function qualifiedPromotion(userId, snapshots) {
  return snapshots.find(s => s.likes.includes(userId) && (s.reposts.includes(userId) || s.quotes?.includes(userId)))?.tweetId || null;
}
export function quotedPromotions(items, user, promotionIds) {
  return [...new Set(items.filter(post => post.publisherId === user.id && post.publisher?.toLowerCase() === user.handle.toLowerCase()
    && /^\d{10,25}$/.test(post.id || '') && post.format?.quote === true && promotionIds.includes(post.quotedPostId)).map(post => post.quotedPostId))];
}
