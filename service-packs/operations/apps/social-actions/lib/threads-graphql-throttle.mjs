import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';
import { atomicBotJson } from './bot-json-store.mjs';

export const THREADS_GRAPHQL_THROTTLED = 'META_GRAPHQL_THROTTLED';
export const THREADS_GRAPHQL_BACKOFF = Object.freeze({ initialMilliseconds: 5 * 60_000,
  maximumMilliseconds: 15 * 60_000, stableRecoveryMilliseconds: 15 * 60_000 });
export const THREADS_HTTP_429_THROTTLED = 'META_HTTP_429_COOLDOWN';
export const THREADS_HTTP_429_PERSIST_FAILED = 'META_HTTP_429_COOLDOWN_PERSIST_FAILED';
export const THREADS_HTTP_429_BACKOFF = Object.freeze({ fallbackMilliseconds: 15 * 60_000, minimumMilliseconds: 60_000 });
// Old receipts contain a locally chosen two-hour wait. Read them without
// altering an active deadline; only newly observed refusals use the new cap.
const MAX_STORED_FALLBACK = 2 * 60 * 60_000;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAX_RETRY_AFTER_SECONDS = Math.floor(MAX_DATE_MILLISECONDS / 1000);
const HTTP_429_STATE_FILE = 'http429-cooldown.json';
const volatileHttp429Deadlines = new Map();
export const threadsThrottleRoot = () => process.env.NODE_TEST_CONTEXT
  ? path.join(os.tmpdir(), 'social-actions-test-throttle-' + process.pid)
  : path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'threads-watchdog');

export function isThreadsGraphqlThrottle(value) {
  const receipt = value?.receipt || value;
  return (value?.code ?? receipt?.code) === THREADS_GRAPHQL_THROTTLED
    && Number(receipt?.httpStatus ?? value?.httpStatus) === 200;
}

// This code was observed on three authenticated TARGET reads. Do not infer
// throttling from arbitrary errors or let it override an interaction challenge.
export function hasObservedThreadsGraphqlThrottle(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : payload?.error ? [payload.error] : [];
  if (/friction|challenge|checkpoint|captcha/i.test(JSON.stringify(errors))) return false;
  return errors.some(error => [error?.code, error?.error_code, error?.extensions?.code, error?.extensions?.error_code]
    .some(code => code === 1675004));
}

function validate(value) {
  if (value?.schemaVersion !== 1 || value.service !== 'threads' || value.owner !== 'lifehack__ailab'
    || value.code !== THREADS_GRAPHQL_THROTTLED || value.httpStatus !== 200 || value.providerErrorCode !== 1675004
    || !Number.isFinite(Date.parse(value.observedAt || '')) || !Number.isFinite(Date.parse(value.retryAt || ''))
    || !['server_hint', 'local_fallback', 'local_fallback_15_minutes', 'local_backoff'].includes(value.deadlineSource)
    || value.consecutiveThrottles != null && (!Number.isSafeInteger(value.consecutiveThrottles) || value.consecutiveThrottles < 0 || value.consecutiveThrottles > 100)
    || value.fallbackMilliseconds != null && (!Number.isSafeInteger(value.fallbackMilliseconds) || value.fallbackMilliseconds < 0 || value.fallbackMilliseconds > MAX_STORED_FALLBACK)) {
    throw Object.assign(new Error('THREADS_THROTTLE_STATE_INVALID'), { code: 'THREADS_THROTTLE_STATE_INVALID' });
  }
  return value;
}

async function readState(root) {
  let value;
  try { value = validate(JSON.parse(await readFile(path.join(root, 'graphql-cooldown.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return value;
}

async function readHttp429State(root) {
  let value;
  try { value = validateHttp429(JSON.parse(await readFile(path.join(root, HTTP_429_STATE_FILE), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return value;
}

function receipt(value) {
  return { httpStatus: 200, code: THREADS_GRAPHQL_THROTTLED, rateLimited: true,
    providerErrorCode: 1675004, cooldownReason: 'graphql_200_rate_limit', retryAt: Date.parse(value.retryAt),
    deadlineSource: value.deadlineSource, operation: safeOperation(value.operation),
    observedAt: value.observedAt, consecutiveThrottles: value.consecutiveThrottles ?? 1,
    fallbackMilliseconds: value.fallbackMilliseconds ?? (value.deadlineSource === 'local_fallback_15_minutes' ? 15 * 60_000
      : value.deadlineSource === 'local_fallback' ? THREADS_GRAPHQL_BACKOFF.initialMilliseconds : 0) };
}
const safeOperation = operation => /^[A-Za-z][A-Za-z0-9_]{1,120}$/.test(operation || '') ? operation : null;

function validateHttp429(value) {
  if (value?.schemaVersion !== 1 || value.service !== 'threads' || value.owner !== 'lifehack__ailab'
    || value.code !== THREADS_HTTP_429_THROTTLED || value.httpStatus !== 429
    || !Number.isFinite(Date.parse(value.observedAt || '')) || !Number.isFinite(Date.parse(value.retryAt || ''))
    || !['server_hint', 'local_fallback_15_minutes'].includes(value.deadlineSource)
    || value.operation !== null && !safeOperation(value.operation)
    || value.providerRetryAfterSeconds != null && (!Number.isSafeInteger(value.providerRetryAfterSeconds)
      || value.providerRetryAfterSeconds < 0 || value.providerRetryAfterSeconds > MAX_RETRY_AFTER_SECONDS)
    || value.rateLimitReset != null && (!Number.isSafeInteger(value.rateLimitReset) || value.rateLimitReset < 1 || value.rateLimitReset > 99_999_999_999_999)
    || value.fallbackMilliseconds != null && (!Number.isSafeInteger(value.fallbackMilliseconds)
      || value.fallbackMilliseconds < 0 || value.fallbackMilliseconds > THREADS_HTTP_429_BACKOFF.fallbackMilliseconds)) {
    throw Object.assign(new Error('THREADS_HTTP_429_STATE_INVALID'), { code: 'THREADS_HTTP_429_STATE_INVALID' });
  }
  return value;
}

function http429Receipt(value, now) {
  const retryAt = Date.parse(value.retryAt);
  const persistFailed = value.persistenceFailed === true;
  return { httpStatus: 429, code: persistFailed ? THREADS_HTTP_429_PERSIST_FAILED : THREADS_HTTP_429_THROTTLED,
    cooldownPersisted: !persistFailed, rateLimited: true,
    cooldownReason: 'http_429_rate_limit', retryAt, deadlineSource: value.deadlineSource,
    operation: safeOperation(value.operation), observedAt: value.observedAt,
    retryAfterSeconds: Math.max(0, Math.ceil((retryAt - now) / 1000)),
    ...(value.providerRetryAfterSeconds != null ? { providerRetryAfterSeconds: value.providerRetryAfterSeconds } : {}),
    ...(value.rateLimitReset != null ? { rateLimitReset: value.rateLimitReset } : {}),
    ...(value.fallbackMilliseconds != null ? { fallbackMilliseconds: value.fallbackMilliseconds } : {}),
  };
}

function retryAfterAt(value, now) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const numeric = Number(value);
  const maximumSeconds = Math.floor((MAX_DATE_MILLISECONDS - now) / 1000);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric <= maximumSeconds) return now + Math.ceil(numeric * 1000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now && parsed <= MAX_DATE_MILLISECONDS ? parsed : 0;
}

function rateLimitResetAt(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > 99_999_999_999_999) return 0;
  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

export async function recordThreadsHttp429Cooldown({ response, operation, now = Date.now(), root = threadsThrottleRoot(),
  persist = atomicBotJson } = {}) {
  if (response?.status !== 429 || !Number.isSafeInteger(now) || typeof root !== 'string' || !root || typeof persist !== 'function') {
    throw Object.assign(new Error('THREADS_HTTP_429_INPUT_INVALID'), { code: 'THREADS_HTTP_429_INPUT_INVALID' });
  }
  const retryHeader = response.headers?.get('retry-after');
  const retryAt = retryAfterAt(retryHeader, now);
  const rawReset = response.headers?.get('x-ratelimit-reset') ?? response.headers?.get('x-rate-limit-reset');
  const resetAt = rateLimitResetAt(rawReset);
  const hasServerHint = retryAt > now || resetAt > now;
  const serverDeadline = Math.max(retryAt, resetAt);
  const headerRetrySeconds = retryHeader == null ? null
    : Number.isFinite(Number(retryHeader)) && Number(retryHeader) >= 0
      && Number(retryHeader) <= Math.floor((MAX_DATE_MILLISECONDS - now) / 1000)
      ? Math.ceil(Number(retryHeader))
      : Number.isFinite(Date.parse(retryHeader)) && Date.parse(retryHeader) > now
        && Date.parse(retryHeader) <= MAX_DATE_MILLISECONDS
        ? Math.ceil((Date.parse(retryHeader) - now) / 1000) : null;
  const resetValue = rawReset == null ? null : Number(rawReset);
  const rateLimitReset = Number.isSafeInteger(resetValue) && resetValue > 0 && resetValue <= 99_999_999_999_999
    ? resetValue : null;
  const fallbackMilliseconds = hasServerHint ? 0 : THREADS_HTTP_429_BACKOFF.fallbackMilliseconds;
  let attempted = { schemaVersion: 1, service: 'threads', owner: 'lifehack__ailab', code: THREADS_HTTP_429_THROTTLED,
    httpStatus: 429, observedAt: new Date(now).toISOString(),
    retryAt: new Date(Math.max(now + THREADS_HTTP_429_BACKOFF.minimumMilliseconds,
      hasServerHint ? serverDeadline : now + THREADS_HTTP_429_BACKOFF.fallbackMilliseconds)).toISOString(),
    deadlineSource: hasServerHint ? 'server_hint' : 'local_fallback_15_minutes', operation: safeOperation(operation),
    ...(headerRetrySeconds == null ? {} : { providerRetryAfterSeconds: headerRetrySeconds }),
    ...(rateLimitReset == null ? {} : { rateLimitReset }), ...(fallbackMilliseconds ? { fallbackMilliseconds } : {}) };
  try {
    await mkdir(root, { recursive: true });
    const value = await withSessionLock(async () => {
      const previous = await readHttp429State(root);
      const previousRetryAt = previous ? Date.parse(previous.retryAt) : 0;
      const previousActive = previousRetryAt > now;
      const until = Math.max(now + THREADS_HTTP_429_BACKOFF.minimumMilliseconds,
        previousActive ? previousRetryAt : 0,
        hasServerHint ? serverDeadline : now + THREADS_HTTP_429_BACKOFF.fallbackMilliseconds);
      const deadlineSource = hasServerHint && serverDeadline >= (previousActive ? previousRetryAt : 0)
        ? 'server_hint' : previousActive ? previous.deadlineSource : 'local_fallback_15_minutes';
      const mergedFallback = deadlineSource === 'local_fallback_15_minutes'
        ? previousActive && previous.deadlineSource === 'local_fallback_15_minutes'
          ? previous.fallbackMilliseconds ?? THREADS_HTTP_429_BACKOFF.fallbackMilliseconds
          : THREADS_HTTP_429_BACKOFF.fallbackMilliseconds
        : 0;
      delete attempted.fallbackMilliseconds;
      attempted = { ...attempted, retryAt: new Date(until).toISOString(), deadlineSource,
        ...(mergedFallback ? { fallbackMilliseconds: mergedFallback } : {}) };
      await persist(path.join(root, HTTP_429_STATE_FILE), attempted);
      return attempted;
    }, { lockPath: path.join(root, 'http429-cooldown.lock'), timeoutMs: 10_000 });
    volatileHttp429Deadlines.set(root, value);
    return { ...http429Receipt(value, now), cooldownPersisted: true };
  } catch {
    // If the durable receipt cannot be written (or the shared lease is unavailable),
    // keep this process closed until the observed deadline. This volatile fallback
    // cannot promise a sibling process will observe the hold.
    volatileHttp429Deadlines.set(root, { ...attempted, persistenceFailed: true });
    throw Object.assign(new Error(THREADS_HTTP_429_PERSIST_FAILED), {
      ...http429Receipt(attempted, now), code: THREADS_HTTP_429_PERSIST_FAILED,
      cooldownPersisted: false, dispatchStarted: true,
    });
  }
}

async function saveState(root, value) {
  await atomicBotJson(path.join(root, 'graphql-cooldown.json'), value);
}

export async function readThreadsSharedCooldown({ root = threadsThrottleRoot(), now = Date.now() } = {}) {
  const [graphql, http429, volatile] = await Promise.all([
    readState(root), readHttp429State(root), Promise.resolve(volatileHttp429Deadlines.get(root) || null),
  ]);
  const candidates = [];
  if (graphql && Date.parse(graphql.retryAt) > now) candidates.push(receipt(graphql));
  if (http429 && Date.parse(http429.retryAt) > now) candidates.push(http429Receipt(http429, now));
  if (volatile) {
    if (Date.parse(volatile.retryAt) > now) candidates.push(http429Receipt(volatile, now));
    else volatileHttp429Deadlines.delete(root);
  }
  candidates.sort((a,b) => b.retryAt - a.retryAt);
  return candidates[0] || null;
}

export async function recordThreadsGraphqlCooldown({ response, operation, now = Date.now(), root = threadsThrottleRoot() }) {
  if (response?.status !== 200 || !Number.isFinite(now)) throw new Error('THREADS_THROTTLE_INPUT_INVALID');
  const retryHeader = response.headers?.get('retry-after');
  const retryNumber = retryHeader == null ? NaN : Number(retryHeader);
  const retryAt = Number.isFinite(retryNumber) && retryNumber >= 0 && retryNumber <= 86_400
    ? now + retryNumber * 1000 : retryHeader ? Date.parse(retryHeader) || 0 : 0;
  const resetHeader = response.headers?.get('x-ratelimit-reset') ?? response.headers?.get('x-rate-limit-reset');
  const resetNumber = resetHeader == null ? NaN : Number(resetHeader);
  const resetAt = Number.isSafeInteger(resetNumber) && resetNumber > 0 && resetNumber <= 99_999_999_999_999
    ? resetNumber > 10_000_000_000 ? resetNumber : resetNumber * 1000 : 0;
  const hasHint = retryAt > now || resetAt > now;
  await mkdir(root, { recursive: true });
  return withSessionLock(async () => {
    // Preserve expired history too: a retry that is rejected
    // again must not restart the same fixed-delay loop after a process reload.
    const previous = await readState(root);
    const active = previous && Date.parse(previous.retryAt) > now;
    const previousCount = previous?.consecutiveThrottles ?? (previous ? 1 : 0);
    const consecutiveThrottles = Math.min(100, active ? Math.max(1, previousCount) : previousCount + 1);
    const fallbackMilliseconds = Math.min(THREADS_GRAPHQL_BACKOFF.maximumMilliseconds,
      THREADS_GRAPHQL_BACKOFF.initialMilliseconds * 2 ** Math.min(3, consecutiveThrottles - 1));
    const until = Math.max(now + 60_000, retryAt, resetAt,
      active ? Date.parse(previous.retryAt) : hasHint ? 0 : now + fallbackMilliseconds);
    if (active && Date.parse(previous.retryAt) === until) return { ...receipt(previous), cooldownPersisted: true };
    const value = { schemaVersion: 1, service: 'threads', owner: 'lifehack__ailab', code: THREADS_GRAPHQL_THROTTLED,
      httpStatus: 200, providerErrorCode: 1675004, observedAt: new Date(now).toISOString(), retryAt: new Date(until).toISOString(),
      deadlineSource: hasHint ? 'server_hint' : consecutiveThrottles === 1 ? 'local_fallback' : 'local_backoff',
      operation: safeOperation(operation), consecutiveThrottles,
      fallbackMilliseconds: hasHint ? 0 : fallbackMilliseconds };
    await saveState(root, value);
    return { ...receipt(value), cooldownPersisted: true };
  }, { lockPath: path.join(root, 'graphql-cooldown.lock'), timeoutMs: 10_000 });
}

export async function recordThreadsGraphqlSuccess({ operation, requestStartedAt, now = Date.now(), root = threadsThrottleRoot() }) {
  const previous = await readState(root);
  if (!previous || (previous.consecutiveThrottles ?? 1) === 0 || safeOperation(operation) !== previous.operation
    || !Number.isFinite(requestStartedAt) || requestStartedAt < Date.parse(previous.retryAt)) return false;
  return withSessionLock(async () => {
    const current = await readState(root);
    if (!current || safeOperation(operation) !== current.operation || requestStartedAt < Date.parse(current.retryAt)) return false;
    // A late response sent before the hold, or an unrelated successful query,
    // cannot shorten it or erase evidence that the rejected read still fails.
    const firstSuccess = Date.parse(current.firstSuccessfulReadAt || '');
    const stableSince = Number.isFinite(firstSuccess) && firstSuccess >= Date.parse(current.retryAt) ? firstSuccess : now;
    const stable = now - stableSince >= THREADS_GRAPHQL_BACKOFF.stableRecoveryMilliseconds;
    // One successful page followed by another rejection is not recovery.
    await saveState(root, { ...current, consecutiveThrottles: stable ? 0 : current.consecutiveThrottles ?? 1,
      firstSuccessfulReadAt: new Date(stableSince).toISOString(), lastSuccessfulProbeAt: new Date(now).toISOString() });
    return stable;
  }, { lockPath: path.join(root, 'graphql-cooldown.lock'), timeoutMs: 10_000 });
}

export function applyThreadsCooldownStatus(status, cooldown) {
  status.status = cooldown.code === 'THREADS_READ_BUDGET_WAIT' ? 'waiting_for_read_budget' : 'cooldown'; status.httpStatus = cooldown.httpStatus;
  status.retryAt = new Date(cooldown.retryAt).toISOString();
  if (cooldown.code === 'THREADS_READ_BUDGET_WAIT') {
    status.code = 'THREADS_READ_BUDGET_WAIT'; status.cooldownReason = 'shared_read_budget';
    status.deadlineSource = 'local_budget';
    delete status.rateLimited; delete status.throttleOperation; delete status.consecutiveThrottles; delete status.fallbackMilliseconds;
  } else if (isThreadsGraphqlThrottle(cooldown)) {
    status.code = THREADS_GRAPHQL_THROTTLED; status.rateLimited = true;
    status.cooldownReason = 'graphql_200_rate_limit'; status.deadlineSource = cooldown.deadlineSource;
    status.throttleOperation = safeOperation(cooldown.operation);
    status.consecutiveThrottles = cooldown.consecutiveThrottles ?? 1;
    status.fallbackMilliseconds = cooldown.fallbackMilliseconds ?? null;
  } else if (cooldown.httpStatus === 429 || [THREADS_HTTP_429_THROTTLED, THREADS_HTTP_429_PERSIST_FAILED].includes(cooldown.code)) {
    status.code = cooldown.code || THREADS_HTTP_429_THROTTLED; status.rateLimited = true;
    status.cooldownReason = 'http_429_rate_limit'; status.deadlineSource = cooldown.deadlineSource;
    delete status.throttleOperation; delete status.consecutiveThrottles;
    if (cooldown.fallbackMilliseconds != null) status.fallbackMilliseconds = cooldown.fallbackMilliseconds;
    else delete status.fallbackMilliseconds;
  } else {
    if (status.code === THREADS_GRAPHQL_THROTTLED) delete status.code;
    delete status.rateLimited; delete status.cooldownReason; delete status.deadlineSource;
    delete status.throttleOperation; delete status.consecutiveThrottles; delete status.fallbackMilliseconds;
  }
}
