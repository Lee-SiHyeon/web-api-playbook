import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('a live restriction monitor is held without restarting repair or declaring the restriction cleared', () => {
  const input = { running: true, stopped: false, now: 1000, updatedAt: 1000, previous: { attempts: 3 },
    status: { status: 'waiting_for_reply_restriction', code: 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED',
      replyRestriction: { automaticWritesBlocked: true } } };
  assert.equal(threadsWatchdogDecision(input).action, 'service_held');
  assert.equal(threadsWatchdogDecision(input).attempts, 3);
  assert.equal(threadsWatchdogDecision({ ...input, stopped: true }).action, 'user_stopped');
  assert.equal(threadsWatchdogDecision({ ...input, running: false }).action, 'recover');
  assert.equal(threadsWatchdogDecision({ ...input, now: 2_000_000 }).action, 'repair');
});
import { threadsWatchdogDecision, readThreadsWorkerPresence, readThreadsProcessPresence, threadsProcessKey,
  reassertThreadsWorkerStopMarkers } from '../threads-watchdog.mjs';
import { threadsPidAlive } from '../lib/threads-runtime-control.mjs';

test('watchdog shutdown reasserts only the matching controller generation and preserves standalone worker STOPs', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'threads-watchdog-stop-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'threads-watchdog'), generation = 'maintenance-generation-2';
  const benefits = { root: path.join(base, 'benefits') }, outreach = { root: path.join(base, 'outreach') };
  await mkdir(root, { recursive: true }); await mkdir(outreach.root, { recursive: true });
  const standalone = 'user_stop';
  await writeFile(path.join(root, 'stop-request.json'), JSON.stringify({ generation }));
  await writeFile(path.join(root, 'STOP'), generation);
  await writeFile(path.join(outreach.root, 'worker-STOP'), standalone);

  assert.equal(await reassertThreadsWorkerStopMarkers(root, [benefits, outreach]), 1);
  assert.equal(await readFile(path.join(benefits.root, 'worker-STOP'), 'utf8'), generation);
  assert.equal(await readFile(path.join(outreach.root, 'worker-STOP'), 'utf8'), standalone);
  assert.equal(await reassertThreadsWorkerStopMarkers(root, [benefits, outreach]), 0);

  await writeFile(path.join(root, 'STOP'), 'different-generation');
  const other = { root: path.join(base, 'other') };
  assert.equal(await reassertThreadsWorkerStopMarkers(root, [other]), 0);
  await assert.rejects(readFile(path.join(other.root, 'worker-STOP'), 'utf8'), { code: 'ENOENT' });
});

test('watchdog rolls back only its new marker when the controller generation changes during reassertion', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'threads-watchdog-generation-race-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'threads-watchdog'), generation = 'generation-before-race';
  const benefits = { root: path.join(base, 'benefits') };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'stop-request.json'), JSON.stringify({ generation }));
  await writeFile(path.join(root, 'STOP'), generation);

  const created = await reassertThreadsWorkerStopMarkers(root, [benefits], {
    afterMarkerCreate: async () => {
      const replacement = 'generation-after-race';
      await writeFile(path.join(root, 'stop-request.json'), JSON.stringify({ generation: replacement }));
      await writeFile(path.join(root, 'STOP'), replacement);
    },
  });

  assert.equal(created, 0);
  await assert.rejects(readFile(path.join(benefits.root, 'worker-STOP'), 'utf8'), { code: 'ENOENT' });
});
test('explicit stop takes precedence over live processes and blocked statuses', () => {
  assert.equal(threadsWatchdogDecision({ stopped: true, running: true, status: { status: 'blocked' } }).action, 'user_stopped');
});

test('shared GraphQL cooldown prevents dead or stale worker repair without using another repair attempt', () => {
  const input = { stopped: false, running: false, now: 1000,
    status: { status: 'blocked', code: 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED' },
    sharedCooldown: { code: 'META_GRAPHQL_THROTTLED', httpStatus: 200, retryAt: 60_000 } };
  const decision = threadsWatchdogDecision(input);
  assert.equal(decision.action, 'cooldown_held'); assert.equal(decision.attempts, 0); assert.equal(decision.nextRepairAt, 60_000);
  assert.equal(threadsWatchdogDecision({ ...input, now: 60_000 }).action, 'repair');
  assert.equal(threadsWatchdogDecision({ ...input, stopped: true }).action, 'user_stopped');
  assert.equal(threadsWatchdogDecision({ ...input, running: true, status: { status: 'running', workerStarted: true } }).action, 'healthy');
});
test('live normal workers require no AI call and exits require scoped repair', () => {
  assert.equal(threadsWatchdogDecision({ stopped: false, running: true, status: { status: 'running' } }).action, 'healthy');
  assert.equal(threadsWatchdogDecision({ stopped: false, running: true, status: { status: 'cooldown', httpStatus: 429 } }).action, 'healthy');
  assert.equal(threadsWatchdogDecision({ stopped: false, running: false, status: { status: 'running' } }).action, 'recover');
});
test('integrity refusal triggers audit, backoff and hold, never direct restart', () => {
  const input = { stopped: false, running: false, status: { status: 'blocked', code: 'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED' }, now: 1000 };
  const first = threadsWatchdogDecision(input);
  assert.equal(first.action, 'repair');
  assert.equal(threadsWatchdogDecision({ ...input, previous: { fingerprint: first.fingerprint, attempts: 1, nextRepairAt: 2000 } }).action, 'backoff');
  assert.equal(threadsWatchdogDecision({ ...input, previous: { fingerprint: first.fingerprint, attempts: 3 } }).action, 'repair_held');
  assert.equal(threadsWatchdogDecision({ ...input, status: { ...input.status, startedAt: 'new-restart', finishedAt: 'new-exit' }, previous: { fingerprint: first.fingerprint, attempts: 3 } }).action, 'repair_held');
  assert.equal(threadsWatchdogDecision({ ...input, status: { ...input.status, code: 'ANOTHER_FAULT' }, previous: { fingerprint: first.fingerprint, attempts: 3 } }).action, 'repair');
});
test('a stalled live worker waits only on tagged 429 retry provenance', () => {
  assert.equal(threadsWatchdogDecision({ running: true, stopped: false, status: { status: 'running' }, now: 2_000_000, updatedAt: 0 }).action, 'repair');
  const now = 2_000_000;
  const arbitraryFuture = threadsWatchdogDecision({ running: true, stopped: false, status: { status: 'cooldown', httpStatus: 429,
    retryAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString() }, now, updatedAt: 0 });
  assert.equal(arbitraryFuture.action, 'repair');
  const observedServerHint = threadsWatchdogDecision({ running: true, stopped: false, status: { status: 'cooldown', httpStatus: 429,
    cooldownReason: 'http_429_rate_limit', deadlineSource: 'server_hint',
    retryAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString() }, now, updatedAt: 0 });
  assert.equal(observedServerHint.action, 'healthy', 'the observed server deadline is retained without an invented cap');
  const localFallback = threadsWatchdogDecision({ running: true, stopped: false, status: { status: 'cooldown', httpStatus: 429,
    cooldownReason: 'http_429_rate_limit', deadlineSource: 'local_fallback_15_minutes', fallbackMilliseconds: 15 * 60_000,
    retryAt: new Date(now + 15 * 60_000).toISOString() }, now, updatedAt: 0 });
  assert.equal(localFallback.action, 'healthy');
  const tooLongFallback = threadsWatchdogDecision({ running: true, stopped: false, status: { status: 'cooldown', httpStatus: 429,
    cooldownReason: 'http_429_rate_limit', deadlineSource: 'local_fallback_15_minutes', fallbackMilliseconds: 15 * 60_000,
    retryAt: new Date(now + 30 * 60_000).toISOString() }, now, updatedAt: 0 });
  assert.equal(tooLongFallback.action, 'repair');
});

test('monitor resume grace defers only living normal reads, preserving stop, error, integrity and dead-worker gates',()=>{
  const input={running:true,stopped:false,status:{status:'starting',workerStarted:false},now:2_000_000,updatedAt:0,resumeGraceUntil:2_600_000};
  assert.equal(threadsWatchdogDecision(input).action,'resume_pending');
  assert.equal(threadsWatchdogDecision({...input,stopped:true}).action,'user_stopped');
  assert.equal(threadsWatchdogDecision({...input,identityPending:true}).action,'identity_pending');
  assert.equal(threadsWatchdogDecision({...input,status:{status:'blocked',code:'META_GRAPHQL_HTTP_401'}}).action,'repair');
  assert.equal(threadsWatchdogDecision({...input,status:{status:'running',writeCountUnknown:1}}).action,'repair');
  assert.equal(threadsWatchdogDecision({...input,now:2_600_001}).action,'repair');
  assert.equal(threadsWatchdogDecision({...input,running:false,status:{status:'running'}}).action,'recover');
  const held={status:'waiting_for_reply_restriction',code:'THREADS_REPLY_SERVER_INTEGRITY_BLOCKED',replyRestriction:{automaticWritesBlocked:true}};
  assert.equal(threadsWatchdogDecision({...input,status:held}).action,'service_held');
  assert.equal(held.replyRestriction.automaticWritesBlocked,true);
  assert.equal(threadsWatchdogDecision({...input,running:false,status:held}).action,'recover');
});
test('old terminal status has a bounded startup grace only for a live new worker', () => {
  const input = { stopped: false, running: true, status: { status: 'stopped', pid: 100 }, previous: { launchedPid: 200, launchedAt: new Date(0).toISOString() }, now: 1000 };
  assert.equal(threadsWatchdogDecision(input).action, 'starting');
  assert.equal(threadsWatchdogDecision({ ...input, running: false }).action, 'repair');
  assert.equal(threadsWatchdogDecision({ ...input, now: 60_001 }).action, 'repair');
});
test('a worker that completed its read gates resets the old repair budget; a new launch alone does not', () => {
  const previous = { fingerprint: 'old-fault', attempts: 3, nextRepairAt: 9000 };
  const recovered = threadsWatchdogDecision({ running: true, stopped: false,
    status: { status: 'waiting_for_queue', workerStarted: true }, previous });
  assert.deepEqual(recovered, { action: 'healthy', fingerprint: null, attempts: 0, nextRepairAt: null });
  const starting = threadsWatchdogDecision({ running: true, stopped: false,
    status: { status: 'starting', workerStarted: false }, previous });
  assert.equal(starting.fingerprint, undefined);
  assert.equal(starting.attempts, undefined);
});

test('network read waits keep the repair budget until read gates pass and never override STOP', () => {
  const previous = { fingerprint: 'old-fault', attempts: 3, nextRepairAt: 9000 };
  const input = { running: true, stopped: false, status: { status: 'waiting_for_network', workerStarted: false }, previous };
  assert.equal(threadsWatchdogDecision(input).action, 'starting');
  assert.equal(threadsWatchdogDecision({ ...input, status: { ...input.status, workerStarted: true } }).action, 'healthy');
  assert.equal(threadsWatchdogDecision({ ...input, status: { ...input.status, workerStarted: true } }).attempts, 0);
  assert.equal(threadsWatchdogDecision({ ...input, stopped: true }).action, 'user_stopped');
});

test('dead workers in a verified local read-budget wait use the deterministic recovery path', () => {
  const decision = threadsWatchdogDecision({ stopped: false, running: false, now: 1_000,
    status: { status: 'waiting_for_read_budget', code: 'THREADS_READ_BUDGET_WAIT',
      cooldownReason: 'shared_read_budget', deadlineSource: 'local_budget', retryAt: new Date(60_000).toISOString() } });
  assert.equal(decision.action, 'recover');
  assert.equal(decision.strategy, 'local_runtime');
  const invalidLongWait = threadsWatchdogDecision({ stopped: false, running: false, now: 1_000,
    status: { status: 'waiting_for_read_budget', code: 'THREADS_READ_BUDGET_WAIT',
      cooldownReason: 'shared_read_budget', deadlineSource: 'local_budget',
      retryAt: new Date(2 * 60 * 60_000).toISOString() } });
  assert.equal(invalidLongWait.action, 'repair');
});

test('watchdog does not forgive a stale generic cooldown with an arbitrary future retry', () => {
  const now = 2_000_000;
  const decision = threadsWatchdogDecision({ stopped: false, running: true, now, updatedAt: 0,
    status: { status: 'cooldown', workerStarted: true, retryAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString() } });
  assert.equal(decision.action, 'repair');
  const localBudgetWait = threadsWatchdogDecision({ stopped: false, running: true, now, updatedAt: 0,
    status: { status: 'waiting_for_read_budget', code: 'THREADS_READ_BUDGET_WAIT', httpStatus: 200,
      cooldownReason: 'shared_read_budget', deadlineSource: 'local_budget',
      retryAt: new Date(now + 2 * 60 * 60_000).toISOString() } });
  assert.equal(localBudgetWait.action, 'repair', 'the production read budget expires within its one-hour window');
});

test('stale throttle waits require an observed source tag while server hints retain their stated deadline', () => {
  const now = 2_000_000, retryAt = new Date(now + 24 * 60 * 60_000).toISOString();
  const base = { status: 'cooldown', code: 'META_GRAPHQL_THROTTLED', httpStatus: 200,
    cooldownReason: 'graphql_200_rate_limit', retryAt };
  const tagged = threadsWatchdogDecision({ stopped: false, running: true, now, updatedAt: 0,
    status: { ...base, deadlineSource: 'server_hint' } });
  assert.equal(tagged.action, 'healthy');
  const untagged = threadsWatchdogDecision({ stopped: false, running: true, now, updatedAt: 0, status: base });
  assert.equal(untagged.action, 'repair');
});

test('a live PID whose identity query times out does not trigger duplicate startup or repair', async () => {
  const presence = await readThreadsWorkerPresence({ script: 'threads-outreach-worker.mjs' }, 12345,
    { pidAlive: () => true, processReader: async () => { throw Object.assign(new Error(), { code: 'ETIMEDOUT' }); } });
  assert.equal(presence, null);
  assert.notEqual(presence, false, 'startup launches only after positively absent or mismatched identity');
  assert.equal(threadsWatchdogDecision({ running: false, identityPending: presence === null, stopped: false,
    status: { status: 'starting', workerStarted: false } }).action, 'identity_pending');
  assert.equal(threadsWatchdogDecision({ running: false, identityPending: true, stopped: true,
    status: { status: 'blocked' } }).action, 'user_stopped');
});

test('worker presence distinguishes dead, matching, mismatched and inconclusive process identities', async () => {
  const spec = { script: 'threads-benefit-worker.mjs' };
  assert.equal(await readThreadsWorkerPresence(spec, 12345,
    { pidAlive: () => false, processReader: async () => { throw new Error('must not query a dead PID'); } }), false);
  for (const [stdout, expected] of [['True\r\n', true], ['False\r\n', false], ['', null]]) {
    assert.equal(await readThreadsWorkerPresence(spec, 12345,
      { pidAlive: () => true, processReader: async () => ({ stdout }) }), expected);
  }
});

test('permission and unknown PID-probe errors are inconclusive, only ESRCH proves exit', async () => {
  for (const code of ['EPERM', 'EACCES', 'UNKNOWN']) {
    const pidAlive = pid => threadsPidAlive(pid, () => { throw Object.assign(new Error(), { code }); });
    assert.equal(pidAlive(12345), true);
    const presence = await readThreadsWorkerPresence({ script: 'threads-outreach-worker.mjs' }, 12345,
      { pidAlive, processReader: async () => { throw Object.assign(new Error(), { code: 'ETIMEDOUT' }); } });
    assert.equal(presence, null);
  }
  assert.equal(threadsPidAlive(12345, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.equal(threadsWatchdogDecision({ running: true, stopped: false, status: { status: 'starting', workerStarted: false } }).action, 'starting');
});

test('one identity batch separates matching, mismatched and dead workers without repeated shell startup', async () => {
  const a = { script: 'threads-benefit-worker.mjs' }, b = { script: 'threads-outreach-worker.mjs' }; let queries = 0;
  const requests = [{ spec: a, pid: 100 }, { spec: a, pid: 100 }, { spec: b, pid: 200 }, { spec: a, pid: 300 }];
  const result = await readThreadsProcessPresence(requests, { pidAlive: pid => pid !== 300,
    processReader: async () => { queries++; return { stdout: JSON.stringify([
      { key: threadsProcessKey(a, 100), present: true }, { key: threadsProcessKey(b, 200), present: false }]) }; } });
  assert.equal(queries, 1); assert.equal(result.get(threadsProcessKey(a, 100)), true);
  assert.equal(result.get(threadsProcessKey(b, 200)), false); assert.equal(result.get(threadsProcessKey(a, 300)), false);
});

test('a failed or malformed batch never turns a still-live unknown identity into absence', async () => {
  const spec = { script: 'threads-watchdog.mjs' };
  for (const processReader of [async () => { throw new Error('timeout'); }, async () => ({ stdout: 'not_json' }), async () => ({ stdout: '[]' })]) {
    const result = await readThreadsProcessPresence([{ spec, pid: 100 }], { pidAlive: () => true, processReader });
    assert.equal(result.get(threadsProcessKey(spec, 100)), null);
  }
});

test('failed sandbox audits do not exhaust the separate deterministic dead-runtime recovery budget', () => {
  const input={ running:false,stopped:false,status:{ status:'cooldown',code:'META_GRAPHQL_THROTTLED',httpStatus:200,
      cooldownReason:'graphql_200_rate_limit',deadlineSource:'server_hint',retryAt:new Date(60000).toISOString() },now:1000,
    sharedCooldown:{ retryAt:60000 },previous:{} };
  const first=threadsWatchdogDecision(input); assert.equal(first.action,'recover');
  assert.equal(threadsWatchdogDecision({ ...input,previous:{ fingerprint:first.fingerprint,attempts:3,nextRepairAt:60000 } }).action,'recover');
  assert.equal(threadsWatchdogDecision({ ...input,previous:{ ...first,attempts:1,nextRepairAt:2000 } }).action,'backoff');
  assert.equal(threadsWatchdogDecision({ ...input,stopped:true }).action,'user_stopped');
});

test('audit decisions replace a saved local recovery strategy and retain their three-attempt budget', () => {
  const input = { running: false, stopped: false, now: 1000,
    status: { status: 'blocked', code: 'THREADS_SEARCH_POST_SCHEMA', httpStatus: 200 } };
  let previous = { strategy: 'local_runtime', fingerprint: 'previous-local-fault', attempts: 12 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const decision = threadsWatchdogDecision({ ...input, previous });
    assert.equal(decision.action, 'repair');
    assert.equal(decision.strategy, 'audit');
    assert.equal(decision.attempts, attempt);
    // Match the monitor's merge and attempt reservation, including stale fields.
    previous = { ...previous, ...decision, attempts: decision.attempts + 1 };
  }
  const held = threadsWatchdogDecision({ ...input, previous });
  assert.equal(held.action, 'repair_held');
  assert.equal(held.strategy, 'audit');
  assert.equal(held.attempts, 3);
  assert.equal(threadsWatchdogDecision({ ...input, previous: { ...previous, ...held }, now: 9999999 }).action,
    'repair_held', 'elapsed time cannot replenish the same failed audit budget');
});

test('audit backoff and shared cooldown preserve the strategy without consuming or resetting attempts', () => {
  const input = { running: false, stopped: false, now: 1000,
    status: { status: 'blocked', code: 'THREADS_SEARCH_POST_SCHEMA', httpStatus: 200 } };
  const first = threadsWatchdogDecision(input);
  const previous = { ...first, strategy: 'audit', attempts: 2, nextRepairAt: 2000 };
  const backoff = threadsWatchdogDecision({ ...input, previous });
  assert.equal(backoff.action, 'backoff');
  assert.equal(backoff.strategy, 'audit');
  assert.equal(backoff.attempts, 2);
  const cooldown = threadsWatchdogDecision({ ...input, previous,
    sharedCooldown: { retryAt: 60000 } });
  assert.equal(cooldown.action, 'cooldown_held');
  assert.equal(cooldown.strategy, 'audit');
  assert.equal(cooldown.attempts, 2);
  assert.equal(threadsWatchdogDecision({ ...input, previous: { ...previous, ...cooldown }, now: 60000 }).attempts, 2);
  assert.equal(threadsWatchdogDecision({ ...input, previous, stopped: true }).action, 'user_stopped');
});
