// Threads / X post through their own web composer in the logged-in automation Canary (CDP 9333); own tab, closed at the end.
// 2026-10-23 (kwak Macau): the HTTP clients (sns-threads, sns-X) have no verified media publish, so promo posts with media go
// through the web UI here. Media goes straight into the composer's <input type=file> (DOM.setFileInputFiles), no chooser.
//   node scripts/sns-web-post.mjs threads|x <text.txt> [media1,media2] [--dry] [--shots=<dir>]
// --dry stops before the post button; --keep leaves the tab open (e.g. --dry --keep, then press Post with a real OS click through
// a Windows desktop MCP when the site ignores synthetic input, as X did on 2026-10-23). Prints {posted, url?, tab?}.
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.SNS_CDP || 'http://127.0.0.1:9333';
const [site, textFile, mediaArg, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries([mediaArg, ...rest].filter((a) => a && a.startsWith('--')).map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const media = mediaArg && !mediaArg.startsWith('--') ? mediaArg.split(',').map((f) => path.resolve(f)) : [];
if (!['threads', 'x'].includes(site) || !textFile) { console.error('usage: sns-web-post.mjs threads|x <text.txt> [media,...] [--dry] [--shots=dir]'); process.exit(2); }
const text = fs.readFileSync(textFile, 'utf8').replace(/\r/g, '').trim();
const shots = opt.shots || path.join(path.dirname(path.resolve(textFile)), `${site}-shots`); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = {
  threads: { url: 'https://www.threads.com/', // the feed's "새로운 소식을 공유해보세요" line does not open the dialog; the left nav "새로운 스레드" does
    open: `[...document.querySelectorAll('a, [role=button], [role=link]')].find((x) => /^(새로운 스레드|Create)$/.test((x.innerText || x.getAttribute('aria-label') || '').trim()) && x.getBoundingClientRect().width)`,
    editor: '[role=dialog] [contenteditable=true]', file: '[role=dialog] input[type=file]', post: /^(게시|Post)$/, scope: '[role=dialog]' },
  x: { url: 'https://x.com/compose/post', open: null, editor: '[data-testid="tweetTextarea_0"]', file: 'input[data-testid="fileInput"], input[type=file]', post: null, postSel: '[data-testid="tweetButton"]', scope: 'body' },
}[site];

const t = await (await fetch(`${CDP}/json/new?${SITE.url}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64')); };
const clickAt = async ([x, y]) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const center = (expr) => ev(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
const out = { site };
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.bringToFront'); await send('DOM.enable');
  await sleep(9000);
  if (SITE.open) { const o = await center(SITE.open); if (!o) throw new Error('NO_COMPOSER_OPEN'); await clickAt(o); await sleep(2500); }
  const ed = await center(`document.querySelector(${JSON.stringify(SITE.editor)})`); if (!ed) throw new Error('NO_EDITOR');
  await clickAt(ed); await sleep(500);
  // newlines: Shift+Enter keeps the composer open on both sites
  for (const [i, line] of text.split('\n').entries()) {
    if (i) for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
    if (line) await send('Input.insertText', { text: line });
  }
  await sleep(1200);
  if (media.length) {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: SITE.file });
    if (!q.result?.nodeId) throw new Error('NO_FILE_INPUT');
    await send('DOM.setFileInputFiles', { files: media, nodeId: q.result.nodeId });
    await sleep(6000);
    // wait for upload/processing (video): the post button turns enabled
    for (let i = 0; i < 120; i++) {
      const ready = await ev(SITE.postSel ? `(() => { const b = document.querySelector(${JSON.stringify(SITE.postSel)}); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`
        : `(() => { const b = [...document.querySelectorAll(${JSON.stringify(SITE.scope + ' [role=button]')})].find((x) => ${SITE.post}.test((x.innerText || '').trim())); return !!b && b.getAttribute('aria-disabled') !== 'true'; })()`);
      // X shows a circular progress ring (role=progressbar) while the video uploads; Post stays clickable but does nothing
      const busy = await ev(`!!document.querySelector('[role=progressbar], [data-testid="progressBar"]') || /업로드 중|Uploading|처리 중|Processing/.test(document.body.innerText)`);
      if (ready && !busy) break;
      await sleep(3000);
    }
  }
  out.typed = await ev(`(document.querySelector(${JSON.stringify(SITE.editor)})?.innerText || '').length`);
  await shot(`${site}-1-filled`);
  if (opt.dry) { out.dry = true; }
  else {
    const pb = await center(SITE.postSel ? `document.querySelector(${JSON.stringify(SITE.postSel)})` : `[...document.querySelectorAll(${JSON.stringify(SITE.scope + ' [role=button]')})].filter((x) => ${SITE.post}.test((x.innerText || '').trim())).pop()`);
    if (!pb) throw new Error('NO_POST_BUTTON');
    await clickAt(pb); await sleep(5000);
    // X sometimes ignores a synthetic click on Post: fall back to Ctrl+Enter in the editor
    if (await ev(`!!document.querySelector(${JSON.stringify(SITE.editor)})`)) {
      const ed2 = await center(`document.querySelector(${JSON.stringify(SITE.editor)})`); if (ed2) await clickAt(ed2);
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
      out.ctrlEnter = true;
    }
    // success = the composer closed (a toast alone is not proof; the first X run reported posted while the video was still uploading)
    let closed = false; for (let i = 0; i < 60 && !closed; i++) { await sleep(3000); closed = !(await ev(`!!document.querySelector(${JSON.stringify(SITE.editor)})`)); }
    await sleep(4000); await shot(`${site}-2-posted`);
    out.posted = closed; if (!closed) throw new Error('COMPOSER_STILL_OPEN');
    out.url = await ev(`(() => { const a = [...document.querySelectorAll('a[href*="/post/"], a[href*="/status/"]')].map((x) => x.href).find((h) => /\\/(post|status)\\//.test(h)); return a || null; })()`);
  }
} catch (e) { out.error = e.message; await shot(`${site}-error`).catch(() => {}); process.exitCode = 1; }
finally { if (opt.keep) out.tab = t.id; console.log(JSON.stringify(out)); ws.close(); if (!opt.keep) await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
