import { createCdpPageFetcher } from './cdp-cookies.mjs';

// AliExpress keyword search for the KR storefront. Observed 2026-10-17: the wholesale Document
// ko.aliexpress.com/w/wholesale-{slug}.html is server-rendered with 60 item cards in `_init_data_`
// (productId, image.imgUrl, title.displayTitle in Korean, prices.salePrice.minPrice in KRW, trade/evaluation).
// Read through an in-tab fetch like the PDP media reader.

const SITE = 'https://ko.aliexpress.com';
const IMAGE_HOST = /^ae-pic-[a-z0-9]+\.aliexpress-media\.com$/;

export class AliExpressSearchError extends Error {
  constructor(code, receipt = null) { super(code); this.name = 'AliExpressSearchError'; this.code = code; this.receipt = receipt; }
}
const fail = (code, receipt) => { throw new AliExpressSearchError(code, receipt); };

function decodeJsonString(raw) { try { return JSON.parse(`"${raw}"`); } catch { return null; } }

export function parseAliExpressSearchItems(html) {
  if (typeof html !== 'string' || html.length < 2000) fail('ALIEXPRESS_SEARCH_INVALID');
  if (/_____tmd_____|punish/.test(html.slice(0, 5000)) && !html.includes('"productId"')) fail('ALIEXPRESS_CHALLENGE_REQUIRED');
  const starts = [...html.matchAll(/"productId":"(\d{12,20})"/g)];
  const items = []; const seen = new Set();
  for (let k = 0; k < starts.length; k++) {
    const id = starts[k][1];
    if (seen.has(id)) continue;
    const seg = html.slice(starts[k].index, starts[k + 1]?.index ?? starts[k].index + 6000).slice(0, 6000);
    const title = /"displayTitle":"((?:[^"\\]|\\.){1,500})"/.exec(seg)?.[1];
    if (!title) continue;
    seen.add(id);
    const img = /"imgUrl":"((?:\/\/|https:\/\/)[^"]+)"/.exec(seg)?.[1];
    let imageUrl = null;
    try { const u = new URL(img?.startsWith('//') ? `https:${img}` : img); if (IMAGE_HOST.test(u.hostname)) imageUrl = u.href; } catch {}
    const sale = /"salePrice":\{[^{}]*?"minPrice":(\d+(?:\.\d+)?)[^{}]*?"currencyCode":"([A-Z]{3})"|"salePrice":\{[^{}]*?"currencyCode":"([A-Z]{3})"[^{}]*?"minPrice":(\d+(?:\.\d+)?)/.exec(seg);
    const tradeDesc = /"tradeDesc":"((?:[^"\\]|\\.){1,40})"/.exec(seg)?.[1];
    const star = /"starRating":(\d(?:\.\d)?)/.exec(seg)?.[1];
    items.push({ productId: id, title: decodeJsonString(title)?.replace(/\s+/g, ' ').trim() ?? null, imageUrl,
      price: sale ? Number(sale[1] ?? sale[4]) : null, currency: sale ? (sale[2] ?? sale[3]) : null,
      sold: tradeDesc ? decodeJsonString(tradeDesc) : null, rating: star ? Number(star) : null,
      productUrl: `${SITE}/item/${id}.html` });
  }
  return items.slice(0, 60);
}

export function createAliExpressSearchClient({ cdpEndpoint = 'http://127.0.0.1:9333', createFetcher = createCdpPageFetcher, now = Date.now, minIntervalMs = 3000 } = {}) {
  const tab = createFetcher({ endpoint: cdpEndpoint, pageOrigin: SITE, openUrl: `${SITE}/`, allowedRequestOrigins: [SITE], maxResponseBytes: 6 * 1024 * 1024 });
  let last = 0;
  return {
    async search({ keyword } = {}) {
      if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 120 || /[\r\n/]/.test(keyword)) fail('ALIEXPRESS_INPUT_INVALID');
      const w = last + minIntervalMs - now(); if (w > 0) await new Promise(r => setTimeout(r, w)); last = now();
      const slug = encodeURIComponent(keyword.trim().replace(/\s+/g, '-'));
      const path = `/w/wholesale-${slug}.html`;
      const r = await tab.fetchText(`${SITE}${path}`);
      const receipt = { method: 'GET', origin: SITE, path, resourceType: 'Document', transport: 'browser_tab_fetch',
        checkedAt: new Date(now()).toISOString(), httpStatus: r.status, responseBytes: Buffer.byteLength(r.text ?? '') };
      if (r.status !== 200) fail('ALIEXPRESS_SEARCH_FAILED', receipt);
      return { keyword: keyword.trim(), items: parseAliExpressSearchItems(r.text), receipt };
    },
  };
}
