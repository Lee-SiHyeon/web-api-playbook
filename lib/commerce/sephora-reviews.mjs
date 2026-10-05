import { commerceJsonRequest, CommerceHttpError } from './http.mjs';

const STOREFRONT = 'https://www.sephora.com';
const BAZAARVOICE = 'https://api.bazaarvoice.com';
const BOOTSTRAP_PATH = '/';
const REVIEWS_PATH = '/data/reviews.json';
const REVIEW_SOURCE = 'https://www.sephora.com/js/ufe/isomorphic/commons.chunk.B22CoriginmasterD20260922192852.js';
const REVIEW_SOURCE_SHA256 = '42da169b63c165086d4a6203752123dca4bee1db30b76a6f208c19bcfb3bec42';
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const PRODUCT_ID = /^P\d{4,12}$/;
const SKU_ID = /^\d{3,16}$/;

export class SephoraReviewsError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'SephoraReviewsError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt) => { throw new SephoraReviewsError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, max = 100_000) => typeof value === 'string' && value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

async function readBounded(response, limit) {
  if (!response.body?.getReader) fail('SEPHORA_REVIEW_BODY_UNREADABLE');
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
        fail('SEPHORA_REVIEW_RESPONSE_TOO_LARGE', { responseBytes: total });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

function mimeOf(response) {
  return response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

function parsePublicReviewConfig(html) {
  const marker = 'bvApi_rwdRating_desktop_read';
  const index = html.indexOf(marker);
  if (index < 0) fail('SEPHORA_REVIEW_CONFIG_MISSING');
  const snippet = html.slice(index, Math.min(html.length, index + 1_600));
  const field = name => snippet.match(new RegExp(`["']?${name}["']?\\s*:\\s*["']([^"']+)["']`, 'i'))?.[1] ?? null;
  const host = field('host');
  const publicKey = field('token');
  const version = field('version');
  if (host !== 'api.bazaarvoice.com' || typeof publicKey !== 'string' ||
      publicKey.length < 20 || publicKey.length > 256 || /[\s\x00-\x1f\x7f]/.test(publicKey) ||
      !/^\d+\.\d+$/.test(version ?? '')) fail('SEPHORA_REVIEW_CONFIG_INVALID');
  return { host, publicKey, version };
}

async function fetchPublicReviewConfig({ fetchImpl, now }) {
  const checkedAt = new Date(now()).toISOString();
  let response;
  try {
    response = await fetchImpl(`${STOREFRONT}${BOOTSTRAP_PATH}`, {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9' },
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    fail('SEPHORA_REVIEW_BOOTSTRAP_TRANSPORT_FAILED', {
      method: 'GET', origin: STOREFRONT, path: BOOTSTRAP_PATH, checkedAt,
      browserUsed: false, anonymous: true, credentialsUsed: false, cookieSent: false,
      causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
    });
  }
  const mime = mimeOf(response);
  const base = {
    method: 'GET', origin: STOREFRONT, path: BOOTSTRAP_PATH, checkedAt,
    httpStatus: response.status, mime, browserUsed: false, anonymous: true,
    credentialsUsed: false, cookieSent: false,
  };
  if (response.status !== 200 || response.redirected || mime !== 'text/html') {
    await response.body?.cancel().catch(() => {});
    fail('SEPHORA_REVIEW_BOOTSTRAP_HTTP_ERROR', base);
  }
  const raw = await readBounded(response, MAX_BOOTSTRAP_BYTES);
  let html;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { fail('SEPHORA_REVIEW_BOOTSTRAP_SCHEMA_INVALID', { ...base, responseBytes: raw.length }); }
  const config = parsePublicReviewConfig(html);
  return {
    config,
    request: { ...base, responseBytes: raw.length, schemaVerified: true },
  };
}

function productFamily(productEntity) {
  const values = productEntity?.Attributes?.BV_FE_FAMILY?.Values;
  if (!Array.isArray(values)) return null;
  return values.map(value => value?.Value).find(value => typeof value === 'string' && PRODUCT_ID.test(value)) ?? null;
}

function safeImageUrl(value) {
  if (!text(value, 4_000)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(url.hostname === 'bazaarvoice.com' || url.hostname.endsWith('.bazaarvoice.com'))) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

function reviewImages(review) {
  if (!Array.isArray(review.Photos)) return [];
  return review.Photos.slice(0, 20).flatMap(photo => {
    if (!object(photo) || !object(photo.Sizes)) return [];
    const sizes = photo.Sizes;
    const chosen = sizes.large ?? sizes.normal ?? sizes.thumbnail;
    const url = safeImageUrl(chosen?.Url);
    if (!url) return [];
    const thumbnailUrl = safeImageUrl(sizes.thumbnail?.Url);
    return [{ url, ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(text(photo.Caption, 500) ? { caption: photo.Caption } : {}) }];
  });
}

function normalizeReview(review, requestedProductId, includesProducts, requestedSkuId) {
  const body = review?.ReviewText ?? '';
  if (!object(review) || !/^\d{1,24}$/.test(String(review.Id ?? '')) ||
      !/^(?:P\d{4,12}|\d{3,16})$/.test(String(review.ProductId ?? '')) || !Number.isFinite(Number(review.Rating)) ||
      Number(review.Rating) < 0 || Number(review.Rating) > 5 ||
      !text(body, 100_000) || typeof review.SubmissionTime !== 'string' ||
      !Number.isFinite(Date.parse(review.SubmissionTime))) return null;
  const skuId = String(review.ProductId);
  const familyId = PRODUCT_ID.test(skuId) ? skuId : productFamily(includesProducts[skuId]);
  if (familyId !== requestedProductId || (requestedSkuId && skuId !== requestedSkuId)) return null;
  return {
    reviewId: String(review.Id),
    productId: requestedProductId,
    ...(SKU_ID.test(skuId) ? { variantId: skuId } : {}),
    body,
    bodyAvailable: body.trim().length > 0,
    rating: Number(review.Rating),
    postedAt: new Date(review.SubmissionTime).toISOString(),
    images: reviewImages(review),
    ...(review.IsRatingsOnly === true ? { isRatingsOnly: true } : {}),
    ...(text(review.Title, 2_000) && review.Title.length ? { title: review.Title } : {}),
  };
}

function reviewReceipt(request, bootstrapRequest, sourceSha256, result, pagination, capabilityId) {
  const { responseSha256: _discard, ...safeRequest } = request;
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'sephora',
    capabilityId,
    checkedAt: request.checkedAt,
    secretsPersistedInEvidence: false,
    anonymous: true,
    authenticated: false,
    credentialsUsed: false,
    publicApiKeyUsed: true,
    publicApiKeyPersisted: false,
    schemaVerified: true,
    expectedResultVerified: result.productIdMatched,
    contractProvenance: {
      kind: 'first_party_bundle_contract',
      sourceURL: REVIEW_SOURCE,
      sourceSha256,
    },
    request: { ...safeRequest, schemaVerified: true },
    publicKeyBootstrap: { ...bootstrapRequest, schemaVerified: true },
    productIdMatched: result.productIdMatched,
    sourceFilter: result.sourceFilter,
    pagination,
  };
}

/** Anonymous Bazaarvoice review reads. The publicly embedded passkey is loaded
 * from Sephora's own landing HTML into process memory and never returned or saved. */
export function createSephoraReviewsClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('SEPHORA_REVIEW_CLIENT_INVALID');
  let bootstrapPromise;
  const getConfig = async () => {
    if (!bootstrapPromise) {
      bootstrapPromise = fetchPublicReviewConfig({ fetchImpl, now }).catch(error => {
        bootstrapPromise = undefined;
        throw error;
      });
    }
    return bootstrapPromise;
  };

  return {
    async getReviews({ productId, skuId, page = 1, pageSize = 20, countryCode = 'US' } = {}) {
      if (!PRODUCT_ID.test(productId ?? '') ||
          (skuId !== undefined && !SKU_ID.test(skuId)) ||
          !positiveInt(page) || page > 10_000 || !positiveInt(pageSize) || pageSize > 100 || countryCode !== 'US') {
        fail('SEPHORA_REVIEW_INPUT_INVALID');
      }
      const offset = (page - 1) * pageSize;
      if (!Number.isSafeInteger(offset) || offset > 1_000_000) fail('SEPHORA_REVIEW_INPUT_INVALID');
      const { config, request: bootstrapRequest } = await getConfig();
      const query = [
        ['Filter', `ProductId:${skuId ?? productId}`],
        ['Filter', 'contentlocale:en*'],
        ['Limit', String(pageSize)],
        ['Offset', String(offset)],
        ['Include', 'Products,Comments'],
        ['Stats', 'Reviews'],
        ...(skuId ? [['ExcludeFamily', 'True']] : []),
        ['passkey', config.publicKey],
        ['apiversion', config.version],
        ['Locale', 'en_US'],
      ];
      let read;
      try {
        read = await commerceJsonRequest({
          service: 'sephora', origin: BAZAARVOICE, path: REVIEWS_PATH, method: 'GET', query,
          fetchImpl, now, maxBytes: MAX_REVIEW_BYTES,
        });
      } catch (error) {
        if (error instanceof CommerceHttpError) fail(error.code, error.receipt);
        throw error;
      }
      const payload = read.payload;
      const rawResults = payload?.Results;
      const totalReviews = payload?.TotalResults;
      const includesProducts = payload?.Includes?.Products;
      if (!object(payload) || payload.HasErrors === true || !Array.isArray(rawResults) ||
          !nonnegativeInt(totalReviews) || payload.Limit !== pageSize || payload.Offset !== offset ||
          !object(includesProducts) || rawResults.length > pageSize) {
        fail('SEPHORA_REVIEW_SCHEMA_INVALID', read.request);
      }
      const normalized = rawResults.map(item => normalizeReview(item, productId, includesProducts, skuId));
      if (normalized.some(item => item === null)) fail('SEPHORA_REVIEW_IDENTITY_MISMATCH', read.request);
      const reviews = normalized;
      const expectedCount = Math.max(0, Math.min(pageSize, totalReviews - offset));
      const hasMore = offset + reviews.length < totalReviews;
      const pagination = {
        page,
        pageSize,
        offset,
        totalReviews,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
        verified: reviews.length === expectedCount,
      };
      if (!pagination.verified) fail('SEPHORA_REVIEW_PAGINATION_SCHEMA_INVALID', read.request);
      const result = {
        productId,
        ...(skuId ? { skuId } : {}),
        totalReviews,
        productIdMatched: true,
        sourceFilter: skuId ? `ProductId:${skuId};ExcludeFamily:True` : `ProductId:${productId}`,
        reviews,
        pagination,
      };
      const receipt = reviewReceipt(read.request, bootstrapRequest, REVIEW_SOURCE_SHA256, result, pagination,
        page === 1 ? 'catalog.reviews.read' : 'catalog.reviews.pagination');
      return { ...result, receipts: [receipt], receipt };
    },
  };
}
