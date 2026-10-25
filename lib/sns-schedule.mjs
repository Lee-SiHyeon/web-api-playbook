// Native scheduled publishing in the X and Threads web composers (CDP-observed 2026-10-26, logged-in Canary :9333).
// Used by scripts/sns-web-post.mjs --schedule=<time>. All date fields are filled in the BROWSER's local time zone (the page
// computes them from the epoch), and the composer's own confirmation line is read back and compared before posting.
//   X: toolbar [data-testid=scheduleOption] -> /compose/post/schedule with six <select>s (month, day, year, hour 1-12,
//      minute, am/pm; React needs the native value setter + change) -> [data-testid=scheduledConfirmationPrimaryAction]
//      -> composer shows "Will send on Thu, Oct 29, 2026 at 3:07 PM" and the Post button reads "Schedule".
//   Threads: dialog header "더 보기" (⋯) -> menu "예약..." -> calendar ("2026년 10월", ‹ › buttons, day <span>s with the
//      neighbouring months' days at both ends, past days aria-disabled) + 24 h inputs placeholder hh / mm -> "완료"
//      -> dialog shows "목요일 오후 3:07 GMT+9에 게시 예정" and the post button reads "예약".

// "2026-10-29T15:07+09:00", "2026-10-29 15:07" (local), or an epoch in ms. Returns a Date rounded down to the minute.
export function parseScheduleTime(s, now = Date.now()) {
  const v = /^\d{12,}$/.test(String(s)) ? new Date(Number(s)) : new Date(String(s).trim().replace(' ', 'T'));
  if (Number.isNaN(v.getTime())) throw new Error(`SCHEDULE_BAD_TIME ${s}`);
  v.setSeconds(0, 0);
  // both sites refuse past times; X also wants a few minutes of lead. Threads' picker and X allow far more than 30 days ahead
  if (v.getTime() < now + 10 * 60e3) throw new Error(`SCHEDULE_TOO_SOON ${v.toISOString()} (needs >= 10 min ahead)`);
  if (v.getTime() > now + 60 * 86400e3) throw new Error(`SCHEDULE_TOO_FAR ${v.toISOString()} (> 60 days)`);
  return v;
}

// page-side functions (run through `(${fn})(...args)` in Runtime.evaluate)
const xSetSelects = (ms) => {
  const d = new Date(ms); const h = d.getHours();
  const sel = [...document.querySelectorAll('[role=dialog] select')];
  if (sel.length < 6 || ![...sel[0].options].some((o) => o.text === 'January') || ![...sel[5].options].some((o) => o.value === 'am')) return { error: 'X_SCHEDULE_SELECTS', n: sel.length };
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  [d.getMonth() + 1, d.getDate(), d.getFullYear(), (h % 12) || 12, d.getMinutes(), h < 12 ? 'am' : 'pm'].forEach((v, i) => {
    set.call(sel[i], String(v)); sel[i].dispatchEvent(new Event('change', { bubbles: true }));
  });
  return { line: (document.querySelector('[role=dialog]').innerText.match(/Will send on[^\n]*/) || [])[0] || null };
};
// "Will send on Thu, Oct 29, 2026 at 3:07 PM" -> epoch ms in the page's zone (null when absent)
const xReadLine = () => {
  const m = /Will send on \w+, (\w+) (\d+), (\d{4}) at (\d+):(\d+) (AM|PM)/.exec(document.body.innerText);
  if (!m) return null;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1].slice(0, 3));
  const h = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
  return new Date(Number(m[3]), mon, Number(m[2]), h, Number(m[5])).getTime();
};
const thMonthDelta = (ms) => {
  const hh = document.querySelector('input[placeholder=hh]'); if (!hh) return { error: 'TH_NO_PICKER' };
  let box = hh; for (let i = 0; i < 12 && !/^\d{4}년 \d{1,2}월/.test(box.innerText); i++) box = box.parentElement;
  const m = /^(\d{4})년 (\d{1,2})월/.exec(box.innerText); const d = new Date(ms);
  return { delta: (d.getFullYear() - Number(m[1])) * 12 + (d.getMonth() + 1 - Number(m[2])) };
};
const thNavButton = (dir) => { // the ‹ › pair beside the month header; returns the centre of the requested one
  const hh = document.querySelector('input[placeholder=hh]'); let box = hh;
  for (let i = 0; i < 12 && !/^\d{4}년 \d{1,2}월/.test(box.innerText); i++) box = box.parentElement;
  const btns = [...box.querySelectorAll('[role=button], button')].filter((b) => b.querySelector('svg') && !(b.innerText || '').trim());
  const b = dir > 0 ? btns[1] : btns[0]; if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
};
const thDayCell = (ms) => {
  const day = new Date(ms).getDate();
  const hh = document.querySelector('input[placeholder=hh]'); let box = hh;
  for (let i = 0; i < 12 && !/^\d{4}년 \d{1,2}월/.test(box.innerText); i++) box = box.parentElement;
  const cells = [...box.querySelectorAll('span')].filter((e) => /^\d{1,2}$/.test(e.innerText.trim()) && !e.children.length);
  const a = cells.findIndex((x) => x.innerText.trim() === '1'); const b = cells.findIndex((x, i) => i > a && x.innerText.trim() === '1');
  const cell = cells.slice(a, b < 0 ? undefined : b).find((x) => x.innerText.trim() === String(day));
  if (!cell || cell.closest('[aria-disabled=true]')) return null; const r = cell.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
};
// "목요일 오후 3:07 GMT+9에 게시 예정" / "10월 29일 오후 3:07 …": compare the hour/minute (and the weekday when shown)
const thCheckLine = (ms) => {
  const line = (document.body.innerText.match(/[^\n]*게시 예정/) || [])[0] || null; if (!line) return { line, ok: false };
  const d = new Date(ms); const h = d.getHours();
  const want = `${h < 12 ? '오전' : '오후'} ${(h % 12) || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()] + '요일';
  return { line, want, ok: line.includes(want) && (!/요일/.test(line) || line.includes(wd)) && (!/(\d+)월 (\d+)일/.test(line) || line.includes(`${d.getMonth() + 1}월 ${d.getDate()}일`)) };
};

// Fills the schedule in the open composer. io = { call(fn, ...args), click([x, y]), key(text), selectAll(), sleep(ms) }.
// Returns { scheduledFor, line }; throws on any mismatch so nothing is posted at a wrong time.
export async function applySchedule(site, when, io) {
  const ms = when.getTime();
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
    const line = await io.call(() => (document.body.innerText.match(/Will send on[^\n]*/) || [])[0] || null);
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
  if (!chk.ok) throw new Error(`TH_SCHEDULE_MISMATCH want ${chk.want} got ${chk.line}`);
  return { scheduledFor: when.toISOString(), line: chk.line };
}
