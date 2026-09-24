import {createHash} from 'node:crypto';
import {requestManagement, safeError} from '../lib/operations.mjs';
import {shape} from './client.mjs';

let input='';
for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>4*1024*1024)throw new Error('TISTORY_REQUEST_INVALID');}
try{
 const {url,method='GET',body}=JSON.parse(input);
 const u=new URL(url);
 if(u.origin!=='https://i-never-stop-study.tistory.com'||!u.pathname.startsWith('/manage/')||u.hash||u.username||u.password
   ||!['GET','POST','PUT','DELETE'].includes(String(method).toUpperCase())
   ||[...u.searchParams.keys()].some(key=>/token|cookie|password|secret|authorization/i.test(key)))throw Object.assign(new Error(),{code:'TISTORY_REQUEST_SCOPE'});
 if(!process.env.TISTORY_COOKIE){
  const result=await requestManagement({url:u.href,method,body});
  console.log(JSON.stringify(result));
 }else{
  let response;
  try{
   response=await fetch(u,{method,headers:{cookie:process.env.TISTORY_COOKIE,accept:'application/json','content-type':'application/json',origin:u.origin,referer:u.origin+'/manage'},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
  }catch{throw Object.assign(new Error(),{code:'TISTORY_TRANSPORT_FAILED'});}
  const bytes=Buffer.from(await response.arrayBuffer());const mime=response.headers.get('content-type')||'';
  if(response.status!==200||!mime.includes('json'))throw Object.assign(new Error(),{code:'TISTORY_API_RESPONSE_INVALID'});
  let data;
  try{data=JSON.parse(bytes.toString('utf8'));}catch{throw Object.assign(new Error(),{code:'TISTORY_JSON_INVALID'});}
  console.log(JSON.stringify({httpStatus:response.status,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),schema:shape(data),data,auth:{provider:'runtime_cookie_override',plaintextPersisted:false}}));
 }
}catch(error){console.error(JSON.stringify({ok:false,code:safeError(error)}));process.exitCode=1;}
