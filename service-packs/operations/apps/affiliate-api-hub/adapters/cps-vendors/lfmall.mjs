import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import {
  extractPublicPage,
  isStrongPublicChallenge,
  publicPageInternals,
  readPublicPage,
  readPublicResource,
  safeUrl,
  textContent,
} from '../../lib/cps-public-reader.mjs';

const LANDING_URL = 'https://www.lfmall.co.kr/app';
const ENTRY_URL = 'https://static.lfmall.co.kr/desktop/assets/entry-BRzjAadY.js';
const SEARCH_RESULT_CHUNK_URL = 'https://static.lfmall.co.kr/desktop/assets/SearchResult-BjzzFFxq.js';
const SEARCH_PRODUCT_CHUNK_URL = 'https://static.lfmall.co.kr/desktop/assets/SearchProductList-tNsJnY9m.js';
const PRODUCT_CHUNK_URL = 'https://static.lfmall.co.kr/desktop/assets/Product-x6G4lxaH.js';
const PRODUCT_REVIEW_CHUNK_URL = 'https://static.lfmall.co.kr/desktop/assets/ProductReview-CaFl4-kS.js';
const API_ORIGIN = 'https://nxapi.lfmall.co.kr';
const BOOTSTRAP_URL = `${API_ORIGIN}/common/v1/token`;
const PAGE_ORIGIN = 'https://www.lfmall.co.kr';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SEARCH_PRODUCTS = 40;
const BLOCKED_STATUSES = new Set([401, 403, 418, 429]);
const isPublicIpv4 = publicPageInternals.isPublicIpv4;

function normalizeReceipt(receipt, kind, extra = {}) {
  if (!receipt) return null;
  return {
    receiptId: receipt.id,
    kind,
    method: receipt.requestMethod,
    requestedUrl: safeUrl(receipt.requestUrl),
    finalUrl: safeUrl(receipt.requestUrl),
    status: receipt.responseStatus,
    mime: receipt.contentType,
    bytes: receipt.bytes,
    sha256: receipt.responseSha256,
    checkedAt: receipt.observedAt,
    redirects: [],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    stopReason: null,
    ...extra,
  };
}

function publicFailureReceipt(url, kind, method, status, contentType, stopReason) {
  const now = new Date().toISOString();
  const receiptId = randomUUID();
  return {
    receiptId,
    kind,
    method,
    requestedUrl: safeUrl(url),
    finalUrl: safeUrl(url),
    status: Number.isInteger(status) ? status : null,
    mime: contentType ?? null,
    bytes: 0,
    sha256: null,
    checkedAt: now,
    redirects: [],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    stopReason,
  };
}

function asList(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function cleanText(value, maxLength = 1000) {
  if (typeof value !== 'string') return null;
  return textContent(value, maxLength);
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return null;
  const number = Number(raw.replaceAll(',', ''));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeCount(value) {
  const parsed = numeric(value);
  return parsed != null && Number.isSafeInteger(parsed) ? parsed : null;
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function firstPresent(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '') ?? null;
}

function normalizeReviewSample(review) {
  if (!review || typeof review !== 'object') return null;
  const rating = numeric(firstPresent(review.reviewScore, review.reviewRating, review.rating, review.score));
  const rawDate = firstPresent(review.regDate, review.reviewDate, review.createdAt, review.createDate, review.writeDate, review.registDate);
  const publishedAt = typeof rawDate === 'string' && /^\d{4}(?:-\d{2}-\d{2}|\d{4})(?:[T ][\d:.+-]+Z?)?$/.test(rawDate)
    ? rawDate.slice(0, 40) : null;
  const body = firstPresent(review.reviewContents, review.reviewContent, review.content, review.reviewText, review.reviewBody);
  return {
    title: null,
    body: null,
    ...(body != null ? { bodyAvailable: true } : {}),
    rating,
    publishedAt,
  };
}

function productUrl(productCode) {
  const id = String(productCode);
  return `${PAGE_ORIGIN}/app/product/${encodeURIComponent(id)}`;
}

function normalizeSearchProduct(product, index, receiptId) {
  const productCode = firstPresent(product?.id, product?.productCode, product?.productCd);
  const title = cleanText(firstPresent(product?.name, product?.productName), 1000);
  if (productCode == null || !title) return null;
  const salePrice = numeric(firstPresent(product.salePrice, product.price));
  const reviewCount = safeCount(firstPresent(product.reviewCount, product.reviewsCount));
  const ratingValue = numeric(firstPresent(product.reviewScore, product.reviewAverageScore));
  const fields = ['type', 'sourceLocalId', 'title', 'url'];
  if (product.brandEngName || product.brandName) fields.push('brand');
  if (salePrice != null) fields.push('price');
  if (ratingValue != null || reviewCount != null) fields.push('rating');
  const originalPrice = numeric(product.originalPrice);
  const soldOut = product.soldout === true || ['y', 'yes', 'true', '1'].includes(String(product.soldout ?? '').trim().toLowerCase());
  const record = {
    type: 'RetailProduct',
    sourceLocalId: cleanText(String(productCode), 200),
    title,
    url: productUrl(productCode),
    description: null,
    brand: cleanText(firstPresent(product.brandEngName, product.brandName), 300),
    price: {
      amount: salePrice,
      currency: salePrice == null ? null : 'KRW',
      priceText: null,
    },
    rating: ratingValue != null || reviewCount != null ? {
      value: ratingValue,
      best: null,
      worst: null,
      reviewCount,
      ratingCount: null,
    } : null,
    variants: [],
    offers: [
      ...(salePrice == null ? [] : [{ amount: salePrice, currency: 'KRW', priceText: null, type: 'SalePrice', availability: soldOut ? 'out_of_stock' : null, seller: null, validFrom: null, validUntil: null, condition: null, url: productUrl(productCode) }]),
      ...(originalPrice == null ? [] : [{ amount: originalPrice, currency: 'KRW', priceText: null, type: 'OriginalPrice', availability: null, seller: null, validFrom: null, validUntil: null, condition: null, url: productUrl(productCode) }]),
    ],
    reviewSamples: [],
    evidence: [{
      receiptId,
      locator: `body.results.products[${index}]`,
      fields: [...fields, ...(salePrice != null || originalPrice != null ? ['offers'] : [])],
    }],
  };
  return record;
}

function variantsFromProduct(product, url, receiptId) {
  const rawSizes = asList(product?.sizes);
  const variants = [];
  for (const [index, size] of rawSizes.entries()) {
    if (!size || typeof size !== 'object') continue;
    const label = cleanText(firstPresent(size.name, size.sizeName, size.optionName, size.label, size.size), 200);
    const id = firstPresent(size.code, size.sizeCode, size.optionCode, size.id);
    if (!label && id == null) continue;
    variants.push({
      sourceLocalId: id == null ? null : cleanText(String(id), 200),
      title: label,
      url,
      price: { amount: null, currency: null, priceText: null },
      offers: [],
      attributes: null,
    });
    if (variants.length >= 30) break;
  }
  return variants;
}

function normalizeSummary(record, summary, receiptId) {
  if (!summary || typeof summary !== 'object') return;
  const value = numeric(firstPresent(summary.reviewAverageScore, summary.reviewScore, summary.averageScore));
  const reviewCount = safeCount(firstPresent(summary.reviewTotalCount, summary.reviewCount));
  const scoreRows = asList(summary.reviewScoreDTOList);
  const observedBounds = scoreRows.map(row => numeric(firstPresent(row.score, row.reviewScore, row.scoreValue, row.ratingValue))).filter(value => value != null);
  record.rating = {
    value: value ?? record.rating?.value ?? null,
    best: observedBounds.length ? Math.max(...observedBounds) : record.rating?.best ?? null,
    worst: observedBounds.length ? Math.min(...observedBounds) : record.rating?.worst ?? null,
    reviewCount: reviewCount ?? record.rating?.reviewCount ?? null,
    ratingCount: safeCount(firstPresent(summary.ratingCount, summary.reviewRatingCount)) ?? record.rating?.ratingCount ?? null,
  };
  record.evidence.push({ receiptId, locator: 'body', fields: ['rating'] });
}

function normalizeBasics(record, basics, receiptId) {
  if (!basics || typeof basics !== 'object') return;
  const brand = basics.productBrandDTO;
  const brandName = cleanText(firstPresent(brand?.brandEngName, brand?.brandName, brand?.sapBrandName), 300);
  if (brandName) record.brand = brandName;
  const detail = basics.productDetailDTO;
  const description = cleanText(firstPresent(detail?.productSummary, detail?.description, detail?.productDescription), 4000);
  if (description) record.description = description;
  if (Array.isArray(basics.productSizeDTOList)) {
    record.variants = basics.productSizeDTOList.slice(0, 30).map((row, index) => {
      const code = firstPresent(row?.sizeCode, row?.optionCode, row?.id);
      const label = cleanText(firstPresent(row?.sizeName, row?.optionName, row?.name), 200);
      return code == null && !label ? null : {
        sourceLocalId: code == null ? null : cleanText(String(code), 200),
        title: label,
        url: record.url,
        price: { amount: null, currency: null, priceText: null },
        offers: [],
        attributes: null,
      };
    }).filter(Boolean);
  }
  const fields = [];
  if (brandName) fields.push('brand');
  if (description) fields.push('description');
  if (record.variants.length) fields.push('variants');
  if (fields.length) record.evidence.push({ receiptId, locator: 'body.productBasicDTO/productBrandDTO/productDetailDTO', fields });
}

function normalizeOptions(record, optionsBody, receiptId) {
  const optionRows = asList(optionsBody?.productOptionDTO?.productOptionSizeDTOList);
  const variants = optionRows.slice(0, 40).map((option, index) => {
    if (!option || typeof option !== 'object') return null;
    const code = firstPresent(option.productOptionCode, option.optionCode, option.sizeCode);
    const label = cleanText(firstPresent(option.optionName, option.sizeName, option.sizeCode, option.productOptionName), 200);
    if (code == null && !label) return null;
    const sale = numeric(firstPresent(option.salePrice, option.price, option.productPrice));
    const original = numeric(firstPresent(option.originalPrice, option.originalSalePrice));
    const variantUrl = record.url;
    return {
      sourceLocalId: code == null ? null : cleanText(String(code), 200),
      title: label,
      url: variantUrl,
      price: sale == null ? null : { amount: sale, currency: 'KRW', priceText: null },
      offers: [
        ...(sale == null ? [] : [{ amount: sale, currency: 'KRW', priceText: null, type: 'VariantSalePrice', availability: null, seller: null, validFrom: null, validUntil: null, condition: null, url: variantUrl }]),
        ...(original == null ? [] : [{ amount: original, currency: 'KRW', priceText: null, type: 'VariantOriginalPrice', availability: null, seller: null, validFrom: null, validUntil: null, condition: null, url: variantUrl }]),
      ],
      attributes: label ? { size: label } : null,
    };
  }).filter(Boolean);
  if (variants.length) {
    record.variants = variants;
    record.evidence.push({ receiptId, locator: 'body.productOptionDTO.productOptionSizeDTOList', fields: ['variants'] });
  }
  return { variants, optionKeys: objectKeys(optionsBody?.productOptionDTO), sizeRowKeys: objectKeys(optionRows[0]) };
}

function normalizePrice(record, priceBody, receiptId) {
  if (!priceBody || typeof priceBody !== 'object') return;
  const priceDto = priceBody.productPriceDTO;
  if (!priceDto || typeof priceDto !== 'object') return;
  const sale = numeric(firstPresent(priceDto.salePrice, priceDto.saleAmt, priceDto.discountPrice, priceDto.price));
  const original = numeric(firstPresent(priceDto.originalPrice, priceDto.normalPrice, priceDto.listPrice, priceDto.consumerPrice));
  if (sale != null) record.price = { amount: sale, currency: 'KRW', priceText: null };
  const discountName = cleanText(firstPresent(priceDto.baseDiscountName, priceDto.benefitName), 300);
  const discountRate = numeric(firstPresent(priceDto.baseDiscountRate, priceDto.discountRate));
  const discountCondition = [discountName, discountRate == null ? null : `${discountRate}% (observed discount rate)`].filter(Boolean).join('; ') || null;
  const offerFields = [
    ['salePrice', 'SalePrice', discountCondition],
    ['originalSalePrice', 'OriginalSalePrice', null],
    ['originalPrice', 'OriginalPrice', null],
    ['baseDiscountPrice', 'DiscountAdjustment:baseDiscountPrice', discountCondition],
  ];
  const offers = [];
  for (const [field, type, condition] of offerFields) {
    const amount = numeric(priceDto[field]);
    if (amount == null) continue;
    offers.push({ amount, currency: 'KRW', priceText: null, type, availability: null, seller: null, validFrom: null, validUntil: null, condition, url: record.url });
  }
  for (const coupon of asList(priceBody.productCouponDTOList)) {
    if (!coupon || typeof coupon !== 'object') continue;
    const couponName = cleanText(firstPresent(coupon.couponName, coupon.benefitName, coupon.name), 300);
    const couponRate = numeric(coupon.couponDiscountRate);
    const couponCondition = [couponName, couponRate == null ? null : `${couponRate}% (observed coupon discount rate)`].filter(Boolean).join('; ') || null;
    const validUntil = typeof coupon.couponDurationEndDate === 'string' && /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-]+Z?)?$/.test(coupon.couponDurationEndDate)
      ? coupon.couponDurationEndDate.slice(0, 40) : null;
    for (const [field, raw] of Object.entries(coupon)) {
      if (!/(?:price|amount|amt)$/i.test(field) || /(?:id|code|seq|number|no)$/i.test(field)) continue;
      const amount = numeric(raw);
      if (amount == null) continue;
      offers.push({
        amount,
        currency: 'KRW',
        priceText: null,
        type: `CouponAdjustment:${field}`,
        availability: null,
        seller: null,
        validFrom: null,
        validUntil: null,
        condition: couponCondition ?? `Observed coupon field ${field}`,
        validUntil,
        url: record.url,
      });
      if (offers.length >= 30) break;
    }
    if (offers.length >= 30) break;
  }
  if (offers.length) record.offers = offers;
  const fields = [];
  if (sale != null) fields.push('price');
  if (offers.length) fields.push('offers');
  if (fields.length) record.evidence.push({ receiptId, locator: 'body.productPriceDTO', fields });
}

function normalizeReviewList(reviewBody, receiptId) {
  const rows = asList(reviewBody?.reviewDTOList);
  const samples = rows.slice(0, 8).map(normalizeReviewSample).filter(Boolean);
  return {
    samples,
    count: safeCount(firstPresent(reviewBody?.reviewTotalCount, reviewBody?.totalCount, rows.length)),
    evidence: [{ receiptId, locator: 'body.reviewDTOList', fields: ['reviewSamples'] }],
  };
}

async function resolvePublicIpv4(hostname) {
  let rows;
  try { rows = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('DNS_LOOKUP_FAILED'); }
  const addresses = rows.filter(row => row.family === 4);
  if (!addresses.length) throw new Error('PUBLIC_IPV4_REQUIRED');
  if (addresses.some(row => !isPublicIpv4(row.address))) throw new Error('NON_PUBLIC_ADDRESS_REJECTED');
  return addresses[0].address;
}

async function requestPinnedJson(urlValue, { method, requestToken, body = null, timeoutMs = 20_000, maxBytes = MAX_BYTES } = {}) {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.hostname !== 'nxapi.lfmall.co.kr' || url.port) {
    return { ok: false, url: safeUrl(urlValue), status: null, contentType: null, data: null, receipt: null, blocked: false, stopReason: 'API_HOST_SCOPE_REJECTED' };
  }
  let ip;
  try { ip = await resolvePublicIpv4(url.hostname); }
  catch (error) {
    return { ok: false, url: safeUrl(url.href), status: null, contentType: null, data: null, receipt: null, blocked: false, stopReason: error.message };
  }

  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const tokenValue = typeof requestToken === 'string' ? requestToken : requestToken?.value;
  const headers = {
    accept: 'application/json',
    'accept-encoding': 'identity',
    'device-type': '2',
    origin: PAGE_ORIGIN,
    referer: LANDING_URL,
    ...(tokenValue ? { 'x-request-token': tokenValue } : {}),
    ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
  };
  const options = {
    protocol: 'https:',
    hostname: url.hostname,
    port: 443,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    servername: url.hostname,
    lookup(host, lookupOptions, callback) {
      if (host.toLowerCase() !== url.hostname.toLowerCase()) return callback(new Error('HOST_CHANGED'));
      if (lookupOptions?.all) return callback(null, [{ address: ip, family: 4 }]);
      callback(null, ip, 4);
    },
  };
  const observedAt = new Date().toISOString();
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      const request = https.request(options, resolve);
      request.setTimeout(timeoutMs, () => request.destroy(new Error('PUBLIC_HTTP_TIMEOUT')));
      request.once('error', reject);
      if (payload) request.write(payload);
      request.end();
    });
  } catch (error) {
    const stopReason = error?.message === 'PUBLIC_HTTP_TIMEOUT' ? error.message : 'PUBLIC_HTTP_TRANSPORT_FAILED';
    return { ok: false, url: safeUrl(url.href), status: null, contentType: null, data: null, receipt: null, blocked: false, stopReason };
  }

  const status = response.statusCode ?? null;
  const contentType = Array.isArray(response.headers['content-type'])
    ? response.headers['content-type'].join(', ')
    : response.headers['content-type'] ?? null;
  const kind = `api_${method.toLowerCase()}`;
  const tokenMetadata = tokenValue ? {
    publicRequestTokenSent: true,
    bootstrapReceiptId: requestToken.bootstrapReceiptId,
    anonymousBootstrap: {
      kind: 'public_anonymous_bootstrap',
      issuedWithoutAccount: true,
      headerName: 'X-REQUEST-TOKEN',
      retention: 'memory_only',
    },
  } : {};
  if (BLOCKED_STATUSES.has(status)) {
    response.destroy();
    const receipt = publicFailureReceipt(url.href, kind, method, status, contentType, 'HTTP_ACCESS_BLOCKED');
    Object.assign(receipt, tokenMetadata);
    return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: true, stopReason: 'HTTP_ACCESS_BLOCKED' };
  }
  if (status >= 300 && status < 400) {
    const receipt = publicFailureReceipt(url.href, kind, method, status, contentType, 'API_REDIRECT_NOT_FOLLOWED');
    Object.assign(receipt, tokenMetadata);
    response.destroy();
    return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: false, stopReason: 'API_REDIRECT_NOT_FOLLOWED' };
  }
  if (status !== 200) {
    const receipt = publicFailureReceipt(url.href, kind, method, status, contentType, 'HTTP_STATUS_REJECTED');
    Object.assign(receipt, tokenMetadata);
    response.destroy();
    return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: false, stopReason: 'HTTP_STATUS_REJECTED' };
  }

  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        response.destroy();
        const receipt = publicFailureReceipt(url.href, kind, method, status, contentType, 'RESPONSE_TOO_LARGE');
        Object.assign(receipt, tokenMetadata);
        return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: false, stopReason: 'RESPONSE_TOO_LARGE' };
      }
      chunks.push(chunk);
    }
  } catch {
    const receipt = publicFailureReceipt(url.href, kind, method, status, contentType, 'PUBLIC_HTTP_BODY_FAILED');
    Object.assign(receipt, tokenMetadata);
    return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: false, stopReason: 'PUBLIC_HTTP_BODY_FAILED' };
  }

  const raw = Buffer.concat(chunks, bytes);
  const digest = createHash('sha256').update(raw).digest('hex');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  const mime = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  const receipt = {
    receiptId: randomUUID(),
    kind,
    method,
    requestedUrl: safeUrl(url.href),
    finalUrl: safeUrl(url.href),
    status,
    mime: contentType,
    bytes,
    sha256: digest,
    checkedAt: observedAt,
    redirects: [],
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    stopReason: null,
    userCredentialsSent: false,
    ...tokenMetadata,
  };
  if (isStrongPublicChallenge(response.headers, text)) {
    receipt.stopReason = 'VISIBLE_CHALLENGE';
    return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: true, stopReason: receipt.stopReason };
  }
  if (!['application/json', 'text/json'].includes(mime) && !/^application\/[a-z0-9.+-]+\+json$/i.test(mime)) {
    receipt.stopReason = 'JSON_CONTENT_TYPE_REQUIRED';
    return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: false, stopReason: receipt.stopReason };
  }
  let data;
  try { data = JSON.parse(text); }
  catch {
    receipt.stopReason = 'JSON_PARSE_FAILED';
    return { ok: false, url: safeUrl(url.href), status, contentType, data: null, receipt, blocked: false, stopReason: receipt.stopReason };
  }
  return { ok: true, url: safeUrl(url.href), status, contentType, data, receipt, blocked: false, stopReason: null };
}

function contract(operation, method, requestUrl, receipt, extra = {}) {
  return {
    operation,
    method,
    requestUrl: safeUrl(requestUrl),
    finalUrl: receipt?.finalUrl ?? safeUrl(requestUrl),
    status: receipt?.status ?? null,
    mime: receipt?.mime ?? null,
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    ...extra,
  };
}

function baseRow() {
  return {
    merchantId: 'lfmall',
    merchantName: 'LFmall',
    siteUrl: LANDING_URL,
    verticalHint: 'fashion',
    receipts: [],
    records: [],
    contracts: [],
    operations: {},
    frontier: [],
    status: 'pending',
  };
}

function finalize(row) {
  const ids = row.receipts.map(item => item.receiptId);
  const receiptIds = (...kinds) => row.receipts.filter(item => kinds.includes(item.kind)).map(item => item.receiptId);
  const hasRating = row.records.some(item => item.rating?.value != null || item.rating?.reviewCount != null || item.rating?.ratingCount != null);
  const hasPrice = row.records.some(item => item.price?.amount != null || item.price?.priceText != null);
  const hasReviews = row.records.some(item => item.reviewSamples.length > 0);
  const hasVariants = row.records.some(item => item.variants.length > 0);
  const pageReached = row.receipts.some(item => item.status === 200);
  const cap = (state, evidenceReceiptIds, note = null) => ({ state, evidenceReceiptIds, note });
  row.operations = {
    landingAndObservedPages: cap(pageReached ? 'live_replay' : row.status.startsWith('blocked') ? 'blocked' : 'unavailable', ids),
    productOrServiceRecord: cap(row.records.length ? 'live_replay' : 'not_observed', row.records.flatMap(record => record.evidence.map(item => item.receiptId)), row.records.length ? null : 'No LFmall offering record was extracted.'),
    productSearch: cap(receiptIds('api_post').length ? 'live_replay' : 'not_observed', receiptIds('api_post'), 'Observed public search contract only; keyword/page scope is recorded in the contract.'),
    price: cap(hasPrice ? 'live_replay' : 'not_observed', row.records.flatMap(record => record.evidence.filter(item => item.fields.includes('price')).map(item => item.receiptId))),
    ratingSummary: cap(hasRating ? 'live_replay' : 'not_observed', row.records.flatMap(record => record.evidence.filter(item => item.fields.includes('rating')).map(item => item.receiptId))),
    variants: cap(hasVariants ? 'live_replay' : 'not_observed', row.records.flatMap(record => record.evidence.filter(item => item.fields.includes('variants')).map(item => item.receiptId))),
    reviewSamples: cap(hasReviews ? 'live_replay_partial' : 'not_observed', row.records.flatMap(record => record.evidence.filter(item => item.fields.includes('reviewSamples')).map(item => item.receiptId)), hasReviews ? 'A bounded public sample only; no reviewer identity or review text is persisted.' : 'No sample was available from a completed public review-list request.'),
  };
  return row;
}

function stop(row, state, note) {
  row.status = state;
  row.frontier.push({ url: null, text: null, state, note });
  return finalize(row);
}

/** Read a bounded public LFmall search slice and enrich a few observed product IDs. */
export async function collectLfmall({ keyword = '셔츠', productLimit = 20, detailLimit = 3, reviewPageSize = 5, timeoutMs = 20_000 } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.trim().length > 40) throw new Error('LF_MALL_KEYWORD_INVALID');
  if (!Number.isSafeInteger(productLimit) || productLimit < 1 || productLimit > MAX_SEARCH_PRODUCTS) throw new Error('LF_MALL_PRODUCT_LIMIT_INVALID');
  if (!Number.isSafeInteger(detailLimit) || detailLimit < 0 || detailLimit > 5) throw new Error('LF_MALL_DETAIL_LIMIT_INVALID');
  if (!Number.isSafeInteger(reviewPageSize) || reviewPageSize < 1 || reviewPageSize > 8) throw new Error('LF_MALL_REVIEW_PAGE_SIZE_INVALID');

  const row = baseRow();
  const landing = await readPublicPage(LANDING_URL, { allowedHosts: ['www.lfmall.co.kr'], maxRedirects: 3, maxBytes: MAX_BYTES, timeoutMs });
  const landingReceipt = normalizeReceipt(landing.receipt, 'landing');
  if (landingReceipt) row.receipts.push(landingReceipt);
  row.contracts.push(contract('landing_document_get', 'GET', LANDING_URL, landingReceipt, {
    parser: landing.ok ? 'cps_public_reader.extractPublicPage' : null,
  }));
  if (!landing.ok || landing.blocked || BLOCKED_STATUSES.has(landing.status)) {
    if (landingReceipt) landingReceipt.stopReason = landing.stopReason ?? 'LANDING_UNAVAILABLE';
    return stop(row, landing.blocked ? 'blocked_http' : 'unavailable', landing.stopReason ?? 'Landing page was not publicly readable.');
  }
  const landingExtract = extractPublicPage(landing, { merchantId: 'lfmall', typeHint: 'fashion' });
  row.contracts.at(-1).title = landingExtract.title;

  const entry = await readPublicResource(ENTRY_URL, { allowedHosts: ['static.lfmall.co.kr'], maxRedirects: 3, maxBytes: 5 * 1024 * 1024, timeoutMs });
  const entryReceipt = normalizeReceipt(entry.receipt, 'observed_public_resource');
  if (entryReceipt) row.receipts.push(entryReceipt);
  row.contracts.push(contract('observed_public_resource_get', 'GET', ENTRY_URL, entryReceipt, {
    parser: entry.ok ? 'readPublicResource' : null,
    sourceLinkText: 'script[src] observed in the prior LFmall landing receipt',
    resourceBodyFormat: entryReceipt?.mime?.split(';', 1)[0] ?? null,
  }));
  if (!entry.ok || entry.blocked || BLOCKED_STATUSES.has(entry.status)) {
    if (entryReceipt) entryReceipt.stopReason = entry.stopReason ?? 'PUBLIC_BUNDLE_UNAVAILABLE';
    return stop(row, entry.blocked ? 'blocked_host_after_partial_reads' : 'reachable_no_ontology_record', entry.stopReason ?? 'The previously observed LFmall public entry bundle was unavailable.');
  }

  const observedEndpoints = [
    'https://nxapi.lfmall.co.kr',
    'common/v1/token',
    '/exhibition/search/v1',
    '/product/v1/basics/',
    '/product/v1/price/',
    '/product/review/v1/',
    '/summary',
    '/product/detail/v1/options/{productCode}',
    'getProductOptionsGET',
  ];
  const missingEndpoints = observedEndpoints.filter(value => !entry.body.includes(value));
  if (missingEndpoints.length) return stop(row, 'reachable_no_ontology_record', 'The live public bundle no longer contains the complete previously observed endpoint set; no API calls were made.');

  const observedCode = new Map([['entry-BRzjAadY.js', entry.body]]);
  const chunkSpecs = [
    { url: SEARCH_RESULT_CHUNK_URL, name: 'SearchResult-BjzzFFxq.js', source: 'entry-BRzjAadY.js', reason: 'dynamic import observed in entry bundle', required: true },
    { url: SEARCH_PRODUCT_CHUNK_URL, name: 'SearchProductList-tNsJnY9m.js', source: 'SearchResult-BjzzFFxq.js', reason: 'module import observed in SearchResult chunk', required: true },
    { url: PRODUCT_CHUNK_URL, name: 'Product-x6G4lxaH.js', source: 'entry-BRzjAadY.js', reason: 'dynamic import observed in entry bundle', required: true },
    { url: PRODUCT_REVIEW_CHUNK_URL, name: 'ProductReview-CaFl4-kS.js', source: 'entry-BRzjAadY.js', reason: 'dynamic import observed in entry bundle', required: true },
  ];
  for (const chunk of chunkSpecs) {
    const sourceBody = observedCode.get(chunk.source);
    if (!sourceBody?.includes(chunk.name)) {
      if (chunk.required) return stop(row, 'reachable_no_ontology_record', `The currently observed entry bundle no longer references ${chunk.name}; no guessed chunk URL was fetched.`);
      continue;
    }
    const result = await readPublicResource(chunk.url, { allowedHosts: ['static.lfmall.co.kr'], maxRedirects: 3, maxBytes: 2 * 1024 * 1024, timeoutMs });
    const receipt = normalizeReceipt(result.receipt, 'observed_public_resource');
    if (receipt) row.receipts.push(receipt);
    row.contracts.push(contract('observed_public_resource_get', 'GET', chunk.url, receipt, {
      parser: result.ok ? 'readPublicResource' : null,
      sourceLinkText: chunk.reason,
      resourceBodyFormat: receipt?.mime?.split(';', 1)[0] ?? null,
    }));
    if (!result.ok || result.blocked || BLOCKED_STATUSES.has(result.status)) {
      if (receipt) receipt.stopReason = result.stopReason ?? 'PUBLIC_CHUNK_UNAVAILABLE';
      if (result.blocked || BLOCKED_STATUSES.has(result.status)) return stop(row, 'blocked_host_after_partial_reads', result.stopReason ?? 'A public LFmall code chunk returned a blocked response; stopped without retries.');
      row.frontier.push({ url: safeUrl(chunk.url), text: chunk.name, state: 'observed_resource_unavailable', note: result.stopReason ?? 'PUBLIC_RESOURCE_UNAVAILABLE' });
      continue;
    }
    observedCode.set(chunk.name, result.body);
    const requiredStrings = chunk.name.startsWith('SearchResult')
      ? ['getSearchPOST', 'sendLogYN']
      : chunk.name.startsWith('SearchProductList') ? ['productCode', 'productName']
        : chunk.name.startsWith('ProductReview') ? []
          : chunk.name.startsWith('Product') ? ['productOptionDTO', 'productOptionSizeDTOList', 'getReviewSummaryGET', 'getReviewListGET'] : [];
    const absent = requiredStrings.filter(value => !result.body.includes(value));
    row.contracts.at(-1).contractStringsObserved = requiredStrings.filter(value => result.body.includes(value));
    if (absent.length) return stop(row, 'reachable_no_ontology_record', `An observed LFmall UI chunk no longer confirms its operation shape (${chunk.name}); stopped before API replay.`);
    row.frontier.push({ url: safeUrl(chunk.url), text: chunk.name, state: 'observed_script_resource_read', note: 'Read from an entry-bundle import; executable code was not run.' });
  }
  row.frontier.push({ url: safeUrl(ENTRY_URL), text: 'script[src]', state: 'observed_script_resource_read', note: 'Public same-site bundle was fetched as text and inspected; it was not executed.' });

  const tokenResult = await readPublicResource(BOOTSTRAP_URL, { allowedHosts: ['nxapi.lfmall.co.kr'], maxRedirects: 0, maxBytes: 128 * 1024, timeoutMs });
  const tokenReceipt = normalizeReceipt(tokenResult.receipt, 'public_anonymous_bootstrap', {
    publicRequestTokenSent: false,
    anonymousBootstrap: { kind: 'public_anonymous_bootstrap', issuedWithoutAccount: true, headerName: 'X-REQUEST-TOKEN', retention: 'memory_only' },
    userCredentialsSent: false,
  });
  if (tokenReceipt) row.receipts.push(tokenReceipt);
  row.contracts.push(contract('public_request_token_bootstrap', 'GET', BOOTSTRAP_URL, tokenReceipt, {
    parser: tokenResult.ok ? 'readPublicResource + in-memory JSON parse' : null,
    authentication: 'anonymous_public_app_request_token',
    accountRequired: false,
    cookiesSent: false,
    authorizationSent: false,
    emittedHeaderName: 'X-REQUEST-TOKEN',
    tokenRetention: 'memory_only',
  }));
  if (!tokenResult.ok || tokenResult.blocked || BLOCKED_STATUSES.has(tokenResult.status)) {
    if (tokenReceipt) tokenReceipt.stopReason = tokenResult.stopReason ?? 'PUBLIC_TOKEN_BOOTSTRAP_UNAVAILABLE';
    return stop(row, tokenResult.blocked ? 'blocked_host_after_partial_reads' : 'reachable_no_ontology_record', tokenResult.stopReason ?? 'Anonymous public request-token bootstrap was unavailable; no replay followed.');
  }
  let tokenData;
  try { tokenData = JSON.parse(tokenResult.body); }
  catch { return stop(row, 'reachable_no_ontology_record', 'Anonymous public request-token response was not valid JSON.'); }
  const tokenValue = typeof tokenData?.body?.token === 'string' && tokenData.body.token.length >= 8 && tokenData.body.token.length <= 1000 && !/[\r\n]/.test(tokenData.body.token)
    ? tokenData.body.token : null;
  if (!tokenValue) return stop(row, 'reachable_no_ontology_record', 'The public bootstrap response did not expose the bundle-observed body.token field.');
  const requestToken = { value: tokenValue, bootstrapReceiptId: tokenReceipt.receiptId };

  const searchUrl = `${API_ORIGIN}/exhibition/search/v1`;
  const searchBody = {
    aggs: ['categories'],
    brandGroupPageWithFixedTid: false,
    keyword: keyword.trim(),
    order: 'popular_2_increase_category',
    page: 1,
    sendLogYN: 'N',
    size: 40,
  };
  const search = await requestPinnedJson(searchUrl, { method: 'POST', requestToken, body: searchBody, timeoutMs });
  if (search.receipt) row.receipts.push(search.receipt);
  row.contracts.push(contract('observed_product_search_json_post', 'POST', searchUrl, search.receipt, {
    endpointObservedIn: safeUrl(ENTRY_URL),
    requestBody: searchBody,
    responseBodyPath: 'body.results.products',
    recordCount: null,
    parser: search.ok ? 'JSON response normalization' : null,
  }));
  if (!search.ok || search.blocked || BLOCKED_STATUSES.has(search.status)) {
    return stop(row, search.blocked ? 'blocked_host_after_partial_reads' : 'reachable_no_ontology_record', search.stopReason ?? 'Observed product-search request did not return a usable public JSON response.');
  }
  const results = search.data?.body?.results;
  const products = asList(results?.products).slice(0, productLimit);
  row.contracts.at(-1).responseKeys = objectKeys(search.data);
  row.contracts.at(-1).resultsKeys = objectKeys(results);
  row.contracts.at(-1).recordCount = products.length;
  row.contracts.at(-1).totalRecords = safeCount(results?.total);
  if (!products.length) return stop(row, 'reachable_no_ontology_record', 'Observed search response did not contain body.results.products.');

  const searchReceiptId = search.receipt.receiptId;
  const records = products.map((product, index) => normalizeSearchProduct(product, index, searchReceiptId)).filter(Boolean);
  for (const [index, record] of records.entries()) {
    const product = products.find(item => String(firstPresent(item?.id, item?.productCode, item?.productCd)) === record.sourceLocalId);
    record.variants = variantsFromProduct(product, record.url, searchReceiptId);
    if (record.variants.length) record.evidence[0].fields.push('variants');
  }
  row.records.push(...records);
  row.contracts.at(-1).normalizedRecordCount = records.length;
  row.frontier.push({ url: safeUrl(searchUrl), text: `keyword=${keyword.trim()}`, state: 'read_product_search_records', recordCount: records.length });

  const productDetails = [];
  for (const record of records.slice(0, detailLimit)) {
    const code = record.sourceLocalId;
    const detailUrl = `${API_ORIGIN}/product/v1/basics/${encodeURIComponent(code)}`;
    const detail = await requestPinnedJson(detailUrl, { method: 'GET', requestToken, timeoutMs });
    if (detail.receipt) row.receipts.push(detail.receipt);
    row.contracts.push(contract('observed_product_basics_json_get', 'GET', detailUrl, detail.receipt, {
      endpointObservedIn: safeUrl(ENTRY_URL),
      responseBodyPath: 'body.productBasicDTO/productBrandDTO/productDetailDTO',
      parser: detail.ok ? 'JSON response normalization' : null,
    }));
    if (!detail.ok || detail.blocked || BLOCKED_STATUSES.has(detail.status)) {
      if (detail.blocked || BLOCKED_STATUSES.has(detail.status)) return stop(row, 'blocked_host_after_partial_reads', detail.stopReason ?? 'A product-basics request was blocked; stopped all further LFmall calls.');
      productDetails.push({ sourceLocalId: code, state: 'detail_unavailable', reason: detail.stopReason });
      continue;
    }
    normalizeBasics(record, detail.data?.body, detail.receipt.receiptId);
    row.contracts.at(-1).bodyKeys = objectKeys(detail.data?.body);
    row.contracts.at(-1).productBasicKeys = objectKeys(detail.data?.body?.productBasicDTO);
    row.contracts.at(-1).productDetailKeys = objectKeys(detail.data?.body?.productDetailDTO);
    productDetails.push({ sourceLocalId: code, receiptId: detail.receipt.receiptId, state: 'detail_live' });

    const optionsUrl = new URL(`${API_ORIGIN}/product/detail/v1/options/${encodeURIComponent(code)}`);
    optionsUrl.searchParams.set('stockCheckYn', 'N');
    const options = await requestPinnedJson(optionsUrl.href, { method: 'GET', requestToken, timeoutMs });
    if (options.receipt) row.receipts.push(options.receipt);
    row.contracts.push(contract('observed_product_options_json_get', 'GET', optionsUrl.href, options.receipt, {
      endpointObservedIn: safeUrl(ENTRY_URL),
      responseBodyPath: 'body.productOptionDTO.productOptionSizeDTOList',
      queryParameters: { stockCheckYn: 'N' },
      parser: options.ok ? 'variant metadata-only normalization' : null,
    }));
    if (!options.ok || options.blocked || BLOCKED_STATUSES.has(options.status)) {
      if (options.blocked || BLOCKED_STATUSES.has(options.status)) return stop(row, 'blocked_host_after_partial_reads', options.stopReason ?? 'A product-options request was blocked; stopped all further LFmall calls.');
      productDetails.at(-1).variantState = options.stopReason ?? 'product_options_unavailable';
    } else {
      const normalizedOptions = normalizeOptions(record, options.data?.body, options.receipt.receiptId);
      row.contracts.at(-1).bodyKeys = objectKeys(options.data?.body);
      row.contracts.at(-1).optionDTOKeys = normalizedOptions.optionKeys;
      row.contracts.at(-1).sizeRowKeys = normalizedOptions.sizeRowKeys;
      row.contracts.at(-1).variantCount = normalizedOptions.variants.length;
      if (normalizedOptions.variants.length) productDetails.at(-1).variantReceiptId = options.receipt.receiptId;
    }

    const priceUrl = `${API_ORIGIN}/product/v1/price/${encodeURIComponent(code)}`;
    const price = await requestPinnedJson(priceUrl, { method: 'GET', requestToken, timeoutMs });
    if (price.receipt) row.receipts.push(price.receipt);
    row.contracts.push(contract('observed_product_price_json_get', 'GET', priceUrl, price.receipt, {
      endpointObservedIn: safeUrl(ENTRY_URL),
      responseBodyPath: 'body.productPriceDTO',
      parser: price.ok ? 'JSON response normalization' : null,
    }));
    if (!price.ok || price.blocked || BLOCKED_STATUSES.has(price.status)) {
      if (price.blocked || BLOCKED_STATUSES.has(price.status)) return stop(row, 'blocked_host_after_partial_reads', price.stopReason ?? 'A price request was blocked; stopped all further LFmall calls.');
      productDetails.at(-1).priceState = price.stopReason ?? 'price_unavailable';
    } else {
      normalizePrice(record, price.data?.body, price.receipt.receiptId);
      row.contracts.at(-1).bodyKeys = objectKeys(price.data?.body);
      row.contracts.at(-1).productPriceKeys = objectKeys(price.data?.body?.productPriceDTO);
      row.contracts.at(-1).publicCouponCount = asList(price.data?.body?.productCouponDTOList).length;
      row.contracts.at(-1).couponKeys = objectKeys(asList(price.data?.body?.productCouponDTOList)[0]);
      row.contracts.at(-1).couponMonetaryFieldNames = Object.keys(asList(price.data?.body?.productCouponDTOList)[0] ?? {}).filter(key => /(?:price|amount|amt)$/i.test(key) && !/(?:id|code|seq|number|no)$/i.test(key));
      productDetails.at(-1).priceReceiptId = price.receipt.receiptId;
    }

    const summaryUrl = `${API_ORIGIN}/product/review/v1/${encodeURIComponent(code)}/summary`;
    const summary = await requestPinnedJson(summaryUrl, { method: 'GET', requestToken, timeoutMs });
    if (summary.receipt) row.receipts.push(summary.receipt);
    row.contracts.push(contract('observed_product_review_summary_json_get', 'GET', summaryUrl, summary.receipt, {
      endpointObservedIn: safeUrl(ENTRY_URL),
      responseBodyPath: 'body.reviewAverageScore/reviewTotalCount/reviewScoreDTOList',
      parser: summary.ok ? 'JSON response normalization' : null,
    }));
    if (!summary.ok || summary.blocked || BLOCKED_STATUSES.has(summary.status)) {
      if (summary.blocked || BLOCKED_STATUSES.has(summary.status)) return stop(row, 'blocked_host_after_partial_reads', summary.stopReason ?? 'A review-summary request was blocked; stopped all further LFmall calls.');
      productDetails.at(-1).ratingState = summary.stopReason ?? 'review_summary_unavailable';
    } else {
      normalizeSummary(record, summary.data?.body, summary.receipt.receiptId);
      row.contracts.at(-1).bodyKeys = objectKeys(summary.data?.body);
      row.contracts.at(-1).scoreRowKeys = objectKeys(asList(summary.data?.body?.reviewScoreDTOList)[0]);
      productDetails.at(-1).summaryReceiptId = summary.receipt.receiptId;
    }

    const reviewUrl = new URL(`${API_ORIGIN}/product/review/v1/${encodeURIComponent(code)}`);
    reviewUrl.searchParams.set('currentPageIndex', '1');
    reviewUrl.searchParams.set('pagingWindowSize', String(reviewPageSize));
    const reviewList = await requestPinnedJson(reviewUrl.href, { method: 'GET', requestToken, timeoutMs });
    if (reviewList.receipt) row.receipts.push(reviewList.receipt);
    row.contracts.push(contract('observed_product_review_list_json_get', 'GET', reviewUrl.href, reviewList.receipt, {
      endpointObservedIn: safeUrl(ENTRY_URL),
      responseBodyPath: 'body.reviewDTOList',
      requestQuery: { currentPageIndex: 1, pagingWindowSize: reviewPageSize },
      parser: reviewList.ok ? 'review metadata-only normalization' : null,
      reviewBodiesPersisted: false,
      reviewerIdentityPersisted: false,
    }));
    if (!reviewList.ok || reviewList.blocked || BLOCKED_STATUSES.has(reviewList.status)) {
      if (reviewList.blocked || BLOCKED_STATUSES.has(reviewList.status)) return stop(row, 'blocked_host_after_partial_reads', reviewList.stopReason ?? 'A review-list request was blocked; stopped all further LFmall calls.');
      productDetails.at(-1).reviewState = reviewList.stopReason ?? 'review_list_unavailable';
    } else {
      const normalized = normalizeReviewList(reviewList.data?.body, reviewList.receipt.receiptId);
      record.reviewSamples = normalized.samples;
      record.evidence.push(...normalized.evidence);
      row.contracts.at(-1).bodyKeys = objectKeys(reviewList.data?.body);
      row.contracts.at(-1).sampleCount = normalized.samples.length;
      row.contracts.at(-1).publicReviewCount = normalized.count;
      productDetails.at(-1).reviewListReceiptId = reviewList.receipt.receiptId;
    }
  }

  row.contracts.push({
    operation: 'observed_product_detail_route_builder',
    method: 'SOURCE_INSPECTION',
    requestUrl: safeUrl(ENTRY_URL),
    finalUrl: safeUrl(ENTRY_URL),
    status: entry.status,
    mime: entry.contentType,
    browserUsed: false,
    cookiesSent: false,
    authorizationSent: false,
    template: '/app/product/{observed product code}',
    observedBuilderNote: 'Entry bundle builds `/app${PRODUCT}/${productCode}?${serializedQuery}`; the record URL retains the observed product path and omits the optional UI query string.',
  });
  row.frontier.push(...productDetails.map(detail => ({ url: productUrl(detail.sourceLocalId), text: detail.sourceLocalId, state: detail.state, ...(detail.reason ? { note: detail.reason } : {}), ...(detail.variantReceiptId ? { variantReceiptId: detail.variantReceiptId } : {}), ...(detail.priceReceiptId ? { priceReceiptId: detail.priceReceiptId } : {}), ...(detail.summaryReceiptId ? { ratingReceiptId: detail.summaryReceiptId } : {}), ...(detail.reviewListReceiptId ? { reviewReceiptId: detail.reviewListReceiptId } : {}) })));
  row.status = row.records.length ? 'reachable_with_ontology_records' : 'reachable_no_ontology_record';
  return finalize(row);
}
