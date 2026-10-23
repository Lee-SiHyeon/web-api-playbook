import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tuneDecision, tuneThreadsReadBudget } from '../threads-read-budget-tune.mjs';
import { tunedThreadsReadLimits } from '../lib/threads-read-budget.mjs';

const now = Date.parse('2026-10-06T08:00:00Z');

test('raise one step only when the hour budget was nearly used and Meta was quiet', () => {
  const current = { perMinute: 30, perHour: 300 };
  assert.deepEqual(tuneDecision({ current, hourReads: 290, now }).perHour, 350);
  assert.equal(tuneDecision({ current, hourReads: 100, now }).action, 'hold', 'not saturated');
  assert.equal(tuneDecision({ current, hourReads: 300, throttleObservedAt: new Date(now - 30 * 60_000).toISOString(),
    lastThrottleSeenAt: new Date(now - 30 * 60_000).toISOString(), now }).reason, 'recent_throttle');
});

test('a new Meta throttle records the ceiling and backs off to 80%, never under the defaults', () => {
  const d = tuneDecision({ current: { perMinute: 50, perHour: 500 }, throttleObservedAt: '2026-10-06T07:50:00Z', hourReads: 500, now });
  assert.equal(d.action, 'back_off');
  assert.deepEqual([d.perMinute, d.perHour, d.ceiling.perHour], [40, 400, 500]);
  assert.equal(tuneDecision({ current: { perMinute: 30, perHour: 300 }, throttleObservedAt: '2026-10-06T07:50:00Z', now }).perHour, 300);
  const near = tuneDecision({ current: { perMinute: 40, perHour: 420 }, ceiling: { perMinute: 50, perHour: 500 },
    lastThrottleSeenAt: '2026-10-06T01:00:00Z', throttleObservedAt: '2026-10-06T01:00:00Z', hourReads: 420, now });
  assert.equal(near.reason, 'near_ceiling', '470 would pass 90% of the 500 ceiling');
});

test('a recent observed HTTP 429 blocks budget growth and records the current limit as its ceiling', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tb-tune-http429-'));
  writeFileSync(path.join(root, 'read-budget-limits.json'), JSON.stringify({ schemaVersion: 1, perMinute: 30,
    perHour: 300, lastThrottleSeenAt: new Date(now - 3 * 3600_000).toISOString(), ceiling: null }));
  writeFileSync(path.join(root, 'read-budget.json'), JSON.stringify({ schemaVersion: 1, service: 'threads',
    events: Array.from({ length: 300 }, (_, i) => now - 1000 * (i + 1)) }));
  writeFileSync(path.join(root, 'http429-cooldown.json'), JSON.stringify({ schemaVersion: 1, service: 'threads',
    owner: 'lifehack__ailab', code: 'META_HTTP_429_COOLDOWN', httpStatus: 429,
    observedAt: new Date(now - 60_000).toISOString(), retryAt: new Date(now + 14 * 60_000).toISOString(),
    deadlineSource: 'local_fallback_15_minutes', operation: 'BarcelonaPostPageTargetQuery', fallbackMilliseconds: 900_000 }));
  const entry = await tuneThreadsReadBudget({ root, now });
  assert.equal(entry.action, 'back_off');
  assert.deepEqual([entry.to.perMinute, entry.to.perHour], [30, 300]);
  const state = JSON.parse(readFileSync(path.join(root, 'read-budget-limits.json'), 'utf8'));
  assert.deepEqual(state.ceiling, { perMinute: 30, perHour: 300, observedAt: new Date(now - 60_000).toISOString() });
  assert.equal(state.lastThrottleSeenAt, new Date(now - 60_000).toISOString());
});

test('an HTTP 429 timestamp with the wrong owner or contract is ignored', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tb-tune-invalid-http429-'));
  writeFileSync(path.join(root, 'read-budget-limits.json'), JSON.stringify({ schemaVersion: 1, perMinute: 30,
    perHour: 300, lastThrottleSeenAt: new Date(now - 3 * 3600_000).toISOString(), ceiling: null }));
  writeFileSync(path.join(root, 'read-budget.json'), JSON.stringify({ schemaVersion: 1, service: 'threads',
    events: Array.from({ length: 300 }, (_, i) => now - 1000 * (i + 1)) }));
  writeFileSync(path.join(root, 'http429-cooldown.json'), JSON.stringify({ schemaVersion: 1, service: 'threads',
    owner: 'someone_else', code: 'META_HTTP_429_COOLDOWN', httpStatus: 429,
    observedAt: new Date(now - 60_000).toISOString(), retryAt: new Date(now + 14 * 60_000).toISOString(),
    deadlineSource: 'local_fallback_15_minutes', operation: 'BarcelonaPostPageTargetQuery', fallbackMilliseconds: 900_000 }));
  assert.equal((await tuneThreadsReadBudget({ root, now })).action, 'raise');
});

test('the latest valid observation wins across GraphQL and HTTP 429 cooldown files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tb-tune-throttle-order-'));
  const httpAt = new Date(now - 60_000).toISOString();
  const graphqlAt = new Date(now - 30_000).toISOString();
  writeFileSync(path.join(root, 'read-budget-limits.json'), JSON.stringify({ schemaVersion: 1, perMinute: 50,
    perHour: 500, lastThrottleSeenAt: new Date(now - 3 * 3600_000).toISOString(), ceiling: null }));
  writeFileSync(path.join(root, 'http429-cooldown.json'), JSON.stringify({ schemaVersion: 1, service: 'threads',
    owner: 'lifehack__ailab', code: 'META_HTTP_429_COOLDOWN', httpStatus: 429, observedAt: httpAt,
    retryAt: new Date(now + 14 * 60_000).toISOString(), deadlineSource: 'local_fallback_15_minutes',
    operation: 'BarcelonaPostPageTargetQuery', fallbackMilliseconds: 900_000 }));
  writeFileSync(path.join(root, 'graphql-cooldown.json'), JSON.stringify({ schemaVersion: 1, service: 'threads',
    owner: 'lifehack__ailab', code: 'META_GRAPHQL_THROTTLED', httpStatus: 200, providerErrorCode: 1675004,
    observedAt: graphqlAt, retryAt: new Date(now + 4 * 60_000).toISOString(), deadlineSource: 'local_fallback',
    consecutiveThrottles: 1, fallbackMilliseconds: 300_000 }));
  const entry = await tuneThreadsReadBudget({ root, now });
  assert.equal(entry.action, 'back_off');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'read-budget-limits.json'), 'utf8')).lastThrottleSeenAt, graphqlAt);
});

test('the tuner writes limits the read budget then uses; a broken file keeps the defaults', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tb-tune-'));
  writeFileSync(path.join(root, 'read-budget.json'), JSON.stringify({ schemaVersion: 1, service: 'threads', events: Array.from({ length: 280 }, (_, i) => now - 1000 * (i + 1)) }));
  const entry = await tuneThreadsReadBudget({ root, now });
  assert.equal(entry.action, 'raise');
  assert.deepEqual(tunedThreadsReadLimits(root), { perMinute: 35, perHour: 350 });
  writeFileSync(path.join(root, 'read-budget-limits.json'), '{broken');
  assert.equal(tunedThreadsReadLimits(root), null);
});

test('first run: a throttle recorded before tuning existed is the baseline, not a back-off', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tb-tune-first-'));
  writeFileSync(path.join(root, 'graphql-cooldown.json'), JSON.stringify({ observedAt: '2026-10-01T08:57:59.616Z' }));
  writeFileSync(path.join(root, 'read-budget.json'), JSON.stringify({ schemaVersion: 1, service: 'threads', events: Array.from({ length: 300 }, (_, i) => now - 1000 * (i + 1)) }));
  const entry = await tuneThreadsReadBudget({ root, now });
  assert.equal(entry.action, 'raise');
  assert.equal((await tuneThreadsReadBudget({ root, now: now + 3600_000 })).action, 'hold', 'the next hour starts from 350 with no fresh reads');
});
