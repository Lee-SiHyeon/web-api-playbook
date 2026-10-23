import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeBotJson } from './lib/bot-json-store.mjs';
import { acquireBotWorkerLease } from './lib/bot-worker-lease.mjs';
import { readBotProcessPresence, botProcessKey } from './lib/bot-process-presence.mjs';
import { captureBotFailure, recordBotFailure } from './lib/bot-diagnostics.mjs';
import { installThreadsProcessLifecycle } from './lib/threads-process-lifecycle.mjs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { threadsStopRequested } from './lib/threads-runtime-control.mjs';
import { threadsSafeFailure } from './lib/threads-safe-error.mjs';
import { readThreadsSharedCooldown, isThreadsGraphqlThrottle, applyThreadsCooldownStatus } from './lib/threads-graphql-throttle.mjs';
import { tagThreadsHttp429CooldownStatus } from './lib/threads-local-recovery.mjs';
import { ThreadsBenefitReadTimeout, ThreadsBenefitReadContextExpired, readThreadsBenefitPhase as readBenefitPhase } from './lib/threads-read-recovery.mjs';
import { THREADS_BENEFIT_POLICY, isVerifiedThreadsFollowHistoryHoldRecord, threadsBasicReactionsVerified } from './threads-benefits.mjs';

const OWNER = 'lifehack__ailab';
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 5 * 60 * 1000;
const MIN_POLL_MS = 60 * 1000;
const MAX_POLL_MS = 15 * 60 * 1000;
const HTTP_429_LOCAL_FALLBACK_MS = 15 * 60 * 1000;
const DRAFT_GROUP_SIZE = 3;
const STATUS_FILE = 'worker-status.json';
const STOP_FILE = 'worker-STOP';
const LOCK_FILE = 'worker.lock';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.code || '') ? error.code : 'THREADS_BENEFIT_WORKER_FAILED';
const isLocalReadBudgetWait = value => value?.code === 'THREADS_READ_BUDGET_WAIT'
  && Number.isSafeInteger(value.retryAt) && value.receipt?.localBudget === true
  && (value.dispatchStarted === false && value.writeSent === false
    || value.writeCountUnknown === false && Number.isSafeInteger(value.writes));

const validId = value => /^\d{1,25}$/.test(String(value ?? ''));
const validHandle = value => typeof value === 'string' && /^[A-Za-z0-9_.]{1,30}$/.test(value);

export const THREADS_BENEFIT_WORKER_SETTINGS = Object.freeze({
  owner: OWNER,
  defaultDurationMilliseconds: DAY,
  maximumDurationMilliseconds: DAY,
  defaultPollMilliseconds: DEFAULT_POLL_MS,
  minimumPollMilliseconds: MIN_POLL_MS,
  maximumPollMilliseconds: MAX_POLL_MS,
  betweenAccountsMilliseconds: 20_000,
  localHourlyLimit: null,
  priorityOrder: ['base', 'bonus'],
});

export function threadsBenefitWorkerRoot() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'threads-benefits');
}

export function validateThreadsBenefitDuration(value = DAY) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DAY) fail('THREADS_BENEFIT_WORKER_DURATION_INVALID');
  return value;
}

export function validateThreadsBenefitPollInterval(value = DEFAULT_POLL_MS) {
  if (!Number.isSafeInteger(value) || value < MIN_POLL_MS || value > MAX_POLL_MS) fail('THREADS_BENEFIT_WORKER_POLL_INVALID');
  return value;
}

export function validateThreadsBenefitPromotionConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.owner !== OWNER || !validId(value.activePromotionId)
    || value.readbackVerified !== true || value.pinReadbackVerified !== true
    || value.previousPromotionPinRemovedVerified !== true
    || !Array.isArray(value.previousPromotionIds) || value.previousPromotionIds.length > 20
    || value.previousPromotionIds.some(id => !validId(id) || String(id) === String(value.activePromotionId))
    || new Set(value.previousPromotionIds.map(String)).size !== value.previousPromotionIds.length) {
    fail('THREADS_BENEFIT_WORKER_PROMOTION_CONFIG_INVALID');
  }
  let url;
  try { url = new URL(value.url); } catch { fail('THREADS_BENEFIT_WORKER_PROMOTION_CONFIG_INVALID'); }
  if (url.origin !== 'https://www.threads.com' || url.search || url.hash || url.username || url.password
    || !/^\/@lifehack__ailab\/post\/[A-Za-z0-9_-]{5,64}\/?$/.test(url.pathname)) {
    fail('THREADS_BENEFIT_WORKER_PROMOTION_CONFIG_INVALID');
  }
  return Object.freeze({
    owner: OWNER,
    activePromotionId: String(value.activePromotionId),
    url: url.origin + url.pathname.replace(/\/$/, ''),
    readbackVerified: true,
    pinReadbackVerified: true,
    previousPromotionPinRemovedVerified: true,
    previousPromotionIds: Object.freeze([...new Set(value.previousPromotionIds.map(String))]),
  });
}

export function threadsBenefitWorkerConfigFingerprint(config) {
  const verified = validateThreadsBenefitPromotionConfig(config);
  return JSON.stringify({ owner: verified.owner, activePromotionId: verified.activePromotionId,
    url: verified.url, previousPromotionIds: [...verified.previousPromotionIds],
    previousPromotionPinRemovedVerified: verified.previousPromotionPinRemovedVerified });
}

function errorHttpStatus(error) {
  const status = Number(error?.receipt?.httpStatus ?? error?.httpStatus);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  return /(?:^|_)HTTP_429$/.test(String(error?.code || '')) || /RATE_LIMIT(?:ED)?|AUTH_THROTTLED/.test(String(error?.code || '')) ? 429 : null;
}

export function threadsBenefitWorkerCooldown(error, now = Date.now()) {
  const graphqlThrottle = isThreadsGraphqlThrottle(error);
  const receipt = error?.receipt || error || {};
  if (error?.code === 'THREADS_READ_BUDGET_WAIT' && receipt.localBudget === true) {
    const retryAt = Number(error.retryAt ?? receipt.readBudgetRetryAt);
    if (!Number.isFinite(retryAt) || retryAt <= now) return { code: 'THREADS_READ_BUDGET_WAIT',
      retryAt: now + 1000, cooldownReason: 'shared_read_budget', deadlineSource: 'local_budget' };
    return { code: 'THREADS_READ_BUDGET_WAIT', retryAt,
      cooldownReason: 'shared_read_budget', deadlineSource: 'local_budget' };
  }
  if (errorHttpStatus(error) !== 429 && !graphqlThrottle) return null;
  // A shared 429 receipt already binds the deadline and whether it came from
  // the provider or a local fallback. Reloading must not start another 15m wait
  // or reinterpret remaining local seconds as a new server hint.
  const savedHttpAt = typeof receipt.retryAt === 'number' ? receipt.retryAt : Date.parse(receipt.retryAt || '');
  if (!graphqlThrottle && ['META_HTTP_429_COOLDOWN','META_HTTP_429_COOLDOWN_PERSIST_FAILED'].includes(receipt.code)
    && receipt.httpStatus===429 && receipt.cooldownReason==='http_429_rate_limit'
    && Number.isFinite(savedHttpAt) && savedHttpAt>now
    && (receipt.deadlineSource==='server_hint' || receipt.deadlineSource==='local_fallback_15_minutes'
      && receipt.fallbackMilliseconds===HTTP_429_LOCAL_FALLBACK_MS && savedHttpAt<=now+HTTP_429_LOCAL_FALLBACK_MS)) {
    return {code:receipt.code,httpStatus:429,retryAt:Math.max(now+60_000,savedHttpAt),rateLimited:true,
      cooldownReason:'http_429_rate_limit',deadlineSource:receipt.deadlineSource,
      ...(receipt.deadlineSource==='local_fallback_15_minutes'?{fallbackMilliseconds:HTTP_429_LOCAL_FALLBACK_MS}:{})};
  }
  const resetValue = Number(receipt.rateLimitReset);
  const resetAt = Number.isFinite(resetValue) ? resetValue > 10_000_000_000 ? resetValue : resetValue * 1000 : 0;
  const retrySeconds = Number(receipt.retryAfterSeconds);
  let retryAt = Number.isFinite(retrySeconds) && retrySeconds >= 0 ? now + retrySeconds * 1000 : 0;
  if (graphqlThrottle && receipt.retryAt != null) {
    const savedAt = typeof receipt.retryAt === 'number' ? receipt.retryAt : Date.parse(receipt.retryAt);
    if (Number.isFinite(savedAt) && savedAt > now) retryAt = Math.max(retryAt, savedAt);
  }
  if (!retryAt && typeof receipt.retryAfter === 'string') {
    const numeric = Number(receipt.retryAfter);
    retryAt = Number.isFinite(numeric) ? now + numeric * 1000 : Date.parse(receipt.retryAfter) || 0;
  }
  const hasServerHint = resetAt > now || retryAt > now;
  return { ...(graphqlThrottle ? { operation: receipt.operation, consecutiveThrottles: receipt.consecutiveThrottles,
      fallbackMilliseconds: receipt.fallbackMilliseconds } : {}), httpStatus: graphqlThrottle ? 200 : 429,
    retryAt: Math.max(now + 60_000, resetAt, retryAt, hasServerHint ? 0 : now + HTTP_429_LOCAL_FALLBACK_MS),
    ...(graphqlThrottle ? { code: 'META_GRAPHQL_THROTTLED', rateLimited: true, cooldownReason: 'graphql_200_rate_limit',
      deadlineSource: receipt.deadlineSource || (hasServerHint ? 'server_hint' : 'local_fallback_15_minutes') }
      : { cooldownReason: 'http_429_rate_limit', deadlineSource: hasServerHint ? 'server_hint' : 'local_fallback_15_minutes',
        ...(!hasServerHint ? { fallbackMilliseconds: HTTP_429_LOCAL_FALLBACK_MS } : {}) }) };
}

const workerCooldownFields = ['code', 'httpStatus', 'retryAt', 'rateLimited', 'cooldownReason',
  'deadlineSource', 'throttleOperation', 'consecutiveThrottles', 'fallbackMilliseconds'];

/** Clear only an expired, recognized worker cooldown after the shared gate says it is inactive. */
export function clearExpiredThreadsBenefitWorkerCooldownStatus(status, now = Date.now()) {
  if (!status || typeof status !== 'object' || !Number.isSafeInteger(now)) return false;
  const retryAt = Date.parse(status.retryAt || '');
  if (!Number.isFinite(retryAt) || retryAt > now) return false;
  const budgetWait = status.status === 'waiting_for_read_budget'
    && status.code === 'THREADS_READ_BUDGET_WAIT' && status.cooldownReason === 'shared_read_budget'
    && status.deadlineSource === 'local_budget' && (status.httpStatus == null || status.httpStatus === 200);
  const graphqlWait = status.status === 'cooldown' && status.code === 'META_GRAPHQL_THROTTLED'
    && status.httpStatus === 200 && status.cooldownReason === 'graphql_200_rate_limit';
  const http429Wait = status.status === 'cooldown'
    && ['META_HTTP_429_COOLDOWN', 'META_HTTP_429_COOLDOWN_PERSIST_FAILED'].includes(status.code)
    && status.httpStatus === 429 && status.cooldownReason === 'http_429_rate_limit';
  if (!budgetWait && !graphqlWait && !http429Wait) return false;

  status.lastExpiredCooldown = {
    status: status.status,
    code: status.code,
    httpStatus: status.httpStatus ?? null,
    retryAt: new Date(retryAt).toISOString(),
    expiredAt: new Date(now).toISOString(),
    cooldownReason: status.cooldownReason,
    deadlineSource: status.deadlineSource,
    ...(typeof status.throttleOperation === 'string' ? { throttleOperation: status.throttleOperation } : {}),
    ...(Number.isSafeInteger(status.consecutiveThrottles) ? { consecutiveThrottles: status.consecutiveThrottles } : {}),
    ...(Number.isSafeInteger(status.fallbackMilliseconds) ? { fallbackMilliseconds: status.fallbackMilliseconds } : {}),
  };
  for (const field of workerCooldownFields) delete status[field];
  status.status = status.workerStarted === true ? 'running' : 'starting';
  delete status.workPhase;
  return true;
}

export function isThreadsBenefitAuthChallenge(errorOrCode) {
  const code = typeof errorOrCode === 'string' ? errorOrCode : String(errorOrCode?.code || '');
  return /(?:AUTH|LOGIN|CHALLENGE|CHECKPOINT|CAPTCHA|REAUTH|SESSION_REJECTED|OWNER_UNVERIFIED|INTERACTION_REQUIRED|BOOTSTRAP_REQUIRED)/i.test(code)
    || /(?:^|_)HTTP_(?:401|403)$/.test(code)
    || /^META_DOCUMENT_HTTP_(?:401|403)$/.test(code)
    || /^THREADS_(?:SOCIAL|REPLY|REACTION)_HTTP_(?:401|403)$/.test(code);
}

export function isThreadsBenefitReplyServerBlock(errorOrCode) {
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorOrCode?.code ?? errorOrCode?.receipt?.code;
  return ['THREADS_REPLY_SERVER_INTEGRITY_BLOCKED', 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED'].includes(code);
}

export function threadsBenefitPriorityGroup(discovery, { excludeTargetIds = new Set() } = {}) {
  const queue = Array.isArray(discovery?.queue) ? discovery.queue : [];
  const excluded = excludeTargetIds instanceof Set ? excludeTargetIds : new Set(excludeTargetIds || []);
  const eligible = [];
  const seen = new Set();
  for (const user of queue) {
    if (!['base', 'bonus'].includes(user?.stage)) continue;
    const id = validId(user.id) ? String(user.id) : null;
    const handle = validHandle(user.handle) ? user.handle.toLowerCase() : null;
    if (!id || !handle || seen.has(id) || excluded.has(id)) continue;
    seen.add(id);
    eligible.push({ id, handle, stage: user.stage, ...(user.basicReactionsPending===true?{basicReactionsPending:true,
      ...(Number.isFinite(user.basicReactionsRetryAt)?{basicReactionsRetryAt:user.basicReactionsRetryAt}:{})}:{}) });
  }
  const stage = eligible.some(user => user.stage === 'base') ? 'base'
    : eligible.some(user => user.stage === 'bonus') ? 'bonus' : null;
  if (!stage) return { stage: null, targets: [] };
  return { stage, targets: eligible.filter(user => user.stage === stage)
    .sort((a,b)=>Number(b.basicReactionsPending===true)-Number(a.basicReactionsPending===true))
    .map(user => ({ ...user, stage })) };
}

function legacySummary(discovery, config) {
  const evidence = discovery?.legacyEvidence || {};
  const attempted = new Set((Array.isArray(evidence.attemptedPromotionIds) ? evidence.attemptedPromotionIds : []).map(String));
  const coverage = Array.isArray(evidence.coverage) ? evidence.coverage : [];
  const rows = coverage.filter(row => config.previousPromotionIds.includes(String(row.promotionId)));
  const attemptedCount = config.previousPromotionIds.filter(id => attempted.has(String(id))).length;
  return {
    configuredPromotionCount: config.previousPromotionIds.length,
    attemptedPromotionCount: attemptedCount,
    promotionWindows: rows.map(row => ({
      promotionId: String(row.promotionId),
      engagementRead: row.engagementRead === true,
      commentsRead: row.commentsRead === true,
      commentsFullList: row.commentsFullList === true,
    })),
    observedSamePromotionPairs: Array.isArray(evidence.qualifyingActors) ? evidence.qualifyingActors.length : 0,
    observedOwnerCompletionHolds: Array.isArray(evidence.completionResponses) ? evidence.completionResponses.length : 0,
    // Current Threads engagement and comment reads are visible windows, not an exhaustive archive.
    fullHistory: false,
    coverage: config.previousPromotionIds.length === 0 ? 'no_previous_promotions'
      : attemptedCount === config.previousPromotionIds.length ? 'attempted_partial_or_unknown' : 'partial_or_unknown',
  };
}

function safeTargetKey(target) {
  if (validId(target?.id)) return String(target.id);
  return validHandle(target?.handle) ? `handle:${target.handle.toLowerCase()}` : null;
}

function holdTarget(status, target, stage, code, now) {
  const key = safeTargetKey(target);
  if (!key) return;
  status.blockedTargets ||= {};
  const previous = status.blockedTargets[key];
  status.blockedTargets[key] = {
    id: validId(target?.id) ? String(target.id) : null,
    handle: validHandle(target?.handle) ? target.handle.toLowerCase() : null,
    stage: ['base', 'bonus', 'pending', 'identity_lookup', 'legacy_review', 'reconciliation'].includes(stage) ? stage : 'unknown',
    status: 'held',
    code: /^[A-Z][A-Z0-9_]{2,100}$/.test(code || '') ? code : 'THREADS_BENEFIT_TARGET_HELD',
    firstSeenAt: previous?.firstSeenAt || new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    ...(Number.isSafeInteger(previous?.readHoldCount) ? { readHoldCount: previous.readHoldCount, readHeldAt: previous.readHeldAt } : {}),
  };
}

// A base target held after its per-target reads (profile timeline, pin replies: 15-20 reads each) mostly stays held
// on the next poll (e.g. PRIOR_REPLY_SCAN_INCOMPLETE on a pin with many replies). Re-reading every poll spent the
// whole 300/h budget with nothing processed (2026-10-02). Its next read waits 30 min, doubling per hold, max 6 h.
export const READ_HOLD_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
function noteReadHold(status, target, code, now) {
  holdTarget(status, target, 'base', code, now);
  const row = status.blockedTargets?.[safeTargetKey(target)];
  if (!row) return;
  row.readHoldCount = (Number.isSafeInteger(row.readHoldCount) ? row.readHoldCount : 0) + 1;
  row.readHeldAt = new Date(now).toISOString();
}
export function readHoldBackoffActive(row, now) {
  if (row?.status !== 'held' || !Number.isSafeInteger(row.readHoldCount) || row.readHoldCount < 1) return false;
  const at = Date.parse(row.readHeldAt || '');
  if (!Number.isFinite(at)) return false;
  return now - at < Math.min(READ_HOLD_MAX_BACKOFF_MS, 30 * 60_000 * 2 ** (row.readHoldCount - 1));
}

function stoppedBeforeDispatch(result,target) {
  const proof=result?.noDispatchProof;
  const operationMatches=target.basicReactionsPending===true?['like','repost'].includes(proof?.operation)
    :target.stage==='base'?['follow','like','repost','contextual_reply','completion_reply'].includes(proof?.operation)
      :target.stage==='bonus'&&(proof?.operation==='completion_reply'||/^bonus_(?:like|repost)_\d{1,30}$/.test(proof?.operation||''));
  return result?.id===target.id && result.stage===target.stage
    && Number.isSafeInteger(result.writes) && result.writes>=0 && result.writeCountUnknown===false
    && proof?.status==='not_sent_verified' && proof.notSentVerified===true
    && proof.dispatchStarted===false && proof.writeSent===false && proof.writes===0 && proof.stopRequested===true
    && operationMatches && proof.dispatchConfirmed!==true && proof.writeCountUnknown!==true
    && proof.needs_reconciliation!==true && proof.success!==true
    && (proof.mutationCount===undefined||proof.mutationCount===0) && (proof.attempts===undefined||proof.attempts===0)
    && proof.code===result.code
    && ['THREADS_BENEFIT_STOPPED','SOCIAL_ACTION_STOPPED_BEFORE_WRITE','THREADS_REPLY_BEFORE_WRITE_STOPPED'].includes(proof.code);
}

function pauseTargetBeforeDispatch(status,target,result,now) {
  holdTarget(status,target,target.stage,result.code,now);
  const row=status.blockedTargets[safeTargetKey(target)];
  row.status='paused_before_dispatch';
  row.notSentVerified=true;
  delete row.readHoldCount;delete row.readHeldAt;
  status.status='stopped';
}

function resolveTarget(status, target, now) {
  const key = safeTargetKey(target);
  const prior = key && status.blockedTargets?.[key];
  if (!prior) return;
  prior.status = 'resolved_from_current_observation';
  prior.resolvedAt = new Date(now).toISOString();
}

function holdCodeForStage(stage) {
  return ({
    pending: 'THREADS_BENEFIT_FOLLOW_REQUEST_PENDING',
    identity_lookup: 'THREADS_BENEFIT_COMMENT_IDENTITY_UNVERIFIED',
    legacy_review: 'THREADS_BENEFIT_LEGACY_REVIEW_REQUIRED',
    reconciliation: 'THREADS_BENEFIT_RECONCILIATION_REQUIRED',
    waiting_for_participation: 'THREADS_BENEFIT_WAITING_FOR_PARTICIPATION',
    complete: 'THREADS_BENEFIT_ALREADY_COMPLETE',
  })[stage] || 'THREADS_BENEFIT_STAGE_HELD';
}

function noteDiscoveryHolds(status, discovery, now) {
  for (const user of discovery?.held || []) holdTarget(status, user, user.stage, holdCodeForStage(user.stage), now);
  for (const user of discovery?.queue || []) {
    if (!validId(user?.id) || !validHandle(user?.handle)) {
      holdTarget(status, user, user?.stage, 'THREADS_BENEFIT_QUEUE_IDENTITY_UNVERIFIED', now);
    }
  }
}

function blockIsTargetLocal(code) {
  if (code === 'THREADS_BENEFIT_PRIMARY_POST_UNVERIFIED') return true;
  return /^THREADS_BENEFIT_(?:TRIGGER_REVERIFY_REQUIRED|PRIOR_REPLY_SCAN_INCOMPLETE|EXISTING_REPLY_REVIEW_REQUIRED|COMMENT_IDENTITY_UNVERIFIED|COMMENT_ACTOR_MISMATCH|ACTOR_UNVERIFIED|ACTOR_AMBIGUOUS|ACTOR_MISMATCH|HANDLE_CHANGED_REVIEW_REQUIRED|ENTRANCE_NOT_OBSERVED|RECONCILE_OR_WAIT|BONUS_INELIGIBLE|NO_ADDITIONAL_POSTS|DRAFT_CACHE_MISSING|TARGET_INVALID|PIN_NOT_VERIFIED|REPLY_NOT_READY|FOLLOW_REQUEST_PENDING|LEGACY_REVIEW_REQUIRED|RECONCILIATION_REQUIRED|STAGE_HELD)$/.test(code || '')
    || /^THREADS_SOCIAL_(?:COMMENT_ROW_SCHEMA|POST_SCHEMA|PROFILE_POST_SCHEMA|PROFILE_THREAD_SCHEMA|PROFILE_THREAD_ITEM_SCHEMA|PROFILE_POST_CONFLICT)$/.test(code || '')
    || /^THREADS_SOCIAL_PROFILE_HTTP_(?:404|410)$/.test(code || '');
}

async function readJsonFile(file, fallback, maxBytes = 1_000_000) {
  try {
    const raw = await readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > maxBytes) fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
    throw error;
  }
}

async function atomicJsonWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeBotJson('threads-benefits', file, value);
}

export async function readThreadsBenefitWorkerStatus({ root = threadsBenefitWorkerRoot() } = {}) {
  const value = await readJsonFile(path.join(root, STATUS_FILE), null);
  if (!value) return { service: 'threads', owner: OWNER, status: 'not_started', workerStarted: false };
  if (value.service !== 'threads' || value.owner !== OWNER || typeof value.status !== 'string') fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
  return value;
}

export async function requestThreadsBenefitWorkerStop({ root = threadsBenefitWorkerRoot(), now = Date.now, processReader } = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, STOP_FILE), new Date(now()).toISOString(), { mode: 0o600 });
  const workerRunning = await readBenefitWorkerLockPresence(root, processReader);
  return { service: 'threads', stopRequested: true, workerRunning, workerIdentityPending: workerRunning === null, workerStarted: false };
}

const BENEFIT_WORKER_SCRIPT = 'threads-benefit-worker.mjs';

export async function acquireThreadsBenefitWorkerLock(root, now = Date.now, options = {}) {
  const lease = await acquireBotWorkerLease(root, { ...options, now, script: BENEFIT_WORKER_SCRIPT });
  if (!lease) fail('THREADS_BENEFIT_WORKER_ALREADY_RUNNING');
  return lease.release;
}

const basicReactionHistoryHoldCodes = new Set([
  'THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
  'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED',
]);
const basicReactionReconciliationHoldCode = 'THREADS_BENEFIT_RECONCILIATION_REQUIRED';

function basicReactionRecoveryReconciledAt(actorId, record, activePromotionId, blocked, now) {
  if (!isVerifiedThreadsFollowHistoryHoldRecord(actorId, record, activePromotionId)
    || record.baseStatus !== 'follow_verified_reward_held' || record.bonusStatus !== 'not_started'
    || record.currentOperation != null || record.basicReactions?.status !== 'reserved'
    || record.basicReactions.postId !== record.pinnedPostId || record.basicReactions.finishedAt != null
    || record.attemptedOperations - record.historyHold.followAttemptOperations !== 1
    || !record.basicReactions.results || typeof record.basicReactions.results !== 'object'
    || Array.isArray(record.basicReactions.results)
    || Object.keys(record.basicReactions.results).length !== 1
    || !Object.hasOwn(record.basicReactions.results, 'like')) return null;
  const receipt = record.basicReactions.results.like;
  if (receipt?.owner !== THREADS_BENEFIT_POLICY.owner || receipt.operation !== 'like'
    || receipt.postId !== record.pinnedPostId || receipt.target?.toLowerCase?.() !== record.handle.toLowerCase()
    || receipt.success !== true || receipt.readbackVerified !== true
    || receipt.currentState?.id !== record.pinnedPostId
    || receipt.currentState?.author?.toLowerCase?.() !== record.handle.toLowerCase()
    || String(receipt.currentState?.authorId ?? '') !== actorId || receipt.currentState?.liked !== true) return null;

  const reconciledAt = Date.parse(record.basicReactions.reconciledAt || '');
  const readHeldAt = Date.parse(blocked?.readHeldAt || ''), lastSeenAt = Date.parse(blocked?.lastSeenAt || '');
  if (blocked?.status !== 'held' || blocked.stage !== 'reconciliation'
    || blocked.code !== basicReactionReconciliationHoldCode || blocked.id !== actorId
    || blocked.handle?.toLowerCase?.() !== record.handle.toLowerCase()
    || !Number.isSafeInteger(blocked.readHoldCount) || blocked.readHoldCount < 1
    || !Number.isFinite(reconciledAt) || reconciledAt > now
    || !Number.isFinite(readHeldAt) || !Number.isFinite(lastSeenAt)
    || readHeldAt >= reconciledAt || lastSeenAt >= reconciledAt) return null;
  return record.basicReactions.reconciledAt;
}

function canBypassStaleBasicReactionReconciliationHold(target, blocked, now) {
  const reconciledAt = Date.parse(target?.basicReactionsRecoveryReconciledAt || '');
  const readHeldAt = Date.parse(blocked?.readHeldAt || ''), lastSeenAt = Date.parse(blocked?.lastSeenAt || '');
  return target?.basicReactionsPending === true
    && blocked?.status === 'held' && blocked.stage === 'reconciliation'
    && blocked.code === basicReactionReconciliationHoldCode
    && blocked.id === target.id && blocked.handle?.toLowerCase?.() === target.handle?.toLowerCase?.()
    && Number.isSafeInteger(blocked.readHoldCount) && blocked.readHoldCount >= 1
    && Number.isFinite(reconciledAt) && reconciledAt <= now
    && Number.isFinite(readHeldAt) && Number.isFinite(lastSeenAt)
    && readHeldAt < reconciledAt && lastSeenAt < reconciledAt;
}

/** Read only the durable, positively verified history-hold queue before any broad discovery reads. */
export async function readThreadsBasicReactionRecoveryQueue({ root = threadsBenefitWorkerRoot(), config, now = Date.now(), blockedTargets = {} } = {}) {
  if (!config || !validId(config.activePromotionId) || !validHandle(config.owner)
    || config.owner.toLowerCase() !== OWNER || !Number.isSafeInteger(now)) fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
  let raw;
  try { raw = await readFile(path.join(root, 'state.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (Buffer.byteLength(raw, 'utf8') > 5_000_000) fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
  let state;
  try { state = JSON.parse(raw); } catch { fail('THREADS_BENEFIT_WORKER_STATE_INVALID'); }
  if (state?.service !== 'threads' || state.owner !== OWNER || state.policyVersion !== THREADS_BENEFIT_POLICY.version
    || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
  if (state.activePromotionId != null && (String(state.activePromotionId) !== config.activePromotionId
    || state.activePromotionUrl && state.activePromotionUrl !== config.url)) {
    fail('THREADS_BENEFIT_ACTIVE_PROMOTION_CHANGED_REVIEW_REQUIRED');
  }
  const pending = [];
  for (const [id, record] of Object.entries(state.records)) {
    if (!isVerifiedThreadsFollowHistoryHoldRecord(id, record, config.activePromotionId)
      || threadsBasicReactionsVerified(id, record)) continue;
    const preflight = record.basicReactions?.lastPreflight;
    const validRetryAt = record.basicReactions?.status === 'preflight_wait'
      && record.basicReactions.postId === record.pinnedPostId
      && preflight?.code === 'THREADS_READ_BUDGET_WAIT' && preflight.localBudget === true
      && preflight.dispatchStarted === false && preflight.writeSent === false && Number.isSafeInteger(preflight.retryAt);
    const reconciledAt = basicReactionRecoveryReconciledAt(id, record, config.activePromotionId, blockedTargets?.[id], now);
    pending.push({ id, handle: record.handle.toLowerCase(), stage: 'base', basicReactionsPending: true,
      ...(reconciledAt ? { basicReactionsRecoveryReconciledAt: reconciledAt } : {}),
      ...(validRetryAt ? { basicReactionsRetryAt: preflight.retryAt } : {}) });
  }
  return pending.sort((a, b) => Number(a.basicReactionsRetryAt > now) - Number(b.basicReactionsRetryAt > now)
    || (a.basicReactionsRetryAt || 0) - (b.basicReactionsRetryAt || 0) || a.id.localeCompare(b.id));
}

async function readBenefitWorkerLockPresence(root, processReader) {
  let lock;
  try { lock = JSON.parse(await readFile(path.join(root, LOCK_FILE), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? false : null; }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) return null;
  const spec = { script: BENEFIT_WORKER_SCRIPT };
  try {
    const result = await readBotProcessPresence([{ spec, pid: lock.pid }], { processReader });
    return result.get(botProcessKey(spec, lock.pid)) ?? null;
  } catch { return null; }
}

async function configReader({ root }) {
  const { readThreadsBenefitConfig } = await import('./threads-benefit-config.mjs');
  return readThreadsBenefitConfig({ root });
}
async function discoveryReader(config, { root, onDiscoveryProgress }) {
  const { refreshThreadsBenefitEvidence } = await import('./threads-benefit-runner.mjs');
  return refreshThreadsBenefitEvidence({ root, promotionConfig: config, onDiscoveryProgress });
}
async function batchDrafter(config, { root, candidates, discovery, sleep, onReadProgress, onDiscoveryProgress }) {
  const { prepareThreadsBenefitBatch } = await import('./threads-benefit-runner.mjs');
  return prepareThreadsBenefitBatch({ candidateIds: candidates.map(target => target.id) },
    { root, promotionConfig: config, discovery, sleep, onReadProgress, onDiscoveryProgress });
}
async function targetRunner(target, config, { root, execute, requireCachedDraft, sleep, excludeBaseTargetIds, onWorkProgress, onDiscoveryProgress }) {
  const { runThreadsBenefitTarget } = await import('./threads-benefit-runner.mjs');
  return runThreadsBenefitTarget({ handle: target.handle, execute, requireCachedDraft, basicReactionsOnly:target.basicReactionsPending===true,
    expectedTarget: { id: target.id, stage: target.stage, excludeBaseTargetIds } },
    { root, promotionConfig: config, sleep, onWorkProgress, onDiscoveryProgress });
}

const defaultDependencies = {
  readSharedCooldown: now => readThreadsSharedCooldown({ now }),
  followbackPass: async (config, options) => (await import('./threads-followback-pass.mjs')).runThreadsFollowbackPass(config, options),
  readConfig: configReader,
  discover: discoveryReader,
  draftBatch: batchDrafter,
  runTarget: targetRunner,
  now: () => Date.now(),
  sleep: ms => delay(ms),
  isStopRequested: threadsStopRequested,
  acquireLock: acquireThreadsBenefitWorkerLock,
  saveStatus: async (root, value) => atomicJsonWrite(path.join(root, STATUS_FILE), value),
  readStatus: readThreadsBenefitWorkerStatus,
  readBasicReactionQueue: readThreadsBasicReactionRecoveryQueue,
};

async function interruptibleWait(ms, { root, deadline, now, sleep, isStopRequested }) {
  const until = Math.min(now() + Math.max(0, ms), deadline);
  while (now() < until) {
    if (await isStopRequested(root)) return false;
    await sleep(Math.min(1000, until - now()));
  }
  return !(await isStopRequested(root));
}

function checkDiscoveryIdentity(discovery, config) {
  if (!discovery || !Array.isArray(discovery.queue) || !Array.isArray(discovery.held)) fail('THREADS_BENEFIT_WORKER_DISCOVERY_INVALID');
  if (discovery.activePromotionId != null && String(discovery.activePromotionId) !== config.activePromotionId) {
    fail('THREADS_BENEFIT_WORKER_PROMOTION_MISMATCH');
  }
  let promotionUrl = '';
  try { const url = new URL(discovery.promotion?.url); url.pathname = url.pathname.replace(/\/$/, ''); promotionUrl = url.href; } catch {}
  if (!discovery.promotion || String(discovery.promotion.id) !== config.activePromotionId
    || String(discovery.promotion.author || '').toLowerCase() !== OWNER
    || promotionUrl !== config.url
    || discovery.promotion.isReply === true || discovery.promotion.isPinnedToProfile !== true) fail('THREADS_BENEFIT_WORKER_PROMOTION_UNVERIFIED');
}

async function persistStatus(deps, root, status) {
  await deps.saveStatus(root, status);
}

async function waitCooldown(deps, root, status, cooldown, deadline) {
  applyThreadsCooldownStatus(status, cooldown);
  tagThreadsHttp429CooldownStatus(status, cooldown);
  await persistStatus(deps, root, status);
  return interruptibleWait(cooldown.retryAt - deps.now(), { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
}

function updateQueueStatus(status, discovery, config, now) {
  const group = threadsBenefitPriorityGroup(discovery);
  noteDiscoveryHolds(status, discovery, now);
  status.activePromotionId = config.activePromotionId;
  status.lastPollAt = new Date(now).toISOString();
  status.queue = { base: discovery.queue.filter(row => row.stage === 'base').length,
    bonus: discovery.queue.filter(row => row.stage === 'bonus').length,
    other: discovery.queue.filter(row => !['base', 'bonus'].includes(row.stage)).length,
    held: discovery.held.length, nextPriority: group.stage };
  status.coverage = {
    followersComplete: discovery.coverage?.followersComplete === true,
    commentsComplete: discovery.coverage?.commentsComplete === true,
    engagementComplete: discovery.coverage?.engagementComplete === true,
    full: false,
  };
  status.legacyHistory = legacySummary(discovery, config);
  return group;
}

function sameTargetStage(fresh, candidate) {
  return fresh?.queue?.find(user => String(user.id) === candidate.id
    && String(user.handle || '').toLowerCase() === candidate.handle && user.stage === candidate.stage) || null;
}

/**
 * Runs one bounded serial Threads benefit worker. This function is dormant on
 * import; only an explicit `start` command or direct invocation starts it.
 */
export async function runThreadsBenefitWorker({
  root = threadsBenefitWorkerRoot(), durationMilliseconds = DAY, indefinite = false, pollMilliseconds = DEFAULT_POLL_MS,
} = {}, dependencies = {}) {
  validateThreadsBenefitDuration(durationMilliseconds);
  if (typeof indefinite !== 'boolean') fail('THREADS_BENEFIT_WORKER_ARGUMENT_INVALID');
  validateThreadsBenefitPollInterval(pollMilliseconds);
  const deps = { ...defaultDependencies, ...dependencies };
  // The production runner checks the current queue under its coordinator lock.
  // Injected runners retain the worker-side check unless they implement it too.
  const runnerRevalidatesQueue = dependencies.runnerRevalidatesQueue ?? !dependencies.runTarget;
  await mkdir(root, { recursive: true });
  const releaseLock = await deps.acquireLock(root, deps.now);
  const startedAt = deps.now();
  const deadline = indefinite ? Infinity : startedAt + durationMilliseconds;
  const status = {
    schemaVersion: 1, service: 'threads', owner: OWNER, status: 'starting', pid: process.pid,
    workerStarted: false, startedAt: new Date(startedAt).toISOString(), expiresAt: indefinite ? null : new Date(deadline).toISOString(), indefinite,
    durationMilliseconds: indefinite ? null : durationMilliseconds, pollMilliseconds, localHourlyLimit: null, betweenAccountsMilliseconds: 20_000,
    processedThisRun: 0, basicReactionsCompleted: 0, actionStagesCompleted: 0, writesObserved: 0, writeCountUnknown: 0,
    blockedTargets: {},
    mode: 'serial_pure_http',
  };
  let exitCode = null;
  let config;
  let priorStatus = null;
  const onDiscoveryProgress = async progress => {
    if (!['state_lock','state_read','promotion','followers','known_followbacks','active_engagement','active_comments',
      'legacy_engagement','legacy_comments','queue_build'].includes(progress?.phase)
      || !Number.isSafeInteger(progress.completedReads) || progress.completedReads < 0) return;
    status.readPhase = progress.phase; status.lastReadProgressAt = new Date(deps.now()).toISOString();
    status.readsCompleted = progress.completedReads;
    await persistStatus(deps, root, status);
  };
  const onWorkProgress = async progress => {
    if (!['coordinator_lock','target_revalidation','target_revalidation_completed','actor_preflight','action_dispatch','action_completed'].includes(progress?.phase)) return;
    status.workPhase = progress.phase; status.lastWorkProgressAt = new Date(deps.now()).toISOString();
    if (['target_revalidation_completed','actor_preflight'].includes(progress.phase)) {
      status.lastReadCompletedAt = new Date(deps.now()).toISOString();
      delete status.readPhase; delete status.readPhaseStartedAt;
    }
    if (['follow','like','repost','contextual_reply','completion_reply','bonus_like','bonus_repost'].includes(progress.operation)) {
      status.currentOperation = progress.operation;
    } else delete status.currentOperation;
    await persistStatus(deps, root, status);
  };
  try {
    priorStatus = await deps.readStatus({ root });
    status.blockedTargets = priorStatus?.blockedTargets && typeof priorStatus.blockedTargets === 'object' ? priorStatus.blockedTargets : {};
    // Holds recorded before read backoff existed count as one hold from their last sighting, so a restart does not
    // re-read every held actor at once.
    for (const row of Object.values(status.blockedTargets)) {
      if (row?.status === 'held' && row.stage === 'base' && !Number.isSafeInteger(row.readHoldCount) && Number.isFinite(Date.parse(row.lastSeenAt || ''))) {
        row.readHoldCount = 1; row.readHeldAt = row.lastSeenAt;
      }
    }
    config = validateThreadsBenefitPromotionConfig(await deps.readConfig({ root }));
    status.activePromotionId = config.activePromotionId;
    status.promotionConfigVerified = true;
    const configFingerprint = threadsBenefitWorkerConfigFingerprint(config);
    // Startup never clears a STOP. The serialized runtime controller owns an
    // explicitly authorized resume; a newer user stop must survive startup.
    await persistStatus(deps, root, status);

    if (priorStatus?.httpStatus === 429 || isThreadsGraphqlThrottle(priorStatus)) {
      const oldRetryAt = Date.parse(priorStatus.retryAt || '');
      const retryAt = Number.isFinite(oldRetryAt)
        ? oldRetryAt : Number.isFinite(Date.parse(priorStatus.finishedAt || ''))
          ? Date.parse(priorStatus.finishedAt) + 15 * 60 * 1000 : deps.now() + 15 * 60 * 1000;
      if (retryAt > deps.now()) {
        const waited = await waitCooldown(deps, root, status, { retryAt, httpStatus: priorStatus.httpStatus,
            ...(isThreadsGraphqlThrottle(priorStatus) ? { code: priorStatus.code, deadlineSource: priorStatus.deadlineSource,
              operation: priorStatus.throttleOperation, consecutiveThrottles: priorStatus.consecutiveThrottles,
              fallbackMilliseconds: priorStatus.fallbackMilliseconds } : {}) }, deadline);
        if (!waited) {
          status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired';
          return { ...status, workerStarted: false };
        }
      }
    }

    let first = true;
    while (deps.now() < deadline) {
      if (await deps.isStopRequested(root)) { status.status = 'stopped'; break; }
      try {
        const sharedCooldown = await deps.readSharedCooldown(deps.now());
        if (sharedCooldown) {
          const waited = await waitCooldown(deps, root, status, sharedCooldown, deadline);
          if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
          continue;
        }
        if (clearExpiredThreadsBenefitWorkerCooldownStatus(status, deps.now())) await persistStatus(deps, root, status);
        const freshConfig = validateThreadsBenefitPromotionConfig(await deps.readConfig({ root }));
        if (threadsBenefitWorkerConfigFingerprint(freshConfig) !== configFingerprint) fail('THREADS_BENEFIT_WORKER_PROMOTION_CHANGED');
        // Follow back new followers first, every cycle (owner 2026-10-06 "신규 팔로워들 처리가 안되나 지금 ?? 로직 어디
        // 빵꾸났나"). It used to run after the basic-reaction recovery below. That recovery `continue`s the loop while
        // any held row is deferred, so six backed-off rows kept the follow-back pass from ever running.
        if (!dependencies.discover || dependencies.followbackPass) {
          status.lastFollowbackPass = await deps.followbackPass(config, { root,
            sleep: ms => interruptibleWait(ms, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested }),
            isStopRequested: () => deps.isStopRequested(root) });
          status.lastFollowbackPassAt = new Date(deps.now()).toISOString();
          status.writesObserved += status.lastFollowbackPass.writes || 0;
          await persistStatus(deps, root, status);
        }
        // Recover the durable follow-history reaction queue before follower,
        // engagement, comment, or legacy discovery can consume this poll's
        // read budget. The target runner still performs fresh promotion,
        // actor, follow, pin, and post checks under its coordinator lock.
        const basicPending = await deps.readBasicReactionQueue({ root, config, now: deps.now(), blockedTargets: status.blockedTargets });
        if (!Array.isArray(basicPending)) fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
        if (basicPending.length) {
          status.workerStarted = true;
          status.status = 'running';
          if (!runnerRevalidatesQueue) fail('THREADS_BENEFIT_WORKER_BASIC_REVALIDATION_UNAVAILABLE');
          const ready = [], deferred = [];
          for (const target of basicPending) {
            if (!validId(target?.id) || !validHandle(target?.handle) || target.stage !== 'base'
              || target.basicReactionsPending !== true) fail('THREADS_BENEFIT_WORKER_STATE_INVALID');
            const blocked = status.blockedTargets?.[safeTargetKey(target)];
            const historyHold = basicReactionHistoryHoldCodes.has(blocked?.code)
              || blocked?.code === 'THREADS_READ_BUDGET_WAIT';
            const reconciledHoldExpired = canBypassStaleBasicReactionReconciliationHold(target, blocked, deps.now());
            const retryAt = Math.max(Number.isSafeInteger(target.basicReactionsRetryAt) ? target.basicReactionsRetryAt : 0,
              Number.isSafeInteger(blocked?.retryAt) ? blocked.retryAt : 0);
            if (retryAt > deps.now() || readHoldBackoffActive(blocked, deps.now()) && !historyHold && !reconciledHoldExpired) {
              deferred.push({ target, retryAt });
            } else ready.push(target);
          }
          if (!ready.length) {
            const budgetRetryPending = deferred.some(({ target, retryAt }) => retryAt > deps.now()
              && (Number.isSafeInteger(target.basicReactionsRetryAt)
                || status.blockedTargets?.[safeTargetKey(target)]?.code === 'THREADS_READ_BUDGET_WAIT'));
            status.basicReactionRecovery = { pending: basicPending.length, ready: 0,
              deferred: deferred.length, reason: budgetRetryPending ? 'read_budget_retry' : 'actor_local_backoff' };
            await persistStatus(deps, root, status);
            if (!budgetRetryPending) {
              // A target-local identity/preflight hold cannot consume an action
              // slot. Let ordinary discovery find other actors while this one
              // remains under its per-target backoff.
            } else {
            const nextRetryAt = deferred.reduce((next, row) => row.retryAt > deps.now()
              ? Math.min(next, row.retryAt) : next, Infinity);
            status.status = 'waiting_for_queue';
            status.workPhase = 'basic_reaction_recovery_wait';
            status.basicReactionRecovery.retryAt = Number.isFinite(nextRetryAt) ? new Date(nextRetryAt).toISOString() : null;
            await persistStatus(deps, root, status);
            const waitMs = Number.isFinite(nextRetryAt) ? Math.min(pollMilliseconds, Math.max(1000, nextRetryAt - deps.now())) : pollMilliseconds;
            const waited = await interruptibleWait(waitMs, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
            if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
            continue;
            }
          } else {
            status.workPhase = 'basic_reaction_recovery';
            status.lastWorkProgressAt = new Date(deps.now()).toISOString();
            status.basicReactionRecovery = { pending: basicPending.length, ready: ready.length,
              deferred: deferred.length, startedAt: new Date(deps.now()).toISOString() };
            await persistStatus(deps, root, status);
            let budgetWaitAt = null, targetLocalHold = false, recoveryCooldown = false;
            for (const target of ready.slice(0, DRAFT_GROUP_SIZE)) {
              if (deps.now() >= deadline || await deps.isStopRequested(root)) break;
              const latestConfig = validateThreadsBenefitPromotionConfig(await deps.readConfig({ root }));
              if (threadsBenefitWorkerConfigFingerprint(latestConfig) !== configFingerprint) fail('THREADS_BENEFIT_WORKER_PROMOTION_CHANGED');
              status.currentHandle = target.handle;
              await persistStatus(deps, root, status);
              let result;
              try {
                result = await deps.runTarget(target, config, { root, execute: true, requireCachedDraft: true,
                  sleep: ms => interruptibleWait(ms, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested }),
                  excludeBaseTargetIds: [], onWorkProgress, onDiscoveryProgress });
              } catch (error) {
                delete status.currentHandle; delete status.currentOperation;
                const cooldown = threadsBenefitWorkerCooldown(error, deps.now());
                if (cooldown) {
                  await waitCooldown(deps, root, status, cooldown, deadline);
                  recoveryCooldown = true; break;
                }
                if (isThreadsBenefitAuthChallenge(error) || isThreadsBenefitReplyServerBlock(error)) throw error;
                const code = safeCode(error);
                if (isLocalReadBudgetWait(error)) {
                  noteReadHold(status, target, code, deps.now());
                  status.blockedTargets[safeTargetKey(target)].retryAt = error.retryAt;
                  status.lastTarget = { id: target.id, handle: target.handle, stage: 'base', result: 'held', code, writes: 0 };
                  budgetWaitAt = error.retryAt;
                  await persistStatus(deps, root, status);
                  break;
                }
                if (blockIsTargetLocal(code)) {
                  noteReadHold(status, target, code, deps.now());
                  status.lastTarget = { id: target.id, handle: target.handle, stage: 'base', result: 'held', code, writes: 0 };
                  targetLocalHold = true;
                  await persistStatus(deps, root, status);
                  continue;
                }
                throw error;
              }
              delete status.currentHandle; delete status.currentOperation;
              const basicVerified = result?.basicReactionsVerified === true;
              status.lastTarget = { id: target.id, handle: target.handle, stage: 'base',
                result: basicVerified ? 'basic_reactions_verified_history_hold' : 'held',
                code: /^[A-Z][A-Z0-9_]{2,100}$/.test(result?.code || '') ? result.code : null,
                writes: Number.isSafeInteger(result?.writes) ? result.writes : null,
                writeCountUnknown: result?.writeCountUnknown === true };
              if (Number.isSafeInteger(result?.writes)) status.writesObserved += result.writes;
              if (result?.writeCountUnknown === true || !Number.isSafeInteger(result?.writes)) status.writeCountUnknown += 1;
              if(stoppedBeforeDispatch(result,target)) {
                pauseTargetBeforeDispatch(status,target,result,deps.now());
                await persistStatus(deps,root,status);
                return {...status,exitCode,workerStarted:status.workerStarted===true};
              }
              if (basicVerified) {
                status.basicReactionsCompleted += 1;
                resolveTarget(status, target, deps.now());
              } else {
                const reason = result?.code || holdCodeForStage('reconciliation');
                noteReadHold(status, target, reason, deps.now());
                if (isLocalReadBudgetWait(result)) {
                  status.blockedTargets[safeTargetKey(target)].retryAt = result.retryAt;
                  budgetWaitAt = result.retryAt;
                } else targetLocalHold = true;
              }
              await persistStatus(deps, root, status);
              const cooldown = threadsBenefitWorkerCooldown(result, deps.now());
              if (cooldown) {
                await waitCooldown(deps, root, status, cooldown, deadline);
                recoveryCooldown = true; break;
              }
              if (isThreadsBenefitReplyServerBlock(result)) fail(result.code ?? result.receipt.code);
              if (isThreadsBenefitAuthChallenge(result?.code)) fail(result.code);
              if (budgetWaitAt) break;
            }
            if (recoveryCooldown) continue;
            if (budgetWaitAt || targetLocalHold) {
              status.status = 'waiting_for_queue';
              status.workPhase = 'basic_reaction_recovery_wait';
              status.retryAt = new Date(budgetWaitAt || deps.now() + pollMilliseconds).toISOString();
              await persistStatus(deps, root, status);
              const waitMs = Math.min(pollMilliseconds, Math.max(1000, (budgetWaitAt || deps.now() + pollMilliseconds) - deps.now()));
              const waited = await interruptibleWait(waitMs, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
              if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
              continue;
            }
            // More held rows get first claim on the next cycle; only when they
            // are all verified or reconciled do we resume broad discovery.
            const stillPending = await deps.readBasicReactionQueue({ root, config, now: deps.now() });
            if (stillPending.length) {
              status.basicReactionRecovery = { pending: stillPending.length, ready: null,
                deferred: stillPending.filter(row => row.basicReactionsRetryAt > deps.now()).length,
                checkedAt: new Date(deps.now()).toISOString() };
              await persistStatus(deps, root, status);
              continue;
            }
            delete status.basicReactionRecovery;
          }
        }
        status.readPhase='discovery'; status.readPhaseStartedAt=new Date(deps.now()).toISOString();
        await persistStatus(deps,root,status);
        const discovery = await readBenefitPhase('discovery', () => deps.discover(config, { root, fresh: true, onDiscoveryProgress }));
        status.lastReadCompletedAt=new Date(deps.now()).toISOString(); delete status.readPhase;delete status.readPhaseStartedAt;
        checkDiscoveryIdentity(discovery, config);
        if (first) {
          // refreshThreadsBenefitEvidence loads durable state, verifies the new
          // active pin, and appends only positive same-promotion legacy evidence.
          status.legacyStartupEvidence = legacySummary(discovery, config);
          status.legacyHistoryFullList = false;
        }
        first = false;
        status.workerStarted = true;
        status.status = 'running';
        delete status.code; delete status.httpStatus; delete status.retryAt;
        delete status.rateLimited; delete status.cooldownReason; delete status.deadlineSource;
        delete status.throttleOperation; delete status.consecutiveThrottles; delete status.fallbackMilliseconds;
        let group = updateQueueStatus(status, discovery, config, deps.now());
        await persistStatus(deps, root, status);

        if (!group.targets.length) {
          status.status = 'waiting_for_queue';
          await persistStatus(deps, root, status);
          const waited = await interruptibleWait(pollMilliseconds, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
          if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
          continue;
        }

        let cycleProgress = false;
        let cooldownWaited = false;
        const heldBaseThisCycle = new Set();
        let draftDiscovery = discovery;
        for (let priorityPass = 0; priorityPass < 2; priorityPass += 1) {
          if (!group.targets.length) break;
          // Chunk preparation, not eligibility or the full priority pass. Each
          // small group is executed before drafting the next, so its cache ages
          // less and the first actor need not wait for every queued actor.
          const size = group.stage === 'base' ? DRAFT_GROUP_SIZE : group.targets.length;
          let basePriorityPending = false;
          for (let offset = 0; offset < group.targets.length; offset += size) {
          if (cooldownWaited || deps.now() >= deadline || await deps.isStopRequested(root)) break;
          const candidates = group.targets.slice(offset, offset + size).filter(target => {
            if(target.basicReactionsPending===true && target.basicReactionsRetryAt>deps.now()) {
              heldBaseThisCycle.add(target.id);return false;
            }
            const blocked=status.blockedTargets?.[safeTargetKey(target)];
            const reactionReadAllowed=target.basicReactionsPending===true
              && ['THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE','THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED',
                'THREADS_READ_BUDGET_WAIT'].includes(blocked?.code)
              || canBypassStaleBasicReactionReconciliationHold(target, blocked, deps.now());
            if (group.stage !== 'base' || reactionReadAllowed || !readHoldBackoffActive(blocked, deps.now())) return true;
            heldBaseThisCycle.add(target.id);
            return false;
          });
          if (!candidates.length) continue;
          const followOnlyTargetIds = new Set();
          const draftCandidates=candidates.filter(target=>target.basicReactionsPending!==true);
          if (group.stage === 'base' && draftCandidates.length) {
            status.workPhase = 'draft_batch'; status.lastWorkProgressAt = new Date(deps.now()).toISOString();
            await persistStatus(deps, root, status);
            const draftReceipt = await readBenefitPhase('draft_batch', () => deps.draftBatch(config, {
              root, candidates:draftCandidates, priorityStage: 'base', discovery: draftDiscovery, onDiscoveryProgress,
              sleep: ms => interruptibleWait(ms, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested }),
              onReadProgress: async progress => {
                status.lastDraftRead = { actorsRead: progress.actorsRead, totalBaseActors: progress.totalBaseActors,
                  checkedAt: new Date(deps.now()).toISOString(), betweenAccountsMilliseconds: 20_000 };
                await persistStatus(deps, root, status);
              },
            }));
            status.lastAiBatch = {
              model: typeof draftReceipt?.model === 'string' ? draftReceipt.model : null,
              effort: typeof draftReceipt?.effort === 'string' ? draftReceipt.effort : null,
              accounts: Number.isSafeInteger(draftReceipt?.prepared) ? draftReceipt.prepared
                : Array.isArray(draftReceipt?.drafts) ? draftReceipt.drafts.length : 0,
              followOnly: Array.isArray(draftReceipt?.followOnlyTargets) ? draftReceipt.followOnlyTargets.length : 0,
              alreadyVerifiedFollowOnly: Array.isArray(draftReceipt?.alreadyVerifiedFollowOnlyTargets)
                ? draftReceipt.alreadyVerifiedFollowOnlyTargets.length : 0,
              elapsedMs: Number.isSafeInteger(draftReceipt?.elapsedMs) ? draftReceipt.elapsedMs : null,
              writes: 0,
            };
            const skippedTargets = Array.isArray(draftReceipt?.skippedTargets) ? draftReceipt.skippedTargets : [];
            const alreadyVerifiedFollowOnlyTargets = Array.isArray(draftReceipt?.alreadyVerifiedFollowOnlyTargets)
              ? draftReceipt.alreadyVerifiedFollowOnlyTargets.filter(row => validId(row?.id) && validHandle(row?.handle)
                && row.stage === 'base' && row.status === 'already_verified_follow_only_hold'
                && row.activePromotionId === config.activePromotionId
                && ['THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
                  'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED'].includes(row.code)
                && candidates.some(target => target.id === row.id
                  && target.handle.toLowerCase() === row.handle.toLowerCase())
                && !skippedTargets.some(skipped => skipped?.id === row.id
                  && String(skipped?.handle || '').toLowerCase() === row.handle.toLowerCase()
                  && skipped.code !== row.code))
              : [];
            const alreadyVerifiedFollowOnlyIds = new Set(alreadyVerifiedFollowOnlyTargets.map(row => row.id));
            const followOnlyTargets = Array.isArray(draftReceipt?.followOnlyTargets)
              ? draftReceipt.followOnlyTargets.filter(row => validId(row?.id) && validHandle(row?.handle)
                && row.stage === 'base' && ['THREADS_BENEFIT_PRIOR_REPLY_SCAN_INCOMPLETE',
                  'THREADS_BENEFIT_EXISTING_REPLY_REVIEW_REQUIRED'].includes(row.code)
                && !alreadyVerifiedFollowOnlyIds.has(row.id)
                && candidates.some(target => target.id === row.id
                  && target.handle.toLowerCase() === row.handle.toLowerCase())
                && !skippedTargets.some(skipped => skipped?.id === row.id
                  && String(skipped?.handle || '').toLowerCase() === row.handle.toLowerCase()
                  && skipped.code !== row.code))
              : [];
            for (const row of alreadyVerifiedFollowOnlyTargets) {
              heldBaseThisCycle.add(row.id);
              noteReadHold(status, row, row.code, deps.now());
            }
            for (const row of followOnlyTargets) followOnlyTargetIds.add(row.id);
            for (const skipped of skippedTargets) {
              if (alreadyVerifiedFollowOnlyTargets.some(row => row.id === skipped?.id
                && row.handle.toLowerCase() === String(skipped?.handle || '').toLowerCase()
                && row.code === skipped?.code)
                || followOnlyTargets.some(row => row.id === skipped?.id
                && row.handle.toLowerCase() === String(skipped?.handle || '').toLowerCase()
                && row.code === skipped?.code)) continue;
              if (skipped.stage === 'base') noteReadHold(status, skipped, skipped.code, deps.now());
              else holdTarget(status, skipped, skipped.stage, skipped.code, deps.now());
              if (skipped.stage === 'base' && validId(skipped.id)) heldBaseThisCycle.add(String(skipped.id));
            }
            await persistStatus(deps, root, status);
          }

          for (const target of candidates) {
            if (deps.now() >= deadline || await deps.isStopRequested(root)) break;
            if (group.stage === 'base' && heldBaseThisCycle.has(target.id) && !followOnlyTargetIds.has(target.id)) continue;
            const latestConfig = validateThreadsBenefitPromotionConfig(await deps.readConfig({ root }));
            if (threadsBenefitWorkerConfigFingerprint(latestConfig) !== configFingerprint) fail('THREADS_BENEFIT_WORKER_PROMOTION_CHANGED');
            let candidate = target;
            if (!runnerRevalidatesQueue) {
              await onWorkProgress({ phase: 'target_revalidation' });
              const fresh = await readBenefitPhase('target_revalidation', () => deps.discover(config, { root, fresh: true, onDiscoveryProgress }));
              status.lastReadCompletedAt = new Date(deps.now()).toISOString();
              delete status.readPhase; delete status.readPhaseStartedAt;
              checkDiscoveryIdentity(fresh, config);
              const next = threadsBenefitPriorityGroup(fresh, { excludeTargetIds: heldBaseThisCycle });
              noteDiscoveryHolds(status, fresh, deps.now());
              if (group.stage === 'bonus' && next.stage === 'base') { basePriorityPending = true; break; }
              candidate = sameTargetStage(fresh, target);
            }
            if (!candidate) continue;
            try {
              status.currentHandle = candidate.handle;
              await onWorkProgress({ phase: 'coordinator_lock' });
              const stopAwareSleep = ms => interruptibleWait(ms, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
              const result = await deps.runTarget(candidate, config, { root, execute: true, requireCachedDraft: true,
                sleep: stopAwareSleep, excludeBaseTargetIds: [...heldBaseThisCycle], onWorkProgress, onDiscoveryProgress });
              delete status.currentHandle; delete status.currentOperation;
              if (result?.status === 'base_priority_pending') { basePriorityPending = true; break; }
              if (result?.status === 'skipped_current_queue') continue;
              status.lastTarget = { id: target.id, handle: target.handle, stage: target.stage,
                result: ['verified', 'pending_follow_request', 'needs_reconciliation'].includes(result?.status) ? result.status : 'held',
                code: /^[A-Z][A-Z0-9_]{2,100}$/.test(result?.code || '') ? result.code : null,
                writes: Number.isSafeInteger(result?.writes) ? result.writes : null,
                writeCountUnknown: result?.writeCountUnknown === true };
              if(stoppedBeforeDispatch(result,target)) {
                status.writesObserved+=result.writes;
                pauseTargetBeforeDispatch(status,target,result,deps.now());
                await persistStatus(deps,root,status);
                return {...status,exitCode,workerStarted:status.workerStarted===true};
              }
              if (result?.status === 'verified') {
                cycleProgress = true;
                status.processedThisRun += 1;
                status.actionStagesCompleted += 1;
                if (Number.isSafeInteger(result.writes)) status.writesObserved += result.writes;
                resolveTarget(status, target, deps.now());
              } else {
                if (result?.basicReactionsVerified===true) {
                  status.basicReactionsCompleted += 1;
                  cycleProgress = true;
                }
                const reason = result?.code || holdCodeForStage(result?.status === 'pending_follow_request' ? 'pending' : 'reconciliation');
                if (target.stage === 'base') noteReadHold(status, target, reason, deps.now());
                else holdTarget(status, target, target.stage, reason, deps.now());
                // Keep every held base actor out of later priority passes in
                // this cycle. In particular, a verified follow-only history
                // hold should remain queued for the next poll without
                // preventing unrelated, already-qualified bonus actors from
                // advancing. This is scheduling only; it does not resolve the
                // actor or waive any reconciliation gate.
                if (target.stage === 'base') heldBaseThisCycle.add(target.id);
                if (result?.writeCountUnknown === true || !Number.isSafeInteger(result?.writes)) status.writeCountUnknown += 1;
                if (Number.isSafeInteger(result?.writes)) status.writesObserved += result.writes;
              }
              await persistStatus(deps, root, status);
              const cooldown = threadsBenefitWorkerCooldown(result, deps.now());
              if (cooldown) {
                await waitCooldown(deps, root, status, cooldown, deadline);
                cooldownWaited = true;
                cycleProgress = false;
                break;
              }
              if (isThreadsBenefitReplyServerBlock(result)) fail(result.code ?? result.receipt.code);
              if (isThreadsBenefitAuthChallenge(result?.code)) fail(result.code);
            } catch (error) {
              const cooldown = threadsBenefitWorkerCooldown(error, deps.now());
              if (cooldown) {
                await waitCooldown(deps, root, status, cooldown, deadline);
                cooldownWaited = true;
                cycleProgress = false;
                break;
              }
              if (isThreadsBenefitAuthChallenge(error) || isThreadsBenefitReplyServerBlock(error)) throw error;
              const code = safeCode(error);
              if (code === 'THREADS_BENEFIT_STOPPED') {
                status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired';
                await persistStatus(deps, root, status);
                break;
              }
              if (blockIsTargetLocal(code)) {
                if (target.stage === 'base') noteReadHold(status, target, code, deps.now());
                else holdTarget(status, target, target.stage, code, deps.now());
                if (target.stage === 'base') heldBaseThisCycle.add(target.id);
                status.lastTarget = { id: target.id, handle: target.handle, stage: target.stage, result: 'held', code, writes: 0 };
                await persistStatus(deps, root, status);
                continue;
              }
              throw error;
            }
          }
          if (basePriorityPending) break;
          }

          // A local base-history hold must not starve already qualified bonus
          // actors. Retry held base targets on the next poll, after this full pass.
          if (group.stage !== 'base' || cooldownWaited || deps.now() >= deadline || await deps.isStopRequested(root)) break;
          await onWorkProgress({ phase: 'target_revalidation' });
          const afterBase = await readBenefitPhase('after_base_discovery', () => deps.discover(config, { root, fresh: true, onDiscoveryProgress }));
          status.lastReadCompletedAt = new Date(deps.now()).toISOString();
          delete status.readPhase; delete status.readPhaseStartedAt;
          checkDiscoveryIdentity(afterBase, config);
          noteDiscoveryHolds(status, afterBase, deps.now());
          group = threadsBenefitPriorityGroup(afterBase, { excludeTargetIds: heldBaseThisCycle });
          draftDiscovery = afterBase;
          updateQueueStatus(status, afterBase, config, deps.now());
          status.queue.nextPriority = group.stage;
          await persistStatus(deps, root, status);
          if (group.stage !== 'bonus') break;
        }
        if (!cycleProgress && !cooldownWaited && deps.now() < deadline && !(await deps.isStopRequested(root))) {
          status.status = 'waiting_for_queue';
          await persistStatus(deps, root, status);
          const waited = await interruptibleWait(pollMilliseconds, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
          if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
        }
      } catch (error) {
        captureBotFailure(status, error, error.phase || (status.currentHandle ? 'target_processing' : 'read_or_orchestration'));
        if (error.code === 'THREADS_BENEFIT_STOPPED') {
          status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired';
          break;
        }
        // Only an explicitly classified read-only timeout may resume discovery.
        // An unclassified response or a failure from mixed action work stays held.
        if (error instanceof ThreadsBenefitReadTimeout || error instanceof ThreadsBenefitReadContextExpired) {
          status.status = 'waiting_for_network';
          status.lastTransientCode = error.code;
          const recovery = { phase: error.phase, at: new Date(deps.now()).toISOString(), failure: threadsSafeFailure(error.cause ?? error) };
          if (error instanceof ThreadsBenefitReadContextExpired) status.lastReadRecovery = recovery;
          else status.lastReadTimeout = recovery;
          status.retryAt = new Date(deps.now() + pollMilliseconds).toISOString();
          delete status.code; delete status.httpStatus;
          delete status.rateLimited; delete status.cooldownReason; delete status.deadlineSource;
          await persistStatus(deps, root, status);
          const waited = await interruptibleWait(pollMilliseconds, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
          if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
          continue;
        }
        if (error.code === 'META_SESSION_BUSY' && !(Number(error.httpStatus ?? error.receipt?.httpStatus) >= 300)) {
          status.status = 'waiting_for_session'; status.lastTransientCode = 'META_SESSION_BUSY';
          await persistStatus(deps, root, status);
          const waited = await interruptibleWait(10_000, { root, deadline, now: deps.now, sleep: deps.sleep, isStopRequested: deps.isStopRequested });
          if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
          continue;
        }
        const cooldown = threadsBenefitWorkerCooldown(error, deps.now());
        if (cooldown) {
          const waited = await waitCooldown(deps, root, status, cooldown, deadline);
          if (!waited) { status.status = (await deps.isStopRequested(root)) ? 'stopped' : 'expired'; break; }
          continue;
        }
        status.status = 'blocked';
        status.code = safeCode(error);
        status.failure = threadsSafeFailure(error);
        if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) status.httpStatus = error.httpStatus;
        if (isThreadsBenefitReplyServerBlock(error)) status.blockedScope = 'reply_server_block';
        else if (isThreadsBenefitAuthChallenge(error)) status.blockedScope = 'worker_authentication_or_challenge';
        else if (/PROMOTION_(?:CONFIG_INVALID|UNVERIFIED|MISMATCH|CHANGED)/.test(status.code)) status.blockedScope = 'worker_activation_gate';
        else status.blockedScope = 'worker_read_or_orchestration';
        exitCode = status.code;
        await persistStatus(deps, root, status);
        break;
      }
    }
    if (['starting', 'running', 'waiting_for_queue', 'waiting_for_session', 'waiting_for_network', 'cooldown'].includes(status.status)) {
      status.status = deps.now() >= deadline ? 'expired' : 'stopped';
    }
    if (status.status === 'blocked' && !status.code) status.code = 'THREADS_BENEFIT_WORKER_BLOCKED';
    return { ...status, exitCode, workerStarted: status.workerStarted === true };
  } catch (error) {
    captureBotFailure(status, error, 'startup_or_orchestration');
    status.status = 'blocked';
    status.code = safeCode(error);
    status.failure = threadsSafeFailure(error);
    if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) status.httpStatus = error.httpStatus;
    if (isThreadsBenefitReplyServerBlock(error)) status.blockedScope = 'reply_server_block';
    else if (isThreadsBenefitAuthChallenge(error)) status.blockedScope = 'worker_authentication_or_challenge';
    else if (/PROMOTION_(?:CONFIG_INVALID|UNVERIFIED|MISMATCH|CHANGED)/.test(status.code)) status.blockedScope = 'worker_activation_gate';
    else status.blockedScope = 'worker_read_or_orchestration';
    exitCode = status.code;
    return { ...status, exitCode, workerStarted: false };
  } finally {
    status.finishedAt = new Date(deps.now()).toISOString();
    await persistStatus(deps, root, status).catch(() => {});
    await releaseLock();
  }
}

function parseStartArguments(args) {
  let durationMilliseconds = DAY;
  if (args.length === 0) return { durationMilliseconds };
  if (args.length === 1 && args[0] === '--indefinite') return { indefinite: true };
  if (args.length !== 2 || args[0] !== '--duration-hours' || !/^(?:[1-9]|1\d|2[0-4])$/.test(args[1])) fail('THREADS_BENEFIT_WORKER_ARGUMENT_INVALID');
  durationMilliseconds = Number(args[1]) * 60 * 60 * 1000;
  return { durationMilliseconds };
}

export async function main(command = process.argv[2], args = process.argv.slice(3)) {
  if (command === 'status' && args.length === 0) {
    console.log(JSON.stringify(await readThreadsBenefitWorkerStatus()));
    return;
  }
  if (command === 'stop' && args.length === 0) {
    console.log(JSON.stringify(await requestThreadsBenefitWorkerStop()));
    return;
  }
  if (command === 'start') {
    const result = await runThreadsBenefitWorker(parseStartArguments(args));
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 2;
    return;
  }
  fail('THREADS_BENEFIT_WORKER_COMMAND_INVALID');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === 'start') installThreadsProcessLifecycle('threads-benefits', threadsBenefitWorkerRoot());
  main().catch(async error => {
    const logging = await recordBotFailure('threads-benefits', threadsBenefitWorkerRoot(), error, { phase: 'worker_entry' });
    console.log(JSON.stringify({ ok: false, service: 'threads', code: safeCode(error), workerStarted: false, logging }));
    process.exitCode = 2;
  });
}
