import { createCdpPageFetcher } from './cdp-cookies.mjs';

// Amazon product videos (seller/brand uploads) for shopping shorts.
// Observed 2026-10-17 in the automation Canary profile (no login):
//  - PDP Document www.amazon.com/dp/{ASIN} carries a `"videos":[...]` array (image-block group IB_G1) with title,
//    durationTimestamp, videoWidth/Height, url (HLS master on m.media-amazon.com) and aciContentId.
//  - aciContentId namespace tells the uploader: amzn1.ive.seller.video / amzn1.ive.vendor.video = seller or brand;
//    anything else is treated as creator/customer content and excluded unless asked for.
//  - Only a 480p progressive MP4 exists next to the master (default.jobtemplate.mp4.480.mp4); HLS goes up to 1080p.
// Cookie-less Node GET of the PDP returns the validateCaptcha form (2026-10-15), so reads run inside an amazon.com tab.

const ORIGIN = 'https://www.amazon.com';
const ASIN = /^[A-Z0-9]{10}$/;
const MEDIA_HOST = 'm.media-amazon.com';
const SELLER_NS = /^amzn1\.ive\.(seller|vendor)\.video\./;

export class AmazonMediaError extends Error {
  constructor(code, receipt = null) { super(code); this.name = 'AmazonMediaError'; this.code = code; this.receipt = receipt; }
}
const fail = (code, receipt) => { throw new AmazonMediaError(code, receipt); };

function jsonArrayAfter(text, key) {
  const at = text.indexOf(`"${key}":[`);
  if (at < 0) return null;
  let i = text.indexOf('[', at), depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length && j - i < 2_000_000; j++) {
    const ch = text[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
  }
  return null;
}

function mediaUrl(raw) {
  if (typeof raw !== 'string') return null;
  try { const u = new URL(raw); return u.protocol === 'https:' && u.hostname === MEDIA_HOST ? u.href : null; } catch { return null; }
}

export function classifyAmazonVideo(aciContentId) {
  return typeof aciContentId === 'string' && SELLER_NS.test(aciContentId) ? 'seller_product_video' : 'creator_or_customer_video';
}

export function parseAmazonPdpVideos(html, asin, { includeCreator = false } = {}) {
  if (typeof html !== 'string' || html.length < 2000) fail('AMAZON_PDP_INVALID');
  if (/validateCaptcha|\/errors\/validateCaptcha/.test(html) && !html.includes('id="productTitle"')) fail('AMAZON_CHALLENGE_REQUIRED');
  const title = /<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400) || null;
  const raw = jsonArrayAfter(html, 'videos') ?? [];
  const seen = new Set();
  const videos = [];
  for (const v of raw) {
    if (!v || v.isVideo === false) continue;
    const hlsUrl = mediaUrl(v.url);
    const id = typeof v.mediaObjectId === 'string' && /^[0-9a-f]{16,64}$/.test(v.mediaObjectId) ? v.mediaObjectId : null;
    if (!hlsUrl || !id || seen.has(id)) continue;
    seen.add(id);
    const kind = classifyAmazonVideo(v.aciContentId);
    if (kind !== 'seller_product_video' && !includeCreator) continue;
    const mp4_480 = /\/default\.jobtemplate\.hls\.m3u8$/.test(new URL(hlsUrl).pathname) ? hlsUrl.replace(/hls\.m3u8$/, 'mp4.480.mp4') : null;
    videos.push({ videoId: id, kind, contentNamespace: (v.aciContentId || '').split('.').slice(0, 4).join('.') || null,
      title: typeof v.title === 'string' ? v.title.slice(0, 200) : null,
      duration: typeof v.durationTimestamp === 'string' ? v.durationTimestamp : null,
      width: Number(v.videoWidth) || null, height: Number(v.videoHeight) || null,
      hlsUrl, mp4Url480: mp4_480, thumbUrl: mediaUrl(v.slateUrl) ?? mediaUrl(v.thumbUrl), groupType: v.groupType ?? null });
  }
  return { asin, productUrl: `${ORIGIN}/dp/${asin}`, title, videos, hasSellerVideo: videos.some(v => v.kind === 'seller_product_video'),
    rawVideoCount: raw.length };
}

export function parseAmazonSearchAsins(html) {
  if (typeof html !== 'string') fail('AMAZON_SEARCH_INVALID');
  if (/validateCaptcha/.test(html) && !/data-asin="[A-Z0-9]{10}"/.test(html)) fail('AMAZON_CHALLENGE_REQUIRED');
  const out = [];
  for (const m of html.matchAll(/<div[^>]+data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"/g)) if (!out.includes(m[1])) out.push(m[1]);
  if (!out.length) for (const m of html.matchAll(/data-asin="([A-Z0-9]{10})"/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out.slice(0, 60);
}

export function createAmazonMediaClient({ cdpEndpoint = 'http://127.0.0.1:9333', createFetcher = createCdpPageFetcher, now = Date.now, minIntervalMs = 3000 } = {}) {
  const tab = createFetcher({ endpoint: cdpEndpoint, pageOrigin: ORIGIN, openUrl: `${ORIGIN}/`, allowedRequestOrigins: [ORIGIN] });
  let last = 0;
  const pace = async () => { const w = last + minIntervalMs - now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = now(); };
  const receiptOf = (path, r) => ({ method: 'GET', origin: ORIGIN, path, resourceType: 'Document', transport: 'browser_tab_fetch',
    checkedAt: new Date(now()).toISOString(), httpStatus: r.status, responseBytes: Buffer.byteLength(r.text ?? '') });
  return {
    async search({ keyword } = {}) {
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 120 || /[\r\n]/.test(keyword)) fail('AMAZON_INPUT_INVALID');
      await pace();
      const path = `/s?k=${encodeURIComponent(keyword.trim())}`;
      const r = await tab.fetchText(`${ORIGIN}${path}`);
      const receipt = receiptOf(path, r);
      if (r.status !== 200) fail('AMAZON_SEARCH_FAILED', receipt);
      return { keyword: keyword.trim(), asins: parseAmazonSearchAsins(r.text), receipt };
    },
    async productVideos({ asin, includeCreator = false } = {}) {
      if (typeof asin !== 'string' || !ASIN.test(asin)) fail('AMAZON_INPUT_INVALID');
      await pace();
      const path = `/dp/${asin}`;
      const r = await tab.fetchText(`${ORIGIN}${path}`);
      const receipt = receiptOf(path, r);
      if (r.status !== 200) fail('AMAZON_PDP_FAILED', receipt);
      return { ...parseAmazonPdpVideos(r.text, asin, { includeCreator }), receipt };
    },
  };
}
