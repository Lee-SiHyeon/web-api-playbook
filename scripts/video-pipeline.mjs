#!/usr/bin/env node
// Coupang product -> same/similar products abroad -> seller videos, as one manifest.
//   npm run video:pipeline -- --coupang-url <https://www.coupang.com/vp/products/...> --out <dir>
//   npm run video:pipeline -- --coupang-query "접이식 피아노" --pick 2 --out <dir>
// Options: --per-source 30  --max-videos 4  --include-type (also download "type" matches)  --judge codex|gateway|agy
// Needs the automation Canary on :9333, ffmpeg (FFMPEG_BIN or PATH), agy (keywords) and the Codex app (judge).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCoupangSeedClient } from '../lib/video-sources/coupang-seed.mjs';
import { findSimilarProducts } from '../lib/video-sources/similar.mjs';
import { createAliExpressSearchClient } from '../lib/video-sources/aliexpress-search.mjs';
import { createAliExpressMediaClient } from '../lib/video-sources/aliexpress-media.mjs';
import { create1688Client } from '../lib/video-sources/alibaba-1688.mjs';
import { createAmazonMediaClient } from '../lib/video-sources/amazon-media.mjs';
import { aiGatewayChat, codexJudge, llmJudge, productKeywords, visionJudge } from '../lib/video-sources/llm.mjs';
import { downloadHlsMedia, downloadMedia } from '../lib/video-sources/media-download.mjs';

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { console.error(JSON.stringify({ error: 'UNKNOWN_ARGUMENT' })); process.exit(2); }
  opts[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
}
const ALLOWED = ['coupang-url', 'coupang-query', 'pick', 'out', 'per-source', 'max-videos', 'include-type', 'judge', 'cdp'];
const log = (...a) => console.error('[pipeline]', ...a);

async function sellerVideo(c, clients) {
  if (c.source === 'aliexpress') {
    const m = await clients.aeMedia.getProductMedia({ productId: c.id });
    return m.video ? { kind: 'mp4', url: m.video.playUrl, videoId: m.video.videoId, hosts: ['video.aliexpress-media.com', 'gv-vod-cdn.aliexpress-media.com'],
      extra: { uploaderAccountId: m.video.uploaderAccountId, storeNum: m.store.storeNum } } : null;
  }
  if (c.source === '1688') {
    const m = await clients[1688].offerMedia({ offerId: c.id });
    return m.video ? { kind: 'mp4', url: m.video.playUrl, videoId: m.video.videoId, hosts: ['cloud.video.taobao.com', 'caiyuanbao.alicdn.com'],
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
      perSource: opts['per-source'] ? Number(opts['per-source']) : 30, judge, judgeTop: 10 });
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
        const saved = existsSync(path.join(dir, `${stem}.mp4`)) ? { file: `${stem}.mp4`, reused: true }
          : v.kind === 'hls' ? await downloadHlsMedia({ masterUrl: v.url, outDir: dir, fileStem: stem, allowedHosts: v.hosts, provenance })
          : await downloadMedia({ url: v.url, outDir: dir, fileStem: stem, allowedHosts: v.hosts, provenance });
        c.videoStatus = 'downloaded';
        videos.push({ videoId: v.videoId, file: saved.file, bytes: saved.bytes ?? null, source: c.source, productId: c.id, verdict: c.verdict });
        log('video', c.source, c.id, saved.file);
      } catch (error) { c.videoStatus = `error:${error?.code ?? 'MEDIA_FAILED'}`; }
    }
    const manifest = { schema: 'shorts-source-manifest-v1', createdAt: new Date().toISOString(),
      seed: { ...seed, receipt: undefined }, keywords, judge: { provider: found.judged?.provider, model: found.judged?.model, error: found.judged?.error },
      matches: found.candidates.filter(c => c.verdict === 'same' || c.verdict === 'type').map(c => ({ source: c.source, id: c.id, verdict: c.verdict,
        reason: c.verdictReason, title: c.title, url: c.url, price: c.price, currency: c.currency, signals: c.signals, modelMatch: c.modelMatch, videoStatus: c.videoStatus ?? null })),
      videos, sources: Object.fromEntries(Object.entries(found.sources).map(([k, v]) => [k, { keyword: v.keyword, found: v.found, error: v.error }])) };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    runs.push({ seed: seed.productId, title: seed.title, same: manifest.matches.filter(m => m.verdict === 'same').length,
      type: manifest.matches.filter(m => m.verdict === 'type').length, videos: videos.length, manifest: path.join(dir, 'manifest.json') });
  }
  console.log(JSON.stringify({ command: 'video-pipeline', runs }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: typeof error?.code === 'string' ? error.code : 'VIDEO_PIPELINE_FAILED', detail: error?.detail, message: String(error?.message ?? '').slice(0, 200) }));
  process.exitCode = 2;
}
