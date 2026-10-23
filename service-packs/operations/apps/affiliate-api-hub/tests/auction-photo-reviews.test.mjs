import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuctionPhotoReviews, readAuctionPhotoReviews } from '../adapters/auction-photo-reviews.mjs';

const card = (id = 1) => `<div class="box__review-item js-box__review-item" id="review_${id}"><div class="box__content"><div class="box__info"><div class="box__star"><span class="for-a11y">4점</span></div><p class="text__writer">IDENTITY_SENTINEL</p><p class="text__date">2026.09.25</p></div><span class="text__option-selected">선택 A</span><div class="box__review-text js-box__review-text"><p class="text">상세 리뷰 본문</p></div><button><span class="text__count js-text__count">12</span></button></div></div>`;
const response = (html, status = 200, headers = {}) => new Response(html, { status, headers: { 'content-type': 'text/html', ...headers } });
const productUrl = 'https://itempage3.auction.co.kr/DetailView.aspx?itemno=A1';

test('photo detail response retains full review content and excludes writer identity', () => {
  const reviews = parseAuctionPhotoReviews(card());
  assert.equal(reviews[0].reviewId, '1'); assert.equal(reviews[0].text, '상세 리뷰 본문');
  assert.equal(reviews[0].rating, 4); assert.equal(reviews[0].publishedDate, '2026-09-25'); assert.equal(reviews[0].helpfulCount, 12);
  assert.doesNotMatch(JSON.stringify(reviews), /IDENTITY_SENTINEL/);
  assert.throws(() => parseAuctionPhotoReviews('<html>login</html>'), { code: 'AUCTION_PHOTO_EMPTY_OR_SCHEMA' });
  assert.throws(() => parseAuctionPhotoReviews(card().replace('4점', 'unknown')), { code: 'AUCTION_PHOTO_ITEM_SCHEMA' });
});

test('photo pages use observed public GET only and deduplicate overlapping reviews', async () => {
  const calls = [];
  const result = await readAuctionPhotoReviews({ productUrl, maxPages: 2, fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://bamboo.auction.co.kr'); assert.equal(url.pathname, '/Review/Review/PhotoViewerReviewList');
    assert.deepEqual([...url.searchParams.keys()], ['ItemNo', 'PageIndex']); assert.equal(options.headers.cookie, undefined); assert.equal(options.redirect, 'manual');
    calls.push(url.searchParams.get('PageIndex'));
    return response(calls.length === 1 ? card(1) + card(2) : card(2) + card(3));
  } });
  assert.deepEqual(calls, ['1', '2']); assert.equal(result.reviewCount, 3); assert.equal(result.duplicateCount, 1);
  assert.equal(result.pagination.complete, false); assert.equal(result.pagination.nextPageCandidate, 3); assert.equal(result.state.live_replay, false);
});

test('wrong product origin, challenges and duplicate pages fail without retries', async () => {
  let calls = 0;
  await assert.rejects(readAuctionPhotoReviews({ productUrl: 'https://other.test/DetailView.aspx?itemno=A1', fetchImpl: async () => { calls++; } }), { code: 'PRODUCT_URL_SCOPE' });
  assert.equal(calls, 0);
  await assert.rejects(readAuctionPhotoReviews({ productUrl, fetchImpl: async () => { calls++; return response('challenge', 403, { 'cf-mitigated': 'challenge' }); } }), { code: 'SITE_CHALLENGE' });
  assert.equal(calls, 1);
  await assert.rejects(readAuctionPhotoReviews({ productUrl, maxPages: 2, fetchImpl: async () => response(card(1)) }), { code: 'PAGINATION_NO_PROGRESS' });
});
