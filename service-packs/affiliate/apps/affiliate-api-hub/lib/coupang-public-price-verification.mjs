import { createCoupangVisitorContext } from './coupang-visitor-context.mjs';
import { readCoupangConsumerOfferList } from '../adapters/coupang-consumer.mjs';

export const COUPANG_PUBLIC_PRICE_MAX_ITEMS = 200;
export const COUPANG_PUBLIC_PRICE_DEFAULT_SPACING_MS = 20_000;
export const COUPANG_PUBLIC_PRICE_MIN_SPACING_MS = 20_000;
export const COUPANG_PUBLIC_PRICE_MAX_SPACING_MS = 5 * 60_000;
export const COUPANG_PUBLIC_PRICE_MAX_MANIFEST_BYTES = 256 * 1024;

const ID_PATTERN = /^[1-9]\d{0,19}$/;
const SOURCE_KINDS = new Set([
  'browser_dom_option_map',
  'browser_network_read',
  'public_catalog_observation',
  'user_supplied_exact_skus',
]);
const SHIPPING_READ_STATUSES = new Set(['verified', 'absent', 'invalid', 'conditional_unverified']);
const EXPECTED_METADATA_KEYS = ['capturedAt', 'frontierSource'];

export class CoupangPublicPriceVerificationInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CoupangPublicPriceVerificationInputError';
    this.code = code;
  }
}

const fail = code => { throw new CoupangPublicPriceVerificationInputError(code); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, allowed, required, code) => {
  if (!isRecord(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
};
const validId = value => typeof value === 'string' && ID_PATTERN.test(value);
const validPositivePrice = value => Number.isSafeInteger(value) && value > 0;

function validateCapturedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateProductUrl(item) {
  const { productUrl, productId, itemId, vendorItemId } = item;
  if (typeof productUrl !== 'string' || !validId(productId) || !validId(itemId) || !validId(vendorItemId)) return false;
  const expected = `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`;
  if (productUrl !== expected) return false;
  let url;
  try { url = new URL(productUrl); } catch { return false; }
  return url.protocol === 'https:' && url.origin === 'https://www.coupang.com'
    && url.pathname === `/vp/products/${productId}` && url.search === `?itemId=${itemId}&vendorItemId=${vendorItemId}`
    && !url.username && !url.password && !url.port && !url.hash
    && [...url.searchParams.keys()].join(',') === 'itemId,vendorItemId'
    && url.searchParams.getAll('itemId').length === 1 && url.searchParams.get('itemId') === itemId
    && url.searchParams.getAll('vendorItemId').length === 1 && url.searchParams.get('vendorItemId') === vendorItemId;
}

export function validateCoupangPublicPriceManifest(manifest) {
  exactKeys(manifest, ['schemaVersion', 'sourceMetadata', 'items'],
    ['schemaVersion', 'sourceMetadata', 'items'], 'MANIFEST_SCHEMA');
  if (manifest.schemaVersion !== 1) fail('MANIFEST_SCHEMA_VERSION');

  const metadata = manifest.sourceMetadata;
  exactKeys(metadata, EXPECTED_METADATA_KEYS, ['frontierSource'], 'SOURCE_METADATA_SCHEMA');
  if (!SOURCE_KINDS.has(metadata.frontierSource)
    || Object.hasOwn(metadata, 'capturedAt') && !validateCapturedAt(metadata.capturedAt))
    fail('SOURCE_METADATA_INVALID');

  if (!Array.isArray(manifest.items) || manifest.items.length === 0) fail('FRONTIER_EMPTY');
  if (manifest.items.length > COUPANG_PUBLIC_PRICE_MAX_ITEMS) fail('FRONTIER_TOO_LARGE');

  const triples = new Set();
  const items = manifest.items.map(item => {
    exactKeys(item, ['productUrl', 'productId', 'itemId', 'vendorItemId', 'expectedGeneralPriceKrw'],
      ['productUrl', 'productId', 'itemId', 'vendorItemId'], 'SKU_SCHEMA');
    if (!validateProductUrl(item)) fail('SKU_URL_SCOPE');
    if (Object.hasOwn(item, 'expectedGeneralPriceKrw') && !validPositivePrice(item.expectedGeneralPriceKrw))
      fail('EXPECTED_PRICE_INVALID');
    const identityKey = `${item.productId}:${item.itemId}:${item.vendorItemId}`;
    if (triples.has(identityKey)) fail('DUPLICATE_SKU');
    triples.add(identityKey);
    return {
      productUrl: item.productUrl,
      productId: item.productId,
      itemId: item.itemId,
      vendorItemId: item.vendorItemId,
      ...(Object.hasOwn(item, 'expectedGeneralPriceKrw')
        ? { expectedGeneralPriceKrw: item.expectedGeneralPriceKrw } : {}),
    };
  });

  return {
    schemaVersion: 1,
    sourceMetadata: {
      frontierSource: metadata.frontierSource,
      ...(Object.hasOwn(metadata, 'capturedAt') ? { capturedAt: metadata.capturedAt } : {}),
    },
    items,
  };
}

export function parseCoupangPublicPriceManifestJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > COUPANG_PUBLIC_PRICE_MAX_MANIFEST_BYTES)
    fail('MANIFEST_TOO_LARGE');
  let manifest;
  try { manifest = JSON.parse(text); } catch { fail('MANIFEST_JSON_INVALID'); }
  return validateCoupangPublicPriceManifest(manifest);
}

export function validateCoupangPublicPriceSpacing(spacingMs = COUPANG_PUBLIC_PRICE_DEFAULT_SPACING_MS) {
  if (!Number.isSafeInteger(spacingMs) || spacingMs < COUPANG_PUBLIC_PRICE_MIN_SPACING_MS
    || spacingMs > COUPANG_PUBLIC_PRICE_MAX_SPACING_MS) fail('SPACING_OUT_OF_RANGE');
  return spacingMs;
}

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const safeHttpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

function errorDetails(error) {
  const receipt = error?.receipt && typeof error.receipt === 'object' ? error.receipt : null;
  const bootstrapReceipt = receipt?.visitorBootstrap && typeof receipt.visitorBootstrap === 'object'
    ? receipt.visitorBootstrap : null;
  const directStatus = safeHttpStatus(receipt?.status) ?? safeHttpStatus(error?.httpStatus)
    ?? safeHttpStatus(error?.status);
  const bootstrapStatus = safeHttpStatus(bootstrapReceipt?.status);
  const httpStatus = directStatus ?? bootstrapStatus;
  const code = typeof error?.code === 'string' ? error.code : '';
  let status = 'read_error';
  if (httpStatus === 429 || code === 'COUPANG_CONSUMER_RATE_LIMITED' || code === 'COUPANG_VISITOR_RATE_LIMITED')
    status = 'rate_limited';
  else if (httpStatus === 403 || httpStatus === 401 || httpStatus === 418
    || code === 'COUPANG_CONSUMER_ACCESS_BLOCKED') status = httpStatus === 403 ? 'blocked_403' : 'blocked_http';
  return {
    status,
    httpStatus,
    bootstrapBlocked: directStatus === null && bootstrapStatus !== null && bootstrapStatus >= 400,
    nativeResponseObserved: receipt?.transport === 'native_fetch' && (directStatus !== null || bootstrapStatus !== null),
    nativeOfferReadObserved: receipt?.transport === 'native_fetch' && safeHttpStatus(receipt?.status) !== null,
  };
}

function responseDetails(result) {
  const receipt = result?.receipt && typeof result.receipt === 'object' ? result.receipt : null;
  const offerListStatus = safeHttpStatus(receipt?.status);
  const bootstrapStatus = safeHttpStatus(receipt?.visitorBootstrap?.status);
  const httpStatus = offerListStatus ?? bootstrapStatus;
  const nativeResponseObserved = receipt?.transport === 'native_fetch' && httpStatus !== null;
  const nativeOfferReadObserved = receipt?.transport === 'native_fetch' && offerListStatus !== null;
  return { receipt, httpStatus, offerListStatus, nativeResponseObserved, nativeOfferReadObserved };
}

function shippingReadStatus(selectedOffer) {
  const status = selectedOffer?.shippingReadStatus;
  return SHIPPING_READ_STATUSES.has(status) ? status : 'unknown';
}

function baseRow(item, index) {
  return {
    index,
    productId: item.productId,
    itemId: item.itemId,
    vendorItemId: item.vendorItemId,
    expectedGeneralPriceKrw: item.expectedGeneralPriceKrw,
    attempted: false,
    status: 'unattempted',
    httpStatus: null,
    selectedIdentityMatched: false,
    observedGeneralPriceKrw: null,
    expectedPriceMatched: null,
    priceVerified: false,
    shippingReadStatus: 'unknown',
  };
}

function parseSuccessfulRead(item, result, row) {
  const details = responseDetails(result);
  if (details.offerListStatus !== 200) {
    row.httpStatus = details.httpStatus;
    if (details.httpStatus === 429) row.status = 'rate_limited';
    else if (details.httpStatus === 403) row.status = 'blocked_403';
    else if (details.httpStatus !== null) row.status = 'blocked_http';
    else row.status = 'read_error';
    return { nativeResponseObserved: details.nativeResponseObserved,
      nativeOfferReadObserved: details.nativeOfferReadObserved,
      stop: details.httpStatus === 429 || details.httpStatus === 403
        || details.httpStatus === 401 || details.httpStatus === 418,
      haltReason: details.httpStatus === 429 ? 'rate_limited'
        : details.httpStatus === 403 || details.httpStatus === 401 || details.httpStatus === 418 ? 'access_blocked' : null };
  }

  const selected = result?.selectedOffer;
  const identityMatches = result?.productId === item.productId && result?.itemId === item.itemId
    && result?.selectedVendorItemId === item.vendorItemId && selected?.selected === true
    && selected?.productId === item.productId && selected?.itemId === item.itemId
    && selected?.vendorItemId === item.vendorItemId;
  row.httpStatus = 200;
  if (!identityMatches) {
    row.status = 'identity_mismatch';
    return { nativeResponseObserved: details.nativeResponseObserved,
      nativeOfferReadObserved: details.nativeOfferReadObserved, stop: false, haltReason: null };
  }
  row.selectedIdentityMatched = true;
  row.shippingReadStatus = shippingReadStatus(selected);
  const price = selected?.price;
  if (!price || price.currency !== 'KRW' || !validPositivePrice(price.amount)
    || price.priceKind !== 'offer_list_general_sale_price' || price.basis !== 'public_offer_list') {
    row.status = 'invalid_price';
    return { nativeResponseObserved: details.nativeResponseObserved,
      nativeOfferReadObserved: details.nativeOfferReadObserved, stop: false, haltReason: null };
  }

  row.observedGeneralPriceKrw = price.amount;
  row.expectedPriceMatched = item.expectedGeneralPriceKrw === null
    ? null : item.expectedGeneralPriceKrw === price.amount;
  if (item.expectedGeneralPriceKrw !== null && row.expectedPriceMatched === false) {
    row.status = 'expected_price_mismatch';
    return { nativeResponseObserved: details.nativeResponseObserved,
      nativeOfferReadObserved: details.nativeOfferReadObserved, stop: false, haltReason: null };
  }
  if (!details.nativeResponseObserved || details.receipt?.transport !== 'native_fetch') {
    row.status = 'non_native_transport';
    return { nativeResponseObserved: details.nativeResponseObserved,
      nativeOfferReadObserved: details.nativeOfferReadObserved, stop: false, haltReason: null };
  }
  row.status = 'verified';
  row.priceVerified = true;
  return { nativeResponseObserved: details.nativeResponseObserved,
    nativeOfferReadObserved: details.nativeOfferReadObserved, stop: false, haltReason: null };
}

function summarize(report) {
  const rows = report.rows;
  const verifiedPriceCount = rows.filter(row => row.priceVerified).length;
  const attemptedCount = rows.filter(row => row.attempted).length;
  const status = verifiedPriceCount === rows.length ? 'complete'
    : verifiedPriceCount === 0 ? 'failed' : 'partial';
  return {
    ...report,
    status,
    passed: status === 'complete',
    attemptedCount,
    verifiedPriceCount,
    unverifiedCount: rows.filter(row => row.attempted && !row.priceVerified).length,
    unattemptedCount: rows.filter(row => !row.attempted).length,
    expectedPriceMismatchCount: rows.filter(row => row.status === 'expected_price_mismatch').length,
    blocked403Count: rows.filter(row => row.status === 'blocked_403').length,
    rateLimitedCount: rows.filter(row => row.status === 'rate_limited').length,
    nativeOfferReadCount: report.nativeOfferReadCount,
  };
}

export async function verifyCoupangPublicPriceFrontier(manifest, {
  live = false,
  spacingMs = COUPANG_PUBLIC_PRICE_DEFAULT_SPACING_MS,
  readOfferList = readCoupangConsumerOfferList,
  sleep = defaultSleep,
  visitorContext = null,
} = {}) {
  const normalized = validateCoupangPublicPriceManifest(manifest);
  const items = normalized.items.map(item => ({
    ...item,
    expectedGeneralPriceKrw: Object.hasOwn(item, 'expectedGeneralPriceKrw') ? item.expectedGeneralPriceKrw : null,
  }));
  const validatedSpacing = validateCoupangPublicPriceSpacing(spacingMs);
  if (typeof live !== 'boolean') fail('LIVE_FLAG_INVALID');
  if (typeof sleep !== 'function' || typeof readOfferList !== 'function') fail('RUNNER_DEPENDENCY_INVALID');

  const base = {
    schemaVersion: 1,
    operation: 'coupang_public_exact_sku_price_batch_verification',
    checkedAt: new Date().toISOString(),
    sourceMetadata: normalized.sourceMetadata,
    providedFrontierCount: normalized.items.length,
    frontierEnumerationComplete: false,
    liveRequested: live === true,
    spacingMs: validatedSpacing,
    spacingPolicy: 'diagnostic_spacing_only',
    retryCount: 0,
    browserUsed: false,
    ownerCredentialUsed: false,
    credentialPropagated: false,
    visitorValuesPersisted: false,
    cookiesPersisted: false,
    rawResponseStored: false,
    rawUrlStored: false,
    allRetailerPricePathsComplete: false,
    nativeResponseObserved: false,
    nativeOfferReadCount: 0,
    rows: items.map(baseRow),
  };

  if (!live) {
    return {
      ...base,
      status: 'validated_only',
      passed: false,
      haltReason: null,
      attemptedCount: 0,
      verifiedPriceCount: 0,
      unverifiedCount: 0,
      unattemptedCount: items.length,
      expectedPriceMismatchCount: 0,
      blocked403Count: 0,
      rateLimitedCount: 0,
      states: { live_replay: false },
    };
  }

  const sharedVisitorContext = visitorContext ?? createCoupangVisitorContext();
  let previousReadAttempted = false;
  let haltReason = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const row = base.rows[index];
    if (previousReadAttempted) {
      try { await sleep(validatedSpacing); }
      catch {
        haltReason = 'pacing_wait_failed';
        break;
      }
    }
    row.attempted = true;
    previousReadAttempted = true;
    let result;
    try {
      result = await readOfferList({ url: item.productUrl, authentication: 'visitor', visitorContext: sharedVisitorContext });
    } catch (error) {
      const details = errorDetails(error);
      row.status = details.status;
      row.httpStatus = details.httpStatus;
      base.nativeResponseObserved ||= details.nativeResponseObserved;
      if (details.nativeOfferReadObserved) base.nativeOfferReadCount += 1;
      if (details.status === 'rate_limited') {
        haltReason = 'rate_limited';
        break;
      }
      if (details.status === 'blocked_403' || details.status === 'blocked_http') {
        haltReason = 'access_blocked';
        break;
      }
      if (details.bootstrapBlocked) {
        haltReason = details.httpStatus === 429 ? 'rate_limited' : 'access_blocked';
        break;
      }
      continue;
    }

    const details = parseSuccessfulRead(item, result, row);
    base.nativeResponseObserved ||= details.nativeResponseObserved;
    if (details.nativeOfferReadObserved) base.nativeOfferReadCount += 1;
    if (details.stop) {
      haltReason = details.haltReason;
      break;
    }
  }

  const report = summarize({ ...base, haltReason });
  report.states = { live_replay: report.verifiedPriceCount > 0 };
  return report;
}
