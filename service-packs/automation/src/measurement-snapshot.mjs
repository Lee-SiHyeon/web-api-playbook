import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const hash=x=>createHash('sha256').update(x).digest('hex');
const numeric=x=>typeof x==='number'&&Number.isFinite(x);
export function tistoryBlogOrigin(value){
 if(typeof value!=='string')return null;
 let url;try{url=new URL(value);}catch{return null;}
 if(url.protocol!=='https:'||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.tistory\.com$/i.test(url.hostname)||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
 return url.origin;
}
export function decodePartners(d){
 if(d.rCode!=='0')throw Error('partners_application_failure');
 const select=source=>{
  if(typeof source?.key!=='string'||typeof source.lastUpdatedDate!=='string')throw Error('partners_period_missing');
  const metrics={};for(const key of ['orderCount','clickCount','gmv','commission','conversion']){if(!numeric(source[key]))throw Error('partners_metric_missing');metrics[key]=source[key];}
  return {period:source.key,lastUpdatedDate:source.lastUpdatedDate,...metrics};
 };
 return {scope:'affiliate-account',daily:select(d.data?.dailyTrend),monthly:select(d.data?.monthlyAggregation),settlementVerified:false};
}
export function decodeBlog(d){
 if(d.status!=='ok')throw Error('blog_application_failure');
 const source=d.data?.result;
 for(const metric of ['pv','uv'])for(const period of ['today','yesterday','total'])if(!numeric(source?.[metric]?.[period]))throw Error('blog_metric_missing');
 return {scope:'whole-blog',pv:source.pv,uv:source.uv,timestamp:d.data.timestamp,lastUpdateTime:d.data.lastUpdateTime};
}
export function decodePostCounts(d,postIds){
 if(d.status!=='ok'||!Array.isArray(d.data?.result))throw Error('blog_post_schema_failure');
 return {scope:'selected-posts-in-dashboard-top-list',timestamp:d.data.timestamp??null,metric:'dashboard-count',period:'dashboard-default-not-independently-verified',posts:postIds.map(id=>{
  const row=d.data.result.find(r=>String(r.entryId)===String(id));
  if(!row)return {postId:String(id),status:'not-in-top-list',count:null};
  if(!numeric(row.count)||row.count<0)throw Error('blog_post_metric_missing');
  return {postId:String(id),status:'observed',count:row.count};
 }),organicTrafficVerified:false};
}
export async function collectMeasurements(directory,env=process.env,postIds=[],{fetchImpl=globalThis.fetch,now=()=>new Date(),uuid=randomUUID}={}){
 if(!Array.isArray(postIds)||postIds.some(id=>!/^\d+$/.test(String(id))))throw Error('Invalid post IDs');
 const blogOrigin=tistoryBlogOrigin(env.TISTORY_BLOG_ORIGIN);
 const specs=[{id:'partners',url:'https://partners.coupang.com/api/v1/dashboard',cookie:env.COUPANG_COOKIE,token:env.COUPANG_X_TOKEN,decode:decodePartners},{id:'blog',url:blogOrigin?blogOrigin+'/manage/v2/statistics/blog/count':null,cookie:env.TISTORY_COOKIE,decode:decodeBlog}];
 if(postIds.length)specs.push({id:'posts',url:blogOrigin?blogOrigin+'/manage/statistics/dashboard/topEntry.json':null,cookie:env.TISTORY_COOKIE,decode:d=>decodePostCounts(d,[...new Set(postIds.map(String))])});
 const results=await Promise.allSettled(specs.map(async spec=>{
  if(!spec.url)throw Error('tistory_origin_missing');
  if(!spec.cookie||(spec.id==='partners'&&!spec.token))throw Error('credentials_missing');
  const r=await fetchImpl(spec.url,{headers:{cookie:spec.cookie,accept:'application/json',...(spec.token?{'x-token':spec.token,lang:'ko'}:{})},redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(r.status!==200||!r.headers.get('content-type')?.includes('json'))throw Error('http_or_mime_failure_'+r.status);
  const text=await r.text();return {status:'verified',httpStatus:r.status,responseHash:hash(text),...spec.decode(JSON.parse(text))};
 }));
 const sources=Object.fromEntries(results.map((r,i)=>[specs[i].id,r.status==='fulfilled'?r.value:{status:'unavailable',reason:/^(credentials_missing|http_or_mime_failure_\d+|partners_\w+|blog_\w+|tistory_origin_missing)$/.test(r.reason.message)?r.reason.message:'transport_or_parse_failure'}]));
 const receipt={checkedAt:now().toISOString(),status:results.every(r=>r.status==='fulfilled')?'collected':'partial',sources,articleAttributionVerified:false,limitations:['No post-specific attribution contract is verified','Reporting periods may lag collection time','Commission is reported commission, not verified net settlement','Known verification traffic must not be interpreted as reader conversion']};
 await mkdir(directory,{recursive:true});const file=resolve(join(directory,'measurement-'+uuid()+'.json'));await writeFile(file,JSON.stringify(receipt,null,2),{flag:'wx'});return {file,...receipt};
}
