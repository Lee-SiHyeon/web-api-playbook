import { validateCoupangQuantityInfoRequestUrl } from '../lib/shopping-session-store.mjs';

const ORIGIN = 'https://www.coupang.com';
const ID = /^[1-9]\d{0,19}$/;
const QUANTITY_PATH = '/next-api/products/quantity-info';
const OTHER_SELLERS_PATH = '/next-api/products/other-seller-info';
const OFFER_LIST_PATH = '/next-api/offer-list';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeIdentity(input) {
  if (!isRecord(input) || typeof input.url !== 'string'
    || ![input.productId, input.itemId, input.vendorItemId].every(value => typeof value === 'string' && ID.test(value)))
    fail('COUPANG_CONSUMER_OFFER_IDENTITY');

  let url;
  try { url = new URL(input.url); } catch { fail('COUPANG_CONSUMER_OFFER_URL_SCOPE'); }
  const match = /^\/vp\/products\/([1-9]\d{0,19})$/.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || url.port || url.hash || !match
    || match[1] !== input.productId
    || [...url.searchParams.keys()].some(key => !['itemId', 'vendorItemId'].includes(key))
    || url.searchParams.getAll('itemId').length !== 1 || url.searchParams.get('itemId') !== input.itemId
    || url.searchParams.getAll('vendorItemId').length !== 1 || url.searchParams.get('vendorItemId') !== input.vendorItemId)
    fail('COUPANG_CONSUMER_OFFER_URL_SCOPE');

  return { url: url.href, productId: match[1], itemId: input.itemId, vendorItemId: input.vendorItemId };
}

function requestUrl(path, parameters) {
  const target = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(parameters)) target.searchParams.set(key, value);
  return target.href;
}

export function buildCoupangQuantityInfoRequest(identity, observedUrl = null) {
  const product = normalizeIdentity(identity);
  if (observedUrl !== null) {
    try {
      return validateCoupangQuantityInfoRequestUrl(observedUrl, {
        productId: product.productId, vendorItemId: product.vendorItemId,
      });
    } catch { fail('COUPANG_CONSUMER_QUANTITY_INFO_SCOPE'); }
  }
  return requestUrl(QUANTITY_PATH, { productId: product.productId, vendorItemId: product.vendorItemId });
}

export function buildCoupangOtherSellersRequest(identity) {
  const product = normalizeIdentity(identity);
  return requestUrl(OTHER_SELLERS_PATH, {
    productId: product.productId,
    selectedId: product.vendorItemId,
    itemId: product.itemId,
  });
}

export function buildCoupangOfferListRequest(identity) {
  const product = normalizeIdentity(identity);
  return requestUrl(OFFER_LIST_PATH, {
    productId: product.productId,
    itemId: product.itemId,
    selectedVendorItemId: product.vendorItemId,
  });
}

function wonAmount(value, code) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?(?:원)?$/.test(value.trim())) fail(code);
  const amount = Number(value.trim().replace(/원$/, '').replaceAll(',', ''));
  if (!Number.isSafeInteger(amount) || amount < 0) fail(code);
  return amount;
}

function i18nWonAmount(value, code) {
  if (!isRecord(value) || value.currency !== 'KRW' || value.rawAmount !== null || value.fractionDigits !== 0)
    fail(code);
  const amount = wonAmount(typeof value.amount === 'number' ? String(value.amount) : value.amount, code);
  return { amount, currency: 'KRW' };
}

function matchedWonPrice(displayValue, i18nValue, priceKind, code) {
  const amount = wonAmount(displayValue, code);
  const internationalized = i18nWonAmount(i18nValue, code);
  if (internationalized.amount !== amount) fail(code);
  return { amount, currency: 'KRW', priceKind, basis: 'account_context' };
}

function matchedAccountSalePrice(displayValue, i18nValue, code) {
  if (displayValue === null && i18nValue === null)
    return { price: null, readStatus: 'explicitly_null' };
  return { price: matchedWonPrice(displayValue, i18nValue,
    'account_context_sale_price', code), readStatus: 'matched' };
}

function parseAccountShipping(shipping) {
  if (!isRecord(shipping) || typeof shipping.shippingFeeType !== 'string')
    fail('COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA');
  const fee = wonAmount(shipping.shippingFee, 'COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA');
  const original = shipping.originalShippingFee == null ? null
    : wonAmount(shipping.originalShippingFee, 'COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA');
  if (shipping.shippingFeeType === 'FREE' && fee !== 0) fail('COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA');
  return {
    fee: { amount: fee, currency: 'KRW', priceKind: 'account_context_shipping_fee' },
    originalFee: original === null ? null
      : { amount: original, currency: 'KRW', priceKind: 'displayed_original_shipping_fee' },
    type: shipping.shippingFeeType === 'FREE' ? 'FREE' : 'OTHER',
    sourceScope: 'consumer_account_price',
    quantity: 1,
  };
}

export function parseCoupangQuantityInfo(payload, identity) {
  const product = normalizeIdentity(identity);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0]))
    fail('COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA');
  const row = payload[0];
  if (row.quantity !== 1 || row.priceUnit !== '원' || !isRecord(row.price)
    || !Object.hasOwn(row.price, 'originPrice')) fail('COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA');

  const price = row.price;
  const salePriceResult = matchedAccountSalePrice(price.salePrice, price.i18nSalePrice,
    'COUPANG_CONSUMER_QUANTITY_INFO_PRICE');
  const salePrice = salePriceResult.price;
  const couponPrice = matchedWonPrice(price.couponPrice, price.i18nCouponPrice,
    'account_context_coupon_price', 'COUPANG_CONSUMER_QUANTITY_INFO_PRICE');
  const finalAmount = wonAmount(price.finalPrice, 'COUPANG_CONSUMER_QUANTITY_INFO_PRICE');
  const finalPrice = { amount: finalAmount, currency: 'KRW', priceKind: 'account_context_final_price', basis: 'account_context' };
  const originPrice = price.originPrice === null ? null : {
    amount: wonAmount(price.originPrice, 'COUPANG_CONSUMER_QUANTITY_INFO_PRICE'),
    currency: 'KRW', priceKind: 'displayed_origin_price',
  };
  // Observed quantity responses carry these flags separately from the amounts.
  // A coupon/final amount alone cannot establish that WOW was applied.
  const requiredDiscountNames = ['wowCouponDiscount', 'instantDiscount', 'hasNormalCouponDiscount'];
  const optionalDiscountNames = ['hasWowCouponDiscount', 'hasNormalInstantDiscount', 'hasWowInstantDiscount'];
  const discountNames = [...requiredDiscountNames, ...optionalDiscountNames];
  const discountContext = Object.fromEntries(discountNames.map(name =>
    [name, typeof price[name] === 'boolean' ? price[name] : null]));
  for (const name of discountNames) {
    discountContext[`${name}ReadStatus`] = !Object.hasOwn(price, name) ? 'absent'
      : typeof price[name] === 'boolean' ? 'valid' : 'invalid';
  }
  const malformedFlag = discountNames.some(name => discountContext[`${name}ReadStatus`] === 'invalid');
  const missingRequiredFlag = requiredDiscountNames.some(name => discountContext[`${name}ReadStatus`] === 'absent');
  const conflictingCouponFlags = typeof price.wowCouponDiscount === 'boolean'
    && typeof price.hasWowCouponDiscount === 'boolean'
    && price.wowCouponDiscount !== price.hasWowCouponDiscount;
  const detailedInstantFlagsPresent = typeof price.hasNormalInstantDiscount === 'boolean'
    && typeof price.hasWowInstantDiscount === 'boolean';
  const conflictingInstantFlags = price.instantDiscount === false
    && (price.hasNormalInstantDiscount === true || price.hasWowInstantDiscount === true)
    || price.instantDiscount === true && detailedInstantFlagsPresent
      && !price.hasNormalInstantDiscount && !price.hasWowInstantDiscount;
  discountContext.readStatus = malformedFlag || conflictingCouponFlags || conflictingInstantFlags ? 'invalid'
    : missingRequiredFlag ? 'incomplete' : 'valid';

  return {
    type: 'RetailOffer',
    id: `coupang:${product.productId}:${product.itemId}:${product.vendorItemId}:quantity-info`,
    sourceId: 'coupang',
    sourceScope: 'consumer_account_price',
    identityEvidence: 'request_scope',
    productId: product.productId,
    itemId: product.itemId,
    vendorItemId: product.vendorItemId,
    url: product.url,
    title: null,
    quantity: 1,
    price: finalPrice,
    priceComponents: { salePrice, couponPrice, finalPrice, originPrice },
    salePriceReadStatus: salePriceResult.readStatus,
    discountContext,
    shipping: parseAccountShipping(row.shippingFee),
    availability: null,
  };
}

function safeCount(value, code) {
  const count = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(count) || count < 0) fail(code);
  return count;
}

function sellerVendorId(value, code) {
  if (typeof value === 'string' && ID.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  fail(code);
}

function publicOfferId(value, code) {
  if (typeof value === 'string' && ID.test(value)) return value;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  fail(code);
}

function publicOfferSalePrice(saleInfo, code) {
  if (!isRecord(saleInfo) || !Number.isSafeInteger(saleInfo.salePrice) || saleInfo.salePrice < 0
    || !isRecord(saleInfo.i18nSalePrice)) fail(code);
  const localized = saleInfo.i18nSalePrice;
  if (localized.currency !== 'KRW' || localized.fractionDigits !== 0
    || typeof localized.amount !== 'string' || !/^(?:0|[1-9]\d*)$/.test(localized.amount)
    || !Number.isSafeInteger(localized.rawAmount) || localized.rawAmount !== saleInfo.salePrice
    || Number(localized.amount) !== saleInfo.salePrice) fail(code);
  return { amount: saleInfo.salePrice, currency: 'KRW', priceKind: 'offer_list_general_sale_price', basis: 'public_offer_list' };
}

const PUBLIC_OFFER_SHIPPING_PATHS = [
  ['vendorItemSaleInfo', 'deliveryFee', 'shippingFee'],
  ['vendorItemSaleInfo', 'vendorItemDelivery', 'shippingFee'],
  ['sellerSaleDeliveryInfo', 'shippingFee'],
];

function publicOfferShippingCandidate(row, keys) {
  let node = row;
  for (const key of keys) {
    if (node === null || node === undefined) return { present: false };
    if (!isRecord(node)) return { present: true, valid: false, valueType: Array.isArray(node) ? 'array' : typeof node };
    if (!Object.hasOwn(node, key)) return { present: false };
    node = node[key];
  }
  if (node === null || node === undefined) return { present: false };
  if (!Number.isSafeInteger(node) || node < 0)
    return { present: true, valid: false, valueType: Array.isArray(node) ? 'array' : typeof node };
  return { present: true, valid: true, amount: node };
}

function safeShippingConditionText(value) {
  if (typeof value !== 'string' || value.length > 512
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return null;
  const sanitized = value.replace(/<[^>]*>/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\s+/g, ' ').trim();
  if (!sanitized || sanitized.length > 120 || /[<>]/.test(sanitized)) return null;
  return sanitized;
}

function parsePublicShippingConditions(row) {
  const conditions = {};
  let conditional = false;
  let valid = true;
  const saleInfo = isRecord(row.vendorItemSaleInfo) ? row.vendorItemSaleInfo : null;

  if (saleInfo && Object.hasOwn(saleInfo, 'hasSkuBundleConditionalFreeShippingPrice')) {
    const value = saleInfo.hasSkuBundleConditionalFreeShippingPrice;
    if (value == null) { /* explicit empty optional condition */ }
    else if (typeof value !== 'boolean') valid = false;
    else {
      conditions.hasSkuBundleConditionalFreeShippingPrice = value;
      conditional ||= value;
    }
  }
  if (saleInfo && Object.hasOwn(saleInfo, 'skuBundleConditionalFreeShippingPrice')) {
    const value = saleInfo.skuBundleConditionalFreeShippingPrice;
    if (value == null) { /* explicit empty optional condition */ }
    else if (!Number.isSafeInteger(value) || value < 0) valid = false;
    else {
      conditions.skuBundleConditionalFreeShippingPrice = value;
      conditional ||= value > 0;
    }
  }

  if (saleInfo && Object.hasOwn(saleInfo, 'vendorItemDelivery')) {
    const delivery = saleInfo.vendorItemDelivery;
    if (delivery == null) { /* optional delivery metadata */ }
    else if (!isRecord(delivery)) valid = false;
    else {
      const deliveryConditions = {};
      if (Object.hasOwn(delivery, 'rocketWowBadge')) {
        if (delivery.rocketWowBadge == null) { /* explicit empty optional condition */ }
        else if (typeof delivery.rocketWowBadge !== 'boolean') valid = false;
        else {
          deliveryConditions.rocketWowBadge = delivery.rocketWowBadge;
          conditional ||= delivery.rocketWowBadge;
        }
      }
      if (Object.hasOwn(delivery, 'freeShipOverAmount')) {
        if (delivery.freeShipOverAmount == null) { /* explicit empty optional condition */ }
        else if (!Number.isSafeInteger(delivery.freeShipOverAmount) || delivery.freeShipOverAmount < 0) valid = false;
        else {
          deliveryConditions.freeShipOverAmount = delivery.freeShipOverAmount;
          conditional ||= delivery.freeShipOverAmount > 0;
        }
      }
      if (Object.hasOwn(delivery, 'deliveryChargeType')) {
        if (delivery.deliveryChargeType != null) {
          const value = safeShippingConditionText(delivery.deliveryChargeType);
          if (value === null) valid = false;
          else {
            deliveryConditions.deliveryChargeType = value;
            if (!/^(?:free|free[_ -]shipping|무료|무료배송)$/i.test(value)) conditional = true;
          }
        }
      }
      if (Object.keys(deliveryConditions).length > 0) conditions.vendorItemDelivery = deliveryConditions;
    }
  }

  if (Object.hasOwn(row, 'sellerSaleDeliveryInfo')) {
    const sellerDelivery = row.sellerSaleDeliveryInfo;
    if (sellerDelivery == null) { /* optional seller metadata */ }
    else if (!isRecord(sellerDelivery)) valid = false;
    else if (Object.hasOwn(sellerDelivery, 'deliveryChargePolicy')) {
      if (sellerDelivery.deliveryChargePolicy != null) {
        const value = safeShippingConditionText(sellerDelivery.deliveryChargePolicy);
        if (value === null) valid = false;
        else {
          conditions.sellerSaleDeliveryInfo = { deliveryChargePolicy: value };
          if (!/^(?:free|free[_ -]shipping|무료|무료배송)$/i.test(value)) conditional = true;
        }
      }
    }
  }

  return { conditions, conditional, valid };
}

function parsePublicOfferShipping(row) {
  const amounts = [];
  const feeCandidates = [];
  for (const keys of PUBLIC_OFFER_SHIPPING_PATHS) {
    const candidate = publicOfferShippingCandidate(row, keys);
    if (!candidate.present) continue;
    const sourcePath = keys.join('.');
    if (candidate.valid) {
      const entry = { amount: candidate.amount, sourcePath };
      amounts.push(entry);
      feeCandidates.push({ sourcePath, amount: candidate.amount, currency: 'KRW', readStatus: 'valid' });
    } else {
      feeCandidates.push({ sourcePath, amount: null, currency: 'KRW', readStatus: 'invalid',
        valueType: candidate.valueType ?? 'undefined' });
    }
  }
  const parsedConditions = parsePublicShippingConditions(row);
  const shippingFeeEvidence = {
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
    feeCandidates,
    conditions: parsedConditions.conditions,
    conditionsReadStatus: parsedConditions.valid ? 'valid' : 'invalid',
  };
  if (feeCandidates.some(candidate => candidate.readStatus === 'invalid')) return {
    shipping: null, advertisedShipping: null, shippingFeeEvidence, shippingReadStatus: 'invalid',
    shippingConditionsReadStatus: parsedConditions.valid ? 'valid' : 'invalid',
  };
  if (amounts.length === 0) return {
    shipping: null, advertisedShipping: null, shippingFeeEvidence, shippingReadStatus: 'absent',
    shippingConditionsReadStatus: parsedConditions.valid ? 'valid' : 'invalid',
  };
  const allFeesAgree = new Set(amounts.map(candidate => candidate.amount)).size === 1;
  if (!allFeesAgree && supportedConditionalSellerFreeDisplay(row, amounts, parsedConditions)) {
    return {
      shipping: null,
      advertisedShipping: {
        fee: { amount: 0, currency: 'KRW', priceKind: 'public_advertised_shipping_fee', basis: 'public_offer_list' },
        sourcePaths: ['sellerSaleDeliveryInfo.shippingFee'],
        conditions: parsedConditions.conditions,
        sourceScope: 'consumer_public_offer_list',
        memberEligibilityVerified: false,
      },
      shippingFeeEvidence,
      shippingReadStatus: 'conditional_unverified',
      shippingConditionsReadStatus: 'valid',
    };
  }
  if (!allFeesAgree) return {
    shipping: null, advertisedShipping: null, shippingFeeEvidence, shippingReadStatus: 'invalid',
    shippingConditionsReadStatus: parsedConditions.valid ? 'valid' : 'invalid',
  };
  const amount = amounts[0].amount;
  if (amount === 0 && !parsedConditions.valid)
    return { shipping: null, advertisedShipping: null, shippingFeeEvidence, shippingReadStatus: 'invalid', shippingConditionsReadStatus: 'invalid' };
  if (amount === 0 && parsedConditions.conditional) {
    return {
      shipping: null,
      advertisedShipping: {
        fee: { amount: 0, currency: 'KRW', priceKind: 'public_advertised_shipping_fee', basis: 'public_offer_list' },
        sourcePaths: amounts.map(candidate => candidate.sourcePath),
        conditions: parsedConditions.conditions,
        sourceScope: 'consumer_public_offer_list',
        memberEligibilityVerified: false,
      },
      shippingFeeEvidence,
      shippingReadStatus: 'conditional_unverified',
      shippingConditionsReadStatus: 'valid',
    };
  }
  return {
    shipping: {
      fee: { amount, currency: 'KRW', priceKind: 'public_offer_list_shipping_fee', basis: 'public_offer_list' },
      sourcePaths: amounts.map(candidate => candidate.sourcePath),
      conditions: parsedConditions.conditions,
      sourceScope: 'consumer_public_offer_list',
      memberEligibilityVerified: false,
    },
    advertisedShipping: null,
    shippingFeeEvidence,
    shippingReadStatus: 'verified',
    shippingConditionsReadStatus: parsedConditions.valid ? 'valid' : 'invalid',
  };
}

function supportedConditionalSellerFreeDisplay(row, amounts, parsedConditions) {
  if (!parsedConditions.valid || amounts.length !== PUBLIC_OFFER_SHIPPING_PATHS.length) return false;
  const byPath = new Map(amounts.map(candidate => [candidate.sourcePath, candidate.amount]));
  const vendorFee = byPath.get('vendorItemSaleInfo.deliveryFee.shippingFee');
  const deliveryFee = byPath.get('vendorItemSaleInfo.vendorItemDelivery.shippingFee');
  const sellerFee = byPath.get('sellerSaleDeliveryInfo.shippingFee');
  const saleInfo = row.vendorItemSaleInfo;
  const conditions = parsedConditions.conditions;
  const delivery = conditions.vendorItemDelivery;
  const threshold = conditions.skuBundleConditionalFreeShippingPrice;
  return Number.isSafeInteger(vendorFee) && vendorFee > 0
    && deliveryFee === vendorFee
    && sellerFee === 0
    && Number.isSafeInteger(threshold) && threshold > 0
    && Number.isSafeInteger(saleInfo?.salePrice) && saleInfo.salePrice >= threshold
    && conditions.hasSkuBundleConditionalFreeShippingPrice === false
    && delivery?.rocketWowBadge === false
    && delivery?.freeShipOverAmount === threshold
    && delivery?.deliveryChargeType === 'FREE'
    && conditions.sellerSaleDeliveryInfo?.deliveryChargePolicy === '무료배송';
}

function publicOfferCouponFlags(row, code, required) {
  const names = ['hasCouponDownload', 'hasAppreciationCoupon', 'hasNoneAppreciationCoupon'];
  const flags = {};
  for (const name of names) {
    if (typeof row[name] === 'boolean') flags[name] = row[name];
    else if (!required && row[name] === undefined) flags[name] = null;
    else fail(code);
  }
  return flags;
}

function optionalPublicPrice(display, localized, priceKind) {
  if ((display === undefined || display === null || display === '')
    && (localized === undefined || localized === null)) return { price: null, readStatus: 'absent' };
  try {
    const amount = wonAmount(typeof display === 'number' ? String(display) : display, 'OPTIONAL_PRICE');
    if (amount <= 0 || !isRecord(localized) || localized.currency !== 'KRW' || localized.fractionDigits !== 0
      || typeof localized.amount !== 'string' || !/^[1-9]\d*$/.test(localized.amount)
      || Number(localized.amount) !== amount || (localized.rawAmount !== null && localized.rawAmount !== amount))
      return { price: null, readStatus: 'invalid' };
    return { price: { amount, currency: 'KRW', priceKind, basis: 'public_offer_list' }, readStatus: 'valid' };
  } catch { return { price: null, readStatus: 'invalid' }; }
}

export function parseCoupangOfferList(payload, identity) {
  const product = normalizeIdentity(identity);
  const code = 'COUPANG_CONSUMER_OFFER_LIST_SCHEMA';
  const identityCode = 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY';
  // A normal public response contained 107 sellers. Keep a local work bound
  // without truncating the response or skipping identity/price validation.
  if (!isRecord(payload) || !isRecord(payload.data) || payload.data.status !== 200
    || !Array.isArray(payload.data.vendorItems) || payload.data.vendorItems.length < 1 || payload.data.vendorItems.length > 1000)
    fail(code);

  const seen = new Set();
  const offers = payload.data.vendorItems.map(row => {
    if (!isRecord(row) || typeof row.selected !== 'boolean') fail(code);
    const productId = publicOfferId(row.productId, identityCode);
    const itemId = publicOfferId(row.itemId, identityCode);
    const vendorItemId = publicOfferId(row.vendorItemId, identityCode);
    if (productId !== product.productId || itemId !== product.itemId || seen.has(vendorItemId)) fail(identityCode);
    seen.add(vendorItemId);

    const selected = row.selected;
    let price = null;
    if (row.vendorItemSaleInfo !== undefined && row.vendorItemSaleInfo !== null) {
      const saleInfo = row.vendorItemSaleInfo;
      if (!isRecord(saleInfo)) fail(code);
      if (publicOfferId(saleInfo.itemId, identityCode) !== itemId
        || publicOfferId(saleInfo.vendorItemId, identityCode) !== vendorItemId) fail(identityCode);
      if (Object.hasOwn(saleInfo, 'salePrice') || Object.hasOwn(saleInfo, 'i18nSalePrice'))
        price = publicOfferSalePrice(saleInfo, 'COUPANG_CONSUMER_OFFER_LIST_PRICE');
    } else if (selected) fail(code);
    if (selected && price === null) fail('COUPANG_CONSUMER_OFFER_LIST_PRICE');
    const shippingResult = parsePublicOfferShipping(row);
    const original = optionalPublicPrice(row.vendorItemSaleInfo?.displayOriginPrice,
      row.vendorItemSaleInfo?.i18nDisplayOriginPrice, 'public_displayed_original_price');
    const coupon = optionalPublicPrice(row.vendorItemSaleInfo?.couponPrice,
      row.vendorItemSaleInfo?.i18nCouponPrice, 'public_advertised_coupon_price');

    return {
      type: 'RetailOffer',
      id: `coupang:${product.productId}:${product.itemId}:${vendorItemId}:offer-list`,
      sourceId: 'coupang',
      sourceScope: 'consumer_public_offer_list',
      identityEvidence: 'request_scope',
      productId,
      itemId,
      vendorItemId,
      selected,
      price,
      priceComponents: { generalSalePrice: price, displayedOriginalPrice: original.price,
        advertisedCouponPrice: coupon.price ? { ...coupon.price, eligibilityVerified: false } : null },
      originalPriceReadStatus: original.readStatus,
      couponPriceReadStatus: coupon.readStatus,
      advertisedWowPrice: null,
      wowPriceReadStatus: 'not_exposed_by_public_offer_list',
      memberPriceVerified: false,
      shipping: shippingResult.shipping,
      advertisedShipping: shippingResult.advertisedShipping,
      shippingFeeEvidence: shippingResult.shippingFeeEvidence,
      shippingReadStatus: shippingResult.shippingReadStatus,
      shippingConditionsReadStatus: shippingResult.shippingConditionsReadStatus,
      couponFlags: publicOfferCouponFlags(row, code, selected),
    };
  });
  const selected = offers.filter(offer => offer.selected);
  if (selected.length !== 1 || selected[0].vendorItemId !== product.vendorItemId) fail(identityCode);
  return {
    source: 'coupang',
    sourceScope: 'consumer_public_offer_list',
    productId: product.productId,
    itemId: product.itemId,
    selectedVendorItemId: product.vendorItemId,
    offers,
    count: offers.length,
    selectedOffer: selected[0],
    coverage: 'one_observed_offer_list_response',
    privacy: { vendorNamesStored: false, vendorContactsStored: false, rawResponseStored: false },
  };
}

function safeLabel(value, code, maxLength = 300) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > maxLength || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(code);
  return value.replace(/\s+/g, ' ').trim() || null;
}

function parseSellerStoreRating(value, code) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isRecord(value.display)) fail(code);
  const display = value.display;
  return {
    total: safeCount(value.total, code),
    display: {
      label: safeLabel(display.label, code, 100),
      score: safeLabel(display.score, code, 100),
      scale: null,
      descriptionText: safeLabel(display.descriptionText, code, 500),
    },
  };
}

export function parseCoupangOtherSellerOffers(payload, identity) {
  const product = normalizeIdentity(identity);
  if (!isRecord(payload) || typeof payload.title !== 'string' || payload.title.length > 1000
    || !Array.isArray(payload.items) || payload.items.length > 100)
    fail('COUPANG_CONSUMER_OTHER_SELLERS_SCHEMA');
  const totalCount = safeCount(payload.totalCount, 'COUPANG_CONSUMER_OTHER_SELLERS_SCHEMA');
  const seenVendors = new Set();
  const offers = payload.items.map(row => {
    const code = 'COUPANG_CONSUMER_OTHER_SELLERS_SCHEMA';
    if (!isRecord(row) || typeof row.selected !== 'boolean') fail(code);
    const vendorItemId = sellerVendorId(row.vendorItemId, code);
    if (seenVendors.has(vendorItemId)) fail(code);
    seenVendors.add(vendorItemId);
    const vendorName = safeLabel(row.vendorName, code);
    if (!vendorName || !isRecord(row.i18nPrice)) fail(code);
    const price = i18nWonAmount(row.i18nPrice, 'COUPANG_CONSUMER_OTHER_SELLERS_PRICE');
    const sellerStoreRating = parseSellerStoreRating(row.sellerStoreRating, code);
    return {
      type: 'RetailOffer',
      id: `coupang:${product.productId}:${product.itemId}:${vendorItemId}:other-seller`,
      sourceId: 'coupang',
      sourceScope: 'consumer_other_seller_offers',
      identityEvidence: 'request_scope',
      productId: product.productId,
      itemId: product.itemId,
      requestedVendorItemId: product.vendorItemId,
      vendorItemId,
      url: null,
      referenceProductUrl: product.url,
      title: null,
      selected: row.selected,
      price: { amount: price.amount, currency: price.currency, priceKind: 'other_seller_offer_price' },
      seller: { vendorItemId, name: vendorName, storeRating: sellerStoreRating },
      availability: null,
    };
  });
  if (totalCount < offers.length) fail('COUPANG_CONSUMER_OTHER_SELLERS_SCHEMA');
  const selected = offers.filter(offer => offer.selected);
  if (selected.length > 1 || selected.length === 1 && selected[0].vendorItemId !== product.vendorItemId)
    fail('COUPANG_CONSUMER_OTHER_SELLERS_IDENTITY');
  return { offers, count: offers.length, totalCount, coverage: 'observed_seller_subset' };
}
