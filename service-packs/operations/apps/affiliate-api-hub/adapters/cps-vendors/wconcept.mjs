import { createHash, randomUUID } from 'node:crypto';
import { readPublicPage, readPublicResource, extractPublicPage, isStrongPublicChallenge, safeUrl } from '../../lib/cps-public-reader.mjs';

const PAGE_URL = 'https://display.wconcept.co.kr/spc/product/casual';
const ALLOWED_SITE_HOSTS = ['wconcept.co.kr'];
const API_ORIGIN = 'https://api-display.wconcept.co.kr';
const API_PATH = '/display/api/v2/special/products/CASUAL';
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 3 * 1024 * 1024;
const MAX_API_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const REVIEWED_PRICE_CURRENCY_SOURCE_HASHES = Object.freeze({
  app: '01b68eab3935ae74db54c857fb6c4e3d09b5b2a910d90df3f3f3fb98ff2239f5',
  route: 'cd630dc4b05b1f5dd3906f612963172546790096d9b4e6cbb414928f0dd07fde',
});

function pageReceipt(page, kind) {
  const receipt = page?.receipt ?? {};
  return {
    receiptId: receipt.id ?? randomUUID(),
    kind,
    method: receipt.requestMethod ?? 'GET',
    requestedUrl: safeUrl(receipt.requestUrl ?? page?.url),
    finalUrl: safeUrl(page?.url),
    status: page?.status ?? receipt.responseStatus ?? null,
    mime: page?.contentType ?? receipt.contentType ?? null,
    bytes: receipt.bytes ?? 0,
    sha256: receipt.responseSha256 ?? null,
    checkedAt: receipt.observedAt ?? null,
    redirects: page?.redirects ?? [],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    stopReason: page?.stopReason ?? null,
  };
}

function observedScriptUrls(html, baseUrl) {
  const urls = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)) {
    const url = safeUrl(match[2], baseUrl);
    if (url && url.startsWith('https://')) urls.push(url);
  }
  return [...new Set(urls)];
}

function parseNextData(html) {
  const match = html.match(/<script\b(?=[^>]*\bid=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function cleanText(value, limit = 1000) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, limit) : null;
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^\s*-?\d[\d,]*(?:\.\d+)?\s*$/.test(value)) return null;
  const parsed = Number(value.replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function safeProductUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const cleaned = safeUrl(value.trim(), baseUrl);
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned);
    if (url.protocol !== 'https:' || !(url.hostname === 'wconcept.co.kr' || url.hostname.endsWith('.wconcept.co.kr'))) return null;
    return url.href;
  } catch { return null; }
}

function safeApiReceipt({ requestUrl, bodyText, startedAt, responseStatus = null, mime = null, bytes = 0, responseHash = null, stopReason = null, blocked = false, configReceiptId }) {
  return {
    receiptId: randomUUID(),
    kind: 'observed_product_listing_replay',
    method: 'POST',
    requestedUrl: safeUrl(requestUrl),
    finalUrl: safeUrl(requestUrl),
    status: Number.isInteger(responseStatus) ? responseStatus : null,
    mime,
    bytes,
    sha256: responseHash,
    requestBodySha256: createHash('sha256').update(bodyText).digest('hex'),
    checkedAt: startedAt,
    redirects: [],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    publicClientHeaderSent: true,
    publicHeaderName: 'DISPLAY-API-KEY',
    publicHeaderScope: new URL(requestUrl).origin,
    configReceiptId,
    publicClientConfigReceiptId: configReceiptId,
    blocked,
    stopReason,
  };
}

async function readBoundedResponse(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { raw: Buffer.alloc(0), tooLarge: false };
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > maxBytes) {
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining) chunks.push(Buffer.from(value.subarray(0, remaining)));
      bytes += remaining;
      await reader.cancel().catch(() => {});
      return { raw: Buffer.concat(chunks, bytes), tooLarge: true };
    }
    bytes += value.byteLength;
    chunks.push(Buffer.from(value));
  }
  return { raw: Buffer.concat(chunks, bytes), tooLarge: false };
}

async function postProductListing({ apiKey, body, configReceiptId }) {
  const requestUrl = `${API_ORIGIN}${API_PATH}`;
  const bodyText = JSON.stringify(body);
  const startedAt = new Date().toISOString();
  let response;
  try {
    response = await fetch(requestUrl, {
      method: 'POST',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json; charset=utf-8',
        'DISPLAY-API-KEY': apiKey,
        'CUST_NO': '',
        'WCK-CUST-BIRTHDATE': '',
        deviceType: 'PC',
        genderType: 'ALL',
        ageGroup: '',
      },
      body: bodyText,
    });
  } catch {
    const receipt = safeApiReceipt({ requestUrl, bodyText, startedAt, stopReason: 'PUBLIC_HTTP_TRANSPORT_FAILED', configReceiptId });
    return { ok: false, blocked: false, stopReason: 'PUBLIC_HTTP_TRANSPORT_FAILED', receipt, data: null };
  }

  const status = response.status;
  const mime = response.headers.get('content-type');
  const headerObject = Object.fromEntries(response.headers.entries());
  let bounded;
  try { bounded = await readBoundedResponse(response, MAX_API_BYTES); }
  catch {
    const receipt = safeApiReceipt({ requestUrl, bodyText, startedAt, responseStatus: status, mime, stopReason: 'PUBLIC_HTTP_BODY_READ_FAILED', configReceiptId });
    return { ok: false, blocked: false, stopReason: 'PUBLIC_HTTP_BODY_READ_FAILED', receipt, data: null };
  }

  if (bounded.tooLarge) {
    const receipt = safeApiReceipt({ requestUrl, bodyText, startedAt, responseStatus: status, mime, bytes: bounded.raw.length, responseHash: createHash('sha256').update(bounded.raw).digest('hex'), stopReason: 'RESPONSE_TOO_LARGE', configReceiptId });
    receipt.bodyTruncated = true;
    return { ok: false, blocked: false, stopReason: 'RESPONSE_TOO_LARGE', receipt, data: null };
  }

  const rawText = bounded.raw.toString('utf8');
  const responseHash = createHash('sha256').update(bounded.raw).digest('hex');
  const challenge = isStrongPublicChallenge(headerObject, rawText);
  const receiptBase = {
    requestUrl, bodyText, startedAt, responseStatus: status, mime,
    bytes: bounded.raw.length, responseHash, configReceiptId,
  };

  if ([401, 403, 418, 429].includes(status)) {
    const receipt = safeApiReceipt({ ...receiptBase, stopReason: 'HTTP_ACCESS_BLOCKED', blocked: true });
    return { ok: false, blocked: true, stopReason: 'HTTP_ACCESS_BLOCKED', receipt, data: null };
  }
  if (status >= 300 && status < 400) {
    const receipt = safeApiReceipt({ ...receiptBase, stopReason: 'REDIRECT_MANUAL_STOP' });
    return { ok: false, blocked: false, stopReason: 'REDIRECT_MANUAL_STOP', receipt, data: null };
  }
  if (challenge) {
    const receipt = safeApiReceipt({ ...receiptBase, stopReason: 'PUBLIC_CHALLENGE', blocked: true });
    return { ok: false, blocked: true, stopReason: 'PUBLIC_CHALLENGE', receipt, data: null };
  }
  if (!response.ok) {
    const receipt = safeApiReceipt({ ...receiptBase, stopReason: 'HTTP_UNEXPECTED_STATUS' });
    return { ok: false, blocked: false, stopReason: 'HTTP_UNEXPECTED_STATUS', receipt, data: null };
  }
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(mime ?? '')) {
    const receipt = safeApiReceipt({ ...receiptBase, stopReason: 'RESPONSE_NOT_JSON' });
    return { ok: false, blocked: false, stopReason: 'RESPONSE_NOT_JSON', receipt, data: null };
  }

  let data;
  try { data = JSON.parse(rawText); }
  catch {
    const receipt = safeApiReceipt({ ...receiptBase, stopReason: 'RESPONSE_JSON_INVALID' });
    return { ok: false, blocked: false, stopReason: 'RESPONSE_JSON_INVALID', receipt, data: null };
  }
  const receipt = safeApiReceipt({ ...receiptBase });
  const productList = data?.data?.productList;
  if (data?.result !== 'SUCCESS' || !Array.isArray(productList?.content)) {
    return {
      ok: false,
      blocked: false,
      stopReason: 'APPLICATION_SCHEMA_OR_RESULT_REJECTED',
      receipt: { ...receipt, stopReason: 'APPLICATION_SCHEMA_OR_RESULT_REJECTED' },
      data: {
        result: cleanText(data?.result, 80),
        errorCode: typeof data?.errorCode === 'number' || typeof data?.errorCode === 'string' ? data.errorCode : null,
        responseKeys: Object.keys(data ?? {}).slice(0, 40),
      },
    };
  }
  return { ok: true, blocked: false, stopReason: null, receipt, data };
}

function mapProducts(payload, receiptId, pageUrl, limit = 60) {
  const products = payload?.data?.productList?.content;
  if (!Array.isArray(products)) return [];
  return products.slice(0, limit).flatMap((item, index) => {
    const sourceLocalId = item?.itemCd == null ? null : cleanText(String(item.itemCd), 100);
    const title = cleanText(item?.itemName, 1000);
    const finalPrice = numericValue(item?.finalPrice);
    const customerPrice = numericValue(item?.customerPrice);
    if (!sourceLocalId || !title || (finalPrice == null && customerPrice == null)) return [];

    const reviewScore = numericValue(item?.reviewScore);
    const reviewCount = numericValue(item?.reviewCnt);
    const rating = reviewScore == null && reviewCount == null ? null : {
      value: reviewScore === 0 && reviewCount === 0 ? null : reviewScore,
      best: null,
      worst: null,
      reviewCount,
      ratingCount: null,
    };
    const detailUrl = safeProductUrl(item?.webViewUrl, pageUrl);
    const brand = cleanText(item?.brandNameKr ?? item?.brandNameEn, 300);
    const fields = ['sourceLocalId', 'title'];
    if (finalPrice != null || customerPrice != null) fields.push('price');
    if (rating) fields.push('rating');
    if (detailUrl) fields.push('url');
    if (brand) fields.push('brand');

    const primaryPrice = finalPrice ?? customerPrice;
    const offers = [];
    if (finalPrice != null) offers.push({ amount: finalPrice, currency: null, priceText: null, lowPrice: null, highPrice: null, type: 'finalPrice', availability: null, seller: 'W컨셉', validFrom: null, validUntil: null, condition: null, url: detailUrl });
    if (customerPrice != null && customerPrice !== finalPrice) offers.push({ amount: customerPrice, currency: null, priceText: null, lowPrice: null, highPrice: null, type: 'customerPrice', availability: null, seller: 'W컨셉', validFrom: null, validUntil: null, condition: null, url: detailUrl });

    return [{
      type: 'RetailProduct',
      sourceLocalId,
      title,
      url: detailUrl,
      description: cleanText(item?.itemNameSub, 2000),
      brand,
      price: { amount: primaryPrice, currency: null, priceText: null },
      rating,
      offers,
      variants: [],
      reviewSamples: [],
      evidence: [{ receiptId, locator: `data.productList.content[${index}]`, fields }],
    }];
  });
}

function operation(state, evidenceReceiptIds, note = null) {
  return { state, evidenceReceiptIds: [...new Set(evidenceReceiptIds.filter(Boolean))], note };
}

/** Collect one page from W Concept's publicly listed CASUAL products. */
export async function collectWconcept({ page = 1, pageSize = 60 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
    throw new RangeError('PAGE_OUT_OF_RANGE');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 60) {
    throw new RangeError('PAGE_SIZE_OUT_OF_RANGE');
  }
  const receipts = [];
  const contracts = [];
  const frontier = [];
  const emptyRow = {
    merchantId: 'wconcept',
    merchantName: '더블유컨셉코리아',
    siteUrl: 'https://display.wconcept.co.kr/',
    verticalHint: 'fashion',
    receipts,
    records: [],
    contracts,
    operations: {
      queryApplied: false,
      keywordSearch: { ...operation('not_verified', [], 'The observed CASUAL listing POST has no keyword field; keyword search was not attempted.'), queryApplied: false },
    },
    queryApplied: false,
    sourceCurrency: { state: 'not_observed', currency: null, evidenceReceiptIds: [] },
    frontier,
    status: 'attempt_without_response',
  };

  const landingPage = await readPublicPage(PAGE_URL, { allowedHosts: ALLOWED_SITE_HOSTS, maxBytes: MAX_PAGE_BYTES, timeoutMs: TIMEOUT_MS });
  const pageRow = pageReceipt(landingPage, 'category_document_get');
  receipts.push(pageRow);
  if (!landingPage.ok) {
    emptyRow.operations.landingAndObservedPages = operation(landingPage.blocked ? 'blocked' : 'attempt_without_response', [pageRow.receiptId], landingPage.stopReason);
    emptyRow.operations.productListing = operation('not_observed', [], 'Listing POST was not attempted because the observed public category page was unavailable.');
    emptyRow.operations.productOrServiceRecord = operation('not_observed', [], 'No product response was available.');
    emptyRow.status = landingPage.blocked ? 'blocked' : 'attempt_without_response';
    return emptyRow;
  }

  const extracted = extractPublicPage(landingPage, { merchantId: 'wconcept', typeHint: 'fashion' });
  const nextData = parseNextData(landingPage.html);
  const runtimeConfig = nextData?.runtimeConfig;
  const assistData = nextData?.props?.pageProps?.assistData;
  const configReceiptId = landingPage.receipt?.id ?? pageRow.receiptId;

  if (!runtimeConfig || assistData?.isLogin !== false) {
    emptyRow.operations.landingAndObservedPages = operation('live_replay', [pageRow.receiptId], 'Anonymous category HTML was reachable, but public runtime config or logged-out state was not verified.');
    emptyRow.operations.productListing = operation('not_observed', [pageRow.receiptId], 'No POST was sent without verified anonymous runtime configuration.');
    emptyRow.operations.productOrServiceRecord = operation('not_observed', [pageRow.receiptId]);
    emptyRow.status = 'reachable_no_ontology_record';
    return emptyRow;
  }

  let observedApiBase;
  try { observedApiBase = new URL(runtimeConfig.DISPLAY_API_BASE_URL); }
  catch {
    emptyRow.operations.landingAndObservedPages = operation('live_replay', [pageRow.receiptId]);
    emptyRow.operations.productListing = operation('not_observed', [pageRow.receiptId], 'Public API base URL was missing or invalid.');
    emptyRow.operations.productOrServiceRecord = operation('not_observed', [pageRow.receiptId]);
    emptyRow.status = 'reachable_no_ontology_record';
    return emptyRow;
  }
  if (observedApiBase.origin !== API_ORIGIN || observedApiBase.username || observedApiBase.password || observedApiBase.port) {
    emptyRow.operations.landingAndObservedPages = operation('live_replay', [pageRow.receiptId]);
    emptyRow.operations.productListing = operation('not_observed', [pageRow.receiptId], 'Runtime API origin did not match the fixed observed WConcept API origin.');
    emptyRow.operations.productOrServiceRecord = operation('not_observed', [pageRow.receiptId]);
    emptyRow.status = 'reachable_no_ontology_record';
    return emptyRow;
  }
  const apiKey = runtimeConfig.DISPLAY_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey) {
    emptyRow.operations.landingAndObservedPages = operation('live_replay', [pageRow.receiptId]);
    emptyRow.operations.productListing = operation('not_observed', [pageRow.receiptId], 'Public client header was unavailable in the anonymous runtime config.');
    emptyRow.operations.productOrServiceRecord = operation('not_observed', [pageRow.receiptId]);
    emptyRow.status = 'reachable_no_ontology_record';
    return emptyRow;
  }

  const scriptUrls = observedScriptUrls(landingPage.html, landingPage.url);
  const appUrl = scriptUrls.find(url => /\/static\/chunks\/pages\/_app-[^/]+\.js$/i.test(new URL(url).pathname));
  const routeUrl = scriptUrls.find(url => /\/static\/chunks\/pages\/spc\/product\/[^/]+\.js$/i.test(new URL(url).pathname));
  if (!appUrl || !routeUrl) {
    emptyRow.operations.landingAndObservedPages = operation('live_replay', [pageRow.receiptId]);
    emptyRow.operations.productListing = operation('not_observed', [pageRow.receiptId], 'The observed category route/client script references were not present in the HTML.');
    emptyRow.operations.productOrServiceRecord = operation('not_observed', [pageRow.receiptId]);
    emptyRow.status = 'reachable_no_ontology_record';
    return emptyRow;
  }

  const [appClient, routeClient] = await Promise.all([
    readPublicResource(appUrl, { allowedHosts: ALLOWED_SITE_HOSTS, maxBytes: MAX_RESOURCE_BYTES, timeoutMs: TIMEOUT_MS }),
    readPublicResource(routeUrl, { allowedHosts: ALLOWED_SITE_HOSTS, maxBytes: MAX_RESOURCE_BYTES, timeoutMs: TIMEOUT_MS }),
  ]);
  const appRow = pageReceipt(appClient, 'observed_api_client_bundle_get');
  const routeRow = pageReceipt(routeClient, 'observed_product_route_bundle_get');
  receipts.push(appRow, routeRow);
  const clientEvidenceIds = [pageRow.receiptId, appRow.receiptId, routeRow.receiptId];
  const reviewedPriceCurrencySourcesMatch = appRow.sha256 === REVIEWED_PRICE_CURRENCY_SOURCE_HASHES.app
    && routeRow.sha256 === REVIEWED_PRICE_CURRENCY_SOURCE_HASHES.route;
  emptyRow.sourceCurrency = {
    state: reviewedPriceCurrencySourcesMatch ? 'not_observed' : 'not_verified',
    currency: null,
    evidenceReceiptIds: [appRow.receiptId, routeRow.receiptId],
    note: reviewedPriceCurrencySourcesMatch
      ? 'Reviewed page-linked app/route bundle versions contain no first-party renderer/configuration proof tying numeric listing prices to a currency.'
      : 'The page-linked app/route bundle version differs from the statically reviewed currency sources; currency remains null pending a new review.',
  };
  const appCodeMatches = appClient.ok
    && appClient.body.includes('DISPLAY_API_BASE_URL')
    && appClient.body.includes('DISPLAY_API_KEY')
    && appClient.body.includes('DISPLAY-API-KEY')
    && appClient.body.includes('/display/api/v2/special/products/');
  const routeCodeMatches = routeClient.ok
    && routeClient.body.includes('pageType:P.toUpperCase()')
    && routeClient.body.includes('pageSize:60')
    && routeClient.body.includes('domainType:E?"pc":"m"');
  contracts.push(
    {
      operation: 'category_document_get', method: 'GET', requestUrl: PAGE_URL, finalUrl: landingPage.url,
      status: landingPage.status, mime: landingPage.contentType, parser: 'extractPublicPage + anonymous __NEXT_DATA__ runtimeConfig',
      recordCount: extracted.records.length, receiptId: pageRow.receiptId,
      loggedOut: true, productState: 'SSR shell; product list loads through the page-linked API client.',
    },
    {
      operation: 'product_listing_client_contract', method: 'POST', requestOrigin: API_ORIGIN,
      requestPath: API_PATH, contentType: 'application/json; charset=utf-8', publicHeaderName: 'DISPLAY-API-KEY',
      publicHeaderSource: '__NEXT_DATA__.runtimeConfig.DISPLAY_API_KEY', publicHeaderValueStored: false,
      requestBodySource: 'page-linked app module 82911 G9; route module default state',
      requestFields: ['pageType', 'custNo', 'gender', 'sort', 'pageNo', 'pageSize', 'bcds', 'mcd', 'ccds', 'pcds', 'lcds', 'minPrice', 'maxPrice', 'colors', 'benefits', 'discounts', 'status', 'domainType', 'saleTags'],
      responseFields: ['data.productList.content[].itemCd', 'itemName', 'finalPrice', 'customerPrice', 'reviewScore', 'reviewCnt', 'webViewUrl'],
      catalogOperation: 'productListing',
      queryApplied: false,
      keywordSearch: 'not_verified',
      priceCurrencyFieldObserved: false,
      clientSourceReceiptIds: [appRow.receiptId, routeRow.receiptId],
      exactClientContractVerified: appCodeMatches && routeCodeMatches,
      publicClientHeader: true, browserUsed: false, cookiesSent: false, authorizationSent: false,
    },
    {
      operation: 'price_currency_static_inspection', method: 'STATIC_INSPECTION',
      sourceReceiptIds: [appRow.receiptId, routeRow.receiptId],
      evidenceReceiptIds: [appRow.receiptId, routeRow.receiptId],
      sourceHashesMatchReviewed: reviewedPriceCurrencySourcesMatch,
      state: reviewedPriceCurrencySourcesMatch ? 'no_explicit_first_party_price_currency_evidence' : 'source_version_not_reviewed',
      priceCurrencyRendererObserved: reviewedPriceCurrencySourcesMatch ? false : null,
      currencyAssigned: false,
      scriptsExecuted: false,
      locator: reviewedPriceCurrencySourcesMatch ? 'app bundle byte offset 323924 (unrelated advertising conversion); route bundle byte offset 38677 (numeric item price props forwarded without a currency prop)' : null,
    },
  );

  if (!appCodeMatches || !routeCodeMatches) {
    emptyRow.operations.landingAndObservedPages = operation('live_replay', [pageRow.receiptId]);
    emptyRow.operations.productListing = operation('not_observed', clientEvidenceIds, 'Current page-linked JavaScript no longer matches the captured category-listing contract.');
    emptyRow.operations.productOrServiceRecord = operation('not_observed', clientEvidenceIds);
    emptyRow.status = 'reachable_no_ontology_record';
    return emptyRow;
  }

  const body = {
    pageType: 'CASUAL',
    custNo: '',
    gender: 'all',
    sort: 'SALE',
    pageNo: page,
    pageSize,
    bcds: [],
    mcd: undefined,
    ccds: undefined,
    pcds: undefined,
    lcds: [],
    minPrice: undefined,
    maxPrice: undefined,
    colors: [],
    benefits: [],
    discounts: [],
    status: undefined,
    saleTags: undefined,
    domainType: 'pc',
  };
  const response = await postProductListing({ apiKey, body, configReceiptId });
  receipts.push(response.receipt);
  const responseReceiptId = response.receipt.receiptId;
  contracts[1] = {
    ...contracts[1],
    requestBodySha256: response.receipt.requestBodySha256,
    status: response.receipt.status,
    mime: response.receipt.mime,
    bytes: response.receipt.bytes,
    responseSha256: response.receipt.sha256,
    responseReceiptId,
    replayState: response.ok ? 'replay_verified' : response.stopReason,
    responseKeys: response.ok ? Object.keys(response.data ?? {}).slice(0, 40) : response.data?.responseKeys ?? [],
    applicationResult: response.data?.result ?? null,
    applicationErrorCode: response.data?.errorCode ?? null,
  };

  emptyRow.operations.landingAndObservedPages = operation('live_replay', clientEvidenceIds);
  if (!response.ok) {
    const blocked = response.blocked;
    const failureState = blocked ? 'blocked'
      : response.stopReason === 'APPLICATION_SCHEMA_OR_RESULT_REJECTED' ? 'application_error'
        : response.receipt.status ? 'attempt_without_response' : 'attempt_without_response';
    emptyRow.operations.productListing = operation(failureState, [pageRow.receiptId, appRow.receiptId, routeRow.receiptId, responseReceiptId], response.stopReason);
    emptyRow.operations.productOrServiceRecord = operation(failureState, [responseReceiptId], response.stopReason);
    emptyRow.operations.price = operation('not_observed', [responseReceiptId], 'No product rows were returned.');
    emptyRow.operations.priceCurrency = operation('not_observed', [appRow.receiptId, routeRow.receiptId, responseReceiptId], 'No first-party price currency was verified.');
    emptyRow.operations.ratingSummary = operation('not_observed', [responseReceiptId], 'No rating or review summary was returned.');
    emptyRow.operations.variants = operation('not_observed', [responseReceiptId]);
    emptyRow.operations.reviewSamples = operation('not_observed', [responseReceiptId]);
    emptyRow.status = blocked ? 'blocked' : 'reachable_no_ontology_record';
    return emptyRow;
  }

  const productList = response.data?.data?.productList;
  const records = mapProducts(response.data, responseReceiptId, landingPage.url, pageSize);
  emptyRow.records = records;
  const pageCount = numericValue(productList?.totalPages);
  const totalElements = numericValue(productList?.totalElements);
  const returnedPageNumber = numericValue(productList?.number);
  const nextPage = returnedPageNumber != null
    ? returnedPageNumber + 1
    : page + 1;
  const hasNextPage = pageCount != null
    ? nextPage <= pageCount
    : records.length === pageSize;
  emptyRow.pagination = {
    requestedPage: page,
    requestedPageSize: pageSize,
    returnedPageNumber,
    totalPages: pageCount,
    totalElements,
    hasNextPage,
    nextPage: hasNextPage ? nextPage : null,
  };
  const recordDetails = records.filter(record => record.url).slice(0, 5);
  for (const record of recordDetails) {
    frontier.push({
      url: record.url,
      text: `API response webViewUrl for WConcept item ${record.sourceLocalId}`,
      state: 'observed_product_detail_pending',
      note: 'Only the exact API-provided detail URL is queued; this adapter does not guess alternate paths.',
    });
  }
  if (hasNextPage) {
    frontier.push({
      url: PAGE_URL,
      text: `page=${nextPage} via observed v2 product-search body`,
      state: 'pending_budget_frontier',
      note: `API reports ${pageCount ?? 'unknown'} pages; this adapter call collected page ${page} only.`,
    });
  }

  const recordHasPrice = records.some(record => record.price?.amount != null);
  const recordHasRating = records.some(record => record.rating && (record.rating.value != null || record.rating.reviewCount != null));
  emptyRow.operations.productListing = operation('live_replay', [pageRow.receiptId, appRow.receiptId, routeRow.receiptId, responseReceiptId], `${records.length} normalized records from the CASUAL product listing page ${page} of ${pageCount ?? 'unknown'} (pageSize ${pageSize}); no keyword query was applied.`);
  emptyRow.operations.productOrServiceRecord = operation(records.length ? 'live_replay' : 'not_observed', [responseReceiptId]);
  emptyRow.operations.price = operation(recordHasPrice ? 'live_replay' : 'not_observed', [responseReceiptId]);
  emptyRow.operations.priceCurrency = operation(reviewedPriceCurrencySourcesMatch ? 'not_observed' : 'not_verified', [appRow.receiptId, routeRow.receiptId, responseReceiptId], 'Numeric amounts are retained with currency null; the inspected source version did not establish a price currency.');
  emptyRow.operations.ratingSummary = operation(recordHasRating ? 'live_replay' : 'not_observed', [responseReceiptId], recordHasRating ? null : 'The product list did not expose rating/review summary values.');
  emptyRow.operations.variants = operation('not_observed', [responseReceiptId], 'This product-list contract does not expose product variants.');
  emptyRow.operations.reviewSamples = operation('not_observed', [responseReceiptId], 'Only list-level reviewScore/reviewCnt are mapped; no review text was fetched.');
  emptyRow.status = records.length ? 'reachable_with_ontology_records' : 'reachable_no_ontology_record';
  return emptyRow;
}
