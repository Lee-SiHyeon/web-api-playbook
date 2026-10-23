// Follow candidates per platform (owner 2026-09-28: "각 계정당 100명은 팔로잉 확보해줘", chose A = one-time reads through
// our own logged-in sessions where the public web shows nothing). Keywords come from the brand's fields; every row keeps the
// source it was read from. Reads only — following is done slowly by affiliate-api-hub/scripts/follow-queue.mjs.
//   youtube   public search, channel filter (sp=EgIQAg%3D%3D) → channelRenderer: title, @handle, 구독자 N
//   instagram our session: /api/v1/web/search/topsearch/?query= → users (username, full_name, follower hint, verified)
//   threads   the Instagram candidates' usernames (Threads profiles share the Instagram username)
// Usage: node follow-targets.mjs --platforms=youtube,instagram --out=<file> [--keywords=a,b] [--per-keyword=15]
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseCount } from './sns-references.mjs';

export const KEYWORDS = ['살림템', '살림꿀팁', '생활꿀팁', '핫딜', '최저가', '쿠팡추천템', '다이소꿀템', '앱테크', '재테크', '짠테크', '여행특가', '국내여행', '해외여행 꿀팁',
  '맛집', 'AI 활용', 'ChatGPT 활용', '부업', '자취꿀팁', '육아템', '주방템',
  '맛집 추천', '카페 추천', '편의점 신상', '올리브영 추천', '생활비 절약', '가계부', '정부지원금', '청약', '절약 꿀팁', '가성비템', '신박한 아이템', '살림 브이로그', '주부 꿀팁', '인테리어 꿀팁', '캠핑용품', '차박', '제주 여행', '부산 여행', '일본 여행', '호캉스', '항공권 특가', '여행 브이로그', '경제 공부', '주식 초보', 'ETF', '미국주식', '코인', '돈 모으기', '짠순이', '재테크 브이로그', 'AI 툴', '생성형 AI', 'AI 부업', '엑셀 꿀팁', '노션', '스마트폰 꿀팁', '아이폰 꿀팁', '갤럭시 꿀팁', 'IT 리뷰', '쿠팡 추천'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jsonAfter = (html, name) => { const i = html.indexOf(`var ${name} = `); if (i < 0) return null; const s = i + name.length + 7; try { return JSON.parse(html.slice(s, html.indexOf(';</script>', s))); } catch { return null; } };
const text = t => t?.simpleText ?? (t?.runs ?? []).map(r => r.text).join('') ?? '';

export function parseYoutubeChannels(data, keyword) {
  const out = [];
  const walk = o => { if (!o || typeof o !== 'object') return; const c = o.channelRenderer;
    if (c?.channelId) {
      const handle = (text(c.subscriberCountText).startsWith('@') ? text(c.subscriberCountText) : null) ?? c.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl?.replace(/^\//, '') ?? null;
      const subsText = [text(c.videoCountText), text(c.subscriberCountText)].find(s => /구독자|subscriber/i.test(s)) ?? null;
      out.push({ platform: 'youtube', channelId: c.channelId, handle, name: text(c.title), followers: subsText ? parseCount(subsText.replace(/구독자/, '')) : null,
        profileUrl: `https://www.youtube.com/${handle ?? `channel/${c.channelId}`}`, keyword, source: `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIQAg%253D%253D` });
    }
    for (const v of Object.values(o)) walk(v); };
  walk(data);
  return out;
}

async function youtube(keywords, perKeyword, fetchImpl = globalThis.fetch) {
  const rows = [];
  for (const k of keywords) {
    const r = await fetchImpl(`https://www.youtube.com/results?search_query=${encodeURIComponent(k)}&sp=EgIQAg%253D%253D&hl=ko&gl=KR`, { headers: { 'user-agent': UA, 'accept-language': 'ko' } });
    const d = jsonAfter(await r.text(), 'ytInitialData');
    rows.push(...parseYoutubeChannels(d, k).slice(0, perKeyword));
    await sleep(1200);
  }
  return rows;
}

// Instagram top search through the owner's session (read). Stops at the first non-200.
async function instagram(keywords, perKeyword) {
  const { loadMetaSession } = await import(pathToFileURL('C:/Users/User/Documents/GitHub/affiliate-content-operations/apps/naver-blog-api/scripts/meta-auth-session.mjs').href);
  const s = await loadMetaSession('instagram');
  const h = Object.fromEntries(Object.entries(s.ownerRequest?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const headers = { cookie: s.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'user-agent': h['user-agent'] ?? UA, 'x-ig-app-id': h['x-ig-app-id'], 'x-asbd-id': h['x-asbd-id'] ?? '359341',
    'x-csrftoken': s.cookies.find(c => c.name === 'csrftoken')?.value, 'x-requested-with': 'XMLHttpRequest', ...(h['x-ig-www-claim'] ? { 'x-ig-www-claim': h['x-ig-www-claim'] } : {}), ...(h['x-web-session-id'] ? { 'x-web-session-id': h['x-web-session-id'] } : {}), referer: 'https://www.instagram.com/', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
  const rows = [];
  for (const k of keywords) {
    const r = await fetch(`https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(k)}&include_reel=false`, { headers });
    if (r.status !== 200) { rows.push({ platform: 'instagram', error: `HTTP_${r.status}`, keyword: k }); break; }
    const j = await r.json();
    for (const u of (j.users ?? []).map(x => x.user).filter(Boolean).slice(0, perKeyword)) {
      rows.push({ platform: 'instagram', handle: u.username, name: u.full_name ?? null, verified: Boolean(u.is_verified), private: Boolean(u.is_private),
        followersHint: u.search_social_context ?? null, profileUrl: `https://www.instagram.com/${u.username}/`, keyword: k, source: 'instagram web topsearch (owner session, one-time)' });
    }
    await sleep(2500 + Math.floor(Math.random() * 2000));
  }
  return rows;
}

// A creator's other accounts from their public YouTube channel page (header links and any profile URLs on the page):
// the Instagram 401 on search made this the reliable path to real Instagram/Threads/X/TikTok/Naver blog handles.
export function socialLinks(html) {
  const t = String(html).replace(/\\u0026/g, '&');
  const urls = [...t.matchAll(/https?:\/\/(?:www\.)?youtube\.com\/redirect\?[^"\\]+/g)].map(m => { const q = /[?&]q=([^&"]+)/.exec(m[0]); try { return q ? decodeURIComponent(q[1]) : null; } catch { return null; } }).filter(Boolean);
  const all = [...urls, ...[...t.matchAll(/https?:\/\/(?:www\.)?(?:instagram\.com|threads\.(?:net|com)|x\.com|twitter\.com|tiktok\.com|blog\.naver\.com)\/[@A-Za-z0-9_.\-]+/g)].map(m => m[0])];
  const out = {};
  for (const u of all) {
    let m;
    if ((m = /instagram\.com\/([A-Za-z0-9_.]+)/i.exec(u)) && !/^(p|reel|explore|accounts)$/i.test(m[1])) out.instagram ??= m[1].toLowerCase();
    else if ((m = /threads\.(?:net|com)\/@([A-Za-z0-9_.]+)/i.exec(u))) out.threads ??= m[1].toLowerCase();
    else if ((m = /(?:x|twitter)\.com\/([A-Za-z0-9_]{2,15})(?:[/?]|$)/i.exec(u)) && !/^(home|intent|share|i)$/i.test(m[1])) out.x ??= m[1].toLowerCase();
    else if ((m = /tiktok\.com\/@([A-Za-z0-9_.]+)/i.exec(u))) out.tiktok ??= m[1].toLowerCase();
    else if ((m = /blog\.naver\.com\/([A-Za-z0-9_-]+)/i.exec(u)) && !/^(PostView|PostList)/i.test(m[1])) out.naver_blog ??= m[1].toLowerCase();
  }
  return out;
}

async function socialsFromYoutube(channels, fetchImpl = globalThis.fetch) {
  const rows = [];
  for (const c of channels) {
    try {
      const r = await fetchImpl(`https://www.youtube.com/channel/${c.channelId}?hl=ko`, { headers: { 'user-agent': UA, 'accept-language': 'ko' } });
      if (r.status === 429) break;
      const html = await r.text();
      // The header shows one link; the channel's "about" panel (browse continuation → aboutChannelViewModel) lists all.
      let about = '';
      try {
        const i = html.indexOf('var ytInitialData = ');
        const d = JSON.parse(html.slice(i + 20, html.indexOf(';</script>', i)));
        let token = null;
        const walk = o => { if (token || !o || typeof o !== 'object') return; if (o.continuationCommand?.token) token = o.continuationCommand.token; for (const v of Object.values(o)) walk(v); };
        walk(d);
        const ver = (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1];
        if (token && ver) {
          const b = await fetchImpl('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA },
            body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'ko', gl: 'KR' } }, continuation: token }) });
          const j = await b.text();
          if (/aboutChannelViewModel/.test(j)) about = [...j.matchAll(/"content":"([^"]*(?:instagram\.com|threads\.(?:net|com)|x\.com|twitter\.com|tiktok\.com|blog\.naver\.com)[^"]*)"/g)].map(m => `https://${m[1].replace(/^https?:\/\//, '')}`).join('\n');
        }
      } catch { /* header links only */ }
      const s = socialLinks(`${html}\n${about}`);
      for (const [platform, handle] of Object.entries(s)) rows.push({ platform, handle, name: c.name, viaYoutube: c.handle, youtubeFollowers: c.followers, keyword: c.keyword,
        profileUrl: { instagram: `https://www.instagram.com/${handle}/`, threads: `https://www.threads.com/@${handle}`, x: `https://x.com/${handle}`, tiktok: `https://www.tiktok.com/@${handle}`, naver_blog: `https://blog.naver.com/${handle}` }[platform],
        source: `https://www.youtube.com/channel/${c.channelId} (creator's own channel link)` });
    } catch { /* next channel */ }
    await sleep(1200);
  }
  return rows;
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const platforms = (arg('platforms') ?? 'youtube').split(',');
  const keywords = arg('keywords')?.split(',') ?? KEYWORDS;
  const per = Number(arg('per-keyword') ?? 15);
  const result = { checkedAt: new Date().toISOString(), keywords };
  if (platforms.includes('youtube')) result.youtube = await youtube(keywords, per);
  if (platforms.includes('socials')) {
    const base = result.youtube ?? JSON.parse((await import('node:fs')).readFileSync(arg('from'), 'utf8')).youtube;
    const uniq = [...new Map(base.filter(c => c.channelId && (c.followers ?? 0) >= 1000).map(c => [c.channelId, c])).values()];
    result.socials = await socialsFromYoutube(uniq);
  }
  if (platforms.includes('instagram') || platforms.includes('threads')) result.instagram = await instagram(keywords, per);
  if (platforms.includes('threads')) result.threads = (result.instagram ?? []).filter(r => r.handle && !r.private).map(r => ({ ...r, platform: 'threads', profileUrl: `https://www.threads.com/@${r.handle}`, source: `${r.source}; same username on Threads` }));
  writeFileSync(arg('out'), JSON.stringify(result, null, 1) + '\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]))));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
