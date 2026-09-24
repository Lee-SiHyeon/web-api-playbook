import {articleBlockText} from './article-block-text.mjs';
import {text} from './publication-document.mjs';
import {editorialProvenanceAllowed} from './editorial-provenance.mjs';
import {MYREALTRIP_ACCOUNTS, myrealtripShortLink} from './travel-planning-contract.mjs';
import {ICLUB_COMPARISON,evaluateIclubSnapshot,verifyIclubEvidence,iclubLayoutChecks,evaluateIclubAffiliate,verifyIclubAffiliate} from './iclub-hotel-contract.mjs';
import {SEOUL_SHILLA,evaluateSeoulShillaSnapshot,verifySeoulShillaEvidence,seoulShillaLayoutChecks,evaluateSeoulShillaAffiliate,verifySeoulShillaAffiliate} from './seoul-shilla-contract.mjs';

// A promotion landing page is neither a booked stay nor an experiences quote.
// This binding is limited to the requested, publicly observed campaign.
// Its own shortlink's 301 -> www.myrealtrip.com/main/bridge/marketing ->
// myrealtrip.com/promotions/202609_MONOGRAM was observed on 2026-09-21.
export const HOTEL_PROMOTION = Object.freeze({
  code:'202609_MONOGRAM', canonicalUrl:'https://www.myrealtrip.com/promotions/202609_MONOGRAM',
  couponUrl:'https://www.myrealtrip.com/promotions/2026salefesta_fall_alarm',
  properties:Object.freeze({residence:'5569868',hotel:'5602483'}),
  packages:Object.freeze(['residence_pool','residence_breakfast','hotel_pool','hotel_breakfast']),
  existingPosts:Object.freeze({aicandoanything:'224418752424'}),
});
const hash=v=>/^[a-f0-9]{64}$/.test(v||'');
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const instant=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v);
const fresh=(v,now,minutes=60)=>instant(v)&&Date.parse(v)<=now.getTime()&&now.getTime()-Date.parse(v)<=minutes*60000;
const finish=checks=>({passed:Object.values(checks).every(v=>v===true),checks,failedChecks:Object.keys(checks).filter(k=>checks[k]!==true)});
const evidence=e=>nonempty(e?.evidenceFile)&&hash(e?.sha256)&&/^https:\/\//.test(e?.url||'');
const campaignUrl=v=>v===HOTEL_PROMOTION.canonicalUrl||v==='https://myrealtrip.com/promotions/202609_MONOGRAM';
const propertyFor=id=>HOTEL_PROMOTION.properties[id?.split('_')[0]];
const expectedBenefits=id=>id?.endsWith('_pool')?['pool_2']:['breakfast_2','drinks_2'];
const exactSet=(actual,expected)=>Array.isArray(actual)&&actual.length===expected.length&&new Set(actual).size===actual.length&&expected.every(v=>actual.includes(v));
const sameBenefits=p=>exactSet(p?.benefits,expectedBenefits(p?.packageId));
const money=v=>Number(String(v||'').replace(/[^\d]/g,''));

function quoteUrlMatches(q){
  try{
    const u=new URL(q.sourceUrl),params=u.searchParams;
    return u.origin==='https://api3.myrealtrip.com'&&u.pathname==='/unionstay/v4/properties/deferred'&&
      !u.username&&!u.password&&!u.hash&&!u.port&&
      exactSet([...params.keys()],['gid','checkIn','checkOut','adultCount','childCount'])&&
      params.get('gid')===q.propertyId&&params.get('checkIn')===q.checkIn&&params.get('checkOut')===q.checkOut&&
      params.get('adultCount')===String(q.adults)&&params.get('childCount')===String(q.children);
  }catch{return false;}
}


// September22 recheck of the existing article: absence means only no matching
// option in this complete query response, never sold-out inventory.
const currentMode=p=>p?.datedQuoteMode==='observed_20260922'&&p?.existingArticle?.blogId==='aicandoanything'&&String(p?.existingArticle?.logNo)==='224418752424';
const currentRoomNames={"residence_pool": "[단독★수영장 2인 특가] 디럭스 더블 오션뷰 [단독★수영장 2인 특가]", "residence_breakfast": "[단독★조식&테라로사 2잔 특가] 디럭스 더블 오션뷰 [단독★조식&테라로사 2잔 특가]", "hotel_pool": "[단독★수영장 2인 특가] 디럭스 더블 오션뷰 [단독★수영장 2인 특가] ", "hotel_breakfast": "[단독★조식&테라로사 2잔 특가] 디럭스 더블 오션뷰 [단독★조식&테라로사 2잔 특가]"};
export const monogramCurrentQuoteScope=q=>['residence_pool','residence_breakfast','hotel_pool','hotel_breakfast'].includes(q?.packageId)&&q?.propertyId===propertyFor(q.packageId)&&q?.checkIn==='2026-11-03'&&q?.checkOut==='2026-11-04'&&q?.adults===2&&q?.children===0&&q?.rooms===1&&q?.currency==='KRW'&&q?.taxIncluded===true&&q?.roomName===currentRoomNames[q?.packageId]&&quoteUrlMatches(q)&&
 (q.packageId.startsWith('residence_')?q.status==='not_observed'&&q.displayedTotalKrw===null&&q.couponApplied===null:q.status==='observed'&&q.couponApplied===true&&q.couponTemplateId==='36075'&&positive(q.normalTotalKrw)&&q.couponDiscountKrw===30000&&q.normalTotalKrw-q.couponDiscountKrw===q.displayedTotalKrw&&nonempty(q.rateOptionId));
export function verifyMonogramCurrentQuote(q,response){
 if(!monogramCurrentQuoteScope(q)||response?.result?.status!==200)return false;
 const sections=(response.data?.sections||[]).filter(s=>s.header?.startDate===q.checkIn&&s.header?.endDate===q.checkOut&&s.header?.persons?.adultCount===2&&s.header?.persons?.childCount===0);
 if(sections.length!==1||!Array.isArray(sections[0].gridCards)||sections[0].gridCards.length===0)return false;
 const options=sections[0].gridCards.flatMap(c=>[...(c.bestOptions||[]),...(c.options||[])]),matching=options.filter(o=>o.priceDetail?.roomName===q.roomName&&String(o.gid)===q.propertyId);
 if(q.status==='not_observed')return options.length>0&&options.every(o=>o&&String(o.gid)===q.propertyId)&&matching.length===0;
 return matching.some(o=>o.rateOptionId===q.rateOptionId&&String(o.couponTemplateId)==='36075'&&o.startDateTime===q.checkIn+'T'+o.checkInStartTime&&o.endDateTime===q.checkOut+'T'+o.checkOutEndTime&&/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(o.checkInStartTime||'')&&/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(o.checkOutEndTime||'')&&
 ['NORMAL','TOTAL','DISCOUNT'].every(t=>o.priceDetail.prices.filter(x=>x.type===t).length===1)&&o.priceDetail.prices.find(x=>x.type==='NORMAL').title==='객실 1개 x 1박'&&money(o.priceDetail.prices.find(x=>x.type==='NORMAL').krwPrice)===q.normalTotalKrw&&money(o.priceDetail.prices.find(x=>x.type==='TOTAL').krwPrice)===q.displayedTotalKrw&&money(o.priceDetail.prices.find(x=>x.type==='DISCOUNT').krwPrice)===30000&&o.priceDetail.prices.find(x=>x.type==='DISCOUNT').subPrices?.some(x=>x.title==='쿠폰 할인'&&money(x.priceText)===30000)&&o.price?.taxIncludedText==='세금 포함 '+q.displayedTotalKrw.toLocaleString('en-US')+'원');
}

export function evaluateHotelPromotionSnapshot(p,{now=new Date(),maxAgeMinutes=60}={}){
  if(p?.productId===SEOUL_SHILLA.key)return evaluateSeoulShillaSnapshot(p,{now,maxAgeMinutes});
  if(p?.productId===ICLUB_COMPARISON.key)return evaluateIclubSnapshot(p,{now,maxAgeMinutes});
  const records=v=>Array.isArray(v)?v.map(x=>x&&typeof x==='object'?x:{}):[];
  const packages=records(p?.packages),quotes=records(p?.datedQuotes);
  const coupon=p?.coupon,stay=p?.stay,sales=p?.sales;
  return finish({
    hotelSnapshotType:p?.schemaVersion===1&&p?.provider==='myrealtrip'&&p?.snapshotType==='hotel_promotion',
    hotelCampaignScope:p?.productId===HOTEL_PROMOTION.code&&campaignUrl(p?.productUrl)&&p?.variantId==='hotel_promotion',
    hotelSnapshotFresh:fresh(p?.checkedAt,now,maxAgeMinutes),
    hotelIdentityRecorded:nonempty(p?.productTitle)&&p?.seller==='마이리얼트립'&&nonempty(p?.variant)&&p?.quantity===2,
    hotelAnnouncementNotCheckout:p?.quoteType==='promotion_advertised_from'&&p?.bookingStatus==='not_booked'&&p?.availability==='not_verified'&&p?.payablePriceKrw==null&&p?.totalQuoteKrw==null&&p?.stockState==null,
    hotelSaleWindow:instant(sales?.startsAt)&&instant(sales?.endsAt)&&Date.parse(sales.startsAt)<=now.getTime()&&now.getTime()<Date.parse(sales.endsAt)&&Date.parse(sales.startsAt)<Date.parse(sales.endsAt),
    hotelStayWindow:date(stay?.checkInStart)&&date(stay?.checkInEnd)&&stay.checkInStart<=stay.checkInEnd,
    hotelCouponWindow:instant(coupon?.opensAt)&&date(coupon?.checkInStart)&&date(coupon?.checkInEnd)&&coupon.checkInStart<=coupon.checkInEnd&&date(stay?.checkInEnd)&&coupon.checkInEnd<=stay.checkInEnd,
    hotelCouponArchiveBoundary:!currentMode(p)||(coupon?.evidenceMode==='archived_notice_20260921'&&coupon?.noticeAsOf==='2026-09-21'&&coupon?.currentTermsVerified===false&&coupon?.evidence?.sha256==='0b446bffc91b615d1051a49a78376472a510ffcfa4528fc2c86528b1ae7eb04c'&&evidence(coupon?.redirectEvidence)&&coupon.redirectEvidence.url===HOTEL_PROMOTION.couponUrl&&evidence(coupon?.currentAccessReceipt)&&coupon.currentAccessReceipt.url==='https://accommodation.myrealtrip.com/union/events/salefesta'),
    hotelCouponConditions:coupon?.program==='2026salefesta_fall_alarm'&&coupon?.sourceUrl===HOTEL_PROMOTION.couponUrl&&positive(coupon?.amountKrw)&&positive(coupon?.minimumPaymentKrw)&&coupon?.minimumNights===1&&coupon?.redemptionVerified===false&&coupon?.stacking==='not_assumed',
    hotelPackagesDistinct:exactSet(packages.map(x=>x.packageId),HOTEL_PROMOTION.packages),
    hotelPackageIdentities:packages.length===4&&packages.every(x=>x.propertyId===propertyFor(x.packageId)&&sameBenefits(x)&&x.nights===1&&x.adults===2),
    hotelAdvertisedArithmetic:packages.every(x=>x.priceType==='advertised_starting_price'&&positive(x.advertisedBaseKrw)&&positive(x.advertisedAfterCouponKrw)&&x.couponKrw===coupon?.amountKrw&&x.advertisedBaseKrw-x.couponKrw===x.advertisedAfterCouponKrw&&x.advertisedBaseKrw>=coupon?.minimumPaymentKrw),
    hotelPackageEvidence:packages.every(x=>evidence(x.evidence)),
    hotelDatedQuotesDistinct:exactSet(quotes.map(x=>x.packageId),HOTEL_PROMOTION.packages),
    hotelDatedQuoteScope:currentMode(p)?quotes.length===4&&quotes.every(q=>monogramCurrentQuoteScope(q)&&fresh(q.checkedAt,now,maxAgeMinutes)&&nonempty(q.evidenceFile)&&hash(q.evidenceSha256)):p?.datedQuoteMode==null&&quotes.length===4&&quotes.every(q=>q.propertyId===propertyFor(q.packageId)&&quoteUrlMatches(q)&&q.priceType==='dated_listing_before_coupon'&&q.couponApplied===false&&q.taxIncluded===true&&q.currency==='KRW'&&positive(q.displayedTotalKrw)&&nonempty(q.roomName)&&q.adults===2&&q.children===0&&q.rooms===1&&date(q.checkIn)&&date(q.checkOut)&&Date.parse(q.checkOut)-Date.parse(q.checkIn)===86400000&&q.checkIn>=stay?.checkInStart&&q.checkIn<=stay?.checkInEnd&&fresh(q.checkedAt,now,maxAgeMinutes)&&nonempty(q.evidenceFile)&&hash(q.evidenceSha256)),
    hotelSourceEvidenceBound:nonempty(p?.evidenceFile)&&hash(p?.evidenceSha256)&&evidence(p?.periodEvidence)&&evidence(coupon?.evidence),
    hotelPriceConditions:nonempty(p?.conditions)&&p?.priceAvailabilityStatement==='advertised_from_not_guaranteed_for_every_date',
    hotelAffiliateUrl:myrealtripShortLink(p?.affiliateUrl),
    hotelAffiliateEvidence:p?.linkVerification?.passed===true&&p?.linkVerification?.targetMatches===true&&fresh(p.linkVerification.checkedAt,now,maxAgeMinutes),
    hotelCredentialsNotPersisted:p?.credentialsPersisted===false,
  });
}

// Hash checks alone cannot turn a different property, room, date or coupon
// payload into evidence for this promotion. Images are separately reviewed by
// the independent editorial verifier; these checks bind their original bytes.
export async function verifyHotelPromotionEvidence(p,{read}={}){
  if(p?.productId===SEOUL_SHILLA.key)return verifySeoulShillaEvidence(p,{read});
  if(p?.productId===ICLUB_COMPARISON.key)return verifyIclubEvidence(p,{read});
  const checks={};
  let promotion;
  try{
    promotion=JSON.parse((await read(p.evidenceFile,p.evidenceSha256)).toString('utf8'));
    checks.hotelPromotionSourceMatches=promotion.code===HOTEL_PROMOTION.code&&promotion.metaUrl===HOTEL_PROMOTION.canonicalUrl&&promotion.title===p.productTitle&&promotion.endAt===p.sales.endsAt&&promotion.displayed===true;
  }catch{checks.hotelPromotionSourceMatches=false;}
  const sourceImages=new Set();
  const collect=v=>{if(Array.isArray(v))return v.forEach(collect);if(v&&typeof v==='object'){if(typeof v.image==='string')sourceImages.add(v.image);Object.values(v).forEach(collect);}};
  collect(promotion?.content);
  for(const [id,e] of [['period',p?.periodEvidence],...(p?.packages||[]).map(x=>[x.packageId,x.evidence])]){
    try{await read(e.evidenceFile,e.sha256);checks[`hotel${id}ImageSourceMatches`]=sourceImages.has(e.url);}
    catch{checks[`hotel${id}ImageSourceMatches`]=false;}
  }
  try{
    const c=JSON.parse((await read(p.coupon.evidence.evidenceFile,p.coupon.evidence.sha256)).toString('utf8'));
    if(currentMode(p)){const redirect=JSON.parse((await read(p.coupon.redirectEvidence.evidenceFile,p.coupon.redirectEvidence.sha256)).toString('utf8')),receipt=JSON.parse((await read(p.coupon.currentAccessReceipt.evidenceFile,p.coupon.currentAccessReceipt.sha256)).toString('utf8'));await read(receipt.evidenceFile,receipt.sha256);checks.hotelCouponCurrentBoundary=redirect.code===null&&redirect.displayed===false&&redirect.redirectUrl==='https://accommodation.myrealtrip.com/union/events/salefesta'&&receipt.url===redirect.redirectUrl&&receipt.httpStatus===403&&receipt.requestMethod==='GET'&&receipt.credentials==='omit';}
    checks.hotelCouponSourceMatches=c.code==='2026salefesta_fall_alarm'&&c.metaUrl===HOTEL_PROMOTION.couponUrl&&p.coupon.evidence.url===HOTEL_PROMOTION.couponUrl;
  }catch{checks.hotelCouponSourceMatches=false;}
  for(const [index,q] of (p?.datedQuotes||[]).entries()){
    try{
      const response=JSON.parse((await read(q.evidenceFile,q.evidenceSha256)).toString('utf8'));
      if(currentMode(p)){checks[`hotelQuote${index}SourceMatches`]=verifyMonogramCurrentQuote(q,response);continue;}
      // The live deferred response leaves staticArea.staySearchParam null.
      // Dates/guests are echoed by the room-section header; each option also
      // carries its property and precise check-in/out date-times (2026-09-21).
      const sections=(response.data?.sections||[]).filter(s=>s.header?.startDate===q.checkIn&&s.header?.endDate===q.checkOut&&s.header?.persons?.adultCount===q.adults&&s.header?.persons?.childCount===q.children);
      const options=sections.flatMap(s=>(s.gridCards||[]).flatMap(c=>[...(c.bestOptions||[]),...(c.options||[])]));
      const matching=options.filter(o=>o.priceDetail?.roomName===q.roomName&&String(o.gid)===q.propertyId&&/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(o.checkInStartTime||'')&&/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(o.checkOutEndTime||'')&&o.startDateTime===`${q.checkIn}T${o.checkInStartTime}`&&o.endDateTime===`${q.checkOut}T${o.checkOutEndTime}`);
      checks[`hotelQuote${index}SourceMatches`]=response.result?.status===200&&matching.some(o=>{
        const total=o.priceDetail?.prices?.filter(x=>x.type==='TOTAL')||[];
        const roomUnits=o.priceDetail?.prices?.filter(x=>x.type==='NORMAL')||[];
        return total.length===1&&roomUnits.length===1&&roomUnits[0].title==='객실 1개 x 1박'&&money(total[0].krwPrice)===q.displayedTotalKrw&&o.price?.taxIncludedText===`세금 포함 ${q.displayedTotalKrw.toLocaleString('en-US')}원`&&
          (q.packageId.endsWith('_pool')?/수영장 2인/.test(o.title||''):/조식.*테라로사 2잔/.test(o.title||''));
      });
    }catch{checks[`hotelQuote${index}SourceMatches`]=false;}
  }
  return finish(checks);
}

const documentText=blocks=>blocks.filter(b=>['paragraph','heading','quote','list','numbered','table'].includes(b.type)).map(b=>articleBlockText(b)).join('\n');
const dateShown=(full,value)=>{if(!date(value))return false;const [,m,d]=value.split('-').map(Number);return full.includes(value)||full.includes(`${m}월 ${d}일`)||full.includes(`${m}/${d}`);};
export function hotelPromotionLayoutChecks(bundle){
  if(bundle?.products?.[0]?.productId===SEOUL_SHILLA.key)return seoulShillaLayoutChecks(bundle);
  if(bundle?.products?.[0]?.productId===ICLUB_COMPARISON.key)return iclubLayoutChecks(bundle);
  const blocks=bundle?.document?.blocks||[],images=blocks.filter(b=>b.type==='image'),p=bundle?.products?.[0],full=documentText(blocks);
  const quotes=Array.isArray(p?.datedQuotes)?p.datedQuotes:[],packages=Array.isArray(p?.packages)?p.packages:[];
  const differences=quotes.filter(q=>q?.status!=='not_observed'&&q?.displayedTotalKrw!==packages.find(x=>x?.packageId===q?.packageId)?.advertisedBaseKrw);
  return {
    hotelPromotionSingleCampaign:bundle?.products?.length===1&&p?.snapshotType==='hotel_promotion'&&p?.productId===HOTEL_PROMOTION.code,
    hotelThreeUsefulImages:images.length>=3&&['affiliate_banner','package_comparison','coupon_calendar'].every(role=>images.filter(b=>b.role===role).length===1),
    hotelEditorialProvenanceRequired:editorialProvenanceAllowed(bundle),
    hotelAdvertisedPriceVisible:/행사 안내|행사에 안내|공식.*안내/.test(full)&&/시작가|부터/.test(full),
    hotelPackageSeparationVisible:/조식/.test(full)&&/테라로사|음료/.test(full)&&/별도/.test(full),
    hotelCouponWindowVisible:dateShown(full,p?.stay?.checkInEnd)&&dateShown(full,p?.coupon?.checkInEnd)&&/입실|체크인/.test(full)&&/쿠폰/.test(full),
    hotelPriceVariationVisible:/날짜/.test(full)&&/최종.*금액|실제.*금액/.test(full)&&/달라|다를|차이/.test(full),
    hotelArchivedNoticeVisible:!currentMode(p)||(/9월 21일/.test(full)&&/당시|안내 기준|기존 안내/.test(full)&&/현재.*확인|최신.*확인/.test(full)),
    hotelCurrentAbsenceVisible:!currentMode(p)||(/조회/.test(full)&&/미노출|노출되지|찾지 못/.test(full)&&/쿠폰/.test(full)),
    hotelObservedDifferenceVisible:differences.every(q=>positive(q?.displayedTotalKrw)&&(full.includes(q.displayedTotalKrw.toLocaleString('en-US'))||full.includes(String(q.displayedTotalKrw)))),
    hotelNoInventedStayExperience:!/(?:직접|제가|저는|우리는).{0,10}(?:투숙|숙박)(?:했|해보)|다녀왔|내돈내산/.test(full),
  };
}

export function evaluateHotelPromotionAffiliate(job,{now=new Date()}={}){
  if(job?.commercialSnapshot?.productId===SEOUL_SHILLA.key)return evaluateSeoulShillaAffiliate(job,{now});
  if(job?.commercialSnapshot?.productId===ICLUB_COMPARISON.key)return evaluateIclubAffiliate(job,{now});
  const a=job?.affiliate,p=job?.commercialSnapshot,proof=a?.verification;
  const documents=[job?.publicationBundle?.document?.blocks||[],job?.bodyBlocks||job?.blocks||[]];
  const banner=b=>b?.type==='image'&&b.role==='affiliate_banner'&&b.href===a?.url;
  return finish({
    hotelAffiliateFormat:job?.publicationBundle?.format==='hotel_promotion'&&p?.snapshotType==='hotel_promotion'&&a?.provider==='myrealtrip'&&p?.provider==='myrealtrip',
    hotelCurrentUpdateOnly:!currentMode(p)||(job?.target?.type==='update'&&job.blogId==='aicandoanything'&&String(job.target.logNo)==='224418752424'),
    hotelWriteScope:job?.target?.type==='create'&&!job.target.logNo&&!job.publicationBundle?.document?.logNo&&job.inputProvider==='headless_sdk'||
      job?.target?.type==='update'&&String(job.target.logNo)===HOTEL_PROMOTION.existingPosts[job.blogId]&&
      job.publicationBundle?.document?.blogId===job.blogId&&String(job.publicationBundle?.document?.logNo)===String(job.target.logNo)&&
      job.preflight?.kind==='independent_http_update_preflight'&&hash(job.preflight?.sourceDocumentFingerprint)&&fresh(job.preflight?.checkedAt,now,30),
    hotelExplicitAffiliateRequired:myrealtripShortLink(a?.url),
    hotelBannerImmediatelyAfterDisclosure:documents.every(bs=>bs[0]?.type==='notice'&&banner(bs.filter(b=>b.type!=='spacer')[1])),
    hotelOneBannerNoTextAffiliate:documents.every(bs=>bs.filter(b=>b.role==='affiliate_banner').length===1&&bs.filter(b=>myrealtripShortLink(b.href||b.url)).length===1&&!/https:\/\/myrealt\.rip\//.test(documentText(bs))),
    hotelSelectedPromotionMatches:p?.productId===HOTEL_PROMOTION.code&&campaignUrl(p?.productUrl)&&p?.affiliateUrl===a?.url,
    hotelRedirectProof:proof?.source==='independent_http_redirect'&&proof.status===301&&proof.bridgeStatus===200&&proof.url===a?.url&&proof.promotionCode===p?.productId&&proof.targetUrl===p?.productUrl&&fresh(proof.checkedAt,now),
    hotelAttributionPresent:hash(a?.accountFingerprint)&&proof?.accountFingerprint===a.accountFingerprint&&/^\d+$/.test(String(a?.mylinkId||''))&&String(proof?.mylinkId)===String(a?.mylinkId),
    hotelCreationJournalRequired:hash(a?.creationJournalKey),
  });
}

export async function verifyHotelPromotionAffiliate(job,{fetchImpl=globalThis.fetch,now=new Date(),journal,accounts=MYREALTRIP_ACCOUNTS}={}){
  if(job?.commercialSnapshot?.productId===SEOUL_SHILLA.key)return verifySeoulShillaAffiliate(job,{fetchImpl,now,journal,accounts});
  if(job?.commercialSnapshot?.productId===ICLUB_COMPARISON.key)return verifyIclubAffiliate(job,{fetchImpl,now,journal,accounts});
  const structural=evaluateHotelPromotionAffiliate(job,{now});
  if(!structural.passed)return {...structural,code:'HOTEL_PROMOTION_AFFILIATE_REQUIRED'};
  const a=job.affiliate,p=job.commercialSnapshot;
  if(accounts[job.blogId]!==a.accountFingerprint)return {passed:false,code:'AFFILIATE_ACCOUNT_UNVERIFIED'};
  try{
    const entry=await journal.read(a.creationJournalKey),r=entry.receipt;
    if(entry.operation!=='myrealtripCreateLink'||entry.state!=='verified'||r?.source!=='independent_http'||r?.status!==200||r?.ownerVerified!==true||r?.accountFingerprint!==a.accountFingerprint||r?.targetUrl!==p.productUrl||r?.data?.mylink!==a.url||String(r?.data?.id)!==String(a.mylinkId))throw Error('CREATION_PROOF');
    const response=await fetchImpl(a.url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000)});
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location||location.length>8192)throw Error('BRIDGE_SCOPE');
    const bridge=new URL(location);
    if(response.status!==301||bridge.origin!=='https://www.myrealtrip.com'||bridge.pathname!=='/main/bridge/marketing'||bridge.username||bridge.password||bridge.port||bridge.hash||!exactSet([...bridge.searchParams.keys()],['return_url']))throw Error('BRIDGE_SCOPE');
    const target=new URL(bridge.searchParams.get('return_url'));
    if(target.username||target.password||target.port||target.hash||!exactSet([...target.searchParams.keys()],['utm_source','mylink_id','t_scope'])||target.searchParams.get('utm_source')!=='mktpartner'||target.searchParams.get('mylink_id')!==String(a.mylinkId)||target.searchParams.get('t_scope')!=='604800')throw Error('ATTRIBUTION_SCOPE');
    target.search='';
    if(target.href!==p.productUrl)throw Error('PROMOTION_TARGET_SCOPE');
    const res=await fetchImpl(bridge.href,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(15000)});await res.body?.cancel();
    return {passed:res.status===200&&/^text\/html(?:;|$)/i.test(res.headers.get('content-type')||''),code:'MYREALTRIP_PROMOTION_REDIRECT_CHECK',checkedAt:now.toISOString(),promotionCode:p.productId,targetUrl:p.productUrl,mylinkId:String(a.mylinkId),accountFingerprint:a.accountFingerprint,bridgeStatus:res.status};
  }catch{return {passed:false,code:'MYREALTRIP_PROMOTION_AFFILIATE_UNVERIFIED'};}
}
