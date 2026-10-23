import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatGPTWebError } from './errors.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPEN_STATES = new Set(['intent_logged', 'dispatch_started', 'response_received', 'outcome_unknown', 'held']);
const JOURNAL_ID = /^[0-9a-f-]{36}$/i;
const HASH = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[a-z][a-z0-9._-]{0,79}$/;
const STALE_LOCK_MS = 5 * 60 * 1000;

export function defaultJournalDirectory(env = process.env) {
  const local = env.LOCALAPPDATA;
  return local ? path.join(local, 'chatgpt-web-xhr-client', 'journal') : path.join(APP_DIR, '.runtime', 'journal');
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateRecord(record) {
  if (!record || record.version !== 1 || !JOURNAL_ID.test(record.journalId)
    || !OPERATION_ID.test(record.operationId) || !HASH.test(record.requestHash)
    || !HASH.test(record.targetHash) || !OPEN_STATES.has(record.state)
      && !['reconciled_present', 'reconciled_absent'].includes(record.state)) {
    throw new ChatGPTWebError('JOURNAL_INVALID');
  }
  return record;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and other errors are treated as alive/unknown. Recovery must be conservative.
    return error?.code !== 'ESRCH';
  }
}

function lockPathFor(directory, operationId, targetHash) {
  return path.join(directory, `.${sha256(`${operationId}\0${targetHash}`).slice(0, 32)}.lock`);
}

async function createExclusiveLock(lockPath, data) {
  const stagedPath = `${lockPath}.${randomUUID()}.tmp`;
  let staged;
  try {
    staged = await open(stagedPath, 'wx', 0o600);
    await staged.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
    await staged.sync();
    await staged.close();
    staged = undefined;
    // Publish complete lock metadata atomically. A crash cannot leave an empty lock
    // with no owner PID that could be confused with a live operation.
    await link(stagedPath, lockPath);
  } finally {
    await staged?.close().catch(() => {});
    await rm(stagedPath, { force: true }).catch(() => {});
  }
}

async function removeOwnedLock(lockPath, expected) {
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (lock.journalId === expected.journalId && lock.ownerPid === expected.ownerPid
      && lock.operationId === expected.operationId && lock.targetHash === expected.targetHash) {
      await rm(lockPath, { force: false });
    }
  } catch { /* Preserve locks we cannot verify as ours. */ }
}

export class MutationJournal {
  constructor({ directory = defaultJournalDirectory() } = {}) {
    this.directory = path.resolve(directory);
  }

  async readAll() {
    let names;
    try { names = await readdir(this.directory); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw new ChatGPTWebError('JOURNAL_UNAVAILABLE'); }
    const records = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      try {
        const record = validateRecord(JSON.parse(await readFile(path.join(this.directory, name), 'utf8')));
        records.push(record);
      } catch (error) {
        if (error instanceof ChatGPTWebError) throw error;
        throw new ChatGPTWebError('JOURNAL_INVALID');
      }
    }
    return records;
  }

  async get(journalId) {
    if (!JOURNAL_ID.test(journalId)) throw new ChatGPTWebError('JOURNAL_ID_INVALID');
    try {
      return validateRecord(JSON.parse(await readFile(path.join(this.directory, `${journalId}.json`), 'utf8')));
    } catch (error) {
      if (error instanceof ChatGPTWebError) throw error;
      throw new ChatGPTWebError('JOURNAL_NOT_FOUND');
    }
  }

  async #recoverStaleLock(lockPath, { operationId, targetHash }) {
    const recoveryPath = `${lockPath}.recovery`;
    const recoveryData = { version: 1, journalId: randomUUID(), operationId, targetHash,
      ownerPid: process.pid, createdAt: new Date().toISOString() };
    try { await createExclusiveLock(recoveryPath, recoveryData); }
    catch {
      // Only one process may inspect and remove a stale lock at a time. A crashed
      // recovery leaves this sidecar held for manual review, never for guessed deletion.
      return false;
    }
    try {
      return await this.#recoverStaleLockUnderMutex(lockPath, { operationId, targetHash });
    } finally {
      await removeOwnedLock(recoveryPath, recoveryData);
    }
  }

  async #recoverStaleLockUnderMutex(lockPath, { operationId, targetHash }) {
    let lock;
    try {
      const text = await readFile(lockPath, 'utf8');
      if (text.length > 4096) return false;
      lock = JSON.parse(text);
    } catch {
      // Empty, malformed, or unreadable locks are never guessed safe to remove.
      return false;
    }
    if (!lock || lock.version !== 1 || lock.operationId !== operationId || lock.targetHash !== targetHash
      || !JOURNAL_ID.test(lock.journalId || '') || !Number.isSafeInteger(lock.ownerPid) || lock.ownerPid < 1
      || typeof lock.createdAt !== 'string' || !Number.isFinite(Date.parse(lock.createdAt))) return false;
    const age = Date.now() - Date.parse(lock.createdAt);
    if (age < STALE_LOCK_MS || processIsAlive(lock.ownerPid)) return false;

    try {
      const record = await this.get(lock.journalId);
      if (record.operationId !== operationId || record.targetHash !== targetHash || record.state !== 'intent_logged'
        || record.ownerPid !== lock.ownerPid) return false;
    } catch (error) {
      // A crash between lock creation and atomic intent write is safe to recover only
      // when the journal is genuinely absent. Corrupt or unreadable journals stay held.
      if (error?.code !== 'JOURNAL_NOT_FOUND') return false;
    }

    try {
      const latest = JSON.parse(await readFile(lockPath, 'utf8'));
      if (latest.journalId !== lock.journalId || latest.ownerPid !== lock.ownerPid
        || latest.operationId !== lock.operationId || latest.targetHash !== lock.targetHash
        || latest.createdAt !== lock.createdAt) return false;
      await rm(lockPath, { force: false });
      return true;
    } catch {
      return false;
    }
  }

  async begin({ operationId, requestBytes, targetValue }) {
    if (!OPERATION_ID.test(operationId) || !Buffer.isBuffer(requestBytes)) throw new ChatGPTWebError('JOURNAL_INPUT_INVALID');
    const requestHash = sha256(requestBytes);
    const targetHash = sha256(JSON.stringify(targetValue ?? null));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = lockPathFor(this.directory, operationId, targetHash);
    const journalId = randomUUID();
    const now = new Date().toISOString();
    const ownerPid = process.pid;
    const lockData = { version: 1, journalId, operationId, targetHash, ownerPid, createdAt: now };
    try { await createExclusiveLock(lockPath, lockData); }
    catch (error) {
      if (error?.code === 'EEXIST') {
        const recovered = await this.#recoverStaleLock(lockPath, { operationId, targetHash });
        if (!recovered) throw new ChatGPTWebError('MUTATION_JOURNAL_BUSY');
        try { await createExclusiveLock(lockPath, lockData); }
        catch (retryError) {
          if (retryError?.code === 'EEXIST') throw new ChatGPTWebError('MUTATION_JOURNAL_BUSY');
          throw new ChatGPTWebError('JOURNAL_UNAVAILABLE');
        }
      } else throw new ChatGPTWebError('JOURNAL_UNAVAILABLE');
    }
    try {
      const records = await this.readAll();
      const pending = records.find((record) => record.operationId === operationId
        && record.targetHash === targetHash && OPEN_STATES.has(record.state));
      if (pending) throw new ChatGPTWebError('MUTATION_OUTCOME_UNKNOWN_HOLD', { journalId: pending.journalId, status: pending.state });
      const sameRequest = records.find((record) => record.operationId === operationId
        && record.targetHash === targetHash && record.requestHash === requestHash);
      if (sameRequest) throw new ChatGPTWebError('MUTATION_ALREADY_JOURNALED', { journalId: sameRequest.journalId, status: sameRequest.state });
      const record = {
        version: 1,
        journalId,
        operationId,
        ownerPid,
        state: 'intent_logged',
        requestHash,
        targetHash,
        createdAt: now,
        updatedAt: now,
      };
      await atomicWrite(path.join(this.directory, `${record.journalId}.json`), record);
      return record;
    } finally {
      await removeOwnedLock(lockPath, lockData);
    }
  }

  async reconcilePreDispatchCrash(journalId, { processExited = false } = {}) {
    if (processExited !== true) throw new ChatGPTWebError('JOURNAL_OPERATOR_CONFIRMATION_REQUIRED');
    const record = await this.get(journalId);
    if (record.state !== 'intent_logged') throw new ChatGPTWebError('JOURNAL_PRE_DISPATCH_RECOVERY_UNSAFE', { journalId, status: record.state });
    if (!Number.isSafeInteger(record.ownerPid) || processIsAlive(record.ownerPid)) {
      throw new ChatGPTWebError('JOURNAL_PROCESS_ACTIVE', { journalId });
    }
    return this.transition(journalId, 'reconciled_absent', {
      readbackOutcome: 'absent', authoritative: true, recovery: 'pre_dispatch_process_exit',
    });
  }

  async transition(journalId, nextState, metadata = {}) {
    const allowed = new Set(['dispatch_started', 'response_received', 'outcome_unknown', 'held', 'reconciled_present', 'reconciled_absent']);
    if (!allowed.has(nextState)) throw new ChatGPTWebError('JOURNAL_TRANSITION_INVALID');
    const record = await this.get(journalId);
    if (!OPEN_STATES.has(record.state)) throw new ChatGPTWebError('JOURNAL_ALREADY_RESOLVED', { journalId, status: record.state });
    const updated = { ...record, state: nextState, updatedAt: new Date().toISOString() };
    if (Number.isInteger(metadata.httpStatus)) updated.httpStatus = metadata.httpStatus;
    if (typeof metadata.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(metadata.mimeType)) updated.mimeType = metadata.mimeType;
    if (Number.isInteger(metadata.byteLength) && metadata.byteLength >= 0) updated.byteLength = metadata.byteLength;
    if (typeof metadata.readbackOperationId === 'string' && OPERATION_ID.test(metadata.readbackOperationId)) updated.readbackOperationId = metadata.readbackOperationId;
    if (metadata.authoritative === true || metadata.authoritative === false) updated.authoritative = metadata.authoritative;
    if (['present', 'absent', 'ambiguous'].includes(metadata.readbackOutcome)) updated.readbackOutcome = metadata.readbackOutcome;
    if (metadata.recovery === 'pre_dispatch_process_exit') updated.recovery = metadata.recovery;
    await atomicWrite(path.join(this.directory, `${journalId}.json`), updated);
    return updated;
  }

  async markDispatchStarted(journalId) {
    const record = await this.get(journalId);
    if (record.state !== 'intent_logged') throw new ChatGPTWebError('JOURNAL_TRANSITION_INVALID', { journalId, status: record.state });
    return this.transition(journalId, 'dispatch_started');
  }

  async markResponseReceived(journalId, metadata) {
    const record = await this.get(journalId);
    if (record.state !== 'dispatch_started') throw new ChatGPTWebError('JOURNAL_TRANSITION_INVALID', { journalId, status: record.state });
    return this.transition(journalId, 'response_received', metadata);
  }

  async markOutcomeUnknown(journalId, metadata = {}) {
    return this.transition(journalId, 'outcome_unknown', metadata);
  }

  async recordReconciliation(journalId, { outcome, authoritative = false, readbackOperationId } = {}) {
    if (!['present', 'absent', 'ambiguous'].includes(outcome) || typeof authoritative !== 'boolean') {
      throw new ChatGPTWebError('RECONCILIATION_INPUT_INVALID');
    }
    const state = outcome === 'present' ? 'reconciled_present'
      : outcome === 'absent' && authoritative ? 'reconciled_absent' : 'held';
    return this.transition(journalId, state, { readbackOutcome: outcome, authoritative, readbackOperationId });
  }

  async listSafe() {
    return (await this.readAll()).map(({ journalId, operationId, state, requestHash, targetHash,
      createdAt, updatedAt, httpStatus, mimeType, byteLength, readbackOperationId, readbackOutcome, authoritative }) => ({
      journalId, operationId, state, requestHash, targetHash, createdAt, updatedAt,
      ...(httpStatus !== undefined ? { httpStatus } : {}), ...(mimeType ? { mimeType } : {}),
      ...(byteLength !== undefined ? { byteLength } : {}),
      ...(readbackOperationId ? { readbackOperationId } : {}),
      ...(readbackOutcome ? { readbackOutcome } : {}), ...(authoritative !== undefined ? { authoritative } : {}),
    }));
  }
}

export const JOURNAL_STATES = Object.freeze({ open: [...OPEN_STATES], resolved: ['reconciled_present', 'reconciled_absent'] });
