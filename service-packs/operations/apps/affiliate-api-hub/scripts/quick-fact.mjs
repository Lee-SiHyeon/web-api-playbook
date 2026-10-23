// Quick-fact publisher: verified Grok-format posts -> X and Threads (one journaled write per channel).
// Image dry run: node quick-fact.mjs --file=posts.txt --channels=x,threads,telegram --images=product.png,detail.jpg --dry-run
//   node quick-fact.mjs --file=posts.txt [--channels=x,threads] [--board=life] [--layout=paragraphs] [--threads-topic=장보기] [--dry-run] [--allow-duplicate-topic]
// Posts in the file are separated by a line "---". In a post, lines starting with http(s):// are links (last = official
// source); every other line is body text. Lines after a "+++" line become a chained reply on X/Threads, and
// an optional "상품 페이지: <url>" line (legacy label "당근:") is the deal's plain product URL, used only as its duplicate-topic key and never sent anywhere.
// Short quick-facts never publish to 당근. Informational blog articles may be mirrored only by mirror-daangn.mjs after Naver readback.
// Each channel has a ledger entry keyed by the post hash: a channel that already has a write attempt is never sent again
// (reconcile by hand), and a live run needs every gate to pass first.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishThread } from './sns/writers/x.mjs';
import { buildXImageUploadPlan } from './sns/writers/x-media.mjs';
import { publishChain } from './sns/writers/threads.mjs';
import { publishChainGraph } from './sns/writers/threads-graph.mjs';
import { enqueueFromPost, QUEUE as INPOCK_QUEUE } from './inpock-links.mjs';
import { defaultJournalDir, reconcileIntent } from './sns/writers/journal.mjs';
import { readThreadsPostsById } from './sns/readers/threads-readback.mjs';
import { sendTransport } from './sns-publish.mjs';
import { publicReadback, isPartnerUrl } from './mirror-daangn.mjs';
import { assertNotHeld } from './publish-hold.mjs';
import { lintPost } from './marketing-copy.mjs';
import { createDefaultTelegramChannelClient, DEFAULT_TELEGRAM_DAILY_CAP, reconcileTelegramIntent } from './telegram-channel.mjs';

import { webApiPlaybookRoot } from '../adapters/web-auth-provider.mjs';
const PLAYBOOK = webApiPlaybookRoot();
// Owner 2026-10-01: deal posts go under a Threads topic housewives browse (장보기, 생필품 추천, 육아템 추천, 주방용품 추천) or the 핫딜 topic,
// never plain 쇼핑. All names below were confirmed to exist via Threads topic search on 2026-10-01; --threads-topic overrides.
export const THREADS_DEAL_FALLBACK = '핫딜, 쇼핑, 세일';
export const THREADS_DEAL_TOPICS = Object.freeze([
  ['육아템 추천', /기저귀|분유|아기|유아|베베|이유식|젖병/],
  ['생필품 추천', /화장지|휴지|티슈|세제|섬유유연제|샴푸|린스|바디워시|치약|칫솔|위생백|수세미|탈취|키친타월|생리대|비누|방향제/],
  ['주방용품 추천', /냄비|프라이팬|도마|식기|텀블러|밀폐용기|에어프라이어|전기밥솥|믹서/],
  ['장보기', /소시지|햄|고기|돼지|소고기|한우|삼겹|갈비|닭|족발|오징어|생선|새우|김치|반찬|두부|유부|계란|달걀|우유|치즈|라면|쌀|과일|키위|감귤|사과|채소|상추|감자|고구마|올리브오일|식용유|참기름|들기름|간장|소스|커피|생수|음료|주스|과자|간식|젤리|떡|약과|인절미|만두|냉동|밀키트|아이스크림|빵|견과|미역|통조림|참치|식초|설탕|밀가루|메추리알|전병|도나스|마카로니/],
]);
// daily (H empathy posts): owner 2026-10-19 21:48 KST "일상채널말고 스하리 채널에 올려줘". '스하리' checked 21:49 KST with threads-topics.mjs resolveThreadsTopic (BarcelonaTagsUtilsQuery: is_valid true, is_sensitive false); the topic search only lists '스하리 N명 프로젝트' variants, so the plain tag is used.
export const THREADS_TOPIC = Object.freeze({ shopping: THREADS_DEAL_FALLBACK, travel: '여행', ai: 'AI', life: '생활', daily: '스하리', economy: '경제', housing: '부동산', sidejob: '부업' });
export const threadsTopicFor = (board, override = null, post = null) => {
  if (typeof override === 'string' && override.trim()) return override.trim();
  if (board === 'shopping' && post?.body?.length) {
    const text = post.body.join(' ');
    for (const [topic, re] of THREADS_DEAL_TOPICS) if (re.test(text)) return topic;
  }
  return THREADS_TOPIC[board] ?? null;
};
const DEFAULT_TAGS = Object.freeze({ shopping: ['#쇼핑', '#최저가'], travel: ['#여행', '#항공권특가'], ai: ['#AI', '#AI뉴스'], life: ['#생활정보'], daily: [], economy: ['#경제'], housing: ['#부동산'], sidejob: ['#부업', '#공모전'] });
const TAG_LINE = /^#[\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*(\s+#[\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)*$/u;
export const BOARDS = Object.freeze({ shopping: 2186662, travel: 2186663, housing: 2186664, life: 2186665, daily: 2186665, economy: 2186666, issue: 2186667, ai: 2186667, sidejob: 2186666 });
const LEDGER = path.join(process.env.LOCALAPPDATA ?? '.', 'affiliate-content-operations', 'quick-fact', 'ledger.jsonl');
const TOPICS = path.join(path.dirname(LEDGER), 'topics.jsonl');
const fail = code => { throw Object.assign(new Error(code), { code }); };
export const QUICKFACT_CHANNELS = Object.freeze(['x', 'threads', 'telegram']);
export function assertQuickFactChannels(channels) {
  if (!Array.isArray(channels)) fail('QUICKFACT_CHANNELS_INVALID');
  if (channels.includes('daangn')) fail('QUICKFACT_DAANGN_CHANNEL_FORBIDDEN');
  if (channels.some(channel => !QUICKFACT_CHANNELS.includes(channel))) fail('QUICKFACT_CHANNEL_INVALID');
  if (new Set(channels).size !== channels.length) fail('QUICKFACT_CHANNEL_DUPLICATE');
  return channels;
}

// Owner 2026-09-30: deal posts carry only affiliate links (쿠팡 파트너스 / 네이버 쇼핑 커넥트) plus the network's disclosure;
// the "어디서 얼마" comparison goes in a chained reply written after a "+++" line.
export const AFFILIATE = Object.freeze([
  { network: 'coupang_partners', host: /^link\.coupang\.com$/, disclosure: '쿠팡 파트너스 활동' },
  // naver.me links come from 쇼핑 커넥트 and 여행 커넥트 (travel-create-link) alike; either program's wording discloses them.
  { network: 'naver_connect', host: /^naver\.me$/, disclosure: '쇼핑 커넥트 활동', alsoDisclosure: ['여행 커넥트 활동'] },
  { network: 'myrealtrip_partner', host: /^myrealt\.rip$/, disclosure: '마이리얼트립 파트너 활동' },
  // Toss requires the disclosure next to the product introduction, so it goes in the body right after the first line.
  // Only /_m/ links track; toss.shopping/t/… product URLs on the same host do not earn anything.
  { network: 'toss_sharelink', host: /^(toss\.im|toss\.shopping)$/, path: /^\/_m\//, disclosure: '토스쇼핑 쉐어링크 활동' },
]);
// Partner-link hosts we know of but have no disclosure rule for here (ontology gap audit 2026-10-05 ONT-03: a LinkPrice
// click URL passed parsePosts with no network and so with no disclosure). Such a link is refused, never posted bare.
export const UNREGISTERED_PARTNER_HOST = /(^|\.)(linkprice\.com|lpweb\.kr|coupa\.ng|adpick\.co\.kr|deg\.kr|bitl\.bz|tenping\.kr|s\.click\.aliexpress\.com|a\.aliexpress\.com|amzn\.to|ali\.ski)$/;
const unregisteredPartner = url => { try { return UNREGISTERED_PARTNER_HOST.test(new URL(url).hostname); } catch { return false; } };
const affiliateOf = url => { try { const u = new URL(url); return AFFILIATE.find(a => a.host.test(u.hostname) && (!a.path || a.path.test(u.pathname))) ?? null; } catch { return null; } };
const discloses = (a, line) => [a.disclosure, ...(a.alsoDisclosure ?? [])].some(d => line.includes(d));
export const isDisclosure = line => AFFILIATE.some(a => discloses(a, line));

// Recall gate (recall-safety, cloud build 2026-10-05): a partner-link post whose product strongly matches an official recall
// or sales-stop notice (barcode, brand+model, or brand + exact name in the notice period) is not posted. Weak name
// matches and unavailable/incomplete evidence require human review before publication. The index is refreshed by
// recall-safety/refresh-index.mjs; review is a hold, distinct from a confirmed recalled-product block.
async function recallGateFor(post) {
  if (process.env.NODE_TEST_CONTEXT && !process.env.QUICKFACT_RECALL_TEST) return { status: 'clear', matches: [], reasons: [{ code: 'TEST_ONLY_RECALL_BYPASS' }] };
  try {
    const dir = '../../naver-blog-api/research/content-store/recall-safety/';
    const [{ recallCheck }, { readRecallIndex }] = await Promise.all([import(dir + 'recall-gate.mjs'), import(dir + 'refresh-index.mjs')]);
    const index = readRecallIndex();
    const title = [...post.body, ...(post.reply?.body ?? [])].join(' ').slice(0, 400);
    return recallCheck({ title }, { index });
  } catch { return { status: 'review', matches: [], reasons: [{ code: 'RECALL_CHECK_UNAVAILABLE' }], assessment: 'unknown' }; }
}

// Daily empathy posts (owner 2026-10-19 "한동안 일상 공감글좀 올리자"): no links, no affiliate, text only, and a different
// text per platform. The block is "<X text>" + a "+++threads" line + "<Threads text>"; blank lines inside each text are kept as
// paragraph breaks. Only the 'daily' board may send them (run() checks), and both texts are sent exactly as written.
const DAILY_MARKER = /^[ \t]*\+\+\+threads[ \t]*$/m;
const DAILY_LINKISH = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|kr|io|me|im|ly|co)\b|@[A-Za-z0-9_]/i;
const dailyText = part => part.replace(/\r/g, '').split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
function parseDailyPost(block, daangnLinks) {
  if (daangnLinks.length) fail('QUICKFACT_DAILY_SHAPE');
  const pieces = block.split(DAILY_MARKER);
  if (pieces.length !== 2) fail('QUICKFACT_DAILY_SHAPE');
  const [x, threads] = pieces.map(dailyText);
  if (!x || !threads || [x, threads].some(t => /^\s*\+\+\+\s*$/m.test(t))) fail('QUICKFACT_DAILY_SHAPE');
  if ([x, threads].some(t => DAILY_LINKISH.test(t)) || [x, threads].some(t => AFFILIATE.some(a => discloses(a, t)))) fail('QUICKFACT_DAILY_LINK_FORBIDDEN');
  return { body: x.split('\n').filter(Boolean), links: [], tags: [], reply: null, daangnLinks: [], affiliate: [], daily: { x, threads },
    hash: createHash('sha256').update(['daily', x, '+++threads', threads].join('\n')).digest('hex').slice(0, 20) };
}

const FLIGHT_SUBJECT = /^https:\/\/flight\.naver\.com\/flights\/(?:domestic|international)\/[A-Z]{3}-[A-Z]{3}-\d{8}(?:\/[A-Z]{3}-[A-Z]{3}-\d{8})?(?:\?\S*)?$/;
export function parsePosts(text) {
  return String(text).replace(/\r/g, '').split(/^\s*---\s*$/m).map(b => b.trim()).filter(Boolean).map(block => {
    // "당근: <url>" lines carry the deal's plain product URL for the duplicate-topic key; no channel ever sees them.
    const DAANGN_LINK = /^(?:당근|상품 페이지)\s*:\s*(https?:\/\/\S+)$/; // '상품 페이지:' since 2026-10-16; hash keeps the old '당근:' prefix
    const daangnLinks = block.split('\n').map(l => l.trim()).map(l => DAANGN_LINK.exec(l)?.[1]).filter(Boolean);
    if (daangnLinks.some(affiliateOf)) fail('QUICKFACT_DAANGN_AFFILIATE_LINK');
    block = block.split('\n').filter(l => !DAANGN_LINK.test(l.trim())).join('\n');
    if (DAILY_MARKER.test(block)) return parseDailyPost(block, daangnLinks);
    const [mainPart, ...replyParts] = block.split(/^\s*\+\+\+\s*$/m);
    const split = part => { const lines = part.split('\n').map(l => l.trim()).filter(Boolean);
      const links = lines.filter(l => /^https?:\/\/\S+$/.test(l));
      const tagLines = lines.filter(l => TAG_LINE.test(l));
      return { lines, links, tags: tagLines.flatMap(l => l.split(/\s+/)), body: lines.filter(l => !links.includes(l) && !tagLines.includes(l)) }; };
    // 2026-10-18 (owner "어그로 좀 끌면서 올려 긴글로"): a post may carry several "+++" parts, each one reply in the X/Threads
    // chain (story, then the price table). One part keeps the old shape and the old hash.
    const parts = replyParts.map(split).filter(p => p.lines.length);
    const main = split(mainPart);
    const reply = parts.length <= 1 ? (parts[0] ?? split(''))
      : { lines: parts.flatMap((p, i) => (i ? ['+++', ...p.lines] : p.lines)), links: parts.flatMap(p => p.links), body: parts.flatMap(p => p.body), tags: [] };
    if (!main.body.length || main.links.length < 1) fail('QUICKFACT_POST_SHAPE');
    // URLs inside text lines count too: the 2026-10-05 Okinawa post put "…44,900원 https://myrealt.rip/…" mid-line and the
    // affiliate rules never saw it.
    const allLinks = [...main.lines, ...reply.lines].flatMap(l => l.match(/https?:\/\/\S+/g) ?? []);
    if (allLinks.some(unregisteredPartner)) fail('QUICKFACT_UNREGISTERED_PARTNER_LINK');
    const networks = [...new Set(allLinks.map(affiliateOf).filter(Boolean))];
    if (networks.length) {
      // The flight a travel post is built on is its subject, not a shop (owner 2026-10-06: "항공권을 제시하고 상품 추천해야할거아냐").
      if (allLinks.some(l => !affiliateOf(l) && !FLIGHT_SUBJECT.test(l))) fail('QUICKFACT_NON_AFFILIATE_LINK_IN_DEAL');
      for (const n of networks) if (!main.body.some(l => discloses(n, l))) fail(`QUICKFACT_DISCLOSURE_MISSING:${n.network}`);
    }
    return { body: main.body, links: main.links, tags: main.tags, reply: reply.lines.length ? { body: reply.body, links: reply.links } : null, daangnLinks,
      ...(parts.length > 1 ? { replies: parts.map(p => ({ body: p.body, links: p.links })) } : {}),
      affiliate: networks.map(n => n.network),
      hash: createHash('sha256').update([...main.lines, '+++', ...reply.lines, ...daangnLinks.map(l => `당근:${l}`)].join('\n')).digest('hex').slice(0, 20) };
  });
}

const replyText = post => (post.reply ? [...post.reply.body, ...post.reply.links].join('\n') : null);

// X weights: links 23, Hangul/CJK/emoji 2, the rest 1.
export function xWeight(text) {
  let n = 0;
  for (const line of text.split('\n')) {
    for (const word of line.split(/(https?:\/\/\S+)/)) {
      if (/^https?:\/\//.test(word)) { n += 23; continue; }
      for (const ch of word) n += /[\u1100-\u11ff\u2e80-\ud7ff\uf900-\ufaff\u{1f000}-\u{1faff}\u2600-\u27bf]/u.test(ch) ? 2 : 1;
    }
    n += 1;
  }
  return n - 1;
}

// X hashtags (owner 2026-09-30 "Sns에 태그기능좀 써라"): at most two, after the body and before the links, dropped when they
// would push the post over 280. Threads already gets its topic tag through tag_header; 당근 gets none.
const xTags = (post, board) => (post.tags?.length ? post.tags : DEFAULT_TAGS[board] ?? []).slice(0, 2);

function buildXMain(post, board) {
  const tags = xTags(post, board);
  const plain = [...post.body, ...post.links].join('\n');
  for (const both of tags.length ? [[...post.body, tags.join(' '), ...post.links].join('\n'), plain] : [plain]) if (xWeight(both) <= 280) return both;
  const official = [...post.body, post.links.at(-1)].join('\n');
  if (!post.affiliate?.length && xWeight(official) <= 280) return official;
  return fail('QUICKFACT_X_TOO_LONG');
}

// Returns the X thread: the post, then the comparison reply when there is one.
// X turns domain-like words in text into t.co links ("SSG.COM 16,900원" became "https://t.co/… 16,900원", 2026-10-05), so the
// readback no longer matched what was sent and the bot held. Seller names that look like domains are written out instead.
export const xSafeLine = line => /^https?:\/\/\S+$/.test(line) ? line
  : String(line).replace(/\b([A-Za-z][A-Za-z0-9-]*)\.(com|COM|co\.kr|CO\.KR|net|NET|kr|KR|shop|SHOP)\b/g,
    (_, name, tld) => (/^com$/i.test(tld) ? `${name}닷컴` : `${name} ${tld.toLowerCase()}`));
const xSafe = text => text.split('\n').map(xSafeLine).join('\n');
// A comparison reply over 280 drops its last comparison rows on X (the header and the first rows — the deal and the
// cheapest rivals — stay; links are kept). Threads and Telegram keep the full list. 2026-10-05: a 9-seller list was too
// long and held the bot.
export function fitXReply(reply, limit = 280) {
  if (reply === null || xWeight(reply) <= limit) return reply;
  const lines = reply.split('\n');
  const links = lines.filter(l => /^https?:\/\/\S+$/.test(l)), text = lines.filter(l => !links.includes(l));
  for (let keep = text.length - 1; keep >= 3; keep--) {
    const cut = [...text.slice(0, keep), `외 ${text.length - keep}곳은 스레드·텔레그램에`, ...links].join('\n');
    if (xWeight(cut) <= limit) return cut;
  }
  return fail('QUICKFACT_X_REPLY_TOO_LONG');
}
// Long post (owner 2026-10-07 "긴글로 ㄱㄱ"): a detail reply that does not fit a 280 thread reply goes into the same post, below a
// blank line, and the whole text is sent as one note tweet. The main part stays within 280, so the hook, disclosure and link sit
// above X's "더 보기" fold. A reply that fits 280 stays a thread reply.
export const X_LONG_LIMIT = 1500;
// AI news briefs (owner 2026-10-08, @choi.openai style): each body line is a paragraph, separated by a blank line, no
// hashtags, the source link last; on X the whole brief is one (long) post.
const PARAGRAPH_BOARDS = new Set(['ai']);
const paragraphText = post => [post.body.join('\n\n'), ...post.links].join('\n\n');
const paragraphLayout = (board, layout) => (layout === 'paragraphs' || PARAGRAPH_BOARDS.has(board));
// 2026-10-20 (owner "X 게시글 주기 늦춰라 봇탐지 걸리나본데"): QF_X_SINGLE_POST=1 sends X one long post instead of a reply
// chain (the parts are joined; when the join is over the long-post limit, only the main post goes out). Threads is unchanged.
export function buildXText(post, board, opts = {}) {
  const parts = buildXTextChain(post, board, opts);
  if (process.env.QF_X_SINGLE_POST !== '1' || parts.length <= 1) return parts;
  const joined = parts.join('\n\n');
  return [xWeight(joined) <= X_LONG_LIMIT ? joined : parts[0]];
}
function buildXTextChain(post, board, { layout = null } = {}) {
  if (post.daily) {
    const text = xSafe(post.daily.x);
    if (xWeight(text) > 280) fail('QUICKFACT_X_TOO_LONG');
    return [text];
  }
  if (paragraphLayout(board, layout) && !post.reply) {
    const text = xSafe(paragraphText(post));
    if (xWeight(text) > X_LONG_LIMIT) fail('QUICKFACT_X_TOO_LONG');
    return [text];
  }
  if (post.replies?.length > 1) return buildXChain(post, board);
  let main;
  try { main = xSafe(buildXMain(post, board)); }
  catch (error) {
    // 2026-10-08: a Coupang deal's main part (hook + item line + the long Partners disclosure) weighed 288 and held the bot.
    // The post goes out as one long post anyway, so a main part over 280 joins its reply instead of failing.
    if (error.code !== 'QUICKFACT_X_TOO_LONG') throw error;
    main = xSafe([...post.body, ...post.links].join('\n'));
    const rest = replyText(post) === null ? null : xSafe(replyText(post));
    const text = rest === null ? main : `${main}\n\n${fitXReply(rest, X_LONG_LIMIT - xWeight(main) - 2)}`;
    if (xWeight(text) > X_LONG_LIMIT) fail('QUICKFACT_X_TOO_LONG');
    return [text];
  }
  if (replyText(post) === null) return [main];
  const reply = xSafe(replyText(post));
  if (xWeight(reply) <= 280) return [main, reply];
  return [`${main}\n\n${fitXReply(reply, X_LONG_LIMIT - xWeight(main) - 2)}`];
}

// Splits a reply into consecutive line groups of at most `limit` (X weight or characters); null when one line alone is too long.
export function chunkLines(text, limit, weigh) {
  const out = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (weigh(line) > limit) return null;
    if (cur.length && weigh([...cur, line].join('\n')) > limit) { out.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}
// Multi-part posts (several "+++" parts): the X post stays a short hook (≤280, above the fold) and every part becomes its own
// reply, split by lines when a part is over 280. A part that cannot be split falls back to one long post, as before.
function buildXChain(post, board) {
  const main = xSafe(buildXMain(post, board));
  const chain = [main];
  for (const part of post.replies) {
    const text = xSafe([...part.body, ...part.links].join('\n'));
    const pieces = chunkLines(text, 280, xWeight);
    if (!pieces || chain.length + pieces.length > 6) {
      const rest = post.replies.map(r => xSafe([...r.body, ...r.links].join('\n'))).join('\n\n');
      const long = `${main}\n\n${fitXReply(rest, X_LONG_LIMIT - xWeight(main) - 2)}`;
      if (xWeight(long) > X_LONG_LIMIT) fail('QUICKFACT_X_TOO_LONG');
      return [long];
    }
    chain.push(...pieces);
  }
  return chain;
}
// Threads (500 characters a post): the first story part joins the root post when it fits, so the root reads as one longer
// post; the remaining parts follow as replies.
function buildThreadsChain(post) {
  const [first, ...rest] = post.replies;
  const plain = [...post.body, ...post.links].join('\n');
  const joined = [...post.body, '', ...first.body, ...first.links, '', ...post.links].join('\n');
  const root = [...joined].length <= 500 ? joined : plain;
  if ([...root].length > 500 || post.links.length > 5) fail('QUICKFACT_THREADS_TOO_LONG');
  const parts = root === joined ? rest : post.replies;
  const out = [root];
  for (const part of parts) {
    const pieces = chunkLines([...part.body, ...part.links].join('\n'), 500, t => [...t].length);
    if (!pieces) fail('QUICKFACT_THREADS_REPLY_TOO_LONG');
    out.push(...pieces);
  }
  return out;
}

export function buildThreadsText(post, board = null, { layout = null } = {}) {
  if (post.daily) {
    if ([...post.daily.threads].length > 500) fail('QUICKFACT_THREADS_TOO_LONG');
    return [post.daily.threads];
  }
  if (post.replies?.length > 1) return buildThreadsChain(post);
  const text = paragraphLayout(board, layout) && !post.reply ? paragraphText(post) : [...post.body, ...post.links].join('\n');
  if ([...text].length > 500 || post.links.length > 5) fail('QUICKFACT_THREADS_TOO_LONG');
  const reply = replyText(post);
  if (reply !== null && [...reply].length > 500) fail('QUICKFACT_THREADS_REPLY_TOO_LONG');
  return reply === null ? [text] : [text, reply];
}

export function buildTelegramText(post) {
  const parts = [...post.body, ...post.links, ...(post.reply ? [...post.reply.body, ...post.reply.links] : [])];
  const text = parts.join('\n');
  if (!text.trim() || [...text].length > 4096) fail('QUICKFACT_TELEGRAM_TOO_LONG');
  return text;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail('QUICKFACT_IMAGE_SIGNATURE_INVALID');
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (startOfFrame.has(marker) && length >= 7) {
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      if (width > 0 && height > 0) return { width, height };
      break;
    }
    offset += length;
  }
  fail('QUICKFACT_IMAGE_DIMENSIONS_INVALID');
}

export function readQuickFactImages(files = []) {
  const paths = typeof files === 'string' ? files.split(',').map(item => item.trim()).filter(Boolean) : files;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 4) fail('QUICKFACT_IMAGES_INVALID');
  return paths.map(file => {
    if (typeof file !== 'string' || !file.trim()) fail('QUICKFACT_IMAGES_INVALID');
    const resolved = path.resolve(file);
    const filename = path.basename(resolved);
    const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(filename).toLowerCase()];
    if (!mimeType) fail('QUICKFACT_IMAGE_TYPE_INVALID');
    const bytes = readFileSync(resolved);
    let dimensions;
    if (mimeType === 'image/png') {
      if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') fail('QUICKFACT_IMAGE_SIGNATURE_INVALID');
      dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    } else {
      if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail('QUICKFACT_IMAGE_SIGNATURE_INVALID');
      dimensions = jpegDimensions(bytes);
    }
    if (!Number.isInteger(dimensions.width) || dimensions.width < 1 || !Number.isInteger(dimensions.height) || dimensions.height < 1) {
      fail('QUICKFACT_IMAGE_DIMENSIONS_INVALID');
    }
    return { path: resolved, filename, bytes, mimeType, ...dimensions,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

export function telegramCaptionPlan(text) {
  if (typeof text !== 'string' || !text.trim() || [...text].length > 4096) fail('QUICKFACT_TELEGRAM_TOO_LONG');
  const points = [...text];
  return { caption: points.slice(0, 1024).join(''), followUp: points.slice(1024).join('') };
}

function telegramImageValidationError(image) {
  if (image.bytes.length > 10 * 1024 * 1024 || image.width + image.height > 10_000
    || Math.max(image.width, image.height) / Math.min(image.width, image.height) > 20) return 'TELEGRAM_IMAGE_LIMIT_INVALID';
  return null;
}

function normalizeQuickFactImageAssets(images) {
  if (!Array.isArray(images) || images.length > 4) fail('QUICKFACT_IMAGES_INVALID');
  if (images.length && images.every(image => typeof image === 'string')) return readQuickFactImages(images);
  return images.map(image => {
    const bytes = Buffer.isBuffer(image?.bytes) || image?.bytes instanceof Uint8Array ? Buffer.from(image.bytes) : null;
    if (!bytes?.length || !['image/png', 'image/jpeg'].includes(image?.mimeType)
      || !Number.isInteger(image?.width) || image.width < 1 || !Number.isInteger(image?.height) || image.height < 1) fail('QUICKFACT_IMAGE_INVALID');
    const signatureOk = image.mimeType === 'image/png' ? bytes.length >= 24 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a'
      : bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    if (!signatureOk) fail('QUICKFACT_IMAGE_SIGNATURE_INVALID');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (image.sha256 && image.sha256 !== sha256) fail('QUICKFACT_IMAGE_HASH_MISMATCH');
    return { ...image, bytes, filename: path.basename(String(image.filename || 'image')), sha256 };
  });
}

// Owner 2026-10-01: 당근 gets informational posts only and no partner link of any network, so a post that carries an
// affiliate link never becomes a 당근 post.
export const daangnSkipReason = post => (post.affiliate?.length || [...post.links, ...(post.reply?.links ?? [])].some(isPartnerUrl) ? 'DAANGN_PARTNER_LINK_POST' : null);

export function buildDaangn(post) {
  if (daangnSkipReason(post)) fail('QUICKFACT_DAANGN_PARTNER_LINK_POST');
  const first = post.body[0].replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '').trim();
  const title = [...first].length <= 50 ? first : [...first].slice(0, 49).join('') + '…';
  const paragraphs = [...post.body, ...post.links, ...(post.reply ? [...post.reply.body, ...post.reply.links] : [])];
  if (!title || paragraphs.length > 40) fail('QUICKFACT_DAANGN_SHAPE');
  return { title, paragraphs };
}

export function ledgerRead(file = LEDGER) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function ledgerWrite(entry, file = LEDGER) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// Duplicate lint: the ledger only stops identical text, but a deal carries its check time and a flight its price, so a
// recomposed post for the same product or route gets a new hash. A topic key names what the post is about; a live post
// (attempted or done on any channel) with the same key blocks it: deals and flights for the rest of that KST day, news for good.
// A deal's query only picks an option or carries tracking, so it is dropped; a source page often names the article in its
// query (korea.kr …View.do?newsId=…), so it stays there minus tracking parameters.
const normUrl = (u, keepQuery = false) => {
  try {
    const x = new URL(u);
    const q = keepQuery ? [...x.searchParams].filter(([k]) => !/^(utm_|fbclid$|gclid$|ref$)/i.test(k)).map(([k, v]) => `${k}=${v}`).sort().join('&') : '';
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${q ? `?${q}` : ''}`;
  } catch { return String(u); }
};
const kstDay = at => new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
export function telegramDailyCount(entries, at = new Date()) {
  const latest = new Map();
  for (const entry of entries ?? []) if (entry.key?.startsWith('telegram:')) latest.set(entry.key, entry);
  const day = kstDay(at);
  return [...latest.values()].filter(entry => ['attempted', 'done'].includes(entry.state)
    && entry.at && kstDay(entry.at) === day).length;
}

function acquireTelegramDailyLock(at, ledgerFile = LEDGER) {
  const directory = path.join(path.dirname(ledgerFile), 'telegram-daily-locks');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${kstDay(at)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { unlinkSync(file); } catch { /* already released */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
      try { process.kill(Number(owner?.pid), 0); return null; }
      catch (aliveError) {
        if (aliveError.code !== 'ESRCH') return null;
        try { unlinkSync(file); } catch { return null; }
      }
    }
  }
  return null;
}

export function topicOf(post) {
  if (post.daily) return { key: `daily:${post.hash}`, scope: 'forever' };
  const f = post.links.map(l => /^https:\/\/flight\.naver\.com\/flights\/(?:domestic|international)\/([A-Z]{3}-[A-Z]{3})-\d{8}(\/[A-Z]{3}-[A-Z]{3}-\d{8})?/.exec(l)).find(Boolean);
  if (f) return { key: `flight:${f[2] ? 'round' : 'oneway'}:${f[1]}`, scope: 'day' };
  if (post.daangnLinks.length || post.affiliate?.length) return { key: `deal:${normUrl(post.daangnLinks[0] ?? post.links[0])}`, scope: 'day' };
  return { key: `source:${normUrl(post.links.at(-1), true)}`, scope: 'forever' };
}
export function duplicateTopic({ post, ledger, topics, now = new Date() }) {
  const { key, scope } = topicOf(post);
  for (const hash of new Set(topics.filter(t => t.key === key && t.hash !== post.hash).map(t => t.hash))) {
    const last = new Map();
    for (const e of ledger) if (e.key?.endsWith(`:${hash}`)) last.set(e.key, e);
    const at = [...last.values()].filter(e => e.state === 'attempted' || e.state === 'done').map(e => e.at).sort().at(-1);
    if (at && (scope === 'forever' || kstDay(at) === kstDay(now))) return { code: 'QUICKFACT_DUPLICATE_TOPIC', topic: key, of: hash, at };
  }
  return null;
}
export function topicsRead(file = TOPICS) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function topicWrite(post, file = TOPICS) {
  if (topicsRead(file).some(t => t.hash === post.hash)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), hash: post.hash, key: topicOf(post).key }) + '\n');
}
// Registers the topic of posts that went out before the lint existed (only those the ledger shows as attempted or done).
export function seedTopics({ file }) {
  const ledger = ledgerRead();
  return parsePosts(readFileSync(file, 'utf8')).map(post => {
    const seeded = ledger.some(e => e.key?.endsWith(`:${post.hash}`) && (e.state === 'attempted' || e.state === 'done'));
    if (seeded) topicWrite(post);
    return { hash: post.hash, topic: topicOf(post).key, seeded };
  });
}

function runDaangn(input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(PLAYBOOK, 'scripts', 'daangn-cafe.mjs'), 'publish-one'], { cwd: PLAYBOOK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => { const line = out.trim().split('\n').pop() || ''; try { resolve({ code, j: JSON.parse(line) }); } catch { resolve({ code, j: null }); } });
    child.on('error', () => resolve({ code: 1, j: null }));
    child.stdin.end(JSON.stringify(input));
  });
}

// Threads goes through the official Graph API (owner 2026-10-05 "공식 api부터 쓰자"); SNS_THREADS_WRITER=web keeps the
// older web-session writer.
// True when any journal file of this Threads run key exists, i.e. a request may have been sent.
export function threadsJournalStarted(journalDir, runKey) {
  try { return readdirSync(journalDir).some(f => f.startsWith(`threads.${runKey}.`)); } catch { return true; }
}
export const threadsWriter = (env = process.env) => (env.SNS_THREADS_WRITER === 'web' ? 'web' : 'graph');

// The Graph API takes images only as public URLs Meta fetches itself. The same images were just posted on X, so their
// pbs.twimg.com URLs (read back from the owner's own timeline) serve as the source; [] when that is not available.
// A just-posted tweet can take longer than 8 s to show its photos on the timeline (2026-10-06: 3 photos were readable
// 16 s later, after the post had already gone out with one image), so wait up to ~30 s.
export async function xImageUrlsFor(xResult, count, { readMedia = null, sleepImpl = ms => new Promise(r => setTimeout(r, ms)), attempts = 6, waitMs = 5000 } = {}) {
  const rootId = xResult?.ok ? String(xResult.ids?.[0] ?? '') : '';
  if (!count || !/^\d{10,25}$/.test(rootId)) return [];
  const read = readMedia ?? (await import('../../social-actions/x-media-reader.mjs')).readXMedia;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeline = await read('lifehack__ailab').catch(() => null);
    const urls = (timeline?.items?.find(item => item.id === rootId)?.media ?? []).filter(m => m.type === 'photo' && m.url)
      .map(m => { const u = new URL(m.url); return u.hostname === 'pbs.twimg.com' ? `${u.origin}${u.pathname}?name=large` : null; }).filter(Boolean);
    if (urls.length === count) return urls;
    if (attempt < attempts - 1) await sleepImpl(waitMs);
  }
  return [];
}

// Fallback public image host for the Threads Graph API when the X copy is not readable (a reply without timeline media,
// 2026-10-05): the Inpock editor's own uploader (anonymous POST upload-image.inpock.co.kr/upload → images/…webp, served
// from its CloudFront). Threads accepted the WebP (container FINISHED, live reply DeGumgpGT8u).
export async function inpockImageUrls(images, { fetchImpl = globalThis.fetch } = {}) {
  const urls = [];
  for (const image of images.slice(0, 4)) {
    const form = new FormData();
    form.append('file', new Blob([image.bytes], { type: image.mimeType }), image.filename ?? 'image');
    const r = await fetchImpl('https://upload-image.inpock.co.kr/upload', { method: 'POST', body: form,
      headers: { origin: 'https://link.inpock.co.kr', referer: 'https://link.inpock.co.kr/' }, signal: AbortSignal.timeout(30000) });
    const path = (await r.json().catch(() => null))?.data;
    const m = /^images\/(.+)\.(?:png|jpe?g|webp|gif|avif)$/i.exec(String(path ?? ''));
    if (r.status !== 200 || !m) return [];
    urls.push(`https://d13k46lqgoj3d6.cloudfront.net/${m[1]}.webp`);
  }
  return urls;
}

// True only when every journal entry of this Threads run is a 200 photo upload or a closed request, no entry carries a
// created-post checkpoint, and the last entry is a configure route the service answered with HTTP 4xx; that entry is
// then reconciled as not created (evidence: the status and the sanitized provider reason).
export async function closeRefusedThreadsImageConfigure(journalDir, runKey, error) {
  if (!existsSync(journalDir)) return false;
  const files = readdirSync(journalDir).filter(f => f.startsWith(`threads.${runKey}.`)).sort();
  if (!files.length) return false;
  const read = f => readFileSync(path.join(journalDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const all = files.map(f => ({ f, events: read(f) }));
  if (all.some(({ events }) => events.some(e => e.type === 'checkpoint'))) return false;
  const last = all.at(-1);
  const intent = last.events.find(e => e.type === 'intent'), result = last.events.find(e => e.type === 'result');
  if (!/\/api\/v1\/media\/configure_text_post_app_(sidecar|feed)\/$/.test(intent?.request?.url ?? '')) return false;
  if (!(result?.outcome === 'response' && result.httpStatus >= 400 && result.httpStatus < 500)) return false;
  if (`THREADS_HTTP_${result.httpStatus}` !== error.code) return false;
  if (all.slice(0, -1).some(({ events }) => { const i = events.find(e => e.type === 'intent'), r = events.find(e => e.type === 'result');
    return !/\/rupload_igphoto\//.test(i?.request?.url ?? '') || r?.httpStatus !== 200; })) return false;
  await reconcileIntent({ file: path.join(journalDir, last.f), result: { outcome: 'reconciled_not_posted',
    evidence: `image configure answered HTTP ${result.httpStatus} with no created-post checkpoint${error.detail ? ` (${error.detail})` : ''}; posted text-only under ${runKey}-noimg` } });
  return true;
}

async function sendOne(channel, post, { board, layout = null, journalDir, threadsTopic = null, telegramClient = null, telegramAttempt = 1, images = [], xResult = null }) {
  if (channel === 'daangn') fail('QUICKFACT_DAANGN_CHANNEL_FORBIDDEN');
  if (!QUICKFACT_CHANNELS.includes(channel)) fail('QUICKFACT_CHANNEL_INVALID');
  const runKey = channel === 'telegram' && telegramAttempt > 1
    ? `qf-${channel}-${post.hash}-retry-${telegramAttempt - 1}` : `qf-${channel}-${post.hash}`;
  if (channel === 'telegram') {
    const client = telegramClient ?? await createDefaultTelegramChannelClient({ journalDir });
    const text = buildTelegramText(post);
    if (!images.length) {
      const sent = await client.sendMessage(text, { runKey, linkPreview: true });
      const messageId = sent.messageId || sent.result?.message_id || null;
      return { ok: Boolean(messageId), ids: messageId ? [String(messageId)] : [], url: sent.publicUrl ?? null, messageId: messageId ? String(messageId) : null };
    }
    const { caption, followUp } = telegramCaptionPlan(text);
    const sent = images.length === 1
      ? await client.sendPhoto(images[0], { runKey, caption })
      : await client.sendMediaGroup(images.map((image, index) => ({ type: 'photo', media: image,
        ...(index === 0 && caption ? { caption } : {}) })), { runKey });
    const ids = [...(sent.messageIds ?? (sent.messageId ? [sent.messageId] : []))].map(String);
    let url = sent.publicUrls?.[0] ?? sent.publicUrl ?? null;
    if (followUp) {
      const continuation = await client.sendMessage(followUp, { runKey, linkPreview: true });
      const followUpId = continuation.messageId || continuation.result?.message_id || null;
      if (followUpId) ids.push(String(followUpId));
      url ||= continuation.publicUrl ?? null;
    }
    return { ok: ids.length > 0, ids, url, messageId: ids[0] ?? null };
  }
  if (channel === 'x') {
    const r = await publishThread(buildXText(post, board, { layout }), { runKey, journalDir, longPostAllowed: true, ...(images.length ? { images } : {}) });
    return { ok: r.readbackVerified, ids: r.ids, url: r.permalinks[0], readback: r.readbacks };
  }
  if (channel === 'threads') {
    // Threads topic (tag_header, Codex writer change 2026-09-30) on the first post only; replies stay untagged.
    const posts = buildThreadsText(post, board, { layout });
    const topic = threadsTopicFor(board, threadsTopic, post);
    let graphFallback = null;
    if (threadsWriter() === 'graph') {
      let imageUrls = images.length ? await xImageUrlsFor(xResult, images.length) : [];
      if (images.length && !imageUrls.length) imageUrls = await inpockImageUrls(images).catch(() => []);
      if (!images.length || imageUrls.length) {
        try {
          const r = await publishChainGraph(posts, { runKey, journalDir, imageUrls, topic });
          return { ok: r.readbackVerified, ids: r.ids, url: r.permalinks[0], readback: r.readback, writer: 'graph', ...(r.notes ? { notes: r.notes } : {}) };
        } catch (error) {
          // Only a failure before the first publish request may move to the web writer; anything later needs reconcile.
          if (!error.notSent) throw error;
          graphFallback = error.code || 'THREADS_GRAPH_FAILED';
        }
      } else graphFallback = 'X_IMAGE_URLS_UNAVAILABLE';
    }
    // Web writer: its multi-image sidecar is refused (400, 2026-10-05), so it carries the first image only.
    const webImages = graphFallback ? images.slice(0, 1) : images;
    const topicOption = topic ? { topic: posts.map((_, i) => (i === 0 ? topic : null)) } : {};
    let r, imageFallback = null;
    try {
      r = await publishChain(posts, { runKey, journalDir, transport: sendTransport,
        ...(webImages.length ? { images: webImages, allowTopicMedia: graphFallback ? true : process.env.SNS_THREADS_IMAGES === 'on' } : {}),
        ...topicOption });
    } catch (error) {
      // 2026-10-17 (box tick 11:00 KST held the bot): an image configure the service refused with HTTP 4xx, before any
      // post of this chain was created, is a definite "not created" (same rule as a 4xx Graph publish). Close that
      // journal entry and post the same text without images under its own run key, so the post still goes out.
      const refused = webImages.length && /^THREADS_HTTP_4\d\d$/.test(error?.code ?? '')
        ? await closeRefusedThreadsImageConfigure(journalDir, runKey, error) : false;
      if (!refused) throw error;
      imageFallback = { code: error.code, ...(error.detail ? { detail: error.detail } : {}) };
      r = await publishChain(posts, { runKey: `${runKey}-noimg`, journalDir, transport: sendTransport, ...topicOption });
    }
    let readback = null;
    try { readback = await readThreadsPostsById(r.ids); } catch (e) { readback = { error: e.code || e.message }; }
    return { ok: Boolean(r.ids?.length), ids: r.ids, url: r.permalinks?.[0], readback, writer: 'web', ...(graphFallback ? { graphFallback } : {}),
      ...(imageFallback ? { imageFallback } : {}) };
  }
  if (!BOARDS[board]) fail('QUICKFACT_BOARD_UNKNOWN');
  const daangn = buildDaangn(post);
  const { j } = await runDaangn({ boardCategoryId: BOARDS[board], title: daangn.title, paragraphs: daangn.paragraphs });
  const url = j?.postSlug ? `https://cafe.daangn.com/saenghwal-ideug/posts/${encodeURIComponent(j.postSlug)}` : null;
  let readback = null;
  if (url) readback = await publicReadback(url, daangn);
  return { ok: Boolean(url) && readback?.verified === true, url, result: j?.result ?? null, code: j?.code ?? null, writeAttempted: j?.writeAttempted === true, readback };
}

// Read-only: where each channel of each post stands (ledger state, URL, and for X/Threads the journal's last request
// outcome), so an "attempted" channel can be judged before anyone decides to retry.
export function status({ file, channels = ['x', 'threads'] }) {
  assertQuickFactChannels(channels);
  const posts = parsePosts(readFileSync(file, 'utf8'));
  const ledger = ledgerRead();
  const journalDir = defaultJournalDir();
  return posts.map(post => ({ hash: post.hash, first: post.body[0].slice(0, 40), channels: Object.fromEntries(channels.map(channel => {
    if (channel === 'daangn' && daangnSkipReason(post)) return [channel, { state: null, at: null, url: null, journal: null, verdict: 'skipped_partner_link_post' }];
    const entries = ledger.filter(e => e.key === `${channel}:${post.hash}`);
    const last = entries.at(-1) ?? null;
    let journal = null;
    if (channel !== 'daangn') {
      const files = existsSync(journalDir) ? readdirSync(journalDir).filter(f => channel === 'telegram'
        ? new RegExp(`^telegram\\.qf-telegram-${post.hash}(?:-retry-\\d+)?\\.`).test(f)
        : f.startsWith(`${channel}.qf-${channel}-${post.hash}.`)).sort() : [];
      journal = files.map(f => {
        const lines = readFileSync(path.join(journalDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const result = lines.find(l => l.type === 'result'), checkpoint = lines.find(l => l.type === 'checkpoint');
        return { file: f, httpStatus: result?.httpStatus ?? null, outcome: result?.outcome ?? 'no_result', created: Boolean(checkpoint),
          permalink: checkpoint?.checkpoint?.permalink ?? checkpoint?.checkpoint?.publicUrls?.[0] ?? null };
      });
    }
    const verdict = !last ? 'not_attempted' : last.state === 'done' ? 'posted'
      : channel === 'telegram' && journal?.some(j => j.created) ? 'created_unreconciled'
      : channel === 'telegram' && journal?.some(j => ['response', 'uncertain'].includes(j.outcome)) ? 'attempted_unresolved'
      // No journal file means the writer failed before its first request (e.g. X AUTH_THROTTLED on the session check).
      : journal && journal.length === 0 ? 'attempted_no_request_sent'
      : journal && journal.length && journal.every(j => !j.created) && journal.every(j => j.httpStatus !== 200) ? 'attempted_no_create_recorded_check_the_app'
      : 'attempted_unresolved';
    return [channel, { state: last?.state ?? null, at: last?.at ?? null, url: last?.url ?? null, journal, verdict }];
  })) }));
}

export function xRefusedTopLevel(journalFile) {
  const lines = readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  // A known_error without a created-ID checkpoint, including HTTP 200,
  // cannot prove non-creation. Keep the compatibility reader fail-closed.
  void lines;
  return false;
}

// Records a checked outcome for an "attempted" channel so the next run may send it again (not_posted) or treats it as
// done (posted). Needs the evidence text (who checked what, when); the attempted entry and its journal stay as they are.
export async function reconcile({ file, channel, outcome, evidence, url = null }) {
  assertQuickFactChannels([channel]);
  if (!['not_posted', 'posted'].includes(outcome)) fail('QUICKFACT_RECONCILE_OUTCOME_INVALID');
  if (typeof evidence !== 'string' || evidence.trim().length < 10) fail('QUICKFACT_RECONCILE_EVIDENCE_REQUIRED');
  const results = [];
  const journalDir = defaultJournalDir();
  for (const post of parsePosts(readFileSync(file, 'utf8'))) {
    const key = `${channel}:${post.hash}`;
    const last = ledgerRead().filter(e => e.key === key).at(-1)?.state;
    if (!['attempted', 'reconciled_not_posted'].includes(last)) { results.push({ key, skipped: `STATE_${last ?? 'NONE'}` }); continue; }
    // The writer journal keeps its own lock on an unresolved request; close it through its reconcileIntent API.
    const closed = [];
    if (channel === 'telegram' && existsSync(journalDir)) {
      for (const f of readdirSync(journalDir).filter(n => new RegExp(`^telegram\\.qf-telegram-${post.hash}(?:-retry-\\d+)?\\.`).test(n)).sort()) {
        await reconcileTelegramIntent({ file: path.join(journalDir, f), outcome, evidence: evidence.trim(), url });
        closed.push(f);
      }
    } else if (channel !== 'daangn' && existsSync(journalDir)) {
      for (const f of readdirSync(journalDir).filter(n => n.startsWith(`${channel}.qf-${channel}-${post.hash}.`)).sort()) {
        try { await reconcileIntent({ file: path.join(journalDir, f), result: { outcome: `reconciled_${outcome}`, evidence: evidence.trim() } }); closed.push(f); }
        catch (e) {
          if (e.code === 'SNS_JOURNAL_ALREADY_RESOLVED') continue;
          throw e;
        }
      }
    }
    if (last === 'attempted') ledgerWrite({ key, state: outcome === 'posted' ? 'done' : 'reconciled_not_posted', evidence: evidence.trim(), ...(url ? { url } : {}) });
    results.push({ key, recorded: outcome, journalClosed: closed });
  }
  return results;
}

export async function run({ file, channels = ['x', 'threads'], board = 'life', layout = null, dryRun = false, allowDuplicate = false, threadsTopic = null,
  telegramDailyCap = DEFAULT_TELEGRAM_DAILY_CAP, telegramClient = null, images = [], ledgerFile = LEDGER, topicsFile = TOPICS,
  now = () => new Date(), inpockQueueFile = ledgerFile === LEDGER ? INPOCK_QUEUE : null, productImageUrl = null,
  isStopped = null, postChannel = sendOne, recallGate = recallGateFor }) {
  assertQuickFactChannels(channels);
  if (!Number.isInteger(telegramDailyCap) || telegramDailyCap < 0 || telegramDailyCap > 1000) fail('QUICKFACT_TELEGRAM_DAILY_CAP_INVALID');
  const imageAssets = normalizeQuickFactImageAssets(images);
  const imageHashes = imageAssets.map(image => image.sha256);
  const posts = parsePosts(readFileSync(file, 'utf8'));
  if (posts.some(post => Boolean(post.daily) !== (board === 'daily'))) fail('QUICKFACT_DAILY_BOARD_MISMATCH');
  const journalDir = defaultJournalDir();
  const report = [];
  let batchStopCode = null;
  const readStop = async () => {
    if (dryRun || typeof isStopped !== 'function') return null;
    try { return await isStopped() === true ? 'X_WRITE_GATE_STOPPED' : null; }
    catch { return 'PUBLISH_STOP_CHECK_FAILED'; }
  };
  const markSkippedChannels = (item, fromIndex, code) => {
    item.batchAborted = { code, notSent: true };
    for (const channel of channels.slice(fromIndex)) {
      item.channels[channel] = { ok: false, skipped: code, notSent: true };
    }
  };
  for (const post of posts) {
    // Warn-only marketing-copy advisories (marketing-copy-ontology.v1.json); they never block a write.
    const item = { hash: post.hash, advisories: (() => { try { return lintPost(post); } catch { return []; } })(), channels: {} };
    if (batchStopCode) {
      markSkippedChannels(item, 0, batchStopCode);
      report.push(item);
      continue;
    }
    const stoppedBeforePost = await readStop();
    if (stoppedBeforePost) {
      batchStopCode = stoppedBeforePost;
      markSkippedChannels(item, 0, stoppedBeforePost);
      report.push(item);
      continue;
    }
    const duplicate = duplicateTopic({ post, ledger: ledgerRead(ledgerFile), topics: topicsRead(topicsFile) });
    if (duplicate && !allowDuplicate) {
      item.duplicate = duplicate;
      for (const channel of channels) item.channels[channel] = { skipped: 'DUPLICATE_TOPIC' };
      report.push(item);
      continue;
    }
    let recall = null;
    if (post.affiliate.length) {
      try { recall = await recallGate(post); }
      catch { recall = { status: 'review', matches: [], reasons: [{ code: 'RECALL_CHECK_UNAVAILABLE' }], assessment: 'unknown' }; }
      if (!['clear', 'review', 'block'].includes(recall?.status)) recall = { status: 'review', matches: [], reasons: [{ code: 'RECALL_CHECK_UNAVAILABLE' }], assessment: 'unknown' };
    }
    if (recall && recall.status !== 'clear') {
      item.recall = { status: recall.status, matches: recall.matches?.slice(0, 3) ?? [], reasons: recall.reasons ?? [], assessment: recall.assessment ?? null };
      for (const channel of channels) item.channels[channel] = { ok: false, skipped: `RECALL_${recall.status.toUpperCase()}`, notSent: true };
      report.push(item);
      continue;
    }
    for (const [channelIndex, channel] of channels.entries()) {
      const stoppedBeforeChannel = await readStop();
      if (stoppedBeforeChannel) {
        batchStopCode = stoppedBeforeChannel;
        markSkippedChannels(item, channelIndex, stoppedBeforeChannel);
        break;
      }
      if (channel === 'daangn' && daangnSkipReason(post)) { item.channels[channel] = { skipped: daangnSkipReason(post) }; continue; }
      if (!dryRun && channel === 'threads' && imageAssets.length && threadsWriter() === 'web' && process.env.SNS_THREADS_IMAGES !== 'on') {
        item.channels[channel] = { skipped: 'THREADS_IMAGES_VERIFICATION_REQUIRED', imageHashes };
        continue;
      }
      const telegramImageError = channel === 'telegram' ? imageAssets.map(telegramImageValidationError).find(Boolean) : null;
      if (!dryRun && telegramImageError) { item.channels[channel] = { skipped: telegramImageError, imageHashes }; continue; }
      const key = `${channel}:${post.hash}`;
      const prior = ledgerRead(ledgerFile).filter(e => e.key === key);
      const last = prior.at(-1)?.state;
      if (last === 'attempted' || last === 'done') { item.channels[channel] = { skipped: last === 'done' ? 'ALREADY_DONE' : 'ATTEMPT_UNRESOLVED_RECONCILE_FIRST' }; continue; }
      try {
        const threadTopicPreview = channel === 'threads' ? threadsTopicFor(board, threadsTopic, post) : null;
        const preview = channel === 'x' ? buildXText(post, board, { layout }) : channel === 'threads' ? buildThreadsText(post, board, { layout })
          : channel === 'telegram' ? buildTelegramText(post) : buildDaangn(post);
        if (dryRun) { item.channels[channel] = { dryRun: true, preview, ...(channel === 'x' ? { weight: preview.map(xWeight) } : {}),
          ...(channel === 'threads' ? { topic: threadTopicPreview } : {}),
          ...(channel === 'telegram' ? { dailyCap: telegramDailyCap } : {}),
          ...(imageAssets.length ? { images: { imageHashes,
            ...(channel === 'x' ? { uploadPlans: imageAssets.map(buildXImageUploadPlan), attachTo: 'root_post' } : {}),
            ...(channel === 'threads' ? { attachTo: 'root_post', uploadRoute: 'https://www.threads.com/rupload_igphoto/<entity>',
              configureRoute: imageAssets.length > 1 ? 'https://www.threads.com/api/v1/media/configure_text_post_app_sidecar/'
                : 'https://www.threads.com/api/v1/media/configure_text_post_app_feed/',
              configureContentType: imageAssets.length > 1 ? 'text/plain;charset=UTF-8' : 'application/x-www-form-urlencoded;charset=UTF-8',
              topicTagHeader: threadTopicPreview ? { display_text: threadTopicPreview } : null,
              featureGate: { name: 'SNS_THREADS_IMAGES', enabled: process.env.SNS_THREADS_IMAGES === 'on' } } : {}),
            ...(channel === 'telegram' ? { method: imageAssets.length === 1 ? 'sendPhoto' : 'sendMediaGroup',
              ...telegramCaptionPlan(buildTelegramText(post)), attachTo: 'root_post',
              validations: imageAssets.map(image => ({ imageSha256: image.sha256, valid: telegramImageValidationError(image) === null,
                ...(telegramImageValidationError(image) ? { code: telegramImageValidationError(image) } : {}) })) } : {}) } } : {}) }; continue; }
        assertNotHeld(file);
        if (channel === 'telegram') {
          let release = null;
          try {
            const client = telegramClient ?? await createDefaultTelegramChannelClient({ journalDir });
            await client.channel();
            release = acquireTelegramDailyLock(now(), ledgerFile);
            if (!release) { item.channels[channel] = { skipped: 'TELEGRAM_DAILY_LOCKED' }; continue; }
            if (telegramDailyCount(ledgerRead(ledgerFile), now()) >= telegramDailyCap) {
              item.channels[channel] = { skipped: 'TELEGRAM_DAILY_CAP_REACHED', dailyCap: telegramDailyCap };
              continue;
            }
            const stoppedBeforeWrite = await readStop();
            if (stoppedBeforeWrite) {
              batchStopCode = stoppedBeforeWrite;
              markSkippedChannels(item, channelIndex, stoppedBeforeWrite);
              break;
            }
            topicWrite(post, topicsFile);
            ledgerWrite({ key, state: 'attempted', ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
            const telegramAttempt = prior.filter(entry => entry.state === 'reconciled_not_posted').length + 1;
            const result = await postChannel(channel, post, { board, layout, journalDir, threadsTopic, telegramClient: client, telegramAttempt, images: imageAssets });
            ledgerWrite({ key, state: result.ok ? 'done' : 'attempted', url: result.url ?? null,
              ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
            item.channels[channel] = result;
            if (result.ok && inpockQueueFile) try { enqueueFromPost(productImageUrl ? { ...post, image: productImageUrl } : post, { queueFile: inpockQueueFile }); } catch { /* best effort */ }
          } catch (e) {
            if (e.code === 'X_WRITE_GATE_STOPPED') {
              if (channel === 'x' && e.receipt?.writeSent === false) {
                ledgerWrite({ key, state: 'reconciled_not_posted', evidence: `local X write gate refused before any send (${e.code})`,
                  ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
                item.channels[channel] = { ok: false, code: e.code, notSent: true };
              } else item.channels[channel] = { ok: false, code: e.code, uncertain: true };
              batchStopCode = e.code;
              markSkippedChannels(item, channelIndex + 1, e.code);
            } else item.channels[channel] = { ok: false, code: e.code || e.message };
          }
          finally { release?.(); }
          if (batchStopCode) break;
          continue;
        }
        // Text that cannot be built is a definite "not sent": checked before the ledger records an attempt, so it never
        // holds the bot as an unclear write.
        try { if (channel === 'x') buildXText(post, board, { layout }); else if (channel === 'threads') buildThreadsText(post, board, { layout }); }
        catch (e) { item.channels[channel] = { ok: false, code: e.code || e.message, notSent: true }; continue; }
        const stoppedBeforeWrite = await readStop();
        if (stoppedBeforeWrite) {
          batchStopCode = stoppedBeforeWrite;
          markSkippedChannels(item, channelIndex, stoppedBeforeWrite);
          break;
        }
        topicWrite(post, topicsFile);
        ledgerWrite({ key, state: 'attempted', ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
        const result = await postChannel(channel, post, { board, layout, journalDir, threadsTopic, images: imageAssets, xResult: item.channels.x ?? null });
        // Which Threads writer posted, and why the Graph API (the one that can post several images) was not used.
        ledgerWrite({ key, state: result.ok ? 'done' : 'attempted', url: result.url ?? null,
          ...(imageHashes.length ? { imageHashes } : {}), ...(result.writer ? { writer: result.writer } : {}),
          ...(result.graphFallback ? { graphFallback: result.graphFallback } : {}), ...(result.imageFallback ? { imageFallback: result.imageFallback } : {}) }, ledgerFile);
        item.channels[channel] = result;
        // Owner 2026-10-05: partner links of posted deals are collected for the Inpock link page (inpock-links.mjs).
        // Only the real ledger feeds the real queue, so test runs never queue a card.
        if (result.ok && inpockQueueFile) try { enqueueFromPost(productImageUrl ? { ...post, image: productImageUrl } : post, { queueFile: inpockQueueFile }); } catch { /* the queue is best effort */ }
      } catch (e) {
        // STOP aborts every remaining channel in this run. WAIT remains channel-local when its receipt proves no send.
        if (e.code === 'X_WRITE_GATE_STOPPED') {
          if (channel === 'x' && e.receipt?.writeSent === false) {
            ledgerWrite({ key, state: 'reconciled_not_posted', evidence: `local X write gate refused before any send (${e.code})`,
              ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
            item.channels[channel] = { ok: false, code: e.code, notSent: true };
          } else item.channels[channel] = { ok: false, code: e.code, uncertain: true };
          batchStopCode = e.code;
          markSkippedChannels(item, channelIndex + 1, e.code);
        } else if (e.code === 'X_WRITE_GATE_WAIT' && e.receipt?.writeSent === false) {
          ledgerWrite({ key, state: 'reconciled_not_posted', evidence: `local X write gate refused before any send (${e.code})`,
            ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
          item.channels[channel] = { ok: false, code: e.code, notSent: true };
        } else if (channel === 'x' && e.code === 'SESSION_LOCK_BUSY') {
          // The X session lock is taken before any request, so nothing was sent. 2026-10-08: posting Threads and Telegram
          // anyway left a partial post that held the worker twice; now the whole post waits for the next cycle.
          ledgerWrite({ key, state: 'reconciled_not_posted', evidence: 'X session lock busy before any send (SESSION_LOCK_BUSY)',
            ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
          item.channels[channel] = { ok: false, code: e.code, notSent: true };
          // Only this post's later channels; no batchAborted, which the worker reads as a STOP and exits on.
          for (const rest of channels.slice(channelIndex + 1)) item.channels[rest] = { ok: false, skipped: e.code, notSent: true };
          break;
        } else if (channel === 'threads' && e.code === 'THREADS_READ_BUDGET_WAIT' && !threadsJournalStarted(journalDir, `qf-threads-${post.hash}`)) {
          // The shared Threads read budget refused before any request of this post was journaled (2026-10-06 15:03: the
          // 로마 post held the bot although nothing reached Threads), so it is a definite "not posted".
          ledgerWrite({ key, state: 'reconciled_not_posted', evidence: `Threads read budget refused before any journaled request (${e.code})`,
            ...(imageHashes.length ? { imageHashes } : {}) }, ledgerFile);
          item.channels[channel] = { ok: false, code: e.code, notSent: true };
        } else item.channels[channel] = { ok: false, code: e.code || e.message, ...(e.detail ? { detail: String(e.detail).slice(0, 300) } : {}) };
      }
      if (batchStopCode) break;
    }
    report.push(item);
  }
  return report;
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const file = arg('file');
  if (!file) fail('QUICKFACT_FILE_REQUIRED');
  const channels = (arg('channels') || 'x,threads').split(',');
  assertQuickFactChannels(channels);
  if (process.argv.includes('--reconcile')) {
    console.log(JSON.stringify(await reconcile({ file: path.resolve(file), channel: arg('channel'), outcome: arg('outcome'), evidence: arg('evidence'), url: arg('url') ?? null }), null, 2));
    return;
  }
  if (process.argv.includes('--status')) { console.log(JSON.stringify(status({ file: path.resolve(file), channels }), null, 2)); return; }
  if (process.argv.includes('--seed-topics')) { console.log(JSON.stringify(seedTopics({ file: path.resolve(file) }), null, 2)); return; }
  const imageFiles = arg('images');
  const images = imageFiles === undefined ? [] : readQuickFactImages(imageFiles);
  const capArg = arg('telegram-daily-cap');
  console.log(JSON.stringify(await run({ file: path.resolve(file), channels, board: arg('board') || 'life', layout: arg('layout') ?? null, dryRun: process.argv.includes('--dry-run'),
    allowDuplicate: process.argv.includes('--allow-duplicate-topic'), threadsTopic: arg('threads-topic') ?? null,
    telegramDailyCap: capArg === undefined ? DEFAULT_TELEGRAM_DAILY_CAP : Number(capArg), images }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
