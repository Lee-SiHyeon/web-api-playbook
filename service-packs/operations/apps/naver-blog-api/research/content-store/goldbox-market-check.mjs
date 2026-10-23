// 쿠팡 골드박스 x 다나와: which Goldbox prices actually beat the rest of the market (G마켓, 옥션, 11번가, SSG ...).
// Usage: node goldbox-market-check.mjs [--limit=30] [--out=path.json] [--no-naver] [--no-connect]
// Each matched row also gets `verdict` (priceVerdict): selected general prices, separate advertised specials,
// and payable prices only where shipping is known.
// Danawa wins are re-checked against Naver 통합검색 shopping cards (naver-crawler-snapshot.mjs); an eligible same-product
// Naver offer at or below the Goldbox payable price turns the row into not_lowest_naver.
// Anonymous prices only: a Goldbox price seen while logged in (WOW, card, coupon) is not visible here.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fetchCoupangGoldbox } from './coupang-goldbox.mjs';
import { searchDanawa, fetchDanawaOffers, matchDanawaResult, compareToMarket, danawaQuery } from './danawa-prices.mjs';
import { naverSearchCards } from './naver-crawler-snapshot.mjs';
import { brandconnectSearch } from './brandconnect-offers.mjs';
import { createCoupangVisitorContext } from '../../../affiliate-api-hub/lib/coupang-visitor-context.mjs';
import { readCoupangComparisonShipping, collectedCoupangComparisonShipping } from './coupang-comparison-shipping.mjs';
import { matchTossMarketOffers, normalizeTossMarketCoverage, loadTossMarketSnapshot, tossCoverageNeedsVerification } from './toss-market-offers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Owner 2026-10-03: "2만원상품이상만 배송비 조회해보라고 해봐 1개 낱개상품은 배송비 있는거같으니"
export const COUPANG_SHIPPING_READ_MINIMUM_PRICE_KRW = 20000;

// Naver cards say "5캔", "24팩"; Coupang and Danawa titles count in 개.
const countAsGae = s => String(s).replace(/(\d+)\s*(캔|팩|병|봉|포|박스)(?![가-힣])/g, '$1개');

const positiveKrw = value => value?.currency === 'KRW' && Number.isSafeInteger(value.amount) && value.amount > 0
  ? value.amount : null;
const positiveWon = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const shippingWon = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Select the exact SKU's public general price when available, then an exact public offer-list price.
 * The legacy Goldbox listing amount is retained only as an explicitly unverified fallback.
 */
export function selectGoldboxGeneralPrice(deal = {}) {
  const listingAmount = positiveWon(deal.salePrice);
  const widgetAmount = positiveKrw(deal.widgetFinalPrice);
  if (widgetAmount !== null && typeof deal.widgetPriceReadStatus === 'string'
    && deal.widgetPriceReadStatus.startsWith('matched_')) {
    return { amount: widgetAmount, currency: 'KRW', source: 'coupang_mlp_goldbox_widget',
      basis: deal.widgetFinalPrice.basis ?? 'widget_final_price_field', verified: true,
      readStatus: deal.widgetPriceReadStatus,
      matchesListingSalePrice: listingAmount === null ? null : listingAmount === widgetAmount };
  }

  const offerAmount = positiveKrw(deal.publicOfferGeneralPrice);
  if (offerAmount !== null && deal.publicOfferGeneralPriceReadStatus === 'matched_public_offer_general_price') {
    return { amount: offerAmount, currency: 'KRW', source: 'coupang_public_offer_list',
      basis: deal.publicOfferGeneralPrice.basis ?? 'public_offer_list', verified: true,
      readStatus: deal.publicOfferGeneralPriceReadStatus,
      matchesListingSalePrice: listingAmount === null ? null : listingAmount === offerAmount };
  }

  if (listingAmount !== null) return { amount: listingAmount, currency: 'KRW', source: 'coupang_goldbox_listing',
    basis: 'legacy_listing_sale_price', verified: false, verificationStatus: 'unverified_listing_fallback',
    readStatus: null, matchesListingSalePrice: true };
  return null;
}

/** Same-product Naver cards; a coupon amount is a separate conditional offer until eligibility is verified. */
export function naverSameProduct(sellerTitle, cards) {
  return cards.map(c => {
    const price = positiveWon(c.price), advertisedCouponPrice = positiveWon(c.couponPrice);
    const couponEligibilityVerified = c.couponEligibilityVerified === true;
    const best = couponEligibilityVerified && advertisedCouponPrice !== null
      ? price === null ? advertisedCouponPrice : Math.min(price, advertisedCouponPrice) : price;
    const shipping = shippingWon(c.shipping);
    return { ...c, price, advertisedCouponPrice, couponEligibilityVerified,
      couponPrice: couponEligibilityVerified ? advertisedCouponPrice : null,
      best, payable: best === null || shipping === null ? null : best + shipping, shipping };
  })
    .filter(c => Number.isFinite(c.best) && matchDanawaResult(sellerTitle, [{ name: countAsGae(c.title), label: '', minPrice: c.best }]))
    .sort((a, b) => (a.payable === null) - (b.payable === null)
      || (a.payable ?? a.best) - (b.payable ?? b.best));
}

// Owner 2026-09-30: compare what a buyer really pays (lowest eligible price + known shipping), post when the combined
// comparison has 3+ other sellers (and a Naver card whenever Danawa has fewer than 8), and when a Naver 쇼핑 커넥트 store
// is the cheapest, route the post there instead of dropping it.
// Titles that open with a grade or origin word have no brand to anchor a same-product match (고당도 감귤 ↔ 온도씨 한라봉).
const GENERIC_TITLE = /^(고당도|국내산|국산|햇|신선|산지직송|프리미엄|대용량|특대|왕|제주|유기농|무농약|친환경)\s/;
const AFFILIATE_ORDER = o => ({ coupang_partners: 0, naver_connect: 1, toss_sharelink: 2 }[o.affiliate] ?? 3);
const payable = o => {
  const price = positiveWon(o.price), shipping = shippingWon(o.shipping);
  const eligibleCoupon = o.couponEligibilityVerified === true ? positiveWon(o.couponPrice) : null;
  const selectedPrice = eligibleCoupon === null ? price : price === null ? eligibleCoupon : Math.min(price, eligibleCoupon);
  return selectedPrice === null || shipping === null ? null : selectedPrice + shipping;
};

const itemPrice = o => {
  const price = positiveWon(o.price), eligibleCoupon = o.couponEligibilityVerified === true ? positiveWon(o.couponPrice) : null;
  return eligibleCoupon === null ? price : price === null ? eligibleCoupon : Math.min(price, eligibleCoupon);
};
const comparePayable = (left, right) => left.payable === null ? right.payable === null
  ? (itemPrice(left) ?? Number.MAX_SAFE_INTEGER) - (itemPrice(right) ?? Number.MAX_SAFE_INTEGER) : 1
  : right.payable === null ? -1 : left.payable - right.payable || AFFILIATE_ORDER(left) - AFFILIATE_ORDER(right);

// `self` is the deal being judged: the Coupang Goldbox item by default, or a Naver 오늘끝딜 item sold by a 쇼핑 커넥트 store.
export function priceVerdict({ title, salePrice, generalPrice = null, specialPrices = null,
  wowPromotion = false, promotionSoldPercent = null, wowPromotionRate = null,
  danawaOffers = [], naverSame = [], connectSame = [], excludeMall = '쿠팡', self = null, coupangShipping = null,
  coupangShippingChargedUnknown = false, coupangShippingEvidence = null, tossSame = [] }) {
  const ownShipping = shippingWon(self ? self.shipping : coupangShipping);
  const coupang = self ? { couponPrice: null, ...self, price: salePrice, shipping: ownShipping }
    : { channel: 'coupang', seller: '쿠팡', price: salePrice, couponPrice: null,
      shipping: ownShipping, affiliate: 'coupang_partners' };
  coupang.subject = true;
  const conditionalDanawaOffers = danawaOffers.filter(o => !o.mall.includes(excludeMall) && o.couponRequired === true)
    .map(o => ({ channel: 'danawa', seller: o.mall, price: null, advertisedCouponPrice: o.price,
      couponEligibilityVerified: false, conditionalPrice: { amount: o.price, currency: 'KRW', basis: 'danawa_coupon_required', eligibilityVerified: false },
      couponRequired: true, shipping: shippingWon(o.shipping), payable: null, shippingKnown: shippingWon(o.shipping) !== null }));
  const danawaOthers = [...danawaOffers.filter(o => !o.mall.includes(excludeMall) && o.couponRequired !== true).reduce((m, o) => {
    const x = { channel: 'danawa', seller: o.mall, price: o.price, couponPrice: null,
      shipping: shippingWon(o.shipping), couponRequired: o.couponRequired === true, title: o.title || null };
    const previous = m.get(o.mall);
    const nextTotal = payable(x), previousTotal = previous && payable(previous);
    const nextLowerBound = itemPrice(x), previousLowerBound = previous && itemPrice(previous);
    return !previous || (nextTotal !== null && (previousTotal === null || nextTotal < previousTotal))
      || (nextTotal === null && previousTotal === null && nextLowerBound !== null && nextLowerBound < previousLowerBound)
      ? m.set(o.mall, x) : m; }, new Map()).values()];
  const naverOthers = naverSame.filter(c => !String(c.seller ?? '').includes(excludeMall))
    .map(c => ({ channel: 'naver', seller: c.seller || '네이버 판매처', price: c.price,
      couponPrice: c.couponEligibilityVerified === true ? c.advertisedCouponPrice ?? c.couponPrice ?? null : null,
      advertisedCouponPrice: c.advertisedCouponPrice ?? c.couponPrice ?? null,
      couponEligibilityVerified: c.couponEligibilityVerified === true,
      shipping: shippingWon(c.shipping), rewardMax: c.rewardMax ?? null, title: c.title || null }));
  const connect = connectSame.map(p => ({ channel: 'naver_connect', seller: p.storeName, price: p.price, couponPrice: null,
    shipping: shippingWon(p.shipping), affiliate: 'naver_connect',
    productId: p.productId, productUrl: p.productUrl, commissionRate: p.commissionRate, brandStore: p.brandStore, title: p.title || null }));
  // Toss peers are accepted only after the title, weight/volume and pack-count matcher validates the observed item.
  // A Toss subject does not count another Toss listing as an independent market source.
  const tossPeerOffers = self?.channel === 'toss' ? [] : matchTossMarketOffers(title, tossSame);
  // A price over 3x the selected baseline is likely a different pack or placeholder. Unknown shipping stays unranked.
  const inRange = o => Number.isFinite(itemPrice(o)) && itemPrice(o) <= salePrice * 3 && itemPrice(o) >= salePrice / 3;
  const allOthers = [...danawaOthers, ...naverOthers, ...connect, ...tossPeerOffers].filter(inRange);
  const offers = [coupang, ...allOthers]
    .map(o => ({ ...o, payable: payable(o), shippingKnown: shippingWon(o.shipping) !== null }))
    .sort(comparePayable);
  const bestKnown = offers.find(o => o.payable !== null) ?? null;
  // Sellers are counted once by name: Naver cards often repeat the malls Danawa already lists.
  const sellerKey = o => String(o.seller).replace(/\s+/g, '').replace(/^주식회사|\(주\)/g, '');
  const sources = new Set(allOthers.map(sellerKey)).size;
  const danawaNames = new Set(danawaOthers.filter(inRange).map(sellerKey));
  const naverOnly = allOthers.filter(o => ['naver', 'naver_connect'].includes(o.channel) && !danawaNames.has(sellerKey(o))).length;
  const comparableDanawaCount = danawaOthers.filter(inRange).length;
  const eligible = sources >= 3 && (comparableDanawaCount >= 8 || naverOnly >= 1);
  const ownOffer = offers.find(o => o.subject) ?? null;
  const ownPayable = ownOffer?.payable ?? null;
  const ownItemPrice = ownOffer ? itemPrice(ownOffer) : null;
  const worstCaseShippingFee = coupangShippingChargedUnknown && ownShipping === null
    ? Math.max(3000, ...allOthers.map(o => shippingWon(o.shipping) ?? 0)) : null;
  const worstCasePayable = worstCaseShippingFee === null || ownItemPrice === null
    ? null : ownItemPrice + worstCaseShippingFee;
  const worstCaseRival = worstCaseShippingFee === null ? null
    : Math.min(...allOthers.map(o => payable(o) ?? itemPrice(o)).filter(Number.isFinite));
  const worstCaseMargin = worstCaseRival === null || worstCasePayable === null
    ? null : worstCaseRival - worstCasePayable;
  // qf-compose applies this same shipping floor and tie margin before accepting an unknown-fee Coupang route.
  const winsWithChargedShippingAssumption = eligible && Number.isFinite(worstCaseMargin) && worstCaseMargin >= 1000;
  const unknownOffers = offers.filter(o => o.payable === null && itemPrice(o) !== null);
  const possibleWinners = bestKnown
    ? unknownOffers.filter(o => itemPrice(o) <= bestKnown.payable)
    : unknownOffers.filter(o => itemPrice(o) === Math.min(...unknownOffers.map(itemPrice)));
  const hasExternalWinnerUncertainty = possibleWinners.some(o => !o.subject);
  const hasSubjectWinnerUncertainty = possibleWinners.some(o => o.subject);
  const shippingUnverifiedRoute = winsWithChargedShippingAssumption ? null
    : hasExternalWinnerUncertainty ? 'comparison_shipping_unverified'
    : hasSubjectWinnerUncertainty ? ownOffer?.affiliate === 'coupang_partners' ? 'coupang_shipping_unverified' : 'comparison_shipping_unverified'
      : null;
  const affiliateRoute = winsWithChargedShippingAssumption ? 'coupang_partners'
    : bestKnown?.affiliate === 'coupang_partners' ? 'coupang_partners'
    : bestKnown?.affiliate === 'naver_connect' ? 'naver_connect'
      : bestKnown?.affiliate === 'toss_sharelink' ? 'toss_sharelink' : 'lowest_not_affiliate';
  const route = GENERIC_TITLE.test(title) ? 'generic_product' : !eligible ? 'too_few_sellers'
    : shippingUnverifiedRoute ?? affiliateRoute;
  // promotionClosingArea.rate is the percentage sold, not a price discount (browser readback 2026-10-02).
  // Old snapshots may still have wowPromotionRate: use that only as a promotion-presence signal.
  const uncertaintyPick = possibleWinners.sort((a, b) => itemPrice(a) - itemPrice(b))[0] ?? null;
  const pick = winsWithChargedShippingAssumption ? ownOffer
    : route === 'coupang_shipping_unverified' || route === 'comparison_shipping_unverified' ? uncertaintyPick
    : route === 'naver_connect' ? offers.find(o => o.affiliate === 'naver_connect' && o.payable === bestKnown?.payable) : bestKnown;
  const shippingKnown = ownShipping !== null;
  // Card-conditional prices from Danawa (effective-price, 2026-10-05): reported beside the cash comparison, never ranked
  // (R1: the headline stays the unconditional lowest; a card price is shown as "○○카드 결제 시 ○원").
  const cardFloor = danawaOffers.filter(o => !o.mall.includes(excludeMall)).flatMap(o => (o.conditionalPrices ?? [])
    .filter(c => Number.isFinite(c.amount)).map(c => ({ seller: o.mall, amount: c.amount, instrument: c.instrument ?? null, kind: c.kind ?? null })))
    .sort((a, b) => a.amount - b.amount)[0] ?? null;
  const selectedGeneral = generalPrice ?? { amount: salePrice, currency: 'KRW', source: null, verified: false };
  const specials = specialPrices ?? { advertisedWowPrice: null, wowSalePrice: null, conditionalCouponPrice: null, memberPriceVerified: false };
  return { title, route, eligible, sources,
    generalPrice: selectedGeneral,
    specialPrices: specials,
    shipping: { fee: shippingKnown ? ownShipping : null, known: shippingKnown,
      basis: !self && shippingKnown ? coupangShippingEvidence?.basis ?? null : null,
      scope: !self && shippingKnown ? coupangShippingEvidence?.scope ?? null : null,
      memberEligibilityVerified: false,
      payable: ownPayable,
      payableLowerBound: ownPayable ?? ownItemPrice,
      chargedUnknown: coupangShippingChargedUnknown && !shippingKnown,
      worstCaseComparison: worstCaseShippingFee === null ? null : { assumedShippingFeeKRW: worstCaseShippingFee,
        assumedPayableKRW: worstCasePayable, cheapestRivalLowerBoundKRW: Number.isFinite(worstCaseRival) ? worstCaseRival : null,
        marginKRW: Number.isFinite(worstCaseMargin) ? worstCaseMargin : null,
        win: winsWithChargedShippingAssumption } },
    best: pick && { channel: pick.channel, seller: pick.seller, price: pick.price,
      payable: pick.payable, shippingKnown: pick.shippingKnown,
      productId: pick.productId ?? null, tacaItemId: pick.tacaItemId ?? (pick.channel === 'toss' ? pick.productId ?? null : null),
      productUrl: pick.productUrl ?? null, title: pick.title ?? (pick.channel === 'toss' ? title : null),
      image: pick.image ?? null, priceIncludesShipping: pick.channel === 'toss'
        && typeof pick.priceIncludesShipping === 'boolean' ? pick.priceIncludesShipping : null },
    ties: bestKnown ? offers.filter(o => o !== bestKnown && o.payable !== null && o.payable === bestKnown.payable)
      .map(o => `${o.channel}:${o.seller}`) : [],
    offers: winsWithChargedShippingAssumption && !offers.slice(0, 8).includes(ownOffer)
      ? [...offers.slice(0, 8), ownOffer] : offers.slice(0, 8), conditionalOffers: conditionalDanawaOffers,
    cardFloor: cardFloor && { ...cardFloor, belowBest: Boolean(bestKnown && cardFloor.amount < bestKnown.payable) },
    coupangShippingKnown: !self && shippingKnown,
    wow: wowPromotion || Number.isFinite(wowPromotionRate) ? { promotionPresent: true,
      soldPercent: Number.isFinite(promotionSoldPercent) && promotionSoldPercent >= 0 && promotionSoldPercent <= 100 ? promotionSoldPercent : null,
      memberPriceVerified: false } : null };
}

export async function checkGoldboxAgainstMarket(items, { fetchImpl = globalThis.fetch, delayMs = 800, excludeMall = '쿠팡', naverCards = null, connectSearch = null,
  shippingReader = readCoupangComparisonShipping, tossSearch = null } = {}) {
  const rows = [];
  const tossConfigured = tossSearch !== null && tossSearch !== undefined;
  const tossOffers = Array.isArray(tossSearch?.offers) ? tossSearch.offers : [];
  const tossCoverage = tossConfigured
    ? normalizeTossMarketCoverage(tossSearch?.coverage, tossOffers.length)
    : { configured: false, available: null, exhaustive: false, complete: false, collectionComplete: false,
      remainingUnknown: null, pages: null, offerCount: 0, sourceCount: 0, sources: [], counts: {}, checkedAt: null, error: null };
  const visitorContext = createCoupangVisitorContext({ fetchImpl });
  let shippingRateLimited = false;
  for (const item of items) {
    const deal = item.deal ?? {};
    const generalPrice = selectGoldboxGeneralPrice(deal);
    const specialPrices = { advertisedWowPrice: deal.advertisedWowPrice ?? null,
      wowSalePrice: positiveWon(deal.wowSalePrice), conditionalCouponPrice: deal.conditionalCouponPrice ?? null,
      memberPriceVerified: deal.memberPriceVerified === true };
    const collectedShipping = collectedCoupangComparisonShipping(deal, generalPrice);
    let coupangShipping = collectedShipping?.feeKRW ?? null;
    let shippingEvidence = collectedShipping;
    let shippingReadAttempted = false;
    let shippingReadSkipped = null;
    if (collectedShipping) shippingReadSkipped = 'collected_public_shipping';
    else if (deal.soldOut === true) shippingReadSkipped = 'sold_out';
    else if (generalPrice?.verified !== true) shippingReadSkipped = 'general_price_unverified';
    else if (generalPrice.amount < COUPANG_SHIPPING_READ_MINIMUM_PRICE_KRW) shippingReadSkipped = 'below_20000_assumed_charged';
    else if (shippingRateLimited) shippingReadSkipped = 'skipped_after_rate_limit';
    else {
      shippingReadAttempted = true;
      shippingEvidence = await shippingReader({ item, generalPrice, fetchImpl, visitorContext });
      if (shippingEvidence?.readStatus === 'verified') coupangShipping = shippingWon(shippingEvidence.feeKRW);
      if (shippingEvidence?.readStatus === 'rate_limited') shippingRateLimited = true;
    }
    const coupangShippingChargedUnknown = shippingReadSkipped === 'below_20000_assumed_charged';
    const base = { title: item.title, url: item.url, image: item.listingContent?.imageUrl ?? null,
      productId: deal.productId ?? null, itemId: deal.itemId ?? null, vendorItemId: deal.vendorItemId ?? null,
      salePrice: generalPrice?.amount ?? null,
      generalPrice, listingSalePrice: positiveWon(deal.salePrice), specialPrices,
      eventEnd: deal.eventEnd ?? null, coupangShippingFee: coupangShipping,
      coupangShippingBasis: shippingEvidence?.basis ?? null, coupangShippingScope: shippingEvidence?.scope ?? null,
      coupangShippingKnown: coupangShipping !== null, coupangShippingEvidence: shippingEvidence,
      shippingReadAttempted, shippingReadStatus: shippingEvidence?.readStatus ?? null, shippingReadSkipped };
    if (deal.soldOut === true) { rows.push({ ...base, status: 'sold_out' }); continue; }
    if (base.salePrice === null) { rows.push({ ...base, status: 'no_price' }); continue; }
    try {
      const search = await searchDanawa(danawaQuery(item.title), { fetchImpl });
      const match = matchDanawaResult(item.title, search.results);
      // Most Goldbox items (102 of 120 on 2026-09-30) have no Danawa listing; Naver may still sell the same product,
      // so an unmatched row is judged on Naver cards and 쇼핑 커넥트 alone (the verdict still needs 3+ sellers).
      if (!match && !naverCards && !tossConfigured) { rows.push({ ...base, status: 'no_match', searchUrl: search.url }); await sleep(delayMs); continue; }
      await sleep(delayMs);
      const offers = match ? await fetchDanawaOffers(match.pcode, { fetchImpl }) : { pcode: null, name: null, pageUrl: null, checkedAt: null, offers: [] };
      const rankableDanawaOffers = offers.offers.filter(offer => offer.couponRequired !== true);
      const conditionalDanawaOffers = offers.offers.filter(offer => offer.couponRequired === true).map(offer => ({
        mall: offer.mall, advertisedCouponPrice: offer.price, couponEligibilityVerified: false,
        eligibilityStatus: 'required_coupon_not_verified', shipping: shippingWon(offer.shipping), payable: null,
      }));
      const marketSource = compareToMarket(base.salePrice, rankableDanawaOffers, { excludeMall });
      const ownPayable = coupangShipping === null ? null : base.salePrice + coupangShipping;
      const beatsMarket = ownPayable !== null && marketSource.lowestOtherTotal !== null
        ? ownPayable < marketSource.lowestOtherTotal
        : ownPayable === null && marketSource.lowestOtherTotal !== null && base.salePrice >= marketSource.lowestOtherTotal ? false : null;
      const market = { ...marketSource,
        itemPriceBeatsMarket: marketSource.beatsMarket,
        beatsMarket,
        coupangShippingFee: coupangShipping,
        coupangShippingBasis: shippingEvidence?.basis ?? null, coupangShippingScope: shippingEvidence?.scope ?? null,
        coupangShippingKnown: coupangShipping !== null,
        coupangPayable: ownPayable,
        conditionalOffers: conditionalDanawaOffers,
        deltaVsLowestTotal: ownPayable === null || marketSource.lowestOtherTotal === null
          ? null : ownPayable - marketSource.lowestOtherTotal };
      let status = !match ? 'no_match' : beatsMarket === true ? 'beats_market'
        : beatsMarket === false ? 'not_lowest' : coupangShipping === null ? 'coupang_shipping_unverified' : 'comparison_unverified';
      let naver, same = [], connectSame = [], connect;
      const queries = [...new Set([offers.name, danawaQuery(item.title)].filter(Boolean))];
      if (naverCards) {
        // Danawa's mall list rarely carries 스마트스토어/브랜드스토어, so every matched row is re-checked against Naver cards.
        try {
          const others = cards => cards.filter(c => !excludeMall || !String(c.seller ?? '').includes(excludeMall));
          let cards = [];
          for (const query of queries) {
            const found = await naverCards(query);
            cards = [...cards, ...found];
            same = naverSameProduct(item.title, others(cards));
            if (same.length) break;
          }
          const lowest = same[0] ?? null;
          naver = { compared: true, cardsSeen: cards.length, matched: same.length,
            lowest: lowest && { title: lowest.title, seller: lowest.seller, price: lowest.price, couponPrice: lowest.couponPrice ?? null, shipping: lowest.shipping ?? null, url: lowest.url } };
          if (lowest && Number.isSafeInteger(lowest.payable)
            && lowest.payable <= (ownPayable ?? base.salePrice)) status = 'not_lowest_naver';
        } catch (error) { naver = { compared: false, error: error.code ?? 'UNKNOWN' }; }
      }
      if (connectSearch) {
        try {
          // 쇼핑 커넥트 search is keyword-strict: the Danawa name with its maker prefix and "(N개)" often finds nothing.
          const connectQueries = [...new Set([danawaQuery(item.title), String(offers.name ?? '').replace(/\s*\(\d+개\)\s*$/, '')].filter(Boolean))];
          let seen = 0;
          for (const query of connectQueries) {
            const products = await connectSearch(query);
            seen += products.length;
            // Scent/colour variants pass the size/count match; keep the listing that shares the most title words.
            const words = new Set(danawaQuery(item.title).split(/\s+/));
            const overlap = p => danawaQuery(p.title).split(/\s+/).filter(w => words.has(w)).length;
            connectSame = naverSameProduct(item.title, products).sort((a, b) => overlap(b) - overlap(a) || a.best - b.best).slice(0, 1);
            if (connectSame.length) break;
          }
          connect = { compared: true, seen, matched: connectSame.length };
        } catch (error) { connect = { compared: false, error: error.code ?? 'UNKNOWN' }; }
      }
      const judged = priceVerdict({ title: item.title, salePrice: base.salePrice, generalPrice, specialPrices,
        wowPromotion: deal.wowPromotion === true,
        promotionSoldPercent: deal.promotionSoldPercent ?? null, wowPromotionRate: deal.wowPromotionRate ?? null,
        danawaOffers: offers.offers, naverSame: same, connectSame, excludeMall, tossSame: tossOffers,
        coupangShipping, coupangShippingChargedUnknown, coupangShippingEvidence: shippingEvidence });
      if (judged.route === 'toss_sharelink') status = 'not_lowest_toss';
      if (judged.shipping.worstCaseComparison) market.worstCaseShippingComparison = judged.shipping.worstCaseComparison;
      if (judged.route === 'coupang_shipping_unverified' || judged.route === 'comparison_shipping_unverified') {
        market.danawaBeatsMarket = market.beatsMarket;
        market.beatsMarket = null;
        status = judged.route;
      }
      if (judged.shipping.worstCaseComparison?.win === true) status = 'beats_market_assumed_shipping';
      // Without Danawa, a win by more than 35% over the next seller is more often a different shade/pack on a Naver card
      // (오휘 쿠션 14,400 vs 23,100) than a real deal; it waits for a manual check instead of posting.
      const runnerUp = judged.offers.find(o => o.payable > judged.offers[0].payable);
      const shippingUnresolved = judged.route === 'coupang_shipping_unverified' || judged.route === 'comparison_shipping_unverified';
      let verdict = !match && !shippingUnresolved && judged.route !== 'too_few_sellers' && runnerUp && runnerUp.payable > judged.offers[0].payable * 1.35
        ? { ...judged, route: 'naver_only_gap_check', routeBeforeGapCheck: judged.route } : judged;
      const matchedToss = matchTossMarketOffers(item.title, tossOffers);
      const tossComparison = {
        ...tossCoverage,
        status: !tossConfigured ? 'not_configured' : !tossCoverage.available ? 'unavailable' : tossCoverage.complete ? 'complete' : 'partial',
        matchedOffers: matchedToss.length,
        matchedTacaItemIds: matchedToss.map(o => o.tacaItemId),
        lowestMatched: matchedToss[0] ? { tacaItemId: matchedToss[0].tacaItemId, title: matchedToss[0].title,
          price: matchedToss[0].price, productUrl: matchedToss[0].productUrl } : null,
      };
      if (tossConfigured && tossCoverageNeedsVerification(tossCoverage)) {
        verdict = { ...verdict, route: 'comparison_toss_unverified', routeBeforeTossVerification: verdict.route };
        status = 'comparison_toss_unverified';
      }
      rows.push({ ...base, status, danawa: match ? { pcode: offers.pcode, name: offers.name, url: offers.pageUrl, checkedAt: offers.checkedAt } : null, market,
        tossComparison,
        ...(naver ? { naver } : {}), ...(connect ? { connect } : {}), verdict });
    } catch (error) {
      rows.push({ ...base, status: 'error', error: error.code ?? 'UNKNOWN' });
      if (error.code === 'ACCESS_BLOCKED') break; // stop, do not keep hitting a site that refused us
    }
    await sleep(delayMs);
  }
  return rows;
}

const goldboxCursorFile = () => path.join(process.env.LOCALAPPDATA || os.homedir(), 'affiliate-content-operations', 'quick-fact', 'goldbox-cursor.json');
function readCursor(file) { try { const n = JSON.parse(readFileSync(file, 'utf8')).next; return Number.isSafeInteger(n) && n >= 0 ? n : 0; } catch { return 0; } }
function writeCursor(file, next) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ next, updatedAt: new Date().toISOString() })); }

// Coupang's home recommendation feed ("오늘의 할인" etc.) via the private coupang-shopping-crawler connector
// (sibling repo, anonymous XHR POST /n-api/recommend/feeds). Items already in the Goldbox list are skipped.
// Feed rows carry no delivery fee, so their shipping stays unknown.
export function mapFeedProduct(p) {
  const salePrice = Number.isSafeInteger(p?.salePriceKrw) && p.salePriceKrw > 0 ? p.salePriceKrw : null;
  if (!p?.title || !/^https:\/\/www\.coupang\.com\/vp\/products\/\d+/.test(p.cleanUrl || '') || salePrice === null) return null;
  const image = /^https:\/\/(thumbnail|image)\d*\.coupangcdn\.com\//.test(String(p.imageUrl ?? p.image ?? '')) ? (p.imageUrl ?? p.image) : null;
  return { title: p.title, url: p.cleanUrl, publisher: `쿠팡 ${p.feedTitle || '할인'}`, listingContent: { imageUrl: image },
    deal: { productId: String(p.productId), itemId: String(p.itemId ?? ''), vendorItemId: String(p.vendorItemId ?? ''),
      price: p.basePriceKrw ?? null, salePrice, discountRate: p.discountRatePercent ?? null, eventEnd: null, soldOut: false,
      rocket: null, wowPromotionRate: null, affiliateLink: false, feedTitle: p.feedTitle ?? null } };
}
async function coupangFeedDeals(goldboxItems) {
  try {
    const { CoupangShoppingClient } = await import(pathToFileURL(path.resolve(HERE, '../../../../../coupang-shopping/adapters/coupang-shopping.mjs')).href);
    const feed = await new CoupangShoppingClient().feed({ limit: 60, maxPages: 5, sort: 'none' });
    const seen = new Set(goldboxItems.map(i => i.deal?.productId));
    return feed.items.filter(p => p.feedTitle !== '골드박스 기간한정 파격 특가' && !seen.has(String(p.productId))).map(mapFeedProduct).filter(Boolean);
  } catch (error) { console.error(`coupang feed skipped: ${error.code ?? error.message}`); return []; }
}

async function main() {
  const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const limit = Number(arg('limit') ?? 30);
  let items, tossSearch = null;
  if (process.argv.includes('--food')) {
    // Owner 2026-10-05: groceries first, checked as soon as they appear — every food item on the current Goldbox list.
    const { isFood } = await import('./food-classifier.mjs');
    items = (await fetchCoupangGoldbox(1000)).items.filter(i => isFood(i.title ?? i.name)).slice(0, limit);
    try {
      tossSearch = await loadTossMarketSnapshot({ foodOnly: true, pages: Number(arg('toss-pages') ?? 3), best: 30 });
    } catch (error) {
      tossSearch = { offers: [], coverage: { available: false,
        error: /^[A-Z0-9_]{2,80}$/.test(String(error?.code ?? '')) ? error.code : 'TOSS_COLLECTION_FAILED' } };
    }
  } else if (process.argv.includes('--rotate')) {
    // The Goldbox list holds ~200 items; check the next `limit` of them each run so the whole list is covered.
    const { items: all } = await fetchCoupangGoldbox(1000);
    const cursorFile = goldboxCursorFile();
    const start = readCursor(cursorFile) % Math.max(1, all.length);
    items = [...all.slice(start), ...all.slice(0, start)].slice(0, limit);
    writeCursor(cursorFile, (start + items.length) % Math.max(1, all.length));
  } else items = (await fetchCoupangGoldbox(limit)).items;
  if (process.argv.includes('--with-feed')) items = [...items, ...await coupangFeedDeals(items)];
  const rows = await checkGoldboxAgainstMarket(items, { naverCards: process.argv.includes('--no-naver') ? null : naverSearchCards(),
    connectSearch: process.argv.includes('--no-connect') ? null : brandconnectSearch(), tossSearch });
  const checkedAt = new Date().toISOString();
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const shippingReads = rows.reduce((acc, r) => {
    if (r.shippingReadAttempted) {
      acc.attempted += 1;
      if (r.coupangShippingEvidence?.status === 200) acc.http200 += 1;
      if (r.coupangShippingEvidence?.status === 403) acc.http403 += 1;
    }
    if (r.shippingReadSkipped === 'below_20000_assumed_charged') acc.skippedBelow20000 += 1;
    if (r.shippingReadSkipped === 'skipped_after_rate_limit') acc.skippedAfterRateLimit += 1;
    return acc;
  }, { attempted: 0, http200: 0, http403: 0, skippedBelow20000: 0, skippedAfterRateLimit: 0 });
  const routes = { coupang_partners: rows.filter(r => r.verdict?.route === 'coupang_partners').length };
  const summary = { checkedAt, rowCount: rows.length, counts, shippingReads, routes,
    tossCoverage: tossSearch ? normalizeTossMarketCoverage(tossSearch.coverage, tossSearch.offers?.length ?? 0) : null };
  if (arg('out')) writeFileSync(arg('out'), JSON.stringify({ ...summary, rows }, null, 2));
  const won = n => (n === null || n === undefined ? '-' : n.toLocaleString('ko-KR'));
  for (const r of rows) {
    const m = r.market;
    console.log([r.status.padEnd(12), won(r.salePrice).padStart(9),
      m ? `vs ${m.lowestOther?.mall ?? '-'} ${won(m.lowestOtherTotal)} (${m.deltaVsLowestTotal > 0 ? '+' : ''}${won(m.deltaVsLowestTotal)})` : '', r.title].join('  '));
  }
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.code ?? error.message); process.exitCode = 1; });
