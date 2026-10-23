import { randomBytes } from 'node:crypto';
import { createCdpPageFetcher } from './cdp-cookies.mjs';
import { classifyMtopRet, mtopRetSummary, mtopSign, mtopToken, parseMtopBody } from './mtop-h5.mjs';

// 1688 wholesale search and offer-detail media (seller video, main images, supplier identity).
// Observed 2026-10-17 in the automation Canary profile (no login):
//  - search: GET h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/ (appKey 12574478,
//    data.appId 32517, params.method getOfferList, 60 offers/page) -> data.data.OFFER.items[].data
//  - detail: Document detail.1688.com/offer/{id}.html; server HTML carries the main-image component with
//    "video":{coverUrl,videoId,state,title,videoUrl}. Plain Node GET of the same Document returns a punish/x5sec page,
//    so both requests run inside a first-party tab (browser_tab_fetch). No login, no challenge solving.

const S_ORIGIN = 'https://s.1688.com';
const DETAIL_ORIGIN = 'https://detail.1688.com';
const H5 = 'https://h5api.m.1688.com';
const SEARCH_API = 'mtop.relationrecommend.wirelessrecommend.recommend';
const APP_KEY = '12574478';
const OFFER_ID = /^\d{9,15}$/;
const VIDEO_HOSTS = new Set(['cloud.video.taobao.com']);
const IMAGE_HOST = /^(cbu\d{2}|img)\.alicdn\.com$/;

export class Alibaba1688Error extends Error {
  constructor(code, receipt = null) { super(code); this.name = 'Alibaba1688Error'; this.code = code; this.receipt = receipt; }
}
const fail = (code, receipt) => { throw new Alibaba1688Error(code, receipt); };
const stripTags = s => typeof s === 'string' ? s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : null;

function httpsUrl(raw, test) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try { const u = new URL(raw.startsWith('//') ? `https:${raw}` : raw); return u.protocol === 'https:' && test(u.hostname) ? u.href : null; }
  catch { return null; }
}

/** Extract the JSON object that follows `"key":` at the first match, using brace matching (strings aware). */
export function extractJsonObjectAfter(text, key, from = 0) {
  const at = text.indexOf(`"${key}":{`, from);
  if (at < 0) return null;
  let i = text.indexOf('{', at), depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length && j - i < 200_000; j++) {
    const ch = text[j];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
  }
  return null;
}

export function parse1688SearchItems(body) {
  const items = body?.data?.data?.OFFER?.items;
  if (!Array.isArray(items)) fail('ALIBABA1688_SEARCH_SCHEMA_INVALID');
  return items.map(x => x?.data).filter(d => d && OFFER_ID.test(String(d.offerId))).map(d => ({
    offerId: String(d.offerId),
    title: stripTags(d.title)?.slice(0, 300) || null,
    priceCny: typeof d.priceInfo?.price === 'string' && /^\d+(\.\d+)?$/.test(d.priceInfo.price) ? d.priceInfo.price : null,
    bookedCount: typeof d.bookedCount === 'string' && /^\d+$/.test(d.bookedCount) ? Number(d.bookedCount) : null,
    repurchaseRate: typeof d.offerRepurchaseRate === 'string' && /^\d+%$/.test(d.offerRepurchaseRate) ? d.offerRepurchaseRate : null,
    imageUrl: httpsUrl(d.offerPicUrl, h => IMAGE_HOST.test(h)),
    offerUrl: `${DETAIL_ORIGIN}/offer/${d.offerId}.html`,
  }));
}

export function parse1688OfferDetail(html, offerId) {
  if (typeof html !== 'string' || html.length < 1000) fail('ALIBABA1688_DETAIL_INVALID');
  if (/_____tmd_____|x5secdata|punish/.test(html.slice(0, 4000)) && !html.includes('"offerTitle"')) fail('ALIBABA1688_CHALLENGE_REQUIRED');
  const str = key => { const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.){1,400})"`).exec(html); try { return m ? JSON.parse(`"${m[1]}"`) : null; } catch { return null; } };
  const num = key => { const m = new RegExp(`"${key}":(\\d{3,20})`).exec(html); return m ? m[1] : null; };
  const v = extractJsonObjectAfter(html, 'video');
  let video = null;
  if (v && Number(v.videoId) > 0) {
    const playUrl = httpsUrl(v.videoUrl, h => VIDEO_HOSTS.has(h));
    if (playUrl) video = { videoId: String(v.videoId), playUrl, coverUrl: httpsUrl(v.coverUrl, h => IMAGE_HOST.test(h)),
      title: typeof v.title === 'string' ? v.title.slice(0, 200) : null, state: Number.isInteger(v.state) ? v.state : null,
      uploaderUserId: /\/play\/u\/(\d{4,24})\//.exec(new URL(playUrl).pathname)?.[1] ?? null, kind: 'seller_product_video' };
  }
  const mainAt = html.indexOf('"mainImage":[');
  const images = mainAt < 0 ? [] : [...new Set((html.slice(mainAt, mainAt + 20_000).match(/https:\/\/cbu\d{2}\.alicdn\.com\/img\/ibank\/[^"\\]+?\.(?:jpg|png|webp)/g) || []))].slice(0, 20);
  return { offerId, offerUrl: `${DETAIL_ORIGIN}/offer/${offerId}.html`, title: str('offerTitle') ?? str('subject'), video, images,
    supplier: { companyName: str('companyName'), sellerUserId: num('sellerUserId'), sellerLoginId: str('sellerLoginId') },
    hasVideo: video !== null };
}

export function create1688Client({ cdpEndpoint = 'http://127.0.0.1:9333', createFetcher = createCdpPageFetcher, now = Date.now, minIntervalMs = 3000 } = {}) {
  const searchTab = createFetcher({ endpoint: cdpEndpoint, pageOrigin: S_ORIGIN, openUrl: `${S_ORIGIN}/selloffer/offer_search.htm?keywords=%E9%92%A2%E7%90%B4&charset=utf8`, allowedRequestOrigins: [H5] });
  const detailTab = createFetcher({ endpoint: cdpEndpoint, pageOrigin: DETAIL_ORIGIN, openUrl: `${DETAIL_ORIGIN}/offer/1047106487219.html`, allowedRequestOrigins: [DETAIL_ORIGIN] });
  let last = 0;
  const pace = async () => { const w = last + minIntervalMs - now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = now(); };
  return {
    async search({ keyword, page = 1 } = {}) {
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 60 || /[\r\n]/.test(keyword)) fail('ALIBABA1688_INPUT_INVALID');
      if (!Number.isInteger(page) || page < 1 || page > 50) fail('ALIBABA1688_INPUT_INVALID');
      const data = JSON.stringify({ appId: 32517, params: JSON.stringify({ beginPage: page, pageSize: 60, method: 'getOfferList',
        pageId: randomBytes(24).toString('base64url').slice(0, 48), verticalProductFlag: 'pcmarket', searchScene: 'pcOfferSearch',
        charset: 'utf8', keywords: encodeURIComponent(keyword.trim()) }) });
      const receipt = { api: SEARCH_API, origin: H5, transport: 'browser_tab_fetch', checkedAt: new Date(now()).toISOString(), attempts: [] };
      for (let attempt = 0; attempt < 2; attempt++) {
        await pace();
        const token = mtopToken((await searchTab.cookies([`${H5}/`])).find(c => c.name === '_m_h5_tk')?.value);
        const t = String(now());
        const url = new URL(`${H5}/h5/${SEARCH_API}/2.0/`);
        url.search = new URLSearchParams({ jsv: '2.7.4', appKey: APP_KEY, t, sign: mtopSign({ token, t, appKey: APP_KEY, data }), api: SEARCH_API,
          v: '2.0', type: 'originaljson', dataType: 'json', timeout: '20000', data }).toString();
        const r = await searchTab.fetchText(url.href);
        const body = parseMtopBody(r.text);
        const verdict = classifyMtopRet(body?.ret);
        receipt.attempts.push({ httpStatus: r.status, ret: mtopRetSummary(body?.ret), verdict, responseBytes: Buffer.byteLength(r.text ?? '') });
        if (verdict === 'token_refresh' && attempt === 0) continue;
        if (verdict === 'challenge') fail('ALIBABA1688_CHALLENGE_REQUIRED', receipt);
        if (r.status !== 200 || verdict !== 'success') fail('ALIBABA1688_SEARCH_FAILED', receipt);
        return { keyword: keyword.trim(), page, items: parse1688SearchItems(body), receipt };
      }
      fail('ALIBABA1688_SEARCH_FAILED', receipt);
    },
    async offerMedia({ offerId } = {}) {
      if (typeof offerId !== 'string' || !OFFER_ID.test(offerId)) fail('ALIBABA1688_INPUT_INVALID');
      await pace();
      const r = await detailTab.fetchText(`${DETAIL_ORIGIN}/offer/${offerId}.html`);
      const receipt = { method: 'GET', origin: DETAIL_ORIGIN, path: `/offer/${offerId}.html`, resourceType: 'Document', transport: 'browser_tab_fetch',
        checkedAt: new Date(now()).toISOString(), httpStatus: r.status, responseBytes: Buffer.byteLength(r.text ?? '') };
      if (r.status !== 200) fail('ALIBABA1688_DETAIL_FAILED', receipt);
      return { ...parse1688OfferDetail(r.text, offerId), receipt };
    },
  };
}
