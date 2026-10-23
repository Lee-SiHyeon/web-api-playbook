// YouTube hook scout (hook ontology, owner 2026-09-27 "유튜브로 온톨로지 수집기에 들여놔 … sns 섭렵한다"): which titles earn
// views for our topics, for long videos and Shorts, classified into hook-ontology patterns (titleMatch).
// Usage: node youtube-hook-scout.mjs [--queries=레고 추천,에어프라이어 추천] --out=<file>
//
// Public, anonymous GET (observed 2026-09-27): https://www.youtube.com/results?search_query=<q>&hl=ko&gl=KR embeds
// ytInitialData with videoRenderer (title, 조회수 N회, N일 전, channel) and shortsLockupViewModel (title, 조회수 N만회).
// Instagram tag pages (login wall) and TikTok discover pages (redirect to the home shell) give nothing anonymously, so
// short-form evidence comes from YouTube Shorts. Stops at a consent/challenge page. Titles and counts only.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadHookOntology } from './hooks.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
export const DEFAULT_QUERIES = ['레고 추천', '레고 할인', '에어프라이어 추천', '무선청소기 추천', '가습기 추천', '추석 선물 추천', '핫딜', '쿠팡 최저가',
  '파리 여행', '오사카 여행 경비', '다낭 패키지', '청약 일정', '신혼부부 지원금', '근로장려금', '챗GPT 활용법', 'AI 이미지 만들기'];
const fail = code => { throw Object.assign(new Error(code), { code }); };

// "조회수 63,440회", "83만회", "1.9만회", "3.2천회", "조회수 없음".
export function parseViews(text) {
  const t = String(text ?? '').replace(/조회수|\s|회/g, '');
  const m = /^([\d.,]+)(천|만|억)?$/.exec(t);
  if (!m) return null;
  return Math.round(Number(m[1].replace(/,/g, '')) * ({ 천: 1e3, 만: 1e4, 억: 1e8 }[m[2]] ?? 1));
}
// "20시간 전", "7일 전", "2주 전", "3개월 전", "2년 전" (optionally "스트리밍 시간: …") → days.
export function parseAgeDays(text) {
  const m = /(\d+)\s*(분|시간|일|주|개월|년)\s*전/.exec(String(text ?? ''));
  if (!m) return null;
  return Number(m[1]) * { 분: 1 / 1440, 시간: 1 / 24, 일: 1, 주: 7, 개월: 30, 년: 365 }[m[2]];
}

export function parseSearch(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(String(html));
  if (!m) fail(/consent\.youtube|unusual traffic|captcha/i.test(html) ? 'YOUTUBE_CHALLENGE' : 'YOUTUBE_NO_DATA');
  const data = JSON.parse(m[1]), out = [];
  const walk = o => {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      out.push({ format: 'video', id: v.videoId, title: (v.title?.runs || []).map(r => r.text).join(''), views: parseViews(v.viewCountText?.simpleText),
        ageDays: parseAgeDays(v.publishedTimeText?.simpleText), length: v.lengthText?.simpleText ?? null, channel: v.ownerText?.runs?.[0]?.text ?? null });
    } else if (o.shortsLockupViewModel) {
      const v = o.shortsLockupViewModel;
      out.push({ format: 'short', id: v.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ?? null, title: v.overlayMetadata?.primaryText?.content ?? '',
        views: parseViews(v.overlayMetadata?.secondaryText?.content), ageDays: null, length: null, channel: null });
    }
    for (const k in o) if (k !== 'videoRenderer' && k !== 'shortsLockupViewModel') walk(o[k]);
  };
  walk(data);
  return out.filter(v => v.id && v.title).map(v => ({ ...v, url: v.format === 'short' ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
    viewsPerDay: v.views != null && v.ageDays ? Math.round(v.views / Math.max(1, v.ageDays)) : null }));
}

export function classify(title, ontology) {
  return ontology.hookPatterns.filter(p => p.titleMatch && new RegExp(p.titleMatch, 'i').test(title)).map(p => p.id);
}
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// Per pattern and format: how many titles use it and their median views (and views/day for long videos), against the
// titles that use no pattern.
export function summarize(videos) {
  const rows = {};
  for (const v of videos) for (const id of v.patterns.length ? v.patterns : ['(none)']) {
    const r = rows[`${id}|${v.format}`] ??= { pattern: id, format: v.format, n: 0, views: [], perDay: [] };
    r.n++; r.views.push(v.views); r.perDay.push(v.viewsPerDay);
  }
  return Object.values(rows).map(r => ({ pattern: r.pattern, format: r.format, n: r.n, medianViews: median(r.views), medianViewsPerDay: median(r.perDay) }))
    .sort((a, b) => a.format.localeCompare(b.format) || (b.medianViews ?? 0) - (a.medianViews ?? 0));
}

export async function scout({ queries = DEFAULT_QUERIES, fetchImpl = globalThis.fetch, ontology = loadHookOntology(), delayMs = 1500 } = {}) {
  const seen = new Set(), videos = [];
  for (const [i, q] of queries.entries()) {
    if (i && delayMs) await new Promise(r => setTimeout(r, delayMs));
    const res = await fetchImpl(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=ko&gl=KR`, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR' } });
    if (res.status !== 200) fail(`YOUTUBE_HTTP_${res.status}`);
    for (const [rank, v] of parseSearch(await res.text()).entries()) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      videos.push({ query: q, rank: rank + 1, ...v, patterns: classify(v.title, ontology) });
    }
  }
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), method: 'GET youtube.com/results (ytInitialData), anonymous', queries, videos, summary: summarize(videos) };
}

async function main() {
  const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  if (!out) fail('USAGE: --out=<file>');
  const queries = process.argv.find(a => a.startsWith('--queries='))?.slice(10).split(',').map(s => s.trim()).filter(Boolean);
  const r = await scout(queries ? { queries } : {});
  writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, videos: r.videos.length, shorts: r.videos.filter(v => v.format === 'short').length, summary: r.summary.slice(0, 30) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
