import {articleBlockText} from './article-block-text.mjs';
// MyRealtrip travel planning is a listing snapshot, not a dated booking quote.
// Contract observed 2026-09-21: own authenticated /partner/v2/mylink receipt,
// followed by a public 301 to the first-party marketing bridge.
export const MYREALTRIP_ACCOUNTS = Object.freeze({aicandoanything:'147940e52ddfb49d038b3ec85392c50df8df6e986b0dde329e10e2686b0d33e2'});
export const myrealtripShortLink = v => /^https:\/\/myrealt\.rip\/[A-Za-z0-9]+$/.test(v || '');
const hash = v => /^[a-f0-9]{64}$/.test(v || '');
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const fresh = (v,now,minutes=60) => Number.isFinite(Date.parse(v)) && Date.parse(v)<=now.getTime() && now.getTime()-Date.parse(v)<=minutes*60000;
const finish = checks => ({passed:Object.values(checks).every(v=>v===true),checks,failedChecks:Object.keys(checks).filter(k=>checks[k]!==true)});

export function evaluateTravelSnapshot(p,{now=new Date(),maxAgeMinutes=60}={}) {
 return finish({
  schemaVersion:p?.schemaVersion===1,provider:p?.provider==='myrealtrip',
  listingFresh:fresh(p?.checkedAt,now,maxAgeMinutes),
  productIdentity:/^\d+$/.test(p?.productId||'') && p?.productUrl===`https://experiences.myrealtrip.com/products/${p?.productId}`,
  productTitle:nonempty(p?.productTitle),seller:nonempty(p?.seller),variant:nonempty(p?.variant)&&nonempty(p?.variantId),
  travelDate:/^\d{4}-\d{2}-\d{2}$/.test(p?.travelDate||'')&&Number.isFinite(Date.parse(p.travelDate)),
  travelers:Number.isInteger(p?.quantity)&&p.quantity>0,
  planningState:p?.bookingStatus==='unconfirmed'&&p?.dateAvailability==='unverified'&&p?.quoteType==='listing_guide_fee',
  listedFee:typeof p?.listedGuideFeeKrw==='number'&&p.listedGuideFeeKrw>0,
  noInventedTotal:p?.payablePriceKrw==null&&p?.totalQuoteKrw==null&&p?.stockState==null,
  priceConditions:nonempty(p?.conditions)&&p?.additionalCosts==='verify_for_travel_date',
  affiliateUrl:myrealtripShortLink(p?.affiliateUrl),
  linkVerification:p?.linkVerification?.passed===true&&p?.linkVerification?.targetMatches===true&&fresh(p.linkVerification.checkedAt,now,maxAgeMinutes),
  evidenceBound:hash(p?.evidenceSha256)&&nonempty(p?.evidenceFile),credentialsNotPersisted:p?.credentialsPersisted===false,
 });
}

export function evaluateTravelAffiliate(job,{now=new Date()}={}) {
 const a=job?.affiliate,p=job?.commercialSnapshot,proof=a?.verification;
 const blocks=job?.publicationBundle?.document?.blocks||[],submitted=job?.bodyBlocks||job?.blocks||[];
 const banner=b=>b?.type==='image'&&b.role==='affiliate_banner'&&b.href===a?.url;
 return finish({
  provider:a?.provider==='myrealtrip'&&p?.provider==='myrealtrip'&&job?.publicationBundle?.format==='travel_itinerary',
  observedUpdateScope:job?.target?.type==='update',
  explicitAffiliateRequired:myrealtripShortLink(a?.url),
  affiliateInFinalDocument:blocks.some(banner)&&submitted.some(banner),
  affiliateImmediatelyAfterDisclosure:blocks[0]?.type==='notice'&&banner(blocks.filter(b=>b.type!=='spacer')[1]),
  oneBannerNoTextAffiliate:[blocks,submitted].every(bs=>bs.filter(b=>myrealtripShortLink(b.href||b.url)).length===1&&bs.filter(b=>b.role==='affiliate_banner').length===1),
  selectedOfferMatches:p?.affiliateUrl===a?.url&&/^\d+$/.test(p?.productId||''),
  redirectEvidenceRequired:proof?.source==='independent_http_redirect'&&proof.status===301&&proof.bridgeStatus===200,
  redirectEvidenceFresh:fresh(proof?.checkedAt,now),verifiedUrlMatches:proof?.url===a?.url,
  attributionPresent:hash(a?.accountFingerprint)&&proof?.accountFingerprint===a.accountFingerprint&&/^\d+$/.test(String(a?.mylinkId||'')),
  exactOfferVerified:proof?.productId===p?.productId&&String(proof?.mylinkId)===String(a?.mylinkId),
  authenticatedCreationJournal:hash(a?.creationJournalKey),
 });
}

export async function verifyTravelAffiliate(job,{fetchImpl=globalThis.fetch,now=new Date(),journal,accounts=MYREALTRIP_ACCOUNTS}={}) {
 const structural=evaluateTravelAffiliate(job,{now});if(!structural.passed)return {...structural,code:'TRAVEL_AFFILIATE_REQUIRED'};
 const a=job.affiliate,p=job.commercialSnapshot;
 if(accounts[job.blogId]!==a.accountFingerprint)return {passed:false,code:'AFFILIATE_ACCOUNT_UNVERIFIED'};
 try {
  const entry=await journal.read(a.creationJournalKey),r=entry.receipt;
  if(entry.operation!=='myrealtripCreateLink'||entry.state!=='verified'||r?.source!=='independent_http'||r?.ownerVerified!==true||r?.status!==200||r?.accountFingerprint!==a.accountFingerprint||r?.targetUrl!==p.productUrl||r?.data?.mylink!==a.url||String(r?.data?.id)!==String(a.mylinkId))throw Error('CREATION_PROOF');
  const response=await fetchImpl(a.url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000)});
  const dest=new URL(response.headers.get('location'));await response.body?.cancel();
  if(response.status!==301||dest.origin!=='https://www.myrealtrip.com'||dest.pathname!=='/main/bridge/marketing'||dest.username||dest.password||dest.searchParams.getAll('return_url').length!==1)throw Error('BRIDGE_SCOPE');
  const target=new URL(dest.searchParams.get('return_url'));
  if(target.origin!=='https://experiences.myrealtrip.com'||target.pathname!==`/products/${p.productId}`||target.username||target.password||target.searchParams.getAll('mylink_id').length!==1||target.searchParams.get('mylink_id')!==String(a.mylinkId)||target.searchParams.get('utm_source')!=='mktpartner')throw Error('DESTINATION_SCOPE');
  const bridge=await fetchImpl(dest.href,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(15000)});await bridge.body?.cancel();
  return {passed:bridge.status===200,code:'MYREALTRIP_REDIRECT_CHECK',checkedAt:now.toISOString(),productId:p.productId,mylinkId:String(a.mylinkId),accountFingerprint:a.accountFingerprint,bridgeStatus:bridge.status};
 } catch {return {passed:false,code:'MYREALTRIP_AFFILIATE_UNVERIFIED'};}
}

export function travelPlanningLayoutChecks(bundle){
 const blocks=bundle?.document?.blocks||[],images=blocks.filter(b=>b.type==='image'),plan=bundle?.itinerary;
 return {
  travelBannerAndMap:images.length>=2&&images.filter(b=>b.role==='itinerary_map').length===1&&images.filter(b=>b.role==='affiliate_banner').length===1,
  travelPlanSourceBound:plan?.status==='unconfirmed_plan'&&/^https:\/\/docs\.google\.com\/spreadsheets\//.test(plan?.sourceUrl||'')&&hash(plan?.evidenceSha256),
  travelDatesConsistent:plan?.dayNumber===Math.round((Date.parse(plan?.visitDate)-Date.parse(plan?.startDate))/86400000)+1&&plan?.tripDays===Math.round((Date.parse(plan?.endDate)-Date.parse(plan?.startDate))/86400000)+1&&plan?.tripNights===plan?.tripDays-1,
  romeDatesConsistent:plan?.romeNights===Math.round((Date.parse(plan?.romeCheckOut)-Date.parse(plan?.romeCheckIn))/86400000)&&plan?.romeDays===plan?.romeNights+1&&plan?.romeDayNumber===Math.round((Date.parse(plan?.visitDate)-Date.parse(plan?.romeCheckIn))/86400000)+1,
  travelProductScope:bundle.products?.length===1&&bundle.products[0].provider==='myrealtrip'&&bundle.products[0].travelDate===plan?.visitDate,
  travelMapAttribution:images.filter(b=>b.role==='itinerary_map').every(b=>b.rights?.basis==='licensed'&&b.rights?.source==='https://www.openstreetmap.org/copyright'&&nonempty(b.rights?.attribution)&&blocks[blocks.indexOf(b)+1]?.text?.includes('© OpenStreetMap contributors')),
  travelUncertaintyVisible:blocks.some(b=>/예약 전|예약이.*확정|아직.*확정/.test(articleBlockText(b)))&&blocks.some(b=>/희망\s*(?:입장\s*)?(?:시간|시각)/.test(articleBlockText(b))),
 };
}
