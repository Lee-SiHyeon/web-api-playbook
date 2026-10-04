import {
  fetchCoupangGoldboxWidgetPrices,
  CoupangGoldboxWidgetError,
} from '../adapters/coupang-goldbox-widget.mjs';
import {
  CoupangConsumerError,
  readCoupangConsumerOfferList,
} from '../adapters/coupang-consumer.mjs';
import { createCoupangVisitorContext } from './coupang-visitor-context.mjs';
import { projectCoupangReadProof } from './coupang-read-proof.mjs';

const ORIGIN = 'https://www.coupang.com';
const WIDGET_SOURCE = 'coupang_mlp_goldbox_widget';
const OFFER_SOURCE = 'coupang_public_offer_list';
const MAX_CATALOG_ROWS = 1000;
const MAX_WIDGET_PAGES = 5;
const MAX_FALLBACK_TARGETS = 1000;
const DEFAULT_FALLBACK_DELAY_MS = 1000;
const DEFAULT_SHIPPING_ENRICHMENT_DELAY_MS = 1000;
const ID = /^[1-9]\d{0,19}$/;
const PUBLIC_SHIPPING_PATHS = new Set([
  'vendorItemSaleInfo.deliveryFee.shippingFee',
  'vendorItemSaleInfo.vendorItemDelivery.shippingFee',
  'sellerSaleDeliveryInfo.shippingFee',
]);
const SHIPPING_EVIDENCE_VALUE_TYPES = new Set(['number', 'string', 'boolean', 'object', 'array', 'null', 'undefined']);
const ACCESS_BLOCK_STATUSES = new Set([401, 403, 418]);

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const positiveId = value => typeof value === 'string' && ID.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const safeText = (value, maxLength = 500) => typeof value === 'string'
  && value.length <= maxLength && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  ? value.replace(/\s+/g, ' ').trim() || null : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const wait = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
const keyOf = ({ productId, itemId, vendorItemId }) => `${productId}:${itemId}:${vendorItemId}`;

function identityOf(row) {
  const productId = positiveId(row?.productId);
  const itemId = positiveId(row?.itemId);
  const vendorItemId = positiveId(row?.vendorItemId);
  return productId && itemId && vendorItemId ? { productId, itemId, vendorItemId } : null;
}

function strictProductUrl(value, identity) {
  if (!identity || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) return null;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password || url.port || url.hash
      || url.pathname !== `/vp/products/${identity.productId}` || keys.length !== 2
      || new Set(keys).size !== 2 || !keys.includes('itemId') || !keys.includes('vendorItemId')
      || url.searchParams.getAll('itemId').length !== 1 || url.searchParams.get('itemId') !== identity.itemId
      || url.searchParams.getAll('vendorItemId').length !== 1 || url.searchParams.get('vendorItemId') !== identity.vendorItemId)
      return null;
    return url.href;
  } catch { return null; }
}

function publicImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['thumbnail.coupangcdn.com', 'image.coupangcdn.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.hash ? url.href : null;
  } catch { return null; }
}

function krwPrice(value, source, basis) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.currency !== 'KRW' || !Number.isSafeInteger(value.amount) || value.amount <= 0) return null;
  const text = safeText(value.text, 48);
  const unitPriceText = safeText(value.unitPriceText, 120);
  return {
    amount: value.amount,
    currency: 'KRW',
    ...(text ? { text } : {}),
    ...(unitPriceText ? { unitPriceText } : {}),
    source,
    basis,
  };
}

function verifyPrices(row) {
  const label = row.advertisedWowPrice?.label;
  const advertisedWowPriceVerified = row.advertisedPriceReadStatus === 'valid'
    && row.advertisedWowPrice !== null && label === '할인가';
  const wowPriceCoverageStatus = row.advertisedPriceReadStatus === 'invalid' ? 'invalid'
    : row.advertisedPriceReadStatus === 'valid' && row.advertisedWowPrice !== null && label === '가입 쿠폰가'
      ? 'conditional_signup_coupon'
      : advertisedWowPriceVerified ? 'verified_advertised' : 'unavailable';
  return {
    generalPriceVerified: row.generalPrice !== null
      && [WIDGET_SOURCE, OFFER_SOURCE].includes(row.generalPriceSource),
    advertisedWowPriceVerified,
    memberEligibilityVerified: false,
    wowPriceCoverageStatus,
  };
}

function normalizedPriceRow(row) {
  const identity = identityOf(row);
  if (!identity) return null;
  const productUrl = strictProductUrl(row.productUrl, identity);
  const adapterUrlStatus = row.productUrlStatus;
  const productUrlStatus = productUrl ? 'verified_consumer_url'
    : adapterUrlStatus === 'tracking_redirect_unresolved' ? 'tracking_redirect_unresolved'
      : ['missing', 'missing_detail_url', 'missing_or_invalid_detail_url'].includes(adapterUrlStatus) ? 'missing'
        : ['invalid_detail_url', 'untrusted_detail_url_host', 'detail_url_identity_mismatch'].includes(adapterUrlStatus)
          ? adapterUrlStatus : row.productUrl == null ? (adapterUrlStatus ?? 'missing') : 'invalid_consumer_url';
  const advertisedSource = row.advertisedWowPrice;
  const advertisedPrice = krwPrice(advertisedSource, WIDGET_SOURCE, 'widget_wow_price_field');
  let advertisedPriceReadStatus = ['absent', 'valid', 'invalid'].includes(row.advertisedPriceReadStatus)
    ? row.advertisedPriceReadStatus : advertisedSource == null ? 'absent' : 'valid';
  if ((advertisedPriceReadStatus === 'valid' && !advertisedPrice)
    || (advertisedPriceReadStatus === 'absent' && advertisedSource != null)) advertisedPriceReadStatus = 'invalid';
  const label = safeText(advertisedSource?.label, 80);
  const advertisedWowPrice = advertisedPrice ? {
    ...advertisedPrice,
    label,
    boxEnabled: typeof advertisedSource.boxEnabled === 'boolean' ? advertisedSource.boxEnabled : null,
    dimmed: typeof advertisedSource.dimmed === 'boolean' ? advertisedSource.dimmed : null,
    conditional: label === '가입 쿠폰가',
    eligibilityVerified: false,
  } : null;
  const wowSalePrice = label === '할인가' && advertisedPrice ? advertisedPrice.amount : null;
  const conditionalCouponPrice = label === '가입 쿠폰가' && advertisedWowPrice
    ? { ...advertisedWowPrice, conditional: true, eligibilityVerified: false } : null;
  const generalPrice = krwPrice(row.generalPrice, WIDGET_SOURCE, 'widget_final_price_field');
  const originalPrice = krwPrice(row.originalPrice, WIDGET_SOURCE, 'widget_original_price_field');
  const productTitle = safeText(row.productTitle, 500);
  const soldOut = typeof row.soldOut === 'boolean' ? row.soldOut : null;
  return {
    ...identity,
    productTitle,
    productUrl,
    productUrlStatus,
    sourceClassification: productUrl ? 'consumer_product_detail'
      : productUrlStatus === 'tracking_redirect_unresolved' ? 'non_consumer_detail_url'
        : ['invalid_detail_url', 'untrusted_detail_url_host', 'detail_url_identity_mismatch', 'invalid_consumer_url'].includes(productUrlStatus)
          ? 'invalid_consumer_detail_url'
          : 'missing_consumer_detail_url',
    productImageUrl: publicImageUrl(row.imageUrl ?? row.productImageUrl),
    soldOut,
    generalPrice,
    widgetGeneralPrice: generalPrice,
    generalPriceSource: generalPrice ? WIDGET_SOURCE : null,
    originalPrice,
    advertisedWowPrice,
    wowSalePrice,
    conditionalCouponPrice,
    advertisedPriceReadStatus,
    wowPriceReadStatus: advertisedPriceReadStatus === 'invalid' ? 'invalid_advertised_price'
      : !advertisedWowPrice ? 'matched_without_explicit_wow_price'
      : label === '할인가' ? 'matched_explicit_wow_price'
        : label === '가입 쿠폰가' ? 'matched_conditional_coupon_price'
          : 'matched_advertised_price_unclassified',
    widgetPriceReadStatus: generalPrice ? 'matched_widget_general_price' : 'missing_general_price',
    publicOfferGeneralPriceReadStatus: generalPrice ? 'matched_widget_general_price' : 'unmatched_public_general_price',
    publicOfferGeneralPriceReadError: null,
    widgetPriceReadError: null,
    shipping: null,
    advertisedShipping: null,
    shippingFeeEvidence: null,
    publicShippingFee: null,
    publicShippingGeneralPrice: null,
    publicOfferGeneralPriceComparisonStatus: 'not_compared',
    publicOfferGeneralPriceMatchesSelectedGeneralPrice: null,
    memberShippingFee: null,
    memberShippingVerified: false,
    shippingReadStatus: 'not_attempted',
    shippingReadError: null,
    shippingConditionsReadStatus: 'not_requested',
    memberPriceVerified: false,
    eventEnd: null,
    publicOfferGeneralPrice: null,
  };
}

function classifyExclusion(row) {
  if (row.productUrlStatus === 'tracking_redirect_unresolved') return 'non_consumer_detail_url';
  if (!row.productTitle && !row.productUrl) return 'missing_title_and_public_product_url';
  if (!row.productTitle) return 'missing_title';
  if (!row.productUrl) return 'invalid_or_missing_public_product_url';
  if (row.soldOut === true) return 'sold_out';
  return null;
}

function formatWon(value) { return `${value.toLocaleString('ko-KR')}원`; }

function shippingText(row) {
  if (row.shippingReadStatus === 'verified' && row.shipping?.fee) {
    return row.shipping.fee.amount === 0
      ? '공개 무료배송 (회원 적용 배송비 미확인)'
      : `공개 배송비 ${formatWon(row.shipping.fee.amount)} (회원 적용 배송비 미확인)`;
  }
  if (row.shippingReadStatus === 'conditional_unverified' && row.advertisedShipping?.fee?.amount === 0)
    return '공개 무료배송 표시 (적용 조건 미확인)';
  return '배송비 미확인';
}

function makeItem(row) {
  const effectivePrice = row.generalPrice ?? row.publicOfferGeneralPrice;
  const advertised = row.advertisedWowPrice;
  const specialText = advertised
    ? advertised.label === '가입 쿠폰가'
      ? `${advertised.label} ${formatWon(advertised.amount)} (가입·적용 조건 미확인)`
      : advertised.label === '할인가'
        ? `와우 표시 할인가 ${formatWon(advertised.amount)} (회원 적용 여부 미확인)`
        : `${advertised.label ?? '위젯 표시가'} ${formatWon(advertised.amount)} (적용 조건 미확인)`
    : null;
  const parts = [
    effectivePrice ? `일반가 ${formatWon(effectivePrice.amount)}` : '일반가 미확인',
    row.originalPrice && row.originalPrice.amount !== effectivePrice?.amount
      ? `위젯 표시 원가 ${formatWon(row.originalPrice.amount)}` : null,
    specialText,
    row.generalPriceSource === OFFER_SOURCE ? '일반가는 공개 offer-list 값' : row.generalPrice ? null : '일반가 미수집',
    shippingText(row),
  ].filter(Boolean);
  const summary = parts.join(' · ');
  const listingContent = {
    coverage: 'public_goldbox_widget_catalog_only',
    description: null,
    imageUrl: row.productImageUrl,
    unitPriceText: row.generalPrice?.unitPriceText ?? null,
    deliveryText: shippingText(row),
    cashbackText: null,
    additionalBenefitText: null,
    benefitBadges: [],
  };
  return {
    title: row.productTitle,
    url: row.productUrl,
    publishedAt: null,
    publisher: '쿠팡 골드박스',
    summary,
    priceVerification: row.priceVerification,
    engagement: { reviews: null, rating: null },
    originalArticleFetched: false,
    claimsVerified: false,
    deal: {
      productId: row.productId,
      itemId: row.itemId,
      vendorItemId: row.vendorItemId,
      price: row.originalPrice?.amount ?? null,
      // Existing consumers expect salePrice to be numeric. It remains the current
      // general price, while widgetFinalPrice keeps its source and price basis.
      salePrice: effectivePrice?.amount ?? null,
      discountRate: null,
      eventEnd: row.eventEnd,
      soldOut: row.soldOut,
      rocket: null,
      shipping: row.shipping,
      advertisedShipping: row.advertisedShipping,
      shippingFeeEvidence: row.shippingFeeEvidence,
      publicShippingFee: row.publicShippingFee,
      publicShippingGeneralPrice: row.publicShippingGeneralPrice,
      publicOfferGeneralPriceComparisonStatus: row.publicOfferGeneralPriceComparisonStatus,
      publicOfferGeneralPriceMatchesSelectedGeneralPrice: row.publicOfferGeneralPriceMatchesSelectedGeneralPrice,
      memberShippingFee: null,
      memberShippingVerified: false,
      shippingReadStatus: row.shippingReadStatus,
      shippingReadError: row.shippingReadError,
      shippingConditionsReadStatus: row.shippingConditionsReadStatus,
      wowPromotion: row.wowSalePrice !== null,
      promotionSoldPercent: null,
      wowSalePrice: row.wowSalePrice,
      advertisedWowPrice: row.advertisedWowPrice,
      advertisedPriceReadStatus: row.advertisedPriceReadStatus,
      conditionalCouponPrice: row.conditionalCouponPrice,
      memberPriceVerified: false,
      priceVerification: row.priceVerification,
      wowPromotionRate: null,
      listingContent,
      affiliateLink: false,
      widgetFinalPrice: row.widgetGeneralPrice,
      widgetOriginalPrice: row.originalPrice,
      widgetFinalPriceMatchesListingSalePrice: row.widgetGeneralPrice
        ? row.widgetGeneralPrice.amount === effectivePrice?.amount : null,
      widgetPriceSource: row.widgetGeneralPrice ? WIDGET_SOURCE : null,
      widgetPriceReadStatus: row.widgetPriceReadStatus,
      widgetPriceReadError: row.widgetPriceReadError,
      wowPriceReadStatus: row.wowPriceReadStatus,
      publicOfferGeneralPrice: row.publicOfferGeneralPrice,
      publicGeneralPriceSource: row.publicOfferGeneralPrice ? OFFER_SOURCE : row.generalPrice ? WIDGET_SOURCE : null,
      publicOfferGeneralPriceReadStatus: row.publicOfferGeneralPriceReadStatus,
      publicOfferGeneralPriceReadError: row.publicOfferGeneralPriceReadError,
      productImageUrl: row.productImageUrl,
      productUrlStatus: row.productUrlStatus,
      sourceClassification: row.sourceClassification,
    },
  };
}

function widgetCatalogReceipt(receipt) {
  return receipt && typeof receipt === 'object' ? receipt : {
    status: 'partial', operation: 'goldbox_widget_read', pages: [], pageCount: 0,
    coverage: {}, states: { captured: true, client_exists: true, remnant_free: true,
      credential_propagated: false, live_replay: false },
  };
}

function fallbackProductUrl(row) { return row.productUrl; }

function exactSelectedOffer(result, row) {
  const offer = result?.selectedOffer;
  return result?.productId === row.productId && result?.itemId === row.itemId
    && result?.selectedVendorItemId === row.vendorItemId
    && offer?.selected === true && offer.productId === row.productId && offer.itemId === row.itemId
    && offer.vendorItemId === row.vendorItemId && offer.price?.currency === 'KRW'
    && offer.price.priceKind === 'offer_list_general_sale_price' && offer.price.basis === 'public_offer_list'
    && Number.isSafeInteger(offer.price.amount) && offer.price.amount > 0;
}

function validShippingSourcePaths(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= PUBLIC_SHIPPING_PATHS.size
    && value.every(path => typeof path === 'string' && PUBLIC_SHIPPING_PATHS.has(path))
    && new Set(value).size === value.length;
}

function safeShippingConditionText(value) {
  const text = safeText(value, 120);
  return text && !/[<>@]/.test(text) && !/(?:https?:\/\/|www\.)/i.test(text) ? text : null;
}

function safeShippingConditions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  if (typeof value.hasSkuBundleConditionalFreeShippingPrice === 'boolean')
    result.hasSkuBundleConditionalFreeShippingPrice = value.hasSkuBundleConditionalFreeShippingPrice;
  if (Number.isSafeInteger(value.skuBundleConditionalFreeShippingPrice) && value.skuBundleConditionalFreeShippingPrice >= 0)
    result.skuBundleConditionalFreeShippingPrice = value.skuBundleConditionalFreeShippingPrice;
  if (value.vendorItemDelivery && typeof value.vendorItemDelivery === 'object' && !Array.isArray(value.vendorItemDelivery)) {
    const delivery = {};
    if (typeof value.vendorItemDelivery.rocketWowBadge === 'boolean')
      delivery.rocketWowBadge = value.vendorItemDelivery.rocketWowBadge;
    if (Number.isSafeInteger(value.vendorItemDelivery.freeShipOverAmount) && value.vendorItemDelivery.freeShipOverAmount >= 0)
      delivery.freeShipOverAmount = value.vendorItemDelivery.freeShipOverAmount;
    const deliveryChargeType = safeShippingConditionText(value.vendorItemDelivery.deliveryChargeType);
    if (deliveryChargeType) delivery.deliveryChargeType = deliveryChargeType;
    if (Object.keys(delivery).length) result.vendorItemDelivery = delivery;
  }
  if (value.sellerSaleDeliveryInfo && typeof value.sellerSaleDeliveryInfo === 'object'
    && !Array.isArray(value.sellerSaleDeliveryInfo)) {
    const deliveryChargePolicy = safeShippingConditionText(value.sellerSaleDeliveryInfo.deliveryChargePolicy);
    if (deliveryChargePolicy) result.sellerSaleDeliveryInfo = { deliveryChargePolicy };
  }
  return result;
}

function safeShippingFeeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.sourceScope !== 'consumer_public_offer_list' || value.memberEligibilityVerified !== false
    || !Array.isArray(value.feeCandidates) || value.feeCandidates.length > PUBLIC_SHIPPING_PATHS.size
    || !['valid', 'invalid'].includes(value.conditionsReadStatus)) return null;
  const seen = new Set();
  const feeCandidates = [];
  for (const candidate of value.feeCandidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !PUBLIC_SHIPPING_PATHS.has(candidate.sourcePath) || seen.has(candidate.sourcePath)
      || candidate.currency !== 'KRW' || !['valid', 'invalid'].includes(candidate.readStatus)) return null;
    seen.add(candidate.sourcePath);
    if (candidate.readStatus === 'valid') {
      if (!Number.isSafeInteger(candidate.amount) || candidate.amount < 0) return null;
      feeCandidates.push({ sourcePath: candidate.sourcePath, amount: candidate.amount,
        currency: 'KRW', readStatus: 'valid' });
    } else {
      if (candidate.amount !== null || !SHIPPING_EVIDENCE_VALUE_TYPES.has(candidate.valueType)) return null;
      feeCandidates.push({ sourcePath: candidate.sourcePath, amount: null,
        currency: 'KRW', readStatus: 'invalid', valueType: candidate.valueType });
    }
  }
  return {
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
    feeCandidates,
    conditions: safeShippingConditions(value.conditions),
    conditionsReadStatus: value.conditionsReadStatus,
  };
}

function normalizedPublicShipping(selectedOffer) {
  const status = selectedOffer?.shippingReadStatus;
  if (status === 'verified') {
    const shipping = selectedOffer.shipping;
    const fee = shipping?.fee;
    if (!shipping || shipping.sourceScope !== 'consumer_public_offer_list'
      || shipping.memberEligibilityVerified !== false || !validShippingSourcePaths(shipping.sourcePaths)
      || !fee || fee.currency !== 'KRW' || !Number.isSafeInteger(fee.amount) || fee.amount < 0
      || fee.priceKind !== 'public_offer_list_shipping_fee' || fee.basis !== 'public_offer_list')
      return { status: 'invalid', shipping: null, advertisedShipping: null };
    return { status, shipping: { ...shipping, fee: { ...fee }, sourcePaths: [...shipping.sourcePaths] }, advertisedShipping: null };
  }
  if (status === 'conditional_unverified') {
    const shipping = selectedOffer.advertisedShipping;
    const fee = shipping?.fee;
    if (!shipping || shipping.sourceScope !== 'consumer_public_offer_list'
      || shipping.memberEligibilityVerified !== false || !validShippingSourcePaths(shipping.sourcePaths)
      || !fee || fee.currency !== 'KRW' || fee.amount !== 0
      || fee.priceKind !== 'public_advertised_shipping_fee' || fee.basis !== 'public_offer_list')
      return { status: 'invalid', shipping: null, advertisedShipping: null };
    return { status, shipping: null,
      advertisedShipping: { ...shipping, fee: { ...fee }, sourcePaths: [...shipping.sourcePaths] } };
  }
  if (status === 'absent') return { status, shipping: null, advertisedShipping: null };
  return { status: 'invalid', shipping: null, advertisedShipping: null };
}

function publicShippingGeneralPrice(selectedOffer) {
  const price = selectedOffer?.price;
  if (!price || price.currency !== 'KRW' || !Number.isSafeInteger(price.amount) || price.amount <= 0
    || price.priceKind !== 'offer_list_general_sale_price' || price.basis !== 'public_offer_list') return null;
  return { amount: price.amount, currency: 'KRW', source: OFFER_SOURCE,
    priceKind: price.priceKind, basis: 'public_offer_list' };
}

function compareShippingOfferGeneralPrice(row) {
  const quote = row.publicShippingGeneralPrice;
  const selected = row.generalPrice;
  if (!quote || !selected || quote.currency !== 'KRW' || selected.currency !== 'KRW'
    || !Number.isSafeInteger(quote.amount) || !Number.isSafeInteger(selected.amount)) {
    row.publicOfferGeneralPriceComparisonStatus = 'not_compared';
    row.publicOfferGeneralPriceMatchesSelectedGeneralPrice = null;
    return;
  }
  const matches = quote.amount === selected.amount;
  row.publicOfferGeneralPriceComparisonStatus = matches ? 'matches_selected_general_price' : 'general_price_conflict';
  row.publicOfferGeneralPriceMatchesSelectedGeneralPrice = matches;
}

function applyOfferShipping(row, selectedOffer) {
  const shipping = normalizedPublicShipping(selectedOffer);
  row.shipping = shipping.shipping;
  row.advertisedShipping = shipping.advertisedShipping;
  row.shippingFeeEvidence = safeShippingFeeEvidence(selectedOffer?.shippingFeeEvidence);
  row.publicShippingFee = shipping.status === 'verified' ? shipping.shipping.fee.amount : null;
  row.publicShippingGeneralPrice = publicShippingGeneralPrice(selectedOffer);
  compareShippingOfferGeneralPrice(row);
  row.memberShippingFee = null;
  row.memberShippingVerified = false;
  row.shippingReadStatus = shipping.status;
  row.shippingReadError = null;
  row.shippingConditionsReadStatus = selectedOffer?.shippingConditionsReadStatus ?? 'unknown';
}

function offerReadStatus(error) {
  const receipt = error instanceof CoupangConsumerError ? error.receipt : null;
  return Number.isInteger(receipt?.status) ? receipt.status
    : Number.isInteger(receipt?.visitorBootstrap?.status) ? receipt.visitorBootstrap.status : null;
}

function safeOfferError(error) {
  return error instanceof CoupangConsumerError && /^[A-Z0-9_]{1,100}$/.test(error.code ?? '')
    ? error.code : 'COUPANG_PUBLIC_OFFER_READ_FAILED';
}

function safeOfferProof(receipt, row) {
  const identity = identityOf(row);
  return identity && receipt ? projectCoupangReadProof(receipt, identity) : null;
}

function offerReadStopReason(page) {
  if (page?.status === 429) return 'rate_limited_429';
  if (ACCESS_BLOCK_STATUSES.has(page?.status)) return `access_blocked_${page.status}`;
  if (page?.proof?.challengeConfirmed === true) return 'challenge_confirmed';
  return null;
}

async function readPublicOfferFallback(rows, { fetchImpl, visitorContext, limit, delayMs, enabled, disabledReason = 'disabled' }) {
  const eligible = enabled ? rows.filter(row => !row.generalPrice && row.productUrl && row.soldOut !== true) : [];
  const targets = eligible.slice(0, limit);
  const receipt = {
    operation: 'public_offer_list_fallback',
    enabled,
    targetLimit: limit,
    delayMs,
    candidates: eligible.length,
    requestedCandidates: targets.length,
    attempted: 0,
    matched: 0,
    notAttempted: 0,
    boundedOutCandidates: eligible.length - targets.length,
    sharedVisitorContext: true,
    visitorBootstrapCount: 0,
    stopReason: !enabled ? disabledReason : eligible.length === 0 ? 'no_candidates' : null,
    pages: [],
    states: { captured: true, client_exists: true, remnant_free: true,
      credential_propagated: false, live_replay: false },
  };
  const matchedByKey = new Map();
  const observedByKey = new Map();
  let readFailures = 0;
  let lastRequestAt = null;
  if (!enabled) return { receipt, matchedByKey, observedByKey, lastRequestAt };
  for (const [index, row] of targets.entries()) {
    const page = { productId: row.productId, itemId: row.itemId, vendorItemId: row.vendorItemId,
      status: null, errorCode: null, retry: false, selectedIdentityMatches: false, generalPrice: null,
      shippingReadStatus: null, proof: null };
    receipt.attempted++;
    lastRequestAt = Date.now();
    let result = null;
    try {
      result = await readCoupangConsumerOfferList({ url: fallbackProductUrl(row), authentication: 'visitor',
        fetchImpl, visitorContext });
      page.status = result.receipt?.status ?? 200;
      page.proof = safeOfferProof(result.receipt, row);
      page.selectedIdentityMatches = exactSelectedOffer(result, row);
      if (page.selectedIdentityMatches) {
        page.generalPrice = { amount: result.selectedOffer.price.amount, currency: 'KRW',
          source: OFFER_SOURCE, basis: 'public_offer_list' };
        page.shippingReadStatus = result.selectedOffer.shippingReadStatus ?? null;
        matchedByKey.set(keyOf(row), page.generalPrice);
        receipt.matched++;
      } else {
        page.errorCode = 'COUPANG_PUBLIC_OFFER_IDENTITY_OR_PRICE';
        readFailures++;
      }
    } catch (error) {
      const operationReceipt = error instanceof CoupangConsumerError ? error.receipt : null;
      page.proof = safeOfferProof(operationReceipt, row);
      page.status = Number.isInteger(operationReceipt?.status) ? operationReceipt.status
        : Number.isInteger(operationReceipt?.visitorBootstrap?.status) ? operationReceipt.visitorBootstrap.status : null;
      page.errorCode = error instanceof CoupangConsumerError && /^[A-Z0-9_]{1,100}$/.test(error.code)
        ? error.code : 'COUPANG_PUBLIC_OFFER_READ_FAILED';
      readFailures++;
    }
    observedByKey.set(keyOf(row), {
      status: page.status,
      selectedIdentityMatches: page.selectedIdentityMatches,
      selectedOffer: page.selectedIdentityMatches ? result?.selectedOffer ?? null : null,
      errorCode: page.errorCode,
      proof: page.proof,
      nativeLiveReplay: page.selectedIdentityMatches && fetchImpl === globalThis.fetch
        && result?.states?.live_replay === true,
    });
    receipt.pages.push(page);
    const readStopReason = offerReadStopReason(page);
    if (readStopReason) { receipt.stopReason = readStopReason; break; }
    if (index + 1 < targets.length) await wait(delayMs);
  }
  receipt.notAttempted = targets.length - receipt.attempted;
  if (receipt.stopReason === null) receipt.stopReason = eligible.length > limit ? 'fallback_limit_reached'
    : readFailures ? 'completed_with_failures' : 'all_targets_processed';
  receipt.states.live_replay = fetchImpl === globalThis.fetch && receipt.attempted > 0
    && receipt.pages.length === receipt.attempted && receipt.pages.every(page => page.status === 200 && page.selectedIdentityMatches);
  return { receipt, matchedByKey, observedByKey, lastRequestAt };
}

async function readPublicShippingEnrichment(rows, { fetchImpl, visitorContext, fallback, limit, delayMs, enabled }) {
  const targets = enabled ? rows.slice(0, limit) : [];
  const receipt = {
    operation: 'public_offer_list_shipping_enrichment',
    enabled,
    scope: 'returned_consumer_candidates_only',
    fullCatalogCoverage: false,
    delayMs,
    eligibleCandidates: rows.length,
    requestedCandidates: targets.length,
    attempted: 0,
    read: 0,
    verified: 0,
    nativeRead: 0,
    nativeVerified: 0,
    unverified: targets.length,
    reusedExistingOfferListReads: 0,
    boundedOutCandidates: rows.length - targets.length,
    notAttempted: enabled ? 0 : rows.length,
    pages: [],
    stopReason: !enabled ? 'disabled' : targets.length === 0 ? 'no_candidates' : null,
    states: { captured: true, client_exists: true, remnant_free: true,
      credential_propagated: false, live_replay: false },
  };
  if (!enabled) {
    for (const row of rows) {
      row.shippingReadStatus = 'not_attempted';
      row.shippingReadError = 'disabled';
    }
    receipt.status = 'not_requested';
    return { receipt };
  }
  for (const row of rows.slice(targets.length)) {
    row.shippingReadStatus = 'not_attempted';
    row.shippingReadError = 'shipping_enrichment_limit';
  }

  let lastRequestAt = fallback.lastRequestAt;
  let stoppedForRateLimit = fallback.receipt.stopReason === 'rate_limited_429';
  const priorAccessBlock = fallback.receipt.pages.find(page => ACCESS_BLOCK_STATUSES.has(page.status)
    || page.errorCode === 'COUPANG_CONSUMER_ACCESS_BLOCKED'
    || page.errorCode === 'COUPANG_CONSUMER_DPOP_REQUIRED');
  let accessBlockStatus = ACCESS_BLOCK_STATUSES.has(priorAccessBlock?.status) ? priorAccessBlock.status : null;
  let stoppedForAccessBlock = Boolean(priorAccessBlock);
  let stoppedForChallenge = fallback.receipt.stopReason === 'challenge_confirmed'
    || fallback.receipt.pages.some(page => page.proof?.challengeConfirmed === true);
  let observedCount = 0;
  const consumeObservation = (row, observation, reused) => {
    if (reused) receipt.reusedExistingOfferListReads++;
    if (observation?.status === 429) {
      row.shippingReadStatus = 'rate_limited';
      row.shippingReadError = 'HTTP_429';
      stoppedForRateLimit = true;
      return;
    }
    if (ACCESS_BLOCK_STATUSES.has(observation?.status)) {
      row.shippingReadStatus = 'read_failed';
      row.shippingReadError = observation.errorCode ?? `HTTP_${observation.status}`;
      accessBlockStatus ??= observation.status;
      stoppedForAccessBlock = true;
      return;
    }
    if (observation?.proof?.challengeConfirmed === true) {
      row.shippingReadStatus = 'read_failed';
      row.shippingReadError = observation.errorCode ?? 'COUPANG_CONSUMER_CHALLENGE';
      stoppedForChallenge = true;
      return;
    }
    if (observation?.status !== 200) {
      row.shippingReadStatus = 'read_failed';
      row.shippingReadError = observation?.errorCode ?? 'COUPANG_PUBLIC_OFFER_READ_FAILED';
      return;
    }
    if (observation.selectedIdentityMatches !== true || !observation.selectedOffer) {
      row.shippingReadStatus = 'identity_mismatch';
      row.shippingReadError = observation.errorCode ?? 'COUPANG_PUBLIC_OFFER_IDENTITY_OR_PRICE';
      return;
    }
    receipt.read++;
    observedCount++;
    if (observation.nativeLiveReplay === true) receipt.nativeRead++;
    applyOfferShipping(row, observation.selectedOffer);
    if (row.shippingReadStatus === 'verified') {
      receipt.verified++;
      if (observation.nativeLiveReplay === true) receipt.nativeVerified++;
    }
  };
  const receiptPage = (row, observation, reused) => ({
    productId: row.productId,
    itemId: row.itemId,
    vendorItemId: row.vendorItemId,
    status: Number.isInteger(observation?.status) ? observation.status : null,
    errorCode: observation?.errorCode ?? (observation?.status === 429 ? 'HTTP_429' : null),
    selectedIdentityMatches: observation?.selectedIdentityMatches === true,
    reusedExistingOfferListRead: reused,
    shippingReadStatus: row.shippingReadStatus,
    proof: observation?.proof ?? null,
  });

  for (const row of targets) {
    const existingObservation = fallback.observedByKey.get(keyOf(row));
    if (existingObservation) {
      consumeObservation(row, existingObservation, true);
      receipt.pages.push(receiptPage(row, existingObservation, true));
      if (existingObservation.status === 429) continue;
      continue;
    }
    if (stoppedForRateLimit) {
      row.shippingReadStatus = 'not_attempted';
      row.shippingReadError = 'stopped_after_429';
      receipt.pages.push(receiptPage(row, { status: null, errorCode: 'stopped_after_429' }, false));
      continue;
    }
    if (stoppedForAccessBlock) {
      const errorCode = accessBlockStatus ? `stopped_after_access_block_${accessBlockStatus}` : 'stopped_after_access_block';
      row.shippingReadStatus = 'not_attempted';
      row.shippingReadError = errorCode;
      receipt.pages.push(receiptPage(row, { status: null, errorCode }, false));
      continue;
    }
    if (stoppedForChallenge) {
      const errorCode = 'stopped_after_challenge_confirmed';
      row.shippingReadStatus = 'not_attempted';
      row.shippingReadError = errorCode;
      receipt.pages.push(receiptPage(row, { status: null, errorCode }, false));
      continue;
    }

    if (lastRequestAt !== null) await wait(Math.max(0, delayMs - (Date.now() - lastRequestAt)));
    receipt.attempted++;
    lastRequestAt = Date.now();
    let observation = null;
    try {
      const result = await readCoupangConsumerOfferList({ url: fallbackProductUrl(row), authentication: 'visitor',
        fetchImpl, visitorContext });
      const selectedIdentityMatches = exactSelectedOffer(result, row);
      observation = {
        status: result.receipt?.status ?? 200,
        selectedIdentityMatches,
        selectedOffer: selectedIdentityMatches ? result.selectedOffer : null,
        errorCode: selectedIdentityMatches ? null : 'COUPANG_PUBLIC_OFFER_IDENTITY_OR_PRICE',
        proof: safeOfferProof(result.receipt, row),
        nativeLiveReplay: selectedIdentityMatches && fetchImpl === globalThis.fetch
          && result.states?.live_replay === true,
      };
    } catch (error) {
      const operationReceipt = error instanceof CoupangConsumerError ? error.receipt : null;
      observation = { status: offerReadStatus(error), selectedIdentityMatches: false,
        selectedOffer: null, errorCode: safeOfferError(error), proof: safeOfferProof(operationReceipt, row), nativeLiveReplay: false };
    }
    consumeObservation(row, observation, false);
    receipt.pages.push(receiptPage(row, observation, false));
    if (observation.status === 429) continue;
  }

  receipt.notAttempted = targets.filter(row => row.shippingReadStatus === 'not_attempted').length;
  receipt.unverified = receipt.requestedCandidates - receipt.verified;
  const allRequestedVerified = receipt.requestedCandidates > 0
    && receipt.verified === receipt.requestedCandidates && receipt.notAttempted === 0;
  receipt.status = allRequestedVerified ? 'complete_requested_candidates' : 'partial_requested_candidates';
  receipt.stopReason ??= stoppedForRateLimit ? 'rate_limited_429'
    : stoppedForAccessBlock ? (accessBlockStatus ? `access_blocked_${accessBlockStatus}` : 'access_blocked')
      : stoppedForChallenge ? 'challenge_confirmed'
      : receipt.boundedOutCandidates > 0 ? 'shipping_enrichment_limit_reached'
      : allRequestedVerified ? 'all_requested_shipping_verified' : 'requested_shipping_unverified';
  receipt.states.live_replay = fetchImpl === globalThis.fetch && receipt.nativeVerified > 0
    && receipt.nativeRead === receipt.read && observedCount === receipt.read;
  return { receipt };
}

/**
 * Read the public Goldbox widget catalog over native HTTP and map its exact public rows.
 * `items` contains consumer detail URLs only; `priceRows` preserves every catalog row
 * returned by the widget, including trip-host rows and sold-out rows.
 */
export async function fetchPublicCoupangGoldbox(limit, options = {}) {
  if (options && Object.hasOwn(options, 'coupangWowObservation'))
    throw fail('COUPANG_WOW_OBSERVATION_HTTP_ONLY');
  const {
    fetchImpl = globalThis.fetch,
    maxWidgetPages = MAX_WIDGET_PAGES,
    widgetPageDelayMs = 1000,
    publicOfferFallbackLimit = MAX_FALLBACK_TARGETS,
    publicOfferFallbackDelayMs = DEFAULT_FALLBACK_DELAY_MS,
    publicOfferFallbackEnabled = true,
    shippingEnrichmentEnabled = true,
    shippingEnrichmentDelayMs = DEFAULT_SHIPPING_ENRICHMENT_DELAY_MS,
  } = options;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_ROWS
    || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(maxWidgetPages) || maxWidgetPages < 1 || maxWidgetPages > MAX_WIDGET_PAGES
    || !Number.isSafeInteger(widgetPageDelayMs) || widgetPageDelayMs < 0 || widgetPageDelayMs > 10000
    || !Number.isSafeInteger(publicOfferFallbackLimit) || publicOfferFallbackLimit < 0
    || publicOfferFallbackLimit > MAX_FALLBACK_TARGETS
    || !Number.isSafeInteger(publicOfferFallbackDelayMs) || publicOfferFallbackDelayMs < 0
    || publicOfferFallbackDelayMs > 10000
    || typeof publicOfferFallbackEnabled !== 'boolean'
    || typeof shippingEnrichmentEnabled !== 'boolean'
    || !Number.isSafeInteger(shippingEnrichmentDelayMs) || shippingEnrichmentDelayMs < 0
    || shippingEnrichmentDelayMs > 10000) throw fail('LIMIT');

  const visitorContext = createCoupangVisitorContext({ fetchImpl });
  let widgetResult = null, widgetErrorCode = null;
  try {
    widgetResult = await fetchCoupangGoldboxWidgetPrices({ catalog: true, fetchImpl, context: visitorContext,
      maxPages: maxWidgetPages, pageDelayMs: widgetPageDelayMs });
  } catch (error) {
    if (!(error instanceof CoupangGoldboxWidgetError)) {
      widgetErrorCode = 'COUPANG_GOLDBOX_WIDGET_READ_FAILED';
      widgetResult = { rows: [], receipt: error?.receipt ?? null };
    } else {
      widgetErrorCode = /^[A-Z0-9_]{1,100}$/.test(error.code ?? '') ? error.code : 'COUPANG_GOLDBOX_WIDGET_READ_FAILED';
      widgetResult = { rows: Array.isArray(error.partialRows) ? error.partialRows : [], receipt: error.receipt };
    }
  }

  const widgetReceipt = widgetCatalogReceipt(widgetResult?.receipt);
  const widgetRows = Array.isArray(widgetResult?.rows) ? widgetResult.rows : [];
  const priceRows = widgetRows.map(normalizedPriceRow).filter(Boolean);
  const invalidNormalizedRows = widgetRows.length - priceRows.length;
  const coverageSource = widgetReceipt.coverage && typeof widgetReceipt.coverage === 'object' ? widgetReceipt.coverage : {};
  const catalogRowsSeen = count(coverageSource.catalogPageRowsSeen) ?? count(widgetReceipt.catalogPageRowsSeen)
    ?? count(coverageSource.pageRowsSeen) ?? widgetReceipt.pages?.reduce((sum, page) => sum + (count(page.rowCount) ?? 0), 0) ?? 0;
  const catalogUniqueTriples = count(coverageSource.catalogUniqueTriples) ?? count(widgetReceipt.catalogUniqueTriples)
    ?? priceRows.length;
  const catalogReturnedRows = count(coverageSource.catalogReturnedRows) ?? count(widgetReceipt.catalogReturnedRows)
    ?? widgetRows.length;
  const catalogDuplicateRows = count(coverageSource.catalogDuplicateRows) ?? count(widgetReceipt.catalogDuplicateRows) ?? 0;
  const catalogConflictingTriples = count(coverageSource.catalogConflictingTriples) ?? count(widgetReceipt.catalogConflictingTriples) ?? 0;
  const catalogExcludedTriples = count(coverageSource.catalogExcludedTriples) ?? count(widgetReceipt.catalogExcludedTriples) ?? 0;
  const invalidIdentityRows = count(coverageSource.invalidIdentityRows) ?? count(widgetReceipt.invalidIdentityRows) ?? 0;
  const catalogScanComplete = coverageSource.catalogScanComplete === true || widgetReceipt.catalogScanComplete === true
    || widgetReceipt.scanComplete === true;
  const adapterCatalogRowsComplete = coverageSource.catalogRowsComplete === true || widgetReceipt.catalogRowsComplete === true;
  const exclusionCounts = {
    missingTitle: 0,
    invalidOrMissingPublicProductUrl: 0,
    nonConsumerDetailUrl: 0,
    missingTitleAndPublicProductUrl: 0,
    soldOutConsumerRows: 0,
  };
  const itemCandidates = [];
  for (const priceRow of priceRows) {
    const exclusion = classifyExclusion(priceRow);
    if (exclusion) {
      priceRow.shippingReadStatus = 'excluded';
      priceRow.shippingReadError = exclusion;
    }
    if (exclusion === 'non_consumer_detail_url') exclusionCounts.nonConsumerDetailUrl++;
    else if (exclusion === 'missing_title') exclusionCounts.missingTitle++;
    else if (exclusion === 'invalid_or_missing_public_product_url') exclusionCounts.invalidOrMissingPublicProductUrl++;
    else if (exclusion === 'missing_title_and_public_product_url') exclusionCounts.missingTitleAndPublicProductUrl++;
    else if (exclusion === 'sold_out') exclusionCounts.soldOutConsumerRows++;
    else itemCandidates.push(priceRow);
  }

  const widgetScanCanSupportFallback = catalogScanComplete && !widgetErrorCode;
  const fallback = await readPublicOfferFallback(priceRows, {
    fetchImpl, visitorContext,
    limit: publicOfferFallbackLimit,
    delayMs: publicOfferFallbackDelayMs,
    enabled: publicOfferFallbackEnabled && widgetScanCanSupportFallback,
    disabledReason: !publicOfferFallbackEnabled ? 'disabled' : 'widget_not_complete',
  });
  for (const row of priceRows) {
    const publicPrice = fallback.matchedByKey.get(keyOf(row));
    if (publicPrice) {
      row.publicOfferGeneralPrice = { ...publicPrice, readStatus: 'matched_public_offer_general_price' };
      row.generalPrice = publicPrice;
      row.generalPriceSource = OFFER_SOURCE;
      row.publicOfferGeneralPriceReadStatus = 'matched_public_offer_general_price';
      row.widgetPriceReadStatus = 'missing_general_price';
    } else if (row.widgetGeneralPrice) {
      row.publicOfferGeneralPriceReadStatus = 'matched_widget_general_price';
    } else {
      const fallbackPage = fallback.receipt.pages.find(page => keyOf(page) === keyOf(row));
      row.publicOfferGeneralPriceReadStatus = 'unmatched_public_general_price';
      row.publicOfferGeneralPriceReadError = fallbackPage?.errorCode ?? (widgetErrorCode ? widgetErrorCode : null);
      if (widgetErrorCode) row.widgetPriceReadError = widgetErrorCode;
    }
  }
  for (const row of priceRows) row.priceVerification = verifyPrices(row);

  const effectiveGeneralPriceRows = priceRows.filter(row => row.generalPrice !== null).length;
  const missingGeneralPriceRows = priceRows.length - effectiveGeneralPriceRows;
  const inStockRowsWithoutGeneralPrice = priceRows.filter(row => row.soldOut === false && !row.generalPrice).length;
  const rowsMissingTitle = priceRows.filter(row => !row.productTitle).length;
  const rowsWithoutProductUrl = priceRows.filter(row => !row.productUrl).length;
  const trackingRedirectUrlRows = priceRows.filter(row => row.productUrlStatus === 'tracking_redirect_unresolved').length;
  const rowsWithAdvertisedWowPrice = priceRows.filter(row => row.advertisedWowPrice !== null).length;
  const invalidAdvertisedPriceRows = Math.max(priceRows.filter(row => row.advertisedPriceReadStatus === 'invalid').length,
    count(coverageSource.invalidAdvertisedPriceRows) ?? 0);
  const rowsWithUnconditionalWowPrice = priceRows.filter(row => row.wowSalePrice !== null).length;
  const rowsWithConditionalCouponPrice = priceRows.filter(row => row.conditionalCouponPrice !== null).length;
  const inStockConsumerRows = itemCandidates.filter(row => row.soldOut !== true);
  const inStockCatalogRows = priceRows.filter(row => row.soldOut === false);
  const rowsWithVerifiedAdvertisedWowPrice = inStockConsumerRows
    .filter(row => row.priceVerification.advertisedWowPriceVerified).length;
  const rowsWithoutVerifiedAdvertisedWowPrice = inStockConsumerRows.length - rowsWithVerifiedAdvertisedWowPrice;
  const wowInventoryComplete = catalogScanComplete && adapterCatalogRowsComplete
    && catalogReturnedRows === priceRows.length && catalogUniqueTriples === priceRows.length
    && catalogConflictingTriples === 0 && catalogExcludedTriples === 0
    && invalidIdentityRows === 0 && invalidNormalizedRows === 0 && widgetErrorCode === null
    && priceRows.every(row => typeof row.soldOut === 'boolean')
    && new Set(priceRows.map(keyOf)).size === priceRows.length;
  const wowAdvertisedPriceCoverageComplete = wowInventoryComplete
    && inStockConsumerRows.length > 0 && rowsWithoutVerifiedAdvertisedWowPrice === 0;
  const catalogRowsWithVerifiedAdvertisedWowPrice = inStockCatalogRows
    .filter(row => row.priceVerification.advertisedWowPriceVerified).length;
  const wowAdvertisedCatalogPriceCoverageComplete = wowInventoryComplete && inStockCatalogRows.length > 0
    && catalogRowsWithVerifiedAdvertisedWowPrice === inStockCatalogRows.length;
  const rowsWithUnclassifiedAdvertisedPrice = Math.max(priceRows.filter(row => row.advertisedWowPrice
    && !['할인가', '가입 쿠폰가'].includes(row.advertisedWowPrice.label)).length,
  count(coverageSource.unclassifiedAdvertisedPriceRows) ?? 0);
  const returnedRowsReconciled = catalogReturnedRows === widgetRows.length && catalogReturnedRows === priceRows.length;
  const publicGoldboxPriceCoverageComplete = catalogScanComplete && adapterCatalogRowsComplete
    && returnedRowsReconciled && invalidNormalizedRows === 0 && missingGeneralPriceRows === 0
    && catalogConflictingTriples === 0 && widgetErrorCode === null;
  const specialPriceClassificationComplete = publicGoldboxPriceCoverageComplete
    && rowsWithUnclassifiedAdvertisedPrice === 0 && invalidAdvertisedPriceRows === 0
    && coverageSource.catalogSpecialPriceClassificationComplete !== false;

  // Sold-out rows remain in priceRows and the receipt. Remove them only from the
  // consumer-facing item list, then apply the caller's limit after a complete scan.
  const inStockItemRows = itemCandidates.filter(row => row.soldOut !== true);
  const returnedItemRows = catalogScanComplete ? inStockItemRows.slice(0, limit) : inStockItemRows;
  if (catalogScanComplete) {
    for (const row of inStockItemRows.slice(limit)) {
      row.shippingReadStatus = 'excluded';
      row.shippingReadError = 'outside_returned_candidate_limit';
    }
  }
  const shipping = await readPublicShippingEnrichment(returnedItemRows, {
    fetchImpl, visitorContext, fallback,
    limit,
    delayMs: shippingEnrichmentDelayMs,
    enabled: shippingEnrichmentEnabled,
  });
  const items = returnedItemRows.map(makeItem);
  const rowsWithVerifiedPublicShipping = returnedItemRows.filter(row => row.shippingReadStatus === 'verified').length;
  const shippingCollectionStatus = !shippingEnrichmentEnabled ? 'not_requested'
    : returnedItemRows.length > 0 && rowsWithVerifiedPublicShipping === returnedItemRows.length
      && shipping.receipt.boundedOutCandidates === 0 ? 'complete' : 'partial';
  const priceCollectionComplete = publicGoldboxPriceCoverageComplete && specialPriceClassificationComplete;
  const rowsWithPublicShippingGeneralPriceMatch = returnedItemRows
    .filter(row => row.publicOfferGeneralPriceComparisonStatus === 'matches_selected_general_price').length;
  const rowsWithPublicShippingGeneralPriceConflict = returnedItemRows
    .filter(row => row.publicOfferGeneralPriceComparisonStatus === 'general_price_conflict').length;
  const rowsWithoutPublicShippingGeneralPriceComparison = returnedItemRows
    .filter(row => row.publicOfferGeneralPriceComparisonStatus === 'not_compared').length;
  const shippingRequiredButIncomplete = shippingEnrichmentEnabled
    && (shippingCollectionStatus !== 'complete' || rowsWithPublicShippingGeneralPriceConflict > 0);
  const widgetNativeReplay = fetchImpl === globalThis.fetch && widgetReceipt.states?.live_replay === true;
  const bootstrapRows = Array.isArray(widgetReceipt.visitorBootstraps) ? widgetReceipt.visitorBootstraps : [];
  const bootstrapVerified = bootstrapRows.length > 0 && bootstrapRows.every(row => row.status === 200);
  const fallbackNativeReplay = fallback.receipt.attempted === 0
    ? fallback.receipt.candidates === 0
    : fallback.receipt.states.live_replay === true;
  const widgetGeneralPriceMissingRows = priceRows.filter(row => !row.widgetGeneralPrice).length;
  const nativePriceReplay = widgetNativeReplay && bootstrapVerified && fallbackNativeReplay
    && publicGoldboxPriceCoverageComplete && specialPriceClassificationComplete
    && priceRows.every(row => [WIDGET_SOURCE, OFFER_SOURCE].includes(row.generalPriceSource));
  const receipt = {
    schemaVersion: 1,
    operation: 'public_goldbox_widget_catalog',
    inventorySource: WIDGET_SOURCE,
    status: priceCollectionComplete && !shippingRequiredButIncomplete ? 'complete' : 'partial',
    generalPriceCollectionStatus: publicGoldboxPriceCoverageComplete ? 'complete' : 'partial',
    sourceUrl: 'https://www.coupang.com/vm/mlp/v1/newweb/mlp-widget-landing',
    pageUrl: 'https://www.coupang.com/mlp/web/mlp-landing-page?landingId=3712&sourceType=gm_crm_goldbox&subSourceType=gm_crm_gwsrtcut',
    execution: 'pure_http',
    browserUsed: false,
    shippingCollectionStatus,
    wowPriceCollectionStatus: wowAdvertisedCatalogPriceCoverageComplete ? 'complete' : 'partial',
    specialPriceClassificationScope: 'public_goldbox_widget_wow_price_labels_only',
    sellerSpecialPriceCollectionStatus: 'unverified',
    flashSalePriceCollectionStatus: 'unverified',
    legacyListingRequested: false,
    credentialsUsed: false,
    ownerCredentialUsed: false,
    credentialPropagated: false,
    visitorCookiesSent: widgetReceipt.visitorCookiesSent === true || (widgetReceipt.pages ?? []).some(page => page.visitorCookiesSent === true),
    visitorValuesPersisted: false,
    retries: 0,
    retry: false,
    widgetErrorCode,
    observedItems: catalogRowsSeen,
    mapped: itemCandidates.length + exclusionCounts.soldOutConsumerRows,
    returnedItems: items.length,
    returnedItemsLimit: catalogScanComplete ? limit : null,
    priceRows: priceRows.length,
    eventEnd: null,
    coverage: {
      scope: 'public_goldbox_widget_catalog_only',
      catalogScanComplete,
      catalogRowsComplete: adapterCatalogRowsComplete,
      catalogPriceCoverageComplete: coverageSource.catalogPriceCoverageComplete === true,
      catalogCoverageComplete: coverageSource.catalogCoverageComplete === true,
      catalogRowsSeen,
      catalogPageRowsSeen: catalogRowsSeen,
      catalogUniqueTriples,
      catalogReturnedRows,
      catalogDuplicateRows,
      catalogConflictingTriples,
      catalogExcludedTriples,
      invalidIdentityRows,
      invalidNormalizedRows,
      returnedRowsReconciled,
      allCatalogPriceRowsAccounted: publicGoldboxPriceCoverageComplete,
      publicGoldboxPriceCoverageComplete,
      allRetailerPricePathsComplete: false,
      mappingExclusions: exclusionCounts,
      rowsMissingTitle: count(coverageSource.rowsMissingTitle) ?? rowsMissingTitle,
      rowsWithoutProductUrl: count(coverageSource.rowsWithoutProductUrl) ?? rowsWithoutProductUrl,
      trackingRedirectUrlRows: count(coverageSource.trackingRedirectUrlRows) ?? trackingRedirectUrlRows,
      rowsWithGeneralPrice: count(coverageSource.rowsWithGeneralPrice) ?? priceRows.filter(row => row.widgetGeneralPrice).length,
      rowsWithEffectiveGeneralPrice: effectiveGeneralPriceRows,
      widgetGeneralPriceMissingRows,
      publicOfferGeneralPriceFallbackMatchedRows: fallback.receipt.matched,
      inStockRowsWithoutGeneralPrice: count(coverageSource.inStockRowsWithoutGeneralPrice) ?? inStockRowsWithoutGeneralPrice,
      missingGeneralPriceRows,
      rowsWithAdvertisedWowPrice: count(coverageSource.rowsWithAdvertisedWowPrice) ?? rowsWithAdvertisedWowPrice,
      invalidAdvertisedPriceRows,
      rowsWithoutAdvertisedWowPrice: priceRows.filter(row => row.advertisedPriceReadStatus === 'absent').length,
      rowsWithUnconditionalWowPrice: count(coverageSource.rowsWithUnconditionalWowPrice) ?? rowsWithUnconditionalWowPrice,
      rowsWithConditionalCouponPrice: count(coverageSource.rowsWithConditionalCouponPrice) ?? rowsWithConditionalCouponPrice,
      rowsWithUnclassifiedAdvertisedPrice,
      unclassifiedAdvertisedPriceRows: rowsWithUnclassifiedAdvertisedPrice,
      inStockConsumerRows: inStockConsumerRows.length,
      rowsWithVerifiedAdvertisedWowPrice,
      rowsWithoutVerifiedAdvertisedWowPrice,
      wowAdvertisedPriceCoverageComplete,
      shippingScope: 'returned_consumer_candidates_only',
      fullCatalogShippingCoverageComplete: false,
      returnedConsumerCandidates: returnedItemRows.length,
      rowsWithVerifiedPublicShippingFee: rowsWithVerifiedPublicShipping,
      rowsWithConditionalAdvertisedShipping: returnedItemRows.filter(row => row.shippingReadStatus === 'conditional_unverified').length,
      rowsWithoutVerifiedPublicShippingFee: returnedItemRows.length - rowsWithVerifiedPublicShipping,
      shippingCollectionStatus,
      inStockCatalogRows: inStockCatalogRows.length,
      catalogRowsWithVerifiedAdvertisedWowPrice,
      catalogRowsWithoutVerifiedAdvertisedWowPrice: inStockCatalogRows.length - catalogRowsWithVerifiedAdvertisedWowPrice,
      wowAdvertisedCatalogPriceCoverageComplete,
      specialPriceClassificationComplete,
      catalogSpecialPriceClassificationComplete: specialPriceClassificationComplete,
      specialPriceClassificationScope: 'public_goldbox_widget_wow_price_labels_only',
      sellerSpecialPriceCollectionStatus: 'unverified',
      flashSalePriceCollectionStatus: 'unverified',
      publicShippingGeneralPriceComparisonScope: 'returned_consumer_candidates_only',
      rowsWithPublicShippingGeneralPriceMatch,
      rowsWithPublicShippingGeneralPriceConflict,
      rowsWithoutPublicShippingGeneralPriceComparison,
      couponEligibilityVerified: false,
      memberPriceVerified: false,
      soldOutRowsRetainedInPriceRows: priceRows.filter(row => row.soldOut === true).length,
      soldOutUnknownRows: priceRows.filter(row => row.soldOut === null).length,
      consumerItemsExcludeSoldOut: true,
      consumerItemsLimitAppliedAfterScan: catalogScanComplete,
    },
    pricePaths: {
      goldboxWidgetGeneral: { captured: true, client_exists: true, remnant_free: true,
        credential_propagated: false, live_replay: widgetNativeReplay },
      goldboxWidgetAdvertisedSpecial: { captured: true, client_exists: true, remnant_free: true,
        credential_propagated: false, live_replay: widgetNativeReplay && rowsWithAdvertisedWowPrice > 0 },
      signupCouponEligibility: { captured: true, client_exists: true, remnant_free: true,
        credential_propagated: false, live_replay: false, eligibilityVerified: false },
      publicOfferListFallback: fallback.receipt.states,
      publicOfferListShipping: { captured: true, client_exists: true, remnant_free: true,
        credential_propagated: false, live_replay: shipping.receipt.states.live_replay,
        scope: 'returned_consumer_candidates_only', fullCatalogCoverage: false,
        memberEligibilityVerified: false },
      accountContextQuantityPrice: { captured: true, client_exists: true, remnant_free: true,
        credential_propagated: false, live_replay: false, status: 'not_requested_by_public_collector' },
      allRetailerPricePaths: { live_replay: false, complete: false },
    },
    states: { captured: true, client_exists: true, remnant_free: true,
      credential_propagated: false, live_replay: nativePriceReplay },
    widget: { ...widgetReceipt, catalogMode: true },
    publicOfferFallback: fallback.receipt,
    shippingEnrichment: shipping.receipt,
  };
  return { items, priceRows, receipt };
}
