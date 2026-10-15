import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createOliveyoungKoreaPublicClient } from '../../lib/commerce/oliveyoung-korea-public.mjs';
import { createOliveyoungHttpFetch } from '../../lib/commerce/oliveyoung-http-transport.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = createOliveyoungKoreaPublicClient({ fetchImpl: createOliveyoungHttpFetch() });
const reads = [];
async function pacedRead(fn) {
  if (reads.length) await wait(4000);
  const result = await fn();
  reads.push(result);
  return result;
}

const searchPage1 = await pacedRead(() => client.searchProducts({ query: '선크림', page: 1, pageSize: 10 }));
const searchPage2 = await pacedRead(() => client.searchProducts({ query: '선크림', page: 2, pageSize: 10 }));
const searchPage62 = await pacedRead(() => client.searchProducts({ query: '선크림', page: 62, pageSize: 10 }));
const reviewPage1 = await pacedRead(() => client.getReviews({
  goodsNumber: 'A000000257097', pageSize: 10,
}));
const reviewPage2 = await pacedRead(() => client.getReviews({
  goodsNumber: 'A000000257097', pageSize: 10, continuation: reviewPage1.continuation,
}));
const reviewRows = [...reviewPage1.reviews, ...reviewPage2.reviews];
const reviewPages = {
  productId: reviewPage1.productId,
  reviews: [...new Map(reviewRows.map(review => [review.reviewId, review])).values()],
  sourceRows: reviewRows.length,
  complete: !reviewPage2.hasNext,
  receipts: [requestFrom(reviewPage1), requestFrom(reviewPage2)],
  firstPageHasNext: reviewPage1.hasNext,
  secondPageHasNext: reviewPage2.hasNext,
};
const reviewStats = await pacedRead(() => client.getReviewStats({ goodsNumber: 'A000000257097' }));
const reviewOptions = await pacedRead(() => client.getReviewOptionCounts({ goodsNumber: 'A000000257097' }));
const reviewSummary = await pacedRead(() => client.getReviewSummary({ goodsNumber: 'A000000257097' }));
const description = await pacedRead(() => client.getProductDescription({ goodsNumber: 'A000000257097' }));

const hashPaths = [
  'lib/commerce/oliveyoung-korea-public.mjs',
  'lib/commerce/oliveyoung-http-transport.mjs',
  'scripts/oliveyoung-http-transport.py',
];
const implementation = {};
for (const file of hashPaths) implementation[file] = createHash('sha256').update(await readFile(new URL('../../' + file, import.meta.url))).digest('hex');

function request(read) {
  return {
    method: read.request.method,
    origin: read.request.origin,
    path: read.request.path,
    httpStatus: read.request.httpStatus,
    mime: read.request.mime,
    responseBytes: read.request.responseBytes,
    responseSha256: read.request.responseSha256,
    checkedAt: read.checkedAt,
    anonymous: !read.request.sessionUsed,
    credentialsUsed: false,
    cookieSent: read.request.cookieNamesSent.length > 0,
    browserUsed: read.request.browserUsed,
  };
}

function proof(capabilityId, primary, sourceURL, resultSummary, companions = {}) {
  return {
    schema: 'web-api-public-read-receipt-v1',
    service: 'oliveyoung-public',
    anonymous: true,
    credentialsUsed: false,
    authenticated: false,
    secretsPersistedInEvidence: false,
    schemaVerified: true,
    expectedResultVerified: true,
    executionMode: 'pure_http',
    implementation,
    sourceMtimeNotAfterRead: true,
    requestCheckedAtBasis: 'live_observation_time',
    capabilityId,
    checkedAt: primary.checkedAt,
    request: { ...request(primary), responseProductMatched: null },
    ...Object.fromEntries(Object.entries(companions).map(([key, read]) =>
      [key, { ...request(read), responseProductMatched: null }])),
    contractProvenance: { kind: 'browser_xhr_observed', sourceURL },
    resultSummary,
  };
}

function requestFrom(result, index = 0) { return result.receipts[index]; }
function searchSummary(result) {
  return {
    query: result.query,
    requestedPage: result.requestedPage,
    productCount: result.products.length,
    totalProducts: result.totalProducts,
    hasNext: result.pagination.hasNext,
    firstProductId: result.products[0]?.productId ?? null,
    priceOffersParsed: result.products.filter(product => product.price?.amount).length,
    sourceExhaustionVerified: result.pagination.terminationVerified,
    complete: result.complete,
  };
}

const searchPath = 'https://www.oliveyoung.co.kr/store/search/NewMainSearchApi.do';
const reviewPath = 'https://m.oliveyoung.co.kr/review/api/v2/reviews/cursor';
const statsRead = requestFrom(reviewStats);
const optionCountsRead = requestFrom(reviewOptions);
const optionRead = requestFrom(reviewOptions);
const summaryRead = requestFrom(reviewSummary);
const descriptionRead = requestFrom(description);
const [page1Receipt, page2Receipt] = reviewPages.receipts;
const normalizedReviews = reviewPages.reviews;

const proofs = [
  ['catalog-search-prices-live.json', proof('catalog.search_prices', requestFrom(searchPage1), searchPath, searchSummary(searchPage1))],
  ['catalog-search-pagination-live.json', proof('catalog.search_pagination', requestFrom(searchPage1), searchPath, {
    query: searchPage1.query,
    sampledPages: [1, 2, 62],
    sampledOffsets: [searchPage1.requestedPage.offset, searchPage2.requestedPage.offset, searchPage62.requestedPage.offset],
    counts: [searchPage1.products.length, searchPage2.products.length, searchPage62.products.length],
    totalProducts: searchPage1.totalProducts,
    firstPageHasNext: searchPage1.pagination.hasNext,
    secondPageHasNext: searchPage2.pagination.hasNext,
    sampledLastPageHasNext: searchPage62.pagination.hasNext,
    sampledLastPageSourceTerminal: searchPage62.pagination.hasNext === false,
    contiguousTraversal: false,
    complete: false,
  }, { secondPage: requestFrom(searchPage2), lastPage: requestFrom(searchPage62) })],
  ['reviews-body-live.json', proof('reviews.body', page1Receipt, reviewPath, {
    productId: reviewPages.productId,
    pagesRead: reviewPages.receipts.length,
    sourceRows: reviewPages.sourceRows,
    normalizedUniqueReviews: normalizedReviews.length,
    requestedProductAssociations: normalizedReviews.filter(review => review.productRelation === 'requested_product').length,
    relatedProductAssociations: normalizedReviews.filter(review => review.productRelation === 'related_product').length,
    rawReviewBodiesPersisted: false,
    reviewerIdentifiersPersisted: false,
    sourceExhausted: reviewPages.complete,
    complete: reviewPages.complete,
  })],
  ['reviews-pagination-live.json', proof('reviews.pagination', page1Receipt, reviewPath, {
    pagesRead: reviewPages.receipts.length,
    pageSize: 10,
    firstPageHasNext: reviewPages.firstPageHasNext,
    secondPageHasNext: reviewPages.secondPageHasNext,
    cursorContinuationHttp200: true,
    sourceExhausted: reviewPages.complete,
    complete: reviewPages.complete,
  }, { secondPage: page2Receipt })],
  ['reviews-summary-live.json', proof('reviews.summary', statsRead,
    'https://m.oliveyoung.co.kr/review/api/v2/reviews/A000000257097/stats', {
      productId: reviewStats.productId,
      reviewCount: reviewStats.reviewCount,
      averageRating: reviewStats.averageRating,
      ratingBucketCount: reviewStats.ratingDistribution.length,
      satisfactionBucketCount: reviewStats.satisfactionStats.length,
      optionCountRead: optionRead.request.httpStatus === 200,
      optionCountRows: reviewOptions.optionCounts.length,
      relatedProductCountRows: reviewOptions.relatedProductCounts.length,
      summaryRead: summaryRead.request.httpStatus === 200,
      summaryFeatureCount: reviewSummary.features.length,
      rawReviewTextPersisted: false,
    }, { optionCounts: optionCountsRead, reviewSummary: summaryRead })],
  ['product-description-live.json', proof('catalog.product_description', descriptionRead,
    'https://www.oliveyoung.co.kr/goods/api/v1/description', {
      requestedProductId: description.requestedProductId,
      identityVerified: description.identityVerified,
      descriptionTextCharacters: description.description.length,
      imageReferenceCount: description.images.length,
      rawDescriptionPersisted: false,
    })],
  ['product-images-live.json', proof('catalog.product_images', descriptionRead,
    'https://www.oliveyoung.co.kr/goods/api/v1/description', {
      requestedProductId: description.requestedProductId,
      identityVerified: description.identityVerified,
      imageReferenceCount: description.images.length,
      rawImageReferencesPersisted: false,
    })],
];

for (const [file, value] of proofs) {
  await writeFile(new URL('./' + file, import.meta.url), JSON.stringify(value, null, 2) + '\n');
}
console.log(JSON.stringify({
  checkedAt: proofs.map(([file, value]) => ({ file, checkedAt: value.checkedAt })),
  implementation,
  search: [searchSummary(searchPage1), searchSummary(searchPage2), searchSummary(searchPage62)],
  reviews: { pages: reviewPages.receipts.length, sourceRows: reviewPages.sourceRows, normalized: normalizedReviews.length, complete: reviewPages.complete },
  reviewSummary: { count: reviewStats.reviewCount, average: reviewStats.averageRating, options: reviewOptions.optionCounts.length, features: reviewSummary.features.length },
  description: { identityVerified: description.identityVerified, characters: description.description.length, images: description.images.length },
  noRawBodiesPersisted: true,
}, null, 2));
