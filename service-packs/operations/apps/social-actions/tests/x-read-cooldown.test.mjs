import test from 'node:test';
import assert from 'node:assert/strict';
import { readCooldown } from '../x-read-cooldown.mjs';

test('invitation transaction bootstrap read failures back off without resuming sent writes', () => {
  const now = 1_000_000;
  const error = { code: 'X_TRANSACTION_BOOTSTRAP_FAILED' };
  assert.deepEqual(readCooldown(error, 'read', now), {
    status: 'waiting_for_session_bootstrap', retryAt: now + 5 * 60000,
  });
  assert.equal(readCooldown(error, 'read', now, 9).retryAt, now + 30 * 60000);
  assert.equal(readCooldown({ ...error, receipt: { writeSent: true } }, 'read', now), null);
  assert.equal(readCooldown({ ...error, writeSent: true }, 'read', now), null);
});

test('repeated Followers 404 reads retain exponential backoff', () => {
  const now = 1000000;
  const error = { code: 'X_FOLLOWERS_READ_REJECTED', receipt: { httpStatus: 404, mime: 'application/json' } };
  assert.equal(readCooldown(error, 'read', now, 3).retryAt, now + 1200000);
  assert.equal(readCooldown(error, 'write', now, 3), null);
});
test('only a positively identified pre-write protected-store read timeout resumes',()=>{
  const error={code:'PROTECTED_STORE_READ_FAILED',detail:{timedOut:true}},now=1000000;
  assert.equal(readCooldown(error,'read',now).retryAt,now+60000);
  assert.equal(readCooldown(error,'write',now),null);
  assert.equal(readCooldown({...error,detail:{timedOut:false}},'read',now),null);
});
test('local read-budget waits are expected cooldowns rather than new HTTP failures',()=>{
 const now=1000000;
 assert.deepEqual(readCooldown({code:'X_READ_BUDGET_WAIT',receipt:{localBudget:true,writeSent:false,rateLimitReset:1900}},'read',now),{status:'waiting_for_read_budget',retryAt:1900000});
});
test('read throttling honors server deadlines; no mutation or authentication error is resumed', () => {
  const now = 1000000;
  const error = { code: 'X_RATE_LIMITED', receipt: { httpStatus: 429, rateLimitReset: 3000 } };
  assert.equal(readCooldown(error, 'read', now).retryAt, 3000000);
  assert.equal(readCooldown(error, 'write', now), null);
  assert.equal(readCooldown({ ...error, receipt: { ...error.receipt, writeSent: true } }, 'read', now), null);
  assert.equal(readCooldown({ code: 'X_REAUTH_REQUIRED', receipt: { httpStatus: 401 } }, 'read', now), null);
  assert.equal(readCooldown({ code: 'X_OWNER_VERIFY_FAILED', receipt: { httpStatus: 404 } }, 'read', now).retryAt, now + 300000);
  assert.equal(readCooldown({ code: 'X_RATE_LIMITED', receipt: { httpStatus: 429 } }, 'read', now).retryAt, now + 900000);
});

test('session bootstrap failures before any send are retried in any phase; after a send they are not', () => {
  const now = 1_000_000;
  const c = readCooldown({ code: 'X_HOME_OWNER_UNVERIFIED' }, 'processing', now, 1);
  assert.equal(c.status, 'waiting_for_session_bootstrap'); assert.equal(c.retryAt, now + 5 * 60000);
  assert.equal(readCooldown({ code: 'X_HOME_OWNER_UNVERIFIED' }, 'processing', now, 9).retryAt, now + 30 * 60000);
  assert.equal(readCooldown({ code: 'X_HOME_OWNER_UNVERIFIED', receipt: { writeSent: true } }, 'processing', now), null);
});
