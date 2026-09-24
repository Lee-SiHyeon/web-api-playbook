import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { withSessionLock } from './session-lock.mjs';

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_SAFE_RECORD_BYTES = 32 * 1024;
const MAX_KEY_INPUT_BYTES = 32 * 1024 * 1024;
const SAFE_SERVICE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const SAFE_OPERATION = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_KEY = /^[a-f0-9]{64}$/i;
const SECRET_FIELD = /(?:password|cookie|token|secret|authorization|credential|api.?key|session|csrf|xsrf|private.?key|headers?|body|content|payload|request|response)$/i;
const SECRET_TEXT = /(?:\bBearer\s+|\bBasic\s+|(?:cookie|token|secret|password|authorization)\s*[:=])/i;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validService(value) {
  if (typeof value !== 'string' || !SAFE_SERVICE.test(value)) throw fail('WRITE_JOURNAL_SERVICE_INVALID');
  return value;
}

function canonical(value, depth = 0, count = { value: 0, bytes: 0 }) {
  if (depth > 32 || ++count.value > 100_000) throw fail('WRITE_JOURNAL_KEY_INPUT_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_KEY_INPUT_BYTES) {
      throw fail('WRITE_JOURNAL_KEY_INPUT_TOO_LARGE');
    }
    const serialized = JSON.stringify(value);
    count.bytes += Buffer.byteLength(serialized, 'utf8');
    if (count.bytes > MAX_KEY_INPUT_BYTES) throw fail('WRITE_JOURNAL_KEY_INPUT_TOO_LARGE');
    return serialized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('WRITE_JOURNAL_KEY_INPUT_INVALID');
    const serialized = JSON.stringify(value);
    count.bytes += Buffer.byteLength(serialized, 'utf8');
    if (count.bytes > MAX_KEY_INPUT_BYTES) throw fail('WRITE_JOURNAL_KEY_INPUT_TOO_LARGE');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1, count)).join(',')}]`;
  if (!plainObject(value)) throw fail('WRITE_JOURNAL_KEY_INPUT_INVALID');
  const entries = Object.keys(value).sort().map(key => {
    const encodedKey = JSON.stringify(key);
    count.bytes += Buffer.byteLength(encodedKey, 'utf8');
    if (count.bytes > MAX_KEY_INPUT_BYTES) throw fail('WRITE_JOURNAL_KEY_INPUT_TOO_LARGE');
    return `${encodedKey}:${canonical(value[key], depth + 1, count)}`;
  });
  return `{${entries.join(',')}}`;
}

function safeMetadata(value, depth = 0, count = { value: 0 }) {
  if (depth > 8 || ++count.value > 2048) throw fail('WRITE_JOURNAL_RECORD_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw fail('WRITE_JOURNAL_RECORD_INVALID');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 4096 || /[\0\r\n]/.test(value) || SECRET_TEXT.test(value) || /^https?:\/\//i.test(value)) {
      throw fail('WRITE_JOURNAL_RECORD_INVALID');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw fail('WRITE_JOURNAL_RECORD_INVALID');
    return value.map(item => safeMetadata(item, depth + 1, count));
  }
  if (!plainObject(value)) throw fail('WRITE_JOURNAL_RECORD_INVALID');
  const output = {};
  const entries = Object.entries(value);
  if (entries.length > 128) throw fail('WRITE_JOURNAL_RECORD_INVALID');
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || SECRET_FIELD.test(key)) throw fail('WRITE_JOURNAL_RECORD_INVALID');
    output[key] = safeMetadata(item, depth + 1, count);
  }
  return output;
}

function validKey(value) {
  if (typeof value !== 'string' || !SAFE_KEY.test(value)) throw fail('WRITE_JOURNAL_KEY_INVALID');
  return value.toLowerCase();
}

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function ensureDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('WRITE_JOURNAL_ROOT_INVALID');
  } catch (error) {
    if (error?.code === 'WRITE_JOURNAL_ROOT_INVALID') throw error;
    throw fail('WRITE_JOURNAL_IO_FAILED');
  }
}

async function atomicReplace(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
  } catch {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw fail('WRITE_JOURNAL_IO_FAILED');
  }
}

function validateStoredRecord(record, service, key) {
  if (!plainObject(record) || record.version !== JOURNAL_VERSION || record.service !== service
    || record.key !== key || !['reserved', 'finished', 'needs-reconciliation', 'reconciled'].includes(record.status)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || !plainObject(record.safeRecord)) throw fail('WRITE_JOURNAL_CORRUPT');
  safeMetadata(record.safeRecord);
  if (record.safeReceipt != null) safeMetadata(record.safeReceipt);
  if (record.reconciliation != null) safeMetadata(record.reconciliation);
  return record;
}

export class WriteJournal {
  #root;
  #service;

  constructor({ root, service } = {}) {
    if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw fail('WRITE_JOURNAL_ROOT_REQUIRED');
    this.#root = path.resolve(root);
    this.#service = validService(service);
  }

  key(operation, target, content) {
    if (typeof operation !== 'string' || !SAFE_OPERATION.test(operation)) throw fail('WRITE_JOURNAL_OPERATION_INVALID');
    const serialized = `${this.#service}\0${operation}\0${canonical(target)}\0${canonical(content)}`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_KEY_INPUT_BYTES) throw fail('WRITE_JOURNAL_KEY_INPUT_TOO_LARGE');
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  #filePath(key) {
    return path.join(this.#root, this.#service, `${validKey(key)}.json`);
  }

  #lockOptions(key) {
    return {
      root: path.join(this.#root, '.locks'),
      key: `write-journal:${this.#service}:${validKey(key)}`,
    };
  }

  async #readFile(key) {
    const filePath = this.#filePath(key);
    let info;
    try { info = await lstat(filePath); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw fail('WRITE_JOURNAL_IO_FAILED'); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES) throw fail('WRITE_JOURNAL_CORRUPT');
    let handle;
    let raw;
    try {
      handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw fail('WRITE_JOURNAL_CORRUPT');
      raw = await handle.readFile();
    } catch (error) {
      if (error?.code === 'WRITE_JOURNAL_CORRUPT') throw error;
      throw fail('WRITE_JOURNAL_IO_FAILED');
    } finally { await handle?.close().catch(() => {}); }
    if (raw.byteLength > MAX_JOURNAL_BYTES) throw fail('WRITE_JOURNAL_CORRUPT');
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw fail('WRITE_JOURNAL_CORRUPT'); }
    return validateStoredRecord(parsed, this.#service, validKey(key));
  }

  async reserve(key, safeRecord = {}) {
    const normalizedKey = validKey(key);
    const safe = safeMetadata(safeRecord);
    if (!plainObject(safe) || Buffer.byteLength(JSON.stringify(safe), 'utf8') > MAX_SAFE_RECORD_BYTES) {
      throw fail('WRITE_JOURNAL_RECORD_INVALID');
    }
    return withSessionLock(async () => {
      const directory = path.join(this.#root, this.#service);
      await ensureDirectory(this.#root);
      await ensureDirectory(directory);
      const record = {
        version: JOURNAL_VERSION,
        service: this.#service,
        key: normalizedKey,
        status: 'reserved',
        createdAt: new Date().toISOString(),
        safeRecord: safe,
      };
      const filePath = this.#filePath(normalizedKey);
      const contents = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(contents, 'utf8') > MAX_JOURNAL_BYTES) throw fail('WRITE_JOURNAL_RECORD_TOO_LARGE');
      let handle;
      try {
        handle = await open(filePath, 'wx', 0o600);
        await handle.writeFile(contents, { encoding: 'utf8' });
        await handle.sync();
      } catch (error) {
        if (error?.code === 'EEXIST') throw fail('WRITE_JOURNAL_EXISTS');
        throw fail('WRITE_JOURNAL_IO_FAILED');
      } finally {
        await handle?.close().catch(() => {});
      }
      return safeClone(record);
    }, this.#lockOptions(normalizedKey));
  }

  async finish(key, state, safeReceipt = {}) {
    const normalizedKey = validKey(key);
    if (typeof state !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(state)) throw fail('WRITE_JOURNAL_STATE_INVALID');
    const safe = safeMetadata(safeReceipt);
    if (!plainObject(safe) || Buffer.byteLength(JSON.stringify(safe), 'utf8') > MAX_SAFE_RECORD_BYTES) {
      throw fail('WRITE_JOURNAL_RECEIPT_INVALID');
    }
    return withSessionLock(async () => {
      const record = await this.#readFile(normalizedKey);
      if (!record || record.status !== 'reserved') throw fail('WRITE_JOURNAL_STATE_INVALID');
      const isUnknown = /(?:unknown|uncertain|ambiguous|needs[-_]?reconciliation)/i.test(state);
      const updated = {
        ...record,
        status: isUnknown ? 'needs-reconciliation' : 'finished',
        state,
        finishedAt: new Date().toISOString(),
        safeReceipt: safe,
      };
      await atomicReplace(this.#filePath(normalizedKey), updated);
      return safeClone(updated);
    }, this.#lockOptions(normalizedKey));
  }

  async reconcile(key, readback) {
    const normalizedKey = validKey(key);
    if (!plainObject(readback) || !['found', 'not-found', 'ambiguous'].includes(readback.result)) {
      throw fail('WRITE_JOURNAL_READBACK_INVALID');
    }
    const safe = safeMetadata(readback);
    return withSessionLock(async () => {
      const record = await this.#readFile(normalizedKey);
      const awaitingReadback = record?.status === 'reserved'
        || record?.status === 'finished'
        && /(?:readback|verify|verification)/i.test(record.state || '');
      if (!record || (record.status !== 'needs-reconciliation' && !awaitingReadback)) {
        throw fail('WRITE_JOURNAL_STATE_INVALID');
      }
      const unresolved = readback.result === 'ambiguous';
      const updated = {
        ...record,
        status: unresolved ? 'needs-reconciliation' : 'reconciled',
        reconciliation: {
          ...safe,
          result: readback.result,
          observedAt: new Date().toISOString(),
          nextAction: unresolved ? 'read-only-reconciliation-required' : 'manual-decision-required',
        },
      };
      await atomicReplace(this.#filePath(normalizedKey), updated);
      return safeClone(updated);
    }, this.#lockOptions(normalizedKey));
  }

  async read(key) {
    const normalizedKey = validKey(key);
    return withSessionLock(async () => {
      const record = await this.#readFile(normalizedKey);
      return record ? safeClone(record) : null;
    }, this.#lockOptions(normalizedKey));
  }
}

export const writeJournalContract = Object.freeze({
  key: 'key(operation,target,content) is a deterministic SHA-256; raw target/content never enter the journal',
  reserve: 'reserve(key,safeRecord) uses exclusive wx; existing key is a hard stop, not permission to retry',
  finish: 'finish(key,state,safeReceipt) records metadata only; unknown outcomes require reconciliation',
  reconcile: 'reconcile(key,readback) records caller-provided evidence locally and performs no HTTP or write retry',
  metadata: 'safeRecord and safeReceipt reject secret-like field names, credential-like strings, and absolute URLs',
});
