// Mirror a published Naver adaptive run to the 당근 카페 (생활이득 AI연구소) as text.
// Usage: node mirror-daangn.mjs --run=<run dir> [--dry-run]
//
// 1. Requires final-verification.json published_verified (Naver is the source revision).
// 2. Picks the board from research/content-store/publication-channels.json by the Naver category (and the brief's
//    event kind); a board whose daangnWritable is false stops here with DAANGN_BOARD_NOT_ENABLED.
// 3. Uses <run>/daangn.json, the short 당근 version the drafting agent wrote (fromDaangnVersion), when it exists.
//    Otherwise converts document.json to a title and at most 40 paragraphs: images, videos and captions are dropped, tables become
//    one line per row, callout/summary/quote keep their text, affiliate links (naver.me 커넥트, 쿠팡) are dropped, and
//    no link back to the Naver blog is added.
// 4. Sends it once through the canonical writer (web-api-playbook scripts/daangn-cafe.mjs publish-one: membership
//    preflight, full-feed exact-title check, journal, one create, feed and public readback) and writes
//    <run>/daangn-mirror.json. A verified receipt is never sent again.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNotHeld } from './publish-hold.mjs';
import { lintDaangnInformation } from './daangn-information-policy.mjs';
import { reserveDailyDaangnShare } from './daangn-daily-share-limit.mjs';

const HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { webApiPlaybookRoot } from '../adapters/web-auth-provider.mjs';
const PLAYBOOK = webApiPlaybookRoot();
const CHANNELS = path.resolve(HUB, '../naver-blog-api/research/content-store/publication-channels.json');
const readJson = f => JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const fail = code => { throw Object.assign(new Error(code), { code }); };
// title: the server refuses 51+ characters ("제목이 너무 길어요. 51자보다 짧게 작성해주세요.", 2026-09-25).
const LIMITS = { paragraphs: 40, chars: 4000, bytes: 24000, title: 50 };

// A Naver title over the limit keeps its part before "｜" and as many comma-separated parts after it as fit.
export function shortTitle(title, max = LIMITS.title) {
  const len = s => [...s].length;
  if (len(title) <= max) return title;
  const [head, ...rest] = title.split('｜');
  let out = head.trim();
  if (len(out) > max) return [...out].slice(0, max - 1).join('') + '…';
  const parts = rest.join('｜').split(',').map(p => p.trim()).filter(Boolean);
  for (const [i, p] of parts.entries()) { const next = `${out}${i === 0 ? '｜' : ', '}${p}`; if (len(next) > max) break; out = next; }
  return out;
}
const AFFILIATE = /(^|\.)naver\.me$|(^|\.)myrealt\.rip$|(^|\.)link\.coupang\.com$|(^|\.)coupa\.ng$|(^|\.)linkprice\.com$|(^|\.)lpweb\.kr$/i;
const plain = s => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/==(.+?)==/g, '$1').replace(/\r/g, '').trim();

export function routeFor({ categoryId, eventKind }, channels = readJson(CHANNELS)) {
  const routes = channels.routes.filter(r => r.naverCategoryId === categoryId);
  return routes.find(r => (r.eventKinds || []).includes(eventKind)) ?? routes.find(r => !r.eventKinds?.length) ?? null;
}

// Same rule as the Tistory mirror: 커넥트 links go to the seller page they were declared for, and the 커넥트 disclosure
// line is dropped because no affiliate link is carried over.
export const CONNECT_DISCLOSURE = /네이버 (?:여행|쇼핑) ?커넥트 활동의 일환으로|쿠팡 ?파트너스 활동의 일환으로|마이리얼트립 파트너 활동의 일환으로|링크프라이스 제휴 활동의 일환으로/;
export function sellerLinked(doc, plan) {
  const affiliate = plan?.affiliate?.links || [];
  const sellerUrl = id => { const s = (plan?.sources || []).find(x => x.id === id); if (!s) fail('AFFILIATE_SOURCE_MISSING'); return s.publicUrl || s.url; };
  return { ...doc, blocks: (doc.blocks || []).filter(b => !(['paragraph', 'notice'].includes(b.type) && CONNECT_DISCLOSURE.test(String(b.text || ''))))
    .map(b => { const a = b.type === 'link' && affiliate.find(x => x.url === b.url); return a ? { ...b, url: sellerUrl(a.sourceId) } : b; }) };
}

// 링크프라이스 on the 네이버 카페 text mirror (owner 2026-09-27: "당근이랑 네이버카페에도 제휴링크 넣어"): the channel is its own
// LinkPrice site (네이버 카페 A100708124), so a LinkPrice link is kept with that site id and its disclosure stays; other
// networks go to the seller page. 당근 no longer takes any partner link (owner 2026-10-01: "앞으로 당근에는 파트너 링크
// 나가야하는거 아예주지말고, 정보성 도메인만 미러링해라"), so it has no site id here and its paths strip every network.
export const LINKPRICE_SITES = Object.freeze({ naver: 'A100708014', tistory: 'A100708029', naverCafe: 'A100708124' });
export const LINKPRICE_DISCLOSURE = '이 포스팅은 링크프라이스 제휴 활동의 일환으로 판매 발생 시 수수료를 제공받습니다.';
const LINKPRICE_CLICK = /^https:\/\/click\.linkprice\.com\/click\.php\?m=[a-z0-9_]+&a=(A\d{6,12})&l=9999&l_cd1=3&l_cd2=0&tu=[^&\s]+$/;
const TOSS_LINK = /^https:\/\/toss\.shopping\/_m\/[A-Za-z0-9]{6,12}$/;
export const OTHER_NETWORK_DISCLOSURE = /네이버 (?:여행|쇼핑) ?커넥트 활동의 일환으로|쿠팡 ?파트너스 활동의 일환으로|마이리얼트립 파트너 활동의 일환으로/;
export const ANY_NETWORK_DISCLOSURE = /네이버 (?:여행|쇼핑) ?커넥트 활동의 일환으로|쿠팡 ?파트너스 활동의 일환으로|마이리얼트립 파트너 활동의 일환으로|링크프라이스 제휴 활동의 일환으로|토스쇼핑 쉐어링크 활동의 일환으로/;
export function linkpriceFor(url, site) {
  if (!LINKPRICE_SITES[site] || !LINKPRICE_CLICK.test(String(url))) fail('LINKPRICE_LINK_INVALID');
  return String(url).replace(/&a=A\d{6,12}&/, `&a=${LINKPRICE_SITES[site]}&`);
}
export const isChannelLinkprice = (url, site) => LINKPRICE_CLICK.exec(String(url))?.[1] === LINKPRICE_SITES[site];
export const isPartnerUrl = url => { try { return AFFILIATE.test(new URL(url).hostname) || TOSS_LINK.test(String(url)) || LINKPRICE_CLICK.test(String(url)); } catch { return false; } };
// A run with a declared partner link is an ad post: it never goes to 당근 (informational posts only).
export const hasPartnerLinks = plan => (plan?.affiliate?.links || []).length > 0;

// 당근 gets no partner link of any network: every declared link goes to the seller page, a Toss 쉐어링크 (its source is an API
// URL with no page to show) is dropped, and every network's disclosure line goes with them.
function daangnLinked(doc, plan) {
  const affiliate = plan?.affiliate?.links || [];
  const sellerUrl = id => { const s = (plan?.sources || []).find(x => x.id === id); if (!s) fail('AFFILIATE_SOURCE_MISSING'); return s.publicUrl || s.url; };
  const declared = b => b.type === 'link' && affiliate.find(x => x.url === b.url);
  return { ...doc, blocks: (doc.blocks || []).filter(b => !(['paragraph', 'notice'].includes(b.type) && ANY_NETWORK_DISCLOSURE.test(String(b.text || ''))))
    .filter(b => { const a = declared(b); return !(a && a.network === 'toss_sharelink' || b.type === 'link' && isPartnerUrl(b.url) && !a); })
    .map(b => { const a = declared(b); return a ? { ...b, url: sellerUrl(a.sourceId) } : b; }) };
}
// 쿠팡 파트너스 links stay as issued on the 네이버 카페 (owner 2026-10-09: "카페에도 쿠팡 링크 붙여"), with their disclosure.
export const COUPANG_DISCLOSURE_TEXT = /쿠팡 ?파트너스 활동의 일환으로/;
const CHANNEL_KEEPS_COUPANG = new Set(['naverCafe']);
export function channelLinked(doc, plan, site) {
  if (site === 'daangn') return daangnLinked(doc, plan);
  const affiliate = plan?.affiliate?.links || [];
  const sellerUrl = id => { const s = (plan?.sources || []).find(x => x.id === id); if (!s) fail('AFFILIATE_SOURCE_MISSING'); return s.publicUrl || s.url; };
  const lp = a => a.network === 'linkprice' || plan?.affiliate?.network === 'linkprice' && !a.network;
  const cp = a => CHANNEL_KEEPS_COUPANG.has(site) && (a.network === 'coupang_partners' || plan?.affiliate?.network === 'coupang_partners' && !a.network);
  // Partner links sit in link blocks and, since 2026-10-01, in banner image hrefs.
  const target = b => b.type === 'link' ? b.url : b.type === 'image' && typeof b.href === 'string' ? b.href : undefined;
  const used = a => (doc.blocks || []).some(b => target(b) === a.url);
  const keepsLinkprice = affiliate.some(a => lp(a) && used(a));
  const keepsCoupang = affiliate.some(a => cp(a) && used(a));
  const dropNotice = t => (OTHER_NETWORK_DISCLOSURE.test(t) && !(keepsCoupang && COUPANG_DISCLOSURE_TEXT.test(t) && !/커넥트|마이리얼트립/.test(t)))
    || !keepsLinkprice && /링크프라이스 제휴 활동의 일환으로/.test(t);
  const mapped = a => lp(a) ? linkpriceFor(a.url, site) : a.network === 'toss_sharelink' || cp(a) ? a.url : sellerUrl(a.sourceId);
  return { ...doc, blocks: (doc.blocks || []).filter(b => !(['paragraph', 'notice'].includes(b.type) && dropNotice(String(b.text || ''))))
    // 토스쇼핑 쉐어링크 links stay as issued: 당근 and 네이버 카페 are registered Sharelink channels (2026-09-28), and the
    // Toss disclosure (not in OTHER_NETWORK_DISCLOSURE) stays with them.
    .map(b => { const a = affiliate.find(x => x.url === target(b)); if (!a) return b;
      return b.type === 'link' ? { ...b, url: mapped(a) } : { ...b, href: mapped(a) }; }) };
}

// A drafted short version links products by their page: a product declared with a 링크프라이스 link gets that link with
// the channel's site id, and the disclosure goes right under the first line (네이버 카페 only; 당근 takes no partner link).
export function withChannelLinkprice(version, plan, site) {
  if (!LINKPRICE_SITES[site]) return version;
  const lp = (plan?.affiliate?.links || []).filter(a => a.network === 'linkprice' || plan.affiliate.network === 'linkprice' && !a.network);
  if (!lp.length || !Array.isArray(version?.lines)) return version;
  const pagesOf = a => { const s = (plan.sources || []).find(x => x.id === a.sourceId); return s ? [...new Set([s.url, s.publicUrl].filter(Boolean))] : []; };
  let used = false;
  const lines = version.lines.map(l => {
    if (typeof l !== 'string') return l;
    let out = l;
    for (const a of lp) for (const page of pagesOf(a)) if (out.includes(page)) { out = out.split(page).join(linkpriceFor(a.url, site)); used = true; }
    return out;
  });
  if (!used || lines.some(l => typeof l === 'string' && /링크프라이스 제휴 활동의 일환으로/.test(l))) return { ...version, lines };
  return { ...version, lines: [lines[0], LINKPRICE_DISCLOSURE, ...lines.slice(1)] };
}

const linkAllowed = url => { try { const u = new URL(url); return u.protocol === 'https:' && !isPartnerUrl(url) && u.hostname !== 'blog.naver.com'; } catch { return false; } };

// **x** and ==x== in the Naver text become bold runs; everything else is plain.
export function toRuns(s, { bold = false } = {}) {
  const runs = [];
  for (const part of String(s ?? '').replace(/\r/g, '').split(/(\*\*.+?\*\*|==.+?==)/g).filter(Boolean)) {
    const m = /^(?:\*\*(.+)\*\*|==(.+)==)$/.exec(part);
    runs.push({ text: m ? (m[1] ?? m[2]) : part, bold: bold || Boolean(m) });
  }
  return runs;
}
// One table row as one line. Two columns: "▪ 상품: 값". Three or more: "▪ 상품 — 열2 값 · 열3 값" so the header stays readable.
export function tableLine(columns, row) {
  const cells = row.map(plain);
  if (cells.length <= 2) return `▪ ${cells[0]}${cells[1] ? `: ${cells[1]}` : ''}`;
  return `▪ ${cells[0]} — ${cells.slice(1).map((c, i) => `${plain(columns[i + 1] ?? '')} ${c}`.trim()).join(' · ')}`;
}

// document.json → blocks the 당근 renderer shows well (observed 2026-09-25): paragraph text keeps its line breaks
// (white-space: pre-wrap) and bold renders per run, but there are no heading, list or table blocks. So each heading
// starts one block with a bold heading line and its section below it; tables become one line per row; links sit on
// their own line under their label (URLs are auto-linked, no label is possible).
export function toDaangnPost(document) {
  const title = shortTitle(plain(document.title));
  if (!title || [...title].length > LIMITS.title) fail('DAANGN_TITLE_INVALID');
  const src = document.blocks || [], out = [];
  let sourceLinkAdded = false;
  let cur = null;
  const flush = () => { if (cur?.length) out.push(cur); cur = null; };
  const add = (runs, { own = false } = {}) => {
    if (own) { flush(); out.push(runs); return; }
    if (!cur) cur = [];
    // Right under a heading one line break; between parts of a section a blank line.
    const underHeading = cur.length === 1 && cur[0].bold && cur[0].text.startsWith('■ ');
    if (cur.length) cur.push({ text: underHeading ? '\n' : '\n\n', bold: false });
    cur.push(...runs);
  };
  src.forEach((b, i) => {
    if (b.type === 'paragraph' && b.presentation === 'caption' && ['image', 'video'].includes(src[i - 1]?.type)) return;
    switch (b.type) {
      case 'notice': add([{ text: `📌 ${plain(b.text)}`, bold: false }], { own: true }); break;
      case 'heading': flush(); cur = [{ text: `■ ${plain(b.text)}`, bold: true }]; break;
      case 'paragraph': add(toRuns(b.text)); break;
      case 'quote': add([{ text: `“${plain(b.text)}”`, bold: false }]); break;
      case 'callout': add([...(b.title ? [{ text: `💡 ${plain(b.title)}\n`, bold: true }] : [{ text: '💡 ', bold: false }]), ...toRuns(b.text)]); break;
      case 'summary': add([{ text: `✅ ${plain(b.title || '한눈에 요약')}\n`, bold: true }, { text: (b.items || []).map(x => `· ${plain(x)}`).join('\n'), bold: false }]); break;
      case 'bulleted': case 'numbered': add([{ text: (b.items || []).map((x, n) => `${b.type === 'numbered' ? `${n + 1}.` : '·'} ${plain(x)}`).join('\n'), bold: false }]); break;
      case 'table': add([{ text: (b.rows || []).map(r => tableLine(b.columns || [], r)).join('\n'), bold: false }]); break;
      case 'link': {
        if (!linkAllowed(b.url)) break;
        let internalDaangn = false;
        try { internalDaangn = /(^|\.)daangn\.com$/i.test(new URL(b.url).hostname); } catch { break; }
        if (!internalDaangn && sourceLinkAdded) break;
        if (!internalDaangn) sourceLinkAdded = true;
        const label = plain(b.label || b.url);
        add([{ text: `🔗 ${label}\n${b.url}`, bold: false }]);
        break;
      }
      default: break; // image, video, divider, spacer
    }
  });
  flush();
  // Merge adjacent plain text runs, then keep within the writer's limits (4,000 characters a block, 40 blocks).
  let blocks = out.map(runs => runs.reduce((a, r) => { const last = a.at(-1); if (last && last.bold === r.bold) last.text += r.text; else a.push({ ...r }); return a; }, []))
    .map(runs => runs.filter(r => r.text));
  const text = runs => runs.map(r => r.text).join('');
  blocks = blocks.flatMap(runs => {
    if ([...text(runs)].length <= LIMITS.chars) return [runs];
    const parts = []; let acc = [];
    for (const r of runs.flatMap(r => r.text.split(/(?<=\n)/).map(t => ({ ...r, text: t })))) {
      if ([...text([...acc, r])].length > LIMITS.chars && acc.length) { parts.push(acc); acc = []; }
      acc.push(r);
    }
    if (acc.length) parts.push(acc);
    return parts;
  });
  while (blocks.length > LIMITS.paragraphs) { const last = blocks.pop(); blocks[blocks.length - 1].push({ text: '\n\n', bold: false }, ...last); }
  const paragraphs = blocks.map(text).map(t => t.trim());
  if (paragraphs.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0) > LIMITS.bytes) fail('DAANGN_BODY_TOO_LARGE');
  if (!paragraphs.length) fail('DAANGN_BODY_EMPTY');
  return { title, paragraphs, blocks: blocks.map(runs => ({ runs })) };
}

// The 당근 version the drafting agent writes next to document.json (owner decision 2026-09-26, "A"): popular 당근 posts
// put one short line in each paragraph block with no links (daangn-reference-scout.mjs style cards), which a conversion
// of the Naver document cannot produce. daangn.json = {title, lines:[...]}: one line per block, **bold** allowed,
// no new facts (every number must appear in document.json), links within VERSION_LIMITS and none affiliate or Naver blog.
// Links back into 당근 itself (a 당근 인기글 roundup's 원문 links, owner 2026-09-26) stay inside the app and are
// counted separately from outside links.
// Deal and notice posts keep one seller or official link per item (owner 2026-09-26: "링크 다 빠졌어"), each on its own
// 🔗 line; affiliate and Naver blog links stay forbidden.
export const VERSION_LIMITS = { minLines: 6, maxLines: 40, lineChars: 90, links: 10, daangnLinks: 12 };
const isDaangnLink = u => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'cafe.daangn.com'; } catch { return false; } };
const numbersIn = s => (String(s).replace(/https?:\/\/\S+/g, ' ').match(/\d[\d,.]*/g) || []).map(n => n.replace(/[,.]+$/, '').replace(/,/g, ''));
export function documentText(document) {
  const parts = [document.title];
  const walk = v => { if (typeof v === 'string') parts.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(document.blocks || []);
  return parts.join('\n');
}
export function fromDaangnVersion(version, document) {
  const title = plain(version?.title);
  if (!title || [...title].length > LIMITS.title) fail('DAANGN_VERSION_TITLE_INVALID');
  if (!Array.isArray(version.lines)) fail('DAANGN_VERSION_SCHEMA');
  // An entry {"image": "images/<file>"} places an owned image between lines (e.g. each package's route map under its
  // section, owner 2026-09-26 "장가계도 지도 넣어주고"); "image" at the top level opens the post.
  const imagePath = p => { if (typeof p !== 'string' || !/^images\/[\w.-]+\.(png|jpe?g)$/i.test(p)) fail('DAANGN_VERSION_IMAGE_INVALID'); return p; };
  const entries = version.lines.map(l => (l && typeof l === 'object' && !Array.isArray(l)) ? { image: imagePath(l.image) } : String(l ?? '').replace(/\r?\n/g, ' ').trim())
    .filter(Boolean);
  const lines = entries.filter(e => typeof e === 'string');
  if (lines.length < VERSION_LIMITS.minLines || lines.length > VERSION_LIMITS.maxLines) fail('DAANGN_VERSION_LINE_COUNT');
  const urls = lines.flatMap(l => l.match(/https?:\/\/\S+/g) || []);
  const inside = urls.filter(isDaangnLink), outside = urls.filter(u => !isDaangnLink(u));
  if (outside.length > VERSION_LIMITS.links || inside.length > VERSION_LIMITS.daangnLinks || urls.some(u => !linkAllowed(u))) fail('DAANGN_VERSION_LINK_NOT_ALLOWED');
  if (lines.some(l => [...plain(l.replace(/https?:\/\/\S+/g, ''))].length > VERSION_LIMITS.lineChars)) fail('DAANGN_VERSION_LINE_TOO_LONG');
  // No partner link (any network) and no network disclosure: 당근 carries informational posts only (owner 2026-10-01).
  if (lines.some(l => ANY_NETWORK_DISCLOSURE.test(l))) fail('DAANGN_AFFILIATE_TEXT_REMAINS');
  const known = new Set(numbersIn(documentText(document)));
  const unknown = [...new Set(numbersIn([title, ...lines].join('\n')))].filter(n => !known.has(n));
  if (unknown.length) fail(`DAANGN_VERSION_NUMBER_NOT_IN_DOCUMENT:${unknown.slice(0, 5).join(',')}`);
  const blocks = lines.map(l => ({ runs: toRuns(l) }));
  const paragraphs = blocks.map(b => b.runs.map(r => r.text).join('').trim());
  if (paragraphs.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0) > LIMITS.bytes) fail('DAANGN_BODY_TOO_LARGE');
  // One owned image (e.g. the travel route map) goes first, as in popular 당근 travel posts; the writer uploads it
  // (update-one image upload verified live 2026-09-26). It must be a PNG/JPEG under the run's images/ folder.
  const image = version.image != null ? imagePath(version.image) : null;
  const sequence = [...(image ? [{ type: 'image', path: image }] : []),
    ...entries.map(e => (typeof e === 'string' ? { type: 'paragraph', runs: toRuns(e) } : { type: 'image', path: e.image }))];
  const images = sequence.filter(s => s.type === 'image').map(s => s.path);
  if (images.length > 5) fail('DAANGN_VERSION_TOO_MANY_IMAGES');
  return { title, paragraphs, blocks, image, images, sequence, source: 'daangn.json' };
}

// The 당근 author comment (owner 2026-09-28: "앞으로도 댓글로 보충"): what the body cannot hold — items past its 10 outside
// links — goes in one comment by the author right after the post, drafted as daangn.json "comment": {"lines": [...]}.
// Same rules as the body: numbers from document.json only, no partner link of any network, no network disclosure, no blog links.
export const COMMENT_LIMITS = { chars: 4000, lines: 60, links: 20 };
export function commentFromVersion(version, document) {
  if (version?.comment == null) return null;
  if (!Array.isArray(version.comment.lines) || !version.comment.lines.length || version.comment.lines.length > COMMENT_LIMITS.lines) fail('DAANGN_COMMENT_SCHEMA');
  const lines = version.comment.lines.map(l => plain(String(l ?? '').replace(/\r?\n/g, ' ')));
  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!content || [...content].length > COMMENT_LIMITS.chars) fail('DAANGN_COMMENT_TOO_LONG');
  const urls = content.match(/https?:\/\/\S+/g) || [];
  if (urls.length > COMMENT_LIMITS.links || urls.some(u => !linkAllowed(u))) fail('DAANGN_COMMENT_LINK_NOT_ALLOWED');
  if (ANY_NETWORK_DISCLOSURE.test(content)) fail('DAANGN_AFFILIATE_TEXT_REMAINS');
  const known = new Set(numbersIn(documentText(document)));
  const unknown = [...new Set(numbersIn(content))].filter(n => !known.has(n));
  if (unknown.length) fail(`DAANGN_COMMENT_NUMBER_NOT_IN_DOCUMENT:${unknown.slice(0, 5).join(',')}`);
  return { content, links: urls.length, firstLine: lines.find(Boolean) };
}

function runCommentWriter(input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(PLAYBOOK, 'scripts', 'daangn-cafe.mjs'), 'comment-one'], { cwd: PLAYBOOK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => { const line = out.trim().split('\n').pop() || ''; try { resolve({ code, j: JSON.parse(line) }); } catch { resolve({ code, j: null }); } });
    child.on('error', () => resolve({ code: 1, j: null }));
    child.stdin.end(JSON.stringify(input));
  });
}

// Sends the author comment once for a verified mirror post. The writer's own readback can miss a fresh comment (observed
// 2026-09-28: sent, readback timed out, the public page showed it); a sent comment is then settled from the public page.
export async function postComment(runDir, { commentWriter = runCommentWriter, fetchImpl = globalThis.fetch, waitMs = 5000 } = {}) {
  const f = n => path.join(runDir, n);
  if (!existsSync(f('daangn.json'))) return null;
  const comment = commentFromVersion(readJson(f('daangn.json')), readJson(f('document.json')));
  if (!comment) return null;
  const receipt = readJson(f('daangn-mirror.json'));
  if (receipt.result !== 'public_readback_verified' || !receipt.postSlug) fail('DAANGN_COMMENT_POST_NOT_VERIFIED');
  const out = f('daangn-comment.json');
  if (existsSync(out)) {
    const prev = readJson(out);
    if (['comment_readback_verified', 'public_readback_verified', 'duplicate_skipped'].includes(prev.result)) return { ok: true, alreadyDone: true, ...prev };
    if (prev.writeAttempted) fail('DAANGN_COMMENT_PREVIOUS_WRITE_UNRESOLVED');
  }
  const { j } = await commentWriter({ postSlug: receipt.postSlug, expectedTitle: receipt.title, content: comment.content });
  const res = { schemaVersion: 1, checkedAt: new Date().toISOString(), postSlug: receipt.postSlug, url: receipt.url, links: comment.links, chars: [...comment.content].length,
    result: j?.result ?? null, code: j?.code ?? null, writeAttempted: j?.writeAttempted === true, journalStatus: j?.journalStatus ?? null };
  if (res.result === 'needs_reconciliation' && res.writeAttempted) {
    res.writerResult = res.result;
    const lines = comment.content.split('\n').map(l => l.trim()).filter(Boolean);
    let last = { verified: false };
    for (let i = 0; i < 3 && !last.verified; i++) {
      if (waitMs) await new Promise(r => setTimeout(r, waitMs));
      try {
        const r = await fetchImpl(receipt.url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36' } });
        const html = (await r.text()).replace(/\\"/g, '"').replace(/&amp;/g, '&').replace(/\\n/g, '\n');
        const found = lines.filter(l => html.includes(l.slice(0, 30))).length;
        last = { checkedAt: new Date().toISOString(), method: 'anonymous public post page', httpStatus: r.status, linesFound: `${found}/${lines.length}`, verified: r.status === 200 && found === lines.length };
      } catch { last = { verified: false, error: 'FETCH_FAILED' }; }
    }
    res.reconciliation = last;
    if (last.verified) res.result = 'public_readback_verified';
  }
  writeFileSync(out, JSON.stringify(res, null, 2) + '\n');
  return { ok: ['comment_readback_verified', 'public_readback_verified', 'duplicate_skipped'].includes(res.result), ...res };
}

function runWriter(input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(PLAYBOOK, 'scripts', 'daangn-cafe.mjs'), 'publish-one'], { cwd: PLAYBOOK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => { const line = out.trim().split('\n').pop() || ''; try { resolve({ code, j: JSON.parse(line) }); } catch { resolve({ code, j: null }); } });
    child.on('error', () => resolve({ code: 1, j: null }));
    child.stdin.end(JSON.stringify(input));
  });
}

export async function mirror(runDir, { dryRun = false, writer = runWriter, commentWriter = runCommentWriter, channels = undefined, fetchImpl = globalThis.fetch, waitMs = 5000, dailyShare = reserveDailyDaangnShare } = {}) {
  const f = n => path.join(runDir, n);
  const fv = readJson(f('final-verification.json'));
  if (fv.status !== 'published_verified') fail('NAVER_NOT_VERIFIED');
  const receiptFile = f('daangn-mirror.json');
  if (existsSync(receiptFile)) {
    const prev = readJson(receiptFile);
    // A verified post whose author comment is still missing gets the comment now (never the post again).
    if (prev.result === 'public_readback_verified') {
      const comment = dryRun ? null : await postComment(runDir, { commentWriter, fetchImpl, waitMs });
      return { ok: comment ? comment.ok : true, alreadyDone: true, ...prev, ...(comment ? { comment } : {}) };
    }
    if (prev.result === 'duplicate_skipped') return { ok: true, alreadyDone: true, ...prev };
    if (prev.writeAttempted) fail('DAANGN_PREVIOUS_WRITE_UNRESOLVED');
  }
  const job = readJson(f('job-publish.json'));
  let quickFactDomain = null;
  if (existsSync(f('quickfact-brief.json'))) quickFactDomain = readJson(f('quickfact-brief.json')).domain ?? null;
  if (quickFactDomain === 'A') return { ok: true, skipped: true, code: 'DAANGN_DEAL_DOMAIN_FORBIDDEN', naverLogNo: fv.logNo };
  if (quickFactDomain && !['D', 'E', 'F'].includes(quickFactDomain)) fail('DAANGN_QUICKFACT_DOMAIN_INVALID');
  let eventKind = null; try { eventKind = readJson(path.join(runDir, '..', 'article-brief.json')).eventKind ?? null; } catch { /* not from an event brief */ }
  const route = routeFor({ categoryId: job.publishSettings?.categoryId, eventKind }, channels);
  if (!route) fail('DAANGN_ROUTE_MISSING');
  // A route the owner keeps off 당근 (e.g. AI posts) is a decision, not a pending board.
  if (route.daangnSkip) return { ok: true, skipped: true, code: 'DAANGN_ROUTE_SKIPPED', route: route.id, reason: route.daangnSkip, naverLogNo: fv.logNo };
  const plan = existsSync(f('gate-plan.json')) ? readJson(f('gate-plan.json')) : null;
  // A post with partner links is an ad post, and 당근 takes informational posts only (owner 2026-10-01).
  if (hasPartnerLinks(plan)) return { ok: true, skipped: true, code: 'DAANGN_ROUTE_SKIPPED', route: route.id, reason: '파트너 링크가 있는 글은 당근에 올리지 않음(정보성 글만)', naverLogNo: fv.logNo };
  const document = readJson(f('document.json'));
  const post = existsSync(f('daangn.json')) ? fromDaangnVersion(readJson(f('daangn.json')), document)
    : { ...toDaangnPost(channelLinked(document, plan, 'daangn')), source: 'converted' };
  if (post.paragraphs.some(p => ANY_NETWORK_DISCLOSURE.test(p) || (p.match(/https?:\/\/\S+/g) || []).some(isPartnerUrl))) fail('DAANGN_AFFILIATE_TEXT_REMAINS');
  if ((post.images || []).some(p => !existsSync(f(p)))) fail('DAANGN_VERSION_IMAGE_MISSING');
  const input = post.images?.length
    ? { boardCategoryId: route.daangnBoardId, title: post.title, sourceLogNo: String(fv.logNo),
      blocks: post.sequence.map(s => (s.type === 'image' ? { type: 'image', path: f(s.path) } : { type: 'paragraph', value: { runs: s.runs } })) }
    : { boardCategoryId: route.daangnBoardId, title: post.title, paragraphs: post.blocks, sourceLogNo: String(fv.logNo) };
  const summary = { naverLogNo: fv.logNo, board: route.daangnBoard, boardCategoryId: route.daangnBoardId, title: post.title, source: post.source, images: post.images ?? [], paragraphs: post.paragraphs.length,
    bytes: post.paragraphs.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0) };
  // The author comment is checked before the post is sent, so a bad comment never leaves a half-mirrored post.
  const comment = existsSync(f('daangn.json')) ? commentFromVersion(readJson(f('daangn.json')), document) : null;
  if (comment) summary.comment = { links: comment.links, chars: [...comment.content].length };
  lintDaangnInformation({ domain: quickFactDomain, title: post.title, paragraphs: post.paragraphs, comments: comment ? [comment.content] : [], requireOneSource: true });
  if (!route.daangnWritable) return { ok: false, code: 'DAANGN_BOARD_NOT_ENABLED', ...summary };
  if (dryRun) return { ok: true, dryRun: true, ...summary, preview: post.paragraphs.slice(0, 3) };
  const reservation = await dailyShare({ runId: String(job.runId ?? job.jobId ?? ('naver-' + fv.logNo)), now: new Date(), limit: 1 });
  if (!reservation?.allowed) return { ok: true, skipped: true, code: reservation?.code || 'DAANGN_DAILY_LIMIT_REACHED', ...summary };
  const { j } = await writer(input);
  const url = j?.postSlug ? `https://cafe.daangn.com/saenghwal-ideug/posts/${encodeURIComponent(j.postSlug)}` : null;
  const receipt = { schemaVersion: 1, checkedAt: new Date().toISOString(), ...summary, dailyReservationId: reservation.reservationId ?? null,
    dailyReservationJournalId: reservation.journalId ?? null, writerJournalId: j?.journalId ?? null, result: j?.result ?? null, code: j?.code ?? null,
    writeAttempted: j?.writeAttempted === true, journalStatus: j?.journalStatus ?? null, postSlug: j?.postSlug ?? null, url,
    actionSuccess: j?.requestSummary?.actionSuccess ?? null, actionFailureReason: j?.requestSummary?.actionFailureReason ?? null,
    actionResultKeys: j?.requestSummary?.actionResultKeys ?? null, responseBytes: j?.requestSummary?.responseBytes ?? null };
  // The writer's readback runs within ~1.5 s and can miss a post on a board it has not written before (observed
  // 2026-09-25 twice). When the create action itself succeeded with a slug, the public post page settles it.
  if (receipt.result === 'needs_reconciliation' && receipt.actionSuccess === true && receipt.postSlug) {
    receipt.writerResult = receipt.result;
    receipt.reconciliation = await publicReadback(url, post, { fetchImpl, waitMs });
    if (receipt.reconciliation.verified) receipt.result = 'public_readback_verified';
  }
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  const posted = j?.ok === true || receipt.result === 'public_readback_verified';
  if (!(posted && comment && receipt.result === 'public_readback_verified')) return { ok: posted, ...receipt };
  const commentResult = await postComment(runDir, { commentWriter, fetchImpl, waitMs });
  return { ok: commentResult.ok, ...receipt, comment: commentResult };
}

// Anonymous read of the public post: HTTP 200, the exact title, and every paragraph's opening in order of the page.
export async function publicReadback(url, post, { fetchImpl = globalThis.fetch, waitMs = 5000, attempts = 3 } = {}) {
  let last = { verified: false };
  for (let i = 0; i < attempts; i++) {
    if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36' } });
      const html = (await res.text()).replace(/\\"/g, '"').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const lines = post.paragraphs.flatMap(p => p.split('\n').map(l => l.trim()).filter(Boolean));
      const found = lines.filter(l => html.replace(/\\n/g, '\n').includes(l.slice(0, 40))).length;
      last = { checkedAt: new Date().toISOString(), method: 'anonymous public post page', httpStatus: res.status, titleFound: html.includes(post.title),
        paragraphsFound: `${found}/${lines.length} lines`, verified: res.status === 200 && html.includes(post.title) && found === lines.length };
      if (last.verified) return last;
    } catch { last = { verified: false, error: 'FETCH_FAILED' }; }
  }
  return last;
}

async function main() {
  const runDir = process.argv.find(a => a.startsWith('--run='))?.slice(6);
  if (!runDir) fail('RUN_REQUIRED');
  if (!process.argv.includes('--dry-run') && !process.argv.includes('--check')) assertNotHeld(runDir);
  // --check: validate <run>/daangn.json against document.json before publishing (used by the drafting agent).
  if (process.argv.includes('--check')) {
    const plan = existsSync(path.join(runDir, 'gate-plan.json')) ? readJson(path.join(runDir, 'gate-plan.json')) : null;
    if (hasPartnerLinks(plan)) { console.log(JSON.stringify({ ok: true, skipped: true, code: 'DAANGN_ROUTE_SKIPPED', reason: 'partner-link run: 당근 gets informational posts only, do not write daangn.json' })); return; }
    const briefFile = path.join(runDir, 'quickfact-brief.json');
    const quickFactDomain = existsSync(briefFile) ? readJson(briefFile).domain ?? null : null;
    if (quickFactDomain === 'A') { console.log(JSON.stringify({ ok: true, skipped: true, code: 'DAANGN_DEAL_DOMAIN_FORBIDDEN' })); return; }
    if (quickFactDomain && !['D', 'E', 'F'].includes(quickFactDomain)) fail('DAANGN_QUICKFACT_DOMAIN_INVALID');
    const version = readJson(path.join(runDir, 'daangn.json')), document = readJson(path.join(runDir, 'document.json'));
    const post = fromDaangnVersion(version, document);
    const comment = commentFromVersion(version, document);
    lintDaangnInformation({ domain: quickFactDomain, title: post.title, paragraphs: post.paragraphs, comments: comment ? [comment.content] : [], requireOneSource: true });
    console.log(JSON.stringify({ ok: true, title: post.title, lines: post.paragraphs.length, preview: post.paragraphs.slice(0, 3),
      ...(comment ? { comment: { links: comment.links, chars: [...comment.content].length } } : {}) }));
    return;
  }
  // --comment: send the author comment of an already verified post (e.g. after an in-place update added overflow items).
  if (process.argv.includes('--comment')) { console.log(JSON.stringify(await postComment(path.resolve(runDir)) ?? { ok: true, code: 'DAANGN_NO_COMMENT' })); return; }
  console.log(JSON.stringify(await mirror(path.resolve(runDir), { dryRun: process.argv.includes('--dry-run') })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message || 'DAANGN_MIRROR_FAILED' })); process.exitCode = 1; });
