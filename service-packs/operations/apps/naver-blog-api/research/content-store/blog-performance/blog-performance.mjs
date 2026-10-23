// Our own blog's "what worked" loop (owner 2026-10-05 "진행해", after @onewaygoal's method: Creator Advisor 조회수 순위
// 1~20위 → 제목 스타일·키워드·후킹 문구·글 스타일의 교집합 → 그 조합으로 다음 글).
// collect: per-post views (cv-ranks) + channel search keywords (referrer-query-rank) from Creator Advisor (read-only),
// tags every post (title hook types, title shape, genre from its brief when we published it through a run), and
// compares the top posts with the rest. Writes latest.json, read by the drafting prompt as a soft hint, never as fact.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX = 'C:/Users/User/Documents/Codex';
const MIN_N = 3; // a feature seen on fewer posts is reported as insufficient, not as a winner

// Title hook types (hook-ontology / marketing-copy names) and the onewaygoal title kinds (비교형·손실회피형·숫자형).
export const TITLE_FEATURES = {
  number: t => /\d/.test(t),
  price: t => /\d[\d,]*\s?원/.test(t),
  comparison: t => /\bvs\b|비교|보다|차이|나란히/i.test(t),
  loss_aversion: t => /놓치|손해|마감|끝나|비싸|아끼|절약|모르면|전에/.test(t),
  question: t => /\?|까요|을까|ㄹ까|일까/.test(t),
  experience: t => /저는|해\s?봤|봤어요|만들어|따라가|후기|모았/.test(t),
  list: t => /\d+\s?(개|가지|곳|단계|건)(?![가-힣])|TOP\s?\d/i.test(t),
  segment_split: t => /[｜|]/.test(t),
  how_to: t => /방법|참여법|하는 법|가이드|동선|일정/.test(t),
  official_data: t => /식약처|정부|공식|발표|검사 결과|공고/.test(t),
};
export function titleFeatures(title) {
  const t = String(title ?? '');
  return Object.entries(TITLE_FEATURES).filter(([, f]) => f(t)).map(([k]) => k);
}
// Body format (서식) of a public post, from se-format.mjs analyzePost (owner 2026-10-05 "그들이 많이쓰는 서식 등도 참조할수있게해").
export function formatFeatures(f) {
  if (!f) return [];
  const out = [];
  if (f.counts?.table) out.push('format:table');
  if (f.counts?.quotation) out.push('format:quotation_heading');
  if (f.quotationEmojiLead) out.push('format:emoji_heading');
  if (f.centered >= 0.5) out.push('format:centered');
  if (f.avgLineChars && f.avgLineChars <= 25) out.push('format:short_lines');
  if (f.images >= 8) out.push('format:images_8plus'); else if (f.images <= 2) out.push('format:images_0to2');
  if (f.imageCaptions) out.push('format:image_captions');
  if (f.boldRuns >= 5) out.push('format:bold_emphasis');
  if ((f.accentColors?.length ?? 0) + (f.highlightColors?.length ?? 0) > 0) out.push('format:color_emphasis');
  if (f.nativeListItems) out.push('format:native_list');
  if (Object.keys(f.oglinkStyles ?? {}).length) out.push('format:link_card');
  if (Object.keys(f.dividerStyles ?? {}).length) out.push('format:divider');
  for (const k of Object.keys(f.rich ?? {})) out.push(`format:${k}`);
  if (f.lines >= 120) out.push('format:long_post'); else if (f.lines && f.lines < 40) out.push('format:short_post');
  return out;
}
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function postFormat(blogId, logNo, fetchImpl = globalThis.fetch) {
  const { analyzePost } = await import(pathToFileURL(path.join(HERE, '../se-format.mjs')).href);
  const res = await fetchImpl(`https://m.blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}`,
    { headers: { 'user-agent': MOBILE_UA, 'accept-language': 'ko-KR', referer: `https://m.blog.naver.com/${blogId}` } });
  const html = await res.text();
  return res.ok && html.includes('se-main-container') ? analyzePost(html) : null;
}

export function titleWords(title) {
  return [...new Set(String(title ?? '').replace(/[^가-힣A-Za-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !/^\d[\d,]*(원|개|kg|g|ml|L)$/i.test(w)))];
}

// logNo → { genre, field, briefDir } from our publication runs (final-verification.json next to the brief).
export function briefIndex(root = CODEX) {
  const index = new Map();
  if (!existsSync(root)) return index;
  for (const day of readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    const auto = path.join(root, day, 'auto-briefs');
    if (!existsSync(auto)) continue;
    for (const name of readdirSync(auto)) {
      const dir = path.join(auto, name);
      for (const run of ['run', 'run-v2']) {
        const fv = path.join(dir, run, 'final-verification.json');
        if (!existsSync(fv)) continue;
        try {
          const v = JSON.parse(readFileSync(fv, 'utf8'));
          if (v.status !== 'published_verified' || !v.logNo) continue;
          const b = JSON.parse(readFileSync(path.join(dir, 'article-brief.json'), 'utf8'));
          index.set(String(v.logNo), { genre: b.genre ?? null, field: b.field ?? null, briefDir: dir });
        } catch { /* a malformed or partial run is skipped */ }
      }
    }
  }
  return index;
}

const logNoOf = url => /\/(\d{9,})(?:\b|$)/.exec(String(url ?? ''))?.[1] ?? null;

// Pure: rows [{title, views, logNo}] + briefs → feature table (top vs rest) and the leading combination.
export function analyze(rows, briefs = new Map(), { topN = 20 } = {}) {
  const posts = rows.map(r => {
    const brief = briefs.get(String(r.logNo)) ?? null;
    const features = [...titleFeatures(r.title), ...formatFeatures(r.format)];
    if (brief?.genre) features.push(`genre:${brief.genre}`);
    if (brief?.field) features.push(`field:${brief.field}`);
    return { ...r, features, words: titleWords(r.title), briefDir: brief?.briefDir ?? null };
  }).sort((a, b) => b.views - a.views);
  const top = posts.slice(0, Math.min(topN, Math.ceil(posts.length / 2)));
  const rest = posts.slice(top.length);
  const mean = list => list.length ? list.reduce((s, p) => s + p.views, 0) / list.length : 0;
  const allFeatures = [...new Set(posts.flatMap(p => p.features))];
  const features = allFeatures.map(f => {
    const withF = posts.filter(p => p.features.includes(f)), without = posts.filter(p => !p.features.includes(f));
    const share = list => list.length ? list.filter(p => p.features.includes(f)).length / list.length : 0;
    return {
      feature: f, posts: withF.length, meanViewsWith: +mean(withF).toFixed(1), meanViewsWithout: +mean(without).toFixed(1),
      lift: mean(without) ? +(mean(withF) / mean(without)).toFixed(2) : null, topShare: +share(top).toFixed(2), restShare: +share(rest).toFixed(2),
      sufficient: withF.length >= MIN_N && without.length >= MIN_N,
    };
  }).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
  const wordCount = list => list.flatMap(p => p.words).reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
  const topWords = wordCount(top), restWords = wordCount(rest);
  const words = [...topWords].filter(([, n]) => n >= 2).map(([w, n]) => ({ word: w, top: n, rest: restWords.get(w) ?? 0 }))
    .sort((a, b) => b.top - a.top || a.rest - b.rest).slice(0, 15);
  const winners = features.filter(f => f.sufficient && f.lift >= 1.3 && f.topShare > f.restShare).map(f => f.feature);
  const losers = features.filter(f => f.sufficient && f.lift !== null && f.lift <= 0.7 && f.topShare < f.restShare).map(f => f.feature);
  return {
    postCount: posts.length, totalViews: posts.reduce((s, p) => s + p.views, 0), topCount: top.length,
    winners, losers, features, topWords: words,
    top: top.map(p => ({ title: p.title, views: p.views, logNo: p.logNo, features: p.features })),
    caution: posts.length < 30 ? 'small_sample: fewer than 30 posts; use as a hint, not a rule' : null,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// "그들" = popular bloggers in our genres: reference-scout ranks Naver blog search results (subscriber floor from
// reference-genres.json) and reads the top post of each leading blog with se-format.mjs; we keep the per-genre
// summary plus how often each format feature appears, so drafting can match what readers of that genre are used to.
export async function peers({ genres, perGenre = 6, keywordsPerGenre = 4, fetchImpl = globalThis.fetch, delayMs = 1500 } = {}) {
  const { scout, addFormats } = await import(pathToFileURL(path.join(HERE, '../reference-scout.mjs')).href);
  const cfg = JSON.parse(readFileSync(path.join(HERE, '../reference-genres.json'), 'utf8'));
  const pick = Object.fromEntries(Object.entries(cfg.genres).filter(([g]) => !genres || genres.includes(g)).map(([g, v]) =>
    [g, { keywords: (Array.isArray(v) ? v : v.keywords).slice(0, keywordsPerGenre), sources: ['naver_blog'] }]));
  let result = await scout({ genres: pick, excludeBlogIds: cfg.excludeBlogIds ?? [], excludeHosts: [], minSubscribers: cfg.minSubscribers ?? 0, fetchImpl, delayMs });
  result = await addFormats(result, { fetchImpl, perGenre, delayMs });
  const byGenre = {};
  for (const [g, v] of Object.entries(result.genres)) {
    const posts = (v.blogs ?? []).filter(b => b.platform === 'naver' && b.topPosts?.[0]?.format).slice(0, perGenre);
    const share = posts.flatMap(b => formatFeatures(b.topPosts[0].format)).reduce((m, f) => m.set(f, (m.get(f) ?? 0) + 1), new Map());
    byGenre[g] = {
      keywords: pick[g].keywords, blogs: posts.map(b => ({ blogId: b.blogId, subscribers: b.subscribers ?? null, post: b.topPosts[0].url ?? b.topPosts[0].logNo })),
      summary: v.formatSummary ?? null,
      common: [...share].map(([feature, n]) => ({ feature, posts: n, share: +(n / posts.length).toFixed(2) }))
        .filter(x => x.share >= 0.5).sort((a, b) => b.share - a.share),
    };
  }
  return { checkedAt: new Date().toISOString(), source: 'reference-scout naver_blog search + se-format (public pages)', coverage: result.coverage, genres: byGenre };
}

export async function collect({ interval = 'month', date, keywordDate, client, formats = true, fetchImpl = globalThis.fetch, delayMs = 1500 } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw Object.assign(new Error('BLOG_PERFORMANCE_DATE'), { code: 'BLOG_PERFORMANCE_DATE' });
  const ca = client ?? await (await import(pathToFileURL(path.join(HERE, '../creator-advisor/creator-advisor.mjs')).href)).loadClient();
  const channelId = 'aicandoanything';
  const ranks = await ca.get('contentRanks', { channelId, contentType: 'text-and-moment', interval, date, limit: 100 });
  const rows = (ranks.data ?? []).map(r => ({ title: r.title, views: Number(r.metricValue) || 0, logNo: logNoOf(r.contentId), createdAt: r.createdAt ?? null }));
  if (formats) {
    for (const row of rows) {
      if (!row.logNo) continue;
      try { row.format = await postFormat(channelId, row.logNo, fetchImpl); } catch { row.format = null; }
      await sleep(delayMs);
    }
  }
  let keywords = null;
  try {
    const q = await ca.get('referrerQueryRank', { channelId, interval: 'day', date: keywordDate ?? date, limit: 20 });
    keywords = q.data ?? null;
  } catch (error) { keywords = { error: error.code ?? 'CREATOR_ADVISOR_FAILED', httpStatus: error.httpStatus ?? null }; }
  return { checkedAt: new Date().toISOString(), source: 'creator-advisor cv-ranks + referrer-query-rank (owner channel, read-only)',
    interval, date, more: ranks.more ?? null, rows, searchKeywords: keywords, analysis: analyze(rows, briefIndex()) };
}

async function main() {
  const [cmd = 'collect', ...rest] = process.argv.slice(2);
  const args = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; }));
  if (cmd === 'peers') {
    const r = await peers({ genres: args.genres?.split(',').filter(Boolean), perGenre: Number(args.perGenre) || 6 });
    writeFileSync(path.join(HERE, 'peer-formats.json'), JSON.stringify(r, null, 2));
    console.log(JSON.stringify({ coverage: r.coverage, genres: Object.fromEntries(Object.entries(r.genres).map(([g, v]) => [g, { blogs: v.blogs.length, common: v.common.map(c => c.feature) }])) }));
    return;
  }
  if (cmd !== 'collect') throw Object.assign(new Error('BLOG_PERFORMANCE_COMMAND'), { code: 'BLOG_PERFORMANCE_COMMAND' });
  const result = await collect({ ...args, formats: args.formats !== 'false' });
  mkdirSync(path.join(HERE, 'snapshots'), { recursive: true });
  writeFileSync(path.join(HERE, 'snapshots', `${result.interval}-${result.date}.json`), JSON.stringify(result, null, 2));
  writeFileSync(path.join(HERE, 'latest.json'), JSON.stringify(result, null, 2));
  const a = result.analysis;
  console.log(JSON.stringify({ posts: a.postCount, views: a.totalViews, winners: a.winners, losers: a.losers, caution: a.caution,
    topWords: a.topWords.slice(0, 8).map(w => w.word), keywordRows: Array.isArray(result.searchKeywords) ? result.searchKeywords.length : result.searchKeywords }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code ?? 'BLOG_PERFORMANCE_FAILED', httpStatus: e.httpStatus ?? null })); process.exitCode = 1; });
}
