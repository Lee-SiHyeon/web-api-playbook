import { createHash } from 'node:crypto';
import {
  CoupangVisitorError, createCoupangVisitorContext,
  prepareCoupangVisitorRead, rotateCoupangVisitorCookies,
} from '../lib/coupang-visitor-context.mjs';

const ORIGIN = 'https://www.coupang.com';
const PATH = '/vm/mlp/v1/newweb/mlp-widget-landing';
const REFERER = `${ORIGIN}/mlp/web/mlp-landing-page?landingId=3712&sourceType=gm_crm_goldbox&subSourceType=gm_crm_gwsrtcut`;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_CATALOG_ROWS = 1000;
const PAGE_DELAY_MS = 1000;

export class CoupangGoldboxWidgetError extends Error {
  constructor(code, receipt = null) {
    super(code);
    this.name = 'CoupangGoldboxWidgetError';
    this.code = code;
    this.receipt = receipt;
  }
}

const fail = (code, receipt = null) => { throw new CoupangGoldboxWidgetError(code, receipt); };

function positiveId(value) {
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

function cleanText(value, max = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) || null : null;
}

function won(value) {
  if (typeof value !== 'string' || value.length > 48) return null;
  const match = /^\s*([1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)\s*원\s*$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1].replaceAll(',', ''));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function safePublicImage(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    // the widget sends http:// CDN URLs (observed 2026-10-11); the same paths serve over https
    if (url.protocol === 'http:' && url.hostname.endsWith('.coupangcdn.com')) url.protocol = 'https:';
    return url.protocol === 'https:' && ['image.coupangcdn.com', 'thumbnail.coupangcdn.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.hash ? url.href : null;
  } catch { return null; }
}

function keyOf(ids) { return `${ids.productId}:${ids.itemId}:${ids.vendorItemId}`; }

function normalizeRequestedIds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const productId = positiveId(value.productId), itemId = positiveId(value.itemId), vendorItemId = positiveId(value.vendorItemId);
  return productId && itemId && vendorItemId ? { productId, itemId, vendorItemId } : null;
}

export function normalizeCoupangGoldboxWidgetRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const ids = normalizeRequestedIds(row);
  if (!ids) return null;

  const finalPriceText = cleanText(row.finalPrice?.value, 48);
  const finalPriceAmount = won(finalPriceText);
  const originalPriceText = cleanText(row.originalPrice, 48);
  const originalPriceAmount = won(originalPriceText);
  const hasWowPriceField = Object.hasOwn(row, 'wowPrice');
  const rawWowPrice = row.wowPrice && typeof row.wowPrice === 'object' && !Array.isArray(row.wowPrice) ? row.wowPrice : null;
  const wowPriceText = cleanText(rawWowPrice?.price, 48);
  const wowPriceAmount = won(wowPriceText);
  const wowPriceLabel = cleanText(rawWowPrice?.label, 80);
  const advertisedPriceReadStatus = !hasWowPriceField ? 'absent'
    : rawWowPrice && wowPriceLabel && wowPriceAmount !== null ? 'valid' : 'invalid';
  const isConditionalCoupon = wowPriceLabel === '가입 쿠폰가';
  const wowPrice = advertisedPriceReadStatus !== 'valid' ? null : {
    amount: wowPriceAmount,
    currency: 'KRW',
    basis: 'widget_wow_price_field',
    source: 'coupang_mlp_goldbox_widget',
    label: wowPriceLabel,
    boxEnabled: typeof rawWowPrice?.boxEnabled === 'boolean' ? rawWowPrice.boxEnabled : null,
    iconUrl: safePublicImage(rawWowPrice?.iconUrl),
    dimmed: typeof rawWowPrice?.dimmed === 'boolean' ? rawWowPrice.dimmed : null,
    conditional: isConditionalCoupon,
    eligibilityVerified: false,
  };
  const generalPrice = finalPriceAmount === null ? null : {
    amount: finalPriceAmount, currency: 'KRW', text: finalPriceText,
    unitPriceText: cleanText(row.finalPrice?.unitPriceText, 120),
    source: 'coupang_mlp_goldbox_widget', basis: 'widget_final_price_field',
  };
  const originalPrice = originalPriceAmount === null ? null : {
    amount: originalPriceAmount, currency: 'KRW', text: originalPriceText,
    source: 'coupang_mlp_goldbox_widget', basis: 'widget_original_price_field',
  };

  return {
    ...ids,
    productTitle: cleanText(row.productTitle, 500),
    generalPrice,
    originalPrice,
    advertisedWowPrice: wowPrice,
    advertisedPriceReadStatus,
    wowSalePrice: advertisedPriceReadStatus === 'valid' && wowPriceLabel === '할인가' ? wowPriceAmount : null,
    conditionalCouponPrice: advertisedPriceReadStatus === 'valid' && isConditionalCoupon ? wowPrice : null,
    memberPriceVerified: false,
  };
}

function catalogProductUrl(row, ids) {
  const value = row?.detailUrl;
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n\0]/.test(value))
    return { productUrl: null, productUrlStatus: 'missing_or_invalid_detail_url' };
  let url;
  try { url = new URL(value, ORIGIN); }
  catch { return { productUrl: null, productUrlStatus: 'invalid_detail_url' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
    return { productUrl: null, productUrlStatus: 'invalid_detail_url' };
  if (url.hostname === 'trip.coupang.com')
    return { productUrl: null, productUrlStatus: 'tracking_redirect_unresolved' };
  if (url.origin !== 'https://www.coupang.com')
    return { productUrl: null, productUrlStatus: 'untrusted_detail_url_host' };
  if (url.pathname !== `/vp/products/${ids.productId}`
    || url.searchParams.getAll('itemId').length !== 1
    || url.searchParams.getAll('vendorItemId').length !== 1
    || url.searchParams.get('itemId') !== ids.itemId
    || url.searchParams.get('vendorItemId') !== ids.vendorItemId)
    return { productUrl: null, productUrlStatus: 'detail_url_identity_mismatch' };
  const canonical = new URL(`/vp/products/${ids.productId}`, ORIGIN);
  canonical.searchParams.set('itemId', ids.itemId);
  canonical.searchParams.set('vendorItemId', ids.vendorItemId);
  return { productUrl: canonical.href, productUrlStatus: 'verified_consumer_url' };
}

export function normalizeCoupangGoldboxCatalogRow(row) {
  const ids = normalizeRequestedIds(row);
  if (!ids) return null;
  const prices = normalizeCoupangGoldboxWidgetRow(row);
  if (!prices) return null;
  const soldOut = typeof row?.stockRemainingInfo?.isSoldOut === 'boolean'
    ? row.stockRemainingInfo.isSoldOut : null;
  return {
    ...prices,
    productTitle: cleanText(row.productTitle, 500),
    ...catalogProductUrl(row, ids),
    imageUrl: safePublicImage(row.productImageUrl),
    soldOut,
  };
}

function initialTarget() {
  const url = new URL(PATH, ORIGIN);
  for (const [key, value] of [
    ['widgetId', '43145'], ['isAsync', 'Y'], ['trafficType', 'organic'], ['landingId', '3712'],
    ['target', 'MLP_GOLDBOX'], ['productOffset', '0'], ['sourceType', 'gm_crm_goldbox'],
    ['isMLP', 'Y'], ['nextWidgetPageKey', '1'], ['categoryId', '0'], ['subSourceType', 'gm_crm_gwsrtcut'],
  ]) url.searchParams.set(key, value);
  return url;
}

function scopedTarget(value, base = `${ORIGIN}${PATH}`) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\r\n\0]/.test(value))
    fail('COUPANG_GOLDBOX_WIDGET_NEXT_URL');
  let url;
  try { url = new URL(value, base); } catch { fail('COUPANG_GOLDBOX_WIDGET_NEXT_URL'); }
  if (url.origin !== ORIGIN || url.pathname !== PATH || url.protocol !== 'https:' || url.username || url.password
    || url.port || url.hash) fail('COUPANG_GOLDBOX_WIDGET_NEXT_URL');
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) fail('COUPANG_GOLDBOX_WIDGET_NEXT_URL');
  return url;
}

function safeTargetReceipt(url) {
  return { origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()] };
}

async function boundedBytes(response) {
  if (!response.body) fail('COUPANG_GOLDBOX_WIDGET_BODY_MISSING');
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0, complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('COUPANG_GOLDBOX_WIDGET_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    if (error instanceof CoupangGoldboxWidgetError) throw error;
    fail('COUPANG_GOLDBOX_WIDGET_BODY_FAILED');
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes);
  return { body, bytes, sha256: createHash('sha256').update(body).digest('hex') };
}

function findProductWidget(payload) {
  const widgets = payload?.rData?.widgets;
  if (!Array.isArray(widgets) || widgets.length > 100) fail('COUPANG_GOLDBOX_WIDGET_SCHEMA');
  const found = widgets.filter(widget => widget?.type === 'product'
    && widget?.props?.config?.id === '43145' && widget?.props?.config?.pageId === 3712);
  if (found.length !== 1) fail(found.length ? 'COUPANG_GOLDBOX_WIDGET_AMBIGUOUS' : 'COUPANG_GOLDBOX_WIDGET_NOT_FOUND');
  const list = found[0]?.props?.data?.list;
  if (!Array.isArray(list) || list.length > 500) fail('COUPANG_GOLDBOX_WIDGET_LIST_SCHEMA');
  const dataUrl = found[0]?.props?.data?.dataUrl;
  if (dataUrl !== undefined && dataUrl !== null && (typeof dataUrl !== 'string' || dataUrl.length > 8192))
    fail('COUPANG_GOLDBOX_WIDGET_NEXT_URL');
  return { list, dataUrl: typeof dataUrl === 'string' && dataUrl.length > 0 ? dataUrl : null };
}

function sameNormalized(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const delay = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Read the observed public Goldbox product widget with an HTTP-issued visitor context.
 * Pagination follows only `props.data.dataUrl` returned by the selected product widget.
 */
export async function fetchCoupangGoldboxWidgetPrices({
  productKeys, catalog = false, fetchImpl = globalThis.fetch, context = null, maxPages = MAX_PAGES, pageDelayMs = PAGE_DELAY_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') fail('COUPANG_GOLDBOX_WIDGET_INPUT');
  if (typeof catalog !== 'boolean' || (catalog
    ? productKeys !== undefined && (!Array.isArray(productKeys) || productKeys.length !== 0)
    : !Array.isArray(productKeys) || productKeys.length > 1000)
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES
    || !Number.isSafeInteger(pageDelayMs) || pageDelayMs < 0 || pageDelayMs > 10000)
    fail('COUPANG_GOLDBOX_WIDGET_INPUT');
  const requested = new Map();
  for (const row of productKeys ?? []) {
    const ids = normalizeRequestedIds(row);
    if (!ids) fail('COUPANG_GOLDBOX_WIDGET_INPUT');
    const key = keyOf(ids);
    if (requested.has(key)) fail('COUPANG_GOLDBOX_WIDGET_DUPLICATE_INPUT');
    requested.set(key, ids);
  }
  const liveContext = context ?? createCoupangVisitorContext({ fetchImpl });
  const prices = new Map(), conflicts = new Set(), seenTargets = new Set(), visitorBootstraps = [], pages = [];
  const catalogRows = new Map(), catalogKeys = new Set(), catalogConflicts = new Set();
  const catalogInvalidAdvertisedPriceKeys = new Set(), catalogUnclassifiedAdvertisedPriceKeys = new Set();
  let catalogDuplicateRows = 0, catalogInvalidIdentityRows = 0, catalogMalformedRows = 0, catalogRowCapReached = false;
  const wantedProducts = new Set([...requested.values()].map(row => row.productId));
  let target = initialTarget();
  let stopReason = catalog ? null : requested.size === 0 ? 'no_candidates' : null;
  let paginationExhausted = false;
  let pageRowsSeen = 0, malformedRows = 0, exactSkuMismatchesExcluded = 0;
  const failRead = (code, receipt) => {
    const result = receipt && typeof receipt === 'object' ? receipt : {};
    const partialRows = catalog ? [...catalogRows.values()]
      : [...prices.entries()].filter(([key]) => !conflicts.has(key)).map(([, row]) => row);
    if (catalog) result.catalogMode = true;
    result.execution ??= 'pure_http';
    result.browserUsed ??= false;
    result.ownerCredentialUsed ??= false;
    result.credentialPropagated ??= false;
    result.visitorValuesPersisted ??= false;
    result.visitorCookiesSent ??= pages.some(page => page.visitorCookiesSent);
    result.retries ??= 0;
    result.retry ??= false;
    if (result.coverage && typeof result.coverage === 'object' && catalog) {
      result.coverage.catalogPageRowsSeen ??= pageRowsSeen;
      result.coverage.catalogUniqueTriples ??= catalogKeys.size;
      result.coverage.catalogReturnedRows ??= catalogRows.size;
      result.coverage.catalogDuplicateRows ??= catalogDuplicateRows;
      result.coverage.catalogConflictingTriples ??= catalogConflicts.size;
      result.coverage.catalogExcludedTriples ??= catalogConflicts.size;
      result.coverage.invalidIdentityRows ??= catalogInvalidIdentityRows;
      result.coverage.malformedRows ??= catalogMalformedRows;
      result.coverage.rowsMissingTitle ??= catalogRows.size
        ? [...catalogRows.values()].filter(row => !row.productTitle).length : 0;
      result.coverage.rowsWithoutProductUrl ??= catalogRows.size
        ? [...catalogRows.values()].filter(row => !row.productUrl).length : 0;
      result.coverage.trackingRedirectUrlRows ??= catalogRows.size
        ? [...catalogRows.values()].filter(row => row.productUrlStatus === 'tracking_redirect_unresolved').length : 0;
      result.coverage.rowsWithGeneralPrice ??= catalogRows.size
        ? [...catalogRows.values()].filter(row => row.generalPrice !== null).length : 0;
      result.coverage.rowsWithAdvertisedWowPrice ??= catalogRows.size
        ? [...catalogRows.values()].filter(row => row.advertisedWowPrice !== null).length : 0;
      result.coverage.rowsWithUnconditionalWowPrice ??= catalogRows.size
        ? [...catalogRows.values()].filter(row => row.wowSalePrice !== null).length : 0;
      result.coverage.rowsWithConditionalCouponPrice ??= catalogRows.size
        ? [...catalogRows.values()].filter(row => row.conditionalCouponPrice !== null).length : 0;
      result.coverage.invalidAdvertisedPriceRows ??= catalogInvalidAdvertisedPriceKeys.size;
      result.coverage.unclassifiedAdvertisedPriceRows ??= catalogUnclassifiedAdvertisedPriceKeys.size;
      result.coverage.catalogScanComplete = paginationExhausted;
      result.coverage.catalogRowsComplete = false;
      result.coverage.catalogPriceCoverageComplete = false;
      result.coverage.catalogSpecialPriceClassificationComplete = false;
      result.coverage.catalogCoverageComplete = false;
    } else if (result.coverage && typeof result.coverage === 'object') {
      result.coverage.requestedTriples ??= requested.size;
      result.coverage.matchedTriples ??= prices.size;
      result.coverage.unmatchedTriples ??= Math.max(0, requested.size - prices.size);
      result.coverage.explicitWowPriceRows ??= partialRows.filter(row => row.advertisedWowPrice !== null).length;
      result.coverage.ordinaryWowPriceRows ??= partialRows.filter(row => row.wowSalePrice !== null).length;
      result.coverage.conditionalCouponRows ??= partialRows.filter(row => row.conditionalCouponPrice !== null).length;
      result.coverage.candidateCoverageComplete = prices.size === requested.size;
      result.coverage.catalogScanComplete = paginationExhausted;
    }
    result.states ??= {
      captured: true,
      client_exists: true,
      remnant_free: true,
      credential_propagated: false,
      live_replay: false,
    };
    const error = new CoupangGoldboxWidgetError(code, result);
    error.partialRows = partialRows;
    throw error;
  };

  for (let pageIndex = 0; (catalog || requested.size > 0) && pageIndex < maxPages; pageIndex++) {
    const fingerprint = createHash('sha256').update(target.href).digest('hex');
    if (seenTargets.has(fingerprint)) { stopReason = 'pagination_cycle'; break; }
    seenTargets.add(fingerprint);
    let prepared;
    try {
      prepared = await prepareCoupangVisitorRead({ context: liveContext, target: target.href,
        operation: 'goldbox_widget_page', fetchImpl });
    } catch (error) {
      const safe = { status: null, origin: ORIGIN, path: PATH, queryKeys: [...target.searchParams.keys()], retry: false };
      if (error instanceof CoupangVisitorError) {
        safe.errorCode = error.code;
        if (error.receipt?.status != null) safe.bootstrapStatus = error.receipt.status;
        if (error.receipt?.cookieNames) safe.bootstrapCookieNames = error.receipt.cookieNames;
        safe.bootstrapTransport = error.receipt?.transport ?? null;
        if (error.receipt?.operation === 'public_visitor_bootstrap') visitorBootstraps.push({
          status: error.receipt.status ?? null,
          contentType: error.receipt.contentType ?? null,
          bytes: error.receipt.bytes ?? null,
          responseSha256: error.receipt.responseSha256 ?? null,
          cookieNames: error.receipt.cookieNames ?? [],
          transport: error.receipt.transport ?? null,
          errorCode: error.code,
          ownerCredentialUsed: false,
          valuesPersisted: false,
        });
      }
      const code = error instanceof CoupangVisitorError && error.code === 'COUPANG_VISITOR_OPERATION_SCOPE' && pageIndex > 0
        ? 'COUPANG_GOLDBOX_WIDGET_NEXT_URL'
        : error instanceof CoupangVisitorError ? error.code : 'COUPANG_GOLDBOX_WIDGET_VISITOR_INPUT';
      failRead(code, {
        status: 'partial', operation: 'goldbox_widget_read', pages, visitorBootstraps,
        pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded },
        retry: false, failedPage: safe,
      });
    }
    if (prepared.bootstrapReceipt) visitorBootstraps.push({ status: prepared.bootstrapReceipt.status,
      bytes: prepared.bootstrapReceipt.bytes ?? null, responseSha256: prepared.bootstrapReceipt.responseSha256 ?? null,
      cookieNames: prepared.bootstrapReceipt.cookieNames ?? [], transport: prepared.bootstrapReceipt.transport,
      ownerCredentialUsed: false, valuesPersisted: false });

    const pageReceipt = { pageIndex: pageIndex + 1, ...safeTargetReceipt(target), method: 'GET', status: null,
      contentType: null, bytes: null, responseSha256: null, server: null,
      visitorCookieNames: prepared.cookieNames, visitorCookiesSent: true, visitorValuesPersisted: false,
      ownerCredentialUsed: false, redirectsFollowed: false, retry: false };
    let response;
    try {
      response = await fetchImpl(target.href, { method: 'GET', credentials: 'omit', redirect: 'manual',
        signal: AbortSignal.timeout(20000), headers: {
          accept: 'application/json, text/plain, */*',
          'x-coupang-accept-language': 'ko-KR',
          'coupang-app': '',
          'modular-front': '',
          referer: REFERER,
          cookie: prepared.cookie,
        } });
    } catch {
      pageReceipt.errorCode = 'COUPANG_GOLDBOX_WIDGET_TRANSPORT';
      pages.push(pageReceipt);
      failRead('COUPANG_GOLDBOX_WIDGET_TRANSPORT', { status: 'partial', operation: 'goldbox_widget_read',
        pages, visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
    }
    pageReceipt.status = response.status;
    pageReceipt.contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    pageReceipt.server = response.headers.get('server') ?? null;
    const actualUrl = response.url;
    if (response.redirected || response.status >= 300 && response.status < 400
      || actualUrl && actualUrl !== target.href) {
      pageReceipt.errorCode = 'COUPANG_GOLDBOX_WIDGET_REDIRECT';
      await response.body?.cancel().catch(() => {});
      pages.push(pageReceipt);
      failRead(pageReceipt.errorCode, { status: 'partial', operation: 'goldbox_widget_read', pages,
        visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
    }
    if (response.status !== 200) {
      pageReceipt.errorCode = response.status === 429 ? 'COUPANG_GOLDBOX_WIDGET_RATE_LIMITED'
        : response.status === 403 ? 'COUPANG_GOLDBOX_WIDGET_ACCESS_BLOCKED' : 'COUPANG_GOLDBOX_WIDGET_HTTP_STATUS';
      await response.body?.cancel().catch(() => {});
      pages.push(pageReceipt);
      failRead(pageReceipt.errorCode, { status: 'partial', operation: 'goldbox_widget_read', pages,
        visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        httpStatus: response.status, coverage: { requestedTriples: requested.size, matchedTriples: prices.size,
          pageRowsSeen, malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
    }
    if (typeof response.headers.getSetCookie === 'function') {
      try { rotateCoupangVisitorCookies(liveContext, response.headers.getSetCookie(), target.href, 'goldbox_widget_page'); }
      catch (error) {
        pageReceipt.errorCode = error instanceof CoupangVisitorError ? error.code : 'COUPANG_GOLDBOX_WIDGET_COOKIE_ROTATION';
        await response.body?.cancel().catch(() => {});
        pages.push(pageReceipt);
        failRead('COUPANG_GOLDBOX_WIDGET_COOKIE_ROTATION', { status: 'partial', operation: 'goldbox_widget_read',
          pages, visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
          requestCount: pages.length + visitorBootstraps.length,
          coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
            malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
      }
    }
    if (pageReceipt.contentType !== 'application/json') {
      pageReceipt.errorCode = 'COUPANG_GOLDBOX_WIDGET_CONTENT_TYPE';
      await response.body?.cancel().catch(() => {});
      pages.push(pageReceipt);
      failRead(pageReceipt.errorCode, { status: 'partial', operation: 'goldbox_widget_read', pages,
        visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
    }

    let bytes;
    try { bytes = await boundedBytes(response); }
    catch (error) {
      pageReceipt.errorCode = error instanceof CoupangGoldboxWidgetError ? error.code : 'COUPANG_GOLDBOX_WIDGET_BODY_FAILED';
      pages.push(pageReceipt);
      failRead(pageReceipt.errorCode, { status: 'partial', operation: 'goldbox_widget_read', pages,
        visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
    }
    pageReceipt.bytes = bytes.bytes;
    pageReceipt.responseSha256 = bytes.sha256;
    let payload;
    try { payload = JSON.parse(bytes.body.toString('utf8')); }
    catch {
      pageReceipt.errorCode = 'COUPANG_GOLDBOX_WIDGET_JSON';
      pages.push(pageReceipt);
      failRead(pageReceipt.errorCode, { status: 'partial', operation: 'goldbox_widget_read', pages,
        visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
    }
    if (payload?.rCode !== 'RET0000') {
      pageReceipt.errorCode = 'COUPANG_GOLDBOX_WIDGET_APPLICATION';
      pages.push(pageReceipt);
      failRead(pageReceipt.errorCode, { status: 'partial', operation: 'goldbox_widget_read', pages,
        visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        applicationCode: cleanText(payload?.rCode, 40), coverage: { requestedTriples: requested.size,
          matchedTriples: prices.size, pageRowsSeen, malformedRows, exactSkuMismatchesExcluded },
        retry: false, failedPage: pageReceipt });
    }

    let widgetPage;
    try { widgetPage = findProductWidget(payload); }
    catch (error) {
      pageReceipt.errorCode = error instanceof CoupangGoldboxWidgetError ? error.code : 'COUPANG_GOLDBOX_WIDGET_SCHEMA';
      pages.push(pageReceipt);
      failRead(pageReceipt.errorCode, { status: 'partial', operation: 'goldbox_widget_read', pages,
        visitorBootstraps, pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded }, retry: false, failedPage: pageReceipt });
    }

    pageReceipt.widgetType = 'product';
    pageReceipt.widgetId = '43145';
    pageReceipt.pageId = 3712;
    pageReceipt.rowCount = widgetPage.list.length;
    if (catalog) pageReceipt.nextPagePresent = widgetPage.dataUrl !== null;
    pageRowsSeen += widgetPage.list.length;
    if (catalog) {
      for (const row of widgetPage.list) {
        const ids = normalizeRequestedIds(row);
        if (!ids) { catalogInvalidIdentityRows++; continue; }
        const key = keyOf(ids);
        if (catalogKeys.has(key)) catalogDuplicateRows++;
        else {
          if (catalogKeys.size >= MAX_CATALOG_ROWS) { catalogRowCapReached = true; break; }
          catalogKeys.add(key);
        }
        const normalized = normalizeCoupangGoldboxCatalogRow(row);
        if (!normalized) { catalogMalformedRows++; continue; }
        if (normalized.advertisedPriceReadStatus === 'invalid') catalogInvalidAdvertisedPriceKeys.add(key);
        if (normalized.advertisedPriceReadStatus === 'valid'
          && !['할인가', '가입 쿠폰가'].includes(normalized.advertisedWowPrice?.label))
          catalogUnclassifiedAdvertisedPriceKeys.add(key);
        if (catalogConflicts.has(key)) continue;
        if (catalogRows.has(key)) {
          if (!sameNormalized(catalogRows.get(key), normalized)) {
            catalogConflicts.add(key);
            catalogRows.delete(key);
          }
        } else catalogRows.set(key, normalized);
      }
    } else {
      for (const row of widgetPage.list) {
        const ids = normalizeRequestedIds(row);
        if (!ids) { malformedRows++; continue; }
        const key = keyOf(ids);
        if (!requested.has(key)) {
          if (wantedProducts.has(ids.productId)) exactSkuMismatchesExcluded++;
          continue;
        }
        const normalized = normalizeCoupangGoldboxWidgetRow(row);
        if (!normalized) { malformedRows++; continue; }
        if (prices.has(key)) {
          if (!sameNormalized(prices.get(key), normalized)) conflicts.add(key);
        } else prices.set(key, normalized);
      }
    }
    pageReceipt.exactCandidateMatches = catalog ? catalogRows.size : prices.size;
    pages.push(pageReceipt);
    if (catalogRowCapReached) { stopReason = 'catalog_row_cap'; break; }
    if (!catalog && conflicts.size) {
      for (const key of conflicts) prices.delete(key);
      stopReason = 'conflicting_duplicate_rows';
      break;
    }
    if (!catalog && prices.size === requested.size) {
      stopReason = 'all_requested_triples_matched';
      paginationExhausted = widgetPage.dataUrl === null;
      break;
    }
    if (!widgetPage.dataUrl) { paginationExhausted = true; stopReason = 'no_next_url'; break; }
    if (pageIndex + 1 >= maxPages) { stopReason = 'page_cap'; break; }
    try { target = scopedTarget(widgetPage.dataUrl, target.href); }
    catch (error) {
      stopReason = 'invalid_next_url';
      const code = error instanceof CoupangGoldboxWidgetError ? error.code : 'COUPANG_GOLDBOX_WIDGET_NEXT_URL';
      failRead(code, { status: 'partial', operation: 'goldbox_widget_read', pages, visitorBootstraps,
        pageCount: pages.length, visitorBootstrapCount: visitorBootstraps.length,
        requestCount: pages.length + visitorBootstraps.length,
        coverage: { requestedTriples: requested.size, matchedTriples: prices.size, pageRowsSeen,
          malformedRows, exactSkuMismatchesExcluded }, stopReason, retry: false });
    }
    if (pageIndex + 1 < maxPages) await delay(pageDelayMs);
  }

  const matched = [...prices.values()];
  const catalogMatched = [...catalogRows.values()];
  const candidateCoverageComplete = prices.size === requested.size;
  const catalogScanComplete = paginationExhausted;
  const catalogRowsComplete = catalog && catalogScanComplete && !catalogRowCapReached
    && catalogInvalidIdentityRows === 0 && catalogMalformedRows === 0 && catalogConflicts.size === 0;
  const inStockRowsWithoutGeneralPrice = catalogMatched.filter(row => row.soldOut !== true && !row.generalPrice).length;
  const catalogPriceCoverageComplete = catalog && catalogScanComplete && inStockRowsWithoutGeneralPrice === 0;
  const catalogSpecialPriceClassificationComplete = catalog && catalogScanComplete
    && catalogInvalidAdvertisedPriceKeys.size === 0 && catalogUnclassifiedAdvertisedPriceKeys.size === 0;
  const catalogCoverageComplete = catalogRowsComplete && catalogPriceCoverageComplete
    && catalogInvalidAdvertisedPriceKeys.size === 0 && catalogMatched.length > 0;
  const receiptStatus = catalog ? catalogCoverageComplete ? 'complete' : 'partial'
    : candidateCoverageComplete ? 'complete' : 'partial';
  return {
    rows: catalog ? catalogMatched : matched,
    receipt: {
      status: receiptStatus,
      operation: 'goldbox_widget_read',
      ...(catalog ? { catalogMode: true } : {}),
      origin: ORIGIN,
      path: PATH,
      execution: 'pure_http',
      browserUsed: false,
      ownerCredentialUsed: false,
      credentialPropagated: false,
      visitorCookiesSent: pages.some(page => page.visitorCookiesSent),
      visitorValuesPersisted: false,
      retries: 0,
      retry: false,
      pageCount: pages.length,
      requestCount: pages.length + visitorBootstraps.length,
      visitorBootstrapCount: visitorBootstraps.length,
      visitorBootstraps,
      pages,
      stopReason,
      paginationExhausted,
      coverage: {
        ...(catalog ? {
          catalogPageRowsSeen: pageRowsSeen,
          catalogUniqueTriples: catalogKeys.size,
          catalogReturnedRows: catalogMatched.length,
          catalogDuplicateRows,
          catalogConflictingTriples: catalogConflicts.size,
          catalogExcludedTriples: catalogConflicts.size,
          invalidIdentityRows: catalogInvalidIdentityRows,
          malformedRows: catalogMalformedRows,
          rowsMissingTitle: catalogMatched.filter(row => !row.productTitle).length,
          rowsWithoutProductUrl: catalogMatched.filter(row => !row.productUrl).length,
          trackingRedirectUrlRows: catalogMatched.filter(row => row.productUrlStatus === 'tracking_redirect_unresolved').length,
          rowsWithImageUrl: catalogMatched.filter(row => row.imageUrl !== null).length,
          rowsWithGeneralPrice: catalogMatched.filter(row => row.generalPrice !== null).length,
          rowsWithAdvertisedWowPrice: catalogMatched.filter(row => row.advertisedWowPrice !== null).length,
          rowsWithUnconditionalWowPrice: catalogMatched.filter(row => row.wowSalePrice !== null).length,
          rowsWithConditionalCouponPrice: catalogMatched.filter(row => row.conditionalCouponPrice !== null).length,
          invalidAdvertisedPriceRows: catalogInvalidAdvertisedPriceKeys.size,
          unclassifiedAdvertisedPriceRows: catalogUnclassifiedAdvertisedPriceKeys.size,
          inStockRowsWithoutGeneralPrice,
          catalogScanComplete,
          catalogRowsComplete,
          catalogPriceCoverageComplete,
          catalogSpecialPriceClassificationComplete,
          catalogCoverageComplete,
        } : {
          requestedTriples: requested.size,
          matchedTriples: prices.size,
          unmatchedTriples: Math.max(0, requested.size - prices.size),
          explicitWowPriceRows: matched.filter(row => row.advertisedWowPrice !== null).length,
          ordinaryWowPriceRows: matched.filter(row => row.wowSalePrice !== null).length,
          conditionalCouponRows: matched.filter(row => row.conditionalCouponPrice !== null).length,
          exactSkuMismatchesExcluded,
          malformedRows,
          duplicateConflicts: conflicts.size,
          pageRowsSeen,
          candidateCoverageComplete,
          catalogScanComplete,
        }),
      },
      states: {
        captured: true,
        client_exists: true,
        remnant_free: true,
        credential_propagated: false,
        live_replay: fetchImpl === globalThis.fetch && pages.length > 0
          && pages.every(page => page.status === 200 && !page.errorCode),
      },
    },
  };
}
