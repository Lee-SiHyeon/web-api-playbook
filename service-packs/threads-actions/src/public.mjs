// Ported from web-api-playbook/service-packs/threads/threads-public.mjs + threads-xhr.mjs (anonymous, read-only).
// Change from the source: the anonymous bootstrap session is kept in process memory only (no DPAPI vault here).
import {createHash} from 'node:crypto';
import {ThreadsError} from './errors.mjs';
export const ORIGIN='https://www.threads.com';
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
export const handleOK=h=>/^[A-Za-z0-9_.]{1,30}$/.test(h??'');
export const codeOK=c=>/^[A-Za-z0-9_-]{5,30}$/.test(c??'');
export const postIdOK=id=>/^\d{10,25}$/.test(String(id??''));
const stripGuard=t=>t.replace(/^for \(;;\);\s*/,'');

export function parseThreadsPayload(roots,handle){
  if(!handleOK(handle))throw new ThreadsError('THREADS_INPUT');
  const posts=new Map();
  function walk(v,depth=0){
    if(!v||typeof v!=='object'||depth>60)return;
    if(v.caption?.text&&v.user?.username===handle&&codeOK(v.code)&&Number.isFinite(v.taken_at)){
      const info=v.text_post_app_info||{};
      posts.set(v.code,{id:v.pk!=null?String(v.pk):null,code:v.code,text:String(v.caption.text),
        url:`${ORIGIN}/@${handle}/post/${v.code}`,author:handle,publishedAt:new Date(v.taken_at*1000).toISOString(),
        engagement:{likes:count(v.like_count),replies:count(info.direct_reply_count),reposts:count(info.repost_count),views:null},
        paidPartnership:v.is_paid_partnership===true});
      return; // do not promote a quoted older post into this profile feed
    }
    for(const child of Object.values(v))walk(child,depth+1);
  }
  roots.forEach(v=>walk(v));
  if(!posts.size)throw new ThreadsError('THREADS_PUBLIC_POSTS_UNAVAILABLE');
  return [...posts.values()];
}

export function decodeViews(body){
  let value;try{value=JSON.parse(stripGuard(body));}catch{throw new ThreadsError('THREADS_XHR_NOT_JSON');}
  if(value.errors?.length||value.error)throw new ThreadsError('THREADS_XHR_SERVICE_ERROR');
  const info=value.data?.media?.text_post_app_info;
  if(!info||!Object.hasOwn(info,'impression_count')||(info.impression_count!==null&&(!Number.isSafeInteger(info.impression_count)||info.impression_count<0)))throw new ThreadsError('THREADS_XHR_SCHEMA_UNVERIFIED');
  return {views:info.impression_count,availability:info.impression_count===null?'not_provided_by_server':'available'};
}

async function bounded(response,limit=3_000_000){
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw new ThreadsError('THREADS_RESPONSE_LIMIT');chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}

export function extractBootstrap(html){
  const modules=new Map();let profileContract;
  function walk(v,depth=0){
    if(!v||typeof v!=='object'||depth>60)return;
    if(Array.isArray(v)&&['LSD','SiteData'].includes(v[0]))modules.set(v[0],v[2]);
    if(v.queryName==='BarcelonaProfileThreadsTabDirectQuery'&&/^\d+$/.test(v.queryID||'')&&v.variables?.userID)profileContract={name:v.queryName,docId:v.queryID,variables:v.variables};
    for(const child of Object.values(v))walk(child,depth+1);
  }
  for(const m of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)){try{walk(JSON.parse(m[1]));}catch{}}
  return {lsd:modules.get('LSD')?.token,site:modules.get('SiteData'),profileContract};
}

async function bootstrap(handle,code,fetchImpl){
  const referer=`${ORIGIN}/@${handle}${code?'/post/'+code:''}`;
  const res=await fetchImpl(referer,{redirect:'error',headers:{accept:'text/html'},signal:AbortSignal.timeout(15000)});
  if(res.status!==200)throw new ThreadsError('THREADS_BOOTSTRAP_HTTP',res.status);
  const html=await bounded(res);
  const {lsd,site,profileContract}=extractBootstrap(html);
  const cookie=(res.headers.getSetCookie?.()||[]).find(c=>c.startsWith('csrftoken='))?.split(';')[0];
  if(!lsd||!site||!cookie)throw new ThreadsError('THREADS_BOOTSTRAP_MISSING');
  return {referer,lsd,site,cookie,csrf:cookie.slice('csrftoken='.length),profileContract};
}

// Header values below are the ones recorded in the source service pack (observed first-party values).
async function readQuery(session,contract,fetchImpl){
  const {referer,lsd,site,cookie,csrf}=session;const operation=contract.name;
  const body=new URLSearchParams({av:'0',__user:'0',__a:'1',dpr:'1',__ccg:'EXCELLENT',__comet_req:'122',
    fb_api_caller_class:'RelayModern',fb_api_req_friendly_name:operation,server_timestamps:'true',
    variables:JSON.stringify(contract.variables),doc_id:contract.docId,lsd,
    __rev:String(site.server_revision),__hs:String(site.haste_session),__hsi:String(site.hsi),
    __spin_r:String(site.__spin_r),__spin_b:String(site.__spin_b),__spin_t:String(site.__spin_t)});
  const queryPath=operation==='BarcelonaPostViewCountQuery'?'/graphql/query':'/api/graphql';
  const response=await fetchImpl(`${ORIGIN}${queryPath}`,{method:'POST',redirect:'error',body,signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/x-www-form-urlencoded',origin:ORIGIN,referer,cookie,'x-csrftoken':csrf,'x-fb-lsd':lsd,
      'x-fb-friendly-name':operation,'x-ig-app-id':'238260118697367','x-asbd-id':'359341',
      'x-bloks-version-id':'263bb7b084de88b94490949454ce63c4e3dd00f199215b85147f5da7c8ed1288',
      'x-logged-out-threads-migrated-request':'true','x-root-field-name':'fetch__XDTMediaDict'}});
  const text=await bounded(response);
  const receipt={operation,method:'POST',path:queryPath,httpStatus:response.status,bytes:Buffer.byteLength(text),
    sha256:createHash('sha256').update(text).digest('hex'),checkedAt:new Date().toISOString(),
    executionMode:'pure_http',browserUsed:false,bootstrap:'fresh_http_anonymous_csrf'};
  return {response,text,receipt};
}

export async function fetchProfilePosts(handle,limit=5,{fetchImpl=globalThis.fetch}={}){
  if(!handleOK(handle)||!Number.isInteger(limit)||limit<1||limit>30)throw new ThreadsError('THREADS_INPUT');
  const session=await bootstrap(handle,null,fetchImpl);
  if(!session.profileContract)throw new ThreadsError('THREADS_PROFILE_CONTRACT_MISSING');
  const {response,text,receipt}=await readQuery(session,session.profileContract,fetchImpl);
  if(response.status===429)throw new ThreadsError('RATE_LIMITED',receipt);
  if(!response.ok)throw new ThreadsError(`THREADS_HTTP_${response.status}`,receipt);
  let payload;try{payload=JSON.parse(stripGuard(text));}catch{throw new ThreadsError('THREADS_XHR_NOT_JSON',receipt);}
  if(payload.error||payload.errors?.length||!payload.data)throw new ThreadsError('THREADS_XHR_SERVICE_ERROR',receipt);
  const items=parseThreadsPayload([payload.data],handle).slice(0,limit);
  return {items,receipt:{...receipt,observedItems:items.length,fullTimeline:false},fullTimeline:false};
}

export async function fetchViews({handle,code,postId},{fetchImpl=globalThis.fetch}={}){
  if(!handleOK(handle)||!codeOK(code)||!postIdOK(postId))throw new ThreadsError('THREADS_INPUT');
  const session=await bootstrap(handle,code,fetchImpl);
  const {response,text,receipt}=await readQuery(session,{name:'BarcelonaPostViewCountQuery',docId:'26985031937839290',variables:{postID:String(postId)}},fetchImpl);
  if(!response.ok)throw new ThreadsError(`THREADS_HTTP_${response.status}`,receipt);
  return {...decodeViews(text),receipt};
}
