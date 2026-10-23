import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsDpapiProtector } from './dpapi-protector.mjs';
import { fail } from './errors.mjs';

const LOCK_WAIT_MS = 4_000;
const LOCK_STEP_MS = 50;
const MAX_PROTECTED_BYTES = 2 * 1024 * 1024;

function defaultRoot() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (!root) throw fail('STORE_PATH_UNAVAILABLE');
  return path.join(root, 'grok-web-xhr-client');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ProtectedJsonStore {
  #filePath;
  #directory;
  #protector;
  #provider;
  #memoryValue = null;
  #memoryTransactionTail = Promise.resolve();

  constructor({ filePath, fileName = 'state.dpapi', directory = defaultRoot(), protector, provider } = {}) {
    if (filePath !== undefined && (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0'))) {
      throw fail('STORE_PATH_INVALID');
    }
    if (filePath === undefined && (typeof fileName !== 'string' || !/^[A-Za-z0-9._-]{1,64}\.dpapi$/.test(fileName))) {
      throw fail('STORE_PATH_INVALID');
    }
    this.#directory = path.resolve(directory);
    this.#filePath = path.resolve(filePath ?? path.join(this.#directory, fileName));
    this.#provider = provider ?? (process.platform === 'win32' ? 'dpapi' : 'unsupported');
    if (this.#provider === 'dpapi' && process.platform !== 'win32') throw fail('DPAPI_UNAVAILABLE');
    if (this.#provider !== 'dpapi' && this.#provider !== 'memory') throw fail('PROTECTED_STORE_PROVIDER_REQUIRED');
    if (this.#provider === 'dpapi' && this.#directory.toLowerCase() !== path.resolve(defaultRoot()).toLowerCase()) {
      throw fail('PROTECTED_STORE_DIRECTORY_SCOPE');
    }
    if (this.#provider === 'dpapi' && path.dirname(this.#filePath).toLowerCase() !== this.#directory.toLowerCase()) {
      throw fail('PROTECTED_STORE_FILE_SCOPE');
    }
    this.#protector = protector ?? (this.#provider === 'dpapi' ? new WindowsDpapiProtector() : null);
    if (this.#provider === 'dpapi' && (!this.#protector || typeof this.#protector.protect !== 'function'
      || typeof this.#protector.unprotect !== 'function')) throw fail('PROTECTED_STORE_PROVIDER_INVALID');
  }

  get filePath() { return this.#filePath; }
  get provider() { return this.#provider === 'dpapi' ? 'Windows DPAPI CurrentUser' : 'process-memory-only'; }

  async #acquireLock() {
    await mkdir(this.#directory, { recursive: true });
    if (this.#provider === 'dpapi') this.#protector.secureAppDirectory(this.#directory);
    const lockPath = `${this.#filePath}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}:${Date.now()}`);
        return async () => {
          await handle.close().catch(() => {});
          await rm(lockPath, { force: true }).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw fail('PROTECTED_STORE_LOCK_FAILED');
        await sleep(LOCK_STEP_MS);
      }
    }
    throw fail('PROTECTED_STORE_BUSY');
  }

  async #readUnlocked() {
    if (this.#provider === 'memory') return this.#memoryValue === null ? null : structuredClone(this.#memoryValue);
    let protectedBytes;
    try { protectedBytes = await readFile(this.#filePath); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw fail('PROTECTED_STORE_READ_FAILED');
    }
    if (!protectedBytes.length || protectedBytes.length > MAX_PROTECTED_BYTES) throw fail('PROTECTED_STORE_DATA_INVALID');
    let plain;
    try { plain = this.#protector.unprotect(protectedBytes); } catch { throw fail('PROTECTED_STORE_DECRYPT_FAILED'); }
    if (!Buffer.isBuffer(plain) || plain.length > MAX_PROTECTED_BYTES) throw fail('PROTECTED_STORE_PLAINTEXT_INVALID');
    try {
      const parsed = JSON.parse(plain.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('PROTECTED_STORE_JSON_INVALID');
      return parsed;
    } catch (error) {
      if (error?.code?.startsWith('PROTECTED_STORE_')) throw error;
      throw fail('PROTECTED_STORE_JSON_INVALID');
    } finally {
      plain.fill(0);
    }
  }

  async read() {
    return this.#readUnlocked();
  }

  async #writeUnlocked(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('PROTECTED_STORE_VALUE_INVALID');
    if (this.#provider === 'memory') {
      this.#memoryValue = structuredClone(value);
      return { stored: true, provider: this.provider, persistent: false };
    }
    const serialized = Buffer.from(JSON.stringify(value), 'utf8');
    if (!serialized.length || serialized.length > MAX_PROTECTED_BYTES) {
      serialized.fill(0);
      throw fail('PROTECTED_STORE_VALUE_TOO_LARGE');
    }
    try {
      let encrypted;
      encrypted = this.#protector.protect(serialized);
      serialized.fill(0);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_PROTECTED_BYTES) {
        throw fail('PROTECTED_STORE_CIPHERTEXT_INVALID');
      }
      await mkdir(this.#directory, { recursive: true });
      const tempPath = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, encrypted, { flag: 'wx', mode: 0o600 });
        await rename(tempPath, this.#filePath);
      } finally {
        await rm(tempPath, { force: true }).catch(() => {});
        encrypted.fill(0);
      }
      return { stored: true, provider: this.provider, persistent: this.#provider === 'dpapi' };
    } catch (error) {
      serialized.fill(0);
      if (error?.code?.startsWith('PROTECTED_STORE_') || error?.code?.startsWith('DPAPI_')) throw error;
      throw fail('PROTECTED_STORE_WRITE_FAILED');
    }
  }

  async write(value) {
    if (this.#provider === 'memory') return this.#writeUnlocked(value);
    const release = await this.#acquireLock();
    try {
      return await this.#writeUnlocked(value);
    } finally {
      await release();
    }
  }

  async transact(mutator) {
    if (typeof mutator !== 'function') throw fail('PROTECTED_STORE_TRANSACTION_INVALID');
    const apply = async () => {
      const current = await this.#readUnlocked();
      const outcome = mutator(current);
      if (outcome && typeof outcome.then === 'function') throw fail('PROTECTED_STORE_TRANSACTION_ASYNC_MUTATOR');
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
        || outcome.value === null || typeof outcome.value !== 'object' || Array.isArray(outcome.value)
        || !Object.hasOwn(outcome, 'result')) throw fail('PROTECTED_STORE_TRANSACTION_INVALID');
      await this.#writeUnlocked(outcome.value);
      return outcome.result;
    };
    if (this.#provider === 'memory') {
      const result = this.#memoryTransactionTail.then(apply);
      this.#memoryTransactionTail = result.then(() => undefined, () => undefined);
      return result;
    }
    const release = await this.#acquireLock();
    try {
      return await apply();
    } finally {
      await release();
    }
  }

  async clear() {
    if (this.#provider === 'memory') {
      this.#memoryValue = null;
      return { cleared: true };
    }
    const release = await this.#acquireLock();
    try {
      await rm(this.#filePath, { force: true });
      return { cleared: true };
    } catch {
      throw fail('PROTECTED_STORE_CLEAR_FAILED');
    } finally {
      await release();
    }
  }

  async status() {
    const value = await this.read();
    return {
      available: value !== null,
      provider: this.provider,
      persistent: this.#provider === 'dpapi',
    };
  }
}
