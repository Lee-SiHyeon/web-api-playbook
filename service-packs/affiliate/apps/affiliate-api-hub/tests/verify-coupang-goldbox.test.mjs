import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoldboxResult } from '../scripts/verify-coupang-goldbox.mjs';

function verifiedResult() {
  return { items: [{ title: '공개 상품', deal: { productId: '1', itemId: '2', vendorItemId: '3',
    salePrice: 1000, widgetFinalPrice: { amount: 1000 }, advertisedWowPrice: null,
    wowSalePrice: null, conditionalCouponPrice: null, memberPriceVerified: false,
    widgetPriceReadStatus: 'matched_without_explicit_wow_price' } }], receipt: {
    status: 'complete', listingHttpStatus: 200,
    coverage: { listingRows: 3, mappedRows: 2, unmappedRows: 1,
      mappingExclusions: { missingTitle: 0, invalidOrSkuMismatchedProductLink: 1, missingTitleAndInvalidProductLink: 0 },
      rawIdentityRows: 3, invalidIdentityRows: 0, uniqueRawIdentityTriples: 3, duplicateIdentityRows: 0,
      publicPriceMatchedTriples: 2, publicPriceUnmatchedTriples: 1, publicPriceExcludedUnmatchedTriples: 1,
      publicPriceExcludedUnmatchedIdentityRows: [{ productId: '4', itemId: '5', vendorItemId: '6', reason: 'sold_out_listing', rawSoldOut: true }],
      publicPriceUnaccountedRawIdentityTriples: 0,
      inStockMappedRows: 1, inStockMappedRowsWithoutExactIdentity: 0,
      expectedInStockMappedTriples: 1, matchedInStockMappedTriples: 1,
      unmatchedInStockMappedTriples: 0, publicMatchedInStockMappedTriples: 1,
      publicUnmatchedInStockMappedTriples: 0, publicPricingCoverageComplete: true },
    publicOfferFallback: { pages: [], visitorBootstrapCount: 0, states: { live_replay: false } },
    widget: { ownerCredentialUsed: false, states: { live_replay: true },
      pages: [{ status: 200 }], visitorBootstraps: [{ status: 200 }] },
  } };
}

test('accepts accounted exclusions and a no-WOW SKU without inventing a member price', () => {
  const report = verifyGoldboxResult(verifiedResult());
  assert.equal(report.passed, true);
  assert.equal(report.rows[0].advertisedPrice, null);
  assert.equal(report.rows[0].wowSalePrice, null);
  assert.ok(report.exclusions.includes('full_product_description_http_restricted_403'));
});

test('requiring WOW does not let a complete general-price scan pass missing or signup prices', () => {
  const result = verifiedResult();
  assert.equal(verifyGoldboxResult(result).passed, true);
  assert.equal(verifyGoldboxResult(result, { requireWowPrices: true }).passed, false);
  assert.equal(verifyGoldboxResult(result, { requireWowPrices: true }).checks.requiredWowPricesPresent, false);
  result.items[0].deal.advertisedWowPrice = { amount: 800, currency: 'KRW', label: '가입 쿠폰가' };
  result.items[0].deal.conditionalCouponPrice = { amount: 800, currency: 'KRW' };
  assert.equal(verifyGoldboxResult(result, { requireWowPrices: true }).checks.requiredWowPricesPresent, false);
  result.items[0].deal.advertisedWowPrice.label = '할인가';
  result.items[0].deal.conditionalCouponPrice = null;
  result.items[0].deal.wowSalePrice = 800;
  assert.equal(verifyGoldboxResult(result, { requireWowPrices: true }).passed, true);
});

test('a 200 listing cannot conceal a later 403 or an unmatched in-stock SKU', () => {
  const result = verifiedResult();
  result.receipt.widget.pages.push({ status: 403 });
  result.receipt.coverage.publicPricingCoverageComplete = false;
  result.receipt.coverage.publicUnmatchedInStockMappedTriples = 1;
  const report = verifyGoldboxResult(result);
  assert.equal(report.passed, false);
  assert.equal(report.checks.listing200, true);
  assert.equal(report.checks.allWidgetPages200, false);
  assert.equal(report.checks.allInStockTriplesMatched, false);
});

test('unaccounted inventory, injected transport, and coupon misclassification fail validation', () => {
  const result = verifiedResult();
  result.receipt.coverage.unmappedRows = 0;
  result.receipt.widget.states.live_replay = false;
  result.items[0].deal.advertisedWowPrice = { amount: 800, label: '가입 쿠폰가' };
  result.items[0].deal.wowSalePrice = 800;
  const report = verifyGoldboxResult(result);
  assert.equal(report.passed, false);
  assert.equal(report.checks.allListingRowsAccounted, false);
  assert.equal(report.checks.allExclusionsAccounted, false);
  assert.equal(report.checks.nativeLiveReplay, false);
  assert.equal(report.checks.advertisedPricesClassified, false);
});

test('ordinary and unclassified labels cannot silently populate the wrong price field', () => {
  const result = verifiedResult();
  result.items[0].deal.advertisedWowPrice = { amount: 800, label: '할인가' };
  assert.equal(verifyGoldboxResult(result).checks.advertisedPricesClassified, false);
  result.items[0].deal.wowSalePrice = 800;
  assert.equal(verifyGoldboxResult(result).checks.advertisedPricesClassified, true);
  result.items[0].deal.advertisedWowPrice.label = '기타 표시';
  assert.equal(verifyGoldboxResult(result).checks.advertisedPricesClassified, false);
});

test('a completed scan cannot conceal a missing raw inventory triple', () => {
  const result = verifiedResult();
  result.receipt.coverage.publicPriceExcludedUnmatchedTriples = 0;
  result.receipt.coverage.publicPriceExcludedUnmatchedIdentityRows = [];
  result.receipt.coverage.publicPriceUnaccountedRawIdentityTriples = 1;
  const report = verifyGoldboxResult(result);
  assert.equal(report.checks.allInStockTriplesMatched, true);
  assert.equal(report.checks.allRawInventoryTriplesAccounted, false);
  assert.equal(report.passed, false);
});

test('an unusable listing record cannot waive an unverified in-stock raw SKU', () => {
  const result = verifiedResult();
  result.receipt.coverage.publicPriceExcludedUnmatchedIdentityRows[0].rawSoldOut = false;
  assert.equal(verifyGoldboxResult(result).checks.allRawInventoryTriplesAccounted, false);
});

test('invalid raw identity fails even when inventory arithmetic balances', () => {
  const result = verifiedResult();
  result.receipt.coverage.invalidIdentityRows = 1;
  result.receipt.coverage.rawIdentityRows = 2;
  result.receipt.coverage.uniqueRawIdentityTriples = 2;
  assert.equal(verifyGoldboxResult(result).checks.rawIdentityRowsAccounted, false);
});

test('an exact native offer fallback verifies general price while WOW remains unknown', () => {
  const result = verifiedResult();
  result.items[0].deal.widgetFinalPrice = null;
  result.items[0].deal.publicOfferGeneralPrice = { amount: 1000 };
  result.items[0].deal.widgetPriceReadStatus = 'not_found_in_complete_catalog_scan';
  result.items[0].deal.publicOfferGeneralPriceReadStatus = 'matched_public_offer_general_price';
  result.receipt.publicOfferFallback = { pages: [{ status: 200, selectedIdentityMatches: true }],
    visitorBootstrapCount: 0, states: { live_replay: true } };
  const report = verifyGoldboxResult(result);
  assert.equal(report.passed, true);
  assert.equal(report.rows[0].generalPriceSource, 'coupang_public_offer_list');
  assert.equal(report.rows[0].advertisedPrice, null);
  result.receipt.publicOfferFallback.pages[0].errorCode = 'COUPANG_CONSUMER_OFFER_LIST_SCHEMA';
  assert.equal(verifyGoldboxResult(result).passed, false);
  delete result.receipt.publicOfferFallback.pages[0].errorCode;
  result.receipt.publicOfferFallback.pages[0].status = 403;
  assert.equal(verifyGoldboxResult(result).passed, false);
});

function verifiedPublicResult() {
  const generalPrice = { amount: 1000, currency: 'KRW', basis: 'widget_final_price_field' };
  return { priceRows: [{ productId: '1', itemId: '2', vendorItemId: '3', productTitle: '공개 상품',
    productUrl: 'https://www.coupang.com/vp/products/1?itemId=2&vendorItemId=3', sourceClassification: 'consumer_product',
    soldOut: false, generalPrice, widgetGeneralPrice: generalPrice, generalPriceSource: 'coupang_mlp_goldbox_widget',
    originalPrice: { amount: 1500, currency: 'KRW' }, advertisedPriceReadStatus: 'absent', advertisedWowPrice: null,
    wowSalePrice: null, conditionalCouponPrice: null, memberPriceVerified: false }],
    items: [{ title: '공개 상품', url: 'https://www.coupang.com/vp/products/1?itemId=2&vendorItemId=3',
      deal: { productId: '1', itemId: '2', vendorItemId: '3', salePrice: 1500,
        widgetFinalPrice: generalPrice, widgetPriceReadStatus: 'matched_without_explicit_wow_price' } }],
    receipt: { inventorySource: 'coupang_mlp_goldbox_widget', status: 'complete',
      legacyListingRequested: false, browserUsed: false, ownerCredentialUsed: false,
      credentialsUsed: false, credentialPropagated: false,
      states: { live_replay: true }, coverage: { catalogScanComplete: true, catalogRowsComplete: true,
        allCatalogPriceRowsAccounted: true, catalogReturnedRows: 1, catalogUniqueTriples: 1,
        catalogConflictingTriples: 0, catalogExcludedTriples: 0, invalidIdentityRows: 0, invalidNormalizedRows: 0,
        specialPriceClassificationComplete: true, couponEligibilityVerified: false, memberPriceVerified: false,
        allRetailerPricePathsComplete: false },
      widget: { paginationExhausted: true, browserUsed: false, ownerCredentialUsed: false, credentialPropagated: false,
        pages: [{ status: 200 }], visitorBootstraps: [{ status: 200 }], states: { live_replay: true } },
      publicOfferFallback: { pages: [] } } };
}

test('required public WOW coverage retains in-stock identities with missing descriptive metadata', () => {
  const result = verifiedPublicResult();
  const confirmed = result.priceRows[0];
  confirmed.advertisedPriceReadStatus = 'valid';
  confirmed.advertisedWowPrice = { amount: 800, currency: 'KRW', label: '할인가', eligibilityVerified: false };
  confirmed.wowSalePrice = 800;
  result.priceRows.push({ ...structuredClone(confirmed), productId: '4', itemId: '5', vendorItemId: '6',
    productTitle: null, productUrl: null, advertisedPriceReadStatus: 'absent', advertisedWowPrice: null, wowSalePrice: null });
  const report = verifyGoldboxResult(result, { requireWowPrices: true });
  assert.equal(report.wowPriceCoverage.expectedRows, 2);
  assert.equal(report.wowPriceCoverage.verifiedAdvertisedRows, 1);
  assert.equal(report.wowPriceCoverage.unverifiedRows, 1);
  assert.equal(report.wowPriceCoverage.complete, false);
  assert.equal(report.checks.requiredWowPricesPresent, false);
});

test('advertised WOW rows cannot complete coverage while catalog inventory is unfinished', () => {
  const result = verifiedPublicResult();
  result.priceRows[0].advertisedPriceReadStatus = 'valid';
  result.priceRows[0].advertisedWowPrice = { amount: 800, currency: 'KRW', label: '할인가', eligibilityVerified: false };
  result.priceRows[0].wowSalePrice = 800;
  assert.equal(verifyGoldboxResult(result, { requireWowPrices: true }).passed, true);
  result.receipt.coverage.catalogScanComplete = false;
  result.receipt.widget.paginationExhausted = false;
  const report = verifyGoldboxResult(result, { requireWowPrices: true });
  assert.equal(report.wowPriceCoverage.verifiedAdvertisedRows, 1);
  assert.equal(report.wowPriceCoverage.inventoryComplete, false);
  assert.equal(report.wowPriceCoverage.complete, false);
  assert.equal(report.checks.requiredWowPricesPresent, false);
  assert.equal(report.passed, false);
});

test('unknown stock cannot disappear from required WOW inventory even when every known in-stock row has WOW', () => {
  const result = verifiedPublicResult();
  result.priceRows[0].advertisedPriceReadStatus = 'valid';
  result.priceRows[0].advertisedWowPrice = { amount: 800, currency: 'KRW', label: '할인가', eligibilityVerified: false };
  result.priceRows[0].wowSalePrice = 800;
  result.priceRows.push({ ...structuredClone(result.priceRows[0]), productId: '4', itemId: '5', vendorItemId: '6',
    productTitle: null, productUrl: null, soldOut: null });
  result.receipt.coverage.catalogReturnedRows = 2;
  result.receipt.coverage.catalogUniqueTriples = 2;
  const report = verifyGoldboxResult(result, { requireWowPrices: true });
  assert.equal(report.wowPriceCoverage.expectedRows, 1);
  assert.equal(report.wowPriceCoverage.verifiedAdvertisedRows, 1);
  assert.equal(report.checks.stockStateExplicit, false);
  assert.equal(report.wowPriceCoverage.inventoryComplete, false);
  assert.equal(report.wowPriceCoverage.complete, false);
  assert.equal(report.checks.requiredWowPricesPresent, false);
  assert.equal(report.passed, false);
});

test('public catalog verification uses the current source and retains original-price and scope evidence', () => {
  const result = verifiedPublicResult(), report = verifyGoldboxResult(result);
  assert.equal(report.passed, true);
  assert.equal(report.checks.comparisonUsesVerifiedGeneralPrice, true);
  assert.equal(report.rows[0].generalPrice, 1000);
  assert.equal(report.rows[0].originalPrice, 1500);
  assert.equal(report.verifiedPriceRows, 1);
  assert.ok(report.exclusions.includes('authenticated_coupon_and_card_eligibility'));
  result.items[0].deal.widgetPriceReadStatus = 'read_failed';
  assert.equal(verifyGoldboxResult(result).checks.comparisonUsesVerifiedGeneralPrice, false);
});

test('public verification cannot hide malformed or unclassified special fields as no special', () => {
  const result = verifiedPublicResult();
  result.priceRows[0].advertisedPriceReadStatus = 'invalid';
  assert.equal(verifyGoldboxResult(result).checks.advertisedPricesClassified, false);
  result.priceRows[0].advertisedPriceReadStatus = 'valid';
  result.priceRows[0].advertisedWowPrice = { amount: 800, currency: 'KRW', label: '새 조건가', eligibilityVerified: false };
  assert.equal(verifyGoldboxResult(result).checks.advertisedPricesClassified, false);
});

test('public verification preserves disabled/dimmed displayed prices without claiming eligibility', () => {
  const result = verifiedPublicResult();
  result.priceRows[0].advertisedPriceReadStatus = 'valid';
  result.priceRows[0].advertisedWowPrice = { amount: 800, currency: 'KRW', label: '할인가',
    conditional: false, boxEnabled: false, dimmed: true, eligibilityVerified: false };
  result.priceRows[0].wowSalePrice = 800;
  let report = verifyGoldboxResult(result);
  assert.equal(report.passed, true);
  assert.equal(report.rows[0].boxEnabled, false);
  assert.equal(report.rows[0].dimmed, true);
  assert.equal(report.rows[0].eligibilityVerified, false);
  result.priceRows[0].advertisedWowPrice.eligibilityVerified = true;
  assert.equal(verifyGoldboxResult(result).passed, false);
});

test('public verification fails missing rows, missing prices, partial scans, and hidden legacy requests', () => {
  for (const mutate of [
    result => { result.receipt.coverage.catalogUniqueTriples = 2; },
    result => { result.priceRows[0].generalPrice = null; },
    result => { result.receipt.widget.paginationExhausted = false; },
    result => { result.receipt.legacyListingRequested = true; },
    result => { result.priceRows[0].soldOut = null; },
    result => { result.receipt.states.live_replay = false; },
    result => { result.receipt.credentialsUsed = true; },
    result => { result.receipt.widget.credentialPropagated = true; },
  ]) {
    const result = verifiedPublicResult(); mutate(result);
    assert.equal(verifyGoldboxResult(result).passed, false);
  }
});
