import test from 'node:test';
import assert from 'node:assert/strict';
import { createOliveyoungGlobalClient } from '../lib/commerce/oliveyoung-global.mjs';

const PRODUCT_ID = 'GA240824996';
const OTHER_PRODUCT_ID = 'GA250128210';
const CATEGORY_ID = '1000000008';
const product = (id = PRODUCT_ID) => ({
  prdtNo: id,
  prdtName: 'MEDIHEAL Essential Mask Sheet 10ea Set',
  brandName: 'MEDIHEAL',
  nrmlAmt: 27,
  saleAmt: 13.5,
  currency: null,
  optnYn: 'Y',
  sellStatCode: '10',
  gdsLclsNm: 'Beauty',
  gdsMclsNm: 'Skincare',
  gdsSclsNm: 'Masks',
  optionList: [{ prdtNo: id, gdsCd: 'SKU-01', gdsName: '7 Options', snglOptnNameEn: 'Rose',
    nrmlAmt: 27, saleAmt: 13.5, sellStatCode: '10', buyStockQty: '8',
    optnImagePath: 'prdtImg/1000/option.png' }],
  thumbnailList: [{ prdtNo: id, imagePath: 'prdtImg/1000/thumbnail.png' }],
});
const summary = () => ({
  reviewExpYn: 'Y', totalReviewCount: 21, totalStarRate: 4.8, totalMediaReviewCount: 7,
  scores: [{ evltItemNm: null, star: 5, count: 18, rate: 86 }],
  evltScores: [{ evltItemNm: 'Moisturizing', star: 0, count: 0, rate: 4.8 }],
});
const json = (value, status = 200, mime = 'application/json; charset=utf-8') => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': mime },
});
const contextHtml = productId => new Response(`<html><head><title>MEDIHEAL Test</title></head><body>${productId}
  <script>var dlvCntry = '1230'; var acesCntry = '00'; var currency = 'USD';</script>
  <div class="selected-option"><span data-code-dtl-no="USD" data-option="currencyCodeList">US$ USD</span></div>
  <div class="selected-option"><span>KOREA, REPUBLIC OF (SOUTH K.)</span></div></body></html>`, {
  status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
});

function createClient({ replies = {}, defaultReply } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(url.origin, 'https://global.oliveyoung.com');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.headers.accept, init.method === 'GET' && url.pathname === '/product/detail' ? 'text/html' : 'application/json');
    if (init.method === 'POST') {
      assert.equal(init.headers['content-type'], url.pathname === '/display/category/product-data/'
        ? 'application/json; charset=utf-8' : 'application/json');
    }
    const key = `${init.method} ${url.pathname}`;
    const reply = replies[key] ?? defaultReply;
    assert.ok(reply, `unexpected request ${key}`);
    return typeof reply === 'function' ? reply({ url, init }) : reply;
  };
  const client = createOliveyoungGlobalClient({ fetchImpl,
    now: () => new Date('2026-10-05T00:00:00.000Z') });
  return { client, calls };
}

function productClient() {
  return createClient({ replies: {
    'GET /product/detail': contextHtml(PRODUCT_ID),
    'POST /product/detail-data': json({ product: product() }),
    'POST /product/details-info': json({
      images: [],
      details: { prdtNo: PRODUCT_ID, dtlDesc: '<p>Product detail text</p><img src="prdtImg/1000/detail.png"><script>discard this</script>',
        dtlAddDesc: '', sellingPointText: '<b>Hydrates</b>', whyWeLoveItText: null,
        ftrdIngrdText: 'Panthenol', howToUseText: 'Apply gently' },
    }),
    'POST /product/review-summary': json(summary()),
  } });
}

function categoryPage({ pageNum, categoryId = CATEGORY_ID, found = 25, rowCount = 24, wrongPriceId = false } = {}) {
  const start = (pageNum - 1) * 24;
  const hit = [];
  const productPriceMap = {};
  for (let index = 0; index < rowCount; index++) {
    const productId = `GA2600${String(start + index).padStart(5, '0')}`;
    hit.push({ fields: {
      prdtNo: productId, prdtName: `Category product ${start + index}`, brandNo: 'B00592',
      brandName: 'Example Brand', ctgrNo: '1000000016', ctgrName: 'Cream',
      allPathCtgrNoList: [`${categoryId}^1000000016`], reviewCnt: '17', reviewScore: '4.8',
      sellStatCode: '10', soldOutYn: 'N', stockQty: null, imagePath: 'prdtImg/1000/category.png',
    } });
    productPriceMap[productId] = {
      prdtNo: wrongPriceId && index === 0 ? OTHER_PRODUCT_ID : productId,
      minNrmlAmt: '27.00', maxNrmlAmt: '27.00', minSaleAmt: '20.52', maxSaleAmt: '20.52',
    };
  }
  return { hits: { found, start, hit, brandInfo: { B00592: 'Example Brand' } }, productPriceMap };
}

test('Global product detail reads prices, options, product and description image URLs without cookies', async () => {
  const { client, calls } = productClient();
  const result = await client.getProduct({ productUrl: `https://global.oliveyoung.com/product/detail?prdtNo=${PRODUCT_ID}`,
    country: 'KR', currency: 'USD' });
  assert.deepEqual(calls.map(call => call.url.pathname), [
    '/product/detail', '/product/detail-data', '/product/details-info', '/product/review-summary',
  ]);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(JSON.parse(calls[1].init.body), { prdtNo: PRODUCT_ID });
  assert.equal(result.product.id, PRODUCT_ID);
  assert.equal(result.product.price.amount, '13.50');
  assert.equal(result.product.price.currency, 'USD');
  assert.equal(result.product.listPrice.amount, '27.00');
  assert.equal(result.product.options[0].variantId, 'SKU-01');
  assert.equal(result.product.options[0].price.amount, '13.50');
  assert.equal(result.product.images.length, 2);
  assert.deepEqual(result.product.images, [
    'https://cdn-image.oliveyoung.com/prdtImg/1000/thumbnail.png',
    'https://cdn-image.oliveyoung.com/prdtImg/1000/detail.png',
  ]);
  assert.equal(result.product.description, 'Product detail text');
  assert.equal(result.product.description.includes('discard this'), false);
  assert.equal(result.product.reviewSummary.totalReviews, 21);
  assert.equal(result.product.marketContext.currency, 'USD');
  assert.equal(result.product.marketContext.currencyVerified, true);
  assert.equal(result.receipt.currencyContextRequest.path, '/product/detail');
  assert.equal(result.receipt.currencyContextRequest.currencyCode, 'USD');
  assert.equal(result.product.marketContext.shippingEligibility, 'not_verified');
  assert.equal(result.receipt.schema, 'web-api-public-read-receipt-v1');
  assert.equal(result.receipt.capabilityId, 'catalog.product_detail');
  assert.equal(result.receipt.request.method, 'POST');
  assert.equal(result.receipt.request.path, '/product/detail-data');
  assert.equal(result.receipt.request.httpStatus, 200);
  assert.equal(result.receipt.request.browserUsed, false);
  assert.equal(result.receipt.credentialsUsed, false);
  assert.equal(result.receipt.productIdMatched, true);
  assert.equal(result.receipt.detailsRequest.path, '/product/details-info');
  assert.equal(result.receipt.reviewSummaryRequest.path, '/product/review-summary');
});

test('Global product identity is bound to the requested ID and product URL is fixed-origin', async () => {
  const wrong = createClient({ replies: {
    'GET /product/detail': contextHtml(PRODUCT_ID),
    'POST /product/detail-data': json({ product: product(OTHER_PRODUCT_ID) }),
  } });
  await assert.rejects(wrong.client.getProduct({ id: PRODUCT_ID }), { code: 'OLIVEYOUNG_GLOBAL_PRODUCT_SCHEMA_INVALID' });
  assert.equal(wrong.calls.length, 2);

  const noCalls = createClient({ defaultReply: json({}) });
  await assert.rejects(noCalls.client.getProduct({ id: '../attacker' }), { code: 'OLIVEYOUNG_GLOBAL_PRODUCT_ID_INVALID' });
  for (const input of [
    { productUrl: 'https://attacker.example/product/detail?prdtNo=GA240824996' },
    { productUrl: `https://global.oliveyoung.com/product/detail?prdtNo=${PRODUCT_ID}&prdtNo=${OTHER_PRODUCT_ID}` },
  ]) await assert.rejects(noCalls.client.getProduct(input), { code: 'OLIVEYOUNG_GLOBAL_PRODUCT_URL_INVALID' });
  await assert.rejects(noCalls.client.getProduct({ id: PRODUCT_ID,
    productUrl: `https://global.oliveyoung.com/product/detail?prdtNo=${OTHER_PRODUCT_ID}` }),
  { code: 'OLIVEYOUNG_GLOBAL_PRODUCT_ID_INVALID' });
  assert.equal(noCalls.calls.length, 0);
});

test('Global reviews preserve bodies, rating/date, associated-product flags and photos without reviewer identifiers', async () => {
  const reviewList = [
    { prdtNo: PRODUCT_ID, assocReviewYn: 'N', prdtReviewNo: 1001, previewScore: 5, conText: 'Helpful review',
      bestYn: 'Y', mediaReviewYn: 'Y', reviewRgstYmd: '20261005', snglOptnName: 'Rose', goodCnt: 4, badCnt: 0,
      loginId: 'must-not-escape', mbrNo: 123456, reviewMediaList: [{ seq: 1, videoYn: 'N', imagePath: 'prdt_review/1000/review.jpg' }] },
    { prdtNo: OTHER_PRODUCT_ID, assocReviewYn: 'Y', prdtReviewNo: 1002, previewScore: 4, conText: 'Associated review',
      bestYn: 'N', mediaReviewYn: 'N', reviewRgstYmd: '20260901', snglOptnName: 'Single', goodCnt: null, badCnt: 0,
      loginId: 'another-private-id', mbrNo: 654321, reviewMediaList: [] },
  ];
  const { client, calls } = createClient({ replies: {
    'POST /product/review-list': json({ reviewList, reviewExpYn: 'Y', totalCount: 21 }),
  } });
  const result = await client.getReviews({ productId: PRODUCT_ID, pageNum: 2, rowsPerPage: 10 });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    filterYn: 'N', prdtNo: PRODUCT_ID, prdtGbnCode: '10', movReviewYn: 'N', photoReviewYn: 'N',
    optnYn: 'Y', transUseYn: 'N', pageNum: 2, rowsPerPage: 10, sort: '10',
  });
  assert.equal(result.productIdMatched, true);
  assert.equal(result.reviews.length, 2);
  assert.equal(result.reviews[0].body, 'Helpful review');
  assert.equal(result.reviews[0].rating, 5);
  assert.equal(result.reviews[0].postedAt, '2026-10-05');
  assert.equal(result.reviews[0].images[0].imageUrl, 'https://cdn-image.oliveyoung.com/prdt_review/1000/review.jpg');
  assert.equal(result.reviews[1].associatedProductReview, true);
  assert.equal(result.reviews[1].sourceProductId, OTHER_PRODUCT_ID);
  assert.equal(result.reviews[1].helpfulCount, null);
  assert.deepEqual(result.pagination, { pageNum: 2, pageSize: 10, totalCount: 21,
    totalPages: 3, isLastPage: false, nextPage: 3 });
  assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
  assert.equal(JSON.stringify(result).includes('123456'), false);
  assert.equal(result.receipt.capabilityId, 'reviews.body');
  assert.equal(result.receipt.paginationVerified, true);
});

test('Review pages return a next page and a terminal page from observed totalCount', async () => {
  const { client, calls } = createClient({ defaultReply: async ({ init }) => {
    const body = JSON.parse(init.body);
    const count = body.pageNum === 1 ? 10 : body.pageNum === 3 ? 1 : 0;
    return json({ reviewList: Array.from({ length: count }, (_, i) => ({ prdtNo: PRODUCT_ID,
      assocReviewYn: 'N', prdtReviewNo: body.pageNum * 100 + i, previewScore: 5,
      conText: 'Review', reviewRgstYmd: '20261005', reviewMediaList: [] })), totalCount: 21 });
  } });
  const first = await client.getReviews({ productId: PRODUCT_ID, pageNum: 1 });
  const last = await client.getReviews({ productId: PRODUCT_ID, pageNum: 3 });
  const beyond = await client.getReviews({ productId: PRODUCT_ID, pageNum: 4 });
  assert.equal(first.pagination.nextPage, 2);
  assert.equal(last.reviews.length, 1);
  assert.equal(last.pagination.nextPage, null);
  assert.equal(beyond.reviews.length, 0);
  assert.equal(beyond.pagination.isLastPage, true);
  assert.equal(calls.length, 3);
});

test('Review media returns photos only with independent page metadata', async () => {
  const { client, calls } = createClient({ replies: {
    'POST /product/review-media-list': json({ totalCount: 16, mediaList: [
      { prdtReviewNo: 1001, seq: 1, bestYn: 'Y', videoYn: 'N', imagePath: 'prdt_review/1000/review.jpg', conText: 'must not be returned' },
    ] }),
  } });
  const result = await client.getReviewMedia({ productId: PRODUCT_ID, pageNum: 1 });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    prdtNo: PRODUCT_ID, prdtGbnCode: '10', pageNum: 1, rowsPerPage: 15,
    photoReviewYn: 'N', movReviewYn: 'N',
  });
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].imageUrl, 'https://cdn-image.oliveyoung.com/prdt_review/1000/review.jpg');
  assert.equal(result.media[0].reviewId, '1001');
  assert.equal(result.containsReviewBodies, false);
  assert.equal(result.pagination.nextPage, 2);
  assert.equal(JSON.stringify(result).includes('must not be returned'), false);
});

test('Global best-seller XHR is a bounded browse list and validates the observed KR/USD context', async () => {
  const { client, calls } = createClient({ replies: {
    'GET /product/detail': contextHtml(PRODUCT_ID),
    'GET /display/product/best-seller/order-best': json([{
      prdtNo: PRODUCT_ID, prdtName: 'Mask set', brandName: 'MEDIHEAL', nrmlAmt: '27.00', saleAmt: '13.50',
      eventSlprcDscntRt: '50.00', reviewCnt: '7766', avgScore: 4.9,
      imagePath: 'prdtImg/1000/thumbnail.png', sellStatCode: '10',
    }]),
  } });
  const result = await client.getBestSellers({ country: 'KR', currency: 'USD' });
  assert.equal(calls[0].url.pathname, '/display/product/best-seller/order-best');
  assert.equal(calls[0].url.searchParams.get('dlvCntryCode'), '1230');
  assert.equal(calls[0].url.searchParams.get('limit'), '20');
  assert.equal(result.products[0].price.amount, '13.50');
  assert.equal(result.products[0].listPrice.amount, '27.00');
  assert.equal(result.products[0].price.currency, 'USD');
  assert.equal(result.page.completeCatalog, false);
  assert.equal(result.receipt.capabilityId, 'catalog.bestsellers');

  for (const options of [{ country: 'US' }, { currency: 'EUR' }]) {
    await assert.rejects(client.getBestSellers(options), error =>
      ['OLIVEYOUNG_GLOBAL_COUNTRY_UNVERIFIED', 'OLIVEYOUNG_GLOBAL_CURRENCY_UNVERIFIED'].includes(error.code));
  }
});

test('Missing stock and review counts stay unknown instead of being converted to zero', async () => {
  const fixtureProduct = product();
  fixtureProduct.optionList[0].buyStockQty = null;
  const { client } = createClient({ replies: {
    'GET /product/detail': () => contextHtml(PRODUCT_ID),
    'POST /product/detail-data': json({ product: fixtureProduct }),
    'POST /product/details-info': json({ details: { prdtNo: PRODUCT_ID, dtlDesc: '' } }),
    'POST /product/review-summary': json(summary()),
    'GET /display/product/best-seller/order-best': json([{
      prdtNo: PRODUCT_ID, prdtName: 'Mask set', nrmlAmt: '27.00', saleAmt: '13.50',
      reviewCnt: null, avgScore: null,
    }]),
  } });
  const detailed = await client.getProduct({ id: PRODUCT_ID });
  assert.equal(detailed.product.options[0].stockQuantity, null);
  const best = await client.getBestSellers();
  assert.equal(best.products[0].reviewCount, null);
  assert.equal(best.products[0].averageRating, null);
});

test('Category browse replays observed JSON XHR fields, binds USD prices, and follows result paging', async () => {
  const { client, calls } = createClient({ defaultReply: async ({ url, init }) => {
    if (init.method === 'GET' && url.pathname === '/product/detail') {
      return contextHtml(url.searchParams.get('prdtNo'));
    }
    assert.equal(url.pathname, '/display/category/product-data/');
    const body = JSON.parse(init.body);
    return json(categoryPage({ pageNum: body.pageNum,
      rowCount: body.pageNum === 1 ? 24 : body.pageNum === 2 ? 1 : 0 }));
  } });

  const first = await client.getCategoryProducts({ categoryId: CATEGORY_ID, pageNum: 1 });
  const last = await client.getCategoryProducts({ categoryId: CATEGORY_ID, pageNum: 2 });
  const beyond = await client.getCategoryProducts({ categoryId: CATEGORY_ID, pageNum: 3 });
  assert.equal(calls.filter(call => call.url.pathname === '/display/category/product-data/').length, 3);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, {
    accParam: '', langCode: 'en', previewDate: '', encKey: '', encText: '', dlvCntry: '1230',
    mrgnCntryCode: '9999', attrValNo: '', ctgrNo: CATEGORY_ID, prdtSortStdrCode: '10',
    pageNum: 1, rowsPerPage: '24', attrValNoList: {}, brandNoList: [], ctgrNoList: [],
    eventSlprcDscntRt: [], reviewScore: [], scrollY: 0,
  });
  assert.equal(calls[0].init.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(first.products.length, 24);
  assert.equal(first.products[0].id, 'GA260000000');
  assert.equal(first.products[0].price.amount, '20.52');
  assert.equal(first.products[0].price.currency, 'USD');
  assert.equal(first.products[0].listPrice.amount, '27.00');
  assert.equal(first.products[0].categoryId, CATEGORY_ID);
  assert.deepEqual(first.products[0].categoryPathIds, [[CATEGORY_ID, '1000000016']]);
  assert.equal(first.products[0].stockQuantity, null);
  assert.equal(first.marketContext.currencyVerified, true);
  assert.equal(first.isLastPage, false);
  assert.equal(first.pagination.nextPage, 2);
  assert.equal(first.receipt.capabilityId, 'catalog.category_products');
  assert.equal(first.receipt.categoryIdMatched, true);
  assert.equal(last.products.length, 1);
  assert.equal(last.isLastPage, true);
  assert.equal(last.pagination.isLastPage, true);
  assert.equal(last.pagination.nextPage, null);
  assert.equal(Object.hasOwn(last, 'completeCategory'), false);
  assert.equal(beyond.products.length, 0);
  assert.equal(beyond.pagination.isLastPage, true);
  assert.deepEqual(beyond.marketContext, { currency: null, currencyVerified: false,
    reason: 'Empty page had no product id to bind a fresh currency context.' });
});

test('Category browse only sends source-observed page sizes and fails closed on category or price-map mismatch', async () => {
  const { client, calls } = createClient({ defaultReply: async ({ url, init }) => {
    if (url.pathname === '/product/detail') return contextHtml(url.searchParams.get('prdtNo'));
    const body = JSON.parse(init.body);
    return json(categoryPage({ pageNum: body.pageNum, found: 0, rowCount: 0 }));
  } });
  for (const input of [{ page: 1, pageSize: 36 }, { pageNum: 1, pageSize: 48 }]) {
    const result = await client.getCategoryProducts({ categoryId: CATEGORY_ID, ...input });
    const pageSize = input.pageSize;
    assert.equal(result.pagination.pageSize, pageSize);
    assert.equal(JSON.parse(calls.at(-1).init.body).rowsPerPage, String(pageSize));
    assert.equal(result.marketContext.currencyVerified, false);
  }
  await assert.rejects(client.getCategoryProducts({ categoryId: 'bad' }),
    { code: 'OLIVEYOUNG_GLOBAL_CATEGORY_ID_INVALID' });
  await assert.rejects(client.getCategoryProducts({ categoryId: CATEGORY_ID, pageSize: 12 }),
    { code: 'OLIVEYOUNG_GLOBAL_CATEGORY_PAGE_INPUT_INVALID' });
  await assert.rejects(client.getCategoryProducts({ categoryId: CATEGORY_ID, page: 1, pageNum: 2 }),
    { code: 'OLIVEYOUNG_GLOBAL_CATEGORY_PAGE_INPUT_INVALID' });
  assert.equal(calls.length, 2);

  const wrongCategory = createClient({ replies: {
    'POST /display/category/product-data/': json({ ...categoryPage({ pageNum: 1, rowCount: 1 }),
      hits: { ...categoryPage({ pageNum: 1, rowCount: 1 }).hits,
        hit: [{ fields: { ...categoryPage({ pageNum: 1, rowCount: 1 }).hits.hit[0].fields,
          allPathCtgrNoList: ['1000000001^1000000016'] } }] } }),
  } });
  await assert.rejects(wrongCategory.client.getCategoryProducts({ categoryId: CATEGORY_ID }),
    { code: 'OLIVEYOUNG_GLOBAL_CATEGORY_PRODUCT_SCHEMA_INVALID' });

  const wrongPrice = createClient({ replies: {
    'POST /display/category/product-data/': json(categoryPage({ pageNum: 1, rowCount: 1, wrongPriceId: true })),
  } });
  await assert.rejects(wrongPrice.client.getCategoryProducts({ categoryId: CATEGORY_ID }),
    { code: 'OLIVEYOUNG_GLOBAL_CATEGORY_PRICE_MAP_MISMATCH' });
});

test('Search suggestions stay separate from product search and normalize only observed brand/category/keyword fields', async () => {
  const { client, calls } = createClient({ replies: {
    'GET /api/v1/search/keywords/auto-complete': json({
      brands: [{ brandNumber: 'B00592', brandName: 'masklab', pcImagePath: 'null', mobileImagePath: 'null' }],
      categories: [{ categoryNumber: '1000000013', categoryName: 'Toner',
        fullCategoryName: 'OliveYoungGlobal &gt; Skincare &gt; Moisturizers &gt; Toner' }],
      keywords: [{ keyword: 'Toner Product Name' }],
    }),
  } });
  const result = await client.getSearchSuggestions({ query: 'toner' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/v1/search/keywords/auto-complete');
  assert.equal(calls[0].url.searchParams.get('query'), 'toner');
  assert.deepEqual(result.brands, [{ brandId: 'B00592', name: 'masklab', pcImageUrl: null, mobileImageUrl: null }]);
  assert.deepEqual(result.categories, [{ categoryId: '1000000013', name: 'Toner',
    fullPath: 'OliveYoungGlobal > Skincare > Moisturizers > Toner' }]);
  assert.deepEqual(result.keywords, ['Toner Product Name']);
  assert.equal(result.containsProducts, false);
  assert.equal(result.containsProductPrices, false);
  assert.equal(result.receipt.contractProvenance.kind, 'first_party_bundle_contract');
  assert.equal(result.receipt.capabilityId, 'search.suggestions');
  assert.deepEqual(result.receipt.request.queryFields, ['query']);
});

test('Popular keyword endpoint is source-backed and does not become catalog data', async () => {
  const { client, calls } = createClient({ replies: {
    'GET /api/v1/search/keywords/popular': json({ aggregatedAt: '2026-10-05T04:00:00Z', popularKeywords: [
      { keyword: 'Anua', rank: 1, rankDiff: 0, count: 34, countDiff: 19 },
      { keyword: 'Lador', rank: 2, rankDiff: -1, count: 12, countDiff: 2 },
      { keyword: 'Arocell', rank: 3, rankDiff: null, count: 9, countDiff: null },
    ] }),
  } });
  const result = await client.getPopularKeywords();
  assert.equal(calls[0].url.pathname, '/api/v1/search/keywords/popular');
  assert.equal(calls[0].url.searchParams.get('size'), '10');
  assert.deepEqual(result.popularKeywords[0], { keyword: 'Anua', rank: 1, rankDiff: 0, searchCount: 34, searchCountDiff: 19 });
  assert.deepEqual(result.popularKeywords[2], { keyword: 'Arocell', rank: 3, rankDiff: null, searchCount: 9, searchCountDiff: null });
  assert.equal(result.aggregatedAt, '2026-10-05T04:00:00Z');
  assert.equal(result.isProductCatalog, false);
  assert.equal(result.receipt.capabilityId, 'search.popular_keywords');
  assert.equal(result.receipt.contractProvenance.kind, 'first_party_bundle_contract');
});

test('An empty bestseller response does not trigger a currency bootstrap without a product identity', async () => {
  const { client, calls } = createClient({ replies: {
    'GET /display/product/best-seller/order-best': json([]),
  } });
  await assert.rejects(client.getBestSellers({ country: 'KR', currency: 'USD' }),
    { code: 'OLIVEYOUNG_GLOBAL_BESTSELLER_EMPTY' });
  assert.equal(calls.length, 1);
});

test('Search-results access stays blocked instead of using product-page HTML or guessed APIs', async () => {
  let calls = 0;
  const client = createOliveyoungGlobalClient({ fetchImpl: async () => { calls++; throw new Error('unexpected request'); } });
  await assert.rejects(client.searchProducts({ query: 'mask' }), { code: 'OLIVEYOUNG_GLOBAL_SEARCH_ACCESS_BLOCKED' });
  assert.equal(calls, 0);
});

test('API failures, HTML gates, and product IDs from a different item do not become successful reads', async () => {
  for (const response of [
    new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
    new Response('{}', { status: 200, headers: { 'content-type': 'text/html' } }),
  ]) {
    const { client } = createClient({ defaultReply: response });
    await assert.rejects(client.getReviewSummary({ productId: PRODUCT_ID }));
  }
});
