// Shared gate for X writes that count toward the account's tweet limit (posts, replies,
// quotes, reposts; likes and follows are not counted). Every X bot and writer goes
// through it, so one bot hitting a limit pauses the others too.
//
// Observed 2026-10-02: X answered CreateRetweet/CreateTweet with HTTP 200 and error
// 344 "You have reached your daily limit for sending Tweets and messages" at about
// 190 such writes in 24 hours, far below the documented 2,400/day. 226 (automation
// suspected) had come earlier. The budget below stays under that observed level.
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withSessionLock } from '../../../../tistory-api/lib/lock.mjs';
import { atomicBotJson } from '../../../../social-actions/lib/bot-json-store.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// 2026-10-02: 30/hour let the bots use the whole 150/day in 7 hours (then nothing for 17 hours, follow-backs
// included), and 226 still came at ~25/hour. 15/hour spreads the day; per-bot daily shares keep the
// follow-back bot (real followers' benefits) from being starved by reflection quotes and invitations.
// perDay 250 (owner 2026-10-03 "250건으로 상향"): 288-301 counted writes in 24 h drew no 344 after pacing began.
// perHour 20 (owner 2026-10-05 "시간당 20으로 올려봐"): a trial; 226 came at ~25/hour on 2026-10-02 and the cooldowns
// below still pause every bot on 226/344.
export const X_WRITE_BUDGET = Object.freeze({ perHour: 20, perDay: 250 });
export const X_WRITE_BOT_DAILY_SHARE = Object.freeze({ reflection: 25, invite: 30, quickfact: 30 });
// Owner 2026-10-02 ("맞팔만 하루한도 예외"): follow-back benefits are exempt from the daily total; the hourly
// pacing and the 344/226 cooldowns still apply, and the last 5 slots of every hour are kept for them.
export const X_WRITE_DAILY_EXEMPT_BOTS = Object.freeze(['followback']);
export const X_WRITE_PRIORITY_HOURLY_RESERVE = 5;
// Owner 2026-10-05 ("30분당 하나씩은 퀵체커 발행해라"): one quick-fact post is 2 writes (post + reply). The follow-back bot
// alone filled the hour (10 of 11 writes) and a composed quick-fact waited 50 min, so quick-fact may use the full hour
// and every other bot leaves its 2 slots free until quick-fact has used them.
export const X_WRITE_QUICKFACT_HOURLY_RESERVE = 2;
const BOT_BY_SCRIPT = Object.freeze({ 'x-followback-bot.mjs': 'followback', 'x-reflection-worker.mjs': 'reflection',
  'x-invite-worker.mjs': 'invite', 'x-quickfact-worker.mjs': 'quickfact' });
export const currentXWriteBot = () => BOT_BY_SCRIPT[path.basename(process.argv[1] || '')] || 'other';
const BOT_STATE_DIR = Object.freeze({ followback: 'x-followback-bot', reflection: 'x-reflection-bot', invite: 'x-invite-bot', quickfact: 'x-quickfact-bot' });
// Callers that pass no isStopped (publishThread) still stop on their bot's STOP file: a reflection worker waiting
// for its daily share ignored STOP for 40+ minutes on 2026-10-03.
export function defaultXWriteStopCheck(bot = currentXWriteBot()) {
  const dir = BOT_STATE_DIR[bot];
  if (!dir || process.env.NODE_TEST_CONTEXT) return async () => false;
  const file = path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', dir, 'STOP');
  return async () => { try { await readFile(file); return true; } catch { return false; } };
}
const eventAt = event => typeof event === 'number' ? event : event?.at;
const eventBot = event => typeof event === 'object' && typeof event?.bot === 'string' ? event.bot : 'unknown';
export const X_WRITE_COOLDOWN_MS = Object.freeze({ 344: HOUR, 185: HOUR, 226: 30 * MINUTE, 88: 15 * MINUTE });
// Callers block (a bot simply pauses) rather than get a new error code in their write paths.
export const X_WRITE_GATE_MAX_WAIT_MS = Infinity;

export function xWriteGateRoot() {
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `x-write-gate-test-${process.pid}`);
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'x-write-gate');
}

async function readGate(file, now) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { events: [], cooldown: null }; throw error; }
  const events = Array.isArray(value?.events) ? value.events.filter(event => { const at = eventAt(event);
    return Number.isSafeInteger(at) && at > now - DAY && at <= now + MINUTE; }).sort((a, b) => eventAt(a) - eventAt(b)) : [];
  const until = Date.parse(value?.cooldown?.until || '');
  return { events, cooldown: Number.isFinite(until) && until > now ? value.cooldown : null };
}

function gated(root, task) {
  return withSessionLock(task, { lockPath: path.join(root, 'gate.lock'), timeoutMs: 10_000 });
}

/** When the next counted write may go out; `now` when it may go out immediately. */
export function xWriteRetryAt({ events: rows, cooldown }, now, limits = X_WRITE_BUDGET, { bot = null, shares = X_WRITE_BOT_DAILY_SHARE } = {}) {
  let retryAt = now;
  if (cooldown) retryAt = Math.max(retryAt, Date.parse(cooldown.until));
  const events = rows.map(eventAt);
  const exempt = bot !== null && X_WRITE_DAILY_EXEMPT_BOTS.includes(bot);
  const hour = events.filter(at => at > now - HOUR);
  let perHour = exempt || bot === null || bot === 'quickfact' || limits.perHour <= 2 * X_WRITE_PRIORITY_HOURLY_RESERVE ? limits.perHour
    : limits.perHour - X_WRITE_PRIORITY_HOURLY_RESERVE;
  if (bot !== null && bot !== 'quickfact' && limits.perHour > 2 * X_WRITE_PRIORITY_HOURLY_RESERVE) {
    const quickfactHour = rows.filter(event => eventBot(event) === 'quickfact' && eventAt(event) > now - HOUR).length;
    perHour -= Math.max(0, X_WRITE_QUICKFACT_HOURLY_RESERVE - quickfactHour);
  }
  if (hour.length >= perHour) retryAt = Math.max(retryAt, hour[hour.length - perHour] + HOUR);
  if (!exempt && events.length >= limits.perDay) retryAt = Math.max(retryAt, events[events.length - limits.perDay] + DAY);
  const share = bot && shares[bot];
  if (Number.isSafeInteger(share)) {
    const own = rows.filter(event => eventBot(event) === bot).map(eventAt);
    if (own.length >= share) retryAt = Math.max(retryAt, own[own.length - share] + DAY);
  }
  return retryAt;
}

/**
 * Reserve one counted write. Waits (stop-aware) while a cooldown or the budget blocks it,
 * up to X_WRITE_GATE_MAX_WAIT_MS; beyond that it throws X_WRITE_GATE_WAIT before any send.
 */
export async function reserveXWrite({ operation = 'XWrite', root = xWriteGateRoot(), now = Date.now, sleep = delay,
  isStopped: givenStop, limits = X_WRITE_BUDGET, maxWaitMs = X_WRITE_GATE_MAX_WAIT_MS, onWait, onReady,
  bot = currentXWriteBot(), shares = X_WRITE_BOT_DAILY_SHARE } = {}) {
  const isStopped = typeof givenStop === 'function' ? givenStop : defaultXWriteStopCheck(bot);
  if ((onWait !== undefined && typeof onWait !== 'function') || (onReady !== undefined && typeof onReady !== 'function')) {
    throw new TypeError('X_WRITE_GATE_CALLBACK_INVALID');
  }
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'gate.json');
  const started = now();
  for (;;) {
    const decision = await gated(root, async () => {
      const at = now(), gate = await readGate(file, at);
      const retryAt = xWriteRetryAt(gate, at, limits, { bot, shares });
      if (retryAt > at) return { retryAt, cooldown: gate.cooldown };
      gate.events.push({ at, bot, operation: String(operation).slice(0, 40) });
      await atomicBotJson(file, { schemaVersion: 2, updatedAt: new Date(at).toISOString(), cooldown: gate.cooldown, events: gate.events });
      return { reserved: true, at };
    });
    if (decision.reserved) {
      const checkedAt = new Date(now()).toISOString();
      await onReady?.({ operation, source: 'local_x_write_gate', checkedAt, waitedMs: now() - started });
      // A caller that reserved but sent nothing (e.g. the repost was already present) returns the slot.
      const release = () => gated(root, async () => {
        const gate = await readGate(file, now());
        const index = gate.events.findIndex(event => eventAt(event) === decision.at && eventBot(event) === bot);
        if (index < 0) return false;
        gate.events.splice(index, 1);
        await atomicBotJson(file, { schemaVersion: 2, updatedAt: new Date(now()).toISOString(), cooldown: gate.cooldown, events: gate.events });
        return true;
      });
      return { reserved: true, operation, bot, at: decision.at, waitedMs: now() - started, release };
    }
    if (decision.retryAt - started > maxWaitMs) {
      throw Object.assign(new Error('X_WRITE_GATE_WAIT'), { code: 'X_WRITE_GATE_WAIT', retryAt: decision.retryAt,
        receipt: { operation, writeSent: false, dispatchStarted: false, retryAt: new Date(decision.retryAt).toISOString(),
          reason: decision.cooldown ? `cooldown_${decision.cooldown.code}` : 'write_budget' } });
    }
    while (now() < decision.retryAt) {
      if (await isStopped()) throw Object.assign(new Error('X_WRITE_GATE_STOPPED'), { code: 'X_WRITE_GATE_STOPPED', receipt: { operation, writeSent: false } });
      await onWait?.({ operation, source: 'local_x_write_gate', reason: decision.cooldown ? `cooldown_${decision.cooldown.code}` : 'write_budget',
        retryAt: new Date(decision.retryAt).toISOString(), checkedAt: new Date(now()).toISOString(), writeSent: false });
      await sleep(Math.min(15_000, decision.retryAt - now()));
    }
  }
}

/** Record an explicit X refusal so every bot pauses counted writes. Returns the cooldown end or null. */
export async function noteXWriteRejection(codes, { root = xWriteGateRoot(), now = Date.now() } = {}) {
  const span = Math.max(0, ...(Array.isArray(codes) ? codes : []).map(code => X_WRITE_COOLDOWN_MS[code] || 0));
  if (!span) return null;
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'gate.json');
  return gated(root, async () => {
    const gate = await readGate(file, now);
    const until = Math.max(now + span, Date.parse(gate.cooldown?.until || '') || 0);
    const code = codes.find(value => X_WRITE_COOLDOWN_MS[value] === span);
    const cooldown = { until: new Date(until).toISOString(), code, at: new Date(now).toISOString() };
    await atomicBotJson(file, { schemaVersion: 1, updatedAt: new Date(now).toISOString(), cooldown, events: gate.events });
    return cooldown.until;
  });
}

export async function readXWriteGate({ root = xWriteGateRoot(), now = Date.now() } = {}) {
  const gate = await readGate(path.join(root, 'gate.json'), now);
  const byBot = {};
  for (const event of gate.events) byBot[eventBot(event)] = (byBot[eventBot(event)] || 0) + 1;
  return { cooldown: gate.cooldown, lastHour: gate.events.filter(event => eventAt(event) > now - HOUR).length, lastDay: gate.events.length,
    byBot, retryAt: new Date(xWriteRetryAt(gate, now)).toISOString() };
}
