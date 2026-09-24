// Entirely synthetic test sources, images, credentials-free journals and review
// receipts. These fixtures never establish live publication evidence.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PNG} from 'pngjs';
import {publicationFixture,bind} from './publication-fixture.mjs';
import {sha256} from '../../scripts/gates/publication-document.mjs';
import {MYREALTRIP_ACCOUNTS} from '../../scripts/gates/travel-planning-contract.mjs';
import {WriteJournal} from '../../scripts/api/write-journal.mjs';
import {seoulShillaProductUrl} from '../../scripts/gates/seoul-shilla-contract.mjs';
import {buildSeoulShillaResearchArtifacts,SEOUL_SHILLA_CLAIM_IDS} from '../../scripts/gates/seoul-shilla-research-builder.mjs';

export const SHILLA_NOW=new Date('2026-09-21T09:20:00Z');
export async function shillaFixture(directory,now=SHILLA_NOW){
  const job=await publicationFixture(directory,now),checkedAt=now.toISOString(),bytes=new Map();
  const save=async(file,value)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));bytes.set(file,b);await writeFile(path.join(directory,file),b);return sha256(b);};
  const query={checkIn:'2026-09-28',checkOut:'2026-09-29',adultCount:2,childCount:0,roomCount:1,nights:1};
  const echo={startDate:query.checkIn,endDate:query.checkOut,persons:{adultCount:2,childCount:0}};
  const definitions=[
    {id:36284,amount:30000,min:550000,descriptionMin:550000,room:418226312,rate:'ACM_OPT_MRT:-:STAYNET:-:147:-:47583:-:173946:-:173946',roomName:'[TA SEP URBAN ISLAND]디럭스 더블 TA SEP URBAN ISLAND',title:'TA SEP URBAN ISLAND',normal:595980,roomCharge:541800,tax:54180},
    {id:36286,amount:50000,min:600000,descriptionMin:55,room:225979239,rate:'ACM_OPT_MRT:-:STAYNET:-:147:-:16928:-:60825:-:60825',roomName:'디럭스 더블 Room Only',title:'Room Only',normal:693000,roomCharge:630000,tax:63000},
    {id:36287,amount:70000,min:700000,descriptionMin:700000,room:225979239,rate:'ACM_OPT_MRT:-:STAYNET:-:147:-:16928:-:159510:-:159510',roomName:'디럭스 더블 조식 2인 패키지',title:'조식 2인 패키지',normal:817000,roomCharge:742728,tax:74272},
    {id:36288,amount:120000,min:1000000,descriptionMin:1000000,room:225939562,rate:'ACM_OPT_MRT:-:STAYNET:-:147:-:16908:-:60646:-:60646',roomName:'이그제큐티브 비즈니스 디럭스 더블 Room Only',title:'Room Only',normal:1056000,roomCharge:960000,tax:96000},
  ];
  const korean=n=>n.toLocaleString('en-US')+'원';
  const research={schemaVersion:1,identity:{gid:2680667,name:'서울신라호텔',promotionId:null,sourceId:'primary'},quoteQuery:query,quotes:[],coupons:[],evidence:{},expiresAt:new Date(now.getTime()+3600000).toISOString(),urbanPackage:{quoteCouponTemplateId:36284,sourceId:'quote',salesStart:'2026-09-18',salesEnd:'2026-09-29',stayStart:'2026-09-21',stayEnd:'2026-09-30',excludedStayDates:['2026-09-24','2026-09-25','2026-09-26'],scope:'Only selected TA SEP URBAN ISLAND package; not every hotel room or coupon',refundability:'non_refundable',dateChangesAllowed:false,benefit:'어번 아일랜드 All Day 입장 혜택',operatingHours:'09:30–21:00',useTimeBoundary:'체크인~체크아웃 사이 운영시간'}};
  const primary={synthetic:true,result:{status:200},data:{staticArea:{metaInfo:{gid:2680667},header:{stayTitle:'서울신라호텔',shareWebLink:seoulShillaProductUrl()},promotionId:null,staySearchParam:{gid:2680667,...query}}}};
  const rawQuote={synthetic:true,result:{status:200},data:{sections:[{header:echo,gridCards:[]}]}};
  const rawCoupons={synthetic:true,result:{status:200},data:[]};
  for(const [i,d] of definitions.entries()){
    const cancellation=i===0?'환불 불가':'무료 취소 가능 (한국시간, 26년 9월 27일 18:00까지)';
    const attrs=i===0?[
      {titleWithIcon:{text:'어번 아일랜드 All Day 입장 혜택'},items:['ㅁ 어번 아일랜드 운영 시간 : 09:30~21:00\nㅁ 어번 아일랜드 이용 가능 시간 : 체크인 ~ 체크아웃 내 어번 아일랜드 운영 시간']},
      {titleWithIcon:{text:'패키지 안내 '},items:['판매 기간 : 2026년 9월 18일 ~ 2026년 9월 29일\n투숙 기간 : 2026년 9월 21일 ~ 2026년 9월 30일\n투숙 제외 기간 : 2026/9/24~26 제외\n날짜 변경이 불가\n환불 불가 상품']},
    ]:i===2?[{titleWithIcon:{text:'더 파크뷰 조식 2인 포함 '},items:['']},{titleWithIcon:{text:'식사 제공 여부'},items:['무료 조식 2인']}]:[];
    const option={gid:2680667,roomId:d.room,rateOptionId:d.rate,title:d.title,couponTemplateId:String(d.id),salePrice:d.normal,startDateTime:'2026-09-28T15:00:00',endDateTime:'2026-09-29T11:00:00',checkInStartTime:'15:00:00',checkOutEndTime:'11:00:00',attributions:[{title:cancellation}],optionAllAttributes:{contents:[{items:attrs}]},price:{discountedPriceText:korean(d.roomCharge-d.amount),taxIncludedText:'세금 포함 '+korean(d.normal-d.amount)},priceDetail:{roomName:d.roomName,prices:[{type:'NORMAL',title:'객실 1개 x 1박',krwPrice:korean(d.normal),subPrices:[{title:'객실 이용료',priceText:korean(d.roomCharge)},{title:'세금 및 수수료',priceText:korean(d.tax)}]},{type:'DISCOUNT',title:'총 할인금액',krwPrice:korean(-d.amount),subPrices:[{title:'쿠폰 할인',priceText:korean(-d.amount)}]},{type:'TOTAL',title:'최종 결제 금액',krwPrice:korean(d.normal-d.amount)}],footerPriceText:korean(d.normal-d.amount)+' / 1박'}};
    rawQuote.data.sections[0].gridCards.push({header:{roomId:d.room,representAttributesWithIcon:[{title:'성인 2명'}]},bestOptions:[option]});
    research.quotes.push({gid:2680667,sourceId:'quote',roomId:d.room,rateOptionId:d.rate,roomName:d.roomName,optionTitle:d.title,couponTemplateId:d.id,checkIn:query.checkIn,checkOut:query.checkOut,adults:2,children:0,rooms:1,nights:1,currency:'KRW',normalTotalKrw:d.normal,normalRoomChargeKrw:d.roomCharge,taxAndFeesKrw:d.tax,couponDiscountKrw:d.amount,displayedTotalKrw:d.normal-d.amount,displayedNightlyPreTaxKrw:d.roomCharge-d.amount,taxIncluded:true,couponApplication:'displayed_in_listing',personalCouponIssued:false,bookingCompleted:false,cancellation:{type:i===0?'non_refundable':'free_until',freeUntil:i===0?null:'2026-09-27T18:00:00+09:00'},confirmation:{status:'unknown'}});
    const common={name:'9월 서울신라호텔 상시',discountType:'FLAT',condition:[korean(d.min)+' 이상 구매 시','2026년 9월 30일 23시 59분까지 사용 가능','android,ios,web에서만 사용 가능','서둘러 사용하세요! 선착순으로 사용 가능한 쿠폰이에요.'],description:`· 지정된 상품에만 적용됩니다.\n· 해당 쿠폰은 최소 주문금액 ${d.descriptionMin}원 이상부터 사용 가능합니다.\n· 한 ID당 1매만 발급됩니다. (중복 발급 불가)\n· 쿠폰 발급/사용 기간 종료 후 구매 취소 시 재발급이 불가합니다.\n· 본 쿠폰의 지급 및 사용기한은 예산 소진 시 조기 종료 될 수 있습니다.`,activatedStartDate:'2026-09-18T09:00:00Z',activatedEndDate:'2026-09-30T14:59:59Z',expireDate:'2026-09-30T14:59:51Z',isUsable:true,isPublishable:true,isRepeatable:false,usableChannel:['android','ios','web'],warningMessages:['android,ios,web에서만 사용 가능','서둘러 사용하세요! 선착순으로 사용 가능한 쿠폰이에요.']};
    rawCoupons.data.push({id:d.id,...common,couponType:'DIRECT_COUPON',promotionCode:null,flatAmount:d.amount,discountRate:null,couponUseStatus:null});
    research.coupons.push({couponTemplateId:d.id,sourceId:'coupons',...structuredClone(common),discountKrw:d.amount,minimumSpendDisplayKrw:d.min,minimumSpendDescriptionKrw:d.descriptionMin,minimumSpendStatus:i===1?'conflicting_source_text':'verified',displayedUseDeadline:'2026-09-30T23:59:00+09:00',deadlinePrecision:'minute',perIdIssueLimit:1,issueLimitScope:'each_coupon_template',stacking:'unverified',tripWindow:'not_explicit_in_coupon_response'});
  }
  const urls={primary:'https://api3.myrealtrip.com/unionstay/v4/properties/primary?gid=2680667&checkIn=2026-09-28&checkOut=2026-09-29&adultCount=2&childCount=0',quote:'https://api3.myrealtrip.com/unionstay/v4/properties/deferred?gid=2680667&checkIn=2026-09-28&checkOut=2026-09-29&adultCount=2&childCount=0',coupons:'https://api3.myrealtrip.com/coupon/traveler/templates/publishable-by-gids?upsIds=2680667&tripStartDate=2026-09-28&tripEndDate=2026-09-29'};
  for(const [id,value] of Object.entries({primary,quote:rawQuote,coupons:rawCoupons}))research.evidence[id]={url:urls[id],checkedAt,httpStatus:200,requestMethod:'GET',credentials:'omit',evidenceFile:`shilla-${id}.json`,sha256:await save(`shilla-${id}.json`,value)};
  const statements=[
    '3만원 쿠폰은 55만원 이상, 7만원은 70만원 이상, 12만원은 100만원 이상입니다. 5만원 쿠폰은 공식 카드에 60만원 이상, 상세 설명에는 55원으로 표기가 다릅니다. 결제 화면에서 확인하세요.',
    '쿠폰 사용기한은 2026년 9월 30일 23시 59분입니다. 전체 투숙 가능 기간과 구분하여 확인하세요. 선착순이며 예산 소진 시 종료됩니다.',
    '2026년 9월 28일 체크인, 9월 29일 체크아웃, 성인 2명·어린이 0명·객실 1개·1박의 세금 포함 총액입니다. 595,980원에서 565,980원, 693,000원에서 643,000원, 817,000원에서 747,000원, 1,056,000원에서 936,000원으로 표시됩니다. 이미 쿠폰 할인이 반영되어 한 번 더 빼면 안 됩니다. 예약 완료 금액이 아닙니다.',
    '3만원 예시는 환불 불가입니다. 5만원·7만원·12만원 예시는 한국시간 2026년 9월 27일 18시까지 무료 취소입니다.',
    '각 쿠폰은 ID당 1매이고 중복 발급 불가입니다. 지정 상품에 적용되며 서로 다른 쿠폰을 함께 사용할 수 있는지는 확인되지 않았습니다.',
  ];
  const ledger={schemaVersion:1,evidence:structuredClone(research.evidence),claims:SEOUL_SHILLA_CLAIM_IDS.map((id,i)=>({claimId:id,productId:'2680667',variantId:'seoul_shilla_september_coupon',text:statements[i],claimType:i===2?'price':'condition',support:'supports',publishable:true,sources:i===2||i===3?['quote']:['coupons'],expiresAt:research.expiresAt}))};
  const created={source:'independent_http',status:200,checkedAt,ownerVerified:true,accountFingerprint:MYREALTRIP_ACCOUNTS.aicandoanything,targetUrl:seoulShillaProductUrl(),data:{id:10001,mylink:'https://myrealt.rip/syntheticShilla'}};
  const links={shilla:created},j=new WriteJournal(directory),journalKey=j.key('myrealtripCreateLink',{accountFingerprint:created.accountFingerprint},{targetUrl:created.targetUrl}),entry={operation:'myrealtripCreateLink',state:'verified',receipt:structuredClone(created)},journal={key:(...x)=>j.key(...x),read:async key=>key===journalKey?entry:null};
  const bridge='https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(created.targetUrl+'&utm_source=mktpartner&mylink_id=10001&t_scope=604800');
  const fetchImpl=async(url,init)=>{if(init.method!=='GET'||init.redirect!=='manual'||init.credentials!=='omit')throw Error('UNSAFE_TEST_HTTP');if(url===created.data.mylink)return new Response('',{status:301,headers:{location:bridge}});if(url===bridge)return new Response('',{status:200,headers:{'content-type':'text/html'}});throw Error('UNEXPECTED_TEST_DESTINATION');};
  const built=await buildSeoulShillaResearchArtifacts({baseDir:directory,research,ledger,links,journal,fetchImpl,now});
  await mkdir(path.join(directory,'sources'),{recursive:true});await writeFile(path.join(directory,built.manifestFile),built.manifestBytes);bytes.set(built.manifestFile,built.manifestBytes);
  const image=async(i,role)=>{const png=new PNG({width:16,height:12});png.data.fill(50+i*30);const file=`shilla-image-${i}.png`;return {type:'image',role,file,publishedUrl:`https://blogfiles.pstatic.net/synthetic/shilla-${i}.png`,sha256:await save(file,PNG.sync.write(png)),purpose:'Synthetic useful Shilla illustration '+i,rights:{basis:'generated',source:'synthetic test'},...(i===0?{propertyId:'2680667',href:built.affiliate.url}:{})};};
  const caption=()=>({type:'paragraph',text:'AI로 제작한 테스트 안내 이미지입니다.',claimClass:'guidance'});
  const blocks=[{type:'notice',text:'제휴 배너로 구매 시 수수료를 받습니다.'},await image(0,'affiliate_banner'),caption(),{type:'heading',presentation:'quotation',text:'쿠폰별 조건을 확인하세요',claimClass:'guidance'},
    {type:'paragraph',text:statements[0],claimClass:'factual',claimIds:['coupons']},await image(1,'coupon_comparison'),caption(),{type:'paragraph',text:statements[1],claimClass:'factual',claimIds:['dates']},await image(2,'booking_dates'),caption(),
    {type:'paragraph',text:statements[2],claimClass:'factual',claimIds:['dated_prices']},{type:'paragraph',text:statements[3],claimClass:'factual',claimIds:['cancellation']},await image(3,'booking_conditions'),caption(),{type:'paragraph',text:statements[4],claimClass:'factual',claimIds:['booking_conditions']}];
  job.blogId='aicandoanything';job.target={type:'create'};job.inputProvider='headless_sdk';job.title='서울신라호텔 9월 쿠폰과 객실 조건 테스트';job.commercialSnapshot=built.snapshot;job.affiliate=built.affiliate;
  Object.assign(job.publicationBundle,{format:'hotel_promotion',products:[built.snapshot],claimLedger:built.claimLedger,comparisonCriteria:[],document:{blogId:job.blogId,title:job.title,blocks},collision:{blogId:job.blogId,checkedAt,decision:'create'}});
  job.preflight.kind='headless_input_http_create_preflight';for(const review of Object.values(job.publicationBundle.renderReviews))review.imageCount=4;for(const assessment of Object.values(job.publicationBundle.qualityReview.editorialAssessments))assessment.blockIndexes=[4];bind(job);
  return {job,built,research,ledger,links,journal,entry,fetchImpl,bytes};
}
