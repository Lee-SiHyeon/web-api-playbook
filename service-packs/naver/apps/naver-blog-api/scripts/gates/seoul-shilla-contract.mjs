import {articleBlockText,articleTableCells} from './article-block-text.mjs';
import {existingArticleUpdateScope} from './existing-article-update-scope.mjs';
import {text} from './publication-document.mjs';
import {editorialProvenanceAllowed} from './editorial-provenance.mjs';
import {MYREALTRIP_ACCOUNTS,myrealtripShortLink} from './travel-planning-contract.mjs';

// Local editorial scope, not an official promotion code. Coupon thresholds and
// issuance terms must be bound to their separately observed original response.
export const SEOUL_SHILLA=Object.freeze({
  key:'seoul_shilla_202609',variantId:'seoul_shilla_coupon_quote',propertyId:'2680667',
  checkIn:'2026-09-28',checkOut:'2026-09-29',adults:2,children:0,rooms:1,nights:1,
  options:Object.freeze([
    Object.freeze({couponId:'36284',amountKrw:30000,roomId:'418226312',rateOptionId:'ACM_OPT_MRT:-:STAYNET:-:147:-:47583:-:173946:-:173946',roomName:'[TA SEP URBAN ISLAND]디럭스 더블 TA SEP URBAN ISLAND',rateName:'TA SEP URBAN ISLAND',cancellation:'nonrefundable'}),
    Object.freeze({couponId:'36286',amountKrw:50000,roomId:'225979239',rateOptionId:'ACM_OPT_MRT:-:STAYNET:-:147:-:16928:-:60825:-:60825',roomName:'디럭스 더블 Room Only',rateName:'Room Only',cancellation:'free_until'}),
    Object.freeze({couponId:'36287',amountKrw:70000,roomId:'225979239',rateOptionId:'ACM_OPT_MRT:-:STAYNET:-:147:-:16928:-:159510:-:159510',roomName:'디럭스 더블 조식 2인 패키지',rateName:'조식 2인 패키지',cancellation:'free_until'}),
    Object.freeze({couponId:'36288',amountKrw:120000,roomId:'225939562',rateOptionId:'ACM_OPT_MRT:-:STAYNET:-:147:-:16908:-:60646:-:60646',roomName:'이그제큐티브 비즈니스 디럭스 더블 Room Only',rateName:'Room Only',cancellation:'free_until'}),
  ]),
});
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const positive=v=>Number.isSafeInteger(v)&&v>0;
const records=v=>Array.isArray(v)?v.map(x=>x&&typeof x==='object'?x:{}):[];
const exactSet=(a,b)=>Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&b.every(v=>a.includes(v));
const instant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const fresh=(v,now,minutes=60)=>instant(v)&&Date.parse(v)<=now.getTime()&&now.getTime()-Date.parse(v)<=Math.min(minutes,60)*60000;
const finish=checks=>({passed:Object.values(checks).every(v=>v===true),checks,failedChecks:Object.keys(checks).filter(k=>checks[k]!==true)});
const source=e=>nonempty(e?.evidenceFile)&&hash(e?.sha256)&&/^https:\/\//.test(e?.url||'');
const money=v=>typeof v==='string'&&/^-?[\d,]+원$/.test(v)?Number(v.replace(/[,원]/g,'')):NaN;
const scopedUrl=(value,origin,pathname,params)=>{
  try{const u=new URL(value);return u.origin===origin&&u.pathname===pathname&&!u.username&&!u.password&&!u.port&&!u.hash&&exactSet([...u.searchParams.keys()],Object.keys(params))&&Object.entries(params).every(([k,v])=>u.searchParams.get(k)===String(v));}catch{return false;}
};
const stayParams=()=>({checkIn:SEOUL_SHILLA.checkIn,checkOut:SEOUL_SHILLA.checkOut,adultCount:2,childCount:0});
export const seoulShillaProductUrl=()=>`https://accommodation.myrealtrip.com/union/products/2680667?${new URLSearchParams(stayParams())}`;
const productUrlMatches=v=>scopedUrl(v,'https://accommodation.myrealtrip.com','/union/products/2680667',stayParams());
const quoteUrlMatches=v=>scopedUrl(v,'https://api3.myrealtrip.com','/unionstay/v4/properties/deferred',{gid:'2680667',...stayParams()});
const primaryUrlMatches=v=>scopedUrl(v,'https://api3.myrealtrip.com','/unionstay/v4/properties/primary',{gid:'2680667',...stayParams()});
const couponUrlMatches=v=>scopedUrl(v,'https://api3.myrealtrip.com','/coupon/traveler/templates/publishable-by-gids',{upsIds:'2680667',tripStartDate:SEOUL_SHILLA.checkIn,tripEndDate:SEOUL_SHILLA.checkOut});
const docText=blocks=>records(blocks).filter(b=>['notice','paragraph','heading','quote','list','numbered','table'].includes(b.type)).map(b=>articleBlockText(b)).join('\n');
const externalText=v=>/https?:\/\/|www\.|\b[A-Za-z0-9-]+\.(?:com|net|org|co\.kr|kr)\b/i.test(v);
const offersOf=p=>records(p?.datedOffers);
const terms=Object.freeze({36284:[550000,550000,'verified'],36286:[600000,55,'conflicting_source_text'],36287:[700000,700000,'verified'],36288:[1000000,1000000,'verified']});
const freeUntil='2026-09-27T18:00:00+09:00';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const couponList=p=>records(p?.coupons);
const cancellationText=id=>id==='36284'?'환불 불가':'무료 취소 가능 (한국시간, 26년 9월 27일 18:00까지)';
const couponShape=(c,i)=>{
  const spec=SEOUL_SHILLA.options[i],t=terms[spec.couponId];
  return c.couponId===spec.couponId&&String(c.couponTemplateId)===spec.couponId&&c.name==='9월 서울신라호텔 상시'&&c.discountType==='FLAT'&&c.discountKrw===spec.amountKrw&&c.minimumSpendDisplayKrw===t[0]&&c.minimumSpendDescriptionKrw===t[1]&&c.minimumSpendStatus===t[2]&&
    c.activatedStartDate==='2026-09-18T09:00:00Z'&&c.activatedEndDate==='2026-09-30T14:59:59Z'&&c.expireDate==='2026-09-30T14:59:51Z'&&c.displayedUseDeadline==='2026-09-30T23:59:00+09:00'&&c.deadlinePrecision==='minute'&&
    c.isUsable===true&&c.isPublishable===true&&c.isRepeatable===false&&c.perIdIssueLimit===1&&c.issueLimitScope==='each_coupon_template'&&c.stacking==='unverified'&&c.tripWindow==='not_explicit_in_coupon_response'&&exactSet(c.usableChannel,['android','ios','web'])&&Array.isArray(c.condition)&&nonempty(c.description);
};

export function evaluateSeoulShillaSnapshot(p,{now=new Date(),maxAgeMinutes=60}={}){
  const offers=offersOf(p),coupons=couponList(p),u=p?.urbanPackage;
  return finish({
    shillaSnapshotType:p?.schemaVersion===1&&p?.provider==='myrealtrip'&&p?.snapshotType==='hotel_promotion',
    shillaLocalScope:p?.productId===SEOUL_SHILLA.key&&p?.variantId===SEOUL_SHILLA.variantId&&p?.campaignKeyType==='local'&&p?.promotionCode==null&&p?.propertyId===SEOUL_SHILLA.propertyId&&p?.hotelTitle==='서울신라호텔'&&(p?.propertyPromotionId==null||p.propertyPromotionId===28146)&&p?.sales==null&&p?.stay==null,
    shillaIdentity:nonempty(p?.productTitle)&&nonempty(p?.variant)&&p?.seller==='마이리얼트립'&&p?.quantity===1&&nonempty(p?.conditions)&&productUrlMatches(p?.productUrl),
    shillaFresh:fresh(p?.checkedAt,now,maxAgeMinutes)&&offers.length===4&&offers.every(q=>fresh(q.checkedAt,now,maxAgeMinutes))&&fresh(p?.propertyEvidence?.checkedAt,now,maxAgeMinutes)&&fresh(p?.couponEvidence?.checkedAt,now,maxAgeMinutes),
    shillaListingNotBooking:p?.quoteType==='dated_coupon_listing_examples'&&p?.bookingStatus==='not_booked'&&p?.availability==='listing_observed_not_guaranteed'&&p?.payablePriceKrw==null&&p?.totalQuoteKrw==null&&p?.stockState==null&&p?.priceAvailabilityStatement==='dated_quote_not_booking_confirmation'&&p?.personalCouponIssued===false&&p?.confirmationStatus==='unknown'&&p?.couponStacking==='unverified'&&p?.couponStayWindow==='not_verified',
    shillaFourExactOptions:offers.length===4&&offers.every((q,i)=>{const s=SEOUL_SHILLA.options[i];return q.propertyId===SEOUL_SHILLA.propertyId&&q.couponId===s.couponId&&q.roomId===s.roomId&&q.rateOptionId===s.rateOptionId&&q.roomName===s.roomName&&q.rateName===s.rateName;}),
    shillaExactStay:offers.length===4&&offers.every(q=>q.checkIn===SEOUL_SHILLA.checkIn&&q.checkOut===SEOUL_SHILLA.checkOut&&q.adults===2&&q.children===0&&q.rooms===1&&q.nights===1&&q.checkInTime==='15:00:00'&&q.checkOutTime==='11:00:00'),
    shillaCouponAlreadyDeducted:offers.length===4&&offers.every((q,i)=>q.priceType==='dated_coupon_listing'&&q.currency==='KRW'&&q.totalTaxIncluded===true&&q.nightlyTaxIncluded===false&&q.couponApplication==='displayed_in_listing'&&q.personalCouponIssued===false&&q.bookingCompleted===false&&q.confirmationStatus==='unknown'&&positive(q.normalTotalKrw)&&positive(q.normalRoomChargeKrw)&&positive(q.taxAndFeesKrw)&&q.normalRoomChargeKrw+q.taxAndFeesKrw===q.normalTotalKrw&&q.couponDiscountKrw===SEOUL_SHILLA.options[i].amountKrw&&positive(q.displayedTotalKrw)&&q.normalTotalKrw-q.couponDiscountKrw===q.displayedTotalKrw&&positive(q.displayedNightlyPreTaxKrw)&&q.displayedNightlyPreTaxKrw+q.taxAndFeesKrw===q.displayedTotalKrw),
    shillaCancellationSeparated:offers.length===4&&offers.every((q,i)=>q.cancellation?.type===SEOUL_SHILLA.options[i].cancellation&&q.cancellation.originalText===cancellationText(q.couponId)&&(i===0?q.cancellation.freeUntilKst===null:q.cancellation.freeUntilKst===freeUntil&&Date.parse(freeUntil)>now.getTime())),
    shillaBenefitsScoped:offers.length===4&&offers.every((q,i)=>q.benefits?.urbanAllDay===(i===0)&&q.benefits?.breakfastPersons===(i===2?2:null)&&q.benefits?.loungeIncluded===null),
    shillaFourCouponTerms:coupons.length===4&&coupons.every(couponShape)&&coupons.every(c=>Date.parse(c.activatedStartDate)<=now.getTime()&&Date.parse(c.expireDate)>now.getTime()),
    shillaSourcesScoped:source(p?.propertyEvidence)&&primaryUrlMatches(p.propertyEvidence.url)&&source(p?.couponEvidence)&&couponUrlMatches(p.couponEvidence.url)&&offers.length===4&&offers.every(q=>nonempty(q.evidenceFile)&&hash(q.evidenceSha256)&&quoteUrlMatches(q.sourceUrl)),
    shillaUrbanPackageSeparate:u?.quoteCouponTemplateId===36284&&u?.salesStart==='2026-09-18'&&u.salesEnd==='2026-09-29'&&u.stayStart==='2026-09-21'&&u.stayEnd==='2026-09-30'&&exactSet(u.excludedStayDates,['2026-09-24','2026-09-25','2026-09-26'])&&u.scope==='Only selected TA SEP URBAN ISLAND package; not every hotel room or coupon'&&u.refundability==='non_refundable'&&u.dateChangesAllowed===false&&u.benefit==='어번 아일랜드 All Day 입장 혜택'&&u.operatingHours==='09:30–21:00'&&u.useTimeBoundary==='체크인~체크아웃 사이 운영시간',
    shillaManifest:nonempty(p?.evidenceFile)&&hash(p?.evidenceSha256),
    shillaOwnedLink:myrealtripShortLink(p?.affiliateUrl)&&p?.linkVerification?.passed===true&&p.linkVerification.targetMatches===true&&fresh(p.linkVerification.checkedAt,now,maxAgeMinutes),
    shillaCredentialsNotPersisted:p?.credentialsPersisted===false,
  });
}

export function seoulShillaCreationEntryMatches(a,entry){
  const r=entry?.receipt;
  return a?.propertyId===SEOUL_SHILLA.propertyId&&productUrlMatches(a?.targetUrl)&&entry?.operation==='myrealtripCreateLink'&&entry.state==='verified'&&r?.source==='independent_http'&&r.status===200&&r.ownerVerified===true&&r.accountFingerprint===a?.accountFingerprint&&r.targetUrl===a?.targetUrl&&r.data?.mylink===a?.url&&String(r.data?.id)===String(a?.mylinkId);
}

export async function inspectSeoulShillaRedirect(a,{fetchImpl=globalThis.fetch,now=new Date()}={}){
  if(a?.propertyId!==SEOUL_SHILLA.propertyId||!productUrlMatches(a?.targetUrl)||!myrealtripShortLink(a?.url)||!/^\d+$/.test(String(a?.mylinkId||'')))throw Error('AFFILIATE_SCOPE');
  const res=await fetchImpl(a.url,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(10000)}),location=res.headers.get('location');await res.body?.cancel();
  if(res.status!==301||!location||location.length>8192)throw Error('BRIDGE_SCOPE');
  const bridge=new URL(location);
  if(bridge.origin!=='https://www.myrealtrip.com'||bridge.pathname!=='/main/bridge/marketing'||bridge.username||bridge.password||bridge.port||bridge.hash||!exactSet([...bridge.searchParams.keys()],['return_url']))throw Error('BRIDGE_SCOPE');
  const target=new URL(bridge.searchParams.get('return_url'));
  if(!scopedUrl(target.href,'https://accommodation.myrealtrip.com','/union/products/2680667',{...stayParams(),utm_source:'mktpartner',mylink_id:String(a.mylinkId),t_scope:'604800'}))throw Error('EXACT_TARGET');
  for(const key of ['utm_source','mylink_id','t_scope'])target.searchParams.delete(key);
  if(target.href!==a.targetUrl)throw Error('JOURNAL_TARGET');
  const page=await fetchImpl(bridge.href,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(15000)});await page.body?.cancel();
  if(page.status!==200||!/^text\/html(?:;|$)/i.test(page.headers.get('content-type')||''))throw Error('BRIDGE_RESPONSE');
  return {source:'independent_http_redirect',checkedAt:now.toISOString(),status:301,bridgeStatus:page.status,url:a.url,targetUrl:a.targetUrl,propertyId:a.propertyId,mylinkId:String(a.mylinkId),accountFingerprint:a.accountFingerprint};
}

export function evaluateSeoulShillaAffiliate(job,{now=new Date()}={}){
  const p=job?.commercialSnapshot,a=job?.affiliate,r=a?.verification,documents=[records(job?.publicationBundle?.document?.blocks),records(job?.bodyBlocks||job?.blocks)];
  return finish({
    shillaAffiliateFormat:job?.publicationBundle?.format==='hotel_promotion'&&p?.provider==='myrealtrip'&&p?.snapshotType==='hotel_promotion'&&p?.productId===SEOUL_SHILLA.key&&a?.provider==='myrealtrip',
    shillaCreateScope:existingArticleUpdateScope(job)?.existingLogNo==='224418980453'||job?.blogId==='aicandoanything'&&job?.publicationBundle?.document?.blogId===job.blogId&&job?.target?.type==='create'&&!job.target.logNo&&!job.publicationBundle.document.logNo&&job.inputProvider==='headless_sdk',
    shillaExactOwnAffiliate:a?.propertyId===SEOUL_SHILLA.propertyId&&productUrlMatches(a?.targetUrl)&&a.targetUrl===p?.productUrl&&myrealtripShortLink(a?.url)&&a.url===p?.affiliateUrl&&a.secondary==null,
    shillaTopBannerCaption:documents.every(bs=>{const s=bs.filter(b=>b.type!=='spacer');return s[0]?.type==='notice'&&s[1]?.type==='image'&&s[1].role==='affiliate_banner'&&s[1].propertyId===SEOUL_SHILLA.propertyId&&s[1].href===a?.url&&s[1].rights?.basis==='generated'&&hash(s[1].sha256)&&s[2]?.type==='paragraph'&&/AI.*(?:생성|제작)/i.test(text(s[2].text));}),
    shillaOnlyOneLinkedBanner:documents.every(bs=>bs.filter(b=>b.role==='affiliate_banner').length===1&&bs.filter(b=>b.href||b.url).length===1&&bs.every(b=>!['link','oglink'].includes(b.type))&&!externalText(docText(bs))),
    shillaRedirectProof:r?.source==='independent_http_redirect'&&r.status===301&&r.bridgeStatus===200&&r.url===a?.url&&r.propertyId===SEOUL_SHILLA.propertyId&&r.targetUrl===p?.productUrl&&r.promotionCode==null&&fresh(r.checkedAt,now),
    shillaOwnerAttribution:hash(a?.accountFingerprint)&&r?.accountFingerprint===a.accountFingerprint&&/^\d+$/.test(String(a?.mylinkId||''))&&String(r?.mylinkId)===String(a.mylinkId),
    shillaCreationJournal:hash(a?.creationJournalKey),
  });
}

export async function verifySeoulShillaAffiliate(job,{fetchImpl=globalThis.fetch,now=new Date(),journal,accounts=MYREALTRIP_ACCOUNTS}={}){
  const structural=evaluateSeoulShillaAffiliate(job,{now});
  if(!structural.passed)return {...structural,code:'SEOUL_SHILLA_AFFILIATE_REQUIRED'};
  const a=job.affiliate;if(accounts[job.blogId]!==a.accountFingerprint)return {passed:false,code:'AFFILIATE_ACCOUNT_UNVERIFIED'};
  try{if(!seoulShillaCreationEntryMatches(a,await journal.read(a.creationJournalKey)))throw Error('CREATION_PROOF');return {passed:true,code:'SEOUL_SHILLA_REDIRECT_CHECK',...await inspectSeoulShillaRedirect(a,{fetchImpl,now})};}
  catch{return {passed:false,code:'SEOUL_SHILLA_AFFILIATE_UNVERIFIED'};}
}

function optionMatches(q,raw){
  const sections=records(raw?.data?.sections).filter(s=>s.header?.startDate===SEOUL_SHILLA.checkIn&&s.header?.endDate===SEOUL_SHILLA.checkOut&&s.header?.persons?.adultCount===2&&s.header?.persons?.childCount===0);
  const matches=sections.flatMap(s=>records(s.gridCards).flatMap(c=>records([...(c.bestOptions||[]),...(c.options||[])]).map(o=>({card:c,option:o})))).filter(({card,option:o})=>String(card.header?.roomId)===q.roomId&&String(o.roomId)===q.roomId&&String(o.gid)===SEOUL_SHILLA.propertyId&&o.rateOptionId===q.rateOptionId&&o.title===q.rateName&&o.priceDetail?.roomName===q.roomName&&String(o.couponTemplateId)===q.couponId);
  return raw?.result?.status===200&&matches.length>0&&matches.every(({card,option:o})=>{
    const prices=records(o.priceDetail?.prices),normal=prices.filter(x=>x.type==='NORMAL'),discount=prices.filter(x=>x.type==='DISCOUNT'),total=prices.filter(x=>x.type==='TOTAL');
    const couponRows=records(discount[0]?.subPrices).filter(x=>x.title==='쿠폰 할인');
    const cancellation=records(o.attributions).map(x=>x.title).filter(x=>typeof x==='string'&&/무료 취소 가능|^환불 불가$/.test(x));
    const baseRows=records(normal[0]?.subPrices),room=baseRows.filter(x=>x.title==='객실 이용료'),tax=baseRows.filter(x=>x.title==='세금 및 수수료');
    const attrs=records(o.optionAllAttributes?.contents).flatMap(x=>records(x.items));
    const urban=attrs.find(x=>x.titleWithIcon?.text==='어번 아일랜드 All Day 입장 혜택');
    const packageText=attrs.filter(x=>x.titleWithIcon?.text?.trim()==='패키지 안내').flatMap(x=>x.items||[]).join('\n');
    const urbanBound=q.couponId!=='36284'||urban?.items?.includes('ㅁ 어번 아일랜드 운영 시간 : 09:30~21:00\nㅁ 어번 아일랜드 이용 가능 시간 : 체크인 ~ 체크아웃 내 어번 아일랜드 운영 시간')&&['판매 기간 : 2026년 9월 18일 ~ 2026년 9월 29일','투숙 기간 : 2026년 9월 21일 ~ 2026년 9월 30일','투숙 제외 기간 : 2026/9/24~26 제외','날짜 변경이 불가','환불 불가 상품'].every(s=>packageText.includes(s));
    const breakfastBound=q.couponId!=='36287'||attrs.some(x=>x.titleWithIcon?.text?.trim()==='더 파크뷰 조식 2인 포함')&&attrs.some(x=>x.titleWithIcon?.text==='식사 제공 여부'&&x.items?.includes('무료 조식 2인'));
    return urbanBound&&breakfastBound&&records(card.header?.representAttributesWithIcon).some(x=>x.title==='성인 2명')&&o.startDateTime==='2026-09-28T15:00:00'&&o.endDateTime==='2026-09-29T11:00:00'&&o.checkInStartTime==='15:00:00'&&o.checkOutEndTime==='11:00:00'&&normal.length===1&&normal[0].title==='객실 1개 x 1박'&&baseRows.length===2&&room.length===1&&tax.length===1&&money(room[0].priceText)===q.normalRoomChargeKrw&&money(tax[0].priceText)===q.taxAndFeesKrw&&discount.length===1&&total.length===1&&couponRows.length===1&&records(discount[0].subPrices).length===1&&money(normal[0].krwPrice)===q.normalTotalKrw&&o.salePrice===q.normalTotalKrw&&money(discount[0].krwPrice)===-q.couponDiscountKrw&&money(couponRows[0].priceText)===-q.couponDiscountKrw&&money(total[0].krwPrice)===q.displayedTotalKrw&&q.normalTotalKrw-q.couponDiscountKrw===q.displayedTotalKrw&&money(o.price?.discountedPriceText)===q.displayedNightlyPreTaxKrw&&o.price?.taxIncludedText===`세금 포함 ${q.displayedTotalKrw.toLocaleString('en-US')}원`&&o.priceDetail.footerPriceText===`${q.displayedTotalKrw.toLocaleString('en-US')}원 / 1박`&&cancellation.length===1&&cancellation[0]===q.cancellation.originalText;
  });
}

function couponMatches(c,raw){
  const matches=records(raw?.data).filter(x=>String(x.id)===c.couponId);
  if(raw?.result?.status!==200||matches.length!==1)return false;
  const o=matches[0],conditionMinimum=/^([\d,]+)원 이상 구매 시$/.exec(o.condition?.[0]||''),descriptionMinimum=/최소 주문금액 ([\d,]+)원 이상/.exec(o.description||'');
  const originalFields=['name','discountType','condition','description','activatedStartDate','activatedEndDate','expireDate','isUsable','isPublishable','isRepeatable','usableChannel','warningMessages'];
  return o.couponType==='DIRECT_COUPON'&&o.promotionCode===null&&o.discountRate===null&&o.couponUseStatus===null&&o.flatAmount===c.discountKrw&&originalFields.every(k=>same(o[k],c[k]))&&Number(conditionMinimum?.[1].replaceAll(',',''))===c.minimumSpendDisplayKrw&&Number(descriptionMinimum?.[1].replaceAll(',',''))===c.minimumSpendDescriptionKrw&&
    o.condition?.includes('2026년 9월 30일 23시 59분까지 사용 가능')&&o.warningMessages?.includes('서둘러 사용하세요! 선착순으로 사용 가능한 쿠폰이에요.')&&['지정된 상품에만 적용','한 ID당 1매만 발급됩니다. (중복 발급 불가)','쿠폰 발급/사용 기간 종료 후 구매 취소 시 재발급이 불가','예산 소진 시 조기 종료'].every(s=>o.description.includes(s));
}

export async function verifySeoulShillaEvidence(p,{read}={}){
  const checks={},offers=offersOf(p),coupons=couponList(p);let receipts=[];
  try{receipts=JSON.parse((await read(p.evidenceFile,p.evidenceSha256)).toString('utf8'));checks.shillaSourceManifest=Array.isArray(receipts)&&receipts.length>=3;}catch{checks.shillaSourceManifest=false;}
  const recorded=e=>Array.isArray(receipts)&&receipts.some(r=>r.url===e?.url&&r.file===e?.evidenceFile&&r.sha256===e?.sha256&&r.checkedAt===e?.checkedAt&&r.httpStatus===200);
  checks.shillaFetchReceiptsMatch=recorded(p?.propertyEvidence)&&recorded(p?.couponEvidence)&&offers.every(q=>recorded({url:q.sourceUrl,evidenceFile:q.evidenceFile,sha256:q.evidenceSha256,checkedAt:q.checkedAt}));
  try{
    const raw=JSON.parse((await read(p.propertyEvidence.evidenceFile,p.propertyEvidence.sha256)).toString('utf8')),s=raw?.data?.staticArea,v=s?.staySearchParam;
    checks.shillaPropertySourceMatches=raw.result?.status===200&&String(s?.metaInfo?.gid)===SEOUL_SHILLA.propertyId&&s?.header?.stayTitle==='서울신라호텔'&&(s?.promotionId===null&&p.propertyPromotionId==null||s?.promotionId===28146&&p.propertyPromotionId===28146)&&s?.header?.shareWebLink===p.productUrl&&String(v?.gid)===SEOUL_SHILLA.propertyId&&v?.checkIn===SEOUL_SHILLA.checkIn&&v?.checkOut===SEOUL_SHILLA.checkOut&&v?.adultCount===2&&v?.childCount===0;
  }catch{checks.shillaPropertySourceMatches=false;}
  try{
    const raw=JSON.parse((await read(p.couponEvidence.evidenceFile,p.couponEvidence.sha256)).toString('utf8'));
    checks.shillaCouponOriginalsMatch=coupons.length===4&&coupons.every(couponShape)&&records(raw.data).length===4&&coupons.every(c=>couponMatches(c,raw));
  }catch{checks.shillaCouponOriginalsMatch=false;}
  for(const [i,q] of offers.entries()){
    try{checks[`shilla${i}DatedOptionSourceMatches`]=optionMatches(q,JSON.parse((await read(q.evidenceFile,q.evidenceSha256)).toString('utf8')));}
    catch{checks[`shilla${i}DatedOptionSourceMatches`]=false;}
  }
  checks.shillaFourSourceOffers=offers.length===4;
  return finish(checks);
}

export function seoulShillaLayoutChecks(bundle){
  const blocks=records(bundle?.document?.blocks),visible=blocks.filter(b=>b.type!=='spacer'),images=blocks.filter(b=>b.type==='image'),p=bundle?.products?.[0],full=[bundle?.document?.title,docText(blocks)].join('\n');
  const shown=n=>positive(n)&&(full.includes(n.toLocaleString('en-US'))||full.includes(String(n))),roles=['affiliate_banner','coupon_comparison','booking_dates','booking_conditions'];
  const tableCells=articleTableCells(blocks), tableRowsText=[...new Set(tableCells.map(c=>c.rowText))];
  const observedAlreadyDiscounted=blocks.some(b=>/조회한.*세금\s*포함.*총액/.test(articleBlockText(b))&&/쿠폰\s*반영가.*(?:이미.*할인|할인.*이미)/.test(articleBlockText(b))&&/예시/.test(articleBlockText(b)));
  return {
    shillaSingleLocalCampaign:bundle?.products?.length===1&&p?.productId===SEOUL_SHILLA.key,
    shillaFourUsefulImages:images.length>=4&&roles.every(role=>images.filter(b=>b.role===role).length===1)&&images.every(b=>hash(b.sha256)&&b.rights?.basis==='generated')&&new Set(images.map(b=>b.sha256)).size===images.length,
    shillaAllImagesCaptioned:visible.every((b,i)=>b.type!=='image'||visible[i+1]?.type==='paragraph'&&/AI.*(?:제작|생성)/i.test(text(visible[i+1].text))),
    shillaEditorialProvenanceRequired:editorialProvenanceAllowed(bundle),
    shillaQuoteDatesVisible:/2026/.test(full)&&/9월\s*28일|2026-09-28|9\/28/.test(full)&&/9월\s*29일|2026-09-29|9\/29/.test(full)&&/성인\s*2명/.test(full)&&/어린이\s*0명|아동\s*0명/.test(full)&&/객실\s*1개|1객실/.test(full)&&/1박/.test(full),
    shillaPricesAndBasisVisible:/세금\s*포함/.test(full)&&/총액/.test(full)&&offersOf(p).length===4&&offersOf(p).every(q=>shown(q.normalTotalKrw)&&shown(q.displayedTotalKrw))&&(observedAlreadyDiscounted||/이미.*쿠폰.*(?:반영|차감)/.test(full)&&/(?:한\s*번\s*더|추가로).*(?:빼면\s*안|차감.*않|공제.*않)/.test(full)&&/예약.*(?:아니|아닙|아닌|않)/.test(full)),
    shillaCouponConflictVisible:(tableRowsText.some(row=>/^5만원\s/.test(row)&&/카드:\s*60만원/.test(row)&&/상세:\s*[“"]?55원\s*이상/.test(row)&&/표기\s*불일치/.test(row)&&/결제\s*화면\s*확인/.test(row))||/5만원\s*쿠폰[^\n]*카드[^\n]*60만원/.test(full)&&/상세\s*설명[^\n]*55원/.test(full)&&/(?:표기|문구).*(?:일치하지|다르|다릅|차이)/.test(full)&&/결제\s*화면.*확인/.test(full)),
    shillaCouponLimitsVisible:/(?:각|동일)\s*쿠폰[^\n]*ID당\s*1매/.test(full)&&/중복\s*발급(?:은)?\s*불가/.test(full)&&/(?:서로\s*다른|중복)[^\n]*(?:함께|사용)[^\n]*(?:확인되지|미확인|확인.*못)/.test(full)&&/지정\s*상품/.test(full)&&/선착순/.test(full)&&/예산.*(?:소진|조기)/.test(full),
    shillaUseDeadlineVisible:(tableRowsText.some(row=>/^쿠폰\s*사용기한\s+2026년\s*9월\s*30일\s*23:59$/.test(row))||/9월\s*30일\s*23시\s*59분|2026-09-30.*23:59/.test(full))&&/쿠폰\s*사용기한/.test(full)&&(/투숙\s*가능\s*기간.*(?:해석하지|다른|구분|확인)/.test(full)||tableRowsText.some(row=>/^숙박일\s*적용\s/.test(row)&&/쿠폰\s*기한과\s*별개/.test(row)&&/투숙일.*적용.*확인/.test(row))),
    shillaCancellationVisible:/3만원[^\n]*환불\s*불가/.test(full)&&/5만원[^\n]*7만원[^\n]*12만원[^\n]*한국시간[^\n]*9월\s*27일\s*18시[^\n]*무료\s*취소/.test(full),
    shillaNoOrdinaryExternalLinks:blocks.every(b=>!['link','oglink'].includes(b.type)&&(!b.href&&!b.url||b.type==='image'&&b.role==='affiliate_banner'&&b.href===p?.affiliateUrl))&&!externalText(full),
    shillaNoUnsupportedAssertions:!/(?:어느|모든)\s*객실(?:이든|에도|에서든)[^\n.]*12만원|55만원\s*이상\s*(?:구매\s*시|구매하면)[^\n.]*5만원\s*(?:할인|쿠폰)|5만원\s*쿠폰은\s*55만원\s*이상\s*(?:구매\s*시|부터\s*사용)|쿠폰\s*(?:4개|네\s*개)[^\n.]*중복\s*(?:사용|할인)\s*가능|즉시\s*(?:예약\s*)?확정|(?:직접|제가|저는|우리는).{0,10}(?:투숙|숙박)(?:했|해보)|다녀왔|내돈내산/.test(full),
  };
}
