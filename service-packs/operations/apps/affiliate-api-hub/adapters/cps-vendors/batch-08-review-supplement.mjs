import { readPublicResource } from '../../lib/cps-public-reader.mjs';
import { readFileSync } from 'node:fs';

const HMALL = Object.freeze({
  merchantId: 'hmall',
  siteUrl: 'https://www.hmall.com/',
  product: Object.freeze({
    sourceLocalId: '2247786819',
    title: '[U.S. POLO ASSN.] USPA 남성 PQ 카라티셔츠 3종 (HUPS269103)',
    url: 'https://www.hmall.com/md/pda/itemPtc?sectId=&slitmCd=2247786819',
  }),
  endpoint: 'https://www.hmall.com/api/hf/dp/v1/item-eval/item-eval-list',
  params: Object.freeze({
    listSize: '20',
    listCondition: '18',
    page: '1',
    refer: 'itemPtc',
    optionYn: 'N',
    opinionAttribute: '',
    slitmCd: '2247786819',
    itemType: 'Y',
    repSlitmCd: '2247786819',
  }),
});

const NSMALL = Object.freeze({
  merchantId: 'nsseshop',
  siteUrl: 'https://m.nsmall.com/',
  product: Object.freeze({
    sourceLocalId: '36026181',
    title: '쫀득고소 듀록 흑돼지 쫀삼겹살 500g+500g 외',
    url: 'https://m.nsmall.com/goods/36026181',
    aggregateReviewCount: 485,
  }),
  endpoint: 'https://mapi.nsmall.com/md/api/v1/review/photo-list',
  params: Object.freeze({ goodsCd: '36026181', pageNum: '1', pageSize: '30' }),
});

const HMALL_APP_RECEIPT = Object.freeze({
  id: '464dd9ba-a2b2-47c5-8d76-8cf8b4e17649',
  requestMethod: 'GET',
  requestUrl: 'https://www.hmall.com/md/_next/static/chunks/pages/_app-5086e80feb599908.js',
  responseStatus: 200,
  contentType: 'application/javascript; charset=UTF-8',
  bytes: 880404,
  responseSha256: '6217f64349481455b3e177f5da475f156064879cb896f497bd2e01fc7ad82be5',
  observedAt: '2026-09-27T11:14:23.521Z',
  browserUsed: false,
  cookiesSent: false,
  authorizationSent: false,
});

const NSMALL_SOURCE_RECEIPTS = Object.freeze([
  {
    id: 'de37dff3-1ec5-418c-a633-ef60d6304b02', requestMethod: 'GET',
    requestUrl: 'https://m.nsmall.com/assets/review-D_eVvLI4.js', responseStatus: 200,
    contentType: 'application/javascript; charset=utf-8', bytes: 920,
    responseSha256: 'd1f73d1f71c815bcaa3229169772c3a9e15497918fb5a98e79865edff87b4a35',
    observedAt: '2026-09-27T11:20:10.261Z', browserUsed: false, cookiesSent: false, authorizationSent: false,
  },
  {
    id: 'a489a1af-9d5b-46dc-b710-27e3e69bcd05', requestMethod: 'GET',
    requestUrl: 'https://m.nsmall.com/assets/modal-photo-review.vue_vue_type_style_index_0_lang-DpOkCDEq.js', responseStatus: 200,
    contentType: 'application/javascript; charset=utf-8', bytes: 7188,
    responseSha256: '2c6ea443bba2128ae3bdc0c19cca0dacda0a1c71e7d19a5ce1767c5ca757bc55',
    observedAt: '2026-09-27T11:20:36.057Z', browserUsed: false, cookiesSent: false, authorizationSent: false,
  },
  {
    id: '65667ca2-ef71-470e-b624-79c724e03895', requestMethod: 'GET',
    requestUrl: 'https://m.nsmall.com/assets/index-2pBlfEtF.js', responseStatus: 200,
    contentType: 'application/javascript; charset=utf-8', bytes: 1860884,
    responseSha256: '3d9dcd256e9e51fd20c9a5856f2329ddf0eae43763ecc7586b83e9d788d1e9a1',
    observedAt: '2026-09-27T11:20:44.205Z', browserUsed: false, cookiesSent: false, authorizationSent: false,
  },
]);

const SSG_BLOCK_RECEIPT = Object.freeze({
  id: '0aa40238-263e-4a5f-a18e-196bceaff673',
  requestMethod: 'GET',
  requestUrl: 'https://www.ssg.com/item/itemView.ssg?itemId=1000633804447&siteNo=6002&salestrNo=2491&tlidSrchWd=%EC%82%BC%EA%B2%B9%EC%82%B4&srchPgNo=1&taste=PPurchase',
  responseStatus: 403,
  contentType: 'text/html',
  bytes: 0,
  responseSha256: null,
  observedAt: '2026-09-27T11:17:15.803Z',
  browserUsed: false,
  cookiesSent: false,
  authorizationSent: false,
});

const BATCH_08_URL = new URL('../../references/cps-reverify/batch-08.json', import.meta.url);

function previousReceipts(merchantId, ids) {
  try {
    const report = JSON.parse(readFileSync(BATCH_08_URL, 'utf8'));
    const row = report.merchants?.find(item => item.merchantId === merchantId);
    const wanted = new Set(ids);
    return (row?.receipts ?? []).filter(receipt => wanted.has(receipt.id ?? receipt.receiptId));
  } catch {
    return [];
  }
}

const HMALL_PRIOR_RECEIPTS = previousReceipts('hmall', [
  '7512b261-2e4f-4418-98c8-d4df266b7bed',
  '87340890-0c7e-4324-bdce-17fec492999b',
  'adcda4f2-c9d3-48d9-9072-c838830e3665',
  'e70d7f65-1cd2-4349-baf7-265a9d42baff',
]);

const NSMALL_PRIOR_RECEIPTS = previousReceipts('nsseshop', [
  '755b6e29-5bc7-4cc5-a5fb-5330cf4de46d',
  'dd4726a4-a637-4b0b-bab1-4ac85748aced',
  '899a6d44-e392-4218-b45d-35562e8d0821',
]);

function buildObservedGetUrl(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

function boundedNumber(value, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) return null;
  return number;
}

function safeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  return value;
}

function evidence(receiptId, locator, fields) {
  return { receiptId, locator, fields };
}

function receiptList(receipt) {
  return receipt ? [receipt] : [];
}

function failureFrontier(operation, result) {
  return [{
    operation,
    reason: result?.stopReason ?? 'PUBLIC_RESPONSE_SCHEMA_UNAVAILABLE',
    responseStatus: result?.status ?? null,
    blocked: result?.blocked === true,
  }];
}

/** Replay Hmall's observed, anonymous product-review-list GET and retain only five safe metadata fields per row. */
export async function collectHmallReviewSamples({ readResource = readPublicResource, limit = 5, timeoutMs = 20_000 } = {}) {
  const sampleLimit = Math.min(5, Math.max(0, Number.isInteger(limit) ? limit : 5));
  const requestUrl = buildObservedGetUrl(HMALL.endpoint, HMALL.params);
  const page = await readResource(requestUrl, {
    allowedHosts: ['hmall.com'],
    maxRedirects: 0,
    maxBytes: 1_500_000,
    timeoutMs,
  });
  const base = {
    merchantId: HMALL.merchantId,
    siteUrl: HMALL.siteUrl,
    product: { ...HMALL.product },
    checkedAt: page?.receipt?.observedAt ?? new Date().toISOString(),
    receipts: [...HMALL_PRIOR_RECEIPTS, HMALL_APP_RECEIPT, ...receiptList(page?.receipt)],
    records: [],
    contracts: [],
    operations: { reviews_list: { state: 'not_verified', evidenceReceiptIds: receiptList(page?.receipt).map(row => row.id) } },
    frontier: [],
  };

  if (!page?.ok) {
    base.status = page?.blocked ? 'review_list_blocked' : 'review_list_unavailable';
    base.operations.reviews_list.state = page?.blocked ? 'blocked' : 'unavailable';
    base.frontier = failureFrontier('reviews_list', page);
    return base;
  }

  let payload;
  try { payload = JSON.parse(page.body ?? ''); }
  catch {
    base.status = 'review_list_schema_unavailable';
    base.operations.reviews_list.state = 'schema_unavailable';
    base.frontier = [{ operation: 'reviews_list', reason: 'JSON_PARSE_FAILED', responseStatus: page.status }];
    return base;
  }

  const responseData = payload?.respData;
  const rows = responseData?.itemEvalList;
  if (!Array.isArray(rows)) {
    base.status = 'review_list_schema_unavailable';
    base.operations.reviews_list.state = 'schema_unavailable';
    base.frontier = [{ operation: 'reviews_list', reason: 'OBSERVED_RESPDATA_ITEMEVAL_LIST_NOT_PRESENT', responseStatus: page.status }];
    return base;
  }

  const captured = rows.slice(0, sampleLimit).map(row => ({
    rating: boundedNumber(row?.itemEvalAvgScrg, { min: 1, max: 5 }),
    publishedAt: safeDate(row?.wrtDtm),
    helpfulCount: boundedNumber(row?.helpCnt, { min: 0, integer: true }),
    bodyAvailable: typeof row?.itemEvalCntn === 'string' && row.itemEvalCntn.trim().length > 0,
  }));
  const receiptId = page.receipt?.id ?? null;
  const aggregateReviewCount = boundedNumber(responseData?.reviewTotCnt, { min: 0, integer: true });

  base.status = captured.length ? 'review_list_metadata_sampled' : 'review_list_empty';
  base.records = [{
    type: 'RetailProduct',
    sourceLocalId: HMALL.product.sourceLocalId,
    title: HMALL.product.title,
    url: HMALL.product.url,
    description: null,
    brand: 'USPA',
    price: { amount: null, currency: null, priceText: null },
    rating: { value: null, best: null, worst: null, reviewCount: aggregateReviewCount, ratingCount: null },
    variants: [],
    reviewSamples: captured,
    reviewList: {
      returnedSampleCount: rows.length,
      capturedSampleCount: captured.length,
      aggregateReviewCount,
    },
    evidence: [
      evidence('87340890-0c7e-4324-bdce-17fec492999b', 'props.pageProps.res.bestInfo.bestCartItemList[0]', ['sourceLocalId', 'title', 'brand']),
      evidence('adcda4f2-c9d3-48d9-9072-c838830e3665', 'observed item link: /md/pda/itemPtc?sectId=&slitmCd={slitmCd}', ['url']),
      evidence(receiptId, 'respData.reviewTotCnt', ['rating', 'rating.reviewCount', 'reviewList.aggregateReviewCount']),
      evidence(
        receiptId,
        'respData.itemEvalList[0..n].{itemEvalAvgScrg,wrtDtm,helpCnt,itemEvalCntn}',
        ['reviewSamples', 'reviewSamples.rating', 'reviewSamples.publishedAt', 'reviewSamples.helpfulCount', 'reviewSamples.bodyAvailable'],
      ),
    ],
  }];
  base.contracts = [{
    operation: 'reviews_list',
    state: captured.length ? 'live_replay_verified_metadata_only' : 'live_replay_verified_empty_list',
    method: 'GET',
    requestUrl,
    requestParams: { ...HMALL.params },
    requestReceiptId: receiptId,
    productIdentityEvidenceReceiptId: '87340890-0c7e-4324-bdce-17fec492999b',
    productUrlEvidenceReceiptId: 'adcda4f2-c9d3-48d9-9072-c838830e3665',
    callerEvidence: {
      receiptId: 'e70d7f65-1cd2-4349-baf7-265a9d42baff',
      locator: 'itemPtc detail chunk: review API caller parameters and listCondition defaults',
      fields: ['requestParams', 'productId', 'reviewListMode'],
    },
    apiMethodEvidence: {
      receiptId: HMALL_APP_RECEIPT.id,
      locator: 'Hmall app chunk: GET /api/hf/dp/v1/item-eval/item-eval-list with params object',
      fields: ['method', 'endpoint'],
    },
    responseStatus: page.status,
    responseReceiptId: receiptId,
    responseLocator: 'respData.itemEvalList',
    returnedSampleCount: rows.length,
    capturedSampleCount: captured.length,
    aggregateReviewCount,
    sampleFields: ['rating', 'publishedAt', 'helpfulCount', 'bodyAvailable'],
    sourceFieldMapping: {
      rating: 'itemEvalAvgScrg',
      publishedAt: 'wrtDtm',
      helpfulCount: 'helpCnt',
      bodyAvailable: 'itemEvalCntn string is non-empty; content value omitted',
    },
    omittedFields: ['reviewId', 'author', 'body', 'imageUrl'],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
  }];
  base.operations.reviews_list = { state: captured.length ? 'metadata_sampled' : 'empty_list', evidenceReceiptIds: receiptId ? [receiptId] : [] };
  return base;
}

/** Replay only NSmall's observed photo-review list GET. Empty results do not establish that the general review list is empty. */
export async function collectNsmallPhotoReviewFrontier({ readResource = readPublicResource, timeoutMs = 20_000 } = {}) {
  const requestUrl = buildObservedGetUrl(NSMALL.endpoint, NSMALL.params);
  const page = await readResource(requestUrl, {
    allowedHosts: ['nsmall.com'],
    maxRedirects: 0,
    maxBytes: 1_500_000,
    timeoutMs,
  });
  const receiptId = page?.receipt?.id ?? null;
  const base = {
    merchantId: NSMALL.merchantId,
    siteUrl: NSMALL.siteUrl,
    product: { sourceLocalId: NSMALL.product.sourceLocalId, title: NSMALL.product.title, url: NSMALL.product.url },
    checkedAt: page?.receipt?.observedAt ?? new Date().toISOString(),
    receipts: [...NSMALL_PRIOR_RECEIPTS, ...NSMALL_SOURCE_RECEIPTS, ...receiptList(page?.receipt)],
    records: [],
    contracts: [],
    operations: { photo_reviews_list: { state: 'not_verified', evidenceReceiptIds: receiptList(page?.receipt).map(row => row.id) } },
    frontier: [],
  };
  if (!page?.ok) {
    base.status = page?.blocked ? 'photo_review_list_blocked' : 'photo_review_list_unavailable';
    base.operations.photo_reviews_list.state = page?.blocked ? 'blocked' : 'unavailable';
    base.frontier = failureFrontier('photo_reviews_list', page);
    return base;
  }

  let payload;
  try { payload = JSON.parse(page.body ?? ''); }
  catch {
    base.status = 'photo_review_list_schema_unavailable';
    base.operations.photo_reviews_list.state = 'schema_unavailable';
    base.frontier = [{ operation: 'photo_reviews_list', reason: 'JSON_PARSE_FAILED', responseStatus: page.status }];
    return base;
  }
  const resultData = payload?.data?.resultData;
  const imageList = resultData?.imageList;
  if (!Array.isArray(imageList)) {
    base.status = 'photo_review_list_schema_unavailable';
    base.operations.photo_reviews_list.state = 'schema_unavailable';
    base.frontier = [{ operation: 'photo_reviews_list', reason: 'OBSERVED_DATA_RESULTDATA_IMAGELIST_NOT_PRESENT', responseStatus: page.status }];
    return base;
  }
  if (imageList.length > 0) {
    base.status = 'photo_review_rows_present_metadata_mapping_unverified';
    base.operations.photo_reviews_list.state = 'response_rows_present_unmapped';
    base.frontier = [{ operation: 'photo_reviews_list', reason: 'NONEMPTY_PHOTO_REVIEW_ROWS_REQUIRE_OBSERVED_SAFE_FIELD_MAPPING', rowCount: imageList.length }];
  } else {
    base.status = 'photo_review_list_empty_general_reviews_unresolved';
    base.operations.photo_reviews_list.state = 'empty_photo_review_list';
    base.frontier = [{
      operation: 'general_reviews_list',
      reason: 'POST_HELPERS_OBSERVED_BUT_PUBLIC_CALLER_AND_EXACT_BODY_VALUES_NOT_ESTABLISHED; NO_REQUEST_SENT',
      observedRoute: 'https://mapi.nsmall.com/md/api/v1/external/review/unregistered/list',
      observedMethod: 'POST',
      sourceReceiptId: 'de37dff3-1ec5-418c-a633-ef60d6304b02',
      sourceLocator: 'review-D_eVvLI4.js: exported function posts data to external/review/unregistered/list',
    }];
  }
  base.contracts = [{
    operation: 'photo_reviews_list',
    state: imageList.length ? 'live_replay_rows_unmapped' : 'live_replay_verified_empty_photo_list',
    method: 'GET',
    requestUrl,
    requestParams: { ...NSMALL.params },
    callerDefaults: { pageNum: 1, pageSize: 30 },
    callerReceiptId: 'a489a1af-9d5b-46dc-b710-27e3e69bcd05',
    apiBaseReceiptId: '65667ca2-ef71-470e-b624-79c724e03895',
    responseStatus: page.status,
    responseReceiptId: receiptId,
    responseLocator: 'data.resultData.imageList',
    returnedSampleCount: imageList.length,
    totalImageCount: boundedNumber(resultData?.totalImageCnt, { min: 0, integer: true }),
    aggregateReviewCount: NSMALL.product.aggregateReviewCount,
    aggregateReviewCountEvidenceReceiptId: '899a6d44-e392-4218-b45d-35562e8d0821',
    productIdEvidenceLocator: 'modal-photo-review items.goodsCd -> Number(items.goodsCd); detail route /goods/{goodsCd}',
    omittedFields: ['reviewId', 'author', 'body', 'imageUrl'],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
  }];
  return base;
}

/** Run the two observed read contracts; it never guesses or sends the separate NSmall text-review POST body. */
export async function collectBatch08ReviewSupplement(options = {}) {
  const hmall = await collectHmallReviewSamples(options);
  const nsmall = await collectNsmallPhotoReviewFrontier(options);
  return {
    schemaVersion: 1,
    batchId: '08-review-supplement',
    checkedAt: [hmall.checkedAt, nsmall.checkedAt].filter(Boolean).sort().at(-1) ?? new Date().toISOString(),
    scope: {
      merchantIds: ['hmall', 'nsseshop'],
      maxSampleRecordsPerMerchant: 5,
      maxSampledMerchants: 2,
      executionMode: 'pure_http',
      browserUsed: false,
      credentialsUsed: false,
      reviewBodyOrIdentityPersisted: false,
    },
    merchants: [hmall, nsmall],
    unresolvedFrontier: [{
      merchantId: 'emart',
      operation: 'product_detail_and_reviews_list',
      status: 'blocked_http_403',
      receipt: SSG_BLOCK_RECEIPT,
      reason: 'Previously observed public www.ssg.com product URL returned HTTP 403; this task did not retry the blocked origin.',
      reviewSamples: [],
    }],
    mergeGuidance: {
      ontologyReviewSamples: hmall.records?.[0]?.reviewSamples?.length ?? 0,
      doNotClaimNsmallGeneralReviewCoverage: true,
      doNotRetrySsgBlockedOrigin: true,
      notes: [
        'Hmall review metadata is directly replayed and normalized; author, review id, text, and image URL are not retained.',
        'NSmall photo-review list returned zero photo rows; the separate general-review POST caller payload is unresolved and was not sent.',
        'SSG product detail is blocked at HTTP 403, so no review request was attempted.',
      ],
    },
  };
}
