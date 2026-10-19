// Ably (에이블리, a-bly.com) anonymous public read client.
// Contracts were observed in the browser (mobile.a-bly.com SPA -> api.a-bly.com XHR) on 2026-10-19
// and replayed with plain Node fetch. See references/commerce-ably.md.
//
// Boundary: every request carries a server-issued anonymous token (GET /api/v2/anonymous/token/)
// in X-Anonymous-Token. It is kept in process memory only and never written to output.
// No account login, no cookies, no writes (likes, carts, share/affiliate link creation are POSTs
// and are not implemented). Requests are serialized with a minimum interval (default 3 s).

import { randomUUID } from 'node:crypto';
import { classifyResponse } from './backoff.mjs';

export const ABLY_API_ORIGIN = 'https://api.a-bly.com';
export const ABLY_WEB_ORIGIN = 'https://m.a-bly.com';
export const ABLY_APP_WEB_ORIGIN = 'https://mobile.a-bly.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

export const ABLY_ROUTES = Object.freeze({
  anonymousToken: '/api/v2/anonymous/token/',
  rankingFilters: '/api/v2/goods/ranking-filters/',
  ranking: '/api/v2/goods/',
  search: '/api/v2/screens/SEARCH_RESULT/',
  overviewCategories: '/api/v2/overview/category-index-list/',
  goodsBasic: sno => `/api/v3/goods/${sno}/basic/`,
  goodsDetail: sno => `/api/v3/goods/${sno}/detail/`,
  goodsReviewSummary: sno => `/api/v2/goods/${sno}/review_summary/`,
  goodsOptionsBrief: sno => `/api/v2/goods/${sno}/options/brief/`,
  goodsOptions: sno => `/api/v2/goods/${sno}/options/`,
  goodsAffiliate: sno => `/api/v2/affiliate/goods/${sno}/`,
  goodsRelatedOutfits: sno => `/api/v2/goods/${sno}/related-outfits/`,
  outfits: '/community/webview/outfits/',
  styleContents: '/api/v2/style_contents/',
  marketRankingTypes: '/api/v2/markets/rankings/available_types/',
  marketRanking: type => `/api/v2/markets/rankings/${type}/`,
});

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const int = v => (Number.isSafeInteger(v) ? v : null);
const str = v => (typeof v === 'string' && v.length ? v : null);
const positiveId = v => typeof v === 'string' ? /^[1-9]\d{0,11}$/.test(v) : Number.isSafeInteger(v) && v > 0;

/** Public link forms for a goods sno (no tracking, no affiliate uid). */
export function ablyGoodsLinks(sno) {
  if (!positiveId(sno)) fail('ABLY_ID_INVALID');
  return {
    web: `${ABLY_WEB_ORIGIN}/goods/${sno}`,
    appWeb: `${ABLY_APP_WEB_ORIGIN}/goods/${sno}`,
    appDeeplink: `ably://goods/${sno}`,
  };
}

function priceKrw(amount, kind) {
  return Number.isSafeInteger(amount) && amount >= 0 ? { amount, currency: 'KRW', kind } : null;
}

function marketSummary(m) {
  if (!object(m)) return null;
  return {
    sno: int(m.sno), name: str(m.name),
    type: str(m.market_type?.name) ?? str(m.market_vertical_type?.name) ?? str(m.market_client_display_type_name) ?? (typeof m.market_type === 'string' ? m.market_type : null),
    styleTags: Array.isArray(m.style_tags) ? m.style_tags : [],
    ageTags: Array.isArray(m.age_tags) ? m.age_tags : [],
    webUrl: Number.isSafeInteger(m.sno) ? `${ABLY_APP_WEB_ORIGIN}/markets/${m.sno}` : null,
  };
}

/** GET /api/v2/goods/ranking-filters/ -> category tree usable by ranking(). */
export function parseRankingFilters(body) {
  if (!object(body) || !Array.isArray(body.market_vertical_types)) fail('ABLY_SCHEMA_INVALID', { where: 'ranking-filters' });
  const verticals = body.market_vertical_types.map(v => ({
    sno: int(v.sno), name: str(v.name), query: object(v.query_value) ? v.query_value : {},
    categories: (v.categories ?? []).filter(c => c.sno !== 0 || c.depth !== null).map(c => ({
      sno: int(c.sno), name: str(c.name), depth: c.depth === null ? null : Number(c.depth),
      children: (c.categories ?? []).filter(x => x.sno !== c.sno).map(x => ({ sno: int(x.sno), name: str(x.name), depth: Number(x.depth) })),
    })),
  }));
  return {
    verticals,
    periods: (body.periods ?? []).map(p => ({ value: p.value, name: p.name })),
    ages: (body.ages ?? []).map(a => ({ value: a.value, name: a.name })),
  };
}

/** Resolve the ranking query for a category sno from the filter tree (the UI sends market_type_sno with category_sno). */
export function rankingQueryFor(filters, categorySno) {
  if (categorySno === undefined || categorySno === null) return {};
  const target = Number(categorySno);
  for (const v of filters.verticals) {
    if (v.query.category_sno === target) return { category_sno: target, path: [v.name] };
    for (const c of v.categories) {
      if (c.sno === target) return { ...v.query, category_sno: target, path: [v.name, c.name] };
      const child = c.children.find(x => x.sno === target);
      if (child) return { ...v.query, category_sno: target, path: [v.name, c.name, child.name] };
    }
  }
  fail('ABLY_CATEGORY_UNKNOWN', { categorySno: target });
}

/** GET /api/v2/goods/?filter=best... -> ranked goods. The displayed rank comes from goods[].ranking. */
export function parseRankingPage(body) {
  if (!object(body) || !Array.isArray(body.goods)) fail('ABLY_SCHEMA_INVALID', { where: 'ranking' });
  const items = body.goods.map(g => {
    if (!Number.isSafeInteger(g.ranking) || g.ranking < 1) fail('ABLY_RANK_MISSING', { sno: g.sno });
    const original = g.linked_option?.original_price ?? g.first_page_rendering?.original_price;
    return {
      rank: g.ranking, sno: int(g.sno), name: str(g.name),
      market: marketSummary(g.market), brandSno: int(g.brand_sno),
      category: g.category ? { sno: int(g.category.sno), name: str(g.category.name) } : null,
      price: priceKrw(g.price, 'retail_current'),
      originalPrice: priceKrw(original, 'retail_list'),
      discountRate: int(g.discount_rate),
      sellCount: int(g.sell_count),
      reviewCount: int(g.total_review_count),
      positiveReviewRate: int(g.positive_review_rate),
      soldOut: g.is_soldout === true,
      image: str(g.image), coverImage: str(g.first_page_rendering?.cover_image),
      isAd: g.ad !== null && g.ad !== undefined,
      links: Number.isSafeInteger(g.sno) ? ablyGoodsLinks(g.sno) : null,
    };
  });
  return { listId: str(body.list_id), updatedAgo: str(body.last_updated_before_message), items };
}

/** GET /api/v2/screens/SEARCH_RESULT/?query= -> goods cards from THREE_COL_GOODS_LIST components. */
export function parseSearchScreen(body) {
  if (!object(body) || !Array.isArray(body.components)) fail('ABLY_SCHEMA_INVALID', { where: 'search' });
  const items = [];
  for (const c of body.components) {
    if (!/GOODS_LIST$/.test(c?.type?.item_list ?? '')) continue;
    for (const entry of c.entity?.item_list ?? []) {
      const g = entry?.item;
      if (!object(g) || !Number.isSafeInteger(g.sno)) continue;
      items.push({
        sno: g.sno, name: str(g.name),
        market: { sno: int(g.market_sno), name: str(g.market_name), type: str(g.market_type) },
        category: str(g.category_name),
        price: priceKrw(g.price, 'retail_current'),
        originalPrice: priceKrw(g.first_page_rendering?.original_price, 'retail_list'),
        discountRate: int(g.discount_rate), sellCount: int(g.sell_count),
        image: str(g.image), coverImage: str(g.first_page_rendering?.cover_image),
        isAd: g.ad !== null && g.ad !== undefined,
        links: ablyGoodsLinks(g.sno),
      });
    }
  }
  return { nextToken: str(body.next_token), items };
}

/** GET /api/v3/goods/{sno}/basic/ */
export function parseGoodsBasic(body) {
  const g = body?.goods;
  if (!object(g) || !Number.isSafeInteger(g.sno)) fail('ABLY_SCHEMA_INVALID', { where: 'basic' });
  return {
    sno: g.sno, name: str(g.name), skuCode: str(g.sku_code), saleType: str(g.sale_type),
    market: marketSummary(g.market),
    brand: g.brand ? { sno: int(g.brand.sno), name: str(g.brand.name) } : null,
    categories: (g.display_categories ?? []).map(c => ({ sno: int(c.sno), name: str(c.name), parent: c.parent_category ? { sno: int(c.parent_category.sno), name: str(c.parent_category.name) } : null })),
    standardCategory: g.standard_category ? { sno: int(g.standard_category.sno), name: str(g.standard_category.name) } : null,
    price: {
      list: priceKrw(g.price_info?.consumer, 'retail_list'),
      sale: priceKrw(g.price_info?.base_thumbnail_price, 'retail_current'),
      couponApplied: priceKrw(g.price_info?.thumbnail_price, 'coupon_applied_display'),
      discountRate: int(g.price_info?.discount_rate),
      couponLabel: str(g.price_description?.text),
    },
    positiveReviewRate: int(g.positive_review_rate),
    coverImages: Array.isArray(g.cover_images) ? g.cover_images.filter(u => typeof u === 'string') : [],
    isOverseasDelivery: g.is_overseas_delivery === true,
    webviewUrl: str(g.webview_url),
  };
}

/** GET /api/v3/goods/{sno}/detail/ -> image URLs inside the DESCRIPTION html parts (notice banners excluded). */
export function parseGoodsDetailImages(body) {
  const parts = body?.goods?.detail_html_parts;
  if (!Array.isArray(parts)) fail('ABLY_SCHEMA_INVALID', { where: 'detail' });
  const out = [];
  for (const part of parts) {
    if (part?.html_part_type !== 'DESCRIPTION') continue;
    for (const html of part.contents ?? []) {
      for (const m of String(html).matchAll(/<img\b[^>]*?\bsrc="(https:\/\/[^"]+)"/g)) if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

export function parseReviewSummary(body) {
  if (!object(body?.review)) fail('ABLY_SCHEMA_INVALID', { where: 'review_summary' });
  return { count: int(body.review.count), positivePercent: int(body.review.positive_percent) };
}

export function parseOptionsBrief(body) {
  if (!object(body) || !Array.isArray(body.option_groups)) fail('ABLY_SCHEMA_INVALID', { where: 'options/brief' });
  return {
    names: Array.isArray(body.option_names) ? body.option_names : [],
    groups: body.option_groups.map(g => ({ depth: int(g.depth), name: str(g.name), count: int(g.component_count) })),
    firstGoodsOptionSno: int(body.option_groups[0]?.first_goods_option_sno),
  };
}

export function parseOptionLevel(body) {
  if (!object(body) || !Array.isArray(body.option_components)) fail('ABLY_SCHEMA_INVALID', { where: 'options' });
  return {
    name: str(body.name),
    values: body.option_components.map(c => ({
      name: str(c.name), depth: int(c.depth), goodsOptionSno: int(c.goods_option_sno), final: c.is_final_depth === true,
      additionalPrice: int(c.option_minimum_additional_price),
      ...(object(c.goods_option) ? {
        optionNames: c.goods_option.option_names, price: priceKrw(c.goods_option.price, 'retail_current'),
        originalPrice: priceKrw(c.goods_option.original_price, 'retail_list'), soldOut: c.goods_option.is_soldout === true,
      } : {}),
    })),
  };
}

/** GET /api/v2/affiliate/goods/{sno}/ (anonymous): shows the share-reward estimate; membership is false for anonymous visitors. */
export function parseAffiliateGoods(body) {
  if (!object(body)) fail('ABLY_SCHEMA_INVALID', { where: 'affiliate' });
  const rate = Number(body.logging?.SETTLEMENT_RATE);
  return {
    isAffiliateMember: body.is_affiliate_member === true, isCampaignMember: body.is_campaign_member === true,
    expectedRewardKrw: int(body.expected_reward), settlementRatePercent: Number.isFinite(rate) ? rate : null,
    note: 'Display estimate shown to the viewer; not a commission guarantee. Creating a reward link needs a logged-in creator account (POST, not implemented).',
  };
}

/** Community outfit (요즘코디) items. Member identity/body fields are dropped on purpose. */
function outfitItem(it) {
  return {
    sno: int(it.sno), text: str(it.contents), createdAt: str(it.created_at),
    images: Array.isArray(it.images) ? it.images : [], thumbnail: str(it.thumbnail),
    tags: Array.isArray(it.tags) ? it.tags : [], seasonTags: Array.isArray(it.season_tags) ? it.season_tags : [],
    likeCount: int(it.like?.count), bookmarkCount: int(it.bookmark?.count), commentCount: int(it.comment_count),
    isOfficialMarket: it.member?.is_official_market === true,
    taggedGoods: (it.goods_list ?? []).map(e => e.item).filter(object).map(g => ({
      sno: int(g.sno), name: str(g.name), category: str(g.category?.name),
      market: g.market ? { sno: int(g.market.sno), name: str(g.market.name) } : null,
      price: priceKrw(g.linked_option?.price, 'retail_current'), originalPrice: priceKrw(g.linked_option?.original_price, 'retail_list'),
      soldOut: g.is_soldout === true, image: str(g.image),
      links: Number.isSafeInteger(g.sno) ? ablyGoodsLinks(g.sno) : null,
    })),
    webUrl: Number.isSafeInteger(it.sno) ? `${ABLY_WEB_ORIGIN}/content/style/${it.sno}/goods` : null,
  };
}

export function parseOutfits(body) {
  if (!object(body) || !Array.isArray(body.outfits)) fail('ABLY_SCHEMA_INVALID', { where: 'outfits' });
  return { nextCursor: body.next_cursor ?? null, items: body.outfits.map(o => outfitItem(o.item ?? {})) };
}

/** GET /api/v2/goods/{sno}/related-outfits/ (outfit cards that tag this goods). */
export function parseRelatedOutfits(body) {
  if (!object(body) || !Array.isArray(body.item_list)) fail('ABLY_SCHEMA_INVALID', { where: 'related-outfits' });
  return body.item_list.map(e => e.item).filter(object).map(it => ({
    sno: int(it.sno), text: str(it.contents), thumbnail: str(it.thumbnail),
    likeCount: int(it.like?.count), bookmarkCount: int(it.bookmark?.count), taggedGoodsCount: int(it.tagged_goods_count),
    webUrl: Number.isSafeInteger(it.sno) ? `${ABLY_WEB_ORIGIN}/content/style/${it.sno}/goods` : null,
  }));
}

/** GET /api/v2/style_contents/ (editorial lookbooks; tags may include '인플 PICK'). */
export function parseStyleContents(body) {
  if (!object(body) || !Array.isArray(body.contents)) fail('ABLY_SCHEMA_INVALID', { where: 'style_contents' });
  return body.contents.map(c => c.item).filter(object).map(it => ({
    sno: int(it.sno), title: str(it.title), subTitle: str(it.sub_title), openedAt: str(it.opened_at),
    thumbnail: str(it.list_thumbnail), filter: str(it.filter?.name), tags: (it.tags ?? []).map(t => t.name),
    webUrl: Number.isSafeInteger(it.sno) ? `${ABLY_WEB_ORIGIN}/events/${it.sno}` : null,
  }));
}

/** GET /api/v2/markets/rankings/{type}/ (type 7 = 셀럽 influencer-run shops). */
export function parseMarketRanking(body) {
  if (!object(body) || !Array.isArray(body.markets)) fail('ABLY_SCHEMA_INVALID', { where: 'market-ranking' });
  return {
    nextToken: str(body.next_token),
    items: body.markets.map(m => ({
      rank: int(m.rank), lastRank: int(m.last_rank), ...marketSummary(m),
      instagram: str(m.instagram), favoritesCount: int(m.favorites_count), goodsLikesCount: int(m.goods_likes_count),
      highlight: str(m.highlight),
    })),
  };
}

/**
 * HTTP client. fetchImpl/sleep/now are injectable for tests.
 * Every response is classified; 401/403/challenge stop the job, 429/5xx are not retried (report and stop).
 */
export function createAblyClient({ fetchImpl = globalThis.fetch, minIntervalMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(), deviceId = randomUUID(), maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) fail('ABLY_INTERVAL_INVALID');
  let token = null; let last = 0;
  const receipts = [];
  let filtersCache = null;

  async function raw(path, params = {}, { anonymous = false } = {}) {
    const wait = last + minIntervalMs - now();
    if (last && wait > 0) await sleep(wait);
    const url = new URL(path, ABLY_API_ORIGIN);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    if (url.origin !== ABLY_API_ORIGIN) fail('ABLY_ORIGIN_INVALID');
    const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: `${ABLY_APP_WEB_ORIGIN}/` };
    if (!anonymous) Object.assign(headers, { 'X-Anonymous-Token': token, 'X-Device-Id': deviceId, 'X-Web-Type': 'Web', 'X-Device-Type': 'PCWeb', 'X-App-Version': '0.1.0' });
    const checkedAt = new Date(now()).toISOString();
    last = now();
    const res = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (text.length > maxBytes) fail('ABLY_RESPONSE_TOO_LARGE');
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const receipt = { method: 'GET', origin: ABLY_API_ORIGIN, path: url.pathname, queryFields: [...url.searchParams.keys()],
      httpStatus: res.status, mime, responseBytes: Buffer.byteLength(text), checkedAt, anonymous: true, cookieSent: false,
      credentialsUsed: false, anonymousTokenSent: !anonymous, browserUsed: false };
    receipts.push(receipt);
    const verdict = classifyResponse({ status: res.status, headers: res.headers, bodySample: mime === 'application/json' ? '' : text });
    if (verdict.action !== 'ok') {
      const code = res.status === 429 ? 'ABLY_RATE_LIMITED' : res.status === 401 ? 'ABLY_AUTH_REJECTED' : verdict.reason === 'challenge_detected' ? 'ABLY_CHALLENGE' : 'ABLY_HTTP_ERROR';
      fail(code, { httpStatus: res.status, path: url.pathname, vendor: verdict.vendor ?? null });
    }
    if (res.status === 204) return null;
    if (mime !== 'application/json') fail('ABLY_NOT_JSON', { path: url.pathname, mime });
    try { return JSON.parse(text); } catch { fail('ABLY_JSON_INVALID', { path: url.pathname }); }
  }

  async function get(path, params) {
    if (!token) {
      const body = await raw(ABLY_ROUTES.anonymousToken, {}, { anonymous: true });
      if (typeof body?.token !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(body.token)) fail('ABLY_TOKEN_SCHEMA_INVALID');
      token = body.token;
    }
    return raw(path, params);
  }

  async function categories() {
    if (!filtersCache) filtersCache = parseRankingFilters(await get(ABLY_ROUTES.rankingFilters));
    return filtersCache;
  }

  async function ranking({ categorySno, period, age, limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('ABLY_LIMIT_INVALID');
    if (period !== undefined && !['daily', 'weekly', 'monthly'].includes(period)) fail('ABLY_PERIOD_INVALID');
    if (age !== undefined && !/^[1-5]$/.test(String(age))) fail('ABLY_AGE_INVALID');
    let query = {}; let path = [];
    if (categorySno !== undefined) {
      if (!positiveId(categorySno)) fail('ABLY_CATEGORY_INVALID');
      ({ path, ...query } = rankingQueryFor(await categories(), categorySno));
    }
    const items = []; let listId = null; let updatedAgo = null; let cursor = {};
    while (items.length < limit) {
      const page = parseRankingPage(await get(ABLY_ROUTES.ranking, { filter: 'best', ...query, period, 'age_tags[]': age, ...cursor }));
      listId ??= page.listId; updatedAgo ??= page.updatedAgo;
      if (!page.items.length) break;
      for (const it of page.items) {
        if (items.some(x => x.rank === it.rank)) fail('ABLY_RANK_DUPLICATE', { rank: it.rank });
        items.push(it);
      }
      const tail = page.items.at(-1);
      cursor = { last_ranking: tail.rank, last_sno: tail.sno };
    }
    return { category: categorySno === undefined ? null : { sno: Number(categorySno), path }, period: period ?? 'default', listId, updatedAgo, items: items.slice(0, limit) };
  }

  async function search({ query, limit = 30 } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 100) fail('ABLY_QUERY_INVALID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 150) fail('ABLY_LIMIT_INVALID');
    const items = []; let nextToken;
    do {
      const page = parseSearchScreen(await get(ABLY_ROUTES.search, { query: query.trim(), next_token: nextToken }));
      for (const it of page.items) if (!items.some(x => x.sno === it.sno)) items.push(it);
      if (nextToken === page.nextToken) break;
      nextToken = page.nextToken;
    } while (nextToken && items.length < limit);
    return { query: query.trim(), items: items.slice(0, limit), nextToken: nextToken ?? null };
  }

  async function product({ id, options = true } = {}) {
    if (!positiveId(id)) fail('ABLY_ID_INVALID');
    const basic = parseGoodsBasic(await get(ABLY_ROUTES.goodsBasic(id)));
    if (String(basic.sno) !== String(id)) fail('ABLY_PRODUCT_MISMATCH');
    const reviews = parseReviewSummary(await get(ABLY_ROUTES.goodsReviewSummary(id)));
    const detailImages = parseGoodsDetailImages(await get(ABLY_ROUTES.goodsDetail(id), { channel: 0 }));
    let optionData = null;
    if (options) {
      const brief = parseOptionsBrief(await get(ABLY_ROUTES.goodsOptionsBrief(id)));
      const levels = [];
      if (brief.groups.length) {
        const first = parseOptionLevel(await get(ABLY_ROUTES.goodsOptions(id), { depth: 1 }));
        levels.push(first);
        const pick = first.values.find(v => !v.final);
        if (brief.groups.length > 1 && pick) levels.push({ ...parseOptionLevel(await get(ABLY_ROUTES.goodsOptions(id), { depth: 2, selected_option_sno: pick.goodsOptionSno })), forFirstValue: pick.name });
      }
      optionData = { ...brief, levels };
    }
    const affiliate = parseAffiliateGoods(await get(ABLY_ROUTES.goodsAffiliate(id)));
    return { ...basic, reviews, detailImages, options: optionData, affiliate, links: ablyGoodsLinks(id),
      rating: { kind: 'positive_review_percent', value: reviews.positivePercent, note: 'Ably shows a positive-review percentage, not a star average.' } };
  }

  async function outfits({ goodsSno, limit = 30, order = 'recommend' } = {}) {
    if (goodsSno !== undefined) {
      if (!positiveId(goodsSno)) fail('ABLY_ID_INVALID');
      return { goodsSno: Number(goodsSno), items: parseRelatedOutfits(await get(ABLY_ROUTES.goodsRelatedOutfits(goodsSno))).slice(0, limit) };
    }
    if (!['recommend', 'recent'].includes(order)) fail('ABLY_ORDER_INVALID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 90) fail('ABLY_LIMIT_INVALID');
    const items = []; let cursor = null;
    do {
      const page = parseOutfits(await get(ABLY_ROUTES.outfits, { per_page: 30, next_token: cursor, cursor, order_by: order }));
      items.push(...page.items);
      if (!page.items.length || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    } while (cursor && items.length < limit);
    return { order, items: items.slice(0, limit) };
  }

  async function styleContents({ limit = 10 } = {}) {
    return { items: parseStyleContents(await get(ABLY_ROUTES.styleContents)).slice(0, limit) };
  }

  async function marketRanking({ type = 7, limit = 20 } = {}) {
    if (!/^\d{1,3}$/.test(String(type))) fail('ABLY_MARKET_TYPE_INVALID');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('ABLY_LIMIT_INVALID');
    const types = await get(ABLY_ROUTES.marketRankingTypes);
    const known = (types?.market_types ?? []).find(t => String(t.sno) === String(type));
    if (!known) fail('ABLY_MARKET_TYPE_UNKNOWN');
    const items = []; let next = '';
    do {
      const page = parseMarketRanking(await get(ABLY_ROUTES.marketRanking(type), { next_token: next || undefined }));
      items.push(...page.items);
      if (!page.items.length || page.nextToken === next) break;
      next = page.nextToken;
    } while (next && items.length < limit);
    return { type: { sno: Number(type), name: known.name }, items: items.slice(0, limit) };
  }

  return { categories, ranking, search, product, outfits, styleContents, marketRanking, receipts };
}
