// Partner links → Inpock link page (owner 2026-10-05: "나오는 파트너스링크 들 거기에 수집해서 저장할거니까 준비해라").
// Every posted deal with a partner link (쿠팡 파트너스, 토스 쉐어링크, 네이버 쇼핑/여행 커넥트, 마이리얼트립) is queued once, and
// `publish` adds it as a public link card on https://link.inpock.co.kr/lifehack__ailab through the web-api-playbook Inpock
// publisher (DPAPI login `inpock-login`; owner check, write-once journal per source, management + anonymous readback).
//   node inpock-links.mjs status | publish [--limit=5] [--dry-run] | backfill --file=<quick-fact post file> [--title=…]
// Queue and results live in %LOCALAPPDATA%\affiliate-content-operations\inpock\ (no secrets).
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = path.join(process.env.LOCALAPPDATA ?? '.', 'affiliate-content-operations', 'inpock');
export const QUEUE = path.join(DIR, 'queue.jsonl'), RESULTS = path.join(DIR, 'results.jsonl');
import { webApiPlaybookRoot } from '../adapters/web-auth-provider.mjs';
const PLAYBOOK = webApiPlaybookRoot();
export const OWNER = 'lifehack__ailab';
export const PARTNER_HOST = /^(link\.coupang\.com|toss\.shopping|toss\.im|naver\.me|myrealt\.rip)$/;
import { isFood as defaultIsFood } from '../../naver-blog-api/research/content-store/food-classifier.mjs';
const rows = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const kstDate = iso => new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' }).replace(/\.\s?/g, '/').replace(/\/$/, '');

// Card title: the post's first line without emoji or links, with the posting date, at most 150 characters (Inpock limit).
export function cardTitle(line, at = new Date().toISOString()) {
  const plain = String(line).replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F✱]/gu, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const suffix = ` (${kstDate(at)})`;
  return (plain.length + suffix.length > 150 ? plain.slice(0, 150 - suffix.length - 1) + '…' : plain) + suffix;
}

// Every card is a partner link, so its title opens with the ad mark (ontology gap audit 2026-10-05 ONT-01: the cards had
// no disclosure; 공정위 추천·보증 심사지침 asks for it next to the recommendation itself).
export const AD_PREFIX = '[광고]';
export const withAdPrefix = title => String(title).startsWith(AD_PREFIX) ? String(title) : `${AD_PREFIX}${title}`.slice(0, 150);
// Owner 2026-10-05 "카테고리별로 분류해놔 식료품, 패키지 등등": each card title starts with its category.
export const PAGE_ORDER = Object.freeze(['여행·패키지', '투어·입장권', '뷰티', '육아', '생활용품', '디지털', '기타', '식료품']);
const PUBLISH_ORDER = [...PAGE_ORDER].reverse();
// The product name decides the category; the post text only marks travel. Non-food words are checked before the food
// list (2026-10-05 backfill: a La Roche-Posay balm, a diffuser and a toner were filed under 식료품 from the post text).
export function categoryOf(post, url, { isFood = () => false, product = null, foodCategory = null } = {}) {
  const text = [...(post.body ?? []), ...(post.reply?.body ?? [])].join(' ');
  const name = product ?? productNameOf(post) ?? post.body?.[0] ?? '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (host === 'myrealt.rip') return '투어·입장권';
  if (/✈|항공|패키지|여행|호텔|숙소|리조트|왕복|편도|출발일/.test(text)) return '여행·패키지';
  if (foodCategory === true) return '식료품';
  // Order matters: 화장지 is not 화장품, 쿠키앤크림 쉐이크 is food, 키즈샴푸 is a kids' product.
  if (/화장지|휴지|세제|섬유유연제|디퓨저|방향제|수납|청소|주방|칫솔|치약/.test(name)) return '생활용품';
  if (/쉐이크|프로틴|단백질|초콜릿|엠앤엠|캔디|젤리|사탕|인절미|도시락김|곱창김|조미김|커피|블랙|전복|해산물/.test(name)) return '식료품';
  if (/키즈|유아|아기|베이비|베베|기저귀|분유/.test(name)) return '육아';
  if (/샴푸|크림|밤\b|선크림|선케어|패치|로션|토너|세럼|화장품|립|쿠션|라로슈포제|클렌|바디워시|향수|앰플|마스크팩/.test(name)) return '뷰티';
  if (/물티슈/.test(name)) return '생활용품';
  if (/이어폰|버즈|충전|보조배터리|노트북|태블릿|모니터|케이블|스피커|키보드|마우스/.test(name)) return '디지털';
  if (isFood(name) || /두유|우유|과자|약과|치즈|라면|생수|소시지|오일|떡|빙수|두부|키위|오징어|당근|쌀|김치|고기|닭|계란|과일|견과|토마토/.test(name)) return '식료품';
  return '기타';
}

// Product name from a quick-fact deal post: the line "<상품>, <판매처> 9,990원…이 최저가예요" (bot format) or a first line that
// names the product before its price. null when the post never names it (the Toss API title is used then).
export function productNameOf(post) {
  const lines = [...(post.body ?? []), ...(post.reply?.body ?? [])].map(l => String(l).replace(/[\u{1F000}-\u{1FAFF}☀-➿️✱]/gu, '').trim());
  for (const l of lines) {
    // The separator is ", " (comma + space); "8,760원" has no space after its comma.
    const m = /^(.+?),\s+(?:쿠팡[^,]*|토스쇼핑|네이버[^,]*)?\s*[\d,]+원.*최저가예요/.exec(l)
      ?? /^((?:쿠팡 반짝세일|쿠팡 골드박스)\s+.+?)\s+[\d,]+원\(/.exec(l);
    if (m) return m[1].replace(/^쿠팡 (?:반짝세일|골드박스)\s+/, '').replace(/\s+/g, ' ').trim();
  }
  const first = lines[0] ?? '';
  const m = /짜리\s+(.+?),\s*(?:토스|쿠팡|네이버)/.exec(first) ?? /^(.+?)(?:가|이)\s*(?:토스쇼핑|쿠팡|네이버)[^ ]*에선/.exec(first);
  return m ? m[1].trim() : null;
}
const storeOf = url => { try { const h = new URL(url).hostname; return h === 'link.coupang.com' ? '쿠팡' : /toss/.test(h) ? '토스쇼핑' : h === 'naver.me' ? '네이버' : h === 'myrealt.rip' ? '마이리얼트립' : null; } catch { return null; } };

export function partnerLinksOf(post) {
  // Standalone link lines and links inside text lines (the 2026-10-05 Okinawa post had "…44,900원 https://myrealt.rip/…").
  const inline = [...(post.body ?? []), ...(post.reply?.body ?? [])].flatMap(l => String(l).match(/https?:\/\/\S+/g) ?? []);
  return [...new Set([...(post.links ?? []), ...(post.reply?.links ?? []), ...inline].filter(u => { try { return PARTNER_HOST.test(new URL(u).hostname); } catch { return false; } }))];
}

// Same block split, line handling and hash as quick-fact parsePosts, without its posting rules: posts that went out under
// older rules (e.g. a flight link next to partner links) still map to their ledger entry.
export function lenientPosts(text) {
  const DAANGN = /^(?:당근|상품 페이지)\s*:\s*(https?:\/\/\S+)$/;
  return String(text).replace(/\r/g, '').split(/^\s*---\s*$/m).map(b => b.trim()).filter(Boolean).map(block => {
    const daangn = block.split('\n').map(l => l.trim()).map(l => DAANGN.exec(l)?.[1]).filter(Boolean);
    block = block.split('\n').filter(l => !DAANGN.test(l.trim())).join('\n');
    const [mainPart, replyPart = ''] = block.split(/^\s*\+\+\+\s*$/m);
    const split = part => { const lines = part.split('\n').map(l => l.trim()).filter(Boolean); const links = lines.filter(l => /^https?:\/\/\S+$/.test(l));
      return { lines, links, body: lines.filter(l => !links.includes(l) && !/^#\S/.test(l)) }; };
    const main = split(mainPart), reply = split(replyPart);
    return { body: main.body, links: main.links, reply: reply.lines.length ? { body: reply.body, links: reply.links } : null,
      hash: createHash('sha256').update([...main.lines, '+++', ...reply.lines, ...daangn.map(l => `당근:${l}`)].join('\n')).digest('hex').slice(0, 20) };
  });
}

// Called by quick-fact after a post is done on some channel. One card per partner link (owner: "여러개 나갔으면 각각으로"):
// a link already queued from an earlier post is not queued again.
export function enqueueFromPost(post, { at = new Date().toISOString(), queueFile = QUEUE, isFood = defaultIsFood, productNames = {}, foodLinks = new Set(), productImages = {} } = {}) {
  const links = partnerLinksOf(post);
  if (!links.length) return [];
  mkdirSync(path.dirname(queueFile), { recursive: true });
  const seen = new Set(rows(queueFile).map(r => r.id));
  const added = [];
  for (const url of links) {
    const id = createHash('sha256').update(url).digest('hex').slice(0, 24);
    if (seen.has(id)) continue;
    seen.add(id);
    // Card title = "[카테고리] 상품명 · 판매처 (날짜)": prices go stale on a link page, so they stay out of the title.
    const product = productNames[url] ?? productNameOf(post);
    const category = categoryOf(post, url, { isFood, product, foodCategory: foodLinks.has(url) ? true : null });
    const label = product ? `${product}${storeOf(url) ? ` · ${storeOf(url)}` : ''}` : (post.body?.[0] ?? '');
    const image = /^https:\/\//.test(String(productImages[url] ?? post.image ?? '')) ? (productImages[url] ?? post.image) : null;
    const item = { id, at, url, category, product, image, title: cardTitle(`${AD_PREFIX}[${category}] ${label}`, at), source: { channel: 'quickfact', postHash: post.hash, linkId: id } };
    appendFileSync(queueFile, JSON.stringify(item) + '\n');
    added.push(item);
  }
  return added;
}

export function cardInput(item) {
  return { confirm: true, ownerUsername: OWNER, sourceIdentity: item.source,
    // Owner 2026-10-05 "사진 들어가는거 있나": a product photo makes a thumbnail card (Inpock's default link style).
    payload: { block_type: 'link', url: item.url, title: item.title, style: item.image ? 'thumbnail' : 'simple', image: item.image ?? '', button_text: '', is_open: true } };
}

function runPublisher(input, { timeoutMs = 180_000, command = 'publish' } = {}) {
  mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `card-${input.sourceIdentity.linkId}.json`);
  writeFileSync(file, JSON.stringify(input));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(PLAYBOOK, 'scripts', 'inpock.mjs'), command, `--input=${file}`], { cwd: PLAYBOOK, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => { clearTimeout(timer); try { unlinkSync(file); } catch {}
      let j = null; try { j = JSON.parse(out.trim().split('\n').pop()); } catch {}
      resolve(j ?? { ok: false, code: code === null ? 'INPOCK_PUBLISH_TIMEOUT' : 'INPOCK_PUBLISH_OUTPUT' }); });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: 'INPOCK_PUBLISH_SPAWN' }); });
  });
}

export function pending({ queueFile = QUEUE, resultsFile = RESULTS } = {}) {
  // Any recorded attempt (verified or not) takes the item out of `publish`; unverified ones go through `reconcile`.
  const done = new Map(rows(resultsFile).map(r => [r.id, r]));
  // Verified and refused-for-good items are finished; anything else waits for a look (the playbook journal never resends).
  // Inpock puts each new card on top (checked 2026-10-05), so cards go out in reverse of the page order (PAGE_ORDER, top →
  // bottom) and oldest first within a category: each category ends up together, newest card first.
  const rank = c => { const i = PUBLISH_ORDER.indexOf(c); return i < 0 ? -1 : i; };
  return rows(queueFile).filter(item => !done.has(item.id))
    .sort((a, b) => rank(a.category) - rank(b.category) || String(a.at).localeCompare(String(b.at)));
}

export async function publish({ limit = 5, dryRun = false, publisher = runPublisher, resultsFile = RESULTS, queueFile = QUEUE } = {}) {
  const out = [];
  for (const item of pending({ queueFile, resultsFile }).slice(0, limit)) {
    if (dryRun) { out.push({ id: item.id, dryRun: true, input: cardInput(item) }); continue; }
    const r = await publisher(cardInput(item));
    const record = { id: item.id, at: new Date().toISOString(), ok: r.ok === true && r.readbackVerified === true, status: r.status ?? null,
      code: r.code ?? null, blockId: r.blockId ?? null, publicVerified: r.publicVerified ?? null, writeSent: r.writeSent ?? null };
    // A result that is not clearly finished stays out of results.jsonl only when nothing was sent; otherwise it is recorded
    // and the playbook journal decides any reconcile (it refuses a second POST for the same source).
    if (record.ok || r.writeSent !== false) appendFileSync(resultsFile, JSON.stringify(record) + '\n');
    out.push(record);
    if (!record.ok) break;
  }
  return out;
}

async function main() {
  const [command = 'status'] = process.argv.slice(2);
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  if (command === 'status') { console.log(JSON.stringify({ queued: rows(QUEUE).length, pending: pending().length, published: rows(RESULTS).filter(r => r.ok).length })); return; }
  if (command === 'publish') { console.log(JSON.stringify(await publish({ limit: Number(arg('limit') ?? 5), dryRun: process.argv.includes('--dry-run') }), null, 1)); return; }
  if (command === 'retouch') {
    // Published cards without a photo get one in place (playbook `update`, PUT /blocks/{id}, one write per card).
    // The image comes from the queue item, or --image=<partner link>=<https image> when the queue has none.
    const overrides = {};
    for (const a of process.argv.filter(x => x.startsWith('--image='))) { const v = a.slice(8), i = v.indexOf('='); if (i > 0) overrides[v.slice(0, i)] = v.slice(i + 1); }
    const last = new Map(rows(RESULTS).filter(r => r.ok && r.blockId).map(r => [r.id, r]));
    // Only cards that are still text-only on Inpock (read from the owner list) are touched.
    const { createInpockReadClient } = await import(pathToFileURL(path.join(PLAYBOOK, 'lib', 'inpock-read.mjs')).href);
    const owned = await createInpockReadClient().listBlocks({ maxPages: 20 });
    if (!owned.complete) throw Object.assign(new Error('INPOCK_OWNER_LIST_INCOMPLETE'), { code: 'INPOCK_OWNER_LIST_INCOMPLETE' });
    const simple = new Set(owned.blocks.filter(b => b.block_type === 'link' && b.style === 'simple').map(b => b.id));
    const lines = rows(QUEUE);
    const out = [];
    for (const item of lines) {
      const image = overrides[item.url] ?? item.image;
      const done = last.get(item.id);
      if (!done || !image || !simple.has(done.blockId)) continue;
      const input = { ...cardInput({ ...item, image }), blockId: done.blockId };
      const r = await runPublisher(input, { command: 'update' });
      const record = { id: item.id, at: new Date().toISOString(), ok: r.ok === true && r.readbackVerified === true, status: r.status ?? null,
        code: r.code ?? null, blockId: done.blockId, style: 'thumbnail', image, publicVerified: r.publicVerified ?? null, writeSent: r.writeSent ?? null, retouch: true };
      if (record.ok || r.writeSent !== false) appendFileSync(RESULTS, JSON.stringify(record) + '\n');
      out.push({ title: item.title, ...record });
      if (!record.ok) break;
    }
    console.log(JSON.stringify(out, null, 1));
    return;
  }
  if (command === 'disclose') {
    // Published cards whose live title lacks the ad mark are retitled in place (PUT /blocks/{id}, one write per card).
    // The live image, style and visibility are kept; --title=<partner link>=<new title body> renames a card as well.
    const titles = {};
    for (const a of process.argv.filter(x => x.startsWith('--title='))) { const v = a.slice(8), i = v.indexOf('='); if (i > 0) titles[v.slice(0, i)] = v.slice(i + 1); }
    const { createInpockReadClient } = await import(pathToFileURL(path.join(PLAYBOOK, 'lib', 'inpock-read.mjs')).href);
    const owned = await createInpockReadClient().listBlocks({ maxPages: 20 });
    if (!owned.complete) throw Object.assign(new Error('INPOCK_OWNER_LIST_INCOMPLETE'), { code: 'INPOCK_OWNER_LIST_INCOMPLETE' });
    const live = new Map(owned.blocks.filter(b => b.block_type === 'link').map(b => [b.id, b]));
    const blockOf = new Map(rows(RESULTS).filter(r => r.ok && r.blockId).map(r => [r.id, r.blockId]));
    const out = [];
    for (const item of rows(QUEUE)) {
      const block = live.get(blockOf.get(item.id));
      // Hidden cards are not public (and the update contract refuses is_open=false input); they keep their title.
      if (!block || block.is_open === false) continue;
      const title = withAdPrefix(titles[item.url] ? cardTitle(titles[item.url], item.at) : block.title);
      if (title === block.title) continue;
      const input = { ...cardInput({ ...item, title, image: block.image || null }), blockId: block.id };
      input.payload.style = block.style; input.payload.is_open = block.is_open;
      if (process.argv.includes('--dry-run')) { out.push({ blockId: block.id, from: block.title, to: title, dryRun: true }); continue; }
      const r = await runPublisher(input, { command: 'update' });
      const record = { id: item.id, at: new Date().toISOString(), ok: r.ok === true && r.readbackVerified === true, status: r.status ?? null,
        code: r.code ?? null, blockId: block.id, title, publicVerified: r.publicVerified ?? null, writeSent: r.writeSent ?? null, disclose: true };
      if (record.ok || r.writeSent !== false) appendFileSync(RESULTS, JSON.stringify(record) + '\n');
      out.push({ from: block.title, ...record });
      if (!record.ok) break;
    }
    console.log(JSON.stringify(out, null, 1));
    return;
  }
  if (command === 'reconcile') {
    // Items whose last result was not verified are asked again: the playbook publisher reads its write-once journal and the
    // remote lists and reports already_verified / reconciled without a second POST (it refuses to resend).
    const results = rows(RESULTS), last = new Map(results.map(r => [r.id, r]));
    const items = rows(QUEUE).filter(i => last.has(i.id) && last.get(i.id).ok !== true);
    const out = [];
    for (const item of items) {
      const r = await runPublisher(cardInput(item));
      const record = { id: item.id, at: new Date().toISOString(), ok: r.ok === true && r.readbackVerified === true, status: r.status ?? null,
        code: r.code ?? null, blockId: r.blockId ?? null, publicVerified: r.publicVerified ?? null, writeSent: r.writeSent ?? null, reconcile: true };
      appendFileSync(RESULTS, JSON.stringify(record) + '\n');
      out.push({ title: item.title, ...record });
    }
    console.log(JSON.stringify(out, null, 1));
    return;
  }
  if (command === 'backfill') {
    const { parsePosts } = await import('./quick-fact.mjs');
    const added = parsePosts(readFileSync(arg('file'), 'utf8')).flatMap(post => enqueueFromPost(post, { at: arg('at') ?? new Date().toISOString() }));
    console.log(JSON.stringify({ added: added.map(a => ({ id: a.id, title: a.title, host: new URL(a.url).host })) }));
    return;
  }
  if (command === 'backfill-all') {
    // Owner 2026-10-05 "인포크에다가 소급적용해놔": every quick-fact post text found under --dirs whose hash the ledger marks
    // done on some channel; its partner links are queued in posting order (a link posted twice keeps its first post).
    const { parsePosts, ledgerRead } = await import('./quick-fact.mjs');
    const { readdirSync, statSync } = await import('node:fs');
    const doneAt = new Map();
    for (const e of ledgerRead()) if (e.state === 'done') { const h = String(e.key).split(':')[1]; if (!doneAt.has(h) || e.at < doneAt.get(h)) doneAt.set(h, e.at); }
    const files = [];
    const walk = (d, depth = 0) => { let names = []; try { names = readdirSync(d); } catch { return; }
      for (const n of names) { const f = path.join(d, n); let s; try { s = statSync(f); } catch { continue; }
        if (s.isDirectory() && depth < 4 && !/node_modules|\.git/.test(n)) walk(f, depth + 1); else if (s.isFile() && /\.txt$/i.test(n) && s.size < 20000) files.push(f); } };
    for (const d of String(arg('dirs') ?? '').split(';').filter(Boolean)) walk(d);
    const found = new Map();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!/link\.coupang\.com\/a\/|toss\.(shopping|im)\/_m\/|naver\.me\/|myrealt\.rip\//.test(text)) continue;
      let posts = []; try { posts = parsePosts(text); } catch { posts = lenientPosts(text); }
      for (const p of posts) if (doneAt.has(p.hash) && !found.has(p.hash)) found.set(p.hash, { post: p, at: doneAt.get(p.hash), file: f });
    }
    // Exact Toss product names: link cache (tacaItemId → issued short link) + Open API detail.
    const productNames = {}, foodLinks = new Set(), productImages = {};
    for (const a of process.argv.filter(x => x.startsWith('--image='))) { const v = a.slice(8), i = v.indexOf('='); if (i > 0) productImages[v.slice(0, i)] = v.slice(i + 1); }
    const LA = path.join(process.env.LOCALAPPDATA ?? '.', 'affiliate-content-operations');
    try {
      const cache = JSON.parse(readFileSync(path.join(LA, 'toss-openapi', 'links.json'), 'utf8'));
      const byId = Object.fromEntries(Object.values(cache).map(e => [String(e.tacaItemId), e.shortUrl]));
      // Links the owner issued in the Toss app are not in the cache: --toss-extra=<short URL>=<tacaItemId>,…
      for (const pair of String(arg('toss-extra') ?? '').split(',').filter(Boolean)) { const [u, id] = pair.split('='); if (u && id) byId[id] = u; }
      const { createTossOpenApi } = await import('../adapters/toss-openapi.mjs');
      const api = createTossOpenApi();
      const ids = Object.keys(byId);
      for (let i = 0; i < ids.length; i += 20) {
        const r = await api.detail(ids.slice(i, i + 20));
        for (const item of r.items ?? []) {
          const u = byId[String(item.tacaItemId)];
          if (!u) continue;
          productNames[u] = item.title;
          if (item.image && !productImages[u]) productImages[u] = item.image;
          if ((item.categoryIds ?? []).includes(50995)) foodLinks.add(u); // 토스쇼핑 식품
        }
      }
    } catch (e) { console.error('toss names unavailable', e.code ?? e.message); }
    // Names the posts and caches do not give: --name=<link>=<상품명> (repeatable).
    for (const a of process.argv.filter(x => x.startsWith('--name='))) { const v = a.slice(7), i = v.indexOf('='); if (i > 0) productNames[v.slice(0, i)] = v.slice(i + 1); }
    // Coupang: link cache (product:item:vendorItem → short link) joined with the saved flash-sale inventories' titles.
    try {
      const cache = JSON.parse(readFileSync(path.join(LA, 'coupang-partners', 'links.json'), 'utf8'));
      const want = new Map(Object.entries(cache).map(([k, e]) => [k, e.shortUrl]));
      const invRoot = path.join(LA, 'coupang-flash-sale');
      for (const d of readdirSync(invRoot).sort().reverse()) {
        let inv; try { inv = JSON.parse(readFileSync(path.join(invRoot, d, 'inventory.json'), 'utf8')); } catch { continue; }
        for (const r of inv.rows ?? []) { const u = want.get(`${r.productId}:${r.itemId}:${r.vendorItemId}`); if (!u) continue;
          if (!productNames[u]) productNames[u] = r.title;
          if (!productImages[u] && r.imageUrl) productImages[u] = r.imageUrl; }
      }
    } catch (e) { console.error('coupang names unavailable', e.code ?? e.message); }
    const added = [...found.values()].sort((a, b) => a.at.localeCompare(b.at)).flatMap(x => enqueueFromPost(x.post, { at: x.at, productNames, foodLinks, productImages }));
    const byCategory = added.reduce((m, a) => ({ ...m, [a.category]: (m[a.category] ?? 0) + 1 }), {});
    console.log(JSON.stringify({ filesScanned: files.length, postsMatched: found.size, cardsQueued: added.length, byCategory,
      cards: added.map(a => `${a.category} | ${new URL(a.url).host} | ${a.title.slice(0, 70)}`) }, null, 1));
    return;
  }
  throw Object.assign(new Error('INPOCK_LINKS_COMMAND'), { code: 'INPOCK_LINKS_COMMAND' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code ?? e.message })); process.exitCode = 1; });
