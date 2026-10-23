import { commerceJsonRequest, CommerceHttpError } from './http.mjs';
import { createSephoraReviewsClient } from './sephora-reviews.mjs';

const ORIGIN = 'https://www.sephora.com';
const SEARCH_PATH = '/api/v2/catalog/search/';
const MAX_QUERY = 120;
const MAX_PAGE_SIZE = 60;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PRODUCT_SERVICE_SOURCE = 'https://www.sephora.com/js/ufe/isomorphic/main.bundle.B22CoriginmasterD20260922192852.js';
const PRODUCT_SERVICE_SOURCE_SHA256 = '5c69df88c12e129005fb796a1067876bc3df65096aa0fdf6f457373513cf5763';
const PRICE = /^\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2})(?:\s+-\s+\$(?:(\d{1,3}(?:,\d{3})*|\d+))\.(\d{2}))?$/;
const PRODUCT_ID = /^P\d{4,12}$/;
const SKU_ID = /^\d{3,16}$/;

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

function parsePublicReviewCount(value) {
  if (!text(value, 32)) return null;
  const normalized = value.replaceAll(',', '');
  if (!/^\d{1,12}$/.test(normalized)) return null;
  const count = Number(normalized);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function normalizeProduct(item) {
  if (!object(item) || !/^P\d{4,12}$/.test(item.productId ?? '') ||
      !text(item.productName ?? item.displayName) || !text(item.brandName, 160) ||
      !object(item.currentSku) || !/^\d{3,16}$/.test(item.currentSku.skuId ?? '') ||
      !text(item.currentSku.listPrice, 80) || !text(item.rating, 32) ||
      !/^\d+(?:\.\d+)?$/.test(item.rating) || !Number.isFinite(Number(item.rating)) ||
      Number(item.rating) < 0 || Number(item.rating) > 5) return null;
  const listPrice = item.currentSku.listPrice.trim();
  const price = parseUsdPriceRange(listPrice);
  const productUrl = normalizeProductUrl(item.targetUrl, item.productId, item.currentSku.skuId);
  const reviewCount = parsePublicReviewCount(item.reviews);
  const images = normalizeCatalogImages(item);
  const rawSalePrice = item.currentSku.salePrice;
  const salePrice = rawSalePrice === undefined || rawSalePrice === null || rawSalePrice === ''
    ? null : usdMoney(rawSalePrice, 'sale');
  if (!price || !productUrl || reviewCount === null ||
      rawSalePrice !== undefined && rawSalePrice !== null && rawSalePrice !== '' && !salePrice) return null;
  const singlePrice = price.min.amount === price.max.amount;
  if (item.onSaleData !== undefined && !text(item.onSaleData, 40)) return null;
  return {
    productId: item.productId,
    skuId: item.currentSku.skuId,
    variantId: item.currentSku.skuId,
    brandName: item.brandName,
    productName: item.productName ?? item.displayName,
    productUrl,
    rating: Number(item.rating),
    reviewCount,
    images,
    listPriceText: listPrice,
    priceKind: 'retail_list',
    priceScope: singlePrice ? 'current_sku' : 'product_range',
    ...(singlePrice ? { price: { ...price.min, kind: 'retail_list' } } : { price: null }),
    ...(!singlePrice ? { priceRange: price } : {}),
    ...(salePrice ? { salePrice } : {}),
    ...(item.onSaleData === undefined ? {} : { onSaleData: item.onSaleData }),
  };
}

function makeReceipt(request, queryMatched, expectedResultVerified, { pageSize, requestedPageSize, productCount } = {}) {
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
    request: {
      ...safeRequest,
      schemaVerified: true,
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(requestedPageSize === undefined ? {} : { requestedPageSize }),
      ...(productCount === undefined ? {} : { productCount }),
    },
    queryMatched,
  };
}

function firstPartyReceipt(request, capabilityId, sourceURL, sourceSha256, extra = {}) {
  const { responseSha256: _discard, ...safeRequest } = request;
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'sephora',
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified: true,
    contractProvenance: { kind: 'first_party_bundle_contract', sourceURL, sourceSha256 },
    request: { ...safeRequest, schemaVerified: true },
    ...extra,
  };
}

function usdMoney(value, kind = 'retail_list') {
  const amount = parseUsdPriceRange(value);
  if (!amount || amount.min.amount !== amount.max.amount) return null;
  return { amount: amount.min.amount, currency: 'USD', kind };
}

function imageUrl(value) {
  if (!text(value, 2_000)) return null;
  try {
    const url = new URL(value, ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !['www.sephora.com', 'sephora.com'].includes(url.hostname) ||
        !url.pathname.startsWith('/productimages/')) return null;
    return `${url.origin}${url.pathname}${url.search}`;
  } catch { return null; }
}

function normalizeCatalogImages(item) {
  const candidates = [
    ['hero', item?.heroImage],
    ['large', item?.image450],
    ['medium', item?.image250],
    ['small', item?.image135],
    ['alternate', item?.altImage],
  ];
  const altText = text(item?.currentSku?.imageAltText, 500) ? item.currentSku.imageAltText : null;
  const images = [];
  for (const [size, raw] of candidates) {
    const url = imageUrl(raw);
    if (url && !images.some(image => image.url === url)) {
      images.push({ url, size, ...(altText ? { altText } : {}) });
    }
  }
  return images;
}

function normalizeImages(sku) {
  const raw = sku?.skuImages;
  if (!object(raw)) return [];
  const result = [];
  for (const [key, value] of [['large', raw.imageUrl], ['medium', raw.image250], ['thumbnail', sku.smallImage]]) {
    const url = imageUrl(value);
    if (url && !result.some(image => image.url === url)) {
      result.push({ url, size: key, ...(text(raw.altText, 500) ? { altText: raw.altText } : {}) });
    }
  }
  return result;
}

function normalizeVariant(variant, productId) {
  if (!object(variant) || !SKU_ID.test(variant.skuId ?? '') ||
      typeof variant.isOutOfStock !== 'boolean' || !text(variant.listPrice, 80)) return null;
  const listPrice = usdMoney(variant.listPrice, 'retail_list');
  const salePrice = variant.salePrice === undefined ? null : usdMoney(variant.salePrice, 'sale');
  if (!listPrice || (variant.salePrice !== undefined && !salePrice)) return null;
  if (variant.targetUrl !== undefined && normalizeProductUrl(variant.targetUrl, productId, variant.skuId) === null) return null;
  const optionValues = Array.isArray(variant.skuRefinements)
    ? variant.skuRefinements.flatMap(refinement => {
      if (!object(refinement) || !text(refinement.key, 120)) return [];
      return (Array.isArray(refinement.values) ? refinement.values : []).flatMap(value =>
        text(value, 160)
          ? [{ name: refinement.key, value }]
          : []);
    }) : [];
  return {
    skuId: variant.skuId,
    variantId: variant.skuId,
    title: variant.variationValue ?? variant.displayName ?? variant.skuId,
    ...(text(variant.variationDesc, 300) ? { optionDescription: variant.variationDesc } : {}),
    ...(text(variant.variationTypeDisplayName, 80) ? { optionType: variant.variationTypeDisplayName } : {}),
    options: optionValues,
    listPrice,
    ...(salePrice ? { salePrice } : {}),
    price: salePrice ?? listPrice,
    availability: variant.isOutOfStock ? 'out_of_stock' : 'in_stock',
    images: normalizeImages(variant),
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

  const reviews = createSephoraReviewsClient({ fetchImpl, now });
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
      // The current anonymous endpoint returns its full 60-result page even
      // when the `page` size hint is smaller. Preserve every source result and
      // use the observed page width for pagination instead of rejecting it as
      // an oversized response or silently truncating products.
      const fixedPageSizeResponse = pageSize < MAX_PAGE_SIZE &&
        Array.isArray(payload?.products) && payload.products.length === MAX_PAGE_SIZE;
      const actualPageSize = fixedPageSizeResponse ? MAX_PAGE_SIZE : pageSize;
      if (!object(payload) || !text(payload.keyword, MAX_QUERY) ||
          payload.keyword.trim().toLowerCase() !== normalizedQuery.toLowerCase() ||
          !nonnegativeInt(payload.totalProducts) || !Array.isArray(payload.products) ||
          (payload.products.length > pageSize && !fixedPageSizeResponse) ||
          payload.products.length > MAX_PAGE_SIZE || payload.products.length > payload.totalProducts ||
          payload.products.some(item => !normalizeProduct(item))) {
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
        pageSize: actualPageSize,
        requestedPageSize: pageSize,
        totalProducts: payload.totalProducts,
        pageCount: payload.totalProducts === 0 ? 0 : Math.ceil(payload.totalProducts / actualPageSize),
        currency: 'USD',
        products,
        receipt: makeReceipt(read.request, true, true, {
          pageSize: actualPageSize,
          requestedPageSize: pageSize,
          productCount: products.length,
        }),
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
        pages.push(await this.searchProducts({ query, page, pageSize: first.pageSize, countryCode }));
      }
      const ids = pages.flatMap(result => result.products.map(item => item.productId));
      if (pages.some(result => result.totalProducts !== first.totalProducts || result.page !== pages.indexOf(result) + 1 ||
          result.pageSize !== first.pageSize) ||
          ids.length !== first.totalProducts || new Set(ids).size !== ids.length) {
        fail('SEPHORA_PAGINATION_SCHEMA_INVALID', first.receipt.request);
      }
      return {
        query: first.query,
        pageSize: first.pageSize,
        requestedPageSize: pageSize,
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

    async getProduct({ productId, skuId, countryCode = 'US' } = {}) {
      if (!PRODUCT_ID.test(productId ?? '') || (skuId !== undefined && !SKU_ID.test(skuId)) || countryCode !== 'US') {
        fail('SEPHORA_PRODUCT_INPUT_INVALID');
      }
      const query = [
        ['addCurrentSkuToProductChildSkus', 'true'],
        ['includeRegionsMap', 'true'],
        ['showContent', 'true'],
        ['includeConfigurableSku', 'true'],
        ['channel', 'RWD'],
        ['loc', 'en_US'],
        ['countryCode', countryCode],
        ...(skuId ? [['preferredSku', skuId]] : []),
        ['removePersonalizedData', 'true'],
        ['includeReviewFilters', 'true'],
        ['includeReviewImages', 'true'],
      ];
      const path = `/gway/v1/dotcom/productservice/v3/catalog/products/${productId}/lite`;
      let read;
      try {
        read = await commerceJsonRequest({
          service: 'sephora', origin: ORIGIN, path, method: 'GET', query, fetchImpl, now,
          maxBytes: MAX_RESPONSE_BYTES,
        });
      } catch (error) {
        if (error instanceof CommerceHttpError) fail(error.code, error.receipt);
        throw error;
      }
      const payload = read.payload;
      const currentSku = payload?.currentSku;
      const detail = payload?.productDetails;
      const rawRegular = payload?.regularChildSkus;
      const rawSale = payload?.onSaleChildSkus ?? [];
      if (!object(payload) || payload.productId !== productId || !object(detail) ||
          detail.productId !== productId || !object(currentSku) ||
          (skuId !== undefined && currentSku.skuId !== skuId) ||
          !Array.isArray(rawRegular) || !Array.isArray(rawSale) ||
          rawRegular.length + rawSale.length < 1 || rawRegular.length + rawSale.length > 1_000) {
        fail('SEPHORA_PRODUCT_SCHEMA_INVALID', read.request);
      }
      const variants = [...rawRegular, ...rawSale].map(item => normalizeVariant(item, productId));
      if (variants.some(item => item === null) || new Set(variants.map(item => item.skuId)).size !== variants.length) {
        fail('SEPHORA_PRODUCT_SCHEMA_INVALID', read.request);
      }
      const selected = normalizeVariant(currentSku, productId);
      if (!selected || !variants.some(item => item.skuId === selected.skuId)) {
        fail('SEPHORA_PRODUCT_SCHEMA_INVALID', read.request);
      }
      const productName = detail.displayName ?? currentSku.productName;
      if (!text(productName) || !text(detail.brand?.displayName ?? currentSku.brandName, 160)) {
        fail('SEPHORA_PRODUCT_SCHEMA_INVALID', read.request);
      }
      const description = [detail.shortDescription, detail.longDescription, detail.description]
        .find(value => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null;
      const product = {
        productId,
        title: productName,
        brandName: detail.brand?.displayName ?? currentSku.brandName,
        description,
        descriptionStatus: description === null ? 'not_returned_by_observed_product_api' : 'verified',
        productUrl: normalizeProductUrl(currentSku.targetUrl ?? payload.targetUrl, productId, currentSku.skuId),
        currency: 'USD',
        currentSku: selected,
        variants,
        variantCount: variants.length,
        onSaleVariantCount: rawSale.length,
      };
      const receipt = firstPartyReceipt(read.request, 'catalog.product_detail', PRODUCT_SERVICE_SOURCE,
        PRODUCT_SERVICE_SOURCE_SHA256, {
          requestedProductId: productId,
          productIdMatched: true,
          requestedSkuId: skuId ?? null,
          currentSkuMatched: skuId === undefined || currentSku.skuId === skuId,
        });
      return { product, receipts: [receipt], receipt };
    },

    async getReviews(options = {}) {
      return reviews.getReviews(options);
    },
  };
}
