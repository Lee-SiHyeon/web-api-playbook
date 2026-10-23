import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRetryAfter, classifyResponse, computeBackoffDelay, createRateGate, withBoundedRetry,
  normalizeHeaders,
} from '../lib/commerce/backoff.mjs';

test('Retry-After parses seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  const now = Date.parse('2026-10-14T00:00:00Z');
  assert.equal(parseRetryAfter('Wed, 14 Oct 2026 00:01:00 GMT', now), 60_000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(undefined), null);
});

test('normalizeHeaders accepts fetch Headers and mixed-case objects', () => {
  const h = new Headers({ 'Retry-After': '10', 'Set-Cookie': 'datadome=x' });
  const n = normalizeHeaders(h);
  assert.equal(n['retry-after'], '10');
  assert.equal(n['set-cookie'], 'datadome=x');
  assert.equal(normalizeHeaders({ 'Retry-After': '5' })['retry-after'], '5');
});

test('challenge pages stop instead of retrying', () => {
  assert.deepEqual(classifyResponse({ status: 200, bodySample: '<title>Just a moment...</title>' }),
    { action: 'stop', reason: 'challenge_detected', vendor: 'cloudflare' });
  assert.equal(classifyResponse({ status: 200, bodySample: 'location: /punish?x5secdata=' }).vendor, 'aliexpress');
  assert.equal(classifyResponse({ status: 503, headers: { 'set-cookie': 'datadome=abc' } }).action, 'stop');
  assert.equal(classifyResponse({ status: 403 }).action, 'stop');
  assert.equal(classifyResponse({ status: 429 }).action, 'retry');
  assert.equal(classifyResponse({ status: 200, bodySample: '{"ok":true}' }).action, 'ok');
});

test('backoff is capped and honour Retry-After from Headers', async () => {
  assert.equal(computeBackoffDelay({ attempt: 10, baseMs: 1000, maxMs: 5000, random: () => 0.999 }), 4995);
  assert.equal(computeBackoffDelay({ attempt: 0, random: () => 0, retryAfterMs: 7000 }), 7000);
  const sleeps = [];
  const queue = [
    { status: 429, headers: new Headers({ 'Retry-After': '2' }) },
    { status: 200, value: 1 },
  ];
  const ok = await withBoundedRetry(async () => queue.shift(), { sleep: async ms => sleeps.push(ms), random: () => 0 });
  assert.equal(ok.ok, true);
  assert.deepEqual(sleeps, [2000]);
});

test('rate gate enforces interval and daily limit', () => {
  let t = Date.parse('2026-10-14T00:00:00Z');
  const gate = createRateGate({ minIntervalMs: 1000, dailyLimit: 2, now: () => t });
  assert.equal(gate.reserve().allowed, true);
  assert.deepEqual(gate.reserve(), { allowed: false, waitMs: 1000, reason: 'min_interval' });
  t += 1000;
  assert.equal(gate.reserve().allowed, true);
  t += 1000;
  assert.equal(gate.reserve().reason, 'daily_limit');
  t += 86_400_000;
  assert.equal(gate.reserve().allowed, true);
});

test('bounded retry stops on challenge without further attempts', async () => {
  let calls = 0;
  const stopped = await withBoundedRetry(async () => { calls += 1; return { status: 403 }; }, { sleep: async () => {} });
  assert.equal(stopped.ok, false);
  assert.equal(calls, 1);
});
