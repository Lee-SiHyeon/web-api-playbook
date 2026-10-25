// lib/sns-schedule.mjs: schedule time parsing and limits (the browser-side steps were verified live on 2026-10-26)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleTime } from '../lib/sns-schedule.mjs';

const now = Date.parse('2026-10-26T00:00:00Z');

test('parses ISO with offset, local "YYYY-MM-DD HH:MM" and epoch ms; seconds are dropped', () => {
  assert.equal(parseScheduleTime('2026-10-29T15:07:45+09:00', now).toISOString(), '2026-10-29T06:07:00.000Z');
  assert.equal(parseScheduleTime(String(Date.parse('2026-10-30T01:00:00Z')), now).toISOString(), '2026-10-30T01:00:00.000Z');
  const local = parseScheduleTime('2026-10-29 15:07', now);
  assert.deepEqual([local.getHours(), local.getMinutes()], [15, 7]);
});

test('refuses bad, past, too-soon (< 10 min) and too-far (> 60 days) times', () => {
  assert.throws(() => parseScheduleTime('garbage', now), /SCHEDULE_BAD_TIME/);
  assert.throws(() => parseScheduleTime('2026-10-25T00:00Z', now), /SCHEDULE_TOO_SOON/);
  assert.throws(() => parseScheduleTime('2026-10-26T00:05Z', now), /SCHEDULE_TOO_SOON/);
  assert.equal(parseScheduleTime('2026-10-26T00:10Z', now).toISOString(), '2026-10-26T00:10:00.000Z');
  assert.throws(() => parseScheduleTime('2027-01-01T00:00Z', now), /SCHEDULE_TOO_FAR/);
});
