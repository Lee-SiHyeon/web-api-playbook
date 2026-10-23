import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runThreadsRuntime, readThreadsRuntime } from '../threads-runtime.mjs';
import { threadsRuntimePaths, threadsFileExists, threadsRuntimeControllerActive, threadsStopRequested } from '../lib/threads-runtime-control.mjs';
import { threadsWatchdogDecision, acquireThreadsWatchdogLock, readThreadsWorkerPresence } from '../threads-watchdog.mjs';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'threads-lifecycle-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const paths = threadsRuntimePaths(base), live = new Map(), launches = [];
  let now = Date.now(), nextPid = 90000;
  const put = async (spec, pid, extra = {}) => {
    await mkdir(spec.root, { recursive: true });
    await writeFile(path.join(spec.root, spec.name === 'watchdog' ? 'status.json' : 'worker-status.json'), JSON.stringify({
      pid, status: 'running', workerStarted: true, indefinite: true, expiresAt: null,
      mode: spec.name === 'outreach' ? 'execute_explicit' : 'serial_pure_http',
      checkedAt: new Date(now).toISOString(), ...extra,
    }));
  };
  const dependencies = {
    now: () => now, sleep: async ms => { now += ms; },
    pidAlive: pid => live.has(pid), presence: async (spec, pid) => live.get(pid) === spec.name,
    auth: async () => ({ authenticated: true, ownerVerified: true, httpStatus: 200 }),
    launch: async spec => {
      const controllerOwner = JSON.parse(await readFile(paths.controlLock, 'utf8'));
      assert.equal(controllerOwner.script, path.basename(process.argv[1]), 'runtime lock records the observed entry script basename');
      assert.equal(await threadsRuntimeControllerActive(paths.controlLock, { processPresence: async () => true }), true);
      assert.equal(await threadsFileExists(path.join(paths.root, 'STOP')), false);
      assert.equal(await threadsFileExists(path.join(paths.workers[0].root, 'worker-STOP')), false);
      const pid = ++nextPid; live.set(pid, spec.name); launches.push(spec.name); await put(spec, pid); return pid;
    },
  };
  return { paths, live, launches, dependencies, put };
}

test('controller identity survives long startup while a reused PID is stale and unknown identity fails closed', async t => {
  const f = await fixture(t), file = f.paths.controlLock, old = new Date(Date.now() - 20 * 60_000).toISOString();
  await mkdir(f.paths.root, { recursive: true });
  await writeFile(file, JSON.stringify({ pid: 81234, nonce: '7ef2ebf1-9a4b-4f59-a490-b9a92fc41371', startedAt: old }));
  assert.equal(await threadsRuntimeControllerActive(file, { processPresence: async () => true }), true,
    'an exact live controller remains active beyond ten minutes');
  assert.equal(await threadsRuntimeControllerActive(file, { processPresence: async () => false }), false,
    'a PID now owned by another script does not hold the controller lease');
  assert.equal(await threadsRuntimeControllerActive(file, { processPresence: async () => null }), true,
    'an inconclusive process identity cannot authorize watchdog repair');
});

test('runtime controller records and probes an imported helper entry script by exact basename', async t => {
  const f = await fixture(t), file = f.paths.controlLock, script = 'threads-restore-after-repair.mjs';
  await withSessionLock(async () => {
    const owner = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(owner.script, script);
    assert.equal(await threadsRuntimeControllerActive(file, {
      pidAlive: () => true,
      processReader: async (_exe, args) => {
        assert.match(args.at(-1), /threads-restore-after-repair\\.mjs/);
        return { stdout: JSON.stringify([{ key: `${script}#${owner.pid}`, present: true }]) };
      },
    }), true);
  }, { lockPath: file, ownerScript: script });
});

test('a live legacy controller without owner script is pending unless a known entrypoint is positively observed', async t => {
  const f = await fixture(t), file = f.paths.controlLock, pid = 81239;
  await mkdir(f.paths.root, { recursive: true });
  await writeFile(file, JSON.stringify({ pid, nonce: '7ef2ebf1-9a4b-4f59-a490-b9a92fc41371', startedAt: new Date().toISOString() }));
  const entrypoints = ['threads-runtime.mjs', 'threads-watchdog.mjs', 'threads-restore-after-repair.mjs',
    'threads-basic-reload.mjs', 'recovery-threads-runtime.mjs'];
  const probe = presentScript => async (_exe, args) => {
    for (const script of entrypoints) assert.ok(args.at(-1).includes(`${script}#${pid}`));
    return { stdout: JSON.stringify(entrypoints.map(script => ({ key: `${script}#${pid}`, present: script === presentScript }))) };
  };
  assert.equal(await threadsRuntimeControllerActive(file, { pidAlive: () => true, processReader: probe(null) }), true,
    'no positive legacy match remains fail-closed');
  assert.equal(await threadsRuntimeControllerActive(file, { pidAlive: () => true, processReader: probe('threads-basic-reload.mjs') }), true,
    'an exact known helper match proves the legacy controller is active');
});

test('malformed controller locks are held while fresh and age out only after the file is unchanged', async t => {
  const f = await fixture(t), file = f.paths.controlLock, now = Date.now();
  await mkdir(f.paths.root, { recursive: true }); await writeFile(file, '{partial');
  assert.equal(await threadsRuntimeControllerActive(file, { now }), true);
  const old = new Date(now - 121_000); await utimes(file, old, old);
  assert.equal(await threadsRuntimeControllerActive(file, { now }), false);
});

test('watchdog lock preserves STOP and recovers only aged malformed or positively mismatched owners', async t => {
  const f = await fixture(t), root = f.paths.root, file = path.join(root, 'watchdog.lock');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'STOP'), 'user_stop');
  await mkdir(f.paths.workers[0].root, { recursive: true });
  await writeFile(path.join(f.paths.workers[0].root, 'worker-STOP'), 'worker_stop');

  await writeFile(file, '{partial');
  await assert.rejects(acquireThreadsWatchdogLock(root, { identityProbe: async () => false }),
    { code: 'THREADS_WATCHDOG_LOCK_RECOVERY_PENDING' });
  assert.equal(await readFile(file, 'utf8'), '{partial');

  const old = new Date(Date.now() - 121_000); await utimes(file, old, old);
  const recoveredMalformed = await acquireThreadsWatchdogLock(root, { identityProbe: async () => false });
  let owner = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(owner.script, 'threads-watchdog.mjs'); assert.equal(owner.nonce, recoveredMalformed.nonce);
  assert.equal(await readFile(path.join(root, 'STOP'), 'utf8'), 'user_stop');
  assert.equal(await readFile(path.join(f.paths.workers[0].root, 'worker-STOP'), 'utf8'), 'worker_stop');
  await recoveredMalformed.release();

  const staleOwner = { pid: 81235, nonce: '8ef2ebf1-9a4b-4f59-a490-b9a92fc41371', startedAt: old.toISOString() };
  await writeFile(file, JSON.stringify(staleOwner));
  const recoveredPid = await acquireThreadsWatchdogLock(root, { identityProbe: async pid => pid === staleOwner.pid ? false : null });
  owner = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(owner.pid, process.pid); assert.equal(owner.script, 'threads-watchdog.mjs');
  await recoveredPid.release();
});

test('watchdog lock holds live old owners and inconclusive identities without deleting their lock', async t => {
  const f = await fixture(t), root = f.paths.root, file = path.join(root, 'watchdog.lock');
  await mkdir(root, { recursive: true });
  const prior = { pid: 81236, nonce: '9ef2ebf1-9a4b-4f59-a490-b9a92fc41371', startedAt: new Date(Date.now() - 20 * 60_000).toISOString() };
  const raw = JSON.stringify(prior); await writeFile(file, raw);
  await assert.rejects(acquireThreadsWatchdogLock(root, { identityProbe: async () => true }),
    { code: 'THREADS_WATCHDOG_ALREADY_RUNNING' });
  assert.equal(await readFile(file, 'utf8'), raw);
  await assert.rejects(acquireThreadsWatchdogLock(root, { identityProbe: async () => null }),
    { code: 'THREADS_WATCHDOG_LOCK_IDENTITY_PENDING' });
  assert.equal(await readFile(file, 'utf8'), raw);
});

test('watchdog lease release refuses to delete a replacement file even when nonce and contents match', async t => {
  const f = await fixture(t), root = f.paths.root, file = path.join(root, 'watchdog.lock');
  await mkdir(root, { recursive: true });
  const lease = await acquireThreadsWatchdogLock(root, { identityProbe: async () => false });
  const raw = await readFile(file, 'utf8');
  await unlink(file); await writeFile(file, raw);
  assert.equal(await lease.release(), false);
  assert.equal(await readFile(file, 'utf8'), raw);
});

test('worker process identity probes match an exact entry script token', async () => {
  const commands = [];
  const presence = await readThreadsWorkerPresence({ script: 'threads-watchdog.mjs' }, 81237,
    { pidAlive: () => true, processReader: async (_exe, args) => { commands.push(args.at(-1)); return { stdout: 'False\r\n' }; } });
  assert.equal(presence, false);
  assert.match(commands[0], /-match/);
  assert.doesNotMatch(commands[0], /-like/);
  assert.match(commands[0], /\(\?:\^\|/);
  const unknown = await readThreadsWorkerPresence({ script: 'threads-watchdog.mjs' }, 81238,
    { pidAlive: () => true, processReader: async (_exe, args) => {
      commands.push(args.at(-1)); return { stdout: 'Unknown\r\n' };
    } });
  assert.equal(unknown, null, 'a live PID without a readable command line is not a confirmed mismatch');
  assert.match(commands[1], /IsNullOrWhiteSpace/);
});

test('explicit start clears old STOP only after the stopping monitor exits, then verifies all three processes', async t => {
  const f = await fixture(t), oldPid = 80000, generation = 'maintenance-generation-old-monitor';
  await mkdir(f.paths.root, { recursive: true });
  await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation }));
  await writeFile(path.join(f.paths.root, 'STOP'), generation);
  await mkdir(f.paths.workers[0].root, { recursive: true });
  await writeFile(path.join(f.paths.workers[0].root, 'worker-STOP'), generation);
  f.live.set(oldPid, 'watchdog'); await f.put(f.paths.monitor, oldPid);
  let stoppingObserved = false;
  f.dependencies.sleep = async () => {
    assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), true);
    await writeFile(path.join(f.paths.workers[0].root, 'worker-STOP'), generation);
    stoppingObserved = true; f.live.delete(oldPid);
  };
  const result = await runThreadsRuntime('start', f);
  assert.equal(stoppingObserved, true); assert.equal(result.ready, true);
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach']);
  for (const spec of f.paths.workers) assert.equal(await threadsStopRequested(spec.root, f.paths), false);
});

test('whole-runtime start preserves a standalone outreach STOP while starting unaffected workers', async t => {
  const f = await fixture(t), spec = f.paths.workers.find(value => value.name === 'outreach');
  await mkdir(spec.root, { recursive: true });
  const stop = JSON.stringify({ reason: 'owner explicitly paused Threads outreach' });
  await writeFile(path.join(spec.root, 'worker-STOP'), stop);

  const result = await runThreadsRuntime('start', { ...f, timeoutMs: 0 });

  assert.equal(await readFile(path.join(spec.root, 'worker-STOP'), 'utf8'), stop);
  assert.deepEqual(f.launches, ['watchdog', 'benefits']);
  assert.equal(result.workers.outreach.stopped, true);
  assert.equal(result.ready, false);
});

test('whole-runtime start preserves a standalone root user_stop with no generation proof', async t => {
  const f = await fixture(t);
  await mkdir(f.paths.root, { recursive: true });
  await writeFile(path.join(f.paths.root, 'STOP'), 'user_stop');

  await assert.rejects(runThreadsRuntime('start', f), { code: 'THREADS_RUNTIME_STOP_GENERATION_CHANGED' });

  assert.equal((await readFile(path.join(f.paths.root, 'STOP'), 'utf8')).trim(), 'user_stop');
  assert.deepEqual(f.launches, []);
});

test('whole-runtime start preserves a standalone user_stop despite a matching global generation', async t => {
  const f = await fixture(t), generation = 'maintenance-generation-standalone';
  const outreach = f.paths.workers.find(value => value.name === 'outreach');
  await mkdir(f.paths.root, { recursive: true });
  await mkdir(outreach.root, { recursive: true });
  await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation }));
  await writeFile(path.join(f.paths.root, 'STOP'), generation);
  await writeFile(path.join(outreach.root, 'worker-STOP'), 'user_stop');

  const result = await runThreadsRuntime('start', { ...f, timeoutMs: 0 });

  assert.equal(await readFile(path.join(outreach.root, 'worker-STOP'), 'utf8'), 'user_stop');
  assert.deepEqual(f.launches, ['watchdog', 'benefits']);
  assert.equal(result.workers.outreach.stopped, true);
  assert.equal(result.ready, false);
});

test('explicit start clears only worker STOP markers owned by the matching global generation', async t => {
  const f = await fixture(t), generation = 'maintenance-generation-1';
  await mkdir(f.paths.root, { recursive: true });
  await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation }));
  await writeFile(path.join(f.paths.root, 'STOP'), generation);
  for (const spec of f.paths.workers) {
    await mkdir(spec.root, { recursive: true });
    await writeFile(path.join(spec.root, 'worker-STOP'), generation);
  }

  const result = await runThreadsRuntime('start', f);

  assert.equal(result.ready, true);
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach']);
  assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), false);
  for (const spec of f.paths.workers) assert.equal(await threadsFileExists(path.join(spec.root, 'worker-STOP')), false);
});

test('a mismatched global STOP generation is held without clearing markers or launching workers', async t => {
  const f = await fixture(t), rootStop = 'older-generation', current = 'current-generation';
  await mkdir(f.paths.root, { recursive: true });
  await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation: current }));
  await writeFile(path.join(f.paths.root, 'STOP'), rootStop);

  await assert.rejects(runThreadsRuntime('start', f), { code: 'THREADS_RUNTIME_STOP_GENERATION_CHANGED' });

  assert.equal(await readFile(path.join(f.paths.root, 'STOP'), 'utf8'), rootStop);
  assert.deepEqual(f.launches, []);
});

test('runtime stop and subsequent start preserve an independently owned outreach STOP', async t => {
  const f = await fixture(t), spec = f.paths.workers.find(value => value.name === 'outreach');
  await runThreadsRuntime('start', f);
  const stop = JSON.stringify({ reason: 'owner explicitly paused Threads outreach' });
  await writeFile(path.join(spec.root, 'worker-STOP'), stop);
  f.dependencies.sleep = async () => { f.live.clear(); };

  const stopped = await runThreadsRuntime('stop', f);
  assert.equal(stopped.stopVerified, true);
  assert.equal(await readFile(path.join(spec.root, 'worker-STOP'), 'utf8'), stop);

  const started = await runThreadsRuntime('start', f);
  assert.equal(await readFile(path.join(spec.root, 'worker-STOP'), 'utf8'), stop);
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach', 'watchdog', 'benefits']);
  assert.equal(started.workers.outreach.stopped, true);
  assert.equal(started.ready, false);
});

test('overlapping stops rotate to the latest generation without stale worker markers', async t => {
  const f = await fixture(t), oldMonitorPid = 89000;
  await mkdir(f.paths.root, { recursive: true });
  for (const [index, spec] of [f.paths.monitor, ...f.paths.workers].entries()) {
    const pid = oldMonitorPid + index;
    f.live.set(pid, spec.name);
    await f.put(spec, pid);
  }
  const outreach = f.paths.workers.find(spec => spec.name === 'outreach');
  await writeFile(path.join(outreach.root, 'worker-STOP'), 'user_stop');

  let firstSleepEntered;
  const firstSleepReady = new Promise(resolve => { firstSleepEntered = resolve; });
  let releaseFirstSleep;
  const firstSleepGate = new Promise(resolve => { releaseFirstSleep = resolve; });
  let sleepCalls = 0;
  f.dependencies.sleep = async _milliseconds => {
    if (sleepCalls++ === 0) {
      firstSleepEntered();
      await firstSleepGate;
      f.live.clear();
    }
  };

  let controlLockRequests = 0, secondControlRequested;
  const secondControlReady = new Promise(resolve => { secondControlRequested = resolve; });
  f.dependencies.lock = (fn, options) => {
    if (path.basename(options.lockPath) === 'runtime-control.lock' && ++controlLockRequests === 2) secondControlRequested();
    return withSessionLock(fn, { ...options, ownerScript: path.basename(process.argv[1]) });
  };

  const firstStop = runThreadsRuntime('stop', f);
  await firstSleepReady;
  const firstGeneration = JSON.parse(await readFile(path.join(f.paths.root, 'stop-request.json'), 'utf8')).generation;
  const secondStop = runThreadsRuntime('stop', f);
  await secondControlReady;
  assert.notEqual(JSON.parse(await readFile(path.join(f.paths.root, 'stop-request.json'), 'utf8')).generation,
    firstGeneration, 'the latest stop must rotate the active generation and fence an authorized start');
  releaseFirstSleep();

  const [first, second] = await Promise.all([firstStop, secondStop]);
  const generation = JSON.parse(await readFile(path.join(f.paths.root, 'stop-request.json'), 'utf8')).generation;
  assert.equal(first.stopVerified, false, 'an older stop must not reassert or report success for a newer generation');
  assert.equal(first.stopGeneration, firstGeneration);
  assert.equal(second.stopGeneration, generation);
  assert.equal((await readFile(path.join(f.paths.root, 'STOP'), 'utf8')).trim(), generation);
  const benefits = f.paths.workers.find(spec => spec.name === 'benefits');
  assert.equal((await readFile(path.join(benefits.root, 'worker-STOP'), 'utf8')).trim(), generation,
    'a prior controller generation must be adopted by the latest stop');
  assert.equal((await readFile(path.join(outreach.root, 'worker-STOP'), 'utf8')).trim(), 'user_stop',
    'an independent worker STOP must survive generation adoption');
});

test('a newer stop fences a start already waiting on owner preflight', async t => {
  const f = await fixture(t), oldGeneration = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await mkdir(f.paths.root, { recursive: true });
  await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation: oldGeneration }));
  await writeFile(path.join(f.paths.root, 'STOP'), oldGeneration);
  for (const spec of f.paths.workers) {
    await mkdir(spec.root, { recursive: true });
    await writeFile(path.join(spec.root, 'worker-STOP'), oldGeneration);
  }

  let ownerReadEntered;
  const ownerReadReady = new Promise(resolve => { ownerReadEntered = resolve; });
  let releaseOwnerRead;
  const ownerReadGate = new Promise(resolve => { releaseOwnerRead = resolve; });
  f.dependencies.auth = async () => {
    ownerReadEntered();
    await ownerReadGate;
    return { authenticated: true, ownerVerified: true, httpStatus: 200 };
  };

  let stopSignalComplete;
  const stopSignalReady = new Promise(resolve => { stopSignalComplete = resolve; });
  f.dependencies.lock = (fn, options) => withSessionLock(async () => {
    const result = await fn();
    if (path.basename(options.lockPath) === 'stop-signal.lock') stopSignalComplete();
    return result;
  }, { ...options, ownerScript: path.basename(process.argv[1]) });

  const starting = runThreadsRuntime('start', f);
  await ownerReadReady;
  const stopping = runThreadsRuntime('stop', f);
  await stopSignalReady;
  const request = JSON.parse(await readFile(path.join(f.paths.root, 'stop-request.json'), 'utf8'));
  assert.notEqual(request.generation, oldGeneration);
  assert.equal(request.transition, undefined, 'the latest stop publishes only after all owned markers are aligned');
  assert.equal((await readFile(path.join(f.paths.root, 'STOP'), 'utf8')).trim(), request.generation);
  releaseOwnerRead();

  await assert.rejects(starting, { code: 'THREADS_RUNTIME_STOPPED' });
  const result = await stopping;
  assert.equal(result.stopVerified, true);
  assert.deepEqual(f.launches, []);
  for (const spec of f.paths.workers) {
    const marker = await readFile(path.join(spec.root, 'worker-STOP'), 'utf8');
    assert.equal(marker.trim(), request.generation);
  }
});

test('serialized concurrent starts preserve healthy workers and create each process only once', async t => {
  const f = await fixture(t);
  const results = await Promise.all([runThreadsRuntime('start', f), runThreadsRuntime('start', f)]);
  assert.ok(results.every(value => value.ready));
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach']);
  await runThreadsRuntime('start', f); assert.equal(f.launches.length, 3);
});

test('inconclusive process identity is pending and never launches a replacement', async t => {
  const f = await fixture(t); await f.put(f.paths.monitor, 80000);
  f.dependencies.presence = async (_spec, pid) => pid === 80000 ? null : false;
  const result = await runThreadsRuntime('start', f);
  assert.equal(result.ready, false); assert.equal(result.code, 'THREADS_RUNTIME_PROCESS_IDENTITY_PENDING');
  assert.equal(f.launches.length, 0);
});

test('launch receipt without completed worker read gates is not startup success', async t => {
  const f = await fixture(t), original = f.dependencies.launch;
  f.dependencies.launch = async spec => {
    const pid = await original(spec);
    if (spec.name !== 'watchdog') await f.put(spec, pid, { workerStarted: false, status: 'starting' });
    return pid;
  };
  const result = await runThreadsRuntime('start', { ...f, timeoutMs: 0 });
  assert.equal(result.ready, false); assert.equal(result.workers.benefits.processAlive, true);
  assert.equal(result.workers.benefits.readGatesPassed, false);
});

test('old blocked status cannot short-circuit readback for a newly launched worker PID', async t => {
  const f = await fixture(t), benefits = f.paths.workers[0], originalLaunch = f.dependencies.launch;
  let launchedBenefitsPid = null, refreshed = false;
  f.dependencies.launch = async spec => {
    const pid = await originalLaunch(spec);
    if (spec.name === 'benefits') {
      launchedBenefitsPid = pid;
      await f.put(spec, 81234, { status: 'blocked', code: 'THREADS_BENEFIT_WORKER_FAILED', workerStarted: false });
    }
    return pid;
  };
  const originalSleep = f.dependencies.sleep;
  f.dependencies.sleep = async milliseconds => {
    if (!refreshed && launchedBenefitsPid !== null) {
      refreshed = true;
      await f.put(benefits, launchedBenefitsPid, { status: 'running', workerStarted: true });
    }
    await originalSleep(milliseconds);
  };

  const result = await runThreadsRuntime('start', f);

  assert.equal(refreshed, true, 'startup should wait for status owned by the newly launched PID');
  assert.equal(result.ready, true);
  assert.equal(result.workers.benefits.readGatesPassed, true);
});

test('a verified worker in HTTP 200 throttle cooldown is ready; a fresh unread worker is still pending', async t => {
  const f = await fixture(t);
  await runThreadsRuntime('start', f);
  const spec = f.paths.workers[0], pid = [...f.live.entries()].find(([, name]) => name === 'benefits')[0];
  const cooldown = { status: 'cooldown', code: 'META_GRAPHQL_THROTTLED', httpStatus: 200,
    cooldownReason: 'graphql_200_rate_limit', deadlineSource: 'server_hint',
    retryAt: new Date(f.dependencies.now() + 900_000).toISOString() };
  await f.put(spec, pid, cooldown);
  let state = await readThreadsRuntime(f);
  assert.equal(state.ready, true); assert.equal(state.workers.benefits.httpStatus, 200);
  assert.equal(state.workers.benefits.retryAt, cooldown.retryAt);
  await f.put(spec, pid, { ...cooldown, workerStarted: false });
  state = await readThreadsRuntime(f);
  assert.equal(state.ready, false); assert.equal(state.workers.benefits.readGatesPassed, false);
  assert.equal(threadsWatchdogDecision({ running: true, status: { ...cooldown, workerStarted: false },
    now: f.dependencies.now(), updatedAt: f.dependencies.now() }).action, 'starting');
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach']);
});

test('network read waits are ready only after the worker completed its live read gates', async t => {
  const f = await fixture(t);
  await runThreadsRuntime('start', f);
  const spec = f.paths.workers[0], pid = [...f.live.entries()].find(([, name]) => name === 'benefits')[0];
  await f.put(spec, pid, { status: 'waiting_for_network', lastTransientCode: 'THREADS_BENEFIT_READ_TIMEOUT' });
  let state = await readThreadsRuntime(f);
  assert.equal(state.ready, true); assert.equal(state.workers.benefits.readGatesPassed, true);
  await f.put(spec, pid, { status: 'waiting_for_network', workerStarted: false });
  state = await readThreadsRuntime(f);
  assert.equal(state.ready, false); assert.equal(state.workers.benefits.readGatesPassed, false);
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach']);
});

test('a valid local read-budget hold stays ready after its status ages beyond the ordinary heartbeat window', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  const prior = await readThreadsRuntime(f), spec = f.paths.workers[0], pid = prior.workers.benefits.pid;
  const later = f.dependencies.now();
  await f.put(spec, pid, { status: 'waiting_for_read_budget', code: 'THREADS_READ_BUDGET_WAIT',
    httpStatus: 200, cooldownReason: 'shared_read_budget', deadlineSource: 'local_budget', retryAt: new Date(later + 60 * 60_000).toISOString() });
  const old = new Date(later - 31 * 60_000);
  await utimes(path.join(spec.root, 'worker-status.json'), old, old);
  const state = await readThreadsRuntime(f);
  assert.equal(state.workers.benefits.readGatesPassed, true);
  assert.equal(state.workers.benefits.ready, true);
  assert.equal(state.workers.benefits.httpStatus, null, 'legacy synthetic local-budget 200 is not a server response');
  assert.equal(state.workers.benefits.cooldownReason, 'shared_read_budget');
  assert.equal(state.workers.benefits.deadlineSource, 'local_budget');
  assert.equal(state.ready, true, JSON.stringify(state));
  assert.equal(state.readinessScope, 'process_presence_and_recorded_startup_read_gates');
  f.live.delete(pid);
  const dead = await readThreadsRuntime(f);
  assert.equal(dead.workers.benefits.processAlive, false);
  assert.equal(dead.workers.benefits.ready, false, 'a future retry deadline cannot make a dead PID ready');
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach']);
});

test('an untagged cooldown with an arbitrary future retry does not keep an old worker fresh', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  const prior = await readThreadsRuntime(f), spec = f.paths.workers[0], pid = prior.workers.benefits.pid;
  const now = Date.now();
  await f.put(spec, pid, { status: 'cooldown', retryAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString() });
  const old = new Date(now - 31 * 60_000);
  await utimes(path.join(spec.root, 'worker-status.json'), old, old);
  const state = await readThreadsRuntime(f);
  assert.equal(state.workers.benefits.ready, false);
  assert.equal(state.workers.benefits.cooldownReason, null);
  assert.equal(state.workers.benefits.deadlineSource, null);
});

test('runtime preserves observed HTTP 429 deadline provenance for stale cooldown health checks', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  const prior = await readThreadsRuntime(f), spec = f.paths.workers[0], now = f.dependencies.now();
  await f.put(spec, prior.workers.benefits.pid, { status: 'cooldown', httpStatus: 429,
    cooldownReason: 'http_429_rate_limit', deadlineSource: 'server_hint', retryAt: new Date(now + 24 * 60 * 60_000).toISOString() });
  let state = await readThreadsRuntime(f);
  assert.equal(state.workers.benefits.ready, true);
  assert.equal(state.workers.benefits.cooldownReason, 'http_429_rate_limit');
  assert.equal(state.workers.benefits.deadlineSource, 'server_hint');
  assert.equal(state.workers.benefits.fallbackMilliseconds, null);

  await f.put(spec, prior.workers.benefits.pid, { status: 'cooldown', httpStatus: 429,
    cooldownReason: 'http_429_rate_limit', deadlineSource: 'local_fallback_15_minutes',
    fallbackMilliseconds: 15 * 60_000, retryAt: new Date(now + 15 * 60_000).toISOString() });
  state = await readThreadsRuntime(f);
  assert.equal(state.workers.benefits.ready, true);
  assert.equal(state.workers.benefits.deadlineSource, 'local_fallback_15_minutes');
  assert.equal(state.workers.benefits.fallbackMilliseconds, 15 * 60_000);
});

test('a tagged local read-budget deadline beyond its configured hour does not keep an old worker fresh', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  const prior = await readThreadsRuntime(f), spec = f.paths.workers[0], pid = prior.workers.benefits.pid;
  const now = Date.now();
  await f.put(spec, pid, { status: 'waiting_for_read_budget', code: 'THREADS_READ_BUDGET_WAIT', httpStatus: 200,
    cooldownReason: 'shared_read_budget', deadlineSource: 'local_budget', retryAt: new Date(now + 2 * 60 * 60_000).toISOString() });
  const old = new Date(now - 31 * 60_000);
  await utimes(path.join(spec.root, 'worker-status.json'), old, old);
  const state = await readThreadsRuntime(f);
  assert.equal(state.workers.benefits.ready, false);
  assert.equal(state.workers.benefits.cooldownReason, 'shared_read_budget');
  assert.equal(state.workers.benefits.deadlineSource, 'local_budget');
});

test('session-lock waits report process readiness scope and preserve their safe transient cause', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  const prior = await readThreadsRuntime(f), spec = f.paths.workers[0];
  await f.put(spec, prior.workers.benefits.pid, { status: 'waiting_for_session', lastTransientCode: 'META_SESSION_BUSY' });
  const state = await readThreadsRuntime(f);
  assert.equal(state.ready, true);
  assert.equal(state.readinessScope, 'process_presence_and_recorded_startup_read_gates');
  assert.equal(state.workers.benefits.lastTransientCode, 'META_SESSION_BUSY');
});

test('a STOP arriving during owner preflight cancels start and remains authoritative', async t => {
  const f = await fixture(t);
  f.dependencies.auth = async () => {
    await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation: 'new_stop' }));
    await writeFile(path.join(f.paths.root, 'STOP'), 'new_stop');
    return { authenticated: true, ownerVerified: true, httpStatus: 200 };
  };
  await assert.rejects(runThreadsRuntime('start', f), { code: 'THREADS_RUNTIME_STOPPED' });
  assert.equal(f.launches.length, 0); assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), true);
});

test('failed owner verification makes zero launches and lifecycle status never checks credentials', async t => {
  const f = await fixture(t); let authCalls = 0;
  f.dependencies.auth = async () => { authCalls++; return { authenticated: false, ownerVerified: false, httpStatus: 401 }; };
  await assert.rejects(runThreadsRuntime('start', f), { code: 'THREADS_RUNTIME_OWNER_UNVERIFIED' });
  assert.equal(f.launches.length, 0);
  await readThreadsRuntime(f); await runThreadsRuntime('status', f); assert.equal(authCalls, 1);
});

test('stop reports completion only after actual worker and monitor exit', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  let result = await runThreadsRuntime('stop', { ...f, timeoutMs: 0 });
  assert.equal(result.stopVerified, false); assert.equal(result.status, 'stopping');
  f.live.clear(); result = await runThreadsRuntime('stop', f);
  assert.equal(result.stopVerified, true); assert.equal(result.status, 'stopped');
});

test('a queued stop interrupts a start instead of waiting for startup to finish', async t => {
  const f = await fixture(t); let entered;
  const entering = new Promise(resolve => { entered = resolve; });
  f.dependencies.auth = async () => {
    entered();
    while (!await threadsFileExists(path.join(f.paths.root, 'STOP'))) await new Promise(resolve => setTimeout(resolve, 5));
    return { authenticated: true, ownerVerified: true, httpStatus: 200 };
  };
  const starting = runThreadsRuntime('start', f);
  const rejected = assert.rejects(starting, { code: 'THREADS_RUNTIME_STOPPED' });
  await entering; const stopping = runThreadsRuntime('stop', f);
  await rejected; assert.equal((await stopping).stopVerified, true); assert.equal(f.launches.length, 0);
});

test('scheduled monitoring defers repair during controller startup and STOP still wins', () => {
  assert.equal(threadsWatchdogDecision({ running: false, startupPending: true, stopped: false, status: { status: 'stopped' } }).action, 'starting');
  assert.equal(threadsWatchdogDecision({ running: false, startupPending: true, stopped: true, status: { status: 'stopped' } }).action, 'user_stopped');
  assert.equal(threadsWatchdogDecision({ running: true, startupPending: true, stopped: false,
    status: { status: 'running', workerStarted: true }, previous: { attempts: 3 } }).attempts, 0);
});

test('a stop arriving during final PID readback cannot be reported as startup success', async t => {
  const f = await fixture(t), original = f.dependencies.presence; let signalled = false;
  f.dependencies.presence = async (spec, pid) => {
    if (!signalled && spec.name === 'outreach' && f.launches.length === 3) {
      signalled = true;
      await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation: 'during_readback' }));
      await writeFile(path.join(f.paths.root, 'STOP'), 'during_readback');
    }
    return original(spec, pid);
  };
  await assert.rejects(runThreadsRuntime('start', f), { code: 'THREADS_RUNTIME_STOPPED' });
  assert.equal(signalled, true); assert.equal((await readThreadsRuntime(f)).ready, false);
});

test('a live prepared-only outreach is not ready and is replaced only after normal stop and actual exit', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  const prior = await readThreadsRuntime(f), pid = prior.workers.outreach.pid;
  await f.put(f.paths.workers[1], pid, { mode: 'prepared_only' });
  assert.equal((await readThreadsRuntime(f)).ready, false);
  f.dependencies.sleep = async () => {
    assert.equal(await threadsFileExists(path.join(f.paths.workers[1].root, 'worker-STOP')), true);
    f.live.delete(pid);
  };
  assert.equal((await runThreadsRuntime('start', f)).ready, true);
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach', 'outreach']);
});

test('prepared-only transition preserves a standalone STOP that replaces its temporary marker', async t => {
  const f = await fixture(t), spec = f.paths.workers.find(value => value.name === 'outreach'), pid = 81235;
  f.live.set(pid, 'outreach');
  await f.put(spec, pid, { mode: 'prepared_only' });
  const ownerStop = JSON.stringify({ reason: 'owner explicitly paused Threads outreach' });
  let replaced = false;
  f.dependencies.sleep = async () => {
    if (!replaced) {
      replaced = true;
      await writeFile(path.join(spec.root, 'worker-STOP'), ownerStop);
      f.live.delete(pid);
      await f.put(spec, pid, { status: 'stopped', mode: 'prepared_only' });
    }
  };

  const result = await runThreadsRuntime('start', f);

  assert.equal(replaced, true);
  assert.equal(await readFile(path.join(spec.root, 'worker-STOP'), 'utf8'), ownerStop);
  assert.deepEqual(f.launches, ['watchdog', 'benefits']);
  assert.equal(result.workers.outreach.stopped, true);
  assert.equal(result.ready, false);
});

test('a newer root STOP releases only the transition marker so a later start can launch outreach', async t => {
  const f = await fixture(t), spec = f.paths.workers.find(value => value.name === 'outreach'), pid = 81236;
  const generation = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  f.live.set(pid, 'outreach');
  await f.put(spec, pid, { mode: 'prepared_only' });
  let signalled = false;
  f.dependencies.sleep = async () => {
    if (signalled) return;
    signalled = true;
    await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation }));
    await writeFile(path.join(f.paths.root, 'STOP'), generation);
    f.live.delete(pid);
    await f.put(spec, pid, { status: 'stopped', mode: 'prepared_only' });
  };

  await assert.rejects(runThreadsRuntime('start', f), { code: 'THREADS_RUNTIME_STOPPED' });
  assert.equal((await readFile(path.join(f.paths.root, 'STOP'), 'utf8')).trim(), generation);
  await assert.rejects(readFile(path.join(spec.root, 'worker-STOP'), 'utf8'), { code: 'ENOENT' },
    'the cancelled start must release its own temporary transition marker');

  const next = await runThreadsRuntime('start', f);
  assert.equal(next.ready, true);
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach']);
  assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), false);
  assert.equal(await threadsFileExists(path.join(spec.root, 'worker-STOP')), false);
});

test('cancellation cleanup never removes a replacement owner STOP marker', async t => {
  const f = await fixture(t), spec = f.paths.workers.find(value => value.name === 'outreach'), pid = 81237;
  const generation = 'cccccccc-dddd-4eee-8fff-000000000001';
  const ownerStop = JSON.stringify({ reason: 'owner paused outreach during transition' });
  f.live.set(pid, 'outreach');
  await f.put(spec, pid, { mode: 'prepared_only' });
  f.dependencies.sleep = async () => {
    await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation }));
    await writeFile(path.join(f.paths.root, 'STOP'), generation);
    await writeFile(path.join(spec.root, 'worker-STOP'), ownerStop);
    f.live.delete(pid);
  };

  await assert.rejects(runThreadsRuntime('start', f), { code: 'THREADS_RUNTIME_STOPPED' });

  assert.equal((await readFile(path.join(spec.root, 'worker-STOP'), 'utf8')), ownerStop);
  assert.equal((await readFile(path.join(f.paths.root, 'STOP'), 'utf8')).trim(), generation);
});

test('restart confirms every old process exited before launching the updated workers', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f); let authCalls = 0;
  f.dependencies.auth = async () => {
    authCalls++;
    assert.equal(f.live.size, 3, 'owner preflight occurs before stopping the current runtime');
    assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), false);
    return { authenticated: true, ownerVerified: true, httpStatus: 200 };
  };
  f.dependencies.sleep = async () => { f.live.clear(); };
  const result = await runThreadsRuntime('restart', f);
  assert.equal(result.ready, true); assert.equal(result.restartPerformed, true); assert.equal(authCalls, 1);
  assert.deepEqual(f.launches, ['watchdog', 'benefits', 'outreach', 'watchdog', 'benefits', 'outreach']);
});

test('restart owner read-budget failure preserves current workers and writes no stop markers', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f); let authCalls = 0;
  f.dependencies.auth = async () => {
    authCalls++;
    throw Object.assign(new Error('THREADS_READ_BUDGET_WAIT'), { code: 'THREADS_READ_BUDGET_WAIT', retryAt: f.dependencies.now() + 30_000 });
  };
  const before = await readThreadsRuntime(f);
  const result = await runThreadsRuntime('restart', f);
  assert.equal(result.restartPerformed, false);
  assert.equal(result.code, 'THREADS_READ_BUDGET_WAIT');
  assert.equal(result.restartPreflight.passed, false);
  assert.equal(result.restartPreflight.retryAt, new Date(f.dependencies.now() + 30_000).toISOString());
  assert.equal(result.ready, before.ready);
  assert.equal(result.readinessScope, 'process_presence_and_recorded_startup_read_gates');
  assert.equal(authCalls, 1);
  assert.equal(f.live.size, 3);
  assert.equal(f.launches.length, 3);
  assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), false);
  assert.equal(await threadsFileExists(path.join(f.paths.root, 'stop-request.json')), false);
  for (const spec of f.paths.workers) assert.equal(await threadsFileExists(path.join(spec.root, 'worker-STOP')), false);
});

test('restart preflight recheck respects a newer STOP without stopping or launching workers', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f); let authCalls = 0;
  f.dependencies.auth = async () => {
    authCalls++;
    await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation: 'newer_stop' }));
    await writeFile(path.join(f.paths.root, 'STOP'), 'newer_stop');
    return { authenticated: true, ownerVerified: true, httpStatus: 200 };
  };
  const result = await runThreadsRuntime('restart', f);
  assert.equal(result.restartPerformed, false);
  assert.equal(result.code, 'THREADS_RUNTIME_STOP_REQUESTED');
  assert.equal(result.ready, false);
  assert.equal(result.readinessScope, 'process_presence_and_recorded_startup_read_gates');
  assert.equal(authCalls, 1); assert.equal(f.live.size, 3); assert.equal(f.launches.length, 3);
  assert.equal(await readFile(path.join(f.paths.root, 'stop-request.json'), 'utf8').then(JSON.parse).then(x => x.generation), 'newer_stop');
  assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), true);
});

test('a new user stop between restart shutdown and startup is never cleared', async t => {
  const f = await fixture(t); await runThreadsRuntime('start', f);
  f.dependencies.sleep = async () => { f.live.clear(); };
  f.dependencies.lock = async (operation, options) => {
    const result = await withSessionLock(operation, options);
    if (result.stopVerified) {
      await writeFile(path.join(f.paths.root, 'stop-request.json'), JSON.stringify({ generation: 'newer_user_stop' }));
      await writeFile(path.join(f.paths.root, 'STOP'), 'newer_user_stop');
    }
    return result;
  };
  const result = await runThreadsRuntime('restart', f);
  assert.equal(result.restartPerformed, false); assert.equal(result.code, 'THREADS_RUNTIME_STOP_REQUESTED');
  assert.equal(f.launches.length, 3); assert.equal(await threadsFileExists(path.join(f.paths.root, 'STOP')), true);
});
