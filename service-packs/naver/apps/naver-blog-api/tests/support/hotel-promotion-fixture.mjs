// Synthetic regression inputs only. Never use these reviews or receipts to publish.
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PNG} from 'pngjs';
import {publicationFixture,bind} from './publication-fixture.mjs';
import {sha256} from '../../scripts/gates/publication-document.mjs';
import {HOTEL_PROMOTION} from '../../scripts/gates/hotel-promotion-contract.mjs';
import {MYREALTRIP_ACCOUNTS} from '../../scripts/gates/travel-planning-contract.mjs';

export const HOTEL_NOW=new Date('2026-09-21T04:00:00Z');
export async function hotelPromotionFixture(directory,now=HOTEL_NOW){
  const job=await publicationFixture(directory,now),checkedAt=now.toISOString(),url='https://myrealt.rip/syntheticHotel';
  const save=async(file,data)=>{const bytes=Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data));await writeFile(path.join(directory,file),bytes);return sha256(bytes);};
  const image=async(i)=>{const png=new PNG({width:16,height:12});png.data.fill(80+i*20);const file=`hotel-evidence-${i}.png`,bytes=PNG.sync.write(png);return {url:`https://dry7pvlp22cox.cloudfront.net/synthetic/hotel-${i}.png`,evidenceFile:file,sha256:await save(file,bytes)};};
  const images=await Promise.all([0,1,2,3,4].map(image));
  const title='[선착순 할인쿠폰] 신라 모노그램 강릉 단독특가';
  const sales={startsAt:'2026-09-21T02:00:00Z',endsAt:'2026-09-27T14:59:00Z'};
  const raw={synthetic:true,code:HOTEL_PROMOTION.code,title,metaUrl:HOTEL_PROMOTION.canonicalUrl,displayed:true,endAt:sales.endsAt,content:{DESKTOP:{artboards:images.map(e=>({image:e.url}))}}};
  const couponFile='hotel-coupon.json',couponHash=await save(couponFile,{synthetic:true,code:'2026salefesta_fall_alarm',metaUrl:HOTEL_PROMOTION.couponUrl});
  const prices=[160760,220760,185440,255440],observed=[171100,231100,185440,255440];
  const packages=HOTEL_PROMOTION.packages.map((id,i)=>({packageId:id,propertyId:HOTEL_PROMOTION.properties[id.split('_')[0]],benefits:id.endsWith('_pool')?['pool_2']:['breakfast_2','drinks_2'],nights:1,adults:2,priceType:'advertised_starting_price',advertisedBaseKrw:prices[i],advertisedAfterCouponKrw:prices[i]-30000,couponKrw:30000,evidence:images[i]}));
  const quotes=[];
  for(const [i,p] of packages.entries()){
    const checkIn='2026-11-03',checkOut='2026-11-04',roomName=`${p.packageId} synthetic room`;
    const q={packageId:p.packageId,propertyId:p.propertyId,roomName,checkIn,checkOut,adults:2,children:0,rooms:1,checkedAt,priceType:'dated_listing_before_coupon',displayedTotalKrw:observed[i],couponApplied:false,taxIncluded:true,currency:'KRW',evidenceFile:`hotel-quote-${i}.json`,sourceUrl:`https://api3.myrealtrip.com/unionstay/v4/properties/deferred?gid=${p.propertyId}&checkIn=${checkIn}&checkOut=${checkOut}&adultCount=2&childCount=0`};
    const option={gid:Number(q.propertyId),startDateTime:`${checkIn}T15:00:00`,endDateTime:`${checkOut}T11:00:00`,checkInStartTime:'15:00:00',checkOutEndTime:'11:00:00',title:p.packageId.endsWith('_pool')?'[단독★수영장 2인 특가]':'[단독★조식&테라로사 2잔 특가]',price:{taxIncludedText:`세금 포함 ${observed[i].toLocaleString('en-US')}원`},priceDetail:{roomName,prices:[{type:'NORMAL',title:'객실 1개 x 1박',krwPrice:`${observed[i].toLocaleString('en-US')}원`},{type:'TOTAL',krwPrice:`${observed[i].toLocaleString('en-US')}원`}]}};
    q.evidenceSha256=await save(q.evidenceFile,{synthetic:true,result:{status:200},data:{staticArea:{staySearchParam:null},sections:[{header:{startDate:checkIn,endDate:checkOut,persons:{adultCount:2,childCount:0}},gridCards:[{bestOptions:[option],options:[]}]}]}});
    quotes.push(q);
  }
  const p={schemaVersion:1,provider:'myrealtrip',snapshotType:'hotel_promotion',productId:HOTEL_PROMOTION.code,productUrl:'https://myrealtrip.com/promotions/202609_MONOGRAM',productTitle:title,variantId:'hotel_promotion',variant:'숙세페 조건부 행사 안내 시작가',seller:'마이리얼트립',quantity:2,checkedAt,quoteType:'promotion_advertised_from',bookingStatus:'not_booked',availability:'not_verified',sales,stay:{checkInStart:'2026-09-27',checkInEnd:'2026-11-30'},coupon:{program:'2026salefesta_fall_alarm',sourceUrl:HOTEL_PROMOTION.couponUrl,opensAt:'2026-09-22T01:00:00Z',checkInStart:'2026-09-22',checkInEnd:'2026-11-08',amountKrw:30000,minimumPaymentKrw:70000,minimumNights:1,redemptionVerified:false,stacking:'not_assumed',evidence:{url:HOTEL_PROMOTION.couponUrl,evidenceFile:couponFile,sha256:couponHash}},packages,datedQuotes:quotes,periodEvidence:images[4],evidenceFile:'hotel-promotion.json',evidenceSha256:await save('hotel-promotion.json',raw),conditions:'Synthetic advertised prices, not a redeemed coupon or a booked room.',priceAvailabilityStatement:'advertised_from_not_guaranteed_for_every_date',affiliateUrl:url,linkVerification:{passed:true,targetMatches:true,checkedAt},credentialsPersisted:false};
  const asset=(i,role)=>({type:'image',role,file:images[i].evidenceFile,publishedUrl:`https://blogfiles.pstatic.net/synthetic/hotel-${i}.png`,sha256:images[i].sha256,purpose:`Synthetic ${role} regression image`,rights:{basis:'owned',source:'synthetic fixture'},...(role==='affiliate_banner'?{href:url}:{})});
  const statements=[
    '공식 행사 안내 시작가: 레지던스 수영장 패키지는 130,760원부터입니다.',
    '조식과 테라로사 음료는 별도 패키지입니다.',
    '행사 투숙은 11월 30일까지, 쿠폰 입실은 11월 8일까지입니다.',
    '쿠폰 적용 여부는 결제 화면에서 확인해야 합니다.',
    '날짜별 실제 금액은 차이가 있습니다. 현재 레지던스는 수영장 171,100원, 조식 231,100원입니다.',
  ];
  const blocks=[{type:'notice',text:'제휴 배너로 구매하면 수수료를 지급받습니다.'},asset(0,'affiliate_banner'),{type:'heading',text:'패키지별 선택 조건',claimClass:'guidance'},{type:'paragraph',text:statements[0],claimClass:'factual',claimIds:['HP0']},asset(1,'package_comparison'),{type:'paragraph',text:statements[1],claimClass:'factual',claimIds:['HP1']},{type:'paragraph',text:statements[2],claimClass:'factual',claimIds:['HP2']},asset(2,'coupon_calendar'),{type:'paragraph',text:statements[3],claimClass:'factual',claimIds:['HP3']},{type:'paragraph',text:statements[4],claimClass:'factual',claimIds:['HP4']},{type:'paragraph',text:'이른 수영과 조식 가운데 여행 일정에 맞는 구성을 고르세요.',claimClass:'guidance'}];
  const ledger={schemaVersion:1,evidence:{HP:{url:p.productUrl,checkedAt,evidenceFile:p.evidenceFile,sha256:p.evidenceSha256}},claims:statements.map((statement,i)=>({claimId:`HP${i}`,text:statement,productId:p.productId,variantId:p.variantId,claimType:i===0||i===4?'price':'condition',support:'supports',publishable:true,sources:['HP'],expiresAt:new Date(now.getTime()+30*60000).toISOString()}))};
  job.blogId='aicandoanything';job.target={type:'create'};job.inputProvider='headless_sdk';job.title='신라모노그램 강릉 행사 패키지 조건 테스트';job.commercialSnapshot=p;
  job.affiliate={provider:'myrealtrip',url,accountFingerprint:MYREALTRIP_ACCOUNTS.aicandoanything,mylinkId:'12345',creationJournalKey:'c'.repeat(64),verification:{source:'independent_http_redirect',checkedAt,status:301,bridgeStatus:200,url,promotionCode:p.productId,targetUrl:p.productUrl,mylinkId:'12345',accountFingerprint:MYREALTRIP_ACCOUNTS.aicandoanything}};
  job.publicationBundle.format='hotel_promotion';job.publicationBundle.products=[p];job.publicationBundle.comparisonCriteria=[];job.publicationBundle.claimLedger=ledger;
  job.publicationBundle.document={blogId:job.blogId,title:job.title,blocks};job.publicationBundle.collision={blogId:job.blogId,checkedAt,decision:'create'};
  for(const review of Object.values(job.publicationBundle.renderReviews))review.imageCount=3;
  job.preflight.kind='headless_input_http_create_preflight';bind(job);
  const receipt={operation:'myrealtripCreateLink',state:'verified',receipt:{source:'independent_http',status:200,ownerVerified:true,accountFingerprint:job.affiliate.accountFingerprint,targetUrl:p.productUrl,data:{id:12345,mylink:url}}};
  const target=`${p.productUrl}?utm_source=mktpartner&t_scope=604800&mylink_id=12345`,bridge='https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(target);
  return {job,receipt,bridge,target};
}
