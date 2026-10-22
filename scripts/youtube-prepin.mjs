// Pin a comment on a SCHEDULED video before it goes live (2026-10-22, Tokyo Shorts). Scheduled = private, which takes no
// comments, so: Studio edit -> 공개 상태 -> 저장 또는 게시 -> 일부 공개 -> 저장; post + pin (youtube-pin-comment.mjs);
// edit -> 공개 상태 -> 예약 -> date/time -> 완료 -> 저장; reload readback of "예약됨" + date + time. Unlisted lasts ~1 min and is
// link-only. Comments survive the visibility changes.
//   node scripts/youtube-prepin.mjs <videoId> <comment.txt> "<2026. 10. 24.>" "<오후 6:00>" [--shorts]
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const [vid, commentFile, date, time, ...flags] = process.argv.slice(2);
const CDP = process.env.YT_STUDIO_CDP || 'http://127.0.0.1:9333';
const EDIT = `https://studio.youtube.com/video/${vid}/edit`;
const out = { videoId: vid, date, time };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = await (await fetch(CDP + '/json/new?' + EDIT, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
const byText = (re) => ev(`(()=>{const re=new RegExp(${JSON.stringify(re)});const c=[...document.querySelectorAll('*')].filter(x=>x.offsetParent!==null&&re.test((x.innerText||'').trim()));c.sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length);const e=c[0];if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
const state = () => ev(`([...document.querySelectorAll('*')].find(e=>e.children.length===0&&/^(일부 공개|예약됨|비공개|공개)$/.test((e.innerText||'').trim())&&e.offsetParent)||{}).innerText||null`);
const when = () => ev(`[...document.querySelectorAll('ytcp-datetime-picker')].map(e=>e.innerText.replace(/\\s+/g,' ')+' '+[...e.querySelectorAll('input')].map(i=>i.value).join(' ')).join('|')`);
const save = async () => { await ev(`(document.querySelector('ytcp-button#save').click(),1)`); await sleep(6000); return ev(`(document.body.innerText.match(/변경사항이 저장됨|저장하지 못했[^\\n]*/)||[null])[0]`); };
const open = async () => { await send('Page.navigate', { url: EDIT }); await sleep(10000); const s = await state(); const pt = await byText(`^${s}$`); if (!pt) throw new Error('NO_VISIBILITY_TRIGGER'); await click(pt); await sleep(2500); return s; };
try {
  await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  out.before = await open();
  if (out.before !== '예약됨') throw new Error('NOT_SCHEDULED ' + out.before);
  // 1) unlisted
  await click(await byText('^저장 또는 게시$')); await sleep(1500);
  await ev(`(document.querySelector('tp-yt-paper-radio-button[name=UNLISTED]').click(),1)`); await sleep(800);
  await click(await byText('^완료$')); await sleep(1500);
  out.unlisted = await save();
  // 2) pin (separate script, own tab)
  const r = spawnSync(process.execPath, [path.join(HERE, 'youtube-pin-comment.mjs'), vid, commentFile, path.join(os.tmpdir(), 'prepin-' + vid), ...(flags.includes('--shorts') ? ['--shorts'] : [])], { encoding: 'utf8', timeout: 240000 });
  const last = String(r.stdout || '').trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
  out.pin = last ? JSON.parse(last) : { error: String(r.stderr || '').slice(-300) };
  // 3) back to the schedule (always, even if the pin failed)
  await open();
  await click(await byText('^예약$')); await sleep(1500);
  // the date is a dropdown (text "2026. 10. 23."); its calendar popup holds the editable input (value "2026. 10. 23.")
  await click(await byText('^\\d{4}\\. \\d+\\. \\d+\\.$')); await sleep(1500);
  const dateIn = await ev(`(()=>{const i=[...document.querySelectorAll('input')].find(e=>e.offsetParent&&/^\\d{4}\\./.test(e.value));if(!i)return false;i.focus();i.select();return true})()`);
  if (!dateIn) throw new Error('NO_DATE_INPUT');
  await send('Input.insertText', { text: date }); await key('Enter', 'Enter', 13); await sleep(500); await key('Escape', 'Escape', 27); await sleep(800);
  const tp = await ev(`(()=>{const i=[...document.querySelectorAll('input')].find(e=>e.offsetParent&&/^오[전후] \\d/.test(e.value));if(!i)return null;i.scrollIntoView({block:'center'});const r=i.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
  await click(tp); await sleep(1500);
  out.timePicked = await ev(`(()=>{const it=[...document.querySelectorAll('tp-yt-paper-item,[role=option]')].find(e=>e.offsetParent&&e.innerText.trim()===${JSON.stringify(time)});if(!it)return false;it.scrollIntoView({block:'center'});it.click();return true})()`);
  await sleep(1200);
  out.whenSet = await when();
  if (!out.whenSet.includes(date.replace(/\.$/, '')) || !out.whenSet.includes(time)) throw new Error('SCHEDULE_MISMATCH');
  await click(await byText('^완료$')); await sleep(1500);
  out.rescheduled = await save();
  // 4) readback
  out.after = await open(); await sleep(1000);
  out.whenNow = await when();
  out.ok = out.after === '예약됨' && out.whenNow.includes(time) && /고정함/.test(out.pin?.badge || '');
} catch (e) { out.ok = false; out.error = e.message; process.exitCode = 2; }
finally { console.log(JSON.stringify(out)); ws.close(); await fetch(CDP + '/json/close/' + t.id).catch(() => {}); }
