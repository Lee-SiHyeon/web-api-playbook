// Read-only source/affiliate normalization. It returns derived artifacts; it
// never changes research originals, creates affiliate links or publishes posts.
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './publication-document.mjs';
import {evaluateClaimEvidenceGate} from './claim-evidence-gates.mjs';
import {WriteJournal} from '../api/write-journal.mjs';
import {MYREALTRIP_ACCOUNTS} from './travel-planning-contract.mjs';
import {ICLUB_COMPARISON,iclubProductUrl,iclubCreationEntryMatches,inspectIclubRedirect,evaluateIclubSnapshot,verifyIclubEvidence} from './iclub-hotel-contract.mjs';

export const ICLUB_CLAIM_IDS=Object.freeze(['dated_prices','late_checkout','benefits','dates','room_layout','location','cancellation','confirmation']);
const jsonBytes=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const failure=(code,detail)=>{const error=new Error(code);error.code=code;error.detail=detail;return error;};
const money=v=>typeof v==='string'&&/^[\d,]+원$/.test(v)?Number(v.replace(/[,원]/g,'')):NaN;
const evidenceFor=(research,id)=>{const e=research.evidence?.[id];if(!e)throw failure('ICLUB_SOURCE_MISSING',id);return e;};

export async function buildIclubResearchArtifacts({baseDir,research,ledger,links,journal,fetchImpl=globalThis.fetch,now=new Date()}={}){
  const root=await realpath(path.resolve(baseDir));
  const read=async(relative,hash)=>{
    if(typeof relative!=='string'||!relative||path.isAbsolute(relative))throw failure('INVALID_ARTIFACT_PATH');
    const file=path.resolve(root,relative);
    if(!file.startsWith(root+path.sep)||!(await realpath(file)).startsWith(root+path.sep)||(await stat(file)).size>20*1024*1024)throw failure('ARTIFACT_OUTSIDE_BUNDLE');
    const bytes=await readFile(file);if(sha256(bytes)!==hash)throw failure('ARTIFACT_HASH_MISMATCH',relative);return bytes;
  };
  if(research?.exactCampaignCode!==null||research?.exactCampaignLandingUrl!==null||!Array.isArray(research?.quotes)||research.quotes.length!==2)throw failure('ICLUB_RESEARCH_SCOPE');
  const sourceEntries=Object.entries(research.evidence||{});
  if(sourceEntries.length<4)throw failure('ICLUB_RESEARCH_SOURCES_REQUIRED');
  for(const [id,e] of sourceEntries){
    if(e.httpStatus!==200||!/^https:\/\//.test(e.url||'')||!Number.isFinite(Date.parse(e.checkedAt))||Date.parse(e.checkedAt)>now.getTime()||now.getTime()-Date.parse(e.checkedAt)>3600000)throw failure('ICLUB_SOURCE_NOT_FRESH',id);
    await read(e.evidenceFile,e.sha256);
  }
  const manifest=sourceEntries.map(([id,e])=>({id,url:e.url,file:e.evidenceFile,sha256:e.sha256,checkedAt:e.checkedAt,httpStatus:e.httpStatus}));
  const manifestFile='sources/iclub-publication-receipts.json',manifestBytes=jsonBytes(manifest),manifestSha256=sha256(manifestBytes);
  const affiliates=[];
  const useJournal=journal||new WriteJournal(path.join(root,'journal'));
  for(const [i,property] of ICLUB_COMPARISON.properties.entries()){
    const created=links?.[i===0?'amtd':'sheungwan'];
    if(!created||created.source!=='independent_http'||created.status!==200||created.ownerVerified!==true||created.accountFingerprint!==MYREALTRIP_ACCOUNTS.aicandoanything||created.targetUrl!==iclubProductUrl(property.propertyId))throw failure('ICLUB_OWN_LINK_CREATION_REQUIRED',property.propertyId);
    const a={provider:'myrealtrip',propertyId:property.propertyId,url:created.data?.mylink,targetUrl:created.targetUrl,accountFingerprint:created.accountFingerprint,mylinkId:String(created.data?.id||'')};
    a.creationJournalKey=useJournal.key('myrealtripCreateLink',{accountFingerprint:a.accountFingerprint},{targetUrl:a.targetUrl});
    if(!iclubCreationEntryMatches(a,await useJournal.read(a.creationJournalKey)))throw failure('ICLUB_OWN_LINK_JOURNAL_REQUIRED',property.propertyId);
    affiliates.push(a);
  }
  if(affiliates[0].url===affiliates[1].url||affiliates[0].mylinkId===affiliates[1].mylinkId)throw failure('ICLUB_DISTINCT_LINKS_REQUIRED');
  const offers=ICLUB_COMPARISON.properties.map((property,i)=>{
    const q=research.quotes.find(q=>String(q.gid)===property.propertyId),identity=research.identities?.find(x=>String(x.gid)===property.propertyId);
    if(!q||!identity)throw failure('ICLUB_PROPERTY_RESEARCH_MISSING',property.propertyId);
    const raw=evidenceFor(research,q.sourceId),primary=evidenceFor(research,identity.sourceId);
    const items=(q.optionAllAttributes?.contents||[]).flatMap(x=>x.items||[]),cancel=items.find(x=>x.titleWithIcon?.text==='무료 취소')?.items?.[0];
    const deadline=/^무료 취소 가능 \(한국시간, (\d{2})년 (\d{1,2})월 (\d{1,2})일 (\d{2}):(\d{2})까지\)$/.exec(cancel||'');
    if(!deadline)throw failure('ICLUB_CANCELLATION_SOURCE_UNSUPPORTED',property.propertyId);
    return {
      propertyId:property.propertyId,hotelTitle:identity.name,productUrl:affiliates[i].targetUrl,
      roomId:String(q.roomId),rateOptionId:q.rateOptionId,roomName:q.roomName,rateName:q.optionTitle,
      checkIn:q.listingDateEcho?.startDate,checkOut:q.listingDateEcho?.endDate,adults:q.adultCount,children:q.childCount,rooms:q.roomCount,nights:q.nights,minimumBookableNights:1,
      priceType:'dated_listing',currency:q.currency,nightlyTaxIncluded:false,totalTaxIncluded:true,displayedNightlyPreTaxKrw:money(q.roomPriceDisplay),displayedTotalKrw:q.totalKrw,
      checkedAt:raw.checkedAt,sourceUrl:raw.url,evidenceFile:raw.evidenceFile,evidenceSha256:raw.sha256,
      propertyEvidence:{url:primary.url,evidenceFile:primary.evidenceFile,sha256:primary.sha256,checkedAt:primary.checkedAt},
      benefits:{breakfastIncluded:false,morningRefreshments:'07:30–10:30',coffeeTea24Hours:true,lateCheckout:{minimumNights:2,requestRequired:true,subjectToAvailability:true,time:property.lateCheckoutTime}},
      confirmationText:q.confirmation,maximumOccupancyVerified:q.maximumOccupancyVerified,
      cancellation:{type:'free_until',originalText:cancel,freeUntilKst:`20${deadline[1]}-${deadline[2].padStart(2,'0')}-${deadline[3].padStart(2,'0')}T${deadline[4]}:${deadline[5]}:00+09:00`},
      promotion:{id:String(identity.promotionId),startsAtLocal:identity.promotionTimer?.startDateTime,endsAtLocal:identity.promotionTimer?.endDateTime,appliesToSelectedRate:q.isPromotion},
      affiliateUrl:affiliates[i].url,
    };
  });
  const snapshot={schemaVersion:1,provider:'myrealtrip',snapshotType:'hotel_promotion',productId:ICLUB_COMPARISON.key,variantId:ICLUB_COMPARISON.variantId,campaignKeyType:'local',promotionCode:null,
    productTitle:'홍콩 아이클럽 2개 호텔 동일 날짜·인원 객실 비교',productUrl:offers[0].productUrl,affiliateUrl:offers[0].affiliateUrl,variant:'2026-11-03~05 성인 5명·아동 0명·객실 1개·2박',seller:'마이리얼트립',quantity:2,
    checkedAt:new Date(Math.min(...sourceEntries.map(([,e])=>Date.parse(e.checkedAt)))).toISOString(),quoteType:'dated_listing_comparison',bookingStatus:'not_booked',availability:'listing_observed_not_guaranteed',payablePriceKrw:null,totalQuoteKrw:null,stockState:null,
    propertyOffers:offers,evidenceFile:manifestFile,evidenceSha256:manifestSha256,conditions:'세전 1박 표시와 세금 포함 2박 총액을 구분한 조회 결과. 예약·결제·재고 확정 아님. AMTD 선택 옵션만 9월 30일 행사 종료, 셩완 선택 옵션은 행사 미적용. 레이트 체크아웃은 2박 이상 예약 요청 및 객실 상황 가능 시 제공.',priceAvailabilityStatement:'dated_quote_not_booking_confirmation',credentialsPersisted:false};
  const sourceGate=await verifyIclubEvidence(snapshot,{read:async(file,hash)=>file===manifestFile&&hash===manifestSha256?manifestBytes:read(file,hash)});
  if(!sourceGate.passed)throw failure('ICLUB_SOURCE_SEMANTICS_FAILED',sourceGate.failedChecks);
  if(!Array.isArray(ledger?.claims)||ledger.claims.length!==ICLUB_CLAIM_IDS.length||!ICLUB_CLAIM_IDS.every(id=>ledger.claims.filter(c=>c.claimId===id&&c.support==='supports'&&c.publishable===true).length===1))throw failure('ICLUB_SUPPORTED_CLAIMS_REQUIRED');
  const normalizedLedger=structuredClone(ledger);
  normalizedLedger.claims=normalizedLedger.claims.map(c=>({...c,productId:ICLUB_COMPARISON.key,variantId:ICLUB_COMPARISON.variantId}));
  for(const [id,e] of Object.entries(normalizedLedger.evidence||{})){
    const original=research.evidence[id];
    if(!original||['url','checkedAt','evidenceFile','sha256'].some(k=>e[k]!==original[k]))throw failure('ICLUB_LEDGER_SOURCE_MISMATCH',id);
  }
  const claimGate=evaluateClaimEvidenceGate(normalizedLedger,{now});
  if(!claimGate.passed)throw failure('ICLUB_CLAIM_NORMALIZATION_FAILED',claimGate.failedChecks);
  for(const [i,a] of affiliates.entries()){
    a.verification=await inspectIclubRedirect(a,{fetchImpl,now});
    offers[i].linkVerification={passed:true,targetMatches:true,checkedAt:a.verification.checkedAt};
  }
  snapshot.linkVerification={...offers[0].linkVerification};
  const snapshotGate=evaluateIclubSnapshot(snapshot,{now});
  if(!snapshotGate.passed)throw failure('ICLUB_SNAPSHOT_INVALID',snapshotGate.failedChecks);
  const affiliate={...affiliates[0],secondary:affiliates[1]};
  return {snapshot,claimLedger:normalizedLedger,affiliate,manifest,manifestFile,manifestBytes,verification:{checkedAt:now.toISOString(),passed:true,sourceGate,snapshotGate,claimGate,sourceCount:sourceEntries.length,sourceExpiresAt:research.sourceExpiresAt,originalResearchUnchanged:true,originalClaimLedgerUnchanged:true}};
}
