import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReviews, normalizeReview, reviewsCsv, safeReviewCursor } from '../lib/commerce/reviews.mjs';

const item = (id, body = 'Actual review\nsecond line') => ({ reviewId: id, body, rating: 4, ratingScale: 5,
  images: ['https://images.example.com/review.jpg'], postedAt: '2026-10-05', reviewerAccountId: 'excluded-profile' });
const page = (reviews, nextCursor, extra = {}) => ({ reviews, nextCursor, productId: 'p1', productIdMatched: true,
  paginationVerified: true, receipts: [{ method: 'GET', origin: 'https://example.com', path: '/reviews',
    httpStatus: 200, browserUsed: false, credentialsUsed: false, authorization: 'excluded-token' }], ...extra });

test('review collection follows explicit cursors, deduplicates IDs, and keeps multiline body/images', async () => {
  const seen = [];
  const result = await collectReviews({ provider: 'example', productId: 'p1', loadPage: async ({ cursor }) => {
    seen.push(cursor);
    return cursor === null ? page([item('a'), item('b')], 2, { total: 3 }) : page([item('b'), item('c')], null, { total: 3 });
  } });
  assert.deepEqual(seen, [null, 2]); assert.equal(result.collection.count, 3);
  assert.equal(result.collection.rowsSeen, 4); assert.equal(result.collection.complete, true);
  assert.equal(result.reviews[0].body, 'Actual review\nsecond line');
  assert.equal(JSON.stringify(result).includes('excluded-'), false);
  assert.equal(result.reviews[0].verifiedPurchase, null);
});

test('ratings do not substitute for review bodies or imply verified purchases', () => {
  const review = normalizeReview({ reviewId: 'r', body: '', rating: '4.5', images: [] });
  assert.equal(review.body, ''); assert.equal(review.verifiedPurchase, null); assert.equal(review.ratingScale, null);
  assert.equal(normalizeReview({ reviewId: 'r', body: null, rating: 4 }).bodyAvailable, false);
  assert.throws(() => normalizeReview({ reviewId: 'r', rating: 4 }), { code: 'REVIEW_SCHEMA_INVALID' });
});

test('a page or review budget leaves the collection incomplete', async () => {
  const capped = await collectReviews({ provider: 'example', productId: 'p1', maxReviews: 1,
    loadPage: async () => page([item('a'), item('b')], null) });
  assert.equal(capped.collection.count, 1); assert.equal(capped.collection.capHit, true);
  assert.equal(capped.collection.complete, false);
  const pageCapped = await collectReviews({ provider: 'example', productId: 'p1', maxPages: 1,
    loadPage: async () => page([item('a')], 2) });
  assert.equal(pageCapped.collection.complete, false); assert.equal(pageCapped.collection.sourceExhausted, false);
  const bytesCapped = await collectReviews({ provider: 'example', productId: 'p1', maxBytes: 10,
    loadPage: async () => page([item('a')], null) });
  assert.equal(bytesCapped.collection.count, 0); assert.equal(bytesCapped.collection.capHit, true);
  assert.equal(bytesCapped.collection.complete, false);
});

test('unknown pagination, changing total, and changed duplicate content prevent completion', async () => {
  const unknown = await collectReviews({ provider: 'example', productId: 'p1', loadPage: async () => page([item('a')], null,
    { paginationVerified: false }) });
  assert.equal(unknown.collection.complete, false);
  const changed = await collectReviews({ provider: 'example', productId: 'p1', loadPage: async ({ cursor }) =>
    cursor === null ? page([item('a')], 2, { total: 1 }) : page([item('a', 'changed')], null, { total: 2 }) });
  assert.equal(changed.collection.complete, false); assert.equal(changed.collection.conflictingDuplicateCount, 1);
});

test('wrong product, missing continuation, and cursor cycles fail explicitly', async () => {
  const run = loadPage => collectReviews({ provider: 'example', productId: 'p1', loadPage });
  await assert.rejects(run(async () => page([item('a')], null, { productId: 'p2' })), { code: 'REVIEW_COLLECTION_PAGE_INVALID' });
  await assert.rejects(run(async () => ({ reviews: [], productId: 'p1', productIdMatched: true })), { code: 'REVIEW_COLLECTION_PAGE_INVALID' });
  await assert.rejects(run(async () => page([item('a')], 2)), { code: 'REVIEW_PAGINATION_CYCLE' });
});

test('bounded runs expose a safe continuation and a resumed tail cannot claim full coverage', async () => {
  const first = await collectReviews({ provider: 'example', productId: 'p1', maxPages: 1,
    loadPage: async () => page([item('a')], 2, { total: 2 }) });
  assert.equal(first.collection.nextCursor, 2);
  const tail = await collectReviews({ provider: 'example', productId: 'p1', initialCursor: 2,
    loadPage: async ({ cursor }) => { assert.equal(cursor, 2); return page([item('b')], null, { total: 2 }); } });
  assert.equal(tail.collection.sourceExhausted, true); assert.equal(tail.collection.startedAtBeginning, false);
  assert.equal(tail.collection.complete, false);
  assert.throws(() => safeReviewCursor('https://example.com/reviews?apikey=fixture'), { code: 'REVIEW_CURSOR_CONTAINS_CREDENTIAL_FIELD' });
  const truncated = await collectReviews({ provider: 'example', productId: 'p1', maxReviews: 1,
    loadPage: async () => page([item('a'), item('b')], null, { total: 2 }) });
  assert.deepEqual(truncated.collection.continuation, { cursor: null, skipReviewIds: ['a'] });
  const remaining = await collectReviews({ provider: 'example', productId: 'p1', initialCursor: truncated.collection.continuation.cursor,
    initialSkipIds: truncated.collection.continuation.skipReviewIds, loadPage: async () => page([item('a'), item('b')], null, { total: 2 }) });
  assert.deepEqual(remaining.reviews.map(review => review.reviewId), ['b']);
  assert.equal(remaining.collection.complete, false);
});

test('CSV keeps newline/photo payloads, and neutralizes spreadsheet formulas', () => {
  const csv = reviewsCsv({ schema: 'web-api-product-reviews-v1', provider: 'example', productId: 'p1',
    reviews: [item('r', '=SUM(1,2)\nquote: "text"')] });
  assert.ok(csv.includes('"\'=SUM(1,2)\nquote: ""text"""'));
  assert.ok(csv.includes('https://images.example.com/review.jpg')); assert.equal(csv.includes('excluded-profile'), false);
  assert.throws(() => normalizeReview({ ...item('r'), images: ['https://user:pass@example.com/a'] }), { code: 'REVIEW_IMAGE_INVALID' });
});

test('associated Olive Young reviews preserve the original product identity through JSON and CSV', async () => {
  const row = { ...item('r'), sourceProductId: 'GA999', variantId: 'sku-1', associatedProductReview: true, helpfulCount: 7 };
  const result = await collectReviews({ provider: 'oliveyoung-global', productId: 'p1', loadPage: async () => page([row], null) });
  assert.equal(result.reviews[0].sourceProductId, 'GA999'); assert.equal(result.reviews[0].associatedProductReview, true);
  assert.equal(result.collection.associatedProductReviewCount, 1);
  const csv = reviewsCsv(result);
  assert.ok(csv.includes('source_product_id,variant_id,associated_product_review,helpful_count'));
  assert.ok(csv.includes('GA999,sku-1,true,7'));
});
