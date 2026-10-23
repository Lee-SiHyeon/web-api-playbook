import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withSessionLock } from '../tistory-api/lib/lock.mjs';
import { reactThreads } from './threads-reactions.mjs';
import { readThreadsBenefitConfig, threadsBenefitRuntimeRoot, assertThreadsBenefitPromotionBinding } from './threads-benefit-config.mjs';
import { THREADS_BENEFIT_POLICY, isVerifiedThreadsFollowHistoryHoldRecord } from './threads-benefits.mjs';
import { verifyThreadsActivePromotion } from './threads-benefit-runner.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const validId = value => typeof value === 'string' && /^\d{1,25}$/.test(value);
const validPostId = value => typeof value === 'string' && /^\d{10,25}$/.test(value);
const safeCode = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code || '')
  ? error.code : 'THREADS_BASIC_REACTION_RECONCILE_FAILED';

async function readStateFile(root) {
  try {
    const raw = await readFile(path.join(root, 'state.json'), 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 5_000_000) fail('THREADS_BENEFIT_STATE_INVALID');
    const state = JSON.parse(raw);
    if (state?.service !== 'threads' || state.owner !== THREADS_BENEFIT_POLICY.owner
      || state.policyVersion !== THREADS_BENEFIT_POLICY.version
      || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) {
      fail('THREADS_BENEFIT_STATE_INVALID');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return {
      service: 'threads', owner: THREADS_BENEFIT_POLICY.owner,
      policyVersion: THREADS_BENEFIT_POLICY.version, records: {},
    };
    throw error;
  }
}

async function saveStateFile(root, state) {
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'state.json'), temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function exactReceiptIdentity(actorId, record, operation, receipt) {
  return receipt?.owner === THREADS_BENEFIT_POLICY.owner
    && receipt.operation === operation && receipt.postId === record.pinnedPostId
    && receipt.target?.toLowerCase?.() === record.handle.toLowerCase()
    && receipt.currentState?.id === record.pinnedPostId
    && receipt.currentState?.author?.toLowerCase?.() === record.handle.toLowerCase()
    && String(receipt.currentState?.authorId ?? '') === actorId;
}

function positiveReceipt(actorId, record, operation, receipt) {
  const stateKey = operation === 'like' ? 'liked' : 'reposted';
  return exactReceiptIdentity(actorId, record, operation, receipt)
    && receipt.readbackVerified === true && receipt.success === true
    && receipt.currentState?.id === record.pinnedPostId
    && receipt.currentState?.author?.toLowerCase?.() === record.handle.toLowerCase()
    && String(receipt.currentState.authorId ?? '') === actorId
    && receipt.currentState[stateKey] === true;
}

function reconciliationReceipt(actorId, record, operation, receipt) {
  return exactReceiptIdentity(actorId, record, operation, receipt)
    && receipt.readbackVerified === false && receipt.status === 'needs_reconciliation'
    && receipt.writes === 1;
}

function historyHoldCandidate(actorId, record, activePromotionId) {
  if (!validId(actorId) || !record || record.baseStatus !== 'needs_reconciliation'
    || record.bonusStatus !== 'not_started' || record.currentOperation != null
    || record.currentOperationStartedAt != null || record.activePromotionId !== activePromotionId
    || record.basicReactions?.status !== 'needs_reconciliation'
    || !validPostId(record.pinnedPostId)
    || record.basicReactions.postId !== record.pinnedPostId
    || !record.basicReactions.results || typeof record.basicReactions.results !== 'object'
    || Array.isArray(record.basicReactions.results)
    || record.basicReactions.reconciliationHistory != null && !Array.isArray(record.basicReactions.reconciliationHistory)) {
    return null;
  }
  const originalHold = {
    ...record,
    baseStatus: 'follow_verified_reward_held',
    basicReactions: undefined,
  };
  if (!isVerifiedThreadsFollowHistoryHoldRecord(actorId, originalHold, activePromotionId)) return null;

  const stage = record.basicReactions;
  const operations = Object.keys(stage.results);
  if (operations.some(operation => !['like', 'repost'].includes(operation))
    || operations.includes('repost') && !operations.includes('like')) return null;
  const reactionAttempts = record.attemptedOperations - record.historyHold.followAttemptOperations;
  if (!Number.isSafeInteger(reactionAttempts) || reactionAttempts < operations.length || reactionAttempts < 1
    || reactionAttempts > 2) return null;
  for (const operation of operations) {
    const receipt = stage.results[operation];
    if (!exactReceiptIdentity(actorId, record, operation, receipt)) return null;
    if (receipt.readbackVerified === true && !positiveReceipt(actorId, record, operation, receipt)) return null;
    if (receipt.readbackVerified !== true && !reconciliationReceipt(actorId, record, operation, receipt)) return null;
  }
  return { stage, operations, reactionAttempts };
}

function makeHistoryEntry(record, operation, previous, reconciledAt) {
  return {
    operation,
    reconciledAt,
    priorStageStatus: record.basicReactions.status,
    priorStageCode: record.basicReactions.code || null,
    priorRecordCode: record.code || null,
    priorCheckedAt: previous.checkedAt || null,
    priorResult: structuredClone(previous),
  };
}

function finalizeStage(actorId, record, candidate, reconciledAt) {
  const stage = record.basicReactions;
  stage.reconciledAt = reconciledAt;
  const allPositive = ['like', 'repost'].every(operation => positiveReceipt(actorId, record, operation, stage.results[operation]));
  if (allPositive) {
    stage.status = 'verified';
    stage.finishedAt ||= reconciledAt;
    record.baseStatus = 'follow_verified_reward_held';
    return { status: 'verified', resumable: false };
  }

  const onlyLikeAttempted = candidate.reactionAttempts === 1
    && Object.keys(stage.results).length === 1
    && positiveReceipt(actorId, record, 'like', stage.results.like)
    && !Object.hasOwn(stage.results, 'repost');
  if (onlyLikeAttempted) {
    stage.status = 'reserved';
    record.baseStatus = 'follow_verified_reward_held';
    return { status: 'partial_resumable', resumable: true };
  }

  stage.status = 'needs_reconciliation';
  record.baseStatus = 'needs_reconciliation';
  return { status: 'needs_reconciliation', resumable: false };
}

/** Resolve only already-journaled basic reactions from positive exact readback. Never dispatches a reaction. */
export async function reconcileThreadsBasicReactionStages({ actorIds, root = threadsBenefitRuntimeRoot() } = {}, {
  configReader = readThreadsBenefitConfig,
  promotionVerifier = verifyThreadsActivePromotion,
  reaction = reactThreads,
  readState,
  persistState,
  lock,
  now = Date.now,
} = {}) {
  if (!Array.isArray(actorIds) || actorIds.length === 0 || actorIds.some(id => !validId(id))
    || new Set(actorIds).size !== actorIds.length) fail('THREADS_BASIC_REACTION_RECONCILE_ACTORS_INVALID');
  const runLock = lock || (task => withSessionLock(task, {
    lockPath: path.join(root, 'coordinator.lock'), timeoutMs: 600_000,
  }));

  return runLock(async () => {
    const config = await configReader({ root });
    const state = readState ? await readState() : await readStateFile(root);
    if (!assertThreadsBenefitPromotionBinding(state, config)
      || state.activePromotionId !== config.activePromotionId) fail('THREADS_BASIC_REACTION_RECONCILE_PROMOTION_UNBOUND');

    const prepared = actorIds.map(id => ({ id, record: state.records?.[id] }))
      .map(item => ({ ...item, candidate: historyHoldCandidate(item.id, item.record, config.activePromotionId) }));
    const eligible = prepared.filter(item => item.candidate);
    if (eligible.length) await promotionVerifier(config);

    const results = [];
    for (const item of prepared) {
      const { id, record, candidate } = item;
      if (!candidate) {
        results.push({ id, handle: record?.handle || null, status: 'held', resumable: false,
          code: 'THREADS_BASIC_REACTION_RECONCILE_SIGNATURE_INVALID' });
        continue;
      }

      let changed = false, heldCode = null;
      for (const operation of ['like', 'repost']) {
        const prior = candidate.stage.results[operation];
        if (!prior || positiveReceipt(id, record, operation, prior)) continue;
        let receipt;
        try {
          receipt = await reaction({ operation, postId: record.pinnedPostId, expectedAuthor: record.handle,
            expectedActorId: id, reconcile: true, execute: false });
        } catch (error) {
          heldCode = safeCode(error);
          break;
        }
        if (!positiveReceipt(id, record, operation, receipt)) {
          heldCode = safeCode({ code: receipt?.code || 'THREADS_BASIC_REACTION_READBACK_NOT_POSITIVE' });
          break;
        }
        candidate.stage.reconciliationHistory ||= [];
        candidate.stage.reconciliationHistory.push(makeHistoryEntry(record, operation, prior,
          new Date(now()).toISOString()));
        candidate.stage.results[operation] = receipt;
        changed = true;
      }

      if (changed) {
        const reconciledAt = new Date(now()).toISOString();
        const outcome = finalizeStage(id, record, candidate, reconciledAt);
        for (const operation of ['like', 'repost']) {
          if (candidate.stage.results[operation] && !positiveReceipt(id, record, operation, candidate.stage.results[operation])) {
            heldCode ||= 'THREADS_BASIC_REACTION_RECONCILE_INCOMPLETE';
          }
        }
        if (persistState) await persistState(state);
        else await saveStateFile(root, state);
        results.push({ id, handle: record.handle, ...outcome, verifiedOperations: ['like', 'repost']
          .filter(operation => positiveReceipt(id, record, operation, candidate.stage.results[operation])),
          newWrites: 0, ...(heldCode ? { code: heldCode } : {}) });
      } else {
        results.push({ id, handle: record.handle, status: 'held', resumable: false,
          code: heldCode || 'THREADS_BASIC_REACTION_RECONCILE_NO_POSITIVE_READBACK' });
      }
    }
    return { service: 'threads', reconciliationOnly: true, newWrites: 0, externalWrites: 0, results };
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  reconcileThreadsBasicReactionStages({ actorIds: process.argv.slice(2) })
    .then(result => { console.log(JSON.stringify(result)); })
    .catch(error => {
      console.log(JSON.stringify({ ok: false, code: safeCode(error) }));
      process.exitCode = 1;
    });
}
