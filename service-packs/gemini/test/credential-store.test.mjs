import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  credentialExists,
  deleteCredential,
  readCredential,
  writeCredentialIfAbsent,
} from '../src/secure-credential-store.mjs';

test('test provider supports absent-only create, readback, and delete without overwrite', () => {
  const name = `credential-selftest-${randomUUID()}`;
  const firstValue = 'synthetic-self-test-value';
  const secondValue = 'must-not-replace-existing-value';

  assert.equal(credentialExists(name), false);
  assert.equal(writeCredentialIfAbsent(name, firstValue).stored, true);
  assert.throws(() => writeCredentialIfAbsent(name, secondValue), { message: 'CREDENTIAL_ALREADY_EXISTS' });
  assert.equal(readCredential(name), firstValue);
  assert.equal(deleteCredential(name), true);
  assert.equal(credentialExists(name), false);
});
