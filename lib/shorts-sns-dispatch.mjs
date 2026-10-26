import { parseScheduleTime } from './sns-schedule.mjs';

const MIN_LEAD_MS = 10 * 60_000;
const MAX_HORIZON_MS = 60 * 86_400_000;
const SLOT_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function checkedSlotTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64 || value.trim() !== value) fail('SHORTS_SLOT_AT_INVALID');
  const match = SLOT_ISO.exec(value);
  if (!match) fail('SHORTS_SLOT_AT_INVALID');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00', fractionText = '0'] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59) fail('SHORTS_SLOT_AT_INVALID');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('SHORTS_SLOT_AT_INVALID');
  const fraction = Number((fractionText + '00').slice(0, 3));
  return { milliseconds, components: { year, month, day, hour, minute, second, fraction } };
}

/**
 * Classify the persisted per-short slot before any channel work, then re-run this
 * immediately before each social dispatch because an earlier channel can be slow.
 */
export function planShortSlot(slotAt, now = Date.now()) {
  if (!Number.isFinite(now)) fail('SHORTS_CLOCK_INVALID');
  if (slotAt === null || slotAt === undefined) {
    return { mode: 'immediate', scheduledFor: null, deferred: false };
  }
  const { milliseconds } = checkedSlotTimestamp(slotAt);
  if (milliseconds <= now) return { mode: 'immediate', scheduledFor: null, deferred: false, dueSlotAt: slotAt };

  // Both composers accept minute precision and sns-web-post rounds down to the
  // minute. A future instant that rounds to the current/past minute still needs
  // to wait; it must never fall through to an early immediate publication.
  const rounded = Math.floor(milliseconds / 60_000) * 60_000;
  const scheduledFor = new Date(rounded).toISOString();
  const remaining = rounded - now;
  if (remaining < MIN_LEAD_MS) {
    return { mode: 'deferred', scheduledFor, deferred: true, reason: 'minimum_schedule_lead_time' };
  }
  if (remaining > MAX_HORIZON_MS) fail('SHORTS_SLOT_TOO_FAR');
  try { parseScheduleTime(String(rounded), now); }
  catch { fail('SHORTS_SLOT_INVALID_FOR_COMPOSER'); }
  return { mode: 'schedule', scheduledFor, deferred: false };
}

export function hasUnconfirmedAttempt(record) {
  if (record === null || record === undefined || record.ok === true) return false;
  // A locally deferred slot was never sent, so the next run may dispatch it
  // once its time is due. An attempted or legacy failed result needs a human
  // reconciliation before resending the non-idempotent post/schedule action.
  if (record.status === 'deferred' || record.status === 'dry_run' || record.status === 'not_submitted') return false;
  return true;
}

export function snsAttemptRecord(attemptedAt, plan) {
  return {
    attemptedAt,
    status: 'attempted',
    ok: false,
    mode: plan.mode === 'schedule' ? 'schedule' : 'post',
    ...(plan.mode === 'schedule' ? { requestedSchedule: plan.scheduledFor } : {}),
  };
}

function sameMinuteTimestamp(value, expected) {
  if (typeof value !== 'string' || !expected) return false;
  const actual = Date.parse(value);
  const wanted = Date.parse(expected);
  if (!Number.isFinite(actual) || !Number.isFinite(wanted)) return false;
  return Math.floor(actual / 60_000) === Math.floor(wanted / 60_000);
}

function ownPostUrl(channel, value, account) {
  if (typeof value !== 'string' || typeof account !== 'string') return false;
  const owner = account.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_.]{1,30}$/.test(owner)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const parts = url.pathname.split('/').filter(Boolean);
  if (channel === 'x') return ['x.com', 'www.x.com'].includes(url.hostname) && parts.length === 3
    && parts[0].toLowerCase() === owner && parts[1] === 'status' && /^\d+$/.test(parts[2]);
  return channel === 'threads' && ['threads.com', 'www.threads.com'].includes(url.hostname) && parts.length === 3
    && parts[0].toLowerCase() === '@' + owner && parts[1] === 'post' && /^[\w-]+$/.test(parts[2]);
}

export function snsOutcomeRecord(runResult, { channel, plan, attemptedAt }) {
  if (runResult?.dry) {
    return {
      status: 'dry_run', ok: false, dry: true,
      mode: plan.mode === 'schedule' ? 'schedule' : 'post',
      ...(plan.mode === 'schedule' ? { requestedSchedule: plan.scheduledFor } : {}),
    };
  }
  const last = runResult?.last;
  const contradictory = last?.needsReconciliation === true || last?.outcomeUnknown === true || Boolean(last?.error)
    || (Number.isInteger(runResult?.status) && runResult.status !== 0);
  if (last?.submissionAttempted === false && last?.outcomeUnknown === false && last?.needsReconciliation === false
    && last?.posted !== true && last?.scheduled !== true) {
    return { status: 'not_submitted', ok: false, submissionAttempted: false,
      mode: plan.mode === 'schedule' ? 'schedule' : 'post',
      ...(plan.mode === 'schedule' ? { requestedSchedule: plan.scheduledFor } : {}),
      error: typeof last.error === 'string' ? last.error.slice(0, 500) : 'PRE_SUBMIT_REJECTED' };
  }
  if (!contradictory && plan.mode === 'schedule' && last?.scheduled === true
    && sameMinuteTimestamp(last.scheduledFor, plan.scheduledFor)) {
    return {
      status: 'scheduled', ok: true, scheduled: true, attemptedAt,
      scheduledFor: new Date(Date.parse(last.scheduledFor)).toISOString(),
      line: typeof last.line === 'string' ? last.line : null,
    };
  }
  if (!contradictory && plan.mode === 'immediate' && channel === 'threads' && last?.posted === true
    && ownPostUrl(channel, last.url, last.account)) {
    return { status: 'posted', ok: true, attemptedAt, url: last.url, account: last.account };
  }
  if (!contradictory && plan.mode === 'immediate' && channel === 'x' && last?.posted === true
    && ownPostUrl(channel, last.url, last.account)) {
    return { status: 'posted', ok: true, attemptedAt, url: last.url, account: last.account };
  }
  const error = last?.error ?? (runResult?.status === 0 ? 'POST_ACK_UNCONFIRMED'
    : Number.isInteger(runResult?.status) ? `CHILD_EXIT_${runResult.status}` : 'POST_OUTCOME_UNKNOWN');
  return {
    attemptedAt,
    status: 'needs_reconciliation',
    ok: false,
    mode: plan.mode === 'schedule' ? 'schedule' : 'post',
    ...(plan.mode === 'schedule' ? { requestedSchedule: plan.scheduledFor } : {}),
    error: String(error).slice(0, 500),
  };
}
