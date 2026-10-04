import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ScopedSession } from '../scoped-session.mjs';

const ORIGIN = 'https://affapi.banggood.com';
const DOCS = 'https://imgs3.banggood.com/affiliate/banggood-affiliate-apidoc-v1.2.2.pdf';
const SERVICE = 'banggood';
const MODULE_PATH = 'lib/commerce/banggood.mjs';
const MAX_PRODUCT_ROWS = 500;
const MAX_CATEGORY_NODES = 20_000;
const PRODUCT_ID = /^[0-9]{1,20}$/;
const CURRENCY = /^[A-Z]{3}$/;
const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class BanggoodApiError extends Error {
  constructor(code, diagnostic = null) {
    super(code);
    this.name = 'BanggoodApiError';
    this.code = code;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

function fail(code, diagnostic) {
  throw new BanggoodApiError(code, diagnostic);
}

function safeText(value, maximum, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || !value.trim() || /[\r\n\0]/.test(value)) fail(code);
  return value;
}

function checkedCurrency(value) {
  const currency = value ?? 'USD';
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) fail('BANGGOOD_CURRENCY_INVALID');
  return currency;
}

function checkedLang(value) {
  const lang = value ?? 'en-GB';
  if (typeof lang !== 'string' || !LANG.test(lang)) fail('BANGGOOD_LANGUAGE_INVALID');
  return lang;
}

function checkedId(value, code) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !PRODUCT_ID.test(id)) fail(code);
  return id;
}

function credentialString(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || /[\r\n\0]/.test(value) || !value.trim()) fail(`BANGGOOD_${field}_REQUIRED`);
  return value;
}

function signatureFor({ apiKey, apiSecret, noncestr, timestamp }) {
  // The official PDF example orders the signed key/value pairs lexicographically
  // by parameter name: api_key, api_secret, noncestr, timestamp.
  const base = [
    ['api_key', apiKey],
    ['api_secret', apiSecret],
    ['noncestr', noncestr],
    ['timestamp', timestamp],
  ].sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, value]) => `${name}=${value}`).join('&');
  return createHash('md5').update(base, 'utf8').digest('hex');
}

function createSession({ fetchImpl, headersByOrigin = {} }) {
  return new ScopedSession({
    allowedOrigins: [ORIGIN],
    cookieOrigins: [],
    headersByOrigin,
    ...(fetchImpl ? { fetchImpl } : {}),
    defaultHeaders: { accept: 'application/json' },
    timeoutMs: 20_000,
    maxResponseBytes: 8 * 1024 * 1024,
    maxRequestBytes: 16 * 1024,
    maxRedirects: 0,
  });
}

function mimeOf(response) {
  return response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() ?? null;
}

function requestDiagnostic(path, response, checkedAt) {
  return {
    method: 'GET', origin: ORIGIN, path,
    httpStatus: response.status,
    mime: mimeOf(response),
    responseBytes: Buffer.byteLength(response.raw, 'utf8'),
    checkedAt,
    browserUsed: false,
    credentialsUsed: true,
  };
}

function parseJson(response, path, checkedAt) {
  const diagnostic = requestDiagnostic(path, response, checkedAt);
  if (response.status !== 200 || diagnostic.mime !== 'application/json') {
    fail(`BANGGOOD_HTTP_${response.status}`, diagnostic);
  }
  let payload;
  try { payload = JSON.parse(response.raw); } catch { fail('BANGGOOD_JSON_INVALID', diagnostic); }
  if (!object(payload) || payload.code !== 200) fail('BANGGOOD_API_REJECTED', diagnostic);
  return { payload, diagnostic };
}

function decimalAmount(value, currency) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    return null;
  }
  if (!text || text.length > 80) return null;

  let indicatedCurrency = null;
  const prefix = /^(USD|EUR|GBP|AUD|CAD|NZD|JPY|CNY|HKD|KRW|SGD|CHF|INR|US\$|[$€£¥])\s*/i.exec(text);
  if (prefix) {
    const raw = prefix[1].toUpperCase();
    indicatedCurrency = raw === 'US$' || raw === '$' ? 'USD'
      : raw === '€' ? 'EUR' : raw === '£' ? 'GBP' : raw === '¥' ? null : raw;
    if (indicatedCurrency === null || indicatedCurrency !== currency) return null;
    text = text.slice(prefix[0].length);
  }
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  return text.replaceAll(',', '');
}

function amount(value, currency, field) {
  const parsed = decimalAmount(value, currency);
  if (parsed === null) fail('BANGGOOD_PRICE_SCHEMA_INVALID', { field });
  return { amount: parsed, currency, unit: 'decimal' };
}

function rawOptionalScalar(source, key) {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (value === null || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value)) return value;
  fail('BANGGOOD_SALE_METADATA_SCHEMA_INVALID');
}

function safeBanggoodProductUrl(value, productId) {
  if (typeof value !== 'string' || value.length > 4096) fail('BANGGOOD_PRODUCT_SCHEMA_INVALID');
  let url;
  try { url = new URL(value); } catch { fail('BANGGOOD_PRODUCT_SCHEMA_INVALID'); }
  if (url.origin !== 'https://www.banggood.com' || url.username || url.password
    || url.hash || !url.pathname.endsWith(`-p-${productId}.html`)) {
    fail('BANGGOOD_PRODUCT_SCHEMA_INVALID');
  }
  // The documented sample URL carries an attribution query value. It is not
  // needed to identify the product and is removed from returned public data.
  return `https://www.banggood.com${url.pathname}`;
}

function productRow(row, currency) {
  if (!object(row)) fail('BANGGOOD_PRODUCT_SCHEMA_INVALID');
  const productId = checkedId(row.product_id, 'BANGGOOD_PRODUCT_SCHEMA_INVALID');
  const categoryId = checkedId(row.category_id, 'BANGGOOD_PRODUCT_SCHEMA_INVALID');
  const productName = safeText(row.product_name, 1000, 'BANGGOOD_PRODUCT_SCHEMA_INVALID');
  const images = {};
  for (const field of ['small_image', 'list_grid_image', 'view_image']) {
    const value = row[field];
    if (value == null || value === '') { images[field] = null; continue; }
    if (typeof value !== 'string' || value.length > 4096) fail('BANGGOOD_PRODUCT_SCHEMA_INVALID');
    let url;
    try { url = new URL(value); } catch { fail('BANGGOOD_PRODUCT_SCHEMA_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('BANGGOOD_PRODUCT_SCHEMA_INVALID');
    images[field] = url.href;
  }
  const out = {
    productId,
    categoryId,
    name: productName,
    productUrl: safeBanggoodProductUrl(row.product_url, productId),
    price: amount(row.product_price, currency, 'product_price'),
    images,
    modifiedAt: typeof row.modify_date === 'string' && row.modify_date.length <= 64 ? row.modify_date : null,
  };
  for (const [field, output] of [
    ['product_coupon_price', 'couponPrice'],
    ['commission', 'commission'],
  ]) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      out[output] = amount(row[field], currency, field);
    }
  }
  if (typeof row.coupon_name === 'string' && row.coupon_name.length <= 256) out.couponName = row.coupon_name;
  if (typeof row.coupon_code === 'string' && row.coupon_code.length <= 256) out.couponCode = row.coupon_code;
  return out;
}

function categoryTree(value) {
  const visited = { count: 0 };
  function walk(node, depth) {
    if (!object(node) || depth > 24 || ++visited.count > MAX_CATEGORY_NODES) fail('BANGGOOD_CATEGORY_SCHEMA_INVALID');
    const children = node.children == null ? [] : node.children;
    if (!Array.isArray(children)) fail('BANGGOOD_CATEGORY_SCHEMA_INVALID');
    return {
      categoryId: checkedId(node.category_id, 'BANGGOOD_CATEGORY_SCHEMA_INVALID'),
      name: safeText(node.category_name, 500, 'BANGGOOD_CATEGORY_SCHEMA_INVALID'),
      children: children.map(child => walk(child, depth + 1)),
    };
  }
  const roots = Array.isArray(value) ? value : object(value) ? [value] : null;
  if (!roots || roots.length > MAX_CATEGORY_NODES) fail('BANGGOOD_CATEGORY_SCHEMA_INVALID');
  return roots.map(node => walk(node, 0));
}

function detailProduct(value, productId) {
  if (!object(value) || checkedId(value.product_id, 'BANGGOOD_PRODUCT_SCHEMA_INVALID') !== productId) {
    fail('BANGGOOD_PRODUCT_ID_MISMATCH');
  }
  const categoryId = checkedId(value.category_id, 'BANGGOOD_PRODUCT_SCHEMA_INVALID');
  const name = safeText(value.product_name, 1000, 'BANGGOOD_PRODUCT_SCHEMA_INVALID');
  if (!Array.isArray(value.warehouse_list) || value.warehouse_list.length > 128) fail('BANGGOOD_WAREHOUSE_SCHEMA_INVALID');
  const seen = new Set();
  const warehouses = value.warehouse_list.map(row => {
    if (!object(row) || typeof row.warehouse !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(row.warehouse)) {
      fail('BANGGOOD_WAREHOUSE_SCHEMA_INVALID');
    }
    const warehouse = row.warehouse.toUpperCase();
    if (seen.has(warehouse)) fail('BANGGOOD_WAREHOUSE_SCHEMA_INVALID');
    seen.add(warehouse);
    const item = { warehouse };
    for (const field of ['warehouse_price', 'market_price']) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        item[field === 'warehouse_price' ? 'warehousePrice' : 'marketPrice'] = amount(row[field], 'USD', field);
      }
    }
    if (!item.warehousePrice) fail('BANGGOOD_WAREHOUSE_SCHEMA_INVALID');
    const salePrice = rawOptionalScalar(row, 'sale_price');
    if (salePrice !== undefined) item.salePrice = salePrice;
    const saleStart = rawOptionalScalar(row, 'sale_date_start');
    const saleEnd = rawOptionalScalar(row, 'sale_date_end');
    if (saleStart !== undefined || saleEnd !== undefined) {
      item.saleWindow = {
        startRaw: saleStart ?? null,
        endRaw: saleEnd ?? null,
        documentedSampleFormat: 'YYYY-MM-DD HH:mm:ss',
        timezone: null,
        activeAtRead: null,
      };
    }
    return item;
  });
  return {
    productId,
    categoryId,
    name,
    productUrl: safeBanggoodProductUrl(value.product_url, productId),
    warehouses,
    images: {
      small: safeImage(value.small_image),
      listGrid: safeImage(value.list_grid_image),
      view: safeImage(value.view_image),
    },
    modifiedAt: typeof value.modify_date === 'string' && value.modify_date.length <= 64 ? value.modify_date : null,
  };
}

function safeImage(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096) fail('BANGGOOD_PRODUCT_SCHEMA_INVALID');
  let url;
  try { url = new URL(value); } catch { fail('BANGGOOD_PRODUCT_SCHEMA_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('BANGGOOD_PRODUCT_SCHEMA_INVALID');
  return url.href;
}

function moduleDigest() {
  return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
}

/**
 * Read-only Banggood affiliate product API.
 * Credentials are supplied by the caller and used only in memory. The API
 * secret is included only in the local MD5 input used to acquire a short-lived
 * access token; it is never sent to Banggood or included in result receipts.
 */
export function createBanggoodClient({ apiKey, apiSecret, fetchImpl, now = Date.now, nonceFactory } = {}) {
  if (typeof now !== 'function' || nonceFactory !== undefined && typeof nonceFactory !== 'function') {
    fail('BANGGOOD_OPTIONS_INVALID');
  }
  const memoryCredentials = {
    apiKey: credentialString(apiKey, 'API_KEY'),
    apiSecret: credentialString(apiSecret, 'API_SECRET'),
  };
  let tokenState = null;
  let tokenPromise = null;

  function currentTime() {
    const value = now();
    if (!Number.isFinite(value) || value < 0) fail('BANGGOOD_CLOCK_INVALID');
    return value;
  }

  async function acquireToken() {
    if (tokenState && currentTime() < tokenState.refreshAt) return tokenState;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      const timestamp = String(Math.floor(currentTime() / 1000));
      const noncestr = nonceFactory ? nonceFactory() : randomBytes(16).toString('hex');
      if (typeof noncestr !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(noncestr)) {
        fail('BANGGOOD_NONCE_INVALID');
      }
      const signature = signatureFor({ ...memoryCredentials, noncestr, timestamp });
      const url = new URL('/getAccessToken', ORIGIN);
      url.search = new URLSearchParams({ api_key: memoryCredentials.apiKey, noncestr, timestamp, signature }).toString();
      let response;
      try { response = await createSession({ fetchImpl }).request(url.href); }
      catch (error) {
        if (error?.code === 'SCOPED_SESSION_TIMEOUT') fail('BANGGOOD_TOKEN_TIMEOUT');
        if (error?.code === 'SCOPED_SESSION_REDIRECT_LIMIT') fail('BANGGOOD_TOKEN_REDIRECTED');
        if (error?.code === 'SCOPED_SESSION_RESPONSE_TOO_LARGE') fail('BANGGOOD_RESPONSE_TOO_LARGE');
        fail('BANGGOOD_TOKEN_TRANSPORT_FAILED');
      }
      const checkedAt = new Date(currentTime()).toISOString();
      const { payload, diagnostic } = parseJson(response, '/getAccessToken', checkedAt);
      const token = payload.result?.access_token;
      const expiresIn = payload.result?.expires_in;
      if (typeof token !== 'string' || token.length < 1 || token.length > 4096 || /[\r\n\0]/.test(token)
        || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 7200) {
        fail('BANGGOOD_TOKEN_SCHEMA_INVALID', diagnostic);
      }
      tokenState = {
        accessToken: token,
        refreshAt: currentTime() + Math.max(0, expiresIn - 30) * 1000,
        acquisition: diagnostic,
      };
      return tokenState;
    })();
    try { return await tokenPromise; } finally { tokenPromise = null; }
  }

  async function getJson(path, params, { retryUnauthorized = true } = {}) {
    let state = await acquireToken();
    const url = new URL(path, ORIGIN);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    async function requestWithToken(token) {
      const session = createSession({ fetchImpl, headersByOrigin: { [ORIGIN]: { 'access-token': token } } });
      try { return await session.request(url.href); }
      catch (error) {
        if (error?.code === 'SCOPED_SESSION_TIMEOUT') fail('BANGGOOD_READ_TIMEOUT');
        if (error?.code === 'SCOPED_SESSION_REDIRECT_LIMIT') fail('BANGGOOD_READ_REDIRECTED');
        if (error?.code === 'SCOPED_SESSION_RESPONSE_TOO_LARGE') fail('BANGGOOD_RESPONSE_TOO_LARGE');
        fail('BANGGOOD_READ_TRANSPORT_FAILED');
      }
    }
    let response = await requestWithToken(state.accessToken);
    if (response.status === 401 && retryUnauthorized) {
      tokenState = null;
      state = await acquireToken();
      response = await requestWithToken(state.accessToken);
    }
    const checkedAt = new Date(currentTime()).toISOString();
    const parsed = parseJson(response, path, checkedAt);
    return { ...parsed, tokenAcquisition: state.acquisition };
  }

  function receipt(capabilityId, diagnostic, tokenAcquisition, result) {
    return {
      schema: 'web-api-credentialed-read-receipt-v1',
      service: SERVICE,
      capabilityId,
      checkedAt: diagnostic.checkedAt,
      secretsPersistedInEvidence: false,
      authenticated: true,
      credentialsUsed: true,
      credentialBindingVerified: true,
      schemaVerified: true,
      expectedResultVerified: true,
      contractProvenance: { kind: 'first_party_documented_api', sourceURL: DOCS },
      request: diagnostic,
      result,
      credentialBinding: {
        source: 'process-memory',
        serviceMatched: true,
        originMatched: true,
        persisted: false,
      },
      credentialAcquisition: tokenAcquisition,
      implementation: { module: moduleDigest() },
    };
  }

  return Object.freeze({
    async listProducts({ keyword, categoryId, currency = 'USD', lang = 'en-GB' } = {}) {
      const queryCurrency = checkedCurrency(currency);
      const queryLang = checkedLang(lang);
      const params = { currency: queryCurrency, lang: queryLang };
      if (keyword !== undefined) {
        if (typeof keyword !== 'string' || keyword.length > 200 || /[\r\n\0]/.test(keyword)) fail('BANGGOOD_KEYWORD_INVALID');
        params.keyword = keyword;
      }
      if (categoryId !== undefined) params.category_id = checkedId(categoryId, 'BANGGOOD_CATEGORY_ID_INVALID');
      const result = await getJson('/product/list', params);
      const body = result.payload.result;
      if (!object(body) || !Array.isArray(body.product_list) || body.product_list.length > MAX_PRODUCT_ROWS
        || !Number.isInteger(body.page_total) || body.page_total < 0 || body.page_total > 1_000_000) {
        fail('BANGGOOD_PRODUCT_LIST_SCHEMA_INVALID', result.diagnostic);
      }
      const products = body.product_list.map(row => productRow(row, queryCurrency));
      const ids = new Set();
      for (const product of products) {
        if (ids.has(product.productId)) fail('BANGGOOD_PRODUCT_LIST_SCHEMA_INVALID', result.diagnostic);
        ids.add(product.productId);
      }
      return {
        currency: queryCurrency,
        language: queryLang,
        pageTotal: body.page_total,
        pagination: { pageParameterDocumented: false, continuationAvailable: false },
        products,
        receipt: receipt('catalog.product_search', result.diagnostic, result.tokenAcquisition, {
          productCount: products.length,
          pageTotal: body.page_total,
          requestedCurrency: queryCurrency,
          returnedProductIdsVerified: true,
          affiliateQueryValuesRemoved: true,
        }),
      };
    },

    async getProduct({ productId, currency = 'USD', lang = 'en-GB' } = {}) {
      const id = checkedId(productId, 'BANGGOOD_PRODUCT_ID_INVALID');
      const queryCurrency = checkedCurrency(currency);
      const queryLang = checkedLang(lang);
      const result = await getJson('/product/detail', { product_id: id, currency: queryCurrency, lang: queryLang });
      const product = detailProduct(result.payload.result, id);
      return {
        ...product,
        requestedCurrency: queryCurrency,
        warehousePriceCurrency: 'USD',
        receipt: receipt('catalog.product_detail', result.diagnostic, result.tokenAcquisition, {
          productIdMatched: true,
          warehouseCount: product.warehouses.length,
          warehousePricesUseUsdDecimalAmounts: true,
          salePriceValueCount: product.warehouses.filter(row => Object.hasOwn(row, 'salePrice')).length,
          saleWindowCount: product.warehouses.filter(row => Object.hasOwn(row, 'saleWindow')).length,
          saleTimingInterpretation: 'not_inferred',
          affiliateQueryValuesRemoved: true,
        }),
      };
    },

    async listCategories({ categoryId, lang = 'en-GB' } = {}) {
      const queryLang = checkedLang(lang);
      const params = { lang: queryLang };
      if (categoryId !== undefined) params.category_id = checkedId(categoryId, 'BANGGOOD_CATEGORY_ID_INVALID');
      const result = await getJson('/product/category', params);
      const categories = categoryTree(result.payload.result);
      return {
        language: queryLang,
        categories,
        receipt: receipt('catalog.categories', result.diagnostic, result.tokenAcquisition, {
          categoryRootCount: categories.length,
          categoryTreeVerified: true,
        }),
      };
    },
  });
}

export const banggoodContract = Object.freeze({
  origin: ORIGIN,
  docs: DOCS,
  auth: 'GET /getAccessToken with api_key, noncestr, timestamp, signature=lowercase-hex-MD5; API key/secret supplied in process memory; API reads use access-token header; expires_in <= 7200 seconds.',
  operations: Object.freeze({
    listProducts: 'GET /product/list; documented filters: keyword, category_id, currency, lang. Pagination request parameter is undocumented and is not sent.',
    getProduct: 'GET /product/detail?product_id=... with optional currency/lang; warehouse_price and market_price are USD decimal amounts.',
    listCategories: 'GET /product/category with optional category_id/lang.',
  }),
});
