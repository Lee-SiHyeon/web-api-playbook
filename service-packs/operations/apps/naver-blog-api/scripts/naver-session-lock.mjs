import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NAVER_SESSION_LOCK_FILENAME = 'naver-publisher-session.lock';
export const NAVER_SESSION_LOCK_MAX_WAIT_MS = 30_000;

let lastRecordTime = 0;

export function getNaverSessionLockPath({ localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') } = {}) {
  return path.join(localAppData, NAVER_SESSION_LOCK_FILENAME);
}

function monotonicNow() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lockError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function definitelyAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    // An unknown OS result is not sufficient evidence to evict a holder.
    return true;
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readSnapshot(lockPath) {
  let raw;
  let fileStat;
  try {
    raw = readFileSync(lockPath, 'utf8');
    fileStat = lstatSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw lockError('NAVER_SESSION_LOCK_FAILED');
  }
  if (!fileStat.isFile()) return { raw, fileStat, valid: false };
  let value;
  try { value = JSON.parse(raw); } catch { return { raw, fileStat, valid: false }; }
  const keys = value && typeof value === 'object' ? Object.keys(value).sort() : [];
  const valid = keys.length === 2 && keys[0] === 'at' && keys[1] === 'pid'
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at));
  return { raw, fileStat, value, valid };
}

function sameSnapshot(a, b) {
  return Boolean(a && b && a.raw === b.raw && sameFile(a.fileStat, b.fileStat));
}

async function acquireRecoveryGuard(lockPath, until, retryIntervalMs, hooks) {
  const recoveryPath = `${lockPath}.recovery`;
  for (;;) {
    const release = tryCreateLock(recoveryPath);
    if (release) return release;
    hooks?.onRecoveryGuardContended?.();
    const remaining = until - monotonicNow();
    if (remaining <= 0) throw lockError('NAVER_SESSION_BUSY');
    await delay(Math.min(remaining, retryIntervalMs));
  }
}

async function tryReclaimDeadHolder(lockPath, until, retryIntervalMs, hooks) {
  const observed = readSnapshot(lockPath);
  if (!observed?.valid || definitelyAlive(observed.value.pid)) return null;

  // All cooperating stale reclaimers re-check under this exclusive guard. It
  // prevents a second reclaimer from acting on the old record after the first
  // one has replaced it with a newly acquired live primary lock.
  const releaseGuard = await acquireRecoveryGuard(lockPath, until, retryIntervalMs, hooks);
  try {
    await hooks?.afterRecoveryGuardAcquired?.();
    const confirmed = readSnapshot(lockPath);
    if (!confirmed?.valid || definitelyAlive(confirmed.value.pid)) return null;
    const finalCheck = readSnapshot(lockPath);
    if (!sameSnapshot(confirmed, finalCheck) || definitelyAlive(finalCheck.value.pid)) return null;

    try { unlinkSync(lockPath); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw lockError('NAVER_SESSION_LOCK_FAILED');
    }

    // Claim the primary lock before releasing the recovery guard. If another
    // normal acquirer wins the exclusive create in this narrow gap, leave its
    // record untouched and let the caller observe it on the next iteration.
    return tryCreateLock(lockPath);
  } finally {
    releaseGuard();
  }
}

function createOwnerRecord() {
  const now = Date.now();
  lastRecordTime = Math.max(now, lastRecordTime + 1);
  return JSON.stringify({ pid: process.pid, at: new Date(lastRecordTime).toISOString() });
}

function writeAll(fd, text, write = writeSync) {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const written = write(fd, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw lockError('NAVER_SESSION_LOCK_FAILED');
      offset += written;
    }
  } finally {
    bytes.fill(0);
  }
}

function removeOwnedFile(lockPath, ownerStat, ownerRecord) {
  try {
    const current = readSnapshot(lockPath);
    if (!current || current.raw !== ownerRecord || !sameFile(current.fileStat, ownerStat)) return false;
    const confirmed = readSnapshot(lockPath);
    if (!sameSnapshot(current, confirmed) || confirmed.raw !== ownerRecord) return false;
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return false;
  }
}

function removeCreatedInode(lockPath, ownerStat) {
  try {
    const current = lstatSync(lockPath);
    if (sameFile(current, ownerStat)) unlinkSync(lockPath);
  } catch { /* already removed or no longer our file */ }
}

function tryCreateLock(lockPath, write = writeSync) {
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw lockError('NAVER_SESSION_LOCK_FAILED');
  }

  const ownerRecord = createOwnerRecord();
  let ownerStat;
  try {
    ownerStat = fstatSync(fd);
    writeAll(fd, ownerRecord, write);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch {
    try { ownerStat ||= fstatSync(fd); } catch { /* descriptor may already be closed */ }
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (ownerStat) removeCreatedInode(lockPath, ownerStat);
    throw lockError('NAVER_SESSION_LOCK_FAILED');
  }

  let released = false;
  return () => {
    if (released) return false;
    released = true;
    return removeOwnedFile(lockPath, ownerStat, ownerRecord);
  };
}

/**
 * Acquires the same per-Windows-user lock used by publisher-direct.mjs.
 * Records contain only {pid, at}; a live process is never evicted based on
 * lock-file age. New callers wait at most 30 seconds by default.
 */
export async function acquireNaverSessionLock({
  lockPath = getNaverSessionLockPath(),
  waitMs = NAVER_SESSION_LOCK_MAX_WAIT_MS,
  retryIntervalMs = 200,
  testHooks = null,
} = {}) {
  if (typeof lockPath !== 'string' || !lockPath || !Number.isFinite(waitMs) || waitMs < 0
      || !Number.isFinite(retryIntervalMs) || retryIntervalMs <= 0
      || (testHooks != null && (typeof testHooks !== 'object'
        || (testHooks.onRecoveryGuardContended != null && typeof testHooks.onRecoveryGuardContended !== 'function')
        || (testHooks.afterRecoveryGuardAcquired != null && typeof testHooks.afterRecoveryGuardAcquired !== 'function')
        || (testHooks.writeSync != null && typeof testHooks.writeSync !== 'function')))) {
    throw lockError('NAVER_SESSION_LOCK_OPTIONS_INVALID');
  }
  const boundedWaitMs = Math.min(waitMs, NAVER_SESSION_LOCK_MAX_WAIT_MS);
  const boundedRetryMs = Math.min(Math.max(1, retryIntervalMs), 1_000);
  const absoluteLockPath = path.resolve(lockPath);
  try { mkdirSync(path.dirname(absoluteLockPath), { recursive: true }); }
  catch { throw lockError('NAVER_SESSION_LOCK_FAILED'); }

  const until = monotonicNow() + boundedWaitMs;
  for (;;) {
    const release = tryCreateLock(absoluteLockPath, testHooks?.writeSync || writeSync);
    if (release) return release;

    const reclaimed = await tryReclaimDeadHolder(absoluteLockPath, until, boundedRetryMs, testHooks);
    if (reclaimed) return reclaimed;

    const remaining = until - monotonicNow();
    if (remaining <= 0) throw lockError('NAVER_SESSION_BUSY');
    await delay(Math.min(remaining, boundedRetryMs));
  }
}

export async function withNaverSessionLock(operation, options) {
  if (typeof operation !== 'function') throw lockError('NAVER_SESSION_LOCK_CALLBACK_REQUIRED');
  const release = await acquireNaverSessionLock(options);
  try { return await operation(); }
  finally { release(); }
}
