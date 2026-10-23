import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_NAME } from './constants.mjs';

const helper = fileURLToPath(new URL('./secure-credential-store.ps1', import.meta.url));
const validName = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const testMemory = process.env.NODE_TEST_CONTEXT ? new Map() : null;

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
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
  try {
    return execFileSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-Operation', operation, '-Name', name,
    ], {
      env: childEnvironment(),
      input,
      encoding: 'utf8',
      windowsHide: true,
      // Windows PowerShell cold-start can exceed 15 s in noninteractive runners;
      // keep a bounded allowance for ACL repair and DPAPI I/O.
      timeout: 60000,
      maxBuffer: 524288,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    let stderrText = '';
    try { stderrText = Buffer.from(error?.stderr || '').toString('utf8'); } catch { /* omit unsafe process details */ }
    const stage = stderrText.match(/CREDENTIAL_STORE_FAILED:(profile|directory|target|read|write)/)?.[1] || null;
    const code = error?.code === 'ETIMEDOUT'
      ? 'CREDENTIAL_STORE_TIMEOUT'
      : error?.code === 'ENOENT'
        ? 'CREDENTIAL_STORE_UNAVAILABLE'
        : operation === 'read'
          ? 'CREDENTIAL_STORE_UNREADABLE'
          : 'CREDENTIAL_STORE_FAILED';
    const safeError = new Error(code);
    safeError.code = code;
    if (stage) safeError.stage = stage;
    throw safeError;
  }
}

export function credentialStoreReady() {
  return process.platform === 'win32' && existsSync(helper);
}

export function credentialExists(name = CREDENTIAL_NAME) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (testMemory) return testMemory.has(name);
  const output = invoke('status', name);
  try { return JSON.parse(output).available === true; }
  catch { throw new Error('CREDENTIAL_STORE_UNREADABLE'); }
}

export function readCredential(name = CREDENTIAL_NAME) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (testMemory) return testMemory.get(name) || null;
  return invoke('read', name) || null;
}

export function writeCredential(name, value) {
  return storeCredential(name, value, 'write');
}

export function writeCredentialIfAbsent(name, value) {
  return storeCredential(name, value, 'write-new');
}

function storeCredential(name, value, operation) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (typeof value !== 'string' || value.length < 1 || value.length > 262144 || /[\0\r\n]/.test(value)) {
    throw new Error('CREDENTIAL_VALUE_INVALID');
  }
  if (testMemory) {
    if (operation === 'write-new' && testMemory.has(name)) throw new Error('CREDENTIAL_ALREADY_EXISTS');
    testMemory.set(name, value);
    return { stored: true, encryption: 'test_memory', plaintextPersisted: false };
  }
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const output = invoke(operation, name, encoded);
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

export function deleteCredential(name) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (testMemory) return testMemory.delete(name);
  const output = invoke('delete', name);
  try {
    if (JSON.parse(output).deleted !== true) throw new Error();
    return true;
  } catch {
    throw new Error('CREDENTIAL_STORE_UNVERIFIED');
  }
}

export function credentialStoreNativeSelfTest(name, value) {
  if (!validName.test(name)) throw new Error('CREDENTIAL_NAME_INVALID');
  if (typeof value !== 'string' || value.length < 1 || value.length > 262144 || /[\0\r\n]/.test(value)) {
    throw new Error('CREDENTIAL_VALUE_INVALID');
  }
  if (testMemory) throw new Error('CREDENTIAL_REAL_STORE_FORBIDDEN_IN_TEST');
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const output = invoke('self-test', name, encoded);
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('CREDENTIAL_STORE_UNVERIFIED'); }
  const fields = [
    'performed',
    'preexistingEntryPreserved',
    'directoryDaclApplied',
    'fileDaclApplied',
    'dpapiRoundTripVerified',
    'deletionVerified',
  ];
  if (!result || fields.some((field) => typeof result[field] !== 'boolean')) {
    throw new Error('CREDENTIAL_STORE_UNVERIFIED');
  }
  if (result.preexistingEntryPreserved !== true || result.directoryDaclApplied !== true) {
    throw new Error('CREDENTIAL_STORE_UNVERIFIED');
  }
  if (result.performed) {
    if (fields.slice(3).some((field) => result[field] !== true)) throw new Error('CREDENTIAL_STORE_UNVERIFIED');
  } else if (result.fileDaclApplied || result.dpapiRoundTripVerified || result.deletionVerified) {
    throw new Error('CREDENTIAL_STORE_UNVERIFIED');
  }
  return Object.fromEntries(fields.map((field) => [field, result[field]]));
}
