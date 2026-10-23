// Style cards (owner 2026-10-06 "상위 블로그 레퍼 … 실질적으로 적용이 되냐"): per genre, how the popular blogs write —
// TITLE, opening HOOK, pick/price placement, sentence rhythm, ending voice, heading emoji, CTA and body format — measured on
// ~20 recent public posts each. Measure and report only: no sentence of another blog is stored (titles only, as examples).
// collect: reference-scout (same subscriber floor as reference-genres.json) → public mobile PostView (as blog-performance does).
//   node style-cards.mjs collect [--genres=travel_deals,ai] [--perGenre=20] [--keywords=4] [--out=style-cards.json]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TITLE_FEATURES, formatFeatures } from '../blog-performance.mjs';
import { analyzePost } from '../../se-format.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, '..', '..');
export const GENRES = ['travel_deals', 'hotdeal', 'ai', 'life_tips'];
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const unescape = s => String(s ?? '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&middot;/g, '·').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const plain = s => unescape(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/[\s​]+/g, ' ').trim();
const EMOJI_LEAD = /^[←-⯿☀-➿\u{1F000}-\u{1FAFF}]/u;
const EMOJI_ANY = /[☀-➿\u{1F000}-\u{1FAFF}]/u;
const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 10) / 10) : null; };

// ---- text extraction from a SmartEditor ONE page: transient, only the measures leave this module ----
export function parsePost(html) {
  const start = html.indexOf('se-main-container');
  let body = start >= 0 ? html.slice(start) : html;
  const end = body.indexOf('class="comment');
  if (end > 0) body = body.slice(0, end);
  const title = plain(/<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? '').replace(/\s*:\s*네이버 블로그$/, '');
  const paragraphs = [], headings = [];
  for (const part of body.split(/(?=<div class="se-component se-)/).slice(1)) {
    const type = /^<div class="se-component se-([a-zA-Z]+)/.exec(part)?.[1];
    if (type === 'text') for (const m of part.matchAll(/<p class="se-text-paragraph[^"]*"[^>]*>([\s\S]*?)<\/p>/g)) { const t = plain(m[1]); if (t) paragraphs.push(t); }
    else if (type === 'quotation' || type === 'sectionTitle') { const t = plain(part); if (t) headings.push(t); }
  }
  return { title, paragraphs, headings };
}

// ---- measures (all pure, shared with style-lint.mjs) ----
export const HOOKS = ['question', 'loss', 'experience', 'number_gap', 'list', 'recommendation_first', 'curiosity'];
const DISCLOSURE = /광고|협찬|수수료|제공받|파트너스|대가를|소정의/;
export function hookType(text) {
  const t = String(text ?? '');
  if (/\?|까요|나요|인가요|있을까|ㄹ까/.test(t)) return 'question';
  if (/놓치|손해|후회|낭비|모르면|바가지|비싸게|마감|끝나기 전|늦기 전/.test(t)) return 'loss';
  if (/저는|제가|직접|써봤|해봤|다녀왔|다녀온|후기|내돈내산|써보니/.test(t)) return 'experience';
  const amounts = t.match(/\d[\d,.]*\s?(원|만원|%|달러|엔|배)/g) ?? [];
  if (amounts.length >= 2 || (amounts.length && /차이|보다|→|vs|비교|할인|절약|아끼|싸|올라|내려|떨어/i.test(t))) return 'number_gap';
  if (/\d+\s?(가지|개(?!월)|곳|단계|건)|TOP\s?\d|첫째|^\s?1[.)]/i.test(t)) return 'list';
  if (/추천|픽|골라|베스트|강추|정리해|한눈에|결론/.test(t)) return 'recommendation_first';
  if (/알고 ?계|아시나요|비밀|이유|궁금|과연|진짜|사실|알려드/.test(t)) return 'curiosity';
  return 'other';
}
export const hasPickOrPrice = t => /\d[\d,.]*\s?(원|만원|%|달러|엔)|추천|1위|최저가|결론|픽/.test(String(t ?? ''));
export function sentences(paragraphs) {
  return paragraphs.flatMap(p => p.split(/(?<=[.!?。…]|[다요죠까])\s+(?=[가-힣A-Za-z0-9'"“‘(\[])/)).map(s => s.trim()).filter(s => s.length >= 2);
}
export const ENDINGS = ['해요체', '합니다체', '반말', '명사형'];
export function endingStyle(sentence) {
  const s = String(sentence ?? '').replace(/[\s.!?~…ㅎㅋ^:;)\]"'”’]+$/u, '').replace(/[☀-➿\u{1F000}-\u{1FAFF}]+$/u, '').trim();
  if (!s) return null;
  if (/(니다|습니까|니까|십시오|십니다)$/.test(s)) return '합니다체';
  if (/(요|죠|네요|군요|거든요|잖아요)$/.test(s)) return '해요체';
  if (/(다|까|냐|자|라|야|어|지|해|거든|잖아|군|네|걸)$/.test(s)) return '반말';
  const last = s.at(-1).charCodeAt(0);
  if (/(음|함|임|됨|기|것|중|필수|가능|예정|완료|추천|정리|비교|후기|방법|혜택|가격|특가|할인)$/.test(s) || (last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 === 16)) return '명사형';
  return null;
}
export function endingShares(sents) {
  const tally = Object.fromEntries(ENDINGS.map(e => [e, 0])); let n = 0;
  for (const s of sents) { const e = endingStyle(s); if (e) { tally[e]++; n++; } }
  return { n, shares: Object.fromEntries(ENDINGS.map(e => [e, n ? +(tally[e] / n).toFixed(2) : 0])) };
}
export const dominantEnding = ({ n, shares }) => n ? ENDINGS.reduce((a, b) => shares[b] > shares[a] ? b : a) : null;
export const CTA_STYLES = {
  subscribe: /구독|이웃\s?추가|팔로우|서로이웃/,
  like_share: /공감|좋아요|하트|공유/,
  comment: /댓글|궁금한 점|문의|물어보/,
  link: /링크|바로가기|신청하기|확인하러|클릭|아래 버튼/,
  next_post: /다음 글|다음 포스팅|다음에|내일|또 만나/,
};
export function ctaStyles(tail) {
  const t = tail.join(' ');
  return Object.entries(CTA_STYLES).filter(([, re]) => re.test(t)).map(([k]) => k);
}

// One post → the measures. `source` = {title, paragraphs, headings}; `format` = analyzePost output or null.
export function measure({ title, paragraphs, headings }, format = null) {
  const body = paragraphs.filter(p => !DISCLOSURE.test(p) || p.length > 80);
  const sents = sentences(body), ends = endingShares(sents);
  // Short-line posts put one phrase per paragraph, so the opening is the first paragraphs up to ~60 characters (at most 3).
  let opening = '', used = 0;
  for (const p of body.slice(0, 3)) { if (used && [...opening].length >= 60) break; opening += `${used ? ' ' : ''}${p}`; used++; }
  const hook = opening ? hookType(opening) : null;
  return {
    titleLen: [...String(title ?? '')].length,
    titleFeatures: Object.entries(TITLE_FEATURES).filter(([, f]) => f(title ?? '')).map(([k]) => k),
    hook, hookLen: opening ? [...opening].length : null,
    pickInFirst3: body.slice(0, 3).some(hasPickOrPrice),
    sentenceMedian: median(sents.map(s => [...s].length)), paragraphMedian: median(body.map(p => [...p].length)), paragraphs: body.length,
    ending: dominantEnding(ends), endingShares: ends.shares,
    headingEmoji: headings.length ? headings.filter(h => EMOJI_ANY.test(h.slice(0, 4))).length / headings.length >= 0.5 : null,
    headingCount: headings.length,
    cta: ctaStyles(body.slice(-3)),
    formatFeatures: formatFeatures(format),
  };
}
export const measureHtml = html => measure(parsePost(html), html.includes('se-main-container') ? analyzePost(html) : null);

// A post's rule tags: what the ≥50% rule counts.
export function tags(m) {
  const t = [...m.titleFeatures.map(f => `title:${f}`)];
  if (m.hook && m.hook !== 'other') t.push(`hook:${m.hook}`);
  if (m.pickInFirst3) t.push('pick_or_price_in_first_3_paragraphs');
  if (m.ending) t.push(`ending:${m.ending}`);
  if (m.headingEmoji) t.push('heading_emoji');
  for (const c of m.cta) t.push(`cta:${c}`);
  return [...t, ...m.formatFeatures];
}

// Pure: measured posts [{url, title, ...measure}] → genre card. Every rule carries the URLs it was measured on.
export function buildCard(posts, { minShare = 0.5 } = {}) {
  const n = posts.length;
  const by = new Map();
  for (const p of posts) for (const tag of new Set(tags(p))) by.set(tag, [...(by.get(tag) ?? []), p.url]);
  const common = [...by].map(([feature, urls]) => ({ feature, posts: urls.length, share: +(urls.length / n).toFixed(2), sample: urls }))
    .filter(r => n && r.share >= minShare).sort((a, b) => b.share - a.share || a.feature.localeCompare(b.feature));
  const med = key => ({ value: median(posts.map(p => p[key])), n: posts.filter(p => Number.isFinite(p[key])).length });
  const hookTally = posts.reduce((m, p) => (p.hook ? m.set(p.hook, (m.get(p.hook) ?? 0) + 1) : m), new Map());
  return {
    posts: n, common,
    medians: { titleLen: med('titleLen'), hookLen: med('hookLen'), sentenceChars: med('sentenceMedian'), paragraphChars: med('paragraphMedian'), paragraphs: med('paragraphs') },
    hookMix: Object.fromEntries([...hookTally].sort((a, b) => b[1] - a[1])),
    endingMix: Object.fromEntries(ENDINGS.map(e => [e, posts.filter(p => p.ending === e).length])),
    exampleTitles: [...new Set(posts.map(p => p.title).filter(Boolean))].slice(0, 3),
    urls: posts.map(p => p.url),
  };
}

// ---- collect ----
export function pickPosts(blogs, { total = 20, perBlog = 2 } = {}) {
  const out = [];
  for (let round = 0; round < perBlog && out.length < total; round++)
    for (const b of blogs.filter(b => b.platform === 'naver')) { const p = b.topPosts?.[round]; if (p && out.length < total) out.push({ blogId: b.blogId, subscribers: b.subscribers ?? null, ...p }); }
  return out;
}
export async function collect({ genres = GENRES, perGenre = 20, keywordsPerGenre = 4, fetchImpl = globalThis.fetch, delayMs = 1500, scoutImpl, now = () => new Date() } = {}) {
  const scout = scoutImpl ?? (await import(pathToFileURL(path.join(STORE, 'reference-scout.mjs')).href)).scout;
  const cfg = JSON.parse(readFileSync(path.join(STORE, 'reference-genres.json'), 'utf8'));
  const pick = Object.fromEntries(Object.entries(cfg.genres).filter(([g]) => genres.includes(g)).map(([g, v]) =>
    [g, { keywords: (Array.isArray(v) ? v : v.keywords).slice(0, keywordsPerGenre), sources: ['naver_blog'] }]));
  const found = await scout({ genres: pick, excludeBlogIds: cfg.excludeBlogIds ?? [], excludeHosts: [], minSubscribers: cfg.minSubscribers ?? 0, top: 30, fetchImpl, delayMs });
  const card = { schemaVersion: 1, kind: 'style-cards', checkedAt: now().toISOString(), minSubscribers: cfg.minSubscribers ?? 0, status: 'ok',
    method: 'reference-scout naver_blog search (recent posts of top blogs) + anonymous public m.blog.naver.com PostView; measures only, no body text stored', genres: {} };
  if (found.coverage?.blocked || (!found.coverage?.rankings && found.coverage?.failures)) { card.status = 'geo_blocked_non_kr'; card.note = 'Naver search was blocked or refused from this egress; run from a Korean IP.'; return card; }
  let reads = 0, refused = 0;
  for (const g of Object.keys(pick)) {
    const picks = pickPosts(found.genres[g]?.blogs ?? [], { total: perGenre });
    const posts = [];
    for (const p of picks) {
      try {
        const res = await fetchImpl(`https://m.blog.naver.com/PostView.naver?blogId=${p.blogId}&logNo=${p.logNo}`,
          { headers: { 'user-agent': MOBILE_UA, 'accept-language': 'ko-KR', referer: `https://m.blog.naver.com/${p.blogId}` } });
        reads++;
        if ([403, 429].includes(res.status)) { refused++; if (refused >= 3) break; continue; }
        const html = await res.text();
        if (!res.ok || !html.includes('se-main-container')) continue;
        const parsed = parsePost(html);
        posts.push({ url: p.url, blogId: p.blogId, ...measure({ ...parsed, title: parsed.title || p.title }, analyzePost(html)), title: parsed.title || p.title, measuredAt: now().toISOString() });
      } catch { /* an unreadable post is skipped, not guessed */ }
      await sleep(delayMs);
    }
    card.genres[g] = { keywords: pick[g].keywords, ...buildCard(posts), blogs: [...new Set(posts.map(p => p.blogId))].length };
    if (refused >= 3) break;
  }
  if (reads && refused === reads && !Object.values(card.genres).some(v => v.posts)) { card.status = 'geo_blocked_non_kr'; card.note = 'PostView refused (403/429) from this egress; run from a Korean IP.'; }
  return card;
}

async function main() {
  const [cmd = 'collect', ...rest] = process.argv.slice(2);
  const args = Object.fromEntries(rest.filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; }));
  if (cmd !== 'collect') throw Object.assign(new Error('STYLE_CARDS_COMMAND'), { code: 'STYLE_CARDS_COMMAND' });
  const card = await collect({ genres: args.genres ? args.genres.split(',').filter(Boolean) : GENRES, perGenre: Number(args.perGenre) || 20, keywordsPerGenre: Number(args.keywords) || 4 });
  writeFileSync(args.out ?? path.join(HERE, 'style-cards.json'), JSON.stringify(card, null, 2));
  console.log(JSON.stringify({ status: card.status, genres: Object.fromEntries(Object.entries(card.genres).map(([g, v]) => [g, { posts: v.posts, common: v.common.map(c => `${c.feature}:${c.share}`) }])) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code ?? 'STYLE_CARDS_FAILED' })); process.exitCode = 1; });
}
