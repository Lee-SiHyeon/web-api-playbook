// Audit: which videos of a channel lack localized captions/metadata. Reads YouTube Studio's 언어 (translations) list in the
// logged-in automation Canary (own tab, closed at the end); all pages. 2026-10-23: found that every Short and one long video had
// only the original language.
//   node scripts/youtube-studio-languages.mjs <channelId> [--min=9] [--json]
// Prints one row per video: videoId | length | title | language count | date, and flags rows below --min.
const CDP = process.env.YT_STUDIO_CDP || 'http://127.0.0.1:9333';
const [channelId, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((f) => { const i = f.indexOf('='); return i < 0 ? [f.slice(2), true] : [f.slice(2, i), f.slice(i + 1)]; }));
if (!channelId) { console.error('usage: youtube-studio-languages.mjs <channelId> [--min=9] [--json]'); process.exit(2); }
const min = Number(opt.min || 0);
const t = await (await fetch(`${CDP}/json/new?https://studio.youtube.com/channel/${channelId}/translations`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let n = 0; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++n; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 2400, deviceScaleFactor: 1, mobile: false });
  await sleep(12000);
  for (let pg = 0; pg < 20; pg++) {
    const got = await ev(`[...document.querySelectorAll('ytcp-video-row, tr')].map((r) => { const a = r.querySelector('a[href*="/video/"]'); const L = r.innerText.split('\\n').map((s) => s.trim()).filter(Boolean);
      return a ? { videoId: a.href.split('/video/')[1].split('/')[0], length: L[0], title: (L[1] || '').slice(0, 80), languages: Number(L[L.length - 2]) || 0, date: L[L.length - 1] } : null; }).filter(Boolean)`);
    for (const r of got || []) if (!rows.some((x) => x.videoId === r.videoId)) rows.push(r);
    const next = await ev(`(() => { const b = document.querySelector('#navigate-after'); if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false; b.click(); return true; })()`);
    if (!next) break; await sleep(5000);
  }
} finally { ws.close(); await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); }
if (opt.json) console.log(JSON.stringify(rows, null, 1));
else for (const r of rows) console.log(`${r.languages < min ? '!' : ' '} ${r.videoId} | ${r.length} | ${r.title} | langs ${r.languages} | ${r.date}`);
if (min) console.log(JSON.stringify({ videos: rows.length, belowMin: rows.filter((r) => r.languages < min).length }));
