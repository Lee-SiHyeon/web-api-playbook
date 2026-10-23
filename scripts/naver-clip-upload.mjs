// Naver Clip (clipcreators.naver.com) upload through the logged-in automation Canary (CDP 9333). 2026-10-19.
//   node scripts/naver-clip-upload.mjs <video.mp4|-> <desc.txt> [--draftId=<id> fills an existing draft instead of uploading] [--cat1=여행] [--cat2=해외여행] [--blog=<post title substring>] [--ai] [--draft]
// Flow: 업로드 → 파일 선택 (native chooser, intercepted) → resumable upload → draft page → 설명 (≤300) → 1차/2차 카테고리 →
// AI 활용 toggle → 콘텐츠 링크 블로그 (picker lists the owner's own posts; pick by title) → 등록 (or 임시저장 with --draft).
// Gotchas seen: clicking on hidden checkbox inputs hit the wrong control ("등록 예약" got ticked); use the visible
// switch's coordinates. Leaving a draft page fires a beforeunload confirm.
import fs from 'node:fs';
import path from 'node:path';
const CDP = process.env.CLIP_CDP || 'http://127.0.0.1:9333';
const [video, descFile, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const desc = fs.readFileSync(descFile, 'utf8').replace(/\r/g, '').trim();
if ([...desc].length > 300) { console.log(JSON.stringify({ ok: false, code: 'DESC_OVER_300' })); process.exit(2); }
const startUrl = opt.draftId ? `https://clipcreators.naver.com/web/draft/${opt.draftId}` : 'https://clipcreators.naver.com/web/upload';
const t = await (await fetch(`${CDP}/json/new?${startUrl}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); let chooser = null;
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.fileChooserOpened') chooser = m.params; if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const pointOf = (js) => ev(`(() => { const e = ${js}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
const byText = (text, sel = 'button,li,[role=option],div,span,a') => `[...document.querySelectorAll('${sel}')].filter(e => e.offsetParent && e.innerText && e.innerText.trim() === ${JSON.stringify(text)}).sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]`;
const out = { video: path.basename(video) };
try {
  await send('Page.enable'); await sleep(7000);
  if (!opt.draftId) {
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await click(await pointOf(byText('파일 선택')));
  for (let k = 0; k < 50 && !chooser; k++) await sleep(100);
  if (!chooser) throw new Error('NO_CHOOSER');
  await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [path.resolve(video)] });
  await send('Page.setInterceptFileChooserDialog', { enabled: false });
  for (let k = 0; k < 150; k++) { await sleep(2000); const s = await ev(`({ url: location.href, prog: (document.body.innerText.match(/진행 중 \\d+%/) || [''])[0] })`); if (/\/draft\/\d+/.test(s.url) && !s.prog) break; }
  }
  out.draft = (await ev('location.href')).match(/draft\/(\d+)/)?.[1];
  await ev(`(() => { const t = document.querySelector('textarea'); t.focus(); t.select(); return 1; })()`);
  // Line breaks: insertText of a multi-line string lands as one line, and Shift+Enter does nothing in this textarea;
  // a plain Enter key event that carries text "\r" makes the break (2026-10-23).
  const enter = async () => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); };
  for (const [i, line] of desc.split('\n').entries()) { if (i) await enter(); if (line) await send('Input.insertText', { text: line }); await sleep(60); }
  await sleep(500);
  out.descMatches = (await ev(`document.querySelector('textarea').value`)) === desc;
  for (const [label, value] of [['1차 카테고리', opt.cat1 || '여행'], ['2차 카테고리', opt.cat2 || '해외여행']]) {
    await click(await pointOf(byText(label, 'button,div'))); await sleep(800);
    await click(await pointOf(byText(value, 'li,[role=option],button'))); await sleep(800);
  }
  if (opt.ai) {
    // the switch is <button class="Toggle_toggle… [Toggle_toggleOn…]"> inside the "AI 활용 설정" module item (not an input)
    const aiBtn = `[...document.querySelectorAll('div[class*=moduleItem]')].find(d => /AI 활용 설정/.test(d.innerText))?.querySelector('button[class*=Toggle_toggle]')`;
    if (!(await ev(`/toggleOn/.test(${aiBtn}?.className || '')`))) { await click(await pointOf(aiBtn)); await sleep(600); }
    out.ai = await ev(`/toggleOn/.test(${aiBtn}?.className || '')`);
  }
  if (opt.blog) {
    await click(await pointOf(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === '블로그')`)); await sleep(2500);
    const sel = await pointOf(`(() => { const card = [...document.querySelectorAll('li,div')].filter(e => e.offsetParent && e.innerText.includes(${JSON.stringify(opt.blog)}) && [...e.querySelectorAll('button')].some(b => b.innerText.trim() === '선택')).sort((a, b) => a.innerText.length - b.innerText.length)[0]; return card ? [...card.querySelectorAll('button')].find(b => b.innerText.trim() === '선택') : null; })()`);
    if (!sel) throw new Error('BLOG_NOT_FOUND'); await click(sel); await sleep(1200);
  }
  const sched = await ev(`[...document.querySelectorAll('input[type=checkbox]')].slice(1).some(c => c.checked && /예약/.test(c.closest('div')?.innerText || ''))`);
  if (sched) throw new Error('SCHEDULE_TICKED_UNEXPECTEDLY');
  const btn = opt.draft ? '임시저장' : '등록';
  await click(await pointOf(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === '${btn}')`)); await sleep(6000);
  out.after = await ev('location.href'); out.ok = true;
} catch (e) { out.ok = false; out.error = e.message; }
console.log(JSON.stringify(out));
ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
