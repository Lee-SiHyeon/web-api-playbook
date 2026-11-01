// YouTube Studio per-video analytics reader (read-only), driven in the logged-in automation Canary (CDP 9333).
// Why: the Data API gives views/likes/comments only. Whether a Short is "viewed vs swiped away" (the signal that decides
// whether YouTube widens distribution past the first test audience) and how long people watch exist only in Studio.
// Owner 2026-11-01: "조회수및 반응 등 데이터검수 안함 ...?" / "웹플레이북부터 개선해와".
//
//   node scripts/youtube-studio-analytics.mjs --in=<videos.json> [--period=lifetime|4w|7d] [--out=<result.json> [--resume]] [--raw=<dir>] [--minFreeGB=1.5]
//   node scripts/youtube-studio-analytics.mjs --channelId=UC.. --channelName="빵터짐연구소" <videoId> [videoId...]
// videos.json: [{"id":"cvLKnSLVMP4","channelId":"UC...","channelName":"빵터짐연구소"}, ...]  (grouped by channel; one switch per group)
//
// Method (observed 2026-11-01, Studio cver 1.20261029): /video/<id>/analytics/tab-overview/period-<p> makes the page call
// POST /youtubei/v1/yta_web/get_cards itself; this script only reads those responses (Network.getResponseBody). Nothing is
// sent by us and no cookie/token leaves the tab. Studio must be the video's channel (see ensureChannel; same switcher
// logic as youtube-studio.mjs), otherwise the page shows "오류가 발생했습니다.".
// Metrics read (enum names as Studio uses them):
//   EXTERNAL_VIEWS 조회수, ENGAGED_VIEWS 참여 조회수, ESTIMATED_UNIQUE_VIEWERS 순시청자, EXTERNAL_WATCH_TIME 시청 시간(ms),
//   AVERAGE_WATCH_TIME 평균 시청 시간(ms), SHORTS_FEED_IMPRESSIONS_VTR 쇼츠 피드에서 "시청함" 비율(나머지는 넘김),
//   traffic sources (TRAFFIC_SOURCE_TYPE share), audience-retention highlights (raw, when present).
// Data lag: Studio says retention/VTR can take up to 2 days; fresh videos return nulls (reported as pending, not 0).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CDP = 'http://127.0.0.1:9333';
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((f) => { const [k, ...v] = f.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const ids = args.filter((a) => !a.startsWith('--'));
const PERIOD = { lifetime: 'period-lifetime', '4w': 'period-default', '7d': 'period-week' }[opt.period || 'lifetime'] || 'period-lifetime';
let videos = opt.in ? JSON.parse(fs.readFileSync(opt.in, 'utf8')) : ids.map((id) => ({ id, channelId: opt.channelId, channelName: opt.channelName }));
if (!videos.length) { console.error('usage: youtube-studio-analytics.mjs --in=<videos.json> | --channelId=UC.. --channelName=.. <videoId...> [--period=lifetime|4w|7d] [--out=f] [--raw=dir]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.error(JSON.stringify(o));

const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let seq = 0; const pend = new Map(); let captured = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.responseReceived' && /\/youtubei\/v1\/yta_web\/get_cards/.test(m.params.response.url)) captured.push(m.params.requestId);
  if (m.method === 'Network.loadingFinished') { const c = captured.find((x) => x === m.params.requestId); if (c) finished.add(c); }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const finished = new Set();
const send = (method, params = {}) => new Promise((r) => { const i = ++seq; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text); return m.result?.result?.value; };
const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await ev(expr).catch(() => null); if (v) return v; await sleep(700); } return null; };
// Memory (owner 2026-11-01 "메모리 관리 안함 ?"): small response buffer (get_cards bodies are ~150 KB), one reused tab
// closed at the end, each video a full page load (heap does not accumulate), results saved after every video, and the
// batch stops cleanly with LOW_MEMORY when free RAM falls under --minFreeGB (default 1.5); rerun with --resume.
await send('Page.enable'); await send('Network.enable', { maxTotalBufferSize: 15e6, maxResourceBufferSize: 3e6 });

const activeChannel = () => ev(`(window.ytcfg && ytcfg.get && ytcfg.get('CHANNEL_ID')) || null`);
async function ensureChannel(v) {
  await send('Page.navigate', { url: 'https://studio.youtube.com/' }); await sleep(8000);
  const before = await activeChannel();
  if (!v.channelId || before === v.channelId) return before;
  if (!v.channelName) throw Object.assign(new Error('CHANNEL_MISMATCH'), { active: before, want: v.channelId });
  await waitFor(`(() => { const b = document.querySelector('#avatar-btn'); if (!b) return false; b.click(); return true; })()`, 15000); await sleep(2000);
  await waitFor(`(() => { const b = [...document.querySelectorAll('tp-yt-paper-item, ytd-compact-link-renderer, [role=menuitem]')].find((x) => /계정 전환/.test(x.innerText || '')); if (!b) return false; b.click(); return true; })()`, 10000); await sleep(3000);
  const ok = await ev(`(() => { const b = [...document.querySelectorAll('ytd-account-item-renderer')].find((x) => (x.innerText || '').trim().split('\\n')[0] === ${JSON.stringify(v.channelName)}); if (!b) return false; (b.querySelector('tp-yt-paper-icon-item, a, [role=link]') || b).click(); return true; })()`);
  if (!ok) throw Object.assign(new Error('CHANNEL_NOT_IN_SWITCHER'), { want: v.channelName });
  await sleep(9000); await send('Page.navigate', { url: 'https://studio.youtube.com/' }); await sleep(8000);
  const after = await activeChannel();
  if (after !== v.channelId) throw Object.assign(new Error('CHANNEL_SWITCH_FAILED'), { before, after, want: v.channelId });
  log({ step: 'channel', switchedFrom: before, active: after });
  return after;
}

// Pull the metrics we care about out of get_cards responses (structure observed 2026-11-01).
function extract(bodies) {
  const out = { views: null, engagedViews: null, uniqueViewers: null, watchTimeMs: null, avgWatchMs: null, viewedRate: null, trafficSources: null, retention: null };
  const key = { EXTERNAL_VIEWS: 'views', ENGAGED_VIEWS: 'engagedViews', ESTIMATED_UNIQUE_VIEWERS: 'uniqueViewers', EXTERNAL_WATCH_TIME: 'watchTimeMs', AVERAGE_WATCH_TIME: 'avgWatchMs' };
  for (const b of bodies) for (const c of b.cards || []) {
    for (const tab of c.keyMetricCardData?.keyMetricTabs || []) {
      const p = tab.primaryContent; if (p && key[p.metric] && typeof p.total === 'number' && out[key[p.metric]] == null) out[key[p.metric]] = p.total;
    }
    for (const col of c.stackedBarCardData?.overviewCardData?.cardData?.metricColumns || []) {
      if (col.metric?.type === 'SHORTS_FEED_IMPRESSIONS_VTR' && !(col.undefinedValueIndices || []).includes(0)) out.viewedRate = col.percentages?.values?.[0] ?? null;
    }
    const tc = c.config?.tableCardConfig;
    if (tc?.dimension === 'TRAFFIC_SOURCE_TYPE' && !tc.restrict && c.tableCardData && !out.trafficSources) {
      const d = c.tableCardData.mainTableData || c.tableCardData.dataTable || c.tableCardData;
      const dims = d.dimensionColumns?.[0]?.strings?.values || d.dimensionColumns?.[0]?.enumValues?.values || [];
      const vals = d.metricColumns?.[0]?.percentages?.values || d.metricColumns?.[0]?.counts?.values || [];
      if (dims.length) out.trafficSources = Object.fromEntries(dims.map((k, i) => [k, vals[i] ?? null]));
    }
    const rv = c.audienceRetentionHighlightsCardData?.videosData?.[0];
    if (rv && !out.retention) {
      const curve = rv.retentionValues || []; const pick = (f) => curve.length ? curve[Math.min(curve.length - 1, Math.round(f * (curve.length - 1)))] : null;
      // retentionValues: % of viewers still watching at each 1% of the video (can exceed 100 with replays)
      out.retention = { avgPercentageWatched: rv.metricTotals?.avgPercentageWatched ?? null, at0: pick(0), at25: pick(0.25), at50: pick(0.5), at75: pick(0.75), at100: pick(1), points: curve.length };
      if (out.viewedRate == null && typeof rv.metricTotals?.shortsFeedImpressionsVtr === 'number') out.viewedRate = rv.metricTotals.shortsFeedImpressionsVtr;
    }
  }
  return out;
}

// --resume keeps the ok rows already in --out and reads only the rest (a killed batch continues where it stopped).
const prev = opt.resume && opt.out && fs.existsSync(opt.out) ? (JSON.parse(fs.readFileSync(opt.out, 'utf8')).results || []).filter((r) => r.ok) : [];
videos = videos.filter((v) => !prev.some((r) => r.id === v.id));
const results = [...prev]; const byChannel = new Map();
const save = (partial) => { if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ at: new Date().toISOString(), partial, results }, null, 1) + '\n'); };
for (const v of videos) { const k = v.channelId || '-'; if (!byChannel.has(k)) byChannel.set(k, []); byChannel.get(k).push(v); }
let stop = false;
try {
  for (const [, group] of byChannel) {
    if (stop) break;
    try { await ensureChannel(group[0]); } catch (e) { for (const v of group) results.push({ id: v.id, ok: false, code: e.message, ...e }); continue; }
    for (const v of group) {
      const freeGB = os.freemem() / 1e9;
      if (freeGB < Number(opt.minFreeGB || 1.5)) { results.push({ id: v.id, ok: false, code: 'LOW_MEMORY', freeGB: +freeGB.toFixed(2) }); stop = true; break; }
      captured = []; finished.clear();
      await send('Page.navigate', { url: `https://studio.youtube.com/video/${v.id}/analytics/tab-overview/${PERIOD}` });
      const end = Date.now() + 30000; let lastN = -1, stable = 0;
      while (Date.now() < end) { await sleep(1500); const n = finished.size; if (n && n === lastN) { if (++stable >= 3) break; } else stable = 0; lastN = n; }
      const bodies = [];
      for (const id of finished) { try { const r = await send('Network.getResponseBody', { requestId: id }); bodies.push(JSON.parse(r.result.body)); } catch {} }
      const err = await ev(`/오류가 발생했습니다/.test(document.body.innerText.slice(0, 400))`).catch(() => false);
      if (opt.raw) { fs.mkdirSync(opt.raw, { recursive: true }); fs.writeFileSync(path.join(opt.raw, `${v.id}.json`), JSON.stringify(bodies)); }
      const m = extract(bodies);
      results.push({ id: v.id, ok: !err && bodies.length > 0, code: err ? 'STUDIO_ERROR_PAGE' : bodies.length ? undefined : 'NO_CARDS', period: opt.period || 'lifetime', ...m, pending: m.viewedRate == null ? 'Studio data not ready (up to 2 days) or not a Short' : undefined });
      log({ step: 'video', id: v.id, views: m.views, viewedRate: m.viewedRate, avgWatchMs: m.avgWatchMs });
      save(true);
    }
  }
} finally { try { await fetch(`${CDP}/json/close/${t.id}`); } catch {} try { ws.close(); } catch {} }
save(stop);
console.log(JSON.stringify({ at: new Date().toISOString(), stoppedLowMemory: stop, results }, null, 1));
process.exit(0);
