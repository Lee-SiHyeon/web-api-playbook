import test from 'node:test';
import assert from 'node:assert/strict';
import { resetTestCredentialStore, writeCredential } from '../scripts/secure-credential-store.mjs';
import { validateLoginIdentity, saveLoginIdentity, loadLoginIdentity } from '../lib/login-identity.mjs';

const owner = { userId: 1, blogId: 2 };
const identity = { username: 'fixture@example.invalid', password: 'fixture-password' };

test('identity stays in the protected provider and requires the verified owner', () => {
  resetTestCredentialStore();
  const receipt = saveLoginIdentity(identity, owner);
  assert.equal(receipt.plaintextPersisted, false);
  assert.equal(JSON.stringify(receipt).includes(identity.password), false);
  assert.deepEqual(loadLoginIdentity(owner), identity);
  assert.throws(() => loadLoginIdentity({ ...owner, blogId: 3 }), { code: 'TISTORY_LOGIN_IDENTITY_BINDING' });
  assert.throws(() => loadLoginIdentity(), { code: 'TISTORY_LOGIN_IDENTITY_BINDING' });
});

test('invalid identity and missing ownership are rejected before storage', () => {
  for (const value of [null, [], {}, { ...identity, username: 'bad' },
    { ...identity, password: '' }, { ...identity, password: 'line\nbreak' }]) {
    assert.throws(() => validateLoginIdentity(value), { code: 'TISTORY_LOGIN_IDENTITY_INVALID' });
  }
  assert.throws(() => saveLoginIdentity(identity, {}), { code: 'TISTORY_LOGIN_IDENTITY_BINDING' });
});

test('missing or differently scoped protected entries fail closed', () => {
  resetTestCredentialStore();
  assert.throws(() => loadLoginIdentity(owner), { code: 'TISTORY_LOGIN_IDENTITY_MISSING' });
  writeCredential('tistory-kakao-login-identity-v1', 'null');
  assert.throws(() => loadLoginIdentity(owner), { code: 'TISTORY_LOGIN_IDENTITY_INVALID' });
  writeCredential('tistory-kakao-login-identity-v1', JSON.stringify({ version: 1,
    loginOrigin: 'https://example.invalid', blogOrigin: 'https://i-never-stop-study.tistory.com',
    owner, ...identity }));
  assert.throws(() => loadLoginIdentity(owner), { code: 'TISTORY_LOGIN_IDENTITY_BINDING' });
});
