import { createHmac } from 'node:crypto';
import { ScopedSession } from '../scoped-session.mjs';

const ORIGIN = 'https://eco.taobao.com';
const ROUTE = '/router/rest';
const ENDPOINTS = Object.freeze({
  query: 'aliexpress.affiliate.product.query',
  detail: 'aliexpress.affiliate.productdetail.get',
  socialSearch: 'aliexpress.social.item.search',
});
const PRODUCT_ID = /^[0-9]{8,22}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})(?:\.[0-9]{1,8})?$/;
const CURRENCIES = new Set(['USD', 'GBP', 'CAD', 'EUR', 'UAH', 'MXN', 'TRY', 'RUB', 'BRL', 'AUD', 'INR', 'JPY', 'IDR', 'SEK', 'KRW']);
const LANGUAGES = new Set(['EN', 'RU', 'PT', 'ES', 'FR', 'ID', 'IT', 'TH', 'JA', 'AR', 'VI', 'TR', 'DE', 'HE', 'KO', 'NL', 'PL', 'MX', 'CL', 'IW', 'IN']);
const ALLOWED_SORTS = new Set(['SALE_PRICE_ASC', 'SALE_PRICE_DESC', 'LAST_VOLUME_ASC', 'LAST_VOLUME_DESC']);
const QUERY_FIELDS = [
  'product_id', 'product_title', 'product_detail_url', 'product_main_image_url',
  'sale_price', 'sale_price_currency', 'original_price', 'original_price_currency',
  'app_sale_price', 'app_sale_price_currency', 'target_sale_price', 'target_sale_price_currency',
  'target_original_price', 'target_original_price_currency', 'target_app_sale_price',
  'target_app_sale_price_currency', 'commission_rate', 'relevant_market_commission_rate',
  'lastest_volume', 'first_level_category_id', 'first_level_category_name',
  'second_level_category_id', 'second_level_category_name',
].join(',');

export class AliExpressAffiliateError extends Error {
  constructor(code, receipt = null, remoteCode = null) {
    super(code);
    this.name = 'AliExpressAffiliateError';
    this.code = code;
    this.receipt = receipt;
    this.remoteCode = remoteCode;
  }
}

function fail(code, receipt = null, remoteCode = null) {
  throw new AliExpressAffiliateError(code, receipt, remoteCode);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, { min = 1, max = 500, pattern = null } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max
    || !value.trim() || /[\r\n\0]/.test(value) || pattern && !pattern.test(value)) {
    fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
  }
  return value.trim();
}

function decimal(value, { optional = false } = {}) {
  if (value == null && optional) return null;
  const normalized = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof normalized === 'string' && DECIMAL.test(normalized) ? normalized : null;
}

function price(amount, currency) {
  if (amount == null && currency == null) return null;
  const parsed = decimal(amount, { optional: true });
  if (parsed === null || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount: parsed, currency };
}

function parseProductId(value) {
  const id = String(value ?? '');
  return PRODUCT_ID.test(id) ? id : null;
}

function productUrl(value, id) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['www.aliexpress.com', 'aliexpress.com'].includes(url.hostname.toLowerCase())
      || url.protocol !== 'https:' || url.username || url.password || url.hash
      || url.pathname !== `/item/${id}.html`) return null;
    return `https://www.aliexpress.com/item/${id}.html`;
  } catch {
    return null;
  }
}

function officialTimestamp(epochMs) {
  if (!Number.isFinite(epochMs)) fail('ALIEXPRESS_AFFILIATE_OPTIONS_INVALID');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function topSign(params, appSecret) {
  const canonical = Object.keys(params).filter(key => key !== 'sign')
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(key => `${key}${params[key]}`).join('');
  return createHmac('md5', appSecret).update(canonical, 'utf8').digest('hex').toUpperCase();
}

function authParams({ appKey, appSecret, now, method }, business) {
  const params = {
    app_key: appKey,
    format: 'json',
    method,
    sign_method: 'hmac',
    timestamp: officialTimestamp(now()),
    v: '2.0',
    ...business,
  };
  params.sign = topSign(params, appSecret);
  return params;
}

function parseResponseEnvelope(data, method, receipt) {
  if (!object(data)) fail('ALIEXPRESS_AFFILIATE_RESPONSE_INVALID', receipt);
  const topName = method === ENDPOINTS.query
    ? 'aliexpress_affiliate_product_query_response'
    : 'aliexpress_affiliate_productdetail_get_response';
  const envelope = data[topName];
  const response = envelope?.resp_result;
  if (!object(response)) {
    const remote = data.error_response;
    if (object(remote)) {
      const remoteCode = remote.sub_code ?? remote.code ?? null;
      fail('ALIEXPRESS_AFFILIATE_REMOTE_ERROR', receipt, remoteCode == null ? null : String(remoteCode).slice(0, 120));
    }
    fail('ALIEXPRESS_AFFILIATE_SCHEMA_INVALID', receipt);
  }
  if (Number(response.resp_code) !== 200 || !object(response.result)) {
    fail('ALIEXPRESS_AFFILIATE_REMOTE_ERROR', receipt,
      response.resp_code == null ? 'UNKNOWN' : String(response.resp_code).slice(0, 120));
  }
  return response.result;
}

function parseSocialEnvelope(data, receipt) {
  const response = data?.aliexpress_social_item_search_response?.result;
  if (!object(response)) {
    const remote = data?.error_response;
    if (object(remote)) {
      const remoteCode = remote.sub_code ?? remote.code ?? null;
      fail('ALIEXPRESS_AFFILIATE_REMOTE_ERROR', receipt, remoteCode == null ? null : String(remoteCode).slice(0, 120));
    }
    fail('ALIEXPRESS_AFFILIATE_SCHEMA_INVALID', receipt);
  }
  if (response.success !== true) {
    const remoteCode = response.error_code;
    fail('ALIEXPRESS_AFFILIATE_REMOTE_ERROR', receipt,
      remoteCode == null || remoteCode === '' ? 'UNKNOWN' : String(remoteCode).slice(0, 120));
  }
  return response;
}

function normalizeProduct(raw) {
  if (!object(raw)) return null;
  const productId = parseProductId(raw.product_id);
  const title = typeof raw.product_title === 'string' && raw.product_title.trim().length <= 2000
    ? raw.product_title.trim() : null;
  const url = productId ? productUrl(raw.product_detail_url, productId) : null;
  const salePrice = price(raw.sale_price, raw.sale_price_currency);
  if (!productId || !title || !url || !salePrice) return null;
  const optionalPrice = (amount, currency) => {
    if (amount == null && currency == null) return null;
    const parsed = price(amount, currency);
    if (parsed === null) fail('ALIEXPRESS_AFFILIATE_SCHEMA_INVALID');
    return parsed;
  };
  return {
    productId,
    title,
    url,
    imageUrl: typeof raw.product_main_image_url === 'string' && raw.product_main_image_url.startsWith('https://')
      ? raw.product_main_image_url.slice(0, 2048) : null,
    salePrice,
    listPrice: optionalPrice(raw.original_price, raw.original_price_currency),
    appSalePrice: optionalPrice(raw.app_sale_price, raw.app_sale_price_currency),
    targetSalePrice: optionalPrice(raw.target_sale_price, raw.target_sale_price_currency),
    targetListPrice: optionalPrice(raw.target_original_price, raw.target_original_price_currency),
    targetAppSalePrice: optionalPrice(raw.target_app_sale_price, raw.target_app_sale_price_currency),
    commissionRate: typeof raw.commission_rate === 'string' ? raw.commission_rate.slice(0, 80) : null,
    category: {
      firstLevelId: raw.first_level_category_id == null ? null : String(raw.first_level_category_id).slice(0, 32),
      firstLevelName: typeof raw.first_level_category_name === 'string' ? raw.first_level_category_name.slice(0, 200) : null,
      secondLevelId: raw.second_level_category_id == null ? null : String(raw.second_level_category_id).slice(0, 32),
      secondLevelName: typeof raw.second_level_category_name === 'string' ? raw.second_level_category_name.slice(0, 200) : null,
    },
    recentSales: Number.isSafeInteger(Number(raw.lastest_volume)) && Number(raw.lastest_volume) >= 0
      ? Number(raw.lastest_volume) : null,
  };
}

function productArray(result) {
  const productList = result.products?.product;
  if (Array.isArray(productList)) return productList;
  if (object(productList)) return [productList];
  if (result.current_record_count === 0 || result.total_record_count === 0 || result.products == null) return [];
  fail('ALIEXPRESS_AFFILIATE_SCHEMA_INVALID');
}

function socialItemArray(result) {
  const items = result.results?.item_search_result;
  if (Array.isArray(items)) return items;
  if (object(items)) return [items];
  if (Number(result.total_count) === 0 || result.results == null) return [];
  fail('ALIEXPRESS_AFFILIATE_SCHEMA_INVALID');
}

function parseUsdDisplayPrice(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = /^\s*US\s+\$\s*([0-9][0-9,]*(?:\.[0-9]{1,8})?)\s*$/.exec(value);
  if (!match) return null;
  const amount = match[1].replaceAll(',', '');
  return DECIMAL.test(amount) ? { amount, currency: 'USD' } : null;
}

function socialProductUrl(value, id) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['www.aliexpress.com', 'aliexpress.com'].includes(url.hostname.toLowerCase())
      || url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || !new RegExp(`^/item/(?:-/${id}|${id})\\.html$`).test(url.pathname)) return null;
    return `https://www.aliexpress.com/item/${id}.html`;
  } catch {
    return null;
  }
}

function normalizeSocialItem(raw) {
  if (!object(raw)) return null;
  const productId = parseProductId(raw.item_id);
  const title = typeof raw.item_title === 'string' && raw.item_title.trim().length <= 2000
    ? raw.item_title.trim() : null;
  const url = productId ? socialProductUrl(raw.item_url, productId) : null;
  const listPriceRange = {
    min: parseUsdDisplayPrice(raw.item_origin_price_min),
    max: parseUsdDisplayPrice(raw.item_origin_price_max),
  };
  const salePriceRange = {
    min: parseUsdDisplayPrice(raw.item_price_discount_min),
    max: parseUsdDisplayPrice(raw.item_price_discount_max),
  };
  if (!productId || !title || !url || !listPriceRange.min || !listPriceRange.max
    || !salePriceRange.min || !salePriceRange.max) return null;
  return {
    productId, title, url, imageUrl: typeof raw.item_main_pic === 'string' && raw.item_main_pic.startsWith('https://')
      ? raw.item_main_pic.slice(0, 2048) : null,
    listPriceRange, salePriceRange,
    discountRate: decimal(String(raw.item_discount_rate ?? ''), { optional: true }),
    commissionRate: typeof raw.commission_rate === 'string' ? raw.commission_rate.slice(0, 80) : null,
    rating: decimal(String(raw.comment_score ?? ''), { optional: true }),
  };
}

function boundedInteger(value, fallback, min, max) {
  const parsed = value == null ? fallback : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function addOptional(params, key, value, max = 256) {
  if (value == null || value === '') return;
  params[key] = cleanText(value, { max });
}

function commonBusiness({ currency, language, trackingId, appSignature }) {
  const business = { fields: QUERY_FIELDS, target_currency: currency, target_language: language };
  addOptional(business, 'tracking_id', trackingId, 128);
  addOptional(business, 'app_signature', appSignature, 256);
  return business;
}

/**
 * Direct HTTP client for AliExpress Affiliate TOP reads. This is not the
 * anonymous storefront SEO endpoint and does not call dropshipping APIs.
 * AppKey/AppSecret sign every request in process memory; no buyer Session is
 * sent. The caller must supply valid developer app credentials and, when
 * desired, its own Affiliate tracking ID. No link IDs are invented.
 */
export function createAliExpressAffiliateClient({
  appKey, appSecret, trackingId, appSignature, fetchImpl, now = Date.now,
} = {}) {
  if (typeof appKey !== 'string' || !appKey.trim() || appKey.length > 128
    || typeof appSecret !== 'string' || !appSecret || appSecret.length > 512) {
    fail('ALIEXPRESS_AFFILIATE_CREDENTIALS_REQUIRED');
  }
  if (typeof now !== 'function') fail('ALIEXPRESS_AFFILIATE_OPTIONS_INVALID');
  const config = {
    appKey: appKey.trim(), appSecret,
    ...(trackingId == null ? {} : { trackingId: cleanText(trackingId, { max: 128 }) }),
    ...(appSignature == null ? {} : { appSignature: cleanText(appSignature, { max: 256 }) }),
    now,
  };
  const session = new ScopedSession({
    allowedOrigins: [ORIGIN], cookieOrigins: [], ...(fetchImpl ? { fetchImpl } : {}),
    defaultHeaders: { accept: 'application/json' },
    timeoutMs: 20_000, maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBytes: 64 * 1024, maxRedirects: 0,
  });

  async function request(method, business) {
    const params = authParams({ appKey: config.appKey, appSecret: config.appSecret, now, method }, business);
    const body = new URLSearchParams(params).toString();
    const receipt = {
      method: 'POST', origin: ORIGIN, path: ROUTE, checkedAt: new Date(now()).toISOString(),
      browserUsed: false, cookiesSent: false, userSessionSent: false,
      credentialsUsed: true, credentialsPersisted: false, credentialKind: 'app_key_hmac_signature',
      apiMethod: method,
    };
    let response;
    try {
      response = await session.request(`${ORIGIN}${ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body,
      });
    } catch (error) {
      if (error?.code === 'SCOPED_SESSION_RESPONSE_TOO_LARGE') fail('ALIEXPRESS_AFFILIATE_RESPONSE_TOO_LARGE', receipt);
      if (error?.code === 'SCOPED_SESSION_TIMEOUT') fail('ALIEXPRESS_AFFILIATE_TIMEOUT', receipt);
      if (error?.code === 'SCOPED_SESSION_REDIRECT_LIMIT') fail('ALIEXPRESS_AFFILIATE_REDIRECTED', receipt);
      fail('ALIEXPRESS_AFFILIATE_TRANSPORT_FAILED', receipt);
    }
    receipt.httpStatus = response.status;
    receipt.mime = response.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null;
    receipt.responseBytes = Buffer.byteLength(response.raw);
    if (response.status === 429) fail('ALIEXPRESS_AFFILIATE_THROTTLED', receipt);
    if (response.status === 401 || response.status === 403) fail('ALIEXPRESS_AFFILIATE_ACCESS_DENIED', receipt);
    if (response.status !== 200 || !['application/json', 'text/javascript'].includes(receipt.mime)) {
      fail('ALIEXPRESS_AFFILIATE_HTTP_ERROR', receipt);
    }
    let data;
    try { data = JSON.parse(response.raw); } catch { fail('ALIEXPRESS_AFFILIATE_RESPONSE_INVALID', receipt); }
    const result = method === ENDPOINTS.socialSearch
      ? parseSocialEnvelope(data, receipt)
      : parseResponseEnvelope(data, method, receipt);
    return { result, receipt };
  }

  function normalizeList(result, receipt, { page, query }) {
    const rawProducts = productArray(result);
    const products = rawProducts.map(normalizeProduct);
    if (products.some(product => product === null)) fail('ALIEXPRESS_AFFILIATE_PRODUCT_SCHEMA_INVALID', receipt);
    const currentPage = boundedInteger(result.current_page_no, page, 1, 1_000_000);
    const totalPages = boundedInteger(result.total_page_no, 0, 0, 1_000_000);
    const totalCount = boundedInteger(result.total_record_count, 0, 0, Number.MAX_SAFE_INTEGER);
    const currentCount = boundedInteger(result.current_record_count, products.length, 0, 10_000);
    if (currentPage === null || totalPages === null || totalCount === null || currentCount === null
      || currentCount !== products.length && products.length > 0) fail('ALIEXPRESS_AFFILIATE_SCHEMA_INVALID', receipt);
    return {
      query, page: currentPage, pageCount: totalPages, totalCount,
      products,
      receipt: { ...receipt, schemaVerified: true, resultCount: products.length,
        priceFieldsVerified: products.every(product => product.salePrice?.amount && product.salePrice?.currency) },
    };
  }

  return {
    async searchSocialProducts({ keyword, page = 1, limit = 10, currency = 'USD', shipTo = 'US',
      locale = 'en_US', categoryId, minimumPrice, maximumPrice, affiliateOnly = true,
      sortBy = 'sales', descending = true, freeShipping, hasVideo } = {}) {
      const searchTerm = keyword == null || keyword === '' ? '' : cleanText(keyword, { max: 128 });
      const pageNo = boundedInteger(page, 1, 1, 1_000_000);
      const pageSize = boundedInteger(limit, 10, 1, 50);
      const targetCurrency = cleanText(currency, { max: 3, pattern: /^[A-Z]{3}$/ });
      const country = cleanText(shipTo, { max: 2, pattern: /^[A-Z]{2}$/ });
      const targetLocale = cleanText(locale, { max: 5, pattern: /^[a-z]{2}_[A-Z]{2}$/ });
      if (pageNo === null || pageSize === null || targetCurrency !== 'USD' || targetLocale !== 'en_US'
        || typeof affiliateOnly !== 'boolean' || typeof descending !== 'boolean'
        || sortBy !== 'sales') fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
      const business = {
        page_no: String(pageNo), page_size: String(pageSize),
        ship_to: country, currency: targetCurrency, locale: targetLocale,
        alliance_item: String(affiliateOnly), order_by: sortBy, desc: String(descending),
      };
      if (searchTerm) business.keyword = searchTerm;
      if (categoryId != null) {
        const id = String(categoryId);
        if (!/^[0-9]{1,20}$/.test(id)) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
        business.cate_id = id;
      }
      if (minimumPrice != null) {
        const parsed = decimal(minimumPrice);
        if (parsed === null) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
        business.min_price = parsed;
      }
      if (maximumPrice != null) {
        const parsed = decimal(maximumPrice);
        if (parsed === null) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
        business.max_price = parsed;
      }
      if (business.min_price && business.max_price && Number(business.min_price) > Number(business.max_price)) {
        fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
      }
      for (const [key, value] of [['is_ship_free', freeShipping], ['has_video', hasVideo]]) {
        if (value != null) {
          if (typeof value !== 'boolean') fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
          business[key] = String(value);
        }
      }
      const { result, receipt } = await request(ENDPOINTS.socialSearch, business);
      const envelope = result;
      const rawItems = socialItemArray(envelope);
      const products = rawItems.map(normalizeSocialItem);
      if (products.some(product => product === null)) fail('ALIEXPRESS_AFFILIATE_PRODUCT_SCHEMA_INVALID', receipt);
      const currentPage = boundedInteger(envelope.page_no, pageNo, 1, 1_000_000);
      const responsePageSize = boundedInteger(envelope.page_size, rawItems.length, 0, 50);
      const totalCount = boundedInteger(envelope.total_count, 0, 0, Number.MAX_SAFE_INTEGER);
      if (currentPage === null || responsePageSize === null || totalCount === null
        || responsePageSize !== rawItems.length && rawItems.length > 0) fail('ALIEXPRESS_AFFILIATE_SCHEMA_INVALID', receipt);
      return { query: searchTerm, page: currentPage, pageSize: responsePageSize, totalCount, products,
        receipt: { ...receipt, schemaVerified: true, resultCount: products.length,
          priceFieldsVerified: products.every(product => product.salePriceRange?.min?.amount && product.salePriceRange?.max?.amount),
          currencyParser: 'documented_USD_en_US_prefix' } };
    },

    async searchProducts({
      query, page = 1, limit = 20, currency = 'USD', language = 'EN', shipToCountry = 'US',
      categoryIds, sort = 'SALE_PRICE_ASC', productType = 'ALL', minPrice, maxPrice,
      deliveryDays, trackingId: requestTrackingId, appSignature: requestAppSignature,
    } = {}) {
      const keyword = cleanText(query, { max: 128 });
      const pageNo = boundedInteger(page, 1, 1, 1_000_000);
      const pageSize = boundedInteger(limit, 20, 1, 50);
      const targetCurrency = cleanText(currency, { max: 3, pattern: /^[A-Z]{3}$/ });
      const targetLanguage = cleanText(language, { max: 2, pattern: /^[A-Z]{2}$/ });
      const country = cleanText(shipToCountry, { max: 2, pattern: /^[A-Z]{2}$/ });
      if (pageNo === null || pageSize === null || !CURRENCIES.has(targetCurrency)
        || !LANGUAGES.has(targetLanguage) || !ALLOWED_SORTS.has(sort)
        || !['ALL', 'PLAZA', 'TMALL'].includes(productType)) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
      const business = {
        ...commonBusiness({ currency: targetCurrency, language: targetLanguage,
          trackingId: requestTrackingId ?? config.trackingId,
          appSignature: requestAppSignature ?? config.appSignature }),
        keywords: keyword,
        page_no: String(pageNo), page_size: String(pageSize),
        ship_to_country: country,
        sort,
        platform_product_type: productType,
      };
      if (categoryIds != null && categoryIds !== '') {
        const ids = Array.isArray(categoryIds) ? categoryIds.map(String) : String(categoryIds).split(',');
        if (ids.length > 20 || ids.some(id => !/^[0-9]{1,20}$/.test(id))) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
        business.category_ids = ids.join(',');
      }
      if (minPrice != null) {
        const parsed = decimal(minPrice);
        if (parsed === null) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
        business.min_sale_price = parsed;
      }
      if (maxPrice != null) {
        const parsed = decimal(maxPrice);
        if (parsed === null) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
        business.max_sale_price = parsed;
      }
      if (business.min_sale_price && business.max_sale_price
        && Number(business.min_sale_price) > Number(business.max_sale_price)) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
      if (deliveryDays != null) {
        const days = String(deliveryDays);
        if (!['3', '5', '7', '10'].includes(days)) fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
        business.delivery_days = days;
      }
      const { result, receipt } = await request(ENDPOINTS.query, business);
      return normalizeList(result, receipt, { page: pageNo, query: keyword });
    },

    async getProduct({ productId, currency = 'USD', language = 'EN', country = 'US',
      trackingId: requestTrackingId, appSignature: requestAppSignature } = {}) {
      const id = parseProductId(productId);
      const targetCurrency = cleanText(currency, { max: 3, pattern: /^[A-Z]{3}$/ });
      const targetLanguage = cleanText(language, { max: 2, pattern: /^[A-Z]{2}$/ });
      const shipCountry = cleanText(country, { max: 2, pattern: /^[A-Z]{2}$/ });
      if (!id || !CURRENCIES.has(targetCurrency) || !LANGUAGES.has(targetLanguage)) {
        fail('ALIEXPRESS_AFFILIATE_INPUT_INVALID');
      }
      const business = {
        ...commonBusiness({ currency: targetCurrency, language: targetLanguage,
          trackingId: requestTrackingId ?? config.trackingId,
          appSignature: requestAppSignature ?? config.appSignature }),
        product_ids: id,
        country: shipCountry,
      };
      const { result, receipt } = await request(ENDPOINTS.detail, business);
      const products = productArray(result).map(normalizeProduct);
      if (products.some(product => product === null)) fail('ALIEXPRESS_AFFILIATE_PRODUCT_SCHEMA_INVALID', receipt);
      const product = products.find(item => item.productId === id);
      if (products.length > 0 && !product) fail('ALIEXPRESS_AFFILIATE_PRODUCT_ID_MISMATCH', receipt);
      if (!product) fail('ALIEXPRESS_AFFILIATE_PRODUCT_NOT_FOUND', receipt);
      return { product, receipt: { ...receipt, schemaVerified: true, productIdMatched: true,
        priceFieldsVerified: Boolean(product.salePrice?.amount && product.salePrice?.currency) } };
    },
  };
}
