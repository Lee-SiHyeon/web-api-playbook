import { readCoupangConsumerWowPrice } from '../adapters/coupang-wow-prices.mjs';
import { projectCoupangReadProof } from './coupang-read-proof.mjs';

const ID_PATTERN = /^[1-9]\d{0,19}$/;
const WOW_READ_STATUSES = new Set([
  'verified_advertised_wow_price',
  'absent',
  'invalid',
  'conditional_unverified',
  'not_exposed_by_public_offer_list',
  'parsed_account_wow_price',
  'no_wow_discount_in_account_response',
  'unverified_account_wow_price',
  'account_wow_price_blocked',
  'account_general_price_mismatch',
  'account_general_price_unverified',
  'public_general_fallback_unverified',
]);
const SAFE_ERROR_CODES = new Set([
  'COUPANG_CONSUMER_ACCESS_BLOCKED',
  'COUPANG_CONSUMER_CHALLENGE',
  'COUPANG_CONSUMER_CONTENT_TYPE',
  'COUPANG_CONSUMER_HTTP_REJECTED',
  'COUPANG_CONSUMER_OFFER_LIST_AUTH_SCOPE',
  'COUPANG_CONSUMER_OFFER_LIST_IDENTITY',
  'COUPANG_CONSUMER_OFFER_LIST_JSON',
  'COUPANG_CONSUMER_OFFER_LIST_PRICE',
  'COUPANG_CONSUMER_OFFER_LIST_SCHEMA',
  'COUPANG_CONSUMER_RATE_LIMITED',
  'COUPANG_CONSUMER_RESPONSE_SIZE',
  'COUPANG_CONSUMER_REAUTH_REQUIRED',
  'COUPANG_CONSUMER_TRANSPORT',
  'COUPANG_WOW_PRICE_IDENTITY',
  'COUPANG_VISITOR_BOOTSTRAP_FAILED',
  'COUPANG_VISITOR_RATE_LIMITED',
]);
const SAFE_ACCOUNT_CONTEXT_CODES = new Set([
  'SESSION_ACCESS_TOKEN_EXPIRED',
  'SESSION_BUSY',
  'SESSION_COOKIE_LIMIT',
  'SESSION_COOKIE_METADATA_MISMATCH',
  'SESSION_COOKIE_ROTATION_SCHEMA',
  'SESSION_COOKIE_SCHEMA',
  'SESSION_COOKIE_SCOPE',
  'SESSION_COOKIES_EXPIRED',
  'SESSION_HANDOFF_STALE',
  'SESSION_LOCK_REQUIRED',
  'SESSION_ORIGIN_SCOPE',
  'SESSION_PROVIDER_MISSING',
  'SESSION_REQUIRED_COOKIES_UNAVAILABLE',
  'SESSION_SCHEMA',
  'SESSION_SCOPE',
  'SESSION_SERIALIZATION_LIMIT',
  'SESSION_VERIFICATION_COOKIE_UNSUPPORTED',
  'COUPANG_CONSUMER_ACCESS_BLOCKED',
  'COUPANG_CONSUMER_BODY_FAILED',
  'COUPANG_CONSUMER_CHALLENGE',
  'COUPANG_CONSUMER_CONTENT_TYPE',
  'COUPANG_CONSUMER_DPOP_REQUIRED',
  'COUPANG_CONSUMER_HTTP_REJECTED',
  'COUPANG_CONSUMER_QUANTITY_INFO_PRICE',
  'COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA',
  'COUPANG_CONSUMER_QUANTITY_INFO_SCOPE',
  'COUPANG_CONSUMER_RATE_LIMITED',
  'COUPANG_CONSUMER_REAUTH_REQUIRED',
  'COUPANG_CONSUMER_RESPONSE_SCHEMA',
  'COUPANG_CONSUMER_RESPONSE_SIZE',
  'COUPANG_CONSUMER_SESSION_BUSY',
  'COUPANG_CONSUMER_SESSION_SCHEMA',
  'COUPANG_CONSUMER_SESSION_SCOPE',
  'COUPANG_CONSUMER_TRANSPORT',
]);

export class CoupangWowPriceVerificationInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CoupangWowPriceVerificationInputError';
    this.code = code;
  }
}

const fail = code => { throw new CoupangWowPriceVerificationInputError(code); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPositivePrice = value => Number.isSafeInteger(value) && value > 0;
const positiveKrw = value => isRecord(value) && value.currency === 'KRW' && validPositivePrice(value.amount);

function validIsoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function normalizeCoupangWowPriceTargetUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('PRODUCT_URL_INVALID'); }
  const productMatch = /^\/vp\/products\/([1-9]\d{0,19})$/.exec(url.pathname);
  const keys = [...url.searchParams.keys()];
  if (url.origin !== 'https://www.coupang.com' || url.username || url.password || url.port || url.hash
    || !productMatch || keys.length !== 2 || keys.some(key => !['itemId', 'vendorItemId'].includes(key))
    || url.searchParams.getAll('itemId').length !== 1 || url.searchParams.getAll('vendorItemId').length !== 1) {
    fail('PRODUCT_URL_SCOPE');
  }

  const productId = productMatch[1];
  const itemId = url.searchParams.get('itemId');
  const vendorItemId = url.searchParams.get('vendorItemId');
  if (![productId, itemId, vendorItemId].every(id => typeof id === 'string' && ID_PATTERN.test(id)))
    fail('PRODUCT_ID_INVALID');

  const canonicalUrl = new URL(`/vp/products/${productId}`, 'https://www.coupang.com');
  canonicalUrl.searchParams.set('itemId', itemId);
  canonicalUrl.searchParams.set('vendorItemId', vendorItemId);
  return { productUrl: canonicalUrl.href, productId, itemId, vendorItemId };
}

function validateExpectedWowPrice(value) {
  if (value !== null && value !== undefined && !validPositivePrice(value)) fail('EXPECTED_WOW_PRICE_INVALID');
  return value ?? null;
}

function baseReport(target, expectedWowPriceKrw, live) {
  return {
    schemaVersion: 1,
    operation: 'coupang_exact_selected_sku_wow_price_verification',
    checkedAt: new Date().toISOString(),
    observedAt: null,
    observedGeneralAt: null,
    observedWowAt: null,
    liveRequested: live,
    status: live ? 'unattempted' : 'validated_only',
    passed: false,
    productId: target.productId,
    itemId: target.itemId,
    vendorItemId: target.vendorItemId,
    selectedIdentityMatched: false,
    observedGeneralPriceKrw: null,
    generalPriceVerified: false,
    advertisedWowPriceKrw: null,
    advertisedWowPriceLabel: null,
    advertisedWowPriceSourcePath: null,
    advertisedWowPriceVerified: false,
    wowPriceReadStatus: 'not_attempted',
    wowMembershipRequired: null,
    memberPriceVerified: false,
    accountContextPriceReadStatus: 'not_attempted',
    accountContextPriceReadCode: null,
    accountContextSalePriceReadStatus: 'not_attempted',
    accountGeneralPriceMatchesPublic: null,
    wowGeneralBoundSource: null,
    accountHttpStatus: null,
    accountCredentialPropagated: false,
    expectedWowPriceKrw,
    expectedWowPriceMatched: expectedWowPriceKrw === null ? null : false,
    nativeOfferListRead: false,
    nativeGeneralStatesVerified: false,
    nativeWowStatesVerified: false,
    nativeStatesVerified: false,
    httpStatus: null,
    errorCode: null,
    retryCount: 0,
    browserUsed: false,
    ownerCredentialUsed: false,
    rawResponseStored: false,
    rawUrlStored: false,
    publicReadReceipt: null,
    accountReadReceipt: null,
  };
}

function safeHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function nativeStateBlockVerified(states, credentialPropagated) {
  return isRecord(states)
    && states.captured === true
    && states.client_exists === true
    && states.remnant_free === true
    && states.credential_propagated === credentialPropagated
    && states.live_replay === true;
}

function exactQuery(query, expected) {
  return isRecord(query) && Object.keys(query).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => query[key] === value)
    && Object.keys(query).every(key => Object.hasOwn(expected, key));
}

function nativeOfferListRequestVerified(receipt, target) {
  return receipt?.origin === 'https://www.coupang.com'
    && receipt?.path === '/next-api/offer-list'
    && receipt?.method === 'GET'
    && exactQuery(receipt?.query, {
      productId: target.productId,
      itemId: target.itemId,
      selectedVendorItemId: target.vendorItemId,
    })
    && receipt?.execution === 'pure_http'
    && receipt?.browserUsed === false
    && receipt?.authenticationMode === 'visitor'
    && receipt?.transport === 'native_fetch'
    && receipt?.operation === 'offer_list'
    && receipt?.status === 200
    && receipt?.ownerCredentialUsed === false
    && receipt?.credentialSent === false
    && receipt?.credentialPropagated === false;
}

function nativeQuantityInfoRequestVerified(receipt, target) {
  return receipt?.origin === 'https://www.coupang.com'
    && receipt?.path === '/next-api/products/quantity-info'
    && receipt?.method === 'GET'
    && exactQuery(receipt?.query, { productId: target.productId, vendorItemId: target.vendorItemId })
    && receipt?.execution === 'pure_http'
    && receipt?.browserUsed === false
    && receipt?.authenticationMode === 'protected'
    && receipt?.transport === 'native_fetch'
    && receipt?.operation === 'quantity_info'
    && receipt?.status === 200
    && receipt?.credentialSent === true
    && receipt?.credentialPropagated === true;
}

function nativeGeneralReadVerified(result, receipt, target) {
  return nativeOfferListRequestVerified(receipt, target)
    && nativeStateBlockVerified(result?.pricePaths?.publicGeneral, false);
}

function nativeWowReadVerified(result, target) {
  const accountRead = result?.accountContextPriceRead;
  const accountReceipt = accountRead?.receipt;
  return accountRead?.status === 'read'
    && accountRead?.attempted === true
    && nativeQuantityInfoRequestVerified(accountReceipt, target)
    && nativeStateBlockVerified(result?.pricePaths?.accountWow, true);
}

function nativeAggregateVerified(result) {
  return nativeStateBlockVerified(result?.states, true);
}

function safeWowReadStatus(value) {
  return WOW_READ_STATUSES.has(value) ? value : 'unknown';
}

function hasExplicitWowDiscount(selectedOffer) {
  const flags = selectedOffer?.discountContext;
  return flags?.readStatus === 'valid'
    && (flags.hasWowCouponDiscount === true || flags.wowCouponDiscount === true
      || flags.hasWowInstantDiscount === true);
}

function validAdvertisedWowBound(selectedOffer, generalPrice, wowAmount) {
  const components = selectedOffer?.accountContextPriceComponents;
  if (!isRecord(components) || !Object.hasOwn(components, 'salePrice')
    || !isRecord(components.couponPrice) || !isRecord(components.finalPrice)
    || !positiveKrw(generalPrice) || !positiveKrw(components.couponPrice)
    || !positiveKrw(components.finalPrice) || components.finalPrice.amount !== wowAmount
    || components.finalPrice.amount > components.couponPrice.amount
    || components.couponPrice.amount > generalPrice.amount
    || components.finalPrice.amount >= generalPrice.amount || !hasExplicitWowDiscount(selectedOffer)
    || !Object.hasOwn(selectedOffer, 'accountGeneralPriceMatchesPublic')
    || !Object.hasOwn(selectedOffer, 'accountContextSalePriceReadStatus')) return false;

  const comparison = selectedOffer.accountGeneralPriceMatchesPublic;
  if (selectedOffer.accountContextSalePriceReadStatus === 'explicitly_null') {
    return components.salePrice === null && comparison === null
      && selectedOffer.wowGeneralBoundSource === 'public_offer_list_fallback';
  }

  return selectedOffer.accountContextSalePriceReadStatus === 'matched'
    && isRecord(components.salePrice) && positiveKrw(components.salePrice)
    && components.salePrice.amount === generalPrice.amount && comparison === true
    && selectedOffer.wowGeneralBoundSource === null;
}

function extractAdvertisedWowPrice(selectedOffer, generalPrice) {
  const status = safeWowReadStatus(selectedOffer?.wowPriceReadStatus);
  const value = selectedOffer?.advertisedWowPrice;
  if (status !== 'verified_advertised_wow_price' || !isRecord(value)
    || !validPositivePrice(value.amount) || value.currency !== 'KRW'
    || typeof value.label !== 'string' || value.label.trim().length === 0 || value.label.length > 100
    || value.requiresMembership !== true || value.eligibilityVerified !== false
    || value.basis !== 'account_context_final_price_with_explicit_wow_discount'
    || value.source !== 'coupang_quantity_info' || value.quantity !== 1
    || typeof value.sourcePath !== 'string' || value.sourcePath.trim().length === 0 || value.sourcePath.length > 250
    || !validAdvertisedWowBound(selectedOffer, generalPrice, value.amount)) {
    return { status, price: null };
  }
  return {
    status,
    price: {
      amount: value.amount,
      label: value.label.trim(),
      sourcePath: value.sourcePath,
    },
  };
}

function readFailureStatus(error) {
  const httpStatus = safeHttpStatus(error?.receipt?.status) ?? safeHttpStatus(error?.httpStatus)
    ?? safeHttpStatus(error?.status);
  let status = 'read_error';
  if (httpStatus === 429 || error?.code === 'COUPANG_CONSUMER_RATE_LIMITED'
    || error?.code === 'COUPANG_VISITOR_RATE_LIMITED') status = 'rate_limited';
  else if (httpStatus === 403) status = 'blocked_403';
  else if ([401, 418].includes(httpStatus) || error?.code === 'COUPANG_CONSUMER_ACCESS_BLOCKED'
    || error?.code === 'COUPANG_CONSUMER_REAUTH_REQUIRED') status = 'access_blocked';
  return {
    status,
    httpStatus,
    errorCode: SAFE_ERROR_CODES.has(error?.code) ? error.code : null,
  };
}

export async function verifyCoupangWowPrice({
  url,
  expectedWowPriceKrw = null,
  live = false,
  readOfferList = readCoupangConsumerWowPrice,
} = {}) {
  const target = normalizeCoupangWowPriceTargetUrl(url);
  const expected = validateExpectedWowPrice(expectedWowPriceKrw);
  if (typeof live !== 'boolean') fail('LIVE_FLAG_INVALID');
  if (typeof readOfferList !== 'function') fail('RUNNER_DEPENDENCY_INVALID');

  const report = baseReport(target, expected, live);
  if (!live) return report;

  let result;
  try {
    result = await readOfferList({ url: target.productUrl, authentication: 'visitor' });
  } catch (error) {
    const failure = readFailureStatus(error);
    report.publicReadReceipt = projectCoupangReadProof(error?.receipt, target);
    report.status = failure.status;
    report.httpStatus = failure.httpStatus;
    report.errorCode = failure.errorCode;
    report.observedAt = validIsoTime(error?.receipt?.checkedAt) ? error.receipt.checkedAt : null;
    return report;
  }

  const receipt = result?.receipt;
  const accountRead = result?.accountContextPriceRead;
  const accountReceipt = accountRead?.receipt;
  report.publicReadReceipt = projectCoupangReadProof(receipt, target);
  report.accountReadReceipt = projectCoupangReadProof(accountReceipt, target);
  report.observedGeneralAt = validIsoTime(receipt?.checkedAt) ? receipt.checkedAt : null;
  report.observedWowAt = validIsoTime(accountReceipt?.checkedAt) ? accountReceipt.checkedAt : null;
  report.observedAt = report.observedWowAt ?? report.observedGeneralAt;
  report.httpStatus = safeHttpStatus(receipt?.status);
  report.nativeOfferListRead = nativeOfferListRequestVerified(receipt, target);
  report.nativeGeneralStatesVerified = nativeGeneralReadVerified(result, receipt, target);
  report.nativeWowStatesVerified = nativeWowReadVerified(result, target);
  report.nativeStatesVerified = report.nativeGeneralStatesVerified
    && report.nativeWowStatesVerified && nativeAggregateVerified(result);
  const readStatus = accountRead?.status;
  report.accountContextPriceReadStatus = ['not_attempted', 'provider_missing', 'provider_unavailable', 'read', 'blocked']
    .includes(readStatus) ? readStatus : 'unknown';
  report.accountContextPriceReadCode = accountRead?.code === 'SESSION_PROVIDER_MISSING'
    ? 'SESSION_PROVIDER_MISSING'
    : SAFE_ACCOUNT_CONTEXT_CODES.has(accountRead?.code) ? accountRead.code : null;
  report.accountHttpStatus = safeHttpStatus(accountReceipt?.status);
  report.accountCredentialPropagated = accountReceipt?.credentialPropagated === true;
  report.ownerCredentialUsed = report.accountCredentialPropagated;

  if (report.httpStatus !== 200) {
    report.status = report.httpStatus === 429 ? 'rate_limited'
      : report.httpStatus === 403 ? 'blocked_403'
        : report.httpStatus === 401 || report.httpStatus === 418 ? 'access_blocked'
          : 'read_error';
    return report;
  }

  const selected = result?.selectedOffer;
  const identityMatches = result?.productId === target.productId
    && result?.itemId === target.itemId
    && result?.selectedVendorItemId === target.vendorItemId
    && selected?.selected === true
    && selected?.productId === target.productId
    && selected?.itemId === target.itemId
    && selected?.vendorItemId === target.vendorItemId;
  if (!identityMatches) {
    report.status = 'identity_mismatch';
    return report;
  }
  report.selectedIdentityMatched = true;
  const selectedSaleStatus = selected?.accountContextSalePriceReadStatus;
  report.accountContextSalePriceReadStatus = ['matched', 'explicitly_null'].includes(selectedSaleStatus)
    ? selectedSaleStatus
    : ['not_attempted', 'provider_missing', 'provider_unavailable'].includes(accountRead?.status)
      ? 'not_attempted' : 'unknown';
  report.accountGeneralPriceMatchesPublic = selected?.accountGeneralPriceMatchesPublic === true
    || selected?.accountGeneralPriceMatchesPublic === false
    ? selected.accountGeneralPriceMatchesPublic : null;
  report.wowGeneralBoundSource = selected?.wowGeneralBoundSource === 'public_offer_list_fallback'
    ? selected.wowGeneralBoundSource : null;

  const generalPrice = selected?.price;
  const validGeneralPrice = isRecord(generalPrice)
    && validPositivePrice(generalPrice.amount)
    && generalPrice.currency === 'KRW'
    && generalPrice.priceKind === 'offer_list_general_sale_price'
    && generalPrice.basis === 'public_offer_list';
  if (validGeneralPrice) report.observedGeneralPriceKrw = generalPrice.amount;

  const wow = extractAdvertisedWowPrice(selected, generalPrice);
  report.wowPriceReadStatus = wow.status;
  if (wow.price) {
    report.advertisedWowPriceKrw = wow.price.amount;
    report.advertisedWowPriceLabel = wow.price.label;
    report.advertisedWowPriceSourcePath = wow.price.sourcePath;
    report.wowMembershipRequired = true;
  }

  const nativeEvidence = report.nativeOfferListRead && report.nativeGeneralStatesVerified
    && report.selectedIdentityMatched && report.observedGeneralAt !== null;
  report.generalPriceVerified = nativeEvidence && validGeneralPrice;

  if (!report.nativeOfferListRead) {
    report.status = 'non_native_transport';
    return report;
  }
  if (!report.nativeGeneralStatesVerified || report.observedGeneralAt === null) {
    report.status = 'native_general_states_unverified';
    return report;
  }
  if (!validGeneralPrice) {
    report.status = 'invalid_general_price';
    return report;
  }
  if (wow.status === 'verified_advertised_wow_price' && !wow.price) {
    report.status = 'invalid_advertised_wow_price';
    return report;
  }
  if (!wow.price) {
    if (report.accountHttpStatus === 403) report.status = 'account_wow_blocked_403';
    else if (report.accountHttpStatus === 429) report.status = 'account_wow_rate_limited';
    else if ([401, 418].includes(report.accountHttpStatus)) report.status = 'account_wow_access_blocked';
    else if (wow.status === 'conditional_unverified') report.status = 'conditional_unverified';
    else if (wow.status === 'account_general_price_mismatch') report.status = 'account_general_price_mismatch';
    else if (wow.status === 'public_general_fallback_unverified') report.status = 'public_general_fallback_unverified';
    else report.status = 'wow_price_unavailable';
    return report;
  }

  if (!report.nativeWowStatesVerified || !nativeAggregateVerified(result) || report.observedWowAt === null) {
    report.status = 'native_wow_states_unverified';
    return report;
  }

  report.advertisedWowPriceVerified = true;
  report.expectedWowPriceMatched = expected === null ? null : expected === wow.price.amount;
  if (expected !== null && report.expectedWowPriceMatched === false) {
    report.status = 'expected_wow_price_mismatch';
    return report;
  }
  report.status = 'verified_advertised_wow_price';
  report.passed = true;
  return report;
}
