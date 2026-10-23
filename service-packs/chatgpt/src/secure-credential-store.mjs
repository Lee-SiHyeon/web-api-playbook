import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeHelperProcess } from './native-helper-process.mjs';

const helper = fileURLToPath(new URL('./secure-credential-store.ps1', import.meta.url));
const validName = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const testMemory = process.env.NODE_TEST_CONTEXT ? new Map() : null;

export function resetTestCredentialStore() {
  if (!testMemory) throw new Error('CREDENTIAL_TEST_CONTEXT_REQUIRED');
  testMemory.clear();
}

function childEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function safeHelperFailure(stderr) {
  const line = String(stderr || '').split(/\r?\n/).find((entry) => entry.startsWith('CREDENTIAL_STORE_FAILED:'));
  const match = line?.match(/^CREDENTIAL_STORE_FAILED:([A-Za-z0-9_.-]{1,40}):([A-Za-z0-9_.-]{1,80}):([A-Za-z0-9_.-]{1,160})$/);
  if (!match) return {};
  return { providerStage: match[1], providerErrorClass: match[2], providerErrorId: match[3] };
}

function credentialFailure(code, operation, cause, stderr) {
  const error = new Error(code);
  error.code = code;
  error.providerOperation = operation;
  error.providerCause = cause;
  Object.assign(error, safeHelperFailure(stderr));
  return error;
}

function invoke(operation, name, input) {
  if (testMemory) throw new Error('CREDENTIAL_REAL_STORE_FORBIDDEN_IN_TEST');
  if (process.platform !== 'win32') throw new Error('CREDENTIAL_STORE_PLATFORM_UNSUPPORTED');
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
  try {
    return runNativeHelperProcess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-Operation', operation, '-Name', name,
    ], {
      env: childEnvironment(), input,
    });
  } catch (error) {
    const code = operation === 'read' ? 'CREDENTIAL_STORE_UNREADABLE' : 'CREDENTIAL_STORE_FAILED';
    throw credentialFailure(code, operation, error?.providerCause || 'HELPER_FAILURE', error?.stderr);
  }
}

export function credentialExists(name) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (testMemory) return testMemory.has(name);
  const output = invoke('status', name);
  try { return JSON.parse(output).available === true; }
  catch { throw new Error('CREDENTIAL_STORE_UNREADABLE'); }
}

export function readCredential(name) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (testMemory) return testMemory.get(name) || null;
  const output = invoke('read', name);
  return output.length ? output : null;
}

export function writeCredential(name, value) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (typeof value !== 'string' || value.length < 1 || value.length > 131_072 || /[\0\r\n]/.test(value)) {
    throw new Error('CREDENTIAL_VALUE_INVALID');
  }
  if (testMemory) {
    testMemory.set(name, value);
    return { stored: true, encryption: 'test_memory', plaintextPersisted: false };
  }
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const output = invoke('write', name, encoded);
  try {
    const result = JSON.parse(output);
    if (result.stored !== true || result.plaintextPersisted !== false
      || result.encryption !== 'Windows DPAPI CurrentUser') throw new Error();
    return { stored: true, encryption: result.encryption, plaintextPersisted: false };
  } catch {
    throw new Error('CREDENTIAL_STORE_UNVERIFIED');
  }
}

export function credentialStoreReady() {
  return process.platform === 'win32' && existsSync(helper);
}
