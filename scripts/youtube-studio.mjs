// YouTube Studio long-form upload + localization, driven in the logged-in automation Canary (CDP 9333).
// Browser-assisted on purpose: Studio's create/publish requests carry first-party attestation (see
// affiliate-content-operations/docs/youtube-video-api-only-2026-09-28.md), so this types into Studio's own UI and
// nothing (cookies, tokens) leaves the tab. Studio UI language must be Korean (labels below are matched as text).
//
//   node scripts/youtube-studio.mjs upload   <job.json> [--shots=dir]   -> uploads, fills details, A/B, schedules; prints videoId
//   node scripts/youtube-studio.mjs captions <job.json> [--shots=dir]   -> original-language SRT + every localization (title/desc/SRT)
//
// job.json (paths are local Windows paths):
// {
//   "channelId": "UC...", "video": "C:\\...\\final.mp4", "videoId": "(set after upload, for captions)",
//   "title": "...", "description": "...", "tags": ["a","b"], "category": "여행/이벤트", "language": "한국어",
//   "thumbnail": "C:\\...\\a.jpg",                                   // or use abTest
//   "abTest": [{"thumbnail": "C:\\a.jpg", "title": "..."}, {"thumbnail": "C:\\b.jpg", "title": "..."}],  // 2-3 variants, 제목과 썸네일
//   "madeForKids": false, "paidPromotion": true, "alteredContent": true,
//   "schedule": {"date": "2026. 10. 19.", "time": "오후 6:00"},         // omit -> stays private
//   "captions": {"original": "C:\\...\\ko.srt",
//                "tracks": [{"label": "영어", "srt": "C:\\...\\en.srt", "title": "...", "description": "..."}]}
// }
//
// Observed 2026-10-19 (channel @lifehack__ailab, video tJfj73x5Ti8), pitfalls this script encodes:
//  - Setting the captions <input type=file> BEFORE pressing 계속 silently closes the dialog (nothing uploaded). The upload
//    must go through the native chooser opened by 계속; we intercept it (Page.setInterceptFileChooserDialog).
//  - For non-original languages the first intercepted chooser after 계속 regularly did nothing; a second attempt works.
//    The script retries until caption rows (textareas) appear.
//  - Date field: typing a date and pressing Enter keeps the calendar open and focus there (typed time lands in the date).
//    The date is typed, then Escape closes the popup; time is chosen from the dropdown list (15-minute items).
//  - Tags are only committed after Enter. Title max 100 chars (localized titles too).
//  - Original-language captions: the 수동 업로드 button on the Language page opened an upload that did not replace the
//    auto captions; the editor's ⋮ menu → 파일 업로드 did. Then 게시.
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.YT_STUDIO_CDP || 'http://127.0.0.1:9333';
const [cmd, jobPath, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map((f) => f.replace(/^--/, '').split('=')));
if (!['upload', 'captions'].includes(cmd) || !jobPath) { console.error('usage: youtube-studio.mjs upload|captions <job.json> [--shots=dir]'); process.exit(2); }
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let seq = 0; const pend = new Map(); let chooser = null;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.fileChooserOpened') chooser = m.params; if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text); return m.result?.result?.value; };
await send('Page.enable'); await send('DOM.enable');
let shotN = 0;
const shot = async (label) => { if (!opt.shots) return; fs.mkdirSync(opt.shots, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(opt.shots, `${String(++shotN).padStart(2, '0')}-${label}.png`), Buffer.from(r.result.data, 'base64')); };
const log = (o) => console.log(JSON.stringify(o));
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };

// --- in-page helpers: "topmost" = the element is what the user would actually hit at its centre (skips content under dialogs)
const H = `(() => {
  const vis = (e) => { const b = e.getBoundingClientRect(); if (!b.width || !b.height || b.bottom < 0 || b.top > innerHeight) return null;
    const x = b.x + b.width / 2, y = b.y + b.height / 2; const hit = document.elementFromPoint(x, y);
    return hit && (e === hit || e.contains(hit) || hit.contains(e)) ? [Math.round(x), Math.round(y)] : null; };
  const all = (root = document, out = []) => { for (const e of root.querySelectorAll('*')) { out.push(e); if (e.shadowRoot) all(e.shadowRoot, out); } return out; };
  return { vis, all };
})()`;
const pointOfText = (text, nth = 0) => ev(`(() => { const {vis, all} = ${H};
  const c = all().filter(e => (e.innerText || '').trim() === ${JSON.stringify(text)}).map(e => [e, vis(e)]).filter(x => x[1]);
  c.sort((a, b) => a[0].querySelectorAll('*').length - b[0].querySelectorAll('*').length); return c[${nth}] ? c[${nth}][1] : null; })()`);
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const clickText = async (text, { nth = 0, wait = 8000 } = {}) => {
  for (let k = 0; k < wait / 250; k++) { const p = await pointOfText(text, nth); if (p) { await click(p); return p; } await sleep(250); }
  fail('NOT_FOUND', { text });
};
const typeText = (text) => send('Input.insertText', { text });
const key = async (k, code) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code }); };
const waitFor = async (expr, ms = 15000) => { for (let k = 0; k < ms / 300; k++) { const v = await ev(expr); if (v) return v; await sleep(300); } fail('TIMEOUT', { expr: expr.slice(0, 120) }); };
const setFiles = async (selector, index, file) => {
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  const q = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector });
  const nodeId = q.result.nodeIds[index]; if (!nodeId) fail('NO_FILE_INPUT', { selector, index, count: q.result.nodeIds.length });
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
};
// click a point that opens a native file chooser and feed it `file`
const viaChooser = async (point, file) => {
  chooser = null; await send('Page.setInterceptFileChooserDialog', { enabled: true });
  try { await click(point); for (let k = 0; k < 50 && !chooser; k++) await sleep(100);
    if (!chooser) return false; await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [file] }); return true;
  } finally { await send('Page.setInterceptFileChooserDialog', { enabled: false }); }
};
// replace the content of the nth topmost editable (contenteditable #textbox or textarea) in the active dialog
const fillEditable = async (n, text) => {
  const p = await ev(`(() => { const {vis, all} = ${H}; const c = all().filter(e => e.isContentEditable && e.id === 'textbox' || e.tagName === 'TEXTAREA').map(vis).filter(Boolean);
    c.sort((a, b) => a[1] - b[1] || a[0] - b[0]); return c[${n}] || null; })()`);
  if (!p) fail('NO_EDITABLE', { n });
  await click(p); await ev(`(document.execCommand('selectAll'), document.activeElement && 'value' in document.activeElement && document.activeElement.select && document.activeElement.select(), 1)`);
  await typeText(text);
};
const pickMenuItem = async (text) => { const ok = await waitFor(`(() => { const it = [...document.querySelectorAll('tp-yt-paper-item')].filter(e => e.offsetParent && e.innerText.trim() === ${JSON.stringify(text)}); if (!it[0]) return false; it[0].click(); return true; })()`, 6000); return ok; };

try {
  if (cmd === 'upload') {
    for (const k of ['channelId', 'video', 'title']) if (!job[k]) fail('JOB_FIELD', { k });
    if ([job.title, ...(job.abTest || []).map((v) => v.title)].some((s) => s && [...s].length > 100)) fail('TITLE_OVER_100');
    await send('Page.navigate', { url: `https://studio.youtube.com/channel/${job.channelId}/videos/upload?d=ud` });
    await waitFor(`!!document.querySelector('input[type=file]')`, 30000);
    await setFiles('input[type=file]', 0, job.video);
    const videoId = await waitFor(`(() => { const a = [...document.querySelectorAll('a')].find(a => /(youtu\\.be|youtube\\.com\\/shorts)\\/[\\w-]{11}/.test(a.href)); return a ? a.href.match(/(?:youtu\\.be|shorts)\\/([\\w-]{11})/)[1] : null; })()`, 60000);
    log({ step: 'file', videoId }); await shot('file');

    await waitFor(`document.querySelectorAll('#textbox').length >= 2`);
    for (const [i, text] of [[0, job.title], [1, job.description || '']]) {
      await ev(`(() => { const b = document.querySelectorAll('#textbox')[${i}]; b.focus(); document.execCommand('selectAll'); return 1; })()`);
      await typeText(text);
    }
    if (job.abTest?.length) {
      const p = await ev(`(() => { const e = [...document.querySelectorAll('ytcp-thumbnail-editor')].find(x => /A\\/B/.test(x.innerText)); if (!e) return null; e.scrollIntoView({block: 'center'}); const b = e.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`);
      if (!p) fail('NO_AB_BUTTON'); await sleep(400); await click(p);
      await clickText('제목과 썸네일');
      await sleep(800);
      for (const [i, v] of job.abTest.entries()) { await setFiles('input#file-loader', i + 1, v.thumbnail); await sleep(2500); }
      // title 1 is prefilled from the main title; fill 2..n (topmost editables in the A/B dialog, top-to-bottom)
      for (const [i, v] of job.abTest.entries()) if (i > 0) await fillEditable(i, v.title);
      await shot('ab'); await clickText('테스트 설정'); await sleep(2000);
    } else if (job.thumbnail) {
      await setFiles('input#file-loader', 0, job.thumbnail); await sleep(2500);
    }
    // audience + disclosures (radio names are stable enum values)
    const radios = [job.madeForKids ? 'VIDEO_MADE_FOR_KIDS_MFK' : 'VIDEO_MADE_FOR_KIDS_NOT_MFK',
      job.paidPromotion ? 'VIDEO_PAID_PRODUCT_PLACEMENT_NOTIFY' : 'VIDEO_PAID_PRODUCT_PLACEMENT_NO',
      job.alteredContent ? 'VIDEO_HAS_ALTERED_CONTENT_YES' : 'VIDEO_HAS_ALTERED_CONTENT_NO'];
    await ev(`(() => { const t = document.querySelector('#toggle-button'); if (t && !document.querySelector('tp-yt-paper-radio-button[name=VIDEO_HAS_ALTERED_CONTENT_YES]')) t.click(); return 1; })()`);
    await waitFor(`!!document.querySelector('tp-yt-paper-radio-button[name=VIDEO_HAS_ALTERED_CONTENT_YES]')`);
    const checked = await ev(`(() => { for (const n of ${JSON.stringify(radios)}) document.querySelector('tp-yt-paper-radio-button[name=' + n + ']').click();
      return [...document.querySelectorAll('tp-yt-paper-radio-button[aria-checked=true]')].map(e => e.getAttribute('name')); })()`);
    if (!radios.every((r) => checked.includes(r))) fail('RADIO', { checked });
    if (job.tags?.length) {
      await ev(`(document.querySelector('#tags-container input').focus(), 1)`); await typeText(job.tags.join(',') + ','); await key('Enter', 13);
      await sleep(600);
    }
    if (job.language) { await ev(`(() => { const s = document.querySelector('#language-input'); (s.querySelector('ytcp-dropdown-trigger') || s).click(); return 1; })()`); await pickMenuItem(job.language); }
    if (job.category) { await sleep(500); await ev(`(() => { const s = document.querySelector('ytcp-form-select#category'); (s.querySelector('ytcp-dropdown-trigger') || s).click(); return 1; })()`); await pickMenuItem(job.category); }
    const details = await ev(`({ title: document.querySelectorAll('#textbox')[0].innerText, descLen: document.querySelectorAll('#textbox')[1].innerText.length,
      tags: document.querySelector('#tags-container').innerText.split('\\n').length, lang: document.querySelector('#language-input').innerText.replace(/\\n/g, ' '),
      category: document.querySelector('ytcp-form-select#category').innerText.replace(/\\n/g, ' ') })`);
    log({ step: 'details', ...details }); await shot('details');

    for (let i = 0; i < 3; i++) { await ev(`(document.querySelector('#next-button').click(), 1)`); await sleep(1800); }
    const checks = await ev(`(document.body.innerText.match(/검사[^\\n]*/) || [''])[0]`);
    log({ step: 'checks', checks });
    if (job.schedule) {
      await clickText('예약'); await sleep(1200);
      const dp = await ev(`(() => { const {vis} = ${H}; const e = [...document.querySelectorAll('ytcp-datetime-picker #datepicker-trigger, ytcp-datetime-picker ytcp-dropdown-trigger')].find(vis); return e ? vis(e) : null; })()`);
      if (!dp) fail('NO_DATE_TRIGGER'); await click(dp); await sleep(1000);
      await ev(`(() => { const i = [...document.querySelectorAll('input')].find(e => e.offsetParent && /\\d{4}\\./.test(e.value)); i.focus(); i.select(); return 1; })()`);
      await typeText(job.schedule.date); await key('Enter', 13); await sleep(400); await key('Escape', 27); await sleep(600);
      const tp = await ev(`(() => { const {vis} = ${H}; const e = [...document.querySelectorAll('input')].find(e => e.offsetParent && /^오[전후] \\d/.test(e.value)); return e ? vis(e) : null; })()`);
      if (!tp) fail('NO_TIME_INPUT'); await click(tp); await sleep(800); await pickMenuItem(job.schedule.time);
      await sleep(600);
      const when = await ev(`[...document.querySelectorAll('ytcp-datetime-picker')].map(e => e.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
      log({ step: 'schedule', when }); await shot('schedule');
      if (!when.includes(job.schedule.date.replace(/\.$/, '')) || !when.includes(job.schedule.time)) fail('SCHEDULE_MISMATCH', { when });
    } else {
      const vis = job.visibility || 'PRIVATE'; // PUBLIC | UNLISTED | PRIVATE
      await ev(`(document.querySelector('tp-yt-paper-radio-button[name=${vis}]')?.click(), 1)`); await sleep(800);
    }
    await ev(`(document.querySelector('#done-button').click(), 1)`);
    const confirm = await waitFor(`(() => { const m = document.body.innerText.match(/(\\d{4}년 \\d+월 \\d+일 [\\d:]+)에 동영상이 공개|동영상 저장됨|동영상 게시됨|동영상 처리 중/); return m ? m[0] : null; })()`, 30000);
    log({ step: 'done', videoId, confirm, url: `https://youtu.be/${videoId}` }); await shot('done');
  }

  if (cmd === 'captions') {
    if (!job.videoId) fail('JOB_FIELD', { k: 'videoId' });
    const page = `https://studio.youtube.com/video/${job.videoId}/translations`;
    const go = async () => { await send('Page.navigate', { url: page }); await waitFor(`!!document.body && /언어 추가/.test(document.body.innerText)`, 30000); await sleep(1500); };
    const uploadInEditor = async (srt) => {
      // editor shows "파일 업로드" (empty track) — then the 타이밍 포함 dialog → 계속 opens the native chooser
      await clickText('파일 업로드'); await sleep(1200);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const p = await pointOfText('계속'); if (!p) break;
        await viaChooser(p, srt); await sleep(4000);
        const rows = await ev(`[...document.querySelectorAll('textarea')].filter(e => e.offsetParent).length`);
        if (rows > 0) return rows;
      }
      fail('CAPTION_UPLOAD', { srt });
    };
    await go();
    if (job.captions?.original) {
      await clickText('자막 수정'); await sleep(3000);
      // ⋮ menu sits right of "텍스트로 편집"
      let p = null; for (let k = 0; k < 60 && !p; k++) { p = await pointOfText('텍스트로 편집'); if (!p) await sleep(500); } if (!p) fail('NO_EDITOR');
      const more = await ev(`(() => { const {vis} = ${H}; const b = [...document.querySelectorAll('ytcp-icon-button, yt-icon-button, button')].map(e => [e, vis(e)]).filter(x => x[1] && Math.abs(x[1][1] - ${p[1]}) < 20 && x[1][0] > ${p[0]}); b.sort((a, c) => a[1][0] - c[1][0]); return b[0] ? b[0][1] : null; })()`);
      if (!more) fail('NO_MORE_MENU'); await click(more); await sleep(1000);
      await pickMenuItem('파일 업로드'); await sleep(1200);
      let rows = 0;
      for (let attempt = 1; attempt <= 3 && !rows; attempt++) {
        const c = await pointOfText('계속'); if (!c) break; await viaChooser(c, job.captions.original); await sleep(4000);
        const first = await ev(`([...document.querySelectorAll('textarea')].find(e => e.offsetParent) || {}).value || ''`);
        rows = first ? 1 : 0;
      }
      await shot('original'); await clickText('게시'); await sleep(4000);
      log({ step: 'original', ok: !!rows });
    }
    for (const tr of job.captions?.tracks || []) {
      await go();
      await clickText('언어 추가'); await sleep(1200);
      if (!(await pickMenuItem(tr.label))) fail('NO_LANG', { label: tr.label });
      await sleep(2500);
      if (tr.title) await fillEditable(0, tr.title);
      if (tr.description) await fillEditable(1, tr.description);
      // "수동 자막 · 추가" — the 추가 on the same row as 수동 자막
      const lbl = await pointOfText('수동 자막'); if (!lbl) fail('NO_CAPTION_ROW');
      const add = await ev(`(() => { const {vis, all} = ${H}; const c = all().filter(e => (e.innerText || '').trim() === '추가').map(e => [e, vis(e)]).filter(x => x[1] && Math.abs(x[1][1] - ${lbl[1]}) < 20); c.sort((a, b) => a[0].querySelectorAll('*').length - b[0].querySelectorAll('*').length); return c[0] ? c[0][1] : null; })()`);
      if (!add) fail('NO_CAPTION_ADD'); await click(add); await sleep(1500);
      if (await pointOfText('변경사항 저장')) { await clickText('변경사항 저장'); await sleep(3000); }
      const rows = await uploadInEditor(tr.srt);
      await shot(tr.label); await clickText('게시'); await sleep(4000);
      const row = await ev(`[...document.querySelectorAll('tr, .row')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).find(t => t.startsWith(${JSON.stringify(tr.label)})) || ''`);
      log({ step: 'track', label: tr.label, rows, row });
    }
  }
} catch (e) {
  await shot('error').catch(() => {});
  log({ ok: false, code: e.code || 'ERROR', message: e.message, ...(e.text ? { text: e.text } : {}) });
  process.exitCode = 2;
} finally {
  ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
}
