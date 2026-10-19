// Grok Imagine web (grok.com/imagine) UI automation in the logged-in automation Canary (CDP 9333). Observed 2026-10-20.
//   node scripts/grok-imagine.mjs video <image> <out.mp4> --prompt="..." [--ratio=16:9] [--dur=6] [--res=720p] [--audio=on|off]
//   node scripts/grok-imagine.mjs image <out.jpg> --prompt="..." [--ref=<image>]
// Opens its own tab on https://grok.com/imagine and closes that tab at the end (other tabs are untouched). No login/settings changes.
// Video (image->video): attach image via 업로드 (intercepted file chooser) -> 비디오 mode -> resolution / duration / audio toggles -> prompt -> 제출
//   -> poll /imagine/post/<id> until generated_video.mp4 appears -> download with the tab's cookies (in memory only).
//   Image-to-video has NO aspect-ratio control in the UI (the 종횡비 button disappears once an image is attached; output follows the image).
//   --ratio is therefore reported as a warning and not applied. Text-to-video does show 종횡비 (not used here).
// HTTP contract observed in the same session (see references/grok-imagine-web-2026-10-20.md):
//   POST https://grok.com/rest/app-chat/conversations/new   body: {modelName:"imagine-video-gen", message:"<prompt> --mode=custom", kind:"CONVERSATION_KIND_IMAGINE",
//        mediaGenInput:{imageToVideo:{prompt, inputAssets:["<assetId>"], aspectRatio, duration, resolutionName, mode:"custom"}}, ...}  -> NDJSON stream
//   Asset upload (picker): POST https://grok.com/http/upload-file-v2/direct ; then GET https://grok.com/rest/assets/<assetId>
//   Result: https://assets.grok.com/users/<uid>/generated/<postId>/generated_video.mp4?cache=1 (h264 + aac, 24 fps)
// Direct HTTP replay of conversations/new with the tab's cookies also worked once (see the reference doc).
import path from 'node:path';
import fs from 'node:fs';

const CDP = process.env.GROK_IMAGINE_CDP || 'http://127.0.0.1:9333';
const URL_IMAGINE = 'https://grok.com/imagine';
const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const pos = args.filter((a) => !a.startsWith('--'));
const [mode, ...rest] = pos;
const usage = 'usage: grok-imagine.mjs video <image> <out.mp4> --prompt=... [--ratio=16:9] [--dur=6] [--res=720p] [--audio=on|off]\n       grok-imagine.mjs image <out.jpg> --prompt=... [--ref=<image>]';
if (!['video', 'image'].includes(mode) || !flags.prompt) { console.error(usage); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stderr.write(`[grok-imagine] ${m}\n`);

// ---- CDP tab (own tab, closed at the end) ----
const created = await (await fetch(`${CDP}/json/new?${encodeURIComponent(URL_IMAGINE)}`, { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); let chooser = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Page.fileChooserOpened') chooser = m.params;
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r, j) => {
  const i = ++seq;
  const to = setTimeout(() => { pending.delete(i); j(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(i, (m) => { clearTimeout(to); r(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) throw new Error('JS: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
  return m.result?.result?.value;
};
const press = async (p) => {
  if (!p) throw new Error('NO_TARGET');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1], button: 'none' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 });
  await sleep(400);
};
const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); await sleep(500); };
// visible element center by predicate source, evaluated in page
const VIS = `(e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }`;
const centerOf = (selectorJs) => ev(`(() => { const e = (${selectorJs}); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
const btnByAria = (aria, extra = '') => `[...document.querySelectorAll('button,[role=radio]')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(aria)} && (${VIS})(e) ${extra})`;
const waitFor = async (fn, ms, what) => { const until = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > until) throw new Error('TIMEOUT waiting for ' + what); await sleep(500); } };

// Radix menu: press trigger -> pick menuitemradio whose text equals `item`.
const pickMenu = async (triggerAria, item) => {
  const cur = await ev(`(() => { const e = ${btnByAria(triggerAria)}; return e ? e.innerText.trim() : null; })()`);
  if (cur === null) return { skipped: 'control-missing' };
  if (cur === item) return { value: cur };
  await press(await centerOf(btnByAria(triggerAria)));
  const pos2 = await waitFor(() => centerOf(`[...document.querySelectorAll('[role=menuitemradio],[role=menuitem]')].find((e) => e.innerText.trim() === ${JSON.stringify(item)} && (${VIS})(e))`), 4000, `menu item ${item}`);
  await press(pos2);
  await sleep(500);
  const after = await ev(`(() => { const e = ${btnByAria(triggerAria)}; return e ? e.innerText.trim() : null; })()`);
  if (after !== item) throw new Error(`${triggerAria} is ${after}, expected ${item}`);
  return { value: after };
};

const warnings = [];
const t0 = Date.now();
let out = { mode, ok: false };
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  await waitFor(() => ev(`!!(${btnByAria('비디오')} || ${btnByAria('이미지')})`), 30000, 'mode radios');
  // mode radio
  const want = mode === 'video' ? '비디오' : '이미지';
  const checked = await ev(`(() => { const e = ${btnByAria(want)}; return e ? e.getAttribute('aria-checked') : null; })()`);
  if (checked !== 'true') await press(await centerOf(btnByAria(want)));

  // attach image (image->video: required; image mode: optional --ref)
  const srcImage = mode === 'video' ? rest[0] : flags.ref;
  if (srcImage) {
    if (mode === 'video' && !fs.existsSync(srcImage)) throw new Error('image not found: ' + srcImage);
    chooser = null; await send('Page.setInterceptFileChooserDialog', { enabled: true });
    await press(await centerOf(btnByAria('업로드', `&& !e.closest('[role=dialog]')`)));
    await waitFor(() => ev(`[...document.querySelectorAll('button')].some((e) => e.innerText.trim() === '업로드' && e.getAttribute('role') !== 'tab' && (${VIS})(e))`), 8000, 'upload panel');
    await press(await centerOf(`[...document.querySelectorAll('button')].find((e) => e.innerText.trim() === '업로드' && e.getAttribute('role') !== 'tab' && (${VIS})(e))`));
    await waitFor(async () => chooser, 8000, 'file chooser');
    await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [path.resolve(srcImage)] });
    await send('Page.setInterceptFileChooserDialog', { enabled: false });
    await waitFor(() => ev(`document.body.innerText.includes('이미지를 참조하려면') || [...document.querySelectorAll('img')].some((i) => { const r = i.getBoundingClientRect(); return r.y > 250 && r.y < 360 && r.width > 0 && r.width < 120; })`), 30000, 'attachment');
    await key('Escape', 'Escape', 27); // the picker stays open after upload
    await sleep(800);
    out.image = path.basename(srcImage);
  }

  if (mode === 'video') {
    const res = flags.res || '720p';
    const dur = `${String(flags.dur || 6).replace(/s$/, '')}s`;
    out.resolution = (await pickMenu('비디오 해상도', res)).value ?? null;
    out.duration = (await pickMenu('동영상 길이', dur)).value ?? null;
    if (flags.ratio) {
      const r = await pickMenu('종횡비', flags.ratio);
      if (r.skipped) warnings.push(`--ratio=${flags.ratio} not applied: image-to-video has no 종횡비 control (output follows the input image)`);
      else out.ratio = r.value;
    }
    if (flags.audio) {
      const wantOn = flags.audio === 'on';
      const pressed = await ev(`(() => { const e = ${btnByAria('비디오 오디오')}; return e ? e.getAttribute('aria-pressed') === 'true' : null; })()`);
      if (pressed !== null && pressed !== wantOn) await press(await centerOf(btnByAria('비디오 오디오')));
    }
    out.audio = await ev(`(() => { const e = ${btnByAria('비디오 오디오')}; return e ? (e.getAttribute('aria-pressed') === 'true' ? 'on' : 'off') : null; })()`);
  }

  // prompt
  const boxXY = await centerOf(`[...document.querySelectorAll('[role=textbox],[contenteditable=true],textarea')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 300 && r.y > 200 && r.y < 520 && (${VIS})(e); })`);
  await press(boxXY);
  await send('Input.insertText', { text: flags.prompt });
  await sleep(600);
  const typed = await ev(`(() => { const e = [...document.querySelectorAll('[role=textbox],[contenteditable=true],textarea')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 300 && r.y > 200 && r.y < 520; }); return e ? (e.innerText || e.value || '').trim() : ''; })()`);
  if (!typed.includes(flags.prompt.slice(0, 40))) throw new Error('prompt not entered');

  // submit
  const seenBefore = mode === 'image' ? await ev(`[...document.querySelectorAll('img')].map((x) => x.currentSrc || x.src)`) : [];
  const submitted = Date.now();
  await press(await waitFor(() => centerOf(btnByAria('제출')), 8000, 'submit button'));
  log('submitted; waiting for result');

  // result. video: the post URL first shows a provisional /imagine/post/<id> whose final id can differ, so the id is re-read on every poll.
  // image: the results grid stays on /imagine; the first image not present before submit is taken.
  const wantFile = mode === 'video' ? 'generated_video.mp4' : null;
  const pollExpr = mode === 'video'
    ? `(() => { const p = location.pathname.split('/'); const k = p.indexOf('post'); const id = k > 0 && p[k - 1] === 'imagine' ? p[k + 1] : null; if (!id) return null; const v = [...document.querySelectorAll('video')].find((x) => (x.currentSrc || x.src || '').includes('/generated/' + id + '/')); if (v) return { id, kind: 'video', src: v.currentSrc || v.src, w: v.videoWidth, h: v.videoHeight, d: Number.isFinite(v.duration) ? v.duration : null }; return null; })()`
    : `(() => { const seen = new Set(${JSON.stringify(seenBefore)}); const im = [...document.querySelectorAll('img')].find((x) => { const s = x.currentSrc || x.src || ''; return (s.includes('imagine-public/images/') || s.includes('/generated/')) && !seen.has(s) && x.naturalWidth > 0 && x.complete; }); return im ? { id: null, kind: 'image', src: im.currentSrc || im.src, w: im.naturalWidth, h: im.naturalHeight } : null; })()`;
  if (mode === 'video') await waitFor(async () => (await ev('location.pathname')).includes('/imagine/post/'), 60000, 'post page');
  let media = null; let lastPct = -1;
  const until = Date.now() + 900000;
  while (Date.now() < until) {
    media = await ev(pollExpr);
    const pct = await ev(`(document.body.innerText.match(/생성 중 *([0-9]+)%/) || [])[1] || null`);
    if (pct && Number(pct) !== lastPct && Number(pct) % 20 === 0) { lastPct = Number(pct); log(`progress ${pct}%`); }
    if (media && (mode === 'video' ? media.kind === 'video' && media.src.includes(wantFile) && media.w > 0 && !pct : true)) { log(`media ready: ${media.kind} ${media.w}x${media.h}${media.id ? ' post=' + media.id : ''}`); break; }
    await sleep(2000);
  }
  if (!media) throw new Error('TIMEOUT: no generated media');
  const postId = media.id;
  const elapsedSec = Math.round((Date.now() - submitted) / 1000);

  // download with the tab's cookies (memory only, never written)
  // cookies are sent only to grok.com hosts (image results may come from another CDN host)
  const onGrok = /(^|\.)grok\.com$/.test(new URL(media.src).hostname);
  const cookie = onGrok ? ((await send('Network.getCookies', { urls: [media.src] })).result?.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ') : '';
  const res = await fetch(media.src, { headers: { ...(cookie ? { cookie } : {}), referer: 'https://grok.com/' } });
  if (!res.ok) throw new Error('download HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const outPath = path.resolve(mode === 'video' ? rest[1] : rest[0]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  out = { ...out, ok: true, postId, out: outPath, bytes: buf.length, kind: media.kind, width: media.w, height: media.h, elapsedSec };
  if (mode === 'video') out.seconds = Number(media.d?.toFixed?.(2)) || null;
  out.prompt = flags.prompt;
} catch (e) {
  out.ok = false; out.error = e.message; out.tab = created.id;
  process.exitCode = 1;
} finally {
  out.totalSec = Math.round((Date.now() - t0) / 1000);
  if (warnings.length) out.warnings = warnings;
  console.log(JSON.stringify(out));
  ws.close();
  if (!(process.env.GROK_IMAGINE_KEEP_TAB && !out.ok)) await fetch(`${CDP}/json/close/${created.id}`).catch(() => {});
}
