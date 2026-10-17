#!/usr/bin/env node
// Product video sources for shopping shorts.
//   npm run video:sources -- aliexpress session-import [--cdp http://127.0.0.1:9333]
//   npm run video:sources -- aliexpress session-status
//   npm run video:sources -- aliexpress product-media --product-id <id> [--download <dir>] [--output <file>] [--transport browser|http] [--cdp <url>]
//   npm run video:sources -- 1688 search --keyword <中文关键词> [--page N] [--output <file>] [--cdp <url>]
//   npm run video:sources -- 1688 offer-media --offer-id <id> [--download <dir>] [--output <file>] [--cdp <url>]
import { writeFileSync, existsSync } from 'node:fs';
import { readCdpCookies } from '../lib/video-sources/cdp-cookies.mjs';
import { aliExpressBrowserTransport, aliExpressHttpTransport, aliExpressSessionStatus, createAliExpressMediaClient, createAliExpressSessionState, importAliExpressSession }
  from '../lib/video-sources/aliexpress-media.mjs';
import { downloadMedia } from '../lib/video-sources/media-download.mjs';
import { create1688Client } from '../lib/video-sources/alibaba-1688.mjs';

const [service, command, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
  if (!m) { console.error('UNKNOWN_ARGUMENT'); process.exit(2); }
  opts[m[1]] = m[2] ?? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true);
}
const COMMANDS = {
  aliexpress: { 'session-import': ['cdp'], 'session-status': [], 'product-media': ['product-id', 'download', 'output', 'transport', 'cdp'] },
  1688: { search: ['keyword', 'page', 'output', 'cdp'], 'offer-media': ['offer-id', 'download', 'output', 'cdp'] },
};
const out = value => console.log(JSON.stringify(value, null, 2));
const err = code => Object.assign(new Error(code), { code });
const cdp = typeof opts.cdp === 'string' ? opts.cdp : undefined;

async function aliexpress() {
  if (command === 'session-import') {
    const read = await readCdpCookies({ endpoint: cdp ?? 'http://127.0.0.1:9333', domainFilter: /(^|\.)aliexpress\.com$/i });
    const state = createAliExpressSessionState(read.cookies, { userAgent: read.userAgent, source: 'cdp_loopback' });
    return { browser: read.browser, ...importAliExpressSession(state) };
  }
  if (command === 'session-status') return aliExpressSessionStatus();
  const transport = opts.transport === 'http' ? aliExpressHttpTransport() : aliExpressBrowserTransport({ cdpEndpoint: cdp });
  const media = await createAliExpressMediaClient({ transport }).getProductMedia({ productId: String(opts['product-id'] ?? '') });
  let download = null;
  if (typeof opts.download === 'string' && media.video) {
    download = await downloadMedia({ url: media.video.playUrl, outDir: opts.download, fileStem: `aliexpress-${media.productId}-${media.video.videoId}`,
      allowedHosts: ['video.aliexpress-media.com', 'gv-vod-cdn.aliexpress-media.com'],
      provenance: { sourcePlatform: 'aliexpress', sourceUrl: media.productUrl, productId: media.productId, videoId: media.video.videoId,
        uploaderAccountId: media.video.uploaderAccountId, storeNum: media.store.storeNum, productTitle: media.title,
        rightsBasis: 'seller_product_video_unverified' } });
  }
  return { ...media, download };
}

async function alibaba1688() {
  const client = create1688Client({ cdpEndpoint: cdp });
  if (command === 'search') return client.search({ keyword: String(opts.keyword ?? ''), page: opts.page ? Number(opts.page) : 1 });
  const media = await client.offerMedia({ offerId: String(opts['offer-id'] ?? '') });
  let download = null;
  if (typeof opts.download === 'string' && media.video) {
    download = await downloadMedia({ url: media.video.playUrl, outDir: opts.download, fileStem: `1688-${media.offerId}-${media.video.videoId}`,
      allowedHosts: ['cloud.video.taobao.com', 'caiyuanbao.alicdn.com'],
      provenance: { sourcePlatform: '1688', sourceUrl: media.offerUrl, productId: media.offerId, videoId: media.video.videoId,
        uploaderAccountId: media.video.uploaderUserId, storeNum: media.supplier.sellerUserId, supplier: media.supplier.companyName,
        productTitle: media.title, rightsBasis: 'seller_product_video_unverified' } });
  }
  return { ...media, download };
}

try {
  const allowed = COMMANDS[service]?.[command];
  if (!allowed) throw err('COMMAND_REQUIRED');
  for (const key of Object.keys(opts)) if (!allowed.includes(key)) throw err('UNKNOWN_OPTION');
  if (typeof opts.output === 'string' && existsSync(opts.output)) throw err('OUTPUT_EXISTS');
  const data = service === 'aliexpress' ? await aliexpress() : await alibaba1688();
  const result = { service, command, ...data };
  if (typeof opts.output === 'string') writeFileSync(opts.output, JSON.stringify(result, null, 2), { flag: 'wx' });
  out(result);
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'VIDEO_SOURCES_FAILED';
  console.error(JSON.stringify({ error: code, receipt: error?.receipt ?? undefined, detail: error?.detail ?? undefined }));
  process.exitCode = 2;
}
