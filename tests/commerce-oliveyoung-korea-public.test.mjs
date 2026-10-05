import test from 'node:test';
import assert from 'node:assert/strict';
import { createOliveyoungKoreaPublicClient } from '../lib/commerce/oliveyoung-korea-public.mjs';

const GOODS = 'A000000263510';
const json = (value, status = 200, mime = 'application/json; charset=utf-8') =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': mime } });

function createClient(replies, options = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const key = init.method + ' ' + url.origin + url.pathname;
    const reply = replies[key];
    assert.ok(reply, 'unexpected request ' + key);
    return typeof reply === 'function' ? reply({ url, init }) : reply;
  };
  return {
    calls,
    client: createOliveyoungKoreaPublicClient({
      fetchImpl,
      now: () => new Date('2026-10-05T00:00:00.000Z'),
      ...options,
    }),
  };
}

const row = (id, overrides = {}) => ({
  GOODS_NO: id,
  GOODS_NM: '라운드랩 자작나무 수분 선크림',
  ONL_BRND_NM: '라운드랩',
  DISP_CAT_NO: '10000010001',
  GOODS_SOUT_INFO: 'N',
  SALE_PRC: 24500,
  SUP_PRC: 25000,
  NORM_PRC: 30000,
  DSCNT_YN: 'Y',
  ITEM_CNT: 2,
  ...overrides,
});

test('search sends the observed form contract and maps price branches without selecting a variant price', async () => {
  const { client, calls } = createClient({
    'POST https://www.oliveyoung.co.kr/store/search/NewMainSearchApi.do': json({
      Data: [{
        CollName: 'OLIVE_GOODS',
        TotalCount: '30',
        Count: 3,
        Result: [
          row(GOODS),
          row('A000000263511', { SALE_PRC: 10000, SUP_PRC: 15000, NORM_PRC: 10000, DSCNT_YN: 'Y', ITEM_CNT: 1 }),
          row('A000000263512', { SALE_PRC: 10000, SUP_PRC: 12000, NORM_PRC: 10000, DSCNT_YN: 'N', ITEM_CNT: 1 }),
        ],
      }],
      Parameter: [{ suggestQuery: null, reQuery: null, realQuery: '선크림' }],
    }),
  });

  const result = await client.searchProducts({
    query: '선크림', page: 2, pageSize: 24,
    formState: { quickYn: 'N', typeChk: '' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://www.oliveyoung.co.kr');
  assert.equal(calls[0].url.pathname, '/store/search/NewMainSearchApi.do');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.headers.get('content-type'), 'application/x-www-form-urlencoded; charset=UTF-8');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('query'), '선크림');
  assert.equal(body.get('collection'), 'OLIVE_GOODS,OLIVE_PLAN,OLIVE_EVENT,OLIVE_BRAND,OLIVE_QUICK_LINK');
  assert.equal(body.get('displayMediaTypes'), '02');
  assert.equal(body.get('listnum'), '24');
  assert.equal(body.get('startCount'), '24');
  assert.equal(body.get('quickYn'), 'N');
  assert.equal(body.get('typeChk'), '');

  assert.equal(result.products.length, 3);
  assert.equal(result.products[0].productId, GOODS);
  assert.equal(result.products[0].brand, '라운드랩');
  assert.deepEqual(result.products[0].price, {
    amount: '24500', currency: 'KRW', minorUnitExponent: 0,
    kind: 'retail_current', sourceField: 'SALE_PRC',
  });
  assert.deepEqual(result.products[0].listPrice, {
    amount: '25000', currency: 'KRW', minorUnitExponent: 0,
    kind: 'retail_list', sourceField: 'SUP_PRC',
  });
  assert.equal(result.products[0].discountRate, '18.33');
  assert.equal(result.products[0].priceContext.optionRangeHint, true);
  assert.equal(result.products[0].priceContext.selectedVariantPrice, false);
  assert.equal(result.products[1].price.sourceField, 'NORM_PRC');
  assert.equal(result.products[2].price.sourceField, 'SUP_PRC');
  assert.equal(result.products[2].listPrice, undefined);
  assert.equal(result.totalProducts, 30);
  assert.equal(result.pagination.hasNext, true);
  assert.equal(result.pagination.nextPage, 3);
  assert.equal(result.pagination.terminationVerified, false);
  assert.equal(result.complete, false);
  assert.equal(result.receipts[0].request.responseProductMatched, null);
  assert.equal(JSON.stringify(result.receipts).includes('선크림'), false);
});

test('detail binds IDs, fetches source-backed description and extras, and strips active description content', async () => {
  const goodsData = {
    goodsNumber: GOODS,
    goodsName: '라운드랩 자작나무 수분 선크림',
    onlineBrandName: '라운드랩',
    displayCategory: { leafCategoryName: '선크림', lowerCategoryName: '선케어' },
    onlineBrand: 'B00001',
    supplier: 'S00001',
    tradeCode: 'TRADE',
    leadTime: 0,
    goodsTypeCode: '01',
    deliveryFreeFlag: false,
    orderableMinimumQuantity: 1,
    goodsSectionCode: '10',
    deliveryPolicyNumber: 'D1',
    salePrice: 24500,
    finalPrice: 24500,
    maxBenefitPrice: 23000,
    options: [{
      optionNumber: '1',
      standardCode: 'SKU-1',
      brand: '라운드랩',
      representFlag: true,
      standardCategory: { lowerCategory: '10000010001' },
      discountApplyFlag: true,
      todayDeliveryFlag: false,
      soldOutFlag: false,
      reservationFlag: true,
      unitInfo: { price: 24500, priceUnit: '50ml' },
    }],
  };
  const { client, calls } = createClient({
    'GET https://www.oliveyoung.co.kr/goods/api/v1/detail': json({ data: goodsData }),
    'GET https://www.oliveyoung.co.kr/goods/api/v1/description': json({
      data: {
        descriptionContents: '<p>보습 선크림</p><script>discard this</script><img src="https://image.oliveyoung.co.kr/detail.png">',
        descriptionTypeCode: 'HTML',
        goodsDetailImages: ['/goods/detail-a.png'],
      },
    }),
    'POST https://www.oliveyoung.co.kr/goods/api/v1/extra': json({
      data: {
        goodsNumber: GOODS,
        optionDetail: { goodsNumber: GOODS, allSoldOutFlag: false, optionList: [{
          optionNumber: '1', standardCode: 'SKU-1', brand: '라운드랩',
          representFlag: true, soldOutFlag: false, unitInfo: { price: 24500, priceUnit: '50ml' },
        }] },
        reviewInfoDto: { goodsNo: GOODS, reviewCnt: 100, reviewAvgScore: 4.8, photoReviews: [] },
      },
    }),
  });

  const result = await client.getProduct({ goodsNumber: GOODS, displayCategoryNumber: '10000010001' });
  assert.deepEqual(calls.map(call => call.url.pathname), [
    '/goods/api/v1/detail', '/goods/api/v1/description', '/goods/api/v1/extra',
  ]);
  assert.equal(calls[0].url.searchParams.get('goodsNo'), GOODS);
  assert.equal(calls[0].url.searchParams.get('dispCatNo'), '10000010001');
  assert.equal(calls[0].url.searchParams.get('appFlag'), 'false');
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    goodsNumber: GOODS, deliveryFreeFlag: false, leadTime: 0, goodsTypeCode: '01', tradeCode: 'TRADE',
    supplier: 'S00001', onlineBrand: 'B00001', orderableMinimumQuantity: 1, deliveryPolicyNumber: 'D1',
    todayDeliveryCheckedFlag: false, options: [{
      optionNumber: '1', standardCode: 'SKU-1', brand: '라운드랩', representFlag: true,
      lowerCategoryNumber: '10000010001', discountApplyFlag: true, todayDeliveryFlag: false,
      soldOutFlag: false, reservationFlag: true,
    }], goodsSectionCode: '10', appFlag: false,
  });
  assert.equal(result.productId, GOODS);
  assert.equal(result.title, '라운드랩 자작나무 수분 선크림');
  assert.equal(result.availability, 'available');
  assert.equal(result.description, '보습 선크림');
  assert.equal(result.description.includes('discard this'), false);
  assert.equal(result.options[0].sku, 'SKU-1');
  assert.equal(result.images.some(image => image.url === 'https://image.oliveyoung.co.kr/detail.png'), true);
  assert.equal(result.reviewSummary.count, 100);
  assert.equal(result.priceFields.displayMappingVerified, false);
});

test('detail fails closed on a wrong identity and does not make dependent requests', async () => {
  const { client, calls } = createClient({
    'GET https://www.oliveyoung.co.kr/goods/api/v1/detail': json({
      data: { goodsNumber: 'A000000000001', goodsName: 'wrong', options: [] },
    }),
  });
  await assert.rejects(client.getProduct({ goodsNumber: GOODS }),
    { code: 'OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_SCHEMA_INVALID' });
  assert.equal(calls.length, 1);
});

test('detail refuses to invent reservation context for limited options', async () => {
  const { client, calls } = createClient({
    'GET https://www.oliveyoung.co.kr/goods/api/v1/detail': json({
      data: { goodsNumber: GOODS, goodsName: 'item', options: [{
        optionNumber: '1', reservationFlag: false, limitedInfoDto: { sourceOnly: true },
      }] },
    }),
  });
  await assert.rejects(client.getProduct({ goodsNumber: GOODS }),
    { code: 'OLIVEYOUNG_KOREA_PUBLIC_EXTRA_LIMIT_RULE_UNVERIFIED' });
  assert.equal(calls.length, 1);
});

test('reviews use the observed first-page request and return an explicit cursor without reviewer identity', async () => {
  const { client, calls } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/cursor': json({
      totalCnt: 2,
      data: {
        goodsReviewList: [{
          reviewId: 'R1',
          content: '<p>좋아요<script>secret-review-script</script></p>',
          goodsDto: { goodsNumber: GOODS, itemNumber: '1', goodsName: '상품', optionName: '50ml' },
          reviewScore: 5,
          reviewType: 'NORMAL',
          isRepurchase: true,
          createdDateTime: '2026-10-05T00:00:00Z',
          photoReviewList: [{ imageSequence: 1, imagePath: '/photo-1.png' }],
          profileDto: { memberId: 'private-profile-id' },
        }],
        hasNext: true,
        nextCursorId: 'cursor-1',
        nextCursorScore: 100,
        nextCursorCount: 10,
        loginRequired: false,
      },
    }),
  });
  const result = await client.getReviews({ goodsNumber: GOODS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://m.oliveyoung.co.kr');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.get('origin'), 'https://www.oliveyoung.co.kr');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    goodsNumber: GOODS, size: 10, sortType: 'USEFUL_SCORE_DESC', reviewType: 'ALL', page: 0,
  });
  assert.equal(result.reviews[0].body, '좋아요');
  assert.equal(result.reviews[0].productRelation, 'requested_product');
  assert.equal(result.reviews[0].photos[0].imagePath, '/photo-1.png');
  assert.deepEqual(result.continuation, { cursorId: 'cursor-1', cursorScore: 100, cursorCount: 10 });
  assert.equal(result.hasNext, true);
  assert.equal(JSON.stringify(result).includes('private-profile-id'), false);
  assert.equal(JSON.stringify(result).includes('secret-review-script'), false);
});

test('review continuation uses cursor fields and omits the first-page offset', async () => {
  const { client, calls } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/cursor': json({
      totalCnt: 0,
      data: { goodsReviewList: [], hasNext: false, loginRequired: false },
    }),
  });
  const result = await client.getReviews({
    goodsNumber: GOODS,
    continuation: { cursorId: 'cursor-1', cursorScore: 100, cursorCount: 10 },
  });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.page, undefined);
  assert.deepEqual(body, {
    goodsNumber: GOODS, size: 10, sortType: 'USEFUL_SCORE_DESC', reviewType: 'ALL',
    cursorId: 'cursor-1', cursorScore: 100, cursorCount: 10,
  });
  assert.equal(result.continuation, null);
  assert.equal(result.hasNext, false);
});

test('review collection deduplicates cursor pages and stops only at hasNext false', async () => {
  let count = 0;
  const replies = async () => {
    count++;
    return json({
      totalCnt: 2,
      data: count === 1 ? {
        goodsReviewList: [{
          reviewId: 'R1', content: 'one', goodsDto: { goodsNumber: GOODS }, reviewScore: 5,
        }],
        hasNext: true, nextCursorId: 'C1', nextCursorScore: 10, nextCursorCount: 1,
      } : {
        goodsReviewList: [
          { reviewId: 'R1', content: 'one', goodsDto: { goodsNumber: GOODS }, reviewScore: 5 },
          { reviewId: 'R2', content: 'two', goodsDto: { goodsNumber: GOODS }, reviewScore: 4 },
        ],
        hasNext: false,
      },
    });
  };
  const { client } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/cursor': replies,
  });
  const result = await client.collectReviews({ goodsNumber: GOODS, maxPages: 5 });
  assert.equal(count, 2);
  assert.deepEqual(result.reviews.map(review => review.reviewId), ['R1', 'R2']);
  assert.equal(result.complete, true);
  assert.equal(result.terminationReason, 'source_terminal');
});

test('photo reviews use zero-based API pages and verified last-page metadata', async () => {
  const { client, calls } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/photo-reviews': json({
      data: [{
        reviewId: 'R1', createdDateTime: '2026-10-05T00:00:00Z',
        photoReviewList: [{ imageSequence: 1, imagePath: '/photo.png' }],
      }],
      pagination: { totalCount: 1, isLastPage: true, pageNumber: 0, pageSize: 10 },
    }),
  });
  const result = await client.getPhotoReviews({ goodsNumber: GOODS, pageNumber: 1 });
  assert.deepEqual(JSON.parse(calls[0].init.body), { goodsNumber: GOODS, page: 0, size: 10 });
  assert.equal(result.reviews[0].photos[0].imagePath, '/photo.png');
  assert.equal(result.pagination.isLastPage, true);
  assert.equal(result.pagination.nextPage, null);
});

test('review stats and summaries bind to exact requested product IDs', async () => {
  const { client, calls } = createClient({
    ['GET https://m.oliveyoung.co.kr/review/api/v2/reviews/' + GOODS + '/stats']: json({
      data: {
        goodsNumber: GOODS, goodsName: 'item', reviewCount: 12,
        ratingDistribution: { averageRating: 4.8, ratingStatDtos: [] },
        satisfactionStats: [],
      },
    }),
    ['GET https://m.oliveyoung.co.kr/review/api/v1/reviews/' + GOODS + '/summary']: json({
      data: { positiveRatio: 80, negativeRatio: 5, feature1Title: '흡수력', feature1Description: '좋아요' },
    }),
  });
  const stats = await client.getReviewStats({ goodsNumber: GOODS });
  const summary = await client.getReviewSummary({ goodsNumber: GOODS });
  assert.equal(stats.reviewCount, 12);
  assert.equal(stats.averageRating, 4.8);
  assert.equal(summary.features[0].title, '흡수력');
  assert.equal(calls[0].url.pathname, '/review/api/v2/reviews/' + GOODS + '/stats');
  assert.equal(calls[1].url.pathname, '/review/api/v1/reviews/' + GOODS + '/summary');
});

test('photo review and option counts expose only observed read fields', async () => {
  const { client } = createClient({
    ['GET https://m.oliveyoung.co.kr/review/api/v2/reviews/options/' + GOODS + '/count']: json({
      data: {
        hasZeroReviewOption: false, isReviewSkinFilterAvailability: true,
        productItemReviewCountList: [], relatedProductReviewCountList: [],
      },
    }),
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/photo-reviews': json({
      data: [], pagination: { totalCount: 0, isLastPage: true },
    }),
  });
  const options = await client.getReviewOptionCounts({ goodsNumber: GOODS });
  const photos = await client.getPhotoReviews({ goodsNumber: GOODS });
  assert.equal(options.skinFilterAvailable, true);
  assert.deepEqual(photos.reviews, []);
});

test('session cookies remain in memory and an HTML 403 is a transport blocker, not login proof', async () => {
  const secret = 'synthetic-cookie-value-should-never-escape';
  let capturedCookie;
  const { client } = createClient({
    'GET https://www.oliveyoung.co.kr/goods/api/v1/detail': json({
      data: { goodsNumber: GOODS, goodsName: 'item', options: [] },
    }),
    'GET https://www.oliveyoung.co.kr/goods/api/v1/description': async ({ init }) => {
      capturedCookie = init.headers.get('cookie');
      return new Response('<html>blocked</html>', {
        status: 403, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
    'POST https://www.oliveyoung.co.kr/goods/api/v1/extra': json({ data: {} }, 403, 'text/html'),
  }, {
    session: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
      cookies: [{ name: '__cf_bm', value: secret, domain: '.oliveyoung.co.kr', path: '/' }],
    },
  });
  let caught;
  try { await client.getProduct({ goodsNumber: GOODS }); }
  catch (error) { caught = error; }
  assert.equal(capturedCookie, '__cf_bm=' + secret);
  assert.equal(caught.code, 'OLIVEYOUNG_KOREA_PUBLIC_HTTP_BLOCKED');
  assert.equal(caught.receipt.request.httpStatus, 403);
  assert.equal(caught.receipt.request.mime, 'text/html');
  assert.equal(JSON.stringify(caught.receipt).includes(secret), false);
  assert.equal(JSON.stringify(caught.receipt).includes('login required'), false);
});

test('client rejects invalid product/search inputs and malformed prices before returning data', async () => {
  let calls = 0;
  const { client } = createClient({
    'POST https://www.oliveyoung.co.kr/store/search/NewMainSearchApi.do': async () => {
      calls++;
      return json({ Data: [{ CollName: 'OLIVE_GOODS', TotalCount: 1, Result: [
        row(GOODS, { SUP_PRC: 'not-a-price' }),
      ] }], Parameter: [] });
    },
  });
  await assert.rejects(client.getProduct({ goodsNumber: '../other' }),
    { code: 'OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_INPUT_INVALID' });
  await assert.rejects(client.searchProducts({ query: 'cream' }),
    { code: 'OLIVEYOUNG_KOREA_PUBLIC_SEARCH_INPUT_INVALID' });
  await assert.rejects(client.searchProducts({ query: 'cream', pageSize: 24 }),
    { code: 'OLIVEYOUNG_KOREA_PUBLIC_PRICE_SCHEMA_INVALID' });
  assert.equal(calls, 1);
});
