import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMyrealtripAuth } from '../lib/web-auth/myrealtrip.mjs';

async function fixture(t, phase) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mrt-login-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = new Map([
    ['myrealtrip-login', JSON.stringify({ version: 1, email: 'fixture@example.com', password: 'test-password', isKeepSignIn: false })],
    ['myrealtrip-pending', JSON.stringify({ version: 1, phase, preAuthToken: 'previous-attempt', createdAt: '2026-09-27T05:12:51Z' })],
  ]);
  const requests = [];
  const store = { directory, read: key => data.get(key), write: (key, value) => data.set(key, value), status: key => ({ available: data.has(key) }) };
  const auth = createMyrealtripAuth({ store, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ result: { status: 200 }, data: { preAuthToken: 'fresh-attempt' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  return { auth, requests, data };
}

test('routine login retains an acknowledged OTP wait without another sign-in', async t => {
  const f = await fixture(t, 'send_otp');
  assert.equal((await f.auth.login()).next, 'otp-send');
  assert.equal(f.requests.length, 0);
});

test('explicit fresh login replaces only an acknowledged wait with one new sign-in', async t => {
  const f = await fixture(t, 'send_otp');
  assert.equal((await f.auth.login({ restartPending: true })).next, 'otp-send');
  assert.equal(f.requests.length, 1);
  assert.equal(new URL(f.requests[0].url).pathname, '/partner/v1/sign-in');
  assert.equal(JSON.parse(f.data.get('myrealtrip-pending')).preAuthToken, 'fresh-attempt');
});

for (const phase of ['login_outcome_unknown', 'refresh_outcome_unknown', 'send_outcome_unknown', 'verify_outcome_unknown']) {
  test(`fresh login never re-arms ${phase}`, async t => {
    const f = await fixture(t, phase);
    const before = f.data.get('myrealtrip-pending');
    await assert.rejects(f.auth.login({ restartPending: true }), { code: 'AUTH_OUTCOME_UNKNOWN' });
    assert.equal(f.requests.length, 0);
    assert.equal(f.data.get('myrealtrip-pending'), before);
  });
}

test('non-boolean fresh-login input is rejected before requesting or overwriting pending state', async t => {
  const f = await fixture(t, 'send_otp');
  const before = f.data.get('myrealtrip-pending');
  await assert.rejects(f.auth.login({ restartPending: 'true' }), { code: 'AUTH_INPUT_INVALID' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.data.get('myrealtrip-pending'), before);
});
