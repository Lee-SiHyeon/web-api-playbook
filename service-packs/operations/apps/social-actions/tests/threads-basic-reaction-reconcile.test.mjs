import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileThreadsBasicReactionStages } from '../threads-basic-reaction-reconcile.mjs';

const actorId = '17824859400';
const otherActorId = '17824859401';
const handle = 'hello_kim.m';
const promotionId = '3997530329766474170';
const otherPromotionId = '3997530329766474171';
const postId = '3983580490905486164';
const otherPostId = '3983580490905486165';
const owner = 'lifehack__ailab';
const checkedAt = '2026-10-05T12:00:00.000Z';

function uncertainReaction(operation = 'like') {
  return {
    owner, operation, postId, target: handle, status: 'needs_reconciliation',
    success: false, readbackVerified: false, writes: 1, dispatchConfirmed: true,
    code: 'THREADS_READ_BUDGET_WAIT', checkedAt,
    currentState: { id: postId, author: handle, authorId: actorId, liked: false, reposted: false },
  };
}

function positiveReaction(operation = 'like', { responseActorId = actorId, responsePostId = postId } = {}) {
  return {
    owner, operation, postId: responsePostId, target: handle, status: 'verified',
    success: true, readbackVerified: true, writes: 1, dispatchConfirmed: true,
    checkedAt: '2026-10-05T12:01:00.000Z',
    currentState: { id: responsePostId, author: handle, authorId: responseActorId,
      liked: operation === 'like', reposted: operation === 'repost' },
  };
}

function fixture({ attemptedOperations = 2 } = {}) {
  const record = {
    handle,
    baseStatus: 'needs_reconciliation',
    bonusStatus: 'not_started',
    activePromotionId: promotionId,
    entrance: 'positive_incoming_follow',
    pinnedPostId: postId,
    attemptedOperations,
    currentOperation: null,
    historyHold: {
      status: 'follow_verified', promotionId,
      code: 'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
      followAttemptOperations: 1, pinnedPostId: postId,
    },
    results: {
      primaryPostId: postId,
      follow: {
        service: 'threads', operation: 'follow', target: handle, normalizedTarget: actorId,
        mutationCount: 1, readbackVerified: true,
        currentState: { following: true, outgoingRequest: false },
      },
    },
    code: 'THREADS_READ_BUDGET_WAIT',
    basicReactions: {
      status: 'needs_reconciliation', postId, code: 'THREADS_READ_BUDGET_WAIT',
      startedAt: '2026-10-05T11:59:00.000Z', results: { like: uncertainReaction('like') },
    },
  };
  const state = {
    service: 'threads', owner, policyVersion: 1, activePromotionId: promotionId,
    records: { [actorId]: record },
  };
  return { state, record };
}

function harness({ state, reaction, config = { activePromotionId: promotionId, owner },
  promotionVerifier = async () => {}, persistState = async () => {} }) {
  const calls = [];
  let locked = false;
  const lock = async task => {
    calls.push('lock'); locked = true;
    try { return await task(); } finally { locked = false; }
  };
  const requireLock = label => { assert.equal(locked, true, `${label} must share the coordinator lock`); };
  return {
    calls,
    run: () => reconcileThreadsBasicReactionStages({ actorIds: [actorId], root: 'unused-root' }, {
      lock,
      configReader: async () => { requireLock('config read'); calls.push('config'); return config; },
      readState: async () => { requireLock('state read'); calls.push('state'); return state; },
      promotionVerifier: async value => { requireLock('active promotion verification'); calls.push('promotion'); return promotionVerifier(value); },
      reaction: async input => { requireLock('reaction reconcile'); calls.push(input); return reaction(input); },
      persistState: async value => { requireLock('state persistence'); calls.push('persist'); return persistState(value); },
      now: () => Date.parse('2026-10-05T12:02:00.000Z'),
    }),
  };
}

test('positive exact readback archives the unknown receipt and resumes only the untouched repost', async () => {
  const { state, record } = fixture();
  const h = harness({ state, reaction: async input => {
    assert.deepEqual(input, { operation: 'like', postId, expectedAuthor: handle,
      expectedActorId: actorId, reconcile: true, execute: false });
    return positiveReaction(input.operation);
  } });

  const result = await h.run();
  assert.equal(result.reconciliationOnly, true);
  assert.equal(result.newWrites, 0);
  assert.equal(result.externalWrites, 0);
  assert.deepEqual(result.results[0].verifiedOperations, ['like']);
  assert.equal(result.results[0].status, 'partial_resumable');
  assert.equal(result.results[0].resumable, true);
  assert.equal(record.basicReactions.status, 'reserved');
  assert.equal(record.baseStatus, 'follow_verified_reward_held');
  assert.equal(record.currentOperation, null);
  assert.equal(record.basicReactions.results.like.readbackVerified, true);
  assert.equal(record.basicReactions.results.repost, undefined);
  assert.equal(record.basicReactions.reconciledAt, '2026-10-05T12:02:00.000Z');
  assert.equal(record.basicReactions.reconciliationHistory[0].priorStageCode, 'THREADS_READ_BUDGET_WAIT');
  assert.equal(record.basicReactions.reconciliationHistory[0].priorRecordCode, 'THREADS_READ_BUDGET_WAIT');
  assert.equal(record.basicReactions.reconciliationHistory[0].priorCheckedAt, checkedAt);
  assert.equal(record.basicReactions.reconciliationHistory[0].priorResult.currentState.liked, false);
  assert.equal(h.calls.filter(call => typeof call === 'object').length, 1);
  assert.ok(h.calls.indexOf('persist') > h.calls.indexOf('promotion'));
});

test('negative readback stays held and does not replace the original uncertain receipt', async () => {
  const { state, record } = fixture();
  const original = structuredClone(record.basicReactions.results.like);
  const h = harness({ state, reaction: async () => ({
    ...positiveReaction('like'), success: false, readbackVerified: false, status: 'needs_reconciliation',
    currentState: { id: postId, author: handle, authorId: actorId, liked: false, reposted: false },
  }) });

  const result = await h.run();
  assert.equal(result.results[0].status, 'held');
  assert.equal(result.results[0].resumable, false);
  assert.equal(result.externalWrites, 0);
  assert.deepEqual(record.basicReactions.results.like, original);
  assert.equal(record.basicReactions.status, 'needs_reconciliation');
  assert.equal(record.baseStatus, 'needs_reconciliation');
  assert.equal(h.calls.includes('persist'), false);
});

test('wrong owner in a saved receipt or a new readback cannot settle a reaction', async () => {
  const saved = fixture();
  saved.record.basicReactions.results.like.owner = 'another_owner';
  let savedReceiptCalls = 0;
  const savedHarness = harness({ state: saved.state, reaction: async () => {
    savedReceiptCalls++;
    return positiveReaction();
  } });
  const savedResult = await savedHarness.run();
  assert.equal(savedResult.results[0].status, 'held');
  assert.equal(savedReceiptCalls, 0);
  assert.equal(savedHarness.calls.includes('persist'), false);

  const readback = fixture();
  const readbackHarness = harness({ state: readback.state, reaction: async input => ({
    ...positiveReaction(input.operation), owner: 'another_owner',
  }) });
  const readbackResult = await readbackHarness.run();
  assert.equal(readbackResult.results[0].status, 'held');
  assert.equal(readback.record.basicReactions.status, 'needs_reconciliation');
  assert.equal(readback.record.baseStatus, 'needs_reconciliation');
  assert.equal(readbackHarness.calls.includes('persist'), false);
});

test('wrong actor, primary post, or promotion signatures never reach reaction reconciliation', async () => {
  const mutations = [
    record => { record.results.follow.normalizedTarget = otherActorId; },
    record => { record.basicReactions.postId = otherPostId; },
    record => { record.activePromotionId = otherPromotionId; },
  ];
  for (const mutate of mutations) {
    const { state, record } = fixture();
    mutate(record);
    let reactionCalls = 0;
    const h = harness({ state, reaction: async () => { reactionCalls++; return positiveReaction(); } });
    const result = await h.run();
    assert.equal(result.results[0].status, 'held');
    assert.equal(result.results[0].code, 'THREADS_BASIC_REACTION_RECONCILE_SIGNATURE_INVALID');
    assert.equal(reactionCalls, 0);
    assert.equal(h.calls.includes('persist'), false);
  }

  const { state, record } = fixture();
  const h = harness({ state, reaction: async input => positiveReaction(input.operation, { responseActorId: otherActorId }) });
  const result = await h.run();
  assert.equal(result.results[0].status, 'held');
  assert.equal(record.basicReactions.status, 'needs_reconciliation');
  assert.equal(record.baseStatus, 'needs_reconciliation');
  assert.equal(h.calls.includes('persist'), false);
});

test('an already-attempted missing repost remains held after the like is positively reconciled', async () => {
  const { state, record } = fixture({ attemptedOperations: 3 });
  const h = harness({ state, reaction: async input => positiveReaction(input.operation) });
  const result = await h.run();
  assert.deepEqual(result.results[0].verifiedOperations, ['like']);
  assert.equal(result.results[0].status, 'needs_reconciliation');
  assert.equal(result.results[0].resumable, false);
  assert.equal(record.basicReactions.results.like.readbackVerified, true);
  assert.equal(record.basicReactions.status, 'needs_reconciliation');
  assert.equal(record.baseStatus, 'needs_reconciliation');
  assert.equal(h.calls.includes('persist'), true);
});

test('two exact positive readbacks verify both reactions and preserve completion timestamps', async () => {
  const { state, record } = fixture({ attemptedOperations: 3 });
  record.basicReactions.results.repost = uncertainReaction('repost');
  const h = harness({ state, reaction: async input => positiveReaction(input.operation) });
  const result = await h.run();
  assert.deepEqual(result.results[0].verifiedOperations, ['like', 'repost']);
  assert.equal(result.results[0].status, 'verified');
  assert.equal(result.results[0].resumable, false);
  assert.equal(record.basicReactions.status, 'verified');
  assert.equal(record.baseStatus, 'follow_verified_reward_held');
  assert.equal(record.basicReactions.reconciledAt, '2026-10-05T12:02:00.000Z');
  assert.equal(record.basicReactions.finishedAt, '2026-10-05T12:02:00.000Z');
  assert.deepEqual(record.basicReactions.reconciliationHistory.map(row => row.operation), ['like', 'repost']);
  assert.equal(result.externalWrites, 0);
});

test('a missing reaction journal leaves its benefits state held', async () => {
  const { state, record } = fixture();
  const h = harness({ state, reaction: async () => { throw Object.assign(new Error('no journal'), {
    code: 'THREADS_REACTION_JOURNAL_MISMATCH',
  }); } });
  const result = await h.run();
  assert.equal(result.results[0].status, 'held');
  assert.equal(result.results[0].code, 'THREADS_REACTION_JOURNAL_MISMATCH');
  assert.equal(record.basicReactions.status, 'needs_reconciliation');
  assert.equal(record.baseStatus, 'needs_reconciliation');
  assert.equal(h.calls.includes('persist'), false);
});

test('a state persistence failure can be retried from a fresh read without dispatching or duplicating history', async () => {
  const initial = fixture().state;
  let durableState = structuredClone(initial);
  let persistCount = 0, readCount = 0, reconcileCount = 0;
  const dependencies = () => ({
    configReader: async () => ({ activePromotionId: promotionId, owner }),
    promotionVerifier: async () => {},
    readState: async () => { readCount++; return structuredClone(durableState); },
    persistState: async state => {
      persistCount++;
      if (persistCount === 1) throw Object.assign(new Error('simulated atomic state save failure'), {
        code: 'THREADS_BENEFIT_STATE_PERSIST_FAILED',
      });
      durableState = structuredClone(state);
    },
    reaction: async input => {
      reconcileCount++;
      assert.equal(input.reconcile, true);
      assert.equal(input.execute, false);
      return positiveReaction(input.operation);
    },
    lock: task => task(),
    now: () => Date.parse('2026-10-05T12:02:00.000Z'),
  });
  const run = () => reconcileThreadsBasicReactionStages({ actorIds: [actorId], root: 'unused-root' }, dependencies());

  await assert.rejects(run(), { code: 'THREADS_BENEFIT_STATE_PERSIST_FAILED' });
  assert.equal(durableState.records[actorId].basicReactions.status, 'needs_reconciliation');
  const retry = await run();
  assert.equal(retry.results[0].status, 'partial_resumable');
  assert.equal(retry.externalWrites, 0);
  assert.equal(readCount, 2);
  assert.equal(reconcileCount, 2, 'both calls only reconcile the existing reaction journal');
  assert.equal(durableState.records[actorId].basicReactions.status, 'reserved');
  assert.equal(durableState.records[actorId].basicReactions.reconciliationHistory.length, 1);
  assert.equal(durableState.records[actorId].basicReactions.reconciliationHistory[0].priorCheckedAt, checkedAt);
});

test('state bound to another promotion fails closed before any reaction query', async () => {
  const { state } = fixture();
  state.activePromotionId = otherPromotionId;
  let reactionCalls = 0;
  const h = harness({ state, reaction: async () => { reactionCalls++; return positiveReaction(); } });
  await assert.rejects(h.run(), { code: 'THREADS_BENEFIT_ACTIVE_PROMOTION_CHANGED_REVIEW_REQUIRED' });
  assert.equal(reactionCalls, 0);
  assert.equal(h.calls.includes('promotion'), false);
  assert.equal(h.calls.includes('persist'), false);
});
