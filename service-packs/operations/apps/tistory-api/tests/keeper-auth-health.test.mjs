import test from 'node:test';
import assert from 'node:assert/strict';
import { keep } from '../../affiliate-api-hub/scripts/session-keeper.mjs';
import { buildAuthHealth } from '../lib/auth-health.mjs';

test('keeper records an early freshness warning without initiating login', async () => {
  const now = Date.parse('2026-10-07T08:00:00Z');
  const health = buildAuthHealth({ login: { lastRenewedAt: '2026-10-05T08:00:00Z' } }, { now });
  const calls = [];
  const result = await keep({ services: ['tistory'], playbook: '/fixture', exec: async (_file, args) => {
    calls.push(args[0]);
    return { json: { authenticated: true, ownerVerified: true, authHealth: { ...health, password: 'private-fixture' } } };
  } });
  assert.equal(result.allOk, true);
  assert.deepEqual(calls, ['status']);
  assert.ok(result.warnings.some(w => w.code === 'TISTORY_KAKAO_RENEWAL_AGE_WARNING'));
  assert.doesNotMatch(JSON.stringify(result), /private-fixture|password/);
});

test('keeper propagates a latched failure and skips an ineffective login subprocess', async () => {
  const health = buildAuthHealth({ login: { reauthRequired: true, lastFailure: 'TISTORY_KAKAO_REAUTH_REQUIRED',
    failedAt: '2026-10-06T03:22:33.340Z', lastRenewedAt: '2026-10-04T22:38:51.496Z' } });
  const calls = [];
  const result = await keep({ services: ['tistory'], playbook: '/fixture', exec: async (_file, args) => {
    calls.push(args[0]);
    return { exitCode: 1, json: { ok: false, code: 'TISTORY_REAUTH_REQUIRED', authHealth: health } };
  } });
  assert.deepEqual(calls, ['status']);
  assert.equal(result.allOk, false);
  assert.equal(result.services.tistory.human, true);
  assert.equal(result.services.tistory.code, 'TISTORY_KAKAO_REAUTH_REQUIRED');
  assert.equal(result.services.tistory.authHealth.failedAt, '2026-10-06T03:22:33.340Z');
});

test('a successful independent status read takes precedence over a stale login result', async () => {
  const goodHealth = buildAuthHealth({ login: { reauthRequired: false, lastRenewedAt: new Date().toISOString() } });
  const failedHealth = buildAuthHealth({ login: { reauthRequired: true, lastFailure: 'TISTORY_KAKAO_REAUTH_REQUIRED' } });
  let statusCalls = 0;
  const result = await keep({ services: ['tistory'], playbook: '/fixture', exec: async (_file, args) => {
    if (args[0] === 'login') return { exitCode: 1, json: { code: 'TISTORY_KAKAO_REAUTH_REQUIRED', authHealth: failedHealth } };
    statusCalls++;
    return statusCalls === 1 ? { exitCode: 1, json: { code: 'TISTORY_REAUTH_REQUIRED' } }
      : { json: { authenticated: true, ownerVerified: true, authHealth: goodHealth } };
  } });
  assert.equal(result.allOk, true);
  assert.equal(result.services.tistory.authHealth.reauthRequired, false);
  assert.equal(result.services.tistory.authHealth.failureCode, null);
});
