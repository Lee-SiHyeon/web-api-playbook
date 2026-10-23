// Shopping Shorts scout + provenance (owner 2026-09-28: "쇼핑쇼츠들 분석하고 온톨로지에 원본영상 데이터 수집가능하게 확장해놔").
// Usage: node shopping-shorts.mjs --out=<file> [--queries=a,b] [--channels=@a,@b] [--limit=60] [--per-query=4] [--origins=15] [--no-comments]
//        node shopping-shorts.mjs --out=<file> --video=<id> [--candidate=<id,…>] [--origin-queries=<zh/ja product name,…>]
//
// Per Short (public, anonymous YouTube web, observed 2026-09-28):
//   GET /watch?v=<id>              ytInitialPlayerResponse (title, description, keywords, length, views, publish date,
//                                   channel, paid-promotion flag, storyboard spec) and ytInitialData (comments token)
//   POST /youtubei/v1/next          first comments page; only creator-authored links are kept (no viewer identities/text)
//   GET i.ytimg.com/sb/<id>/…       storyboard sheets → per-frame 64-bit dHash (9×8 gray via ffmpeg untile); no frames kept
// Origins: candidate videos from the named brand's official channel and YouTube searches for the Short's foreign/product
// terms; ≥2 frames within Hamming ≤10 of an OLDER video = derivedFrom, of a newer one = siblingOf. Douyin/TikTok/Instagram
// are not reachable anonymously and stay notCollectable (cue recorded). Metadata and hashes only — never the footage.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseSearch } from './youtube-hook-scout.mjs';
import { parseCount } from './sns-references.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const YT = 'https://www.youtube.com';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sleep = ms => (ms ? new Promise(r => setTimeout(r, ms)) : null);
export const loadOntology = (file = path.join(HERE, 'shopping-shorts-ontology.v1.json')) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

function jsonAfter(html, name) {
  const m = new RegExp(`var ${name} = (\\{.*?\\});(?:var |</script>)`, 's').exec(String(html));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ---- watch page ------------------------------------------------------------------------------------------------------
export function parseWatch(html) {
  if (/consent\.youtube|unusual traffic|captcha/i.test(html) && !/ytInitialPlayerResponse/.test(html)) fail('YOUTUBE_CHALLENGE');
  const p = jsonAfter(html, 'ytInitialPlayerResponse');
  if (!p?.videoDetails) fail('YOUTUBE_NO_PLAYER');
  const v = p.videoDetails, mf = p.microformat?.playerMicroformatRenderer ?? {};
  let commentsToken = null, commentCount = null, subscribers = null;
  const products = new Map();
  const d = jsonAfter(html, 'ytInitialData');
  const text = t => t?.simpleText ?? (t?.runs ?? []).map(r => r.text).join('') ?? '';
  const walk = (o, trail) => {
    if (!o || typeof o !== 'object') return;
    if (!commentsToken && trail.endsWith('continuationItemRenderer.continuationEndpoint') && o.continuationCommand?.token) { commentsToken = o.continuationCommand.token; return; }
    // Ranking inputs (숏템메이커 knowhow, 2026-09-28): the comments panel header carries the total ("댓글" + contextualInfo
    // "73"), the owner renderer the subscriber count ("구독자 686명").
    const hdr = o.engagementPanelTitleHeaderRenderer;
    if (commentCount == null && hdr && /댓글|Comments/.test(text(hdr.title)) && hdr.contextualInfo) commentCount = parseCount(text(hdr.contextualInfo));
    if (subscribers == null && o.videoOwnerRenderer?.subscriberCountText) {
      const s = o.videoOwnerRenderer.subscriberCountText;
      subscribers = parseCount(s.accessibility?.accessibilityData?.label ?? text(s));
    }
    // YouTube Shopping tags (observed 2026-09-28): productListItemRenderer {title, price, merchantName, affiliateDisclaimerText "수수료 지급"}.
    const pr = o.productListItemRenderer ?? o.compactProductListItemRenderer;
    if (pr?.title) {
      const title = pr.title.simpleText ?? (pr.title.runs ?? []).map(r => r.text).join('');
      if (title && !products.has(title)) products.set(title, { title, price: pr.price ?? null, merchant: pr.merchantName ?? null, affiliate: Boolean(pr.affiliateDisclaimerText) });
    }
    for (const k in o) walk(o[k], trail.slice(-120) + '.' + k);
  };
  walk(d, '');
  return {
    videoId: v.videoId, title: v.title ?? '', description: v.shortDescription ?? '', keywords: v.keywords ?? [],
    lengthSeconds: Number(v.lengthSeconds) || null, views: Number(v.viewCount) || null, channelId: v.channelId ?? null, channel: v.author ?? null,
    publishDate: mf.publishDate ?? mf.uploadDate ?? null, category: mf.category ?? null,
    paidPromotion: Boolean(p.paidContentOverlay), products: [...products.values()].slice(0, 20), storyboardSpec: p.storyboards?.playerStoryboardSpecRenderer?.spec ?? null,
    clientVersion: /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] ?? null, commentsToken, commentCount, subscribers,
  };
}

// Ranking signals (숏템메이커 knowhow 2026-09-28, adapted to public YouTube data): views per hour since publishing,
// comments per 1,000 views (engagement density) and views per subscriber (a small channel breaking out); tags use the
// ontology's rankingSignals thresholds, which are first guesses until two-snapshot acceleration calibrates them.
export function rankSignals(short, o, now = Date.now()) {
  const rs = o.rankingSignals;
  const published = short.publishDate ? Date.parse(short.publishDate) : NaN;
  const ageHours = Number.isFinite(published) ? Math.max(1, (now - published) / 3600e3) : null;
  const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
  const viewsPerHour = ageHours && short.views != null ? round(short.views / ageHours) : null;
  const commentsPerThousandViews = short.views && short.commentCount != null ? round(short.commentCount / short.views * 1000, 2) : null;
  const viewsPerSubscriber = short.views != null && short.subscribers ? round(short.views / short.subscribers, 2) : null;
  const t = rs.tags;
  const tags = [];
  if (ageHours != null && ageHours <= rs.windowHours && viewsPerHour >= t.rising.minViewsPerHour) tags.push('rising');
  if (commentsPerThousandViews != null && commentsPerThousandViews >= t.reactive.minCommentsPerThousandViews) tags.push('reactive');
  if (viewsPerSubscriber != null && viewsPerSubscriber >= t.efficient.minViewsPerSubscriber) tags.push('efficient');
  if (tags.length >= t.must_watch.minOtherTags) tags.push('must_watch');
  return { ageHours: round(ageHours), inWindow: ageHours != null && ageHours <= rs.windowHours, viewsPerHour, commentsPerThousandViews, viewsPerSubscriber, tags };
}

// ---- storyboard → frame hashes ---------------------------------------------------------------------------------------
// spec: "<base with $L and $N>|w#h#count#cols#rows#intervalMs#name#sigh|…"; level index = position after the base.
export function parseStoryboardSpec(spec) {
  if (!spec) return [];
  const [base, ...levels] = String(spec).split('|');
  return levels.map((s, level) => {
    const [w, h, count, cols, rows, interval, name, sigh] = s.split('#');
    const perSheet = Number(cols) * Number(rows);
    return { level, w: Number(w), h: Number(h), count: Number(count), cols: Number(cols), rows: Number(rows), intervalMs: Number(interval), name, sigh,
      sheets: Math.ceil(Number(count) / perSheet), perSheet,
      url: n => base.replace('$L', String(level)).replace('$N', name.replace('$M', String(n))) + (sigh ? `&sigh=${encodeURIComponent(sigh)}` : '') };
  }).filter(l => l.name !== 'default' && l.count > 0 && l.cols > 0);
}
// Largest tiles with at most `maxSheets` sheets and tiles at least 48 px wide.
export function chooseLevel(levels, maxSheets = 6) {
  const ok = levels.filter(l => l.sheets <= maxSheets && Math.min(l.w, l.h) >= 45);
  return ok.sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null;
}
export function dHash(px) { // 72 gray bytes (9×8) → 16 hex chars; null for flat frames (black/blank tiles)
  let bits = 0n, lo = 255, hi = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const a = px[r * 9 + c], b = px[r * 9 + c + 1];
    lo = Math.min(lo, a); hi = Math.max(hi, a);
    bits = (bits << 1n) | (a < b ? 1n : 0n);
  }
  return hi - lo < 12 ? null : bits.toString(16).padStart(16, '0');
}
export const hamming = (a, b) => { let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

// Sheet JPEG → hashes of each tile; for landscape tiles also the centered 9:16 crop (vertical re-edit of a wide original).
export function sheetHashes(jpeg, { cols, rows, w, h }, ffmpeg) {
  const run = vf => {
    const r = spawnSync(ffmpeg, ['-loglevel', 'error', '-i', 'pipe:0', '-vf', vf, '-f', 'rawvideo', 'pipe:1'], { input: jpeg, windowsHide: true, maxBuffer: 1 << 20 });
    if (r.status !== 0) return [];
    return Array.from({ length: Math.floor(r.stdout.length / 72) }, (_, i) => dHash(r.stdout.subarray(i * 72, i * 72 + 72)));
  };
  const full = run(`format=gray,untile=${cols}x${rows},scale=9:8:flags=area`);
  const crop = w > h ? run(`format=gray,untile=${cols}x${rows},crop=ih*9/16:ih,scale=9:8:flags=area`) : [];
  return { full, crop };
}

// ---- text signals ----------------------------------------------------------------------------------------------------
export function textSignals({ title = '', description = '', keywords = [] }, o) {
  const text = `${title}\n${description}`;
  const links = [...new Set(description.match(/https?:\/\/[^\s)>\]]+/g) ?? [])];
  const kinds = new Set();
  for (const url of links) {
    let host = ''; try { host = new URL(url).hostname; } catch { continue; }
    const k = o.monetizationLinks.find(m => m.host && new RegExp(m.host, 'i').test(host) && m.id !== 'other_link');
    kinds.add(k ? k.id : /youtube\.com|youtu\.be|instagram|tiktok|x\.com|twitter/i.test(host) ? 'social' : 'other_link');
  }
  for (const m of o.monetizationLinks) if (m.text && new RegExp(m.text).test(text)) kinds.add(m.id);
  if (o.monetizationLinks.some(m => m.disclosure && new RegExp(m.disclosure).test(text))) kinds.add('coupang_partners');
  const hashtags = [...new Set([...(description.match(/#[^\s#]+/g) ?? []), ...(title.match(/#[^\s#]+/g) ?? [])].map(h => h.slice(1)))];
  const generic = new Set(o.genericHashtags.map(g => g.toLowerCase()));
  const productTerms = [...new Set([...hashtags, ...keywords].filter(t => !generic.has(String(t).toLowerCase())))].slice(0, 8);
  const cue = id => o.provenanceCues.find(c => c.id === id);
  const foreignTerms = productTerms.filter(t => /^[A-Za-z][A-Za-z0-9]{3,}$|[぀-ヿ一-鿿]/.test(t))
    .map(t => t.replace(/([a-z])([A-Z])/g, '$1 $2'));
  const brands = o.knownBrands.filter(b => b.names.some(n => text.toLowerCase().includes(n.toLowerCase()) || hashtags.some(h => h.toLowerCase() === n.toLowerCase()))).map(b => b.id);
  return {
    titleFormulas: o.titleFormulas.filter(f => new RegExp(f.match).test(title)).map(f => f.id),
    links: links.map(u => u.slice(0, 200)), monetization: [...kinds], hashtags, productTerms, foreignTerms, brands,
    foreignOrigin: new RegExp(cue('foreign_origin_text').match, 'i').test(text),
    ownUse: new RegExp(cue('own_use_wording').match).test(text),
    adLabel: new RegExp(cue('ad_label').match, 'i').test(text),
  };
}

// Creator-authored comment links from the first comments page (viewer comments are counted, never stored).
export function parseComments(json) {
  const payloads = (json?.frameworkUpdates?.entityBatchUpdate?.mutations ?? []).map(m => m.payload?.commentEntityPayload).filter(Boolean);
  const creator = payloads.filter(c => c.author?.isCreator);
  const links = [...new Set(creator.flatMap(c => String(c.properties?.content?.content ?? '').match(/https?:\/\/[^\s)>\]]+/g) ?? []))];
  return { viewerComments: payloads.length - creator.length, creatorComments: creator.length, creatorLinks: links.map(u => u.slice(0, 200)) };
}

// ---- provenance --------------------------------------------------------------------------------------------------------
export function matchFrames(short, cand, maxDist = 10) {
  const pool = [...cand.full, ...cand.crop].filter(Boolean);
  const hits = [];
  short.forEach((h, i) => {
    if (!h) return;
    let best = 65; for (const c of pool) best = Math.min(best, hamming(h, c));
    if (best <= maxDist) hits.push({ frame: i, dist: best });
  });
  return { matched: hits.length, minDist: hits.length ? Math.min(...hits.map(x => x.dist)) : null, frames: hits.map(x => x.frame) };
}

export function hypothesis(short, o) {
  const s = short.signals, score = Object.fromEntries(o.sourceKinds.map(k => [k.id, 0])), evidence = [];
  const add = (kind, w, why) => { score[kind] += w; evidence.push(why); };
  const origin = short.origins?.find(x => x.relation === 'manufacturer_original') ?? short.origins?.find(x => x.relation === 'earlier_upload');
  if (origin) add(origin.relation === 'manufacturer_original' ? 'manufacturer_official' : 'curator_repost', 3, `frame_match:${origin.videoId}(${origin.matched})`);
  if (s.adLabel || short.paidPromotion) add('seller_supplied', 2, short.paidPromotion ? 'paid_promotion_flag' : 'ad_label_text');
  if (s.ownUse) add('own_footage', 2, 'own_use_wording');
  if (s.foreignOrigin) { add('manufacturer_official', 1, 'foreign_origin_text'); add('douyin_tiktok_creator', 0.5, 'foreign_origin_text'); }
  if (s.foreignTerms.length) add('manufacturer_official', 0.5, `foreign_hashtag:${s.foreignTerms[0]}`);
  if (s.titleFormulas.some(f => ['angry_genius', 'genius_invention', 'country_craft'].includes(f)) && !s.ownUse) add('curator_repost', 1, 'curiosity_formula_title');
  const [best, w] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return { sourceKind: w > 0 ? best : 'unknown', confidence: w >= 3 ? 'high' : w >= 2 ? 'medium' : w > 0 ? 'low' : 'none', evidence };
}

// ---- network ----------------------------------------------------------------------------------------------------------
export function createClient({ fetchImpl = globalThis.fetch, delayMs = 1200, imageDelayMs = 150, ffmpeg = null, retries = 3, backoffMs = 2000 } = {}) {
  let last = 0;
  const pace = async ms => { const wait = last + ms - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); };
  const headers = { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9' };
  // Transport errors ("fetch failed": dropped connections in long runs, observed 2026-09-28) are retried with backoff;
  // HTTP statuses are not (a 429/403 is an answer, not a transport fault).
  async function send(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      try { return await fetchImpl(url, { ...init, headers: { ...headers, ...init.headers } }); }
      catch (e) { if (attempt >= retries) throw Object.assign(e, { code: 'YOUTUBE_TRANSPORT' }); await sleep(backoffMs * 2 ** attempt); }
    }
  }
  async function page(url) {
    await pace(delayMs);
    const r = await send(url);
    if (r.status !== 200) fail(`YOUTUBE_HTTP_${r.status}`);
    return r.text();
  }
  const ff = () => (ffmpeg ??= process.env.FFMPEG_PATH || spawnSync('python', ['-c', 'import imageio_ffmpeg as f;print(f.get_ffmpeg_exe())'], { encoding: 'utf8', windowsHide: true }).stdout.trim() || fail('FFMPEG_UNAVAILABLE'));
  return {
    search: async q => parseSearch(await page(`${YT}/results?search_query=${encodeURIComponent(q)}&hl=ko&gl=KR`)),
    channelShorts: async ref => parseSearch(await page(ref.startsWith('UC') ? `${YT}/channel/${ref}/shorts?hl=ko&gl=KR` : `${YT}/${encodeURI(ref)}/shorts?hl=ko&gl=KR`)).filter(v => v.format === 'short'),
    watch: async id => parseWatch(await page(`${YT}/watch?v=${id}&hl=ko&gl=KR`)),
    async comments(w) {
      if (!w.commentsToken || !w.clientVersion) return null;
      await pace(delayMs);
      const r = await send(`${YT}/youtubei/v1/next?prettyPrint=false`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: w.clientVersion, hl: 'ko', gl: 'KR' } }, continuation: w.commentsToken }) });
      return r.status === 200 ? parseComments(await r.json()) : null;
    },
    async hashes(spec) {
      const level = chooseLevel(parseStoryboardSpec(spec));
      if (!level) return null;
      const out = { level: level.level, tile: `${level.w}x${level.h}`, intervalMs: level.intervalMs, full: [], crop: [] };
      for (let n = 0; n < level.sheets; n++) {
        await pace(imageDelayMs);
        const r = await send(level.url(n));
        if (r.status !== 200) break;
        const h = sheetHashes(Buffer.from(await r.arrayBuffer()), level, ff());
        out.full.push(...h.full); out.crop.push(...h.crop);
      }
      out.full = out.full.slice(0, level.count); out.crop = out.crop.slice(0, level.count);
      return out;
    },
  };
}

export async function inspectShort(id, client, o, { comments = true } = {}) {
  const w = await client.watch(id);
  const short = { videoId: w.videoId, url: `${YT}/shorts/${w.videoId}`, title: w.title, channel: w.channel, channelId: w.channelId, views: w.views,
    lengthSeconds: w.lengthSeconds, publishDate: w.publishDate, category: w.category, paidPromotion: w.paidPromotion, products: w.products,
    commentCount: w.commentCount ?? null, subscribers: w.subscribers ?? null,
    signals: textSignals(w, o), comments: comments ? await client.comments(w) : null, frames: await client.hashes(w.storyboardSpec) };
  short.ranking = rankSignals(short, o);
  if (short.products.length) {
    const merchants = [...new Set(short.products.map(p => p.merchant).filter(Boolean))];
    short.signals.monetization.push(short.products.some(p => p.affiliate) ? 'youtube_shopping_affiliate' : 'youtube_shopping_tag',
      ...merchants.map(m => `merchant:${m.replace(/!$/, '')}`));
  }
  if (short.comments?.creatorLinks?.length) {
    const extra = textSignals({ title: '', description: short.comments.creatorLinks.join('\n'), keywords: [] }, o).monetization;
    short.signals.monetization = [...new Set([...short.signals.monetization, ...extra.map(k => `${k}@comment`)])];
  }
  return short;
}

// Candidates: brand official channel Shorts + searches for the foreign/product terms; compare storyboard hashes.
// extraQueries: the product name in the origin's language (숏템메이커 knowhow: the footage usually comes from 샤오홍슈·도우인,
// found by searching the Chinese product name). Those platforms are login-walled for us, but their clips are often
// re-uploaded publicly on YouTube, which is where we trace them — to know the origin, never to reuse the footage.
export async function findOrigins(short, client, o, { maxCandidates = 8, manual = [], extraQueries = [] } = {}) {
  if (!short.frames?.full?.some(Boolean)) return { origins: [], candidatesChecked: 0, notCollectable: [] };
  const cands = new Map(manual.map(id => [id, 'manual']));
  for (const b of o.knownBrands.filter(b => short.signals.brands.includes(b.id) && b.officialChannelId)) {
    for (const v of (await client.channelShorts(b.officialChannelId)).slice(0, 12)) if (!cands.has(v.id)) cands.set(v.id, `brand:${b.id}`);
  }
  const terms = [...new Set([...extraQueries, ...short.signals.foreignTerms, ...short.signals.productTerms.slice(0, 1)])].slice(0, 2 + extraQueries.length);
  for (const t of terms) for (const v of (await client.search(t)).slice(0, 6)) if (!cands.has(v.id)) cands.set(v.id, `search:${t}`);
  cands.delete(short.videoId);
  const origins = [];
  let checked = 0;
  for (const [id, via] of [...cands].slice(0, maxCandidates + manual.length)) {
    let w; try { w = await client.watch(id); } catch { continue; }
    const frames = await client.hashes(w.storyboardSpec);
    checked++;
    if (!frames) continue;
    const m = matchFrames(short.frames.full, frames);
    if (m.matched < 2) continue;
    const older = w.publishDate && short.publishDate && w.publishDate < short.publishDate;
    const brand = o.knownBrands.find(b => b.officialChannelId === w.channelId || b.names.some(n => String(w.channel).toLowerCase().includes(n.toLowerCase())));
    origins.push({ videoId: id, url: `${YT}/watch?v=${id}`, title: w.title, channel: w.channel, channelId: w.channelId, publishDate: w.publishDate,
      views: w.views, via, matched: m.matched, minDist: m.minDist, frames: m.frames,
      relation: older ? (brand ? 'manufacturer_original' : 'earlier_upload') : 'later_or_sibling' });
  }
  const notCollectable = [];
  if (!origins.some(x => x.relation !== 'later_or_sibling')) {
    if (short.signals.foreignOrigin || short.signals.foreignTerms.length) notCollectable.push('douyin_tiktok_creator', 'instagram_reel');
    if (short.signals.adLabel || short.paidPromotion) notCollectable.push('seller_supplied');
  }
  return { origins: origins.sort((a, b) => b.matched - a.matched), candidatesChecked: checked, notCollectable };
}

// Shared footage (숏템메이커 knowhow: "이 두 영상이 같은 원본을 썼다"): Shorts in one scan whose storyboard frames match
// (≥2 frames within Hamming 10) are grouped. A cluster across several channels marks footage from a common outside source
// that is currently earning views — a sourcing signal and a reuse-risk flag, not footage we take.
export function footageClusters(shorts, { minMatched = 2 } = {}) {
  const withFrames = shorts.filter(s => s.frames?.full?.some(Boolean));
  const parent = new Map(withFrames.map(s => [s.videoId, s.videoId]));
  const root = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  for (let i = 0; i < withFrames.length; i++) for (let j = i + 1; j < withFrames.length; j++) {
    const a = withFrames[i], b = withFrames[j];
    if (matchFrames(a.frames.full, { full: b.frames.full, crop: b.frames.crop ?? [] }).matched >= minMatched) parent.set(root(a.videoId), root(b.videoId));
  }
  const groups = new Map();
  for (const s of withFrames) (groups.get(root(s.videoId)) ?? groups.set(root(s.videoId), []).get(root(s.videoId))).push(s);
  return [...groups.values()].filter(g => g.length > 1).map(g => ({
    videoIds: g.map(s => s.videoId), channels: [...new Set(g.map(s => s.channel))], totalViews: g.reduce((n, s) => n + (s.views ?? 0), 0),
    earliest: g.map(s => s.publishDate).filter(Boolean).sort()[0] ?? null, crossChannel: new Set(g.map(s => s.channelId ?? s.channel)).size > 1,
  })).sort((a, b) => b.totalViews - a.totalViews);
}

export function summarize(shorts) {
  const group = (key) => {
    const rows = {};
    for (const s of shorts) for (const k of key(s)) (rows[k] ??= []).push(s.views);
    return Object.entries(rows).map(([id, v]) => ({ id, n: v.length, medianViews: median(v) })).sort((a, b) => b.n - a.n);
  };
  return {
    shorts: shorts.length, medianViews: median(shorts.map(s => s.views)), medianLength: median(shorts.map(s => s.lengthSeconds)),
    titleFormulas: group(s => s.signals.titleFormulas.length ? s.signals.titleFormulas : ['(none)']),
    monetization: group(s => s.signals.monetization.length ? s.signals.monetization : ['(none)']),
    sourceKinds: group(s => [s.provenance?.sourceKind ?? 'unknown']),
    channels: group(s => [s.channel ?? '?']).slice(0, 15),
    originsFound: shorts.filter(s => s.origins?.some(x => x.relation !== 'later_or_sibling')).length,
    siblingsFound: shorts.filter(s => s.origins?.some(x => x.relation === 'later_or_sibling')).length,
    sharedFootage: footageClusters(shorts),
  };
}

// Sample: the top `perQuery` Shorts of each search (views sort alone keeps only all-time virals) and `perChannel` of each
// seed channel, capped at `limit`.
export async function scan({ queries, channels, limit = 60, perQuery = 4, perChannel = 6, origins = 15, comments = true, client = createClient(), ontology = loadOntology(), log = () => {} } = {}) {
  const o = ontology;
  queries ??= o.seeds.queries; channels ??= o.seeds.channels.map(c => c.handle);
  const found = new Map();
  const take = (list, n, via) => { for (const v of list.filter(v => v.format === 'short' && !found.has(v.id)).slice(0, n)) found.set(v.id, { ...v, via }); };
  for (const c of channels) { try { take(await client.channelShorts(c), perChannel, `channel:${c}`); } catch (e) { log({ c, code: e.code || e.message }); } }
  for (const q of queries) { try { take(await client.search(q), perQuery, `search:${q}`); } catch (e) { log({ q, code: e.code || e.message }); if (e.code === 'YOUTUBE_CHALLENGE') break; } }
  const picked = [...found.values()].slice(0, limit);
  const shorts = [];
  for (const [i, v] of picked.entries()) {
    try {
      const s = await inspectShort(v.id, client, o, { comments });
      s.discoveredVia = v.via;
      shorts.push(s);
      log({ i: i + 1, of: picked.length, id: v.id, views: s.views });
    } catch (e) { log({ id: v.id, code: e.code || e.message }); if (e.code === 'YOUTUBE_CHALLENGE') break; }
  }
  // Origin search for the most-viewed Shorts that carry a foreign/brand cue (the ones likely made from someone else's footage).
  const cue = s => s.signals.foreignTerms.length || s.signals.brands.length || s.signals.foreignOrigin;
  const traced = shorts.filter(cue).sort((a, b) => /^channel:/.test(b.discoveredVia) - /^channel:/.test(a.discoveredVia)).slice(0, origins);
  for (const s of traced) {
    try { Object.assign(s, await findOrigins(s, client, o)); log({ origin: s.videoId, found: s.origins.length }); }
    catch (e) { log({ origin: s.videoId, code: e.code || e.message }); }
  }
  for (const s of shorts) s.provenance = hypothesis(s, o);
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), ontology: o.id, method: 'anonymous public YouTube web; metadata + storyboard dHash only',
    queries, channels, shorts, summary: summarize(shorts) };
}

async function main() {
  const arg = n => process.argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const out = arg('out');
  if (!out) fail('USAGE: --out=<file>');
  const o = loadOntology(), client = createClient();
  const log = x => console.error(JSON.stringify(x));
  let result;
  if (arg('video')) {
    const short = await inspectShort(arg('video'), client, o, { comments: !process.argv.includes('--no-comments') });
    const manual = (arg('candidate') ?? '').split(',').map(s => /(?:v=|shorts\/|youtu\.be\/)?([\w-]{11})/.exec(s.trim())?.[1]).filter(Boolean);
    const extraQueries = (arg('origin-queries') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    Object.assign(short, await findOrigins(short, client, o, { manual, extraQueries }));
    short.provenance = hypothesis(short, o);
    result = { schemaVersion: 1, checkedAt: new Date().toISOString(), shorts: [short], summary: summarize([short]) };
  } else {
    const list = n => arg(n)?.split(',').map(s => s.trim()).filter(Boolean);
    result = await scan({ queries: list('queries'), channels: list('channels'), limit: Number(arg('limit') ?? 60), perQuery: Number(arg('per-query') ?? 4), origins: Number(arg('origins') ?? 15),
      comments: !process.argv.includes('--no-comments'), client, ontology: o, log });
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, shorts: result.shorts.length, summary: result.summary }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.log(JSON.stringify({ ok: false, code: e.code || e.message })); process.exitCode = 1; });
