import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isStrongPublicChallenge } from '../lib/cps-public-reader.mjs';

const ORIGIN = 'https://m.coupang.com';
const PATH = '/vm/vendor-funded-discount/paged';
const PROMOTION_PAGE = 'LIGHTENING_DEAL';
const LABEL = 'VENDOR_FUNDED_DISCOUNT';
const DEFAULT_MAX_PAGES = 10;
// The observed public bundle initializes this.maxPage to 50.
const MAX_PAGES = 50;
const PAGE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TARGET_TITLE_PATTERN = /Unique|후드 집업|ETB-01WH|음파 전동칫솔|제니베이커리/i;
const ID = /^[1-9]\d{0,19}$/;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function positiveId(value) {
  if (typeof value === 'string' && ID.test(value)) return value;
  return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function safeCount(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,12}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function safeText(value, maxLength = 500) {
  if (typeof value !== 'string' || value.length > maxLength || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
  return value.replace(/\s+/g, ' ').trim() || null;
}

function safeMime(value) {
  if (typeof value !== 'string') return null;
  const mime = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : null;
}

function safeFormattedPrice(value) {
  const text = safeText(value, 48);
  if (!text || !/^(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:원)?$/.test(text)) return null;
  const amount = Number(text.replace(/원$/, '').replaceAll(',', ''));
  return Number.isSafeInteger(amount) && amount >= 0 ? { text, amount } : null;
}

function localizedPrice(wrapper, localizedKey, formattedKey) {
  const localized = isRecord(wrapper) && isRecord(wrapper[localizedKey]) ? wrapper[localizedKey] : null;
  const rawAmount = localized ? safeCount(localized.rawAmount) : null;
  const amountText = localized && typeof localized.amount === 'string' && /^\d{1,12}$/.test(localized.amount)
    ? localized.amount : null;
  const formatted = isRecord(wrapper) ? safeFormattedPrice(wrapper[formattedKey]) : null;
  const currency = localized?.currency === 'KRW' ? 'KRW' : null;
  const fractionDigits = localized?.fractionDigits === 0 ? 0 : null;
  const crosscheckMatches = rawAmount !== null && amountText !== null && formatted !== null
    && currency === 'KRW' && fractionDigits === 0
    && Number(amountText) === rawAmount && formatted.amount === rawAmount;
  return {
    rawAmountKRW: rawAmount,
    localizedAmountText: amountText,
    formattedText: formatted?.text ?? null,
    currency,
    fractionDigits,
    crosscheckMatches,
    listingPriceKRW: crosscheckMatches ? rawAmount : null,
  };
}

function safePercentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function projectDealInfo(value) {
  if (!isRecord(value)) return null;
  const timedDealStatus = typeof value.timedDealStatus === 'string'
    && /^[A-Z0-9_]{1,50}$/.test(value.timedDealStatus) ? value.timedDealStatus : null;
  return {
    progressRate: safePercentage(value.progressRate),
    remainingTime: safeCount(value.remainingTime),
    timedDealStatus,
    remainingTimeUnit: 'unverified',
  };
}

function projectProduct(row) {
  if (!isRecord(row)) return { product: null, error: 'row_not_object' };
  const productId = positiveId(row.productId);
  const itemId = positiveId(row.itemId);
  const vendorItemId = positiveId(row.vendorItemId);
  if (!productId || !itemId || !vendorItemId) return { product: null, error: 'identity_invalid' };

  const priceInfo = isRecord(row.priceInfoWrapper) ? row.priceInfoWrapper : null;
  const finalPrice = localizedPrice(priceInfo, 'i18nFinalPrice', 'finalPrice');
  const originPrice = localizedPrice(priceInfo, 'i18nOriginPrice', 'originPrice');
  const title = safeText(row.title);
  const timedDeal = projectDealInfo(row.lighteningDealInfo);
  const badgeText = priceInfo ? safeText(priceInfo.priceBadgeText, 80) : null;
  const product = {
    productId,
    itemId,
    vendorItemId,
    title,
    soldOut: typeof row.soldOut === 'boolean' ? row.soldOut : null,
    listingPriceScope: 'public_promotion_listing_final_price_only',
    finalPrice,
    originPrice,
    priceBadgeText: badgeText,
    priceBadgeIsTimeSale: badgeText === '타임할인',
    priceInfoDiscountRate: priceInfo ? safePercentage(priceInfo.discountRate) : null,
    discountPercent: safePercentage(row.discountPercent),
    lighteningDealInfo: timedDeal,
    timedDealActive: timedDeal?.timedDealStatus === 'TIME_DEAL',
    officialProductCategoryVerified: false,
    wowMemberEligibilityVerified: false,
    couponEligibilityVerified: false,
    ownerPriceVerified: false,
  };
  const projectionIncomplete = title === null || typeof row.soldOut !== 'boolean'
    || !finalPrice.crosscheckMatches;
  return { product, error: null, projectionIncomplete };
}

async function readBoundedBody(response) {
  if (!response.body) return { text: '', bytes: 0, bodyComplete: true, overLimit: false };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    let part;
    try { part = await reader.read(); }
    catch {
      return { text: null, bytes, bodyComplete: false, overLimit: false };
    }
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) {
      await reader.cancel().catch(() => {});
      return { text: null, bytes, bodyComplete: false, overLimit: false };
    }
    if (part.value.byteLength > MAX_RESPONSE_BYTES - bytes) {
      bytes = MAX_RESPONSE_BYTES + 1;
      await reader.cancel().catch(() => {});
      return { text: null, bytes, bodyComplete: false, overLimit: true };
    }
    bytes += part.value.byteLength;
    chunks.push(Buffer.from(part.value));
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { return { text: null, bytes, bodyComplete: false, overLimit: false }; }
  return { text, bytes, bodyComplete: true, overLimit: false };
}

function requestUrl(page) {
  const url = new URL(PATH, ORIGIN);
  url.searchParams.set('promotionPage', PROMOTION_PAGE);
  url.searchParams.set('page', String(page));
  url.searchParams.set('couponOnly', 'false');
  url.searchParams.set('isAdult', 'false');
  return url;
}

function pageReceipt(page) {
  return {
    page,
    request: {
      method: 'GET', origin: ORIGIN, path: PATH,
      query: { promotionPage: PROMOTION_PAGE, page, couponOnly: false, isAdult: false },
      transport: 'native_fetch', execution: 'pure_http', credentials: 'omit',
      customHeaders: false, redirectsFollowed: false,
    },
    status: null,
    contentType: null,
    bytes: 0,
    bodyComplete: false,
    challengeConfirmed: false,
    applicationCode: null,
    returnedRowCount: null,
    currentPage: null,
    hasNextPage: null,
    declaredTotalCount: null,
    categoryFilterListEntryCount: null,
    validIdentityRows: 0,
    uniqueRowsAdded: 0,
    duplicateRows: 0,
    duplicateWithinPageRows: 0,
    invalidRows: 0,
    state: 'not_attempted',
    errorCode: null,
  };
}

function safeApplicationCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value) ? value : null;
}

function safePageNumber(value) {
  const page = safeCount(value);
  return page !== null && page > 0 ? page : null;
}

function projectRowSummary(product) {
  return {
    productId: product.productId,
    itemId: product.itemId,
    vendorItemId: product.vendorItemId,
    title: product.title,
    soldOut: product.soldOut,
    listingFinalPriceKRW: product.finalPrice.listingPriceKRW,
    priceBadgeText: product.priceBadgeText,
    timedDealStatus: product.lighteningDealInfo?.timedDealStatus ?? null,
    priceScope: product.listingPriceScope,
    wowMemberEligibilityVerified: false,
    ownerPriceVerified: false,
  };
}

export async function collectCoupangFlashSaleInventory({ maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES)
    throw new Error('FLASH_SALE_MAX_PAGES_INVALID');
  if (typeof globalThis.fetch !== 'function') throw new Error('FLASH_SALE_NATIVE_FETCH_UNAVAILABLE');

  const checkedAt = new Date().toISOString();
  const startedAt = performance.now();
  const rows = [];
  const seenTriples = new Set();
  const pageSignatures = new Set();
  const pages = [];
  const totalCounts = [];
  let stopReason = 'max_pages_reached';
  let declaredTotalCount = null;
  let categoryFilterListEntryCount = null;
  let projectionIncompleteRows = 0;
  let duplicateIdentityRows = 0;
  let invalidIdentityRows = 0;
  let paginationEnded = false;

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await wait(PAGE_DELAY_MS);
    const receipt = pageReceipt(page);
    pages.push(receipt);
    const target = requestUrl(page);
    let response;
    try {
      response = await globalThis.fetch(target.href, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      receipt.state = 'failed';
      receipt.errorCode = 'native_request_failed';
      stopReason = 'native_request_failed';
      break;
    }

    receipt.status = Number.isInteger(response.status) ? response.status : null;
    receipt.contentType = safeMime(response.headers.get('content-type'));
    receipt.request.redirectsFollowed = response.redirected === true;
    const body = await readBoundedBody(response);
    receipt.bytes = body.bytes;
    receipt.bodyComplete = body.bodyComplete;

    const challengeHeaders = {
      'cf-mitigated': response.headers.get('cf-mitigated'),
      'x-captcha-required': response.headers.get('x-captcha-required'),
      'x-sucuri-block': response.headers.get('x-sucuri-block'),
    };
    receipt.challengeConfirmed = isStrongPublicChallenge(challengeHeaders, body.text ?? '');
    if (body.overLimit) {
      receipt.state = 'failed';
      receipt.errorCode = 'response_too_large';
      stopReason = 'response_too_large';
      break;
    }
    if (!body.bodyComplete || body.text === null) {
      receipt.state = 'failed';
      receipt.errorCode = 'response_body_unavailable';
      stopReason = 'response_body_unavailable';
      break;
    }
    if (receipt.challengeConfirmed) {
      receipt.state = 'failed';
      receipt.errorCode = 'challenge_confirmed';
      stopReason = 'challenge_confirmed';
      break;
    }
    if (receipt.status !== 200) {
      receipt.state = 'failed';
      receipt.errorCode = Number.isInteger(receipt.status) ? `http_${receipt.status}` : 'http_status_unavailable';
      stopReason = receipt.status === 403 ? 'http_403' : receipt.status === 429 ? 'http_429'
        : receipt.status === 418 ? 'http_418' : receipt.status === 401 ? 'http_401' : 'http_rejected';
      break;
    }
    if (receipt.contentType !== 'application/json') {
      receipt.state = 'failed';
      receipt.errorCode = 'unexpected_content_type';
      stopReason = 'unexpected_content_type';
      break;
    }

    let payload;
    try { payload = JSON.parse(body.text); }
    catch {
      receipt.state = 'failed';
      receipt.errorCode = 'invalid_json';
      stopReason = 'invalid_response';
      break;
    }
    if (!isRecord(payload) || payload.rCode !== 'RET0000' || !isRecord(payload.rData)
      || !Array.isArray(payload.rData.productList) || typeof payload.rData.hasNextPage !== 'boolean') {
      receipt.applicationCode = isRecord(payload) ? safeApplicationCode(payload.rCode) : null;
      receipt.state = 'failed';
      receipt.errorCode = payload?.rCode === 'RET0000' ? 'invalid_response_schema' : 'application_rejected';
      stopReason = 'invalid_response';
      break;
    }

    const data = payload.rData;
    const currentPage = safePageNumber(data.curPage);
    const pageRows = data.productList;
    const pageTotalCount = safeCount(data.totalCount);
    const categoryCount = Array.isArray(data.categoryFilterList) ? data.categoryFilterList.length : null;
    receipt.applicationCode = 'RET0000';
    receipt.currentPage = currentPage;
    receipt.hasNextPage = data.hasNextPage;
    receipt.returnedRowCount = pageRows.length;
    receipt.declaredTotalCount = pageTotalCount;
    receipt.categoryFilterListEntryCount = categoryCount;
    if (pageTotalCount !== null) totalCounts.push(pageTotalCount);
    if (categoryFilterListEntryCount === null && categoryCount !== null) categoryFilterListEntryCount = categoryCount;

    if (currentPage !== page || (data.totalCount !== undefined && pageTotalCount === null)) {
      receipt.state = 'failed';
      receipt.errorCode = 'pagination_metadata_mismatch';
      stopReason = 'invalid_response';
      break;
    }
    if (pageRows.length === 0 && data.hasNextPage) {
      receipt.state = 'failed';
      receipt.errorCode = 'empty_page_with_next_page';
      stopReason = 'invalid_response';
      break;
    }

    const pageKeys = [];
    const pageUnique = new Set();
    const productsOnPage = new Map();
    let invalidOnPage = 0;
    for (const rawRow of pageRows) {
      const projected = projectProduct(rawRow);
      if (!projected.product) {
        invalidOnPage++;
        invalidIdentityRows++;
        continue;
      }
      receipt.validIdentityRows++;
      const key = `${projected.product.productId}:${projected.product.itemId}:${projected.product.vendorItemId}`;
      if (pageUnique.has(key)) {
        receipt.duplicateWithinPageRows++;
        duplicateIdentityRows++;
        const prior = productsOnPage.get(key);
        const stableFields = product => [product.title, product.soldOut,
          product.finalPrice.listingPriceKRW, product.originPrice.listingPriceKRW,
          product.priceBadgeText, product.lighteningDealInfo?.timedDealStatus ?? null];
        if (JSON.stringify(stableFields(prior)) !== JSON.stringify(stableFields(projected.product)))
          invalidOnPage++;
        continue;
      }
      pageUnique.add(key);
      productsOnPage.set(key, projected.product);
      pageKeys.push(key);
      if (projected.projectionIncomplete) projectionIncompleteRows++;
      if (seenTriples.has(key)) {
        receipt.duplicateRows++;
        duplicateIdentityRows++;
        continue;
      }
      seenTriples.add(key);
      rows.push(projected.product);
      receipt.uniqueRowsAdded++;
    }
    receipt.invalidRows = invalidOnPage;

    const signature = [...pageUnique].sort().join('|');
    const repeatedPage = pageSignatures.has(signature);
    if (repeatedPage) {
      receipt.state = 'failed';
      receipt.errorCode = 'repeated_page';
      stopReason = 'repeated_page';
      break;
    }
    pageSignatures.add(signature);
    if (invalidOnPage > 0) {
      receipt.state = 'failed';
      receipt.errorCode = 'invalid_product_row';
      stopReason = 'invalid_response';
      break;
    }
    if (receipt.duplicateRows > 0) {
      receipt.state = 'failed';
      receipt.errorCode = 'duplicate_identity_across_pages';
      stopReason = 'duplicate_identity_across_pages';
      break;
    }
    receipt.state = 'complete';
    if (!data.hasNextPage) {
      paginationEnded = true;
      stopReason = 'no_next_page';
      break;
    }
    if (page === maxPages) {
      stopReason = 'max_pages_reached';
      break;
    }
  }

  const pagesReturnedRows = pages.reduce((sum, page) => sum + (page.returnedRowCount ?? 0), 0);
  const allPagesValid = pages.length > 0 && pages.every(page => page.state === 'complete');
  const totalCountConsistent = totalCounts.length === 0 || totalCounts.every(value => value === totalCounts[0]);
  declaredTotalCount = totalCounts.length > 0 ? totalCounts[0] : null;
  const uniqueTripleReconciled = rows.length + duplicateIdentityRows === pagesReturnedRows
    && invalidIdentityRows === 0 && pages.every(page => page.invalidRows === 0);
  const totalCountReconciled = declaredTotalCount === null ? null : declaredTotalCount === rows.length;
  const inventoryTraversalComplete = paginationEnded && allPagesValid && uniqueTripleReconciled;
  const complete = inventoryTraversalComplete && totalCountConsistent && totalCountReconciled !== false;
  const timeDealRows = rows.filter(row => row.lighteningDealInfo?.timedDealStatus === 'TIME_DEAL').length;
  const explicitOtherStatusRows = rows.filter(row => row.lighteningDealInfo?.timedDealStatus !== null
    && row.lighteningDealInfo?.timedDealStatus !== undefined
    && row.lighteningDealInfo.timedDealStatus !== 'TIME_DEAL').length;
  const missingTimeDealStatusRows = rows.length - timeDealRows - explicitOtherStatusRows;
  const priceCrosscheckValidRows = rows.filter(row => row.finalPrice.crosscheckMatches === true).length;
  const observedPriceCoverageComplete = rows.length > 0 && projectionIncompleteRows === 0
    && priceCrosscheckValidRows === rows.length;
  const priceCoverageComplete = complete && observedPriceCoverageComplete;
  const targetRows = rows.filter(row => row.title && TARGET_TITLE_PATTERN.test(row.title)).map(projectRowSummary);
  const completedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    operation: 'public_mypromo_lightening_deal_inventory',
    checkedAt,
    completedAt,
    elapsedMs: Math.round(performance.now() - startedAt),
    source: {
      origin: ORIGIN,
      path: PATH,
      promotionPage: PROMOTION_PAGE,
      label: LABEL,
    },
    requestPolicy: {
      method: 'GET',
      transport: 'native_fetch',
      execution: 'pure_http',
      browserUsed: false,
      credentials: 'omit',
      cookiesSent: false,
      ownerCredentialUsed: false,
      customHeaders: false,
      redirectMode: 'manual',
      automaticRetry: false,
      visitorContextUsed: false,
      authenticationStoreUsed: false,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      interPageDelayMs: PAGE_DELAY_MS,
    },
    priceScope: 'public_promotion_listing_final_price_only',
    couponEligibilityVerified: false,
    wowMemberEligibilityVerified: false,
    ownerPriceVerified: false,
    officialProductCategoriesVerified: false,
    categoryFilterListEntryCount,
    categoryMembership: 'unverified',
    maxPagesRequested: maxPages,
    pagesRequested: pages.length,
    pages,
    counts: {
      returnedRows: pagesReturnedRows,
      uniqueTriples: rows.length,
      uniqueProductIds: new Set(rows.map(row => row.productId)).size,
      explicitlyInStockRows: rows.filter(row => row.soldOut === false).length,
      explicitlySoldOutRows: rows.filter(row => row.soldOut === true).length,
      unknownStockRows: rows.filter(row => row.soldOut === null).length,
      timedDealStatusCounts: Object.fromEntries([...new Set(rows.map(row => row.lighteningDealInfo?.timedDealStatus ?? 'UNVERIFIED'))]
        .map(status => [status, rows.filter(row => (row.lighteningDealInfo?.timedDealStatus ?? 'UNVERIFIED') === status).length])),
      duplicateIdentityRows,
      invalidIdentityRows,
      projectionIncompleteRows,
      finalPriceCrosscheckValidRows: priceCrosscheckValidRows,
      activeTimeDealRows: timeDealRows,
      nonTimeDealStatusRows: explicitOtherStatusRows,
      missingTimeDealStatusRows,
      targetRows: targetRows.length,
      declaredTotalCount,
      totalCountConsistent,
      totalCountReconciled,
      uniqueTripleReconciled,
    },
    stopReason,
    paginationEnded,
    inventoryTraversalComplete,
    observedPriceCoverageComplete,
    priceCoverageComplete,
    complete,
    rows,
    targetRows,
  };

  const directory = new URL(`../../../../runs/coupang-flash-sale-inventory-${checkedAt.replace(/[:.]/g, '-')}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  const inventoryPath = fileURLToPath(new URL('inventory.json', directory));
  await writeFile(inventoryPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { report, inventoryPath };
}

function parseMaxPages(args) {
  if (args.length === 0) return DEFAULT_MAX_PAGES;
  if (args.length !== 1 || !/^--max-pages=\d+$/.test(args[0])) throw new Error('FLASH_SALE_ARGUMENTS_INVALID');
  const value = Number(args[0].slice('--max-pages='.length));
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGES) throw new Error('FLASH_SALE_MAX_PAGES_INVALID');
  return value;
}

function safeCliError(error) {
  return /^FLASH_SALE_[A-Z0-9_]{1,80}$/.test(error?.message ?? '') ? error.message : 'FLASH_SALE_COLLECTION_FAILED';
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const maxPages = parseMaxPages(process.argv.slice(2));
    const { report, inventoryPath } = await collectCoupangFlashSaleInventory({ maxPages });
    console.log(JSON.stringify({
      operation: report.operation,
      checkedAt: report.checkedAt,
      completedAt: report.completedAt,
      complete: report.complete,
      inventoryTraversalComplete: report.inventoryTraversalComplete,
      observedPriceCoverageComplete: report.observedPriceCoverageComplete,
      priceCoverageComplete: report.priceCoverageComplete,
      stopReason: report.stopReason,
      pagesRequested: report.pagesRequested,
      counts: report.counts,
      targetRows: report.targetRows,
      inventoryPath,
    }));
  } catch (error) {
    console.error(JSON.stringify({ error: safeCliError(error) }));
    process.exitCode = 1;
  }
}
