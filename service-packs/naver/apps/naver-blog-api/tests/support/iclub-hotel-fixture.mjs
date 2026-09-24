// Synthetic regression data, including synthetic review images and receipts.
// Never use this fixture as live source, editorial or publication evidence.
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PNG} from 'pngjs';
import {publicationFixture,bind} from './publication-fixture.mjs';
import {sha256} from '../../scripts/gates/publication-document.mjs';
import {WriteJournal} from '../../scripts/api/write-journal.mjs';
import {MYREALTRIP_ACCOUNTS} from '../../scripts/gates/travel-planning-contract.mjs';
import {iclubProductUrl} from '../../scripts/gates/iclub-hotel-contract.mjs';
import {buildIclubResearchArtifacts,ICLUB_CLAIM_IDS} from '../../scripts/gates/iclub-research-builder.mjs';

export const ICLUB_NOW=new Date('2026-09-21T07:30:00Z');
export async function iclubFixture(directory,now=ICLUB_NOW){
  const job=await publicationFixture(directory,now),checkedAt=now.toISOString(),bytes=new Map();
  const save=async(file,value)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));bytes.set(file,b);await writeFile(path.join(directory,file),b);return sha256(b);};
  const definitions=[
    {gid:4819071,name:'아이클럽 셩완 AMTD',roomId:223158121,roomName:'iResidence Elite [특가] 룸 온리',rate:'ACM_OPT_MRT:-:STAYNET:-:2483:-:16886:-:115895:-:115895',promotionId:28041,end:'2026-09-30T23:59:59',promoted:true,night:436688,total:960712},
    {gid:4818069,name:'아이클럽 셩완',roomId:222857246,roomName:'i Residence [특가] 룸 온리',rate:'ACM_OPT_MRT:-:STAYNET:-:2471:-:16879:-:115892:-:115892',promotionId:27780,end:'2026-09-23T23:59:59',promoted:false,night:387437,total:852361},
  ];
  const research={schemaVersion:1,exactCampaignCode:null,exactCampaignLandingUrl:null,identities:[],quotes:[],evidence:{},sourceExpiresAt:new Date(now.getTime()+3600000).toISOString()};
  for(const [i,d] of definitions.entries()){
    const primaryFile=`iclub-primary-${i}.json`,quoteFile=`iclub-quote-${i}.json`;
    const timer={type:'PROMOTION_TIMER',startDateTime:'2026-09-01T00:00',endDateTime:d.end};
    const primary={synthetic:true,result:{status:200},data:{staticArea:{metaInfo:{gid:d.gid},header:{stayTitle:d.name},promotionId:d.promotionId},sections:[timer]}};
    const attrs={title:'[특가] 룸 온리',contents:[{title:'혜택',items:[
      {titleWithIcon:{text:'조식 등이 제공되지 않는 실속 옵션'},items:['iLounge 아침 다과 제공 (07:30AM–10:30AM)\n24시간 커피 & 티 서비스']},
      {titleWithIcon:{text:d.promoted?'2박 이상- 13시 무료 레이트 체크아웃 제공':'2박 이상 투숙 시 레이트 체크아웃 제공'},items:['예약 시 요청사항란에 기재 필수\n객실 상황이 가능할 경우에 한하여 제공']},
      {titleWithIcon:{text:'무료 취소'},items:['무료 취소 가능 (한국시간, 26년 10월 25일 01:00까지)']},
      {titleWithIcon:{text:'최소/최대 숙박일'},items:['최소 숙박일 1일']},
    ]}]};
    const header={startDate:'2026-11-03',endDate:'2026-11-05',persons:{adultCount:5,childCount:0}};
    const option={gid:d.gid,roomId:d.roomId,rateOptionId:d.rate,title:'[특가] 룸 온리',salePrice:d.total,startDateTime:'2026-11-03T14:00:00',endDateTime:'2026-11-05T11:00:00',checkInStartTime:'14:00:00',checkOutEndTime:'11:00:00',isPromotion:d.promoted,promotionPriceDisplay:d.promoted?{endDateTime:d.end}:null,optionAllAttributes:attrs,price:{discountedPriceText:d.night.toLocaleString('en-US')+'원',taxIncludedText:`2박 세금 포함 ${d.total.toLocaleString('en-US')}원`},priceDetail:{roomName:d.roomName,prices:[{type:'NORMAL',title:'객실 1개 x 2박',krwPrice:d.total.toLocaleString('en-US')+'원'},{type:'TOTAL',krwPrice:d.total.toLocaleString('en-US')+'원'}],footerPriceText:d.total.toLocaleString('en-US')+'원 / 2박'}};
    const raw={synthetic:true,result:{status:200},data:{staticArea:{staySearchParam:null},sections:[{header,gridCards:[{header:{roomId:d.roomId,representAttributesWithIcon:[{title:'성인 5명'},{title:'영업일 기준 4일 이내 확정'}]},bestOptions:[option],options:[]}]}]}};
    const primaryId=`primary${i}`,quoteId=`quote${i}`;
    research.evidence[primaryId]={url:`https://api3.myrealtrip.com/unionstay/v4/properties/primary?gid=${d.gid}`,checkedAt,httpStatus:200,evidenceFile:primaryFile,sha256:await save(primaryFile,primary)};
    research.evidence[quoteId]={url:`https://api3.myrealtrip.com/unionstay/v4/properties/deferred?gid=${d.gid}&checkIn=2026-11-03&checkOut=2026-11-05&adultCount=5&childCount=0`,checkedAt,httpStatus:200,evidenceFile:quoteFile,sha256:await save(quoteFile,raw)};
    research.identities.push({gid:d.gid,name:d.name,promotionId:d.promotionId,promotionTimer:timer,sourceId:primaryId});
    research.quotes.push({gid:d.gid,sourceId:quoteId,roomId:d.roomId,rateOptionId:d.rate,roomName:d.roomName,optionTitle:option.title,listingDateEcho:header,adultCount:5,childCount:0,roomCount:1,nights:2,currency:'KRW',roomPriceDisplay:option.price.discountedPriceText,totalKrw:d.total,optionAllAttributes:attrs,confirmation:'영업일 기준 4일 이내 확정',maximumOccupancyVerified:false,isPromotion:d.promoted});
  }
  const statements=[
    '2026년 11월 3일~11월 5일, 성인 5명·어린이 0명·객실 1개·2박. AMTD 세전 1박 436,688원, 세금 포함 2박 총액 960,712원. 셩완 세전 1박 387,437원, 세금 포함 2박 총액 852,361원입니다.',
    'AMTD는 2박 이상 13시 레이트 체크아웃을 안내합니다. 예약 시 요청해야 하며 객실 상황이 가능할 때 제공됩니다. 셩완은 레이트 체크아웃 시간이 미명시되어 있습니다.',
    '아침 다과가 제공되는 룸 온리이며 정식 조식 불포함입니다.',
    'AMTD 선택 옵션은 9월 30일까지입니다. 셩완 선택 옵션에는 프로모션 적용 표시가 없습니다.',
    '두 객실의 침실 구성은 호텔의 실제 안내를 비교하세요.',
    '각 숙소의 위치와 역까지 이동 조건을 확인하세요.',
    '최종 금액과 취소 조건 및 기한을 확인하세요.',
    '선택 옵션은 영업일 기준 4일 이내 확정입니다.',
  ];
  const ledger={schemaVersion:1,evidence:structuredClone(research.evidence),claims:ICLUB_CLAIM_IDS.map((id,i)=>({claimId:id,productId:'4819071',variantId:'hotel_promotion',text:statements[i],claimType:i===0?'price':'condition',support:'supports',publishable:true,sources:['quote0','quote1'],expiresAt:research.sourceExpiresAt}))};
  const journalBase=new WriteJournal(directory),journalEntries=new Map(),links={};
  definitions.forEach((d,i)=>{
    const r={source:'independent_http',status:200,checkedAt,ownerVerified:true,accountFingerprint:MYREALTRIP_ACCOUNTS.aicandoanything,targetUrl:iclubProductUrl(String(d.gid)),data:{id:12345+i,mylink:`https://myrealt.rip/syntheticIclub${i}`}};
    links[i===0?'amtd':'sheungwan']=r;
    const key=journalBase.key('myrealtripCreateLink',{accountFingerprint:r.accountFingerprint},{targetUrl:r.targetUrl});
    journalEntries.set(key,{operation:'myrealtripCreateLink',state:'verified',receipt:structuredClone(r)});
  });
  const journal={key:(...args)=>journalBase.key(...args),read:async key=>journalEntries.get(key)};
  const bridges=new Map();
  for(const r of Object.values(links)){const u=new URL(r.targetUrl);u.searchParams.set('utm_source','mktpartner');u.searchParams.set('t_scope','604800');u.searchParams.set('mylink_id',String(r.data.id));bridges.set(r.data.mylink,'https://www.myrealtrip.com/main/bridge/marketing?return_url='+encodeURIComponent(u.href));}
  const fetchImpl=async(url,init)=>{
    if(init.method!=='GET'||init.redirect!=='manual'||init.credentials!=='omit')throw Error('INVALID_TEST_HTTP_METHOD');
    if(bridges.has(String(url)))return new Response('',{status:301,headers:{location:bridges.get(String(url))}});
    if([...bridges.values()].includes(String(url)))return new Response('',{status:200,headers:{'content-type':'text/html'}});
    throw Error('UNEXPECTED_TEST_HTTP_DESTINATION');
  };
  const built=await buildIclubResearchArtifacts({baseDir:directory,research,ledger,links,journal,fetchImpl,now});
  // The production wrapper creates this child directory; the fixture keeps the
  // exact relative manifest path while publishing only synthetic evidence.
  const {mkdir}=await import('node:fs/promises');await mkdir(path.join(directory,'sources'),{recursive:true});
  await writeFile(path.join(directory,built.manifestFile),built.manifestBytes);bytes.set(built.manifestFile,built.manifestBytes);
  const asset=async(i,role)=>{const png=new PNG({width:16,height:12});png.data.fill(50+i*25);const file=`iclub-image-${i}.png`,hash=await save(file,PNG.sync.write(png));return {type:'image',role,file,publishedUrl:`https://blogfiles.pstatic.net/synthetic/iclub-${i}.png`,sha256:hash,purpose:`Synthetic distinct iclub illustration ${i}`,rights:{basis:'generated',source:'synthetic test fixture'},...(i<2?{propertyId:String(definitions[i].gid),href:built.snapshot.propertyOffers[i].affiliateUrl}:{})};};
  const caption=text=>({type:'paragraph',text,claimClass:'guidance'});
  const blocks=[{type:'notice',text:'제휴 배너로 예약하면 수수료를 지급받습니다.'},await asset(0,'affiliate_banner'),caption('AI로 제작한 AMTD 안내 이미지입니다.'),await asset(1,'affiliate_banner'),caption('AI로 제작한 셩완 안내 이미지입니다.'),{type:'heading',presentation:'quotation',text:'조회한 날짜와 총액',claimClass:'guidance'},
    {type:'paragraph',text:statements[0],claimClass:'factual',claimIds:['dated_prices']},await asset(2,'offer_comparison'),caption('AI로 제작한 가격 비교 이미지입니다.'),
    ...statements.slice(1,4).map((text,i)=>({type:'paragraph',text,claimClass:'factual',claimIds:[ICLUB_CLAIM_IDS[i+1]]})),await asset(3,'benefit_conditions'),caption('AI로 제작한 조건 안내 이미지입니다.'),
    ...statements.slice(4).map((text,i)=>({type:'paragraph',text,claimClass:'factual',claimIds:[ICLUB_CLAIM_IDS[i+4]]}))];
  job.blogId='aicandoanything';job.target={type:'create'};job.inputProvider='headless_sdk';job.title='홍콩 성인 5명 숙소 2박 총액과 조건 비교 테스트';
  job.commercialSnapshot=built.snapshot;job.affiliate=built.affiliate;job.publicationBundle.format='hotel_promotion';job.publicationBundle.products=[built.snapshot];job.publicationBundle.comparisonCriteria=[];job.publicationBundle.claimLedger=built.claimLedger;
  job.publicationBundle.document={blogId:job.blogId,title:job.title,blocks};job.publicationBundle.collision={blogId:job.blogId,checkedAt,decision:'create'};job.preflight.kind='headless_input_http_create_preflight';
  for(const review of Object.values(job.publicationBundle.renderReviews))review.imageCount=4;
  for(const assessment of Object.values(job.publicationBundle.qualityReview.editorialAssessments))assessment.blockIndexes=[6];
  bind(job);
  return {job,built,research,ledger,links,journal,journalEntries,bridges,fetchImpl,bytes};
}
