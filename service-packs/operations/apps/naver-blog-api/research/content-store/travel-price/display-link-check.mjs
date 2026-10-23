// Anonymous, single public read of the proposed Naver hotel source route. No response headers/session state are retained.
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const url='https://hotels.naver.com/item/hotels/12159697?checkIn=2026-10-31&checkOut=2026-11-01&adultCnt=2&includeTax=true';
let result;
try{
 let target=url,response,requests=[];
 for(let i=0;i<4;i++){
  if(i)await delay(2050);
  response=await fetch(target,{credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36','accept-language':'ko-KR,ko;q=0.9'}});
  requests.push({url:target,status:response.status});
  if(response.status<300||response.status>=400)break;
  const destination=new URL(response.headers.get('location'),target);
  if(destination.protocol!=='https:'||!['hotels.naver.com','hotel.naver.com'].includes(destination.hostname)||/login|auth|session/i.test(destination.pathname)
   ||[...destination.searchParams.keys()].some(k=>/token|auth|session|key/i.test(k)))break;
  target=destination.href;
 }
 const html=await response.text();
 const title=html.match(/<title[^>]*>([^<]{0,200})<\/title>/i)?.[1]??null;
 const canonical=html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1]??null;
 const routeExamples=[...new Set([...html.matchAll(/(?:https:\/\/hotels\.naver\.com)?\/item\/hotels\/[A-Za-z0-9_-]+/g)].map(m=>m[0]))].slice(0,10);
 result={url,status:response.status,requests,title,canonical,hotelNamePresent:html.includes('서울신라호텔'),hotelIdPresent:html.includes('12159697'),routeExamples,checkedAt:new Date().toISOString(),remoteWrites:0};
}catch(error){result={url,code:'PUBLIC_SOURCE_UNVERIFIED',errorName:error.name,checkedAt:new Date().toISOString(),remoteWrites:0};}
await writeFile(new URL('dry-run-source-link.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
