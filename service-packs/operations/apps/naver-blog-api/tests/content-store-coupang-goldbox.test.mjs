import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCoupangGoldboxLegacy as fetchCoupangGoldbox, mapGoldboxProduct } from '../research/content-store/coupang-goldbox.mjs';

// Trimmed real product from the 2026-09-24 Goldbox response.
const product = (over = {}) => ({
  productId: 6955197525, itemId: 17771296119, vendorItemId: 88377301303,
  imageAndTitleArea: { title: '코카콜라 제로 무라벨, 370ml, 24개' },
  priceArea: { originalPrice: '28,600', salesPrice: '22,880', discountRate: 20 },
  promotionClosingArea: { expiryDateUTC: '2026-09-24T21:59:59.059Z' },
  reviewArea: { ratingAverage: 5, ratingCountNum: 19578 },
  soldoutArea: { soldout: false }, rocketArea: { layoutType: 'ROCKET' },
  link: '/vp/products/6955197525?itemId=17771296119&vendorItemId=88377301303', ...over,
});
const bootstrap = () => new Response('<html><title>web-adapter-proxy</title>getLocalStorage</html>', {
  headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'PCID=test-visitor; Domain=.coupang.com; Path=/; Secure' },
});
const widgetPayload = (list, dataUrl) => ({ rCode: 'RET0000', rData: { widgets: [{ type: 'product', props: {
  config: { id: '43145', pageId: 3712 }, data: dataUrl === undefined ? { list } : { list, dataUrl },
} }] }, rMessage: null });
const offerListPayload = (target, price = 12345) => {
  const url = new URL(target);
  const productId = url.searchParams.get('productId'), itemId = url.searchParams.get('itemId');
  const vendorItemId = url.searchParams.get('selectedVendorItemId');
  return { data: { status: 200, vendorItems: [{ productId, itemId, vendorItemId, selected: true,
    hasCouponDownload: false, hasAppreciationCoupon: false, hasNoneAppreciationCoupon: false,
    vendorItemSaleInfo: { itemId, vendorItemId, salePrice: price,
      i18nSalePrice: { amount: String(price), rawAmount: price, fractionDigits: 0, currency: 'KRW' } } }] } };
};
const reply = (status, body, widgetList = [], { offerStatus = 200, offerPrice = 12345 } = {}) => async (url, options = {}) => {
  const href = String(url);
  if (href.endsWith('/n-api/web-adapter/proxy')) return bootstrap();
  if (href.includes('/vm/mlp/v1/newweb/mlp-widget-landing'))
    return new Response(JSON.stringify(widgetPayload(widgetList)), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  if (href.includes('/next-api/offer-list')) return new Response(
    offerStatus === 200 ? JSON.stringify(offerListPayload(href, offerPrice)) : 'Access Denied',
    { status: offerStatus, headers: { 'content-type': offerStatus === 200 ? 'application/json; charset=utf-8' : 'text/plain' } });
  assert.equal(href, 'https://pages.coupang.com/api/products');
  assert.deepEqual(JSON.parse(options.body), { goldbox: true, releaseDate: null });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
};

test('maps price, discount, closing time and reviews; link is a plain product URL', () => {
  const item = mapGoldboxProduct(product());
  assert.equal(item.url, 'https://www.coupang.com/vp/products/6955197525?itemId=17771296119&vendorItemId=88377301303');
  assert.equal(item.deal.salePrice, 22880); assert.equal(item.deal.price, 28600); assert.equal(item.deal.discountRate, 20);
  assert.equal(item.deal.eventEnd, '2026-09-24T21:59:59.059Z'); assert.equal(item.engagement.reviews, 19578);
  assert.equal(item.deal.affiliateLink, false);
  assert.match(item.summary, /22,880원 \(정가 28,600원, 20%↓\)/);
});

test('listing text and public general price survive collection; sold percentage cannot become a WOW price or discount', async () => {
  const observed = product({
    imageAndTitleArea: { title: '코카콜라 제로, 350ml, 24개', description: '',
      defaultUrl: '//thumbnail.coupangcdn.com/thumbnails/remote/230x230ex/image/sample.png' },
    priceArea: { originalPrice: '25,700', salesPrice: '19,480', discountRate: 24 },
    promotionClosingArea: { rate: 60, manageCode: 'retail_rocket_wow_discount_example', expiryDateUTC: '2026-10-02T21:59Z' },
    instantDiscountBundlePriceArea: { unitPriceDescription: '(100ml당 232원)' },
    promisedDeliveryDateArea: { contents: [{ text: '내일(토) ' }, { text: '도착 보장' }] },
    cashBackArea: { cashRewardText: '최대 774원 적립' },
    additionalBenefit: { description: '추가 와우 캐시 적립' },
    benefitBadgeArea: { badgeAreaContents: [{ title: '추가할인 쿠폰' }] },
  });
  const result = await fetchCoupangGoldbox(1, { fetchImpl: reply(200, [observed]) });
  const item = result.items[0];
  assert.equal(item.deal.wowPromotion, true);
  assert.equal(item.deal.promotionSoldPercent, 60);
  assert.equal(item.deal.discountRate, 24);
  assert.equal(item.deal.wowPromotionRate, null);
  assert.equal(item.deal.wowSalePrice, null);
  assert.equal(item.deal.memberPriceVerified, false);
  assert.equal(item.deal.widgetPriceReadStatus, 'not_found_in_complete_catalog_scan');
  assert.equal(result.receipt.status, 'complete');
  assert.deepEqual(item.deal.listingContent, { coverage: 'listing_only', description: null,
    imageUrl: 'https://thumbnail.coupangcdn.com/thumbnails/remote/230x230ex/image/sample.png',
    unitPriceText: '(100ml당 232원)', deliveryText: '내일(토) 도착 보장', cashbackText: '최대 774원 적립',
    additionalBenefitText: '추가 와우 캐시 적립', benefitBadges: ['추가할인 쿠폰'] });
  assert.match(item.summary, /100ml당 232원/);
  assert.match(item.summary, /추가할인 쿠폰/);
  assert.equal(result.receipt.coverage.widgetCatalogScanComplete, true);
  assert.equal(result.receipt.coverage.expectedInStockMappedTriples, 1);
  assert.equal(result.receipt.coverage.unmatchedInStockMappedTriples, 1);
  assert.equal(result.receipt.coverage.widgetPricingCoverageComplete, false);
  assert.equal(result.receipt.coverage.widgetUnaccountedRawIdentityTriples, 1);
  assert.equal(result.receipt.coverage.widgetExcludedUnmatchedTriples, 0);
  assert.equal(item.deal.salePrice, 19480);
  assert.equal(item.deal.widgetFinalPrice, null);
  assert.equal(item.deal.publicOfferGeneralPrice.amount, 12345);
  assert.equal(item.deal.publicOfferGeneralPrice.basis, 'public_offer_list');
  assert.equal(item.deal.publicOfferGeneralPriceReadStatus, 'matched_public_offer_general_price');
  assert.equal(item.deal.wowSalePrice, null);
  assert.equal(item.deal.memberPriceVerified, false);
  assert.equal(result.receipt.coverage.publicPriceMatchedTriples, 1);
  assert.equal(result.receipt.coverage.publicPricingCoverageComplete, true);
  assert.equal(result.receipt.publicOfferFallback.visitorBootstrapCount, 0);
});

test('exact widget triple enriches Goldbox while preserving the legacy general sale price', async () => {
  const listing = product({
    productId: 8174473713, itemId: 26504519093, vendorItemId: 91458195016,
    imageAndTitleArea: { title: '코카콜라 제로 무라벨, 350ml, 24개' },
    priceArea: { originalPrice: '25,700', salesPrice: '19,480', discountRate: 24 },
    link: '/vp/products/8174473713?itemId=26504519093&vendorItemId=91458195016',
  });
  const widgetRow = { productId: 8174473713, itemId: 26504519093, vendorItemId: 91458195016,
    productTitle: '제로, 350ml, 24개', finalPrice: { unitPriceText: '(100ml당 232원)', value: '19,480원' },
    originalPrice: '25,700원', wowPrice: { boxEnabled: true, iconUrl: 'https://thumbnail.coupangcdn.com/wow.png',
      label: '할인가', price: '15,480원', dimmed: false } };
  const result = await fetchCoupangGoldbox(1, { fetchImpl: reply(200, [listing], [widgetRow]) });
  const item = result.items[0];
  assert.equal(item.deal.salePrice, 19480);
  assert.equal(item.deal.widgetFinalPrice.amount, 19480);
  assert.equal(item.deal.advertisedWowPrice.amount, 15480);
  assert.equal(item.deal.advertisedWowPrice.label, '할인가');
  assert.equal(item.deal.wowSalePrice, 15480);
  assert.equal(item.deal.conditionalCouponPrice, null);
  assert.equal(item.deal.memberPriceVerified, false);
  assert.equal(item.deal.widgetFinalPriceMatchesListingSalePrice, true);
  assert.match(item.summary, /골드박스 할인가 15,480원/);
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.receipt.coverage.widgetMatchedTriples, 1);
  assert.equal(result.receipt.coverage.ordinaryWowPriceRows, 1);
  assert.equal(result.receipt.coverage.widgetUnmatchedTriples, 0);
  assert.equal(result.receipt.coverage.widgetCandidateCoverageComplete, true);
});

test('conditional widget coupon is recorded separately and never becomes unconditional wowSalePrice', async () => {
  const listing = product();
  const widgetRow = { productId: listing.productId, itemId: listing.itemId, vendorItemId: listing.vendorItemId,
    finalPrice: { value: '22,880원' }, originalPrice: '28,600원',
    wowPrice: { boxEnabled: true, label: '가입 쿠폰가', price: '21,880원', dimmed: false } };
  const result = await fetchCoupangGoldbox(1, { fetchImpl: reply(200, [listing], [widgetRow]) });
  const item = result.items[0];
  assert.equal(item.deal.advertisedWowPrice.label, '가입 쿠폰가');
  assert.equal(item.deal.wowSalePrice, null);
  assert.equal(item.deal.conditionalCouponPrice.amount, 21880);
  assert.equal(item.deal.conditionalCouponPrice.eligibilityVerified, false);
  assert.equal(item.deal.memberPriceVerified, false);
  assert.match(item.summary, /가입 쿠폰가 21,880원 \(가입 조건 적용 여부 미확인\)/);
});

test('sold-out items are dropped before the limit; missing price stays null', async () => {
  const data = [product({ soldoutArea: { soldout: true } }),
    product({ productId: 2, itemId: undefined, vendorItemId: undefined, link: '/vp/products/2', priceArea: {} }),
    product({ productId: 3, itemId: undefined, vendorItemId: undefined, link: '/vp/products/3' })];
  const r = await fetchCoupangGoldbox(1, { fetchImpl: reply(200, data) });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].deal.salePrice, null);
  assert.equal(r.receipt.soldOut, 1); assert.equal(r.receipt.observedItems, 3);
  assert.equal(r.receipt.coverage.requestedWidgetTriples, 1);
  assert.equal(r.receipt.coverage.widgetIdentityMatchedTriples, 0);
  assert.equal(r.receipt.coverage.widgetIdentityUnmatchedTriples, 1);
  assert.equal(r.receipt.coverage.rawIdentityRows, 1);
  assert.equal(r.receipt.coverage.invalidIdentityRows, 2);
  assert.equal(r.receipt.coverage.soldOutMappedRows, 1);
  assert.equal(r.receipt.coverage.widgetUnmatchedTriples, 1);
  assert.equal(r.receipt.coverage.widgetExcludedUnmatchedTriples, 1);
  assert.equal(r.receipt.coverage.widgetExcludedUnmatchedIdentityRows[0].reason, 'sold_out_listing');
  assert.equal(r.receipt.coverage.widgetExcludedUnmatchedIdentityRows[0].rawSoldOut, true);
  assert.equal(r.receipt.coverage.widgetUnaccountedRawIdentityTriples, 0);
});

test('hydrates every raw exact identity and accounts for unmapped listing rows without claiming them', async () => {
  const raw = [
    product({ productId: 2, itemId: 22, vendorItemId: 222, imageAndTitleArea: { title: '' },
      link: '/vp/products/2?itemId=22&vendorItemId=222' }),
    product({ productId: 3, itemId: 33, vendorItemId: 333, link: '' }),
    product({ productId: 4, itemId: 44, vendorItemId: 444, link: '/vp/products/4?itemId=44&vendorItemId=444' }),
  ];
  const widgets = raw.map(row => ({ productId: row.productId, itemId: row.itemId, vendorItemId: row.vendorItemId,
    finalPrice: { value: '1,234원' }, originalPrice: '2,000원' }));
  const result = await fetchCoupangGoldbox(10, { fetchImpl: reply(200, raw, widgets) });
  assert.equal(result.items.length, 1);
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.receipt.coverage.listingRows, 3);
  assert.equal(result.receipt.coverage.mappedRows, 1);
  assert.equal(result.receipt.coverage.unmappedRows, 2);
  assert.deepEqual(result.receipt.coverage.mappingExclusions, {
    missingTitle: 1, invalidOrSkuMismatchedProductLink: 1, missingTitleAndInvalidProductLink: 0,
  });
  assert.equal(Object.values(result.receipt.coverage.mappingExclusions).reduce((sum, count) => sum + count, 0), 2);
  assert.equal(result.receipt.coverage.rawIdentityRows, 3);
  assert.equal(result.receipt.coverage.uniqueRawIdentityTriples, 3);
  assert.equal(result.receipt.coverage.expectedInStockMappedTriples, 1);
  assert.equal(result.receipt.coverage.matchedInStockMappedTriples, 1);
  assert.equal(result.receipt.coverage.widgetPricingCoverageComplete, true);
  assert.equal(result.receipt.coverage.widgetUnaccountedRawIdentityTriples, 0);
  assert.equal(result.receipt.coverage.widgetExcludedUnmatchedTriples, 0);
  assert.equal(result.receipt.listingHttpStatus, 200);
});

test('public offer-list price covers an unmapped in-stock raw triple without inventing a listing item', async () => {
  const raw = [product({ productId: 2, itemId: 22, vendorItemId: 222, imageAndTitleArea: { title: '' },
    link: '/vp/products/2?itemId=22&vendorItemId=222' })];
  const result = await fetchCoupangGoldbox(10, { fetchImpl: reply(200, raw, []) });
  assert.equal(result.items.length, 0);
  assert.equal(result.receipt.status, 'complete');
  assert.equal(result.receipt.coverage.unmappedRows, 1);
  assert.equal(result.receipt.coverage.expectedInStockRawTriples, 1);
  assert.equal(result.receipt.coverage.unmatchedInStockRawTriples, 1);
  assert.equal(result.receipt.coverage.widgetExcludedUnmatchedTriples, 0);
  assert.equal(result.receipt.coverage.widgetUnaccountedRawIdentityTriples, 1);
  assert.equal(result.receipt.coverage.widgetExcludedUnmatchedIdentityRows.length, 0);
  assert.equal(result.receipt.coverage.publicPriceMatchedTriples, 1);
  assert.equal(result.receipt.coverage.publicPriceUnaccountedRawIdentityTriples, 0);
  assert.equal(result.receipt.coverage.publicPricingCoverageComplete, true);
});

test('does not substitute a different option SKU; exact public offer fallback fills only the general price', async () => {
  const listing = product({ productId: 81, itemId: 810, vendorItemId: 8100,
    priceArea: { originalPrice: '20,000', salesPrice: '18,000', discountRate: 10 },
    link: '/vp/products/81?itemId=810&vendorItemId=8100' });
  const differentOption = { productId: 81, itemId: 810, vendorItemId: 8101,
    finalPrice: { value: '1,000원' }, wowPrice: { label: '할인가', price: '500원' } };
  const result = await fetchCoupangGoldbox(5, { fetchImpl: reply(200, [listing], [differentOption]),
    publicOfferFallbackDelayMs: 0 });
  const item = result.items[0];
  assert.equal(result.receipt.coverage.widgetMatchedTriples, 0);
  assert.equal(result.receipt.coverage.exactSkuMismatchesExcluded, 1);
  assert.equal(result.receipt.coverage.publicOfferFallbackMatchedTriples, 1);
  assert.equal(item.deal.salePrice, 18000);
  assert.equal(item.deal.widgetFinalPrice, null);
  assert.equal(item.deal.wowSalePrice, null);
  assert.equal(item.deal.advertisedWowPrice, null);
  assert.equal(item.deal.publicOfferGeneralPrice.amount, 12345);
  assert.equal(item.deal.publicOfferGeneralPrice.readStatus, 'matched_public_offer_general_price');
  assert.equal(item.deal.publicGeneralPriceSource, 'consumer_public_offer_list');
  assert.equal(item.deal.memberPriceVerified, false);
  assert.equal(result.receipt.publicOfferFallback.sharedVisitorContext, true);
  assert.equal(result.receipt.widget.visitorBootstrapCount, 1);
  assert.equal(result.receipt.publicOfferFallback.visitorBootstrapCount, 0);
  assert.equal(result.receipt.coverage.publicPricingCoverageComplete, true);
});

test('an exact widget identity without a positive general amount still receives public offer fallback', async () => {
  const listing = product({ productId: 91, itemId: 910, vendorItemId: 9100,
    link: '/vp/products/91?itemId=910&vendorItemId=9100' });
  const widgetRow = { productId: 91, itemId: 910, vendorItemId: 9100, productTitle: '확인된 옵션',
    wowPrice: { label: '가입 쿠폰가', price: '9,000원' } };
  const result = await fetchCoupangGoldbox(5, { fetchImpl: reply(200, [listing], [widgetRow]),
    publicOfferFallbackDelayMs: 0 });
  const item = result.items[0];
  assert.equal(result.receipt.coverage.widgetMatchedTriples, 1);
  assert.equal(result.receipt.coverage.widgetPriceMatchedTriples, 0);
  assert.equal(result.receipt.coverage.publicOfferFallbackMatchedTriples, 1);
  assert.equal(item.deal.widgetFinalPrice, null);
  assert.equal(item.deal.advertisedWowPrice.amount, 9000);
  assert.equal(item.deal.conditionalCouponPrice.eligibilityVerified, false);
  assert.equal(item.deal.publicOfferGeneralPrice.amount, 12345);
  assert.equal(result.receipt.coverage.publicPriceMatchedTriples, 1);
});

test('a zero-valued selected offer is not claimed as a verified general price', async () => {
  const listing = product({ productId: 92, itemId: 920, vendorItemId: 9200,
    link: '/vp/products/92?itemId=920&vendorItemId=9200' });
  const result = await fetchCoupangGoldbox(5, { fetchImpl: reply(200, [listing], [], { offerPrice: 0 }),
    publicOfferFallbackDelayMs: 0 });
  assert.equal(result.receipt.publicOfferFallback.pages[0].status, 200);
  assert.equal(result.receipt.publicOfferFallback.pages[0].selectedIdentityMatches, false);
  assert.equal(result.receipt.coverage.publicPriceMatchedTriples, 0);
  assert.equal(result.receipt.coverage.publicPriceUnaccountedRawIdentityTriples, 1);
  assert.equal(result.items[0].deal.publicOfferGeneralPrice, null);
  assert.equal(result.receipt.status, 'partial');
});

test('public offer fallback is sequentially capped at five exact identities', async () => {
  const raw = Array.from({ length: 6 }, (_, index) => {
    const productId = 100 + index, itemId = 1000 + index, vendorItemId = 10000 + index;
    return product({ productId, itemId, vendorItemId,
      link: `/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}` });
  });
  let bootstrapCount = 0, offerReadCount = 0;
  const base = reply(200, raw, []);
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/n-api/web-adapter/proxy')) bootstrapCount++;
    if (href.includes('/next-api/offer-list')) {
      offerReadCount++;
      assert.equal(options.headers.cookie, 'PCID=test-visitor');
    }
    return base(url, options);
  };
  const result = await fetchCoupangGoldbox(10, { fetchImpl, publicOfferFallbackDelayMs: 0 });
  assert.equal(bootstrapCount, 1);
  assert.equal(offerReadCount, 5);
  assert.equal(result.receipt.publicOfferFallback.attempted, 5);
  assert.equal(result.receipt.publicOfferFallback.limit, 5);
  assert.equal(result.receipt.publicOfferFallback.stopReason, 'fallback_limit_reached');
  assert.equal(result.receipt.coverage.publicPriceMatchedTriples, 5);
  assert.equal(result.receipt.coverage.publicPriceUnmatchedTriples, 1);
  assert.equal(result.receipt.coverage.publicPricingCoverageComplete, false);
});

test('exhaustive price verification can process every fallback identity beyond the routine cap', async () => {
  const raw = Array.from({ length: 7 }, (_, index) => {
    const productId = 300 + index, itemId = 3000 + index, vendorItemId = 30000 + index;
    return product({ productId, itemId, vendorItemId,
      link: `/vp/products/${productId}?itemId=${itemId}&vendorItemId=${vendorItemId}` });
  });
  const result = await fetchCoupangGoldbox(1000, { fetchImpl: reply(200, raw, []),
    publicOfferFallbackDelayMs: 0, publicOfferFallbackLimit: 1000 });
  assert.equal(result.receipt.publicOfferFallback.attempted, 7);
  assert.equal(result.receipt.publicOfferFallback.candidates, 7);
  assert.equal(result.receipt.publicOfferFallback.stopReason, 'all_targets_processed');
  assert.equal(result.receipt.coverage.publicPriceMatchedTriples, 7);
  assert.equal(result.receipt.coverage.publicPriceUnmatchedTriples, 0);
  assert.equal(result.receipt.status, 'complete');
  for (const publicOfferFallbackLimit of [-1, 1001, 1.5, NaN]) {
    await assert.rejects(fetchCoupangGoldbox(1000, { publicOfferFallbackLimit,
      fetchImpl: () => { throw new Error('must not request invalid limits'); } }), { code: 'LIMIT' });
  }
});

test('public offer-list 403 is not retried; a later SKU may still be read', async () => {
  const raw = [
    product({ productId: 11, itemId: 110, vendorItemId: 1100,
      link: '/vp/products/11?itemId=110&vendorItemId=1100' }),
    product({ productId: 12, itemId: 120, vendorItemId: 1200,
      link: '/vp/products/12?itemId=120&vendorItemId=1200' }),
  ];
  let offerReadCount = 0;
  const base = reply(200, raw, [], { offerStatus: 403 });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/next-api/offer-list')) offerReadCount++;
    return base(url, options);
  };
  const result = await fetchCoupangGoldbox(5, { fetchImpl, publicOfferFallbackDelayMs: 0 });
  assert.equal(offerReadCount, 2);
  assert.deepEqual(result.receipt.publicOfferFallback.pages.map(page => page.status), [403, 403]);
  assert.ok(result.receipt.publicOfferFallback.pages.every(page => page.retry === false));
  assert.equal(result.receipt.publicOfferFallback.stopReason, 'completed_with_failures');
  assert.equal(result.receipt.coverage.publicPriceMatchedTriples, 0);
  assert.equal(result.receipt.coverage.publicPriceUnaccountedRawIdentityTriples, 2);
  assert.equal(result.receipt.status, 'partial');
});

test('public offer-list 429 stops later reads immediately', async () => {
  const raw = [
    product({ productId: 21, itemId: 210, vendorItemId: 2100,
      link: '/vp/products/21?itemId=210&vendorItemId=2100' }),
    product({ productId: 22, itemId: 220, vendorItemId: 2200,
      link: '/vp/products/22?itemId=220&vendorItemId=2200' }),
  ];
  let offerReadCount = 0;
  const base = reply(200, raw, [], { offerStatus: 429 });
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/next-api/offer-list')) offerReadCount++;
    return base(url, options);
  };
  const result = await fetchCoupangGoldbox(5, { fetchImpl, publicOfferFallbackDelayMs: 0 });
  assert.equal(offerReadCount, 1);
  assert.equal(result.receipt.publicOfferFallback.attempted, 1);
  assert.equal(result.receipt.publicOfferFallback.pages[0].status, 429);
  assert.equal(result.receipt.publicOfferFallback.stopReason, 'rate_limited_429');
  assert.equal(result.receipt.coverage.publicPricingCoverageComplete, false);
});

test('preserves first-page exact prices after a later widget page is rejected', async () => {
  const first = product({ productId: 10, itemId: 100, vendorItemId: 1000,
    link: '/vp/products/10?itemId=100&vendorItemId=1000' });
  const second = product({ productId: 20, itemId: 200, vendorItemId: 2000,
    link: '/vp/products/20?itemId=200&vendorItemId=2000' });
  const next = new URL('https://www.coupang.com/vm/mlp/v1/newweb/mlp-widget-landing');
  for (const [key, value] of Object.entries({ widgetId: '43145', isAsync: 'Y', trafficType: 'organic', landingId: '3712',
    target: 'MLP_GOLDBOX', productOffset: '100', sourceType: 'gm_crm_goldbox', isMLP: 'Y', nextWidgetPageKey: '2',
    categoryId: '0', subSourceType: 'gm_crm_gwsrtcut', extra: 'invalid' })) next.searchParams.set(key, value);
  const widgetRow = { productId: 10, itemId: 100, vendorItemId: 1000, finalPrice: { value: '12,000원' },
    wowPrice: { label: '할인가', price: '11,000원' } };
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/n-api/web-adapter/proxy')) return bootstrap();
    if (href.includes('/vm/mlp/v1/newweb/mlp-widget-landing'))
      return new Response(JSON.stringify(widgetPayload([widgetRow], next.pathname + next.search)),
        { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    assert.equal(href, 'https://pages.coupang.com/api/products');
    assert.deepEqual(JSON.parse(options.body), { goldbox: true, releaseDate: null });
    return new Response(JSON.stringify([first, second]), { status: 200 });
  };
  const result = await fetchCoupangGoldbox(10, { fetchImpl });
  assert.equal(result.receipt.status, 'partial');
  assert.equal(result.receipt.widgetErrorCode, 'COUPANG_GOLDBOX_WIDGET_NEXT_URL');
  assert.equal(result.receipt.coverage.widgetMatchedTriples, 1);
  assert.equal(result.receipt.coverage.expectedInStockRawTriples, 2);
  assert.equal(result.receipt.coverage.unmatchedInStockRawTriples, 1);
  const [withPrice, missing] = result.items;
  assert.equal(withPrice.deal.wowSalePrice, 11000);
  assert.equal(withPrice.deal.widgetPriceReadStatus, 'matched_explicit_wow_price');
  assert.equal(withPrice.deal.widgetPriceReadError, null);
  assert.equal(missing.deal.advertisedWowPrice, null);
  assert.equal(missing.deal.widgetPriceReadStatus, 'read_failed');
  assert.equal(missing.deal.widgetPriceReadError, 'COUPANG_GOLDBOX_WIDGET_NEXT_URL');
});

test('blocked, non-JSON and wrong shapes fail closed', async () => {
  await assert.rejects(fetchCoupangGoldbox(5, { fetchImpl: reply(403, 'Access Denied') }), /ACCESS_BLOCKED/);
  await assert.rejects(fetchCoupangGoldbox(5, { fetchImpl: reply(200, '<html>') }), /NOT_JSON/);
  await assert.rejects(fetchCoupangGoldbox(5, { fetchImpl: reply(200, { items: [] }) }), /SCHEMA/);
  assert.equal(mapGoldboxProduct(product({ link: 'https://evil.example/x' })), null);
  assert.equal(mapGoldboxProduct(product({ link: '/vp/products/999?itemId=17771296119&vendorItemId=88377301303' })), null);
  assert.equal(mapGoldboxProduct(product({ itemId: 111, link: '/vp/products/6955197525?itemId=17771296119&vendorItemId=88377301303' })), null);
});
