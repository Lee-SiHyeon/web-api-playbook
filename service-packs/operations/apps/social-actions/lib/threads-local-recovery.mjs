import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';
import { verifyThreadsRuntimeOwner } from './threads-runtime-owner.mjs';
import { threadsRuntimePaths, threadsStopRequested } from './threads-runtime-control.mjs';

const localFaults = new Set(['CREDENTIAL_STORE_UNREADABLE', 'CREDENTIAL_STORE_FAILED', 'CREDENTIAL_STORE_UNVERIFIED', 'META_SESSION_BUSY']);
const localFault = status => localFaults.has(status?.code) && !(Number(status?.httpStatus) >= 300);
const HOUR = 60 * 60_000;
const GRAPHQL_LEGACY_FALLBACK_MAX = 2 * HOUR;
const ACCOUNT_REVIEW_INTERVAL = 30 * 60_000;
const HTTP_429_LOCAL_FALLBACK_MS = 15 * 60_000;
const restartableHttp429Code = status => status?.code == null || status.code === 'META_HTTP_429_COOLDOWN';
const graphqlDeadlineSources = new Set(['server_hint', 'local_fallback', 'local_fallback_15_minutes', 'local_backoff']);

export function isThreadsLocalReadBudgetStatus(status) {
  return status?.status === 'waiting_for_read_budget' && status.code === 'THREADS_READ_BUDGET_WAIT'
    && status.cooldownReason === 'shared_read_budget' && status.deadlineSource === 'local_budget'
    && (status.httpStatus == null || status.httpStatus === 200);
}

export function tagThreadsHttp429CooldownStatus(status, cooldown) {
  if (Number(cooldown?.httpStatus) !== 429 || cooldown.cooldownReason !== 'http_429_rate_limit') return false;
  if (cooldown.deadlineSource === 'server_hint') {
    status.cooldownReason = 'http_429_rate_limit';
    status.deadlineSource = 'server_hint';
    delete status.fallbackMilliseconds;
    return true;
  }
  if (cooldown.deadlineSource === 'local_fallback_15_minutes'
    && cooldown.fallbackMilliseconds === HTTP_429_LOCAL_FALLBACK_MS) {
    status.cooldownReason = 'http_429_rate_limit';
    status.deadlineSource = 'local_fallback_15_minutes';
    status.fallbackMilliseconds = HTTP_429_LOCAL_FALLBACK_MS;
    return true;
  }
  return false;
}

export function threadsRecognizedWaitState(status, now = Date.now()) {
  const retryAt = Date.parse(status?.retryAt || '');
  if (!Number.isFinite(now) || !Number.isFinite(retryAt) || retryAt <= now) return false;
  if (isThreadsLocalReadBudgetStatus(status)) return retryAt <= now + HOUR;
  if (status?.status === 'cooldown' && status.code === 'META_GRAPHQL_THROTTLED'
    && status.httpStatus === 200 && status.cooldownReason === 'graphql_200_rate_limit'
    && graphqlDeadlineSources.has(status.deadlineSource)) {
    if (status.deadlineSource === 'server_hint') return true;
    return Number.isSafeInteger(status.fallbackMilliseconds) && status.fallbackMilliseconds >= 0
      && status.fallbackMilliseconds <= GRAPHQL_LEGACY_FALLBACK_MAX && retryAt <= now + GRAPHQL_LEGACY_FALLBACK_MAX;
  }
  if (status?.status === 'cooldown' && status.httpStatus === 429 && restartableHttp429Code(status)
    && status.cooldownReason === 'http_429_rate_limit') {
    if (status.deadlineSource === 'server_hint') return true;
    return status.deadlineSource === 'local_fallback_15_minutes'
      && status.fallbackMilliseconds === HTTP_429_LOCAL_FALLBACK_MS
      && retryAt <= now + HTTP_429_LOCAL_FALLBACK_MS;
  }
  return status?.status === 'waiting_for_account_restriction'
    && status.code === 'THREADS_ACCOUNT_WRITE_RESTRICTION'
    && status.blockedScope === 'account_feature_restriction' && status.accountWriteHold != null
    && retryAt <= now + ACCOUNT_REVIEW_INTERVAL;
}

export function threadsLocalRecoveryKind(status, now = Date.now()) {
  if (localFault(status)) return 'local_fault';
  // These phases only read first-party state / prepare drafts. Start a fresh
  // cycle without altering any durable action journal or target reservation.
  if (status?.status === 'blocked' && status.code === 'META_CONTEXT_EXPIRED'
    && ['draft_batch', 'discovery'].includes(status.failurePhase)
    && !status.writeCountUnknown && !status.diagnostic?.writeCountUnknown
    && !status.diagnostic?.needsReconciliation && status.diagnostic?.writeSent !== true
    && status.diagnostic?.request?.writeSent !== true) return 'expired_read_context';
  const retryAt = Date.parse(status?.retryAt || '');
  const localReadBudgetWait = isThreadsLocalReadBudgetStatus(status) && Number.isFinite(retryAt)
    && Number.isFinite(now) && (retryAt <= now || retryAt <= now + HOUR);
  if (localReadBudgetWait || ['running', 'waiting_for_queue', 'waiting_for_candidates', 'waiting_for_session', 'waiting_for_network'].includes(status?.status)
    && !status.code && !(Number(status.httpStatus) >= 300)) return 'dead_runtime';
  // A worker that died before its first read gate (e.g. ENOSPC on 2026-10-03)
  // sent no write, so it is an ordinary dead runtime, not an audit case.
  if (status?.status === 'starting' && status.workerStarted === false && !status.code
    && !status.writeCountUnknown && !status.writesObserved && !(Number(status.httpStatus) >= 300)) return 'dead_runtime';
  if (status?.status === 'cooldown' && Number.isFinite(now) && Number.isFinite(retryAt)) {
    const futureWithin = maximum => retryAt <= now + maximum;
    const verifiedGraphql = status.code === 'META_GRAPHQL_THROTTLED' && status.httpStatus === 200
      && status.cooldownReason === 'graphql_200_rate_limit' && graphqlDeadlineSources.has(status.deadlineSource)
      && (status.deadlineSource === 'server_hint' || Number.isSafeInteger(status.fallbackMilliseconds)
        && status.fallbackMilliseconds >= 0 && status.fallbackMilliseconds <= GRAPHQL_LEGACY_FALLBACK_MAX
        && futureWithin(GRAPHQL_LEGACY_FALLBACK_MAX));
    const verifiedHttp429 = status.httpStatus === 429 && restartableHttp429Code(status) && status.cooldownReason === 'http_429_rate_limit'
      && (status.deadlineSource === 'server_hint' || status.deadlineSource === 'local_fallback_15_minutes'
        && status.fallbackMilliseconds === HTTP_429_LOCAL_FALLBACK_MS && futureWithin(HTTP_429_LOCAL_FALLBACK_MS));
    if (verifiedGraphql || verifiedHttp429) return 'dead_runtime';
  }
  // Restarting this reader preserves the durable write hold. It does not
  // declare the integrity refusal resolved or authorize a historical retry.
  if (status?.status === 'waiting_for_reply_restriction' && status.replyRestriction?.automaticWritesBlocked === true
    && ['THREADS_REPLY_SERVER_INTEGRITY_BLOCKED', 'THREADS_REPLY_SERVER_FETCH_POLICY_BLOCKED'].includes(status.code)) return 'held_reader';
  return null;
}
const json = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
};
const directory = fileURLToPath(new URL('../', import.meta.url));
async function launch(spec) {
  const child = spawn(process.execPath, [path.join(directory, spec.script), ...spec.args],
    { cwd: path.resolve(directory, '../..'), windowsHide: true, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); return child.pid;
}

// Recover local faults and positively dead ordinary/held readers. No STOP or
// action journal is changed. Terminal refusal/auth/unknown-write faults need audit.
export async function recoverThreadsLocalWorker(spec, status, { paths = threadsRuntimePaths(), presence, dependencies = {}, onLaunched = () => {} } = {}) {
  const recoveryKind = threadsLocalRecoveryKind(status);
  if (!recoveryKind) return { handled: false };
  const deps = { lock: withSessionLock, readStatus: () => json(path.join(spec.root, 'worker-status.json')),
    presence, stopped: () => threadsStopRequested(spec.root, paths), launch,
    readAdditionalPids: async () => {
      const [lock, receipt] = await Promise.all([json(path.join(spec.root, 'worker.lock')), json(path.join(paths.root, 'runtime-launch.json'))]);
      return [lock.pid, receipt[spec.name]?.pid].filter(pid => Number.isSafeInteger(pid) && pid > 0);
    },
    verifyOwner: verifyThreadsRuntimeOwner,
    saveLaunch: async pid => {
      const file = path.join(paths.root, 'runtime-launch.json'), state = await json(file);
      state[spec.name] = { pid, launchedAt: new Date().toISOString(), script: spec.script };
      await mkdir(paths.root, { recursive: true });
      const temp = file + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, file);
    }, ...dependencies };
  let launchedPid = null;
  const probe = async current => {
    const pids = [...new Set([current.pid, ...await deps.readAdditionalPids()].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    const results = await Promise.all(pids.map(pid => deps.presence(spec, pid)));
    return results.includes(true) ? true : results.includes(null) ? null : false;
  };
  try {
    return await deps.lock(async () => {
      if (await deps.stopped()) return { handled: true, code: 'USER_STOPPED', restartRequested: false };
      let current = await deps.readStatus();
      if (threadsLocalRecoveryKind(current) !== recoveryKind) return { handled: false, code: 'WORKER_FAULT_CHANGED' };
      let present = await probe(current);
      if (present !== false) return { handled: true, code: present === true ? 'WORKER_ALREADY_RUNNING' : 'PROCESS_IDENTITY_PENDING', restartRequested: false };
      const owner = await deps.verifyOwner();
      if (owner?.authenticated !== true || owner.ownerVerified !== true || owner.httpStatus !== 200) return { handled: false, code: 'OWNER_READBACK_UNVERIFIED', restartRequested: false };
      if (await deps.stopped()) return { handled: true, code: 'USER_STOPPED', restartRequested: false };
      current = await deps.readStatus();
      if (threadsLocalRecoveryKind(current) !== recoveryKind) return { handled: false, code: 'WORKER_FAULT_CHANGED' };
      present = await probe(current);
      if (present !== false) return { handled: true, code: present === true ? 'WORKER_ALREADY_RUNNING' : 'PROCESS_IDENTITY_PENDING', restartRequested: false };
      if (await deps.stopped()) return { handled: true, code: 'USER_STOPPED', restartRequested: false };
      launchedPid = await deps.launch(spec); onLaunched(launchedPid);
      await deps.saveLaunch(launchedPid);
      return { handled: true, recoveryKind, restartRequested: true, launchedPid, ownerReadbackVerified: true, readinessVerified: false, socialWritesByRecovery: 0 };
    }, { lockPath: paths.controlLock, timeoutMs: 30_000 });
  } catch (error) {
    // A receipt failure after spawn must not fall through to another launcher.
    return { handled: launchedPid !== null, restartRequested: launchedPid !== null, ...(launchedPid ? { launchedPid } : {}),
      code: /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'LOCAL_RECOVERY_FAILED' };
  }
}
