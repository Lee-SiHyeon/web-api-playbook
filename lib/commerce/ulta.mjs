import { createHash } from 'node:crypto';

const ORIGIN = 'https://www.ulta.com';
const SEARCH_PATH = '/search';
const API_PATH = '/dxl/graphql';
const SOURCE_URL = 'https://www.ulta.com/search';
const MAX_QUERY_LENGTH = 120;
const MAX_PAGE = 10;
const MAX_PAGE_SIZE = 100;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const PRICE_RE = /^\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2})(?:\s+-\s+\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2}))?$/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

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

async function getBounded({ url, headers, fetchImpl, now, maxBytes, expectedMime, requestPath, queryFields }) {
  const checkedAt = new Date(now()).toISOString();
  const baseReceipt = {
    method: 'GET', origin: ORIGIN, path: requestPath, checkedAt,
    browserUsed: false, anonymous: true, credentialsUsed: false,
    cookieSent: false, authorizationSent: false, queryFields,
  };
  let response;
  try {
    response = await fetchImpl(url, {
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

/**
 * Search Ulta's US public catalogue using its observed DXL ProductListingResults
 * XHR. A fresh anonymous HTML response supplies the current content ID and the
 * first-party query/header metadata. No browser, cookie, authorization, or
 * retailer visitor identifier is used.
 */
export function createUltaPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('ULTA_CLIENT_INVALID');

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
  };
}
