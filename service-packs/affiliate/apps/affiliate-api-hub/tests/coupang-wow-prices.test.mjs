import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoupangConsumerWowPrice } from '../adapters/coupang-wow-prices.mjs';
import { parseCoupangOfferList, parseCoupangQuantityInfo } from '../adapters/coupang-consumer-offers.mjs';

const identity = { productId: '6247736560', itemId: '12646874013', vendorItemId: '79914317500',
  url: 'https://www.coupang.com/vp/products/6247736560?itemId=12646874013&vendorItemId=79914317500' };
const eggIdentity = { productId: '6417848924', itemId: '13792011639', vendorItemId: '81042389208',
  url: 'https://www.coupang.com/vp/products/6417848924?itemId=13792011639&vendorItemId=81042389208' };
const checkedAt = '2026-10-04T12:00:00.000Z';
const states = { captured: true, client_exists: true, remnant_free: true, credential_propagated: false, live_replay: true };
const offerListReceipt = identity => ({ checkedAt, operation: 'offer_list', method: 'GET', origin: 'https://www.coupang.com',
  path: '/next-api/offer-list', query: { productId: identity.productId, itemId: identity.itemId,
    selectedVendorItemId: identity.vendorItemId }, status: 200, execution: 'pure_http', browserUsed: false,
  authenticationMode: 'visitor', transport: 'native_fetch', credentialSent: false,
  credentialPropagated: false, ownerCredentialUsed: false });
const quantityReceipt = (identity, overrides = {}) => ({ checkedAt, operation: 'quantity_info', method: 'GET',
  origin: 'https://www.coupang.com', path: '/next-api/products/quantity-info',
  query: { productId: identity.productId, vendorItemId: identity.vendorItemId }, status: 200,
  execution: 'pure_http', browserUsed: false, authenticationMode: 'protected', transport: 'native_fetch',
  credentialSent: true, credentialPropagated: true, ...overrides });
const publicPayload = () => ({ data: { status: 200, vendorItems: [{ ...identity, selected: true,
  hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: true,
  vendorItemSaleInfo: { itemId: identity.itemId, vendorItemId: identity.vendorItemId,
    salePrice: 13200, i18nSalePrice: { amount: '13200', rawAmount: 13200, fractionDigits: 0, currency: 'KRW' },
    couponPrice: null, i18nCouponPrice: null, displayOriginPrice: '19,900',
    i18nDisplayOriginPrice: { amount: '19900', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
    deliveryFee: { shippingFee: 2500 } } }] } });
const publicResult = () => ({ ...parseCoupangOfferList(publicPayload(), identity),
  receipt: offerListReceipt(identity), states: { ...states } });
const accountPayload = () => [{ quantity: 1, priceUnit: '원', price: {
  salePrice: '13,200', couponPrice: '11,200', finalPrice: '11,200', originPrice: '19,900',
  i18nSalePrice: { amount: '13200', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  i18nCouponPrice: { amount: '11200', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  wowCouponDiscount: true, instantDiscount: false, hasNormalCouponDiscount: false },
  shippingFee: { shippingFeeType: 'FREE', shippingFee: '0' } }];
// Sanitized Canary browser-observed fixture for the exact SKU; this is not a native HTTP replay.
const browserObservedWowInstantPayload = () => [{ quantity: 1, priceUnit: '원', price: {
  salePrice: '13,200', couponPrice: '11,200', finalPrice: '11,200', originPrice: '19,900',
  i18nSalePrice: { amount: '13200', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  i18nCouponPrice: { amount: '11200', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  wowCouponDiscount: false, instantDiscount: true, hasNormalCouponDiscount: false,
  hasWowCouponDiscount: false, hasNormalInstantDiscount: false, hasWowInstantDiscount: true,
  couponPriceTitle: '와우할인' },
  shippingFee: { shippingFeeType: 'FREE', shippingFee: '0' } }];
const accountResult = () => ({ offer: parseCoupangQuantityInfo(accountPayload(), identity),
  receipt: quantityReceipt(identity),
  states: { ...states, credential_propagated: true } });
const browserObservedAccountResult = payload => ({ offer: parseCoupangQuantityInfo(payload, identity),
  receipt: quantityReceipt(identity, { execution: 'browser_observation', browserUsed: true,
    transport: 'browser_observed_fixture', credentialSent: false, credentialPropagated: false }),
  states: { ...states, credential_propagated: false, live_replay: false } });
const options = overrides => ({ url: identity.url, publicReader: async () => publicResult(),
  accountReader: async () => accountResult(), providerStatus: () => ({ usableForAttempt: true }), ...overrides });
const eggPublicPayload = () => ({ data: { status: 200, vendorItems: [{
  ...eggIdentity, selected: true, hasCouponDownload: false, hasAppreciationCoupon: false,
  hasNoneAppreciationCoupon: true,
  vendorItemSaleInfo: { itemId: eggIdentity.itemId, vendorItemId: eggIdentity.vendorItemId,
    salePrice: 8690, i18nSalePrice: { amount: '8690', rawAmount: 8690, fractionDigits: 0, currency: 'KRW' },
    couponPrice: null, i18nCouponPrice: null, displayOriginPrice: '8,690',
    i18nDisplayOriginPrice: { amount: '8690', rawAmount: null, fractionDigits: 0, currency: 'KRW' } },
}] } });
const eggPublicResult = () => ({ ...parseCoupangOfferList(eggPublicPayload(), eggIdentity),
  receipt: offerListReceipt(eggIdentity),
  states: { ...states } });
// Sanitized browser-observed fixture for the egg SKU; it is deliberately kept non-native in tests.
const browserObservedEggQuantityPayload = () => [{ quantity: 1, priceUnit: '원', price: {
  salePrice: null, i18nSalePrice: null, originPrice: '8,690',
  i18nOriginPrice: { amount: '8690', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  couponPrice: '7,590', i18nCouponPrice: { amount: '7590', rawAmount: null, fractionDigits: 0, currency: 'KRW' },
  finalPrice: '7,590', wowCouponDiscount: false, instantDiscount: true,
  hasNormalCouponDiscount: false, hasWowCouponDiscount: false,
  hasNormalInstantDiscount: false, hasWowInstantDiscount: true,
}, shippingFee: { shippingFeeType: 'FREE', shippingFee: '0' } }];
const browserObservedEggAccountResult = (payload = browserObservedEggQuantityPayload()) => ({
  offer: parseCoupangQuantityInfo(payload, eggIdentity),
  receipt: quantityReceipt(eggIdentity, { execution: 'browser_observation', browserUsed: true,
    transport: 'browser_observed_fixture', credentialSent: false, credentialPropagated: false }),
  states: { ...states, credential_propagated: false, live_replay: false },
});
const nativeEggAccountResult = (payload = browserObservedEggQuantityPayload()) => ({
  offer: parseCoupangQuantityInfo(payload, eggIdentity), receipt: quantityReceipt(eggIdentity),
  states: { ...states, credential_propagated: true },
});
const eggOptions = overrides => ({ url: eggIdentity.url, publicReader: async () => eggPublicResult(),
  accountReader: async () => browserObservedEggAccountResult(),
  providerStatus: () => ({ usableForAttempt: true }), ...overrides });

test('live-public fixture keeps 13200 general and 19900 original with WOW explicitly unavailable', () => {
  const selected = parseCoupangOfferList(publicPayload(), identity).selectedOffer;
  assert.equal(selected.price.amount, 13200);
  assert.equal(selected.priceComponents.displayedOriginalPrice.amount, 19900);
  assert.equal(selected.advertisedWowPrice, null);
  assert.equal(selected.priceComponents.advertisedCouponPrice, null);
  assert.equal(selected.wowPriceReadStatus, 'not_exposed_by_public_offer_list');
  assert.equal(selected.memberPriceVerified, false);
});

test('missing protected provider does not call quantity reader or pass general as WOW', async () => {
  let calls = 0;
  const result = await readCoupangConsumerWowPrice(options({
    providerStatus: () => ({ usableForAttempt: false, code: 'SESSION_PROVIDER_MISSING' }),
    accountReader: async () => { calls++; return accountResult(); },
  }));
  assert.equal(calls, 0);
  assert.equal(result.selectedOffer.price.amount, 13200);
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.pricePaths.publicGeneral.live_replay, true);
  assert.equal(result.pricePaths.accountWow.live_replay, false);
  assert.equal(result.states.live_replay, false);
  assert.equal(result.accountContextPriceRead.status, 'provider_missing');
  assert.equal(result.selectedOffer.publicShippingFee, 2500);
  assert.equal(result.selectedOffer.accountContextShipping, null);
  assert.equal(result.selectedOffer.accountContextShippingReadStatus, 'provider_missing');
  assert.equal(result.selectedOffer.memberShippingFee, null);
  assert.equal(result.selectedOffer.memberShippingVerified, false);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
});

test('public conditional shipping remains advertised without being converted to verified public or member shipping', async () => {
  const payload = publicPayload();
  payload.data.vendorItems[0].vendorItemSaleInfo.deliveryFee = { shippingFee: 0 };
  payload.data.vendorItems[0].vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = true;
  const publicResultWithConditionalShipping = () => ({
    ...parseCoupangOfferList(payload, identity), receipt: offerListReceipt(identity), states: { ...states },
  });
  const result = await readCoupangConsumerWowPrice(options({
    publicReader: async () => publicResultWithConditionalShipping(),
    providerStatus: () => ({ usableForAttempt: false, code: 'SESSION_PROVIDER_MISSING' }),
  }));
  assert.equal(result.selectedOffer.shipping, null);
  assert.equal(result.selectedOffer.publicShipping, null);
  assert.equal(result.selectedOffer.publicShippingFee, null);
  assert.equal(result.selectedOffer.advertisedShipping.memberEligibilityVerified, false);
  assert.equal(result.selectedOffer.advertisedShipping.fee.amount, 0);
  assert.equal(result.selectedOffer.memberShippingFee, null);
  assert.equal(result.selectedOffer.memberShippingVerified, false);
});

test('explicit native account WOW flag retains both prices and does not assert membership eligibility', async () => {
  const result = await readCoupangConsumerWowPrice(options());
  assert.equal(result.selectedOffer.price.amount, 13200);
  assert.equal(result.selectedOffer.accountGeneralPriceMatchesPublic, true);
  assert.equal(result.selectedOffer.accountContextSalePriceReadStatus, 'matched');
  assert.equal(result.selectedOffer.wowGeneralBoundSource, null);
  assert.equal(result.selectedOffer.advertisedWowPrice.amount, 11200);
  assert.equal(result.selectedOffer.advertisedWowPrice.source, 'coupang_quantity_info');
  assert.equal(result.selectedOffer.advertisedWowPrice.eligibilityVerified, false);
  assert.equal(result.selectedOffer.advertisedWowPrice.requiresMembership, true);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'verified_advertised_wow_price');
  assert.equal(result.selectedOffer.shipping.fee.amount, 2500);
  assert.equal(result.selectedOffer.publicShipping.fee.amount, 2500);
  assert.equal(result.selectedOffer.publicShippingFee, 2500);
  assert.deepEqual(result.selectedOffer.accountContextShipping, {
    fee: { amount: 0, currency: 'KRW', priceKind: 'account_context_shipping_fee' },
    type: 'FREE', originalFee: null, sourceScope: 'consumer_account_price', quantity: 1,
    memberEligibilityVerified: false,
  });
  assert.equal(result.selectedOffer.accountContextShippingReadStatus, 'verified_account_context');
  assert.equal(result.selectedOffer.accountContextShippingVerified, true);
  assert.equal(result.selectedOffer.memberShippingFee, null);
  assert.equal(result.selectedOffer.memberShippingVerified, false);
  assert.equal(result.states.live_replay, true);
  assert.equal(result.ok, true);
});

test('native account WOW price is held when account sale price disagrees with public general price', async () => {
  const payload = accountPayload();
  payload[0].price.salePrice = '14,000';
  payload[0].price.i18nSalePrice = { amount: '14000', rawAmount: null, fractionDigits: 0, currency: 'KRW' };
  const account = accountResult();
  account.offer = parseCoupangQuantityInfo(payload, identity);
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));

  assert.equal(result.selectedOffer.price.amount, 13200);
  assert.equal(result.selectedOffer.accountGeneralPriceMatchesPublic, false);
  assert.equal(result.selectedOffer.wowGeneralBoundSource, null);
  assert.equal(result.selectedOffer.accountContextPriceComponents.salePrice.amount, 14000);
  assert.equal(result.selectedOffer.accountContextPriceComponents.couponPrice.amount, 11200);
  assert.equal(result.selectedOffer.discountContext.wowCouponDiscount, true);
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'account_general_price_mismatch');
  assert.equal(result.accountContextPriceRead.receipt.status, 200);
  assert.equal(result.accountContextPriceRead.receipt.transport, 'native_fetch');
  assert.equal(result.pricePaths.publicGeneral.live_replay, true);
  assert.equal(result.pricePaths.accountWow.live_replay, false);
  assert.equal(result.states.live_replay, false);
  assert.equal(result.partial, true);
  assert.equal(result.ok, false);
});

test('paired-null account sale uses only the same-run native public general price as its bound', async () => {
  const account = browserObservedEggAccountResult();
  const result = await readCoupangConsumerWowPrice(eggOptions({ accountReader: async () => account }));

  assert.equal(result.selectedOffer.price.amount, 8690);
  assert.equal(result.selectedOffer.accountContextPriceComponents.salePrice, null);
  assert.equal(result.selectedOffer.accountContextPriceComponents.couponPrice.amount, 7590);
  assert.equal(result.selectedOffer.accountContextPriceComponents.finalPrice.amount, 7590);
  assert.equal(result.selectedOffer.accountContextSalePriceReadStatus, 'explicitly_null');
  assert.equal(result.selectedOffer.accountGeneralPriceMatchesPublic, null);
  assert.equal(result.selectedOffer.wowGeneralBoundSource, 'public_offer_list_fallback');
  assert.equal(result.selectedOffer.advertisedWowPrice.amount, 7590);
  assert.equal(result.selectedOffer.advertisedWowPrice.wowInstantDiscountApplied, true);
  assert.equal(result.selectedOffer.advertisedWowPrice.requiresMembership, true);
  assert.equal(result.selectedOffer.advertisedWowPrice.eligibilityVerified, false);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'parsed_account_wow_price');
  assert.deepEqual(result.selectedOffer.accountContextShipping, {
    fee: { amount: 0, currency: 'KRW', priceKind: 'account_context_shipping_fee' },
    type: 'FREE', originalFee: null, sourceScope: 'consumer_account_price', quantity: 1,
    memberEligibilityVerified: false,
  });
  assert.equal(result.selectedOffer.accountContextShippingReadStatus, 'parsed_account_context');
  assert.equal(result.selectedOffer.accountContextShippingVerified, false);
  assert.equal(result.selectedOffer.memberShippingFee, null);
  assert.equal(result.selectedOffer.memberShippingVerified, false);
  assert.equal(result.accountContextPriceRead.receipt.transport, 'browser_observed_fixture');
  assert.equal(result.pricePaths.publicGeneral.live_replay, true);
  assert.equal(result.pricePaths.accountWow.live_replay, false);
  assert.equal(result.states.live_replay, false);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
});

test('paired-null account sale cannot use a non-native or incomplete public general result as its bound', async () => {
  const mutations = [
    result => { result.receipt.transport = 'browser_observed_fixture'; },
    result => { result.receipt.execution = 'browser_observation'; },
    result => { result.receipt.browserUsed = true; },
    result => { result.receipt.ownerCredentialUsed = true; },
    result => { result.receipt.credentialSent = true; },
    result => { result.receipt.operation = 'product_document'; },
    result => { result.receipt.path = '/vp/products/6417848924'; },
    result => { result.receipt.method = 'POST'; },
    result => { result.receipt.query.selectedVendorItemId = identity.vendorItemId; },
    result => { result.receipt.checkedAt = 'not-a-time'; },
    result => { result.receipt.status = 403; },
    result => { result.states.live_replay = false; },
    result => { result.states.captured = false; },
    result => { result.states.client_exists = false; },
    result => { result.states.remnant_free = false; },
    result => { result.receipt.credentialPropagated = true; result.states.credential_propagated = true; },
    result => { result.selectedOffer.price.priceKind = 'account_context_final_price'; },
    result => { result.selectedOffer.price.basis = 'account_context'; },
  ];
  for (const mutate of mutations) {
    const publicResponse = eggPublicResult();
    mutate(publicResponse);
    const result = await readCoupangConsumerWowPrice(eggOptions({
      publicReader: async () => publicResponse,
      accountReader: async () => browserObservedEggAccountResult(),
    }));
    assert.equal(result.selectedOffer.price.amount, 8690);
    assert.equal(result.selectedOffer.accountGeneralPriceMatchesPublic, null);
    assert.equal(result.selectedOffer.wowGeneralBoundSource, null);
    assert.equal(result.selectedOffer.advertisedWowPrice, null);
    assert.equal(result.selectedOffer.wowPriceReadStatus, 'public_general_fallback_unverified');
    assert.equal(result.states.live_replay, false);
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
  }
});

test('paired-null native quantity price verifies only with exact request receipts on both paths', async () => {
  const account = nativeEggAccountResult();
  const result = await readCoupangConsumerWowPrice(eggOptions({ accountReader: async () => account }));

  assert.equal(result.selectedOffer.accountContextPriceComponents.salePrice, null);
  assert.equal(result.selectedOffer.accountContextSalePriceReadStatus, 'explicitly_null');
  assert.equal(result.selectedOffer.accountGeneralPriceMatchesPublic, null);
  assert.equal(result.selectedOffer.wowGeneralBoundSource, 'public_offer_list_fallback');
  assert.equal(result.selectedOffer.advertisedWowPrice.amount, 7590);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'verified_advertised_wow_price');
  assert.equal(result.pricePaths.accountWow.live_replay, true);
  assert.equal(result.states.live_replay, true);
  assert.equal(result.ok, true);

  const badAccount = nativeEggAccountResult();
  badAccount.receipt.query.productId = identity.productId;
  const rejected = await readCoupangConsumerWowPrice(eggOptions({ accountReader: async () => badAccount }));
  assert.equal(rejected.selectedOffer.advertisedWowPrice, null);
  assert.equal(rejected.selectedOffer.wowPriceReadStatus, 'account_wow_price_blocked');
  assert.equal(rejected.accountContextPriceRead.code, 'COUPANG_WOW_ACCOUNT_IDENTITY');
  assert.equal(rejected.pricePaths.accountWow.live_replay, false);
  assert.equal(rejected.states.live_replay, false);
  assert.equal(rejected.ok, false);
});

test('paired-null native quantity price is not verified when account receipt indicates browser execution', async () => {
  for (const mutate of [
    receipt => { receipt.browserUsed = true; },
    receipt => { receipt.execution = 'browser_observation'; },
  ]) {
    const account = nativeEggAccountResult();
    mutate(account.receipt);
    const result = await readCoupangConsumerWowPrice(eggOptions({ accountReader: async () => account }));
    assert.equal(result.selectedOffer.advertisedWowPrice.amount, 7590);
    assert.equal(result.selectedOffer.wowPriceReadStatus, 'parsed_account_wow_price');
    assert.equal(result.pricePaths.accountWow.live_replay, false);
    assert.equal(result.states.live_replay, false);
    assert.equal(result.ok, false);
  }
});

test('paired-null sale requires valid WOW flags and a positive final price bounded by coupon and public general', async () => {
  const mutations = [
    payload => { payload[0].price.finalPrice = '7591'; },
    payload => {
      payload[0].price.couponPrice = '9,000';
      payload[0].price.i18nCouponPrice.amount = '9000';
    },
    payload => {
      payload[0].price.couponPrice = '8,690';
      payload[0].price.i18nCouponPrice.amount = '8690';
      payload[0].price.finalPrice = '8,690';
    },
    payload => { payload[0].price.finalPrice = '0'; },
    payload => {
      payload[0].price.hasWowInstantDiscount = false;
      payload[0].price.hasNormalInstantDiscount = true;
    },
  ];
  for (const mutate of mutations) {
    const payload = browserObservedEggQuantityPayload();
    mutate(payload);
    const result = await readCoupangConsumerWowPrice(eggOptions({
      accountReader: async () => browserObservedEggAccountResult(payload),
    }));
    assert.equal(result.selectedOffer.price.amount, 8690);
    assert.equal(result.selectedOffer.accountGeneralPriceMatchesPublic, null);
    assert.equal(result.selectedOffer.wowGeneralBoundSource, 'public_offer_list_fallback');
    assert.equal(result.selectedOffer.advertisedWowPrice, null);
    assert.equal(result.pricePaths.accountWow.live_replay, false);
    assert.equal(result.states.live_replay, false);
    assert.equal(result.ok, false);
  }
});

test('browser-observed WOW instant flag recognizes 11200 while keeping browser evidence separate', async () => {
  const payload = browserObservedWowInstantPayload();
  const account = browserObservedAccountResult(payload);
  assert.deepEqual(account.offer.discountContext, {
    wowCouponDiscount: false,
    instantDiscount: true,
    hasNormalCouponDiscount: false,
    hasWowCouponDiscount: false,
    hasNormalInstantDiscount: false,
    hasWowInstantDiscount: true,
    wowCouponDiscountReadStatus: 'valid',
    instantDiscountReadStatus: 'valid',
    hasNormalCouponDiscountReadStatus: 'valid',
    hasWowCouponDiscountReadStatus: 'valid',
    hasNormalInstantDiscountReadStatus: 'valid',
    hasWowInstantDiscountReadStatus: 'valid',
    readStatus: 'valid',
  });
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
  assert.equal(result.selectedOffer.price.amount, 13200);
  assert.equal(result.selectedOffer.advertisedWowPrice.amount, 11200);
  assert.equal(result.selectedOffer.advertisedWowPrice.wowCouponDiscountApplied, false);
  assert.equal(result.selectedOffer.advertisedWowPrice.wowInstantDiscountApplied, true);
  assert.equal(result.selectedOffer.advertisedWowPrice.normalInstantDiscountApplied, false);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'parsed_account_wow_price');
  assert.equal(result.states.live_replay, false);
  assert.equal(result.ok, false);
});

test('normal instant discount alone never qualifies as WOW price', async () => {
  const payload = browserObservedWowInstantPayload();
  payload[0].price.hasWowInstantDiscount = false;
  payload[0].price.hasNormalInstantDiscount = true;
  const account = browserObservedAccountResult(payload);
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
  assert.equal(result.selectedOffer.discountContext.hasNormalInstantDiscount, true);
  assert.equal(result.selectedOffer.discountContext.hasWowInstantDiscount, false);
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'no_wow_discount_in_account_response');
  assert.equal(result.states.live_replay, false);
});

test('malformed optional WOW flag invalidates account discount context', async () => {
  const payload = browserObservedWowInstantPayload();
  payload[0].price.hasWowInstantDiscount = 'true';
  const account = browserObservedAccountResult(payload);
  assert.equal(account.offer.discountContext.hasWowInstantDiscount, null);
  assert.equal(account.offer.discountContext.hasWowInstantDiscountReadStatus, 'invalid');
  assert.equal(account.offer.discountContext.readStatus, 'invalid');
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.selectedOffer.wowPriceReadStatus, 'unverified_account_wow_price');
  assert.equal(result.states.live_replay, false);
});

test('WOW instant flag contradicting aggregate discount cannot pass when another detail flag is absent', async () => {
  const payload = browserObservedWowInstantPayload();
  payload[0].price.instantDiscount = false;
  delete payload[0].price.hasNormalInstantDiscount;
  const account = browserObservedAccountResult(payload);
  assert.equal(account.offer.discountContext.readStatus, 'invalid');
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.ok, false);
});

test('coupon amount without an explicit WOW flag cannot satisfy WOW collection', async () => {
  for (const flag of [false, null, undefined, 'true']) {
    const payload = accountPayload();
    if (flag === undefined) delete payload[0].price.wowCouponDiscount;
    else payload[0].price.wowCouponDiscount = flag;
    const account = accountResult(); account.offer = parseCoupangQuantityInfo(payload, identity);
    const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
    assert.equal(result.selectedOffer.advertisedWowPrice, null);
    assert.equal(result.pricePaths.accountWow.live_replay, false);
  }
});

test('injected or unpropagated account read stays parsed rather than native verified', async () => {
  for (const receiptChange of [{ transport: 'injected' }, { credentialPropagated: false }, { status: 403 }]) {
    const account = accountResult(); Object.assign(account.receipt, receiptChange);
    const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
    assert.equal(result.selectedOffer.wowPriceReadStatus, 'parsed_account_wow_price');
    assert.equal(result.states.live_replay, false);
  }
});

test('wrong account variant cannot contaminate the selected general or WOW price', async () => {
  const account = accountResult(); account.offer.itemId = '12646874014';
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
  assert.equal(result.accountContextPriceRead.code, 'COUPANG_WOW_ACCOUNT_IDENTITY');
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.selectedOffer.price.amount, 13200);
});

test('matching identity with another source or operation cannot be promoted to quantity WOW evidence', async () => {
  for (const field of ['sourceScope', 'operation']) {
    const account = accountResult();
    if (field === 'sourceScope') account.offer.sourceScope = 'consumer_other_seller_offers';
    else account.receipt.operation = 'other_sellers';
    const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
    assert.equal(result.selectedOffer.advertisedWowPrice, null);
    assert.equal(result.accountContextPriceRead.code, 'COUPANG_WOW_ACCOUNT_IDENTITY');
    assert.equal(result.ok, false);
  }
});

test('account rejection is held without retries and does not erase general evidence', async () => {
  let calls = 0;
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => {
    calls++; throw Object.assign(new Error('COUPANG_CONSUMER_ACCESS_BLOCKED'),
      { code: 'COUPANG_CONSUMER_ACCESS_BLOCKED', receipt: { status: 403, credentialPropagated: true } });
  } }));
  assert.equal(calls, 1);
  assert.equal(result.selectedOffer.price.amount, 13200);
  assert.equal(result.accountContextPriceRead.receipt.status, 403);
  assert.equal(result.selectedOffer.publicShippingFee, 2500);
  assert.equal(result.selectedOffer.accountContextShipping, null);
  assert.equal(result.selectedOffer.accountContextShippingReadStatus, 'blocked_account_shipping');
  assert.equal(result.selectedOffer.accountContextShippingVerified, false);
  assert.equal(result.selectedOffer.memberShippingFee, null);
  assert.equal(result.selectedOffer.memberShippingVerified, false);
  assert.equal(result.pricePaths.accountWow.credential_propagated, true);
  assert.equal(result.states.credential_propagated, true);
  assert.equal(result.selectedOffer.advertisedWowPrice, null);
  assert.equal(result.states.live_replay, false);
});

test('account shipping is sanitized and invalid fee context is never exposed as verified or member eligible', async () => {
  const account = accountResult();
  account.offer.shipping = {
    fee: { amount: 0, currency: 'USD', priceKind: 'account_context_shipping_fee' },
    type: 'FREE', originalFee: null, privateSentinel: 'PRIVATE_SHIPPING_SENTINEL',
  };
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
  assert.equal(result.selectedOffer.publicShippingFee, 2500);
  assert.equal(result.selectedOffer.accountContextShipping, null);
  assert.equal(result.selectedOffer.accountContextShippingReadStatus, 'invalid_account_context_shipping');
  assert.equal(result.selectedOffer.accountContextShippingVerified, false);
  assert.equal(result.selectedOffer.memberShippingFee, null);
  assert.equal(result.selectedOffer.memberShippingVerified, false);
  assert.equal(JSON.stringify(result.selectedOffer).includes('PRIVATE_SHIPPING_SENTINEL'), false);
});

test('valid account shipping exposes only the fee, type, and original fee allowlist', async () => {
  const account = accountResult();
  account.offer.shipping.privateSentinel = 'PRIVATE_SHIPPING_SENTINEL';
  const result = await readCoupangConsumerWowPrice(options({ accountReader: async () => account }));
  assert.deepEqual(Object.keys(result.selectedOffer.accountContextShipping).sort(), [
    'fee', 'memberEligibilityVerified', 'originalFee', 'quantity', 'sourceScope', 'type',
  ]);
  assert.equal(JSON.stringify(result.selectedOffer).includes('PRIVATE_SHIPPING_SENTINEL'), false);
  assert.equal(result.selectedOffer.accountContextShippingVerified, true);
  assert.equal(result.selectedOffer.memberShippingVerified, false);
});

test('malformed optional coupon/original does not erase general or become a WOW claim', () => {
  const payload = publicPayload();
  payload.data.vendorItems[0].vendorItemSaleInfo.i18nDisplayOriginPrice.amount = '19901';
  payload.data.vendorItems[0].vendorItemSaleInfo.couponPrice = 'TOKEN_SENTINEL';
  const row = parseCoupangOfferList(payload, identity).selectedOffer;
  assert.equal(row.originalPriceReadStatus, 'invalid');
  assert.equal(row.couponPriceReadStatus, 'invalid');
  assert.equal(row.price.amount, 13200);
  assert.equal(row.advertisedWowPrice, null);
  assert.equal(JSON.stringify(row).includes('TOKEN_SENTINEL'), false);
});
