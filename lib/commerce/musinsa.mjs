// Musinsa (무신사, www.musinsa.com) anonymous public reads: women's category ranking, keyword search,
// goods detail/options and image URLs. Contracts were observed in the browser (Canary CDP, 2026-10-20)
// and replayed with plain Node fetch. See references/commerce-musinsa.md.
//
// Boundary: no cookies, no account, no login, no writes (likes, carts, reviews are not implemented).
// Only JSON API hosts are called. The www HTML pages are NOT fetched: www.musinsa.com/robots.txt has
// "User-agent: *  Disallow: /" and only a named allowlist of bots is permitted. The API hosts
// (client/api/goods-detail/goods.musinsa.com) serve no robots.txt (404). That is an operator-policy
// judgment, recorded in the reference doc.

import { createFashionHttp, fashionFail } from './fashion-http.mjs';

export const MUSINSA_HOSTS = Object.freeze(['client.musinsa.com', 'api.musinsa.com', 'goods-detail.musinsa.com', 'goods.musinsa.com']);
export const MUSINSA_WEB_ORIGIN = 'https://www.musinsa.com';
export const MUSINSA_IMAGE_ORIGIN = 'https://image.msscdn.net';
const RANKING_SECTION = '199'; // 랭킹 > 상품 (product ranking). 200 is the beauty/new-arrival section.

// Category codes of section 199 with gf=F (women). Observed 2026-10-20 in the section's tab tree.
// `dress` is 원피스/스커트 (100000, includes skirts); 100001/100002/100003 are 미니/미디/맥시 원피스.
// `swim` is 스포츠/레저 > 수영복/비치웨어 (017022), which also lists unisex items.
// `sunglasses` is 소품 > 선글라스/안경테 (101003), which also lists eyeglass frames.
export const MUSINSA_CATEGORY_CODES = Object.freeze({
  top: '001000', outer: '002000', bottom: '003000', dress: '100000', swim: '017022',
  bag: '004000', hat: '120000', sunglasses: '101003',
});
export const MUSINSA_RANK_PERIODS = Object.freeze({
  realtime: ['REALTIME', 'BASIC_REALTIME'], daily: ['DAILY', 'BASIC_DAILY'], weekly: ['WEEKLY', 'BASIC_WEEKLY'],
});

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = v => (Number.isSafeInteger(v) ? v : null);
const intStr = v => (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : int(v));
const str = v => (typeof v === 'string' && v.length ? v : null);
const fail = (code, extra) => fashionFail(code, extra);

/** goodsNo: positive integer, 1..12 digits (string or number in the API). */
export function musinsaGoodsNo(value) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,11}$/.test(text)) fail('MUSINSA_ID_INVALID');
  return Number(text);
}

export function musinsaProductUrl(goodsNo) {
  return `${MUSINSA_WEB_ORIGIN}/products/${musinsaGoodsNo(goodsNo)}`;
}

/** Musinsa returns image paths as "/images/..." or "//image.msscdn.net/...". Normalize to https or null. */
export function musinsaImageUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${MUSINSA_IMAGE_ORIGIN}${value}`;
  return /^https:\/\//.test(value) ? value : null;
}

/** Ranking page URL (section 199). Page 1 is built here; later pages use the server's link.next. */
export function musinsaRankingUrl({ categoryCode, period, startRank = 1, includeSoldOut = false }) {
  const [periodKey, eventPeriod] = MUSINSA_RANK_PERIODS[period] ?? [];
  if (!periodKey) fail('MUSINSA_PERIOD_INVALID');
  const u = new URL(`https://client.musinsa.com/api/home/web/v5/pans/ranking/sections/${RANKING_SECTION}`);
  const params = {
    storeCode: 'musinsa', gf: 'F', ageBand: 'AGE_BAND_ALL', period: periodKey, eventPeriod, categoryCode,
    contentsId: '', variantValue: '', plusDelivery: 'false', soldOut: includeSoldOut ? 'true' : 'false',
    page: Math.floor((startRank - 1) / 101) + 1, startRank, offset: startRank - 1,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.href;
}

/** Search page 1. Later pages come from data.pagination.nextPageUrl (signed by the server; not generated here). */
export function musinsaSearchUrl({ keyword, page = 1, size = 60 }) {
  const u = new URL('https://api.musinsa.com/api2/dp/v2/plp/goods');
  for (const [k, v] of Object.entries({ gf: 'F', keyword, sortCode: 'POPULAR', isUsed: 'false', page, size, caller: 'SEARCH' })) u.searchParams.set(k, String(v));
  return u.href;
}

export function musinsaGoodsUrl(goodsNo, suffix = '') {
  return `https://goods-detail.musinsa.com/api2/goods/${musinsaGoodsNo(goodsNo)}${suffix}`;
}

function assertAllowedUrl(value) {
  if (typeof value !== 'string') return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  return u.protocol === 'https:' && MUSINSA_HOSTS.includes(u.hostname) ? u.href : null;
}

/**
 * GET ranking section -> ranked goods. The displayed rank is modules[].items[].image.rank.
 * Ranking-position numbers are never derived from array order. Duplicate or missing ranks fail.
 * reviewCount and satisfactionPercent come from the item's analytics payload in the same response:
 * payload.reviewScore matches the goods-detail satisfactionScore (0-5) x 20 (e.g. 4.9 -> 98).
 */
export function parseRankingSection(body) {
  if (!object(body?.data) || !Array.isArray(body.data.modules)) fail('MUSINSA_SCHEMA_INVALID', { where: 'ranking' });
  const items = [];
  const seen = new Set();
  for (const module of body.data.modules) {
    for (const x of module?.items ?? []) {
      if (x?.type !== 'PRODUCT_COLUMN') continue;
      const rank = x.image?.rank;
      const goodsNo = musinsaGoodsNo(x.id);
      if (!Number.isSafeInteger(rank) || rank < 1 || seen.has(rank)) fail('MUSINSA_RANK_INVALID', { goodsNo });
      seen.add(rank);
      const payload = x.onClick?.eventLog?.amplitude?.payload ?? {};
      items.push({
        rank, goodsNo, brand: str(x.info?.brandName), name: str(x.info?.productName),
        price: { final: int(x.info?.finalPrice), original: intStr(payload.original_price), discountRate: int(x.info?.discountRatio) },
        soldOut: x.info?.isSoldOut === true,
        image: musinsaImageUrl(x.image?.url),
        productUrl: musinsaProductUrl(goodsNo),
        reviewCount: intStr(payload.reviewCount),
        satisfactionPercent: intStr(payload.reviewCount) > 0 ? intStr(payload.reviewScore) : null,
      });
    }
  }
  return { nextUrl: assertAllowedUrl(body.link?.next), items };
}

/** GET search goods list (page 1 or a server-issued nextPageUrl). */
export function parseSearchList(body) {
  if (!object(body?.data) || !Array.isArray(body.data.list)) fail('MUSINSA_SCHEMA_INVALID', { where: 'search' });
  const items = body.data.list.filter(g => object(g) && Number.isSafeInteger(g.goodsNo)).map(g => ({
    goodsNo: g.goodsNo, name: str(g.goodsName), brand: str(g.brandName), brandCode: str(g.brand),
    price: { final: int(g.finalPrice), normal: int(g.normalPrice), couponPrice: int(g.couponPrice), discountRate: int(g.saleRate) },
    soldOut: g.isSoldOut === true,
    image: musinsaImageUrl(g.thumbnail),
    productUrl: musinsaProductUrl(g.goodsNo),
    reviewCount: int(g.reviewCount),
    satisfactionPercent: int(g.reviewCount) > 0 ? int(g.reviewScore) : null,
    isAd: g.isAd === true,
  }));
  const p = body.data.pagination ?? {};
  return { totalCount: int(p.totalCount), page: int(p.page), nextUrl: assertAllowedUrl(p.nextPageUrl), items };
}

const colorGroup = name => /컬러|색상|color/i.test(name ?? '');

/** GET goods-detail /api2/goods/{no}: same data the product page embeds. */
export function parseGoodsDetail(body) {
  const d = body?.data;
  if (!object(d) || !Number.isSafeInteger(d.goodsNo)) fail('MUSINSA_SCHEMA_INVALID', { where: 'goods' });
  const gallery = (d.goodsImages ?? []).map(x => musinsaImageUrl(x?.imageUrl)).filter(Boolean);
  const thumbnail = musinsaImageUrl(d.thumbnailImageUrl);
  const description = [...String(d.goodsContents ?? '').matchAll(/<img\b[^>]*?\bsrc="((?:https:)?\/\/[^"]+)"/g)].map(m => musinsaImageUrl(m[1])).filter(Boolean);
  return {
    goodsNo: d.goodsNo, name: str(d.goodsNm), englishName: str(d.goodsNmEng) || null, styleNo: str(d.styleNo),
    gender: (d.genders ?? []).join(',') || null, labels: (d.labels ?? []).map(l => l.name).filter(Boolean),
    brand: { code: str(d.brand), name: str(d.brandInfo?.brandName), english: str(d.brandInfo?.brandEnglishName) },
    category: {
      depth1: str(d.category?.categoryDepth1Title), depth2: str(d.category?.categoryDepth2Title),
      baseFullPath: str(d.baseCategoryFullPath),
    },
    price: {
      final: int(d.goodsPrice?.finalPrice), normal: int(d.goodsPrice?.normalPrice),
      discountRate: int(d.goodsPrice?.discountRate), couponPrice: int(d.goodsPrice?.couponPrice),
    },
    reviews: { totalCount: int(d.goodsReview?.totalCount), satisfactionScore: typeof d.goodsReview?.satisfactionScore === 'number' ? d.goodsReview.satisfactionScore : null },
    materialAttributes: (d.goodsMaterial?.materials ?? [])
      .map(g => ({ name: str(g.name), selected: (g.items ?? []).filter(i => i.isSelected).map(i => i.name) }))
      .filter(g => g.name && g.selected.length),
    compositionNote: '혼용률/소재 구성은 구조화된 필드가 없다. 상세 이미지(images)에서 확인한다.',
    images: { thumbnail, gallery, description: [...new Set(description)].filter(u => !gallery.includes(u)) },
    productUrl: musinsaProductUrl(d.goodsNo),
  };
}

/** GET goods-detail /api2/goods/{no}/options: basic option groups (사이즈, 컬러 ...) and combinations. */
export function parseGoodsOptions(body) {
  const d = body?.data;
  if (!object(d) || !Array.isArray(d.basic) || !Array.isArray(d.optionItems)) fail('MUSINSA_SCHEMA_INVALID', { where: 'options' });
  const groups = d.basic.map(b => ({
    name: str(b.name), displayType: str(b.displayType),
    values: (b.optionValues ?? []).filter(v => v.isDeleted !== true).map(v => str(v.name)).filter(Boolean),
  }));
  const colors = d.basic.filter(b => colorGroup(b.name)).flatMap(b => (b.optionValues ?? []).filter(v => v.isDeleted !== true).map(v => v.name));
  return {
    groups,
    colors: [...new Set(colors)],
    variants: d.optionItems.filter(i => i.isDeleted !== true).map(i => ({
      label: (i.optionValues ?? []).map(v => v.name).join(' / ') || null,
      managedCode: str(i.managedCode),
      additionalPrice: int(i.price),
      activated: i.activated === true,
    })),
  };
}

/** Download-set for the images command: thumbnail, gallery (product/model shots) and description images. */
export function musinsaImageSet(goods) {
  const out = [];
  const add = (url, kind) => { if (url && !out.some(x => x.url === url)) out.push({ url, kind }); };
  add(goods.images.thumbnail, 'thumb');
  for (const u of goods.images.gallery) add(u, 'gallery');
  for (const u of goods.images.description) add(u, 'desc');
  return out;
}

export function createMusinsaClient({ fetchImpl, minIntervalMs = 3000, sleep, now, maxBytes } = {}) {
  const http = createFashionHttp({ service: 'musinsa', allowedHosts: MUSINSA_HOSTS, minIntervalMs, fetchImpl, sleep, now, maxBytes });

  /** Ranking: follows the server's link.next until `limit` ranked items are collected (max 3 pages). */
  async function ranking({ category = 'top', period = 'realtime', limit = 20, includeSoldOut = false } = {}) {
    const categoryCode = /^\d{3,6}$/.test(category) ? category : MUSINSA_CATEGORY_CODES[category];
    if (!categoryCode) fail('MUSINSA_CATEGORY_INVALID');
    let url = musinsaRankingUrl({ categoryCode, period, startRank: 1, includeSoldOut });
    const items = [];
    for (let page = 0; page < 3 && url && items.length < limit; page++) {
      const parsed = parseRankingSection(await http.request(url));
      items.push(...parsed.items);
      url = parsed.nextUrl;
      if (!parsed.items.length) break;
    }
    return { category: { key: category, code: categoryCode }, period, includeSoldOut, items: items.slice(0, limit) };
  }

  /** Search: sortCode=POPULAR (site default), page 1 from the search API without a signature. */
  async function search({ keyword, limit = 20 }) {
    if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 60 || /[\x00-\x1f]/.test(keyword)) fail('MUSINSA_KEYWORD_INVALID');
    const items = [];
    let totalCount = null;
    let url = musinsaSearchUrl({ keyword: keyword.trim() });
    for (let page = 0; page < 5 && url && items.length < limit; page++) {
      const parsed = parseSearchList(await http.request(url));
      totalCount ??= parsed.totalCount;
      items.push(...parsed.items);
      url = parsed.nextUrl;
      if (!parsed.items.length) break;
    }
    return { keyword: keyword.trim(), sort: 'POPULAR', totalCount, items: items.slice(0, limit) };
  }

  /** Goods: detail + options (two GETs). Images are listed here and downloaded only by the images command. */
  async function goods({ goodsNo }) {
    const detail = parseGoodsDetail(await http.request(musinsaGoodsUrl(goodsNo)));
    const options = parseGoodsOptions(await http.request(musinsaGoodsUrl(goodsNo, '/options')));
    return { ...detail, options };
  }

  return { ranking, search, goods, receipts: http.receipts, request: http.request };
}
