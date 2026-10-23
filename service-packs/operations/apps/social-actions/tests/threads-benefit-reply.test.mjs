import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeThreadsBenefitReply, composeThreadsCompletionReply,
} from '../threads-benefit-reply.mjs';

const OWNER = 'lifehack__ailab';
const TARGET_ID = '17890000123456789';
const PIN_ID = '3996994421430736442';
const PROMO_ID = '3996994421430737000';
const COMMENT_ID = '3996994421430737111';
const target = { id: TARGET_ID, handle: 'target_person', protected: false, pinnedPostId: PIN_ID };
const pinnedPost = { id: PIN_ID, author: target.handle, text: '생활정보를 편하게 나누는 공간입니다.', isPinnedToProfile: true };
const promotionPost = { id: PROMO_ID, author: OWNER, text: '댓글 달아주시면 스하리 후 완료 답글 달아드릴게요',
  url: 'https://www.threads.com/@lifehack__ailab/post/ABCde12' };

function verifiedBaseReceipts(postId = PIN_ID) {
  return {
    primaryPostId: postId,
    follow: { target: target.handle, readbackVerified: true, currentState: { following: true } },
    like: { target: target.handle, operation: 'like', postId, readbackVerified: true, currentState: { liked: true } },
    repost: { target: target.handle, operation: 'repost', postId, readbackVerified: true, currentState: { reposted: true } },
  };
}

function verifiedCompletionReceipts(postId = PIN_ID) {
  return { ...verifiedBaseReceipts(postId),
    reply: { postId, parentAuthor: target.handle, readbackVerified: true } };
}

function verifiedPair(postId, { reposted = true } = {}) {
  return { postId,
    like: { target: target.handle, operation: 'like', postId, readbackVerified: true, currentState: { liked: true } },
    repost: { target: target.handle, operation: 'repost', postId, readbackVerified: reposted, currentState: { reposted } },
  };
}

test('base reply preserves the requested Korean footer and binds context to the exact pinned post', () => {
  const contextComment = { postId: PIN_ID, postAuthor: target.handle, comment: '꾸준히 나누는 모습이 보기 좋네요.' };
  const result = composeThreadsBenefitReply({ target, pinnedPost, contextComment, receipts: { ...verifiedBaseReceipts(), like: null, repost: null } });
  assert.equal(result.shouldReply, true);
  assert.equal(result.parentPostId, PIN_ID);
  assert.equal(result.expectedAuthor, target.handle);
  assert.equal(result.language, 'ko');
  assert.equal(result.completionVerified, false);
  assert.match(result.text, /스하리 기계 도착🚨\n기계는 뒷삭이 없다\n반하리 와줘라 https:\/\/www\.threads\.com\/share\/BBK7k3y_8E\//);
  assert.match(result.text, /부수입 정보는 텔레그램에서 👉 https:\/\/t\.me\/lifehack_ailab/);
  assert.doesNotMatch(result.text, /당근/);
  assert.doesNotMatch(result.text, /스하리 완료/);
  assert.ok(result.characterCount <= 500);

  const verified = composeThreadsBenefitReply({ target: { ...target, blueVerified: false }, pinnedPost,
    contextComment, receipts: verifiedBaseReceipts() });
  assert.equal(verified.completionVerified, true);
  assert.match(verified.text, /스하리 완료🚨/);
  assert.equal(verified.claim, 'follow_like_repost_verified');
});

test('unverified or mismatched action receipts never claim completion; context must identify the actual post', () => {
  const contextComment = { postId: PIN_ID, postAuthor: target.handle, comment: '소개 글 잘 읽었어요.' };
  const wrongPost = { ...verifiedBaseReceipts(), repost: { ...verifiedBaseReceipts().repost, postId: '3996994421430736999' } };
  const result = composeThreadsBenefitReply({ target: { ...target, blueVerified: true }, pinnedPost,
    contextComment, receipts: wrongPost });
  assert.equal(result.completionVerified, false);
  assert.doesNotMatch(result.text, /스하리 완료/);
  assert.throws(() => composeThreadsBenefitReply({ target, pinnedPost,
    contextComment: { ...contextComment, postId: '3996994421430736000' }, receipts: verifiedBaseReceipts() }),
  /THREADS_BENEFIT_CONTEXT_POST_MISMATCH/);
  assert.throws(() => composeThreadsBenefitReply({ target, pinnedPost,
    contextComment: { ...contextComment, comment: '좋아요와 리포스트 완료했습니다.' }, receipts: verifiedBaseReceipts() }),
  /THREADS_BENEFIT_CONTEXT_COMMENT_INVALID/);
});

test('protected and missing-pin targets receive no pin comment', () => {
  const contextComment = { postId: PIN_ID, postAuthor: target.handle, comment: '소개를 잘 읽었습니다.' };
  assert.deepEqual(composeThreadsBenefitReply({ target: { ...target, protected: true }, pinnedPost, contextComment }),
    { shouldReply: false, reason: 'TARGET_PROTECTED', language: 'ko' });
  assert.equal(composeThreadsBenefitReply({ target: { ...target, pinnedPostId: null }, pinnedPost: null, contextComment }).shouldReply, false);
  assert.equal(composeThreadsBenefitReply({ target: { ...target, protected: undefined }, pinnedPost, contextComment }).reason,
    'TARGET_VISIBILITY_UNVERIFIED');
});

test('completion reply targets the exact triggering comment and only base stage invites activity on this promotion', () => {
  const noPinReplyReceipt = composeThreadsCompletionReply({ promotionPost, target, stage: 'base', receipts: verifiedBaseReceipts(),
    triggeringComment: { id: COMMENT_ID, directParentPostId: PROMO_ID, author: target.handle, authorId: TARGET_ID } });
  assert.equal(noPinReplyReceipt.shouldReply, false);
  assert.equal(noPinReplyReceipt.reason, 'BASE_ACTIONS_NOT_VERIFIED');

  const result = composeThreadsCompletionReply({ promotionPost, target, stage: 'base', receipts: verifiedCompletionReceipts(),
    triggeringComment: { id: COMMENT_ID, directParentPostId: PROMO_ID, author: target.handle, authorId: TARGET_ID } });
  assert.equal(result.shouldReply, true);
  assert.equal(result.replyToPostId, COMMENT_ID);
  assert.equal(result.expectedAuthor, target.handle);
  assert.equal(result.receiptKey, `benefit-base-${TARGET_ID}`);
  assert.match(result.text, /고마워요 @target_person! 스하리 완료🚨/);
  assert.match(result.text, new RegExp(promotionPost.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.text, /좋아요와 리포스트를 둘 다/);
  assert.equal(result.mentionMode, 'plain_text');
  assert.ok(result.characterCount <= 500);
  assert.equal(composeThreadsCompletionReply({ promotionPost, target, stage: 'base', receipts: verifiedCompletionReceipts(),
    triggeringComment: { id: COMMENT_ID, directParentPostId: PROMO_ID, author: 'someone_else' } }).shouldReply, false);

  for (const reply of [
    { postId: '3996994421430736888', parentAuthor: target.handle, readbackVerified: true },
    { postId: PIN_ID, parentAuthor: 'someone_else', readbackVerified: true },
  ]) {
    const mismatched = composeThreadsCompletionReply({ promotionPost, target, stage: 'base',
      receipts: { ...verifiedBaseReceipts(), reply },
      triggeringComment: { id: COMMENT_ID, directParentPostId: PROMO_ID, author: target.handle, authorId: TARGET_ID } });
    assert.equal(mismatched.shouldReply, false);
    assert.equal(mismatched.reason, 'BASE_ACTIONS_NOT_VERIFIED');
  }
});

test('same-promotion qualification changes the base notice to bonus-pending without repeating its invitation', () => {
  const verified = verifiedCompletionReceipts();
  const qualified = composeThreadsCompletionReply({ promotionPost, target, stage: 'base', receipts: verified,
    qualifyingPostId: PROMO_ID, triggeringComment: null });
  assert.equal(qualified.shouldReply, true);
  assert.match(qualified.text, /같은 안내글 참여가 확인/);
  assert.match(qualified.text, /추가 스하리 결과는 별도 답글/);
  assert.doesNotMatch(qualified.text, /좋아요와 리포스트를 둘 다/);

  const otherPromotion = composeThreadsCompletionReply({ promotionPost, target, stage: 'base', receipts: verified,
    qualifyingPostId: '3996994421430737999', triggeringComment: null });
  assert.match(otherPromotion.text, /좋아요와 리포스트를 둘 다/);
  assert.ok(otherPromotion.text.includes(promotionPost.url));
});

test('follower-only base notices say follow-back only and bonus notices state the actual verified pair count', () => {
  const followerOnly = composeThreadsCompletionReply({ promotionPost, target: { ...target, pinnedPostId: null }, stage: 'base',
    receipts: { primaryPostId: null, follow: { target: target.handle, readbackVerified: true,
      currentState: { following: true } } }, triggeringComment: null });
  assert.equal(followerOnly.replyToPostId, PROMO_ID);
  assert.equal(followerOnly.expectedAuthor, OWNER);
  assert.equal(followerOnly.claim, 'follow_only_verified');
  assert.match(followerOnly.text, /맞팔 완료/);
  assert.doesNotMatch(followerOnly.text, /스하리 완료/);
  assert.match(followerOnly.text, new RegExp(promotionPost.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(followerOnly.text, /좋아요와 리포스트/); // invitation only; no completion claim

  const bonus = composeThreadsCompletionReply({ promotionPost, target, stage: 'bonus',
    receipts: { follow: { target: target.handle, readbackVerified: true, currentState: { following: true } },
      primaryPostId: PIN_ID,
      bonusPairs: [verifiedPair(PIN_ID), verifiedPair('3996994421430737201'), verifiedPair('3996994421430737202'),
        verifiedPair('3996994421430737203', { reposted: false })] },
    triggeringComment: { id: COMMENT_ID, directParentPostId: PROMO_ID, author: target.handle, authorId: TARGET_ID } });
  assert.equal(bonus.verifiedPairCount, 2);
  assert.equal(bonus.receiptKey, `benefit-bonus-${TARGET_ID}`);
  assert.equal(bonus.replyToPostId, COMMENT_ID);
  assert.match(bonus.text, /추가 반응 2쌍 확인/);
  assert.doesNotMatch(bonus.text, /9|안내글에 좋아요/);
  assert.ok(bonus.characterCount <= 500);
});

test('English post text selects English wording and failed receipts suppress the promised completion response', () => {
  const englishPin = { id: PIN_ID, author: target.handle, text: 'A simple routine makes life easier.', isPinned: true };
  const result = composeThreadsBenefitReply({ target, pinnedPost: englishPin,
    contextComment: { postId: PIN_ID, postAuthor: target.handle, comment: 'That routine sounds easy to keep.' } });
  assert.equal(result.language, 'en');
  assert.match(result.text, /The follow-back machine has arrived/);

  const denied = composeThreadsCompletionReply({ promotionPost, target, stage: 'base', receipts: {
    follow: { target: target.handle, readbackVerified: false, currentState: { following: false } },
  } });
  assert.equal(denied.shouldReply, false);
  assert.equal(denied.reason, 'FOLLOW_NOT_VERIFIED');
});
