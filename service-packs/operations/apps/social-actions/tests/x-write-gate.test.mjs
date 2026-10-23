import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reserveXWrite, noteXWriteRejection, readXWriteGate, xWriteRetryAt } from '../../affiliate-api-hub/scripts/sns/writers/x-write-gate.mjs';

async function clockFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'x-write-gate-')); t.after(() => rm(root, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-02T06:00:00Z'); const slept = [];
  return { root, now: () => clock, sleep: async ms => { slept.push(ms); clock += ms; }, slept, advance: ms => { clock += ms; } };
}

test('the hourly budget makes the next counted write wait until the oldest one leaves the hour', async t => {
  const f = await clockFixture(t), limits = { perHour: 2, perDay: 10 };
  await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits });
  f.advance(1000);
  await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits });
  const start = f.now();
  const third = await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits });
  assert.equal(third.reserved, true);
  assert.equal(f.now() - start, 60 * 60_000 - 1000, 'waited exactly until the first write aged out');
});

test('an explicit 344 pauses counted writes for an hour; 226 for 30 minutes; other codes do nothing', async t => {
  const f = await clockFixture(t);
  assert.equal(await noteXWriteRejection([131], { root: f.root, now: f.now() }), null);
  const until = await noteXWriteRejection([344], { root: f.root, now: f.now() });
  assert.equal(Date.parse(until) - f.now(), 60 * 60_000);
  assert.equal((await readXWriteGate({ root: f.root, now: f.now() })).cooldown.code, 344);
  // A shorter later code never shortens an active cooldown.
  assert.equal(await noteXWriteRejection([226], { root: f.root, now: f.now() }), until);
  const start = f.now();
  await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep });
  assert.equal(f.now() - start, 60 * 60_000);
  assert.ok(f.slept.every(ms => ms <= 15_000), 'waits in short stop-aware steps');
});

test('a stop request during the wait throws before any send and a bounded wait reports the retry time', async t => {
  const f = await clockFixture(t);
  await noteXWriteRejection([344], { root: f.root, now: f.now() });
  await assert.rejects(reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, isStopped: async () => true }),
    error => error.code === 'X_WRITE_GATE_STOPPED' && error.receipt.writeSent === false);
  await assert.rejects(reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, maxWaitMs: 60_000 }),
    error => error.code === 'X_WRITE_GATE_WAIT' && error.receipt.reason === 'cooldown_344');
});

test('a long local gate wait emits bounded progress metadata and a ready checkpoint',async t=>{
  const f=await clockFixture(t),waits=[],ready=[];
  await noteXWriteRejection([344],{root:f.root,now:f.now()});
  const result=await reserveXWrite({root:f.root,now:f.now,sleep:f.sleep,isStopped:async()=>false,
    onWait:async value=>{waits.push(value);f.advance(Date.parse(value.retryAt)-f.now());},
    onReady:async value=>ready.push(value)});
  assert.equal(result.reserved,true);assert.equal(waits.length,1);assert.equal(ready.length,1);
  assert.deepEqual({operation:waits[0].operation,source:waits[0].source,reason:waits[0].reason,writeSent:waits[0].writeSent},
    {operation:'XWrite',source:'local_x_write_gate',reason:'cooldown_344',writeSent:false});
  assert.equal(waits[0].retryAt,'2026-10-02T07:00:00.000Z');
  assert.equal(ready[0].source,'local_x_write_gate');assert.equal(ready[0].operation,'XWrite');
});

test('retry time combines cooldown, hour and day windows', () => {
  const now = 10 * 86_400_000;
  assert.equal(xWriteRetryAt({ events: [], cooldown: null }, now), now);
  const day = Array.from({ length: 150 }, (_, i) => now - 23 * 3_600_000 + i);
  assert.equal(xWriteRetryAt({ events: day, cooldown: null }, now, { perHour: 15, perDay: 150 }), day[0] + 86_400_000);
});

test('per-bot daily shares and returned slots', async t => {
  const f = await clockFixture(t), limits = { perHour: 100, perDay: 100 }, shares = { reflection: 2 };
  const a = await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, shares, bot: 'reflection' });
  f.advance(1000);
  await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, shares, bot: 'reflection' });
  await assert.rejects(reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, shares, bot: 'reflection', maxWaitMs: 1000 }),
    error => error.code === 'X_WRITE_GATE_WAIT');
  const other = await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, shares, bot: 'followback' });
  assert.equal(other.reserved, true, 'the follow-back bot is not limited by the reflection share');
  assert.equal(await a.release(), true);
  const again = await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, shares, bot: 'reflection', maxWaitMs: 1000 });
  assert.equal(again.reserved, true, 'a returned slot can be used again');
  const gate = await readXWriteGate({ root: f.root, now: f.now() });
  assert.deepEqual(gate.byBot, { reflection: 2, followback: 1 });
});

test('follow-back writes skip the daily total but keep hourly pacing; others leave the last 5 hourly slots', async t => {
  const f = await clockFixture(t), limits = { perHour: 15, perDay: 3 };
  for (let i = 0; i < 3; i++) { await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, bot: 'other' }); f.advance(1000); }
  await assert.rejects(reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, bot: 'other', maxWaitMs: 1000 }), error => error.code === 'X_WRITE_GATE_WAIT');
  const fb = await reserveXWrite({ root: f.root, now: f.now, sleep: f.sleep, limits, bot: 'followback', maxWaitMs: 1000 });
  assert.equal(fb.reserved, true, 'daily total does not stop follow-back');
  const g = { events: Array.from({ length: 10 }, (_, i) => ({ at: f.now() - i * 1000, bot: 'reflection' })), cooldown: null };
  assert.ok(xWriteRetryAt(g, f.now(), { perHour: 15, perDay: 1000 }, { bot: 'invite', shares: {} }) > f.now(), 'others stop at 10 per hour');
  assert.equal(xWriteRetryAt(g, f.now(), { perHour: 15, perDay: 1000 }, { bot: 'followback', shares: {} }), f.now(), 'follow-back still has the reserved 5');
});

test('quick-fact keeps 2 hourly slots (post + reply) that follow-back cannot fill', () => {
  const now = 10 * 86_400_000, limits = { perHour: 15, perDay: 1000 };
  const fb = n => Array.from({ length: n }, (_, i) => ({ at: now - (i + 1) * 1000, bot: 'followback' }));
  // 2026-10-05: 10 follow-back writes in the hour held a composed quick-fact post for 50 minutes.
  assert.equal(xWriteRetryAt({ events: fb(10), cooldown: null }, now, limits, { bot: 'quickfact', shares: {} }), now);
  assert.equal(xWriteRetryAt({ events: fb(14), cooldown: null }, now, limits, { bot: 'quickfact', shares: {} }), now);
  assert.ok(xWriteRetryAt({ events: fb(13), cooldown: null }, now, limits, { bot: 'followback', shares: {} }) > now, 'follow-back leaves 2');
  const used = [...fb(13), { at: now - 500, bot: 'quickfact' }, { at: now - 400, bot: 'quickfact' }].sort((a, b) => a.at - b.at);
  assert.ok(xWriteRetryAt({ events: used, cooldown: null }, now, limits, { bot: 'followback', shares: {} }) > now, 'the hour is full');
  const half = [...fb(12), { at: now - 500, bot: 'quickfact' }].sort((a, b) => a.at - b.at);
  assert.equal(xWriteRetryAt({ events: half, cooldown: null }, now, limits, { bot: 'followback', shares: {} }), now, 'only the unused slot stays held');
  assert.ok(xWriteRetryAt({ events: [...half, { at: now - 300, bot: 'followback' }], cooldown: null }, now, limits, { bot: 'followback', shares: {} }) > now);
});
