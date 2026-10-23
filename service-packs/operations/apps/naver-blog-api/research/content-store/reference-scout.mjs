// Writing-reference scout: which blogs and sites actually rank for our target keywords, and how big they are.
// Usage: node reference-scout.mjs [--genres=reference-genres.json] [--only=hotdeal,ai] [--collection=<collection.json>] --out=<reference-scout.json> [--top=30]
//        node reference-scout.mjs --rescore=<earlier reference-scout.json> [--enrich-tistory] [--formats] --out=<file>
//          --formats also opens each genre's top Naver posts and stores their SmartEditor layout (se-format.mjs)
//          re-apply exclusions and minSubscribers with no searches; --enrich-tistory re-reads Tistory blogs only
//
// Public, anonymous plain HTTP only (observed 2026-09-25):
//   GET https://search.naver.com/search.naver?ssc=tab.blog.all&query=<kw>   source naver_blog: Naver blog tab in rank order
//   GET https://search.daum.net/search?w=fusion&col=blog&q=<kw>             source daum_blog: Daum blog results (Tistory + Naver), card order
//   GET https://search.naver.com/search.naver?ssc=tab.web.all&query=<kw>    source naver_web: web documents (personal sites, Tistory)
//   GET https://m.blog.naver.com/api/blogs/<blogId>                          Naver: dayVisitorCount, totalVisitorCount, subscriberCount
//   GET https://blog.naver.com/NVisitorgp4Ajax.nhn?blogId=<blogId>           Naver: last 5 days of visitor counts (XML)
//   GET https://<name>.tistory.com/                                          Tistory: skin visitor widget (Today/Yesterday/Total), when the skin shows it
//   GET https://<name>.tistory.com/m/api/blog/info                            Tistory: blogFollowerCount (subscribers)
// Neither platform publishes per-post view counts; search rank is the proxy. Web sites have no public traffic figure.
// Stops at the first 403/429/CAPTCHA.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/새 창 열림/g, ' ').replace(/\s+/g, ' ').trim();
const CHALLENGE = /자동입력 방지 문자|보안문자를 입력|unusual traffic|비정상적인 접근/;
// Search, portal and reference hosts that are never writing references.
const PORTAL_HOSTS = /(^|\.)(naver\.com|naver\.net|pstatic\.net|daum\.net|kakao\.com|kakaocdn\.net|daumcdn\.net)$/;

export const SEARCH_SOURCES = {
  naver_blog: kw => `https://search.naver.com/search.naver?ssc=tab.blog.all&query=${encodeURIComponent(kw)}`,
  daum_blog: kw => `https://search.daum.net/search?w=fusion&col=blog&q=${encodeURIComponent(kw)}`,
  naver_web: kw => `https://search.naver.com/search.naver?ssc=tab.web.all&query=${encodeURIComponent(kw)}`,
};

// One id per publisher: Naver blog id, "<name>.tistory.com", "brunch.co.kr/@<id>", or the bare web host.
export function siteOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  let m;
  if (host === 'blog.naver.com' || host === 'm.blog.naver.com') {
    m = /^\/([A-Za-z0-9_-]{2,40})\/(\d{9,15})/.exec(u.pathname);
    return m ? { platform: 'naver', blogId: m[1], logNo: m[2], url: `https://blog.naver.com/${m[1]}/${m[2]}` } : null;
  }
  if (host.endsWith('.tistory.com')) {
    m = /^\/(\d+|entry\/[^/?#]+)/.exec(u.pathname);
    return m ? { platform: 'tistory', blogId: host, logNo: decodeURIComponent(m[1]), url: `https://${host}/${m[1]}` } : null;
  }
  if (host === 'brunch.co.kr') {
    m = /^\/(@[^/]+)\/(\d+)/.exec(u.pathname);
    return m ? { platform: 'brunch', blogId: `brunch.co.kr/${m[1]}`, logNo: m[2], url: `https://brunch.co.kr/${m[1]}/${m[2]}` } : null;
  }
  if (host === 'velog.io' || host === 'medium.com') { // shared hosts: one publisher per author
    m = /^\/(@[^/]+)\/?(.*)$/.exec(u.pathname);
    if (m) return { platform: 'web', blogId: `${host}/${m[1]}`, logNo: m[2] || '/', url: u.href };
  }
  if (PORTAL_HOSTS.test(host)) return null;
  return { platform: 'web', blogId: host, logNo: u.pathname + u.search, url: u.href };
}

export function parseBlogSearch(html, { top = 30 } = {}) {
  const src = String(html);
  const order = [];
  for (const m of src.matchAll(/https:\/\/blog\.naver\.com\/([A-Za-z0-9_-]{2,40})\/(\d{9,15})/g)) {
    const key = `${m[1]}/${m[2]}`;
    if (!order.includes(key)) order.push(key);
    if (order.length >= top) break;
  }
  if (!order.length && CHALLENGE.test(src)) throw fail('SEARCH_CHALLENGE');
  return order.map((key, i) => {
    const [blogId, logNo] = key.split('/');
    const url = `https://blog.naver.com/${key}`;
    // Anchors pointing at this post: the blog-name link, the title link and the snippet link (images carry no text).
    const texts = [];
    let at = -1;
    while ((at = src.indexOf(url, at + 1)) >= 0) {
      const start = src.lastIndexOf('<a', at), end = src.indexOf('</a>', at);
      if (start < 0 || end < 0 || end - start > 20000) continue;
      const t = text(src.slice(start, end));
      if (t && !texts.includes(t)) texts.push(t);
    }
    const blogName = text((new RegExp(`href="https://blog\\.naver\\.com/${blogId}"[^>]*>([\\s\\S]{0,400}?)</a>`).exec(src) || [])[1]) || null;
    // The profile block (nickname, age, "Keep에 저장") also links to the post; it is not the title.
    const candidates = texts.filter(t => t !== blogName && t.length >= 4 && !/Keep에 저장|Keep에 바로가기/.test(t));
    const title = candidates.filter(t => t.length >= 6 && t.length <= 120).sort((a, b) => a.length - b.length)[0] ?? null;
    const snippet = candidates.filter(t => t !== title).sort((a, b) => b.length - a.length)[0] ?? null;
    return { platform: 'naver', rank: i + 1, blogId, logNo, url, blogName, title, snippet: snippet ? snippet.slice(0, 300) : null };
  });
}

// Daum renders each result as <c-card>; the share widget carries the canonical link and title as JSON.
export function parseDaumBlog(html, { top = 30 } = {}) {
  const src = String(html), rows = [], seen = new Set();
  for (const card of src.split('<c-card data-docid="').slice(1)) {
    const link = /"link":\s*"([^"]+)"/.exec(card)?.[1];
    const site = link && siteOf(link);
    if (!site || site.platform === 'web' || seen.has(site.url)) continue;
    seen.add(site.url);
    let title = null;
    try { title = JSON.parse(`"${/"prefix":\s*"((?:[^"\\]|\\.)*)"/.exec(card)?.[1] ?? ''}"`) || null; } catch { title = null; }
    const frags = [...card.matchAll(/<c-frag>([\s\S]*?)<\/c-frag>/g)].map(m => text(m[1]));
    const snippet = text(/<c-contents-desc[^>]*>([\s\S]*?)<\/c-contents-desc>/.exec(card)?.[1]) || null;
    rows.push({ ...site, rank: rows.length + 1, blogName: frags[1] || null, title, snippet: snippet ? snippet.slice(0, 300) : null });
    if (rows.length >= top) break;
  }
  if (!rows.length && CHALLENGE.test(src)) throw fail('SEARCH_CHALLENGE');
  return rows;
}

// Naver web-document tab: each result has three ".link" anchors (site breadcrumb, headline, description).
export function parseNaverWeb(html, { top = 30, excludeHosts = [] } = {}) {
  const src = String(html), byUrl = new Map();
  for (const m of src.matchAll(/<a [^>]*href="(https?:\/\/[^"]+)"[^>]*data-heatmap-target="\.link"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = m[1].replace(/&amp;/g, '&');
    const site = siteOf(href);
    if (!site || hostExcluded(hostPatterns(excludeHosts), site.blogId)) continue;
    const r = byUrl.get(site.url) ?? { ...site, blogName: null, title: null, snippet: null };
    const t = text(m[2]);
    if (/headline/.test(m[2])) r.title ??= t;
    else if (!r.blogName) r.blogName = t.split(' ')[0] || null;
    else r.snippet ??= t.slice(0, 300);
    byUrl.set(site.url, r);
  }
  const rows = [...byUrl.values()].slice(0, top).map((r, i) => ({ ...r, rank: i + 1 }));
  if (!rows.length && CHALLENGE.test(src)) throw fail('SEARCH_CHALLENGE');
  return rows;
}

export function parseVisitorXml(xml) {
  return [...String(xml).matchAll(/<visitorcnt id="(\d{8})" cnt="(\d+)"/g)].map(m => ({ date: m[1], count: Number(m[2]) }));
}

// Tistory skins that show the visitor widget print Today / Yesterday / Total next to the numbers; others show nothing.
export function parseTistoryVisitors(html) {
  const src = String(html);
  const name = text(/<meta property="og:site_name" content="([^"]*)"/.exec(src)?.[1]) || text(/<title>([\s\S]*?)<\/title>/.exec(src)?.[1]) || null;
  const at = src.search(/class="[^"]*(visitor|box-visit|counter|count-total)[^"]*"|방문자/i);
  if (at < 0) return { blogName: name, today: null, yesterday: null, total: null };
  const flat = text(src.slice(at, at + 3000));
  const grab = label => { const m = new RegExp(`(?:${label})\\s*:?\\s*([\\d,]+)`, 'i').exec(flat); return m ? Number(m[1].replace(/,/g, '')) : null; };
  return { blogName: name, today: grab('Today|오늘'), yesterday: grab('Yesterday|어제'), total: grab('Total|전체') };
}

// GET https://<name>.tistory.com/m/api/blog/info → {data:{blogTitle, blogFollowerCount}} (public, observed 2026-09-25).
export function tistoryInfoFields(json) {
  const d = json?.data;
  if (!d || typeof d !== 'object') throw fail('TISTORY_INFO_SCHEMA');
  const n = Number(d.blogFollowerCount);
  return { blogName: d.blogTitle ?? d.blogName ?? null, followers: Number.isFinite(n) ? n : null };
}

async function measureTistory(fetchImpl, host) {
  const headers = { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' };
  const v = parseTistoryVisitors(await get(fetchImpl, `https://${host}/`, headers));
  let t = { blogName: null, followers: null };
  try { t = tistoryInfoFields(JSON.parse(await get(fetchImpl, `https://${host}/m/api/blog/info`, { ...headers, accept: 'application/json' }))); } catch (e) { if (e.code === 'ACCESS_BLOCKED') throw e; }
  // Yesterday is the last full day; fall back to today's partial count when the skin shows only that.
  return { platform: 'tistory', blogId: host, blogName: t.blogName ?? v.blogName, dayVisitorCount: v.yesterday ?? v.today, todayVisitorCount: v.today, totalVisitorCount: v.total,
    subscriberCount: t.followers, powerBlog: false, officialBlog: false, visitorSeries: [], visitorWidgetHidden: v.yesterday == null && v.today == null && v.total == null };
}

// Add Tistory subscriber counts to an earlier result (one request pair per Tistory blog; no searches).
export async function enrichTistory(result, { fetchImpl = globalThis.fetch, delayMs = 500 } = {}) {
  const hosts = [...new Set(result.rankings.filter(r => r.platform === 'tistory').map(r => r.blogId))];
  const byId = new Map((result.blogs || []).map(b => [b.blogId, b])), failures = [];
  for (const host of hosts) {
    try { byId.set(host, { ...byId.get(host), ...(await measureTistory(fetchImpl, host)) }); }
    catch (e) { failures.push({ step: 'tistory', blogId: host, code: e.code || 'ERROR' }); if (e.code === 'ACCESS_BLOCKED') break; }
    await sleep(delayMs);
  }
  return { ...result, blogs: [...byId.values()], failures: [...(result.failures || []), ...failures] };
}

export function blogInfoFields(json) {
  const r = json?.result;
  if (!r || typeof r.blogId !== 'string') throw fail('BLOG_INFO_SCHEMA');
  const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
  return { blogId: r.blogId, blogName: r.blogName ?? null, dayVisitorCount: num(r.dayVisitorCount), totalVisitorCount: num(r.totalVisitorCount),
    subscriberCount: num(r.subscriberCount), powerBlog: r.powerBlog === true, officialBlog: r.officialBlog === true };
}

// Score: breadth of ranking across the genre's keywords first, then position, then audience size.
// minSubscribers drops blogs whose subscriber count is known and smaller; unknown counts (web sites) stay.
export function scoreBlogs(rankings, infos, { exclude = [], minSubscribers = 0 } = {}) {
  const byBlog = new Map();
  for (const r of rankings) {
    if (exclude.includes(r.blogId)) continue;
    const subs = infos.get(r.blogId)?.subscriberCount;
    if (minSubscribers && subs != null && subs < minSubscribers) continue;
    const b = byBlog.get(r.blogId) ?? { blogId: r.blogId, blogName: r.blogName, platform: r.platform ?? 'naver', keywords: new Set(), sources: new Set(), ranks: [], posts: [] };
    b.keywords.add(r.keyword); b.ranks.push(r.rank); if (r.source) b.sources.add(r.source);
    b.blogName ??= r.blogName;
    if (!b.posts.some(p => p.logNo === r.logNo)) b.posts.push({ logNo: r.logNo, url: r.url, title: r.title, keyword: r.keyword, rank: r.rank, source: r.source ?? null });
    byBlog.set(r.blogId, b);
  }
  return [...byBlog.values()].map(b => {
    const info = infos.get(b.blogId) ?? {};
    const full = (info.visitorSeries || []).slice(0, -1).map(v => v.count); // drop today's partial count
    const avgDaily = full.length ? Math.round(full.reduce((a, c) => a + c, 0) / full.length) : info.dayVisitorCount ?? null;
    const positional = b.ranks.reduce((a, r) => a + (31 - Math.min(r, 30)), 0);
    const score = Math.round((b.keywords.size * 20 + positional + Math.log10((avgDaily ?? 0) + 1) * 8 + Math.log10((info.subscriberCount ?? 0) + 1) * 4) * 10) / 10;
    return { blogId: b.blogId, blogName: info.blogName ?? b.blogName, platform: b.platform, sources: [...b.sources], appearances: b.keywords.size, keywords: [...b.keywords],
      bestRank: Math.min(...b.ranks), avgDailyVisitors: avgDaily, totalVisitors: info.totalVisitorCount ?? null, subscribers: info.subscriberCount ?? null,
      powerBlog: info.powerBlog ?? null, officialBlog: info.officialBlog ?? null, score, topPosts: b.posts.sort((x, y) => x.rank - y.rank).slice(0, 5) };
  }).sort((a, b) => b.score - a.score);
}

// SNS references: creators we already collect, ranked by engagement in a collection.json.
export function rankSns(collection) {
  const by = new Map();
  for (const c of collection?.candidates || []) {
    if (c.sourceKind !== 'public_social_post' || !c.publisher || !c.engagement) continue;
    const e = c.engagement, s = by.get(c.publisher) ?? { publisher: c.publisher, field: c.field, sourceIds: new Set(), posts: 0, likes: 0, reposts: 0, replies: 0, best: null };
    s.posts++; s.likes += e.likes ?? 0; s.reposts += e.reposts ?? 0; s.replies += e.replies ?? 0; (c.sourceIds || []).forEach(id => s.sourceIds.add(id));
    if (!s.best || (e.likes ?? 0) > (s.best.likes ?? 0)) s.best = { url: c.urls?.[0] ?? null, likes: e.likes ?? 0, excerpt: String(c.title || '').slice(0, 120) };
    by.set(c.publisher, s);
  }
  return [...by.values()].map(s => ({ ...s, sourceIds: [...s.sourceIds], avgLikes: Math.round(s.likes / s.posts) }))
    .sort((a, b) => b.avgLikes - a.avgLikes);
}

async function get(fetchImpl, url, headers, { allowEmpty = false } = {}) {
  let r;
  try { r = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) }); } catch { throw fail('TRANSPORT', { url }); }
  if (r.status === 403 || r.status === 429) throw fail('ACCESS_BLOCKED', { httpStatus: r.status, url });
  if (allowEmpty && r.status === 204) return ''; // visitor widget hidden by the blog owner
  if (r.status !== 200) throw fail('HTTP_STATUS', { httpStatus: r.status, url });
  return r.text();
}

// excludeHosts is a regex list, or an object of lists grouped by reason.
export const hostPatterns = excludeHosts => (Array.isArray(excludeHosts) ? excludeHosts : Object.values(excludeHosts ?? {}).flat());
const hostExcluded = (patterns, host) => patterns.some(p => new RegExp(p).test(host));

// Re-apply exclusions to an earlier result without new requests; search rows and measurements are kept as observed.
export function rescore(result, { excludeBlogIds = [], excludeHosts = [], minSubscribers = 0 } = {}) {
  const patterns = hostPatterns(excludeHosts);
  const keep = r => !excludeBlogIds.includes(r.blogId) && !(r.platform === 'web' && hostExcluded(patterns, r.blogId));
  // Web ids are re-derived from the URL so id rules added later (per-author hosts) apply to old results too.
  const reid = r => { if (r.platform !== 'web') return r; const s = siteOf(r.url); return s ? { ...r, blogId: s.blogId, logNo: s.logNo } : r; };
  const rankings = result.rankings.map(reid).filter(keep);
  const infos = new Map((result.blogs || []).map(b => [b.blogId, b]));
  const genres = Object.fromEntries(Object.entries(result.genres).map(([g, v]) => [g, { ...v, blogs: scoreBlogs(rankings.filter(r => r.genre === g), infos, { exclude: excludeBlogIds, minSubscribers }) }]));
  return { ...result, genres, rankings, minSubscribers, coverage: { ...result.coverage, rankings: rankings.length, excludedRankings: result.rankings.length - rankings.length } };
}

// A genre is either a keyword list (Naver blog tab only) or { keywords, sources }.
export function normalizeGenres(genres) {
  return Object.fromEntries(Object.entries(genres).map(([g, v]) => [g, Array.isArray(v) ? { keywords: v, sources: ['naver_blog'] } : { keywords: v.keywords, sources: v.sources ?? ['naver_blog'] }]));
}

export async function scout({ genres, excludeBlogIds = [], excludeHosts = [], minSubscribers = 0, collection = null, top = 30, fetchImpl = globalThis.fetch, delayMs = 1500, now = () => new Date() }) {
  const checkedAt = now().toISOString(), rankings = [], failures = [], plan = normalizeGenres(genres);
  let blocked = false, searches = 0;
  for (const [genre, { keywords, sources }] of Object.entries(plan)) {
    for (const source of sources) {
      if (!SEARCH_SOURCES[source]) throw fail('UNKNOWN_SOURCE', { source });
      for (const keyword of keywords) {
        if (blocked) break;
        searches++;
        try {
          const html = await get(fetchImpl, SEARCH_SOURCES[source](keyword), { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' });
          const rows = source === 'naver_blog' ? parseBlogSearch(html, { top }) : source === 'daum_blog' ? parseDaumBlog(html, { top }) : parseNaverWeb(html, { top, excludeHosts });
          for (const row of rows) rankings.push({ genre, keyword, source, ...row });
        } catch (e) { failures.push({ step: 'search', source, keyword, code: e.code || 'ERROR' }); if (['ACCESS_BLOCKED', 'SEARCH_CHALLENGE'].includes(e.code)) blocked = true; }
        await sleep(delayMs);
      }
    }
  }
  const infos = new Map();
  const measurable = new Map(rankings.filter(r => r.platform === 'naver' || r.platform === 'tistory').map(r => [r.blogId, r.platform]));
  for (const [blogId, platform] of measurable) {
    if (blocked || excludeBlogIds.includes(blogId)) continue;
    try {
      if (platform === 'naver') {
        const info = blogInfoFields(JSON.parse(await get(fetchImpl, `https://m.blog.naver.com/api/blogs/${blogId}`, { 'user-agent': MOBILE_UA, referer: `https://m.blog.naver.com/${blogId}`, accept: 'application/json' })));
        info.visitorSeries = parseVisitorXml(await get(fetchImpl, `https://blog.naver.com/NVisitorgp4Ajax.nhn?blogId=${blogId}`, { 'user-agent': MOBILE_UA }, { allowEmpty: true }));
        info.visitorWidgetHidden = info.visitorSeries.length === 0;
        infos.set(blogId, { platform, ...info });
      } else {
        infos.set(blogId, await measureTistory(fetchImpl, blogId));
      }
    } catch (e) { failures.push({ step: 'blog', blogId, code: e.code || 'ERROR' }); if (e.code === 'ACCESS_BLOCKED' && platform === 'naver') blocked = true; }
    await sleep(Math.round(delayMs / 3));
  }
  const byGenre = {};
  for (const [genre, { keywords, sources }] of Object.entries(plan)) {
    byGenre[genre] = { keywords, sources, blogs: scoreBlogs(rankings.filter(r => r.genre === genre), infos, { exclude: excludeBlogIds, minSubscribers }) };
  }
  return { schemaVersion: 2, kind: 'reference-scout', checkedAt, coverage: { searches, rankings: rankings.length, blogsMeasured: infos.size, blocked, failures: failures.length },
    genres: byGenre, rankings, blogs: [...infos.values()], sns: collection ? rankSns(collection) : [], failures,
    limits: 'Search rank at checkedAt from one anonymous session; Naver and Tistory publish no per-post view counts. Visitor widgets may be hidden (Naver) or absent from the skin (Tistory). Web sites have no public traffic figure, so they score on search presence only.' };
}

// --formats (2026-09-27): open the top post of each genre's leading Naver blogs and keep its SmartEditor layout
// (se-format.mjs) on topPosts[0].format, plus a per-genre formatSummary. Before this the scout never read post bodies.
export async function addFormats(result, { fetchImpl = globalThis.fetch, perGenre = 10, delayMs = 1500 } = {}) {
  const { analyzePost, summarizeFormats } = await import('./se-format.mjs');
  const cache = new Map();
  for (const g of Object.values(result.genres ?? {})) {
    const picks = (g.blogs ?? []).filter(b => b.platform === 'naver' && b.topPosts?.length).slice(0, perGenre);
    for (const b of picks) {
      const p = b.topPosts[0], key = `${b.blogId}/${p.logNo}`;
      if (!cache.has(key)) {
        let html;
        try { html = await get(fetchImpl, `https://m.blog.naver.com/PostView.naver?blogId=${b.blogId}&logNo=${p.logNo}`, { 'user-agent': MOBILE_UA, referer: `https://m.blog.naver.com/${b.blogId}` }); }
        catch (e) { if (/ACCESS_BLOCKED|CHALLENGE/.test(e.code ?? '')) throw e; html = null; }
        cache.set(key, html && html.includes('se-main-container') ? { ...analyzePost(html), measuredAt: new Date().toISOString() } : null);
        await sleep(delayMs);
      }
      p.format = cache.get(key);
    }
    g.formatSummary = summarizeFormats(picks.map(b => b.topPosts[0].format));
  }
  result.formatsMeasuredAt = new Date().toISOString();
  return result;
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const cfg = JSON.parse(readFileSync(arg('genres') || new URL('./reference-genres.json', import.meta.url), 'utf8'));
  const only = arg('only')?.split(',').filter(Boolean);
  const genres = only ? Object.fromEntries(Object.entries(cfg.genres).filter(([g]) => only.includes(g))) : cfg.genres;
  if (!Object.keys(genres).length) throw fail('NO_GENRES');
  const out = arg('out'); if (!out) throw fail('OUT_REQUIRED');
  const opts = { excludeBlogIds: cfg.excludeBlogIds || [], excludeHosts: cfg.excludeHosts || [], minSubscribers: cfg.minSubscribers || 0 };
  if (arg('rescore')) {
    let earlier = JSON.parse(readFileSync(arg('rescore'), 'utf8'));
    if (process.argv.includes('--enrich-tistory')) earlier = await enrichTistory(earlier);
    let result = rescore(earlier, opts);
    if (process.argv.includes('--formats')) result = await addFormats(result);
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ out, ...result.coverage }));
    return;
  }
  const collection = arg('collection') ? JSON.parse(readFileSync(arg('collection'), 'utf8')) : null;
  let result = await scout({ genres, ...opts, collection, top: Number(arg('top') || 30) });
  if (process.argv.includes('--formats')) result = await addFormats(result);
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ out, ...result.coverage, top: Object.fromEntries(Object.entries(result.genres).map(([g, v]) => [g, v.blogs.slice(0, 5).map(b => `${b.blogId}[${b.platform}](${b.appearances}kw,${b.avgDailyVisitors ?? '?'}/day)`)])) }));
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
