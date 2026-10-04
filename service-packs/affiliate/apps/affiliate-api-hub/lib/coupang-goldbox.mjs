// 쿠팡 골드박스 (daily deals) from the public Goldbox page's own product call.
// Observed 2026-09-24: https://www.coupang.com/np/goldbox 302 -> https://pages.coupang.com/p/121237 (public),
// whose client bundle calls POST https://pages.coupang.com/api/products {goldbox:true, releaseDate:null}.
// One anonymous call returned 200 JSON (205 products). Consumer product HTML separately returns Akamai
// 403; this listing client does not request it. Links are plain product URLs, not issued affiliate links.
import { createHash } from 'node:crypto';
import { fetchCoupangGoldboxWidgetPrices, CoupangGoldboxWidgetError } from '../adapters/coupang-goldbox-widget.mjs';
import { CoupangConsumerError, readCoupangConsumerOfferList } from '../adapters/coupang-consumer.mjs';
import { createCoupangVisitorContext } from './coupang-visitor-context.mjs';
import { fetchPublicCoupangGoldbox } from './coupang-goldbox-public.mjs';

const ENDPOINT = 'https://pages.coupang.com/api/products';
const PAGE = 'https://pages.coupang.com/p/121237?sourceType=oms_goldbox';
const UA = 'affiliate-content-operations/1.0';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PUBLIC_OFFER_FALLBACK = 5;
const MAX_EXHAUSTIVE_PUBLIC_OFFER_FALLBACK = 1000;

const fail = (code, details = {}) => Object.assign(new Error(code), { code, ...details });
const won = value => { const n = Number(String(value ?? '').replace(/[^\d]/g, '')); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const positiveId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 1000) || null : null;
const percent = value => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
function productImage(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, 'https://pages.coupang.com');
    return url.protocol === 'https:' && url.hostname === 'thumbnail.coupangcdn.com' && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

function canonicalProductLink(p) {
  const productId = positiveId(p?.productId);
  if (!productId || typeof p?.link !== 'string' || p.link.length > 4096 || /[\r\n\0]/.test(p.link)) return null;
  try {
    const url = new URL(p.link, 'https://www.coupang.com');
    if (url.origin !== 'https://www.coupang.com' || url.username || url.password || url.port || url.hash
      || url.pathname !== `/vp/products/${productId}`) return null;
    if (url.searchParams.getAll('itemId').length > 1 || url.searchParams.getAll('vendorItemId').length > 1) return null;
    const itemId = positiveId(p.itemId), vendorItemId = positiveId(p.vendorItemId);
    if (p.itemId != null && !itemId || p.vendorItemId != null && !vendorItemId) return null;
    const hasSourceItem = itemId !== null, hasSourceVendor = vendorItemId !== null;
    const hasLinkItem = url.searchParams.has('itemId'), hasLinkVendor = url.searchParams.has('vendorItemId');
    if (hasSourceItem !== hasSourceVendor || hasLinkItem !== hasLinkVendor) return null;
    if (hasSourceItem && (!hasLinkItem || url.searchParams.get('itemId') !== itemId
      || url.searchParams.get('vendorItemId') !== vendorItemId)) return null;
    if (!hasSourceItem && (hasLinkItem || hasLinkVendor)) return null;
    return url.href;
  } catch { return null; }
}

function listingMappingExclusion(p) {
  const hasTitle = typeof p?.imageAndTitleArea?.title === 'string' && p.imageAndTitleArea.title.trim().length > 0;
  const hasUsableLink = canonicalProductLink(p) !== null;
  if (hasTitle && hasUsableLink) return null;
  if (!hasTitle && !hasUsableLink) return 'missingTitleAndInvalidProductLink';
  if (!hasTitle) return 'missingTitle';
  return 'invalidOrSkuMismatchedProductLink';
}

function identityKey(p) {
  const productId = positiveId(p?.productId), itemId = positiveId(p?.itemId), vendorItemId = positiveId(p?.vendorItemId);
  if (!productId || !itemId || !vendorItemId) return null;
  return `${productId}:${itemId}:${vendorItemId}`;
}

export function mapGoldboxProduct(p) {
  const title = String(p?.imageAndTitleArea?.title ?? '').trim();
  const link = canonicalProductLink(p);
  if (!title || !link) return null;
  const price = p.priceArea ?? {};
  const salePrice = won(price.salesPrice ?? price.price);
  const originalPrice = won(price.originalPrice ?? price.basePrice);
  const discountRate = Number.isFinite(price.discountRate) ? price.discountRate : null;
  const eventEnd = typeof p.promotionClosingArea?.expiryDateUTC === 'string' && Number.isFinite(Date.parse(p.promotionClosingArea.expiryDateUTC))
    ? new Date(p.promotionClosingArea.expiryDateUTC).toISOString() : null;
  const reviews = Number.isSafeInteger(p.reviewArea?.ratingCountNum) ? p.reviewArea.ratingCountNum : null;
  const rating = Number.isFinite(p.reviewArea?.ratingAverage) ? p.reviewArea.ratingAverage : null;
  const soldOut = p.soldoutArea?.soldout === true;
  const rocket = typeof p.rocketArea?.layoutType === 'string' ? p.rocketArea.layoutType : null;
  // This response carries the general listed price, not the numeric WOW price.
  // Browser readback 2026-10-02: promotionClosingArea.rate = 60 was "60% 판매됨", while the WOW discount was 39%.
  const promoCode = typeof p.promotionClosingArea?.manageCode === 'string' ? p.promotionClosingArea.manageCode : '';
  const wowPromotion = /wow/i.test(promoCode);
  const promotionSoldPercent = percent(p.promotionClosingArea?.rate);
  const listingContent = {
    coverage: 'listing_only', description: text(p.imageAndTitleArea?.description),
    imageUrl: productImage(p.imageAndTitleArea?.defaultUrl),
    unitPriceText: text(p.instantDiscountBundlePriceArea?.unitPriceDescription),
    deliveryText: Array.isArray(p.promisedDeliveryDateArea?.contents)
      ? text(p.promisedDeliveryDateArea.contents.slice(0, 12).map(part => text(part?.text) ?? '').join(' ')) : null,
    cashbackText: text(p.cashBackArea?.cashRewardText),
    additionalBenefitText: text(p.additionalBenefit?.description),
    benefitBadges: Array.isArray(p.benefitBadgeArea?.badgeAreaContents)
      ? [...new Set(p.benefitBadgeArea.badgeAreaContents.slice(0, 12).map(badge => text(badge?.title)).filter(Boolean))] : [],
  };
  const fmt = n => n === null ? null : `${n.toLocaleString('ko-KR')}원`;
  const summary = [salePrice !== null ? `${fmt(salePrice)}${originalPrice && originalPrice !== salePrice ? ` (정가 ${fmt(originalPrice)}, ${discountRate ?? '?'}%↓)` : ''}` : '가격 미확인',
    eventEnd ? `특가 종료 ${eventEnd}` : null, reviews !== null ? `리뷰 ${reviews.toLocaleString('ko-KR')}개${rating !== null ? ` ★${rating}` : ''}` : null,
    rocket ? rocket : null, soldOut ? '품절' : null, listingContent.description, listingContent.unitPriceText,
    listingContent.deliveryText, listingContent.cashbackText, listingContent.additionalBenefitText,
    ...listingContent.benefitBadges].filter(Boolean).join(' · ');
  return {
    title,
    url: link,
    publishedAt: null,
    publisher: '쿠팡 골드박스',
    summary,
    engagement: { reviews, rating },
    deal: { productId: positiveId(p.productId) ?? '', itemId: positiveId(p.itemId) ?? '', vendorItemId: positiveId(p.vendorItemId) ?? '',
      price: originalPrice, salePrice, discountRate, eventEnd, soldOut, rocket,
      wowPromotion, promotionSoldPercent, wowSalePrice: null, memberPriceVerified: false,
      wowPromotionRate: null, // Retired misleading field, kept null for existing readers.
      listingContent, affiliateLink: false },
  };
}

function attachWidgetPrice(item, widgetRow, { readStatus, errorCode = null } = {}) {
  item.deal.advertisedWowPrice = widgetRow?.advertisedWowPrice ?? null;
  item.deal.wowSalePrice = widgetRow?.wowSalePrice ?? null;
  item.deal.conditionalCouponPrice = widgetRow?.conditionalCouponPrice ?? null;
  item.deal.memberPriceVerified = false;
  item.deal.widgetPriceReadStatus = readStatus;
  item.deal.widgetPriceReadError = errorCode;
  item.deal.widgetFinalPrice = widgetRow?.generalPrice ?? null;
  item.deal.widgetOriginalPrice = widgetRow?.originalPrice ?? null;
  item.deal.widgetProductTitle = widgetRow?.productTitle ?? null;
  item.deal.widgetFinalPriceMatchesListingSalePrice = widgetRow?.generalPrice?.amount == null
    ? null : widgetRow.generalPrice.amount === item.deal.salePrice;
  if (widgetRow?.wowSalePrice !== null && widgetRow?.wowSalePrice !== undefined) item.deal.wowPromotion = true;

  const price = widgetRow?.advertisedWowPrice;
  if (price) {
    const formatted = `${price.amount.toLocaleString('ko-KR')}원`;
    const extra = price.label === '가입 쿠폰가' ? `${price.label} ${formatted} (가입 조건 적용 여부 미확인)`
      : price.label === '할인가' ? `골드박스 ${price.label} ${formatted}`
        : `${price.label ?? '위젯 표시가'} ${formatted}`;
    item.summary = [item.summary, extra].filter(Boolean).join(' · ');
  }
  return item;
}

const hasPositiveKrwPrice = price => price?.currency === 'KRW'
  && Number.isSafeInteger(price.amount) && price.amount > 0;
const wait = ms => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();

function offerListProductUrl(meta) {
  return `https://www.coupang.com/vp/products/${meta.productId}?itemId=${meta.itemId}&vendorItemId=${meta.vendorItemId}`;
}

function exactSelectedOffer(result, meta) {
  const selected = result?.selectedOffer;
  return result?.productId === meta.productId && result?.itemId === meta.itemId
    && result?.selectedVendorItemId === meta.vendorItemId
    && selected?.selected === true && selected.productId === meta.productId
    && selected.itemId === meta.itemId && selected.vendorItemId === meta.vendorItemId
    && hasPositiveKrwPrice(selected.price);
}

// The recurring collector uses the current public widget catalog without a
// legacy POST or browser identity. Keep the legacy contract explicitly named for diagnostics.
export function fetchCoupangGoldbox(limit, options = {}) {
  return fetchPublicCoupangGoldbox(limit, options);
}

export async function fetchCoupangGoldboxLegacy(limit, {
  fetchImpl = globalThis.fetch, publicOfferFallbackDelayMs = 1000,
  publicOfferFallbackLimit = MAX_PUBLIC_OFFER_FALLBACK,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isSafeInteger(publicOfferFallbackDelayMs)
    || publicOfferFallbackDelayMs < 0 || publicOfferFallbackDelayMs > 10000
    || !Number.isSafeInteger(publicOfferFallbackLimit) || publicOfferFallbackLimit < 0
    || publicOfferFallbackLimit > MAX_EXHAUSTIVE_PUBLIC_OFFER_FALLBACK) throw fail('LIMIT');
  let response;
  try {
    response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', accept: 'application/json', 'content-type': 'application/json',
        origin: 'https://pages.coupang.com', referer: PAGE },
      body: JSON.stringify({ goldbox: true, releaseDate: null }) });
  } catch { throw fail('TRANSPORT'); }
  if (response.status === 403 || response.status === 429) throw fail('ACCESS_BLOCKED', { httpStatus: response.status });
  if (response.status !== 200) throw fail('HTTP_STATUS', { httpStatus: response.status });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw fail('SOURCE_TOO_LARGE');
  let data;
  try { data = JSON.parse(text); } catch { throw fail('NOT_JSON'); }
  if (!Array.isArray(data)) throw fail('SCHEMA');
  const mappingExclusions = { missingTitle: 0, invalidOrSkuMismatchedProductLink: 0, missingTitleAndInvalidProductLink: 0 };
  const mapped = [];
  for (const raw of data) {
    const exclusion = listingMappingExclusion(raw);
    if (exclusion) { mappingExclusions[exclusion]++; continue; }
    const item = mapGoldboxProduct(raw);
    if (item) mapped.push(item);
    else mappingExclusions.invalidOrSkuMismatchedProductLink++;
  }
  const productKeyMap = new Map(), rawIdentityMeta = new Map();
  let rawIdentityRows = 0, invalidIdentityRows = 0, duplicateIdentityRows = 0;
  for (const raw of data) {
    const key = identityKey(raw);
    if (!key) { invalidIdentityRows++; continue; }
    rawIdentityRows++;
    let meta = rawIdentityMeta.get(key);
    if (!meta) {
      meta = { productId: positiveId(raw.productId), itemId: positiveId(raw.itemId),
        vendorItemId: positiveId(raw.vendorItemId), allRowsSoldOut: true, mappingExclusionReasons: new Set() };
      rawIdentityMeta.set(key, meta);
      productKeyMap.set(key, { productId: meta.productId, itemId: meta.itemId, vendorItemId: meta.vendorItemId });
    } else duplicateIdentityRows++;
    meta.allRowsSoldOut &&= raw?.soldoutArea?.soldout === true;
    const mappingReason = listingMappingExclusion(raw);
    if (mappingReason) meta.mappingExclusionReasons.add(mappingReason);
  }
  const productKeys = [...productKeyMap.values()];
  const expectedInStockMap = new Map();
  let inStockMappedRowsWithoutExactIdentity = 0;
  for (const item of mapped) {
    if (item.deal.soldOut) continue;
    const key = identityKey(item.deal);
    if (key) expectedInStockMap.set(key, { productId: item.deal.productId, itemId: item.deal.itemId,
      vendorItemId: item.deal.vendorItemId });
    else inStockMappedRowsWithoutExactIdentity++;
  }
  const soldOutMappedRows = mapped.filter(item => item.deal.soldOut).length;
  const inStockMappedRows = mapped.length - soldOutMappedRows;
  const visitorContext = productKeys.length ? createCoupangVisitorContext({ fetchImpl }) : null;
  let widgetResult = { rows: [], receipt: { status: 'complete', operation: 'goldbox_widget_read',
    origin: 'https://www.coupang.com', path: '/vm/mlp/v1/newweb/mlp-widget-landing', execution: 'pure_http',
    browserUsed: false, ownerCredentialUsed: false, credentialPropagated: false, visitorCookiesSent: false,
    visitorValuesPersisted: false, retries: 0, retry: false, pageCount: 0, requestCount: 0,
    visitorBootstrapCount: 0, visitorBootstraps: [], pages: [], stopReason: 'no_candidates',
    paginationExhausted: false, coverage: { requestedTriples: 0, matchedTriples: 0, unmatchedTriples: 0,
      explicitWowPriceRows: 0, ordinaryWowPriceRows: 0, conditionalCouponRows: 0,
      exactSkuMismatchesExcluded: 0, malformedRows: 0, duplicateConflicts: 0, pageRowsSeen: 0,
      candidateCoverageComplete: true, catalogScanComplete: false }, states: { captured: true, client_exists: true,
      remnant_free: true, credential_propagated: false, live_replay: false } } };
  let widgetErrorCode = null;
  try {
    widgetResult = await fetchCoupangGoldboxWidgetPrices({ productKeys, fetchImpl, context: visitorContext });
  } catch (error) {
    if (!(error instanceof CoupangGoldboxWidgetError)) throw error;
    widgetErrorCode = error.code;
    widgetResult = { rows: error.partialRows ?? [], receipt: error.receipt ?? { status: 'partial', operation: 'goldbox_widget_read',
      errorCode: error.code, retry: false, coverage: { requestedTriples: productKeys.length, matchedTriples: 0,
        unmatchedTriples: productKeys.length, candidateCoverageComplete: false } } };
  }
  const widgetByKey = new Map(widgetResult.rows.map(row => [`${row.productId}:${row.itemId}:${row.vendorItemId}`, row]));
  const widgetPriceByKey = new Map([...widgetByKey].filter(([, row]) => hasPositiveKrwPrice(row.generalPrice)));
  const widgetExcludedUnmatchedIdentityRows = [];
  for (const [key, meta] of rawIdentityMeta) {
    if (widgetByKey.has(key) || !meta.allRowsSoldOut) continue;
    const reason = 'sold_out_listing';
    widgetExcludedUnmatchedIdentityRows.push({ productId: meta.productId, itemId: meta.itemId,
      vendorItemId: meta.vendorItemId, reason, rawSoldOut: true });
  }
  const widgetMatchedRawIdentityTriples = [...rawIdentityMeta.keys()].filter(key => widgetByKey.has(key)).length;
  const unaccountedRawIdentityTriples = Math.max(0, rawIdentityMeta.size - widgetMatchedRawIdentityTriples
    - widgetExcludedUnmatchedIdentityRows.length);
  const expectedInStockRawKeys = [...rawIdentityMeta].filter(([, meta]) => !meta.allRowsSoldOut).map(([key]) => key);
  const matchedInStockRawTriples = expectedInStockRawKeys.filter(key => widgetByKey.has(key)).length;
  const unmatchedInStockRawTriples = expectedInStockRawKeys.length - matchedInStockRawTriples;
  const unmatchedInStockRawPriceKeys = expectedInStockRawKeys.filter(key => !widgetPriceByKey.has(key));
  const matchedInStockMappedTriples = [...expectedInStockMap.keys()].filter(key => widgetPriceByKey.has(key)).length;
  const unmatchedInStockMappedTriples = expectedInStockMap.size - matchedInStockMappedTriples;
  const widgetCatalogScanComplete = widgetResult.receipt?.coverage?.catalogScanComplete === true
    || widgetResult.receipt?.paginationExhausted === true;

  // The public offer-list contract is a separate general-price source. It is only
  // consulted after the exact Goldbox catalog has been fully exhausted without an error.
  const fallbackCandidates = widgetCatalogScanComplete && !widgetErrorCode
    ? [...rawIdentityMeta].filter(([key, meta]) => !meta.allRowsSoldOut && !widgetPriceByKey.has(key))
    : [];
  const publicOfferFallback = { pages: [], visitorBootstrapCount: 0, attempted: 0,
    limit: publicOfferFallbackLimit, candidates: fallbackCandidates.length, sharedVisitorContext: visitorContext !== null,
    stopReason: widgetErrorCode || !widgetCatalogScanComplete ? 'widget_not_complete'
      : fallbackCandidates.length === 0 ? 'no_fallback_candidates' : null,
    states: { captured: true, client_exists: true, remnant_free: true,
      credential_propagated: false, live_replay: false } };
  const fallbackPriceByKey = new Map();
  if (publicOfferFallback.stopReason !== 'widget_not_complete') {
    const selectedTargets = fallbackCandidates.slice(0, publicOfferFallbackLimit);
    let hadReadFailure = false;
    for (const [index, [key, meta]] of selectedTargets.entries()) {
      publicOfferFallback.attempted++;
      const page = { productId: meta.productId, itemId: meta.itemId, vendorItemId: meta.vendorItemId,
        status: null, errorCode: null, retry: false, ownerCredentialUsed: false,
        visitorCookiesSent: false, selectedIdentityMatches: false, offerCount: null, generalPrice: null };
      let result;
      try {
        result = await readCoupangConsumerOfferList({ url: offerListProductUrl(meta), authentication: 'visitor',
          fetchImpl, visitorContext });
        page.status = result.receipt?.status ?? 200;
        page.visitorCookiesSent = result.receipt?.visitorCookiesSent === true;
        if (result.receipt?.visitorBootstrap) publicOfferFallback.visitorBootstrapCount++;
        page.offerCount = Number.isSafeInteger(result.count) && result.count >= 0 ? result.count : null;
        page.selectedIdentityMatches = exactSelectedOffer(result, meta);
        if (page.selectedIdentityMatches) {
          const price = result.selectedOffer.price;
          page.generalPrice = { amount: price.amount, currency: 'KRW', basis: 'public_offer_list',
            priceKind: 'offer_list_general_sale_price' };
          fallbackPriceByKey.set(key, { ...page.generalPrice, source: 'consumer_public_offer_list',
            readStatus: 'matched_public_offer_general_price' });
        } else {
          page.errorCode = result.count > 0 ? 'COUPANG_PUBLIC_OFFER_IDENTITY_OR_PRICE' : 'COUPANG_PUBLIC_OFFER_EMPTY';
          hadReadFailure = true;
        }
      } catch (error) {
        const receipt = error instanceof CoupangConsumerError ? error.receipt : null;
        page.status = Number.isInteger(receipt?.status) ? receipt.status
          : Number.isInteger(receipt?.visitorBootstrap?.status) ? receipt.visitorBootstrap.status : null;
        page.errorCode = error instanceof CoupangConsumerError && /^[A-Z0-9_]{1,96}$/.test(error.code)
          ? error.code : 'COUPANG_PUBLIC_OFFER_READ_FAILED';
        page.visitorCookiesSent = receipt?.visitorCookiesSent === true;
        if (receipt?.visitorBootstrap) publicOfferFallback.visitorBootstrapCount++;
        hadReadFailure = true;
      }
      publicOfferFallback.pages.push(page);
      if (page.status === 429) { publicOfferFallback.stopReason = 'rate_limited_429'; break; }
      if (index + 1 < selectedTargets.length) await wait(publicOfferFallbackDelayMs);
    }
    if (publicOfferFallback.stopReason === null) {
      publicOfferFallback.stopReason = fallbackCandidates.length > publicOfferFallbackLimit
        ? 'fallback_limit_reached' : hadReadFailure ? 'completed_with_failures' : 'all_targets_processed';
    }
  }
  publicOfferFallback.states.live_replay = fetchImpl === globalThis.fetch && publicOfferFallback.attempted > 0
    && publicOfferFallback.pages.length === publicOfferFallback.attempted
    && publicOfferFallback.pages.every(page => page.status === 200 && page.selectedIdentityMatches
      && hasPositiveKrwPrice(page.generalPrice));

  const publicPriceMatchedKeys = new Set([...widgetPriceByKey.keys(), ...fallbackPriceByKey.keys()]);
  const publicPriceExcludedUnmatchedIdentityRows = [...rawIdentityMeta].filter(([key, meta]) =>
    meta.allRowsSoldOut && !publicPriceMatchedKeys.has(key)).map(([, meta]) => ({ productId: meta.productId,
    itemId: meta.itemId, vendorItemId: meta.vendorItemId, reason: 'sold_out_listing', rawSoldOut: true }));
  const publicPriceUnmatchedKeys = expectedInStockRawKeys.filter(key => !publicPriceMatchedKeys.has(key));
  const publicPriceUnaccountedRawIdentityTriples = Math.max(0, rawIdentityMeta.size - publicPriceMatchedKeys.size
    - publicPriceExcludedUnmatchedIdentityRows.length);
  const publicPricingCoverageComplete = !widgetErrorCode && publicPriceUnaccountedRawIdentityTriples === 0;
  const widgetPriceUnmatchedTriples = Math.max(0, productKeys.length - widgetPriceByKey.size);
  const widgetUnaccountedRawPriceTriples = Math.max(0, rawIdentityMeta.size - widgetPriceByKey.size
    - [...rawIdentityMeta].filter(([key, meta]) => meta.allRowsSoldOut && !widgetPriceByKey.has(key)).length);
  const widgetPricingCoverageComplete = !widgetErrorCode
    && unmatchedInStockRawPriceKeys.length === 0 && widgetUnaccountedRawPriceTriples === 0;

  for (const item of mapped) {
    const key = identityKey(item.deal);
    const widgetRow = key ? widgetByKey.get(key) ?? null : null;
    const readStatus = item.deal.soldOut ? 'sold_out_excluded'
      : !key ? 'missing_exact_identity'
        : widgetRow?.conditionalCouponPrice ? 'matched_conditional_coupon'
        : widgetRow?.wowSalePrice !== null && widgetRow?.wowSalePrice !== undefined ? 'matched_explicit_wow_price'
          : widgetRow?.advertisedWowPrice ? 'matched_advertised_price_unclassified'
            : widgetRow ? 'matched_without_explicit_wow_price'
            : widgetErrorCode ? 'read_failed'
              : widgetCatalogScanComplete ? 'not_found_in_complete_catalog_scan' : 'not_found_in_partial_scan';
    attachWidgetPrice(item, widgetRow, { readStatus, errorCode: widgetRow || item.deal.soldOut || !key ? null : widgetErrorCode });
    const fallbackPrice = key ? fallbackPriceByKey.get(key) ?? null : null;
    item.deal.publicOfferGeneralPrice = fallbackPrice;
    item.deal.publicOfferGeneralPriceReadStatus = fallbackPrice ? 'matched_public_offer_general_price'
      : key && widgetPriceByKey.has(key) ? 'matched_widget_general_price'
        : item.deal.soldOut ? 'sold_out_excluded' : 'unmatched_public_general_price';
    item.deal.publicOfferGeneralPriceReadError = fallbackPrice ? null
      : key ? publicOfferFallback.pages.find(page => `${page.productId}:${page.itemId}:${page.vendorItemId}` === key)?.errorCode ?? null : null;
    item.deal.publicGeneralPriceSource = fallbackPrice ? 'consumer_public_offer_list'
      : key && widgetPriceByKey.has(key) ? 'goldbox_widget' : null;
  }
  // Keep Coupang's own order (its ranking), but drop sold-out items before applying the limit.
  const items = mapped.filter(item => !item.deal.soldOut).slice(0, limit);
  const widgetCandidateCoverageComplete = widgetByKey.size === productKeys.length;
  const publicMatchedInStockMappedTriples = [...expectedInStockMap.keys()].filter(key => publicPriceMatchedKeys.has(key)).length;
  const publicUnmatchedInStockMappedTriples = expectedInStockMap.size - publicMatchedInStockMappedTriples;
  const publicOfferFallbackMatchedTriples = fallbackPriceByKey.size;
  const widgetComplete = publicPricingCoverageComplete;
  return { items, receipt: { status: widgetComplete ? 'complete' : 'partial', httpStatus: 200, listingHttpStatus: 200,
    sourceUrl: ENDPOINT, pageUrl: PAGE, observedItems: data.length, mapped: mapped.length,
    soldOut: soldOutMappedRows, responseSha256: createHash('sha256').update(text).digest('hex'),
    browserUsed: false, credentialsUsed: false, affiliateLinks: false, widgetErrorCode,
    coverage: { listingRows: data.length, mappedRows: mapped.length, unmappedRows: data.length - mapped.length,
      mappingExclusions, rawIdentityRows, uniqueRawIdentityTriples: productKeys.length,
      invalidIdentityRows, duplicateIdentityRows, soldOutMappedRows, inStockMappedRows,
      inStockMappedRowsWithoutExactIdentity, expectedInStockMappedTriples: expectedInStockMap.size,
      matchedInStockMappedTriples, unmatchedInStockMappedTriples, widgetPricingCoverageComplete,
      expectedInStockRawTriples: expectedInStockRawKeys.length, matchedInStockRawTriples, unmatchedInStockRawTriples,
      requestedWidgetTriples: productKeys.length,
      widgetMatchedTriples: widgetByKey.size, widgetIdentityMatchedTriples: widgetByKey.size,
      explicitWowPriceRows: widgetResult.receipt?.coverage?.explicitWowPriceRows ?? 0,
      ordinaryWowPriceRows: widgetResult.receipt?.coverage?.ordinaryWowPriceRows ?? 0,
      conditionalCouponRows: widgetResult.receipt?.coverage?.conditionalCouponRows ?? 0,
      widgetScanComplete: widgetCatalogScanComplete,
      widgetCatalogScanComplete,
      widgetUnmatchedTriples: Math.max(0, productKeys.length - widgetByKey.size),
      widgetIdentityUnmatchedTriples: Math.max(0, productKeys.length - widgetByKey.size),
      widgetCandidateCoverageComplete,
      widgetExcludedUnmatchedTriples: widgetExcludedUnmatchedIdentityRows.length,
      widgetExcludedUnmatchedIdentityRows,
      widgetUnaccountedRawIdentityTriples: unaccountedRawIdentityTriples,
      unaccountedRawIdentityTriples,
      unaccountedRawIdentityCoverageComplete: unaccountedRawIdentityTriples === 0,
      widgetPriceMatchedTriples: widgetPriceByKey.size,
      widgetPriceUnmatchedTriples,
      widgetUnaccountedRawPriceTriples,
      publicPriceMatchedTriples: publicPriceMatchedKeys.size,
      publicPriceUnmatchedTriples: publicPriceUnmatchedKeys.length,
      publicMatchedInStockMappedTriples,
      publicUnmatchedInStockMappedTriples,
      publicPricingCoverageComplete,
      publicPriceUnaccountedRawIdentityTriples,
      publicPriceExcludedUnmatchedTriples: publicPriceExcludedUnmatchedIdentityRows.length,
      publicPriceExcludedUnmatchedIdentityRows,
      publicOfferFallbackMatchedTriples,
      exactSkuMismatchesExcluded: widgetResult.receipt?.coverage?.exactSkuMismatchesExcluded ?? 0 },
    widget: widgetResult.receipt,
    publicOfferFallback } };
}
