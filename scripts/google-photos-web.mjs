// Google Photos web, driven in the logged-in automation Canary (CDP 9333). Own tab, closed at the end. 2026-10-23.
// Use: find the owner's own phone footage (backed up to Google Photos, not Drive) for real-experience clips, read where and
// when each was shot, and download originals. Read-only on Google Photos: nothing is shared, edited, moved or deleted.
//   node scripts/google-photos-web.mjs storage                       -> {loggedIn, storage: "5TB 중 …GB 사용"}
//   node scripts/google-photos-web.mjs list [--videos] [--query=<text>] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--limit=100] [--json]
//        -> one row per item: date | type/orientation | duration | url   (newest first; scrolls to collect)
//   node scripts/google-photos-web.mjs info <photoUrl>...            -> {url, date, file, resolution, size, place, device}
//   node scripts/google-photos-web.mjs download --out=<dir> <photoUrl>...
//   node scripts/google-photos-web.mjs download --out=<dir> [--videos] [--query=<text>] [--since=] [--until=] [--limit=]
//   node scripts/google-photos-web.mjs download --out=<dir> --from=<list.json>      (the output of list --json)
//        -> original files (Shift+D on each item page), one at a time, each awaited to completion: {url, state, file, bytes}
//        Resumable: <out>/.google-photos-downloads.json records finished items, which later runs skip.
//        --timeout-min=30 per item (large 4K videos are GBs). --dry lists what would be downloaded.
// Notes:
//  - "--videos" opens the built-in 동영상 view (/search/_tv_); "--query" uses Photos search (a place, a thing, a month).
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

// "2026. 10. 15. 오후 2:15:08" (or "Oct 15, 2026, 2:15:08 PM") -> "2026-10-15"
function ymd(label) {
  const m = label.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(label.replace(/ /g, ' ')); return Number.isNaN(+d) ? '' : d.toISOString().slice(0, 10);
}
const listUrl = () => (opt.query ? `https://photos.google.com/search/${encodeURIComponent(opt.query)}` : opt.videos ? 'https://photos.google.com/search/_tv_' : 'https://photos.google.com/');
const inRange = (r) => (!opt.since || (r.day || '') >= opt.since) && (!opt.until || (r.day || '9999') <= opt.until);

// Collect grid items (newest first). The grid virtualises, so rows are gathered at every scroll step; stops at `limit`
// matches, at the end of the grid, or once the grid is older than --since.
async function collect(c, limit) {
  const seen = new Map();
  for (let i = 0; i < 400; i++) {
    const rows = await c.ev(`[...document.querySelectorAll('a[href*="/photo/"]')].map((a) => ({ url: a.href.replace(/^.*(\\/photo\\/[^/?]+).*$/, 'https://photos.google.com$1'), label: a.getAttribute('aria-label') || '', duration: (a.parentElement.innerText.match(/\\d+:\\d{2}(:\\d{2})?/) || [])[0] || '' }))`);
    const before = seen.size;
    for (const r of rows || []) if (!seen.has(r.url)) { const m = r.label.match(/^(.*?) - (.*?) - (.*)$/) || []; seen.set(r.url, { date: m[3] || '', day: ymd(m[3] || r.label), type: m[1] ? `${m[1]}/${m[2]}` : r.label, duration: r.duration, url: r.url }); }
    const all = [...seen.values()];
    if (all.filter(inRange).length >= limit) break;
    if (opt.since && all.length && all.at(-1).day && all.at(-1).day < opt.since) break;
    await c.ev(`window.scrollBy(0, 900)`); await sleep(1200);
    if (seen.size === before && i > 3) { const atEnd = await c.ev(`innerHeight + scrollY >= document.body.scrollHeight - 5`); if (atEnd) break; }
  }
  return [...seen.values()].filter(inRange).slice(0, limit);
}

const out = [];
if (cmd === 'storage') {
  const c = await open('https://photos.google.com/');
  try {
    await sleep(8000); await closePrompt(c);
    console.log(JSON.stringify({ loggedIn: await loggedIn(c), storage: await c.ev(`(document.body.innerText.match(/\\d+(\\.\\d+)?\\s*[TG]B 중 [\\d.]+\\s*[TGM]B 사용|[\\d.]+\\s*[TGM]B of [\\d.]+\\s*[TG]B used/) || [])[0] || null`) }));
  } finally { await c.close(); }
} else if (cmd === 'list') {
  const c = await open(listUrl());
  try {
    await sleep(9000); await closePrompt(c);
    if (!(await loggedIn(c))) throw new Error('NOT_LOGGED_IN');
    out.push(...(await collect(c, Number(opt.limit || 100))));
    if (opt.json) console.log(JSON.stringify(out, null, 1)); else for (const r of out) console.log(`${r.date} | ${r.type} | ${r.duration || '-'} | ${r.url}`);
  } finally { await c.close(); }
} else if (cmd === 'info') {
  if (!args.length) { console.error('usage: google-photos-web.mjs info <photoUrl>...'); process.exit(2); }
  const c = await open('https://photos.google.com/');
  try {
    await sleep(6000); await closePrompt(c);
    for (const url of args) {
      await c.send('Page.navigate', { url }); await sleep(6000); await closePrompt(c);
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
    }
  } finally { await c.close(); }
} else if (cmd === 'download') {
  if (!opt.out) { console.error('download needs --out=<dir>'); process.exit(2); }
  const byFilter = !args.length && !opt.from;
  if (byFilter && !(opt.videos || opt.query || opt.since || opt.until)) { console.error('download: give item URLs, --from=<list.json>, or a filter (--videos/--query/--since/--until)'); process.exit(2); }
  const dir = path.resolve(opt.out); fs.mkdirSync(dir, { recursive: true });
  const stFile = path.join(dir, '.google-photos-downloads.json');
  const st = fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, 'utf8')) : {};
  const timeoutMs = Number(opt['timeout-min'] || 30) * 60000;
  const c = await open(byFilter ? listUrl() : 'https://photos.google.com/');
  const browser = await attach((await (await fetch(`${CDP}/json/version`)).json()).webSocketDebuggerUrl);
  // allowAndName saves each file under its download GUID; it is renamed to the original name once complete
  const dl = new Map(); // guid -> {name, state}
  browser.on((m) => {
    if (m.method === 'Browser.downloadWillBegin') dl.set(m.params.guid, { name: m.params.suggestedFilename, state: 'inProgress' });
    if (m.method === 'Browser.downloadProgress' && dl.has(m.params.guid)) dl.get(m.params.guid).state = m.params.state;
  });
  try {
    await sleep(byFilter ? 9000 : 6000); await closePrompt(c);
    if (!(await loggedIn(c))) throw new Error('NOT_LOGGED_IN');
    let items = args.map((url) => ({ url }));
    if (opt.from) items = JSON.parse(fs.readFileSync(opt.from, 'utf8')).filter(inRange);
    if (byFilter) items = await collect(c, Number(opt.limit || 1000));
    const todo = items.filter((x) => !st[x.url]?.file || !fs.existsSync(st[x.url].file));
    console.log(JSON.stringify({ matched: items.length, alreadyDownloaded: items.length - todo.length, todo: todo.length }));
    if (opt.dry) { for (const x of todo) console.log(`${x.date || ''} | ${x.type || ''} | ${x.duration || ''} | ${x.url}`); }
    else {
      await browser.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
      for (const x of todo) {
        await c.send('Page.navigate', { url: x.url }); await sleep(5000); await closePrompt(c);
        const known = new Set(dl.keys());
        await c.key('D', 'KeyD', 68, 8, 'D'); // Shift+D = download original
        let guid = null; for (let k = 0; k < 60 && !guid; k++) { await sleep(500); guid = [...dl.keys()].find((g) => !known.has(g)) || null; }
        if (!guid) { out.push({ url: x.url, state: 'not_started' }); console.log(JSON.stringify(out.at(-1))); process.exitCode = 1; continue; }
        const t0 = Date.now(); while (dl.get(guid).state === 'inProgress' && Date.now() - t0 < timeoutMs) await sleep(1000);
        const { name, state } = dl.get(guid); const tmp = path.join(dir, guid);
        if (state !== 'completed' || !fs.existsSync(tmp)) { out.push({ url: x.url, state: state === 'inProgress' ? 'timeout' : state, name }); console.log(JSON.stringify(out.at(-1))); process.exitCode = 1; continue; }
        let file = path.join(dir, name); const { name: base, ext } = path.parse(name);
        for (let n = 1; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n})${ext}`);
        fs.renameSync(tmp, file);
        st[x.url] = { file, bytes: fs.statSync(file).size, date: x.date || null, at: new Date().toISOString() };
        fs.writeFileSync(stFile, JSON.stringify(st, null, 1));
        out.push({ url: x.url, state, file, bytes: st[x.url].bytes }); console.log(JSON.stringify(out.at(-1)));
      }
    }
  } finally {
    await c.close();
    await browser.send('Browser.setDownloadBehavior', { behavior: 'default' }).catch(() => {}); browser.ws.close();
  }
} else {
  console.error('usage: google-photos-web.mjs storage | list [--videos] [--query=] [--since=] [--until=] [--limit=] [--json] | info <url>... | download --out=<dir> (<url>... | --from=<list.json> | --videos/--query/--since/--until [--limit=]) [--dry] [--timeout-min=30]'); process.exit(2);
}
