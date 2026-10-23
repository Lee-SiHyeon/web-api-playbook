import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOliveyoungKoreaPublicClient } from '../lib/commerce/oliveyoung-korea-public.mjs';

const GOODS = 'A000000263510';
const OBSERVED_EXTRA_BODY = JSON.parse(readFileSync(new URL('../verification/remaining-oliveyoung-2026-10-16/extra-observed-request.json', import.meta.url), 'utf8')).body;
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
  assert.equal(result.products[0].listPrice.kind, 'retail_list');
  assert.equal(result.products[0].normalPrice.kind, 'market_reference');
  assert.equal(result.products[0].discountRate, '18.33');
  assert.equal(result.products[0].priceContext.optionRangeHint, true);
  assert.equal(result.products[0].priceContext.selectedVariantPrice, false);
  assert.deepEqual(result.products[1].price, {
    amount: '10000', currency: 'KRW', minorUnitExponent: 0,
    kind: 'retail_current', sourceField: 'NORM_PRC',
  });
  assert.deepEqual(result.products[2].price, {
    amount: '12000', currency: 'KRW', minorUnitExponent: 0,
    kind: 'retail_current', sourceField: 'SUP_PRC',
  });
  assert.equal(result.products[2].normalPrice.kind, 'market_reference');
  assert.equal(result.products[2].listPrice, undefined);
  assert.equal(result.totalProducts, 30);
  assert.equal(result.pagination.hasNext, true);
  assert.equal(result.pagination.nextPage, 3);
  assert.equal(result.pagination.terminationVerified, false);
  assert.equal(result.complete, false);
  assert.equal(result.receipts[0].request.responseProductMatched, null);
  assert.equal(JSON.stringify(result.receipts).includes('선크림'), false);
});

test('search preserves numeric prices and every comma-delimited display category ID', async () => {
  const categories = '1000001000800050004,1000001001100060001';
  const { client } = createClient({
    'POST https://www.oliveyoung.co.kr/store/search/NewMainSearchApi.do': json({
      Data: [{
        CollName: 'OLIVE_GOODS', TotalCount: 1, Count: 1,
        Result: [row(GOODS, { DISP_CAT_NO: categories, SALE_PRC: 24500, NORM_PRC: 25000 })],
      }],
      Parameter: [],
    }),
  });
  const result = await client.searchProducts({ query: '선크림', pageSize: 10 });
  assert.deepEqual(result.products[0].categoryIds, categories.split(','));
  assert.equal(result.products[0].categoryId, undefined);
  assert.equal(result.products[0].price.amount, '24500');
  assert.equal(result.products[0].listPrice.amount, '25000');
});

test('product detail fails closed before sending the uncaptured /detail request', async () => {
  const { client, calls } = createClient({});
  await assert.rejects(client.getProduct({ goodsNumber: GOODS }),
    { code: 'OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_CONTRACT_UNAVAILABLE' });
  assert.equal(calls.length, 0);
});

test('product options replay the captured source body unchanged and bind returned options to its product', async () => {
  const id = OBSERVED_EXTRA_BODY.goodsNumber;
  const { client, calls } = createClient({
    'POST https://www.oliveyoung.co.kr/goods/api/v1/extra': json({ data: {
      goodsNumber: id,
      optionDetail: { allSoldOutFlag: false, optionList: [
        { optionNumber: '001', standardCode: '8800312067096', brand: '4435',
          standardCategoryNumber: '010401', discountApplyFlag: true, todayDeliveryFlag: true, soldOutFlag: false },
        { optionNumber: '002', standardCode: '8800312067102', brand: '4435',
          standardCategoryNumber: '010401', discountApplyFlag: true, todayDeliveryFlag: true, soldOutFlag: false },
      ] },
    } }),
  });

  const result = await client.getProductOptions({ goodsNumber: id, observedRequestBody: OBSERVED_EXTRA_BODY });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/goods/api/v1/extra');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.get('content-type'), 'application/json');
  assert.equal(calls[0].init.headers.get('referer'),
    'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + id);
  assert.equal(calls[0].init.body, JSON.stringify(OBSERVED_EXTRA_BODY));
  assert.equal(Buffer.byteLength(calls[0].init.body), 722);
  assert.equal(result.productId, id);
  assert.equal(result.identityVerified, true);
  assert.equal(result.availability, 'available');
  assert.deepEqual(result.options.map(option => [option.optionId, option.sku, option.lowerCategoryNumber, option.availability]), [
    ['001', '8800312067096', '010401', 'available'],
    ['002', '8800312067102', '010401', 'available'],
  ]);
  assert.equal(result.receipts[0].request.responseProductMatched, true);
});

test('product options reject unbound or extra caller fields before any request', async t => {
  const cases = [
    ['product mismatch', { ...OBSERVED_EXTRA_BODY, goodsNumber: 'A000000000001' }],
    ['unobserved field', { ...OBSERVED_EXTRA_BODY, guessedFlag: false }],
    ['malformed option flag', { ...OBSERVED_EXTRA_BODY, options: [
      { ...OBSERVED_EXTRA_BODY.options[0], soldOutFlag: 'false' }, OBSERVED_EXTRA_BODY.options[1],
    ] }],
  ];
  for (const [name, observedRequestBody] of cases) {
    await t.test(name, async () => {
      const { client, calls } = createClient({});
      await assert.rejects(client.getProductOptions({
        goodsNumber: OBSERVED_EXTRA_BODY.goodsNumber, observedRequestBody,
      }), { code: 'OLIVEYOUNG_KOREA_PUBLIC_OPTIONS_CONTEXT_INVALID' });
      assert.equal(calls.length, 0);
    });
  }
});

test('product options reject a conflicting response product ID with a safe receipt', async () => {
  const { client, calls } = createClient({
    'POST https://www.oliveyoung.co.kr/goods/api/v1/extra': json({ data: {
      goodsNumber: 'A000000000001', optionDetail: { optionList: [] },
    } }),
  });
  await assert.rejects(client.getProductOptions({
    goodsNumber: OBSERVED_EXTRA_BODY.goodsNumber, observedRequestBody: OBSERVED_EXTRA_BODY,
  }), error => {
    assert.equal(error.code, 'OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_ID_MISMATCH');
    assert.equal(error.receipt.request.httpStatus, 200);
    assert.equal(error.receipt.request.mime, 'application/json');
    assert.equal(typeof error.receipt.request.responseSha256, 'string');
    assert.equal(error.receipt.request.responseProductMatched, false);
    assert.equal(calls.length, 1);
    return true;
  });
});

test('product description and source images can be read independently while absent identity echo stays explicit', async () => {
  const { client, calls } = createClient({
    'GET https://www.oliveyoung.co.kr/goods/api/v1/description': json({ data: {
      descriptionContents: '<p>보습 설명</p><script>drop this</script><img data-src="/images/one.jpg"><img src="https://image.oliveyoung.co.kr/two.jpg">',
      goodsDetailImages: null,
    } }),
  });

  const result = await client.getProductDescription({ goodsNumber: GOODS });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://www.oliveyoung.co.kr');
  assert.equal(calls[0].url.pathname, '/goods/api/v1/description');
  assert.equal(calls[0].url.searchParams.get('goodsNumber'), GOODS);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.get('referer'),
    'https://www.oliveyoung.co.kr/store/goods/getGoodsDetail.do?goodsNo=' + GOODS);
  assert.equal(result.requestedProductId, GOODS);
  assert.equal(result.identityVerified, false);
  assert.equal(result.description, '보습 설명');
  assert.deepEqual(result.images, [{ path: '/images/one.jpg' }, { url: 'https://image.oliveyoung.co.kr/two.jpg' }]);
  assert.equal(result.receipts[0].request.httpStatus, 200);
});

test('product description rejects a conflicting echoed goods number with its safe receipt', async () => {
  const { client, calls } = createClient({
    'GET https://www.oliveyoung.co.kr/goods/api/v1/description': json({ data: {
      goodsNumber: 'A000000000001', descriptionContents: '<p>다른 상품</p>', goodsDetailImages: null,
    } }),
  });

  await assert.rejects(client.getProductDescription({ goodsNumber: GOODS }), error => {
    assert.equal(error.code, 'OLIVEYOUNG_KOREA_PUBLIC_PRODUCT_ID_MISMATCH');
    assert.equal(error.receipt.request.httpStatus, 200);
    assert.equal(error.receipt.request.mime, 'application/json');
    assert.equal(typeof error.receipt.request.responseSha256, 'string');
    assert.equal(calls.length, 1);
    return true;
  });
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

test('review cursor retains a numeric ID and null count across the continuation request', async () => {
  const pages = [
    json({
      totalCnt: 54_540,
      data: {
        goodsReviewList: [{ reviewId: 'R1', content: 'first', goodsDto: { goodsNumber: GOODS }, reviewScore: 5 }],
        hasNext: true, nextCursorId: 123456789, nextCursorScore: 4.8, nextCursorCount: null,
      },
    }),
    json({
      totalCnt: 54_540,
      data: {
        goodsReviewList: [{ reviewId: 'R2', content: 'second', goodsDto: { goodsNumber: GOODS }, reviewScore: 4 }],
        hasNext: false,
      },
    }),
  ];
  const { client, calls } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/cursor': () => pages.shift(),
  });
  const first = await client.getReviews({ goodsNumber: GOODS });
  assert.deepEqual(first.continuation, { cursorId: 123456789, cursorScore: 4.8, cursorCount: null });
  assert.equal(first.hasNext, true);
  const second = await client.getReviews({ goodsNumber: GOODS, continuation: first.continuation });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    goodsNumber: GOODS, size: 10, sortType: 'USEFUL_SCORE_DESC', reviewType: 'ALL',
    cursorId: 123456789, cursorScore: 4.8, cursorCount: null,
  });
  assert.equal(second.hasNext, false);
  assert.equal(second.continuation, null);
});

test('review cursor schema rejects object values rather than stringifying opaque cursor fields', async () => {
  const { client } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/cursor': json({
      totalCnt: 0,
      data: { goodsReviewList: [], hasNext: true, nextCursorId: { id: 1 }, nextCursorScore: 2, nextCursorCount: null },
    }),
  });
  await assert.rejects(client.getReviews({ goodsNumber: GOODS }),
    { code: 'OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PAGINATION_SCHEMA_INVALID' });
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
  assert.equal(result.pagination.terminalityVerified, true);
});

test('photo-review rows survive a current response with no pagination object, with termination left unknown', async () => {
  const { client, calls } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/photo-reviews': json({
      code: 'SUCCESS', status: 'SUCCESS', totalCnt: null, pageData: null, pagination: null,
      data: [{ reviewId: 'R2', createdDateTime: '2026-10-16T00:00:00Z',
        photoReviewList: [{ imageSequence: 1, imagePath: '/photo-2.png' }] }],
    }),
  });

  const result = await client.getPhotoReviews({ goodsNumber: GOODS, pageNumber: 2, pageSize: 10 });

  assert.deepEqual(JSON.parse(calls[0].init.body), { goodsNumber: GOODS, page: 1, size: 10 });
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].photos[0].imagePath, '/photo-2.png');
  assert.equal(result.pagination.isLastPage, null);
  assert.equal(result.pagination.nextPage, null);
  assert.equal(result.pagination.nextPageCandidate, 3);
  assert.equal(result.pagination.terminalityVerified, false);
  assert.equal(result.receipts[0].request.httpStatus, 200);
});

test('photo reviews fail closed on unsupported pageData or malformed pagination while retaining the safe HTTP receipt', async t => {
  const cases = [
    ['pageData object', { data: [], pageData: { totalPages: 1 }, pagination: null }],
    ['pagination primitive', { data: [], pageData: null, pagination: 'last' }],
    ['non-boolean terminal flag', { data: [], pageData: null, pagination: { isLastPage: 'true' } }],
  ];
  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      const { client } = createClient({
        'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/photo-reviews': json(payload),
      });
      await assert.rejects(client.getPhotoReviews({ goodsNumber: GOODS, pageNumber: 1 }), error => {
        assert.equal(error.code, 'OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PHOTO_SCHEMA_INVALID');
        assert.equal(error.receipt.request.httpStatus, 200);
        assert.equal(error.receipt.request.mime, 'application/json');
        assert.equal(typeof error.receipt.request.responseSha256, 'string');
        return true;
      });
    });
  }
});

test('photo reviews reject malformed photo entries instead of silently dropping image rows', async () => {
  const { client } = createClient({
    'POST https://m.oliveyoung.co.kr/review/api/v2/reviews/photo-reviews': json({
      data: [{ reviewId: 'R3', photoReviewList: [{ imagePath: null }] }],
      pageData: null,
      pagination: null,
    }),
  });
  await assert.rejects(client.getPhotoReviews({ goodsNumber: GOODS, pageNumber: 1 }), error => {
    assert.equal(error.code, 'OLIVEYOUNG_KOREA_PUBLIC_REVIEW_PHOTO_SCHEMA_INVALID');
    assert.equal(error.receipt.request.httpStatus, 200);
    assert.equal(typeof error.receipt.request.responseSha256, 'string');
    return true;
  });
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
    'GET https://www.oliveyoung.co.kr/goods/api/v1/description': async ({ init }) => {
      capturedCookie = init.headers.get('cookie');
      return new Response('<html>blocked</html>', {
        status: 403, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  }, {
    session: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
      cookies: [{ name: '__cf_bm', value: secret, domain: '.oliveyoung.co.kr', path: '/' }],
    },
  });
  let caught;
  try { await client.getProductDescription({ goodsNumber: GOODS }); }
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
