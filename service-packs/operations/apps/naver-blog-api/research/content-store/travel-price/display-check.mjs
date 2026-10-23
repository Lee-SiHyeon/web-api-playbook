// Stage 1: anonymous displayed-price comparisons. Stage 2 payable gates remain in the ontologies.
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DEFAULT_CRAWLER_DIR} from '../naver-crawler-snapshot.mjs';

export const HOTEL_WATCHLIST=Object.freeze([
 {hotelId:'12159697',name:'서울신라호텔',city:'서울'},
 {hotelId:'11583218',name:'그랜드 워커힐 서울',city:'서울'},
 {hotelId:'11576700',name:'파라다이스 호텔 부산',city:'부산'},
 {hotelId:'650968109',name:'아난티 앳 부산 코브',city:'부산'},
 {hotelId:'1016404332',name:'그랜드 조선 부산',city:'부산'},
 {hotelId:'1857519376',name:'시그니엘 부산',city:'부산'},
 {hotelId:'11565526',name:'웨스틴 조선 부산',city:'부산'},
 // Same-source Naver IDs confirmed by hotel-name searches in dry-run-watchlist.json; no cross-source hotel merging.
 {hotelId:'11583210',name:'제주신라호텔',city:'제주'},
 {hotelId:'11583214',name:'롯데 호텔 제주',city:'제주'},
 {hotelId:'1919264399',name:'그랜드 하얏트 제주',city:'제주'},
]);
const text=v=>typeof v==='string'?v.normalize('NFKC').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim():'';
const normalized=v=>text(v).toLocaleLowerCase('en-US');
const ymd=d=>d.toISOString().slice(0,10);
const sorted=xs=>Array.isArray(xs)?xs.map(normalized).sort():[];
const money=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const dateStart=today=>new Date(`${new Date(today.getTime()+9*3600000).toISOString().slice(0,10)}T00:00:00Z`);

// Each daily pass rotates hotels and lead times, with Fri-Sun and weekday stays inside 2-6 weeks.
export function watchlistDates(today=new Date(),watchlist=HOTEL_WATCHLIST){
 const start=dateStart(today),cycle=Math.floor(start.getTime()/86400000),offset=((cycle%watchlist.length)+watchlist.length)%watchlist.length;
 return [...watchlist.slice(offset),...watchlist.slice(0,offset)].map((hotel,index)=>{
  const lead=[14,21,28,35][(index+cycle)%4];
  let checkIn=new Date(start.getTime()+lead*86400000),nights=1;
  if(index%2===0){checkIn=new Date(checkIn.getTime()+((5-checkIn.getUTCDay()+7)%7)*86400000);nights=2;
   if((checkIn-start)/86400000>40)checkIn=new Date(checkIn.getTime()-7*86400000);}
  return {...hotel,checkIn:ymd(checkIn),checkOut:ymd(new Date(checkIn.getTime()+nights*86400000)),nights};
 });
}

// Exact source room name plus observed features: no fuzzy bed/view/lounge or promotional-name merges.
export function hotelRoomKey(rate){
 const name=normalized(rate.roomName);
 if(!name||typeof rate.isFreeCancel!=='boolean'||typeof rate.freeBreakfast!=='boolean')return null;
 const deadline=rate.isFreeCancel&&rate.freeCancelDeadline
  ?(Number.isFinite(Date.parse(rate.freeCancelDeadline))?new Date(rate.freeCancelDeadline).toISOString():text(rate.freeCancelDeadline)):null;
 return JSON.stringify({name,roomType:sorted(rate.roomType),viewType:sorted(rate.viewType),bedType:sorted(rate.bedType),
  sizeSqm:rate.sizeSqm??null,maxOccupancy:rate.maxOccupancy??null,refundable:rate.isFreeCancel,cancellationDeadline:deadline,
  breakfast:rate.freeBreakfast,dinner:rate.freeDinner??null,memberPrice:rate.memberPrice??null,couponPrice:rate.couponPrice??null,
  taxesIncluded:rate.taxesIncluded??null,feesIncluded:rate.feesIncluded??null});
}
export function hotelLink(hotel){
 // The old /item/hotels/{id} guess redirects to the home page. Only this public source route was verified.
 // Exact hotel/date/room identifiers stay in the checked row; this is not a verified booking deep link.
 return 'https://hotels.naver.com/accommodation';
}

export function compareStayRates(hotel,result,{checkedAt=result?.checkedAt??new Date().toISOString()}={}){
 // Exact request context is required even when a test/injected client supplies the response.
 if(String(result?.hotelId)!==String(hotel.hotelId)||result?.stayPeriod?.checkIn!==hotel.checkIn||result?.stayPeriod?.checkOut!==hotel.checkOut
  ||result?.occupancy?.adult!==2||!Array.isArray(result?.occupancy?.childrenAges)||result.occupancy.childrenAges.length)
  return [{kind:'stay',title:hotel.name,hotelId:hotel.hotelId,verdict:{eligible:false,route:'lowest_not_affiliate',reasons:['rate_context_mismatch']}}];
 const groups=new Map();
 for(const rate of result.rates??[]){
  const roomKey=hotelRoomKey(rate),priceKrw=money(rate.listingPriceKrw),otaCode=text(rate.otaCode);
  if(!roomKey||!priceKrw||!otaCode||rate.currency!=='KRW')continue;
  if(!groups.has(roomKey))groups.set(roomKey,[]);
  groups.get(roomKey).push({...rate,priceKrw,otaCode});
 }
 const rows=[];
 for(const [roomKey,rates] of groups){
  const byOta=new Map();
  for(const rate of rates)if(!byOta.has(rate.otaCode)||byOta.get(rate.otaCode).priceKrw>rate.priceKrw)byOta.set(rate.otaCode,rate);
  const quotes=[...byOta.values()].sort((a,b)=>a.priceKrw-b.priceKrw);
  if(quotes.length<2)continue;
  const min=quotes[0].priceKrw,max=quotes.at(-1).priceKrw,spreadKrw=max-min,spreadPct=100*spreadKrw/min;
  const sourceUrl=hotelLink(hotel),sample=quotes[0];
  const hiddenCosts=['세금·수수료 포함 여부 미확인','회원·쿠폰 적용 조건 미확인','표시금액의 1박·전체숙박 단위 미확인'];
  if(sample.isFreeCancel&&!sample.freeCancelDeadline)hiddenCosts.push('무료취소 기한 미확인');
  const offers=quotes.map(r=>({seller:r.otaCode,otaCode:r.otaCode,priceKrw:r.priceKrw,url:sourceUrl,rateId:r.rateId,roomId:r.roomId}));
  const eligible=spreadKrw>=20000&&spreadPct>=10;
  rows.push({kind:'stay',priceTier:'display',title:hotel.name,hotelName:hotel.name,city:hotel.city,hotelId:String(hotel.hotelId),
   checkIn:hotel.checkIn,checkOut:hotel.checkOut,nights:hotel.nights,adults:2,roomKey,roomName:sample.roomName,
   refundable:sample.isFreeCancel,cancellationDeadline:sample.freeCancelDeadline??null,breakfast:sample.freeBreakfast,dinner:sample.freeDinner??null,
   lowest:offers[0],offers,min,max,spreadKrw,spreadPct,hiddenCosts,sourceUrl,sourceLinkScope:'naver_hotel_home',checkedAt,
   verdict:{eligible:false,route:'lowest_not_affiliate',reasons:[eligible?'live_recheck_required':'spread_below_threshold']},
   displayThresholdEligible:eligible,verified:{ok:false},priceScope:'quoted_listing_rate',payablePriceVerified:false});
 }
 return rows.sort((a,b)=>b.spreadKrw-a.spreadKrw);
}

// Only documented hotel read queries can reach the crawler transport. No cookie/session/credential source is used.
export async function createHotelClient({crawlerDir=process.env.NAVER_CRAWLER_DIR||DEFAULT_CRAWLER_DIR,fetchImpl=globalThis.fetch,
 now=()=>Date.now(),sleep=delay,minIntervalMs=2050,requests=[]}={}){
 const {NaverTravelClient}=await import(pathToFileURL(path.join(crawlerDir,'adapters/naver-travel.mjs')).href);
 let lastStart=-Infinity,queue=Promise.resolve();
 const mealConditions=new Map(),contextKey=v=>JSON.stringify([String(v.id),v.checkIn,v.checkOut]);
 const anonymousFetch=(url,options={})=>{
  const execute=async()=>{
   const target=new URL(url),body=JSON.parse(options.body??'{}');
   const operation=body.query?.trim().match(/^query\s+(domesticHotelList|domesticHotelRates)\b/)?.[1];
   if(target.href!=='https://hermes-hotel-svc-api.naver.com/graphql'||options.method!=='POST'||!operation||/\b(mutation|subscription)\b/i.test(body.query))
    throw Object.assign(new Error('HOTEL_READ_CONTRACT_REJECTED'),{code:'HOTEL_READ_CONTRACT_REJECTED'});
   if([...new Headers(options.headers).keys()].some(k=>/cookie|authorization|token|api[-_]?key|session/i.test(k)))throw new Error('HOTEL_AUTH_HEADER_REJECTED');
   await sleep(Math.max(0,Math.max(2000,minIntervalMs)-(now()-lastStart)));
   lastStart=now();const receipt={host:target.hostname,operation,startedAt:new Date(lastStart).toISOString()};requests.push(receipt);
   try{const response=await fetchImpl(target,{...options,credentials:'omit',redirect:'manual'});receipt.status=response.status;
    // The private crawler queries freeDinner but drops it from its normalized row. Keep that observed boolean.
    if(operation==='domesticHotelRates'&&response.status===200){
     try{const payload=await response.clone().json(),rates=payload?.data?.domesticHotelRates?.rates;
      mealConditions.set(contextKey(body.variables),new Map((rates??[]).map(r=>[String(r.id),typeof r.productFeatures?.freeDinner==='boolean'?r.productFeatures.freeDinner:null])));
     }catch{mealConditions.delete(contextKey(body.variables));}
    }
    return response;}
   catch(error){receipt.code='TRANSPORT';throw error;}
  };
  const pending=queue.then(execute);queue=pending.catch(()=>{});return pending;
 };
 const client=new NaverTravelClient({fetchImpl:anonymousFetch,timeoutMs:30000}),hotelRates=client.hotelRates.bind(client);
 client.hotelRates=async input=>{
  const result=await hotelRates(input),meals=mealConditions.get(contextKey({id:input.hotelId,checkIn:input.checkIn,checkOut:input.checkOut}));
  return {...result,rates:result.rates.map(rate=>({...rate,freeDinner:meals?.get(String(rate.rateId))??null}))};
 };
 return client;
}
const codeOf=e=>/^[A-Z0-9_]+$/.test(e?.code??'')?e.code:'HOTEL_READ_FAILED';
export async function checkStays({today=new Date(),client,watchlist=HOTEL_WATCHLIST,requests=[]}={}){
 const api=client??await createHotelClient({requests}),rows=[],observations=[];
 for(const entry of watchlistDates(today,watchlist)){
  let hotel={...entry};
  try{
   if(!hotel.hotelId)throw Object.assign(new Error('HOTEL_IDENTITY_UNCONFIRMED'),{code:'HOTEL_IDENTITY_UNCONFIRMED'});
   const input={hotelId:hotel.hotelId,checkIn:hotel.checkIn,checkOut:hotel.checkOut,adult:2,childrenAges:[],queryName:hotel.name};
   const result=await api.hotelRates(input),compared=compareStayRates(hotel,result);
   observations.push({hotel:hotel.name,hotelId:hotel.hotelId,checkIn:hotel.checkIn,checkOut:hotel.checkOut,rateCount:result.rates?.length??0,comparisonCells:compared.length,receipt:result.receipt??null});
   rows.push(...compared);
  }catch(error){rows.push({kind:'stay',priceTier:'display',title:hotel.name,hotelId:hotel.hotelId??null,checkIn:hotel.checkIn,checkOut:hotel.checkOut,
   verdict:{eligible:false,route:'lowest_not_affiliate',reasons:[codeOf(error)]},verified:{ok:false},error:codeOf(error)});}
 }
 // Re-read the selected whole comparison cell, including rival quotes; stale gaps never become postable.
 for(const pick of rows.filter(r=>r.displayThresholdEligible).sort((a,b)=>b.spreadKrw-a.spreadKrw)){
  try{
   const result=await api.hotelRates({hotelId:pick.hotelId,checkIn:pick.checkIn,checkOut:pick.checkOut,adult:2,childrenAges:[],queryName:pick.hotelName});
   const fresh=compareStayRates({...pick,name:pick.hotelName},result).find(r=>r.roomKey===pick.roomKey);
   if(!fresh?.displayThresholdEligible){pick.displayThresholdEligible=false;pick.verdict.reasons=['live_spread_no_longer_eligible'];continue;}
   Object.assign(pick,fresh,{verdict:{eligible:true,route:'lowest_not_affiliate',reasons:[]},verified:{ok:true,checkedAt:result.checkedAt??new Date().toISOString(),
    link:fresh.sourceUrl,priceKrw:fresh.lowest.priceKrw,otaCode:fresh.lowest.otaCode,comparisonOffers:fresh.offers,receipt:result.receipt??null}});
   break;
  }catch(error){pick.displayThresholdEligible=false;pick.verdict.reasons=[codeOf(error)];pick.verified={ok:false,error:codeOf(error)};}
 }
 return {kind:'stay',priceTier:'display',checkedAt:new Date().toISOString(),rows,observations,requests};
}

export async function checkDisplay(kind,options={}){
 if(kind==='stay')return checkStays(options);
 if(kind==='package'){const {checkPackages}=await import('./package-display.mjs');return checkPackages(options);}
 throw Object.assign(new Error('DISPLAY_KIND_INVALID'),{code:'DISPLAY_KIND_INVALID'});
}
export async function main(argv=process.argv.slice(2)){
 const arg=name=>argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
 const kind=arg('kind');
 if(argv.some(a=>!/^--(?:kind|out)=/.test(a)))throw Object.assign(new Error('DISPLAY_ARGUMENT_INVALID'),{code:'DISPLAY_ARGUMENT_INVALID'});
 const result=await checkDisplay(kind);
 if(arg('out'))await writeFile(path.resolve(arg('out')),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(JSON.stringify({code:codeOf(error)}));process.exitCode=1;});
