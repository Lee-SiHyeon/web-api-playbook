// Read-only normalization of verified research originals. No coupon issuance,
// affiliate creation, booking or publication occurs in this builder.
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './publication-document.mjs';
import {evaluateClaimEvidenceGate} from './claim-evidence-gates.mjs';
import {WriteJournal} from '../api/write-journal.mjs';
import {MYREALTRIP_ACCOUNTS} from './travel-planning-contract.mjs';
import {SEOUL_SHILLA,seoulShillaProductUrl,seoulShillaCreationEntryMatches,inspectSeoulShillaRedirect,evaluateSeoulShillaSnapshot,verifySeoulShillaEvidence} from './seoul-shilla-contract.mjs';

export const SEOUL_SHILLA_CLAIM_IDS=Object.freeze(['coupons','dates','dated_prices','cancellation','booking_conditions']);
const jsonBytes=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const failure=(code,detail)=>{const e=new Error(code);e.code=code;e.detail=detail;return e;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export async function buildSeoulShillaResearchArtifacts({baseDir,research,ledger,links,journal,fetchImpl=globalThis.fetch,now=new Date()}={}){
  const root=await realpath(path.resolve(baseDir));
  const read=async(relative,hash)=>{
    if(typeof relative!=='string'||!relative||path.isAbsolute(relative))throw failure('INVALID_ARTIFACT_PATH');
    const file=path.resolve(root,relative);
    if(!file.startsWith(root+path.sep)||!(await realpath(file)).startsWith(root+path.sep)||(await stat(file)).size>20*1024*1024)throw failure('ARTIFACT_OUTSIDE_BUNDLE');
    const bytes=await readFile(file);if(sha256(bytes)!==hash)throw failure('ARTIFACT_HASH_MISMATCH',relative);return bytes;
  };
  const evidence=id=>{const e=research?.evidence?.[id];if(!e)throw failure('SHILLA_SOURCE_MISSING',id);return e;};
  if(String(research?.identity?.gid)!==SEOUL_SHILLA.propertyId||research.identity.name!=='서울신라호텔'||![null,28146].includes(research.identity.promotionId)||!same(research.quoteQuery,{checkIn:SEOUL_SHILLA.checkIn,checkOut:SEOUL_SHILLA.checkOut,adultCount:2,childCount:0,roomCount:1,nights:1})||research?.quotes?.length!==4||research?.coupons?.length!==4)throw failure('SHILLA_RESEARCH_SCOPE');
  const entries=Object.entries(research.evidence||{});
  if(entries.length<3)throw failure('SHILLA_SOURCE_MANIFEST_REQUIRED');
  for(const [id,e] of entries){
    if(e.httpStatus!==200||e.requestMethod!=='GET'||e.credentials!=='omit'||!/^https:\/\//.test(e.url||'')||!Number.isFinite(Date.parse(e.checkedAt))||Date.parse(e.checkedAt)>now.getTime()||now.getTime()-Date.parse(e.checkedAt)>3600000)throw failure('SHILLA_SOURCE_NOT_FRESH',id);
    await read(e.evidenceFile,e.sha256);
  }
  const oldest=Math.min(...entries.map(([,e])=>Date.parse(e.checkedAt)));
  if(Date.parse(research.expiresAt)>oldest+3600000||!(Date.parse(research.expiresAt)>now.getTime()))throw failure('SHILLA_RESEARCH_EXPIRY');
  const manifest=entries.map(([id,e])=>({id,url:e.url,file:e.evidenceFile,sha256:e.sha256,checkedAt:e.checkedAt,httpStatus:e.httpStatus}));
  const manifestFile='sources/seoul-shilla-publication-receipts.json',manifestBytes=jsonBytes(manifest),manifestSha256=sha256(manifestBytes);
  const created=links?.shilla,useJournal=journal||new WriteJournal(path.join(root,'journal'));
  if(!created||Object.keys(links).length!==1||created.source!=='independent_http'||created.status!==200||created.ownerVerified!==true||created.accountFingerprint!==MYREALTRIP_ACCOUNTS.aicandoanything||created.targetUrl!==seoulShillaProductUrl())throw failure('SHILLA_OWN_LINK_CREATION_REQUIRED');
  const affiliate={provider:'myrealtrip',propertyId:SEOUL_SHILLA.propertyId,url:created.data?.mylink,targetUrl:created.targetUrl,accountFingerprint:created.accountFingerprint,mylinkId:String(created.data?.id||'')};
  affiliate.creationJournalKey=useJournal.key('myrealtripCreateLink',{accountFingerprint:affiliate.accountFingerprint},{targetUrl:affiliate.targetUrl});
  if(!seoulShillaCreationEntryMatches(affiliate,await useJournal.read(affiliate.creationJournalKey)))throw failure('SHILLA_OWN_LINK_JOURNAL_REQUIRED');
  const datedOffers=SEOUL_SHILLA.options.map(spec=>{
    const rows=research.quotes.filter(q=>String(q.couponTemplateId)===spec.couponId);if(rows.length!==1)throw failure('SHILLA_EXACT_OPTION_REQUIRED',spec.couponId);
    const q=rows[0],e=evidence(q.sourceId);
    if(q.cancellation?.type!==(spec.cancellation==='nonrefundable'?'non_refundable':'free_until')||q.confirmation?.status!=='unknown'||q.couponApplication!=='displayed_in_listing'||q.personalCouponIssued!==false||q.bookingCompleted!==false)throw failure('SHILLA_QUOTE_STATE_REQUIRED',spec.couponId);
    return {propertyId:String(q.gid),couponId:String(q.couponTemplateId),roomId:String(q.roomId),rateOptionId:q.rateOptionId,roomName:q.roomName,rateName:q.optionTitle,
      checkIn:q.checkIn,checkOut:q.checkOut,adults:q.adults,children:q.children,rooms:q.rooms,nights:q.nights,checkInTime:'15:00:00',checkOutTime:'11:00:00',
      priceType:'dated_coupon_listing',currency:q.currency,totalTaxIncluded:q.taxIncluded,nightlyTaxIncluded:false,
      normalTotalKrw:q.normalTotalKrw,normalRoomChargeKrw:q.normalRoomChargeKrw,taxAndFeesKrw:q.taxAndFeesKrw,couponDiscountKrw:q.couponDiscountKrw,displayedTotalKrw:q.displayedTotalKrw,displayedNightlyPreTaxKrw:q.displayedNightlyPreTaxKrw,
      couponApplication:q.couponApplication,personalCouponIssued:q.personalCouponIssued,bookingCompleted:q.bookingCompleted,confirmationStatus:q.confirmation.status,
      cancellation:{type:spec.cancellation,originalText:spec.cancellation==='nonrefundable'?'환불 불가':'무료 취소 가능 (한국시간, 26년 9월 27일 18:00까지)',freeUntilKst:q.cancellation.freeUntil},
      benefits:{urbanAllDay:spec.couponId==='36284',breakfastPersons:spec.couponId==='36287'?2:null,loungeIncluded:null},
      checkedAt:e.checkedAt,sourceUrl:e.url,evidenceFile:e.evidenceFile,evidenceSha256:e.sha256};
  });
  const coupons=SEOUL_SHILLA.options.map(spec=>{
    const rows=research.coupons.filter(c=>String(c.couponTemplateId)===spec.couponId);if(rows.length!==1)throw failure('SHILLA_COUPON_REQUIRED',spec.couponId);
    return {...structuredClone(rows[0]),couponId:spec.couponId};
  });
  if(new Set(coupons.map(c=>c.sourceId)).size!==1)throw failure('SHILLA_COUPON_SOURCE_SCOPE');
  const propertyEvidence=structuredClone(evidence(research.identity.sourceId)),couponEvidence=structuredClone(evidence(coupons[0].sourceId));
  const snapshot={schemaVersion:1,provider:'myrealtrip',snapshotType:'hotel_promotion',productId:SEOUL_SHILLA.key,variantId:SEOUL_SHILLA.variantId,campaignKeyType:'local',promotionCode:null,propertyPromotionId:research.identity.promotionId,propertyId:SEOUL_SHILLA.propertyId,hotelTitle:research.identity.name,
    productTitle:'서울신라호텔 9월 쿠폰별 조건과 날짜 지정 객실 예시',productUrl:affiliate.targetUrl,affiliateUrl:affiliate.url,variant:'2026-09-28~29 성인 2명·아동 0명·객실 1개·1박',seller:'마이리얼트립',quantity:1,
    checkedAt:new Date(oldest).toISOString(),quoteType:'dated_coupon_listing_examples',bookingStatus:'not_booked',availability:'listing_observed_not_guaranteed',payablePriceKrw:null,totalQuoteKrw:null,stockState:null,personalCouponIssued:false,confirmationStatus:'unknown',couponStacking:'unverified',couponStayWindow:'not_verified',
    datedOffers,coupons,propertyEvidence,couponEvidence,urbanPackage:structuredClone(research.urbanPackage),evidenceFile:manifestFile,evidenceSha256:manifestSha256,
    conditions:'9월 28~29일 성인 2명·객실 1개·1박 조회. 표시 총액에는 쿠폰 할인이 이미 반영됨. 5만원권 카드 60만원과 상세 55원 표기 충돌을 보존. 각 쿠폰 ID당 1매, 중복 사용·전체 투숙기간·예약 확정 시점은 미확인. 개인 발급·예약·결제 완료 아님.',priceAvailabilityStatement:'dated_quote_not_booking_confirmation',credentialsPersisted:false};
  const sourceGate=await verifySeoulShillaEvidence(snapshot,{read:async(file,hash)=>file===manifestFile&&hash===manifestSha256?manifestBytes:read(file,hash)});
  if(!sourceGate.passed)throw failure('SHILLA_SOURCE_SEMANTICS_FAILED',sourceGate.failedChecks);
  if(!Array.isArray(ledger?.claims)||ledger.claims.length!==SEOUL_SHILLA_CLAIM_IDS.length||!SEOUL_SHILLA_CLAIM_IDS.every(id=>ledger.claims.filter(c=>c.claimId===id&&c.support==='supports'&&c.publishable===true).length===1))throw failure('SHILLA_SUPPORTED_CLAIMS_REQUIRED');
  const normalizedLedger=structuredClone(ledger);
  normalizedLedger.claims=normalizedLedger.claims.map(c=>({...c,productId:SEOUL_SHILLA.key,variantId:SEOUL_SHILLA.variantId}));
  if(!same(normalizedLedger.evidence,research.evidence))throw failure('SHILLA_LEDGER_SOURCE_MISMATCH');
  if(normalizedLedger.claims.some(c=>Date.parse(c.expiresAt)>Date.parse(research.expiresAt)))throw failure('SHILLA_CLAIM_EXPIRY_OVERRUN');
  const claimGate=evaluateClaimEvidenceGate(normalizedLedger,{now});
  if(!claimGate.passed)throw failure('SHILLA_CLAIM_NORMALIZATION_FAILED',claimGate.failedChecks);
  affiliate.verification=await inspectSeoulShillaRedirect(affiliate,{fetchImpl,now});
  snapshot.linkVerification={passed:true,targetMatches:true,checkedAt:affiliate.verification.checkedAt};
  const snapshotGate=evaluateSeoulShillaSnapshot(snapshot,{now});
  if(!snapshotGate.passed)throw failure('SHILLA_SNAPSHOT_INVALID',snapshotGate.failedChecks);
  return {snapshot,claimLedger:normalizedLedger,affiliate,manifest,manifestFile,manifestBytes,verification:{checkedAt:now.toISOString(),passed:true,sourceGate,snapshotGate,claimGate,sourceCount:entries.length,sourceExpiresAt:research.expiresAt,originalResearchUnchanged:true,originalClaimLedgerUnchanged:true,personalCouponIssuanceAttempted:false,bookingAttempted:false}};
}
