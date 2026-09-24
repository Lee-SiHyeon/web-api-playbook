import { randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_LOCK_BYTES = 4096;
const MALFORMED_LOCK_MAX_AGE_MS = 2 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_HOST_HASH = createHash('sha256').update(os.hostname(), 'utf8').digest('hex');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function alive(pid, hostHash) {
  if (hostHash !== LOCAL_HOST_HASH) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function validOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.hostHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hostHash)
    || typeof value.startedAt !== 'string' || value.startedAt.length > 64 || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.nonce !== 'string' || !UUID_PATTERN.test(value.nonce)) return null;
  return { pid: value.pid, hostHash: value.hostHash, startedAt: value.startedAt, nonce: value.nonce };
}

async function readLock(lockPath) {
  let before;
  try { before = await lstat(lockPath); }
  catch (error) { if (error?.code === 'ENOENT') return null; return { unreadable: true }; }
  if (!before.isFile() || before.isSymbolicLink()) return { unreadable: true };
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) return { unreadable: true };
    if (current.size > MAX_LOCK_BYTES) return { malformed: true, stat: current };
    let parsed;
    try { parsed = JSON.parse(await handle.readFile({ encoding: 'utf8' })); }
    catch { return { malformed: true, stat: current }; }
    const owner = validOwner(parsed);
    return owner ? { owner, stat: current } : { malformed: true, stat: current };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { unreadable: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function recoverStale(lockPath, processAlive, now = Date.now()) {
  const observed = await readLock(lockPath);
  if (!observed) return true;
  if (observed.unreadable) return false;
  let stale = false;
  if (observed.owner) {
    try { stale = !(await processAlive(observed.owner.pid, observed.owner.hostHash)); } catch { stale = false; }
  } else if (observed.malformed) {
    stale = now - observed.stat.mtimeMs >= MALFORMED_LOCK_MAX_AGE_MS;
  }
  if (!stale) return false;

  const current = await readLock(lockPath);
  if (!current || current.unreadable || current.stat?.dev !== observed.stat?.dev
    || current.stat?.ino !== observed.stat?.ino) return !current;
  if (observed.owner) {
    if (!current.owner || current.owner.nonce !== observed.owner.nonce
      || current.owner.pid !== observed.owner.pid || current.owner.hostHash !== observed.owner.hostHash) return false;
    try { if (await processAlive(current.owner.pid, current.owner.hostHash)) return false; } catch { return false; }
  } else if (!current.malformed || now - current.stat.mtimeMs < MALFORMED_LOCK_MAX_AGE_MS) {
    return false;
  }
  try {
    const finalStat = await lstat(lockPath);
    if (!finalStat.isFile() || finalStat.isSymbolicLink()
      || finalStat.dev !== current.stat.dev || finalStat.ino !== current.stat.ino) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function optionsFor(callback, options) {
  if (typeof callback !== 'function') throw fail('SESSION_LOCK_CALLBACK_REQUIRED');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('SESSION_LOCK_OPTIONS_INVALID');
  if (typeof options.root !== 'string' || !options.root.trim() || options.root.includes('\0')) {
    throw fail('SESSION_LOCK_ROOT_REQUIRED');
  }
  if (typeof options.key !== 'string' || !options.key || options.key.length > 512 || /[\0\r\n]/.test(options.key)) {
    throw fail('SESSION_LOCK_KEY_INVALID');
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const processAlive = options.processAlive ?? alive;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10 * 60 * 1000
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 10_000 || typeof processAlive !== 'function') {
    throw fail('SESSION_LOCK_OPTIONS_INVALID');
  }
  const keyHash = createHash('sha256').update(options.key, 'utf8').digest('hex');
  return { root: path.resolve(options.root), lockPath: path.join(path.resolve(options.root), `${keyHash}.lock`), timeoutMs, pollMs, processAlive };
}

export async function withSessionLock(callback, options = {}) {
  const { root, lockPath, timeoutMs, pollMs, processAlive } = optionsFor(callback, options);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('SESSION_LOCK_ROOT_INVALID');
  } catch (error) {
    if (error?.code === 'SESSION_LOCK_ROOT_INVALID') throw error;
    throw fail('SESSION_LOCK_ROOT_INVALID');
  }

  const deadline = performance.now() + timeoutMs;
  while (true) {
    const owner = { pid: process.pid, hostHash: LOCAL_HOST_HASH, startedAt: new Date().toISOString(), nonce: randomUUID() };
    let handle;
    let identity;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      identity = await handle.stat();
      await handle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' });
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => {});
      if (identity) {
        const current = await readLock(lockPath);
        if (current?.stat?.dev === identity.dev && current.stat?.ino === identity.ino) {
          await unlink(lockPath).catch(() => {});
        }
      }
      if (error?.code !== 'EEXIST') throw fail('SESSION_LOCK_FAILED');
      await recoverStale(lockPath, processAlive);
      if (performance.now() >= deadline) throw fail('SESSION_LOCK_BUSY');
      await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())));
      continue;
    }
    await handle.close().catch(() => {});
    try {
      return await callback();
    } finally {
      const current = await readLock(lockPath);
      if (current?.owner?.nonce === owner.nonce && current.owner.pid === owner.pid
        && current.owner.hostHash === owner.hostHash && current.stat?.dev === identity.dev
        && current.stat?.ino === identity.ino) {
        try { await unlink(lockPath); }
        catch (error) { if (error?.code !== 'ENOENT') throw fail('SESSION_LOCK_RELEASE_FAILED'); }
      }
    }
  }
}

export const sessionLockContract = Object.freeze({
  root: 'required and caller-configurable; one lock per SHA-256(key)',
  owner: 'PID, host hash, start time, and nonce are checked before stale recovery and release; raw host names are not stored',
  staleRecovery: 'same-host dead PID or malformed lock older than two minutes; other-host locks are retained',
});
