// New videos from the "여행 유튜버 따라가기" watchlist (youtuber-watchlist.json), public and anonymous:
// the channel RSS feed, or the channel's /videos page when the feed is unavailable (404/500 seen 2026-09-26).
// Usage: node youtuber-watch.mjs [--days=14] [--tier=core] [--out=<file>]
// Each candidate says whether Korean captions exist (player API, mobile client — the web caption URL returns 0 bytes),
// which the video graph needs. Shorts and clips under 8 minutes are skipped: a route needs a real trip video.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseFeed(xml) {
  return [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => ({
    videoId: m[1].match(/<yt:videoId>([^<]+)</)?.[1], title: m[1].match(/<title>([^<]*)<\/title>/)?.[1]?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
    publishedAt: m[1].match(/<published>([^<]+)</)?.[1] ?? null, isShort: /\/shorts\//.test(m[1]) })).filter(v => v.videoId);
}

// Destination words that make a trip video worth a follow post (Korean titles).
export const TRIP_HINT = /여행|박\s*\d일|\d박|일주|투어|브이로그|vlog|파리|도쿄|오사카|후쿠오카|교토|방콕|다낭|나트랑|세부|발리|타이베이|홍콩|싱가포르|런던|로마|바르셀로나|뉴욕|하와이|괌|사이판|호주|시드니|유럽|일본|대만|베트남|태국|미국|스페인|이탈리아|프랑스|튀르키예|터키|몽골|중국|제주|부산/i;

async function playerInfo(videoId) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
    body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'ko', gl: 'KR' } }, videoId }) });
  const j = await r.json();
  const tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return { lengthSec: Number(j?.videoDetails?.lengthSeconds ?? 0), captions: tracks.map(t => t.languageCode + (t.kind === 'asr' ? '(asr)' : '')), playable: j?.playabilityStatus?.status ?? null };
}

async function channelVideos(ch) {
  const feed = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.channelId}`, { headers: { 'user-agent': UA } });
  if (feed.status === 200) return { source: 'rss', videos: parseFeed(await feed.text()) };
  const page = await fetch(`https://www.youtube.com/channel/${ch.channelId}/videos?hl=ko`, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR' } });
  const t = await page.text();
  return { source: `videos-page ${page.status}`, videos: videosFromPage(t) };
}

// ytInitialData walk: older videoRenderer {videoId, title.runs} and the current lockupViewModel
// {contentId, metadata.lockupMetadataViewModel.title.content} (observed 2026-09-26).
export function videosFromPage(html) {
  const raw = String(html).match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
  if (!raw) return [];
  const out = [], seen = new Set();
  const walk = o => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    const vr = o.videoRenderer, lv = o.lockupViewModel;
    const id = vr?.videoId ?? lv?.contentId;
    const title = vr?.title?.runs?.map(r => r.text).join('') ?? lv?.metadata?.lockupMetadataViewModel?.title?.content;
    if (id && title && !seen.has(id)) { seen.add(id); out.push({ videoId: id, title, publishedAt: null, isShort: false }); }
    Object.values(o).forEach(walk);
  };
  try { walk(JSON.parse(raw)); } catch { return []; }
  return out;
}

export async function watch({ days = 14, tier = null, debug = false, now = Date.now(), list = JSON.parse(readFileSync(path.join(HERE, 'youtuber-watchlist.json'), 'utf8')) } = {}) {
  const out = [];
  for (const ch of list.channels.filter(c => !tier || c.tier === tier)) {
    let got; try { got = await channelVideos(ch); } catch (e) { out.push({ channel: ch.name, error: e.message }); continue; }
    if (debug) console.error(`[${ch.name}] ${got.source}: ${got.videos.slice(0, 8).map(v => `${(v.publishedAt ?? '').slice(0, 10)} ${v.title}`).join(' | ')}`);
    for (const v of got.videos.slice(0, 8)) {
      if (v.isShort || !TRIP_HINT.test(v.title ?? '')) continue;
      if (v.publishedAt && now - Date.parse(v.publishedAt) > days * 864e5) continue;
      const info = await playerInfo(v.videoId).catch(() => ({}));
      await sleep(400);
      if (info.lengthSec && info.lengthSec < 480) continue;
      out.push({ channel: ch.name, channelId: ch.channelId, tier: ch.tier, listSource: got.source, ...v, url: `https://youtu.be/${v.videoId}`,
        lengthMin: info.lengthSec ? Math.round(info.lengthSec / 60) : null, koCaptions: (info.captions ?? []).some(c => c.startsWith('ko')), captions: info.captions ?? [] });
    }
  }
  return { schemaVersion: 1, kind: 'youtuber-watch', checkedAt: new Date(now).toISOString(), days, candidates: out };
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const r = await watch({ days: Number(arg('days') ?? 14), tier: arg('tier') ?? null, debug: process.argv.includes('--debug') });
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify(r, null, 2) + '\n');
  for (const c of r.candidates) console.log(c.error ? `${c.channel}: ${c.error}` : `${(c.publishedAt ?? '').slice(0, 10) || '?'} ${c.channel} | ${c.title} | ${c.lengthMin ?? '?'}분 | 자막 ${c.captions.join(',') || '없음'} | ${c.url}`);
  console.log(JSON.stringify({ ok: true, candidates: r.candidates.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.message })); process.exitCode = 1; });
