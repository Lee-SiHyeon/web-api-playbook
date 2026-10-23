export const THREADS_BENEFIT_LINKS = Object.freeze({
  main: 'https://www.threads.com/share/BBK7k3y_8E/',
  secondary: 'https://t.me/lifehack_ailab',
});
const validTelegramChannelUrl = value => value === 'https://t.me/lifehack_ailab';

const OWNER = 'lifehack__ailab';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codePoints = value => [...value].length;
const safeId = value => /^\d{10,25}$/.test(String(value ?? ''));
const safeHandle = value => /^[A-Za-z0-9_.]{1,30}$/.test(String(value ?? ''));

function languageOf(post) {
  const declared = String(post?.language ?? post?.format?.lang ?? post?.lang ?? '').toLowerCase();
  if (/^ko(?:-|$)/.test(declared)) return 'ko';
  if (/^en(?:-|$)/.test(declared)) return 'en';
  const text = String(post?.text ?? post?.caption?.text ?? '').replace(/https?:\/\/\S+/g, '');
  const korean = (text.match(/[가-힣]/g) || []).length;
  const english = (text.match(/[A-Za-z]/g) || []).length;
  return korean >= english && korean > 0 ? 'ko' : 'en';
}

function validThreadsPostUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === 'https://www.threads.com'
      && (/^\/share\/[A-Za-z0-9_-]{5,120}\/?$/.test(url.pathname)
        || /^\/@[A-Za-z0-9_.]{1,30}\/post\/[A-Za-z0-9_-]{5,64}\/?$/.test(url.pathname))
      && !url.search && !url.hash;
  } catch { return false; }
}

function checkFinalText(text) {
  if (typeof text !== 'string' || !text.trim() || codePoints(text) > 500) fail('THREADS_BENEFIT_REPLY_TOO_LONG');
  return text;
}

function validateContextComment(contextComment, post) {
  if (!contextComment || typeof contextComment !== 'object' || Array.isArray(contextComment)
    || String(contextComment.postId ?? '') !== String(post.id ?? '')
    || String(contextComment.postAuthor ?? contextComment.author ?? '').toLowerCase() !== String(post.author ?? '').toLowerCase()) {
    fail('THREADS_BENEFIT_CONTEXT_POST_MISMATCH');
  }
  const text = String(contextComment.comment ?? contextComment.text ?? '').trim();
  if (!text || codePoints(text) > 80 || text.split('\n').length > 2
    || /https?:|www\.|@[A-Za-z0-9_.]|#[A-Za-z0-9_]|<[^>]+>|```/i.test(text)
    || /스하리\s*(?:완료|했)|맞팔\s*(?:완료|했)|(?:좋아요|리포스트|리포)\s*(?:완료|했|눌렀)/i.test(text)
    || /\b(?:i|we)\s+(?:already\s+)?(?:followed|liked|reposted)\b|\b(?:follow|like|repost)(?:ing)?\s+(?:is|was|has been)\s+(?:done|completed)\b/i.test(text)
    || /소급|안내\s*변경\s*죄송|sorry for the changing details|retroactive/i.test(text)) {
    fail('THREADS_BENEFIT_CONTEXT_COMMENT_INVALID');
  }
  return text;
}

function isVerifiedFollow(receipt, targetHandle) {
  return receipt?.readbackVerified === true && receipt?.currentState?.following === true
    && typeof receipt.target === 'string' && receipt.target.toLowerCase() === targetHandle.toLowerCase();
}

function isVerifiedReaction(receipt, operation, postId, targetHandle) {
  const state = operation === 'like' ? 'liked' : 'reposted';
  return receipt?.readbackVerified === true && receipt.operation === operation
    && String(receipt.postId ?? '') === String(postId)
    && receipt.currentState?.[state] === true
    && typeof receipt.target === 'string' && receipt.target.toLowerCase() === targetHandle.toLowerCase();
}

function verifiedBaseActions(receipts, targetHandle, primaryPostId) {
  return isVerifiedFollow(receipts?.follow, targetHandle)
    && safeId(primaryPostId)
    && isVerifiedReaction(receipts?.like, 'like', primaryPostId, targetHandle)
    && isVerifiedReaction(receipts?.repost, 'repost', primaryPostId, targetHandle);
}

function verifiedBaseCompletion(receipts, targetHandle, primaryPostId) {
  return verifiedBaseActions(receipts, targetHandle, primaryPostId)
    && isVerifiedContextualReply(receipts?.reply, targetHandle, primaryPostId);
}

function isVerifiedContextualReply(receipt, targetHandle, parentPostId) {
  if (receipt?.readbackVerified !== true || String(receipt.parentPostId ?? receipt.postId ?? '') !== String(parentPostId)) return false;
  const parentAuthor = receipt.parentAuthor ?? receipt.expectedAuthor;
  return parentAuthor == null || String(parentAuthor).toLowerCase() === targetHandle.toLowerCase();
}

function baseFooter(language, { completionVerified, mainShareLink, secondaryShareLink }) {
  if (language === 'ko') {
    return [
      '스하리 기계 도착🚨',
      '기계는 뒷삭이 없다',
      `반하리 와줘라 ${mainShareLink}`,
      '',
      `부수입 정보는 텔레그램에서 👉 ${secondaryShareLink}`,
      ...(completionVerified ? ['', '스하리 완료🚨'] : []),
    ].join('\n');
  }
  return [
    'The follow-back machine has arrived 🚨',
    'This machine never unfollows.',
    `Follow back! ${mainShareLink}`,
    '',
    `Side-income tips on Telegram 👉 ${secondaryShareLink}`,
    ...(completionVerified ? ['', 'Follow, like and repost complete.'] : []),
  ].join('\n');
}

/** Compose under the verified pin or the planner's verified latest-original fallback. */
export function composeThreadsBenefitReply({
  target,
  pinnedPost,
  primarySelection = null,
  contextComment,
  receipts = {},
  mainShareLink = THREADS_BENEFIT_LINKS.main,
  secondaryShareLink = THREADS_BENEFIT_LINKS.secondary,
} = {}) {
  const handle = target?.handle;
  if (!safeHandle(handle)) fail('THREADS_BENEFIT_TARGET_INVALID');
  if (target.protected === true) return { shouldReply: false, reason: 'TARGET_PROTECTED', language: 'ko' };
  if (target.protected !== false) return { shouldReply: false, reason: 'TARGET_VISIBILITY_UNVERIFIED', language: 'ko' };
  const isPinned = pinnedPost?.isPinnedToProfile === true || pinnedPost?.isPinned === true || pinnedPost?.pinVerified === true;
  const isLatestOriginal = primarySelection?.source === 'latest_original' && primarySelection.pinAbsenceVerified === true
    && primarySelection.postId === pinnedPost?.id && pinnedPost?.isPinnedToProfile === false
    && pinnedPost?.isReply === false && Number.isFinite(Date.parse(pinnedPost?.publishedAt))
    && Date.parse(pinnedPost.publishedAt) <= Date.now();
  if (!(isPinned || isLatestOriginal) || !safeId(pinnedPost?.id) || String(target.pinnedPostId ?? pinnedPost.id) !== String(pinnedPost.id)
    || String(pinnedPost.author ?? '').toLowerCase() !== handle.toLowerCase()) {
    return { shouldReply: false, reason: 'PIN_NOT_VERIFIED', language: languageOf(pinnedPost) };
  }
  if (!validThreadsPostUrl(mainShareLink) || !validTelegramChannelUrl(secondaryShareLink)) fail('THREADS_BENEFIT_LINK_INVALID');
  const contextualText = validateContextComment(contextComment, pinnedPost);
  const language = languageOf(pinnedPost);
  // This is the contextual comment itself. Its later readback cannot be a prerequisite
  // for wording that comment, so only claim actions with already verified receipts.
  const completionVerified = verifiedBaseActions(receipts, handle, pinnedPost.id);
  const text = checkFinalText(`${contextualText}\n\n${baseFooter(language, { completionVerified, mainShareLink, secondaryShareLink })}`);
  return { shouldReply: true, parentPostId: pinnedPost.id, expectedAuthor: handle, text, language,
    completionVerified, claim: completionVerified ? 'follow_like_repost_verified' : 'none',
    characterCount: codePoints(text), mentionMode: 'plain_text' };
}

function verifiedBonusCount(bonusPairs, targetHandle, primaryPostId) {
  if (!Array.isArray(bonusPairs) || bonusPairs.length > 9) fail('THREADS_BENEFIT_BONUS_RECEIPTS_INVALID');
  const seen = new Set();
  let count = 0;
  for (const pair of bonusPairs) {
    const postId = String(pair?.postId ?? '');
    if (!safeId(postId) || seen.has(postId)) fail('THREADS_BENEFIT_BONUS_RECEIPTS_INVALID');
    seen.add(postId);
    if (postId === String(primaryPostId ?? '')) continue;
    if (isVerifiedReaction(pair.like, 'like', postId, targetHandle)
      && isVerifiedReaction(pair.repost, 'repost', postId, targetHandle)) count += 1;
  }
  return count;
}

/** Compose the promised response to one exact comment after its stage receipts verify. */
export function composeThreadsCompletionReply({ promotionPost, triggeringComment = null, target, stage = 'base', receipts = {}, qualifyingPostId,
  previousPromotionIds = [] } = {}) {
  if (!safeId(promotionPost?.id) || String(promotionPost.author ?? '').toLowerCase() !== OWNER
    || !validThreadsPostUrl(promotionPost.url) || !safeHandle(target?.handle) || !safeId(target?.id)
    || !['base', 'bonus'].includes(stage) || !Array.isArray(previousPromotionIds)
    || previousPromotionIds.some(id => !safeId(id) || String(id) === String(promotionPost.id))) {
    fail('THREADS_BENEFIT_COMPLETION_INPUT_INVALID');
  }
  if (target.protected === true) return { shouldReply: false, reason: 'TARGET_PROTECTED', language: languageOf(promotionPost) };
  const language = languageOf(promotionPost);
  if (receipts.primaryPostId != null && !safeId(receipts.primaryPostId)) {
    return { shouldReply: false, reason: 'PRIMARY_POST_RECEIPT_INVALID', language };
  }
  const hasPin = safeId(receipts.primaryPostId);
  const followVerified = isVerifiedFollow(receipts.follow, target.handle);
  const baseActionsVerified = hasPin && verifiedBaseCompletion(receipts, target.handle, receipts.primaryPostId);
  const qualification = qualifyingPostId ?? receipts.qualifyingPostId;
  const activeQualified = safeId(qualification) && String(qualification) === String(promotionPost.id);
  const legacyQualified = safeId(qualification) && previousPromotionIds.includes(String(qualification));
  const bonusEligible = activeQualified || legacyQualified;
  const bonusPendingKo = legacyQualified
    ? '이전 안내글 참여가 확인되어 보너스 대기 중이에요. 결과는 별도 답글로 알려드릴게요.'
    : '같은 안내글 참여가 확인됐어요. 추가 스하리 결과는 별도 답글로 알려드릴게요.';
  const bonusPendingEn = legacyQualified
    ? 'Your participation on an earlier promotion is verified; the bonus is pending and I will post its result separately.'
    : 'Your participation on this promotion is confirmed; I will post another update with the bonus result.';
  let verifiedPairCount = 0;
  if (stage === 'base' && !followVerified) return { shouldReply: false, reason: 'FOLLOW_NOT_VERIFIED', language };
  if (stage === 'bonus') {
    verifiedPairCount = verifiedBonusCount(receipts.bonusPairs, target.handle, receipts.primaryPostId);
    if (!followVerified || verifiedPairCount < 1) return { shouldReply: false, reason: 'BONUS_STAGE_NOT_VERIFIED', language,
      verifiedPairCount };
  }
  let replyToPostId = promotionPost.id;
  let expectedAuthor = OWNER;
  if (triggeringComment != null) {
    if (!safeId(triggeringComment.id) || String(triggeringComment.directParentPostId ?? '') !== String(promotionPost.id)
      || String(triggeringComment.author ?? '').toLowerCase() !== target.handle.toLowerCase()
      || triggeringComment.authorVerified === false
      || triggeringComment.authorId != null && String(triggeringComment.authorId) !== String(target.id)) {
      return { shouldReply: false, reason: 'TRIGGERING_COMMENT_MISMATCH', language };
    }
    replyToPostId = triggeringComment.id;
    expectedAuthor = target.handle;
  }
  let text;
  if (stage === 'bonus') {
    text = language === 'ko'
      ? `고마워요 @${target.handle}! 추가 반응 ${verifiedPairCount}쌍 확인했어요 🚨`
      : `Thanks, @${target.handle}! Verified ${verifiedPairCount} additional like/repost pair${verifiedPairCount === 1 ? '' : 's'} 🚨`;
  } else if (!hasPin) {
    text = language === 'ko'
      ? `고마워요 @${target.handle}! 맞팔 완료🚨\n${bonusEligible
        ? bonusPendingKo
        : `추가 혜택은 이 안내글에 좋아요와 리포스트를 둘 다 해주시면 확인할게요: ${promotionPost.url}`}`
      : `Thanks, @${target.handle}! Follow-back complete 🚨\n${bonusEligible
        ? bonusPendingEn
        : `Like and repost this same promotion for the bonus: ${promotionPost.url}`}`;
  } else if (baseActionsVerified) {
    text = language === 'ko'
      ? `고마워요 @${target.handle}! 스하리 완료🚨\n${bonusEligible
        ? bonusPendingKo
        : `추가 혜택은 이 안내글에 좋아요와 리포스트를 둘 다 해주시면 확인할게요: ${promotionPost.url}`}`
      : `Thanks, @${target.handle}! Follow, like and repost complete 🚨\n${bonusEligible
        ? bonusPendingEn
        : `For the bonus, like and repost this same promotion: ${promotionPost.url}`}`;
  } else {
    return { shouldReply: false, reason: 'BASE_ACTIONS_NOT_VERIFIED', language };
  }
  text = checkFinalText(text);
  return { shouldReply: true, replyToPostId, expectedAuthor,
    receiptKey: `benefit-${stage}-${target.id}`, text, language,
    claim: stage === 'bonus' ? `verified_bonus_pairs_${verifiedPairCount}`
      : hasPin ? 'follow_like_repost_verified' : 'follow_only_verified',
    verifiedPairCount: stage === 'bonus' ? verifiedPairCount : 0,
    characterCount: codePoints(text), mentionMode: 'plain_text',
  };
}
