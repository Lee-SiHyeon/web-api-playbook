import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicCoupangGoldbox } from '../research/content-store/coupang-goldbox-public.mjs';
import { collect, main as collectMain } from '../research/content-store/collect.mjs';

const bootstrap = () => new Response('<html><title>web-adapter-proxy</title>getLocalStorage</html>', {
  headers: { 'content-type': 'text/html; charset=utf-8',
    'set-cookie': 'PCID=test-public-visitor; Domain=.coupang.com; Path=/; Secure' },
});

const fetchGoldboxWithoutShipping = (limit, options = {}) => fetchPublicCoupangGoldbox(limit, {
  shippingEnrichmentEnabled: false,
  ...options,
});

const widgetPayload = (list, dataUrl = null) => ({ rCode: 'RET0000', rData: { widgets: [{ type: 'product', props: {
  config: { id: '43145', pageId: 3712 }, data: { list, dataUrl },
} }] }, rMessage: null });

const row = (productId, options = {}) => {
  const itemId = String(Number(productId) + 1000), vendorItemId = String(Number(productId) + 10000);
  return {
    productId: String(productId), itemId, vendorItemId,
    productTitle: `테스트 상품 ${productId}`,
    detailUrl: `https://www.coupang.com/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}`,
    finalPrice: { value: '10,000원', unitPriceText: '(100g당 1,000원)' },
    originalPrice: '12,000원',
    stockRemainingInfo: { isSoldOut: false },
    productImageUrl: 'https://thumbnail.coupangcdn.com/test/image.png',
    ...options,
  };
};

const nextTarget = () => {
  const url = new URL('https://www.coupang.com/vm/mlp/v1/newweb/mlp-widget-landing');
  for (const [key, value] of Object.entries({
    widgetId: '43145', isAsync: 'Y', trafficType: 'organic', landingId: '3712', target: 'MLP_GOLDBOX',
    productOffset: '100', sourceType: 'gm_crm_goldbox', isMLP: 'Y', nextWidgetPageKey: '2', categoryId: '0',
    subSourceType: 'gm_crm_gwsrtcut',
  })) url.searchParams.set(key, value);
  return url.href;
};

const offerPayload = (url, amount = 4321, shipping = {}) => {
  const target = new URL(url);
  const productId = target.searchParams.get('productId');
  const itemId = target.searchParams.get('itemId');
  const vendorItemId = target.searchParams.get('selectedVendorItemId');
  const vendorItemSaleInfo = { itemId, vendorItemId, salePrice: amount,
    i18nSalePrice: { amount: String(amount), rawAmount: amount, fractionDigits: 0, currency: 'KRW' } };
  if (shipping.shippingFee !== undefined) vendorItemSaleInfo.deliveryFee = { shippingFee: shipping.shippingFee };
  if (shipping.vendorItemShippingFee !== undefined || shipping.freeShipOverAmount !== undefined
    || shipping.rocketWowBadge !== undefined || shipping.deliveryChargeType !== undefined) {
    vendorItemSaleInfo.vendorItemDelivery = {
      ...(shipping.vendorItemShippingFee !== undefined ? { shippingFee: shipping.vendorItemShippingFee } : {}),
      ...(shipping.freeShipOverAmount !== undefined ? { freeShipOverAmount: shipping.freeShipOverAmount } : {}),
      ...(shipping.rocketWowBadge !== undefined ? { rocketWowBadge: shipping.rocketWowBadge } : {}),
      ...(shipping.deliveryChargeType !== undefined ? { deliveryChargeType: shipping.deliveryChargeType } : {}),
    };
  }
  if (shipping.skuBundleConditionalFreeShippingPrice !== undefined)
    vendorItemSaleInfo.skuBundleConditionalFreeShippingPrice = shipping.skuBundleConditionalFreeShippingPrice;
  if (shipping.hasSkuBundleConditionalFreeShippingPrice !== undefined)
    vendorItemSaleInfo.hasSkuBundleConditionalFreeShippingPrice = shipping.hasSkuBundleConditionalFreeShippingPrice;
  const vendorItem = { productId, itemId, vendorItemId, selected: true,
    hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: false,
    vendorItemSaleInfo };
  if (shipping.sellerShippingFee !== undefined || shipping.sellerDeliveryChargePolicy !== undefined)
    vendorItem.sellerSaleDeliveryInfo = {
      ...(shipping.sellerShippingFee !== undefined ? { shippingFee: shipping.sellerShippingFee } : {}),
      ...(shipping.sellerDeliveryChargePolicy !== undefined ? { deliveryChargePolicy: shipping.sellerDeliveryChargePolicy } : {}),
    };
  return { data: { status: 200, vendorItems: [vendorItem] } };
};

function createFetch({ pages, offer = () => ({ status: 200, amount: 4321 }), onWidget = null } = {}) {
  const calls = { bootstrap: 0, widget: 0, offer: 0, other: 0 };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/n-api/web-adapter/proxy') {
      calls.bootstrap++;
      return bootstrap();
    }
    if (url.pathname === '/vm/mlp/v1/newweb/mlp-widget-landing') {
      calls.widget++;
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.cookie, 'PCID=test-public-visitor');
      assert.equal(Object.keys(init.headers).some(key => key.toLowerCase() === 'user-agent'), false);
      if (onWidget) return onWidget({ url, init, calls });
      const page = pages.shift();
      assert.ok(page, 'unexpected extra catalog page');
      return new Response(JSON.stringify(widgetPayload(page.rows, page.next)), {
        status: page.status ?? 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    if (url.pathname === '/next-api/offer-list') {
      calls.offer++;
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.cookie, 'PCID=test-public-visitor');
      assert.equal(Object.keys(init.headers).some(key => key.toLowerCase() === 'user-agent'), false);
      const answer = offer(url, calls.offer);
      const headers = { 'content-type': answer.status === 200 ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8' };
      if (answer.server) headers.server = answer.server;
      Object.assign(headers, answer.challengeHeaders ?? {});
      const body = answer.body ?? (answer.status === 200 ? JSON.stringify(offerPayload(url, answer.amount, answer)) : 'Access Denied');
      return new Response(body, {
        status: answer.status,
        headers,
      });
    }
    calls.other++;
    throw new Error(`unexpected mocked request path: ${url.pathname}`);
  };
  return { fetchImpl, calls };
}

test('the maintained collection pipeline uses the public catalog and carries verified price sources without a legacy request', async () => {
  const mock = createFetch({ pages: [{ rows: [row(801, { wowPrice: { label: '할인가', price: '8,000원' } }), row(802)] }],
    offer: () => ({ status: 200, amount: 4321, shippingFee: 2500 }) });
  const config = { schemaVersion: 1, perSourceLimit: 1,
    sources: [{ id: 'goldbox', kind: 'coupang_goldbox', field: 'deals', label: '쿠팡 골드박스' }] };
  const result = await collect(config, { fetchImpl: mock.fetchImpl });
  assert.deepEqual(mock.calls, { bootstrap: 1, widget: 1, offer: 1, other: 0 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].deal.widgetFinalPrice.amount, 10000);
  assert.equal(result.candidates[0].deal.widgetPriceReadStatus, 'matched_widget_general_price');
  assert.equal(result.candidates[0].deal.advertisedWowPrice.amount, 8000);
  assert.equal(result.candidates[0].deal.publicShippingFee, 2500);
  assert.equal(result.candidates[0].deal.shippingReadStatus, 'verified');
  assert.equal(result.candidates[0].deal.publicShippingGeneralPrice.amount, 4321);
  assert.equal(result.candidates[0].deal.publicOfferGeneralPriceComparisonStatus, 'general_price_conflict');
  assert.equal(result.candidates[0].deal.publicOfferGeneralPriceMatchesSelectedGeneralPrice, false);
  assert.equal(result.candidates[0].deal.memberShippingFee, null);
  assert.equal(result.candidates[0].deal.memberShippingVerified, false);
  assert.match(result.candidates[0].summary, /공개 배송비 2,500원 \(회원 적용 배송비 미확인\)/);
  assert.equal(result.sources[0].coverage.rowsWithPublicShippingGeneralPriceConflict, 1);
  assert.equal(result.sources[0].sellerSpecialPriceCollectionStatus, 'unverified');
  assert.equal(result.sources[0].flashSalePriceCollectionStatus, 'unverified');
  assert.equal(result.sources[0].coverage.specialPriceClassificationScope,
    'public_goldbox_widget_wow_price_labels_only');
  assert.equal(result.candidates[0].originalArticleFetched, false);
  assert.equal(result.candidates[0].claimsVerified, false);
  assert.equal(result.sources[0].inventorySource, 'coupang_mlp_goldbox_widget');
  assert.equal(result.sources[0].coverage.catalogUniqueTriples, 2);
  assert.equal(result.sources[0].legacyListingRequested, false);
  assert.equal(result.policy.publicOnly, true);
  assert.equal(Object.hasOwn(result, 'browserPriceObservationUsed'), false);
  assert.equal(result.sources[0].browserUsed, false);
  assert.equal(result.sources[0].execution, 'pure_http');
  assert.equal(Object.hasOwn(result.candidates[0].deal, 'browserObservedWowPrice'), false);
});

test('rejects obsolete browser WOW input before configuration reads or network requests', async () => {
  const obsoleteOptions = [
    '--coupang-wow-observation',
    '--coupang-wow-observation=untrusted-observation.json',
  ];
  for (const option of obsoleteOptions) {
    await assert.rejects(collectMain(['missing-config.json', 'new-output.json', option]),
      { code: 'COUPANG_WOW_OBSERVATION_HTTP_ONLY' });
  }

  const config = { schemaVersion: 1, perSourceLimit: 10,
    sources: [{ id: 'goldbox', kind: 'coupang_goldbox', field: 'deals' }] };
  const directMock = createFetch({ pages: [{ rows: [row(1601)] }] });
  const observation = { productId: '6247736560', browserObservedWowPrice: { amount: 11200 } };
  await assert.rejects(() => collect(config, { fetchImpl: directMock.fetchImpl, coupangWowObservation: observation }),
    { code: 'COUPANG_WOW_OBSERVATION_HTTP_ONLY' });
  await assert.rejects(() => fetchPublicCoupangGoldbox(10, {
    fetchImpl: directMock.fetchImpl,
    coupangWowObservation: observation,
  }), { code: 'COUPANG_WOW_OBSERVATION_HTTP_ONLY' });
  assert.deepEqual(directMock.calls, { bootstrap: 0, widget: 0, offer: 0, other: 0 });
});

test('reads the full catalog, preserves public price rows, separates trip URLs and drops sold-out items after coverage', async () => {
  const ordinary = row(1001, { wowPrice: { label: '할인가', price: '8,000원', boxEnabled: true, dimmed: false } });
  const signup = row(1002, { finalPrice: { value: '9,000원' }, wowPrice: {
    label: '가입 쿠폰가', price: '7,000원', boxEnabled: false, dimmed: true,
  } });
  const trip = row(1003, { detailUrl: 'https://trip.coupang.com/t/opaque-public-route' });
  const soldOut = row(1004, { stockRemainingInfo: { isSoldOut: true } });
  const missingTitle = row(1005, { productTitle: '' });
  const thirdConsumerItem = row(1006, { finalPrice: { value: '8,000원' } });
  const mock = createFetch({ pages: [{ rows: [ordinary, signup, trip, soldOut, missingTitle, thirdConsumerItem] }] });

  const result = await fetchGoldboxWithoutShipping(2, { fetchImpl: mock.fetchImpl, widgetPageDelayMs: 0 });
  assert.equal(mock.calls.bootstrap, 1);
  assert.equal(mock.calls.widget, 1);
  assert.equal(mock.calls.offer, 0);
  assert.equal(result.items.length, 2);
  assert.equal(result.priceRows.length, 6);
  assert.equal(result.priceRows.find(item => item.productId === '1004').soldOut, true);
  assert.equal(result.priceRows.find(item => item.productId === '1004').generalPrice.amount, 10000);
  assert.equal(result.items[0].deal.salePrice, 10000);
  assert.equal(result.items[0].deal.widgetFinalPrice.amount, 10000);
  assert.equal(result.items[0].deal.widgetFinalPriceMatchesListingSalePrice, true);
  assert.equal(result.items[0].deal.advertisedWowPrice.boxEnabled, true);
  assert.equal(result.items[0].deal.advertisedWowPrice.dimmed, false);
  assert.equal(result.items[0].deal.advertisedWowPrice.eligibilityVerified, false);
  assert.equal(result.items[0].deal.wowSalePrice, 8000);
  assert.match(result.items[0].summary, /일반가 10,000원/);
  assert.match(result.items[0].summary, /할인가 8,000원/);
  const conditionalItem = result.items.find(item => item.deal.productId === '1002');
  assert.ok(conditionalItem);
  assert.equal(conditionalItem.deal.salePrice, 9000);
  assert.equal(conditionalItem.deal.wowSalePrice, null);
  assert.equal(conditionalItem.deal.conditionalCouponPrice.amount, 7000);
  assert.equal(conditionalItem.deal.conditionalCouponPrice.boxEnabled, false);
  assert.equal(conditionalItem.deal.conditionalCouponPrice.dimmed, true);
  assert.equal(conditionalItem.deal.conditionalCouponPrice.eligibilityVerified, false);
  assert.match(conditionalItem.summary, /가입·적용 조건 미확인/);
  const tripPrice = result.priceRows.find(item => item.productId === '1003');
  assert.equal(tripPrice.productUrl, null);
  assert.equal(tripPrice.sourceClassification, 'non_consumer_detail_url');
  assert.equal(tripPrice.generalPrice.amount, 10000);
  assert.equal(tripPrice.eventEnd, null);
  assert.equal(result.receipt.legacyListingRequested, false);
  assert.equal(result.receipt.inventorySource, 'coupang_mlp_goldbox_widget');
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.receipt.coverage.catalogPageRowsSeen, 6);
  assert.equal(result.receipt.coverage.returnedRowsReconciled, true);
  assert.equal(result.receipt.coverage.soldOutRowsRetainedInPriceRows, 1);
  assert.equal(result.receipt.coverage.consumerItemsExcludeSoldOut, true);
  assert.equal(result.receipt.coverage.consumerItemsLimitAppliedAfterScan, true);
  assert.equal(result.receipt.coverage.mappingExclusions.nonConsumerDetailUrl, 1);
  assert.equal(result.receipt.coverage.mappingExclusions.missingTitle, 1);
  assert.equal(result.receipt.coverage.mappingExclusions.soldOutConsumerRows, 1);
  assert.equal(result.receipt.coverage.allRetailerPricePathsComplete, false);
  assert.equal(result.receipt.states.live_replay, false);
});

test('tracks advertised WOW coverage separately from general price and signup coupons', async () => {
  const advertised = row(1051, { wowPrice: { label: '할인가', price: '8,000원' } });
  const absent = row(1052);
  const signup = row(1053, { wowPrice: { label: '가입 쿠폰가', price: '7,000원' } });
  const mock = createFetch({ pages: [{ rows: [advertised, absent, signup] }] });
  const result = await fetchGoldboxWithoutShipping(10, { fetchImpl: mock.fetchImpl, widgetPageDelayMs: 0 });

  const advertisedRow = result.priceRows.find(item => item.productId === '1051');
  const absentRow = result.priceRows.find(item => item.productId === '1052');
  const signupRow = result.priceRows.find(item => item.productId === '1053');
  assert.deepEqual(advertisedRow.priceVerification, {
    generalPriceVerified: true,
    advertisedWowPriceVerified: true,
    memberEligibilityVerified: false,
    wowPriceCoverageStatus: 'verified_advertised',
  });
  assert.equal(absentRow.priceVerification.generalPriceVerified, true);
  assert.equal(absentRow.priceVerification.advertisedWowPriceVerified, false);
  assert.equal(absentRow.priceVerification.wowPriceCoverageStatus, 'unavailable');
  assert.equal(signupRow.priceVerification.advertisedWowPriceVerified, false);
  assert.equal(signupRow.priceVerification.wowPriceCoverageStatus, 'conditional_signup_coupon');

  const advertisedItem = result.items.find(item => item.deal.productId === '1051');
  const signupItem = result.items.find(item => item.deal.productId === '1053');
  assert.deepEqual(advertisedItem.deal.priceVerification, advertisedRow.priceVerification);
  assert.match(advertisedItem.summary, /와우 표시 할인가 8,000원/);
  assert.equal(signupItem.deal.priceVerification.advertisedWowPriceVerified, false);
  assert.match(signupItem.summary, /가입 쿠폰가 7,000원/);

  assert.equal(result.receipt.coverage.inStockConsumerRows, 3);
  assert.equal(result.receipt.coverage.rowsWithVerifiedAdvertisedWowPrice, 1);
  assert.equal(result.receipt.coverage.rowsWithoutVerifiedAdvertisedWowPrice, 2);
  assert.equal(result.receipt.coverage.wowAdvertisedPriceCoverageComplete, false);
  assert.equal(result.receipt.coverage.publicGoldboxPriceCoverageComplete, true);
  assert.equal(result.receipt.status, 'complete');
});

test('invalid or unknown special-price evidence stays visible and makes special-price classification partial', async () => {
  const invalidWow = row(1101, { wowPrice: { label: '할인가', price: '정상가 아님' } });
  const unknownLabel = row(1102, { wowPrice: { label: '카드 혜택가', price: '9,000원' } });
  const mock = createFetch({ pages: [{ rows: [invalidWow, unknownLabel] }] });
  const result = await fetchGoldboxWithoutShipping(10, { fetchImpl: mock.fetchImpl, widgetPageDelayMs: 0 });
  assert.equal(result.priceRows.length, 2);
  const invalid = result.priceRows.find(item => item.productId === '1101');
  assert.equal(invalid.advertisedPriceReadStatus, 'invalid');
  assert.equal(invalid.advertisedWowPrice, null);
  assert.equal(invalid.wowPriceReadStatus, 'invalid_advertised_price');
  assert.equal(invalid.priceVerification.generalPriceVerified, true);
  assert.equal(invalid.priceVerification.wowPriceCoverageStatus, 'invalid');
  const unknown = result.priceRows.find(item => item.productId === '1102');
  assert.equal(unknown.advertisedPriceReadStatus, 'valid');
  assert.equal(unknown.advertisedWowPrice.label, '카드 혜택가');
  assert.equal(unknown.wowSalePrice, null);
  assert.equal(unknown.priceVerification.advertisedWowPriceVerified, false);
  assert.equal(unknown.priceVerification.wowPriceCoverageStatus, 'unavailable');
  assert.equal(result.receipt.coverage.invalidAdvertisedPriceRows, 1);
  assert.equal(result.receipt.coverage.unclassifiedAdvertisedPriceRows, 1);
  assert.equal(result.receipt.coverage.wowAdvertisedPriceCoverageComplete, false);
  assert.equal(result.receipt.coverage.specialPriceClassificationComplete, false);
  assert.equal(result.receipt.status, 'partial');
});

test('fills only missing exact consumer general prices from the public offer list using the same visitor', async () => {
  const needsFallback = row(1201, { finalPrice: {}, originalPrice: null });
  const mock = createFetch({ pages: [{ rows: [needsFallback] }] });
  const result = await fetchPublicCoupangGoldbox(10, { fetchImpl: mock.fetchImpl,
    publicOfferFallbackDelayMs: 0, shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
  assert.equal(mock.calls.bootstrap, 1);
  assert.equal(mock.calls.widget, 1);
  assert.equal(mock.calls.offer, 1);
  const price = result.priceRows[0];
  assert.equal(price.widgetGeneralPrice, null);
  assert.equal(price.generalPrice.amount, 4321);
  assert.equal(price.generalPriceSource, 'coupang_public_offer_list');
  assert.equal(price.publicOfferGeneralPrice.readStatus, 'matched_public_offer_general_price');
  assert.equal(result.items[0].deal.salePrice, 4321);
  assert.equal(result.items[0].deal.widgetFinalPrice, null);
  assert.equal(result.items[0].deal.widgetPriceReadStatus, 'missing_general_price');
  assert.equal(result.items[0].deal.publicOfferGeneralPriceReadStatus, 'matched_public_offer_general_price');
  assert.equal(result.items[0].deal.publicOfferGeneralPriceReadError, null);
  assert.equal(result.items[0].deal.publicShippingGeneralPrice.amount, 4321);
  assert.equal(result.items[0].deal.shippingReadStatus, 'absent');
  assert.equal(result.receipt.shippingEnrichment.attempted, 0);
  assert.equal(result.receipt.shippingEnrichment.reusedExistingOfferListReads, 1);
  assert.equal(result.receipt.publicOfferFallback.sharedVisitorContext, true);
  assert.equal(result.receipt.publicOfferFallback.visitorBootstrapCount, 0);
  assert.equal(result.receipt.publicOfferFallback.matched, 1);
  assert.equal(result.receipt.generalPriceCollectionStatus, 'complete');
  assert.equal(result.receipt.status, 'partial');
});

test('reads public shipping separately and keeps verified, conditional, absent and conflicting fees distinct', async () => {
  const rows = [row(1251), row(1252), row(1253, { finalPrice: { value: '19,900원' } }), row(1254), row(1255),
    row(1256, { finalPrice: { value: '31,500원' } }), row(1257), row(1258)];
  const mock = createFetch({ pages: [{ rows }], offer: url => {
    const productId = new URL(url).searchParams.get('productId');
    if (productId === '1251') return { status: 200, amount: 10000, shippingFee: 2500 };
    if (productId === '1252') return { status: 200, amount: 10000, shippingFee: 0 };
    if (productId === '1253') return { status: 200, amount: 19900, shippingFee: 2500,
      vendorItemShippingFee: 2500, sellerShippingFee: 0, hasSkuBundleConditionalFreeShippingPrice: false,
      skuBundleConditionalFreeShippingPrice: 19800, freeShipOverAmount: 19800, rocketWowBadge: false,
      deliveryChargeType: 'FREE', sellerDeliveryChargePolicy: '무료배송' };
    if (productId === '1255') return { status: 200, amount: 10000, shippingFee: 2500, vendorItemShippingFee: 3000 };
    if (productId === '1256') return { status: 200, amount: 81600, shippingFee: 2500 };
    if (productId === '1257') return { status: 200, amount: 10000, shippingFee: 'free' };
    if (productId === '1258') return { status: 200, amount: 10000, shippingFee: 0, freeShipOverAmount: 'invalid' };
    return { status: 200, amount: 10000 };
  } });
  const result = await fetchPublicCoupangGoldbox(8, { fetchImpl: mock.fetchImpl,
    shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });

  assert.equal(mock.calls.offer, 8);
  assert.equal(result.receipt.generalPriceCollectionStatus, 'complete');
  assert.equal(result.receipt.shippingCollectionStatus, 'partial');
  assert.equal(result.receipt.coverage.fullCatalogShippingCoverageComplete, false);
  assert.deepEqual({ requested: result.receipt.shippingEnrichment.requestedCandidates,
    attempted: result.receipt.shippingEnrichment.attempted, read: result.receipt.shippingEnrichment.read,
    verified: result.receipt.shippingEnrichment.verified, unverified: result.receipt.shippingEnrichment.unverified },
  { requested: 8, attempted: 8, read: 8, verified: 3, unverified: 5 });

  const [paid, free, conditional, missing, feeConflict, priceConflict, invalidFee, invalidConditions] = result.items;
  assert.equal(paid.deal.shippingReadStatus, 'verified');
  assert.equal(paid.deal.publicShippingFee, 2500);
  assert.equal(paid.deal.publicShippingGeneralPrice.amount, 10000);
  assert.equal(paid.deal.shipping.sourceScope, 'consumer_public_offer_list');
  assert.equal(paid.deal.shipping.memberEligibilityVerified, false);
  assert.equal(paid.deal.publicOfferGeneralPriceComparisonStatus, 'matches_selected_general_price');
  assert.equal(paid.deal.publicOfferGeneralPriceMatchesSelectedGeneralPrice, true);
  assert.match(paid.summary, /공개 배송비 2,500원 \(회원 적용 배송비 미확인\)/);
  assert.equal(paid.deal.listingContent.deliveryText, '공개 배송비 2,500원 (회원 적용 배송비 미확인)');
  assert.equal(free.deal.shippingReadStatus, 'verified');
  assert.equal(free.deal.publicShippingFee, 0);
  assert.equal(free.deal.memberShippingFee, null);
  assert.equal(free.deal.memberShippingVerified, false);
  assert.match(free.summary, /공개 무료배송 \(회원 적용 배송비 미확인\)/);
  assert.equal(conditional.deal.shippingReadStatus, 'conditional_unverified');
  assert.equal(conditional.deal.shipping, null);
  assert.equal(conditional.deal.publicShippingFee, null);
  assert.equal(conditional.deal.advertisedShipping.fee.amount, 0);
  assert.deepEqual(conditional.deal.advertisedShipping.sourcePaths, ['sellerSaleDeliveryInfo.shippingFee']);
  assert.deepEqual(conditional.deal.shippingFeeEvidence.feeCandidates.map(candidate => candidate.amount), [2500, 2500, 0]);
  assert.deepEqual(conditional.deal.shippingFeeEvidence.conditions, {
    hasSkuBundleConditionalFreeShippingPrice: false,
    skuBundleConditionalFreeShippingPrice: 19800,
    vendorItemDelivery: { rocketWowBadge: false, freeShipOverAmount: 19800, deliveryChargeType: 'FREE' },
    sellerSaleDeliveryInfo: { deliveryChargePolicy: '무료배송' },
  });
  assert.equal(conditional.deal.shippingFeeEvidence.conditionsReadStatus, 'valid');
  assert.match(conditional.deal.listingContent.deliveryText, /공개 무료배송 표시 \(적용 조건 미확인\)/);
  assert.equal(missing.deal.shippingReadStatus, 'absent');
  assert.equal(missing.deal.publicShippingFee, null);
  assert.equal(missing.deal.publicShippingGeneralPrice.amount, 10000);
  assert.equal(missing.deal.listingContent.deliveryText, '배송비 미확인');
  assert.equal(feeConflict.deal.shippingReadStatus, 'invalid');
  assert.equal(feeConflict.deal.shipping, null);
  assert.equal(feeConflict.deal.publicShippingFee, null);
  assert.equal(feeConflict.deal.shippingFeeEvidence.sourceScope, 'consumer_public_offer_list');
  assert.equal(feeConflict.deal.shippingFeeEvidence.memberEligibilityVerified, false);
  assert.deepEqual(feeConflict.deal.shippingFeeEvidence.feeCandidates.map(candidate => candidate.amount), [2500, 3000]);
  assert.deepEqual(feeConflict.deal.shippingFeeEvidence.feeCandidates.map(candidate => candidate.sourcePath), [
    'vendorItemSaleInfo.deliveryFee.shippingFee', 'vendorItemSaleInfo.vendorItemDelivery.shippingFee',
  ]);
  assert.equal(feeConflict.deal.listingContent.deliveryText, '배송비 미확인');
  assert.equal(priceConflict.deal.publicShippingGeneralPrice.amount, 81600);
  assert.equal(priceConflict.deal.publicOfferGeneralPriceComparisonStatus, 'general_price_conflict');
  assert.equal(priceConflict.deal.publicOfferGeneralPriceMatchesSelectedGeneralPrice, false);
  assert.equal(invalidFee.deal.shippingReadStatus, 'invalid');
  assert.deepEqual(invalidFee.deal.shippingFeeEvidence.feeCandidates, [{
    sourcePath: 'vendorItemSaleInfo.deliveryFee.shippingFee', amount: null, currency: 'KRW',
    readStatus: 'invalid', valueType: 'string',
  }]);
  assert.equal(Object.hasOwn(invalidFee.deal.shippingFeeEvidence.feeCandidates[0], 'rawValue'), false);
  assert.equal(invalidConditions.deal.shippingReadStatus, 'invalid');
  assert.equal(invalidConditions.deal.shippingFeeEvidence.conditionsReadStatus, 'invalid');
  assert.deepEqual(invalidConditions.deal.shippingFeeEvidence.conditions, {});
  assert.equal(result.receipt.coverage.rowsWithPublicShippingGeneralPriceConflict, 1);
  assert.equal(result.receipt.coverage.rowsWithPublicShippingGeneralPriceMatch, 7);
  assert.equal(result.receipt.status, 'partial');
});

test('shipping enrichment can be disabled without changing public general-price coverage', async () => {
  const mock = createFetch({ pages: [{ rows: [row(1261)] }] });
  const result = await fetchPublicCoupangGoldbox(1, { fetchImpl: mock.fetchImpl,
    shippingEnrichmentEnabled: false, widgetPageDelayMs: 0 });
  assert.equal(mock.calls.offer, 0);
  assert.equal(result.receipt.shippingEnrichment.status, 'not_requested');
  assert.equal(result.receipt.shippingEnrichment.requestedCandidates, 0);
  assert.equal(result.items[0].deal.shippingReadStatus, 'not_attempted');
  assert.equal(result.receipt.shippingCollectionStatus, 'not_requested');
  assert.equal(result.receipt.generalPriceCollectionStatus, 'complete');
  assert.equal(result.receipt.status, 'complete');
});

test('shipping-only 429 stops remaining offer-list reads and leaves general pricing complete', async () => {
  const mock = createFetch({ pages: [{ rows: [row(1271), row(1272), row(1273)] }], offer: url => {
    const productId = new URL(url).searchParams.get('productId');
    return productId === '1272' ? { status: 429 } : { status: 200, amount: 10000, shippingFee: 2500 };
  } });
  const result = await fetchPublicCoupangGoldbox(3, { fetchImpl: mock.fetchImpl,
    shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
  assert.equal(mock.calls.offer, 2);
  assert.equal(result.receipt.shippingEnrichment.stopReason, 'rate_limited_429');
  assert.equal(result.receipt.shippingEnrichment.attempted, 2);
  assert.equal(result.receipt.shippingEnrichment.read, 1);
  assert.equal(result.receipt.shippingEnrichment.verified, 1);
  assert.equal(result.receipt.shippingEnrichment.unverified, 2);
  assert.deepEqual(result.items.map(item => item.deal.shippingReadStatus), ['verified', 'rate_limited', 'not_attempted']);
  assert.equal(result.receipt.shippingCollectionStatus, 'partial');
  assert.equal(result.receipt.generalPriceCollectionStatus, 'complete');
  assert.equal(result.receipt.status, 'partial');
});

test('shipping-only 401, 403 and 418 stop the batch with exact status and no retries', async () => {
  for (const status of [401, 403, 418]) {
    const mock = createFetch({ pages: [{ rows: [row(1281), row(1282), row(1283)] }], offer: url => {
      const productId = new URL(url).searchParams.get('productId');
      return productId === '1281' ? { status } : { status: 200, amount: 10000, shippingFee: 2500 };
    } });
    const result = await fetchPublicCoupangGoldbox(3, { fetchImpl: mock.fetchImpl,
      shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
    assert.equal(mock.calls.offer, 1);
    assert.deepEqual(result.receipt.shippingEnrichment.pages.map(page => page.status), [status, null, null]);
    assert.equal(result.receipt.shippingEnrichment.pages[0].errorCode, 'COUPANG_CONSUMER_ACCESS_BLOCKED');
    assert.equal(result.receipt.shippingEnrichment.pages[0].selectedIdentityMatches, false);
    assert.equal(result.receipt.shippingEnrichment.pages[0].proof.status, status);
    assert.equal(result.receipt.shippingEnrichment.pages[0].proof.exactRequestIdentityMatched, true);
    assert.deepEqual(result.receipt.shippingEnrichment.pages.slice(1).map(page => page.proof), [null, null]);
    assert.deepEqual(result.receipt.shippingEnrichment.pages.map(page => page.shippingReadStatus),
      ['read_failed', 'not_attempted', 'not_attempted']);
    assert.equal(result.receipt.shippingEnrichment.pages.every(page => page.reusedExistingOfferListRead === false), true);
    assert.equal(result.receipt.shippingEnrichment.stopReason, `access_blocked_${status}`);
    assert.equal(result.receipt.shippingCollectionStatus, 'partial');
    assert.equal(result.receipt.generalPriceCollectionStatus, 'complete');
    assert.equal(result.receipt.status, 'partial');
  }
});

test('401, 403 and 418 during general fallback stop remaining fallback and shipping GETs', async () => {
  for (const status of [401, 403, 418]) {
    const firstId = 1284 + status;
    const rows = [row(firstId, { finalPrice: {} }), row(firstId + 1, { finalPrice: {} }), row(firstId + 2)];
    const mock = createFetch({ pages: [{ rows }], offer: url => {
      const productId = new URL(url).searchParams.get('productId');
      return productId === String(firstId) ? { status } : { status: 200, amount: 10000, shippingFee: 2500 };
    } });
    const result = await fetchPublicCoupangGoldbox(3, { fetchImpl: mock.fetchImpl,
      publicOfferFallbackDelayMs: 0, shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
    assert.equal(mock.calls.offer, 1);
    assert.equal(result.receipt.publicOfferFallback.attempted, 1);
    assert.equal(result.receipt.publicOfferFallback.requestedCandidates, 2);
    assert.equal(result.receipt.publicOfferFallback.notAttempted, 1);
    assert.equal(result.receipt.publicOfferFallback.stopReason, `access_blocked_${status}`);
    assert.equal(result.receipt.publicOfferFallback.pages[0].proof.status, status);
    assert.equal(result.receipt.publicOfferFallback.pages[0].proof.exactRequestIdentityMatched, true);
    assert.equal(result.receipt.shippingEnrichment.pages.length, 3);
    assert.deepEqual(result.receipt.shippingEnrichment.pages.map(page => page.status), [status, null, null]);
    assert.equal(result.receipt.shippingEnrichment.pages[0].proof.status, status);
    assert.equal(result.receipt.shippingEnrichment.pages[0].proof.exactRequestIdentityMatched, true);
    assert.deepEqual(result.receipt.shippingEnrichment.pages.map(page => page.reusedExistingOfferListRead),
      [true, false, false]);
    assert.equal(result.receipt.shippingEnrichment.pages[1].errorCode, `stopped_after_access_block_${status}`);
    assert.equal(result.receipt.shippingEnrichment.pages[2].errorCode, `stopped_after_access_block_${status}`);
    assert.equal(result.receipt.shippingEnrichment.stopReason, `access_blocked_${status}`);
    assert.equal(result.receipt.shippingEnrichment.attempted, 0);
    assert.equal(result.receipt.generalPriceCollectionStatus, 'partial');
  }
});

test('confirmed 200 challenge stops fallback and direct shipping reads without retrying', async () => {
  const challenge = {
    status: 200,
    challengeHeaders: { 'x-captcha-required': 'true' },
    body: '<html><title>Additional verification</title><body>challenge</body></html>',
  };
  const fallbackRows = [row(1771, { finalPrice: {} }), row(1772, { finalPrice: {} }), row(1773)];
  const fallbackMock = createFetch({ pages: [{ rows: fallbackRows }], offer: () => challenge });
  const fallbackResult = await fetchPublicCoupangGoldbox(3, { fetchImpl: fallbackMock.fetchImpl,
    publicOfferFallbackDelayMs: 0, shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
  assert.equal(fallbackMock.calls.offer, 1);
  assert.equal(fallbackResult.receipt.publicOfferFallback.stopReason, 'challenge_confirmed');
  assert.equal(fallbackResult.receipt.publicOfferFallback.attempted, 1);
  assert.equal(fallbackResult.receipt.publicOfferFallback.notAttempted, 1);
  assert.equal(fallbackResult.receipt.publicOfferFallback.pages[0].status, 200);
  assert.equal(fallbackResult.receipt.publicOfferFallback.pages[0].proof.challengeConfirmed, true);
  assert.equal(fallbackResult.receipt.shippingEnrichment.stopReason, 'challenge_confirmed');
  assert.equal(fallbackResult.receipt.shippingEnrichment.attempted, 0);
  assert.deepEqual(fallbackResult.receipt.shippingEnrichment.pages.map(page => page.status), [200, null, null]);
  assert.equal(fallbackResult.receipt.shippingEnrichment.pages[0].proof.challengeConfirmed, true);
  assert.deepEqual(fallbackResult.items.map(item => item.deal.shippingReadStatus),
    ['read_failed', 'not_attempted', 'not_attempted']);
  assert.equal(fallbackResult.receipt.generalPriceCollectionStatus, 'partial');
  assert.equal(fallbackResult.receipt.status, 'partial');

  const shippingMock = createFetch({ pages: [{ rows: [row(1781), row(1782)] }], offer: () => challenge });
  const shippingResult = await fetchPublicCoupangGoldbox(2, { fetchImpl: shippingMock.fetchImpl,
    shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
  assert.equal(shippingMock.calls.offer, 1);
  assert.equal(shippingResult.receipt.publicOfferFallback.stopReason, 'no_candidates');
  assert.equal(shippingResult.receipt.shippingEnrichment.attempted, 1);
  assert.equal(shippingResult.receipt.shippingEnrichment.notAttempted, 1);
  assert.equal(shippingResult.receipt.shippingEnrichment.stopReason, 'challenge_confirmed');
  assert.deepEqual(shippingResult.receipt.shippingEnrichment.pages.map(page => page.status), [200, null]);
  assert.equal(shippingResult.receipt.shippingEnrichment.pages[0].proof.challengeConfirmed, true);
  assert.deepEqual(shippingResult.items.map(item => item.deal.shippingReadStatus), ['read_failed', 'not_attempted']);
  assert.equal(shippingResult.receipt.generalPriceCollectionStatus, 'complete');
  assert.equal(shippingResult.receipt.status, 'partial');
});

test('native shipping replay stays false when exact offers are read but every shipping fee is invalid', async () => {
  const mock = createFetch({ pages: [{ rows: [row(1291)] }],
    offer: () => ({ status: 200, amount: 10000, shippingFee: 2500, vendorItemShippingFee: 3000 }) });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = mock.fetchImpl;
    const result = await fetchPublicCoupangGoldbox(1, { shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
    assert.equal(result.receipt.shippingEnrichment.nativeRead, 1);
    assert.equal(result.receipt.shippingEnrichment.nativeVerified, 0);
    assert.equal(result.receipt.shippingEnrichment.pages[0].shippingReadStatus, 'invalid');
    assert.equal(result.receipt.shippingEnrichment.pages[0].proof.status, 200);
    assert.equal(result.receipt.shippingEnrichment.pages[0].proof.exactRequestIdentityMatched, true);
    assert.equal(result.receipt.shippingEnrichment.states.live_replay, false);
    assert.equal(result.receipt.pricePaths.publicOfferListShipping.live_replay, false);
    assert.equal(result.receipt.status, 'partial');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shipping failure receipt carries only projected exact-SKU proof, never the raw denial body', async () => {
  const bodyCanary = 'RAW_COUPANG_DENIAL_BODY_CANARY_7F91';
  const target = row(8771465367, {
    itemId: '25514751793',
    vendorItemId: '92507577588',
    detailUrl: 'https://www.coupang.com/vp/products/8771465367?itemId=25514751793&vendorItemId=92507577588',
  });
  const mock = createFetch({ pages: [{ rows: [target] }], offer: () => ({
    status: 403,
    server: 'envoy',
    body: `<html><title>Access Denied</title><body>permission denied ${bodyCanary}</body></html>`,
  }) });
  const result = await fetchPublicCoupangGoldbox(1, { fetchImpl: mock.fetchImpl,
    shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
  const proof = result.receipt.shippingEnrichment.pages[0].proof;
  assert.deepEqual(mock.calls, { bootstrap: 1, widget: 1, offer: 1, other: 0 });
  assert.equal(proof.status, 403);
  assert.equal(proof.server, 'envoy');
  assert.equal(proof.contentType, 'text/html');
  assert.equal(proof.exactRequestIdentityMatched, true);
  assert.equal(proof.visitorBootstrapStatus, null);
  assert.equal(proof.retry, false);
  assert.equal(JSON.stringify(result).includes(bodyCanary), false);
  assert.equal(Object.hasOwn(proof, 'responseSha256'), false);
  assert.equal(Object.hasOwn(proof, 'rawBody'), false);
});

test('keeps all safe first-page rows on a partial scan and does not apply the item limit early', async () => {
  const first = row(1301, { wowPrice: { label: '할인가', price: '8,000원' } });
  const second = row(1302, { wowPrice: { label: '할인가', price: '8,000원' } });
  const continuation = nextTarget();
  const mock = createFetch({ pages: [
    { rows: [first, second], next: continuation },
    { rows: [], status: 403 },
  ] });
  const result = await fetchPublicCoupangGoldbox(1, { fetchImpl: mock.fetchImpl,
    shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
  assert.equal(mock.calls.widget, 2);
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.receipt.widgetErrorCode, 'COUPANG_GOLDBOX_WIDGET_ACCESS_BLOCKED');
  assert.equal(result.receipt.coverage.catalogScanComplete, false);
  assert.equal(result.receipt.coverage.consumerItemsLimitAppliedAfterScan, false);
  assert.equal(result.receipt.returnedItemsLimit, null);
  assert.equal(result.items.length, 2);
  assert.equal(result.priceRows.length, 2);
  assert.equal(mock.calls.offer, 1);
  assert.equal(result.receipt.shippingEnrichment.eligibleCandidates, 2);
  assert.equal(result.receipt.shippingEnrichment.requestedCandidates, 1);
  assert.equal(result.receipt.shippingEnrichment.boundedOutCandidates, 1);
  assert.equal(result.items[0].deal.shippingReadStatus, 'absent');
  assert.equal(result.items[1].deal.shippingReadStatus, 'not_attempted');
  assert.equal(result.receipt.shippingCollectionStatus, 'partial');
  assert.equal(result.receipt.publicOfferFallback.stopReason, 'widget_not_complete');
  assert.equal(result.receipt.wowPriceCollectionStatus, 'partial');
  assert.equal(result.receipt.coverage.wowAdvertisedCatalogPriceCoverageComplete, false);
  assert.equal(result.receipt.coverage.wowAdvertisedPriceCoverageComplete, false);
});

test('an unknown stock row prevents complete WOW coverage across the scanned catalog', async () => {
  const mock = createFetch({ pages: [{ rows: [
    row(1351, { wowPrice: { label: '할인가', price: '8,000원' } }),
    row(1352, { wowPrice: { label: '할인가', price: '8,000원' }, stockRemainingInfo: {} }),
  ] }] });
  const result = await fetchGoldboxWithoutShipping(2, { fetchImpl: mock.fetchImpl, widgetPageDelayMs: 0 });
  assert.equal(result.priceRows.length, 2);
  assert.equal(result.receipt.coverage.catalogScanComplete, true);
  assert.equal(result.receipt.coverage.soldOutUnknownRows, 1);
  assert.equal(result.receipt.coverage.catalogRowsWithVerifiedAdvertisedWowPrice, 1);
  assert.equal(result.receipt.coverage.wowAdvertisedCatalogPriceCoverageComplete, false);
  assert.equal(result.receipt.coverage.wowAdvertisedPriceCoverageComplete, false);
  assert.equal(result.receipt.wowPriceCollectionStatus, 'partial');
});

test('public offer-list 429 stops fallback without retrying or hiding the missing general price', async () => {
  const first = row(1401, { finalPrice: {} });
  const second = row(1402, { finalPrice: {} });
  const mock = createFetch({ pages: [{ rows: [first, second] }], offer: () => ({ status: 429 }) });
  const result = await fetchPublicCoupangGoldbox(10, { fetchImpl: mock.fetchImpl,
    publicOfferFallbackDelayMs: 0, shippingEnrichmentDelayMs: 0, widgetPageDelayMs: 0 });
  assert.equal(mock.calls.offer, 1);
  assert.equal(result.receipt.publicOfferFallback.attempted, 1);
  assert.equal(result.receipt.publicOfferFallback.stopReason, 'rate_limited_429');
  assert.equal(result.priceRows.filter(item => item.generalPrice).length, 0);
  assert.equal(result.receipt.coverage.publicGoldboxPriceCoverageComplete, false);
  assert.equal(result.receipt.status, 'partial');
});

test('rejects invalid limits before any network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('network must remain untouched'); };
  await assert.rejects(fetchPublicCoupangGoldbox(0, { fetchImpl }), { code: 'LIMIT' });
  await assert.rejects(fetchPublicCoupangGoldbox(1, { fetchImpl, publicOfferFallbackLimit: 1001 }), { code: 'LIMIT' });
  await assert.rejects(fetchPublicCoupangGoldbox(1, { fetchImpl, maxWidgetPages: 6 }), { code: 'LIMIT' });
  await assert.rejects(fetchPublicCoupangGoldbox(1, { fetchImpl, shippingEnrichmentDelayMs: 10001 }), { code: 'LIMIT' });
  await assert.rejects(fetchPublicCoupangGoldbox(1, { fetchImpl, shippingEnrichmentEnabled: 'yes' }), { code: 'LIMIT' });
  assert.equal(calls, 0);
});
