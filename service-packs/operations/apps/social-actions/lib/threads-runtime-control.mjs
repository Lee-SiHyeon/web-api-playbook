import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readBotProcessPresence, botProcessKey } from './bot-process-presence.mjs';

export function threadsRuntimePaths(base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations')) {
  const root = path.join(base, 'threads-watchdog');
  return { root, controlLock: path.join(root, 'runtime-control.lock'),
    monitor: { name: 'watchdog', root, script: 'threads-watchdog.mjs', args: ['run'] },
    workers: [
      { name: 'benefits', root: path.join(base, 'threads-benefits'), script: 'threads-benefit-worker.mjs', args: ['start', '--indefinite'] },
      { name: 'outreach', root: path.join(base, 'threads-benefits', 'outreach', 'worker'), script: 'threads-outreach-worker.mjs', args: ['start', '--execute', '--indefinite'] },
    ] };
}

export async function threadsFileExists(file) {
  try { await readFile(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function threadsStopRequested(workerRoot, paths = threadsRuntimePaths()) {
  return await threadsFileExists(path.join(paths.root, 'STOP'))
    || await threadsFileExists(path.join(workerRoot, 'worker-STOP'));
}

export function threadsPidAlive(pid, probe = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { probe(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

const legacyControllerScripts = Object.freeze([
  'threads-runtime.mjs', 'threads-watchdog.mjs', 'threads-restore-after-repair.mjs',
  'threads-basic-reload.mjs', 'recovery-threads-runtime.mjs',
]);
const safeScript = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]{0,100}\.mjs$/i.test(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
const controllerLockFresh = (info, now) => now - info.mtimeMs < 120_000;

async function defaultControllerPresence(pid, { script, pidAlive = threadsPidAlive, processReader } = {}) {
  if (!pidAlive(pid)) return false;
  // New controller leases record only the observed entry-script basename.
  // Legacy leases omit it; a live PID is then held unless a known exact entry
  // point is positively observed, never inferred stale from a negative guess.
  const scripts = script ? [script] : legacyControllerScripts;
  const specs = scripts.map(value => ({ script: value }));
  const result = await readBotProcessPresence(specs.map(spec => ({ spec, pid })),
    { pidAlive, processReader });
  const values = specs.map(spec => result.get(botProcessKey(spec, pid)));
  if (values.includes(true)) return true;
  return script ? values.includes(null) ? null : false : null;
}

// Only an exact live controller identity holds this lease indefinitely. Unknown
// process probes fail closed; a PID reused by another process is not an owner.
// Malformed recent files may be mid-write, while aged malformed files no longer
// represent an active controller and can be ignored by the watchdog.
export async function threadsRuntimeControllerActive(file, {
  pidAlive = threadsPidAlive, processReader, processPresence, now = Date.now(),
} = {}) {
  let initial;
  try { initial = await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return false; return true; }
  if (!initial.isFile() || initial.isSymbolicLink()) return true;

  let contents, value;
  try {
    contents = await readFile(file, 'utf8');
    value = JSON.parse(contents);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (!(error instanceof SyntaxError)) return true;
    const current = await lstat(file).catch(() => null);
    return current && sameFile(initial, current) ? controllerLockFresh(current, now) : true;
  }

  const afterRead = await lstat(file).catch(() => null);
  if (!afterRead || !sameFile(initial, afterRead)) return true;
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.nonce || '')
    || !Number.isFinite(Date.parse(value.startedAt || ''))
    || value.script != null && !safeScript(value.script)) return controllerLockFresh(afterRead, now);

  let identity;
  try {
    identity = processPresence
      ? await processPresence(value.pid)
      : await defaultControllerPresence(value.pid, { script: value.script, pidAlive, processReader });
  } catch { identity = null; }
  if (identity !== true && identity !== false && identity !== null) identity = null;
  const current = await lstat(file).catch(() => null);
  if (!current || !sameFile(initial, current)) return true;
  if (identity === true) return true;
  if (identity === false) return false;
  return true;
}
