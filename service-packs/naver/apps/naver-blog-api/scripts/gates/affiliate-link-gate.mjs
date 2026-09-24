// Publisher-owned account policy, not an article-supplied account assertion.
import {evaluateTravelAffiliate,verifyTravelAffiliate} from './travel-planning-contract.mjs';
import {evaluateHotelPromotionAffiliate,verifyHotelPromotionAffiliate} from './hotel-promotion-contract.mjs';
import {isSingleOfferHotdeal,evaluateSingleOfferHotdealAffiliate} from './single-offer-hotdeal-contract.mjs';
export const AFFILIATE_ACCOUNTS = Object.freeze({ aicandoanything: 'AF5462559' });
const shortLink = v => /^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(v || '');
const digits = v => /^\d+$/.test(String(v || ''));
const finish = checks => ({ passed: Object.values(checks).every(Boolean), checks,
  failedChecks: Object.keys(checks).filter(k => !checks[k]) });

export function evaluateAffiliateLinkGate(job, { now = new Date() } = {}) {
  if(isSingleOfferHotdeal(job))return evaluateSingleOfferHotdealAffiliate(job,{now});
  if(job?.affiliate?.provider==='myrealtrip'&&job?.publicationBundle?.format==='hotel_promotion')return evaluateHotelPromotionAffiliate(job,{now});
  if(job?.affiliate?.provider==='myrealtrip')return evaluateTravelAffiliate(job,{now});
  const a = job?.affiliate, p = job?.commercialSnapshot, proof = a?.verification;
  const blocks = job?.publicationBundle?.document?.blocks || [];
  const submitted = job?.bodyBlocks || job?.blocks || [];
  const matches = b => ['link', 'oglink'].includes(b.type) && b.url === a?.url;
  const age = now.getTime() - Date.parse(proof?.checkedAt || '');
  return finish({
    explicitAffiliateRequired: shortLink(a?.url),
    affiliateInFinalDocument: blocks.some(matches) && submitted.some(matches),
    noUnverifiedAffiliateLinks: [...blocks,...submitted].filter(b => ['link','oglink'].includes(b.type) && shortLink(b.url)).every(b => b.url === a?.url),
    affiliateImmediatelyAfterDisclosure: blocks.filter(b => b.type !== 'spacer')[1]?.url === a?.url && shortLink(a?.url),
    selectedOfferMatches: p?.affiliateUrl === a?.url && digits(p?.productId) && digits(p?.itemId) && digits(p?.vendorItemId),
    redirectEvidenceRequired: proof?.source === 'independent_http_redirect' && proof?.status === 302,
    redirectEvidenceFresh: Number.isFinite(age) && age >= 0 && age <= 60 * 60000,
    verifiedUrlMatches: proof?.url === a?.url,
    attributionPresent: /^AF\d+$/.test(a?.accountId || '') && proof?.accountId === a?.accountId,
    exactOfferVerified: proof?.productId === p?.productId && proof?.itemId === p?.itemId && proof?.vendorItemId === p?.vendorItemId,
  });
}

// Inspect the observed first-party 302 only. Never follow to arbitrary hosts or
// send account cookies. A submitted success flag cannot replace a live check.
export async function verifyAffiliateRedirect(job, { fetchImpl = globalThis.fetch,
  accounts = AFFILIATE_ACCOUNTS, now = new Date(), journal } = {}) {
  if(job?.affiliate?.provider==='myrealtrip'&&job?.publicationBundle?.format==='hotel_promotion')return verifyHotelPromotionAffiliate(job,{fetchImpl,now,journal});
  if(job?.affiliate?.provider==='myrealtrip')return verifyTravelAffiliate(job,{fetchImpl,now,journal});
  const structural = evaluateAffiliateLinkGate(job, { now });
  if (!structural.passed) return { ...structural, code: 'AFFILIATE_LINK_REQUIRED' };
  if (!accounts[job.blogId] || accounts[job.blogId] !== job.affiliate.accountId)
    return { passed: false, code: 'AFFILIATE_ACCOUNT_UNVERIFIED' };
  try {
    const response = await fetchImpl(job.affiliate.url, { method: 'GET', redirect: 'manual',
      credentials: 'omit', signal: AbortSignal.timeout(10000), headers: { accept: 'text/html' } });
    const location = response.headers.get('location');
    await response.body?.cancel();
    const dest = new URL(location), p = job.commercialSnapshot;
    const unique = key => dest.searchParams.getAll(key).length === 1;
    return { ...finish({
      redirectStatus: response.status === 302,
      destinationOrigin: dest.origin === 'https://www.coupang.com' && !dest.username && !dest.password,
      destinationProduct: dest.pathname === `/vp/products/${p.productId}`,
      attribution: unique('lptag') && dest.searchParams.get('lptag') === accounts[job.blogId],
      exactItem: unique('itemId') && dest.searchParams.get('itemId') === p.itemId,
      exactVendorItem: unique('vendorItemId') && dest.searchParams.get('vendorItemId') === p.vendorItemId,
    }), code: 'AFFILIATE_REDIRECT_CHECK', checkedAt: now.toISOString(),
    accountId: accounts[job.blogId], productId: p.productId, itemId: p.itemId, vendorItemId: p.vendorItemId };
  } catch { return { passed: false, code: 'AFFILIATE_REDIRECT_UNVERIFIED' }; }
}
