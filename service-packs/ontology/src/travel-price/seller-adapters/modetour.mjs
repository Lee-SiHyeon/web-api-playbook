import { createHash } from 'node:crypto';

const WEB_ORIGIN = 'https://www.modetour.com';
const API_ORIGIN = 'https://b2c-api.modetour.com';
const CONTEXT_COOKIE = 'ModeEcommerceContext';
const RECOMMENDATION_PATH = '/Package/GetRecommendedProduct';
const PRODUCT_MASTER_PATH = '/Package/GetProductMasterByIds';
const CONTEXT_PATH = '/package/overseas';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36';
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_DESTINATIONS = new Map([
  ['다낭', ['다낭', 'danang', 'da nang']],
  ['나트랑', ['나트랑', '냐짱', 'nha trang', 'nhatrang']],
  ['호이안', ['호이안', 'hoi an', 'hoian']],
]);
const FORBIDDEN_PERSISTED_HEADERS = /cookie|authorization|modewebapireqheader|token|api[-_]?key/i;
const CHALLENGE = /captcha|cloudflare|attention required|cf-chl-|challenge-platform|cf-turnstile|verify you are (?:human|a person)|automated requests|bot detection|checking your browser/i;

function asObject(input, label) {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = typeof value === 'number' ? value : Number(String(value).replace(/[\s,]/g, ''));
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function dateOnly(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function recommendationRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.products)) return payload.products;
  if (Array.isArray(payload.result?.package)) return payload.result.package;
  return [];
}

function productMasterRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.products)) return payload.products;
  const productMaster = payload.result?.productMaster;
  if (Array.isArray(productMaster)) return productMaster;
  return productMaster && typeof productMaster === 'object' ? [productMaster] : [];
}

function explicitCurrency(item, productMaster) {
  return nonempty(productMaster.currency ?? productMaster.currencyCode ?? productMaster.priceCurrency
    ?? item.currency ?? item.currencyCode ?? item.priceCurrency);
}

function explicitBasis(item, productMaster) {
  return nonempty(productMaster.quotedBasis ?? productMaster.priceBasis ?? productMaster.basis
    ?? item.quotedBasis ?? item.priceBasis ?? item.basis);
}

function durationOptions(productMaster) {
  return arrayOrEmpty(productMaster.dates)
    .map((row) => ({
      nights: Number.isInteger(Number(row?.night)) && Number(row.night) > 0 ? Number(row.night) : null,
      days: Number.isInteger(Number(row?.days)) && Number(row.days) > 0 ? Number(row.days) : null,
      source: row,
    }))
    .filter((row) => row.nights !== null || row.days !== null);
}

function airlineOptions(productMaster) {
  const seen = new Set();
  return arrayOrEmpty(productMaster.productCodes).flatMap((row) => {
    const option = {
      marketingAirCode: nonempty(row?.marketingAirCode),
      marketingAirName: nonempty(row?.marketingAirName),
      transportCode: nonempty(row?.transportCode),
      transportName: nonempty(row?.transportName),
      computedProductCode: nonempty(row?.computedProductCode),
    };
    if (!Object.values(option).some(Boolean)) return [];
    const key = JSON.stringify(option);
    if (seen.has(key)) return [];
    seen.add(key);
    return [option];
  });
}

function areas(productMaster) {
  return arrayOrEmpty(productMaster.areas).map((area) => nonempty(area?.name)).filter(Boolean);
}

function normalizeRecommendation(item, detail = null) {
  const master = detail ?? (item.productMaster && !Array.isArray(item.productMaster) ? item.productMaster : {});
  const sellerProductId = master.masterCodeNo ?? item.masterCodeNo ?? item.masterCodeId ?? item.productsCode ?? null;
  const destinationNames = areas(master);
  const names = [...new Set(destinationNames)];
  const airportNames = arrayOrEmpty(master.depatureFrom).map(nonempty).filter(Boolean);
  const airportCodes = arrayOrEmpty(master.depatures).map(nonempty).filter(Boolean);
  const listPrice = numeric(item.price);
  const detailPrice = numeric(master.price);
  const currency = explicitCurrency(item, master);
  const quotedBasis = explicitBasis(item, master);
  const dateCandidates = arrayOrEmpty(master.departureDates);
  const minimumObservedDepartureDate = dateOnly(master.minDepartureDate);

  return {
    sellerId: 'modetour-package',
    sellerProductId: sellerProductId === null ? null : String(sellerProductId),
    sellerMasterCode: nonempty(master.masterCode) ?? nonempty(item.productsCode),
    sellerMasterCodeId: nonempty(master.masterCodeId) ?? nonempty(item.masterCodeId),
    title: nonempty(master.masterProductName) ?? nonempty(item.productsName),
    destinationText: [
      ...names,
      nonempty(master.areaName),
      nonempty(item.productsName),
      nonempty(master.masterProductName),
      nonempty(item.tag),
    ].filter(Boolean).join(' '),
    destinationCitySet: names.length ? names : null,
    nights: null,
    days: null,
    durationOptions: durationOptions(master),
    departureAirport: null,
    departureAirportText: airportNames.length ? airportNames.join(' / ') : null,
    departureAirportCodes: airportCodes,
    airlineName: null,
    airlineNamesSummaryText: [...new Set(airlineOptions(master).map((row) => row.marketingAirName ?? row.transportName).filter(Boolean))].join(' / ') || null,
    airlineOptions: airlineOptions(master),
    airlineClass: null,
    directness: null,
    hotelGradeBand: null,
    shoppingStopBand: null,
    summaryPriceMinKrw: null,
    summaryPriceMaxKrw: null,
    priceQuote: {
      summaryAmount: listPrice,
      detailAmount: detailPrice,
      currency,
      quotedBasis,
      currencySourceField: currency ? 'seller-declared currency field' : null,
      quotedBasisSourceField: quotedBasis ? 'seller-declared basis field' : null,
      normalization: 'amounts kept in seller response units; no currency or per-person basis inferred',
    },
    minimumObservedDepartureDate,
    departureDates: dateCandidates,
    departureAvailability: null,
    departureAvailabilityStatus: dateCandidates.length ? 'seller supplied departureDates; semantics unverified' : 'not_observed',
    departures: [],
    reservationSeatRaw: numeric(master.reservationSeat),
    durationSourceRows: arrayOrEmpty(master.dates),
    departureSourceFields: {
      minDepartureDate: master.minDepartureDate ?? null,
      departureDates: dateCandidates,
      depatureFrom: Array.isArray(master.depatureFrom) ? master.depatureFrom : null,
      depatures: Array.isArray(master.depatures) ? master.depatures : null,
    },
    productCodes: airlineOptions(master),
    raw: {
      list: {
        type: item.type ?? null,
        subType: item.subType ?? null,
        productsType: item.productsType ?? null,
        productsMapTypeCode: item.productsMapTypeCode ?? null,
        productsCode: item.productsCode ?? null,
        masterCodeId: item.masterCodeId ?? null,
        masterCodeNo: item.masterCodeNo ?? null,
        productsName: item.productsName ?? null,
        price: item.price ?? null,
        currency: item.currency ?? item.currencyCode ?? item.priceCurrency ?? null,
        quotedBasis: item.quotedBasis ?? item.priceBasis ?? item.basis ?? null,
      },
      productMaster: {
        masterCode: master.masterCode ?? null,
        masterCodeId: master.masterCodeId ?? null,
        masterCodeNo: master.masterCodeNo ?? null,
        masterProductName: master.masterProductName ?? null,
        price: master.price ?? null,
        currency: master.currency ?? master.currencyCode ?? master.priceCurrency ?? null,
        quotedBasis: master.quotedBasis ?? master.priceBasis ?? master.basis ?? null,
        period: master.period ?? null,
        dates: arrayOrEmpty(master.dates),
        minDepartureDate: master.minDepartureDate ?? null,
        departureDates: dateCandidates,
        depatureFrom: Array.isArray(master.depatureFrom) ? master.depatureFrom : null,
        depatures: Array.isArray(master.depatures) ? master.depatures : null,
        areas: arrayOrEmpty(master.areas),
        productCodes: arrayOrEmpty(master.productCodes),
        reservationSeat: master.reservationSeat ?? null,
      },
    },
  };
}

function destinationMatches(item, destination) {
  const target = String(destination ?? '').trim();
  const aliases = DEFAULT_DESTINATIONS.get(target) ?? [target];
  const master = item.productMaster && !Array.isArray(item.productMaster) ? item.productMaster : {};
  const explicitAreaNames = [...areas(master), nonempty(master.areaName)].filter(Boolean);
  const searchable = explicitAreaNames.length
    ? explicitAreaNames
    : [item.productsName, master.masterProductName, item.tag].map(nonempty).filter(Boolean);
  const normalize = (value) => String(value).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s/·()[\]]/g, '');
  return aliases.some((alias) => searchable.some((value) => normalize(value).includes(normalize(alias))));
}

function contextCookieFrom(response) {
  const setCookie = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  let value = null;
  for (const line of setCookie) {
    const pair = line.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator).trim() === CONTEXT_COOKIE) value = pair.slice(separator + 1);
  }
  if (!value) return { context: null, cookieNames: setCookie.map((line) => line.split('=', 1)[0]) };
  try {
    const context = JSON.parse(decodeURIComponent(value));
    return { context, cookieNames: setCookie.map((line) => line.split('=', 1)[0]) };
  } catch {
    return { context: null, cookieNames: setCookie.map((line) => line.split('=', 1)[0]) };
  }
}

/** Convert only the observed lower-camel ModeEcommerceContext keys through the first-party SDK mapping. */
export function buildModeWebApiReqHeaderFromContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || context.webSiteNo === undefined || context.companyNo === undefined
    || typeof context.deviceType !== 'string' || !context.deviceType.trim()
    || context.apiKey === undefined) return null;
  const sdkInput = {
    WebSiteNo: context.webSiteNo,
    CompanyNo: context.companyNo,
    DeviceType: context.deviceType,
    ApiKey: context.apiKey,
  };
  return Buffer.from(JSON.stringify(sdkInput), 'utf8').toString('base64');
}

async function directRead({ fetchImpl, name, url, method = 'GET', headers = {}, timeoutMs = 20000 }) {
  const checkedAt = new Date().toISOString();
  const response = await fetchImpl(url, {
    method,
    headers: {
      'user-agent': DEFAULT_UA,
      'accept-language': 'ko-KR,ko;q=0.9',
      accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
      ...headers,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const boundedBody = await readBoundedResponseBody(response, MAX_RESPONSE_BODY_BYTES);
  const text = boundedBody.text;
  const sentHeaders = {
    'user-agent': DEFAULT_UA,
    'accept-language': 'ko-KR,ko;q=0.9',
    accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
    ...headers,
  };
  const meta = {
    name,
    method,
    origin: new URL(url).origin,
    pathname: new URL(url).pathname,
    queryKeys: [...new URL(url).searchParams.keys()].sort(),
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    checkedAt,
    bytes: boundedBody.bytes?.length ?? null,
    bytesObservedBeforeCancel: boundedBody.bytesObservedBeforeCancel,
    declaredContentLengthBytes: boundedBody.declaredContentLengthBytes,
    responseBodyReadStatus: boundedBody.status,
    responseBodyLimitBytes: MAX_RESPONSE_BODY_BYTES,
    sha256: boundedBody.bytes ? createHashSha256(boundedBody.bytes) : null,
    locationPresent: Boolean(response.headers.get('location')),
    responseCookieNames: (typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [])
      .map((line) => line.split('=', 1)[0]),
    requestHeaderNames: Object.keys(sentHeaders).map((key) => key.toLowerCase()).sort(),
    challengeSignals: {
      captcha: /captcha|hcaptcha|recaptcha/i.test(text),
      cloudflare: /cf-chl|cloudflare ray id/i.test(text),
      accessDenied: /access denied|automated access|security check|bot detection|request rejected/i.test(text.slice(0, 20000)),
    },
  };
  if (meta.requestHeaderNames.some((key) => FORBIDDEN_PERSISTED_HEADERS.test(key))
    && meta.requestHeaderNames.includes('cookie')) throw new Error('cookie propagation is disallowed');
  return { response, text, meta };
}

async function readBoundedResponseBody(response, limitBytes) {
  const rawLength = response.headers.get('content-length');
  const declaredContentLengthBytes = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
  const body = response.body;
  if (Number.isSafeInteger(declaredContentLengthBytes) && declaredContentLengthBytes > limitBytes) {
    try { await body?.cancel('Mode response exceeded bounded body limit'); } catch {}
    return {
      status: 'content_length_exceeds_limit',
      text: '',
      bytes: null,
      bytesObservedBeforeCancel: 0,
      declaredContentLengthBytes,
    };
  }
  if (body === null) {
    const bytes = Buffer.alloc(0);
    return { status: 'complete', text: '', bytes, bytesObservedBeforeCancel: 0, declaredContentLengthBytes };
  }
  if (typeof body?.getReader !== 'function') {
    try { await body?.cancel?.('Mode response body stream is unavailable'); } catch {}
    return {
      status: 'stream_unavailable',
      text: '',
      bytes: null,
      bytesObservedBeforeCancel: 0,
      declaredContentLengthBytes,
    };
  }

  const reader = body.getReader();
  const chunks = [];
  let bytesObserved = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkBytes = value?.byteLength ?? 0;
      if (bytesObserved + chunkBytes > limitBytes) {
        const bytesObservedBeforeCancel = bytesObserved + chunkBytes;
        chunks.length = 0;
        try { await reader.cancel('Mode response exceeded bounded body limit'); } catch {}
        return {
          status: 'stream_exceeds_limit',
          text: '',
          bytes: null,
          bytesObservedBeforeCancel,
          declaredContentLengthBytes,
        };
      }
      chunks.push(Buffer.from(value));
      bytesObserved += chunkBytes;
    }
    const bytes = Buffer.concat(chunks, bytesObserved);
    return {
      status: 'complete',
      text: bytes.toString('utf8'),
      bytes,
      bytesObservedBeforeCancel: bytesObserved,
      declaredContentLengthBytes,
    };
  } catch {
    try { await reader.cancel('Mode response stream read failed'); } catch {}
    return {
      status: 'stream_read_failed',
      text: '',
      bytes: null,
      bytesObservedBeforeCancel: bytesObserved,
      declaredContentLengthBytes,
    };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function createHashSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function applicationError(payload, label) {
  if (payload?.isOK === true) return null;
  if (payload?.isOK === false) return `${label} returned isOK=false`;
  if (Array.isArray(payload?.products) || Array.isArray(payload?.result?.package)
    || Array.isArray(payload?.result?.productMaster) || payload?.result?.productMaster) return null;
  return `${label} response has no successful application envelope`;
}

function validateReadResponse(result, label) {
  if (result.meta.status === 403 || result.meta.status === 418 || result.meta.status === 429 || result.meta.status >= 500
    || CHALLENGE.test(result.text)) {
    const suffix = Object.values(result.meta.challengeSignals).some(Boolean) || CHALLENGE.test(result.text) ? ' challenge/access block' : '';
    throw new Error(`${label} stopped at HTTP ${result.meta.status}${suffix}`);
  }
  if (result.meta.status < 200 || result.meta.status >= 300) throw new Error(`${label} failed with HTTP ${result.meta.status}`);
  if (result.meta.responseBodyReadStatus !== 'complete') {
    throw new Error(`${label} response body read stopped at ${result.meta.responseBodyReadStatus} (limit ${result.meta.responseBodyLimitBytes} bytes)`);
  }
}

function parseJson(text, label) {
  try { return asObject(text, label); }
  catch { throw new TypeError(`${label} was not a JSON object`); }
}

function errorResult(error, requests, checkedAt) {
  const challenge = /challenge|access block|HTTP (?:403|418|429|503)/i.test(error.message);
  return {
    schemaVersion: 1,
    sourceId: 'modetour-package',
    checkedAt,
    mode: 'anonymous-direct-api',
    contractSourceObserved: true,
    httpIndependentLive: hasIndependentHttpLive(requests),
    verdict: challenge ? 'challenge_blocked' : 'endpoint_error',
    requestCount: requests.length,
    requests,
    products: [],
    fiveStates: {
      captured: false,
      client_exists: true,
      credential_propagated: false,
      anonymous_sdk_context_propagated: requests.some((row) => row.requestHeaderNames?.includes('modewebapireqheader')),
      remnant_free: true,
      live_replay: false,
    },
    error: error.message,
    limitations: ['Only observed public read contracts are attempted. No retry, challenge bypass, authentication write, or session persistence is performed.'],
  };
}

function hasIndependentHttpLive(requests) {
  const apiRequests = requests.filter((row) => row.origin === API_ORIGIN);
  return apiRequests.length > 0 && apiRequests.every((row) => row.status >= 200 && row.status < 300
    && row.responseBodyReadStatus === 'complete');
}

/** Parse the direct public `GetRecommendedProduct?theme=Package` application response. */
export function parseModetourRecommendationList(input) {
  const payload = asObject(input, 'Mode recommendation response');
  const error = applicationError(payload, 'Mode recommendation response');
  if (error) throw new TypeError(error);
  const rows = recommendationRows(payload);
  return rows.map((item) => normalizeRecommendation(item));
}

/** Parse the direct public `GetProductMasterByIds` response without inventing dates or prices. */
export function parseModetourProductMaster(input, { listingProduct = null } = {}) {
  const payload = asObject(input, 'Mode product master response');
  const error = applicationError(payload, 'Mode product master response');
  if (error) throw new TypeError(error);
  const masters = productMasterRows(payload);
  const expectedMasterNo = listingProduct?.masterCodeNo ?? listingProduct?.productMaster?.masterCodeNo;
  const associatedMasters = expectedMasterNo === undefined || expectedMasterNo === null
    ? masters
    : masters.filter((master) => String(master?.masterCodeNo ?? '') === String(expectedMasterNo));
  return associatedMasters.map((master) => normalizeRecommendation({
    ...(listingProduct ?? {}),
    masterCodeNo: master.masterCodeNo ?? listingProduct?.masterCodeNo,
    masterCodeId: master.masterCodeId ?? listingProduct?.masterCodeId,
    productsCode: master.masterCode ?? listingProduct?.productsCode,
    productsName: master.masterProductName ?? listingProduct?.productsName,
    price: listingProduct?.price,
    productMaster: master,
  }, master));
}

/**
 * Read Mode's public recommendation API and observed product-master detail API.
 * Context cookies and the derived SDK header stay in memory and are never written to receipts.
 */
export async function collectModetourLive({
  destination = '다낭',
  anchor,
  anchorDate,
  maxProductsPerDestination = 1,
  requestBudget = 40,
  fetchImpl = fetch,
  minIntervalMs = 2050,
} = {}) {
  const target = nonempty(destination);
  if (!target) throw new TypeError('destination is required');
  if (!Number.isInteger(maxProductsPerDestination) || maxProductsPerDestination < 0) throw new TypeError('maxProductsPerDestination must be a nonnegative integer');
  if (!Number.isInteger(requestBudget) || requestBudget < 2) throw new TypeError('requestBudget must allow the context and list reads');
  const checkedAt = new Date().toISOString();
  const center = anchorDate ?? anchor ?? null;
  const requests = [];
  let lastRequestAt = 0;
  const read = async (name, url, headers = {}) => {
    if (requests.length >= requestBudget) throw new Error('Modetour per-run request budget exhausted');
    const wait = minIntervalMs - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const response = await directRead({ fetchImpl, name, url, headers });
    requests.push(response.meta);
    validateReadResponse(response, name);
    return response;
  };

  try {
    const page = await read('first-party-anonymous-context', `${WEB_ORIGIN}${CONTEXT_PATH}`, {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    });
    const issued = contextCookieFrom(page.response);
    const headerValue = buildModeWebApiReqHeaderFromContext(issued.context);
    if (!headerValue) {
      return {
        schemaVersion: 1,
        sourceId: 'modetour-package',
        checkedAt,
        mode: 'anonymous-direct-api',
        contractSourceObserved: true,
        httpIndependentLive: hasIndependentHttpLive(requests),
        verdict: 'anonymous_context_unavailable',
        requestCount: requests.length,
        requests,
        products: [],
        anonymousContextShape: {
          issued: Boolean(issued.context),
          keys: issued.context ? Object.keys(issued.context).sort() : [],
          hasWebSiteNo: issued.context?.webSiteNo !== undefined,
          hasCompanyNo: issued.context?.companyNo !== undefined,
          hasDeviceType: typeof issued.context?.deviceType === 'string' && Boolean(issued.context.deviceType.trim()),
          hasApiKey: issued.context?.apiKey !== undefined,
        },
        fiveStates: {
          captured: false, client_exists: true, credential_propagated: false,
          anonymous_sdk_context_propagated: false, remnant_free: true, live_replay: false,
        },
        limitations: ['The current first-party page did not issue the fields required by the observed Mode SDK serializer; no context values were fabricated.'],
      };
    }

    const commonHeaders = {
      accept: 'application/json, text/plain, */*',
      origin: WEB_ORIGIN,
      referer: `${WEB_ORIGIN}${CONTEXT_PATH}`,
      ModeWebApiReqHeader: headerValue,
    };
    const listUrl = `${API_ORIGIN}${RECOMMENDATION_PATH}?theme=Package`;
    const listResponse = await read('recommended-package-list', listUrl, commonHeaders);
    const listPayload = parseJson(listResponse.text, 'Mode recommendation payload');
    const applicationFailure = applicationError(listPayload, 'Mode recommendation API');
    if (applicationFailure) throw new Error(applicationFailure);
    const sourceRows = recommendationRows(listPayload);
    const matchedRows = sourceRows.filter((item) => item?.productsMapTypeCode === 'PMTProductSearchGroup'
      && destinationMatches(item, target));
    const normalizedProducts = matchedRows.map((item) => normalizeRecommendation(item));
    const detailLimit = Math.min(maxProductsPerDestination, Math.max(0, requestBudget - requests.length));
    const products = [];
    for (const item of matchedRows.slice(0, detailLimit)) {
      const master = item.productMaster && !Array.isArray(item.productMaster) ? item.productMaster : {};
      const masterNo = master.masterCodeNo ?? item.masterCodeNo;
      const searchFrom = dateOnly(master.minDepartureDate);
      if (masterNo === undefined || masterNo === null || !searchFrom) {
        products.push({
          ...normalizeRecommendation(item),
          detailReadStatus: 'skipped_missing_observed_query_fields',
        });
        continue;
      }
      const detailQuery = new URLSearchParams({ productMasterNos: String(masterNo), searchFrom });
      const detailReferer = `${WEB_ORIGIN}/product-common/${encodeURIComponent(String(masterNo))}?type=group`;
      const detailResponse = await read(`product-master-${masterNo}`, `${API_ORIGIN}${PRODUCT_MASTER_PATH}?${detailQuery}`, {
        ...commonHeaders,
        referer: detailReferer,
      });
      const detailPayload = parseJson(detailResponse.text, 'Mode product-master payload');
      const detailFailure = applicationError(detailPayload, 'Mode product-master API');
      if (detailFailure) throw new Error(detailFailure);
      const detailRows = productMasterRows(detailPayload);
      const expectedMasterCodeNo = String(masterNo);
      const detail = detailRows.find((candidate) => String(candidate.masterCodeNo ?? '') === expectedMasterCodeNo) ?? null;
      const returnedMasterCodeNos = detailRows.map((candidate) => candidate?.masterCodeNo)
        .filter((value) => value !== undefined && value !== null).map(String);
      products.push({
        ...normalizeRecommendation(item, detail),
        detailReadStatus: detail ? 'live_detail_read' : detailRows.length ? 'product_detail_mismatch' : 'empty_detail_result',
        detailErrorCode: detail ? null : detailRows.length ? 'PRODUCT_DETAIL_MISMATCH' : 'EMPTY_PRODUCT_DETAIL',
        detailExpectedMasterCodeNo: expectedMasterCodeNo,
        detailReturnedMasterCodeNos: returnedMasterCodeNos,
        detailSearchFrom: searchFrom,
        detailRequested: true,
      });
    }
    const noDetailRows = matchedRows.slice(detailLimit).map((item) => ({
      ...normalizeRecommendation(item),
      detailReadStatus: 'not_requested_request_budget_or_limit',
    }));
    products.push(...noDetailRows);

    return {
      schemaVersion: 1,
      sourceId: 'modetour-package',
      checkedAt: new Date().toISOString(),
      mode: 'anonymous-direct-api',
      contractSourceObserved: true,
      httpIndependentLive: hasIndependentHttpLive(requests),
      sourceScope: 'public ModeRecommended recommendation feed; not a destination-complete search result',
      destination: target,
      anchor: center,
      requestCount: requests.length,
      requests,
      recommendationCount: sourceRows.length,
      matchedRecommendationCount: matchedRows.length,
      products,
      verdict: products.some((product) => product.detailReadStatus === 'live_detail_read') ? 'usable_limited' : products.length ? 'list_only' : 'empty_result',
      anonymousContextShape: {
        issued: true,
        keys: Object.keys(issued.context).sort(),
        hasWebSiteNo: issued.context.webSiteNo !== undefined,
        hasCompanyNo: issued.context.companyNo !== undefined,
        hasDeviceType: typeof issued.context.deviceType === 'string' && Boolean(issued.context.deviceType.trim()),
        hasApiKey: issued.context.apiKey !== undefined,
        sdkHeaderPropagated: true,
        userAccountCredentialPropagated: false,
      },
      fiveStates: {
        captured: false,
        client_exists: true,
        credential_propagated: false,
        anonymous_sdk_context_propagated: true,
        remnant_free: true,
        live_replay: requests.some((row) => row.name === 'recommended-package-list' && row.status === 200)
          && products.some((product) => product.detailReadStatus === 'live_detail_read'),
      },
      fieldCoverage: {
        observed: ['product IDs', 'titles', 'list and detail price amounts', 'duration options', 'minimum observed departure date', 'departure-origin names and codes', 'airline code/name options', 'destination area names'],
        explicitUnknown: ['price currency', 'quoted price basis', 'exact departure-date availability', 'seats remaining', 'mandatory options and fees', 'hotel selection', 'checkout total'],
      },
      limitations: [
        'The first-party recommendation feed is not exhaustive for a destination and does not support lowest-price comparisons.',
        'minDepartureDate is the earliest source field observed, not proof of departure availability; no departure variants are fabricated.',
        'Price amounts are preserved in seller units with currency and quoted basis null unless a future response supplies them explicitly.',
      ],
    };
  } catch (error) {
    return errorResult(error, requests, checkedAt);
  }
}

export { normalizeRecommendation as normalizeModetourRecommendation };
