// Hard-subtitle removal on Vmake (vmake.ai) through its free 5 s previews (owner 2026-10-26: "정지 상관없어 ... 싹 자막 지워";
// a full-length download needs a paid plan, the account may be suspended for this and that is accepted). Needs the automation
// Canary on :9333 logged in to Vmake (free Google sign-in). Split into 4.8 s chunks -> per chunk: own tab, upload through the
// page's file chooser (intercepted), wait for processing, "Download 5s preview video" into a work folder -> each cleaned chunk
// is time-stretched to its source chunk's exact length (Vmake returns +-0.1 s) -> concat with the ORIGINAL audio.
// Resumable: finished chunks in <work>/out are reused. First real run: 37 s seller clip, 8 chunks, 0 failures, about 5 min.
//   node scripts/vmake-subtitle-remove.mjs <in.mp4> <out.mp4> <workDir>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [src, dst, work] = process.argv.slice(2);
const FF = process.env.FFMPEG_BIN || 'ffmpeg'; const FP = process.env.FFPROBE_BIN || 'ffprobe';
const CHUNK = 4.8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inDir = path.join(work, 'in'); const outDir = path.join(work, 'out'); fs.mkdirSync(inDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
const dur = Number(spawnSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { encoding: 'utf8' }).stdout);
const n = Math.ceil(dur / CHUNK);
for (let i = 0; i < n; i++) {
  const f = path.join(inDir, `c${String(i).padStart(2, '0')}.mp4`);
  if (!fs.existsSync(f)) spawnSync(FF, ['-v', 'error', '-y', '-ss', (i * CHUNK).toFixed(3), '-t', String(CHUNK), '-i', src, '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', f]);
}
const rpc = (url) => new Promise((resolve) => { const ws = new WebSocket(url); let k = 0; const p = new Map(); const events = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } else events.push(m); };
  ws.onopen = () => resolve({ events, close: () => ws.close(), send: (method, params = {}) => new Promise((r) => { const id = ++k; p.set(id, r); ws.send(JSON.stringify({ id, method, params })); }) }); });
const evalIn = async (tid, expression) => { // fresh connection: the page swaps documents on the way to the editor
  const t = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((x) => x.id === tid); if (!t) return null;
  const c = await rpc(t.webSocketDebuggerUrl); const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); c.close();
  return r.result?.result?.value ?? null; };
const browser = await rpc((await (await fetch('http://127.0.0.1:9333/json/version')).json()).webSocketDebuggerUrl);

async function one(file, outFile) {
  const tmp = path.join(work, 'dl'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  const t = await (await fetch('http://127.0.0.1:9333/json/new?https://vmake.ai/remove-subtitles-from-video', { method: 'PUT' })).json();
  try {
    await sleep(8000);
    const tab = await rpc(t.webSocketDebuggerUrl); let chooser = null;
    const poll = setInterval(() => { const ev = tab.events.find((e) => e.method === 'Page.fileChooserOpened'); if (ev) chooser = ev.params; }, 200);
    await tab.send('Page.enable'); await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await tab.send('Runtime.evaluate', { expression: "(() => { const c = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'Accept'); c && c.click(); const b = [...document.querySelectorAll('button,[role=button],div')].filter((x) => /^Upload$/.test((x.innerText || '').trim()) && x.offsetParent)[0]; b && b.click(); })()", userGesture: true });
    for (let i = 0; i < 30 && !chooser; i++) await sleep(300);
    clearInterval(poll);
    if (!chooser) throw new Error('NO_CHOOSER');
    await tab.send('DOM.setFileInputFiles', { files: [path.resolve(file)], backendNodeId: chooser.backendNodeId });
    tab.close();
    let state = null;
    for (let i = 0; i < 72; i++) {
      await sleep(5000);
      state = await evalIn(t.id, "(() => { const s = document.body ? document.body.innerText : ''; if (s.includes('Processing')) return 'processing'; if (s.includes('Download 5s preview')) return 'ready'; if (/Log in to enjoy/.test(s)) return 'login'; return 'other'; })()");
      if (state === 'ready' || state === 'login') break;
    }
    if (state !== 'ready') throw new Error('STATE_' + state);
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: tmp.replace(/\//g, '\\'), eventsEnabled: true });
    browser.events.length = 0;
    await evalIn(t.id, "(() => { const b = [...document.querySelectorAll('button,div')].filter((x) => /Download 5s preview/.test(x.innerText || '') && x.offsetParent).sort((a, b) => a.innerText.length - b.innerText.length)[0]; b && b.click(); })()");
    let done = null;
    for (let i = 0; i < 60 && !done; i++) { await sleep(1000); done = browser.events.find((e) => e.method === 'Browser.downloadProgress' && (e.params.state === 'completed' || e.params.state === 'canceled')); }
    if (done?.params.state !== 'completed') {
      const msg = await evalIn(t.id, "(document.body.innerText.match(/(limit|today|upgrade|credit|log in)[^\\n]{0,80}/i) || [''])[0]");
      throw new Error('DOWNLOAD_' + (done?.params.state ?? 'timeout') + (msg ? ' ' + msg : ''));
    }
    const got = fs.readdirSync(tmp).find((x) => x.endsWith('.mp4'));
    fs.renameSync(path.join(tmp, got), outFile);
  } finally {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await fetch(`http://127.0.0.1:9333/json/close/${t.id}`).catch(() => {});
  }
}

const chunks = fs.readdirSync(inDir).filter((x) => /^c\d+\.mp4$/.test(x)).sort();
for (const c of chunks) {
  const o = path.join(outDir, c);
  if (fs.existsSync(o)) { console.log(c, 'cached'); continue; }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try { await one(path.join(inDir, c), o); console.log(c, 'ok', Math.round((Date.now() - t0) / 1000) + 's'); break; }
    catch (e) { console.log(c, 'attempt', attempt, 'failed', e.message); if (attempt === 2) { browser.close(); process.exit(1); } }
  }
}
browser.close();
// concat: stretch each cleaned chunk to its source chunk's length, then join under the original audio
const durOf = (f) => Number(spawnSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout);
const inputs = chunks.flatMap((c) => ['-i', path.join(outDir, c)]);
const W0 = spawnSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src], { encoding: 'utf8' }).stdout.trim().split(',').map(Number);
const filt = chunks.map((c, k) => `[${k}:v]setpts=PTS*${(durOf(path.join(inDir, c)) / durOf(path.join(outDir, c))).toFixed(5)},fps=30,scale=${W0[0]}:${W0[1]},setsar=1[v${k}]`).join(';')
  + ';' + chunks.map((_, k) => `[v${k}]`).join('') + `concat=n=${chunks.length}:v=1:a=0[v]`;
const r = spawnSync(FF, ['-v', 'error', '-y', ...inputs, '-i', src, '-filter_complex', filt, '-map', '[v]', '-map', `${chunks.length}:a:0?`,
  '-c:v', 'libx264', '-crf', '17', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', dst]);
if (r.status) { console.log('concat failed', String(r.stderr).slice(0, 300)); process.exit(1); }
console.log('done', dst, durOf(dst).toFixed(2) + 's (source ' + dur.toFixed(2) + 's)');
