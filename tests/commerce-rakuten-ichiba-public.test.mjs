import test from 'node:test';
import assert from 'node:assert/strict';
import { createRakutenIchibaPublicClient } from '../lib/commerce/rakuten-ichiba-public.mjs';

const REVIEW_URL = 'https://review.rakuten.co.jp/item/1/319501_10000000/1.1/';
const PRODUCT_URL = 'https://item.rakuten.co.jp/kinujo/001/';
const FRONTEND_KEY = 'synthetic-public-frontend-key-for-test';
const IMAGE_URL = 'https://image.space.rakuten.co.jp/d/strg/ctrl/9/abcdef123456.jpg';
const NOW = Date.parse('2026-10-05T00:00:00.000Z');
const BUNDLE_PATH = '/com/review/front/assets/app/pages/review/javascript/pc-synthetic-version.bundle.js';
const ENDPOINT = 'https://web-gateway.rakuten.co.jp/review/itemshopreviewlist/get/v1';

const bundle = `var REVIEW_FEATURES={public:{endpoints:{bff:{itemShopReviewList:{name:"itemshopreviewlist",url:"${ENDPOINT}",authkey:"${FRONTEND_KEY}",features:{ITEM_INFO:"itemInfo",SHOP_INFO:"shopInfo",ITEM_REVIEW_LIST:"itemReviewList",SHOP_REVIEW_LIST:"shopReviewList",MEDIA_REVIEW_LIST:"mediaReviewList"}}}}}};`;

function html(reviewUrl = REVIEW_URL) {
  return `<!doctype html><html><head><meta charset="utf-8"><script src="https://r.r10s.jp${BUNDLE_PATH}"></script></head><body>
    <input name="shop_bid" value="319501"><input name="item_id" value="10000000"><input name="shopurl" value="kinujo">
    <a href="${reviewUrl}">すべてのレビューを見る（427件）</a>
  </body></html>`;
}

function row(overrides = {}) {
  return {
    rating: 5,
    title: 'レビュー題名',
    body: '使用感がよく、満足しています。',
    postDate: '2026/10/04',
    orderDate: '2026/09/30',
    helpfulCount: 3,
    revSubkey: '1234567890',
    nickname: 'private-name-must-not-leak',
    encryptedRevKey: 'opaque-private-review-key',
    key: 'opaque-row-key',
    media: [{ id: 'opaque-media-id', reviewKey: 'opaque-review-key', thumbnail: IMAGE_URL, type: 1 }],
    ...overrides,
  };
}

function responseJson(value, status = 207) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function reviewPayload({ reviews = [row()], count = reviews.length, hasNextPage = false, status = 'SUCCESS' } = {}) {
  return { status, body: { itemReviewList: { data: { reviews, count, hasNextPage } } } };
}

function harness(onReview, productPageHtml = html()) {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.get('cookie'), null);
    if (url.origin === 'https://item.rakuten.co.jp') {
      assert.equal(url.pathname, '/kinujo/001/');
      assert.equal(init.method, 'GET');
      return new Response(productPageHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.origin === 'https://review.rakuten.co.jp') {
      assert.equal(url.pathname, '/item/1/319501_10000000/1.1/');
      assert.equal(init.method, 'GET');
      return new Response(html(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.origin === 'https://r.r10s.jp') {
      assert.equal(url.pathname, BUNDLE_PATH);
      assert.equal(init.method, 'GET');
      return new Response(bundle, { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8' } });
    }
    assert.equal(url.origin, 'https://web-gateway.rakuten.co.jp');
    assert.equal(url.pathname, '/review/itemshopreviewlist/get/v1');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('authkey'), FRONTEND_KEY);
    assert.equal(url.search, '');
    return onReview(url, init);
  };
  const client = createRakutenIchibaPublicClient({ fetchImpl, now: () => NOW });
  return { client, requests };
}

test('resolves anonymous public review target from exact item-page hidden IDs and embedded review link', async () => {
  const mock = harness(() => responseJson(reviewPayload()));
  const target = await mock.client.resolveReviewTarget({ productUrl: PRODUCT_URL, itemCode: 'kinujo:001' });
  assert.deepEqual({ shopId: target.shopId, itemId: target.itemId, targetKey: target.targetKey,
    reviewUrl: target.reviewUrl, targetVerified: target.targetVerified }, {
    shopId: '319501', itemId: '10000000', targetKey: '319501:10000000',
    reviewUrl: REVIEW_URL, targetVerified: true,
  });
  assert.equal(target.requestedShopCodeMatched, true);
  assert.equal(target.itemCodePathMatched, true);
  assert.equal(target.receipt.source, 'first_party_public_product_document_bootstrap_only');
  assert.equal(JSON.stringify(target).includes(FRONTEND_KEY), false);
  assert.equal(mock.requests.length, 1);
});

test('reads full review fields with page and media filters using current bundle bootstrap and no cookies', async () => {
  const mock = harness((url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.common, { params: { device: 'pc' }, include: ['itemReviewList'] });
    assert.equal(body.features.itemReviewList.params.shopId, 319501);
    assert.equal(body.features.itemReviewList.params.itemId, 10000000);
    assert.equal(body.features.itemReviewList.params.hits, 30);
    assert.equal(body.features.itemReviewList.params.page, '2');
    assert.equal(body.features.itemReviewList.params.filter.mediaOnly, 'false');
    assert.equal(init.headers.get('origin'), 'https://review.rakuten.co.jp');
    assert.equal(init.headers.get('referer'), REVIEW_URL);
    return responseJson(reviewPayload({ reviews: [row()], count: 427, hasNextPage: true }));
  });
  const result = await mock.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL, page: 2 });
  assert.equal(result.productId, '319501:10000000');
  assert.equal(result.targetKey, '319501:10000000');
  assert.equal(result.productIdMatched, true);
  assert.equal(result.pagination.nextPage, 3);
  assert.equal(result.total, 427);
  assert.equal(result.nextCursor, 3);
  assert.equal(result.paginationVerified, true);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.pagination.totalReviews, 427);
  assert.equal(result.reviews[0].rating, 5);
  assert.equal(result.reviews[0].reviewId, '1234567890');
  assert.equal(result.reviews[0].identityKind, 'native_review_id');
  assert.equal(result.reviews[0].reviewIdSource, 'revSubkey');
  assert.equal(result.reviews[0].body, '使用感がよく、満足しています。');
  assert.equal(result.reviews[0].postDate, '2026/10/04');
  assert.deepEqual(result.reviews[0].media, [{ thumbnailUrl: IMAGE_URL, type: 1, mediaKind: 'image' }]);
  assert.equal(result.receipt.schema, 'web-api-public-read-receipt-v1');
  assert.equal(result.receipt.request.httpStatus, 207);
  assert.equal(result.receipt.request.readOnly, true);
  assert.equal(result.receipt.credentialsUsed, false);
  assert.equal(result.receipt.userCredentialsUsed, false);
  assert.equal(result.receipt.publicFrontendKeyUsed, true);
  assert.equal(result.receipt.request.cookieSent, false);
  assert.equal(result.receipt.publicFrontendBootstrap.valuePersisted, false);
  assert.equal(result.receipt.productTargetBootstrap, undefined);
  assert.equal(JSON.stringify(result).includes(FRONTEND_KEY), false);
  assert.equal(JSON.stringify(result).includes('private-name-must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('opaque-private-review-key'), false);
  assert.equal(JSON.stringify(result).includes('opaque-row-key'), false);
  assert.deepEqual(mock.requests.map(x => x.url.origin), [
    'https://review.rakuten.co.jp', 'https://r.r10s.jp', 'https://web-gateway.rakuten.co.jp',
  ]);
});

test('reuses the in-memory bootstrap key for sequential pagination without persisting it', async () => {
  const mock = harness((url, init) => {
    const body = JSON.parse(init.body);
    const page = Number(body.features.itemReviewList.params.page);
    return responseJson(reviewPayload({ reviews: [row({ title: `Page ${page}` })], count: 61, hasNextPage: page < 3 }));
  });
  const page1 = await mock.client.getReviews({ shopId: 319501, itemId: 10000000, reviewUrl: REVIEW_URL, page: 1 });
  const page2 = await mock.client.getReviews({ shopId: 319501, itemId: 10000000, reviewUrl: REVIEW_URL, page: 2 });
  assert.equal(page1.reviews[0].title, 'Page 1');
  assert.equal(page2.reviews[0].title, 'Page 2');
  assert.equal(page1.pagination.nextPage, 2);
  assert.equal(page2.pagination.nextPage, 3);
  assert.equal(page2.receipt.capabilityId, 'catalog.public_review_pagination');
  assert.equal(mock.requests.filter(x => x.url.origin === 'https://review.rakuten.co.jp').length, 1);
  assert.equal(mock.requests.filter(x => x.url.origin === 'https://r.r10s.jp').length, 1);
  assert.equal(mock.requests.filter(x => x.url.origin === 'https://web-gateway.rakuten.co.jp').length, 2);
  assert.equal(page2.receipt.publicFrontendBootstrap.reusedInProcess, true);
  assert.equal(JSON.stringify([page1, page2]).includes(FRONTEND_KEY), false);
});

test('media-only review filter returns photo thumbnails and records the exact observed filter', async () => {
  const mock = harness((url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.features.itemReviewList.params.filter.mediaOnly, 'true');
    return responseJson(reviewPayload({ reviews: [row()], count: 18, hasNextPage: false }));
  });
  const result = await mock.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL, mediaOnly: true });
  assert.equal(result.mediaOnly, true);
  assert.equal(result.pagination.totalReviews, 18);
  assert.equal(result.pagination.hasNextPage, false);
  assert.equal(result.receipt.capabilityId, 'catalog.public_review_photos');
  assert.equal(result.receipt.result.returnedMedia, 1);
});

test('classifies media type 2 as video and leaves undocumented media types unknown', async () => {
  const mock = harness(() => responseJson(reviewPayload({ reviews: [row({ media: [
    { thumbnail: IMAGE_URL, type: 2 }, { thumbnail: IMAGE_URL, type: 9 },
  ] })] })));
  const result = await mock.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL });
  assert.deepEqual(result.reviews[0].media.map(x => x.mediaKind), ['video', 'unknown']);
});

test('uses a content fingerprint only when the source omits native revSubkey and marks coverage ambiguous', async () => {
  const mock = harness(() => responseJson(reviewPayload({ reviews: [row({ revSubkey: undefined })], count: 1, hasNextPage: false })));
  const result = await mock.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL });
  assert.match(result.reviews[0].reviewId, /^[a-f0-9]{64}$/);
  assert.equal(result.reviews[0].identityKind, 'content_fingerprint');
  assert.equal(result.paginationVerified, true);
  assert.equal(result.receipt.result.deduplicationExact, false);
  assert.equal(result.receipt.result.completeForFilter, false);
});

test('binds caller product page and review URL identities before returning a verified read', async () => {
  const mock = harness((url, init) => responseJson(reviewPayload()));
  const result = await mock.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL,
    productUrl: PRODUCT_URL, itemCode: 'kinujo:001' });
  assert.equal(result.productIdMatched, true);
  assert.equal(result.receipt.productIdMatched, true);
  assert.equal(result.receipt.productTargetBootstrap.reviewUrlMatched, true);
  assert.equal(mock.requests.filter(x => x.url.origin === 'https://item.rakuten.co.jp').length, 1);
  assert.equal(mock.requests.filter(x => x.url.origin === 'https://review.rakuten.co.jp').length, 1);
});

test('rejects malformed target identities, API failures, partial bodies, and key leakage without exposing secrets', async () => {
  const mock = harness(() => responseJson(reviewPayload()));
  await assert.rejects(mock.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: 'https://review.rakuten.co.jp/item/1/319501_10000001/1.1/' }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_REVIEW_TARGET_IDENTITY_MISMATCH');
  await assert.rejects(mock.client.getReviews({ shopId: 'nope', itemId: '10000000', reviewUrl: REVIEW_URL }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_REVIEW_IDENTITY_REQUIRED');
  await assert.rejects(mock.client.getReviews({ shopId: '99999999999999999999', itemId: '10000000', reviewUrl: REVIEW_URL }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_REVIEW_IDENTITY_REQUIRED');
  await assert.rejects(mock.client.getReviews({ shopId: '0319501', itemId: '10000000', reviewUrl: REVIEW_URL }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_REVIEW_IDENTITY_REQUIRED');
  assert.equal(mock.requests.length, 0, 'unsafe numeric identities are rejected before network access');

  const failed = harness(() => responseJson({ status: 'FAILURE', body: {} }));
  await assert.rejects(failed.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_REVIEW_API_STATUS_INVALID' &&
      !JSON.stringify(error.receipt).includes(FRONTEND_KEY));

  const badRow = harness(() => responseJson(reviewPayload({ reviews: [row({ rating: 9 })] })));
  await assert.rejects(badRow.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_REVIEW_RATING_INVALID');

  const keyEcho = harness(() => responseJson(reviewPayload({ reviews: [row({ body: FRONTEND_KEY })] })));
  await assert.rejects(keyEcho.client.getReviews({ shopId: '319501', itemId: '10000000', reviewUrl: REVIEW_URL }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_REVIEW_RESPONSE_CONTAINS_PUBLIC_KEY' &&
      !JSON.stringify(error.receipt).includes(FRONTEND_KEY));
});

test('does not claim a bootstrap target when the page shop or embedded review href disagrees', async () => {
  const wrongShop = harness(() => responseJson(reviewPayload()));
  await assert.rejects(wrongShop.client.resolveReviewTarget({ productUrl: 'https://item.rakuten.co.jp/other-shop/001/', itemCode: 'kinujo:001' }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_PRODUCT_SHOP_CODE_MISMATCH');
  const wrongHref = harness(() => responseJson(reviewPayload()),
    html('https://review.rakuten.co.jp/item/1/319501_10000001/1.1/'));
  await assert.rejects(wrongHref.client.resolveReviewTarget({ productUrl: PRODUCT_URL }),
    error => error.code === 'RAKUTEN_ICHIBA_PUBLIC_PRODUCT_REVIEW_LINK_IDENTITY_UNVERIFIED');
});
