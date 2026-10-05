import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';

const ORIGIN = 'https://global.oliveyoung.com';
const CDN_ORIGIN = 'https://cdn-image.oliveyoung.com';
const DEFAULT_COUNTRY = 'KR';
const DEFAULT_CURRENCY = 'USD';
const DEFAULT_PRODUCT_ID = 'GA240824996';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const PRODUCT_ID = /^[A-Z0-9]{6,32}$/;
const API_PATHS = new Set([
  '/display/product/best-seller/order-best',
  '/product/detail-data', '/product/details-info', '/product/review-summary',
  '/product/review-list', '/product/review-media-list',
]);

export class OliveyoungGlobalError extends Error {
  constructor(code, receipt = {}) {
    super(code);
    this.name = 'OliveyoungGlobalError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = {}) => { throw new OliveyoungGlobalError(code, receipt); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, max = 50_000) => typeof value === 'string' && value.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const id = value => typeof value === 'string' && PRODUCT_ID.test(value);
const nonNegativeInt = value => Number.isSafeInteger(value) && value >= 0;

function checkedAt(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('OLIVEYOUNG_GLOBAL_OPTIONS_INVALID');
  return date.toISOString();
}

function context({ country, currency } = {}) {
  const requestedCountry = country ?? DEFAULT_COUNTRY;
  const requestedCurrency = currency ?? DEFAULT_CURRENCY;
  if (requestedCountry !== DEFAULT_COUNTRY) {
    fail('OLIVEYOUNG_GLOBAL_COUNTRY_UNVERIFIED', {
      supportedObservedCountry: DEFAULT_COUNTRY,
      note: 'The current captured product journey only verified the Global site default delivery country.',
    });
  }
  if (requestedCurrency !== DEFAULT_CURRENCY) {
    fail('OLIVEYOUNG_GLOBAL_CURRENCY_UNVERIFIED', {
      supportedObservedCurrency: DEFAULT_CURRENCY,
      note: 'The product JSON has no explicit currency; USD is verified only against the current Global storefront display.',
    });
  }
  return { country: requestedCountry, currency: requestedCurrency };
}

function contextReceipt(contextRead) {
  return {
    country: contextRead.country,
    deliveryCountryCode: contextRead.deliveryCountryCode,
    currency: contextRead.currency,
    currencyVerified: true,
    source: 'fresh_cookie_free_product_html_selected_currency_and_global_config',
    shippingEligibility: 'not_verified',
  };
}

function productIdInput({ id: productId, productUrl } = {}) {
  let fromUrl = null;
  if (productUrl !== undefined) {
    if (typeof productUrl !== 'string' || productUrl.length > 2048) fail('OLIVEYOUNG_GLOBAL_PRODUCT_URL_INVALID');
    let url;
    try { url = new URL(productUrl); } catch { fail('OLIVEYOUNG_GLOBAL_PRODUCT_URL_INVALID'); }
    const ids = url.searchParams.getAll('prdtNo');
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password || url.port ||
        url.pathname !== '/product/detail' || url.hash || ids.length !== 1 ||
        [...url.searchParams.keys()].some(key => key !== 'prdtNo')) fail('OLIVEYOUNG_GLOBAL_PRODUCT_URL_INVALID');
    fromUrl = ids[0];
    if (!id(fromUrl)) fail('OLIVEYOUNG_GLOBAL_PRODUCT_ID_INVALID');
  }
  if (productId !== undefined && (!id(productId) || fromUrl !== null && productId !== fromUrl)) {
    fail('OLIVEYOUNG_GLOBAL_PRODUCT_ID_INVALID');
  }
  const resolved = productId ?? fromUrl;
  if (!id(resolved)) fail('OLIVEYOUNG_GLOBAL_PRODUCT_ID_REQUIRED');
  return resolved;
}

function decimalUsd(value, field) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/.test(raw)) {
    fail('OLIVEYOUNG_GLOBAL_PRICE_SCHEMA_INVALID', { field });
  }
  const [whole, fraction = ''] = raw.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function usdMinor(amount) {
  const [whole, fraction] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}

function money(value, { field, kind, currency = DEFAULT_CURRENCY } = {}) {
  if (value === null || value === undefined || value === '') return null;
  return { amount: decimalUsd(value, field), currency, minorUnitExponent: 2, kind, sourceField: field };
}

function safeCdnImage(value, roots) {
  if (!safeText(value, 2048) || !value) return null;
  let url;
  try {
    url = /^https:\/\//i.test(value) ? new URL(value) : new URL(`/${value.replace(/^\/+/, '')}`, CDN_ORIGIN);
  } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== CDN_ORIGIN || url.username || url.password || url.port ||
      url.search || url.hash || !roots.some(root => url.pathname.startsWith(root)) || url.pathname.includes('..')) return null;
  return url.href;
}

function htmlContent(value) {
  if (typeof value !== 'string' || value.length > 1_000_000) fail('OLIVEYOUNG_GLOBAL_DETAIL_SCHEMA_INVALID');
  const { document } = parseHTML(`<html><body><div id="api-content">${value}</div></body></html>`);
  const root = document.getElementById('api-content');
  for (const node of root.querySelectorAll('script,style,iframe,object,embed,form')) node.remove();
  const images = [...root.querySelectorAll('img')].map(image =>
    image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original'))
    .map(path => safeCdnImage(path, ['/prdtImg/', '/editor/', '/display/']))
    .filter(Boolean);
  const text = (root.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { text, images: [...new Set(images)] };
}

function normalizeOption(option, index, currency) {
  if (!object(option)) fail('OLIVEYOUNG_GLOBAL_PRODUCT_SCHEMA_INVALID', { field: 'optionList', index });
  const optionName = option.snglOptnNameEn ?? option.gdsName ?? option.snglOptnName ?? null;
  if (optionName !== null && !safeText(optionName, 500)) fail('OLIVEYOUNG_GLOBAL_PRODUCT_SCHEMA_INVALID', { field: 'optionList.name', index });
  const listPrice = money(option.nrmlAmt, { field: 'optionList[].nrmlAmt', kind: 'retail_list', currency });
  const currentPrice = money(option.saleAmt ?? option.nrmlAmt, {
    field: option.saleAmt == null ? 'optionList[].nrmlAmt' : 'optionList[].saleAmt',
    kind: option.saleAmt == null ? 'retail_current' : 'retail_sale', currency,
  });
  return {
    variantId: safeText(option.gdsCd, 100) && option.gdsCd ? option.gdsCd : null,
    name: optionName,
    price: currentPrice,
    listPrice,
    sellStatusCode: safeText(option.sellStatCode, 32) ? option.sellStatCode : null,
    stockQuantity: nonNegativeInt(Number(option.buyStockQty)) ? Number(option.buyStockQty) : null,
    imageUrl: safeCdnImage(option.optnImagePath, ['/prdtImg/']),
  };
}

function pagination(pageNum, pageSize, totalCount) {
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) fail('OLIVEYOUNG_GLOBAL_PAGINATION_SCHEMA_INVALID');
  const totalPages = Math.ceil(totalCount / pageSize);
  return {
    pageNum,
    pageSize,
    totalCount,
    totalPages,
    isLastPage: pageNum >= totalPages,
    nextPage: pageNum < totalPages ? pageNum + 1 : null,
  };
}

function dateFromYmd(value) {
  if (typeof value !== 'string' || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function mediaImage(value) {
  return safeCdnImage(value, ['/prdt_review/', '/prdt_review_mov/']);
}

function reviewImages(value) {
  if (!Array.isArray(value) || value.length > 30) fail('OLIVEYOUNG_GLOBAL_REVIEW_SCHEMA_INVALID', { field: 'reviewMediaList' });
  return value.filter(object).map(item => ({
    imageUrl: mediaImage(item.imagePath),
    sequence: nonNegativeInt(Number(item.seq)) ? Number(item.seq) : null,
    video: item.videoYn === 'Y',
  })).filter(item => item.imageUrl);
}

function reviewSummary(data, productId) {
  if (!object(data) || !['totalReviewCount', 'totalMediaReviewCount'].every(key =>
    Number.isSafeInteger(Number(data[key])) && Number(data[key]) >= 0) ||
      !Number.isFinite(Number(data.totalStarRate))) {
    fail('OLIVEYOUNG_GLOBAL_REVIEW_SUMMARY_SCHEMA_INVALID');
  }
  if (data.totalStarRate != null && (!Number.isFinite(Number(data.totalStarRate)) || Number(data.totalStarRate) < 0 || Number(data.totalStarRate) > 5)) {
    fail('OLIVEYOUNG_GLOBAL_REVIEW_SUMMARY_SCHEMA_INVALID', { field: 'totalStarRate' });
  }
  const ratingDistribution = Array.isArray(data.scores) ? data.scores.slice(0, 5).map(score => {
    if (!object(score) || !(score.evltItemNm == null || safeText(score.evltItemNm, 300)) || !Number.isFinite(Number(score.star)) ||
        !nonNegativeInt(Number(score.count)) || !Number.isFinite(Number(score.rate))) {
      fail('OLIVEYOUNG_GLOBAL_REVIEW_SUMMARY_SCHEMA_INVALID', { field: 'scores' });
    }
    return { name: safeText(score.evltItemNm, 300) ? score.evltItemNm : null,
      rating: Number(score.star), count: Number(score.count), percent: Number(score.rate) };
  }) : [];
  const evaluationScores = Array.isArray(data.evltScores) ? data.evltScores.slice(0, 30).map(score => {
    if (!object(score) || !safeText(score.evltItemNm, 300) || !Number.isFinite(Number(score.rate))) {
      fail('OLIVEYOUNG_GLOBAL_REVIEW_SUMMARY_SCHEMA_INVALID', { field: 'evltScores' });
    }
    return { name: score.evltItemNm, averageRating: Number(score.rate), count: nonNegativeInt(Number(score.count)) ? Number(score.count) : null };
  }) : [];
  return {
    productId,
    totalReviews: Number(data.totalReviewCount),
    averageRating: Number(data.totalStarRate),
    totalMediaReviews: Number(data.totalMediaReviewCount),
    reviewEnabled: data.reviewExpYn === 'Y',
    ratingDistribution,
    evaluationScores,
  };
}

async function readBounded(response, limit) {
  if (!response.body?.getReader) fail('OLIVEYOUNG_GLOBAL_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        fail('OLIVEYOUNG_GLOBAL_RESPONSE_TOO_LARGE', { responseBytes: total });
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

/** Anonymous Global storefront reads. Korea Shopping Curator is a separate service. */
export function createOliveyoungGlobalClient({ fetchImpl = globalThis.fetch, now = () => new Date(),
  timeoutMs = 15_000, maxResponseBytes = MAX_JSON_BYTES } = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 || timeoutMs > 60_000 || !Number.isInteger(maxResponseBytes) ||
      maxResponseBytes < 1024 || maxResponseBytes > 8 * 1024 * 1024) {
    fail('OLIVEYOUNG_GLOBAL_OPTIONS_INVALID');
  }

  async function request(path, { method = 'POST', body, query } = {}) {
    if (!API_PATHS.has(path) || !['POST', 'GET'].includes(method) || method === 'POST' && !object(body) ||
        method === 'GET' && path !== '/display/product/best-seller/order-best') {
      fail('OLIVEYOUNG_GLOBAL_ENDPOINT_NOT_ALLOWED');
    }
    const url = new URL(path, ORIGIN);
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const checked = checkedAt(now);
    const fields = body ? Object.keys(body) : Object.keys(query ?? {});
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: method === 'POST' ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail('OLIVEYOUNG_GLOBAL_TRANSPORT_FAILED', {
        method, origin: ORIGIN, path, checkedAt: checked,
        causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
        browserUsed: false, cookieSent: false, authorizationSent: false,
      });
    }
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    const baseReceipt = {
      method, origin: ORIGIN, path, httpStatus: response.status, mime,
      checkedAt: checked, browserUsed: false, anonymous: true,
      cookieSent: false, credentialsUsed: false, bodyFields: fields,
      ...(method === 'GET' ? { queryFields: fields } : {}),
    };
    if (response.status >= 300 && response.status < 400 || response.redirected) {
      fail('OLIVEYOUNG_GLOBAL_REDIRECT_REJECTED', { ...baseReceipt, redirectFollowed: false });
    }
    if (response.status === 401 || response.status === 403) fail('OLIVEYOUNG_GLOBAL_ACCESS_BLOCKED', baseReceipt);
    if (response.status === 429) fail('OLIVEYOUNG_GLOBAL_THROTTLED', baseReceipt);
    if (response.status !== 200 || mime !== 'application/json') fail('OLIVEYOUNG_GLOBAL_HTTP_OR_MIME_ERROR', baseReceipt);
    const raw = await readBounded(response, maxResponseBytes);
    let data;
    try { data = JSON.parse(raw.toString('utf8')); }
    catch { fail('OLIVEYOUNG_GLOBAL_JSON_INVALID', { ...baseReceipt, responseBytes: raw.byteLength }); }
    const requestReceipt = { ...baseReceipt, responseBytes: raw.byteLength,
      responseSha256: createHash('sha256').update(raw).digest('hex') };
    return { data, request: requestReceipt };
  }

  async function bootstrapMarketContext(productId, expected) {
    const path = '/product/detail';
    const url = new URL(path, ORIGIN);
    url.searchParams.set('prdtNo', productId);
    const startedAt = checkedAt(now);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET', headers: { accept: 'text/html' },
        redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail('OLIVEYOUNG_GLOBAL_CONTEXT_TRANSPORT_FAILED', {
        method: 'GET', origin: ORIGIN, path, checkedAt: startedAt, browserUsed: false,
        credentialsUsed: false, causeCode: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR',
      });
    }
    const mime = response.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
    const requestReceipt = {
      method: 'GET', origin: ORIGIN, path, httpStatus: response.status, mime,
      checkedAt: startedAt, browserUsed: false, anonymous: true, cookieSent: false,
      credentialsUsed: false, queryFields: ['prdtNo'], contextOnly: true,
    };
    if (response.status >= 300 && response.status < 400 || response.redirected) {
      fail('OLIVEYOUNG_GLOBAL_CONTEXT_REDIRECT_REJECTED', { ...requestReceipt, redirectFollowed: false });
    }
    if (response.status === 401 || response.status === 403) fail('OLIVEYOUNG_GLOBAL_CONTEXT_ACCESS_BLOCKED', requestReceipt);
    if (response.status !== 200 || mime !== 'text/html') fail('OLIVEYOUNG_GLOBAL_CONTEXT_HTTP_OR_MIME_ERROR', requestReceipt);
    const bytes = await readBounded(response, maxResponseBytes);
    const html = bytes.toString('utf8');
    if (!html.includes(productId)) fail('OLIVEYOUNG_GLOBAL_CONTEXT_PRODUCT_MISMATCH', requestReceipt);
    const { document } = parseHTML(html);
    const selectedCurrency = document.querySelector('.selected-option [data-option="currencyCodeList"]');
    const selectedCurrencyCode = selectedCurrency?.getAttribute('data-code-dtl-no') ?? null;
    const selectedCurrencyLabel = (selectedCurrency?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const scripts = [...document.querySelectorAll('script')].map(script => script.textContent ?? '').join('\n');
    const codeValue = name => scripts.match(new RegExp(`\\bvar\\s+${name}\\s*=\\s*['"]([A-Za-z0-9]+)['"]`))?.[1] ?? null;
    const configuredCurrency = codeValue('currency');
    const deliveryCountryCode = codeValue('dlvCntry');
    const currencyIsUSD = selectedCurrencyCode === 'USD' && configuredCurrency === 'USD' && /US\$/.test(selectedCurrencyLabel);
    const countryIsKR = deliveryCountryCode === '1230';
    const bound = currencyIsUSD && countryIsKR;
    if (!bound || selectedCurrencyCode !== expected.currency || expected.country !== 'KR') {
      fail('OLIVEYOUNG_GLOBAL_CONTEXT_UNVERIFIED', {
        ...requestReceipt, currencyCode: selectedCurrencyCode, configuredCurrency,
        deliveryCountryCode, productIdMatched: true,
      });
    }
    requestReceipt.responseBytes = bytes.byteLength;
    requestReceipt.responseSha256 = createHash('sha256').update(bytes).digest('hex');
    requestReceipt.productIdMatched = true;
    requestReceipt.currencyCode = selectedCurrencyCode;
    requestReceipt.currencySelectedInPage = true;
    requestReceipt.currencyConfirmedByInlineConfig = true;
    requestReceipt.deliveryCountryCode = deliveryCountryCode;
    return { country: 'KR', deliveryCountryCode, currency: 'USD', request: requestReceipt };
  }

  function receipt(capabilityId, requestReceipt, sourceURL, extra = {}) {
    return {
      schema: 'web-api-public-read-receipt-v1',
      service: 'oliveyoung-global',
      capabilityId,
      checkedAt: requestReceipt.checkedAt,
      secretsPersistedInEvidence: false,
      anonymous: true,
      credentialsUsed: false,
      authenticated: false,
      schemaVerified: true,
      expectedResultVerified: true,
      contractProvenance: { kind: 'browser_xhr_observed', sourceURL },
      request: requestReceipt,
      ...extra,
    };
  }

  function assertContext(input) { return context(input); }

  async function getReviewSummaryFor(productId, { sourceURL, withReceipt = true } = {}) {
    const read = await request('/product/review-summary', { body: {
      filterYn: 'N', prdtNo: productId, prdtGbnCode: '10', movReviewYn: 'N', photoReviewYn: 'N',
      optnYn: 'Y', transUseYn: 'N', filterUseYn: 'Y',
    } });
    const result = reviewSummary(read.data, productId);
    return withReceipt ? { ...result, receipt: receipt('reviews.summary', read.request, sourceURL) }
      : { result, request: read.request };
  }

  return Object.freeze({
    async getProduct(input = {}) {
      const market = assertContext(input);
      const productId = productIdInput(input);
      const sourceURL = `${ORIGIN}/product/detail?prdtNo=${encodeURIComponent(productId)}`;
      const contextRead = await bootstrapMarketContext(productId, market);
      const productRead = await request('/product/detail-data', { body: { prdtNo: productId } });
      const raw = productRead.data?.product;
      if (!object(raw) || raw.prdtNo !== productId || !safeText(raw.prdtName, 2000) || !Array.isArray(raw.optionList) ||
          raw.optionList.length > 250 || !Array.isArray(raw.thumbnailList) || raw.thumbnailList.length > 100) {
        fail('OLIVEYOUNG_GLOBAL_PRODUCT_SCHEMA_INVALID', { request: productRead.request });
      }
      if (raw.currency != null && raw.currency !== market.currency) {
        fail('OLIVEYOUNG_GLOBAL_CURRENCY_MISMATCH', { request: productRead.request });
      }
      const currentPrice = money(raw.saleAmt ?? raw.nrmlAmt, {
        field: raw.saleAmt == null ? 'product.nrmlAmt' : 'product.saleAmt',
        kind: raw.saleAmt == null ? 'retail_current' : 'retail_sale', currency: market.currency,
      });
      const listPrice = money(raw.nrmlAmt, { field: 'product.nrmlAmt', kind: 'retail_list', currency: market.currency });
      if (!currentPrice || !listPrice) fail('OLIVEYOUNG_GLOBAL_PRICE_SCHEMA_INVALID', { request: productRead.request });
      const detailsRead = await request('/product/details-info', { body: { prdtNo: productId } });
      const details = detailsRead.data?.details;
      if (!object(details) || details.prdtNo !== productId || !safeText(details.dtlDesc ?? '', 1_000_000) ||
          details.dtlAddDesc != null && !safeText(details.dtlAddDesc, 1_000_000)) {
        fail('OLIVEYOUNG_GLOBAL_DETAIL_SCHEMA_INVALID', { request: detailsRead.request });
      }
      const description = htmlContent(details.dtlDesc ?? '');
      const additionalDescription = htmlContent(details.dtlAddDesc ?? '');
      const summaryRead = await getReviewSummaryFor(productId, { sourceURL, withReceipt: false });
      const summary = summaryRead.result;
      const options = raw.optionList.map((option, index) => normalizeOption(option, index, market.currency));
      const thumbnails = raw.thumbnailList.map(item => safeCdnImage(item?.imagePath, ['/prdtImg/'])).filter(Boolean);
      const optionPrices = options.map(option => option.price?.amount).filter(Boolean)
        .sort((left, right) => usdMinor(left) < usdMinor(right) ? -1 : usdMinor(left) > usdMinor(right) ? 1 : 0);
      const product = {
        id: productId,
        name: raw.prdtName,
        brand: safeText(raw.brandName, 300) ? raw.brandName : null,
        url: sourceURL,
        price: currentPrice,
        listPrice,
        priceRange: optionPrices.length ? {
          min: optionPrices[0],
          max: optionPrices.at(-1),
          currency: market.currency,
        } : null,
        category: {
          large: safeText(raw.gdsLclsNm, 300) ? raw.gdsLclsNm : null,
          medium: safeText(raw.gdsMclsNm, 300) ? raw.gdsMclsNm : null,
          small: safeText(raw.gdsSclsNm, 300) ? raw.gdsSclsNm : null,
        },
        availability: 'unknown',
        sellStatusCode: safeText(raw.sellStatCode, 32) ? raw.sellStatCode : null,
        options,
        images: [...new Set([...thumbnails, ...description.images, ...additionalDescription.images])],
        description: description.text,
        additionalDescription: additionalDescription.text || null,
        sellingPoints: safeText(details.sellingPointText) ? htmlContent(details.sellingPointText).text : null,
        whyWeLoveIt: safeText(details.whyWeLoveItText) ? htmlContent(details.whyWeLoveItText).text : null,
        featuredIngredients: safeText(details.ftrdIngrdText) ? htmlContent(details.ftrdIngrdText).text : null,
        howToUse: safeText(details.howToUseText) ? htmlContent(details.howToUseText).text : null,
        reviewSummary: summary,
        marketContext: contextReceipt(contextRead),
      };
      const productReceipt = receipt('catalog.product_detail', productRead.request, sourceURL, {
        productIdMatched: true,
        currencyContextVerified: true,
        currencyContextRequest: contextRead.request,
        detailsRequest: detailsRead.request,
        reviewSummaryRequest: summaryRead.request,
      });
      return { product, receipt: productReceipt };
    },

    async getReviewSummary({ productId, id: productIdAlias, productUrl, country, currency } = {}) {
      assertContext({ country, currency });
      const resolved = productIdInput({ id: productId ?? productIdAlias, productUrl });
      const sourceURL = `${ORIGIN}/product/detail?prdtNo=${encodeURIComponent(resolved)}`;
      return getReviewSummaryFor(resolved, { sourceURL });
    },

    async getReviews({ productId, pageNum = 1, rowsPerPage = 10, sort = '10', country, currency } = {}) {
      if (country !== undefined || currency !== undefined) assertContext({ country, currency });
      if (!id(productId)) fail('OLIVEYOUNG_GLOBAL_PRODUCT_ID_REQUIRED');
      if (!Number.isSafeInteger(pageNum) || pageNum < 1 || pageNum > 10_000 ||
          !Number.isSafeInteger(rowsPerPage) || rowsPerPage < 1 || rowsPerPage > 10 || String(sort) !== '10') {
        fail('OLIVEYOUNG_GLOBAL_REVIEW_PAGE_INPUT_INVALID');
      }
      const sourceURL = `${ORIGIN}/product/detail?prdtNo=${encodeURIComponent(productId)}`;
      const read = await request('/product/review-list', { body: {
        filterYn: 'N', prdtNo: productId, prdtGbnCode: '10', movReviewYn: 'N', photoReviewYn: 'N',
        optnYn: 'Y', transUseYn: 'N', pageNum, rowsPerPage, sort: '10',
      } });
      const data = read.data;
      if (!object(data) || !Array.isArray(data.reviewList) || data.reviewList.length > rowsPerPage ||
          data.reviewList.some(review => !object(review) || !id(review.prdtNo) ||
            review.prdtNo !== productId && review.assocReviewYn !== 'Y' ||
            review.prdtNo === productId && !['Y', 'N'].includes(review.assocReviewYn) ||
            !safeText(review.conText, 20_000) || !nonNegativeInt(Number(review.prdtReviewNo)) ||
            !Number.isFinite(Number(review.previewScore)) || Number(review.previewScore) < 0 || Number(review.previewScore) > 5 ||
            typeof review.reviewRgstYmd !== 'string' || !/^\d{8}$/.test(review.reviewRgstYmd))) {
        fail('OLIVEYOUNG_GLOBAL_REVIEW_SCHEMA_INVALID', { request: read.request });
      }
      const page = pagination(pageNum, rowsPerPage, Number(data.totalCount));
      const reviews = data.reviewList.map(review => ({
        reviewId: String(review.prdtReviewNo),
        productId,
        sourceProductId: review.prdtNo,
        associatedProductReview: review.prdtNo !== productId || review.assocReviewYn === 'Y',
        body: review.conText,
        rating: Number(review.previewScore),
        postedAt: dateFromYmd(review.reviewRgstYmd),
        optionName: safeText(review.snglOptnName, 500) ? review.snglOptnName : null,
        helpfulCount: nonNegativeInt(Number(review.goodCnt)) ? Number(review.goodCnt) : 0,
        best: review.bestYn === 'Y',
        mediaReview: review.mediaReviewYn === 'Y',
        images: reviewImages(review.reviewMediaList ?? []),
      }));
      const rec = receipt('reviews.body', read.request, sourceURL, {
        productIdMatched: true,
        paginationVerified: true,
        totalReviews: page.totalCount,
        pageNum,
        rowsPerPage,
      });
      return {
        productId,
        productIdMatched: true,
        reviews,
        totalReviews: page.totalCount,
        pagination: page,
        receipt: rec,
      };
    },

    async getReviewMedia({ productId, pageNum = 1, rowsPerPage = 15, country, currency } = {}) {
      if (country !== undefined || currency !== undefined) assertContext({ country, currency });
      if (!id(productId)) fail('OLIVEYOUNG_GLOBAL_PRODUCT_ID_REQUIRED');
      if (!Number.isSafeInteger(pageNum) || pageNum < 1 || pageNum > 10_000 ||
          !Number.isSafeInteger(rowsPerPage) || rowsPerPage < 1 || rowsPerPage > 15) {
        fail('OLIVEYOUNG_GLOBAL_MEDIA_PAGE_INPUT_INVALID');
      }
      const sourceURL = `${ORIGIN}/product/detail?prdtNo=${encodeURIComponent(productId)}`;
      const read = await request('/product/review-media-list', { body: {
        prdtNo: productId, prdtGbnCode: '10', pageNum, rowsPerPage, photoReviewYn: 'N', movReviewYn: 'N',
      } });
      const data = read.data;
      if (!object(data) || !Array.isArray(data.mediaList) || data.mediaList.length > rowsPerPage ||
          data.mediaList.some(media => !object(media) || !nonNegativeInt(Number(media.prdtReviewNo)) ||
            !Number.isSafeInteger(Number(media.seq)) || !mediaImage(media.imagePath))) {
        fail('OLIVEYOUNG_GLOBAL_MEDIA_SCHEMA_INVALID', { request: read.request });
      }
      const page = pagination(pageNum, rowsPerPage, Number(data.totalCount));
      const media = data.mediaList.map(item => ({
        reviewId: String(item.prdtReviewNo),
        sequence: Number(item.seq),
        imageUrl: mediaImage(item.imagePath),
        best: item.bestYn === 'Y',
        video: item.videoYn === 'Y',
      }));
      return {
        productId,
        media,
        totalMedia: page.totalCount,
        pagination: page,
        containsReviewBodies: false,
        receipt: receipt('reviews.media', read.request, sourceURL, {
          productIdMatched: true, paginationVerified: true, pageNum, rowsPerPage,
        }),
      };
    },

    async getBestSellers({ country, currency } = {}) {
      const market = assertContext({ country, currency });
      const query = {
        curLangCode: 'en', langCode: 'en', mbrNo: '', acesCntryCode: '00', accParam: '',
        mrgnCntryCode: '9999', dlvCntryCode: '1230', limit: '20', showSoldoutProduct: 'true',
      };
      const read = await request('/display/product/best-seller/order-best', { method: 'GET', query });
      if (!Array.isArray(read.data) || read.data.length > 20 || read.data.some(row => !object(row) || !id(row.prdtNo) ||
          !safeText(row.prdtName, 2000) || row.nrmlAmt == null || row.saleAmt == null)) {
        fail('OLIVEYOUNG_GLOBAL_BESTSELLER_SCHEMA_INVALID', { request: read.request });
      }
      const contextRead = await bootstrapMarketContext(read.data[0].prdtNo, market);
      const products = read.data.map(row => ({
        id: row.prdtNo,
        name: row.prdtName,
        brand: safeText(row.brandName, 300) ? row.brandName : null,
        url: `${ORIGIN}/product/detail?prdtNo=${encodeURIComponent(row.prdtNo)}`,
        price: money(row.saleAmt, { field: 'bestSeller.saleAmt', kind: 'retail_sale', currency: market.currency }),
        listPrice: money(row.nrmlAmt, { field: 'bestSeller.nrmlAmt', kind: 'retail_list', currency: market.currency }),
        discountRate: safeText(row.eventSlprcDscntRt, 20) && /^(?:\d{1,3})(?:\.\d+)?$/.test(row.eventSlprcDscntRt)
          ? row.eventSlprcDscntRt : null,
        reviewCount: nonNegativeInt(Number(row.reviewCnt)) ? Number(row.reviewCnt) : null,
        averageRating: Number.isFinite(Number(row.avgScore)) ? Number(row.avgScore) : null,
        availability: 'unknown',
        sellStatusCode: safeText(row.sellStatCode, 32) ? row.sellStatCode : null,
        imageUrl: safeCdnImage(row.imagePath, ['/prdtImg/']),
      }));
      return {
        products,
        page: { type: 'homepage_best_seller', limit: 20, continuation: null, completeCatalog: false },
        marketContext: contextReceipt(contextRead),
        receipt: receipt('catalog.bestsellers', read.request, `${ORIGIN}/`, {
          currencyContextVerified: true,
          currencyContextRequest: contextRead.request,
        }),
      };
    },

    async searchProducts() {
      fail('OLIVEYOUNG_GLOBAL_SEARCH_ACCESS_BLOCKED', {
        origin: ORIGIN,
        observed: ['/display/search/search-word 403 text/html', '/kr/search/results 403 text/html'],
        supportedAlternative: 'getBestSellers',
      });
    },
  });
}
