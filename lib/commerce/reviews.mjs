import { sanitizedRequestReceipt } from './snapshots.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const text = (value, max) => typeof value === 'string' && value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const identifier = value => text(value, 256) && value.trim().length > 0 && !/[\r\n\t]/.test(value);
const opaqueCursor = value => text(value, 8192) && value.trim().length > 0 && !/[\r\n\t]/.test(value);
export function safeReviewCursor(value) {
  if (value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (!opaqueCursor(value)) fail('REVIEW_CURSOR_INVALID');
  if (value.startsWith('/') || /^https?:\/\//i.test(value)) {
    const url = new URL(value, 'https://cursor.invalid');
    if (url.username || url.password || [...url.searchParams.keys()].some(key => /key|token|auth|cookie|secret|signature/i.test(key))) {
      fail('REVIEW_CURSOR_CONTAINS_CREDENTIAL_FIELD');
    }
  }
  return value;
}

export function sanitizedCatalogReceipt(value) {
  const receipt = sanitizedRequestReceipt(value);
  if (!receipt) return null;
  return { ...receipt, ...Object.fromEntries(['readOnly', 'publicFrontendKeyUsed', 'userCredentialsUsed', 'noUserCredentials',
    'shopIdMatched', 'itemIdMatched', 'productHandleMatched'].filter(key => typeof value[key] === 'boolean')
    .map(key => [key, value[key]])) };
}

function imageUrl(value) {
  const source = typeof value === 'string' ? value : object(value) ? value.url : null;
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 8192) fail('REVIEW_IMAGE_INVALID');
    return url.href;
  } catch { fail('REVIEW_IMAGE_INVALID'); }
}

/** Keep public review content, not reviewer account/profile identifiers. */
export function normalizeReview(value) {
  if (!object(value) || !identifier(value.reviewId) || !Object.hasOwn(value, 'body') || value.body !== null && !text(value.body, 100_000) ||
      !Array.isArray(value.images ?? []) || (value.images ?? []).length > 100) fail('REVIEW_SCHEMA_INVALID');
  const rating = value.rating ?? null;
  if (rating !== null && !(typeof rating === 'number' && Number.isFinite(rating) && rating >= 0 ||
      typeof rating === 'string' && /^(?:0|[1-9]\d{0,3})(?:\.\d{1,8})?$/.test(rating))) fail('REVIEW_RATING_INVALID');
  for (const key of ['title', 'postedAt', 'locale', 'variantLabel']) {
    if (value[key] != null && !text(value[key], key === 'title' ? 2000 : 256)) fail('REVIEW_SCHEMA_INVALID');
  }
  if (value.verifiedPurchase != null && typeof value.verifiedPurchase !== 'boolean') fail('REVIEW_SCHEMA_INVALID');
  if (value.ratingScale != null && !(typeof value.ratingScale === 'number' && Number.isFinite(value.ratingScale) && value.ratingScale > 0)) fail('REVIEW_RATING_INVALID');
  if (value.ratingScale != null && rating != null && Number(rating) > value.ratingScale) fail('REVIEW_RATING_INVALID');
  const identityKind = value.identityKind ?? 'native_review_id';
  if (!['native_review_id', 'content_fingerprint', 'page_position'].includes(identityKind)) fail('REVIEW_IDENTITY_KIND_INVALID');
  return {
    reviewId: value.reviewId, identityKind, body: value.body ?? '', bodyAvailable: typeof value.body === 'string' && value.body.trim().length > 0,
    title: value.title ?? null,
    rating, ratingScale: value.ratingScale ?? null, images: [...new Set((value.images ?? []).map(imageUrl))],
    postedAt: value.postedAt ?? null, verifiedPurchase: value.verifiedPurchase ?? null,
    locale: value.locale ?? null, variantLabel: value.variantLabel ?? null,
  };
}

/** Pagination comes from the provider; review counts never imply a next page. */
export async function collectReviews({ provider, productId, loadPage, maxPages = 3, maxReviews = 100, maxBytes = 32 * 1024 * 1024, initialCursor = null, initialSkipIds = [], now = Date.now } = {}) {
  if (!identifier(provider) || !identifier(productId) || typeof loadPage !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
      !Number.isSafeInteger(maxReviews) || maxReviews < 1 || maxReviews > 50_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 ||
      !Array.isArray(initialSkipIds) || initialSkipIds.length > 2000 || initialSkipIds.some(id => !identifier(id))) fail('REVIEW_COLLECTION_INPUT_INVALID');
  const reviews = new Map(), cursors = new Set(), receipts = [];
  let cursor = safeReviewCursor(initialCursor), nextCursor = null, pagesRead = 0, rowsSeen = 0, total = null, sourceExhausted = false,
    paginationVerified = true, capHit = false, conflictingDuplicateCount = 0, bytesStored = 0, continuation = null;
  let skip = new Set(initialSkipIds);
  while (pagesRead < maxPages) {
    const result = await loadPage({ cursor, remaining: maxReviews - reviews.size });
    if (!object(result) || !Array.isArray(result.reviews) || result.productIdMatched !== true ||
        result.productId !== productId || !Object.hasOwn(result, 'nextCursor')) fail('REVIEW_COLLECTION_PAGE_INVALID');
    if (result.total != null && (!Number.isSafeInteger(result.total) || result.total < 0)) fail('REVIEW_COLLECTION_PAGE_INVALID');
    if (result.total != null) {
      if (total !== null && total !== result.total) paginationVerified = false;
      total = result.total;
    }
    paginationVerified &&= result.paginationVerified === true;
    pagesRead++; rowsSeen += result.reviews.length;
    const processedIds = new Set(skip);
    let pageTruncated = false;
    for (const item of result.reviews) {
      const review = normalizeReview(item), existing = reviews.get(review.reviewId);
      if (skip.has(review.reviewId)) continue;
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(review)) conflictingDuplicateCount++;
        processedIds.add(review.reviewId);
        continue;
      }
      if (reviews.size >= maxReviews) { capHit = true; pageTruncated = true; break; }
      const bytes = Buffer.byteLength(JSON.stringify(review));
      if (bytesStored + bytes > maxBytes) { capHit = true; pageTruncated = true; break; }
      bytesStored += bytes;
      reviews.set(review.reviewId, review);
      processedIds.add(review.reviewId);
    }
    receipts.push(...(result.receipts ?? []).map(sanitizedCatalogReceipt).filter(Boolean));
    const next = safeReviewCursor(result.nextCursor); nextCursor = next;
    if (pageTruncated) {
      if (processedIds.size > 2000) fail('REVIEW_RESUME_PAGE_TOO_LARGE');
      continuation = { cursor, skipReviewIds: [...processedIds] };
      break;
    }
    skip = new Set();
    if (next === null) { sourceExhausted = true; break; }
    const key = JSON.stringify(next);
    if (cursors.has(key) || key === JSON.stringify(cursor)) fail('REVIEW_PAGINATION_CYCLE');
    cursors.add(key);
    if (capHit || reviews.size >= maxReviews) { capHit = true; continuation = { cursor: next, skipReviewIds: [] }; break; }
    cursor = next;
    continuation = { cursor: next, skipReviewIds: [] };
  }
  if (!sourceExhausted && pagesRead >= maxPages) capHit = true;
  const count = reviews.size, totalMatched = total === null ? null : total === count;
  return {
    schema: 'web-api-product-reviews-v1', provider, productId,
    checkedAt: new Date(now()).toISOString(), executionMode: 'pure_http', browserUsed: false,
    credentialsUsed: receipts.some(receipt => receipt.credentialsUsed === true), secretsPersistedInEvidence: false,
    collection: { count, pagesRead, rowsSeen, total, totalMatched, sourceExhausted, paginationVerified, capHit, bytesStored, maxBytes,
      startedAtBeginning: initialCursor === null && initialSkipIds.length === 0, nextCursor,
      continuation: sourceExhausted ? null : continuation,
      conflictingDuplicateCount, bodyCount: [...reviews.values()].filter(review => review.body.trim()).length,
      imageReviewCount: [...reviews.values()].filter(review => review.images.length > 0).length,
      identityUnverifiedCount: [...reviews.values()].filter(review => review.identityKind !== 'native_review_id').length,
      complete: initialCursor === null && initialSkipIds.length === 0 && sourceExhausted && paginationVerified && !capHit && !conflictingDuplicateCount &&
        totalMatched !== false && [...reviews.values()].every(review => review.identityKind === 'native_review_id') },
    reviews: [...reviews.values()], receipts,
  };
}

const cell = value => {
  let str = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(str)) str = "'" + str;
  return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
};
export function reviewsCsv(result) {
  if (result?.schema !== 'web-api-product-reviews-v1' || !Array.isArray(result.reviews)) fail('REVIEW_CSV_INPUT_INVALID');
  const rows = [['provider', 'product_id', 'review_id', 'body', 'title', 'rating', 'rating_scale', 'images_json',
    'posted_at', 'verified_purchase', 'locale', 'variant_label']];
  for (const value of result.reviews) {
    const review = normalizeReview(value);
    rows.push([result.provider, result.productId, review.reviewId, review.body, review.title, review.rating,
      review.ratingScale, JSON.stringify(review.images), review.postedAt, review.verifiedPurchase, review.locale, review.variantLabel]);
  }
  return rows.map(row => row.map(cell).join(',')).join('\n') + '\n';
}
