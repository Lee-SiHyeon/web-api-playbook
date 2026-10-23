// Post a comment as the channel on a watch/Shorts page and pin it (own Canary tab, closed at the end). 2026-10-21.
//   node scripts/youtube-pin-comment.mjs <videoId> <comment.txt> <shotDir> [--shorts] [--replace]
// Newlines go in with execCommand(insertLineBreak) (plain Enter submits). --replace deletes our previous top comment first.
// Only public videos take comments: scheduled Shorts are pinned after they go live (shorts-distribute.mjs --channels=youtube-pin).
import fs from 'node:fs';
import path from 'node:path';
const [vid, file, shotDir] = process.argv.slice(2);
const SHORTS = process.argv.includes('--shorts');
const text = fs.readFileSync(file, 'utf8').trim();
const CDP = 'http://127.0.0.1:9333';
const url = SHORTS ? `https://www.youtube.com/shorts/${vid}` : `https://www.youtube.com/watch?v=${vid}`;
const t = await (await fetch(CDP + '/json/new?' + url, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const m = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); return m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { fs.mkdirSync(shotDir, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, n + '.png'), Buffer.from(s.result.data, 'base64')); };
const waitFor = async (expr, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await ev(expr); if (v) return v; await sleep(700); } return null; };
try {
  await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(6000);
  if (SHORTS) { // open the comments panel of the short
    await ev(`(()=>{const b=[...document.querySelectorAll('button,yt-button-shape button')].find(x=>/댓글/.test(x.getAttribute('aria-label')||''));b&&b.click();return !!b})()`); await sleep(3000);
  } else { for (let i = 0; i < 6; i++) { await ev('window.scrollBy(0, 700)'); await sleep(1200); } }
  if (process.argv.includes('--replace')) {
    const m = await waitFor(`(()=>{const th=document.querySelector('ytd-comment-thread-renderer');if(!th||!/lifehack__ailab/.test(th.innerText))return false;th.scrollIntoView({block:'center'});th.querySelector('#action-menu button').click();return true})()`, 30000);
    if (m) { await sleep(1200); await ev(`(()=>{const it=[...document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item')].find(x=>/삭제/.test(x.innerText));it&&it.click();return !!it})()`); await sleep(1200);
      const d = await ev(`(()=>{const b=[...document.querySelectorAll('yt-confirm-dialog-renderer button, tp-yt-paper-dialog button')].find(x=>/삭제/.test(x.innerText));if(!b)return null;b.click();return true})()`); console.log(JSON.stringify({ deleted: !!d })); await sleep(4000); }
  }
  const ph = await waitFor(`(()=>{const p=document.querySelector('#placeholder-area');if(p){p.scrollIntoView({block:'center'});p.click();return true}return false})()`, 40000);
  if (!ph) throw new Error('NO_COMMENT_BOX');
  await sleep(1500);
  const ok = await waitFor(`(()=>{const e=document.querySelector('#contenteditable-root');if(!e)return false;e.focus();return true})()`, 15000);
  if (!ok) throw new Error('NO_EDITOR');
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (i) await ev("document.execCommand('insertLineBreak')");
    if (line) await send('Input.insertText', { text: line });
  }
  await sleep(1000); await shot('1-typed');
  const typed = await ev(`document.querySelector('#contenteditable-root').innerText`);
  console.log(JSON.stringify({ typedChars: typed.length, expected: text.length, lines: typed.split('\n').length }));
  const sub = await ev(`(()=>{const b=document.querySelector('#submit-button button, #submit-button');if(!b)return null;b.click();return true})()`);
  if (!sub) throw new Error('NO_SUBMIT');
  await sleep(5000); await shot('2-posted');
  // pin: the action menu of our new comment (first comment thread) -> 고정
  const first = await waitFor(`(()=>{const th=document.querySelector('ytd-comment-thread-renderer');if(!th)return false;const b=th.querySelector('#action-menu button');if(!b)return false;b.click();return true})()`, 20000);
  if (!first) throw new Error('NO_ACTION_MENU');
  await sleep(1500);
  const pin = await ev(`(()=>{const it=[...document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item')].find(x=>/고정/.test(x.innerText));if(!it)return null;it.click();return it.innerText.trim()})()`);
  if (!pin) { await shot('3-menu'); throw new Error('NO_PIN_ITEM'); }
  await sleep(1500);
  const conf = await ev(`(()=>{const b=[...document.querySelectorAll('yt-confirm-dialog-renderer button, #confirm-button button, tp-yt-paper-dialog button')].find(x=>/고정/.test(x.innerText));if(!b)return null;b.click();return b.innerText.trim()})()`);
  await sleep(4000); await shot('4-pinned');
  const badge = await ev(`(()=>{const th=document.querySelector('ytd-comment-thread-renderer');return th?(th.querySelector('#pinned-comment-badge')?.innerText||th.innerText.slice(0,80)):null})()`);
  console.log(JSON.stringify({ pinItem: pin, confirm: conf, badge }));
} finally { ws.close(); await fetch(CDP + '/json/close/' + t.id).catch(() => {}); }
