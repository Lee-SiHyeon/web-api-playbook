import {evaluateTravelSnapshot} from './travel-planning-contract.mjs';
import {evaluateHotelPromotionSnapshot} from './hotel-promotion-contract.mjs';
const validDate = value => Number.isFinite(Date.parse(String(value || '')));

export function evaluateCommercialSnapshot(snapshot, { now = new Date(), maxAgeMinutes = 60, requireCommerceDetails = false, requireAffiliate = true } = {}) {
  if(snapshot?.provider==='myrealtrip'&&snapshot?.snapshotType==='hotel_promotion')return evaluateHotelPromotionSnapshot(snapshot,{now,maxAgeMinutes});
  if(snapshot?.provider==='myrealtrip')return evaluateTravelSnapshot(snapshot,{now,maxAgeMinutes});
  const checkedAt = validDate(snapshot?.checkedAt) ? Date.parse(snapshot.checkedAt) : null;
  const ageMinutes = checkedAt === null ? null : (now.getTime() - checkedAt) / 60000;
  const linkAge = validDate(snapshot?.linkVerification?.checkedAt) ? (now.getTime()-Date.parse(snapshot.linkVerification.checkedAt))/60000 : null;
  const readable = value => typeof value === 'string' && value.trim().length > 0 && !/[?？]{2,}|\uFFFD/.test(value);
  const link = snapshot?.linkVerification;
  const checks = {
    schemaVersion: snapshot?.schemaVersion === 1,
    checkedAtValid: checkedAt !== null,
    fresh: ageMinutes !== null && ageMinutes >= 0 && ageMinutes <= maxAgeMinutes,
    productTitlePresent: readable(snapshot?.productTitle) && snapshot.productTitle.trim().length > 3,
    payablePriceValid: typeof snapshot?.payablePriceKrw==='number' && Number.isFinite(snapshot.payablePriceKrw) && snapshot.payablePriceKrw > 0,
    affiliateUrlValid: !requireAffiliate || /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(String(snapshot?.affiliateUrl || '')),
    productUrlPresent: !requireCommerceDetails || /^https:\/\/(?:www\.)?coupang\.com\/vp\/products\/\d+/.test(snapshot?.productUrl||''),
    variantRecorded: readable(snapshot?.variant),
    stockStateRecorded: snapshot?.stockState === 'in_stock',
    linkVerificationPassed: link?.passed === true,
    linkCheckedAtValid: validDate(link?.checkedAt),
    linkFresh: linkAge !== null && linkAge >= 0 && linkAge <= maxAgeMinutes,
    linkTargetMatches: link?.targetMatches === true,
    credentialsNotPersisted: snapshot?.credentialsPersisted === false,
    productIdentityPresent: !requireCommerceDetails || readable(snapshot?.productId) && readable(snapshot?.variantId),
    sellerRecorded: !requireCommerceDetails || readable(snapshot?.seller),
    quantityRecorded: !requireCommerceDetails || Number.isInteger(snapshot?.quantity) && snapshot.quantity > 0,
    conditionsRecorded: !requireCommerceDetails || ['none','member','coupon','member_coupon'].includes(snapshot?.priceBasis) && readable(snapshot?.conditions),
    shippingRecorded: !requireCommerceDetails || Number.isFinite(snapshot?.shippingKrw) && snapshot.shippingKrw >= 0,
    sourceEvidenceBound: !requireCommerceDetails || /^[a-f0-9]{64}$/.test(snapshot?.evidenceSha256 || ''),
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name);
  return {
    schemaVersion: 1,
    checkedAt: now.toISOString(),
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    details: {
      ageMinutes: ageMinutes === null ? null : Math.round(ageMinutes * 100) / 100,
      maxAgeMinutes,
    },
  };
}
