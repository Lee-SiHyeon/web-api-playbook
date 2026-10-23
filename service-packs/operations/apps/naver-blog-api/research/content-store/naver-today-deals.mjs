import { createHash } from 'node:crypto';
import { assertStatus, fetchText } from '../trend-radar/lib/http.mjs';

const PROMOTION_URL = 'https://shopping.naver.com/promotion';
const API_ORIGIN = 'https://vertical-api.shopping.naver.com';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LAYOUT_ID_PATTERN = /^I_[a-f0-9]{24}$/;
const PUBLISHER = '네이버 오늘끝딜';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = text => createHash('sha256').update(text).digest('hex');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1) fail('SOURCE_LIMIT');
}

function kstIso(value) {
  if (value == null) return null;
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) fail('SCHEMA');
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const date = new Date(hasZone ? value : `${value}+09:00`);
  if (!Number.isFinite(date.getTime())) fail('SCHEMA');
  return date.toISOString();
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function parseNextData(html) {
  let jsonText;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(match[1])) {
      jsonText = match[2];
      break;
    }
  }
  if (!jsonText) fail('SCHEMA');

  let root;
  try { root = JSON.parse(jsonText); }
  catch { fail('SCHEMA'); }
  const waffle = root?.props?.pageProps?.waffleData;
  if (!isRecord(waffle) || !Array.isArray(waffle.pageLayout?.layers) || !waffle.pageData) fail('SCHEMA');

  const candidates = [];
  for (const layer of waffle.pageLayout.layers) {
    walk(layer, value => {
      if (value.componentType !== 'AUTO_SORT_PRODUCT') return;
      if (typeof value.layoutId !== 'string' || !LAYOUT_ID_PATTERN.test(value.layoutId)) fail('SCHEMA');
      candidates.push({ layoutId: value.layoutId, title: layer.meta?.title ?? null });
    });
  }
  const unique = [...new Map(candidates.map(candidate => [candidate.layoutId, candidate])).values()];
  const namedTodayDeals = unique.filter(candidate => typeof candidate.title === 'string'
    && /오늘끝딜|스페셜딜/.test(candidate.title));
  const selected = namedTodayDeals.length === 1 ? namedTodayDeals[0] : unique.length === 1 ? unique[0] : null;
  if (!selected) fail('SCHEMA');

  let metadata;
  walk(waffle.pageData, value => {
    if (value.itemLayoutId === selected.layoutId) {
      if (metadata) fail('SCHEMA');
      metadata = value;
    }
  });
  if (!metadata) fail('SCHEMA');

  return {
    layoutId: selected.layoutId,
    eventStart: kstIso(metadata.startDate),
    eventEnd: kstIso(metadata.endDate),
  };
}

async function readSource(url, { fetchImpl, json }) {
  const result = await fetchText(url, {
    fetchImpl,
    attempts: 1,
    timeoutMs: 20000,
    headers: {
      accept: json ? 'application/json' : 'text/html',
      referer: PROMOTION_URL,
    },
  });
  assertStatus(result.response);
  const contentType = result.response.headers.get('content-type') ?? '';
  if (!(json ? /\bjson\b/i : /text\/html/i).test(contentType)) fail('HTTP_CONTENT_TYPE');
  if (Buffer.byteLength(result.text) > MAX_BODY_BYTES) fail('SOURCE_TOO_LARGE');

  let data = result.text;
  if (json) {
    try { data = JSON.parse(result.text); }
    catch { fail('SCHEMA'); }
  }
  return { ...result, data };
}

function amount(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('SCHEMA');
  return value;
}

function publicHttpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) fail('SCHEMA');
  let url;
  try { url = new URL(value); }
  catch { fail('SCHEMA'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) fail('SCHEMA');
  return url.href;
}

function parseProduct(product, window) {
  if (!isRecord(product) || !/^\d+$/.test(String(product.productId))
    || typeof product.name !== 'string' || !product.name.trim()
    || typeof product.isSoldOut !== 'boolean') fail('SCHEMA');

  const price = amount(product.salePrice, true);
  const discountedPrice = amount(product.discountedPrice);
  const salePrice = discountedPrice ?? price;
  const discountRate = amount(product.discountedRatio);
  if (discountRate !== null && discountRate > 100) fail('SCHEMA');
  if (product.isDeliveryFree !== undefined && product.isDeliveryFree !== null
    && typeof product.isDeliveryFree !== 'boolean') fail('SCHEMA');
  if (product.deliveryFeeType !== undefined && product.deliveryFeeType !== null
    && typeof product.deliveryFeeType !== 'string') fail('SCHEMA');

  const reportedDeliveryFee = amount(product.deliveryFee);
  const deliveryFee = reportedDeliveryFee
    ?? (product.isDeliveryFree === true || product.deliveryFeeType === 'FREE' ? 0 : null);
  const deliveryLabel = deliveryFee === null ? null
    : deliveryFee === 0 ? '무료배송' : `배송비 ${deliveryFee.toLocaleString('ko-KR')}원`;
  const priceLabel = salePrice !== price
    ? `정가 ${price.toLocaleString('ko-KR')}원 → 할인가 ${salePrice.toLocaleString('ko-KR')}원`
    : `가격 ${salePrice.toLocaleString('ko-KR')}원`;
  const summary = [priceLabel, deliveryLabel, product.isSoldOut ? '품절' : null].filter(Boolean).join(' · ');

  return {
    title: product.name,
    url: publicHttpsUrl(product.landingUrl),
    publishedAt: window.eventStart,
    publisher: PUBLISHER,
    summary,
    deal: {
      productId: String(product.productId),
      price,
      salePrice,
      discountRate,
      deliveryFee,
      soldOut: product.isSoldOut,
      eventStart: window.eventStart,
      eventEnd: window.eventEnd,
    },
  };
}

export async function fetchNaverTodayDeals(limit, { fetchImpl = globalThis.fetch, maxPages = 5 } = {}) {
  validateLimit(limit);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) fail('PAGE_LIMIT');

  const manifestRead = await readSource(PROMOTION_URL, { fetchImpl, json: false });
  const window = parseNextData(manifestRead.text);
  const products = new Map();
  let pages = 0;
  let observedItems = 0;
  let complete = false;
  let responseSha256;
  let httpStatus;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${API_ORIGIN}/v1/waffle-maker/layouts/${window.layoutId}/auto-sort-products`);
    if (page === 1) url.searchParams.set('first', '');
    url.searchParams.set('page', String(page));
    url.searchParams.set('type', 'VIEW');

    const result = await readSource(url.href, { fetchImpl, json: true });
    const data = result.data;
    if (!isRecord(data) || data.itemLayoutId !== window.layoutId || data.page !== page
      || typeof data.hasNext !== 'boolean' || !Array.isArray(data.contents)) fail('SCHEMA');
    if (data.hasNext && data.contents.length === 0) fail('PAGINATION_NO_PROGRESS');

    pages++;
    observedItems += data.contents.length;
    httpStatus = result.response.status;
    responseSha256 = sha256(result.text);
    let added = 0;
    for (const rawProduct of data.contents) {
      const item = parseProduct(rawProduct, window);
      if (!products.has(item.deal.productId)) added++;
      products.set(item.deal.productId, item);
    }
    if (!data.hasNext) {
      complete = true;
      break;
    }
    if (!added) fail('PAGINATION_NO_PROGRESS');
  }

  const items = [...products.values()]
    .sort((a, b) => Number(a.deal.soldOut) - Number(b.deal.soldOut))
    .slice(0, limit);

  return {
    items,
    receipt: {
      httpStatus,
      sourceUrl: PROMOTION_URL,
      layoutId: window.layoutId,
      pages,
      complete,
      observedItems,
      responseSha256,
      browserUsed: false,
    },
  };
}
