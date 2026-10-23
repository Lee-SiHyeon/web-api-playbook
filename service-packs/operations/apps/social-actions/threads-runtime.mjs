import { readFile, writeFile, mkdir, rename, unlink, stat, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withSessionLock } from '../tistory-api/lib/lock.mjs';
import { verifyThreadsRuntimeOwner } from './lib/threads-runtime-owner.mjs';
import { readThreadsWorkerPresence, readThreadsProcessPresence, threadsProcessKey } from './threads-watchdog.mjs';
import { threadsRuntimePaths, threadsFileExists, threadsPidAlive } from './lib/threads-runtime-control.mjs';
import { isThreadsLocalReadBudgetStatus, threadsRecognizedWaitState } from './lib/threads-local-recovery.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const OWNER_PREFLIGHT = Symbol('threads-runtime-owner-preflight');
const RESTART_STOP_FENCE = Symbol('threads-runtime-restart-stop-fence');
const normal = new Set(['running', 'waiting_for_queue', 'waiting_for_candidates', 'waiting_for_session', 'waiting_for_network', 'waiting_for_read_budget', 'cooldown']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const observedEntryScript = process.argv[1] ? path.basename(process.argv[1]) : '';
const safeObservedEntryScript = /^[a-z0-9][a-z0-9_.-]{0,100}\.mjs$/i.test(observedEntryScript) ? observedEntryScript : null;
const json = async (file, fallback = {}) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const atomic = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, file);
};
const defaults = {
  now: Date.now, sleep: delay, presence: readThreadsWorkerPresence, pidAlive: threadsPidAlive,
  lock: (fn, options) => withSessionLock(fn, { ...options, ...(safeObservedEntryScript ? { ownerScript: safeObservedEntryScript } : {}) }),
  auth: verifyThreadsRuntimeOwner,
  launch: async spec => {
    const child = spawn(process.execPath, [path.join(directory, spec.script), ...spec.args],
      { cwd: path.resolve(directory, '../..'), windowsHide: true, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); return child.pid;
  },
};

export async function readThreadsRuntime({ paths = threadsRuntimePaths(), dependencies = {} } = {}) {
  const deps = { ...defaults, ...dependencies }, now = deps.now();
  const launch = await json(path.join(paths.root, 'runtime-launch.json'));
  const stopped = await threadsFileExists(path.join(paths.root, 'STOP'));
  let probeCache = null;
  if (deps.presence === readThreadsWorkerPresence) {
    const snapshots = await Promise.all([...paths.workers, paths.monitor].map(async spec => {
      const monitor = spec.name === 'watchdog';
      const [status, lock] = await Promise.all([json(path.join(spec.root, monitor ? 'status.json' : 'worker-status.json')),
        json(path.join(spec.root, monitor ? 'watchdog.lock' : 'worker.lock'))]);
      return [status.pid, lock.pid, launch[spec.name]?.pid].map(pid => ({ spec, pid }));
    }));
    probeCache = await readThreadsProcessPresence(snapshots.flat());
  }
  async function read(spec, monitor = false) {
    const statusFile = path.join(spec.root, monitor ? 'status.json' : 'worker-status.json');
    const status = await json(statusFile), lock = await json(path.join(spec.root, monitor ? 'watchdog.lock' : 'worker.lock'));
    const candidates = [...new Set([status.pid, lock.pid, launch[spec.name]?.pid].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    const present = await Promise.all(candidates.map(pid => probeCache?.has(threadsProcessKey(spec, pid))
      ? deps.pidAlive(pid) ? probeCache.get(threadsProcessKey(spec, pid)) : false : deps.presence(spec, pid)));
    const index = present.indexOf(true), alive = index >= 0 ? true : present.includes(null) ? null : false;
    const pid = index >= 0 ? candidates[index] : status.pid || launch[spec.name]?.pid || null;
    const stoppedHere = stopped || (!monitor && await threadsFileExists(path.join(spec.root, 'worker-STOP')));
    const updatedAt = await stat(statusFile).then(value => value.mtimeMs).catch(error => { if (error.code === 'ENOENT') return 0; throw error; });
    const taggedLocalReadBudget = isThreadsLocalReadBudgetStatus(status);
    const taggedHttp429Fallback = status.status === 'cooldown' && status.httpStatus === 429 && !status.code
      && status.cooldownReason === 'http_429_rate_limit' && status.deadlineSource === 'local_fallback_15_minutes'
      && status.fallbackMilliseconds === 15 * 60_000;
    const recognizedWait = threadsRecognizedWaitState(status, now);
    const fresh = monitor ? now - Date.parse(status.checkedAt || status.startedAt || '') <= 120_000
      : now - updatedAt <= 30 * 60_000 || recognizedWait;
    const readGatesPassed = !monitor && status.pid === pid && status.workerStarted === true;
    const ready = alive === true && !stoppedHere && status.pid === pid && fresh
      && (monitor ? status.status === 'running' : readGatesPassed && normal.has(status.status) && status.indefinite === true && status.expiresAt === null
        && (!status.code && !['cooldown', 'waiting_for_read_budget'].includes(status.status) || recognizedWait)
        && (spec.name !== 'outreach' || status.mode === 'execute_explicit'));
    return { pid, processAlive: alive, statusMatchesProcess: alive === true && status.pid === pid,
      status: status.status || 'missing', ready, readGatesPassed, stopped: stoppedHere,
      indefinite: status.indefinite === true, expiresAt: status.expiresAt ?? null, mode: status.mode || null,
      code: /^[A-Z][A-Z0-9_]+$/.test(status.code || '') ? status.code : null,
      httpStatus: Number.isInteger(status.httpStatus) && !taggedLocalReadBudget ? status.httpStatus : null,
      retryAt: Number.isFinite(Date.parse(status.retryAt || '')) ? status.retryAt : null,
      cooldownReason: ['graphql_200_rate_limit', 'shared_read_budget', 'http_429_rate_limit'].includes(status.cooldownReason) ? status.cooldownReason : null,
      deadlineSource: ['server_hint', 'local_fallback', 'local_fallback_15_minutes', 'local_backoff', 'local_budget'].includes(status.deadlineSource) ? status.deadlineSource : null,
      fallbackMilliseconds: taggedHttp429Fallback ? status.fallbackMilliseconds : null,
      lastTransientCode: /^[A-Z][A-Z0-9_]+$/.test(status.lastTransientCode || '') ? status.lastTransientCode : null,
      lastPollAt: status.lastPollAt || null, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      ...(monitor ? { checkedAt: status.checkedAt || null,
        workers: Object.fromEntries(Object.entries(status.workers || {}).map(([name, value]) => [name,
          { action: value.action, workerAlive: value.workerAlive, code: value.code || null, attempts: value.attempts || 0 }])) } : {}) };
  }
  const results = await Promise.allSettled([...paths.workers.map(spec => read(spec)), read(paths.monitor, true)]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const workers = Object.fromEntries(paths.workers.map((spec, i) => [spec.name, results[i].value]));
  const watchdog = results.at(-1).value;
  const finalStopped = stopped || await threadsFileExists(path.join(paths.root, 'STOP'));
  for (const spec of paths.workers) if (finalStopped || await threadsFileExists(path.join(spec.root, 'worker-STOP'))) {
    workers[spec.name].stopped = true; workers[spec.name].ready = false;
  }
  if (finalStopped) { watchdog.stopped = true; watchdog.ready = false; }
  const ready = !finalStopped && watchdog.ready && Object.values(workers).every(value => value.ready);
  return { service: 'threads', checkedAt: new Date(deps.now()).toISOString(),
    readinessScope: 'process_presence_and_recorded_startup_read_gates',
    status: ready ? 'running' : finalStopped ? 'stopped_or_stopping' : 'pending_or_blocked',
    ready, stopped: finalStopped, workers, watchdog };
}

const sameStopFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;

async function readStopMarker(file) {
  let before;
  try { before = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; return { unreadable: true }; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024) return { unreadable: true, stat: before };
  try {
    const raw = await readFile(file, 'utf8'), after = await lstat(file);
    if (!sameStopFile(before, after)) return { unreadable: true, stat: after };
    return { value: raw.trim(), stat: after };
  } catch (error) { if (error.code === 'ENOENT') return null; return { unreadable: true, stat: before }; }
}

async function removeStopMarkerIfUnchanged(file, observed) {
  const current = await readStopMarker(file);
  if (!observed || !current || current.unreadable || current.value !== observed.value
    || !sameStopFile(observed.stat, current.stat)) return false;
  try { await unlink(file); return true; }
  catch (error) { return error.code === 'ENOENT'; }
}

async function clearOwnedWorkerStops(paths, { globalStop, generation }) {
  for (const spec of paths.workers) {
    const file = path.join(spec.root, 'worker-STOP'), marker = await readStopMarker(file);
    if (!marker) continue;
    if (marker.unreadable) fail('THREADS_RUNTIME_STOP_MARKER_IDENTITY_PENDING');
    const ownedByGlobalStop = globalStop && marker.value === globalStop.value;
    const residualGenerationMarker = !globalStop && generation && marker.value === generation;
    if (!ownedByGlobalStop && !residualGenerationMarker) continue;
    if (!await removeStopMarkerIfUnchanged(file, marker)) fail('THREADS_RUNTIME_STOP_MARKER_CHANGED');
  }
}

const stopSignalLockOptions = paths => ({ lockPath: path.join(paths.root, 'stop-signal.lock'), timeoutMs: 180_000, pollMs: 100 });
const isStopGeneration = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

async function setStopMarkerGeneration(file, generation, previousGeneration, { required = false } = {}) {
  const marker = await readStopMarker(file);
  if (marker?.unreadable) fail('THREADS_RUNTIME_STOP_MARKER_IDENTITY_PENDING');
  if (marker?.value === generation) return true;
  if (marker && (!previousGeneration || marker.value !== previousGeneration)) {
    if (required) fail('THREADS_RUNTIME_STOP_GENERATION_CHANGED');
    return false;
  }
  if (marker && !await removeStopMarkerIfUnchanged(file, marker)) fail('THREADS_RUNTIME_STOP_MARKER_CHANGED');
  try { await writeFile(file, generation, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') {
      if (required) fail('THREADS_RUNTIME_STOP_MARKER_CHANGED');
      return false;
    }
    throw error;
  }
  const created = await readStopMarker(file);
  if (created?.unreadable || created?.value !== generation) {
    if (required) fail('THREADS_RUNTIME_STOP_MARKER_IDENTITY_PENDING');
    return false;
  }
  return true;
}

async function completeStopGenerationTransition(paths, generationFile, transition) {
  const current = await json(generationFile);
  if (current.generation !== transition.generation || current.transition !== 'pending'
    || (current.previousGeneration ?? null) !== (transition.previousGeneration ?? null)) fail('THREADS_RUNTIME_STOPPED');

  await setStopMarkerGeneration(path.join(paths.root, 'STOP'), transition.generation,
    transition.previousGeneration ?? null, { required: true });
  for (const spec of paths.workers) {
    await mkdir(spec.root, { recursive: true });
    await setStopMarkerGeneration(path.join(spec.root, 'worker-STOP'), transition.generation,
      transition.previousGeneration ?? null);
  }

  const rootStop = await readStopMarker(path.join(paths.root, 'STOP'));
  const latest = await json(generationFile);
  if (rootStop?.unreadable || rootStop?.value !== transition.generation
    || latest.generation !== transition.generation || latest.transition !== 'pending') fail('THREADS_RUNTIME_STOP_MARKER_CHANGED');
  await atomic(generationFile, { generation: transition.generation });
}

async function beginStopGeneration(paths, generationFile, deps, expectedGeneration, restartStopFence) {
  return deps.lock(async () => {
    let request = await json(generationFile), generation = request.generation || null;
    if (expectedGeneration !== undefined && generation !== expectedGeneration) fail('THREADS_RUNTIME_STOPPED');
    if (restartStopFence) {
      const currentFence = await readRestartStopFence(paths);
      if (currentFence.generation !== restartStopFence.generation || currentFence.markers.length) {
        fail('THREADS_RUNTIME_RESTART_PRECONDITION_CHANGED');
      }
    }
    if (request.transition === 'pending') {
      if (!isStopGeneration(generation)) fail('THREADS_RUNTIME_STOP_GENERATION_CHANGED');
      await completeStopGenerationTransition(paths, generationFile, request);
      return generation;
    }

    const rootStop = await readStopMarker(path.join(paths.root, 'STOP'));
    if (rootStop?.unreadable) fail('THREADS_RUNTIME_STOP_MARKER_IDENTITY_PENDING');
    const previousGeneration = rootStop && isStopGeneration(generation) && rootStop.value === generation ? generation : null;
    if (rootStop && !previousGeneration) fail('THREADS_RUNTIME_STOP_GENERATION_CHANGED');
    generation = randomUUID();
    const transition = { generation, transition: 'pending', ...(previousGeneration ? { previousGeneration } : {}) };
    await atomic(generationFile, transition);
    await completeStopGenerationTransition(paths, generationFile, transition);
    return generation;
  }, stopSignalLockOptions(paths));
}

async function writeStops(paths, generation, generationFile) {
  const request = await json(generationFile), rootStop = await readStopMarker(path.join(paths.root, 'STOP'));
  if (request.generation !== generation || request.transition === 'pending'
    || rootStop?.unreadable || rootStop?.value !== generation) return false;
  for (const spec of paths.workers) {
    await mkdir(spec.root, { recursive: true });
    await setStopMarkerGeneration(path.join(spec.root, 'worker-STOP'), generation, null);
  }
  const latest = await json(generationFile), currentStop = await readStopMarker(path.join(paths.root, 'STOP'));
  return latest.generation === generation && latest.transition !== 'pending'
    && !currentStop?.unreadable && currentStop?.value === generation;
}

async function stopGenerationIsCurrent(paths, generationFile, generation) {
  const request = await json(generationFile), rootStop = await readStopMarker(path.join(paths.root, 'STOP'));
  return request.generation === generation && request.transition !== 'pending'
    && !rootStop?.unreadable && rootStop?.value === generation;
}

async function readRestartStopFence(paths) {
  const generation = (await json(path.join(paths.root, 'stop-request.json'))).generation || null;
  const markers = [];
  if (await threadsFileExists(path.join(paths.root, 'STOP'))) markers.push('root');
  for (const spec of paths.workers) if (await threadsFileExists(path.join(spec.root, 'worker-STOP'))) markers.push(spec.name);
  return { generation, markers };
}

function safeRuntimeErrorCode(error, fallback) {
  return /^[A-Z][A-Z0-9_]+$/.test(error?.code || '') ? error.code : fallback;
}

function safeRuntimeRetryAt(error) {
  const raw = error?.retryAt ?? error?.receipt?.readBudgetRetryAt;
  const retryAt = typeof raw === 'number' ? raw : Date.parse(raw || '');
  const date = new Date(retryAt);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function runThreadsRuntime(command, options = {}) {
  const { paths = threadsRuntimePaths(), dependencies = {}, timeoutMs = 300_000, expectedStopGeneration,
    [OWNER_PREFLIGHT]: ownerPreflight = null, [RESTART_STOP_FENCE]: restartStopFence = null } = options;
  const deps = { ...defaults, ...dependencies };
  if (!['start', 'stop', 'status', 'restart'].includes(command) || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) fail('THREADS_RUNTIME_ARGUMENT');
  const read = () => readThreadsRuntime({ paths, dependencies: deps });
  if (command === 'restart') {
    const blocked = async (code, phase, details = {}) => ({ ...(await read()), code, restartPerformed: false,
      restartPreflight: { passed: false, phase, code, ...details } });
    const before = await readRestartStopFence(paths);
    if (expectedStopGeneration !== undefined && before.generation !== expectedStopGeneration) {
      return blocked('THREADS_RUNTIME_STOP_GENERATION_CHANGED', 'stop_precondition');
    }
    if (before.markers.length) return blocked('THREADS_RUNTIME_STOP_REQUESTED', 'stop_precondition', { markers: before.markers });

    let auth;
    try { auth = await deps.auth(); }
    catch (error) { return blocked(safeRuntimeErrorCode(error, 'THREADS_RUNTIME_OWNER_PREFLIGHT_FAILED'), 'owner_preflight',
      { retryAt: safeRuntimeRetryAt(error) }); }
    if (auth?.authenticated !== true || auth.ownerVerified !== true || auth.httpStatus !== 200) {
      return blocked('THREADS_RUNTIME_OWNER_UNVERIFIED', 'owner_preflight');
    }

    const afterAuth = await readRestartStopFence(paths);
    if (afterAuth.markers.length || afterAuth.generation !== before.generation) {
      return blocked(afterAuth.markers.length ? 'THREADS_RUNTIME_STOP_REQUESTED' : 'THREADS_RUNTIME_STOP_GENERATION_CHANGED',
        'stop_precondition', { markers: afterAuth.markers });
    }

    let stopped;
    try {
      stopped = await runThreadsRuntime('stop', { paths, dependencies, timeoutMs, [RESTART_STOP_FENCE]: before });
    } catch (error) {
      if (['THREADS_RUNTIME_RESTART_PRECONDITION_CHANGED', 'THREADS_RUNTIME_STOPPED'].includes(error?.code)) {
        return blocked('THREADS_RUNTIME_STOP_GENERATION_CHANGED', 'stop_precondition');
      }
      throw error;
    }
    if (!stopped.stopVerified) return { ...stopped, restartPerformed: false,
      restartPreflight: { passed: true, phase: 'owner_preflight', code: null } };
    try {
      const started = await runThreadsRuntime('start', { paths, dependencies, timeoutMs,
        expectedStopGeneration: stopped.stopGeneration, [OWNER_PREFLIGHT]: auth });
      return { ...started, restartPerformed: true,
        restartPreflight: { passed: true, phase: 'owner_preflight', code: null } };
    } catch (error) {
      if (error?.code === 'THREADS_RUNTIME_STOPPED') {
        return blocked('THREADS_RUNTIME_STOP_REQUESTED', 'start_precondition');
      }
      throw error;
    }
  }
  if (command === 'status') return read();
  await mkdir(paths.root, { recursive: true });
  const generationFile = path.join(paths.root, 'stop-request.json');
  const initialRequest = await json(generationFile);
  let baseline = initialRequest.generation || null;
  if (expectedStopGeneration !== undefined && baseline !== expectedStopGeneration) fail('THREADS_RUNTIME_STOPPED');
  if (command === 'start' && initialRequest.transition === 'pending') fail('THREADS_RUNTIME_STOPPED');
  if (command === 'stop') {
    if (restartStopFence) {
      // The signal lease repeats this check so an external stop cannot slip into the restart window.
      const currentFence = await readRestartStopFence(paths);
      if (currentFence.generation !== restartStopFence.generation || currentFence.markers.length) {
        fail('THREADS_RUNTIME_RESTART_PRECONDITION_CHANGED');
      }
    }
    // The short signal lease cancels a pending start before this request waits for
    // the longer runtime-control lease, and serializes overlapping stop writers.
    baseline = await beginStopGeneration(paths, generationFile, deps, expectedStopGeneration, restartStopFence);
  }
  try {
    return await deps.lock(async () => {
      const until = deps.now() + timeoutMs;
      const checkCancel = async () => {
        const current = await json(generationFile);
        if ((current.generation || null) !== baseline || current.transition === 'pending') fail('THREADS_RUNTIME_STOPPED');
      };
      const checkActive = async () => {
        await checkCancel();
      };
      const checkNoRuntimeStop = async () => {
        await checkActive();
        if (await threadsFileExists(path.join(paths.root, 'STOP'))) fail('THREADS_RUNTIME_STOPPED');
      };
      if (command === 'stop') {
        while (true) {
          const markersWritten = await deps.lock(() => writeStops(paths, baseline, generationFile), stopSignalLockOptions(paths));
          if (!markersWritten) return { ...(await read()), status: 'stopping', stopVerified: false,
            stopGeneration: baseline, code: 'THREADS_RUNTIME_STOPPED' };
          const state = await read();
          const monitor = await json(path.join(paths.root, 'status.json'));
          const exited = state.watchdog.processAlive === false && Object.values(state.workers).every(value => value.processAlive === false)
            && !deps.pidAlive(monitor.repairPid);
          if (exited || deps.now() >= until) {
            const stillCurrent = await deps.lock(() => stopGenerationIsCurrent(paths, generationFile, baseline), stopSignalLockOptions(paths));
            if (!stillCurrent) return { ...state, status: 'stopping', stopVerified: false,
              stopGeneration: baseline, code: 'THREADS_RUNTIME_STOPPED' };
            return { ...state, status: exited ? 'stopped' : 'stopping', stopVerified: exited, stopGeneration: baseline };
          }
          await deps.sleep(1000);
        }
      }
      await checkCancel();
      // A stopping monitor must exit before STOP is cleared: it can still be
      // reasserting generation-owned worker markers. Independent worker STOPs
      // remain authoritative and do not prevent unaffected workers starting.
      while (true) {
        const state = await read(), monitor = await json(path.join(paths.root, 'status.json'));
        const stopping = state.stopped && (state.watchdog.processAlive !== false || deps.pidAlive(monitor.repairPid))
          || Object.values(state.workers).some(value => value.stopped && value.processAlive !== false);
        if (!stopping) break;
        if (deps.now() >= until) return { ...state, code: 'THREADS_RUNTIME_STOP_COMPLETION_PENDING' };
        await checkCancel(); await deps.sleep(1000);
      }
      await checkCancel();
      const authReceipt = ownerPreflight || await deps.auth();
      if (authReceipt?.authenticated !== true || authReceipt.ownerVerified !== true || authReceipt.httpStatus !== 200) fail('THREADS_RUNTIME_OWNER_UNVERIFIED');
      await checkActive();
      const rootStopFile = path.join(paths.root, 'STOP'), rootStop = await readStopMarker(rootStopFile);
      if (rootStop?.unreadable) fail('THREADS_RUNTIME_STOP_MARKER_IDENTITY_PENDING');
      let ownedGlobalStop = null;
      if (rootStop) {
        if (baseline && rootStop.value === baseline) ownedGlobalStop = rootStop;
        else fail('THREADS_RUNTIME_STOP_GENERATION_CHANGED');
      }
      await clearOwnedWorkerStops(paths, { globalStop: ownedGlobalStop, generation: baseline });
      if (ownedGlobalStop && !await removeStopMarkerIfUnchanged(rootStopFile, ownedGlobalStop)) {
        fail('THREADS_RUNTIME_STOP_MARKER_CHANGED');
      }
      await checkNoRuntimeStop();
      // An already live prepare-only process cannot satisfy an execute runtime.
      // Stop that process through its normal marker and verify its exit first.
      const beforeLaunch = await read(); await checkNoRuntimeStop();
      const outreachSpec = paths.workers.find(spec => spec.name === 'outreach');
      let transitionMarkerChanged = false;
      if (outreachSpec && !beforeLaunch.workers.outreach.stopped
        && beforeLaunch.workers.outreach.processAlive === true && beforeLaunch.workers.outreach.mode === 'prepared_only') {
        const transitionMarker = path.join(outreachSpec.root, 'worker-STOP');
        try { await writeFile(transitionMarker, 'authorized_execute_transition', { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code === 'EEXIST') return await read(); throw error; }
        const ownedTransitionMarker = await readStopMarker(transitionMarker);
        if (ownedTransitionMarker?.unreadable || ownedTransitionMarker?.value !== 'authorized_execute_transition') {
          fail('THREADS_RUNTIME_STOP_MARKER_IDENTITY_PENDING');
        }
        try {
          while (true) {
            await checkCancel();
            if (await threadsFileExists(path.join(paths.root, 'STOP'))) fail('THREADS_RUNTIME_STOPPED');
            const state = await read();
            if (state.workers.outreach.processAlive === false) break;
            if (deps.now() >= until) return { ...state, code: 'THREADS_RUNTIME_EXECUTE_TRANSITION_PENDING' };
            await deps.sleep(1000);
          }
          await checkCancel();
          if (!await removeStopMarkerIfUnchanged(transitionMarker, ownedTransitionMarker)) {
            const currentTransitionMarker = await readStopMarker(transitionMarker);
            if (!currentTransitionMarker || currentTransitionMarker.unreadable) fail('THREADS_RUNTIME_STOP_MARKER_CHANGED');
            transitionMarkerChanged = true;
          }
        } catch (error) {
          let superseded = false;
          try {
            const currentRequest = await json(generationFile);
            const rootSignal = await readStopMarker(path.join(paths.root, 'STOP'));
            superseded = (currentRequest.generation || null) !== baseline || currentRequest.transition === 'pending'
              || Boolean(rootSignal && !rootSignal.unreadable);
          } catch { /* Preserve the marker when ownership of the global stop is unknown. */ }
          if (superseded) {
            try { await removeStopMarkerIfUnchanged(transitionMarker, ownedTransitionMarker); }
            catch { /* Preserve the original cancellation/error and never replace a changed marker. */ }
          }
          throw error;
        }
      }
      const launches = await json(path.join(paths.root, 'runtime-launch.json'));
      for (const spec of [paths.monitor, ...paths.workers]) {
        await checkNoRuntimeStop();
        if (spec.name !== 'watchdog' && await threadsFileExists(path.join(spec.root, 'worker-STOP'))) continue;
        const state = await read(), current = spec.name === 'watchdog' ? state.watchdog : state.workers[spec.name];
        await checkNoRuntimeStop();
        if (current.processAlive === null) return { ...state, code: 'THREADS_RUNTIME_PROCESS_IDENTITY_PENDING' };
        if (current.processAlive === false) {
          if (spec.name !== 'watchdog' && await threadsFileExists(path.join(spec.root, 'worker-STOP'))) continue;
          launches[spec.name] = { pid: await deps.launch(spec), launchedAt: new Date(deps.now()).toISOString(), script: spec.script };
          await atomic(path.join(paths.root, 'runtime-launch.json'), launches); await checkNoRuntimeStop();
        }
      }
      while (true) {
        await checkNoRuntimeStop();
        const state = await read();
        await checkNoRuntimeStop();
        const workerRows = Object.values(state.workers);
        const activeWorkersReady = workerRows.filter(value => !value.stopped).every(value => value.ready);
        const currentTerminalFailure = workerRows.some(value => value.processAlive === true && value.statusMatchesProcess
          && ['blocked', 'waiting_for_reply_restriction'].includes(value.status));
        if (state.ready || state.watchdog.ready && activeWorkersReady || currentTerminalFailure || deps.now() >= until) {
          return transitionMarkerChanged ? { ...state, code: 'THREADS_RUNTIME_STOP_MARKER_CHANGED' } : state;
        }
        await deps.sleep(1000);
      }
    }, { lockPath: paths.controlLock, timeoutMs: 180_000, pollMs: 250 });
  } catch (error) {
    if (error.code === 'TISTORY_SESSION_BUSY') fail('THREADS_RUNTIME_CONTROL_BUSY');
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runThreadsRuntime(process.argv[2] || 'status').then(value => {
    console.log(JSON.stringify(value));
    if (process.argv[2] === 'start' && !value.ready || process.argv[2] === 'restart' && (!value.ready || value.restartPerformed !== true)
      || process.argv[2] === 'stop' && !value.stopVerified) process.exitCode = 2;
  }).catch(error => {
    console.log(JSON.stringify({ service: 'threads', ready: false, code: /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'THREADS_RUNTIME_FAILED' }));
    process.exitCode = 2;
  });
}
