import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseStoredNaverSession } from '../scripts/naver-session-reuse.mjs';

function fakeSession({ verification, persistError, verifyError } = {}) {
  const calls = { options: null, verify: 0, persist: 0, clear: 0 };
  class SessionClient {
    constructor(options) { calls.options = options; }
    async verifyRoot() {
      calls.verify++;
      if (verifyError) throw verifyError;
      return verification;
    }
    async persistVerifiedSession() {
      calls.persist++;
      if (persistError) throw persistError;
      return { stored: true, verification };
    }
    clear() { calls.clear++; }
  }
  return { SessionClient, calls };
}

const owner = 'aicandoanything';
const verified = { verified: true, actorMatched: true, adminShell: true, loginHTML: false,
  checkedAt: '2026-10-03T00:00:00.000Z', httpStatus: 200 };

test('reuse without remember verifies once and never persists rotation', async () => {
  const saved = { cookies: [{ name: 'NID_AUT', value: 'fixture' }], userAgent: 'Fixture/1.0',
    provider: 'windows_dpapi', persisted: true };
  const fake = fakeSession({ verification: verified });
  const result = await reuseStoredNaverSession({ loadNaverCookies: async () => saved,
    SessionClient: fake.SessionClient, ownerBlogId: owner });
  assert.equal(fake.calls.options.persistRotation, false);
  assert.equal(fake.calls.verify, 1);
  assert.equal(fake.calls.persist, 0);
  assert.equal(fake.calls.clear, 1);
  assert.equal(result.protectedOwnerRead, true);
  assert.equal(result.sessionStored, true);
  assert.equal(result.cookiesPersisted, false);
  assert.equal(saved.cookies.length, 0);
});

test('remember reuses the verification returned by the single protected save', async () => {
  const saved = { cookies: [{ name: 'NID_AUT', value: 'fixture' }], userAgent: 'Fixture/1.0',
    provider: 'windows_dpapi', persisted: true };
  const fake = fakeSession({ verification: verified });
  const result = await reuseStoredNaverSession({ loadNaverCookies: async () => saved,
    SessionClient: fake.SessionClient, ownerBlogId: owner, rememberSession: true });
  assert.equal(fake.calls.options.persistRotation, false);
  assert.equal(fake.calls.verify, 0);
  assert.equal(fake.calls.persist, 1);
  assert.equal(fake.calls.clear, 1);
  assert.equal(result.sessionStored, true);
  assert.equal(result.cookiesPersisted, true);
  assert.equal(result.protectedReadStatus, 200);
});

test('login HTML verification errors fall back to password login without another cookie write', async () => {
  const saved = { cookies: [{ name: 'NID_AUT', value: 'fixture' }], persisted: true };
  const error = Object.assign(new Error('AUTH_UNVERIFIED'), { code: 'AUTH_UNVERIFIED', details: { loginHTML: true } });
  const fake = fakeSession({ verification: null, persistError: error });
  const result = await reuseStoredNaverSession({ loadNaverCookies: async () => saved,
    SessionClient: fake.SessionClient, ownerBlogId: owner, rememberSession: true });
  assert.equal(result, null);
  assert.equal(fake.calls.persist, 1);
  assert.equal(fake.calls.verify, 0);
  assert.equal(fake.calls.clear, 1);
  assert.equal(saved.cookies.length, 0);
});

test('a rejected login redirect still falls back to password login', async () => {
  const saved = { cookies: [{ name: 'NID_AUT', value: 'fixture' }], persisted: true };
  const error = Object.assign(new Error('AUTH_UNVERIFIED'), { code: 'AUTH_UNVERIFIED',
    details: { finalPath: 'https://nid.naver.com/nidlogin.login' } });
  const fake = fakeSession({ verifyError: error });
  const result = await reuseStoredNaverSession({ loadNaverCookies: async () => saved,
    SessionClient: fake.SessionClient, ownerBlogId: owner });
  assert.equal(result, null);
  assert.equal(fake.calls.verify, 1);
  assert.equal(fake.calls.persist, 0);
});

test('non-login owner verification failures remain errors', async () => {
  const saved = { cookies: [{ name: 'NID_AUT', value: 'fixture' }], persisted: true };
  const fake = fakeSession({ verification: { ...verified, actorMatched: false } });
  await assert.rejects(reuseStoredNaverSession({ loadNaverCookies: async () => saved,
    SessionClient: fake.SessionClient, ownerBlogId: owner }), { message: 'LOGIN_SESSION_OWNER_MISMATCH' });
  assert.equal(fake.calls.verify, 1);
  assert.equal(fake.calls.persist, 0);
});
