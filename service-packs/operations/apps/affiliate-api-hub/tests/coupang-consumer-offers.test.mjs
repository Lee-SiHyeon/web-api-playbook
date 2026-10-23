import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCoupangOtherSellersRequest,
  buildCoupangOfferListRequest,
  buildCoupangQuantityInfoRequest,
  parseCoupangOtherSellerOffers,
  parseCoupangOfferList,
  parseCoupangQuantityInfo,
} from '../adapters/coupang-consumer-offers.mjs';

const identity = {
  url: 'https://www.coupang.com/vp/products/6159950381?itemId=11948008563&vendorItemId=3299873959',
  productId: '6159950381',
  itemId: '11948008563',
  vendorItemId: '3299873959',
};
const eggIdentity = {
  url: 'https://www.coupang.com/vp/products/6417848924?itemId=13792011639&vendorItemId=81042389208',
  productId: '6417848924', itemId: '13792011639', vendorItemId: '81042389208',
};

const quantityPayload = [{
  quantity: 1,
  priceUnit: '원',
  price: {
    salePrice: '25,570',
    couponPrice: '25,570',
    finalPrice: '25,570',
    i18nSalePrice: { amount: '25570', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    i18nCouponPrice: { amount: '25570', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    originPrice: null,
    wowCouponDiscount: false,
    instantDiscount: false,
    hasNormalCouponDiscount: false,
  },
  shippingFee: {
    message: "<em class='prod-txt-bold'>무료배송</em>",
    shippingFeeType: 'FREE',
    shippingFee: '0',
    originalShippingFee: '2,500원',
    memberDeliveryContext: 'DO_NOT_EXPORT',
  },
  memberCashback: { value: 'DO_NOT_EXPORT' },
}];

const sellersPayload = {
  title: 'Observed seller-list heading, not a current product title',
  items: [
    {
      vendorItemId: 3299873959,
      vendorName: 'Selected Seller',
      selected: true,
      deliveryInfo: { shippingFeeMessage: 'DO_NOT_EXPORT', deliveryChargePolicy: 'member-only details' },
      sellerStoreRating: {
        total: 31,
        display: { label: '만족도', score: '4.7', descriptionText: '판매자 평가' },
        notice: 'DO_NOT_EXPORT',
      },
      i18nPrice: { amount: '25570', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    },
    {
      vendorItemId: 4000123456,
      vendorName: 'Alternate Seller',
      selected: false,
      deliveryInfo: { shippingFeeMessage: 'DO_NOT_EXPORT' },
      sellerStoreRating: null,
      i18nPrice: { amount: '26900', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    },
  ],
  totalCount: 12,
};

const offerListIdentity = {
  url: 'https://www.coupang.com/vp/products/8174473713?itemId=26504519093&vendorItemId=91458195016',
  productId: '8174473713', itemId: '26504519093', vendorItemId: '91458195016',
};
const offerListPayload = () => ({ data: {
  status: 200,
  title: 'ROOT_TITLE_SENTINEL', offerConditions: ['CONDITION_SENTINEL'],
  ab24540IsB: true, ab24540Value: 'EXPERIMENT_SENTINEL',
  vendorItems: [
    { productId: 8174473713, itemId: 26504519093, vendorItemId: 91458195016, selected: true,
      vendorId: 'VENDOR_ID_SENTINEL', vendorName: 'VENDOR_NAME_SENTINEL', imageUrls: ['IMAGE_URL_SENTINEL'],
      hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: true,
      vendorItemSaleInfo: { itemId: 26504519093, vendorItemId: 91458195016,
        salePrice: 19480, i18nSalePrice: { amount: '19480', rawAmount: 19480, fractionDigits: 0, currency: 'KRW' },
        originPrice: 25980, couponPrice: 'COUPON_AMOUNT_SENTINEL', couponDownloadUrl: 'COUPON_URL_SENTINEL',
        discountRate: 'DISCOUNT_RATE_SENTINEL' } },
    { productId: '8174473713', itemId: '26504519093', vendorItemId: '90000000001', selected: false,
      hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: false,
      vendorItemSaleInfo: { itemId: '26504519093', vendorItemId: '90000000001',
        salePrice: 20900, i18nSalePrice: { amount: '20900', rawAmount: 20900, fractionDigits: 0, currency: 'KRW' } } },
  ],
} });

test('builds only the observed consumer quantity and other-seller GET requests', () => {
  assert.equal(buildCoupangQuantityInfoRequest(identity),
    'https://www.coupang.com/next-api/products/quantity-info?productId=6159950381&vendorItemId=3299873959');
  assert.equal(buildCoupangOtherSellersRequest(identity),
    'https://www.coupang.com/next-api/products/other-seller-info?productId=6159950381&selectedId=3299873959&itemId=11948008563');
  assert.equal(buildCoupangOfferListRequest(offerListIdentity),
    'https://www.coupang.com/next-api/offer-list?productId=8174473713&itemId=26504519093&selectedVendorItemId=91458195016');
});

test('quantity URL builder preserves a validated captured query and its order', () => {
  const captured = 'https://www.coupang.com/next-api/products/quantity-info?quantity=1&deliveryToggle=false&landingItemId=11948008560&landingVendorItemId=3299873958&vendorItemId=3299873959&productId=6159950381&landingProductId=6159950381';
  assert.equal(buildCoupangQuantityInfoRequest(identity, captured), captured);

  const invalid = [
    captured.replace('quantity=1', 'quantity=2'),
    captured.replace('deliveryToggle=false', 'deliveryToggle=0'),
    captured.replace('landingItemId=11948008560&', ''),
    captured.replace('landingProductId=6159950381', 'landingProductId=1'),
    captured.replace('vendorItemId=3299873959&productId', 'vendorItemId=1&productId'),
    `${captured}&traceId=unobserved`,
    `${captured}&quantity=1`,
    captured.replace('productId=6159950381', 'productId=%36%31%35%39%39%35%30%33%38%31'),
    captured.replace('www.coupang.com', 'm.coupang.com'),
  ];
  for (const candidate of invalid) assert.throws(() => buildCoupangQuantityInfoRequest(identity, candidate),
    { code: 'COUPANG_CONSUMER_QUANTITY_INFO_SCOPE' });
});

test('rejects an identity whose URL or IDs do not agree', () => {
  assert.throws(() => buildCoupangQuantityInfoRequest({ ...identity, productId: '1' }),
    error => error.code === 'COUPANG_CONSUMER_OFFER_URL_SCOPE');
  assert.throws(() => buildCoupangOtherSellersRequest({ ...identity, url: identity.url.replace('www.coupang.com', 'coupang.com') }),
    error => error.code === 'COUPANG_CONSUMER_OFFER_URL_SCOPE');
  assert.throws(() => buildCoupangQuantityInfoRequest({
    ...identity, url: `${identity.url}&vendorItemId=3299873959`,
  }), error => error.code === 'COUPANG_CONSUMER_OFFER_URL_SCOPE');
});

test('parses account-context quantity pricing without implying stock or exporting private modules', () => {
  const offer = parseCoupangQuantityInfo(quantityPayload, identity);
  assert.equal(offer.type, 'RetailOffer');
  assert.equal(offer.sourceScope, 'consumer_account_price');
  assert.equal(offer.identityEvidence, 'request_scope');
  assert.equal(offer.productId, identity.productId);
  assert.equal(offer.itemId, identity.itemId);
  assert.equal(offer.vendorItemId, identity.vendorItemId);
  assert.equal(offer.url, identity.url);
  assert.equal(offer.title, null);
  assert.equal(offer.quantity, 1);
  assert.equal(offer.price.amount, 25570);
  assert.equal(offer.price.priceKind, 'account_context_final_price');
  assert.equal(offer.discountContext.readStatus, 'valid');
  assert.equal(offer.discountContext.hasWowCouponDiscount, null);
  assert.equal(offer.discountContext.hasWowCouponDiscountReadStatus, 'absent');
  assert.equal(offer.discountContext.hasNormalInstantDiscountReadStatus, 'absent');
  assert.equal(offer.discountContext.hasWowInstantDiscountReadStatus, 'absent');
  assert.deepEqual(Object.fromEntries(Object.entries(offer.priceComponents).map(([key, value]) => [key, value?.amount ?? null])), {
    salePrice: 25570, couponPrice: 25570, finalPrice: 25570, originPrice: null,
  });
  assert.equal(offer.salePriceReadStatus, 'matched');
  assert.equal(offer.priceComponents.salePrice.basis, 'account_context');
  assert.equal(offer.shipping.fee.amount, 0);
  assert.equal(offer.shipping.originalFee.amount, 2500);
  assert.equal(offer.shipping.sourceScope, 'consumer_account_price');
  assert.equal(offer.shipping.quantity, 1);
  assert.equal(offer.shipping.type, 'FREE');
  assert.equal(offer.availability, null);
  assert.equal(JSON.stringify(offer).includes('DO_NOT_EXPORT'), false);
  assert.equal(JSON.stringify(offer).includes('<em'), false);
  assert.equal(JSON.stringify(offer).includes('message'), false);
});

test('accepts the exact observed paired-null account sale fields and preserves explicit null status', () => {
  const payload = [{ quantity: 1, priceUnit: '원', price: {
    salePrice: null, i18nSalePrice: null,
    originPrice: '8,690', i18nOriginPrice: { amount: '8690', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    couponPrice: '7,590', i18nCouponPrice: { amount: '7590', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    finalPrice: '7,590', wowCouponDiscount: false, instantDiscount: true,
    hasNormalCouponDiscount: false, hasWowCouponDiscount: false,
    hasNormalInstantDiscount: false, hasWowInstantDiscount: true,
  }, shippingFee: { shippingFeeType: 'FREE', shippingFee: '0' } }];
  const offer = parseCoupangQuantityInfo(payload, eggIdentity);
  assert.equal(offer.priceComponents.salePrice, null);
  assert.equal(offer.salePriceReadStatus, 'explicitly_null');
  assert.equal(offer.priceComponents.couponPrice.amount, 7590);
  assert.equal(offer.priceComponents.finalPrice.amount, 7590);
  assert.equal(offer.priceComponents.originPrice.amount, 8690);
  assert.equal(offer.discountContext.readStatus, 'valid');
  assert.equal(offer.discountContext.hasWowInstantDiscount, true);
});

test('paired-null account sale exception rejects one-sided, missing, malformed, or non-KRW values', () => {
  const base = [{ quantity: 1, priceUnit: '원', price: {
    salePrice: null, i18nSalePrice: null, couponPrice: '7,590',
    i18nCouponPrice: { amount: '7590', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    finalPrice: '7,590', originPrice: '8,690',
    wowCouponDiscount: false, instantDiscount: true, hasNormalCouponDiscount: false,
  }, shippingFee: { shippingFeeType: 'FREE', shippingFee: '0' } }];
  const invalidCases = [];
  const saleOnlyNull = structuredClone(base); saleOnlyNull[0].price.i18nSalePrice = {
    amount: '8690', rawAmount: null, fractionDigits: 0, currency: 'KRW',
  }; invalidCases.push(saleOnlyNull);
  const localizedOnlyNull = structuredClone(base); localizedOnlyNull[0].price.salePrice = '8,690'; invalidCases.push(localizedOnlyNull);
  const missingPair = structuredClone(base); delete missingPair[0].price.salePrice; delete missingPair[0].price.i18nSalePrice; invalidCases.push(missingPair);
  const missingLocalized = structuredClone(base); delete missingLocalized[0].price.i18nSalePrice; invalidCases.push(missingLocalized);
  const malformed = structuredClone(base); malformed[0].price.salePrice = 'PRICE_SENTINEL'; invalidCases.push(malformed);
  const nonKrw = structuredClone(base); nonKrw[0].price.salePrice = '8,690';
  nonKrw[0].price.i18nSalePrice = { amount: '8690', rawAmount: null, fractionDigits: 0, currency: 'USD' };
  invalidCases.push(nonKrw);
  for (const payload of invalidCases) assert.throws(() => parseCoupangQuantityInfo(payload, eggIdentity),
    { code: 'COUPANG_CONSUMER_QUANTITY_INFO_PRICE' });
});

test('rejects inconsistent quantity price and display contracts', () => {
  const mismatched = structuredClone(quantityPayload);
  mismatched[0].price.i18nSalePrice.amount = '25571';
  assert.throws(() => parseCoupangQuantityInfo(mismatched, identity),
    error => error.code === 'COUPANG_CONSUMER_QUANTITY_INFO_PRICE');

  const contradictoryFreeShipping = structuredClone(quantityPayload);
  contradictoryFreeShipping[0].shippingFee.shippingFee = '1';
  assert.throws(() => parseCoupangQuantityInfo(contradictoryFreeShipping, identity),
    error => error.code === 'COUPANG_CONSUMER_QUANTITY_INFO_SCHEMA');

  const noOriginalFee = structuredClone(quantityPayload);
  delete noOriginalFee[0].shippingFee.originalShippingFee;
  assert.equal(parseCoupangQuantityInfo(noOriginalFee, identity).shipping.originalFee, null);
});

test('optional WOW discount flags distinguish absent values from malformed values', () => {
  const missing = parseCoupangQuantityInfo(quantityPayload, identity).discountContext;
  assert.equal(missing.readStatus, 'valid');
  assert.equal(missing.hasWowInstantDiscount, null);
  assert.equal(missing.hasWowInstantDiscountReadStatus, 'absent');

  const malformedPayload = structuredClone(quantityPayload);
  malformedPayload[0].price.hasWowInstantDiscount = 'false';
  const malformed = parseCoupangQuantityInfo(malformedPayload, identity).discountContext;
  assert.equal(malformed.hasWowInstantDiscount, null);
  assert.equal(malformed.hasWowInstantDiscountReadStatus, 'invalid');
  assert.equal(malformed.readStatus, 'invalid');
});

test('returns seller offers with request-bound identity, seller rating scope, and observed-subset coverage', () => {
  const result = parseCoupangOtherSellerOffers(sellersPayload, identity);
  assert.equal(result.count, 2);
  assert.equal(result.totalCount, 12);
  assert.equal(result.coverage, 'observed_seller_subset');
  assert.equal(result.offers[0].type, 'RetailOffer');
  assert.equal(result.offers[0].sourceScope, 'consumer_other_seller_offers');
  assert.equal(result.offers[0].identityEvidence, 'request_scope');
  assert.equal(result.offers[0].productId, identity.productId);
  assert.equal(result.offers[0].itemId, identity.itemId);
  assert.equal(result.offers[0].requestedVendorItemId, identity.vendorItemId);
  assert.equal(result.offers[0].vendorItemId, identity.vendorItemId);
  assert.equal(result.offers[0].url, null);
  assert.equal(result.offers[0].referenceProductUrl, identity.url);
  assert.equal(result.offers[0].title, null);
  assert.equal(result.offers[0].selected, true);
  assert.equal(result.offers[0].price.amount, 25570);
  assert.deepEqual(result.offers[0].seller.storeRating, {
    total: 31,
    display: { label: '만족도', score: '4.7', scale: null, descriptionText: '판매자 평가' },
  });
  assert.equal(result.offers[1].seller.storeRating, null);
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
  assert.equal(JSON.stringify(result).includes('deliveryInfo'), false);
  assert.equal(JSON.stringify(result).includes('notice'), false);
  assert.equal(JSON.stringify(result).includes('Observed seller-list heading'), false);
});

test('rejects selected seller identity conflicts, duplicate sellers, and malformed currencies', () => {
  const wrongSelected = structuredClone(sellersPayload);
  wrongSelected.items[0].vendorItemId = 5000000000;
  assert.throws(() => parseCoupangOtherSellerOffers(wrongSelected, identity),
    error => error.code === 'COUPANG_CONSUMER_OTHER_SELLERS_IDENTITY');

  const duplicate = structuredClone(sellersPayload);
  duplicate.items[1].vendorItemId = duplicate.items[0].vendorItemId;
  duplicate.items[1].selected = false;
  assert.throws(() => parseCoupangOtherSellerOffers(duplicate, identity),
    error => error.code === 'COUPANG_CONSUMER_OTHER_SELLERS_SCHEMA');

  const badCurrency = structuredClone(sellersPayload);
  badCurrency.items[0].i18nPrice.currency = 'USD';
  assert.throws(() => parseCoupangOtherSellerOffers(badCurrency, identity),
    error => error.code === 'COUPANG_CONSUMER_OTHER_SELLERS_PRICE');

  const impossibleCount = structuredClone(sellersPayload);
  impossibleCount.totalCount = 1;
  assert.throws(() => parseCoupangOtherSellerOffers(impossibleCount, identity),
    error => error.code === 'COUPANG_CONSUMER_OTHER_SELLERS_SCHEMA');
});

function largeOfferListPayload(count = 107) {
  const payload = offerListPayload();
  const [selected, alternate] = payload.data.vendorItems;
  payload.data.vendorItems = Array.from({ length: count - 1 }, (_, index) => {
    const row = structuredClone(alternate);
    row.vendorItemId = String(80000000000 + index);
    row.vendorItemSaleInfo.vendorItemId = row.vendorItemId;
    return row;
  });
  payload.data.vendorItems.push(selected);
  return payload;
}

test('public offer-list retains a selected price beyond the first 100 sellers', () => {
  const result = parseCoupangOfferList(largeOfferListPayload(), offerListIdentity);
  assert.equal(result.count, 107);
  assert.equal(result.offers.at(-1), result.selectedOffer);
  assert.equal(result.selectedOffer.vendorItemId, offerListIdentity.vendorItemId);
  assert.equal(result.selectedOffer.price.amount, 19480);
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false);
});

test('public offer-list validates identities and prices after the first 100 sellers', () => {
  const duplicate = largeOfferListPayload();
  duplicate.data.vendorItems[105] = structuredClone(duplicate.data.vendorItems[0]);
  assert.throws(() => parseCoupangOfferList(duplicate, offerListIdentity),
    { code: 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY' });

  const invalidPrice = largeOfferListPayload();
  invalidPrice.data.vendorItems[105].vendorItemSaleInfo.i18nSalePrice.amount = '1';
  assert.throws(() => parseCoupangOfferList(invalidPrice, offerListIdentity),
    { code: 'COUPANG_CONSUMER_OFFER_LIST_PRICE' });

});

test('parses public offer-list general sale prices and coupon flags without seller or root metadata', () => {
  const result = parseCoupangOfferList(offerListPayload(), offerListIdentity);
  assert.equal(result.count, 2);
  assert.equal(result.selectedVendorItemId, offerListIdentity.vendorItemId);
  assert.equal(result.selectedOffer.vendorItemId, offerListIdentity.vendorItemId);
  assert.equal(result.selectedOffer.price.amount, 19480);
  assert.deepEqual(result.selectedOffer.price, {
    amount: 19480, currency: 'KRW', priceKind: 'offer_list_general_sale_price', basis: 'public_offer_list',
  });
  assert.deepEqual(result.selectedOffer.couponFlags, {
    hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: true,
  });
  assert.equal(result.offers[1].price.amount, 20900);
  assert.equal('originPrice' in result.selectedOffer, false);
  assert.equal('wowPrice' in result.selectedOffer, false);
  assert.equal(result.privacy.rawResponseStored, false);
  const serialized = JSON.stringify(result);
  for (const omitted of ['ROOT_TITLE_SENTINEL', 'CONDITION_SENTINEL', 'EXPERIMENT_SENTINEL', 'VENDOR_ID_SENTINEL',
    'VENDOR_NAME_SENTINEL', 'IMAGE_URL_SENTINEL', 'COUPON_AMOUNT_SENTINEL', 'COUPON_URL_SENTINEL', 'DISCOUNT_RATE_SENTINEL'])
    assert.equal(serialized.includes(omitted), false, omitted);
});

test('parses exact-row public shipping fees and preserves the shipping source paths', () => {
  const payload = offerListPayload();
  const selected = payload.data.vendorItems[0];
  selected.vendorItemSaleInfo.salePrice = 1070;
  selected.vendorItemSaleInfo.i18nSalePrice = { amount: '1070', rawAmount: 1070, fractionDigits: 0, currency: 'KRW' };
  selected.vendorItemSaleInfo.deliveryFee = { shippingFee: 3000 };
  selected.vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = false;
  selected.vendorItemSaleInfo.skuBundleConditionalFreeShippingPrice = 19800;
  selected.vendorItemSaleInfo.vendorItemDelivery = {
    shippingFee: 3000, freeShipOverAmount: 19800, rocketWowBadge: false, deliveryChargeType: 'CONDITIONAL',
  };
  selected.sellerSaleDeliveryInfo = { shippingFee: 3000 };
  payload.data.vendorItems[1].vendorItemSaleInfo.deliveryFee = { shippingFee: 250 };

  const result = parseCoupangOfferList(payload, offerListIdentity);
  assert.deepEqual(result.selectedOffer.shipping, {
    fee: { amount: 3000, currency: 'KRW', priceKind: 'public_offer_list_shipping_fee', basis: 'public_offer_list' },
    sourcePaths: [
      'vendorItemSaleInfo.deliveryFee.shippingFee',
      'vendorItemSaleInfo.vendorItemDelivery.shippingFee',
      'sellerSaleDeliveryInfo.shippingFee',
    ],
    conditions: {
      hasSkuBundleConditionalFreeShippingPrice: false,
      skuBundleConditionalFreeShippingPrice: 19800,
      vendorItemDelivery: { rocketWowBadge: false, freeShipOverAmount: 19800, deliveryChargeType: 'CONDITIONAL' },
    },
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
  });
  assert.equal(result.selectedOffer.shippingReadStatus, 'verified');
  assert.equal(result.selectedOffer.advertisedShipping, null);
  assert.equal(result.selectedOffer.shippingConditionsReadStatus, 'valid');
  assert.deepEqual(result.selectedOffer.shippingFeeEvidence, {
    sourceScope: 'consumer_public_offer_list', memberEligibilityVerified: false,
    feeCandidates: [
      { sourcePath: 'vendorItemSaleInfo.deliveryFee.shippingFee', amount: 3000, currency: 'KRW', readStatus: 'valid' },
      { sourcePath: 'vendorItemSaleInfo.vendorItemDelivery.shippingFee', amount: 3000, currency: 'KRW', readStatus: 'valid' },
      { sourcePath: 'sellerSaleDeliveryInfo.shippingFee', amount: 3000, currency: 'KRW', readStatus: 'valid' },
    ],
    conditions: {
      hasSkuBundleConditionalFreeShippingPrice: false,
      skuBundleConditionalFreeShippingPrice: 19800,
      vendorItemDelivery: { rocketWowBadge: false, freeShipOverAmount: 19800, deliveryChargeType: 'CONDITIONAL' },
    },
    conditionsReadStatus: 'valid',
  });
  assert.equal(result.selectedOffer.price.amount + result.selectedOffer.shipping.fee.amount, 4070);
  assert.deepEqual(result.offers[1].shipping, {
    fee: { amount: 250, currency: 'KRW', priceKind: 'public_offer_list_shipping_fee', basis: 'public_offer_list' },
    sourcePaths: ['vendorItemSaleInfo.deliveryFee.shippingFee'],
    conditions: {},
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
  });
  assert.equal(result.offers[1].shipping.memberEligibilityVerified, false);
});

test('distinguishes absent shipping from an explicit unconditional zero fee', () => {
  const absent = parseCoupangOfferList(offerListPayload(), offerListIdentity).selectedOffer;
  assert.equal(absent.shipping, null);
  assert.equal(absent.advertisedShipping, null);
  assert.equal(absent.shippingReadStatus, 'absent');

  const zeroPayload = offerListPayload();
  zeroPayload.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 0 };
  const zero = parseCoupangOfferList(zeroPayload, offerListIdentity).selectedOffer;
  assert.deepEqual(zero.shipping, {
    fee: { amount: 0, currency: 'KRW', priceKind: 'public_offer_list_shipping_fee', basis: 'public_offer_list' },
    sourcePaths: ['vendorItemSaleInfo.deliveryFee.shippingFee'],
    conditions: {},
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
  });
  assert.equal(zero.advertisedShipping, null);
  assert.equal(zero.shippingReadStatus, 'verified');
  assert.equal(zero.shippingConditionsReadStatus, 'valid');
});

test('keeps the price but marks zero conditional shipping unverified until eligibility is known', () => {
  const conditional = offerListPayload();
  conditional.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 0 };
  conditional.data.vendorItems[0].vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = true;
  const offer = parseCoupangOfferList(conditional, offerListIdentity).selectedOffer;
  assert.equal(offer.price.amount, 19480);
  assert.equal(offer.shipping, null);
  assert.deepEqual(offer.advertisedShipping, {
    fee: { amount: 0, currency: 'KRW', priceKind: 'public_advertised_shipping_fee', basis: 'public_offer_list' },
    sourcePaths: ['vendorItemSaleInfo.deliveryFee.shippingFee'],
    conditions: { hasSkuBundleConditionalFreeShippingPrice: true },
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
  });
  assert.equal(offer.shippingReadStatus, 'conditional_unverified');
  assert.equal(offer.shippingConditionsReadStatus, 'valid');

  const thresholdOnly = offerListPayload();
  thresholdOnly.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 0 };
  thresholdOnly.data.vendorItems[0].vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = false;
  thresholdOnly.data.vendorItems[0].vendorItemSaleInfo.skuBundleConditionalFreeShippingPrice = 19800;
  thresholdOnly.data.vendorItems[0].vendorItemSaleInfo.vendorItemDelivery = { shippingFee: 0, freeShipOverAmount: 19800 };
  thresholdOnly.data.vendorItems[0].sellerSaleDeliveryInfo = { shippingFee: 0 };
  const thresholdOffer = parseCoupangOfferList(thresholdOnly, offerListIdentity).selectedOffer;
  assert.equal(thresholdOffer.price.amount, 19480);
  assert.equal(thresholdOffer.shipping, null);
  assert.deepEqual(thresholdOffer.advertisedShipping, {
    fee: { amount: 0, currency: 'KRW', priceKind: 'public_advertised_shipping_fee', basis: 'public_offer_list' },
    sourcePaths: [
      'vendorItemSaleInfo.deliveryFee.shippingFee',
      'vendorItemSaleInfo.vendorItemDelivery.shippingFee',
      'sellerSaleDeliveryInfo.shippingFee',
    ],
    conditions: {
      hasSkuBundleConditionalFreeShippingPrice: false,
      skuBundleConditionalFreeShippingPrice: 19800,
      vendorItemDelivery: { freeShipOverAmount: 19800 },
    },
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
  });
  assert.equal(thresholdOffer.shippingReadStatus, 'conditional_unverified');

  const policyConditional = offerListPayload();
  policyConditional.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 0 };
  policyConditional.data.vendorItems[0].sellerSaleDeliveryInfo = { deliveryChargePolicy: 'MEMBER_FREE_SHIPPING' };
  const policyOffer = parseCoupangOfferList(policyConditional, offerListIdentity).selectedOffer;
  assert.equal(policyOffer.shipping, null);
  assert.deepEqual(policyOffer.advertisedShipping.conditions, {
    sellerSaleDeliveryInfo: { deliveryChargePolicy: 'MEMBER_FREE_SHIPPING' },
  });
  assert.equal(policyOffer.shippingReadStatus, 'conditional_unverified');
  assert.equal(policyOffer.advertisedShipping.memberEligibilityVerified, false);
});

test('keeps threshold-backed seller free display separate from conflicting vendor base fees', () => {
  const payload = offerListPayload();
  const selected = payload.data.vendorItems[0];
  selected.vendorItemSaleInfo.salePrice = 19_900;
  selected.vendorItemSaleInfo.i18nSalePrice = { amount: '19900', rawAmount: 19_900, fractionDigits: 0, currency: 'KRW' };
  selected.vendorItemSaleInfo.deliveryFee = { shippingFee: 2500 };
  selected.vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = false;
  selected.vendorItemSaleInfo.skuBundleConditionalFreeShippingPrice = 19_800;
  selected.vendorItemSaleInfo.vendorItemDelivery = {
    shippingFee: 2500, rocketWowBadge: false, freeShipOverAmount: 19_800, deliveryChargeType: 'FREE',
  };
  selected.sellerSaleDeliveryInfo = {
    shippingFee: 0, deliveryChargePolicy: "<em class='policy'>무료배송</em>",
  };

  const offer = parseCoupangOfferList(payload, offerListIdentity).selectedOffer;
  assert.equal(offer.price.amount, 19_900);
  assert.equal(offer.shipping, null);
  assert.equal(offer.shippingReadStatus, 'conditional_unverified');
  assert.equal(offer.shippingConditionsReadStatus, 'valid');
  assert.deepEqual(offer.advertisedShipping, {
    fee: { amount: 0, currency: 'KRW', priceKind: 'public_advertised_shipping_fee', basis: 'public_offer_list' },
    sourcePaths: ['sellerSaleDeliveryInfo.shippingFee'],
    conditions: {
      hasSkuBundleConditionalFreeShippingPrice: false,
      skuBundleConditionalFreeShippingPrice: 19_800,
      vendorItemDelivery: { rocketWowBadge: false, freeShipOverAmount: 19_800, deliveryChargeType: 'FREE' },
      sellerSaleDeliveryInfo: { deliveryChargePolicy: '무료배송' },
    },
    sourceScope: 'consumer_public_offer_list',
    memberEligibilityVerified: false,
  });
  assert.deepEqual(offer.shippingFeeEvidence.feeCandidates, [
    { sourcePath: 'vendorItemSaleInfo.deliveryFee.shippingFee', amount: 2500, currency: 'KRW', readStatus: 'valid' },
    { sourcePath: 'vendorItemSaleInfo.vendorItemDelivery.shippingFee', amount: 2500, currency: 'KRW', readStatus: 'valid' },
    { sourcePath: 'sellerSaleDeliveryInfo.shippingFee', amount: 0, currency: 'KRW', readStatus: 'valid' },
  ]);
  assert.equal(offer.shippingFeeEvidence.conditions.sellerSaleDeliveryInfo.deliveryChargePolicy, '무료배송');
  assert.equal(offer.shippingFeeEvidence.memberEligibilityVerified, false);
});

test('other conflicting seller shipping amounts remain invalid without a free-shipping promotion', () => {
  const mutateCases = [
    selected => { selected.sellerSaleDeliveryInfo.deliveryChargePolicy = '판매자 배송'; },
    selected => { selected.vendorItemSaleInfo.vendorItemDelivery.deliveryChargeType = 'CONDITIONAL_FREE'; },
    selected => { selected.vendorItemSaleInfo.vendorItemDelivery.freeShipOverAmount = 19_801; },
    selected => { selected.vendorItemSaleInfo.deliveryFee.shippingFee = 2600; },
  ];
  for (const mutate of mutateCases) {
    const payload = offerListPayload();
    const selected = payload.data.vendorItems[0];
    selected.vendorItemSaleInfo.salePrice = 19_900;
    selected.vendorItemSaleInfo.i18nSalePrice = { amount: '19900', rawAmount: 19_900, fractionDigits: 0, currency: 'KRW' };
    selected.vendorItemSaleInfo.deliveryFee = { shippingFee: 2500 };
    selected.vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = false;
    selected.vendorItemSaleInfo.skuBundleConditionalFreeShippingPrice = 19_800;
    selected.vendorItemSaleInfo.vendorItemDelivery = {
      shippingFee: 2500, rocketWowBadge: false, freeShipOverAmount: 19_800, deliveryChargeType: 'FREE',
    };
    selected.sellerSaleDeliveryInfo = { shippingFee: 0, deliveryChargePolicy: '무료배송' };
    mutate(selected);

    const offer = parseCoupangOfferList(payload, offerListIdentity).selectedOffer;
    assert.equal(offer.shipping, null);
    assert.equal(offer.advertisedShipping, null);
    assert.equal(offer.shippingReadStatus, 'invalid');
    assert.equal(offer.shippingConditionsReadStatus, 'valid');
    assert.equal(offer.shippingFeeEvidence.feeCandidates.length, 3);
  }
});

test('keeps valid offer prices but makes malformed or conflicting shipping unusable', () => {
  const conflict = offerListPayload();
  conflict.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 3000 };
  conflict.data.vendorItems[0].vendorItemSaleInfo.vendorItemDelivery = { shippingFee: 2500 };
  conflict.data.vendorItems[0].sellerSaleDeliveryInfo = { shippingFee: 3000 };
  const conflicted = parseCoupangOfferList(conflict, offerListIdentity).selectedOffer;
  assert.equal(conflicted.price.amount, 19480);
  assert.equal(conflicted.shipping, null);
  assert.equal(conflicted.advertisedShipping, null);
  assert.equal(conflicted.shippingReadStatus, 'invalid');

  const actualConflictingConcepts = offerListPayload();
  actualConflictingConcepts.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 2500 };
  actualConflictingConcepts.data.vendorItems[0].vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = false;
  actualConflictingConcepts.data.vendorItems[0].vendorItemSaleInfo.skuBundleConditionalFreeShippingPrice = 19800;
  actualConflictingConcepts.data.vendorItems[0].vendorItemSaleInfo.vendorItemDelivery = { shippingFee: 2500, freeShipOverAmount: 19800 };
  actualConflictingConcepts.data.vendorItems[0].sellerSaleDeliveryInfo = { shippingFee: 0 };
  const actualConflict = parseCoupangOfferList(actualConflictingConcepts, offerListIdentity).selectedOffer;
  assert.equal(actualConflict.price.amount, 19480);
  assert.equal(actualConflict.shipping, null);
  assert.equal(actualConflict.advertisedShipping, null);
  assert.equal(actualConflict.shippingReadStatus, 'invalid');
  assert.deepEqual(actualConflict.shippingFeeEvidence.feeCandidates.map(candidate => [candidate.sourcePath, candidate.amount]), [
    ['vendorItemSaleInfo.deliveryFee.shippingFee', 2500],
    ['vendorItemSaleInfo.vendorItemDelivery.shippingFee', 2500],
    ['sellerSaleDeliveryInfo.shippingFee', 0],
  ]);
  assert.equal(actualConflict.shippingFeeEvidence.conditionsReadStatus, 'valid');

  for (const malformed of [-1, 3000.5, '3000', Number.MAX_SAFE_INTEGER + 1]) {
    const payload = offerListPayload();
    payload.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: malformed };
    const offer = parseCoupangOfferList(payload, offerListIdentity).selectedOffer;
    assert.equal(offer.price.amount, 19480);
    assert.equal(offer.shipping, null);
    assert.equal(offer.advertisedShipping, null);
    assert.equal(offer.shippingReadStatus, 'invalid');
    if (malformed === '3000') {
      assert.deepEqual(offer.shippingFeeEvidence.feeCandidates[0], {
        sourcePath: 'vendorItemSaleInfo.deliveryFee.shippingFee',
        amount: null, currency: 'KRW', readStatus: 'invalid', valueType: 'string',
      });
    }
  }
});

test('malformed public free-shipping conditions never promote a zero fee to free shipping', () => {
  const malformedCases = [
    payload => { payload.data.vendorItems[0].vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = 'true'; },
    payload => { payload.data.vendorItems[0].vendorItemSaleInfo.skuBundleConditionalFreeShippingPrice = '19800'; },
    payload => { payload.data.vendorItems[0].vendorItemSaleInfo.vendorItemDelivery = { rocketWowBadge: 'false' }; },
    payload => { payload.data.vendorItems[0].vendorItemSaleInfo.vendorItemDelivery = { freeShipOverAmount: -1 }; },
    payload => { payload.data.vendorItems[0].vendorItemSaleInfo.vendorItemDelivery = { deliveryChargeType: 'FREE<' }; },
    payload => { payload.data.vendorItems[0].sellerSaleDeliveryInfo = { deliveryChargePolicy: ['FREE'] }; },
  ];

  for (const mutate of malformedCases) {
    const payload = offerListPayload();
    payload.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 0 };
    mutate(payload);
    const offer = parseCoupangOfferList(payload, offerListIdentity).selectedOffer;
    assert.equal(offer.shipping, null);
    assert.equal(offer.advertisedShipping, null);
    assert.equal(offer.shippingReadStatus, 'invalid');
    assert.equal(offer.shippingConditionsReadStatus, 'invalid');
  }

  const positiveFeeWithMalformedCondition = offerListPayload();
  positiveFeeWithMalformedCondition.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 2500 };
  positiveFeeWithMalformedCondition.data.vendorItems[0].vendorItemSaleInfo.vendorItemDelivery = { rocketWowBadge: 'false' };
  const positive = parseCoupangOfferList(positiveFeeWithMalformedCondition, offerListIdentity).selectedOffer;
  assert.equal(positive.shipping.fee.amount, 2500);
  assert.equal(positive.shipping.sourceScope, 'consumer_public_offer_list');
  assert.equal(positive.shipping.memberEligibilityVerified, false);
  assert.equal(positive.shippingReadStatus, 'verified');
  assert.equal(positive.shippingConditionsReadStatus, 'invalid');
});

test('public advertised shipping keeps only bounded observed condition fields and never claims member eligibility', () => {
  const payload = offerListPayload();
  const selected = payload.data.vendorItems[0];
  selected.vendorItemSaleInfo.deliveryFee = { shippingFee: 0 };
  selected.vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = true;
  selected.vendorItemSaleInfo.unobservedSecret = 'CONDITION_SECRET_SENTINEL';
  selected.vendorItemSaleInfo.vendorItemDelivery = {
    rocketWowBadge: true, freeShipOverAmount: 19800, deliveryChargeType: 'ROCKET_WOW',
    unobservedSecret: 'DELIVERY_SECRET_SENTINEL',
  };
  selected.sellerSaleDeliveryInfo = {
    deliveryChargePolicy: 'MEMBER_FREE_SHIPPING <em>policy</em> https://example.invalid/token?secret=POLICY_URL_SENTINEL',
    unobservedSecret: 'SELLER_SECRET_SENTINEL',
  };
  const offer = parseCoupangOfferList(payload, offerListIdentity).selectedOffer;
  assert.equal(offer.advertisedShipping.fee.amount, 0);
  assert.equal(offer.advertisedShipping.memberEligibilityVerified, false);
  assert.equal(offer.advertisedShipping.sourceScope, 'consumer_public_offer_list');
  assert.equal(offer.advertisedShipping.conditions.sellerSaleDeliveryInfo.deliveryChargePolicy,
    'MEMBER_FREE_SHIPPING policy [URL]');
  const serialized = JSON.stringify(offer.advertisedShipping);
  for (const secret of ['CONDITION_SECRET_SENTINEL', 'DELIVERY_SECRET_SENTINEL', 'SELLER_SECRET_SENTINEL', 'POLICY_URL_SENTINEL'])
    assert.equal(serialized.includes(secret), false);
});

test('offer-list rejects stale application status, target identity drift, and selected-row conflicts', () => {
  const badStatus = offerListPayload(); badStatus.data.status = 403;
  assert.throws(() => parseCoupangOfferList(badStatus, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_SCHEMA' });
  const wrongProduct = offerListPayload(); wrongProduct.data.vendorItems[1].productId = '1';
  assert.throws(() => parseCoupangOfferList(wrongProduct, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY' });
  const wrongItem = offerListPayload(); wrongItem.data.vendorItems[1].itemId = '1';
  assert.throws(() => parseCoupangOfferList(wrongItem, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY' });
  const wrongNestedVendor = offerListPayload(); wrongNestedVendor.data.vendorItems[0].vendorItemSaleInfo.vendorItemId = '2';
  wrongNestedVendor.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 3000 };
  assert.throws(() => parseCoupangOfferList(wrongNestedVendor, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY' });
  const noSelection = offerListPayload(); noSelection.data.vendorItems[0].selected = false;
  assert.throws(() => parseCoupangOfferList(noSelection, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY' });
  const doubleSelection = offerListPayload(); doubleSelection.data.vendorItems[1].selected = true;
  assert.throws(() => parseCoupangOfferList(doubleSelection, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY' });
  const selectedDrift = offerListPayload(); selectedDrift.data.vendorItems[0].vendorItemId = '90000000000';
  selectedDrift.data.vendorItems[0].vendorItemSaleInfo.vendorItemId = '90000000000';
  assert.throws(() => parseCoupangOfferList(selectedDrift, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_IDENTITY' });
});

test('offer-list sale price requires matching KRW raw and localized amounts and coupon flags', () => {
  const badRaw = offerListPayload(); badRaw.data.vendorItems[0].vendorItemSaleInfo.i18nSalePrice.rawAmount = 19481;
  assert.throws(() => parseCoupangOfferList(badRaw, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_PRICE' });
  const badAmount = offerListPayload(); badAmount.data.vendorItems[0].vendorItemSaleInfo.i18nSalePrice.amount = '19481';
  assert.throws(() => parseCoupangOfferList(badAmount, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_PRICE' });
  const badCurrency = offerListPayload(); badCurrency.data.vendorItems[0].vendorItemSaleInfo.i18nSalePrice.currency = 'USD';
  assert.throws(() => parseCoupangOfferList(badCurrency, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_PRICE' });
  const missingFlags = offerListPayload(); delete missingFlags.data.vendorItems[0].hasCouponDownload;
  assert.throws(() => parseCoupangOfferList(missingFlags, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_SCHEMA' });
  const tooMany = offerListPayload(); tooMany.data.vendorItems = Array.from({ length: 1001 }, (_, index) => ({
    productId: offerListIdentity.productId, itemId: offerListIdentity.itemId, vendorItemId: String(index + 1), selected: false,
  }));
  assert.throws(() => parseCoupangOfferList(tooMany, offerListIdentity), { code: 'COUPANG_CONSUMER_OFFER_LIST_SCHEMA' });
});
