import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {requestManagement, safeError} from '../lib/operations.mjs';

const origin='https://i-never-stop-study.tistory.com';
export const operations={
  count:'/manage/v2/statistics/blog/count',
  trend:'/manage/v2/statistics/dashboard/trend',
  top:'/manage/statistics/dashboard/topEntry.json',
  inflow:'/manage/statistics/dashboard/inflow.json',
  keyword:'/manage/statistics/dashboard/keyword.json',
  recent:'/manage/statistics/dashboard/recentEntry.json'
};
export function shape(v){
  if(v===null)return 'null';
  if(Array.isArray(v))return {type:'array',length:v.length,item:v.length?shape(v[0]):null};
  if(typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,shape(x)]));
  return typeof v;
}
export async function read(operation,{cookie=process.env.TISTORY_COOKIE}={}){
  if(!Object.hasOwn(operations,operation))throw Object.assign(new Error(),{code:'TISTORY_OPERATION_INVALID'});
  if(!cookie){
    const result=await requestManagement({url:origin+operations[operation],method:'GET'});
    return {data:result.data,evidence:{operation,status:result.httpStatus,mime:result.mime,bytes:result.bytes,sha256:result.sha256,schema:result.schema,auth:result.auth}};
  }
  let response;
  try {
    response=await fetch(origin+operations[operation],{headers:{cookie,accept:'application/json',referer:origin+'/manage'},redirect:'manual',signal:AbortSignal.timeout(20000)});
  } catch { throw Object.assign(new Error(),{code:'TISTORY_TRANSPORT_FAILED'}); }
  const bytes=Buffer.from(await response.arrayBuffer());
  const mime=response.headers.get('content-type')||'';
  if(response.status!==200||!mime.includes('json'))throw Object.assign(new Error(),{code:'TISTORY_API_RESPONSE_INVALID'});
  let data;
  try { data=JSON.parse(bytes.toString('utf8')); }
  catch { throw Object.assign(new Error(),{code:'TISTORY_JSON_INVALID'}); }
  return {data,evidence:{operation,status:response.status,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),schema:shape(data),auth:{provider:'runtime_cookie_override',plaintextPersisted:false}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const result=await read(process.argv[2]||'count');console.log(JSON.stringify(process.argv.includes('--data')?result.data:result.evidence,null,2));}
  catch(error){console.error(JSON.stringify({ok:false,code:safeError(error)}));process.exitCode=1;}
}
