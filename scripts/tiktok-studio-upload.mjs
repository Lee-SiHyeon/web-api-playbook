// TikTok Studio web upload (@lifehack__aibal, logged-in automation Canary CDP 9333; own tab, closed at the end). 2026-10-22.
//   node scripts/tiktok-studio-upload.mjs <video.mp4> <caption.txt> [--ai] [--post] [--shots=<dir>]
// Without --post it stops before 게시 (settings screenshot). With --post it prints the new video URL from Studio's content list.
// Login: email + password (DPAPI `tiktok-login`) + 2FA code from Gmail; see references/blog-multichannel-publish-2026-10-19.md.
// Pitfalls encoded here (2026-10-22, 7 uploads):
//  - Caption: typing a whole text with hashtags lets the hashtag autocomplete swallow the sentence. Type the sentence first,
//    then each "#tag" + Enter on the suggestion (that makes it a real hashtag), all inside the caption box (Ctrl+A/Backspace there only; a document-wide
//    selectAll crashed the page).
//  - "AI 생성 콘텐츠" is an <input type=checkbox> in the settings block (after 펼치기); a JS click switches it on.
//  - 게시 opens "계속 게시할까요? (검사가 아직 진행 중)" -> 지금 게시.
//  - Links in captions/comments are not clickable on TikTok; the web comment menu has no 고정 (pin is app-only).
import fs from 'node:fs';
import path from 'node:path';
const [video, captionFile, ...flags] = process.argv.slice(2);
const opt = Object.fromEntries(flags.map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const CDP = process.env.TT_CDP || 'http://127.0.0.1:9333';
const t = await (await fetch(CDP + '/json/new?https://www.tiktok.com/tiktokstudio/upload?from=webapp', { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const key = async (k, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); };
const shot = async (name) => { if (!opt.shots) return; fs.mkdirSync(opt.shots, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${opt.shots}/${name}.png`, Buffer.from(s.result.data, 'base64')); };
const buttonAt = (re) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.offsetParent&&new RegExp(${JSON.stringify(re)}).test(x.innerText.trim())&&!x.disabled);if(!b)return null;b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
const AIQ = `[...document.querySelectorAll('input[type=checkbox]')].find(e=>{let p=e;for(let i=0;i<6&&p;i++){p=p.parentElement;if(p&&p.innerText&&p.innerText.trim().length>3)return /^AI 생성 콘텐츠/.test(p.innerText.trim())}return false})`;
const out = { video: path.basename(video) };
try {
  await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(12000);
  if (/login/.test(await ev('location.href'))) throw new Error('NOT_LOGGED_IN');
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  const q = await send('DOM.querySelectorAll', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  if (!q.result.nodeIds.length) { await shot('0-noinput'); throw new Error('NO_FILE_INPUT'); }
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeIds[0], files: [path.resolve(video)] });
  const waitN = Math.max(60, Math.ceil(fs.statSync(video).size / 1.5e6)); // ~3 s per 4.5 MB; a 492 MB long video needs minutes
  for (let i = 0; i < waitN; i++) { await sleep(3000); if (await ev(`!!document.querySelector('[contenteditable=true]') && /업로드됨|Uploaded/.test(document.body.innerText)`)) break; }
  await sleep(2000); await shot('1-uploaded');
  const capRaw = fs.readFileSync(captionFile, 'utf8').trim();
  const tags = (capRaw.match(/#[^\s#]+/g) || []).map((x) => x.slice(1));
  const sentence = capRaw.replace(/#[^\s#]+/g, '').replace(/\s+/g, ' ').trim() + ' ';
  const edPt = await ev(`(()=>{const e=document.querySelector('[contenteditable=true]');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.x+r.width-30,r.y+r.height/2]})()`);
  await click(edPt); await sleep(500);
  await key('a', 'KeyA', 65, 2); await key('Backspace', 'Backspace', 8); await sleep(600);
  await send('Input.insertText', { text: sentence }); await sleep(800);
  // A typed "#tag" followed by a space stays plain text (2026-10-23: 26 posts, 0 recognised hashtags). Enter on the open
  // hashtag suggestion turns it into a tag (<span class="mention" data-testid="mentionText">) and adds the space itself.
  const enter = async () => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); };
  for (const tg of tags) { await send('Input.insertText', { text: '#' + tg }); await sleep(1800); await enter(); await sleep(900); }
  await sleep(800);
  out.caption = await ev(`document.querySelector('[contenteditable=true]').innerText.length`);
  out.hashtags = await ev(`[...document.querySelectorAll('[contenteditable=true] [data-testid=mentionText]')].map((e) => e.innerText.trim())`);
  if (tags.length && out.hashtags.length < tags.length) { await shot('1b-hashtags'); throw new Error(`HASHTAGS_NOT_RECOGNISED ${out.hashtags.length}/${tags.length}`); }
  const more = await buttonAt('^(펼치기|Show more)$'); if (more) { await click(more); await sleep(1500); }
  const popup = await buttonAt('^켜기$'); if (popup) { await click(popup); await sleep(1000); }
  if (opt.ai) {
    if (await ev(`(()=>{const e=${AIQ};return e?!e.checked:null})()`)) { await ev(`(${AIQ}).click()`); await sleep(1500); const c = await buttonAt('^(켜기|확인|사용)$'); if (c) { await click(c); await sleep(1000); } }
    out.aiLabel = await ev(`(()=>{const e=${AIQ};return e?e.checked:null})()`);
    if (out.aiLabel !== true) { await shot('2-ai-fail'); throw new Error('AI_LABEL_NOT_ON'); }
  }
  await shot('2-settings');
  if (opt.post) {
    const b = await buttonAt('^(게시|Post)$'); if (!b) throw new Error('NO_POST_BUTTON');
    await click(b); await sleep(4000);
    const now = await buttonAt('^지금 게시$'); if (now) { await click(now); out.confirmed = true; }
    // short videos redirect to the content list; a long one stays on the form while checks run but shows "동영상이 게시되었습니다"
    for (let i = 0; i < 20 && !out.posted; i++) { await sleep(3000); out.posted = await ev(`/tiktokstudio\\/content/.test(location.href) || /동영상이 게시되었습니다/.test(document.body.innerText)`); }
    await shot('3-posted'); out.after = await ev('location.href');
    if (!out.posted) throw new Error('POST_NOT_CONFIRMED');
    if (!/tiktokstudio\/content/.test(out.after)) await send('Page.navigate', { url: 'https://www.tiktok.com/tiktokstudio/content' });
    await sleep(10000);
    out.url = await ev(`[...document.querySelectorAll('a')].map(a=>a.href).find(h=>/\\/video\\/\\d+/.test(h))`); // newest first
  }
  out.ok = true;
} catch (e) { out.ok = false; out.error = e.message; process.exitCode = 2; }
finally { console.log(JSON.stringify(out)); ws.close(); await fetch(CDP + '/json/close/' + t.id).catch(() => {}); }
