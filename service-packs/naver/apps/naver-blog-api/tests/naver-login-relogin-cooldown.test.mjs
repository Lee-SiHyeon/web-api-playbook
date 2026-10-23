import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIC_RELOGIN_COOLDOWN_MS, automaticReloginBlocked } from '../scripts/naver-login-state.mjs';

test('automatic password logins wait after a recent verified login', () => {
  const now = Date.parse('2026-10-03T08:00:00Z');
  assert.equal(automaticReloginBlocked({ lastLoginAt: '2026-10-03T07:18:50Z' }, now), true);
  assert.equal(automaticReloginBlocked({ lastLoginAt: new Date(now - AUTOMATIC_RELOGIN_COOLDOWN_MS - 1).toISOString() }, now), false);
});

test('no recorded login never blocks', () => {
  assert.equal(automaticReloginBlocked({ blocked: false }), false);
  assert.equal(automaticReloginBlocked({ lastLoginAt: null }), false);
  assert.equal(automaticReloginBlocked(undefined), false);
});
