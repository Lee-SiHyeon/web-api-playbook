// lib/sns-schedule.mjs: schedule time parsing and limits (the browser-side steps were verified live on 2026-10-26)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { applySchedule, parseScheduleTime, scheduleDatePartsMatch,
  thCheckLine, thDayCell, thMonthDelta, thNavButton, xReadLine } from '../lib/sns-schedule.mjs';

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

test('rejects impossible dates, clock fields, offsets, and rollover normalization', () => {
  for (const input of [
    '2026-11-31T12:00Z', '2026-02-29T12:00Z', '2026-10-29T24:00Z',
    '2026-10-29T12:60Z', '2026-10-29T12:00:60Z', '2026-10-29T12:00',
    '2026-10-29T12:00+25:00', '2026-10-29T12:00+09:60',
    '2026-11-31 12:00', '2026-02-29 12:00', '2026-10-29 24:00',
  ]) assert.throws(() => parseScheduleTime(input, now), /SCHEDULE_BAD_TIME/);

  const leapNow = Date.parse('2028-02-29T11:49:00Z');
  assert.equal(parseScheduleTime('2028-02-29T12:00Z', leapNow).toISOString(), '2028-02-29T12:00:00.000Z');
  assert.throws(() => parseScheduleTime('2026-10-29T12:00Z', Number.NaN), /SCHEDULE_BAD_NOW/);
  assert.throws(() => parseScheduleTime('2026-10-29T12:00Z', 'now'), /SCHEDULE_BAD_NOW/);
  assert.throws(() => parseScheduleTime({ date: '2026-10-29' }, now), /SCHEDULE_BAD_TIME/);
});

test('rounds epoch milliseconds down without changing the target minute', () => {
  const target = Date.parse('2026-10-29T15:07:59.999Z');
  const parsedNumber = parseScheduleTime(target, now);
  const parsedString = parseScheduleTime(String(target), now);
  assert.equal(parsedNumber.getTime(), Date.parse('2026-10-29T15:07:00.000Z'));
  assert.equal(parsedString.getTime(), parsedNumber.getTime());
  assert.equal(parsedNumber.scheduleInputKind, 'epoch');
});

test('Node-local wall times reject DST gaps and ambiguous repeated times', () => {
  const moduleUrl = new URL('../lib/sns-schedule.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    const { parseScheduleTime } = await import(${JSON.stringify(moduleUrl)});
    const now = Date.parse('2026-03-07T00:00:00-05:00');
    assert.throws(() => parseScheduleTime('2026-03-08 02:30', now), /SCHEDULE_NONEXISTENT_LOCAL_TIME/);
    const valid = parseScheduleTime('2026-03-08 03:30', now);
    assert.deepEqual([valid.getFullYear(), valid.getMonth(), valid.getDate(), valid.getHours()], [2026, 2, 8, 3]);
    assert.equal(valid.scheduleInputKind, 'node-local');
    const fallNow = Date.parse('2026-10-31T00:00:00-04:00');
    assert.throws(() => parseScheduleTime('2026-11-01 01:30', fallNow), /SCHEDULE_AMBIGUOUS_LOCAL_TIME/);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', env: { ...process.env, TZ: 'America/New_York' },
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});

test('Node-local wall-time scheduling verifies the browser timezone before opening a picker', async () => {
  const target = new Date(Date.now() + 2 * 60 * 60 * 1000);
  target.setMinutes(0, 0, 0);
  const local = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')} ${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const when = parseScheduleTime(local);
  let clickCount = 0;
  const io = {
    call: async (fn, ...args) => fn(...args) + 60,
    click: async () => { clickCount++; },
  };
  await assert.rejects(applySchedule('x', when, io), /SCHEDULE_TIMEZONE_MISMATCH/);
  assert.equal(clickCount, 0);
});

function fakeDay(label, index, disabled = false) {
  return {
    innerText: label, children: [],
    closest: selector => disabled && selector === '[aria-disabled=true]' ? {} : null,
    getBoundingClientRect: () => ({ x: index * 10, y: index * 20, width: 10, height: 20 }),
  };
}

function runPageFunction(fn, document, ...args) {
  return runInNewContext(`(${fn.toString()})(...${JSON.stringify(args)})`, { document, Date });
}

test('X confirmation is scoped to the composer and checks exact date fields', () => {
  const rect = [{ x: 0, y: 0, width: 400, height: 400 }];
  const validDialog = { innerText: 'Will send on Thu, Oct 29, 2026 at 3:07 PM',
    getAttribute: () => null, getClientRects: () => rect };
  const inactiveDialog = { innerText: 'Will send on Fri, Oct 30, 2026 at 3:07 PM',
    getAttribute: () => 'true', getClientRects: () => [] };
  const validDocument = { body: { innerText: 'stale Will send on Fri, Oct 30, 2026 at 3:07 PM' },
    querySelectorAll: selector => selector === '[role=dialog]' ? [inactiveDialog, validDialog] : [] };
  assert.equal(runPageFunction(xReadLine, validDocument), new Date(2026, 9, 29, 15, 7).getTime());
  const wrongWeekdayDialog = { innerText: 'Will send on Fri, Oct 29, 2026 at 3:07 PM',
    getAttribute: () => null, getClientRects: () => rect };
  const wrongWeekday = { querySelectorAll: () => [wrongWeekdayDialog] };
  assert.equal(runPageFunction(xReadLine, wrongWeekday), null);
  const rolloverDialog = { innerText: 'Will send on Mon, Nov 31, 2026 at 3:07 PM',
    getAttribute: () => null, getClientRects: () => rect };
  const rollover = { querySelectorAll: () => [rolloverDialog] };
  assert.equal(runPageFunction(xReadLine, rollover), null);
  const noDialog = { body: { innerText: validDialog.innerText }, querySelectorAll: () => [] };
  assert.equal(runPageFunction(xReadLine, noDialog), null);
});

test('Threads confirmation needs numeric month/day and time in the active composer', () => {
  const target = new Date(2026, 9, 29, 15, 7);
  const offsetMinutes = -target.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetRemainder = Math.abs(offsetMinutes) % 60;
  const zone = `GMT${offsetSign}${offsetHours}${offsetRemainder ? `:${String(offsetRemainder).padStart(2, '0')}` : ''}`;
  const dialog = { innerText: `10월 29일 목요일 오후 3:07 ${zone}에 게시 예정` };
  const document = { body: { innerText: '10월 30일 금요일 오후 3:07 GMT+9에 게시 예정' },
    querySelectorAll: selector => selector === '[role=dialog]' ? [
      { innerText: '10월 30일 금요일 오후 3:07 GMT+9에 게시 예정', getAttribute: () => 'true', getClientRects: () => [] },
      { ...dialog, getAttribute: () => null, getClientRects: () => [{ x: 0, y: 0, width: 400, height: 400 }] },
    ] : [] };
  assert.equal(runPageFunction(thCheckLine, document, target.getTime()).ok, true);
  dialog.innerText = '목요일 오후 3:07 GMT+9에 게시 예정';
  assert.equal(runPageFunction(thCheckLine, document, target.getTime()).reason, 'date_unconfirmed');
  dialog.innerText = `10월 30일 목요일 오후 3:07 ${zone}에 게시 예정`;
  assert.equal(runPageFunction(thCheckLine, document, target.getTime()).ok, false);
  dialog.innerText = `10월 29일 목요일 오후 3:070 ${zone}에 게시 예정`;
  assert.equal(runPageFunction(thCheckLine, document, target.getTime()).ok, false);
  dialog.innerText = `10월 29일 목요일 오후 3:07:00 ${zone}에 게시 예정`;
  assert.equal(runPageFunction(thCheckLine, document, target.getTime()).ok, false);
  const mismatchedZone = offsetMinutes === 540 ? 'GMT+0' : 'GMT+9';
  dialog.innerText = `10월 29일 목요일 오후 3:07 ${mismatchedZone}에 게시 예정`;
  assert.equal(runPageFunction(thCheckLine, document, target.getTime()).reason, 'timezone_mismatch');
  const missing = { body: { innerText: '10월 29일 목요일 오후 3:07 게시 예정' }, querySelectorAll: () => [] };
  assert.equal(runPageFunction(thCheckLine, missing, target.getTime()).reason, 'confirmation_missing');
});

test('numeric page date parts match the target exactly when a source exposes them', () => {
  const target = new Date(2026, 9, 29, 15, 7);
  assert.equal(scheduleDatePartsMatch({ year: 2026, month: 10, day: 29 }, target.getTime()), true);
  assert.equal(scheduleDatePartsMatch({ year: 2026, month: 10, day: 30 }, target.getTime()), false);
  assert.equal(scheduleDatePartsMatch({ year: 2026, month: 11, day: 29 }, target.getTime()), false);
  assert.equal(scheduleDatePartsMatch({ year: 2026, month: 2, day: 29 }, target.getTime()), false);
  assert.equal(scheduleDatePartsMatch({ year: '2026', month: 10, day: 29 }, target.getTime()), false);
});

test('Threads picker guards missing boxes and selects the correct day at a month boundary', () => {
  const missing = { querySelector: () => null };
  assert.deepEqual(JSON.parse(JSON.stringify(runPageFunction(thMonthDelta, missing, Date.now()))), { error: 'TH_NO_PICKER' });
  assert.equal(runPageFunction(thNavButton, missing, 1), null);
  assert.equal(runPageFunction(thDayCell, missing, Date.now()), null);
  const noHeader = { querySelector: () => ({ parentElement: null }) };
  assert.deepEqual(JSON.parse(JSON.stringify(runPageFunction(thMonthDelta, noHeader, Date.now()))),
    { error: 'TH_MONTH_HEADER_MISSING' });

  const labels = ['26', '27', '28', '29', '30', '31', ...Array.from({ length: 30 }, (_, i) => String(i + 1)),
    ...Array.from({ length: 12 }, (_, i) => String(i + 1))];
  const cells = labels.map((label, index) => fakeDay(label, index));
  const box = { innerText: '2026년 11월', parentElement: null, querySelectorAll: selector => selector === 'span' ? cells : [] };
  const hh = { parentElement: box };
  const calendar = { querySelector: selector => selector === 'input[placeholder=hh]' ? hh : null };
  const day30Index = 6 + 29;
  assert.deepEqual(JSON.parse(JSON.stringify(runPageFunction(thDayCell, calendar, new Date(2026, 10, 30, 15, 7).getTime()))),
    [day30Index * 10 + 5, day30Index * 20 + 10]);
  const disabledCells = labels.map((label, index) => fakeDay(label, index, index === day30Index));
  box.querySelectorAll = selector => selector === 'span' ? disabledCells : [];
  assert.equal(runPageFunction(thDayCell, calendar, new Date(2026, 10, 30, 15, 7).getTime()), null);
});
