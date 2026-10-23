import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  credentialStoreNativeSelfTest,
  credentialStoreReady,
} from '../src/secure-credential-store.mjs';

export function runCredentialStoreSelfTest() {
  if (!credentialStoreReady()) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');

  const name = `native-acl-selftest-${randomBytes(12).toString('hex')}`;
  const sentinel = randomBytes(32).toString('base64url');
  try {
    return credentialStoreNativeSelfTest(name, sentinel);
  } catch (error) {
    const allowed = new Set([
      'CREDENTIAL_STORE_TIMEOUT',
      'CREDENTIAL_STORE_UNAVAILABLE',
      'CREDENTIAL_STORE_UNREADABLE',
      'CREDENTIAL_STORE_FAILED',
      'CREDENTIAL_STORE_UNVERIFIED',
    ]);
    const code = allowed.has(error?.code) ? error.code : 'CREDENTIAL_STORE_SELFTEST_FAILED';
    const failure = new Error(code);
    failure.code = code;
    if (['profile', 'directory', 'target', 'read', 'write'].includes(error?.stage)) failure.storeStage = error.stage;
    throw failure;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify(runCredentialStoreSelfTest()) + '\n');
  } catch (error) {
    const code = ['CREDENTIAL_STORE_TIMEOUT', 'CREDENTIAL_STORE_UNAVAILABLE', 'CREDENTIAL_STORE_UNREADABLE',
      'CREDENTIAL_STORE_FAILED', 'CREDENTIAL_STORE_UNVERIFIED', 'CREDENTIAL_STORE_SELFTEST_FAILED'].includes(error?.code)
      ? error.code
      : 'CREDENTIAL_STORE_SELFTEST_FAILED';
    const storeStage = ['profile', 'directory', 'target', 'read', 'write'].includes(error?.storeStage)
      ? error.storeStage
      : null;
    process.stderr.write(JSON.stringify({ passed: false, code, storeStage }) + '\n');
    process.exitCode = 1;
  }
}
