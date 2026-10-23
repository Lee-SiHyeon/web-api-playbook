// Add SRT caption tracks (one per language) to a published Facebook Page video or Reel, through Meta Business Suite's
// "동영상 수정 > 캡션 및 자막" panel, in the logged-in automation Canary (CDP 9333). Own tab, closed at the end. 2026-10-23.
// Facebook turned every Page video into a Reel; Reels still take uploaded .srt files, one per language, after publishing.
//   node scripts/facebook-captions.mjs <businessAssetId> <titleRegex> <file.ll_CC.srt>... [--dry] [--shots=<dir>]
//   - businessAssetId: the Page's asset_id in business.facebook.com/latest/...?asset_id=<id>
//   - titleRegex: matches the row in 콘텐츠 > 게시물 및 릴스 (duration + caption text, e.g. "^11:17" or "에그타르트")
//   - The file name carries the language: <name>.<ll_CC>.srt (en_US, ja_JP, zh_CN, zh_TW, th_TH, vi_VN, id_ID, es_LA, ko_KR ...).
//     Facebook rejects a bare name.srt.
// Skips languages already listed as "업로드됨: <언어>". Readback: reloads, reopens the panel and lists the uploaded languages.
// How the panel opens: hover the row's CC icon in the 상태 column; its tooltip has a "캡션 관리" link. The row's ⋯ menu has
// no edit entry for Reels.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = process.env.FB_CDP || 'http://127.0.0.1:9333';
const rest = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const [assetId, titleRe, ...files] = rest.filter((a) => !a.startsWith('--'));
if (!assetId || !titleRe || !files.length) { console.error('usage: facebook-captions.mjs <assetId> <titleRegex> <file.ll_CC.srt>... [--dry]'); process.exit(2); }
const shots = opt.shots || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'facebook');
fs.mkdirSync(shots, { recursive: true });
// Korean UI labels per locale, to skip languages that are already uploaded
const LABEL = { en: '영어', ja: '일본어', zh_CN: '중국어(간체)', zh_TW: '중국어(번체)', zh_HK: '중국어(홍콩)', th: '태국어', vi: '베트남어', id: '인도네시아어', es: '스페인어', ko: '한국어', fr: '프랑스어', de: '독일어', pt: '포르투갈어' };
const localeOf = (f) => (path.basename(f).match(/\.([a-z]{2}_[A-Z]{2})\.srt$/i) || [])[1];
const labelOf = (loc) => LABEL[loc] || LABEL[loc.split('_')[0]];
for (const f of files) {
  if (!fs.existsSync(f)) { console.error(JSON.stringify({ error: 'MISSING_FILE', file: f })); process.exit(2); }
  if (!localeOf(f)) { console.error(JSON.stringify({ error: 'BAD_FILE_NAME', file: f, need: '<name>.<ll_CC>.srt' })); process.exit(2); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = await (await fetch(`${CDP}/json/new?https://business.facebook.com/latest/posts/published_posts/?asset_id=${assetId}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map(); const listeners = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } else if (m.method) listeners.forEach((f) => f(m)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const click = async ([x, y]) => { await move(x, y); await sleep(80); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(s.result.data, 'base64')); };
const ROW = `[...document.querySelectorAll('[role=row]')].find((r) => new RegExp(${JSON.stringify(titleRe)}).test(r.innerText.trim()))`;
const uploaded = () => ev(`[...document.querySelectorAll('[role=dialog] *')].filter((e) => e.children.length === 0 && /^업로드됨:/.test(e.textContent.trim())).map((e) => e.textContent.trim().replace(/^업로드됨:\\s*/, ''))`);

// Business Suite stacks onboarding pop-ups ("탭이 콘텐츠라는 이름으로 변경", "릴스 일괄 업로드" ...) over the table
async function dismissPopups() {
  for (let i = 0; i < 5; i++) {
    const b = await ev(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find((x) => x.getBoundingClientRect().width && !/(동영상|게시물|릴스) 수정|캡션 및 자막/.test(x.innerText)); if (!d) return null;
      const e = [...d.querySelectorAll('[role=button], button, [aria-label]')].find((x) => /^(닫기|완료)$/.test((x.innerText || '').trim()) || x.getAttribute('aria-label') === '닫기'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!b) return; await click(b); await sleep(700);
  }
}

async function openPanel() {
  await dismissPopups();
  let y = null;
  for (let i = 0; i < 10 && !y; i++) {
    y = await ev(`(() => { const r = ${ROW}; if (!r) return null; r.scrollIntoView({ block: 'center' }); return 1; })()`);
    if (!y) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 1100, y: 1500, deltaX: 0, deltaY: 1500 }); await sleep(2000); }
  }
  if (!y) throw new Error('ROW_NOT_FOUND');
  await sleep(800);
  y = await ev(`(() => { const b = (${ROW}).getBoundingClientRect(); return b.y + b.height / 2; })()`);
  const x = await ev(`(() => { const h = [...document.querySelectorAll('[role=columnheader]')].find((e) => /^상태/.test(e.innerText.trim())); const b = h.getBoundingClientRect(); return b.x + 18; })()`);
  let link = null;
  for (let i = 0; i < 4 && !link; i++) { // the tooltip sometimes does not show on the first hover: leave and come back
    await move(x - 300, y); await sleep(400); await move(x, y); await sleep(1500 + i * 500);
    link = await ev(`(() => { const e = [...document.querySelectorAll('*')].find((x) => x.children.length === 0 && /^캡션 (관리|추가)$/.test(x.textContent.trim())); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  }
  if (link) {
    await move((x + link[0]) / 2, (y + link[1]) / 2); await sleep(150); // keep the tooltip open on the way to its link
    await click(link);
  } else {
    // a grey CC icon (no captions yet) may have no tooltip: row ⋯ > 게시물 관리 (hover opens the submenu) > 게시물 수정 > 캡션 및 자막
    await move(x - 300, y); await sleep(300);
    const leaf = (text, scope = '') => ev(`(() => { const e = [...document.querySelectorAll('${scope}*')].filter((x) => x.children.length === 0 && x.textContent.trim() === ${JSON.stringify(text)} && x.getBoundingClientRect().width).at(-1); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    const menu = await ev(`(() => { const b = [...(${ROW}).querySelectorAll('[role=button]')].find((x) => /드롭다운 열기/.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!menu) throw new Error('NO_ROW_MENU');
    await click(menu); await sleep(1500);
    const manage = await leaf('게시물 관리'); if (!manage) throw new Error('NO_MANAGE_ITEM');
    for (let dx = -40; dx <= 40; dx += 20) { await move(manage[0] + dx, manage[1]); await sleep(250); }
    await sleep(1200);
    const edit = await leaf('게시물 수정'); if (!edit) throw new Error('NO_EDIT_ITEM');
    await move(manage[0] + 60, manage[1]); await sleep(150); await move(edit[0], edit[1]); await sleep(300);
    await click(edit); await sleep(6000);
    const cc = await leaf('캡션 및 자막', '[role=dialog] '); if (!cc) throw new Error('NO_CAPTIONS_SECTION');
    await click(cc); await sleep(2000);
  }
  for (let i = 0; i < 20; i++) { await sleep(500); if (await ev(`[...document.querySelectorAll('[role=dialog]')].some((d) => /캡션 파일/.test(d.innerText))`)) return; }
  throw new Error('NO_CAPTION_PANEL');
}

const out = { assetId, row: titleRe };
try {
  // tall viewport: the dialog grows with each uploaded track and pushes 저장 below the fold
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 2600, deviceScaleFactor: 1, mobile: false });
  await send('Page.bringToFront'); await send('Page.enable'); await send('DOM.enable');
  await sleep(12000);
  await openPanel();
  const before = await uploaded(); out.before = before;
  const todo = files.filter((f) => !before.includes(labelOf(localeOf(f))));
  out.todo = todo.map((f) => localeOf(f));
  if (opt.dry || !todo.length) { out.dry = !!opt.dry; console.log(JSON.stringify(out)); }
  else {
    let chooser = null; listeners.push((m) => { if (m.method === 'Page.fileChooserOpened') chooser = m.params; });
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    for (const f of todo) {
      chooser = null;
      // the panel's hidden <input type=file> takes the file directly; the chooser is the fallback
      const direct = (await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('[role=dialog] input[type=file]')].find((i) => /srt/i.test(i.accept || '')) || null` })).result?.result;
      if (direct?.objectId) {
        await send('DOM.setFileInputFiles', { files: [path.resolve(f)], objectId: direct.objectId });
        let ok = false; for (let i = 0; i < 20 && !ok; i++) { await sleep(500); ok = (await uploaded()).includes(labelOf(localeOf(f))); }
        if (ok) continue;
      }
      const up =await ev(`(() => { const b = [...document.querySelectorAll('[role=dialog] [role=button]')].find((x) => x.innerText.trim() === '업로드'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      if (!up) throw new Error('NO_UPLOAD_BUTTON');
      // the button can ignore a click right after the previous upload: retry
      for (let k = 0; k < 3 && !chooser; k++) { await sleep(1000 * k); await click(up); for (let i = 0; i < 20 && !chooser; i++) await sleep(300); }
      if (!chooser) throw new Error('NO_FILE_CHOOSER');
      await send('DOM.setFileInputFiles', { files: [path.resolve(f)], backendNodeId: chooser.backendNodeId });
      let ok = false; for (let i = 0; i < 20 && !ok; i++) { await sleep(500); ok = (await uploaded()).includes(labelOf(localeOf(f))); }
      if (!ok) { await shot('captions-upload-fail'); throw new Error(`UPLOAD_NOT_LISTED ${localeOf(f)}`); }
    }
    await send('Page.setInterceptFileChooserDialog', { enabled: false });
    const save = await ev(`(() => { const e = [...document.querySelectorAll('[role=dialog] *')].filter((x) => x.children.length === 0 && x.textContent.trim() === '저장').map((x) => x.closest('button,[role=button]') || x).at(-1); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!save) throw new Error('NO_SAVE_BUTTON');
    await click(save);
    let closed = false; for (let i = 0; i < 30 && !closed; i++) { await sleep(1000); closed = !(await ev(`[...document.querySelectorAll('[role=dialog]')].some((d) => d.getBoundingClientRect().width && /캡션 및 자막/.test(d.innerText))`)); }
    if (!closed) { await shot('captions-save-fail'); throw new Error('SAVE_NOT_CONFIRMED'); }
    // readback after a reload
    await send('Page.reload'); await sleep(12000); await openPanel();
    out.after = await uploaded();
    out.ok = files.every((f) => out.after.includes(labelOf(localeOf(f))));
    console.log(JSON.stringify(out));
    if (!out.ok) process.exitCode = 1;
  }
} catch (e) {
  out.error = String(e.message || e); await shot('captions-error').catch(() => {}); console.log(JSON.stringify(out)); process.exitCode = 1;
} finally { ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
