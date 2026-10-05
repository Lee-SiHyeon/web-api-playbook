import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const SERVICE = 'oliveyoung-public';
const WWW = 'https://www.oliveyoung.co.kr';
const MOBILE = 'https://m.oliveyoung.co.kr';
const SEARCH = '/store/search/NewMainSearchApi.do';
const DETAIL = '/goods/api/v1/detail';
const DESCRIPTION = '/goods/api/v1/description';
const EXTRA = '/goods/api/v1/extra';
const REVIEW_CURSOR = '/review/api/v2/reviews/cursor';
const REVIEW_PHOTOS = '/review/api/v2/reviews/photo-reviews';
const REVIEW_STATS = '/review/api/v2/reviews';
const REVIEW_OPTIONS = '/review/api/v2/reviews/options';
const REVIEW_SUMMARY = '/review/api/v1/reviews';
const COLLECTION = 'OLIVE_GOODS,OLIVE_PLAN,OLIVE_EVENT,OLIVE_BRAND,OLIVE_QUICK_LINK';
const MEDIA_TYPE = '02';
const SEARCH_FORM_FIELDS = new Set([
  'reQuery', 'rt', 'sort', 'goods_sort', 'disPlayCateId', 'cateId', 'cateId2', 'sale_below_price',
  'sale_over_price', 'brandCheck', 'benefitCheck', 'attrCheck0', 'attrCheck1', 'attrCheck2',
  'attrCheck3', 'attrCheck4', 'authenticYn', 'typeChk', 'onlyOneBrand', 'quickYn',
]);
const COOKIE_NAMES = new Set(['__cf_bm', '_cfuvid', 'cf_clearance']);
const REVIEW_SORTS = new Set([
  'USEFUL_SCORE_DESC', 'DATETIME_DESC', 'RATING_DESC', 'RATING_ASC', 'RECOMMENDED_DESC',
]);
const REVIEW_TYPES = new Set(['ALL', 'PHOTO', 'MONTHLY', 'REPURCHASE']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const GOODS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export class OliveyoungKoreaPublicError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'OliveyoungKoreaPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new OliveyoungKoreaPublicError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 1000) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);
const nonnegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const goodsId = value => typeof value === 'string' && GOODS_ID.test(value);

function checkedAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('OLIVEYOUNG_KOREA_PUBLIC_OPTIONS_INVALID');
  return date.toISOString();
}

function validateSession(session) {
  if (session === undefined || session === null) return { cookies: [], userAgent: null };
  if (!object(session) || Object.keys(session).some(key => !['cookies', 'userAgent'].includes(key)) ||
      session.cookies !== undefined && !Array.isArray(session.cookies) ||
      session.cookies?.length > 64) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_SESSION_INVALID');
  }
  if (session.userAgent !== undefined &&
      (typeof session.userAgent !== 'string' || session.userAgent.length < 1 ||
       session.userAgent.length > 512 || /[\r\n\0]/.test(session.userAgent))) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_SESSION_INVALID');
  }
  const cookies = [];
  for (const cookie of session.cookies ?? []) {
    if (!object(cookie) || typeof cookie.name !== 'string' || !COOKIE_NAMES.has(cookie.name) ||
        typeof cookie.value !== 'string' || cookie.value.length < 1 || cookie.value.length > 8192 ||
        /[\r\n;\0]/.test(cookie.value) ||
        !['.oliveyoung.co.kr', 'oliveyoung.co.kr', 'www.oliveyoung.co.kr',
          'm.oliveyoung.co.kr', undefined].includes(cookie.domain) ||
        cookie.path !== undefined && cookie.path !== '/') {
      fail('OLIVEYOUNG_KOREA_PUBLIC_SESSION_INVALID');
    }
    cookies.push({ name: cookie.name, value: cookie.value, domain: cookie.domain ?? '.oliveyoung.co.kr' });
  }
  return { cookies, userAgent: session.userAgent ?? null };
}

function cookieHeaderFor(session, origin) {
  const host = new URL(origin).hostname;
  const selected = session.cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '');
    return host === domain || host.endsWith('.' + domain);
  });
  return {
    value: selected.map(cookie => cookie.name + '=' + cookie.value).join('; '),
    names: [...new Set(selected.map(cookie => cookie.name))].sort(),
  };
}

function safeInteger(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,14})$/.test(value)) return Number(value);
  fail('OLIVEYOUNG_KOREA_PUBLIC_SCHEMA_INVALID', { field });
}

function money(value, field, kind) {
  if (value === null || value === undefined || value === '') return null;
  let raw;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) raw = String(value);
  else if (typeof value === 'string' &&
      /^(?:0|[1-9][0-9]{0,14}|(?:0|[1-9][0-9]{0,2})(?:,[0-9]{3})+)$/.test(value)) {
    raw = value.replaceAll(',', '');
  }
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]{0,14})$/.test(raw)) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_PRICE_SCHEMA_INVALID', { field });
  }
  return { amount: raw, currency: 'KRW', minorUnitExponent: 0, kind, sourceField: field };
}

function optionalSourceMoney(value, field) {
  if (value === null || value === undefined || value === '' ||
      typeof value !== 'number' && typeof value !== 'string') return null;
  try { return money(value, field, 'unknown'); }
  catch (error) {
    if (error instanceof OliveyoungKoreaPublicError &&
        error.code === 'OLIVEYOUNG_KOREA_PUBLIC_PRICE_SCHEMA_INVALID') return null;
    throw error;
  }
}

function discountRate(normalPrice, salePrice) {
  const normal = money(normalPrice, 'NORM_PRC', 'market_reference');
  const sale = money(salePrice, 'SALE_PRC', 'retail_current');
  if (!normal || !sale || BigInt(normal.amount) <= 0n || BigInt(sale.amount) > BigInt(normal.amount)) return null;
  const denominator = BigInt(normal.amount);
  const numerator = (denominator - BigInt(sale.amount)) * 10000n;
  const hundredths = (numerator + denominator / 2n) / denominator;
  const whole = hundredths / 100n;
  const fraction = String(hundredths % 100n).padStart(2, '0');
  return String(whole) + '.' + fraction;
}

function normalizeSearchProduct(row) {
  if (!object(row) || !goodsId(String(row.GOODS_NO ?? '')) || !text(row.GOODS_NM, 2000)) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_SCHEMA_INVALID');
  }
  const id = String(row.GOODS_NO);
  const normalPrice = row.NORM_PRC === undefined ? null : money(row.NORM_PRC, 'NORM_PRC', 'retail_reference');
  const salePrice = row.SALE_PRC === undefined ? null : money(row.SALE_PRC, 'SALE_PRC', 'retail_current');
  const supplierPrice = row.SUP_PRC === undefined ? null : money(row.SUP_PRC, 'SUP_PRC', 'retail_list');
  const discounted = row.DSCNT_YN === 'Y';
  let current = null;
  let reference = null;
  if (normalPrice && salePrice && normalPrice.amount !== salePrice.amount) {
    current = salePrice;
    reference = supplierPrice;
  } else if (normalPrice && salePrice && normalPrice.amount === salePrice.amount && discounted) {
    current = normalPrice;
    reference = supplierPrice;
  } else {
    current = supplierPrice;
  }
  if (!current) fail('OLIVEYOUNG_KOREA_PUBLIC_PRICE_SCHEMA_INVALID', { field: 'SUP_PRC/SALE_PRC/NORM_PRC' });

  const itemCount = safeInteger(row.ITEM_CNT, 'ITEM_CNT', { optional: true });
  const soldOut = row.GOODS_SOUT_INFO;
  if (soldOut !== undefined && soldOut !== 'Y' && soldOut !== 'N') {
    fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_SCHEMA_INVALID', { field: 'GOODS_SOUT_INFO' });
  }
  const category = row.DISP_CAT_NO;
  let categoryIds;
  if (category !== undefined && category !== null) {
    if (!(typeof category === 'string' || typeof category === 'number' && Number.isSafeInteger(category)) ||
        typeof category === 'number' && category < 0) {
      fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_SCHEMA_INVALID', { field: 'DISP_CAT_NO' });
    }
    const encoded = String(category);
    categoryIds = encoded.split(',');
    if (categoryIds.length > 16 || categoryIds.some(id => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
        new Set(categoryIds).size !== categoryIds.length) {
      fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_SCHEMA_INVALID', { field: 'DISP_CAT_NO' });
    }
  }
  return {
    productId: id,
    title: row.GOODS_NM,
    ...(text(row.ONL_BRND_NM, 500) ? { brand: row.ONL_BRND_NM } : {}),
    ...(categoryIds ? { categoryIds } : {}),
    price: { ...current, kind: 'retail_current' },
    ...(reference ? { listPrice: reference } : {}),
    ...(normalPrice ? { normalPrice: { ...normalPrice, kind: 'market_reference' } } : {}),
    discountRate: discountRate(row.NORM_PRC, row.SALE_PRC),
    availability: soldOut === 'Y' ? 'unavailable' : soldOut === 'N' ? 'available' : 'unknown',
    priceContext: {
      source: 'OLIVE_GOODS.Result',
      selectedVariantPrice: false,
      optionRangeHint: itemCount !== null && itemCount > 1,
      itemCount,
      referenceField: reference ? 'SUP_PRC' : null,
    },
  };
}

function formBody(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_INVALID', { field: key });
    }
    const encoded = String(value);
    if (encoded.length > 2048 || CONTROL.test(encoded)) fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_INVALID', { field: key });
    body.append(key, encoded);
  }
  return body.toString();
}

function allowedPath(origin, path) {
  if (origin === WWW) return new Set([SEARCH, DETAIL, DESCRIPTION, EXTRA]).has(path);
  if (origin === MOBILE) return path === REVIEW_CURSOR || path === REVIEW_PHOTOS ||
    /^\/review\/api\/v2\/reviews\/[A-Za-z0-9_-]{1,64}\/stats$/.test(path) ||
    /^\/review\/api\/v2\/reviews\/options\/[A-Za-z0-9_-]{1,64}\/count$/.test(path) ||
    /^\/review\/api\/v1\/reviews\/[A-Za-z0-9_-]{1,64}\/summary$/.test(path);
  return false;
}

async function readBounded(response, maxBytes) {
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function htmlToText(value) {
  if (typeof value !== 'string' || value.length > 2_000_000) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_DESCRIPTION_SCHEMA_INVALID');
  }
  const { document } = parseHTML('<html><body><div id="oy-content">' + value + '</div></body></html>');
  const root = document.getElementById('oy-content');
  for (const node of root.querySelectorAll('script,style,iframe,object,embed,form')) node.remove();
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function htmlImages(value) {
  if (typeof value !== 'string' || value.length > 2_000_000) return [];
  const { document } = parseHTML('<html><body><div id="oy-content">' + value + '</div></body></html>');
  const root = document.getElementById('oy-content');
  return [...root.querySelectorAll('img')].flatMap(image => {
    const src = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original');
    const ref = imageReference(src);
    return ref ? [ref] : [];
  });
}

function imageReference(value) {
  if (!text(value, 4096) || !value) return null;
  if (!/^https?:\/\//i.test(value)) {
    if (value.startsWith('//') || value.split('/').includes('..')) return null;
    return { path: value };
  }
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' ||
      !(url.hostname === 'oliveyoung.co.kr' || url.hostname.endsWith('.oliveyoung.co.kr')) ||
      url.username || url.password || url.port) return null;
  return { url: url.href };
}

function imageReferences(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.flatMap(item => {
    if (typeof item === 'string') {
      const ref = imageReference(item);
      return ref ? [ref] : [];
    }
    if (!object(item)) return [];
    const out = {};
    for (const key of ['imagePath', 'imageUrl', 'imgPathNm', 'url', 'path']) {
      if (typeof item[key] === 'string') {
        const ref = imageReference(item[key]);
        if (ref) out[key] = ref;
      }
    }
    return Object.keys(out).length ? [out] : [];
  });
}

function safeReviewBody(value) {
  if (!text(value, 100_000)) fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_SCHEMA_INVALID', { field: 'content' });
  return value.includes('<') && value.includes('>')
    ? htmlToText(value)
    : value.replace(/\s+/g, ' ').trim();
}

function normalizeReview(row, requestedGoodsNumber) {
  if (!object(row) || row.reviewId === null || row.reviewId === undefined ||
      !object(row.goodsDto) || !goodsId(String(row.goodsDto.goodsNumber ?? '')) ||
      !Number.isFinite(Number(row.reviewScore)) || Number(row.reviewScore) < 0 || Number(row.reviewScore) > 5) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_SCHEMA_INVALID');
  }
  const sourceGoodsNumber = String(row.goodsDto.goodsNumber);
  const photos = Array.isArray(row.photoReviewList) ? row.photoReviewList.flatMap(photo => {
    if (!object(photo) || typeof photo.imagePath !== 'string' || photo.imagePath.length > 4096) return [];
    return [{ ...(photo.imageSequence !== undefined ? { imageSequence: photo.imageSequence } : {}),
      imagePath: photo.imagePath }];
  }) : [];
  return {
    reviewId: String(row.reviewId),
    sourceProductId: sourceGoodsNumber,
    productRelation: sourceGoodsNumber === requestedGoodsNumber ? 'requested_product' : 'related_product',
    body: safeReviewBody(row.content ?? ''),
    rating: Number(row.reviewScore),
    ...(text(row.createdDateTime, 100) ? { createdAt: row.createdDateTime } : {}),
    ...(text(row.reviewType, 80) ? { reviewType: row.reviewType } : {}),
    ...(text(row.goodsDto.optionName, 500) ? { optionName: row.goodsDto.optionName } : {}),
    ...(typeof row.isRepurchase === 'boolean' ? { isRepurchase: row.isRepurchase } : {}),
    ...(typeof row.isMonthUseReview === 'boolean' ? { isMonthUseReview: row.isMonthUseReview } : {}),
    ...(typeof row.isMonthOverReview === 'boolean' ? { isMonthOverReview: row.isMonthOverReview } : {}),
    photos,
  };
}

function assertNoSessionEcho(value, session) {
  if (!session.cookies.length) return value;
  const serialized = JSON.stringify(value);
  if (session.cookies.some(cookie => serialized.includes(cookie.value))) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_OUTPUT_REDACTED');
  }
  return value;
}

function numericRating(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 5 ? number : null;
}

function optionalRatio(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function canonicalProductUrl(goodsNumber, categoryNumber = '') {
  const url = new URL('/store/goods/getGoodsDetail.do', WWW);
  url.searchParams.set('goodsNo', goodsNumber);
  if (categoryNumber) url.searchParams.set('dispCatNo', categoryNumber);
  return url.href;
}

function safeCursorId(value, field = 'cursorId') {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && value.length > 0 && value.length <= 1000 && !CONTROL.test(value)) return value;
  fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PAGINATION_SCHEMA_INVALID', { field });
}

function safeCursorNumber(value, field) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PAGINATION_SCHEMA_INVALID', { field });
  }
  return value;
}

function validateCursorFields(cursor, { source = false } = {}) {
  if (!object(cursor) || !['cursorId', 'cursorScore', 'cursorCount'].every(key =>
    Object.prototype.hasOwnProperty.call(cursor, key))) {
    fail(source ? 'OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PAGINATION_SCHEMA_INVALID'
      : 'OLIVEYOUNG_KOREA_PUBLIC_REVIEW_CURSOR_INVALID');
  }
  try {
    safeCursorId(cursor.cursorId, 'cursorId');
    safeCursorNumber(cursor.cursorScore, 'cursorScore');
    safeCursorNumber(cursor.cursorCount, 'cursorCount');
  } catch (error) {
    if (source) throw error;
    fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_CURSOR_INVALID');
  }
  return cursor;
}

function validateReviewInput({ goodsNumber, pageSize, sortType, reviewType, continuation, itemNumber, filters }) {
  if (!goodsId(goodsNumber) || !positiveInt(pageSize) || pageSize > 100 ||
      !REVIEW_SORTS.has(sortType) || !REVIEW_TYPES.has(reviewType) ||
      itemNumber !== undefined && !goodsId(itemNumber) || !object(filters)) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_INPUT_INVALID');
  }
  const filterKeys = new Set(['skinType', 'skinTone', 'skinTrouble', 'cacheAvailable',
    'itemNumberList', 'relateGoodsList']);
  for (const key of Object.keys(filters)) {
    if (!filterKeys.has(key)) fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_INPUT_INVALID', { field: key });
  }
  if (continuation !== null) validateCursorFields(continuation);
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      const invalid = key === 'relateGoodsList'
        ? value.some(item => !object(item) || !goodsId(item.goodsNumber) ||
            item.itemNumber !== undefined && !goodsId(item.itemNumber))
        : value.some(item => !(typeof item === 'string' || typeof item === 'number') ||
            !text(String(item), 500));
      if (value.length > 100 || invalid) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_INPUT_INVALID', { field: key });
      }
    } else if (!(typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value))) {
      fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_INPUT_INVALID', { field: key });
    }
  }
}

function validateReviewPhotoInput({ goodsNumber, pageNumber, pageSize, itemNumber }) {
  if (!goodsId(goodsNumber) || !positiveInt(pageNumber) || pageNumber > 10_000 ||
      !positiveInt(pageSize) || pageSize > 100 ||
      itemNumber !== undefined && !goodsId(itemNumber)) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_INPUT_INVALID');
  }
}

function normalizeOption(option) {
  if (!object(option)) fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_SCHEMA_INVALID');
  const id = option.optionNumber;
  if (id !== undefined && id !== null && !goodsId(String(id)) && !/^[0-9]{1,40}$/.test(String(id))) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_SCHEMA_INVALID', { field: 'optionNumber' });
  }
  const unitInfo = object(option.unitInfo) ? option.unitInfo : null;
  return {
    ...(id !== undefined && id !== null ? { optionId: String(id) } : {}),
    ...(text(option.standardCode, 120) ? { sku: option.standardCode } : {}),
    ...(text(option.brand, 300) ? { brand: option.brand } : {}),
    ...(text(option.lowerCategoryNumber, 100) ? { lowerCategoryNumber: option.lowerCategoryNumber } : {}),
    ...(typeof option.representFlag === 'boolean' ? { selected: option.representFlag } : {}),
    availability: option.soldOutFlag === true ? 'unavailable' : option.soldOutFlag === false ? 'available' : 'unknown',
    ...(unitInfo ? { unitPrice: {
      amount: unitInfo.price === undefined ? null : String(unitInfo.price),
      unit: text(unitInfo.priceUnit, 120) ? unitInfo.priceUnit : null,
    } } : {}),
  };
}

function buildExtraBody(goodsData, { goodsNumber, todayDeliveryChecked }) {
  const options = goodsData.options;
  if (!Array.isArray(options)) fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_SCHEMA_INVALID');
  const mapped = options.map(option => {
    if (!object(option)) fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_SCHEMA_INVALID', { field: 'options' });
    let reservationFlag;
    if (option.reservationFlag === true) reservationFlag = true;
    else if (option.limitedInfoDto === null || option.limitedInfoDto === undefined) reservationFlag = true;
    else fail('OLIVEYOUNG_KOREA_PUBLIC_EXTRA_LIMIT_RULE_UNVERIFIED');
    const entry = {
      optionNumber: option.optionNumber,
      standardCode: option.standardCode,
      brand: option.brand,
      representFlag: option.representFlag,
      lowerCategoryNumber: option.standardCategory?.lowerCategory,
      discountApplyFlag: option.discountApplyFlag,
      todayDeliveryFlag: option.todayDeliveryFlag,
      soldOutFlag: option.soldOutFlag,
      reservationFlag,
    };
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
  });
  const body = {
    goodsNumber,
    deliveryFreeFlag: goodsData.deliveryFreeFlag ?? false,
    leadTime: goodsData.leadTime ?? 0,
    goodsTypeCode: goodsData.goodsTypeCode ?? '',
    tradeCode: goodsData.tradeCode ?? '',
    supplier: goodsData.supplier ?? '',
    onlineBrand: goodsData.onlineBrand ?? '',
    orderableMinimumQuantity: goodsData.orderableMinimumQuantity ?? 0,
    deliveryPolicyNumber: goodsData.deliveryPolicyNumber ?? null,
    todayDeliveryCheckedFlag: todayDeliveryChecked,
    options: mapped,
  };
  if (goodsData.goodsSectionCode !== undefined) body.goodsSectionCode = goodsData.goodsSectionCode;
  return body;
}

/**
 * Read the Korean non-affiliate storefront through direct HTTP.
 * This factory never launches a browser. An optional caller-supplied anonymous
 * session is memory-only and scoped to Olive Young's www/m origins.
 */
export function createOliveyoungKoreaPublicClient({
  session,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 15_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > MAX_RESPONSE_BYTES) {
    fail('OLIVEYOUNG_KOREA_PUBLIC_OPTIONS_INVALID');
  }
  const scopedSession = validateSession(session);
  const readReceipts = [];

  async function requestJson({
    origin, path, method = 'GET', query = [], jsonBody, formBodyValue,
    formFieldNames = [], referer, capabilityId, expectedId = null,
    originHeader = null, useRequestedWith = false,
  }) {
    if (![WWW, MOBILE].includes(origin) || !allowedPath(origin, path) ||
        !['GET', 'POST'].includes(method) ||
        (method === 'GET' && (jsonBody !== undefined || formBodyValue !== undefined)) ||
        (method === 'POST' && (jsonBody !== undefined) === (formBodyValue !== undefined))) {
      fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_INVALID');
    }
    const url = new URL(path, origin);
    for (const [key, value] of query) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' ||
          value.length > 2048 || CONTROL.test(value)) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_INVALID');
      }
      url.searchParams.append(key, value);
    }
    const cookie = cookieHeaderFor(scopedSession, origin);
    const headers = new Headers({ accept: 'application/json' });
    if (originHeader) {
      if (![WWW, MOBILE].includes(originHeader)) fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_INVALID');
      headers.set('origin', originHeader);
    }
    if (referer) {
      if (typeof referer !== 'string' || referer.length > 2048 || CONTROL.test(referer)) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_INVALID');
      }
      const ref = new URL(referer);
      if (![WWW, MOBILE].includes(ref.origin)) fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_INVALID');
      headers.set('referer', ref.href);
    }
    if (scopedSession.userAgent) headers.set('user-agent', scopedSession.userAgent);
    if (cookie.value) headers.set('cookie', cookie.value);
    if (useRequestedWith) headers.set('x-requested-with', 'XMLHttpRequest');
    let body;
    if (jsonBody !== undefined) {
      body = JSON.stringify(jsonBody);
      if (Buffer.byteLength(body) > 128 * 1024) fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_TOO_LARGE');
      headers.set('content-type', 'application/json');
    } else if (formBodyValue !== undefined) {
      body = formBodyValue;
      if (Buffer.byteLength(body) > 64 * 1024) fail('OLIVEYOUNG_KOREA_PUBLIC_REQUEST_TOO_LARGE');
      headers.set('content-type', 'application/x-www-form-urlencoded; charset=UTF-8');
    }
    const base = {
      schema: 'commerce-api-read-receipt-v1',
      service: SERVICE,
      capabilityId,
      checkedAt: checkedAt(now),
      request: {
        method, origin, path: url.pathname,
        queryFields: [...new Set(query.map(([name]) => name))],
        bodyFieldNames: method !== 'POST' ? [] : jsonBody !== undefined
          ? Object.keys(jsonBody).sort() : [...new Set(formFieldNames)].sort(),
        browserUsed: false,
        sessionUsed: Boolean(cookie.value || scopedSession.userAgent),
        cookieNamesSent: cookie.names,
        userAgentSupplied: Boolean(scopedSession.userAgent),
        accountAuthentication: 'not_used',
      },
      secretsPersistedInEvidence: false,
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail('OLIVEYOUNG_KOREA_PUBLIC_TRANSPORT_FAILED', {
        ...base,
        request: { ...base.request, causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' },
      });
    }
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    const receipt = { ...base, request: { ...base.request, httpStatus: response.status, mime } };
    if (response.redirected || [301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_KOREA_PUBLIC_REDIRECT_REJECTED', receipt);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_KOREA_PUBLIC_HTTP_BLOCKED', receipt);
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_KOREA_PUBLIC_THROTTLED', receipt);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_KOREA_PUBLIC_HTTP_ERROR', receipt);
    }
    if (!/^application\/(?:json|[^;]+\+json)$/i.test(mime ?? '')) {
      await response.body?.cancel().catch(() => {});
      fail('OLIVEYOUNG_KOREA_PUBLIC_MIME_INVALID', receipt);
    }
    const raw = await readBounded(response, maxResponseBytes);
    if (!raw) fail('OLIVEYOUNG_KOREA_PUBLIC_RESPONSE_TOO_LARGE', receipt);
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { fail('OLIVEYOUNG_KOREA_PUBLIC_JSON_INVALID', { ...receipt, responseBytes: raw.byteLength }); }
    if (!object(payload)) fail('OLIVEYOUNG_KOREA_PUBLIC_SCHEMA_INVALID', {
      ...receipt, responseBytes: raw.byteLength,
    });
    const record = {
      ...receipt,
      request: {
        ...receipt.request,
        responseBytes: raw.byteLength,
        responseSha256: createHash('sha256').update(raw).digest('hex'),
        responseProductMatched: expectedId === null || payload?.data?.goodsNumber === undefined
          ? null : payload.data.goodsNumber === expectedId,
      },
    };
    readReceipts.push(record);
    return { payload, receipt: record };
  }

  function receiptSnapshot(startIndex) {
    return readReceipts.slice(startIndex);
  }

  async function getReviewsPage({ goodsNumber, pageSize, sortType, reviewType, continuation, itemNumber, filters }) {
    validateReviewInput({ goodsNumber, pageSize, sortType, reviewType, continuation, itemNumber, filters });
    const firstPage = continuation === null;
    const body = {
      goodsNumber,
      size: pageSize,
      sortType,
      reviewType,
      ...filters,
      ...(itemNumber ? { itemNumber } : {}),
      ...(firstPage ? { page: 0 } : {
        cursorId: continuation.cursorId,
        cursorScore: continuation.cursorScore,
        cursorCount: continuation.cursorCount,
      }),
    };
    const start = readReceipts.length;
    const { payload } = await requestJson({
      origin: MOBILE, path: REVIEW_CURSOR, method: 'POST', jsonBody: body,
      originHeader: WWW,
      referer: WWW + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNumber),
      capabilityId: 'reviews.body',
    });
    const data = payload.data;
    if (!object(data) || !Array.isArray(data.goodsReviewList) || data.goodsReviewList.length > pageSize ||
        typeof data.hasNext !== 'boolean') fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_SCHEMA_INVALID');
    const total = safeInteger(payload.totalCnt, 'totalCnt', { optional: true });
    const reviews = data.goodsReviewList.map(row => normalizeReview(row, goodsNumber));
    let nextCursor = null;
    if (data.hasNext) {
      const sourceCursor = {
        cursorId: data.nextCursorId,
        cursorScore: data.nextCursorScore,
        cursorCount: data.nextCursorCount,
      };
      validateCursorFields(sourceCursor, { source: true });
      nextCursor = sourceCursor;
    }
    return assertNoSessionEcho({
      productId: goodsNumber,
      reviews,
      totalReviews: total,
      pageSize,
      continuation: nextCursor,
      hasNext: data.hasNext,
      loginRequiredIndicated: typeof data.loginRequired === 'boolean' ? data.loginRequired : null,
      productAssociation: 'each review preserves sourceProductId; related-product rows are not relabeled as exact product reviews',
      receipts: receiptSnapshot(start),
    }, scopedSession);
  }

  return Object.freeze({
    async searchProducts({
      query, page = 1, pageSize, sort, goodsSort, formState = {},
    } = {}) {
      if (!text(query, 120) || !query.trim() || !positiveInt(page) || page > 10_000 ||
          !positiveInt(pageSize) || pageSize > 100 || !object(formState) ||
          Object.keys(formState).some(key => !SEARCH_FORM_FIELDS.has(key))) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_INPUT_INVALID');
      }
      const normalizedQuery = query.trim();
      const offset = (page - 1) * pageSize;
      const fields = {
        query: normalizedQuery,
        collection: COLLECTION,
        displayMediaTypes: MEDIA_TYPE,
        listnum: String(pageSize),
        startCount: String(offset),
        sort: sort ?? formState.sort ?? 'RANK/DESC',
        goods_sort: goodsSort ?? formState.goods_sort ?? 'RANK/DESC',
        ...formState,
      };
      const body = formBody(fields);
      const start = readReceipts.length;
      const { payload } = await requestJson({
        origin: WWW, path: SEARCH, method: 'POST', formBodyValue: body,
        formFieldNames: [...new URLSearchParams(body).keys()],
        referer: WWW + '/store/search/getSearchMain.do',
        capabilityId: 'catalog.search_prices',
        useRequestedWith: true,
      });
      if (!Array.isArray(payload.Data) || !Array.isArray(payload.Parameter) ||
          payload.Data.length > 50 || payload.Parameter.length > 5) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_SCHEMA_INVALID');
      }
      const goodsGroup = payload.Data.find(group => object(group) && group.CollName === 'OLIVE_GOODS');
      const rows = goodsGroup ? goodsGroup.Result : [];
      if (!Array.isArray(rows) || rows.length > 1000) fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_SCHEMA_INVALID');
      const products = rows.map(normalizeSearchProduct);
      const ids = products.map(product => product.productId);
      if (new Set(ids).size !== ids.length) fail('OLIVEYOUNG_KOREA_PUBLIC_SEARCH_SCHEMA_INVALID');
      const total = goodsGroup ? safeInteger(goodsGroup.TotalCount, 'OLIVE_GOODS.TotalCount') : 0;
      const hasNext = rows.length > 0 && offset + rows.length < total;
      return assertNoSessionEcho({
        query: normalizedQuery,
        products,
        requestedPage: { page, pageSize, offset },
        totalProducts: total,
        pagination: {
          mode: 'offset',
          currentOffset: offset,
          pageSize,
          hasNext,
          nextPage: hasNext ? page + 1 : null,
          terminationVerified: false,
        },
        complete: false,
        receipts: receiptSnapshot(start),
      }, scopedSession);
    },

    async getProduct({
      goodsNumber,
      displayCategoryNumber = '',
      trackingCode = '',
      gateCode = '',
      returnType = '',
      referer = '',
      utmSource = '',
      utmMedium = '',
      utmCampaign = '',
      todayDeliveryChecked = false,
    } = {}) {
      if (!goodsId(goodsNumber) ||
          [displayCategoryNumber, trackingCode, gateCode, returnType, referer, utmSource, utmMedium, utmCampaign]
            .some(value => !text(value, 2048)) ||
          typeof todayDeliveryChecked !== 'boolean') {
        fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_INPUT_INVALID');
      }
      const start = readReceipts.length;
      const productReferer = referer || WWW + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNumber);
      const detail = await requestJson({
        origin: WWW, path: DETAIL, method: 'GET',
        query: [
          ['goodsNo', goodsNumber], ['dispCatNo', displayCategoryNumber], ['trackingCd', trackingCode],
          ['gateCd', gateCode], ['retType', returnType], ['referer', referer], ['appFlag', 'false'],
          ['utmSource', utmSource], ['utmMedium', utmMedium], ['utmCampaign', utmCampaign],
        ],
        referer: productReferer,
        capabilityId: 'catalog.product_detail',
        expectedId: goodsNumber,
      });
      const receivedGoodsData = detail.payload?.data;
      if (!object(receivedGoodsData) || receivedGoodsData.goodsNumber !== goodsNumber ||
          !text(receivedGoodsData.goodsName, 2000)) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_SCHEMA_INVALID', detail.receipt);
      }
      const goodsData = { ...receivedGoodsData,
        options: receivedGoodsData.options === undefined ? [] : receivedGoodsData.options };
      const extraBody = buildExtraBody(goodsData, { goodsNumber, todayDeliveryChecked });
      const [description, extra] = await Promise.all([
        requestJson({
          origin: WWW, path: DESCRIPTION, method: 'GET',
          query: [['goodsNumber', goodsNumber]],
          referer: productReferer,
          capabilityId: 'catalog.product_description',
          expectedId: goodsNumber,
        }),
        requestJson({
          origin: WWW, path: EXTRA, method: 'POST',
          jsonBody: { ...extraBody, appFlag: false },
          referer: productReferer,
          capabilityId: 'catalog.options',
          expectedId: goodsNumber,
        }),
      ]);
      const descriptionData = description.payload?.data;
      const extraData = extra.payload?.data;
      if (!object(descriptionData) || !object(extraData) || extraData.goodsNumber !== goodsNumber ||
          !object(extraData.optionDetail) || !Array.isArray(extraData.optionDetail.optionList)) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_SCHEMA_INVALID', extra.receipt);
      }
      const options = extraData.optionDetail.optionList.map(normalizeOption);
      const descriptionContent = typeof descriptionData.descriptionContents === 'string'
        ? descriptionData.descriptionContents : '';
      return assertNoSessionEcho({
        productId: goodsNumber,
        canonicalUrl: canonicalProductUrl(goodsNumber, displayCategoryNumber),
        title: goodsData.goodsName,
        ...(text(goodsData.onlineBrandName, 500) ? { brand: goodsData.onlineBrandName } : {}),
        ...(object(goodsData.displayCategory) ? {
          categories: Object.fromEntries(['middleCategoryName', 'lowerCategoryName', 'leafCategoryName']
            .filter(key => text(goodsData.displayCategory[key], 500))
            .map(key => [key, goodsData.displayCategory[key]])),
        } : {}),
        availability: extraData.optionDetail.allSoldOutFlag === true ? 'unavailable' :
          extraData.optionDetail.allSoldOutFlag === false ? 'available' : 'unknown',
        options,
        description: htmlToText(descriptionContent),
        images: [...imageReferences(descriptionData.goodsDetailImages), ...htmlImages(descriptionContent)],
        priceFields: {
          salePrice: optionalSourceMoney(goodsData.salePrice, 'goodsData.salePrice'),
          finalPrice: optionalSourceMoney(goodsData.finalPrice, 'goodsData.finalPrice'),
          maxBenefitPrice: optionalSourceMoney(goodsData.maxBenefitPrice, 'goodsData.maxBenefitPrice'),
          currency: 'KRW',
          displayMappingVerified: false,
        },
        reviewSummary: {
          count: safeInteger(extraData.reviewInfoDto?.reviewCnt, 'reviewInfoDto.reviewCnt', { optional: true }),
          averageRating: numericRating(extraData.reviewInfoDto?.reviewAvgScore),
        },
        receipts: receiptSnapshot(start),
      }, scopedSession);
    },

    getReviews({ goodsNumber, pageSize = 10, sortType = 'USEFUL_SCORE_DESC',
      reviewType = 'ALL', continuation = null, itemNumber, filters = {} } = {}) {
      return getReviewsPage({ goodsNumber, pageSize, sortType, reviewType, continuation, itemNumber, filters });
    },

    async collectReviews({ goodsNumber, pageSize = 10, maxPages = 20, maxReviews = 1000,
      sortType = 'USEFUL_SCORE_DESC', reviewType = 'ALL', itemNumber, filters = {} } = {}) {
      if (!positiveInt(maxPages) || maxPages > 100 || !positiveInt(maxReviews) || maxReviews > 10_000) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_INPUT_INVALID');
      }
      const start = readReceipts.length;
      const byId = new Map();
      const seenCursors = new Set();
      let continuation = null;
      let reason = 'max_pages';
      for (let page = 0; page < maxPages; page++) {
        const result = await getReviewsPage({ goodsNumber, pageSize, sortType, reviewType, itemNumber, filters, continuation });
        let added = 0;
        for (const review of result.reviews) {
          if (!byId.has(review.reviewId)) { byId.set(review.reviewId, review); added++; }
          if (byId.size >= maxReviews) break;
        }
        if (!result.hasNext) { reason = 'source_terminal'; break; }
        const next = result.continuation;
        const cursorKey = JSON.stringify([next?.cursorId, next?.cursorScore, next?.cursorCount]);
        if (!next || seenCursors.has(cursorKey)) { reason = 'cursor_repeat'; break; }
        if (added === 0) { reason = 'no_new_reviews'; break; }
        seenCursors.add(cursorKey);
        continuation = next;
        if (byId.size >= maxReviews) { reason = 'max_reviews'; break; }
      }
      return assertNoSessionEcho({
        productId: goodsNumber,
        reviews: [...byId.values()],
        totalCollected: byId.size,
        complete: reason === 'source_terminal',
        terminationReason: reason,
        paginationVerified: true,
        receipts: receiptSnapshot(start),
      }, scopedSession);
    },

    async getPhotoReviews({ goodsNumber, pageNumber = 1, pageSize = 10, itemNumber } = {}) {
      validateReviewPhotoInput({ goodsNumber, pageNumber, pageSize, itemNumber });
      const body = { goodsNumber, page: pageNumber - 1, size: pageSize,
        ...(itemNumber ? { itemNumber } : {}) };
      const start = readReceipts.length;
      const { payload } = await requestJson({
        origin: MOBILE, path: REVIEW_PHOTOS, method: 'POST', jsonBody: body,
        originHeader: WWW,
        referer: WWW + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNumber),
        capabilityId: 'reviews.images',
      });
      if (!Array.isArray(payload.data) || !object(payload.pagination)) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PHOTO_SCHEMA_INVALID');
      }
      const reviews = payload.data.map(row => {
        if (!object(row) || row.reviewId === null || row.reviewId === undefined ||
            !Array.isArray(row.photoReviewList)) fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PHOTO_SCHEMA_INVALID');
        return {
          reviewId: String(row.reviewId),
          ...(text(row.createdDateTime, 100) ? { createdAt: row.createdDateTime } : {}),
          photos: row.photoReviewList.flatMap(photo => object(photo) && typeof photo.imagePath === 'string'
            ? [{ imageSequence: photo.imageSequence ?? null, imagePath: photo.imagePath }] : []),
        };
      }).filter(review => review.photos.length > 0);
      const last = payload.pagination.isLastPage;
      if (typeof last !== 'boolean') fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PHOTO_SCHEMA_INVALID');
      return assertNoSessionEcho({
        productId: goodsNumber,
        reviews,
        pagination: {
          pageNumber,
          pageSize,
          totalCount: safeInteger(payload.pagination.totalCount, 'pagination.totalCount', { optional: true }),
          isLastPage: last,
          nextPage: last ? null : pageNumber + 1,
          sourceCursor: payload.pagination.nextCursor ?? null,
        },
        receipts: receiptSnapshot(start),
      }, scopedSession);
    },

    async getReviewStats({ goodsNumber, itemNumber } = {}) {
      if (!goodsId(goodsNumber) || itemNumber !== undefined && !goodsId(itemNumber)) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_ID_INVALID');
      }
      const path = REVIEW_STATS + '/' + encodeURIComponent(goodsNumber) + '/stats';
      const query = itemNumber ? [['itemNumber', itemNumber]] : [];
      const start = readReceipts.length;
      const { payload } = await requestJson({
        origin: MOBILE, path, method: 'GET', query,
        referer: WWW + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNumber),
        capabilityId: 'reviews.summary',
      });
      const data = payload.data;
      if (!object(data) || data.goodsNumber !== goodsNumber || !object(data.ratingDistribution)) {
        fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_STATS_SCHEMA_INVALID');
      }
      return assertNoSessionEcho({
        productId: goodsNumber,
        reviewCount: safeInteger(data.reviewCount, 'reviewCount'),
        averageRating: numericRating(data.ratingDistribution.averageRating),
        ratingDistribution: Array.isArray(data.ratingDistribution.ratingStatDtos)
          ? data.ratingDistribution.ratingStatDtos : [],
        satisfactionStats: Array.isArray(data.satisfactionStats) ? data.satisfactionStats : [],
        receipts: receiptSnapshot(start),
      }, scopedSession);
    },

    async getReviewOptionCounts({ goodsNumber } = {}) {
      if (!goodsId(goodsNumber)) fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_ID_INVALID');
      const path = REVIEW_OPTIONS + '/' + encodeURIComponent(goodsNumber) + '/count';
      const start = readReceipts.length;
      const { payload } = await requestJson({
        origin: MOBILE, path, method: 'GET',
        referer: WWW + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNumber),
        capabilityId: 'reviews.option_counts',
      });
      if (!object(payload.data)) fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_OPTIONS_SCHEMA_INVALID');
      return assertNoSessionEcho({
        productId: goodsNumber,
        hasZeroReviewOption: payload.data.hasZeroReviewOption ?? null,
        skinFilterAvailable: payload.data.isReviewSkinFilterAvailability ?? null,
        optionCounts: Array.isArray(payload.data.productItemReviewCountList)
          ? payload.data.productItemReviewCountList : [],
        relatedProductCounts: Array.isArray(payload.data.relatedProductReviewCountList)
          ? payload.data.relatedProductReviewCountList : [],
        receipts: receiptSnapshot(start),
      }, scopedSession);
    },

    async getReviewSummary({ goodsNumber } = {}) {
      if (!goodsId(goodsNumber)) fail('OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_ID_INVALID');
      const path = REVIEW_SUMMARY + '/' + encodeURIComponent(goodsNumber) + '/summary';
      const start = readReceipts.length;
      const { payload } = await requestJson({
        origin: MOBILE, path, method: 'GET',
        referer: WWW + '/store/goods/getGoodsDetail.do?goodsNo=' + encodeURIComponent(goodsNumber),
        capabilityId: 'reviews.summary',
      });
      if (!object(payload.data)) fail('OLIVEYOUNG_KOREA_PUBLIC_REVIEW_SUMMARY_SCHEMA_INVALID');
      const data = payload.data;
      return assertNoSessionEcho({
        productId: goodsNumber,
        features: [1, 2, 3].flatMap(index => {
          const title = data['feature' + index + 'Title'];
          const description = data['feature' + index + 'Description'];
          return text(title, 500) || text(description, 2000)
            ? [{ title: text(title, 500) ? title : null, description: text(description, 2000) ? description : null }]
            : [];
        }),
        positiveRatio: optionalRatio(data.positiveRatio),
        negativeRatio: optionalRatio(data.negativeRatio),
        receipts: receiptSnapshot(start),
      }, scopedSession);
    },
  });
}
