#!/usr/bin/env node
// Similar-product discovery across no-login sources, with optional seller-video lookup.
//   npm run video:similar -- --title "<seed title>" --image <https-url|file> [--ko ..] [--zh ..] [--en ..]
//        [--sources aliexpress,1688,amazon] [--per-source 20] [--judge] [--videos 5] [--output <file>]
// Missing keywords are generated with the logged-in agy CLI. Needs ffmpeg (FFMPEG_BIN or PATH) for image hashing.
import { writeFileSync, existsSync } from 'node:fs';
import { findSimilarProducts } from '../lib/video-sources/similar.mjs';
import { createAliExpressSearchClient } from '../lib/video-sources/aliexpress-search.mjs';
import { create1688Client } from '../lib/video-sources/alibaba-1688.mjs';
import { createAmazonMediaClient } from '../lib/video-sources/amazon-media.mjs';
import { createAliExpressMediaClient } from '../lib/video-sources/aliexpress-media.mjs';
import { aiGatewayChat, codexJudge, llmJudge, productKeywords, visionJudge } from '../lib/video-sources/llm.mjs';

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) { console.error(JSON.stringify({ error: 'UNKNOWN_ARGUMENT' })); process.exit(2); }
  opts[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
}
const ALLOWED = ['title', 'image', 'ko', 'zh', 'en', 'sources', 'per-source', 'judge', 'judge-model', 'videos', 'output', 'cdp'];
try {
  for (const k of Object.keys(opts)) if (!ALLOWED.includes(k)) throw Object.assign(new Error('UNKNOWN_OPTION'), { code: 'UNKNOWN_OPTION' });
  if (typeof opts.output === 'string' && existsSync(opts.output)) throw Object.assign(new Error('OUTPUT_EXISTS'), { code: 'OUTPUT_EXISTS' });
  const title = typeof opts.title === 'string' ? opts.title : null;
  let keywords = { ko: opts.ko, zh: opts.zh, en: opts.en };
  let keywordProvider = 'caller';
  if ((!keywords.ko || !keywords.zh || !keywords.en) && title) {
    const gen = await productKeywords({ title });
    keywords = { ko: keywords.ko ?? gen.ko, zh: keywords.zh ?? gen.zh, en: keywords.en ?? gen.en };
    keywordProvider = gen.provider;
  }
  const want = new Set(String(opts.sources ?? 'aliexpress,1688,amazon').split(','));
  const cdpEndpoint = typeof opts.cdp === 'string' ? opts.cdp : undefined;
  const amazon = want.has('amazon') ? createAmazonMediaClient({ cdpEndpoint }) : null;
  const c1688 = want.has('1688') ? create1688Client({ cdpEndpoint }) : null;
  const clients = { ...(want.has('aliexpress') ? { aliexpress: createAliExpressSearchClient({ cdpEndpoint }) } : {}),
    ...(c1688 ? { 1688: c1688 } : {}), ...(amazon ? { amazon } : {}) };
  const result = await findSimilarProducts({ seed: { title, image: opts.image, lang: 'ko' }, keywords, clients,
    perSource: opts['per-source'] ? Number(opts['per-source']) : 20,
    // --judge (= codex): Codex CLI on the ChatGPT subscription, images+titles, schema-forced verdicts.
    // --judge gateway: AI Gateway vision model; --judge agy: text-only judge through the agy CLI.
    judge: !opts.judge ? undefined : opts.judge === 'agy' ? llmJudge()
      : opts.judge === 'gateway' ? visionJudge({ chat: aiGatewayChat({ model: typeof opts['judge-model'] === 'string' ? opts['judge-model'] : 'google/gemini-2.5-flash' }) })
      : codexJudge({ model: typeof opts['judge-model'] === 'string' ? opts['judge-model'] : 'gpt-6-luna' }),
    judgeTop: 10 });
  // Seller-video lookup for the top N (skipping judged "different").
  const nVideos = opts.videos ? Number(opts.videos) : 0;
  if (nVideos > 0) {
    // candidates are already ordered same > type > unjudged > different
    const ae = clients.aliexpress ? createAliExpressMediaClient({}) : null;
    let looked = 0;
    for (const c of result.candidates) {
      if (looked >= nVideos) break;
      if (c.verdict === 'different') continue;
      looked++;
      try {
        if (c.source === 'aliexpress') { const m = await ae.getProductMedia({ productId: c.id }); c.video = m.video; }
        else if (c.source === '1688') { const m = await c1688.offerMedia({ offerId: c.id }); c.video = m.video; }
        else if (c.source === 'amazon') { const m = await amazon.productVideos({ asin: c.id }); c.video = m.videos[0] ?? null; c.videoCount = m.videos.length; }
      } catch (error) { c.videoError = error?.code ?? 'MEDIA_FAILED'; }
    }
  }
  const out = { command: 'similar', keywords: { ...keywords, provider: keywordProvider }, ...result };
  if (typeof opts.output === 'string') writeFileSync(opts.output, JSON.stringify(out, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(out, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: typeof error?.code === 'string' ? error.code : 'VIDEO_SIMILAR_FAILED', detail: error?.detail }));
  process.exitCode = 2;
}
