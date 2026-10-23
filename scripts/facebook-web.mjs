// Facebook web, driven in the logged-in automation Canary (CDP 9333); own tab, closed at the end. 2026-10-23.
// Owner 2026-10-23: "Facebook도 웹플레이북 작업해".
//   node scripts/facebook-web.mjs login  [--shots=<dir>]   -> types the DPAPI identity (ProtectedStore "facebook-login" = {email,password})
//                                                             into facebook.com/login; reports checkpoint / 2-step code screens
//   node scripts/facebook-web.mjs code <code> [--shots=<dir>] -> enters a login/2-step code on the open checkpoint screen
//   node scripts/facebook-web.mjs whoami                    -> logged-in profile name + the pages this profile manages
// Nothing (cookies, password) leaves the browser tab or is printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProtectedStore } from '../lib/protected-store.mjs';

const CDP = process.env.FB_CDP || 'http://127.0.0.1:9333';
const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const args = rest.filter((a) => !a.startsWith('--'));
const shots = opt.shots || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'facebook');
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STATE = path.join(shots, 'login-tab.txt'); // a checkpoint screen stays open for `code`

async function open(url, reuse) {
  let t = null;
  if (reuse && fs.existsSync(STATE)) t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.id === fs.readFileSync(STATE, 'utf8').trim()) || null;
  if (!t) t = await (await fetch(`${CDP}/json/new?${url}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let n = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
  const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64')); };
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.bringToFront'); // Facebook ignores clicks in a background tab (the composer never opens)
  return { t, ws, send, ev, shot, close: async () => { ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); } };
}
const pageText = (ev) => ev(`document.body.innerText.replace(/\\s+/g, ' ').slice(0, 600)`);
const loggedIn = (ev) => ev(`!document.querySelector('input[name=pass]') && !!document.querySelector('[aria-label="계정"], [aria-label="Account"], [aria-label="Your profile"], [aria-label="내 프로필"], div[role=navigation] a[href*="/me"], [aria-label*="프로필"]')`);
const checkpoint = (url, text) => /checkpoint|two_step|two_factor|login\/device-based|approvals/.test(url) || /인증|코드|승인|보안 확인|Check your|confirm|Enter the code/i.test(text);

const out = {};
if (cmd === 'login') {
  const id = JSON.parse(await new ProtectedStore().read('facebook-login'));
  const b = await open('https://www.facebook.com/login/');
  let keep = false;
  try {
    await sleep(6000);
    if (await loggedIn(b.ev)) { out.already = true; }
    else {
      await b.ev(`(()=>{const e=document.querySelector('input[name=email]');e.focus();e.select&&e.select()})()`);
      await b.send('Input.insertText', { text: id.email });
      await b.ev(`(()=>{const e=document.querySelector('input[name=pass]');e.focus()})()`);
      await b.send('Input.insertText', { text: id.password });
      await sleep(400);
      await b.ev(`(()=>{const x=document.querySelector('button[name=login], #loginbutton, [type=submit]');x&&x.click()})()`);
      await sleep(9000);
    }
    await b.shot('login-1');
    out.url = await b.ev('location.href'); const text = await pageText(b.ev);
    out.loggedIn = await loggedIn(b.ev);
    if (!out.loggedIn && checkpoint(out.url, text)) { out.checkpoint = true; out.text = text.slice(0, 300); keep = true; fs.writeFileSync(STATE, b.t.id); }
    else if (!out.loggedIn) out.text = text.slice(0, 300);
  } finally { console.log(JSON.stringify(out)); if (keep) b.ws.close(); else await b.close(); }
} else if (cmd === 'code') {
  const b = await open('https://www.facebook.com/', true);
  let keep = false;
  try {
    await b.ev(`(()=>{const e=[...document.querySelectorAll('input')].find(x=>x.offsetParent&&!['hidden','submit','checkbox','radio'].includes(x.type));e&&e.focus();return !!e})()`);
    await b.send('Input.insertText', { text: args[0] });
    await sleep(500);
    out.submit = await b.ev(`(()=>{const x=[...document.querySelectorAll('button, [role=button], input[type=submit]')].find(x=>x.offsetParent&&/^(계속|제출|확인|Continue|Submit)$/.test((x.innerText||x.value||'').trim()));if(!x)return null;x.click();return (x.innerText||x.value).trim()})()`);
    await sleep(9000); await b.shot('login-code');
    out.url = await b.ev('location.href'); out.loggedIn = await loggedIn(b.ev); out.text = (await pageText(b.ev)).slice(0, 300);
    keep = !out.loggedIn;
  } finally { console.log(JSON.stringify(out)); if (keep) b.ws.close(); else { await b.close(); fs.rmSync(STATE, { force: true }); } }
} else if (cmd === 'whoami') {
  const b = await open('https://www.facebook.com/pages/?category=your_pages');
  try {
    await sleep(8000); await b.shot('whoami');
    out.loggedIn = await loggedIn(b.ev);
    out.text = (await pageText(b.ev)).slice(0, 500);
  } finally { console.log(JSON.stringify(out)); await b.close(); }
} else if (cmd === 'post') {
  // node facebook-web.mjs post <video|image> <caption.txt> [--dry] : a feed post as the active profile (switch to the Page first:
  // the account acts as the Page "생활이득 AI 연구소" after page creation). --dry stops before 게시.
  const [file, capFile] = args; const caption = fs.readFileSync(capFile, 'utf8').replace(/\r/g, '').trim();
  const b = await open('https://www.facebook.com/');
  try { steps: {
    await sleep(7000);
    out.actor = await b.ev(`(document.querySelector('[role=main] [role=button] span, [aria-label*="무슨 생각"]')?.innerText || '').slice(0, 60)`);
    await b.send('Page.enable'); await b.send('DOM.enable');
    await b.send('Page.setInterceptFileChooserDialog', { enabled: true });
    const chosen = new Promise((resolve) => { const h = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.fileChooserOpened') { b.ws.removeEventListener('message', h); resolve(m.params); } }; b.ws.addEventListener('message', h); });
    // composer "사진/동영상" icon on the 무슨 생각 bar
    const icon = await b.ev(`(() => { const e = [...document.querySelectorAll('[aria-label="사진/동영상"], [aria-label="Photo/video"]')].find((x) => x.getBoundingClientRect().width); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!icon) throw new Error('NO_PHOTO_VIDEO_BUTTON');
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: icon[0], y: icon[1], button: 'left', clickCount: 1 });
    await sleep(3500); await b.shot('post-1-dialog');
    // the dialog's drop area "사진/동영상 추가" opens the chooser
    const add = await b.ev(`(() => { const e = [...document.querySelectorAll('[role=dialog] *')].find((x) => /^(사진\\/동영상 추가|Add photos\\/videos)$/.test((x.innerText || '').trim()) && x.getBoundingClientRect().width); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (add) for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: add[0], y: add[1], button: 'left', clickCount: 1 });
    const fc = await Promise.race([chosen, sleep(15000).then(() => null)]);
    if (!fc) throw new Error('NO_FILE_CHOOSER');
    await b.send('DOM.setFileInputFiles', { files: [path.resolve(file)], backendNodeId: fc.backendNodeId });
    await sleep(8000); await b.shot('post-2-file');
    // caption: the dialog's contenteditable text box
    const box = await b.ev(`(() => { const e = document.querySelector('[role=dialog] [contenteditable=true]'); if (!e) return false; e.focus(); return true; })()`);
    if (!box) throw new Error('NO_TEXT_BOX');
    // newlines: Shift+Enter (execCommand insertLineBreak selects and replaces in this editor; only the last line survived)
    const nlKey = async () => { for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 }); };
    for (const [i, line] of caption.split('\n').entries()) { if (i) await nlKey(); if (line) await b.send('Input.insertText', { text: line }); }
    await sleep(1500); await b.shot('post-3-text');
    out.typed = await b.ev(`document.querySelector('[role=dialog] [contenteditable=true]').innerText.length`);
    // AI 레이블 추가 (host Ria is AI-generated): switch on if the composer offers it
    out.aiLabel = await b.ev(`(() => { const rows = [...document.querySelectorAll('[role=dialog] *')].filter((x) => /^AI 레이블 추가/.test((x.innerText || '').trim())); for (const row of rows) { let el = row; for (let k = 0; k < 6 && el; k++, el = el.parentElement) { const sw = el.querySelector('input[type=checkbox], [role=switch]'); if (sw) { const on = sw.checked ?? (sw.getAttribute('aria-checked') === 'true'); if (!on) sw.click(); return 'on'; } } } return null; })()`);
    await sleep(800); await b.shot('post-3b-ai');
    if (opt.dry) { out.dry = true; break steps; }
    // 다음 (newer composer) then 게시
    for (const label of ['다음', '게시']) {
      const btn = await b.ev(`(() => { const e = [...document.querySelectorAll('[role=dialog] [role=button], [role=dialog] button')].find((x) => (x.innerText || x.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)} && x.getAttribute('aria-disabled') !== 'true'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      if (!btn) { if (label === '다음') continue; throw new Error('NO_POST_BUTTON'); }
      for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: btn[0], y: btn[1], button: 'left', clickCount: 1 });
      await sleep(4000);
    }
    // wait for the upload/processing to finish and the dialog to close
    for (let i = 0; i < 90 && (await b.ev(`!!document.querySelector('[role=dialog] [contenteditable=true]')`)); i++) await sleep(4000);
    // the upload keeps running in this tab after the dialog closes: wait until no progress text is left (closing kills it)
    for (let i = 0; i < 120 && (await b.ev(`/업로드 중|게시하는 중|게시 중|처리 중|Uploading|Posting/.test(document.body.innerText)`)); i++) await sleep(5000);
    await sleep(5000); await b.shot('post-4-done');
    out.posted = !(await b.ev(`!!document.querySelector('[role=dialog] [contenteditable=true]')`));
  } } catch (e) { out.error = e.message; await b.shot('post-error').catch(() => {}); process.exitCode = 1; }
  finally { console.log(JSON.stringify(out)); await b.close(); }
} else { console.error('usage: facebook-web.mjs login|code <code>|whoami|post <file> <caption.txt> [--dry] [--shots=dir]'); process.exit(2); }
