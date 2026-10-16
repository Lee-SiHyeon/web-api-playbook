import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../scripts/dpapi-store.ps1', import.meta.url));
const NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const MAX_VALUE_BYTES = 1024 * 1024;
export const PROTECTED_STORE_TIMEOUT_MS = 180_000;
const memoryValues = new Map();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validateName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw fail('PROTECTED_STORE_NAME_INVALID');
  return name;
}

function defaultDirectory() {
  const userRoot = os.homedir();
  if (!userRoot) throw fail('PROTECTED_STORE_DIRECTORY_INVALID');
  return path.join(userRoot, '.config', 'xhr-to-api-only', 'credentials');
}

function childEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  const candidate = root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  return candidate && existsSync(candidate) ? candidate : 'powershell.exe';
}

// Linux/macOS persistent backend (opt-in): AES-256-GCM sealed files, 0600, in a 0700 directory.
// Key: PROTECTED_STORE_KEY (base64, 32 bytes) or PROTECTED_STORE_KEY_FILE
// (default ~/.config/xhr-to-api-only/protected-store.key, created 0600 on first use).
// The credential name is bound as AES-GCM additional data, so a sealed file cannot be swapped to another name.
export const FILE_PROVIDER_LABEL = 'Linux AES-256-GCM file';

function fileKey() {
  if (process.env.PROTECTED_STORE_KEY) {
    const key = Buffer.from(process.env.PROTECTED_STORE_KEY, 'base64');
    if (key.length !== 32) throw fail('PROTECTED_STORE_KEY_INVALID');
    return key;
  }
  const keyPath = path.resolve(process.env.PROTECTED_STORE_KEY_FILE
    || path.join(os.homedir(), '.config', 'xhr-to-api-only', 'protected-store.key'));
  if (!existsSync(keyPath)) {
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    try { writeFileSync(keyPath, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error?.code !== 'EEXIST') throw fail('PROTECTED_STORE_KEY_INVALID'); }
  }
  const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw fail('PROTECTED_STORE_KEY_INVALID');
  return key;
}

function sealValue(value, key, name) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`protected-store:${name}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
  return JSON.stringify({ v: 1, alg: 'A256GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}

function unsealValue(blob, key, name) {
  try {
    const sealed = JSON.parse(blob);
    if (sealed?.v !== 1 || sealed.alg !== 'A256GCM') throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(`protected-store:${name}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch { throw fail('PROTECTED_STORE_READ_FAILED'); }
}

export class ProtectedStore {
  #provider;
  #directory;

  constructor({ directory, provider } = {}) {
    // Non-Windows hosts opt in to persistence explicitly: provider:'file' or PROTECTED_STORE_PROVIDER=file.
    const resolvedProvider = provider
      ?? (process.platform === 'win32' ? 'dpapi' : (process.env.PROTECTED_STORE_PROVIDER || null));
    if (resolvedProvider === 'dpapi' && process.platform !== 'win32') {
      throw fail('PROTECTED_STORE_PROVIDER_UNSUPPORTED');
    }
    if (resolvedProvider !== 'dpapi' && resolvedProvider !== 'memory' && resolvedProvider !== 'file') {
      throw fail('PROTECTED_STORE_PROVIDER_REQUIRED');
    }
    if (directory != null && (typeof directory !== 'string' || !directory.trim() || directory.includes('\0'))) {
      throw fail('PROTECTED_STORE_DIRECTORY_INVALID');
    }
    this.#provider = resolvedProvider;
    this.#directory = path.resolve(directory ?? defaultDirectory());
  }

  get directory() { return this.#directory; }

  #sealedPath(name) { return path.join(this.#directory, `${name}.sealed`); }

  #invoke(operation, name, input) {
    if (!['read', 'write', 'status'].includes(operation)) throw fail('PROTECTED_STORE_OPERATION_INVALID');
    const args = [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helperPath,
      '-Operation', operation,
      '-Name', name,
      '-Directory', this.#directory,
    ];
    try {
      return execFileSync(powershellPath(), args, {
        env: childEnvironment(),
        input,
        encoding: 'utf8',
        windowsHide: true,
        // Busy Windows hosts have exceeded the former 60 s helper deadline.
        timeout: PROTECTED_STORE_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      const error = fail(operation === 'read' ? 'PROTECTED_STORE_READ_FAILED' : 'PROTECTED_STORE_OPERATION_FAILED');
      // Only the helper's fixed stage label or a timeout flag; never stdout, input or values.
      const stage = /PROTECTED_STORE_FAILED:([a-z-]{1,32})/.exec(String(cause?.stderr ?? ''))?.[1];
      error.detail = { stage: stage ?? null, timedOut: cause?.code === 'ETIMEDOUT' || cause?.signal === 'SIGTERM', exitStatus: cause?.status ?? null };
      throw error;
    }
  }

  read(rawName) {
    const name = validateName(rawName);
    if (this.#provider === 'memory') return memoryValues.get(`${this.#directory}\0${name}`) ?? null;
    if (this.#provider === 'file') {
      const file = this.#sealedPath(name);
      if (!existsSync(file)) return null;
      let blob;
      try { blob = readFileSync(file, 'utf8'); } catch { throw fail('PROTECTED_STORE_READ_FAILED'); }
      return unsealValue(blob, fileKey(), name);
    }
    const value = this.#invoke('read', name, undefined);
    return value.length ? value : null;
  }

  write(rawName, value) {
    const name = validateName(rawName);
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      throw fail('PROTECTED_STORE_VALUE_INVALID');
    }
    if (this.#provider === 'memory') {
      memoryValues.set(`${this.#directory}\0${name}`, value);
      return { stored: true, provider: 'process-memory', persistent: false };
    }
    if (this.#provider === 'file') {
      const file = this.#sealedPath(name);
      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
        writeFileSync(tmp, sealValue(value, fileKey(), name), { mode: 0o600, flag: 'wx' });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
      } catch (cause) {
        try { unlinkSync(tmp); } catch {}
        if (cause?.code?.startsWith?.('PROTECTED_STORE_')) throw cause;
        throw fail('PROTECTED_STORE_OPERATION_FAILED');
      }
      return { stored: true, provider: FILE_PROVIDER_LABEL, persistent: true };
    }
    const base64 = Buffer.from(value, 'utf8').toString('base64');
    const output = this.#invoke('write', name, base64);
    let receipt;
    try { receipt = JSON.parse(output); } catch { throw fail('PROTECTED_STORE_RECEIPT_INVALID'); }
    if (receipt.stored !== true || receipt.provider !== 'Windows DPAPI CurrentUser' || receipt.persistent !== true) {
      throw fail('PROTECTED_STORE_RECEIPT_INVALID');
    }
    return { stored: true, provider: receipt.provider, persistent: true };
  }

  status(rawName) {
    const name = validateName(rawName);
    if (this.#provider === 'memory') {
      return {
        available: memoryValues.has(`${this.#directory}\0${name}`),
        provider: 'process-memory',
        persistent: false,
      };
    }
    if (this.#provider === 'file') {
      return { available: existsSync(this.#sealedPath(name)), provider: FILE_PROVIDER_LABEL, persistent: true };
    }
    const output = this.#invoke('status', name, undefined);
    let receipt;
    try { receipt = JSON.parse(output); } catch { throw fail('PROTECTED_STORE_STATUS_FAILED'); }
    if (typeof receipt.available !== 'boolean' || receipt.provider !== 'Windows DPAPI CurrentUser' || receipt.persistent !== true) {
      throw fail('PROTECTED_STORE_STATUS_FAILED');
    }
    return { available: receipt.available, provider: receipt.provider, persistent: true };
  }
}

export const protectedStoreContract = Object.freeze({
  api: 'synchronous read(name), write(name,value), status(name)',
  windows: 'defaults to Windows DPAPI CurrentUser; secret values travel only on stdin and are never passed in arguments or environment',
  otherPlatforms: 'opt-in provider:"file" (or PROTECTED_STORE_PROVIDER=file) seals each value with AES-256-GCM into <directory>/<name>.sealed (0600) keyed by PROTECTED_STORE_KEY or PROTECTED_STORE_KEY_FILE; provider:"memory" is process-local and not persistent',
  data: 'store UTF-8 strings such as JSON.stringify(session.toJSON()); read() returns the same string or null',
});
