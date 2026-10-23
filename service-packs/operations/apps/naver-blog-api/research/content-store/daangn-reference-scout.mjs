// 당근 카페 writing references: the most-viewed posts in the cafes that match each of our 당근 boards, and how they are written.
// Usage: node daangn-reference-scout.mjs [--genres=daangn-reference-genres.json] [--only=travel,hotdeal] --out=<dir>
//        node daangn-reference-scout.mjs --hot [--days=7] [--top=10] --out=<dir>     most-viewed recent posts across every category
//
// Public, anonymous plain HTTP only (observed 2026-09-26). Each page embeds its data in the Next.js flight payload
// (self.__next_f.push([1,"..."])):
//   GET https://cafe.daangn.com/categories/<category>   {items:[{id,name,description,location,memberCount:"11,160",category,slug}], pagination}
//   GET https://cafe.daangn.com/<cafeSlug>              {items:[{id,title,createdAt,boardName,viewCount,likeCount,commentCount,href,isPinned,publishType}]}
//   GET https://cafe.daangn.com/<cafeSlug>/posts/<slug> {cafeSlug,postId,title,blocks:[{type:paragraph|image|video|...}],viewCount,memberCount,...}
// 당근 has no sorted "most viewed" list; the cafe home shows its recent posts with view counts, so ranking is ours.
// Only titles, counts, block shapes and the first lines are kept: no author names, no comments.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const BASE = 'https://cafe.daangn.com';
const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const ALL_CATEGORIES = ['game', 'culture-art', 'travel', 'sports', 'pet', 'fashion-beauty', 'health-fitness', 'parenting', 'it-mobile', 'education',
  'economy-finance', 'food-beverage', 'life-talk', 'neighborhood', 'real-estate', 'outdoor', 'collection-goods', 'car', 'interior', 'plant-gardening',
  'farming-rural', 'career', 'humor-issue', 'entertainment', 'movie-animation'];

// The flight payload as one string: every self.__next_f.push([1,"..."]) chunk, JSON-decoded and joined.
export function flightText(html) {
  return [...String(html).matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(m => JSON.parse(m[1])).join('');
}

// The JSON value (object or array) that starts at text[start].
export function jsonAt(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw fail('DAANGN_PAYLOAD_TRUNCATED');
}

// Every "items":[...] array whose first entry has the field.
export function itemArrays(flight, field) {
  const out = [];
  for (const m of flight.matchAll(/"items":\[/g)) {
    try { const arr = jsonAt(flight, m.index + 8); if (arr[0] && field in arr[0]) out.push(arr); } catch { /* not JSON at this spot */ }
  }
  return out;
}

const count = v => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d]/g, '')) || 0);

export function parseCategoryCafes(html) {
  const seen = new Set();
  return itemArrays(flightText(html), 'memberCount').flat()
    .filter(c => c?.slug && !seen.has(c.slug) && seen.add(c.slug))
    .map(c => ({ slug: c.slug, name: String(c.name ?? '').trim(), description: String(c.description ?? '').slice(0, 300), location: c.location ?? null, category: c.category ?? null, members: count(c.memberCount) }));
}

export function parseCafePosts(html, cafeSlug) {
  const seen = new Set();
  return itemArrays(flightText(html), 'viewCount').flat()
    .filter(p => p?.href && !seen.has(p.href) && seen.add(p.href))
    .map(p => ({ cafe: cafeSlug, postId: p.id, title: String(p.title ?? '').trim(), board: p.boardName ?? null, createdAt: p.createdAt ?? null,
      views: count(p.viewCount), likes: count(p.likeCount), comments: count(p.commentCount), pinned: p.isPinned === true,
      publishType: p.publishType ?? null, url: BASE + p.href.split('/').map((s, i) => (i < 3 ? s : encodeURIComponent(s))).join('/') }));
}

// Long strings (a comment over ~1 KB) travel as text rows "66:T75c,<utf-8 bytes>" and appear in the JSON as "$66" (observed 2026-09-29).
export function textRows(flight) {
  const rows = new Map();
  for (const m of flight.matchAll(/(?:^|\n)([0-9a-f]+):T([0-9a-f]+),/g)) {
    const bytes = parseInt(m[2], 16), from = m.index + m[0].length;
    rows.set(m[1], Buffer.from(flight.slice(from, from + bytes), 'utf8').subarray(0, bytes).toString('utf8'));
  }
  return rows;
}
const resolveRefs = (v, rows) => {
  if (typeof v === 'string') { const m = /^\$([0-9a-f]+)$/.exec(v); return m && rows.has(m[1]) ? rows.get(m[1]) : v; }
  if (Array.isArray(v)) return v.map(x => resolveRefs(x, rows));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, rows)]));
  return v;
};

export function parsePost(html) {
  const flight = flightText(html);
  const i = flight.indexOf('"blocks":');
  if (i < 0) throw fail('DAANGN_POST_SCHEMA');
  // The post object encloses "blocks" and opens with its cafeSlug key (observed 2026-09-26).
  const s = flight.lastIndexOf('{"cafeSlug":', i);
  if (s < 0) throw fail('DAANGN_POST_SCHEMA');
  const post = jsonAt(flight, s);
  if (!Array.isArray(post.blocks)) throw fail('DAANGN_POST_SCHEMA');
  return resolveRefs(post, textRows(flight));
}

const EMOJI = /\p{Extended_Pictographic}/u;
const LIST_LINE = /^\s*(?:[-•·▪▫◦✔✅☑️*]|\d+[.)]|[①-⑳]|\p{Extended_Pictographic})/u;
const median = xs => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const share = (xs, f) => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 100) : null);
const mediaCount = b => (Array.isArray(b.images) ? b.images.length : Array.isArray(b.items) ? b.items.length : 1);

// Shape of one post: how long its paragraphs are, where media sits, links, emoji, lists and how it ends.
export function postFeatures(post) {
  const blocks = post.blocks ?? [];
  const paras = blocks.filter(b => b.type === 'paragraph');
  const lines = paras.flatMap(b => String(b.text ?? '').split('\n')).map(l => l.trim()).filter(Boolean);
  const text = lines.join('\n');
  const title = String(post.title ?? '').trim();
  const last = lines.at(-1) ?? '';
  return {
    blocks: blocks.length,
    paragraphs: paras.length,
    emptyParagraphs: paras.filter(b => !String(b.text ?? '').trim()).length,
    lines: lines.length,
    linesPerParagraph: paras.length ? +(lines.length / paras.length).toFixed(2) : 0,
    charsPerLine: median(lines.map(l => [...l].length)),
    chars: [...text].length,
    images: blocks.filter(b => b.type === 'image').reduce((n, b) => n + mediaCount(b), 0),
    videos: blocks.filter(b => b.type === 'video').length,
    mediaFirst: ['image', 'video'].includes(blocks[0]?.type),
    otherBlocks: [...new Set(blocks.map(b => b.type).filter(t => !['paragraph', 'image', 'video'].includes(t)))],
    urls: (text.match(/https?:\/\/\S+/g) || []).length,
    hashtags: (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).length,
    emojiLineShare: share(lines, l => EMOJI.test(l)),
    listLines: lines.filter(l => LIST_LINE.test(l)).length,
    boldSegments: paras.flatMap(b => b.segments ?? []).filter(s => s.bold || s.style?.bold || s.attributes?.bold).length,
    endsWithQuestion: /\?|까요|나요|세요\??$|인가요|있나요|어떠세요/.test(last),
    titleChars: [...title].length,
    titleEmoji: EMOJI.test(title),
    titleQuestion: /\?|까요|나요|인가요|어떡|어쩌/.test(title),
    titleNumber: /\d/.test(title),
    firstLines: lines.slice(0, 3).map(l => [...l].slice(0, 60).join('')),
  };
}

// Question and venting posts draw the biggest numbers; info posts are the format we write. Tag both.
export function postKind(title, features) {
  if (features && (features.images + features.videos > 0 || features.listLines >= 2) && features.lines >= 8) return 'info';
  if (/추천|정보|꿀팁|총정리|정리|방법|가격|특가|할인|후기|비교|공유|신청|일정|혜택|\d+\s*(만\s*)?원/.test(title)) return 'info';
  return 'talk';
}

const excluded = (p, excludeBoards) => p.pinned || !p.title || (p.publishType && p.publishType !== 'public')
  || excludeBoards.some(w => String(p.board ?? '').includes(w) || p.title.includes(w));

export function rankPosts(posts, { now = new Date(), days = null, excludeBoards = [] } = {}) {
  const t = now.getTime();
  return posts.filter(p => !excluded(p, excludeBoards))
    .filter(p => !days || (p.createdAt && t - Date.parse(p.createdAt) <= days * 864e5))
    .map(p => ({ ...p, ageDays: p.createdAt ? +Math.max((t - Date.parse(p.createdAt)) / 864e5, 0).toFixed(1) : null }))
    .map(p => ({ ...p, viewsPerDay: Math.round(p.views / Math.max(p.ageDays ?? 1, 1)) }))
    .sort((a, b) => b.views - a.views || b.comments - a.comments);
}

export function pickCafes(cafes, { cafeKeywords = [], minMembers = 0, limit = 8 } = {}) {
  const big = cafes.filter(c => c.members >= minMembers);
  const matches = cafeKeywords.length ? big.filter(c => cafeKeywords.some(k => `${c.name} ${c.description}`.includes(k))) : big;
  return [...matches].sort((a, b) => b.members - a.members).slice(0, limit);
}

// Aggregate the top posts of a genre into numbers and plain rules the drafting and the 당근 converter can follow.
export function styleCard(genre, posts, { own = [] } = {}) {
  const withF = posts.filter(p => p.features);
  const info = withF.filter(p => p.kind === 'info');
  const basis = info.length >= 3 ? info : withF;
  const f = k => basis.map(p => p.features[k]);
  const stats = {
    basis: basis === info ? 'info' : 'all', posts: basis.length,
    paragraphs: median(f('paragraphs')), linesPerParagraph: median(f('linesPerParagraph')), charsPerLine: median(f('charsPerLine')), chars: median(f('chars')),
    mediaFirstPct: share(basis, p => p.features.mediaFirst), withMediaPct: share(basis, p => p.features.images + p.features.videos > 0),
    images: median(f('images')), urls: median(f('urls')), emojiLinePct: median(f('emojiLineShare')), listLines: median(f('listLines')),
    endsWithQuestionPct: share(basis, p => p.features.endsWithQuestion),
    titleChars: median(f('titleChars')), titleEmojiPct: share(basis, p => p.features.titleEmoji), titleQuestionPct: share(basis, p => p.features.titleQuestion),
    titleNumberPct: share(basis, p => p.features.titleNumber),
  };
  const ownF = own.filter(p => p.features);
  const ownStats = ownF.length ? { posts: ownF.length, paragraphs: median(ownF.map(p => p.features.paragraphs)), linesPerParagraph: median(ownF.map(p => p.features.linesPerParagraph)),
    charsPerLine: median(ownF.map(p => p.features.charsPerLine)), urls: median(ownF.map(p => p.features.urls)), withMediaPct: share(ownF, p => p.features.images + p.features.videos > 0),
    views: median(ownF.map(p => p.views)) } : null;
  const round = v => (v == null ? '?' : Math.round(v));
  const rules = [
    stats.linesPerParagraph != null && `한 문단에 ${stats.linesPerParagraph <= 1.3 ? '한 줄' : `${round(stats.linesPerParagraph)}줄 안팎`}, 한 줄 ${round(stats.charsPerLine)}자 안팎으로 끊는다.`,
    stats.paragraphs != null && `문단 수는 ${round(stats.paragraphs)}개 안팎 (전체 ${round(stats.chars)}자 안팎).`,
    stats.withMediaPct != null && `사진·영상이 있는 글 ${stats.withMediaPct}%, 첫 블록이 사진·영상인 글 ${stats.mediaFirstPct}%.`,
    stats.urls != null && (stats.urls < 1 ? '본문 링크는 거의 쓰지 않는다.' : `본문 링크는 ${round(stats.urls)}개 안팎.`),
    stats.emojiLinePct != null && stats.emojiLinePct > 0 && `줄의 ${round(stats.emojiLinePct)}%에 이모지가 들어간다.`,
    stats.listLines != null && stats.listLines > 0 && `목록 줄(-, 번호, 이모지 머리) ${round(stats.listLines)}개 안팎.`,
    stats.endsWithQuestionPct != null && `질문으로 끝나는 글 ${stats.endsWithQuestionPct}%.`,
    stats.titleChars != null && `제목 ${stats.titleChars}자 안팎, 숫자 ${stats.titleNumberPct}% · 이모지 ${stats.titleEmojiPct}% · 물음형 ${stats.titleQuestionPct}%.`,
  ].filter(Boolean);
  return {
    genre: genre.id, label: genre.label, daangnBoardId: genre.daangnBoardId ?? null, stats, own: ownStats, rules,
    titles: posts.slice(0, 10).map(p => ({ title: p.title, views: p.views, comments: p.comments, kind: p.kind, cafe: p.cafeName ?? p.cafe, url: p.url })),
    openings: basis.slice(0, 3).map(p => ({ title: p.title, firstLines: p.features.firstLines })),
  };
}

export function styleCardsMarkdown(cards, { generatedAt } = {}) {
  const kstDate = generatedAt ? new Date(Date.parse(generatedAt) + 9 * 3600e3).toISOString().slice(0, 10) : '';
  const out = [`# 당근 카페 글쓰기 레퍼런스 (${kstDate})`, '',
    '당근 카페 공개 페이지에서 조회수가 높은 글의 형식을 모은 것입니다. 수치는 각 보드와 맞는 카페의 최근 글 중 조회수 상위 글 기준입니다.', ''];
  for (const c of cards) {
    out.push(`## ${c.label} (보드 ${c.daangnBoardId ?? '-'})`, '', `기준: ${c.stats.basis === 'info' ? '정보형' : '전체'} 글 ${c.stats.posts}개`, '');
    for (const r of c.rules) out.push(`- ${r}`);
    if (c.own) out.push('', `우리 카페 현재: 문단 ${c.own.paragraphs}개, 문단당 ${c.own.linesPerParagraph}줄, 한 줄 ${c.own.charsPerLine}자, 링크 ${c.own.urls}개, 사진 있는 글 ${c.own.withMediaPct}%, 조회 중앙값 ${c.own.views}`);
    out.push('', '| 조회 | 댓글 | 유형 | 제목 |', '|---:|---:|---|---|');
    for (const t of c.titles) out.push(`| ${t.views.toLocaleString('ko-KR')} | ${t.comments} | ${t.kind ?? ''} | [${t.title.replace(/\|/g, '/')}](${t.url}) |`);
    out.push('', '첫 줄 예시:');
    for (const o of c.openings) out.push(`- ${o.title}: ${o.firstLines.join(' / ')}`);
    out.push('');
  }
  return out.join('\n');
}

async function getPage(url, { fetchImpl, delayMs }) {
  await sleep(delayMs);
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' } });
  if (res.status === 403 || res.status === 429) throw fail('DAANGN_BLOCKED', { status: res.status, url });
  if (res.status !== 200) return null;
  return res.text();
}

async function detailed(posts, opts) {
  for (const p of posts) {
    const html = await getPage(p.url, opts);
    if (!html) continue;
    try {
      const post = parsePost(html);
      p.features = postFeatures(post);
      p.cafeName = post.cafeName ?? p.cafeName ?? null;
      p.cafeMembers = post.memberCount != null ? count(post.memberCount) : p.cafeMembers ?? null;
    } catch (e) { p.featureError = e.code || e.message; }
    p.kind = postKind(p.title, p.features);
  }
  return posts;
}

export async function scout({ config, only = null, fetchImpl = globalThis.fetch, delayMs = 700, now = () => new Date() }) {
  const opts = { fetchImpl, delayMs };
  const excludeBoards = config.excludeBoards ?? [];
  const catCache = new Map();
  const cafesOf = async cat => { if (!catCache.has(cat)) { const html = await getPage(`${BASE}/categories/${cat}`, opts); catCache.set(cat, html ? parseCategoryCafes(html) : []); } return catCache.get(cat); };
  const genres = Object.entries(config.genres).map(([id, g]) => ({ id, ...g })).filter(g => !only || only.includes(g.id));
  const results = [];
  for (const g of genres) {
    const pool = [];
    for (const c of g.categories) pool.push(...await cafesOf(c));
    const uniq = [...new Map(pool.map(c => [c.slug, c])).values()];
    const cafes = pickCafes(uniq, { cafeKeywords: g.cafeKeywords ?? [], minMembers: g.minMembers ?? config.minMembers ?? 0, limit: config.cafesPerGenre ?? 8 });
    const posts = [];
    for (const cafe of cafes) {
      const html = await getPage(`${BASE}/${cafe.slug}`, opts);
      if (html) posts.push(...parseCafePosts(html, cafe.slug).map(p => ({ ...p, cafeName: cafe.name, cafeMembers: cafe.members })));
    }
    const ranked = rankPosts(posts, { now: now(), excludeBoards }).slice(0, config.postsPerGenre ?? 12);
    await detailed(ranked, opts);
    results.push({ genre: g, cafes, scanned: posts.length, top: ranked });
  }
  let own = [];
  if (config.ownCafe) {
    const html = await getPage(`${BASE}/${config.ownCafe}`, opts);
    own = html ? await detailed(rankPosts(parseCafePosts(html, config.ownCafe), { now: now(), excludeBoards }), opts) : [];
  }
  const generatedAt = now().toISOString();
  const cards = results.map(r => styleCard(r.genre, r.top, { own }));
  return { schemaVersion: 1, generatedAt, source: 'cafe.daangn.com public pages', genres: results.map(r => ({ id: r.genre.id, label: r.genre.label, cafes: r.cafes, scanned: r.scanned, top: r.top })), own, cards };
}

// Most-viewed recent posts across every category's biggest cafes: the "요즘 당근에서 뜨는 글" list.
export async function hotPosts({ categories = ALL_CATEGORIES, cafesPerCategory = 6, minMembers = 1000, days = 7, top = 10, excludeBoards = [], fetchImpl = globalThis.fetch, delayMs = 700, now = () => new Date() }) {
  const opts = { fetchImpl, delayMs };
  const posts = [];
  const cafesSeen = new Set();
  for (const cat of categories) {
    const html = await getPage(`${BASE}/categories/${cat}`, opts);
    const cafes = html ? pickCafes(parseCategoryCafes(html), { minMembers, limit: cafesPerCategory }) : [];
    for (const cafe of cafes) {
      if (cafesSeen.has(cafe.slug)) continue;
      cafesSeen.add(cafe.slug);
      const home = await getPage(`${BASE}/${cafe.slug}`, opts);
      if (home) posts.push(...parseCafePosts(home, cafe.slug).map(p => ({ ...p, cafeName: cafe.name, cafeMembers: cafe.members, cafeCategory: cafe.category ?? cat })));
    }
  }
  const ranked = rankPosts(posts, { now: now(), days, excludeBoards });
  const topPosts = ranked.slice(0, top);
  await detailed(topPosts, opts);
  return { schemaVersion: 1, generatedAt: now().toISOString(), windowDays: days, cafesScanned: cafesSeen.size, postsScanned: posts.length, top: topPosts };
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const out = arg('out');
  if (!out) throw fail('OUT_REQUIRED');
  mkdirSync(out, { recursive: true });
  const config = JSON.parse(readFileSync(arg('genres') ?? path.join(HERE, 'daangn-reference-genres.json'), 'utf8'));
  if (process.argv.includes('--hot')) {
    const r = await hotPosts({ days: Number(arg('days') ?? 7), top: Number(arg('top') ?? 10), excludeBoards: config.excludeBoards ?? [], minMembers: config.minMembers ?? 1000 });
    writeFileSync(path.join(out, 'daangn-hot-posts.json'), JSON.stringify(r, null, 2) + '\n');
    for (const p of r.top) console.log(`${String(p.views).padStart(7)} 조회 · 💬${p.comments} · ${p.cafeName} · ${p.title}`);
    console.log(JSON.stringify({ ok: true, cafesScanned: r.cafesScanned, postsScanned: r.postsScanned, top: r.top.length }));
    return;
  }
  const only = arg('only')?.split(',');
  const r = await scout({ config, only });
  writeFileSync(path.join(out, 'daangn-references.json'), JSON.stringify(r, null, 2) + '\n');
  writeFileSync(path.join(out, 'daangn-style-cards.json'), JSON.stringify({ generatedAt: r.generatedAt, cards: r.cards }, null, 2) + '\n');
  writeFileSync(path.join(out, 'daangn-style-cards.md'), styleCardsMarkdown(r.cards, { generatedAt: r.generatedAt }) + '\n');
  console.log(JSON.stringify({ ok: true, genres: r.genres.map(g => ({ id: g.id, cafes: g.cafes.length, scanned: g.scanned, top: g.top.length })), own: r.own.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
