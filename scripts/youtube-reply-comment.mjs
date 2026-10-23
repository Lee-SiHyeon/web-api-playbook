// Reply as the channel under the pinned (first) comment thread of a video, then verify the reply is visible after a reload.
// Own Canary tab (CDP 9333), closed at the end. 2026-10-23.
//   node scripts/youtube-reply-comment.mjs <videoId> <reply.txt> <shotDir>
// Why: YouTube silently drops a single comment with many links (a 41-link pinned comment never appeared, no error, nothing
// held for review). Long link lists go into several short replies under the pinned comment instead; each reply is checked.
// Newlines go in with execCommand(insertLineBreak) (plain Enter submits).
import fs from 'node:fs';
const CDP = process.env.YT_STUDIO_CDP || 'http://127.0.0.1:9333';
const [videoId, file, shots] = process.argv.slice(2);
if (!videoId || !file || !shots) { console.error('usage: youtube-reply-comment.mjs <videoId> <reply.txt> <shotDir>'); process.exit(2); }
const text = fs.readFileSync(file, 'utf8').replace(/\r/g, '').trim();
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = await (await fetch(`${CDP}/json/new?https://www.youtube.com/watch?v=${videoId}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(s.result.data, 'base64')); };
const waitFor = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await ev(expr); if (v) return v; await sleep(700); } return null; };
const toComments = async () => {
  await ev('document.querySelector("video")?.pause()');
  for (let i = 0; i < 6; i++) { await ev('window.scrollBy(0, 700)'); await sleep(1100); }
  return waitFor(`(()=>{const th=document.querySelector('ytd-comment-thread-renderer');if(!th)return false;th.scrollIntoView({block:'center'});return true})()`, 30000);
};
// replies of the first thread, after expanding them
const replies = async () => {
  await ev(`(()=>{const th=document.querySelector('ytd-comment-thread-renderer');const b=th&&th.querySelector('#more-replies button, #more-replies');b&&b.click()})()`);
  await sleep(3000);
  return ev(`[...(document.querySelector('ytd-comment-thread-renderer')?.querySelectorAll('#replies ytd-comment-view-model, #replies ytd-comment-renderer')||[])].map(r=>(r.querySelector('#content-text')?.innerText||'').slice(0,60))`);
};
const out = {};
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(6000);
  if (!(await toComments())) throw new Error('NO_THREAD');
  out.pinned = await ev(`!!document.querySelector('ytd-comment-thread-renderer #pinned-comment-badge *')`);
  out.before = (await replies()).length;
  const ok = await waitFor(`(()=>{const th=document.querySelector('ytd-comment-thread-renderer');const b=th.querySelector('#reply-button-end button, #reply-button-end ytd-button-renderer');if(!b)return false;b.click();return true})()`, 15000);
  if (!ok) throw new Error('NO_REPLY_BUTTON');
  await sleep(1500);
  const ed = await waitFor(`(()=>{const e=document.querySelector('ytd-comment-thread-renderer ytd-comment-reply-dialog-renderer #contenteditable-root');if(!e)return false;e.focus();return true})()`, 15000);
  if (!ed) throw new Error('NO_REPLY_EDITOR');
  for (const [i, line] of text.split('\n').entries()) {
    if (i) await ev("document.execCommand('insertLineBreak')");
    if (line) await send('Input.insertText', { text: line });
  }
  await sleep(800); await shot('r1-typed');
  out.typed = await ev(`document.querySelector('ytd-comment-thread-renderer ytd-comment-reply-dialog-renderer #contenteditable-root').innerText.length`);
  const sub = await ev(`(()=>{const b=document.querySelector('ytd-comment-thread-renderer ytd-comment-reply-dialog-renderer #submit-button button');if(!b||b.disabled)return false;b.click();return true})()`);
  if (!sub) throw new Error('NO_SUBMIT');
  await sleep(6000); await shot('r2-posted');
  // verify after a reload: the reply must be there for everyone, not only in the local UI
  await send('Page.reload', {}); await sleep(7000);
  await toComments();
  const after = await replies();
  out.after = after.length;
  // the header's tail (emoji-free) identifies the reply; a reload may show fewer expanded replies, so also report the count
  const key = text.split('\n')[0].slice(-12);
  out.visible = after.some((r) => r.includes(key));
  out.replyButton = await ev(`document.querySelector('ytd-comment-thread-renderer')?.querySelector('#more-replies, #less-replies')?.innerText.trim()`);
  await shot('r3-verified');
} catch (e) { out.error = e.message; await shot('r-error').catch(() => {}); process.exitCode = 1; }
finally { console.log(JSON.stringify(out)); ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
