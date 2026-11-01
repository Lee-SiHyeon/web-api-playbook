#!/usr/bin/env node
// Coupang product -> same/similar products abroad -> seller videos, as one manifest.
//   npm run video:pipeline -- --coupang-url <https://www.coupang.com/vp/products/...> --out <dir>
//   npm run video:pipeline -- --coupang-query "접이식 피아노" --pick 2 --out <dir>
// Options: --per-source 120  --pages-1688 2  --judge-max (all)  --max-videos 4  --include-type (also download "type" matches)
//          --judge codex|gateway|agy  --no-video-check (skip the frame check that rejects factory tours / other models)
// Search coverage (2026-10-26, owner: "판매자 영상이 있는데 못찾는 누락이 발생하지 않게"): every keyword variant per source,
// 1688 two result pages, judging every candidate in source-interleaved batches of 10 (about 5-10 s each) instead of the top 10 by dHash. The manifest
// carries a per-source funnel (coverage) and possibleMiss, so "0 same" with candidates left unjudged is never read as absence.
// Needs the automation Canary on :9333, ffmpeg (FFMPEG_BIN or PATH), agy (keywords) and the Codex app (judge).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createCoupangSeedClient } from '../lib/video-sources/coupang-seed.mjs';
import { findSimilarProducts } from '../lib/video-sources/similar.mjs';
import { createAliExpressSearchClient } from '../lib/video-sources/aliexpress-search.mjs';
import { createAliExpressMediaClient } from '../lib/video-sources/aliexpress-media.mjs';
import { create1688Client } from '../lib/video-sources/alibaba-1688.mjs';
import { createAmazonMediaClient } from '../lib/video-sources/amazon-media.mjs';
import { aiGatewayChat, codexJudge, codexVideoCheck, llmJudge, productKeywords, visionJudge } from '../lib/video-sources/llm.mjs';
import { downloadHlsMedia, downloadMedia } from '../lib/video-sources/media-download.mjs';

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { console.error(JSON.stringify({ error: 'UNKNOWN_ARGUMENT' })); process.exit(2); }
  opts[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
}
const ALLOWED = ['coupang-url', 'coupang-query', 'pick', 'out', 'per-source', 'pages-1688', 'judge-max', 'max-videos', 'include-type', 'judge', 'cdp', 'no-video-check'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
const log = (...a) => console.error('[pipeline]', ...a);

// Fewer videos than asked is only an answer when every source searched cleanly and every candidate was judged.
function possibleMiss(coverage, videos, maxVideos) {
  if (videos >= maxVideos) return null;
  const reasons = [];
  for (const [k, c] of Object.entries(coverage ?? {})) { if (c.error) reasons.push(`${k}:search_${c.error}`); if (c.unjudged) reasons.push(`${k}:unjudged_${c.unjudged}`); }
  return reasons.length ? reasons : null;
}

// Six frames spread over the file (5%..95%), 480 px wide, for the video-level check.
function sampleFrames(file) {
  const ff = process.env.FFMPEG_BIN || 'ffmpeg'; const fp = process.env.FFPROBE_BIN || 'ffprobe';
  const dur = Number(spawnSync(fp, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout) || 0;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vframes-'));
  const frames = [0.05, 0.23, 0.41, 0.59, 0.77, 0.95].map((k, i) => {
    const out = path.join(dir, `f${i}.jpg`);
    spawnSync(ff, ['-v', 'error', '-y', '-ss', String((dur * k).toFixed(2)), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', out]);
    return existsSync(out) ? out : null;
  }).filter(Boolean);
  return { dir, frames, duration: dur };
}

async function sellerVideo(c, clients) {
  if (c.source === 'aliexpress') {
    const m = await clients.aeMedia.getProductMedia({ productId: c.id });
    return m.video ? { kind: 'mp4', url: m.video.playUrl, videoId: m.video.videoId, hosts: ['video.aliexpress-media.com', 'gv-vod-cdn.aliexpress-media.com'],
      extra: { uploaderAccountId: m.video.uploaderAccountId, storeNum: m.store.storeNum } } : null;
  }
  if (c.source === '1688') {
    const m = await clients[1688].offerMedia({ offerId: c.id });
    return m.video ? { kind: 'mp4', url: m.video.playUrl, videoId: m.video.videoId, hosts: ['cloud.video.taobao.com', 'caiyuanbao.alicdn.com'], referer: 'https://detail.1688.com/',
      extra: { uploaderAccountId: m.video.uploaderUserId, supplier: m.supplier.companyName } } : null;
  }
  if (c.source === 'amazon') {
    const m = await clients.amazon.productVideos({ asin: c.id });
    const v = m.videos[0];
    return v ? { kind: 'hls', url: v.hlsUrl, videoId: v.videoId, hosts: ['m.media-amazon.com'], extra: { contentNamespace: v.contentNamespace, videoTitle: v.title } } : null;
  }
  return null;
}

try {
  for (const k of Object.keys(opts)) if (!ALLOWED.includes(k)) throw Object.assign(new Error('UNKNOWN_OPTION'), { code: 'UNKNOWN_OPTION' });
  if (typeof opts.out !== 'string') throw Object.assign(new Error('OUT_REQUIRED'), { code: 'OUT_REQUIRED' });
  const cdpEndpoint = typeof opts.cdp === 'string' ? opts.cdp : undefined;
  const coupang = createCoupangSeedClient({ cdpEndpoint });
  const clients = { aliexpress: createAliExpressSearchClient({ cdpEndpoint }), 1688: create1688Client({ cdpEndpoint }),
    amazon: createAmazonMediaClient({ cdpEndpoint }), aeMedia: createAliExpressMediaClient({}) };
  const judge = opts.judge === 'agy' ? llmJudge() : opts.judge === 'gateway' ? visionJudge({ chat: aiGatewayChat() }) : codexJudge();
  const maxVideos = opts['max-videos'] ? Number(opts['max-videos']) : 4;
  const videoCheck = opts['no-video-check'] ? null : codexVideoCheck();

  let seedUrls = [];
  if (typeof opts['coupang-url'] === 'string') seedUrls = [opts['coupang-url'].split('?')[0]];
  else if (typeof opts['coupang-query'] === 'string') {
    const s = await coupang.search({ keyword: opts['coupang-query'] });
    seedUrls = s.products.slice(0, opts.pick ? Number(opts.pick) : 1).map(p => p.productUrl.split('?')[0]);
    log('coupang search', s.products.length, 'non-sponsored; seeds', seedUrls.length);
  } else throw Object.assign(new Error('SEED_REQUIRED'), { code: 'SEED_REQUIRED' });

  const runs = [];
  for (const url of seedUrls) {
    const seed = await coupang.productSeed({ url });
    log('seed', seed.productId, seed.title);
    const keywords = await productKeywords({ title: seed.title });
    log('keywords', JSON.stringify(keywords));
    const found = await findSimilarProducts({ seed: { title: seed.title, image: seed.image, lang: 'ko' }, keywords,
      clients: { aliexpress: clients.aliexpress, 1688: clients[1688], amazon: clients.amazon },
      perSource: opts['per-source'] ? Number(opts['per-source']) : 120, pages: { 1688: opts['pages-1688'] ? Number(opts['pages-1688']) : 2 },
      judge, judgeTop: opts['judge-max'] ? Number(opts['judge-max']) : Infinity, judgeBatch: 10 }); // judge all: a "same" listing can still fail the video check
    // Matches carried over from earlier runs of this Coupang product: keywords are LLM-generated and differ per run, so a
    // listing judged "same" once (2026-10-26: AliExpress 1005011886393071 in run v3) could vanish from the next run's pool.
    const cacheFile = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'web-api-playbook', 'video-pipeline', `coupang-${seed.productId}.json`);
    const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : { matches: {} };
    for (const c of found.candidates.filter(c => c.verdict === 'same')) cache.matches[`${c.source}:${c.id}`] = { source: c.source, id: c.id, title: c.title, url: c.url, imageUrl: c.imageUrl, verdict: 'same', verdictReason: c.verdictReason, firstSeen: cache.matches[`${c.source}:${c.id}`]?.firstSeen ?? new Date().toISOString() };
    const inRun = new Set(found.candidates.map(c => `${c.source}:${c.id}`));
    const carried = Object.values(cache.matches).filter(m => !inRun.has(`${m.source}:${m.id}`)).map(m => ({ ...m, carried: true }));
    found.candidates.push(...carried);
    mkdirSync(path.dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
    if (carried.length) log('carried over', carried.length, 'same match(es) from earlier runs');
    const wanted = found.candidates.filter(c => c.verdict === 'same' || (opts['include-type'] && c.verdict === 'type'));
    const dir = path.resolve(opts.out, `coupang-${seed.productId}`);
    mkdirSync(dir, { recursive: true });
    const videos = [];
    for (const c of wanted) {
      if (videos.length >= maxVideos) break;
      try {
        const v = await sellerVideo(c, clients);
        if (!v) { c.videoStatus = 'none'; continue; }
        if (videos.some(x => x.videoId === v.videoId)) { c.videoStatus = 'duplicate'; continue; }
        const provenance = { sourcePlatform: c.source, sourceUrl: c.url, productId: c.id, videoId: v.videoId, productTitle: c.title,
          matchedCoupangProductId: seed.productId, verdict: c.verdict, verdictReason: c.verdictReason ?? null, ...v.extra,
          rightsBasis: 'seller_product_video_unverified' };
        const stem = `${c.source}-${c.id}-${String(v.videoId).slice(0, 16)}`;
        const download = () => v.kind === 'hls' ? downloadHlsMedia({ masterUrl: v.url, outDir: dir, fileStem: stem, allowedHosts: v.hosts, provenance })
          : downloadMedia({ url: v.url, outDir: dir, fileStem: stem, allowedHosts: v.hosts, provenance, referer: v.referer, userAgent: v.referer ? UA : undefined });
        // one retry for uncoded transport failures (CDN resets): a coded refusal (host, size, provenance) is final
        const saved = existsSync(path.join(dir, `${stem}.mp4`)) ? { file: `${stem}.mp4`, reused: true }
          : await download().catch(async error => { if (error?.code) throw error; await new Promise(r => setTimeout(r, 3000)); return download(); });
        if (videoCheck) {
          const { dir: fdir, frames, duration } = sampleFrames(path.join(dir, saved.file));
          const vc = frames.length ? await videoCheck({ seed, frames }) : { error: 'NO_FRAMES' };
          rmSync(fdir, { recursive: true, force: true });
          c.videoCheck = { ...vc, duration: Number(duration.toFixed(1)) };
          if (vc.match !== 'same') {
            mkdirSync(path.join(dir, 'rejected'), { recursive: true });
            for (const n of [saved.file, `${saved.file}.provenance.json`]) if (existsSync(path.join(dir, n))) renameSync(path.join(dir, n), path.join(dir, 'rejected', n));
            c.videoStatus = `rejected:${vc.match ?? vc.error}/${vc.content ?? '-'}`; log('video rejected', c.source, c.id, c.videoStatus, vc.reason ?? '');
            continue;
          }
        }
        c.videoStatus = 'downloaded';
        videos.push({ videoId: v.videoId, file: saved.file, bytes: saved.bytes ?? null, source: c.source, productId: c.id, verdict: c.verdict, videoCheck: c.videoCheck ?? null });
        log('video', c.source, c.id, saved.file, c.videoCheck?.content ?? '');
      } catch (error) { c.videoStatus = `error:${error?.code ?? 'MEDIA_FAILED'}`; c.videoError = String(error?.message ?? '').slice(0, 200); log('video error', c.source, c.id, c.videoStatus, c.videoError); }
    }
    const manifest = { schema: 'shorts-source-manifest-v1', createdAt: new Date().toISOString(),
      seed: { ...seed, receipt: undefined }, keywords, judge: { provider: found.judged?.provider, model: found.judged?.model, calls: found.judged?.calls ?? null, error: found.judged?.error },
      coverage: found.coverage, possibleMiss: possibleMiss(found.coverage, videos.length, maxVideos),
      matches: found.candidates.filter(c => c.verdict === 'same' || c.verdict === 'type').map(c => ({ source: c.source, id: c.id, verdict: c.verdict, carried: c.carried ?? false,
        reason: c.verdictReason, title: c.title, url: c.url, price: c.price, currency: c.currency, signals: c.signals, modelMatch: c.modelMatch, videoStatus: c.videoStatus ?? null, videoError: c.videoError ?? null, videoCheck: c.videoCheck ?? null })),
      videos, sources: Object.fromEntries(Object.entries(found.sources).map(([k, v]) => [k, { keyword: v.keyword, keywords: v.keywords, queries: v.queries, found: v.found, error: v.error }])) };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    runs.push({ seed: seed.productId, title: seed.title, same: manifest.matches.filter(m => m.verdict === 'same').length,
      type: manifest.matches.filter(m => m.verdict === 'type').length, videos: videos.length, possibleMiss: manifest.possibleMiss,
      judged: Object.values(found.coverage).reduce((a, c) => a + c.judged, 0), candidates: found.candidates.length, manifest: path.join(dir, 'manifest.json') });
  }
  console.log(JSON.stringify({ command: 'video-pipeline', runs }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: typeof error?.code === 'string' ? error.code : 'VIDEO_PIPELINE_FAILED', detail: error?.detail, message: String(error?.message ?? '').slice(0, 200) }));
  process.exitCode = 2;
}
