import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../scripts/dpapi-store.ps1', import.meta.url));
const NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const MAX_VALUE_BYTES = 1024 * 1024;
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

export class ProtectedStore {
  #provider;
  #directory;

  constructor({ directory, provider } = {}) {
    const resolvedProvider = provider ?? (process.platform === 'win32' ? 'dpapi' : null);
    if (resolvedProvider === 'dpapi' && process.platform !== 'win32') {
      throw fail('PROTECTED_STORE_PROVIDER_UNSUPPORTED');
    }
    if (resolvedProvider !== 'dpapi' && resolvedProvider !== 'memory') {
      throw fail('PROTECTED_STORE_PROVIDER_REQUIRED');
    }
    if (directory != null && (typeof directory !== 'string' || !directory.trim() || directory.includes('\0'))) {
      throw fail('PROTECTED_STORE_DIRECTORY_INVALID');
    }
    this.#provider = resolvedProvider;
    this.#directory = path.resolve(directory ?? defaultDirectory());
  }

  get directory() { return this.#directory; }

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
        // Cold PowerShell start takes 5-15 s on a busy machine; 15 s timed out mid-run and lost session rotations.
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw fail(operation === 'read' ? 'PROTECTED_STORE_READ_FAILED' : 'PROTECTED_STORE_OPERATION_FAILED');
    }
  }

  read(rawName) {
    const name = validateName(rawName);
    if (this.#provider === 'memory') return memoryValues.get(`${this.#directory}\0${name}`) ?? null;
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
  otherPlatforms: 'only explicit provider:"memory" is supported; it is process-local and not persistent',
  data: 'store UTF-8 strings such as JSON.stringify(session.toJSON()); read() returns the same string or null',
});
