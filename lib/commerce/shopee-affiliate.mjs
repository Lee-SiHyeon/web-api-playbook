import { createHash } from 'node:crypto';

const ORIGIN = 'https://open-api.affiliate.shopee.co.id';
const PATH = '/graphql';
const MARKET = 'ID';
const CURRENCY_CANDIDATE = 'IDR';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_KEYWORD_LENGTH = 200;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})(?:\.[0-9]{1,12})?$/;
const ITEM_ID = /^[1-9][0-9]{0,19}$/;
const RATE = /^(?:0(?:\.[0-9]{1,12})?|1(?:\.0{1,12})?)$/;
const PRODUCT_FIELDS = [
  'itemId', 'productName', 'price', 'priceMin', 'priceMax',
  'commissionRate', 'sellerCommissionRate', 'shopeeCommissionRate',
  'appExistRate', 'appNewRate', 'webExistRate', 'webNewRate',
  'commission', 'sales', 'imageUrl', 'productLink', 'shopId', 'shopName',
  'productCatIds', 'ratingStar', 'priceDiscountRate', 'shopType',
  'periodStartTime', 'periodEndTime',
].join(' ');
const PAGE_FIELDS = 'page limit hasNextPage';

export class ShopeeAffiliateError extends Error {
  constructor(code, request = null, remoteCode = null) {
    super(code);
    this.name = 'ShopeeAffiliateError';
    this.code = code;
    this.request = request;
    this.remoteCode = remoteCode;
  }
}

function fail(code, request = null, remoteCode = null) {
  throw new ShopeeAffiliateError(code, request, remoteCode);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCredential(value, maxLength) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength
    && value === value.trim() && !/[\x00-\x20\x7f]/.test(value);
}

function integer(value, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function graphqlString(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_KEYWORD_LENGTH
    || !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    fail('SHOPEE_AFFILIATE_KEYWORD_INVALID');
  }
  return JSON.stringify(value.trim());
}

function itemId(value) {
  const id = String(value ?? '');
  return ITEM_ID.test(id) ? id : null;
}

function safeDecimal(value, { rate = false, required = false } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !(rate ? RATE : DECIMAL).test(value)) return null;
  return value;
}

function percentage(rate) {
  if (rate == null) return null;
  const [whole, fraction = ''] = rate.split('.');
  const shifted = `${whole}${fraction.padEnd(2, '0').slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const remaining = fraction.slice(2).replace(/0+$/, '');
  return remaining ? `${shifted}.${remaining}` : shifted;
}

function safeProductUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !(host === 'shopee.co.id' || host.endsWith('.shopee.co.id'))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function int64String(value) {
  if (typeof value === 'string' && ITEM_ID.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function nonNegativeInt64String(value) {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function normalizeProduct(raw) {
  if (!object(raw)) fail('SHOPEE_AFFILIATE_SCHEMA_INVALID');
  const id = int64String(raw.itemId);
  const price = safeDecimal(raw.price, { required: true });
  const url = safeProductUrl(raw.productLink);
  if (!id || !price || !url || typeof raw.productName !== 'string' || !raw.productName.trim()
    || raw.productName.length > 2000) {
    fail('SHOPEE_AFFILIATE_SCHEMA_INVALID');
  }

  const optionalPrice = field => {
    if (raw[field] == null) return null;
    const result = safeDecimal(raw[field]);
    if (result == null) fail('SHOPEE_AFFILIATE_SCHEMA_INVALID');
    return result;
  };
  const optionalRate = field => {
    if (raw[field] == null) return null;
    const result = safeDecimal(raw[field], { rate: true });
    if (result == null) fail('SHOPEE_AFFILIATE_SCHEMA_INVALID');
    return result;
  };
  const rawSales = nonNegativeInt64String(raw.sales);
  if (rawSales == null) fail('SHOPEE_AFFILIATE_SCHEMA_INVALID');
  const categories = raw.productCatIds == null ? [] : raw.productCatIds;
  if (!Array.isArray(categories) || categories.some(value => !Number.isSafeInteger(value) || value < 0)) {
    fail('SHOPEE_AFFILIATE_SCHEMA_INVALID');
  }

  const commissionRate = optionalRate('commissionRate');
  return {
    market: MARKET,
    itemId: id,
    title: raw.productName.trim(),
    url,
    imageUrl: safeImageUrl(raw.imageUrl),
    price: {
      amount: price,
      currency: null,
      currencyCandidate: CURRENCY_CANDIDATE,
      currencyVerified: false,
      currencySource: 'market-inference',
      sourceField: 'price',
    },
    priceRange: {
      min: optionalPrice('priceMin'),
      max: optionalPrice('priceMax'),
      currency: null,
      currencyCandidate: CURRENCY_CANDIDATE,
      currencyVerified: false,
      currencySource: 'market-inference',
    },
    discountRatePercent: Number.isSafeInteger(raw.priceDiscountRate)
      && raw.priceDiscountRate >= 0 && raw.priceDiscountRate <= 100
      ? String(raw.priceDiscountRate) : null,
    commission: {
      amount: optionalPrice('commission'),
      currency: null,
      currencyCandidate: CURRENCY_CANDIDATE,
      currencyVerified: false,
      currencySource: 'market-inference',
      rate: commissionRate,
      ratePercent: percentage(commissionRate),
      sellerRate: optionalRate('sellerCommissionRate'),
      shopeeRate: optionalRate('shopeeCommissionRate'),
      appExistingUserRate: optionalRate('appExistRate'),
      appNewUserRate: optionalRate('appNewRate'),
      webExistingUserRate: optionalRate('webExistRate'),
      webNewUserRate: optionalRate('webNewRate'),
    },
    sales: rawSales,
    shopId: raw.shopId == null ? null : int64String(raw.shopId),
    shopName: typeof raw.shopName === 'string' ? raw.shopName.slice(0, 500) : null,
    categoryIds: categories.map(String),
    rating: typeof raw.ratingStar === 'string' ? raw.ratingStar.slice(0, 32) : null,
    shopTypes: Array.isArray(raw.shopType)
      && raw.shopType.every(value => Number.isSafeInteger(value) && value >= 0) ? [...raw.shopType] : [],
    offerPeriod: {
      startTime: Number.isSafeInteger(raw.periodStartTime) ? raw.periodStartTime : null,
      endTime: Number.isSafeInteger(raw.periodEndTime) ? raw.periodEndTime : null,
    },
  };
}

function readGraphqlResult(payload, request) {
  if (!object(payload)) fail('SHOPEE_AFFILIATE_RESPONSE_INVALID', request);
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const code = payload.errors[0]?.extensions?.code;
    fail('SHOPEE_AFFILIATE_REMOTE_ERROR', request,
      typeof code === 'string' || typeof code === 'number' ? String(code).slice(0, 80) : 'GRAPHQL_ERROR');
  }
  const products = payload.data?.productOfferV2;
  if (!object(products) || !Array.isArray(products.nodes) || !object(products.pageInfo)) {
    fail('SHOPEE_AFFILIATE_SCHEMA_INVALID', request);
  }
  const normalized = products.nodes.map(normalizeProduct);
  const { page, limit, hasNextPage } = products.pageInfo;
  if (!Number.isSafeInteger(limit) || limit < 1 || typeof hasNextPage !== 'boolean'
    || page != null && !Number.isSafeInteger(page)) {
    fail('SHOPEE_AFFILIATE_SCHEMA_INVALID', request);
  }
  const verifiedRequest = { ...request, schemaVerified: true, expectedResultVerified: true };
  return {
    market: MARKET,
    currency: null,
    currencyCandidate: CURRENCY_CANDIDATE,
    currencyVerified: false,
    currencySource: 'market-inference',
    products: normalized,
    pageInfo: {
      page: Number.isSafeInteger(page) ? page : null,
      limit,
      hasNextPage,
    },
    request: verifiedRequest,
    schemaVerified: true,
    expectedResultVerified: true,
  };
}

async function readBounded(response, maxBytes) {
  if (!response.body?.getReader) fail('SHOPEE_AFFILIATE_BODY_UNREADABLE');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('SHOPEE_AFFILIATE_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function timestampSeconds(now) {
  const value = now();
  const millis = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(millis) || millis < 0) fail('SHOPEE_AFFILIATE_CLOCK_INVALID');
  return String(Math.ceil(millis / 1000));
}

function signedHeaders(appId, appSecret, payload, timestamp) {
  const signature = createHash('sha256')
    .update(`${appId}${timestamp}${payload}${appSecret}`, 'utf8')
    .digest('hex');
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
  };
}

function buildSearchQuery(keyword, page, limit, sortType) {
  return `query { productOfferV2(listType: 0, keyword: ${graphqlString(keyword)}, sortType: ${sortType}, page: ${page}, limit: ${limit}) { nodes { ${PRODUCT_FIELDS} } pageInfo { ${PAGE_FIELDS} } } }`;
}

function buildItemQuery(id) {
  return `query { productOfferV2(itemId: ${id}, page: 1, limit: 1) { nodes { ${PRODUCT_FIELDS} } pageInfo { ${PAGE_FIELDS} } } }`;
}

export function createShopeeAffiliateClient({
  appId,
  appSecret,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  timeoutMs = 15_000,
} = {}) {
  if (!validCredential(appId, 128) || !validCredential(appSecret, 512)) {
    fail('SHOPEE_AFFILIATE_APP_CREDENTIALS_REQUIRED');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
    || maxResponseBytes > 16 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 120_000) {
    fail('SHOPEE_AFFILIATE_CONFIGURATION_INVALID');
  }

  async function readProducts(query, argumentNames) {
    const time = timestampSeconds(now);
    const body = JSON.stringify({ query });
    const startedAt = new Date(Number(time) * 1000).toISOString();
    const baseRequest = {
      method: 'POST',
      origin: ORIGIN,
      path: PATH,
      market: MARKET,
      checkedAt: startedAt,
      browserUsed: false,
      credentialsUsed: true,
      appCredentialsSent: true,
      userSessionSent: false,
      cookieSent: false,
      redirectsFollowed: false,
      graphqlOperation: 'productOfferV2',
      graphqlArgumentNames: argumentNames,
      requestBytes: Buffer.byteLength(body, 'utf8'),
      requestSha256: createHash('sha256').update(body).digest('hex'),
    };
    let response;
    try {
      response = await fetchImpl(`${ORIGIN}${PATH}`, {
        method: 'POST',
        headers: new Headers(signedHeaders(appId, appSecret, body, time)),
        body,
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail('SHOPEE_AFFILIATE_TRANSPORT_FAILED', {
        ...baseRequest,
        causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
      });
    }
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    const request = { ...baseRequest, httpStatus: response.status, mime };
    if ([301, 302, 303, 307, 308].includes(response.status) || response.redirected) {
      await response.body?.cancel().catch(() => {});
      fail('SHOPEE_AFFILIATE_REDIRECT_REJECTED', request);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      fail('SHOPEE_AFFILIATE_AUTH_REJECTED', request);
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      fail('SHOPEE_AFFILIATE_THROTTLED', request);
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      fail('SHOPEE_AFFILIATE_HTTP_ERROR', request);
    }
    if (!/^(?:application\/json|application\/[a-z0-9.+-]+\+json)$/i.test(mime ?? '')) {
      await response.body?.cancel().catch(() => {});
      fail('SHOPEE_AFFILIATE_MIME_INVALID', request);
    }
    let raw;
    try { raw = await readBounded(response, maxResponseBytes); }
    catch (error) {
      if (error instanceof ShopeeAffiliateError) {
        error.request = request;
        throw error;
      }
      fail('SHOPEE_AFFILIATE_BODY_UNREADABLE', request);
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { fail('SHOPEE_AFFILIATE_JSON_INVALID', { ...request, responseBytes: raw.byteLength }); }
    const finishedRequest = {
      ...request,
      responseBytes: raw.byteLength,
      responseSha256: createHash('sha256').update(raw).digest('hex'),
    };
    return readGraphqlResult(payload, finishedRequest);
  }

  return Object.freeze({
    market: MARKET,
    currency: null,
    currencyCandidate: CURRENCY_CANDIDATE,
    async searchProducts({ keyword, page, limit, sortType } = {}) {
      const normalizedKeyword = typeof keyword === 'string' ? keyword.trim() : keyword;
      const normalizedPage = integer(page, 1, 1, 1_000_000);
      const normalizedLimit = integer(limit, 20, 1, 20);
      const normalizedSort = integer(sortType, 1, 1, 5);
      if (normalizedPage == null || normalizedLimit == null || normalizedSort == null) {
        fail('SHOPEE_AFFILIATE_PAGINATION_INVALID');
      }
      const query = buildSearchQuery(normalizedKeyword, normalizedPage, normalizedLimit, normalizedSort);
      return readProducts(query, ['listType', 'keyword', 'sortType', 'page', 'limit']);
    },
    async getProductById({ itemId: rawId } = {}) {
      const id = itemId(rawId);
      if (!id) fail('SHOPEE_AFFILIATE_ITEM_ID_INVALID');
      const result = await readProducts(buildItemQuery(id), ['itemId', 'page', 'limit']);
      const matching = result.products.filter(product => product.itemId === id);
      if (result.products.length === 0) {
        fail('SHOPEE_AFFILIATE_PRODUCT_NOT_FOUND', {
          ...result.request, schemaVerified: true, expectedResultVerified: false,
        });
      }
      if (matching.length !== 1 || matching.length !== result.products.length) {
        fail('SHOPEE_AFFILIATE_ITEM_ID_MISMATCH', {
          ...result.request, schemaVerified: true, expectedResultVerified: false,
        });
      }
      return { ...result, products: matching };
    },
  });
}
