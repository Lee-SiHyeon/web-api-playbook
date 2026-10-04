import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchCoupangGoldbox } from '../lib/coupang-goldbox.mjs';
import { selectGoldboxGeneralPrice } from '../lib/coupang-goldbox-price.mjs';

const positiveKrw = value => value?.currency === 'KRW' && Number.isSafeInteger(value.amount) && value.amount > 0;
const identityKey = row => `${row.productId}:${row.itemId}:${row.vendorItemId}`;
const validId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

export function verifyPublicGoldboxResult(result, { requireWowPrices = false } = {}) {
  const receipt = result?.receipt ?? {}, coverage = receipt.coverage ?? {};
  const widget = receipt.widget ?? {}, fallback = receipt.publicOfferFallback ?? {};
  const priceRows = Array.isArray(result?.priceRows) ? result.priceRows : [];
  const items = Array.isArray(result?.items) ? result.items : [];
  // Metadata gaps must not remove an in-stock identity from required WOW coverage.
  const wowTargets = priceRows.filter(row => row.soldOut === false
    && [row.productId, row.itemId, row.vendorItemId].every(validId));
  const confirmedWowTargets = wowTargets.filter(row => row.advertisedPriceReadStatus === 'valid'
    && row.advertisedWowPrice?.label === '할인가' && positiveKrw(row.advertisedWowPrice)
    && row.wowSalePrice === row.advertisedWowPrice.amount);
  const wowInventoryComplete = coverage.catalogScanComplete === true && coverage.catalogRowsComplete === true
    && widget.paginationExhausted === true && coverage.catalogReturnedRows === priceRows.length
    && coverage.catalogUniqueTriples === priceRows.length && coverage.catalogConflictingTriples === 0
    && coverage.catalogExcludedTriples === 0 && coverage.invalidIdentityRows === 0 && coverage.invalidNormalizedRows === 0
    && priceRows.every(row => typeof row.soldOut === 'boolean'
      && [row.productId, row.itemId, row.vendorItemId].every(validId))
    && new Set(priceRows.map(identityKey)).size === priceRows.length;
  const wowPriceCoverageComplete = wowInventoryComplete
    && wowTargets.length > 0 && confirmedWowTargets.length === wowTargets.length;
  const pricesByKey = new Map(priceRows.map(row => [identityKey(row), row]));
  const specialValid = row => {
    const price = row.advertisedWowPrice;
    if (row.advertisedPriceReadStatus === 'invalid') return false;
    if (price === null) return row.wowSalePrice === null && row.conditionalCouponPrice === null;
    if (!positiveKrw(price) || typeof price.label !== 'string' || !price.label.trim()
      || price.eligibilityVerified !== false) return false;
    return price.label === '가입 쿠폰가'
      ? row.wowSalePrice === null && positiveKrw(row.conditionalCouponPrice)
        && row.conditionalCouponPrice.amount === price.amount && price.conditional === true
      : price.label === '할인가'
        ? row.wowSalePrice === price.amount && row.conditionalCouponPrice === null
        : false;
  };
  const checks = {
    receiptComplete: receipt.status === 'complete',
    publicWidgetInventory: receipt.inventorySource === 'coupang_mlp_goldbox_widget',
    catalogExhausted: coverage.catalogScanComplete === true && widget.paginationExhausted === true,
    catalogRowsComplete: coverage.catalogRowsComplete === true,
    nonemptyCatalog: priceRows.length > 0,
    allCatalogPriceRowsAccounted: coverage.allCatalogPriceRowsAccounted === true
      && coverage.catalogReturnedRows === priceRows.length
      && coverage.catalogUniqueTriples === priceRows.length
      && coverage.catalogConflictingTriples === 0 && coverage.catalogExcludedTriples === 0
      && coverage.invalidIdentityRows === 0 && coverage.invalidNormalizedRows === 0,
    exactPriceTriplesUnique: new Set(priceRows.map(identityKey)).size === priceRows.length
      && priceRows.every(row => [row.productId, row.itemId, row.vendorItemId].every(validId)),
    allGeneralPricesPresent: priceRows.every(row => positiveKrw(row.generalPrice)),
    generalPriceSourcesKnown: priceRows.every(row => ['coupang_mlp_goldbox_widget', 'coupang_public_offer_list']
      .includes(row.generalPriceSource)),
    advertisedPricesClassified: coverage.specialPriceClassificationComplete === true
      && priceRows.every(specialValid),
    noMemberEligibilityClaim: priceRows.every(row => row.memberPriceVerified === false)
      && coverage.couponEligibilityVerified === false && coverage.memberPriceVerified === false,
    stockStateExplicit: priceRows.every(row => typeof row.soldOut === 'boolean'),
    allReturnedItemsReconciled: items.length === priceRows.filter(row => row.productTitle && row.productUrl && row.soldOut !== true).length
      && items.every(item => {
        const row = pricesByKey.get(identityKey(item.deal ?? {}));
        return row && row.productUrl === item.url && row.soldOut === false;
      }),
    comparisonUsesVerifiedGeneralPrice: items.every(item => {
      const selected = selectGoldboxGeneralPrice(item.deal);
      const row = pricesByKey.get(identityKey(item.deal ?? {}));
      return row && selected?.verified === true && selected.amount === row.generalPrice?.amount
        && selected.source === row.generalPriceSource;
    }),
    allWidgetPages200: widget.pages?.length > 0 && widget.pages.every(page => page.status === 200 && !page.errorCode),
    publicBootstrap200: widget.visitorBootstraps?.length > 0
      && widget.visitorBootstraps.every(row => row.status === 200),
    allFallbackReads200: Array.isArray(fallback.pages) && fallback.pages.every(page => page.status === 200
      && !page.errorCode && page.selectedIdentityMatches === true),
    nativeLiveReplay: receipt.states?.live_replay === true && widget.states?.live_replay === true,
    noBrowserOrOwnerCredential: receipt.browserUsed === false && receipt.ownerCredentialUsed === false
      && receipt.credentialsUsed === false && receipt.credentialPropagated === false
      && widget.browserUsed === false && widget.ownerCredentialUsed === false && widget.credentialPropagated === false,
    legacyListingNotRequested: receipt.legacyListingRequested === false,
    broaderCoverageNotClaimed: coverage.allRetailerPricePathsComplete === false,
    requiredWowPricesPresent: !requireWowPrices || wowPriceCoverageComplete,
  };
  const rows = priceRows.map(row => ({
    productId: row.productId, itemId: row.itemId, vendorItemId: row.vendorItemId,
    title: row.productTitle, productUrl: row.productUrl, sourceClassification: row.sourceClassification,
    soldOut: row.soldOut, generalPrice: row.generalPrice?.amount ?? null,
    generalPriceSource: row.generalPriceSource, generalPriceBasis: row.generalPrice?.basis ?? null,
    widgetGeneralPrice: row.widgetGeneralPrice?.amount ?? null,
    publicOfferGeneralPrice: row.publicOfferGeneralPrice?.amount ?? null,
    originalPrice: row.originalPrice?.amount ?? null,
    advertisedPriceReadStatus: row.advertisedPriceReadStatus ?? null,
    advertisedPrice: row.advertisedWowPrice?.amount ?? null,
    advertisedPriceLabel: row.advertisedWowPrice?.label ?? null,
    boxEnabled: row.advertisedWowPrice?.boxEnabled ?? null, dimmed: row.advertisedWowPrice?.dimmed ?? null,
    conditional: row.advertisedWowPrice?.conditional ?? null,
    eligibilityVerified: row.advertisedWowPrice?.eligibilityVerified ?? false,
    wowSalePrice: row.wowSalePrice, conditionalCouponPrice: row.conditionalCouponPrice?.amount ?? null,
    memberPriceVerified: row.memberPriceVerified,
  }));
  return { schemaVersion: 2, operation: 'maintained_public_goldbox_price_verification',
    scope: 'current_public_goldbox_catalog_general_and_advertised_special_prices',
    passed: Object.values(checks).every(value => value === true), checks, receipt,
    wowPriceCoverage: { scope: 'all_in_stock_catalog_identities', required: requireWowPrices, complete: wowPriceCoverageComplete,
      inventoryComplete: wowInventoryComplete,
      expectedRows: wowTargets.length, verifiedAdvertisedRows: confirmedWowTargets.length,
      unverifiedRows: wowTargets.length - confirmedWowTargets.length,
      memberEligibilityVerified: false },
    returnedItems: items.length, verifiedPriceRows: rows.length, rows,
    exclusions: ['consumer_reviews', 'authenticated_coupon_and_card_eligibility',
      'account_context_quantity_final_price', 'complete_product_option_catalog', 'delivery_inclusive_payable_total'],
  };
}

// All available listing rows are checked; this does not assert that every consumer
// API or an authenticated checkout accepts the same anonymous visitor context.
export function verifyGoldboxResult(result, { requireWowPrices = false } = {}) {
  if (result?.receipt?.inventorySource === 'coupang_mlp_goldbox_widget') return verifyPublicGoldboxResult(result, { requireWowPrices });
  const receipt = result?.receipt ?? {}, coverage = receipt.coverage ?? {};
  const widget = receipt.widget ?? {}, fallback = receipt.publicOfferFallback ?? {}, items = result?.items ?? [];
  const exclusionCounts = Object.values(coverage.mappingExclusions ?? {});
  const excludedIdentities = coverage.publicPriceExcludedUnmatchedIdentityRows ?? [];
  const positiveId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
  const mapped = coverage.mappedRows, unmapped = coverage.unmappedRows;
  const rows = items.map(item => ({
    productId: item.deal.productId, itemId: item.deal.itemId, vendorItemId: item.deal.vendorItemId,
    title: item.title, legacyGeneralPrice: item.deal.salePrice,
    widgetGeneralPrice: item.deal.widgetFinalPrice?.amount ?? null,
    publicOfferGeneralPrice: item.deal.publicOfferGeneralPrice?.amount ?? null,
    verifiedGeneralPrice: item.deal.widgetFinalPrice?.amount ?? item.deal.publicOfferGeneralPrice?.amount ?? null,
    generalPriceSource: item.deal.widgetFinalPrice?.amount != null ? 'coupang_mlp_goldbox_widget'
      : item.deal.publicOfferGeneralPrice?.amount != null ? 'coupang_public_offer_list' : null,
    advertisedPrice: item.deal.advertisedWowPrice?.amount ?? null,
    advertisedPriceLabel: item.deal.advertisedWowPrice?.label ?? null,
    wowSalePrice: item.deal.wowSalePrice,
    conditionalCouponPrice: item.deal.conditionalCouponPrice?.amount ?? null,
    memberPriceVerified: item.deal.memberPriceVerified, widgetReadStatus: item.deal.widgetPriceReadStatus,
    readStatus: item.deal.widgetFinalPrice?.amount != null ? item.deal.widgetPriceReadStatus
      : item.deal.publicOfferGeneralPriceReadStatus ?? item.deal.widgetPriceReadStatus,
  }));
  const checks = {
    receiptComplete: receipt.status === 'complete',
    nonemptyInventory: Number.isSafeInteger(coverage.listingRows) && coverage.listingRows > 0,
    allListingRowsAccounted: Number.isSafeInteger(mapped) && Number.isSafeInteger(unmapped)
      && mapped + unmapped === coverage.listingRows,
    allExclusionsAccounted: exclusionCounts.length > 0
      && exclusionCounts.every(n => Number.isSafeInteger(n) && n >= 0)
      && exclusionCounts.reduce((sum, n) => sum + n, 0) === unmapped,
    allInStockRowsReturned: items.length === coverage.inStockMappedRows,
    rawIdentityRowsAccounted: coverage.invalidIdentityRows === 0
      && coverage.rawIdentityRows + coverage.invalidIdentityRows === coverage.listingRows
      && coverage.rawIdentityRows === coverage.uniqueRawIdentityTriples + coverage.duplicateIdentityRows,
    allRawInventoryTriplesAccounted: coverage.publicPriceMatchedTriples + coverage.publicPriceExcludedUnmatchedTriples === coverage.uniqueRawIdentityTriples
      && coverage.publicPriceUnmatchedTriples === coverage.publicPriceExcludedUnmatchedTriples
      && coverage.publicPriceExcludedUnmatchedTriples === excludedIdentities.length
      && coverage.publicPriceUnaccountedRawIdentityTriples === 0
      && excludedIdentities.every(row => ['sold_out_listing', 'unmapped_listing'].includes(row.reason)
        && row.rawSoldOut === true && [row.productId, row.itemId, row.vendorItemId].every(positiveId))
      && new Set(excludedIdentities.map(row => `${row.productId}:${row.itemId}:${row.vendorItemId}`)).size === excludedIdentities.length,
    allInStockTriplesMatched: coverage.inStockMappedRowsWithoutExactIdentity === 0
      && coverage.publicPricingCoverageComplete === true
      && coverage.publicUnmatchedInStockMappedTriples === 0
      && coverage.expectedInStockMappedTriples === coverage.publicMatchedInStockMappedTriples,
    listing200: receipt.listingHttpStatus === 200,
    allWidgetPages200: widget.pages?.length > 0 && widget.pages.every(page => page.status === 200 && !page.errorCode),
    onePublicBootstrap200: widget.visitorBootstraps?.length === 1
      && widget.visitorBootstraps.every(row => row.status === 200) && fallback.visitorBootstrapCount === 0,
    allFallbackReads200: Array.isArray(fallback.pages) && fallback.pages.every(page => page.status === 200
      && !page.code && !page.errorCode && page.selectedIdentityMatches === true),
    nativeLiveReplay: widget.states?.live_replay === true
      && (fallback.pages?.length === 0 || fallback.states?.live_replay === true),
    noOwnerCredential: widget.ownerCredentialUsed === false,
    noMemberEligibilityClaim: rows.every(row => row.memberPriceVerified === false),
    exactReturnedTriplesUnique: new Set(rows.map(row => `${row.productId}:${row.itemId}:${row.vendorItemId}`)).size === rows.length,
    allReturnedRowsMatched: rows.every(row => row.readStatus?.startsWith('matched_')),
    generalPricesPresent: rows.every(row => Number.isSafeInteger(row.verifiedGeneralPrice) && row.verifiedGeneralPrice > 0),
    advertisedPricesClassified: rows.every(row => row.advertisedPriceLabel === '가입 쿠폰가'
      ? row.advertisedPrice !== null && row.wowSalePrice === null && row.conditionalCouponPrice === row.advertisedPrice
      : row.advertisedPriceLabel === '할인가'
        ? row.advertisedPrice !== null && row.wowSalePrice === row.advertisedPrice && row.conditionalCouponPrice === null
        : row.wowSalePrice === null && row.conditionalCouponPrice === null),
    requiredWowPricesPresent: !requireWowPrices || rows.length > 0 && rows.every(row =>
      row.advertisedPriceLabel === '할인가' && Number.isSafeInteger(row.wowSalePrice) && row.wowSalePrice > 0),
  };
  return { schemaVersion: 1, operation: 'maintained_goldbox_price_verification',
    passed: Object.values(checks).every(value => value === true), checks, receipt, returnedItems: rows.length, rows,
    exclusions: ['full_product_description_http_restricted_403', 'authenticated_member_eligibility',
      'consumer_reviews_and_sellers_outside_this_price_verification'],
  };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.includes('--live') || args.length !== new Set(args).size
    || args.some(arg => !['--live', '--write', '--require-wow'].includes(arg))) {
    console.error('Usage: node apps/affiliate-api-hub/scripts/verify-coupang-goldbox.mjs --live [--write] [--require-wow]');
    return 2;
  }
  const observedAt = new Date().toISOString();
  let report;
  try { report = { observedAt, ...verifyGoldboxResult(await fetchCoupangGoldbox(1000, {
    publicOfferFallbackLimit: 1000, shippingEnrichmentEnabled: false,
  }),
    { requireWowPrices: args.includes('--require-wow') }) }; }
  catch (error) { report = { observedAt, passed: false,
    errorCode: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'VERIFICATION_FAILED',
    httpStatus: error.httpStatus ?? null }; }
  report.finishedAt = new Date().toISOString();
  let outputFile = null;
  if (args.includes('--write')) {
    const directory = new URL(`../../../../runs/coupang-goldbox-verification-${observedAt.replace(/[:.]/g, '-')}/`, import.meta.url);
    await mkdir(directory, { recursive: true });
    const target = new URL('verification.json', directory);
    await writeFile(target, JSON.stringify(report, null, 2));
    outputFile = fileURLToPath(target);
  }
  console.log(JSON.stringify({ observedAt, passed: report.passed, errorCode: report.errorCode ?? null,
    coverage: report.receipt?.coverage ?? null, checks: report.checks ?? null,
    wowPriceCoverage: report.wowPriceCoverage ?? null,
    pageStatuses: report.receipt?.widget?.pages?.map(page => page.status) ?? [],
    fallbackStatuses: report.receipt?.publicOfferFallback?.pages?.map(page => page.status) ?? [],
    returnedItems: report.returnedItems ?? 0, outputFile }));
  return report.passed ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  process.exitCode = await main();
