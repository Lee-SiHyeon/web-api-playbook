import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const MALFORMED_LOCK_MAX_AGE_MS = 2 * 60 * 1000;
const MAX_LOCK_BYTES = 4096;
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionBusy() {
  const error = new Error('TISTORY_SESSION_BUSY');
  error.code = 'TISTORY_SESSION_BUSY';
  return error;
}

function validOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.startedAt !== 'string' || value.startedAt.length > 64 || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.nonce !== 'string' || !noncePattern.test(value.nonce)) return null;
  return { pid: value.pid, startedAt: value.startedAt, nonce: value.nonce };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // EPERM and unknown errors do not prove that the process has exited.
    return true;
  }
}

async function readLockFile(lockPath) {
  let initial;
  try { initial = await lstat(lockPath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { unreadable: true };
  }
  if (!initial.isFile() || initial.isSymbolicLink()) return { unreadable: true };

  let handle;
  try {
    const noFollow = constants.O_NOFOLLOW || 0;
    handle = await open(lockPath, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) return { unreadable: true };
    if (opened.size > MAX_LOCK_BYTES) return { malformed: true, stat: opened };
    const contents = await handle.readFile({ encoding: 'utf8' });
    let parsed;
    try { parsed = JSON.parse(contents); } catch { return { malformed: true, stat: opened }; }
    const owner = validOwner(parsed);
    if (!owner) return { malformed: true, stat: opened };
    return { owner, stat: opened };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { unreadable: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function tryRecoverStaleLock(lockPath, processAlive, now = Date.now()) {
  const observed = await readLockFile(lockPath);
  if (!observed) return true;
  if (observed.unreadable) return false;
  let stale = false;
  if (observed.owner) {
    try { stale = !(await processAlive(observed.owner.pid)); } catch { stale = false; }
  } else if (observed.malformed) {
    stale = now - observed.stat.mtimeMs >= MALFORMED_LOCK_MAX_AGE_MS;
  }
  if (!stale) return false;

  // Recheck the same file immediately before unlinking. Live owners are never
  // removed; inode matching also prevents deleting a lock replaced meanwhile.
  const current = await readLockFile(lockPath);
  if (!current || current.unreadable || current.stat?.dev !== observed.stat?.dev
    || current.stat?.ino !== observed.stat?.ino) return !current;
  if (observed.owner) {
    if (!current.owner || current.owner.nonce !== observed.owner.nonce || current.owner.pid !== observed.owner.pid) return false;
    try { if (await processAlive(current.owner.pid)) return false; } catch { return false; }
  } else if (!current.malformed || now - current.stat.mtimeMs < MALFORMED_LOCK_MAX_AGE_MS) {
    return false;
  }
  try {
    const finalStat = await lstat(lockPath);
    if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.dev !== current.stat.dev || finalStat.ino !== current.stat.ino) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
}

function validateOptions(fn, options) {
  if (typeof fn !== 'function') throw new TypeError('TISTORY_SESSION_LOCK_CALLBACK_REQUIRED');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('TISTORY_SESSION_LOCK_OPTIONS_INVALID');
  const lockPath = options.lockPath ?? path.join(os.homedir(), '.config', 'affiliate-content-operations', 'tistory-auth.lock');
  if (typeof lockPath !== 'string' || !lockPath || lockPath.includes('\0')) throw new TypeError('TISTORY_SESSION_LOCK_PATH_INVALID');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const ownerScript = options.ownerScript;
  const processAlive = options.processAlive ?? isProcessAlive;
  const lockFileOpener = options.lockFileOpener ?? open;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 10 * 60 * 1000
    || !Number.isFinite(pollMs) || pollMs <= 0 || pollMs > 10_000 || typeof processAlive !== 'function'
    || typeof lockFileOpener !== 'function'
    || ownerScript !== undefined && (typeof ownerScript !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,100}\.mjs$/i.test(ownerScript))) {
    throw new TypeError('TISTORY_SESSION_LOCK_OPTIONS_INVALID');
  }
  return { lockPath: path.resolve(lockPath), timeoutMs, pollMs, processAlive, ownerScript, lockFileOpener };
}

export async function withSessionLock(fn, options = {}) {
  const { lockPath, timeoutMs, pollMs, processAlive, ownerScript, lockFileOpener } = validateOptions(fn, options);
  try { await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 }); }
  catch { throw sessionBusy(); }

  const deadline = performance.now() + timeoutMs;
  while (true) {
    const owner = { pid: process.pid, startedAt: new Date().toISOString(), nonce: randomUUID(), ...(ownerScript ? { script: ownerScript } : {}) };
    let handle;
    try {
      handle = await lockFileOpener(lockPath, 'wx', 0o600);
    } catch (error) {
      // Windows may briefly deny an exclusive create while another process is
      // deleting the prior lock. Treat EPERM as contention only: stale-lock
      // recovery is reserved for EEXIST, and must never run on a denied open.
      if (error?.code === 'EPERM') {
        if (performance.now() >= deadline) throw sessionBusy();
        await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())));
        continue;
      }
      if (error?.code !== 'EEXIST') throw error;
      await tryRecoverStaleLock(lockPath, processAlive);
      if (performance.now() >= deadline) throw sessionBusy();
      await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())));
      continue;
    }

    let identity;
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' });
      identity = await handle.stat();
    } catch {
      await handle.close().catch(() => {});
      throw sessionBusy();
    }
    await handle.close().catch(() => {});
    try {
      return await fn();
    } finally {
      const current = await readLockFile(lockPath);
      if (current?.owner?.nonce === owner.nonce && current.owner.pid === owner.pid
        && current.stat?.dev === identity.dev && current.stat?.ino === identity.ino) {
        try { await unlink(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw sessionBusy(); }
      }
    }
  }
}
