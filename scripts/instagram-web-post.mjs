// Instagram web "새로운 게시물" flow in the logged-in automation Canary (CDP 9333). 2026-10-19 @lifehack_ailab.
//   node scripts/instagram-web-post.mjs <caption.txt> <file1> [file2 …] [--ratio=4:5|1:1|원본|16:9|9:16] [--ai]
// Images -> carousel post; one MP4 -> Reel. Steps: 새로운 게시물 → (menu 게시물 if shown) → 컴퓨터에서 선택 (intercepted
// chooser, multi-file) → 자르기 (ratio) → 다음 → 편집 → 다음 → caption (contenteditable) → AI 레이블 → 공유하기 →
// wait for "…공유되었습니다". A new account first shows the required-consent sheet (4 [필수] toggles + 동의함).
import path from 'node:path';
import fs from 'node:fs';
const CDP = process.env.IG_CDP || 'http://127.0.0.1:9333';
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const [captionFile, ...files] = args.filter((a) => !a.startsWith('--'));
const caption = fs.readFileSync(captionFile, 'utf8').trim();
const list = await (await fetch(`${CDP}/json/list`)).json();
let t = list.find((v) => v.type === 'page' && /^https:\/\/www\.instagram\.com\//.test(v.url));
if (!t) t = await (await fetch(`${CDP}/json/new?https://www.instagram.com/`, { method: 'PUT' })).json();
await fetch(`${CDP}/json/activate/${t.id}`);
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); let chooser = null;
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.fileChooserOpened') chooser = m.params; if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (pt) => { if (!pt) throw new Error('NO_TARGET'); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 }); };
const at = (js) => ev(`(() => { const e = ${js}; if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
const text = (s, root = 'document') => `[...${root}.querySelectorAll('*')].filter(e => e.offsetParent && e.children.length <= 1 && (e.innerText || '').trim() === ${JSON.stringify(s)}).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]`;
const out = { files: files.map((f) => path.basename(f)) };
try {
  await send('Page.enable');
  await send('Page.navigate', { url: 'https://www.instagram.com/' }); await sleep(8000);
  await click(await at(`[...document.querySelectorAll('svg[aria-label="새로운 게시물"]')].find(e => e.getBoundingClientRect().width > 0)`)); await sleep(2000);
  const menu = await at(text('게시물')); if (menu) { await click(menu); await sleep(1500); }
  chooser = null; await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await click(await at(text('컴퓨터에서 선택'))); for (let k = 0; k < 50 && !chooser; k++) await sleep(100);
  if (!chooser) throw new Error('NO_CHOOSER');
  await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: files.map((f) => path.resolve(f)) });
  await send('Page.setInterceptFileChooserDialog', { enabled: false }); await sleep(6000);
  // reels sometimes show an info sheet ("동영상 게시물이 이제 릴스로 공유됩니다") -> 확인
  const ok = await at(`[...document.querySelectorAll('[role=dialog]')].filter(d => /릴스로 공유됩니다/.test(d.innerText)).map(d => [...d.querySelectorAll('*')].find(e => e.offsetParent && e.children.length <= 1 && e.innerText.trim() === '확인')).find(Boolean)`); if (ok) { await click(ok); await sleep(1200); }
  const isReel = files.length === 1 && /\.mp4$/i.test(files[0]); if (isReel && !flags.ratio) flags.ratio = '9:16';
  if (flags.ratio) {
    await click(await at(`[...document.querySelectorAll('[role=dialog] svg[aria-label="자르기 선택"]')].find(e => e.getBoundingClientRect().width > 0)?.closest('button,div[role=button]')`)); await sleep(1000);
    await click(await at(text(flags.ratio, "document.querySelector('[role=dialog]')"))); await sleep(800);
  }
  for (let step = 0; step < 2; step++) { await click(await at(`[...document.querySelectorAll('[role=dialog] *')].filter(e => e.offsetParent && e.children.length <= 1 && e.innerText?.trim() === '다음').pop()`)); await sleep(3000); }
  await ev(`(() => { const e = document.querySelector('[role=dialog] [contenteditable=true], [role=dialog] textarea'); e.focus(); return 1; })()`);
  await send('Input.insertText', { text: caption }); await sleep(800);
  if (flags.ai) {
    const on = await ev(`[...document.querySelectorAll('[role=dialog] input[type=checkbox]')].map(c => c.checked)[0]`);
    if (!on) { await click(await at(`(() => { const h = ${text('AI 레이블 추가', "document.querySelector('[role=dialog]')")}; let b = h; for (let k = 0; k < 5 && b; k++) { const s = b.querySelector('input[type=checkbox]'); if (s) return s.parentElement; b = b.parentElement; } return null; })()`)); await sleep(800); }
    out.ai = await ev(`[...document.querySelectorAll('[role=dialog] input[type=checkbox]')].map(c => c.checked)[0]`);
  }
  await click(await at(text('공유하기', "document.querySelector('[role=dialog]')")));
  // wait scales with the upload size: a 492 MB 10-min long video stayed at "공유 중" for ~4 min (2026-10-22)
  const waitN = Math.max(60, Math.ceil(files.reduce((t, f) => t + fs.statSync(f).size, 0) / 1.5e6));
  for (let k = 0; k < waitN; k++) { await sleep(3000); const s = await ev(`(document.querySelector('[role=dialog]')?.innerText.match(/(게시물이|릴스가) 공유되었습니다/) || [])[0] || null`); if (s) { out.shared = s; break; } }
  out.ok = !!out.shared;
} catch (e) { out.ok = false; out.error = e.message; }
console.log(JSON.stringify(out));
if (out.ok) await ev(`(() => { const b = [...document.querySelectorAll('[role=dialog] *')].find(e => e.offsetParent && e.children.length <= 1 && e.innerText?.trim() === '완료'); b?.click(); return 1; })()`).catch(() => {});
ws.close();
