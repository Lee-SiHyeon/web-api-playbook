// YouTube Studio edit page of one video (own Canary tab, closed at the end): thumbnail, description, related video; 저장;
// then a reload readback of the related-video field. Works for public, scheduled and private videos (Shorts too).
//   node scripts/youtube-studio-edit.mjs <videoId> [--thumb=<jpg>] [--desc=<txt>] [--related=<title prefix of the long video>] [--shots=<dir>]
// Observed 2026-10-22 (Tokyo Shorts): the 관련 동영상 picker sometimes renders its list late (no item on the first try);
// the step retries up to 3 times. Shorts thumbnails are not offered in the upload dialog, so set them here after upload.
import fs from 'node:fs'; import path from 'node:path';
const [vid, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
const CDP = process.env.YT_STUDIO_CDP || 'http://127.0.0.1:9333';
const EDIT = 'https://studio.youtube.com/video/' + vid + '/edit';
const t = await (await fetch(CDP + '/json/new?' + EDIT, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const m = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true, userGesture: true }); return m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const pt = (js) => ev(`(() => { const e = ${js}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
const shot = async (n) => { if (!opt.shots) return; fs.mkdirSync(opt.shots, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(opt.shots, n + '.png'), Buffer.from(s.result.data, 'base64')); };
const RELATED = `[...document.querySelectorAll('ytcp-text-dropdown-trigger')].find(e => e.offsetParent && /관련 동영상/.test(e.innerText))`;
const out = { videoId: vid };
try {
  await send('Page.enable'); await send('DOM.enable'); await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(10000);
  if (opt.desc) {
    const text = fs.readFileSync(opt.desc, 'utf8').trim();
    const ok = await ev(`(()=>{const b=document.querySelector('#description-textarea #textbox');if(!b)return false;b.focus();document.execCommand('selectAll');return true})()`);
    if (!ok) throw new Error('NO_DESCRIPTION_BOX');
    await send('Input.insertText', { text }); await sleep(1000);
    out.desc = { typed: await ev(`document.querySelector('#description-textarea #textbox').innerText.length`), expected: text.length };
  }
  if (opt.thumb) {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input#file-loader' });
    if (!q.result.nodeIds.length) throw new Error('NO_THUMB_INPUT');
    await send('DOM.setFileInputFiles', { nodeId: q.result.nodeIds[0], files: [path.resolve(opt.thumb)] }); await sleep(6000);
    out.thumb = true;
  }
  if (opt.related) {
    const cur = await ev(`${RELATED}?.innerText.replace(/\\s+/g, ' ')`);
    if (cur && cur.includes(opt.related)) out.related = 'already';
    else {
      for (let attempt = 1; attempt <= 3 && !out.related; attempt++) {
        const trig = await pt(RELATED); if (!trig) throw new Error('NO_RELATED_FIELD');
        await click(trig); await sleep(3000 + attempt * 1500);
        const item = await pt(`[...document.querySelectorAll('ytcp-dialog *, tp-yt-paper-dialog *')].filter(e => e.offsetParent && e.children.length <= 1 && (e.innerText || '').trim().startsWith(${JSON.stringify(opt.related)})).sort((a, b) => a.innerText.length - b.innerText.length)[0]`);
        if (item) { await click(item); await sleep(2000); out.related = 'picked'; }
        else { await ev(`(document.querySelector('ytcp-dialog #close-button, tp-yt-paper-dialog #close-button')?.click(), 1)`); await sleep(1500); }
      }
      if (!out.related) throw new Error('RELATED_ITEM_NOT_FOUND');
    }
  }
  await shot('1-edited');
  const saveBtn = await ev(`(()=>{const b=document.querySelector('ytcp-button#save');return b?!(b.hasAttribute('disabled')||b.getAttribute('aria-disabled')==='true'):null})()`);
  if (saveBtn) { await ev(`(document.querySelector('ytcp-button#save').click(), 1)`); await sleep(6000); }
  out.saveClicked = !!saveBtn;
  out.toast = await ev(`document.body.innerText.match(/변경사항이 저장됨|저장됨|저장하지 못했/)?.[0] || null`);
  await shot('2-saved');
  if (opt.related) { // readback after reload
    await send('Page.navigate', { url: EDIT }); await sleep(9000);
    out.relatedNow = await ev(`${RELATED}?.innerText.replace(/\\s+/g, ' ')`);
    if (!String(out.relatedNow || '').includes(opt.related)) { console.log(JSON.stringify(out)); throw new Error('RELATED_NOT_SAVED'); }
  }
  out.ok = true;
  console.log(JSON.stringify(out));
} catch (e) { out.ok = false; out.error = e.message; console.log(JSON.stringify(out)); process.exitCode = 2; }
finally { ws.close(); await fetch(CDP + '/json/close/' + t.id).catch(() => {}); }
