// Find the Threads read budget that Meta tolerates (owner 2026-10-06 "조금씩 늘려서 조회한도 안걸릴 수준 찾아라").
// Run hourly (Windows task Codex-Threads-ReadBudget-Tune). Each run:
//   - a new Meta throttle (graphql-cooldown.json, code 1675004) since the last run: the current limits become the
//     ceiling and the limits drop to 80% of it (never below the 30/300 defaults);
//   - otherwise, when the hourly budget was nearly used up (>= 90%) in the last hour and no throttle was seen for 2 h,
//     raise by one step (+5/min, +50/h), staying under 90% of a known ceiling and under 120/1200;
//   - otherwise keep the limits.
// Every decision is appended to the history in read-budget-limits.json, which the read budget reads on each reservation.
//   node apps/social-actions/threads-read-budget-tune.mjs [--dry-run]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicBotJson } from './lib/bot-json-store.mjs';
import { THREADS_READ_BUDGET, THREADS_READ_LIMITS_FILE, threadsReadBudgetRoot } from './lib/threads-read-budget.mjs';
import { THREADS_GRAPHQL_THROTTLED, THREADS_HTTP_429_THROTTLED } from './lib/threads-graphql-throttle.mjs';

export const TUNE = Object.freeze({ stepPerMinute: 5, stepPerHour: 50, maxPerMinute: 120, maxPerHour: 1200,
  saturation: 0.9, quietMilliseconds: 2 * 3600_000, backoff: 0.8, ceilingMargin: 0.9 });
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAX_RETRY_AFTER_SECONDS = Math.floor(MAX_DATE_MILLISECONDS / 1000);
const MAX_HTTP_429_FALLBACK = 15 * 60_000;
const MAX_GRAPHQL_FALLBACK = 2 * 60 * 60_000;
const validDate = value => Number.isFinite(Date.parse(value || ''));
const validOperation = value => /^[A-Za-z][A-Za-z0-9_]{1,120}$/.test(value || '');

// Keep this reader aligned with the maintained state contracts in
// lib/threads-graphql-throttle.mjs. The tuner needs observedAt even after the
// cooldown expires, so it validates the durable receipts instead of reading
// arbitrary timestamps or asking the active-cooldown API.
function graphqlThrottleObservedAt(value) {
  if (value?.schemaVersion !== 1 || value.service !== 'threads' || value.owner !== 'lifehack__ailab'
    || value.code !== THREADS_GRAPHQL_THROTTLED || value.httpStatus !== 200 || value.providerErrorCode !== 1675004
    || !validDate(value.observedAt) || !validDate(value.retryAt)
    || !['server_hint', 'local_fallback', 'local_fallback_15_minutes', 'local_backoff'].includes(value.deadlineSource)
    || value.consecutiveThrottles != null && (!Number.isSafeInteger(value.consecutiveThrottles)
      || value.consecutiveThrottles < 0 || value.consecutiveThrottles > 100)
    || value.fallbackMilliseconds != null && (!Number.isSafeInteger(value.fallbackMilliseconds)
      || value.fallbackMilliseconds < 0 || value.fallbackMilliseconds > MAX_GRAPHQL_FALLBACK)) return null;
  return value.observedAt;
}

function http429ThrottleObservedAt(value) {
  if (value?.schemaVersion !== 1 || value.service !== 'threads' || value.owner !== 'lifehack__ailab'
    || value.code !== THREADS_HTTP_429_THROTTLED || value.httpStatus !== 429
    || !validDate(value.observedAt) || !validDate(value.retryAt)
    || !['server_hint', 'local_fallback_15_minutes'].includes(value.deadlineSource)
    || value.operation !== null && !validOperation(value.operation)
    || value.providerRetryAfterSeconds != null && (!Number.isSafeInteger(value.providerRetryAfterSeconds)
      || value.providerRetryAfterSeconds < 0 || value.providerRetryAfterSeconds > MAX_RETRY_AFTER_SECONDS)
    || value.rateLimitReset != null && (!Number.isSafeInteger(value.rateLimitReset)
      || value.rateLimitReset < 1 || value.rateLimitReset > 99_999_999_999_999)
    || value.fallbackMilliseconds != null && (!Number.isSafeInteger(value.fallbackMilliseconds)
      || value.fallbackMilliseconds < 0 || value.fallbackMilliseconds > MAX_HTTP_429_FALLBACK)) return null;
  return value.observedAt;
}

export function tuneDecision({ current, ceiling = null, lastThrottleSeenAt = null, throttleObservedAt = null, hourReads = 0, now = Date.now() }) {
  const base = { perMinute: current.perMinute, perHour: current.perHour };
  const throttleAt = Date.parse(throttleObservedAt ?? '');
  if (Number.isFinite(throttleAt) && throttleAt > (Date.parse(lastThrottleSeenAt ?? '') || 0)) {
    return { action: 'back_off', ceiling: { ...base, observedAt: throttleObservedAt },
      perMinute: Math.max(THREADS_READ_BUDGET.perMinute, Math.floor(base.perMinute * TUNE.backoff)),
      perHour: Math.max(THREADS_READ_BUDGET.perHour, Math.floor(base.perHour * TUNE.backoff)), lastThrottleSeenAt: throttleObservedAt };
  }
  const quiet = !Number.isFinite(throttleAt) || now - throttleAt >= TUNE.quietMilliseconds;
  const saturated = hourReads >= Math.floor(base.perHour * TUNE.saturation);
  const next = { perMinute: Math.min(TUNE.maxPerMinute, base.perMinute + TUNE.stepPerMinute), perHour: Math.min(TUNE.maxPerHour, base.perHour + TUNE.stepPerHour) };
  const underCeiling = !ceiling || next.perHour <= Math.floor(ceiling.perHour * TUNE.ceilingMargin) && next.perMinute <= Math.floor(ceiling.perMinute * TUNE.ceilingMargin);
  const grows = next.perHour > base.perHour || next.perMinute > base.perMinute;
  if (quiet && saturated && underCeiling && grows) return { action: 'raise', ...next, ceiling, lastThrottleSeenAt };
  return { action: 'hold', ...base, ceiling, lastThrottleSeenAt, reason: !quiet ? 'recent_throttle' : !saturated ? 'not_saturated' : !underCeiling ? 'near_ceiling' : 'at_max' };
}

export async function tuneThreadsReadBudget({ root = threadsReadBudgetRoot(), now = Date.now(), dryRun = false } = {}) {
  const file = path.join(root, THREADS_READ_LIMITS_FILE);
  const state = readJson(file) ?? {};
  const current = Number.isSafeInteger(state.perHour) && Number.isSafeInteger(state.perMinute) ? state : THREADS_READ_BUDGET;
  const events = readJson(path.join(root, 'read-budget.json'))?.events ?? [];
  const hourReads = events.filter(t => Number.isSafeInteger(t) && t > now - 3600_000).length;
  const throttleTimes = [graphqlThrottleObservedAt(readJson(path.join(root, 'graphql-cooldown.json'))),
    http429ThrottleObservedAt(readJson(path.join(root, 'http429-cooldown.json')))]
    .filter(Boolean).map(Date.parse);
  const throttleObservedAt = throttleTimes.length ? new Date(Math.max(...throttleTimes)).toISOString() : null;
  // First run: a throttle recorded before tuning existed (the last one, 2026-10-01, predates the 2026-10-03 budget) is
  // the baseline, not a new refusal at the current limits.
  const lastThrottleSeenAt = state.schemaVersion === 1 ? state.lastThrottleSeenAt ?? null : throttleObservedAt;
  const d = tuneDecision({ current, ceiling: state.ceiling ?? null, lastThrottleSeenAt, throttleObservedAt, hourReads, now });
  const entry = { at: new Date(now).toISOString(), action: d.action, from: { perMinute: current.perMinute, perHour: current.perHour },
    to: { perMinute: d.perMinute, perHour: d.perHour }, hourReads, ...(d.reason ? { reason: d.reason } : {}) };
  const next = { schemaVersion: 1, perMinute: d.perMinute, perHour: d.perHour, ceiling: d.ceiling ?? null,
    lastThrottleSeenAt: d.lastThrottleSeenAt ?? null, updatedAt: entry.at, history: [...(state.history ?? []), entry].slice(-200) };
  if (!dryRun) await atomicBotJson(file, next);
  return entry;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await tuneThreadsReadBudget({ dryRun: process.argv.includes('--dry-run') })));
}
