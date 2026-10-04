import { commerceJsonRequest, CommerceHttpError } from './http.mjs';

const ORIGIN = 'https://www.sephora.com';
const SEARCH_PATH = '/api/v2/catalog/search/';
const MAX_QUERY = 120;
const MAX_PAGE_SIZE = 60;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PRICE = /^\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2})(?:\s+-\s+\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2}))?$/;

export class SephoraPublicError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'SephoraPublicError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new SephoraPublicError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 2_000) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeInt = value => Number.isSafeInteger(value) && value >= 0;

function parseUsdPriceRange(listPrice) {
  if (typeof listPrice !== 'string' || listPrice.length > 80) return null;
  const match = PRICE.exec(listPrice.trim());
  if (!match) return null;
  const amount = (whole, fraction) => {
    const integer = Number(whole.replaceAll(',', ''));
    if (!Number.isSafeInteger(integer)) return null;
    return `${integer}.${fraction}`;
  };
  const min = amount(match[1], match[2]);
  const max = match[3] === undefined ? min : amount(match[3], match[4]);
  if (min === null || max === null || Number(min) > Number(max)) return null;
  return { min: { amount: min, currency: 'USD' }, max: { amount: max, currency: 'USD' } };
}

function normalizeProductUrl(value, productId, skuId) {
  if (!text(value, 2_000)) return null;
  try {
    const url = new URL(value, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
        !url.pathname.startsWith('/product/') || !url.pathname.toUpperCase().endsWith(`-${productId}`)) return null;
    const linkedSku = url.searchParams.get('skuId');
    if (linkedSku !== null && linkedSku !== skuId) return null;
    return `${ORIGIN}${url.pathname}${linkedSku === null ? '' : `?skuId=${encodeURIComponent(skuId)}`}`;
  } catch { return null; }
}

function normalizeProduct(item) {
  if (!object(item) || !/^P\d{4,12}$/.test(item.productId ?? '') ||
      !text(item.productName ?? item.displayName) || !text(item.brandName, 160) ||
      !object(item.currentSku) || !/^\d{3,16}$/.test(item.currentSku.skuId ?? '') ||
      !text(item.currentSku.listPrice, 80)) return null;
  const listPrice = item.currentSku.listPrice.trim();
  const price = parseUsdPriceRange(listPrice);
  const productUrl = normalizeProductUrl(item.targetUrl, item.productId, item.currentSku.skuId);
  if (!price || !productUrl) return null;
  const singlePrice = price.min.amount === price.max.amount;
  if (item.onSaleData !== undefined && !text(item.onSaleData, 40)) return null;
  return {
    productId: item.productId,
    skuId: item.currentSku.skuId,
    variantId: item.currentSku.skuId,
    brandName: item.brandName,
    productName: item.productName ?? item.displayName,
    productUrl,
    listPriceText: listPrice,
    priceKind: 'retail_list',
    priceScope: singlePrice ? 'current_sku' : 'product_range',
    ...(singlePrice ? { price: { ...price.min, kind: 'retail_list' } } : { price: null }),
    ...(!singlePrice ? { priceRange: price } : {}),
    ...(item.onSaleData === undefined ? {} : { onSaleData: item.onSaleData }),
  };
}

function makeReceipt(request, queryMatched, expectedResultVerified) {
  const { responseSha256: _discard, ...safeRequest } = request;
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'sephora',
    capabilityId: 'catalog.search',
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified,
    contractProvenance: {
      kind: 'browser_xhr_observed',
      sourceURL: 'https://www.sephora.com/search',
    },
    request: { ...safeRequest, schemaVerified: true },
    queryMatched,
  };
}

/**
 * Anonymous public catalog search using Sephora's observed catalog XHR.
 * The adapter currently supports the US storefront and pages of at most 60.
 */
export function createSephoraPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') {
    fail('SEPHORA_CLIENT_INVALID');
  }

  return {
    async searchProducts({ query, page = 1, pageSize = MAX_PAGE_SIZE, countryCode = 'US' } = {}) {
      if (typeof query !== 'string' || query.trim().length < 1 || query.trim().length > MAX_QUERY ||
          /[\x00-\x1f\x7f]/.test(query) || !positiveInt(page) || page > 10_000 ||
          !positiveInt(pageSize) || pageSize > MAX_PAGE_SIZE || countryCode !== 'US') {
        fail('SEPHORA_SEARCH_INPUT_INVALID');
      }
      const normalizedQuery = query.trim();
      let read;
      try {
        read = await commerceJsonRequest({
          service: 'sephora', origin: ORIGIN, path: SEARCH_PATH, method: 'GET',
          query: [
            ['type', 'keyword'],
            ['q', normalizedQuery],
            ['page', String(pageSize)],
            ['currentPage', String(page)],
            ['countryCode', countryCode],
          ],
          fetchImpl, now, maxBytes: MAX_RESPONSE_BYTES,
        });
      } catch (error) {
        if (error instanceof CommerceHttpError) {
          fail(error.code.replace(/^SEPHORA_/, 'SEPHORA_'), error.receipt);
        }
        throw error;
      }

      const payload = read.payload;
      if (!object(payload) || !text(payload.keyword, MAX_QUERY) ||
          payload.keyword.trim().toLowerCase() !== normalizedQuery.toLowerCase() ||
          !nonnegativeInt(payload.totalProducts) || !Array.isArray(payload.products) ||
          payload.products.length > pageSize || payload.products.some(item => !normalizeProduct(item))) {
        fail('SEPHORA_SEARCH_SCHEMA_INVALID', read.request);
      }
      const products = payload.products.map(normalizeProduct);
      const productIds = products.map(item => item.productId);
      if (new Set(productIds).size !== productIds.length) {
        fail('SEPHORA_SEARCH_SCHEMA_INVALID', read.request);
      }
      const result = {
        query: normalizedQuery,
        page,
        pageSize,
        totalProducts: payload.totalProducts,
        pageCount: payload.totalProducts === 0 ? 0 : Math.ceil(payload.totalProducts / pageSize),
        currency: 'USD',
        products,
        receipt: makeReceipt(read.request, true, true),
      };
      return result;
    },

    async searchAllProducts({ query, pageSize = MAX_PAGE_SIZE, countryCode = 'US', maxPages = 100 } = {}) {
      if (!positiveInt(maxPages) || maxPages > 1_000) fail('SEPHORA_SEARCH_INPUT_INVALID');
      const first = await this.searchProducts({ query, page: 1, pageSize, countryCode });
      if (first.pageCount > maxPages) {
        fail('SEPHORA_PAGE_LIMIT_EXCEEDED', {
          ...first.receipt.request,
          expectedPageCount: first.pageCount,
          maxPages,
        });
      }
      const pages = [first];
      for (let page = 2; page <= first.pageCount; page++) {
        pages.push(await this.searchProducts({ query, page, pageSize, countryCode }));
      }
      const ids = pages.flatMap(result => result.products.map(item => item.productId));
      if (pages.some(result => result.totalProducts !== first.totalProducts || result.page !== pages.indexOf(result) + 1) ||
          ids.length !== first.totalProducts || new Set(ids).size !== ids.length) {
        fail('SEPHORA_PAGINATION_SCHEMA_INVALID', first.receipt.request);
      }
      return {
        query: first.query,
        pageSize,
        totalProducts: first.totalProducts,
        pageCount: first.pageCount,
        complete: true,
        products: pages.flatMap(result => result.products),
        pages: pages.map(result => ({
          page: result.page,
          pageSize: result.pageSize,
          totalProducts: result.totalProducts,
          returnedProducts: result.products.length,
          pricedProducts: result.products.filter(item => item.price || item.priceRange).length,
          request: result.receipt.request,
        })),
        receipts: pages.map(result => result.receipt),
      };
    },
  };
}
