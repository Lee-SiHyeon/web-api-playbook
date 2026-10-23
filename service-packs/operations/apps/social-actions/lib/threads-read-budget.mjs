import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';
import { atomicBotJson } from './bot-json-store.mjs';
import { randomUUID } from 'node:crypto';

export const THREADS_READ_BUDGET = Object.freeze({ perMinute: 30, perHour: 300 });
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function threadsReadBudgetRoot() {
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `social-actions-test-read-budget-${process.pid}`);
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'threads-watchdog');
}

function safeOperation(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,120}$/.test(value) ? value : 'ThreadsRead';
}

// Owner 2026-10-06 "조금씩 늘려서 조회한도 안걸릴 수준 찾아라": threads-read-budget-tune.mjs raises these limits step by
// step while Meta does not throttle and writes them to <root>/read-budget-limits.json; a missing or invalid file keeps
// the defaults above.
export const THREADS_READ_LIMITS_FILE = 'read-budget-limits.json';
export function tunedThreadsReadLimits(root = threadsReadBudgetRoot()) {
  try {
    const value = JSON.parse(readFileSync(path.join(root, THREADS_READ_LIMITS_FILE), 'utf8'));
    const limits = { perMinute: value?.perMinute, perHour: value?.perHour };
    return Number.isSafeInteger(limits.perMinute) && Number.isSafeInteger(limits.perHour)
      && limits.perMinute >= 1 && limits.perMinute <= 300 && limits.perHour >= limits.perMinute && limits.perHour <= 3000 ? limits : null;
  } catch { return null; }
}

function validateLimits(limits, root) {
  const value = limits || (root ? tunedThreadsReadLimits(root) : null) || THREADS_READ_BUDGET;
  if (!Number.isSafeInteger(value.perMinute) || value.perMinute < 1 || value.perMinute > 10_000
    || !Number.isSafeInteger(value.perHour) || value.perHour < value.perMinute || value.perHour > 100_000) {
    throw Object.assign(new Error('THREADS_READ_BUDGET_LIMITS_INVALID'), { code: 'THREADS_READ_BUDGET_LIMITS_INVALID' });
  }
  return value;
}

async function readEvents(file, now) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (value?.schemaVersion !== 1 || value.service !== 'threads' || !Array.isArray(value.events)
    || value.events.length > 100_000 || value.events.some((item, index) => !Number.isSafeInteger(item)
      || item > now + MINUTE || index > 0 && item < value.events[index - 1])) {
    throw Object.assign(new Error('THREADS_READ_BUDGET_STATE_INVALID'), { code: 'THREADS_READ_BUDGET_STATE_INVALID' });
  }
  // Keep bounded future entries when the system clock moves backwards.
  return value.events.filter(item => item > now - HOUR);
}

function waitError(retryAt, limits, operation, now) {
  const error = Object.assign(new Error('THREADS_READ_BUDGET_WAIT'), {
    code: 'THREADS_READ_BUDGET_WAIT', retryAt, dispatchStarted: false, writeSent: false,
    receipt: { operation: safeOperation(operation), localBudget: true, readBudgetRetryAt: retryAt,
      retryAfterSeconds: Math.max(0, Math.ceil((retryAt - now) / 1000)),
      perMinuteLimit: limits.perMinute, perHourLimit: limits.perHour },
  });
  return error;
}

// A per-minute wait is short: wait it out in place so a multi-page scan (a post with many replies needs more than
// 30 reads) can finish. Throwing there made the caller restart the scan from page one every minute, forever
// (observed 2026-10-02: one post read ~100 times in 20 minutes, 94 budget waits). Hour-window waits still throw.
export const THREADS_READ_INLINE_WAIT_MS = 75_000;

export async function reserveThreadsRead({ operation, root = threadsReadBudgetRoot(), now, limits,
  maxInlineWaitMs = process.env.NODE_TEST_CONTEXT ? 0 : THREADS_READ_INLINE_WAIT_MS, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (;;) {
    try { return await reserveThreadsReadOnce({ operation, root, now: now ?? Date.now(), limits }); }
    catch (error) {
      const wait = error?.code === 'THREADS_READ_BUDGET_WAIT' ? error.retryAt - (now ?? Date.now()) : Infinity;
      if (now !== undefined || !(wait <= maxInlineWaitMs)) throw error;
      await sleep(Math.max(250, wait + 250));
    }
  }
}

async function reserveThreadsReadOnce({ operation, root, now, limits }) {
  const caps = validateLimits(limits, root);
  if (!Number.isSafeInteger(now) || typeof root !== 'string' || !root) {
    throw Object.assign(new Error('THREADS_READ_BUDGET_INPUT_INVALID'), { code: 'THREADS_READ_BUDGET_INPUT_INVALID' });
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'read-budget.json');
  return withSessionLock(async () => {
    const events = await readEvents(file, now);
    const pending=await pendingReadCredits(root,now);
    const minuteEvents = occupiedEvents(events,pending,now,MINUTE);
    const hourEvents = occupiedEvents(events,pending,now,HOUR);
    let retryAt = now;
    if (minuteEvents.length >= caps.perMinute) retryAt = Math.max(retryAt, minuteEvents[minuteEvents.length - caps.perMinute] + MINUTE);
    if (hourEvents.length >= caps.perHour) retryAt = Math.max(retryAt, hourEvents[hourEvents.length - caps.perHour] + HOUR);
    if (retryAt > now) throw waitError(retryAt, caps, operation, now);
    events.push(Math.max(now,events.at(-1)||now));
    await atomicBotJson(file, { schemaVersion: 1, service: 'threads', updatedAt: new Date(now).toISOString(), events });
    return { reserved: true, operation: safeOperation(operation), retryAt: null, perMinuteLimit: caps.perMinute, perHourLimit: caps.perHour };
  }, { lockPath: path.join(root, 'read-budget.lock'), timeoutMs: 10_000 });
}

const readbackOperations=['ThreadsProfileDocumentRead','BarcelonaPostPageTargetQuery'];
// 120s write + 90s document + up to nine 60s static-source batches +
// 90s target read, with credential/file overhead within this buffer.
export const THREADS_READ_RESERVATION_TTL_MS=20*MINUTE;
const validScope=({ownerId,handle,postId}={})=>typeof ownerId==='string' && /^\d{1,30}$/.test(ownerId)
  && typeof handle==='string' && /^[a-z0-9_.]{1,30}$/.test(handle)
  && typeof postId==='string' && /^\d{10,25}$/.test(postId);
const reservationError=code=>Object.assign(new Error(code),{code,dispatchStarted:false,writeSent:false});

function validReservation(record,now) {
  return record?.schemaVersion===1 && record.service==='threads' && /^[0-9a-f-]{36}$/.test(record.id||'')
    && validScope(record) && Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.chargedAt)
    && Number.isSafeInteger(record.expiresAt) && record.chargedAt>=record.createdAt && record.createdAt<=now+MINUTE
    && record.expiresAt===record.createdAt+THREADS_READ_RESERVATION_TTL_MS
    && record.operations && Object.keys(record.operations).length===2
    && readbackOperations.every(name=>Object.hasOwn(record.operations,name)
      && [record.operations[name]?.consumingAt,record.operations[name]?.consumedAt].every(t=>t===null
        || Number.isSafeInteger(t)&&t>=record.createdAt-MINUTE&&t<record.expiresAt&&t<=now+MINUTE)
      && (record.operations[name].consumedAt===null||record.operations[name].consumingAt!==null));
}

async function pendingReadCredits(root,now) {
  const directory=path.join(root,'read-reservations');
  let files;
  try{files=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const pending=[];
  for(const name of files.filter(name=>/^[0-9a-f-]{36}\.json$/.test(name))) {
    const file=path.join(directory,name),record=JSON.parse(await readFile(file,'utf8'));
    if(!validReservation(record,now)||name!==record.id+'.json')throw reservationError('THREADS_READ_RESERVATION_STATE_INVALID');
    // Local capacity bookkeeping only; action journals remain untouched.
    if(record.expiresAt<=now-HOUR){await unlink(file);continue;}
    if(record.expiresAt<=now)continue;
    for(const operation of Object.values(record.operations))if(operation.consumedAt===null)
      pending.push({chargedAt:record.chargedAt,expiresAt:record.expiresAt});
  }
  return pending;
}

function occupiedEvents(events,pending,now,window) {
  const windowStart=now-window;
  const occupied=events.filter(t=>t>windowStart),chargedCounts=new Map();
  for(const t of occupied)chargedCounts.set(t,(chargedCounts.get(t)||0)+1);
  for(const credit of pending) {
    const covered=chargedCounts.get(credit.chargedAt)||0;
    if(covered)chargedCounts.set(credit.chargedAt,covered-1);
    else occupied.push(credit.expiresAt-window);
  }
  return occupied.sort((a,b)=>a-b);
}

/** Charge the entire readback before a mutation. Never refund after a crash. */
export async function reserveThreadsReactionReadback(options={}) {
  const {now,maxInlineWaitMs=process.env.NODE_TEST_CONTEXT?0:THREADS_READ_INLINE_WAIT_MS,
    sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}=options;
  for(;;) {
    try{return await reserveThreadsReactionReadbackOnce({...options,now:now??Date.now()});}
    catch(error) {
      const wait=error?.code==='THREADS_READ_BUDGET_WAIT'?error.retryAt-(now??Date.now()):Infinity;
      if(now!==undefined || !(wait<=maxInlineWaitMs))throw error;
      await sleep(Math.max(250,wait+250));
    }
  }
}

async function reserveThreadsReactionReadbackOnce({ownerId,handle,postId,root=threadsReadBudgetRoot(),now,limits,persist=atomicBotJson}={}) {
  handle=typeof handle==='string'?handle.toLowerCase():handle;
  const scope={ownerId,handle,postId},caps=validateLimits(limits,root);
  if(!validScope(scope) || !Number.isSafeInteger(now) || typeof root!=='string' || !root || caps.perMinute<2 || typeof persist!=='function')
    throw reservationError('THREADS_READ_RESERVATION_INPUT_INVALID');
  await mkdir(root,{recursive:true,mode:0o700});
  return withSessionLock(async()=>{
    const file=path.join(root,'read-budget.json'),events=await readEvents(file,now);
    const pending=await pendingReadCredits(root,now);
    const minute=occupiedEvents(events,pending,now,MINUTE),hour=occupiedEvents(events,pending,now,HOUR);
    let retryAt=now;
    if(minute.length+2>caps.perMinute) retryAt=Math.max(retryAt,minute[minute.length+2-caps.perMinute-1]+MINUTE);
    if(hour.length+2>caps.perHour) retryAt=Math.max(retryAt,hour[hour.length+2-caps.perHour-1]+HOUR);
    if(retryAt>now) throw waitError(retryAt,caps,'ThreadsReactionReadbackReservation',now);
    const chargedAt=Math.max(now,events.at(-1)||now);
    events.push(chargedAt,chargedAt);
    // The separate ticket file survives old readers rewriting their events-only
    // ledger. A failure after charging cannot authorize a mutation or free quota.
    await persist(file,{schemaVersion:1,service:'threads',updatedAt:new Date(now).toISOString(),events});
    const id=randomUUID(),directory=path.join(root,'read-reservations');
    await mkdir(directory,{recursive:true,mode:0o700});
    const record={schemaVersion:1,service:'threads',id,...scope,createdAt:now,chargedAt,expiresAt:now+THREADS_READ_RESERVATION_TTL_MS,
      operations:Object.fromEntries(readbackOperations.map(operation=>[operation,{consumingAt:null,consumedAt:null}]))};
    await persist(path.join(directory,id+'.json'),record);
    return {id,root,...scope};
  },{lockPath:path.join(root,'read-budget.lock'),timeoutMs:10000});
}

/** Single-use credit for the exact owner/actor/post and observed read operation. */
export async function consumeThreadsReadReservation({reservation,operation,ownerId,handle,postId,now=Date.now()}={}) {
  const scope={ownerId,handle:typeof handle==='string'?handle.toLowerCase():handle,postId};
  if(!validScope(scope) || !reservation || !/^[0-9a-f-]{36}$/.test(reservation.id||'')
    || typeof reservation.root!=='string' || !reservation.root || !readbackOperations.includes(operation)
    || !Number.isSafeInteger(now)) throw reservationError('THREADS_READ_RESERVATION_INPUT_INVALID');
  return withSessionLock(async()=>{
    const file=path.join(reservation.root,'read-reservations',reservation.id+'.json');
    let record;
    try {record=JSON.parse(await readFile(file,'utf8'));}
    catch(error){if(error.code==='ENOENT')throw reservationError('THREADS_READ_RESERVATION_MISSING');throw error;}
    if(!validReservation(record,now) || record.id!==reservation.id
      || Object.entries(scope).some(([key,value])=>record[key]!==value || reservation[key]!==value))
      throw reservationError('THREADS_READ_RESERVATION_MISMATCH');
    if(record.expiresAt<=now)throw reservationError('THREADS_READ_RESERVATION_EXPIRED');
    if(record.operations[operation].consumedAt!==null || record.operations[operation].consumingAt!==null)
      throw reservationError('THREADS_READ_RESERVATION_ALREADY_CONSUMED');
    if(operation===readbackOperations[1] && record.operations[readbackOperations[0]].consumedAt===null)
      throw reservationError('THREADS_READ_RESERVATION_ORDER_INVALID');
    // A persisted intent fences interrupted consumes before any fetch.
    record.operations[operation].consumingAt=now;await atomicBotJson(file,record);
    const ledger=path.join(reservation.root,'read-budget.json'),events=await readEvents(ledger,now);
    const index=events.indexOf(record.chargedAt);
    if(index>=0)events.splice(index,1);
    events.push(now);events.sort((a,b)=>a-b);
    await atomicBotJson(ledger,{schemaVersion:1,service:'threads',updatedAt:new Date(now).toISOString(),events});
    record.operations[operation].consumedAt=now;await atomicBotJson(file,record);
    return {reserved:true,prepaid:true,operation,retryAt:null};
  },{lockPath:path.join(reservation.root,'read-budget.lock'),timeoutMs:10000});
}
