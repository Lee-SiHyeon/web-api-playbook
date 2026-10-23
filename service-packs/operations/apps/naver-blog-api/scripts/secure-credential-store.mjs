import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helper = fileURLToPath(new URL('./secure-credential-store.ps1', import.meta.url));
export const CREDENTIAL_HELPER_TIMEOUT_MS = 180_000;
const validName = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const testMemory = process.env.NODE_TEST_CONTEXT ? new Map() : null;
// Linux/box hosts: opt in with PROTECTED_STORE_PROVIDER=file to read/write the playbook's sealed file store
// (same names as the DPAPI records). Values never leave the store API; nothing is logged.
const fileStore = !testMemory && process.platform !== 'win32' && process.env.PROTECTED_STORE_PROVIDER === 'file'
  ? new (await import(new URL('lib/protected-store.mjs', process.env.WEB_API_PLAYBOOK
    ? pathToFileURL(process.env.WEB_API_PLAYBOOK.replace(/\/?$/, '/'))
    : new URL('../../../../..', import.meta.url)).href)).ProtectedStore({ provider: 'file' })
  : null;

export function resetTestCredentialStore() {
  if (!testMemory) throw new Error('CREDENTIAL_TEST_CONTEXT_REQUIRED');
  testMemory.clear();
}

function childEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function invoke(operation, name, input) {
  if (testMemory) throw new Error('CREDENTIAL_REAL_STORE_FORBIDDEN_IN_TEST');
  if (process.platform !== 'win32') throw new Error('CREDENTIAL_STORE_PLATFORM_UNSUPPORTED');
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  try {
    return execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-Operation', operation, '-Name', name,
    ], {
      env: childEnvironment(),
      input,
      encoding: 'utf8',
      windowsHide: true,
      // Busy Windows hosts have exceeded the former 60 s helper deadline.
      timeout: CREDENTIAL_HELPER_TIMEOUT_MS,
      maxBuffer: 262144,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (cause) {
    const code = operation === 'read' ? 'CREDENTIAL_STORE_UNREADABLE' : 'CREDENTIAL_STORE_FAILED';
    // Keep diagnostics useful without retaining stdout, stderr or secret input.
    throw Object.assign(new Error(code), { code, detail: {
      timedOut: cause?.code === 'ETIMEDOUT' || cause?.signal === 'SIGTERM',
      exitStatus: Number.isInteger(cause?.status) ? cause.status : null,
    } });
  }
}

export function credentialExists(name) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (testMemory) return testMemory.has(name);
  if (fileStore) return fileStore.status(name).available === true;
  const output = invoke('status', name);
  try { return JSON.parse(output).available === true; }
  catch { throw new Error('CREDENTIAL_STORE_UNREADABLE'); }
}

export function readCredential(name) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (testMemory) return testMemory.get(name) || null;
  if (fileStore) return fileStore.read(name) || null;
  const output = invoke('read', name);
  return output.length ? output : null;
}

export function writeCredential(name, value) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (typeof value !== 'string' || value.length < 1 || value.length > 131072 || /[\0\r\n]/.test(value)) {
    throw new Error('CREDENTIAL_VALUE_INVALID');
  }
  if (testMemory) {
    testMemory.set(name, value);
    return { stored: true, encryption: 'test_memory', plaintextPersisted: false };
  }
  if (fileStore) {
    fileStore.write(name, value);
    return { stored: true, encryption: 'Linux AES-256-GCM file', plaintextPersisted: false };
  }
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const output = invoke('write', name, encoded);
  try {
    const result = JSON.parse(output);
    if (result.stored !== true || result.plaintextPersisted !== false || result.encryption !== 'Windows DPAPI CurrentUser') {
      throw new Error();
    }
    return { stored: true, encryption: result.encryption, plaintextPersisted: false };
  } catch {
    throw new Error('CREDENTIAL_STORE_UNVERIFIED');
  }
}

export function credentialStoreReady() {
  return Boolean(fileStore) || (process.platform === 'win32' && existsSync(helper));
}
