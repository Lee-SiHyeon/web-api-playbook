// 29CM (29CM, www.29cm.co.kr) anonymous public reads: category best ranking (실시간/일간/주간),
// keyword search (listing API), product detail and options. Contracts were observed in the browser
// (Canary CDP, 2026-10-20) and replayed with plain Node fetch. See references/commerce-musinsa.md (29CM section).
//
// Boundary: no cookies, no account, no login, no writes. www.29cm.co.kr/robots.txt allows "/" for all
// bots except a few paths (/embed, /my-page, /order, /auth, /inbox, ...). Goods detail reads the public
// product page (/products/{id}) once and the options JSON; ranking and search use the JSON hosts.
// The JSON calls send Origin/Referer set to www.29cm.co.kr.

import { createFashionHttp, fashionFail } from './fashion-http.mjs';

export const CM29_HOSTS = Object.freeze(['recommend-api.29cm.co.kr', 'display-bff-api.29cm.co.kr', 'bff-api.29cm.co.kr', 'www.29cm.co.kr']);
export const CM29_WEB_ORIGIN = 'https://www.29cm.co.kr';
export const CM29_IMAGE_ORIGIN = 'https://img.29cm.co.kr';

// Women's category codes. Observed 2026-10-20 from the best-category and listing trees.
// `top` 상의, `outer` 아우터, `bottom` 바지, `dress` 원피스, `skirt` 스커트,
// `swim` 레져 > 수영 (includes unisex and kids swim items), `bag` 여성가방, `hat` 여성모자,
// `sunglasses` 여성액세서리 > 아이웨어 (sunglasses and eyeglass frames).
export const CM29_CATEGORY_CODES = Object.freeze({
  top: '268103100', outer: '268102100', bottom: '268106100', dress: '268104100', skirt: '268107100',
  swim: '286104100', bag: '269100100', hat: '310100100', sunglasses: '271104100',
});
// Observed UI tabs 실시간/일간/주간/월간 map to these periodSort values (from the best-items page bundle).
export const CM29_RANK_PERIODS = Object.freeze({ realtime: 'NOW', daily: 'ONE_DAY', weekly: 'ONE_WEEK', monthly: 'ONE_MONTH' });
// Observed sort list for the listing API. 29CM has no "인기순" label; 판매순 (MOST_SOLD) is the closest.
export const CM29_SEARCH_SORTS = Object.freeze(['RECOMMENDED', 'NEWEST', 'MOST_REVIEWED', 'LOWEST_PRICE', 'HIGHEST_PRICE', 'HIGHEST_DISCOUNT', 'MOST_LIKED', 'MOST_SOLD']);

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = v => (Number.isSafeInteger(v) ? v : null);
const str = v => (typeof v === 'string' && v.length ? v : null);
const fail = (code, extra) => fashionFail(code, extra);

export function cm29ItemNo(value) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,11}$/.test(text)) fail('CM29_ID_INVALID');
  return Number(text);
}

export function cm29ProductUrl(itemNo) {
  return `${CM29_WEB_ORIGIN}/products/${cm29ItemNo(itemNo)}`;
}

/** Image paths are relative ("/item/202610/...") in detail and best responses; thumbnails in search are absolute. */
export function cm29ImageUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${CM29_IMAGE_ORIGIN}${value}`;
  return /^https:\/\//.test(value) ? value : null;
}

/** Best (ranking) items. The list order is the rank (the API has no rank field); the request returns up to 100. */
export function cm29BestUrl({ categoryCode, period }) {
  const periodSort = CM29_RANK_PERIODS[period];
  if (!periodSort) fail('CM29_PERIOD_INVALID');
  const u = new URL('https://recommend-api.29cm.co.kr/api/v4/best/items');
  for (const [k, v] of Object.entries({ categoryList: categoryCode, periodSort, limit: 100, offset: 0 })) u.searchParams.set(k, String(v));
  return u.href;
}

export function parseBestItems(body, { limit }) {
  if (!object(body?.data) || !Array.isArray(body.data.content)) fail('CM29_SCHEMA_INVALID', { where: 'best' });
  return body.data.content.slice(0, limit).map((x, i) => {
    const itemNo = cm29ItemNo(x.itemNo);
    const cat = (x.frontCategoryInfo ?? [])[0] ?? null;
    return {
      rank: i + 1, goodsNo: itemNo, name: str(x.itemName),
      brand: str(x.frontBrandNameKor), brandEnglish: str(x.frontBrandNameEng),
      price: { final: int(x.lastSalePrice), normal: int(x.consumerPrice), discountRate: int(x.lastSalePercent) },
      soldOut: x.isSoldOut === true,
      image: cm29ImageUrl(x.imageUrl),
      productUrl: cm29ProductUrl(itemNo),
      reviewCount: int(x.reviewCount),
      reviewAveragePoint: typeof x.reviewAveragePoint === 'number' ? x.reviewAveragePoint : null,
      heartCount: int(x.heartCount),
      category: cat ? { depth1: str(cat.category1Name), depth2: str(cat.category2Name), depth3: str(cat.category3Name) } : null,
    };
  });
}

/** POST listing (search). Body mirrors the page request: keyword, pageType SRP, sortType, facets, pageRequest. */
export function cm29SearchBody({ keyword, sort, page = 1, size = 50 }) {
  return { keyword, pageType: 'SRP', sortType: sort, facets: {}, pageRequest: { page, size } };
}
export const CM29_SEARCH_URL = 'https://display-bff-api.29cm.co.kr/api/v1/listing/items?colorchipVariant=treatment';

export function parseListing(body) {
  if (!object(body?.data) || !Array.isArray(body.data.list)) fail('CM29_SCHEMA_INVALID', { where: 'listing' });
  const items = body.data.list.filter(x => object(x?.itemInfo) && x.itemInfo.itemType !== 'AD' && x.itemEvent?.eventProperties?.isAd !== true).map(x => {
    const info = x.itemInfo;
    const itemNo = cm29ItemNo(x.itemId);
    return {
      goodsNo: itemNo, name: str(info.productName), brand: str(info.brandName), brandId: int(info.brandId),
      price: { final: int(info.displayPrice), normal: int(info.originalPrice), discountRate: int(info.saleRate) },
      soldOut: info.isSoldOut === true,
      image: cm29ImageUrl(info.thumbnailUrl),
      productUrl: cm29ProductUrl(itemNo),
      reviewCount: int(info.reviewCount),
      reviewAveragePoint: typeof info.reviewScore === 'number' ? info.reviewScore : null,
      likeCount: int(info.likeCount),
    };
  });
  const p = body.data.pagination ?? {};
  return { totalCount: int(p.totalCount), page: int(p.page), hasNext: p.hasNext === true, items };
}

/**
 * The product page (www.29cm.co.kr/products/{id}, allowed by robots.txt) embeds the same product DTO as
 * React Flight rows: lines "<hex id>:<json>" inside self.__next_f.push([1,"..."]). Object values refer to
 * other rows as "$<hex id>". This resolves them without a browser. The bff-api v5 product-detail endpoint
 * answers plain Node fetch with 403 HTML (observed 2026-10-20), so it is not used.
 */
export function cm29PageRows(html) {
  const pieces = [];
  for (const m of String(html).matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try { pieces.push(JSON.parse(`"${m[1]}"`)); } catch { /* malformed chunk: skipped */ }
  }
  const rows = new Map();
  for (const line of pieces.join('').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0 && /^[0-9a-f]+$/.test(line.slice(0, i))) rows.set(line.slice(0, i), line.slice(i + 1));
  }
  return rows;
}

export function cm29ProductFromPage(html, itemNo) {
  const rows = cm29PageRows(html);
  const cache = new Map();
  const parse = id => {
    if (!cache.has(id)) {
      let value;
      try { value = JSON.parse(rows.get(id)); } catch { value = undefined; }
      cache.set(id, value);
    }
    return cache.get(id);
  };
  const resolve = (v, depth = 0) => {
    if (depth > 12) return undefined;
    if (typeof v === 'string' && /^\$[0-9a-f]+$/.test(v) && rows.has(v.slice(1))) return resolve(parse(v.slice(1)), depth + 1);
    if (Array.isArray(v)) return v.map(x => resolve(x, depth + 1));
    if (object(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, depth + 1)]));
    return v;
  };
  for (const id of rows.keys()) {
    const v = parse(id);
    if (object(v) && v.itemNo === Number(itemNo) && 'itemImages' in v) return resolve(v);
  }
  return null;
}

/** Product detail (from the page DTO, or any {data} wrapper with the same fields): prices, images, specs, reviews. */
export function parseProductDetail(body) {
  const d = body?.data;
  if (!object(d) || !Number.isSafeInteger(d.itemNo)) fail('CM29_SCHEMA_INVALID', { where: 'detail' });
  const gallery = (d.itemImages ?? []).map(i => cm29ImageUrl(i?.imageUrl)).filter(Boolean);
  const description = [...String(d.itemDescriptions ?? '').matchAll(/<img\b[^>]*?\bsrc="((?:https:)?\/\/[^"]+)"/g)]
    .map(m => cm29ImageUrl(m[1])).filter(u => u && /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(u));
  const cat = (d.frontCategoryInfo ?? [])[0] ?? null;
  return {
    goodsNo: d.itemNo, name: str(d.itemName),
    brand: { code: int(d.frontBrand?.frontBrandNo ?? d.partnerBrandNo), name: str(d.frontBrand?.brandNameKor), english: str(d.frontBrand?.brandNameEng) },
    category: cat ? { depth1: str(cat.category1Name), depth2: str(cat.category2Name), depth3: str(cat.category3Name) } : null,
    price: { final: int(d.sellPrice), normal: int(d.consumerPrice), discountRate: int(d.discountRate) },
    stockStatus: str(d.frontItemStockStatus),
    reviews: { totalCount: int(d.reviewAggregation?.totalCount), averagePoint: typeof d.reviewAggregation?.averagePoint === 'number' ? d.reviewAggregation.averagePoint : null, photoCount: int(d.reviewAggregation?.totalPhotoReviewCount) },
    badges: (d.badge ?? []).map(b => b.displayName ?? b.type).filter(Boolean),
    specs: (d.itemDetailsList ?? []).map(s => ({ title: str(s.itemDetailsTitles), value: str(s.itemDetailsValue) })).filter(s => s.title),
    images: { gallery, description: [...new Set(description)].filter(u => !gallery.includes(u)) },
    productUrl: cm29ProductUrl(d.itemNo),
  };
}

/** GET bff-api /api/v6/product-detail/{id}/options. `layout` names the combined option axes (e.g. 사이즈/색상). */
export function parseProductOptions(body) {
  const d = body?.data;
  if (!object(d) || !Array.isArray(d.list)) fail('CM29_SCHEMA_INVALID', { where: 'options' });
  return {
    layout: (d.layout ?? []).filter(s => typeof s === 'string'),
    variants: d.list.map(o => ({
      label: str(o.title), stockStatus: str(o.frontOptionStockStatus), additionalPrice: int(o.sellPrice), isLimitedQty: o.isLimitedQty === true,
    })),
  };
}

/** Download-set for the images command: gallery (product/model shots) and description images. */
export function cm29ImageSet(goods) {
  const out = [];
  const add = (url, kind) => { if (url && !out.some(x => x.url === url)) out.push({ url, kind }); };
  for (const u of goods.images.gallery) add(u, 'gallery');
  for (const u of goods.images.description) add(u, 'desc');
  return out;
}

export function createCm29Client({ fetchImpl, minIntervalMs = 3000, sleep, now, maxBytes } = {}) {
  const headers = { Origin: CM29_WEB_ORIGIN, Referer: `${CM29_WEB_ORIGIN}/` };
  const http = createFashionHttp({ service: 'cm29', allowedHosts: CM29_HOSTS, headers, minIntervalMs, fetchImpl, sleep, now, maxBytes });

  async function ranking({ category = 'top', period = 'realtime', limit = 20 } = {}) {
    const categoryCode = /^\d{9}$/.test(category) ? category : CM29_CATEGORY_CODES[category];
    if (!categoryCode) fail('CM29_CATEGORY_INVALID');
    const items = parseBestItems(await http.request(cm29BestUrl({ categoryCode, period })), { limit });
    return { category: { key: category, code: categoryCode }, period, items };
  }

  async function search({ keyword, sort = 'MOST_SOLD', limit = 20 }) {
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 60 || /[\x00-\x1f]/.test(keyword)) fail('CM29_KEYWORD_INVALID');
    if (!CM29_SEARCH_SORTS.includes(sort)) fail('CM29_SORT_INVALID');
    const items = [];
    let totalCount = null;
    for (let page = 1; page <= 4 && items.length < limit; page++) {
      const parsed = parseListing(await http.request(CM29_SEARCH_URL, { method: 'POST', body: cm29SearchBody({ keyword: keyword.trim(), sort, page, size: 50 }) }));
      totalCount ??= parsed.totalCount;
      items.push(...parsed.items);
      if (!parsed.hasNext || !parsed.items.length) break;
    }
    return { keyword: keyword.trim(), sort, totalCount, items: items.slice(0, limit) };
  }

  async function goods({ goodsNo }) {
    const id = cm29ItemNo(goodsNo);
    const product = cm29ProductFromPage(await http.request(cm29ProductUrl(id), { html: true }), id);
    if (!product) fail('CM29_PRODUCT_DATA_MISSING', { path: `/products/${id}` });
    const detail = parseProductDetail({ data: product });
    const options = parseProductOptions(await http.request(`https://bff-api.29cm.co.kr/api/v6/product-detail/${id}/options`));
    return { ...detail, options };
  }

  return { ranking, search, goods, receipts: http.receipts, request: http.request };
}
