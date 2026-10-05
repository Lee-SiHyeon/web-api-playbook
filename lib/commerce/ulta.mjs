import { createHash } from 'node:crypto';

const ORIGIN = 'https://www.ulta.com';
const SEARCH_PATH = '/search';
const API_PATH = '/dxl/graphql';
const SOURCE_URL = 'https://www.ulta.com/search';
const PRODUCT_SOURCE_URL = 'https://www.ulta.com/p';
const ULTA_CLIENT_BUNDLE_URL = 'https://www.ulta.com/ux/assets/js/client.fa640546.js';
const ULTA_CLIENT_BUNDLE_SHA256 = '4f8fb445dbf097260ce1a08e3e4872422742130e75860d49c5f4a399d848b506';
const POWERREVIEWS_ORIGIN = 'https://display.powerreviews.com';
const POWERREVIEWS_ENGINE_URL = 'https://ui.powerreviews.com/tag-builds/10578/4.0/reviews.engine.js';
const POWERREVIEWS_ENGINE_SHA256 = 'c5962864e32a3b9eb466c968d870d0f112631d37e82c57d0d0741625628ee9f3';
const PAGE_QUERY = 'query Page($url: JSON, $stagingHost: String, $contentId:String, $previewOptions: JSON, $moduleParams: JSON) { Page(url:$url, stagingHost:$stagingHost, contentId:$contentId, previewOptions:$previewOptions, moduleParams:$moduleParams) { content customResponseAttributes meta } }';
const MAX_QUERY_LENGTH = 120;
const MAX_PAGE = 10;
const MAX_PAGE_SIZE = 100;
const MAX_REVIEW_PAGE = 100;
const MAX_REVIEW_PAGE_SIZE = 25;
const PAGE_CONTEXT_TTL_MS = 5 * 60_000;
const PAGE_CONTEXT_CACHE_MAX = 24;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const PRICE_RE = /^\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2})(?:\s+-\s+\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2}))?$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const IMAGE_ORIGINS = new Set(['https://media.ulta.com', 'https://media.ultainc.com']);
const REVIEW_IMAGE_ORIGINS = new Set(['https://res.cloudinary.com', 'https://media.powerreviews.com']);

export class UltaPublicError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'UltaPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new UltaPublicError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, max = 2_000) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeInt = value => Number.isSafeInteger(value) && value >= 0;

function readAssignedString(html, name) {
  const marker = `window.${name} = `;
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return null;
  let at = markerAt + marker.length;
  while (/\s/.test(html[at] ?? '')) at++;
  const quote = html[at];
  if (quote !== '"' && quote !== "'") return null;
  at++;
  let value = '';
  for (; at < html.length; at++) {
    const char = html[at];
    if (char === quote) return value;
    if (char !== '\\') {
      if (char === '\n' || char === '\r') return null;
      value += char;
      continue;
    }
    const next = html[++at];
    if (next === undefined) return null;
    if (next === 'u') {
      const hex = html.slice(at + 1, at + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      at += 4;
    } else if (next === '/' || next === '\\' || next === quote) value += next;
    else return null;
  }
  return null;
}

function readAssignedJson(html, name) {
  const marker = `window.${name} = `;
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) return null;
  let start = markerAt + marker.length;
  while (/\s/.test(html[start] ?? '')) start++;
  if (html[start] !== '{' && html[start] !== '[') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < html.length; at++) {
    const char = html[at];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, at + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

async function readBody(response, maxBytes, code, receipt) {
  if (!response.body?.getReader) fail(code, receipt);
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
        fail('ULTA_RESPONSE_TOO_LARGE', { ...receipt, responseBytes: bytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function checkedUrl(value, path, query, code) {
  let url;
  try { url = new URL(value, ORIGIN); }
  catch { fail(code); }
  if (url.origin !== ORIGIN || url.pathname !== path || url.username || url.password || url.hash) {
    fail(code);
  }
  if (query) {
    for (const [name, expected] of Object.entries(query)) {
      if (url.searchParams.get(name) !== expected) fail(code);
    }
  }
  return url;
}

async function getBounded({ url, origin = ORIGIN, headers, fetchImpl, now, maxBytes, expectedMime, requestPath, queryFields }) {
  let requestUrl;
  try { requestUrl = new URL(url); }
  catch { fail('ULTA_REQUEST_URL_INVALID'); }
  if (typeof origin !== 'string' || !/^https:\/\/[^/]+$/.test(origin) || requestUrl.origin !== origin ||
      requestUrl.username || requestUrl.password || requestUrl.hash) fail('ULTA_REQUEST_ORIGIN_INVALID');
  const checkedAt = new Date(now()).toISOString();
  const baseReceipt = {
    method: 'GET', origin, path: requestPath, checkedAt,
    browserUsed: false, anonymous: true, credentialsUsed: false,
    cookieSent: false, authorizationSent: false, queryFields,
  };
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: 'GET', headers: new Headers(headers), redirect: 'manual', credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    fail('ULTA_TRANSPORT_FAILED', {
      ...baseReceipt, causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    });
  }
  const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
  const receipt = { ...baseReceipt, httpStatus: response.status, mime };
  if (REDIRECTS.has(response.status) || response.redirected) {
    await response.body?.cancel().catch(() => {});
    fail('ULTA_REDIRECT_REJECTED', { ...receipt, redirectFollowed: false });
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    fail('ULTA_AUTH_REJECTED', receipt);
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    fail('ULTA_THROTTLED', receipt);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    fail('ULTA_HTTP_ERROR', receipt);
  }
  if (mime !== expectedMime) {
    await response.body?.cancel().catch(() => {});
    fail('ULTA_MIME_INVALID', receipt);
  }
  const raw = await readBody(response, maxBytes, 'ULTA_BODY_UNREADABLE', receipt);
  return {
    raw,
    receipt: {
      ...receipt, responseBytes: raw.byteLength,
      responseSha256: createHash('sha256').update(raw).digest('hex'),
    },
  };
}

function findListingModule(state) {
  const root = state?.ROOT_QUERY;
  if (!object(root)) return null;
  let count = 0;
  const seen = new Set();
  const walk = (value, depth = 0) => {
    if (!object(value) && !Array.isArray(value)) return null;
    if (seen.has(value) || depth > 64 || ++count > 100_000) return null;
    seen.add(value);
    if (object(value) && value.moduleName === 'ProductListingResults' &&
        object(value.meta?.initAction) && typeof value.meta.initAction.graphql === 'string') return value;
    for (const child of Object.values(value)) {
      const result = walk(child, depth + 1);
      if (result) return result;
    }
    return null;
  };
  for (const [key, page] of Object.entries(root)) {
    if (!key.startsWith('Page(')) continue;
    const result = walk(page?.content);
    if (result) return result;
    seen.clear();
    count = 0;
  }
  return null;
}

function extractGraphqlInputs(action, pageUrl, expectedPage) {
  const query = action.graphql;
  const id = query.match(/\bcontentId\s*:\s*"([0-9a-f]{8}-[0-9a-f-]{27,})"/i)?.[1];
  const pathString = query.match(/\burl\s*:\s*\{\s*path\s*:\s*("(?:\\.|[^"\\])*")\s*\}/)?.[1];
  let embeddedUrl;
  try { embeddedUrl = pathString ? JSON.parse(pathString) : null; }
  catch { embeddedUrl = null; }
  const expected = new URL(pageUrl);
  let actual;
  try { actual = new URL(embeddedUrl); }
  catch { actual = null; }
  if (!id || !/^query\s+NonCachedPage\s*\(/.test(query) || action.method !== 'GET' ||
      !Array.isArray(action.params) ||
      !['gti', 'loginStatus', 'retailerVisitorId', 'breakpoint'].every(name => action.params.includes(name)) ||
      !Array.isArray(action.customHeaders) || !actual || actual.origin !== ORIGIN ||
      actual.pathname !== SEARCH_PATH || actual.searchParams.get('search') !== expected.searchParams.get('search') ||
      Number(actual.searchParams.get('page') ?? 1) !== expectedPage || actual.href !== expected.href) {
    fail('ULTA_BOOTSTRAP_CONTRACT_INVALID');
  }
  const headers = Object.fromEntries(action.customHeaders.map(item => [String(item?.key ?? '').toLowerCase(), item?.value]));
  if (headers['x-ulta-graph-type'] !== 'query' ||
      headers['x-ulta-graph-sub-type'] !== 'noncachedpage' ||
      headers['x-ulta-graph-module-name'] !== 'ProductListingResults') {
    fail('ULTA_BOOTSTRAP_CONTRACT_INVALID');
  }
  return { query, contentId: id };
}

function parsePrice(value, kind) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match = PRICE_RE.exec(value.trim());
  if (!match) return null;
  const amount = (whole, fraction) => {
    const integer = Number(whole.replaceAll(',', ''));
    return Number.isSafeInteger(integer) ? `${integer}.${fraction}` : null;
  };
  const min = amount(match[1], match[2]);
  const max = match[3] === undefined ? min : amount(match[3], match[4]);
  if (min === null || max === null || Number(min) > Number(max)) return null;
  return { minAmount: min, maxAmount: max, currency: 'USD', kind };
}

function normalizeProduct(item) {
  if (!object(item) || !/^(?:[a-z]{1,12})?\d{3,16}$/i.test(item.productId ?? '') ||
      !/^\d{3,16}$/.test(item.skuId ?? '') || !safeText(item.brandName, 160) ||
      !safeText(item.productName, 500) ||
      !(item.listPrice === null || safeText(item.listPrice, 80)) ||
      !(item.salePrice === null || safeText(item.salePrice, 80)) || !object(item.action) ||
      !safeText(item.action.url, 2_000)) return null;
  let target;
  try { target = new URL(item.action.url, ORIGIN); }
  catch { return null; }
  if (target.origin !== ORIGIN || !/^\/p\//.test(target.pathname) ||
      !target.pathname.toLowerCase().endsWith(`-${item.productId.toLowerCase()}`)) return null;
  const sku = target.searchParams.get('sku');
  if (sku !== null && sku !== item.skuId) return null;
  const canonicalUrl = `${ORIGIN}${target.pathname}${sku === null ? '' : `?sku=${encodeURIComponent(sku)}`}`;
  const listPrice = parsePrice(item.listPrice, 'retail_list');
  const salePrice = parsePrice(item.salePrice, 'retail_sale');
  const currentPrice = salePrice ?? listPrice;
  const fixedPrice = currentPrice && currentPrice.minAmount === currentPrice.maxAmount
    ? { amount: currentPrice.minAmount, currency: currentPrice.currency, kind: currentPrice.kind }
    : null;
  const priceRange = currentPrice && currentPrice.minAmount !== currentPrice.maxAmount
    ? {
      min: { amount: currentPrice.minAmount, currency: currentPrice.currency },
      max: { amount: currentPrice.maxAmount, currency: currentPrice.currency },
      kind: currentPrice.kind,
    }
    : null;
  return {
    productId: item.productId,
    skuId: item.skuId,
    variantId: item.skuId,
    brandName: item.brandName,
    productName: item.productName,
    title: item.productName,
    productUrl: canonicalUrl,
    url: canonicalUrl,
    listPriceText: item.listPrice,
    listPrice,
    salePriceText: item.salePrice,
    salePrice,
    currentPrice,
    price: fixedPrice,
    ...(priceRange ? { priceRange } : {}),
    currency: currentPrice ? 'USD' : null,
    rating: typeof item.rating === 'number' && Number.isFinite(item.rating) && item.rating >= 0 && item.rating <= 5
      ? item.rating : null,
    reviewCount: nonnegativeInt(item.reviewCount) ? item.reviewCount : null,
    sponsored: typeof item.sponsored === 'boolean' ? item.sponsored : null,
  };
}

function parseBootstrap(html, pageUrl, page) {
  const state = readAssignedJson(html, '__APOLLO_STATE__');
  const module = state ? findListingModule(state) : null;
  const action = module?.meta?.initAction;
  const inputs = action ? extractGraphqlInputs(action, pageUrl, page) : null;
  const locale = readAssignedString(html, '__APP_LOCALE__');
  const domain = readAssignedString(html, '__GRAPHQL_DOMAIN__');
  const getUri = readAssignedString(html, '__GRAPHQL_GET_URI__');
  const siteHeaders = readAssignedJson(html, '__REQUEST_HEADERS__');
  if (!inputs || locale !== 'en-US' || domain !== ORIGIN || !safeText(getUri, 500) ||
      !object(siteHeaders) || !/^[A-Za-z0-9_-]{1,32}$/.test(siteHeaders.X_ULTA_SITE ?? '')) {
    fail('ULTA_BOOTSTRAP_CONTRACT_INVALID');
  }
  const graphqlBase = new URL(getUri, domain);
  if (graphqlBase.origin !== ORIGIN || graphqlBase.pathname !== API_PATH ||
      !graphqlBase.searchParams.has('ultasite') || !graphqlBase.searchParams.has('user-agent') ||
      [...graphqlBase.searchParams.keys()].some(key => !['ultasite', 'user-agent'].includes(key))) {
    fail('ULTA_BOOTSTRAP_CONTRACT_INVALID');
  }
  const apiUrl = new URL(graphqlBase);
  apiUrl.searchParams.set('operationName', 'NonCachedPage');
  apiUrl.searchParams.set('query', inputs.query);
  return {
    apiUrl,
    contentId: inputs.contentId,
    locale,
    site: siteHeaders.X_ULTA_SITE,
    moduleName: module.moduleName,
  };
}

function validateNextUrl(value, currentUrl, query, nextPage) {
  const next = checkedUrl(value, SEARCH_PATH, { search: query }, 'ULTA_PAGINATION_CONTRACT_INVALID');
  const keys = [...next.searchParams.keys()];
  if (keys.some(key => !['search', 'page'].includes(key)) ||
      Number(next.searchParams.get('page')) !== nextPage ||
      next.origin !== currentUrl.origin) fail('ULTA_PAGINATION_CONTRACT_INVALID');
  return next;
}

function normalizePayload(payload, query, page, pageSize) {
  const content = payload?.data?.Page?.content;
  if (!object(payload) || (Array.isArray(payload.errors) && payload.errors.length > 0) ||
      !object(content) || content.moduleName !== 'ProductListingResults' ||
      content.page !== page || !positiveInt(content.pageSize) || !nonnegativeInt(content.resultCount) ||
      !Array.isArray(content.items) || content.items.length > 200) {
    fail('ULTA_SEARCH_SCHEMA_INVALID');
  }
  const products = content.items.map(normalizeProduct);
  const invalidItemIndexes = products.flatMap((product, index) => product === null ? [index] : []);
  if (invalidItemIndexes.length) fail('ULTA_SEARCH_SCHEMA_INVALID', {
    responseItemCount: content.items.length,
    invalidItemIndexes: invalidItemIndexes.slice(0, 20),
  });
  return {
    content,
    result: {
      query,
      page,
      pageSize: content.pageSize,
      requestedPageSize: pageSize,
      resultCount: content.resultCount,
      pageCount: content.resultCount === 0 ? 0 : Math.ceil(content.resultCount / content.pageSize),
      market: 'US',
      currency: 'USD',
      sourceItemCount: products.length,
      products: products.slice(0, pageSize),
      hasNextPage: typeof content.loadMoreUrl === 'string' && content.loadMoreUrl.length > 0,
    },
  };
}

function makePublicReceipt(apiRequest, bootstrapRequests, queryMatched, expectedResultVerified) {
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'ulta',
    capabilityId: 'catalog.search',
    checkedAt: apiRequest.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified,
    contractProvenance: { kind: 'browser_xhr_observed', sourceURL: SOURCE_URL },
    request: apiRequest,
    queryMatched,
    bootstrapRequests,
  };
}

function validProductId(value) {
  return typeof value === 'string' && /^(?:[a-z]{1,12})?\d{3,16}$/i.test(value);
}

function validSkuId(value) {
  return typeof value === 'string' && /^\d{3,16}$/.test(value);
}

function canonicalProductPage(productId, skuId, productUrl) {
  if (!validProductId(productId) || (skuId !== undefined && !validSkuId(skuId)) ||
      !safeText(productUrl, 2_000)) fail('ULTA_PRODUCT_INPUT_INVALID');
  let url;
  try { url = new URL(productUrl); }
  catch { fail('ULTA_PRODUCT_URL_INVALID'); }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || !url.pathname.startsWith('/p/') ||
      !url.pathname.toLowerCase().endsWith(`-${productId.toLowerCase()}`)) fail('ULTA_PRODUCT_URL_INVALID');
  const skus = url.searchParams.getAll('sku');
  if (skus.length > 1) fail('ULTA_PRODUCT_URL_INVALID');
  const urlSku = skus[0];
  if (urlSku !== undefined && !validSkuId(urlSku)) fail('ULTA_PRODUCT_URL_INVALID');
  if (skuId !== undefined && urlSku !== undefined && skuId !== urlSku) fail('ULTA_PRODUCT_BINDING_MISMATCH');
  const selectedSkuId = skuId ?? urlSku;
  url.search = '';
  if (selectedSkuId) url.searchParams.set('sku', selectedSkuId);
  return { url, pathname: url.pathname, productId, skuId: selectedSkuId };
}

function parsePageCacheKey(root, pathname, skuId) {
  if (!object(root)) return null;
  for (const [key, page] of Object.entries(root)) {
    if (!key.startsWith('Page(') || !key.endsWith(')')) continue;
    let args;
    try { args = JSON.parse(key.slice(5, -1)); }
    catch { continue; }
    if (!object(args) || args.url?.path !== pathname || !object(page?.content)) continue;
    const cachedSku = args.moduleParams?.sku;
    if (skuId !== undefined && cachedSku !== skuId) fail('ULTA_PRODUCT_BOOTSTRAP_BINDING_MISMATCH');
    if (cachedSku !== undefined && !validSkuId(cachedSku)) fail('ULTA_PRODUCT_BOOTSTRAP_INVALID');
    return { content: page.content, skuId: skuId ?? cachedSku };
  }
  return null;
}

function allModules(value, expectedName, out = [], seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 64 || seen.size > 100_000) return out;
  seen.add(value);
  if (value.moduleName === expectedName) out.push(value);
  for (const child of Object.values(value)) allModules(child, expectedName, out, seen, depth + 1);
  return out;
}

function safeUltaImageUrl(value) {
  if (!safeText(value, 2_000)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !IMAGE_ORIGINS.has(url.origin) || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function safeReviewImageUrl(value) {
  if (!safeText(value, 2_000)) return null;
  try {
    const url = new URL(value, POWERREVIEWS_ORIGIN);
    if (url.protocol !== 'https:' || !REVIEW_IMAGE_ORIGINS.has(url.origin) || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function moneyForPrice(textValue, kind, currency) {
  if (currency !== 'USD') return { text: textValue ?? null, amount: null, range: null };
  const parsed = parsePrice(textValue, kind);
  if (!parsed) return { text: textValue ?? null, amount: null, range: null };
  if (parsed.minAmount === parsed.maxAmount) {
    return {
      text: textValue,
      amount: { amount: parsed.minAmount, currency, kind },
      range: null,
    };
  }
  return {
    text: textValue,
    amount: null,
    range: {
      min: { amount: parsed.minAmount, currency },
      max: { amount: parsed.maxAmount, currency },
      kind,
    },
  };
}

function normalizeGalleryItem(item) {
  if (!object(item)) return null;
  const imageUrl = safeUltaImageUrl(item.imageUrl);
  if (!imageUrl) return null;
  const meta = object(item.metaData) ? item.metaData : {};
  return {
    imageUrl,
    name: safeText(item.name, 240) ? item.name : null,
    altText: safeText(item.altText, 800) ? item.altText : null,
    mediaType: safeText(meta.mediaType, 80) ? meta.mediaType : null,
    width: positiveInt(meta.width) ? meta.width : null,
    height: positiveInt(meta.height) ? meta.height : null,
  };
}

function normalizeVariant(variant, productId, currency) {
  if (!object(variant) || !validProductId(variant.productId ?? '') ||
      variant.productId !== productId || !validSkuId(variant.skuId ?? '') ||
      !safeText(variant.name, 240)) return null;
  const image = value => object(value) ? safeUltaImageUrl(value.imageUrl) : null;
  const list = moneyForPrice(variant.listPrice, 'retail_list', currency);
  const sale = moneyForPrice(variant.salePrice, 'retail_sale', currency);
  return {
    productId,
    skuId: variant.skuId,
    name: variant.name,
    description: safeText(variant.shadeDescription, 500) ? variant.shadeDescription : null,
    selected: typeof variant.selected === 'boolean' ? variant.selected : null,
    disabled: typeof variant.disabled === 'boolean' ? variant.disabled : null,
    unavailable: typeof variant.unavailable === 'boolean' ? variant.unavailable : null,
    listPriceText: list.text,
    listPrice: list.amount,
    listPriceRange: list.range,
    salePriceText: sale.text,
    salePrice: sale.amount,
    salePriceRange: sale.range,
    images: {
      main: image(variant.mainImage),
      swatch: image(variant.swatchImage),
      smoosh: image(variant.smooshImage),
    },
  };
}

function normalizeProductPage(payload, context) {
  const page = payload?.data?.Page?.content;
  if (!object(payload) || (Array.isArray(payload.errors) && payload.errors.length > 0) ||
      !object(page) || page.type !== 'Page' || !Array.isArray(page.modules)) fail('ULTA_PRODUCT_SCHEMA_INVALID');
  const pricing = allModules(page, 'ProductPricing').filter(item => item.productId === context.productId);
  const selected = pricing.find(item => context.skuId ? item.skuId === context.skuId : true);
  const info = allModules(page, 'ProductInformation').find(item => safeText(item.productName, 500));
  const detail = allModules(page, 'ProductDetail').find(item => typeof item.description === 'string');
  const gallery = allModules(page, 'MediaGallery').find(item => !context.skuId || item.skuId === context.skuId);
  const variants = allModules(page, 'ProductVariant').find(item => Array.isArray(item.variants));
  const review = allModules(page, 'ProductReviews').find(item => item.productId === context.productId &&
    (!context.skuId || item.productSku === context.skuId));
  if (!selected || selected.productId !== context.productId || !validSkuId(selected.skuId ?? '') ||
      (context.skuId && selected.skuId !== context.skuId) || !review ||
      !safeText(selected.productName, 500) || !safeText(selected.brandName, 160)) {
    fail('ULTA_PRODUCT_BINDING_MISMATCH');
  }
  const currency = review.priceCurrency === 'USD' ? 'USD' : null;
  const list = moneyForPrice(selected.productListPrice ?? selected.listPrice, 'retail_list', currency);
  const sale = moneyForPrice(selected.productSalePrice ?? selected.salePrice, 'retail_sale', currency);
  const current = sale.amount ?? sale.range ?? list.amount ?? list.range;
  const galleryItems = Array.isArray(gallery?.items) ? gallery.items : [];
  const images = galleryItems.map(normalizeGalleryItem);
  if (images.some(item => item === null)) fail('ULTA_PRODUCT_IMAGE_SCHEMA_INVALID');
  if (images.length > 100) fail('ULTA_PRODUCT_SCHEMA_INVALID');
  const optionRows = Array.isArray(variants?.variants) ? variants.variants : [];
  if (optionRows.length > 500) fail('ULTA_PRODUCT_SCHEMA_INVALID');
  const options = optionRows.map(item => normalizeVariant(item, context.productId, currency));
  if (options.some(item => item === null)) fail('ULTA_PRODUCT_VARIANT_SCHEMA_INVALID');
  const rating = typeof info?.rating === 'number' && Number.isFinite(info.rating) && info.rating >= 0 && info.rating <= 5
    ? info.rating
    : typeof review.rating === 'number' && Number.isFinite(review.rating) && review.rating >= 0 && review.rating <= 5
      ? review.rating : null;
  const reviewCount = nonnegativeInt(info?.reviewCount) ? info.reviewCount :
    nonnegativeInt(review.reviewCount) ? review.reviewCount : null;
  return {
    productId: context.productId,
    skuId: selected.skuId,
    variantId: selected.skuId,
    productName: selected.productName,
    title: selected.productName,
    brandName: selected.brandName,
    productUrl: context.productUrl,
    url: context.productUrl,
    currency,
    listPriceText: list.text,
    listPrice: list.amount,
    listPriceRange: list.range,
    salePriceText: sale.text,
    salePrice: sale.amount,
    salePriceRange: sale.range,
    price: current && 'amount' in current ? current : null,
    priceRange: current && 'min' in current ? current : null,
    category: safeText(selected.productCategory, 240) ? selected.productCategory : null,
    description: safeText(detail?.description, 20_000) ? detail.description : null,
    usage: safeText(detail?.usage, 20_000) ? detail.usage : null,
    ingredients: safeText(detail?.ingredients, 30_000) ? detail.ingredients : null,
    restrictions: safeText(detail?.restrictions, 20_000) ? detail.restrictions : null,
    rating,
    reviewCount,
    images,
    options,
    selectedVariant: options.find(option => option.skuId === selected.skuId) ?? null,
  };
}

function reviewApiBase(context) {
  return new URL(`/m/${encodeURIComponent(context.merchantId)}/l/${encodeURIComponent(context.powerReviewsLocale)}` +
    `/product/${encodeURIComponent(context.productId)}/reviews`, POWERREVIEWS_ORIGIN);
}

function validatePowerReviewsNext(value, context, expectedPage, pageSize, apiKey) {
  let url;
  try { url = new URL(value, POWERREVIEWS_ORIGIN); }
  catch { fail('ULTA_REVIEW_PAGINATION_INVALID'); }
  const expectedPath = reviewApiBase(context).pathname;
  const allowedKeys = new Set(['paging.from', 'paging.size', 'filters', 'search', 'sort', 'image_only', 'page_locale', 'apikey']);
  if (url.origin !== POWERREVIEWS_ORIGIN || url.pathname !== expectedPath || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => !allowedKeys.has(key)) ||
      Number(url.searchParams.get('paging.from')) !== (expectedPage - 1) * pageSize ||
      Number(url.searchParams.get('paging.size')) !== pageSize) fail('ULTA_REVIEW_PAGINATION_INVALID');
  url.searchParams.delete('apikey');
  url.searchParams.set('apikey', apiKey);
  return url;
}

function normalizeReviewImage(media) {
  if (!object(media) || !safeText(media.uri, 4_000)) return null;
  const imageUrl = safeReviewImageUrl(media.uri);
  if (!imageUrl) return null;
  return { url: imageUrl, type: safeText(media.type, 80) ? media.type : null };
}

function normalizeReview(item) {
  if (!object(item) || !(Number.isSafeInteger(item.review_id) && item.review_id > 0) ||
      !object(item.details) || !object(item.metrics) ||
      !(item.details.comments === null || typeof item.details.comments === 'string' && item.details.comments.length <= 30_000) ||
      !(typeof item.metrics.rating === 'number' && Number.isFinite(item.metrics.rating) && item.metrics.rating >= 0 && item.metrics.rating <= 5)) {
    return null;
  }
  const created = item.details.created_date;
  const createdMs = Number.isFinite(created) ? (created < 100_000_000_000 ? created * 1_000 : created) :
    typeof created === 'string' ? new Date(created).getTime() : NaN;
  if (!Number.isFinite(createdMs)) return null;
  const postedAt = new Date(createdMs);
  if (!Number.isFinite(postedAt.getTime())) return null;
  const images = Array.isArray(item.media) ? item.media.map(normalizeReviewImage) : [];
  if (images.some(image => image === null) || images.length > 30) return null;
  return {
    reviewId: String(item.review_id),
    body: typeof item.details.comments === 'string' ? item.details.comments : null,
    rating: item.metrics.rating,
    images,
    postedAt: postedAt.toISOString(),
  };
}

function normalizePowerReviewsPage(payload, context, expectedPage, pageSize) {
  const groups = payload?.results;
  if (!object(payload) || !Array.isArray(groups) || groups.length < 1) fail('ULTA_REVIEW_SCHEMA_INVALID');
  const group = groups.find(item => item?.page_id === context.productId);
  const paging = payload.paging;
  if (!group || !Array.isArray(group.reviews) || group.reviews.length > pageSize || !object(paging) ||
      !nonnegativeInt(paging.total_results) || !positiveInt(paging.pages_total) ||
      paging.page_size !== pageSize || paging.current_page_number !== expectedPage) fail('ULTA_REVIEW_BINDING_MISMATCH');
  const reviews = group.reviews.map(normalizeReview);
  if (reviews.some(item => item === null) || new Set(reviews.map(item => item.reviewId)).size !== reviews.length) {
    fail('ULTA_REVIEW_SCHEMA_INVALID');
  }
  return {
    reviews,
    total: paging.total_results,
    pagesTotal: paging.pages_total,
    pageSize: paging.page_size,
    currentPage: paging.current_page_number,
    nextPageUrl: typeof paging.next_page_url === 'string' && paging.next_page_url.length > 0
      ? paging.next_page_url : null,
  };
}

function makeDomainReceipt({ service, capabilityId, request, sourceURL, sourceSha256, bootstrapRequest,
  productIdMatched, skuIdMatched, expectedResultVerified, pagination }) {
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'ulta',
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified,
    contractProvenance: { kind: 'first_party_bundle_contract', sourceURL, sourceSha256 },
    request,
    bootstrapRequest,
    ...(productIdMatched ? { productIdMatched: true } : {}),
    ...(skuIdMatched ? { skuIdMatched: true } : {}),
    ...(pagination ? { pagination } : {}),
  };
}

function pageContextFromHtml(html, canonical, bootstrapReceipt) {
  const state = readAssignedJson(html, '__APOLLO_STATE__');
  const root = state?.ROOT_QUERY;
  const pageKey = object(root) ? Object.keys(root).find(key => key.startsWith('Page(')) : null;
  if (!pageKey || !pageKey.endsWith(')')) fail('ULTA_PRODUCT_BOOTSTRAP_INVALID');
  let pageArgs;
  try { pageArgs = JSON.parse(pageKey.slice(5, -1)); }
  catch { fail('ULTA_PRODUCT_BOOTSTRAP_INVALID'); }
  if (!object(pageArgs) || pageArgs.url?.path !== canonical.pathname || !object(root[pageKey]?.content)) {
    fail('ULTA_PRODUCT_BOOTSTRAP_BINDING_MISMATCH');
  }
  const cachedSku = pageArgs.moduleParams?.sku;
  if (cachedSku !== undefined && !validSkuId(cachedSku) ||
      canonical.skuId !== undefined && cachedSku !== canonical.skuId) fail('ULTA_PRODUCT_BOOTSTRAP_BINDING_MISMATCH');
  const productReviewModules = allModules(root[pageKey].content, 'ProductReviews')
    .filter(module => module.productId === canonical.productId);
  const productReviews = productReviewModules.length === 1 ? productReviewModules[0] : null;
  const pageSku = canonical.skuId ?? cachedSku ??
    (validSkuId(productReviews?.productSku) ? productReviews.productSku : undefined);
  if (productReviewModules.length > 1 || productReviews && pageSku && productReviews.productSku !== pageSku) {
    fail('ULTA_PRODUCT_BOOTSTRAP_BINDING_MISMATCH');
  }

  const locale = readAssignedString(html, '__APP_LOCALE__');
  const domain = readAssignedString(html, '__GRAPHQL_DOMAIN__');
  const graphqlGetUri = readAssignedString(html, '__GRAPHQL_GET_URI__');
  const siteHeaders = readAssignedJson(html, '__REQUEST_HEADERS__');
  if (locale !== 'en-US' || domain !== ORIGIN || !safeText(graphqlGetUri, 500) ||
      !object(siteHeaders) || !/^[A-Za-z0-9_-]{1,32}$/.test(siteHeaders.X_ULTA_SITE ?? '')) {
    fail('ULTA_PRODUCT_BOOTSTRAP_INVALID');
  }
  if (!html.includes('client.fa640546.js')) fail('ULTA_PRODUCT_SOURCE_VERSION_UNVERIFIED');
  const graphqlBase = new URL(graphqlGetUri, domain);
  if (graphqlBase.origin !== ORIGIN || graphqlBase.pathname !== API_PATH ||
      !graphqlBase.searchParams.has('ultasite') || !graphqlBase.searchParams.has('user-agent') ||
      [...graphqlBase.searchParams.keys()].some(key => !['ultasite', 'user-agent'].includes(key))) {
    fail('ULTA_PRODUCT_BOOTSTRAP_INVALID');
  }
  const powerReviewsLocale = productReviews?.locale;
  const merchantId = productReviews?.prMerchantId;
  const apiKey = productReviews?.prApiKey;
  const powerReviewsConfigured = productReviews?.enableLocalPowerReviewContent === true &&
    safeText(apiKey, 500) && /^[A-Za-z0-9_-]{1,32}$/.test(merchantId ?? '') &&
    powerReviewsLocale === 'en-US' && /ui\.powerreviews\.com(?:\\u002F|\/)stable(?:\\u002F|\/)4\.0(?:\\u002F|\/)ui\.js/i.test(html);
  return {
    productId: canonical.productId,
    skuId: pageSku,
    productUrl: canonical.url.toString(),
    pathname: canonical.pathname,
    locale,
    site: siteHeaders.X_ULTA_SITE,
    graphqlBase,
    bootstrapRequest: bootstrapReceipt,
    ...(powerReviewsConfigured ? {
      powerReviews: {
        apiKey,
        merchantId,
        locale: powerReviewsLocale,
        powerReviewsLocale: powerReviewsLocale.replace('-', '_'),
      },
    } : {}),
    sourceURL: ULTA_CLIENT_BUNDLE_URL,
    sourceSha256: ULTA_CLIENT_BUNDLE_SHA256,
  };
}

async function loadProductPageContext({ canonical, fetchImpl, now, contextCache }) {
  const cacheKey = canonical.url.toString();
  const cached = contextCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) return cached.context;
  const htmlRead = await getBounded({
    url: canonical.url,
    headers: { accept: 'text/html' },
    fetchImpl, now, maxBytes: MAX_HTML_BYTES, expectedMime: 'text/html',
    requestPath: canonical.pathname,
    queryFields: [...canonical.url.searchParams.keys()],
  });
  const bootstrapRequest = {
    method: 'GET', origin: ORIGIN, path: canonical.pathname,
    httpStatus: htmlRead.receipt.httpStatus, mime: htmlRead.receipt.mime,
    responseBytes: htmlRead.receipt.responseBytes, checkedAt: htmlRead.receipt.checkedAt,
    browserUsed: false, anonymous: true, credentialsUsed: false,
    cookieSent: false, authorizationSent: false, queryFields: htmlRead.receipt.queryFields,
  };
  const context = pageContextFromHtml(htmlRead.raw.toString('utf8'), canonical, bootstrapRequest);
  contextCache.delete(cacheKey);
  if (contextCache.size >= PAGE_CONTEXT_CACHE_MAX) contextCache.delete(contextCache.keys().next().value);
  contextCache.set(cacheKey, { context, expiresAt: now() + PAGE_CONTEXT_TTL_MS });
  return context;
}

async function requestProductPageData(context, { fetchImpl, now }) {
  const url = new URL(context.graphqlBase);
  const variables = {
    url: { path: context.pathname },
    ...(context.skuId ? { moduleParams: { sku: context.skuId } } : {}),
  };
  for (const [key, value] of Object.entries({ operationName: 'Page', query: PAGE_QUERY, variables: JSON.stringify(variables) })) {
    url.searchParams.set(key, value);
  }
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-ulta-client-country': 'US',
    'x-ulta-client-locale': context.locale,
    'x-ulta-client-channel': 'web',
    'x-ulta-dxl-query-id': `Page::${context.pathname}`,
    'x-ulta-graph-type': 'query',
    'x-ulta-graph-sub-type': 'page',
    'x-ulta-graph-module-name': 'RouteContainer',
    'x-forwarded-proto': 'https',
    x_ulta_site: context.site,
    referer: context.productUrl,
  };
  const read = await getBounded({
    url, headers, fetchImpl, now, maxBytes: MAX_JSON_BYTES,
    expectedMime: 'application/json', requestPath: API_PATH,
    queryFields: [...url.searchParams.keys()],
  });
  let payload;
  try { payload = JSON.parse(read.raw.toString('utf8')); }
  catch { fail('ULTA_PRODUCT_JSON_INVALID', read.receipt); }
  return { payload, request: read.receipt };
}

function makePageDataReceipt({ capabilityId, request, context, sourceURL, sourceSha256, productIdMatched,
  skuIdMatched, result }) {
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'ulta',
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified: true,
    contractProvenance: { kind: 'first_party_bundle_contract', sourceURL, sourceSha256 },
    request,
    bootstrapRequest: context.bootstrapRequest,
    productIdMatched,
    skuIdMatched,
    result,
  };
}

function makePowerReviewsUrl(context, pageSize) {
  const url = new URL(`/m/${encodeURIComponent(context.merchantId)}/l/${encodeURIComponent(context.powerReviewsLocale)}` +
    `/product/${encodeURIComponent(context.productId)}/reviews`, POWERREVIEWS_ORIGIN);
  url.searchParams.set('apikey', context.apiKey);
  url.searchParams.set('_noconfig', 'true');
  url.searchParams.set('paging.size', String(pageSize));
  return url;
}

async function requestPowerReviewsPage(url, { fetchImpl, now }) {
  const read = await getBounded({
    url,
    origin: POWERREVIEWS_ORIGIN,
    headers: { accept: 'application/json' },
    fetchImpl, now, maxBytes: MAX_JSON_BYTES, expectedMime: 'application/json',
    requestPath: url.pathname,
    queryFields: [...new Set(url.searchParams.keys())],
  });
  let payload;
  try { payload = JSON.parse(read.raw.toString('utf8')); }
  catch { fail('ULTA_REVIEW_JSON_INVALID', read.receipt); }
  return { payload, request: read.receipt };
}

function makeReviewReceipt({ request, context, bootstrapRequests, pagination, expectedResultVerified }) {
  const publicRequest = {
    ...request,
    readOnly: true,
    publicFrontendKeyUsed: true,
    userCredentialsUsed: false,
    noUserCredentials: true,
  };
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'ulta',
    capabilityId: 'reviews.read',
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified,
    publicFrontendKeyUsed: true,
    userCredentialsUsed: false,
    noUserCredentials: true,
    contractProvenance: {
      kind: 'first_party_bundle_contract',
      sourceURL: POWERREVIEWS_ENGINE_URL,
      sourceSha256: POWERREVIEWS_ENGINE_SHA256,
    },
    request: publicRequest,
    bootstrapRequest: context.bootstrapRequest,
    bootstrapRequests,
    productIdMatched: true,
    pagination,
  };
}

/**
 * Search Ulta's US public catalogue using its observed DXL ProductListingResults
 * XHR. A fresh anonymous HTML response supplies the current content ID and the
 * first-party query/header metadata. No browser, cookie, authorization, or
 * retailer visitor identifier is used.
 */
export function createUltaPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('ULTA_CLIENT_INVALID');
  const pageContextCache = new Map();
  const reviewPageLinksCache = new Map();

  return {
    async searchProducts({ query, page = 1, pageSize = 100 } = {}) {
      if (typeof query !== 'string' || query.trim().length < 1 || query.trim().length > MAX_QUERY_LENGTH ||
          /[\x00-\x1f\x7f]/.test(query) || !positiveInt(page) || page > MAX_PAGE ||
          !positiveInt(pageSize) || pageSize > MAX_PAGE_SIZE) fail('ULTA_SEARCH_INPUT_INVALID');
      const normalizedQuery = query.trim();
      const bootstrapRequests = [];
      let pageUrl = new URL(SEARCH_PATH, ORIGIN);
      pageUrl.searchParams.set('search', normalizedQuery);
      let payload;
      let apiRequest;
      let content;

      for (let currentPage = 1; currentPage <= page; currentPage++) {
        if (currentPage > 1) {
          const previousContent = content;
          if (!safeText(previousContent?.loadMoreUrl, 2_000)) {
            fail('ULTA_PAGE_UNAVAILABLE', apiRequest);
          }
          pageUrl = validateNextUrl(previousContent.loadMoreUrl, pageUrl, normalizedQuery, currentPage);
        }
        const htmlRead = await getBounded({
          url: pageUrl,
          headers: { accept: 'text/html' },
          fetchImpl, now, maxBytes: MAX_HTML_BYTES, expectedMime: 'text/html',
          requestPath: SEARCH_PATH,
          queryFields: [...pageUrl.searchParams.keys()],
        });
        bootstrapRequests.push({
          method: 'GET', origin: ORIGIN, path: SEARCH_PATH,
          httpStatus: htmlRead.receipt.httpStatus, mime: htmlRead.receipt.mime,
          responseBytes: htmlRead.receipt.responseBytes, checkedAt: htmlRead.receipt.checkedAt,
          browserUsed: false, anonymous: true, credentialsUsed: false,
          cookieSent: false, authorizationSent: false, queryFields: htmlRead.receipt.queryFields,
        });
        const html = htmlRead.raw.toString('utf8');
        const bootstrap = parseBootstrap(html, pageUrl.toString(), currentPage);
        const variables = {
          moduleParams: { gti: '', loginStatus: 'anonymous', breakpoint: 'desktop' },
          cacheBust: now(),
        };
        bootstrap.apiUrl.searchParams.set('variables', JSON.stringify(variables));
        const apiHeaders = {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-ulta-client-country': 'US',
          'x-ulta-client-locale': bootstrap.locale,
          'x-ulta-client-channel': 'web',
          'x-ulta-dxl-query-id': 'NonCachedPage',
          'x-ulta-graph-type': 'query',
          'x-ulta-graph-sub-type': 'noncachedpage',
          'x-ulta-graph-module-name': bootstrap.moduleName,
          'x-forwarded-proto': 'https',
          x_ulta_site: bootstrap.site,
          referer: pageUrl.toString(),
        };
        const apiRead = await getBounded({
          url: bootstrap.apiUrl,
          headers: apiHeaders,
          fetchImpl, now, maxBytes: MAX_JSON_BYTES, expectedMime: 'application/json',
          requestPath: API_PATH,
          queryFields: [...bootstrap.apiUrl.searchParams.keys()],
        });
        let parsed;
        try { parsed = JSON.parse(apiRead.raw.toString('utf8')); }
        catch { fail('ULTA_JSON_INVALID', apiRead.receipt); }
        const normalized = normalizePayload(parsed, normalizedQuery, currentPage, pageSize);
        content = normalized.content;
        payload = normalized.result;
        apiRequest = apiRead.receipt;
      }

      const result = payload;
      result.pagesTraversed = Array.from({ length: page }, (_unused, index) => index + 1);
      result.receipt = makePublicReceipt(apiRequest, bootstrapRequests, true, true);
      return result;
    },

    async getProduct({ productId, skuId, productUrl } = {}) {
      const canonical = canonicalProductPage(productId, skuId, productUrl);
      const context = await loadProductPageContext({ canonical, fetchImpl, now, contextCache: pageContextCache });
      const { payload, request } = await requestProductPageData(context, { fetchImpl, now });
      const product = normalizeProductPage(payload, context);
      const productIdMatched = product.productId === productId;
      const skuIdMatched = context.skuId === undefined || product.skuId === context.skuId;
      if (!productIdMatched || !skuIdMatched) fail('ULTA_PRODUCT_BINDING_MISMATCH', request);
      const receipt = makePageDataReceipt({
        capabilityId: 'catalog.product_detail',
        request,
        context,
        sourceURL: ULTA_CLIENT_BUNDLE_URL,
        sourceSha256: ULTA_CLIENT_BUNDLE_SHA256,
        productIdMatched,
        skuIdMatched,
        result: {
          productId: product.productId,
          skuId: product.skuId,
          descriptionReturned: Boolean(product.description),
          imageCount: product.images.length,
          optionCount: product.options.length,
          listPriceCurrency: product.currency,
          ratingReturned: product.rating !== null,
          reviewCount: product.reviewCount,
        },
      });
      return { product, receipt, receipts: [receipt] };
    },

    async getReviews({ productId, skuId, productUrl, page = 1, pageSize = 10 } = {}) {
      if (!positiveInt(page) || page > MAX_REVIEW_PAGE ||
          !positiveInt(pageSize) || pageSize > MAX_REVIEW_PAGE_SIZE) fail('ULTA_REVIEW_INPUT_INVALID');
      const canonical = canonicalProductPage(productId, skuId, productUrl);
      const context = await loadProductPageContext({ canonical, fetchImpl, now, contextCache: pageContextCache });
      if (!context.powerReviews) fail('ULTA_REVIEW_CONFIG_MISSING');
      const powerContext = { ...context, ...context.powerReviews };
      const linkKey = `${context.productId}\u0000${powerContext.merchantId}\u0000${powerContext.powerReviewsLocale}\u0000${pageSize}`;
      let pageLinks = reviewPageLinksCache.get(linkKey);
      if (!pageLinks) {
        pageLinks = new Map();
        reviewPageLinksCache.set(linkKey, pageLinks);
      }
      const receipts = [];
      let url = makePowerReviewsUrl(powerContext, pageSize);
      let target;
      let expectedTotal = null;
      let expectedPages = null;
      const cachedTargetPage = pageLinks.get(page);
      const startPage = page > 1 && cachedTargetPage && cachedTargetPage.expiresAt > now() ? page : 1;

      for (let currentPage = startPage; currentPage <= page; currentPage++) {
        if (currentPage > 1) {
          const cached = pageLinks.get(currentPage);
          if (cached && cached.expiresAt > now()) {
            url = new URL(cached.url);
            url.searchParams.delete('apikey');
            url.searchParams.set('apikey', powerContext.apiKey);
          } else {
            if (!target?.nextPageUrl) fail('ULTA_REVIEW_PAGE_UNAVAILABLE');
            url = validatePowerReviewsNext(target.nextPageUrl, powerContext, currentPage, pageSize, powerContext.apiKey);
          }
        }
        const apiRead = await requestPowerReviewsPage(url, { fetchImpl, now });
        const parsed = normalizePowerReviewsPage(apiRead.payload, context, currentPage, pageSize);
        if (expectedTotal !== null && (parsed.total !== expectedTotal || parsed.pagesTotal !== expectedPages)) {
          fail('ULTA_REVIEW_PAGINATION_DRIFT', apiRead.request);
        }
        expectedTotal = parsed.total;
        expectedPages = parsed.pagesTotal;
        if (parsed.pagesTotal > MAX_REVIEW_PAGE || currentPage > parsed.pagesTotal) {
          fail('ULTA_REVIEW_PAGE_LIMIT_OR_RANGE');
        }
        if (currentPage === 1 && parsed.total === 0 && parsed.reviews.length === 0) {
          target = { ...parsed, pagesTotal: 0, currentPage: 1 };
        } else {
          target = parsed;
        }
        const nextPage = parsed.nextPageUrl
          ? validatePowerReviewsNext(parsed.nextPageUrl, powerContext, currentPage + 1, pageSize, powerContext.apiKey)
          : null;
        if (nextPage) {
          const safeNext = new URL(nextPage);
          safeNext.searchParams.delete('apikey');
          pageLinks.set(currentPage + 1, { url: safeNext.toString(), expiresAt: now() + PAGE_CONTEXT_TTL_MS });
          while (pageLinks.size > MAX_REVIEW_PAGE) pageLinks.delete(pageLinks.keys().next().value);
        } else if (currentPage < parsed.pagesTotal) {
          fail('ULTA_REVIEW_PAGINATION_INCOMPLETE', apiRead.request);
        }
        const receipt = makeReviewReceipt({
          request: apiRead.request,
          context,
          bootstrapRequests: [context.bootstrapRequest],
          pagination: {
            page: currentPage,
            pageSize: parsed.pageSize,
            total: parsed.total,
            pagesTotal: parsed.pagesTotal,
            hasMore: Boolean(nextPage),
            paginationVerified: true,
          },
          expectedResultVerified: parsed.reviews.every(review => typeof review.body === 'string' || review.body === null),
        });
        receipts.push(receipt);
      }

      const hasMore = Boolean(target?.nextPageUrl);
      const pagination = {
        page,
        pageSize,
        total: expectedTotal ?? 0,
        pagesTotal: expectedPages ?? 0,
        hasMore,
        ...(hasMore ? { nextPage: page + 1 } : {}),
        complete: !hasMore,
        verified: true,
      };
      return {
        productId,
        ...(context.skuId ? { skuId: context.skuId } : {}),
        page,
        pageSize,
        totalReviews: expectedTotal ?? 0,
        productIdMatched: true,
        paginationVerified: true,
        reviews: target?.reviews ?? [],
        pagination,
        receipts,
      };
    },
  };
}
