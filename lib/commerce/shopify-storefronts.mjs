import { createHash } from 'node:crypto';
import { createAllbirdsPublicClient } from '../retail/shopify.mjs';

const COLOURPOP_ORIGIN = 'https://colourpop.com';
const OKENDO_ORIGIN = 'https://api.okendo.io';
const OKENDO_V1 = `${OKENDO_ORIGIN}/v1`;
const OKENDO_STORE_ID = '5419d3a5-7ff7-4bcf-ace6-31f3fa34803d';
const OKENDO_SOURCE_SHA = 'e2ef2d47fd999831dba203b628e09301cdc3bc78a121ff2505f68076d914f10e';
const PRODUCT_BYTES = 1024 * 1024;
const SEARCH_BYTES = 512 * 1024;
const REVIEW_BYTES = 2 * 1024 * 1024;
const CART_BYTES = 64 * 1024;
const MAX_VARIANTS = 250;
const MAX_IMAGES = 250;
const MAX_TEXT = 100_000;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STORES = Object.freeze(['allbirds', 'colourpop']);

export class ShopifyStorefrontError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'ShopifyStorefrontError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new ShopifyStorefrontError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const nullableText = value => value === null || value === undefined || text(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const usdDecimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(value);
const minor = amount => {
  if (!usdDecimal(amount)) return null;
  const [whole, fraction] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
};

function amountFromMinor(value) {
  return {
    amount: `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`,
    amountInApiUnits: value,
    currency: 'USD',
    minorUnitExponent: 2,
  };
}

function validVariant(variant) {
  if (!object(variant) || !integer(variant.id) || !text(variant.title) || !integer(variant.price) ||
      typeof variant.available !== 'boolean' ||
      !['option1', 'option2', 'option3'].every(key => nullableText(variant[key]))) return false;
  if (variant.sku !== undefined && !nullableText(variant.sku)) return false;
  if (variant.options !== undefined && (!Array.isArray(variant.options) || variant.options.length > 3 ||
      variant.options.some(value => !text(value)))) return false;
  if (variant.compare_at_price !== undefined && variant.compare_at_price !== null &&
      !integer(variant.compare_at_price)) return false;
  if (variant.inventory_quantity !== undefined && !Number.isSafeInteger(variant.inventory_quantity)) return false;
  if (variant.inventory_management !== undefined && !nullableText(variant.inventory_management)) return false;
  if (variant.inventory_policy !== undefined && !nullableText(variant.inventory_policy)) return false;
  if (variant.requires_shipping !== undefined && typeof variant.requires_shipping !== 'boolean') return false;
  if (variant.taxable !== undefined && typeof variant.taxable !== 'boolean') return false;
  if (variant.weight !== undefined && (!Number.isFinite(variant.weight) || variant.weight < 0)) return false;
  if (variant.featured_image !== undefined && variant.featured_image !== null &&
      safeShopifyImage(typeof variant.featured_image === 'string' ? variant.featured_image :
        variant.featured_image?.src) === null) return false;
  return true;
}

function safeShopifyImage(value) {
  if (!text(value)) return null;
  try {
    const parsed = new URL(value, 'https://cdn.shopify.com');
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.shopify.com' ||
        parsed.username || parsed.password || parsed.hash) return null;
    return parsed.toString();
  } catch { return null; }
}

function productDetailFields(product) {
  return {
    descriptionHtml: product.description ?? '',
    featuredImageUrl: product.featured_image ? safeShopifyImage(product.featured_image) : null,
    images: (product.images ?? []).map(safeShopifyImage),
    options: (product.options ?? []).map(option => ({
      name: option.name,
      position: option.position,
      values: [...option.values],
    })),
    tags: [...(product.tags ?? [])],
    requiresSellingPlan: product.requires_selling_plan ?? null,
  };
}

function variantDetailFields(variant) {
  const featuredImage = typeof variant.featured_image === 'string'
    ? variant.featured_image
    : variant.featured_image?.src;
  return {
    sku: variant.sku ?? null,
    options: Array.isArray(variant.options)
      ? [...variant.options]
      : [variant.option1, variant.option2, variant.option3].filter(value => value !== null && value !== undefined),
    compareAtPrice: variant.compare_at_price === undefined || variant.compare_at_price === null
      ? null : amountFromMinor(variant.compare_at_price),
    inventoryQuantity: variant.inventory_quantity ?? null,
    inventoryManagement: variant.inventory_management ?? null,
    inventoryPolicy: variant.inventory_policy ?? null,
    featuredImageUrl: featuredImage ? safeShopifyImage(featuredImage) : null,
    weightGrams: variant.weight ?? null,
    requiresShipping: variant.requires_shipping ?? null,
    taxable: variant.taxable ?? null,
  };
}

function okendoRequestUrl(productId, cursor, pageSize) {
  const productPath = `/v1/stores/${OKENDO_STORE_ID}/products/shopify-${productId}/reviews`;
  let url;
  if (cursor === undefined || cursor === null || cursor === '') {
    url = new URL(productPath, OKENDO_ORIGIN);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('orderBy', 'date desc');
  } else {
    if (typeof cursor !== 'string' || cursor.length > 20_000 || /[\x00-\x20]/.test(cursor)) {
      fail('SHOPIFY_REVIEW_CURSOR_INVALID');
    }
    // Okendo returns a relative /stores/... continuation. Its live storefront
    // resolves that source URL under /v1; accepting a same-origin absolute URL
    // also supports a browser-captured source continuation without rewriting it.
    const candidate = cursor.startsWith('/stores/')
      ? new URL(`${OKENDO_V1}${cursor}`, OKENDO_ORIGIN)
      : new URL(cursor, OKENDO_ORIGIN);
    if (candidate.origin !== OKENDO_ORIGIN || candidate.pathname !== productPath) {
      fail('SHOPIFY_REVIEW_CURSOR_INVALID');
    }
    url = candidate;
    const limit = url.searchParams.get('limit');
    if (limit !== String(pageSize)) fail('SHOPIFY_REVIEW_CURSOR_INVALID');
  }
  const keys = [...url.searchParams.keys()];
  if (url.origin !== OKENDO_ORIGIN || url.pathname !== productPath ||
      new Set(keys).size !== keys.length || keys.some(key => !['limit', 'orderBy', 'lastEvaluated'].includes(key)) ||
      url.searchParams.get('limit') !== String(pageSize) || url.searchParams.get('orderBy') !== 'date desc') {
    fail('SHOPIFY_REVIEW_CURSOR_INVALID');
  }
  return url;
}

function reviewPageCursor(nextUrl, productId) {
  if (nextUrl === undefined || nextUrl === null || nextUrl === '') return null;
  if (!text(nextUrl) || nextUrl.length > 20_000 || /[\x00-\x20]/.test(nextUrl)) {
    fail('SHOPIFY_REVIEW_SCHEMA_INVALID');
  }
  const productPath = `/v1/stores/${OKENDO_STORE_ID}/products/shopify-${productId}/reviews`;
  let parsed;
  try {
    parsed = nextUrl.startsWith('/stores/')
      ? new URL(`${OKENDO_V1}${nextUrl}`, OKENDO_ORIGIN)
      : new URL(nextUrl, OKENDO_ORIGIN);
  } catch { fail('SHOPIFY_REVIEW_SCHEMA_INVALID'); }
  const keys = [...parsed.searchParams.keys()];
  if (parsed.origin !== OKENDO_ORIGIN || parsed.pathname !== productPath ||
      new Set(keys).size !== keys.length || keys.some(key => !['limit', 'orderBy', 'lastEvaluated'].includes(key)) ||
      !/^[1-5]$/.test(parsed.searchParams.get('limit') ?? '') ||
      parsed.searchParams.get('orderBy') !== 'date desc' || !parsed.searchParams.has('lastEvaluated')) {
    fail('SHOPIFY_REVIEW_SCHEMA_INVALID');
  }
  // Keep the supplier's opaque continuation string byte-for-byte in the result.
  return nextUrl;
}

function validOkendoReview(review, handle, productId) {
  if (!object(review) || !text(review.reviewId) || typeof review.body !== 'string' ||
      review.body.length > MAX_TEXT || typeof (review.title ?? '') !== 'string' ||
      (review.title ?? '').length > MAX_TEXT ||
      !Number.isFinite(review.rating) || review.rating < 0 || review.rating > 5 ||
      !text(review.dateCreated) || Number.isNaN(Date.parse(review.dateCreated)) ||
      !nullableText(review.dateUpdated) ||
      (review.dateUpdated !== undefined && review.dateUpdated !== null && Number.isNaN(Date.parse(review.dateUpdated))) ||
      review.productId !== `shopify-${productId}` || review.productHandle !== handle ||
      (review.reviewer?.isVerified !== undefined && typeof review.reviewer.isVerified !== 'boolean') ||
      (review.media !== undefined && (!Array.isArray(review.media) || review.media.length > 100))) return false;
  return (review.media ?? []).every(item => !object(item) || item.type !== 'image' ||
    (safeOkendoImage(item.fullSizeUrl) !== null && nullableText(item.thumbnailUrl) &&
      (item.thumbnailUrl === undefined || item.thumbnailUrl === null || safeOkendoImage(item.thumbnailUrl) !== null) &&
      nullableText(item.alt)));
}

function safeOkendoImage(value) {
  if (!text(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'media-dynamic.okendo.io' ||
        parsed.username || parsed.password || parsed.hash) return null;
    return parsed.toString();
  } catch { return null; }
}

function validProductExtras(product) {
  if (product.description !== undefined && !nullableText(product.description)) return false;
  if (product.images !== undefined && (!Array.isArray(product.images) || product.images.length > MAX_IMAGES ||
      product.images.some(image => safeShopifyImage(image) === null))) return false;
  if (product.featured_image !== undefined && product.featured_image !== null &&
      safeShopifyImage(product.featured_image) === null) return false;
  if (product.options !== undefined && (!Array.isArray(product.options) || product.options.length > 3 ||
      product.options.some(option => !object(option) || !text(option.name) ||
        !integer(option.position) || !Array.isArray(option.values) || option.values.length > 250 ||
        option.values.some(value => !text(value))))) return false;
  if (product.tags !== undefined && (!Array.isArray(product.tags) || product.tags.length > 500 ||
      product.tags.some(tag => !text(tag)))) return false;
  if (product.requires_selling_plan !== undefined && typeof product.requires_selling_plan !== 'boolean') return false;
  return true;
}

function validProduct(product, handle) {
  if (!object(product) || !integer(product.id) || product.handle !== handle || !text(product.title) ||
      !text(product.vendor) || !text(product.type) || typeof product.available !== 'boolean' ||
      !integer(product.price) || !integer(product.price_min) || !integer(product.price_max) ||
      product.url !== `/products/${handle}` || product.price_min > product.price_max ||
      !validProductExtras(product) || !Array.isArray(product.variants) || product.variants.length < 1 ||
      product.variants.length > MAX_VARIANTS || product.variants.some(variant => !validVariant(variant))) return false;
  const ids = product.variants.map(variant => variant.id);
  return new Set(ids).size === ids.length &&
    (product.currency === undefined || /^[A-Z]{3}$/.test(product.currency));
}

function canonicalProductUrl(value, handle) {
  if (!text(value)) return null;
  try {
    const parsed = new URL(value, COLOURPOP_ORIGIN);
    if (parsed.origin !== COLOURPOP_ORIGIN || parsed.username || parsed.password || parsed.hash ||
        parsed.pathname !== `/products/${handle}`) return null;
    return `${COLOURPOP_ORIGIN}${parsed.pathname}`;
  } catch { return null; }
}

function validSearchProduct(product) {
  if (!object(product) || !integer(product.id) || !text(product.handle) ||
      product.handle.length > 120 || !HANDLE.test(product.handle) || !text(product.title) ||
      !text(product.vendor) || !text(product.type) || typeof product.available !== 'boolean' ||
      !usdDecimal(product.price) || !usdDecimal(product.price_min) || !usdDecimal(product.price_max) ||
      minor(product.price_min) > minor(product.price_max) ||
      canonicalProductUrl(product.url, product.handle) === null) return false;
  return product.currency === undefined || /^[A-Z]{3}$/.test(product.currency);
}

async function readBounded(response, limit, request) {
  if (!response.body?.getReader) fail('SHOPIFY_RESPONSE_INVALID', request);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        fail('SHOPIFY_RESPONSE_TOO_LARGE', { ...request, responseBytes: total });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total).toString('utf8');
}

function publicCurrencyReceipt(currency) {
  const { responseSha256: _discard, ...request } = currency.request;
  return { ...request, currency: currency.currency, itemCount: currency.itemCount };
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase() ?? null;
}

function makeReceipt(capabilityId, request, extra = {}) {
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'shopify-storefronts',
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    schemaVerified: true,
    expectedResultVerified: true,
    contractProvenance: {
      kind: 'first_party_documented_api',
      sourceURL: capabilityId.endsWith('predictive_search')
        ? 'https://shopify.dev/docs/api/ajax/reference/predictive-search'
        : 'https://shopify.dev/docs/api/ajax/reference/product',
    },
    request: { ...request, schemaVerified: true },
    ...extra,
  };
}

function normalizeAllbirdsResult(result, store, operation) {
  const currencyRequest = result.receipt.currencyRequest;
  const sanitizedCurrencyRequest = currencyRequest
    ? (({ responseSha256: _discard, ...request }) => request)(currencyRequest)
    : currencyRequest;
  return {
    ...result,
    receipt: {
      ...result.receipt,
      service: 'shopify-storefronts',
      capabilityId: `${store}.catalog.${operation}`,
      ...(sanitizedCurrencyRequest ? { currencyRequest: sanitizedCurrencyRequest } : {}),
    },
  };
}

export function createColourPopPublicClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SHOPIFY_CLIENT_INVALID');

  async function getJson(path, limit, query = []) {
    const url = new URL(path, COLOURPOP_ORIGIN);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const checkedAt = new Date(now()).toISOString();
    const base = {
      method: 'GET', origin: COLOURPOP_ORIGIN, path, checkedAt,
      browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false,
      ...(query.length ? { queryFields: query.map(([key]) => key) } : {}),
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      fail('SHOPIFY_TRANSPORT_FAILED', { ...base,
        causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
    }
    const mime = mimeOf(response);
    const request = { ...base, httpStatus: response.status, mime };
    if (response.status === 401) fail('SHOPIFY_AUTH_REQUIRED', request);
    if (response.status === 403) fail('SHOPIFY_ACCESS_BLOCKED', request);
    if (response.status === 429) fail('SHOPIFY_THROTTLED', request);
    if (response.status !== 200 || response.redirected ||
        !['application/json', 'text/javascript'].includes(mime)) {
      fail('SHOPIFY_RESPONSE_INVALID', request);
    }
    let raw;
    try { raw = await readBounded(response, limit, request); }
    catch (error) {
      if (error instanceof ShopifyStorefrontError) throw error;
      fail('SHOPIFY_TRANSPORT_FAILED', request);
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { fail('SHOPIFY_RESPONSE_INVALID', { ...request, responseBytes: Buffer.byteLength(raw) }); }
    return {
      payload,
      request: { ...request, responseBytes: Buffer.byteLength(raw),
        responseSha256: createHash('sha256').update(raw, 'utf8').digest('hex') },
    };
  }

  async function getOkendoJson(url, capabilityId, limit = REVIEW_BYTES) {
    const checkedAt = new Date(now()).toISOString();
    const base = {
      method: 'GET', origin: OKENDO_ORIGIN, path: url.pathname, checkedAt,
      queryFields: [...url.searchParams.keys()].sort(),
      browserUsed: false, anonymous: true, cookieSent: false, credentialsUsed: false,
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      fail('SHOPIFY_TRANSPORT_FAILED', { ...base,
        causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR' });
    }
    const mime = mimeOf(response);
    const request = { ...base, httpStatus: response.status, mime };
    if (response.status === 401) fail('SHOPIFY_AUTH_REQUIRED', request);
    if (response.status === 403) fail('SHOPIFY_ACCESS_BLOCKED', request);
    if (response.status === 429) fail('SHOPIFY_THROTTLED', request);
    if (response.status !== 200 || response.redirected || mime !== 'application/json') {
      fail('SHOPIFY_RESPONSE_INVALID', request);
    }
    let raw;
    try { raw = await readBounded(response, limit, request); }
    catch (error) {
      if (error instanceof ShopifyStorefrontError) throw error;
      fail('SHOPIFY_TRANSPORT_FAILED', request);
    }
    let payload;
    try { payload = JSON.parse(raw); }
    catch { fail('SHOPIFY_RESPONSE_INVALID', { ...request, responseBytes: Buffer.byteLength(raw) }); }
    return {
      payload,
      request: { ...request, capabilityId, responseBytes: Buffer.byteLength(raw),
        responseSha256: createHash('sha256').update(raw, 'utf8').digest('hex') },
    };
  }

  async function getUsdCurrency() {
    const read = await getJson('/cart.js', CART_BYTES);
    const cart = read.payload;
    if (!object(cart) || !/^[A-Z]{3}$/.test(cart.currency ?? '') ||
        !Number.isSafeInteger(cart.item_count) || cart.item_count < 0) {
      fail('SHOPIFY_CURRENCY_SCHEMA_INVALID', read.request);
    }
    if (cart.currency !== 'USD') fail('SHOPIFY_CURRENCY_UNSUPPORTED', read.request);
    // The response can include a cart token and cart contents. Only the currency and
    // empty/non-empty item count survive this boundary; no cart body is returned.
    return { currency: cart.currency, itemCount: cart.item_count, request: read.request };
  }

  return {
    async getProduct({ handle } = {}) {
      if (typeof handle !== 'string' || handle.length > 120 || !HANDLE.test(handle)) {
        fail('SHOPIFY_PRODUCT_HANDLE_INVALID');
      }
      const productRead = await getJson(`/products/${handle}.js`, PRODUCT_BYTES);
      if (!validProduct(productRead.payload, handle)) {
        fail('SHOPIFY_PRODUCT_SCHEMA_INVALID', productRead.request);
      }
      const currency = await getUsdCurrency();
      if (productRead.payload.currency !== undefined && productRead.payload.currency !== currency.currency) {
        fail('SHOPIFY_CURRENCY_MISMATCH', currency.request);
      }
      const product = productRead.payload;
      const variants = product.variants.map(variant => ({
        id: variant.id,
        title: variant.title,
        price: amountFromMinor(variant.price),
        available: variant.available,
        option1: variant.option1 ?? null,
        option2: variant.option2 ?? null,
        option3: variant.option3 ?? null,
      }));
      return {
        store: 'colourpop',
        product: {
          id: product.id,
          handle: product.handle,
          canonicalUrl: `${COLOURPOP_ORIGIN}${product.url}`,
          title: product.title,
          vendor: product.vendor,
          productType: product.type,
          available: product.available,
          price: amountFromMinor(product.price),
          priceRange: { min: amountFromMinor(product.price_min), max: amountFromMinor(product.price_max) },
          variants: variants.map((variant, index) => ({
            ...variant,
            ...variantDetailFields(product.variants[index]),
          })),
          ...productDetailFields(product),
        },
        receipt: makeReceipt('colourpop.catalog.product_detail', productRead.request, {
          productHandleMatched: true,
          variantCount: variants.length,
          currencyRequest: publicCurrencyReceipt(currency),
        }),
      };
    },

    async getReviews({ handle, pageSize = 5, cursor } = {}) {
      if (typeof handle !== 'string' || handle.length > 120 || !HANDLE.test(handle)) {
        fail('SHOPIFY_PRODUCT_HANDLE_INVALID');
      }
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5) {
        fail('SHOPIFY_REVIEW_INPUT_INVALID');
      }
      const productRead = await getJson(`/products/${handle}.js`, PRODUCT_BYTES);
      if (!validProduct(productRead.payload, handle)) {
        fail('SHOPIFY_PRODUCT_SCHEMA_INVALID', productRead.request);
      }
      const product = productRead.payload;
      const reviewsUrl = okendoRequestUrl(product.id, cursor, pageSize);
      if (reviewsUrl.searchParams.get('limit') !== String(pageSize)) {
        fail('SHOPIFY_REVIEW_CURSOR_INVALID');
      }
      const aggregateUrl = new URL(
        `/v1/stores/${OKENDO_STORE_ID}/products/shopify-${product.id}/review_aggregate`, OKENDO_ORIGIN);
      const [aggregateRead, reviewsRead] = await Promise.all([
        getOkendoJson(aggregateUrl, 'colourpop.catalog.review_aggregate', 128 * 1024),
        getOkendoJson(reviewsUrl, 'colourpop.catalog.reviews'),
      ]);
      const aggregate = aggregateRead.payload?.reviewAggregate;
      const rows = reviewsRead.payload?.reviews;
      if (!object(aggregate) || aggregate.productId !== `shopify-${product.id}` ||
          !integer(aggregate.reviewCount) || !integer(aggregate.reviewRatingValuesTotal) ||
          aggregate.reviewRatingValuesTotal > aggregate.reviewCount * 5 ||
          !Array.isArray(rows) || rows.length > pageSize ||
          reviewsRead.payload.areReviewsGrouped !== false ||
          rows.some(row => !validOkendoReview(row, handle, product.id))) {
        fail('SHOPIFY_REVIEW_SCHEMA_INVALID', {
          capabilityId: 'colourpop.catalog.reviews',
          request: { ...reviewsRead.request, schemaVerified: false },
        });
      }
      const nextCursor = reviewPageCursor(reviewsRead.payload.nextUrl, product.id);
      if (nextCursor) {
        const parsedCursor = nextCursor.startsWith('/stores/')
          ? new URL(`${OKENDO_V1}${nextCursor}`, OKENDO_ORIGIN)
          : new URL(nextCursor, OKENDO_ORIGIN);
        if (parsedCursor.searchParams.get('limit') !== String(pageSize)) {
          fail('SHOPIFY_REVIEW_SCHEMA_INVALID', {
            capabilityId: 'colourpop.catalog.reviews',
            request: { ...reviewsRead.request, schemaVerified: false },
          });
        }
      }
      const reviewCount = aggregate.reviewCount;
      return {
        store: 'colourpop',
        handle,
        productId: product.id,
        totalReviews: reviewCount,
        averageRating: reviewCount > 0
          ? Math.round((aggregate.reviewRatingValuesTotal / reviewCount) * 100) / 100
          : null,
        pageSize,
        reviews: rows.map(review => ({
          reviewId: review.reviewId,
          title: review.title ?? '',
          body: review.body,
          rating: review.rating,
          postedAt: review.dateCreated,
          updatedAt: review.dateUpdated ?? null,
          verifiedPurchase: null,
          sourceVerification: {
            provider: 'okendo',
            field: 'reviewer.isVerified',
            value: review.reviewer?.isVerified ?? null,
          },
          images: (review.media ?? []).filter(media => object(media) && media.type === 'image')
            .map(media => ({
              url: safeOkendoImage(media.fullSizeUrl),
              thumbnailUrl: media.thumbnailUrl ? safeOkendoImage(media.thumbnailUrl) : null,
              alt: media.alt ?? null,
            })),
        })),
        nextCursor,
        hasMore: nextCursor !== null,
        receipt: {
          schema: 'web-api-public-read-receipt-v1',
          service: 'shopify-storefronts',
          capabilityId: 'colourpop.catalog.reviews',
          checkedAt: reviewsRead.request.checkedAt,
          secretsPersistedInEvidence: false,
          anonymous: true,
          credentialsUsed: false,
          authenticated: false,
          schemaVerified: true,
          expectedResultVerified: true,
          productHandleMatched: true,
          productIdMatched: true,
          reviewProductTargetMatched: true,
          reviewCount: rows.length,
          totalReviews: reviewCount,
          nextCursorPresent: nextCursor !== null,
          paginationVerified: true,
          contractProvenance: {
            kind: 'browser_xhr_observed',
            sourceURL: 'https://colourpop.com/products/eeveelution-shadow-palette',
            sourceSha: OKENDO_SOURCE_SHA,
            vendor: 'Okendo',
          },
          productRequest: {
            ...productRead.request,
            schemaVerified: true,
            productHandleMatched: true,
          },
          aggregateRequest: {
            ...aggregateRead.request,
            schemaVerified: true,
            productIdMatched: true,
          },
          request: {
            ...reviewsRead.request,
            schemaVerified: true,
            productIdMatched: true,
            reviewArrayVerified: true,
            returnedReviewCount: rows.length,
          },
        },
      };
    },

    async searchProducts({ query, limit = 5 } = {}) {
      if (!text(query) || query.trim().length < 1 || query.trim().length > 100 ||
          /[\x00-\x1f\x7f]/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 10) {
        fail('SHOPIFY_SEARCH_INPUT_INVALID');
      }
      const normalized = query.trim();
      const searchRead = await getJson('/search/suggest.json', SEARCH_BYTES, [
        ['q', normalized],
        ['resources[type]', 'product'],
        ['resources[limit]', String(limit)],
        ['resources[options][unavailable_products]', 'hide'],
      ]);
      const products = searchRead.payload?.resources?.results?.products;
      if (!object(searchRead.payload) || !object(searchRead.payload.resources) ||
          !object(searchRead.payload.resources.results) || !Array.isArray(products) ||
          products.length > limit || products.some(product => !validSearchProduct(product)) ||
          new Set(products.map(product => product.id)).size !== products.length ||
          new Set(products.map(product => product.handle)).size !== products.length) {
        fail('SHOPIFY_SEARCH_SCHEMA_INVALID', searchRead.request);
      }
      const currency = await getUsdCurrency();
      if (products.some(product => product.currency !== undefined && product.currency !== currency.currency)) {
        fail('SHOPIFY_CURRENCY_MISMATCH', currency.request);
      }
      return {
        store: 'colourpop',
        query: normalized,
        products: products.map(product => ({
          id: product.id,
          handle: product.handle,
          canonicalUrl: canonicalProductUrl(product.url, product.handle),
          title: product.title,
          vendor: product.vendor,
          productType: product.type,
          available: product.available,
          price: { amount: product.price, currency: currency.currency, minorUnitExponent: 2 },
          priceRange: {
            min: { amount: product.price_min, currency: currency.currency, minorUnitExponent: 2 },
            max: { amount: product.price_max, currency: currency.currency, minorUnitExponent: 2 },
          },
        })),
        receipt: makeReceipt('colourpop.catalog.predictive_search', searchRead.request, {
          productCount: products.length,
          currencyRequest: publicCurrencyReceipt(currency),
        }),
      };
    },
  };
}

export function createShopifyStorefrontClient({ store = 'allbirds', ...options } = {}) {
  if (store === 'allbirds') {
    const client = createAllbirdsPublicClient(options);
    return {
      async getProduct(input) {
        return normalizeAllbirdsResult(await client.getProduct(input), store, 'product_detail');
      },
      async searchProducts(input) {
        return normalizeAllbirdsResult(await client.searchProducts(input), store, 'predictive_search');
      },
      async getReviews({ handle } = {}) {
        if (typeof handle !== 'string' || handle.length > 120 || !HANDLE.test(handle)) {
          fail('SHOPIFY_PRODUCT_HANDLE_INVALID');
        }
        fail('SHOPIFY_REVIEW_SOURCE_DISABLED', {
          schema: 'web-api-public-read-receipt-v1',
          service: 'shopify-storefronts',
          capabilityId: 'allbirds.catalog.reviews',
          origin: 'https://www.allbirds.com',
          path: `/products/${handle}`,
          blocker: 'The current Allbirds page exposes a Yotpo placeholder but explicitly reports yotpoEnabled=false; no review-body API request was observed.',
          anonymous: true,
          credentialsUsed: false,
          browserUsed: false,
          sourceAssessmentBrowserUsed: true,
          secretsPersistedInEvidence: false,
        });
      },
    };
  }
  if (store === 'colourpop') return createColourPopPublicClient(options);
  fail('SHOPIFY_STORE_UNSUPPORTED');
}

export function createShopifyStorefronts(options = {}) {
  return Object.freeze({
    stores: STORES,
    forStore(store) { return createShopifyStorefrontClient({ store, ...options }); },
    async getProduct({ store = 'allbirds', ...input } = {}) {
      return createShopifyStorefrontClient({ store, ...options }).getProduct(input);
    },
    async searchProducts({ store = 'allbirds', ...input } = {}) {
      return createShopifyStorefrontClient({ store, ...options }).searchProducts(input);
    },
    async getReviews({ store = 'allbirds', ...input } = {}) {
      return createShopifyStorefrontClient({ store, ...options }).getReviews(input);
    },
  });
}
