import { access, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerFor, reconcileAction } from './index.mjs';
import { executeJournaled } from './lib/journal.mjs';
import { reactThreads } from './threads-reactions.mjs';
import { threadsBenefitWorkerCooldown } from './threads-benefit-worker.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), details, { code }); };
const safeCode = value => /^[A-Z][A-Z0-9_]{2,100}$/.test(value || '') ? value : 'THREADS_OUTREACH_ENGAGEMENT_UNVERIFIED';
const validId = value => /^\d{1,25}$/.test(value || '');
const validPost = value => /^\d{10,25}$/.test(value || '');

export async function followThreadsOutreachActor({ actorId, author, journalPath, isStopRequested = async () => false }, {
  providerLoader = providerFor, reconcile = reconcileAction, journalExecutor = executeJournaled,
} = {}) {
  const input = { service: 'threads', operation: 'follow', target: author };
  let existing = true;
  try {
    await access(journalPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existing = false;
  }
  if (existing) {
    const result = await reconcile(journalPath);
    if (String(result.normalizedTarget) !== actorId || result.target?.toLowerCase() !== author.toLowerCase()) fail('THREADS_OUTREACH_ACTOR_CHANGED');
    if (result.status !== 'not_sent' || result.mutationCount !== 0 || result.needs_reconciliation === true || await isStopRequested()) {
      return { ...result, writesThisRun: 0 };
    }
    // Only a journal independently proven to contain zero attempts can be replaced.
    // Preserve that proof beside the new fixed-path journal before resuming.
    const original = path.resolve(journalPath);
    const archived = path.resolve(original + '.not-sent-' + randomUUID());
    if (path.dirname(original) !== path.dirname(archived)) fail('THREADS_OUTREACH_ENGAGEMENT_SCOPE_INVALID');
    await rename(original, archived);
  }
  const provider = await providerLoader('threads');
  const bound = ready => {
    if (ready.service !== 'threads' || ready.operation !== 'follow' || String(ready.normalizedTarget) !== actorId
      || ready.target?.toLowerCase() !== author.toLowerCase() || ready.auth?.ownerVerified !== true) fail('THREADS_OUTREACH_ACTOR_CHANGED');
    return ready;
  };
  const result = await journalExecutor(input, {
    prepare: async value => {
      const ready = bound(await provider.prepare(value));
      if (await isStopRequested()) fail('THREADS_OUTREACH_STOP_REQUESTED');
      return ready;
    },
    execute: async (value, options) => {
      let guardedReady, stopped = false;
      try {
        return await provider.execute(value, { ...options, beforeWrite: async ready => {
          guardedReady = bound(ready);
          if (await isStopRequested()) { stopped = true; return false; }
          await options.beforeWrite(guardedReady);
          if (await isStopRequested()) { stopped = true; return false; }
        } });
      } catch (error) {
        if (!stopped || error.code !== 'SOCIAL_JOURNAL_REJECTED') throw error;
        return { ...guardedReady, status: 'blocked', success: false, code: 'THREADS_OUTREACH_STOP_REQUESTED',
          mutationCount: 0, writeSent: false, readbackVerified: false };
      }
    },
  }, { journalPath });
  return { ...result, writesThisRun: result.mutationCount };
}

export function safeThreadsOutreachEngagementReceipt(operation, value) {
  const count = value?.writesThisRun ?? value?.mutationCount ?? value?.writes;
  return {
    operation, status: typeof value?.status === 'string' ? value.status : 'needs_reconciliation',
    success: value?.success === true, readbackVerified: value?.readbackVerified === true,
    writesThisRun: Number.isSafeInteger(count) && count >= 0 ? count : null,
    noOp: value?.noOp === true, reconciliationOnly: value?.reconciliationOnly === true,
    ...(typeof value?.responseVerified === 'boolean' ? { responseVerified: value.responseVerified } : {}),
    ...(value?.priorResponseUnverified === true ? { priorResponseUnverified: true } : {}),
    ...(value?.notSentVerified === true ? { notSentVerified: true } : {}),
    ...(typeof value?.journalPath === 'string' ? { journalPath: value.journalPath } : {}),
    ...(value?.priorWriteCode || value?.code ? { code: safeCode(value.priorWriteCode || value.code) } : {}),
    ...(Number.isInteger(value?.priorWriteHttpStatus ?? value?.httpStatus) ? { httpStatus: value.priorWriteHttpStatus ?? value.httpStatus } : {}),
    ...(Number.isSafeInteger(value?.retryAfterSeconds) ? { retryAfterSeconds: value.retryAfterSeconds } : {}),
    ...(Number.isSafeInteger(value?.rateLimitReset) ? { rateLimitReset: value.rateLimitReset } : {}),
    ...(Number.isFinite(Date.parse(value?.priorFailureCheckedAt || value?.checkedAt))
      ? { checkedAt: value.priorFailureCheckedAt || value.checkedAt } : {}),
    currentState: Object.fromEntries(['following', 'outgoingRequest', 'liked', 'reposted']
      .filter(key => typeof value?.currentState?.[key] === 'boolean').map(key => [key, value.currentState[key]])),
  };
}

function verifiedStep(operation, value) {
  if (value?.success !== true || value?.readbackVerified !== true) return false;
  if (operation === 'follow') return value.currentState?.following === true && value.currentState?.outgoingRequest === false;
  return value.currentState?.[operation === 'like' ? 'liked' : 'reposted'] === true;
}

function receiptBlock(operation, receipt, timestamp) {
  const throttle = receipt?.httpStatus === 429;
  const observedAt = Date.parse(receipt?.checkedAt);
  const cooldown = throttle && Number.isFinite(observedAt) ? threadsBenefitWorkerCooldown(receipt, observedAt) : null;
  const throttleCleared = cooldown && timestamp >= cooldown.retryAt;
  if ([400, 401, 403, 429].includes(receipt?.httpStatus) && !throttleCleared) {
    const code = receipt.httpStatus === 400 ? 'THREADS_OUTREACH_ENGAGEMENT_CONTRACT_REJECTED'
      : `THREADS_OUTREACH_HTTP_${receipt.httpStatus}`;
    const remaining = cooldown ? Math.max(0, Math.ceil((cooldown.retryAt - timestamp) / 1000)) : receipt.retryAfterSeconds;
    return { ...receipt, code,
      ...(throttle && Number.isSafeInteger(remaining) ? { retryAfterSeconds: remaining } : {}) };
  }
  if (operation === 'follow' && !throttleCleared && (receipt?.priorResponseUnverified === true
    || receipt?.responseVerified === false && receipt?.writesThisRun > 0 && !receipt.noOp)) {
    return { ...receipt, code: 'THREADS_OUTREACH_ENGAGEMENT_RESPONSE_UNVERIFIED' };
  }
  return null;
}

/** Called only under the shared coordinator, after an exact successful reply readback. */
export async function runThreadsOutreachEngagement(reservation, {
  followJournalPath, verifyTarget, verifyFinal, save, isStopRequested = async () => false,
  follow = followThreadsOutreachActor, reaction = reactThreads, now = Date.now, onReceipt = async () => {},
} = {}) {
  if (!validId(reservation?.actorId) || !validPost(reservation?.postId)
    || !/^[A-Za-z0-9_.]{1,30}$/.test(reservation?.postAuthor || '')
    || reservation.status !== 'verified_present' || reservation.readbackVerified !== true
    || reservation.engagementRequested !== true || reservation.engagementPolicyVersion !== 1
    || typeof followJournalPath !== 'string' || typeof verifyTarget !== 'function'
    || typeof verifyFinal !== 'function' || typeof save !== 'function') fail('THREADS_OUTREACH_ENGAGEMENT_SCOPE_INVALID');
  let engagement = { ...(reservation.engagement || {}) };
  let writes = 0, writeCountUnknown = false;
  const persist = patch => save({ engagement, ...patch });
  const guardWrite = async () => !(await isStopRequested());
  if (await isStopRequested()) return { status: 'pending', stopped: true, writes: 0 };
  await persist({ engagementStatus: 'in_progress', engagementReadbackVerified: false });
  for (const operation of ['follow', 'like', 'repost']) {
    if (await isStopRequested()) { await persist({ engagementStatus: 'pending' }); return { status: 'pending', stopped: true, writes, writeCountUnknown }; }
    const cached = engagement[operation];
    const cachedBlock = receiptBlock(operation, cached, now());
    if (cachedBlock) {
      await persist({ engagementStatus: 'needs_reconciliation', engagementCode: cachedBlock.code });
      fail(cachedBlock.code, cachedBlock);
    }
    if (cached?.httpStatus === 429) engagement[operation] = { ...cached, readbackVerified: false };
    if (verifiedStep(operation, engagement[operation])) {
      if (operation === 'follow') {
        await verifyTarget(reservation);
        const current = await verifyFinal(reservation);
        if (current?.following !== true || current?.outgoingRequest !== false) {
          await persist({ engagementStatus: 'needs_reconciliation', engagementCode: 'THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED' });
          fail('THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED');
        }
        // Rebuild the derived outbound-follow index if a crash interrupted its save.
        await onReceipt({ ...engagement.follow, operation: 'follow', writesThisRun: 0, noOp: true, reconciliationOnly: true });
      }
      continue;
    }
    await verifyTarget(reservation);
    if (operation !== 'follow') {
      const current = await verifyFinal(reservation);
      if (current?.following !== true || current?.outgoingRequest !== false || operation === 'repost' && current?.liked !== true) {
        await persist({ engagementStatus: 'needs_reconciliation', engagementCode: 'THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED' });
        fail('THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED');
      }
    }
    if (await isStopRequested()) { await persist({ engagementStatus: 'pending' }); return { status: 'pending', stopped: true, writes, writeCountUnknown }; }
    let value;
    try {
      if (operation === 'follow') value = await follow({ actorId: reservation.actorId, author: reservation.postAuthor, journalPath: followJournalPath, isStopRequested });
      else {
        const input = { operation, postId: reservation.postId, expectedAuthor: reservation.postAuthor, expectedActorId: reservation.actorId };
        if (engagement[operation]?.journalPath && engagement[operation]?.readbackVerified !== true) {
          value = { ...await reaction({ ...input, reconcile: true }), writesThisRun: 0, reconciliationOnly: true };
          if (value.status === 'not_sent' && value.notSentVerified === true && value.writes === 0) {
            value = await reaction({ ...input, execute: true }, { beforeWrite: guardWrite });
          }
        } else {
          try { value = await reaction({ ...input, execute: true }, { beforeWrite: guardWrite }); }
          catch (error) {
            if (error.code !== 'THREADS_REACTION_RECONCILE_FIRST') throw error;
            value = { ...await reaction({ ...input, reconcile: true }), writesThisRun: 0, reconciliationOnly: true };
          }
        }
      }
    } catch (error) {
      if (error.code === 'THREADS_OUTREACH_STOP_REQUESTED' && await isStopRequested()) {
        await persist({ engagementStatus: 'pending' });
        return { status: 'pending', stopped: true, writes, writeCountUnknown };
      }
      const receipt = safeThreadsOutreachEngagementReceipt(operation, { ...error, status: 'needs_reconciliation', success: false });
      engagement[operation] = receipt;
      const code = receipt.httpStatus === 400 ? 'THREADS_OUTREACH_ENGAGEMENT_CONTRACT_REJECTED' : safeCode(error.code);
      await persist({ engagementStatus: 'needs_reconciliation', engagementLastStep: operation, engagementCode: code });
      await onReceipt(receipt);
      if (receipt.httpStatus === 400) fail(code, receipt);
      throw error;
    }
    const receipt = safeThreadsOutreachEngagementReceipt(operation, value);
    receipt.checkedAt ||= new Date(now()).toISOString();
    engagement[operation] = receipt;
    if (Number.isSafeInteger(receipt.writesThisRun)) writes += receipt.writesThisRun;
    else writeCountUnknown = true;
    await persist({ engagementStatus: 'in_progress', engagementLastStep: operation });
    await onReceipt(receipt);
    // Confirmed state does not authorize continuing after a rejected request.
    const block = receiptBlock(operation, receipt, now());
    if (block) {
      await persist({ engagementStatus: 'needs_reconciliation', engagementCode: block.code });
      fail(block.code, block);
    }
    if (receipt.code === 'THREADS_OUTREACH_STOP_REQUESTED' || receipt.notSentVerified === true && await isStopRequested()) {
      await persist({ engagementStatus: 'pending' });
      return { status: 'pending', stopped: true, writes, writeCountUnknown };
    }
    if (receipt.code && !receipt.reconciliationOnly && !receipt.noOp) {
      await persist({ engagementStatus: 'needs_reconciliation', engagementCode: receipt.code });
      fail(receipt.code, receipt);
    }
    if (operation === 'follow' && receipt.success && receipt.readbackVerified && receipt.currentState.outgoingRequest === true) {
      await persist({ engagementStatus: 'pending_follow_request' });
      return { status: 'pending_follow_request', success: false, readbackVerified: false, writes, writeCountUnknown };
    }
    if (!verifiedStep(operation, receipt)) {
      const code = receipt.httpStatus === 400 ? 'THREADS_OUTREACH_ENGAGEMENT_CONTRACT_REJECTED'
        : receipt.code || 'THREADS_OUTREACH_ENGAGEMENT_UNVERIFIED';
      await persist({ engagementStatus: 'needs_reconciliation', engagementCode: code });
      fail(code, receipt);
    }
  }
  await verifyTarget(reservation);
  const current = await verifyFinal(reservation);
  if (current?.following !== true || current?.outgoingRequest !== false || current?.liked !== true || current?.reposted !== true) {
    await persist({ engagementStatus: 'needs_reconciliation', engagementCode: 'THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED' });
    fail('THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED');
  }
  await persist({ engagementStatus: 'verified', engagementReadbackVerified: true, engagementCompletedAt: new Date(now()).toISOString() });
  return { status: 'verified', success: true, readbackVerified: true, writes, writeCountUnknown };
}
