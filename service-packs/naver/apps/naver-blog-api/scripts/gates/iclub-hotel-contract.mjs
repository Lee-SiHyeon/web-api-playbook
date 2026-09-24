import {articleBlockText,articleTableCells} from './article-block-text.mjs';
import {existingArticleUpdateScope} from './existing-article-update-scope.mjs';
import {text} from './publication-document.mjs';
import {editorialProvenanceAllowed} from './editorial-provenance.mjs';
import {MYREALTRIP_ACCOUNTS, myrealtripShortLink} from './travel-planning-contract.mjs';

// A local editorial comparison key, NOT a MyRealtrip promotion code. The two
// property pages and selected rates have different observed promotion states.
export const ICLUB_COMPARISON = Object.freeze({
  key:'iclub_202609', variantId:'iclub_two_property_comparison',
  checkIn:'2026-11-03', checkOut:'2026-11-05', adults:5, children:0, rooms:1, nights:2,
  properties:Object.freeze([
    Object.freeze({propertyId:'4819071',hotelTitle:'아이클럽 셩완 AMTD',roomId:'223158121',roomName:'iResidence Elite [특가] 룸 온리',rateOptionId:'ACM_OPT_MRT:-:STAYNET:-:2483:-:16886:-:115895:-:115895',promotionId:'28041',promotionEnd:'2026-09-30T23:59:59',selectedRatePromotion:true,lateCheckoutTime:'13:00'}),
    Object.freeze({propertyId:'4818069',hotelTitle:'아이클럽 셩완',roomId:'222857246',roomName:'i Residence [특가] 룸 온리',rateOptionId:'ACM_OPT_MRT:-:STAYNET:-:2471:-:16879:-:115892:-:115892',promotionId:'27780',promotionEnd:'2026-09-23T23:59:59',selectedRatePromotion:false,lateCheckoutTime:null}),
  ]),
});
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const records=v=>Array.isArray(v)?v.map(x=>x&&typeof x==='object'?x:{}):[];
const exactSet=(a,b)=>Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&b.every(v=>a.includes(v));
const instant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const fresh=(v,now,minutes=60)=>instant(v)&&Date.parse(v)<=now.getTime()&&now.getTime()-Date.parse(v)<=minutes*60000;
const finish=checks=>({passed:Object.values(checks).every(v=>v===true),checks,failedChecks:Object.keys(checks).filter(k=>checks[k]!==true)});
const source=e=>nonempty(e?.evidenceFile)&&hash(e?.sha256)&&/^https:\/\//.test(e?.url||'');
const money=v=>typeof v==='string'&&/^-?[\d,]+원$/.test(v)?Number(v.replace(/[,원]/g,'')):NaN;
const expected=i=>ICLUB_COMPARISON.properties[i];
const scopedUrl=(value,origin,pathname,params)=>{
  try{
    const u=new URL(value);
    return u.origin===origin&&u.pathname===pathname&&!u.username&&!u.password&&!u.port&&!u.hash&&
      exactSet([...u.searchParams.keys()],Object.keys(params))&&Object.entries(params).every(([k,v])=>u.searchParams.get(k)===String(v));
  }catch{return false;}
};
const stayParams=()=>({checkIn:ICLUB_COMPARISON.checkIn,checkOut:ICLUB_COMPARISON.checkOut,adultCount:5,childCount:0});
export const iclubProductUrl=propertyId=>`https://accommodation.myrealtrip.com/union/products/${propertyId}?${new URLSearchParams(stayParams())}`;
const productUrlMatches=(v,id)=>scopedUrl(v,'https://accommodation.myrealtrip.com',`/union/products/${id}`,stayParams());
const quoteUrlMatches=q=>scopedUrl(q?.sourceUrl,'https://api3.myrealtrip.com','/unionstay/v4/properties/deferred',{gid:q?.propertyId,...stayParams()});
const primaryUrlMatches=(v,id)=>scopedUrl(v,'https://api3.myrealtrip.com','/unionstay/v4/properties/primary',{gid:id});
const offersOf=p=>records(p?.propertyOffers);
const docText=blocks=>records(blocks).filter(b=>['notice','paragraph','heading','quote','list','numbered','table'].includes(b.type)).map(b=>articleBlockText(b)).join('\n');
const cancellationInstant=value=>{
  const m=/^무료 취소 가능 \(한국시간, (\d{2})년 (\d{1,2})월 (\d{1,2})일 (\d{2}):(\d{2})까지\)$/.exec(value||'');
  if(!m)return null;
  const v=`20${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}T${m[4]}:${m[5]}:00+09:00`;
  return Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)+9*3600000).toISOString().slice(0,19)===v.slice(0,19)?v:null;
};

export function evaluateIclubSnapshot(p,{now=new Date(),maxAgeMinutes=60}={}){
  const offers=offersOf(p);
  return finish({
    iclubSnapshotType:p?.schemaVersion===1&&p?.provider==='myrealtrip'&&p?.snapshotType==='hotel_promotion',
    iclubLocalComparisonScope:p?.productId===ICLUB_COMPARISON.key&&p?.variantId===ICLUB_COMPARISON.variantId&&p?.campaignKeyType==='local'&&p?.promotionCode==null&&p?.sales==null&&p?.coupon==null,
    iclubSnapshotFresh:fresh(p?.checkedAt,now,maxAgeMinutes),
    iclubIdentityRecorded:nonempty(p?.productTitle)&&nonempty(p?.variant)&&p?.seller==='마이리얼트립'&&p?.quantity===2&&nonempty(p?.conditions),
    iclubListingNotBooking:p?.quoteType==='dated_listing_comparison'&&p?.bookingStatus==='not_booked'&&p?.availability==='listing_observed_not_guaranteed'&&p?.payablePriceKrw==null&&p?.totalQuoteKrw==null&&p?.stockState==null&&p?.priceAvailabilityStatement==='dated_quote_not_booking_confirmation',
    iclubTwoExactProperties:offers.length===2&&offers.every((q,i)=>q.propertyId===expected(i).propertyId&&q.hotelTitle===expected(i).hotelTitle),
    iclubExactRoomRates:offers.length===2&&offers.every((q,i)=>String(q.roomId)===expected(i).roomId&&q.roomName===expected(i).roomName&&q.rateOptionId===expected(i).rateOptionId&&q.rateName==='[특가] 룸 온리'),
    iclubSameStayAndGuests:offers.length===2&&offers.every(q=>q.checkIn===ICLUB_COMPARISON.checkIn&&q.checkOut===ICLUB_COMPARISON.checkOut&&q.adults===5&&q.children===0&&q.rooms===1&&q.nights===2&&q.minimumBookableNights===1),
    iclubPriceBasisExplicit:offers.length===2&&offers.every(q=>q.priceType==='dated_listing'&&q.currency==='KRW'&&q.nightlyTaxIncluded===false&&q.totalTaxIncluded===true&&positive(q.displayedNightlyPreTaxKrw)&&positive(q.displayedTotalKrw)),
    iclubSourceScope:offers.length===2&&offers.every(q=>productUrlMatches(q.productUrl,q.propertyId)&&quoteUrlMatches(q)&&source(q.propertyEvidence)&&primaryUrlMatches(q.propertyEvidence.url,q.propertyId)&&nonempty(q.evidenceFile)&&hash(q.evidenceSha256)),
    iclubSourcesFresh:offers.length===2&&offers.every(q=>fresh(q.checkedAt,now,maxAgeMinutes)&&fresh(q.propertyEvidence?.checkedAt,now,maxAgeMinutes)),
    // The source omits its timezone offset. Bind its literal date/time and
    // calendar end date without claiming an exact UTC/KST closing instant.
    iclubPromotionSeparation:offers.length===2&&offers.every((q,i)=>q.promotion?.id===expected(i).promotionId&&q.promotion.startsAtLocal==='2026-09-01T00:00'&&q.promotion.endsAtLocal===expected(i).promotionEnd&&q.promotion.appliesToSelectedRate===expected(i).selectedRatePromotion)&&now.toISOString().slice(0,10)<='2026-09-30',
    iclubConditionalBenefits:offers.length===2&&offers.every((q,i)=>q.benefits?.breakfastIncluded===false&&q.benefits.morningRefreshments==='07:30–10:30'&&q.benefits.coffeeTea24Hours===true&&q.benefits.lateCheckout?.minimumNights===2&&q.benefits.lateCheckout.requestRequired===true&&q.benefits.lateCheckout.subjectToAvailability===true&&q.benefits.lateCheckout.time===expected(i).lateCheckoutTime),
    iclubConfirmationNotInstant:offers.length===2&&offers.every(q=>q.confirmationText==='영업일 기준 4일 이내 확정'&&q.maximumOccupancyVerified===false),
    iclubCancellationRecorded:offers.length===2&&offers.every(q=>q.cancellation?.type==='free_until'&&cancellationInstant(q.cancellation.originalText)===q.cancellation.freeUntilKst&&instant(q.cancellation.freeUntilKst)&&Date.parse(q.cancellation.freeUntilKst)>now.getTime()),
    iclubManifestBound:nonempty(p?.evidenceFile)&&hash(p?.evidenceSha256),
    iclubTwoDistinctAffiliateUrls:offers.length===2&&offers.every(q=>myrealtripShortLink(q.affiliateUrl)&&q.linkVerification?.passed===true&&q.linkVerification.targetMatches===true&&fresh(q.linkVerification.checkedAt,now,maxAgeMinutes))&&new Set(offers.map(q=>q.affiliateUrl)).size===2,
    iclubPrimaryAliasMatches:p?.productUrl===offers[0]?.productUrl&&p?.affiliateUrl===offers[0]?.affiliateUrl&&p?.linkVerification?.passed===true&&p?.linkVerification?.targetMatches===true&&fresh(p?.linkVerification?.checkedAt,now,maxAgeMinutes),
    iclubCredentialsNotPersisted:p?.credentialsPersisted===false,
  });
}

function attributeItems(option){return records(option?.optionAllAttributes?.contents).flatMap(c=>records(c.items));}
function optionSourceChecks(q,raw){
  const sections=records(raw?.data?.sections).filter(s=>s.header?.startDate===q.checkIn&&s.header?.endDate===q.checkOut&&s.header?.persons?.adultCount===q.adults&&s.header?.persons?.childCount===q.children);
  const matches=sections.flatMap(s=>records(s.gridCards).flatMap(c=>records([...(c.bestOptions||[]),...(c.options||[])]).map(o=>({card:c,option:o})))).filter(({card,option:o})=>String(card.header?.roomId)===String(q.roomId)&&String(o.roomId)===String(q.roomId)&&String(o.gid)===q.propertyId&&o.rateOptionId===q.rateOptionId&&o.title===q.rateName&&o.priceDetail?.roomName===q.roomName);
  return raw?.result?.status===200&&matches.length>0&&matches.every(({card,option:o})=>{
    const prices=records(o.priceDetail?.prices),totals=prices.filter(x=>x.type==='TOTAL'),normals=prices.filter(x=>x.type==='NORMAL');
    const attrs=attributeItems(o),benefit=attrs.find(x=>/레이트 체크아웃/.test(x.titleWithIcon?.text||''));
    const food=attrs.find(x=>x.titleWithIcon?.text==='조식 등이 제공되지 않는 실속 옵션');
    const cancel=attrs.find(x=>x.titleWithIcon?.text==='무료 취소');
    const stay=attrs.find(x=>x.titleWithIcon?.text==='최소/최대 숙박일');
    const lateTitle=q.propertyId==='4819071'?'2박 이상- 13시 무료 레이트 체크아웃 제공':'2박 이상 투숙 시 레이트 체크아웃 제공';
    const confirmation=records(card.header?.representAttributesWithIcon).some(x=>x.title===q.confirmationText);
    const guests=records(card.header?.representAttributesWithIcon).some(x=>x.title==='성인 5명');
    return confirmation&&guests&&o.startDateTime===`${q.checkIn}T14:00:00`&&o.endDateTime===`${q.checkOut}T11:00:00`&&o.checkInStartTime==='14:00:00'&&o.checkOutEndTime==='11:00:00'&&
      normals.length===1&&normals[0].title==='객실 1개 x 2박'&&totals.length===1&&money(totals[0].krwPrice)===q.displayedTotalKrw&&o.salePrice===q.displayedTotalKrw&&
      money(o.price?.discountedPriceText)===q.displayedNightlyPreTaxKrw&&o.price?.taxIncludedText===`2박 세금 포함 ${q.displayedTotalKrw.toLocaleString('en-US')}원`&&
      o.priceDetail.footerPriceText===`${q.displayedTotalKrw.toLocaleString('en-US')}원 / 2박`&&
      (food?.items||[]).includes('iLounge 아침 다과 제공 (07:30AM–10:30AM)\n24시간 커피 & 티 서비스')&&
      benefit?.titleWithIcon?.text===lateTitle&&(benefit?.items||[]).includes('예약 시 요청사항란에 기재 필수\n객실 상황이 가능할 경우에 한하여 제공')&&
      (cancel?.items||[]).includes(q.cancellation.originalText)&&(stay?.items||[]).includes('최소 숙박일 1일')&&
      o.isPromotion===q.promotion.appliesToSelectedRate&&(q.promotion.appliesToSelectedRate?o.promotionPriceDisplay?.endDateTime===q.promotion.endsAtLocal:o.promotionPriceDisplay==null);
  });
}

export async function verifyIclubEvidence(p,{read}={}){
  const checks={},offers=offersOf(p);let receipts=[];
  try{receipts=JSON.parse((await read(p.evidenceFile,p.evidenceSha256)).toString('utf8'));checks.iclubSourceManifest=Array.isArray(receipts)&&receipts.length>=4;}catch{checks.iclubSourceManifest=false;}
  for(const [i,q] of offers.entries()){
    const recorded=(url,file,sha256,checkedAt)=>Array.isArray(receipts)&&receipts.some(r=>r.url===url&&r.file===file&&r.sha256===sha256&&r.checkedAt===checkedAt&&r.httpStatus===200);
    checks[`iclub${i}FetchReceiptsMatch`]=recorded(q.sourceUrl,q.evidenceFile,q.evidenceSha256,q.checkedAt)&&recorded(q.propertyEvidence?.url,q.propertyEvidence?.evidenceFile,q.propertyEvidence?.sha256,q.propertyEvidence?.checkedAt);
    try{
      const primary=JSON.parse((await read(q.propertyEvidence.evidenceFile,q.propertyEvidence.sha256)).toString('utf8'));
      const timer=records(primary.data?.sections).filter(s=>s.type==='PROMOTION_TIMER');
      checks[`iclub${i}PropertySourceMatches`]=primary.result?.status===200&&String(primary.data?.staticArea?.metaInfo?.gid)===q.propertyId&&primary.data?.staticArea?.header?.stayTitle===q.hotelTitle&&String(primary.data?.staticArea?.promotionId)===q.promotion.id&&timer.length===1&&timer[0].startDateTime===q.promotion.startsAtLocal&&timer[0].endDateTime===q.promotion.endsAtLocal;
    }catch{checks[`iclub${i}PropertySourceMatches`]=false;}
    try{checks[`iclub${i}DatedOptionSourceMatches`]=optionSourceChecks(q,JSON.parse((await read(q.evidenceFile,q.evidenceSha256)).toString('utf8')));}
    catch{checks[`iclub${i}DatedOptionSourceMatches`]=false;}
  }
  checks.iclubTwoSourceOffers=offers.length===2;
  return finish(checks);
}

export function iclubLayoutChecks(bundle){
  const blocks=records(bundle?.document?.blocks),images=blocks.filter(b=>b.type==='image'),p=bundle?.products?.[0],offers=offersOf(p);
  const full=[bundle?.document?.title,docText(blocks)].join('\n');
  const cells=articleTableCells(blocks);
  const shorthandDates=blocks.some(b=>/2026년\s*9월\s*22일|2026/.test(articleBlockText(b))&&/11월\s*3일\s*체크인[~～–-]5일\s*체크아웃/.test(articleBlockText(b)));
  const shown=n=>positive(n)&&(full.includes(n.toLocaleString('en-US'))||full.includes(String(n)));
  return {
    iclubSingleLocalComparison:bundle?.products?.length===1&&p?.productId===ICLUB_COMPARISON.key,
    iclubFourUsefulImages:images.length>=4&&images.filter(b=>b.role==='affiliate_banner').length===2&&['offer_comparison','benefit_conditions'].every(role=>images.filter(b=>b.role===role).length===1)&&images.every(b=>hash(b.sha256))&&new Set(images.map(b=>b.sha256)).size===images.length,
    iclubEditorialProvenanceRequired:editorialProvenanceAllowed(bundle),
    iclubQuoteDatesVisible:/2026/.test(full)&&/11월\s*3일|2026-11-03|11\/3/.test(full)&&(/11월\s*5일|2026-11-05|11\/5/.test(full)||shorthandDates)&&/성인\s*5명/.test(full)&&/2박/.test(full)&&/객실\s*1개|1객실/.test(full),
    iclubPriceBasisVisible:/세전.*1박|1박.*세전/.test(full)&&/세금\s*포함/.test(full)&&/2박.*총액|총액.*2박/.test(full)&&offers.length===2&&offers.every(q=>shown(q.displayedNightlyPreTaxKrw)&&shown(q.displayedTotalKrw)),
    iclubBenefitConditionsVisible:/AMTD/.test(full)&&/13시/.test(full)&&/2박\s*이상/.test(full)&&/예약.*요청/.test(full)&&/객실.*(?:상황|가능)/.test(full)&&(/셩완.*(?:시간.*(?:미명시|명시.*않|안내.*없)|(?:미명시).*시간)/.test(full)||cells.some(c=>/셩완/.test(c.column)&&/2박\s*이상\s*혜택/.test(c.rowLabel)&&/레이트\s*체크아웃.*시간\s*미표기/.test(c.value))),
    iclubMealConditionsVisible:/아침\s*다과/.test(full)&&/조식.*(?:별도|불포함|포함.*않|제공.*않)/.test(full),
    iclubPromotionDifferenceVisible:/AMTD[^\n]*9월\s*30일|9월\s*30일[^\n]*AMTD/.test(full)&&/셩완[^\n]*(?:선택|조회)[^\n]*(?:행사|프로모션)[^\n]*(?:아니|않|미적용|표시.*없)/.test(full),
    iclubBookingCaveatVisible:(/영업일\s*기준\s*4일\s*이내\s*확정/.test(full)||['셩완','AMTD'].every(hotel=>cells.some(c=>c.column===hotel&&c.rowLabel==='예약 확정'&&/^영업일\s*기준\s*4일\s*이내$/.test(c.value))))&&/최종.*(?:금액|요금).*확인|(?:금액|요금).*(?:달라|변동)/.test(full)&&/취소.*(?:조건|기한).*확인/.test(full),
    iclubNoUnsupportedAssertions:!/(?:304\s*,?\s*700|30만\s*4\s*,?\s*700|30\.47만)\s*원|(?:레이트\s*)?체크아웃(?:\s*(?:시각|시간|혜택))?(?:은|이|는)?\s*(?:14시|오후\s*2시)|(?:14시|오후\s*2시)(?:까지|에)?\s*(?:무료\s*)?(?:레이트\s*)?체크아웃|즉시\s*확정|최대\s*(?:성인\s*)?[5-8](?:[~–-][5-8])?명|두\s*호텔\s*모두[^\n.]*9월\s*30일|2박\s*(?:이상)?이어야\s*예약\s*가능|(?:직접|제가|저는|우리는).{0,10}(?:투숙|숙박)(?:했|해보)|다녀왔|내돈내산/.test(full),
  };
}

const affiliatesOf=job=>[job?.affiliate,job?.affiliate?.secondary];

export function iclubCreationEntryMatches(a,entry){
  const r=entry?.receipt;
  return ICLUB_COMPARISON.properties.some(p=>p.propertyId===a?.propertyId)&&productUrlMatches(a?.targetUrl,a?.propertyId)&&
    entry?.operation==='myrealtripCreateLink'&&entry.state==='verified'&&r?.source==='independent_http'&&r.status===200&&r.ownerVerified===true&&r.accountFingerprint===a?.accountFingerprint&&r.targetUrl===a?.targetUrl&&r.data?.mylink===a?.url&&String(r.data?.id)===String(a?.mylinkId);
}

// Public GET-only observation, also used by the research builder. This receipt
// does not substitute for the authenticated creation journal at the write gate.
export async function inspectIclubRedirect(a,{fetchImpl=globalThis.fetch,now=new Date()}={}){
  if(!ICLUB_COMPARISON.properties.some(p=>p.propertyId===a?.propertyId)||!productUrlMatches(a?.targetUrl,a?.propertyId)||!myrealtripShortLink(a?.url)||!/^\d+$/.test(String(a?.mylinkId||'')))throw Error('AFFILIATE_SCOPE');
  const res=await fetchImpl(a.url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000)}),location=res.headers.get('location');await res.body?.cancel();
  if(res.status!==301||!location||location.length>8192)throw Error('BRIDGE_SCOPE');
  const bridge=new URL(location);
  if(bridge.origin!=='https://www.myrealtrip.com'||bridge.pathname!=='/main/bridge/marketing'||bridge.username||bridge.password||bridge.port||bridge.hash||!exactSet([...bridge.searchParams.keys()],['return_url']))throw Error('BRIDGE_SCOPE');
  const target=new URL(bridge.searchParams.get('return_url'));
  const tracked={...stayParams(),utm_source:'mktpartner',mylink_id:String(a.mylinkId),t_scope:'604800'};
  if(!scopedUrl(target.href,'https://accommodation.myrealtrip.com',`/union/products/${a.propertyId}`,tracked))throw Error('EXACT_TARGET');
  for(const key of ['utm_source','mylink_id','t_scope'])target.searchParams.delete(key);
  if(target.href!==a.targetUrl)throw Error('JOURNAL_TARGET');
  const page=await fetchImpl(bridge.href,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(15000)});await page.body?.cancel();
  if(page.status!==200||!/^text\/html(?:;|$)/i.test(page.headers.get('content-type')||''))throw Error('BRIDGE_RESPONSE');
  return {source:'independent_http_redirect',checkedAt:now.toISOString(),status:301,bridgeStatus:page.status,url:a.url,targetUrl:a.targetUrl,propertyId:a.propertyId,mylinkId:String(a.mylinkId),accountFingerprint:a.accountFingerprint};
}
export function evaluateIclubAffiliate(job,{now=new Date()}={}){
  const p=job?.commercialSnapshot,offers=offersOf(p),affiliates=affiliatesOf(job);
  const documents=[records(job?.publicationBundle?.document?.blocks),records(job?.bodyBlocks||job?.blocks)];
  const topSequence=bs=>{
    const seq=bs.filter(b=>b.type!=='spacer');
    return seq[0]?.type==='notice'&&[0,1].every(i=>{
      const b=seq[1+i*2],caption=seq[2+i*2];
      return b?.type==='image'&&b.role==='affiliate_banner'&&b.propertyId===expected(i).propertyId&&b.href===affiliates[i]?.url&&hash(b.sha256)&&b.rights?.basis==='generated'&&caption?.type==='paragraph'&&/AI.*(?:생성|제작)/i.test(text(caption.text));
    })&&seq[1]?.sha256!==seq[3]?.sha256;
  };
  return finish({
    iclubAffiliateFormat:job?.publicationBundle?.format==='hotel_promotion'&&p?.provider==='myrealtrip'&&p?.snapshotType==='hotel_promotion'&&p?.productId===ICLUB_COMPARISON.key,
    iclubCreateScope:existingArticleUpdateScope(job)?.existingLogNo==='224418864957'||job?.blogId==='aicandoanything'&&job?.publicationBundle?.document?.blogId===job.blogId&&job?.target?.type==='create'&&!job.target.logNo&&!job.publicationBundle.document.logNo&&job.inputProvider==='headless_sdk',
    iclubTwoExactAffiliates:offers.length===2&&affiliates.every((a,i)=>a?.provider==='myrealtrip'&&a.propertyId===expected(i).propertyId&&myrealtripShortLink(a.url)&&a.url===offers[i].affiliateUrl&&a.targetUrl===offers[i].productUrl)&&affiliates[0]?.url!==affiliates[1]?.url&&affiliates[1]?.secondary==null,
    iclubBothBannersAtTop:documents.every(topSequence),
    iclubNoExtraAffiliatePlacement:documents.every(bs=>bs.filter(b=>b.role==='affiliate_banner').length===2&&bs.filter(b=>b.type==='image'&&b.href).length===2&&bs.filter(b=>myrealtripShortLink(b.href||b.url)).length===2&&!/https:\/\/myrealt\.rip\//.test(docText(bs))),
    iclubTwoRedirectProofs:offers.length===2&&affiliates.every((a,i)=>{const r=a?.verification;return r?.source==='independent_http_redirect'&&r.status===301&&r.bridgeStatus===200&&r.url===a.url&&r.propertyId===offers[i].propertyId&&r.targetUrl===offers[i].productUrl&&r.promotionCode==null&&fresh(r.checkedAt,now);}),
    iclubBothOwnerAttributions:affiliates.every(a=>hash(a?.accountFingerprint)&&a?.verification?.accountFingerprint===a.accountFingerprint&&/^\d+$/.test(String(a?.mylinkId||''))&&String(a?.verification?.mylinkId)===String(a.mylinkId))&&affiliates[0]?.accountFingerprint===affiliates[1]?.accountFingerprint,
    iclubTwoCreationJournals:affiliates.every(a=>hash(a?.creationJournalKey))&&affiliates[0]?.creationJournalKey!==affiliates[1]?.creationJournalKey&&affiliates[0]?.mylinkId!==affiliates[1]?.mylinkId,
  });
}

export async function verifyIclubAffiliate(job,{fetchImpl=globalThis.fetch,now=new Date(),journal,accounts=MYREALTRIP_ACCOUNTS}={}){
  const structural=evaluateIclubAffiliate(job,{now});
  if(!structural.passed)return {...structural,code:'ICLUB_AFFILIATE_REQUIRED'};
  const affiliates=affiliatesOf(job);
  if(affiliates.some(a=>accounts[job.blogId]!==a.accountFingerprint))return {passed:false,code:'AFFILIATE_ACCOUNT_UNVERIFIED'};
  try{
    // Validate BOTH authenticated creation journals before any public request.
    for(const a of affiliates)if(!iclubCreationEntryMatches(a,await journal.read(a.creationJournalKey)))throw Error('CREATION_PROOF');
    const verified=[];
    for(const a of affiliates)verified.push(await inspectIclubRedirect(a,{fetchImpl,now}));
    return {passed:true,code:'ICLUB_TWO_PROPERTY_REDIRECT_CHECK',checkedAt:now.toISOString(),affiliates:verified};
  }catch{return {passed:false,code:'ICLUB_AFFILIATE_UNVERIFIED'};}
}
