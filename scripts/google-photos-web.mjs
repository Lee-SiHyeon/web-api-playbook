// Google Photos web, driven in the logged-in automation Canary (CDP 9333). Own tab, closed at the end. 2026-10-23.
// Use: find the owner's own phone footage (backed up to Google Photos, not Drive) for real-experience clips, read where and
// when each was shot, and download originals. Read-only: nothing is shared, edited, moved or deleted.
//   node scripts/google-photos-web.mjs storage                       -> {loggedIn, storage: "5TB 중 …GB 사용"}
//   node scripts/google-photos-web.mjs list [--videos] [--query=<text>] [--limit=100] [--json]
//        -> one row per item: date | type/orientation | duration | url   (newest first; scrolls to collect --limit)
//   node scripts/google-photos-web.mjs info <photoUrl>...            -> {url, date, file, resolution, size, place, device}
//   node scripts/google-photos-web.mjs download <photoUrl>... --out=<dir>
//        -> original file (Shift+D on the item page); waits for the download to finish and prints {file, bytes}
// Notes:
//  - "list --videos" opens the built-in 동영상 view (/search/_tv_); "--query" uses the search box (e.g. a place name).
//  - The first visit may show a face-grouping prompt. It is personal, so this script closes it without choosing.
//  - The info panel shows the place at the precision Google keeps (often only the city).
//  - Personal media: keep downloads out of any repository. Ask the owner before publishing anything from here.
import fs from 'node:fs';
import path from 'node:path';

const CDP = process.env.GP_CDP || 'http://127.0.0.1:9333';
const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
const args = rest.filter((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
  let n = 0; const p = new Map(); const listeners = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } else if (m.method) listeners.forEach((f) => f(m)); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ws, send, on: (f) => listeners.push(f) };
}
async function open(url) {
  const t = await (await fetch(`${CDP}/json/new?${url}`, { method: 'PUT' })).json();
  const c = await attach(t.webSocketDebuggerUrl);
  c.ev = async (e) => (await c.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
  c.key = async (key, code, vk, modifiers = 0, text) => { await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) }); await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers }); };
  c.close = async () => { c.ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); };
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.bringToFront');
  return c;
}
async function closePrompt(c) { // face-grouping or other first-run dialog: close, never choose
  await c.ev(`(() => { const d = [...document.querySelectorAll('[role=dialog]')].find((x) => x.getBoundingClientRect().width); if (!d) return 0;
    const b = [...d.querySelectorAll('button,[role=button]')].find((x) => /닫기|Close/.test(x.getAttribute('aria-label') || x.innerText || '')); if (b) b.click(); return 1; })()`);
}
const loggedIn = (c) => c.ev(`!!document.querySelector('a[aria-label*="Google 계정"], a[aria-label*="Google Account"]')`);

const out = [];
if (cmd === 'storage') {
  const c = await open('https://photos.google.com/');
  try {
    await sleep(8000); await closePrompt(c);
    console.log(JSON.stringify({ loggedIn: await loggedIn(c), storage: await c.ev(`(document.body.innerText.match(/\\d+(\\.\\d+)?\\s*[TG]B 중 [\\d.]+\\s*[TGM]B 사용|[\\d.]+\\s*[TGM]B of [\\d.]+\\s*[TG]B used/) || [])[0] || null`) }));
  } finally { await c.close(); }
} else if (cmd === 'list') {
  const url = opt.videos && !opt.query ? 'https://photos.google.com/search/_tv_' : opt.query ? `https://photos.google.com/search/${encodeURIComponent(opt.query)}` : 'https://photos.google.com/';
  const limit = Number(opt.limit || 100);
  const c = await open(url);
  try {
    await sleep(9000); await closePrompt(c);
    if (!(await loggedIn(c))) throw new Error('NOT_LOGGED_IN');
    const seen = new Map(); // the grid virtualises: collect at each scroll step
    for (let i = 0; i < 60 && seen.size < limit; i++) {
      const rows = await c.ev(`[...document.querySelectorAll('a[href*="/photo/"]')].map((a) => ({ url: a.href.replace(/^.*(\\/photo\\/[^/?]+).*$/, 'https://photos.google.com$1'), label: a.getAttribute('aria-label') || '', duration: (a.parentElement.innerText.match(/\\d+:\\d{2}(:\\d{2})?/) || [])[0] || '' }))`);
      const before = seen.size; for (const r of rows || []) if (!seen.has(r.url)) seen.set(r.url, r);
      await c.ev(`window.scrollBy(0, 900)`); await sleep(1200);
      if (seen.size === before && i > 3) { const atEnd = await c.ev(`innerHeight + scrollY >= document.body.scrollHeight - 5`); if (atEnd) break; }
    }
    for (const r of [...seen.values()].slice(0, limit)) {
      const m = r.label.match(/^(.*?) - (.*?) - (.*)$/) || [];
      out.push({ date: m[3] || '', type: m[1] ? `${m[1]}/${m[2]}` : r.label, duration: r.duration, url: r.url });
    }
    if (opt.json) console.log(JSON.stringify(out, null, 1)); else for (const r of out) console.log(`${r.date} | ${r.type} | ${r.duration || '-'} | ${r.url}`);
  } finally { await c.close(); }
} else if (cmd === 'info' || cmd === 'download') {
  if (!args.length) { console.error(`usage: google-photos-web.mjs ${cmd} <photoUrl>...${cmd === 'download' ? ' --out=<dir>' : ''}`); process.exit(2); }
  let dir = null, browser = null;
  if (cmd === 'download') {
    if (!opt.out) { console.error('download needs --out=<dir>'); process.exit(2); }
    dir = path.resolve(opt.out); fs.mkdirSync(dir, { recursive: true });
    browser = await attach((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl);
  }
  const c = await open('https://photos.google.com/');
  try {
    await sleep(6000); await closePrompt(c);
    for (const url of args) {
      await c.send('Page.navigate', { url }); await sleep(6000); await closePrompt(c);
      if (cmd === 'info') {
        // The info panel stays open across items once opened, and 'i' toggles it: press only when it is not showing.
        // Leaves under the panel, in order: 설명 추가, 세부정보, <date>, <weekday time>, GMT+.., <file>, <MP>, <WxH>, <device>, 백업됨(<size>), 자세히 알아보기, <place>, 지도 데이터 ..
        const panelLeaves = `(() => { const h = [...document.querySelectorAll('*')].find((e) => !e.children.length && /^(세부정보|Details)$/.test(e.textContent.trim()) && e.getBoundingClientRect().width); if (!h) return [];
          let b = h; while (b.parentElement && !/설명 추가|Add a description/.test(b.parentElement.textContent)) b = b.parentElement; b = b.parentElement || b; const x0 = h.getBoundingClientRect().x - 40;
          return [...b.querySelectorAll('*')].filter((e) => !e.children.length && e.getBoundingClientRect().width && e.getBoundingClientRect().x >= x0).map((e) => e.textContent.trim()).filter(Boolean); })()`;
        const MEDIA = /\.(mp4|mov|jpe?g|heic|png|gif|webp|3gp|m4v)$/i;
        const ready = (L) => L.some((s) => MEDIA.test(s));
        let L = await c.ev(panelLeaves);
        if (!L.length) await c.key('i', 'KeyI', 73, 0, 'i');
        for (let k = 0; k < 15 && !ready(L); k++) { await sleep(700); L = await c.ev(panelLeaves); }
        if (!ready(L)) { out.push({ url, error: 'NO_INFO_PANEL' }); console.log(JSON.stringify(out.at(-1))); continue; }
        const at = (re) => L.find((s) => re.test(s)) || null;
        const i = L.findIndex((s) => /^(세부정보|Details)$/.test(s));
        const more = L.findIndex((s) => /자세히 알아보기|Learn more/.test(s));
        const place = more >= 0 && L[more + 1] && !/지도 데이터|Map data|약관|Terms/.test(L[more + 1]) ? L[more + 1] : null;
        out.push({ url, date: i >= 0 ? L.slice(i + 1, i + 3).join(' ') : null, file: at(MEDIA), resolution: at(/^\d+\s*[×x]\s*\d+$/),
          size: ((L.join(' ').match(/\(([\d.]+\s*[KMGT]B)\)/) || [])[1]) || null, device: at(/업로드됨|Uploaded from/), place });
        console.log(JSON.stringify(out.at(-1)));
      } else {
        const files0 = new Set(fs.readdirSync(dir));
        await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
        let done = null; browser.on((m) => { if (m.method === 'Browser.downloadProgress' && m.params.state !== 'inProgress') done = m.params; });
        await c.key('D', 'KeyD', 68, 8, 'D'); // Shift+D = download original
        for (let k = 0; k < 900 && !done; k++) await sleep(1000); // up to 15 min for large videos
        const added = fs.readdirSync(dir).filter((f) => !files0.has(f) && !/\.crdownload$/.test(f));
        const f = added[0] ? path.join(dir, added[0]) : null;
        out.push({ url, state: done?.state || 'timeout', file: f, bytes: f ? fs.statSync(f).size : 0 });
        console.log(JSON.stringify(out.at(-1)));
        if (done?.state !== 'completed') process.exitCode = 1;
      }
    }
  } finally { await c.close(); if (browser) { await browser.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {}); browser.ws.close(); } }
} else {
  console.error('usage: google-photos-web.mjs storage | list [--videos] [--query=] [--limit=] [--json] | info <url>... | download <url>... --out=<dir>'); process.exit(2);
}
