// Native scheduled publishing in the X and Threads web composers (CDP-observed 2026-10-26, logged-in Canary :9333).
// Used by scripts/sns-web-post.mjs --schedule=<time>. The page fills date fields in the BROWSER's local time zone from
// the epoch. A local `YYYY-MM-DD HH:MM` input is explicitly Node-local and is applied only when the browser's offset
// agrees at that instant; an ISO offset or epoch input names an absolute instant directly. The composer confirmation is read back.
// Current Threads confirmation line exposes weekday/time/GMT offset but no numeric date. In that observed state, thCheckLine
// returns `date_unconfirmed` and applySchedule refuses to continue. A selected calendar click alone is not date readback.
//   X: toolbar [data-testid=scheduleOption] -> /compose/post/schedule with six <select>s (month, day, year, hour 1-12,
//      minute, am/pm; React needs the native value setter + change) -> [data-testid=scheduledConfirmationPrimaryAction]
//      -> composer shows "Will send on Thu, Oct 29, 2026 at 3:07 PM" and the Post button reads "Schedule".
//   Threads: dialog header "더 보기" (⋯) -> menu "예약..." -> calendar ("2026년 10월", ‹ › buttons, day <span>s with the
//      neighbouring months' days at both ends, past days aria-disabled) + 24 h inputs placeholder hh / mm -> "완료"
//      -> dialog shows "목요일 오후 3:07 GMT+9에 게시 예정" and the post button reads "예약".

function scheduleFail(code, detail = '') {
  throw new Error(`${code}${detail ? ` ${detail}` : ''}`);
}

function checkedParts(year, month, day, hour, minute, second = 0, millisecond = 0) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999 ||
      !Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59 ||
      !Number.isInteger(second) || second < 0 || second > 59 ||
      !Number.isInteger(millisecond) || millisecond < 0 || millisecond > 999) {
    scheduleFail('SCHEDULE_BAD_TIME');
  }
  return { year, month, day, hour, minute, second, millisecond };
}

function sameLocalParts(date, parts) {
  return date.getFullYear() === parts.year && date.getMonth() + 1 === parts.month && date.getDate() === parts.day &&
    date.getHours() === parts.hour && date.getMinutes() === parts.minute && date.getSeconds() === parts.second &&
    date.getMilliseconds() === parts.millisecond;
}

// Use only when the page exposes numeric calendar fields for the selected target.
// The current Threads confirmation line does not expose them.
export function scheduleDatePartsMatch(parts, when) {
  if (!parts || typeof parts !== 'object' || !Number.isFinite(when)) return false;
  const { year, month, day } = parts;
  if (![year, month, day].every(Number.isInteger) || year < 1000 || year > 9999 ||
      month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  const date = new Date(when);
  return date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day;
}

// Resolve the caller's Node-local wall time explicitly. Sampling surrounding offsets
// detects both skipped clock times and the repeated hour at a fall-back transition.
function nodeLocalEpoch(parts) {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute,
    parts.second, parts.millisecond);
  const offsets = new Set();
  for (let delta = -48 * 60; delta <= 48 * 60; delta += 30) {
    offsets.add(new Date(wall + delta * 60_000).getTimezoneOffset());
  }
  const matches = [...offsets]
    .map(offset => wall + offset * 60_000)
    .filter(epoch => sameLocalParts(new Date(epoch), parts));
  if (matches.length === 0) scheduleFail('SCHEDULE_NONEXISTENT_LOCAL_TIME');
  if (matches.length > 1) scheduleFail('SCHEDULE_AMBIGUOUS_LOCAL_TIME');
  return matches[0];
}

function timeInput(input) {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || Math.abs(input) > 8_640_000_000_000_000) scheduleFail('SCHEDULE_BAD_TIME');
    return { epoch: input, kind: 'epoch' };
  }
  if (typeof input !== 'string') scheduleFail('SCHEDULE_BAD_TIME');
  const value = input.trim();
  if (/^\d{12,16}$/.test(value)) {
    const epoch = Number(value);
    if (!Number.isSafeInteger(epoch) || Math.abs(epoch) > 8_640_000_000_000_000) scheduleFail('SCHEDULE_BAD_TIME');
    return { epoch, kind: 'epoch' };
  }

  const offsetMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (offsetMatch) {
    const [, year, month, day, hour, minute, second = '0', fraction = '', zone] = offsetMatch;
    checkedParts(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second),
      Number(fraction.padEnd(3, '0')));
    if (zone !== 'Z') {
      const offset = /[+-](\d{2}):(\d{2})$/.exec(zone);
      if (!offset || Number(offset[1]) > 23 || Number(offset[2]) > 59) scheduleFail('SCHEDULE_BAD_TIME');
    }
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) scheduleFail('SCHEDULE_BAD_TIME');
    return { epoch, kind: 'offset' };
  }

  const localMatch = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (localMatch) {
    const [, year, month, day, hour, minute] = localMatch;
    const parts = checkedParts(Number(year), Number(month), Number(day), Number(hour), Number(minute));
    const epoch = nodeLocalEpoch(parts);
    return { epoch, kind: 'node-local', nodeOffset: new Date(epoch).getTimezoneOffset() };
  }
  scheduleFail('SCHEDULE_BAD_TIME');
}

// Accepts an ISO time with an explicit UTC offset, Node-local `YYYY-MM-DD HH:MM`,
// or epoch milliseconds. Local wall-clock input uses the Node process timezone;
// applying it in a browser with a different timezone is rejected explicitly.
export function parseScheduleTime(input, now = Date.now()) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8_640_000_000_000_000) scheduleFail('SCHEDULE_BAD_NOW');
  const parsed = timeInput(input);
  const epoch = Math.floor(parsed.epoch / 60_000) * 60_000;
  const v = new Date(epoch);
  if (Number.isNaN(v.getTime())) scheduleFail('SCHEDULE_BAD_TIME');
  Object.defineProperties(v, {
    scheduleInputKind: { value: parsed.kind },
    ...(parsed.nodeOffset === undefined ? {} : { scheduleNodeOffset: { value: parsed.nodeOffset } }),
  });
  // both sites refuse past times; X also wants a few minutes of lead. Threads' picker and X allow far more than 30 days ahead
  if (epoch < now + 10 * 60e3) scheduleFail('SCHEDULE_TOO_SOON', `${v.toISOString()} (needs >= 10 min ahead)`);
  if (epoch > now + 60 * 86400e3) scheduleFail('SCHEDULE_TOO_FAR', `${v.toISOString()} (> 60 days)`);
  return v;
}

// page-side functions (run through `(${fn})(...args)` in Runtime.evaluate)
const xSetSelects = (ms) => {
  const d = new Date(ms); const h = d.getHours();
  const dialogs = [...document.querySelectorAll('[role=dialog]')];
  const dialog = dialogs.filter((candidate) => candidate?.getAttribute?.('aria-hidden') !== 'true'
    && typeof candidate?.getClientRects === 'function' && candidate.getClientRects().length > 0).at(-1) ?? null;
  if (!dialog) return { error: 'X_SCHEDULE_DIALOG_MISSING' };
  const sel = [...dialog.querySelectorAll('select')];
  if (sel.length < 6 || ![...sel[0].options].some((o) => o.text === 'January') || ![...sel[5].options].some((o) => o.value === 'am')) return { error: 'X_SCHEDULE_SELECTS', n: sel.length };
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  [d.getMonth() + 1, d.getDate(), d.getFullYear(), (h % 12) || 12, d.getMinutes(), h < 12 ? 'am' : 'pm'].forEach((v, i) => {
    set.call(sel[i], String(v)); sel[i].dispatchEvent(new Event('change', { bubbles: true }));
  });
  return { line: (dialog.innerText.match(/Will send on[^\n]*/) || [])[0] || null };
};
// "Will send on Thu, Oct 29, 2026 at 3:07 PM" -> epoch ms in the page's zone (null when absent)
export const xReadLine = () => {
  const dialogs = [...document.querySelectorAll('[role=dialog]')];
  const dialog = dialogs.filter((candidate) => candidate?.getAttribute?.('aria-hidden') !== 'true'
    && typeof candidate?.getClientRects === 'function' && candidate.getClientRects().length > 0).at(-1) ?? null;
  const m = dialog && /Will send on (\w{3}), (\w{3}) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM)\b/.exec(dialog.innerText);
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const month = months.indexOf(m[2]);
  const day = Number(m[3]); const year = Number(m[4]); const hour12 = Number(m[5]);
  const minute = Number(m[6]); const hour = (hour12 % 12) + (m[7] === 'PM' ? 12 : 0);
  if (month < 0 || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const date = new Date(0); date.setFullYear(year, month, day); date.setHours(hour, minute, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day ||
      weekdays[date.getDay()] !== m[1]) return null;
  return date.getTime();
};
export const thMonthDelta = (ms) => {
  const hh = document.querySelector('input[placeholder=hh]');
  if (!hh) return { error: 'TH_NO_PICKER' };
  let box = hh;
  for (let i = 0; i < 12 && box; i++, box = box.parentElement) {
    if (/^\d{4}년 \d{1,2}월(?:\s|$)/.test(box.innerText || '')) break;
  }
  if (!box) return { error: 'TH_MONTH_HEADER_MISSING' };
  const m = /^(\d{4})년 (\d{1,2})월/.exec(box.innerText || ''); const d = new Date(ms);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number.isNaN(d.getTime())) return { error: 'TH_MONTH_HEADER_INVALID' };
  return { delta: (d.getFullYear() - Number(m[1])) * 12 + (d.getMonth() + 1 - Number(m[2])) };
};
export const thNavButton = (dir) => { // the ‹ › pair beside the month header; returns the centre of the requested one
  const hh = document.querySelector('input[placeholder=hh]'); if (!hh) return null;
  let box = hh;
  for (let i = 0; i < 12 && box; i++, box = box.parentElement) {
    if (/^\d{4}년 \d{1,2}월(?:\s|$)/.test(box.innerText || '')) break;
  }
  if (!box) return null;
  const btns = [...box.querySelectorAll('[role=button], button')].filter((b) => b.querySelector('svg') && !(b.innerText || '').trim());
  const b = dir > 0 ? btns[1] : btns[0]; if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
};
export const thDayCell = (ms) => {
  const day = new Date(ms).getDate();
  const hh = document.querySelector('input[placeholder=hh]'); if (!hh) return null;
  let box = hh;
  for (let i = 0; i < 12 && box; i++, box = box.parentElement) {
    if (/^\d{4}년 \d{1,2}월(?:\s|$)/.test(box.innerText || '')) break;
  }
  if (!box) return null;
  const header = /^(\d{4})년 (\d{1,2})월/.exec(box.innerText || '');
  const date = new Date(ms);
  if (!header || Number(header[1]) !== date.getFullYear() || Number(header[2]) !== date.getMonth() + 1) return null;
  const cells = [...box.querySelectorAll('span')].filter((e) => /^\d{1,2}$/.test(e.innerText.trim()) && !e.children.length);
  const start = cells.findIndex((x) => x.innerText.trim() === '1');
  const length = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  if (start < 0 || start + length > cells.length) return null;
  const matches = cells.slice(start, start + length).filter((x) => x.innerText.trim() === String(day));
  if (matches.length !== 1) return null;
  const cell = matches[0];
  if (!cell || cell.closest('[aria-disabled=true]')) return null; const r = cell.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
};
// The selected dialog must confirm the numeric calendar date and time. A weekday by itself is not enough.
export const thCheckLine = (ms) => {
  const dialogs = [...document.querySelectorAll('[role=dialog]')];
  const dialog = dialogs.filter((candidate) => candidate?.getAttribute?.('aria-hidden') !== 'true'
    && typeof candidate?.getClientRects === 'function' && candidate.getClientRects().length > 0).at(-1) ?? null;
  const line = (dialog?.innerText.match(/[^\n]*게시 예정/) || [])[0] || null;
  if (!line) return { line, ok: false, reason: 'confirmation_missing' };
  const d = new Date(ms); const h = d.getHours();
  const want = `${h < 12 ? '오전' : '오후'} ${(h % 12) || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
  const weekdays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
  const dateMatch = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일|(\d{1,2})월\s*(\d{1,2})일/.exec(line);
  if (!dateMatch) return { line, want, ok: false, reason: 'date_unconfirmed' };
  const year = dateMatch[1] ? Number(dateMatch[1]) : d.getFullYear();
  const month = Number(dateMatch[1] ? dateMatch[2] : dateMatch[4]);
  const day = Number(dateMatch[1] ? dateMatch[3] : dateMatch[5]);
  const weekday = /(일요일|월요일|화요일|수요일|목요일|금요일|토요일)/.exec(line)?.[1];
  const dateMatches = year === d.getFullYear() && month === d.getMonth() + 1 && day === d.getDate();
  const weekdayMatches = !weekday || weekday === weekdays[d.getDay()];
  const timeMatch = /(오전|오후)\s+(\d{1,2}):(\d{2})(?=\s|에|분|$)/.exec(line);
  const timeMatches = Boolean(timeMatch && timeMatch[0] === want);
  const zoneMatch = /\b(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?\b/i.exec(line);
  let zoneMatches = true;
  if (zoneMatch) {
    const hours = Number(zoneMatch[2]); const minutes = Number(zoneMatch[3] ?? 0);
    const sourceOffset = (zoneMatch[1] === '+' ? 1 : -1) * (hours * 60 + minutes);
    zoneMatches = hours <= 23 && minutes <= 59 && sourceOffset === -d.getTimezoneOffset();
  }
  const ok = dateMatches && weekdayMatches && timeMatches && zoneMatches;
  return { line, want, ok, reason: ok ? 'confirmed'
    : !zoneMatches ? 'timezone_mismatch' : !dateMatches ? 'date_mismatch'
      : !weekdayMatches || !timeMatches ? 'confirmation_mismatch' : 'date_unconfirmed' };
};

// Fills the schedule in the open composer. io = { call(fn, ...args), click([x, y]), key(text), selectAll(), sleep(ms) }.
// Returns { scheduledFor, line }; throws on any mismatch so nothing is posted at a wrong time.
export async function applySchedule(site, when, io) {
  if (!(when instanceof Date) || !Number.isFinite(when.getTime()) || when.getSeconds() !== 0 || when.getMilliseconds() !== 0) {
    throw new Error('SCHEDULE_TIME_UNVALIDATED');
  }
  const ms = when.getTime();
  if (when.scheduleInputKind === 'node-local') {
    const browserOffset = await io.call((epoch) => new Date(epoch).getTimezoneOffset(), ms);
    if (!Number.isInteger(browserOffset) || browserOffset !== when.scheduleNodeOffset) {
      throw new Error(`SCHEDULE_TIMEZONE_MISMATCH nodeOffset=${when.scheduleNodeOffset} browserOffset=${browserOffset}`);
    }
  }
  if (site === 'x') {
    const b = await io.call(() => { const e = document.querySelector('[role=dialog] [data-testid=scheduleOption]') || document.querySelector('[data-testid=scheduleOption]'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    if (!b) throw new Error('X_NO_SCHEDULE_BUTTON');
    await io.click(b); await io.sleep(2000);
    const r = await io.call(xSetSelects, ms); if (r?.error) throw new Error(r.error);
    await io.sleep(500);
    const c = await io.call(() => { const e = document.querySelector('[data-testid=scheduledConfirmationPrimaryAction]'); if (!e) return null; const q = e.getBoundingClientRect(); return [q.x + q.width / 2, q.y + q.height / 2]; });
    if (!c) throw new Error('X_NO_SCHEDULE_CONFIRM');
    await io.click(c); await io.sleep(2000);
    const got = await io.call(xReadLine);
    const line = await io.call(() => (document.querySelector('[role=dialog]')?.innerText.match(/Will send on[^\n]*/) || [])[0] || null);
    if (got !== ms) throw new Error(`X_SCHEDULE_MISMATCH want ${when.toISOString()} got ${got ? new Date(got).toISOString() : null} (${line})`);
    const label = await io.call(() => (document.querySelector('[role=dialog] [data-testid=tweetButton]') || document.querySelector('[data-testid=tweetButton]'))?.innerText.trim());
    if (!/^(Schedule|예약)/.test(label || '')) throw new Error(`X_SCHEDULE_BUTTON_LABEL ${label}`);
    return { scheduledFor: when.toISOString(), line };
  }
  // threads
  // the dialog's ⋯ is a div[role=button][aria-label="더 보기"] (the page header has svg ones with the same label, outside the dialog)
  const more = await io.call(() => { const s = document.querySelector('[role=dialog] [aria-label="더 보기"], [role=dialog] [aria-label="More"]'); if (!s) return null; const e = s.closest('[role=button], button') || s; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  if (!more) throw new Error('TH_NO_MORE_MENU');
  await io.click(more); await io.sleep(1500);
  const item = await io.call(() => { const e = [...document.querySelectorAll('[role=menuitem], [role=option], [role=button]')].find((x) => /^(예약\.\.\.|예약…|Schedule\.\.\.|Schedule…)$/.test((x.innerText || '').trim())); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  if (!item) throw new Error('TH_NO_SCHEDULE_ITEM');
  await io.click(item); await io.sleep(2000);
  const md = await io.call(thMonthDelta, ms); if (md?.error) throw new Error(md.error);
  for (let i = 0; i < Math.abs(md.delta); i++) { const nb = await io.call(thNavButton, Math.sign(md.delta)); if (!nb) throw new Error('TH_NO_MONTH_NAV'); await io.click(nb); await io.sleep(700); }
  if ((await io.call(thMonthDelta, ms)).delta !== 0) throw new Error('TH_MONTH_NAV_FAILED');
  const cell = await io.call(thDayCell, ms); if (!cell) throw new Error('TH_NO_DAY_CELL');
  await io.click(cell); await io.sleep(500);
  const d = new Date(ms);
  for (const [ph, v] of [['hh', String(d.getHours()).padStart(2, '0')], ['mm', String(d.getMinutes()).padStart(2, '0')]]) {
    // the page clock decides the hour: read it from the page, not Node (same machine, but keep one source of truth)
    const pv = await io.call((q, t) => { const x = new Date(t); return q === 'hh' ? String(x.getHours()).padStart(2, '0') : String(x.getMinutes()).padStart(2, '0'); }, ph, ms);
    await io.click(await io.call((q) => { const r = document.querySelector(`input[placeholder=${q}]`).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, ph));
    await io.sleep(200); await io.selectAll(); await io.key(pv || v); await io.sleep(300);
  }
  const done = await io.call(() => { const b = [...document.querySelectorAll('[role=button], button')].find((x) => /^(완료|Done)$/.test((x.innerText || '').trim())); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  if (!done) throw new Error('TH_NO_DONE');
  await io.click(done); await io.sleep(1500);
  const chk = await io.call(thCheckLine, ms);
  if (!chk.ok) throw new Error(`TH_SCHEDULE_MISMATCH want ${chk.want} got ${chk.line} (${chk.reason})`);
  return { scheduledFor: when.toISOString(), line: chk.line };
}
