import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withSessionLock } from '../../tistory-api/lib/lock.mjs';

const origins = { x: new Set(['https://x.com','https://api.x.com','https://upload.x.com']), threads: new Set(['https://www.threads.com']) };
const helper = fileURLToPath(new URL('../../naver-blog-api/scripts/secure-credential-store.ps1', import.meta.url));
const scope = new AsyncLocalStorage(), wrapped = Symbol('protectedBotDebugFetch'), keys = new Map();
const wireScope=new AsyncLocalStorage(),wireRequests=new WeakMap(),wireBodyLimit=8*1024*1024;
const rootDefault = () => path.join(process.env.LOCALAPPDATA,'affiliate-content-operations','social-bot-debug');
const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
const fail = code => Object.assign(new Error(code),{code});
export const withBotDebugScope = (onRecord, task) => scope.run({onRecord},task);

// Observe Node's actual dispatch without modifying headers, streams or retry policy.
channel('undici:client:sendHeaders').subscribe(({request,headers})=>{
  try{
    const capture=wireScope.getStore();
    if(!capture||!origins[capture.service].has(String(request?.origin)))return;
    const attempt={at:new Date().toISOString(),origin:String(request.origin),path:request.path,method:request.method,
      headers:typeof headers==='string'?headers:allHeaders(headers),chunks:[],bytes:0,capturedBytes:0,bodySent:false};
    capture.attempts.push(attempt);wireRequests.set(request,attempt);
  }catch{/* Transport observation never changes an HTTP operation. */}
});
channel('undici:request:bodyChunkSent').subscribe(({request,chunk})=>{
  try{
    const attempt=wireRequests.get(request);if(!attempt)return;
    const bytes=Buffer.from(chunk);attempt.bytes+=bytes.length;
    const size=Math.min(bytes.length,wireBodyLimit-attempt.capturedBytes);
    if(size>0){attempt.chunks.push(Buffer.from(bytes.subarray(0,size)));attempt.capturedBytes+=size;}
  }catch{}
});
channel('undici:request:bodySent').subscribe(({request})=>{const attempt=wireRequests.get(request);if(attempt)attempt.bodySent=true;});
channel('undici:request:headers').subscribe(({request,response})=>{
  try{
    const attempt=wireRequests.get(request);if(!attempt)return;
    attempt.response={statusCode:response.statusCode,headers:(response.headers||[]).map(value=>Buffer.from(value).toString('base64')),headerEncoding:'base64'};
  }catch{}
});
function wireCapture(capture){
  return {source:'node-undici-diagnostics',observed:capture.attempts.length>0,
    attempts:capture.attempts.map(({chunks,bytes,capturedBytes,bodySent,...attempt})=>({...attempt,
      body:{encoding:'base64',value:Buffer.concat(chunks).toString('base64'),bytes,capturedBytes,complete:bodySent&&bytes===capturedBytes}}))};
}

// Plaintext enters/leaves the existing CurrentUser DPAPI helper only on pipes.
function keyOperation(operation,name,input='') {
  return new Promise((resolve,reject)=>{
    const env=Object.fromEntries(['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA']
      .filter(name=>process.env[name]).map(name=>[name,process.env[name]]));
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Operation',operation,'-Name',name],
      {windowsHide:true,env,stdio:['pipe','pipe','pipe']});
    let output='',bytes=0,stage=null;
    const timer=setTimeout(()=>{child.kill();reject(fail('BOT_DEBUG_KEY_TIMEOUT'));},15_000);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>2048){child.kill();reject(fail('BOT_DEBUG_KEY_FAILED'));}else output+=chunk.toString('utf8');});
    child.stderr.on('data',chunk=>{stage=/CREDENTIAL_STORE_FAILED:([a-z_]{1,40})/.exec(chunk.toString('utf8'))?.[1]||stage;});child.stdin.on('error',()=>{});
    child.once('error',()=>{clearTimeout(timer);reject(fail('BOT_DEBUG_KEY_FAILED'));});
    child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(Object.assign(fail('BOT_DEBUG_KEY_FAILED'),{detail:{exitStatus:code,stage,operation}}));else resolve(output);});
    child.stdin.end(input);
  });
}
export async function protectedBotDebugKey(service,{root=rootDefault()}={}) {
  if(!origins[service]||process.platform!=='win32'||process.env.NODE_TEST_CONTEXT)throw fail('BOT_DEBUG_KEY_SCOPE');
  const cacheKey=root+'#'+service;
  if(!keys.has(cacheKey))keys.set(cacheKey,(async()=>{
    await mkdir(root,{recursive:true});
    return withSessionLock(async()=>{
      const name=`social-debug-${service}-key-v1`;
      let value=await keyOperation('read',name);
      if(!value){
        value=randomBytes(32).toString('base64');
        const result=await keyOperation('write',name,Buffer.from(value).toString('base64'));
        if(JSON.parse(result).stored!==true)throw fail('BOT_DEBUG_KEY_FAILED');
        if(await keyOperation('read',name)!==value)throw fail('BOT_DEBUG_KEY_FAILED');
      }
      if(!/^[A-Za-z0-9+/]{43}=$/.test(value))throw fail('BOT_DEBUG_KEY_INVALID');
      return Buffer.from(value,'base64');
    },{lockPath:path.join(root,service+'-key.lock'),timeoutMs:30_000});
  })().catch(error=>{keys.delete(cacheKey);throw error;}));
  return keys.get(cacheKey);
}
export function encryptBotDebug(record,key,{id=randomUUID(),service,now=Date.now()}={}) {
  if(!origins[service]||!validId(id)||!Buffer.isBuffer(key)||key.length!==32)throw fail('BOT_DEBUG_INPUT');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const binding=JSON.stringify({schemaVersion:1,service,id});cipher.setAAD(Buffer.from(binding));
  const payload=gzipSync(Buffer.from(JSON.stringify(record)),{level:1});
  const ciphertext=Buffer.concat([cipher.update(payload),cipher.final()]);
  return {schemaVersion:1,service,id,pid:process.pid,at:new Date(now).toISOString(),
    encryption:'AES-256-GCM; key protected by Windows DPAPI CurrentUser',compression:'gzip',
    iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
export function decryptBotDebug(envelope,key) {
  if(envelope.schemaVersion!==1||!origins[envelope.service]||!validId(envelope.id))throw fail('BOT_DEBUG_INPUT');
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify({schemaVersion:1,service:envelope.service,id:envelope.id})));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const raw=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
  return JSON.parse(gunzipSync(raw).toString('utf8'));
}
const cleanupAt=new Map();
async function cleanup(root,service,now) {
  const directory=path.join(root,service);
  if(now-(cleanupAt.get(directory)||0)<3600_000)return;
  cleanupAt.set(directory,now);
  for(const name of await readdir(directory)){
    if(!/^[0-9a-f-]{36}\.json$/.test(name))continue;
    const file=path.join(directory,name),value=await stat(file).catch(()=>null);
    if(value&&now-value.mtimeMs>7*86400_000)await unlink(file).catch(()=>{});
  }
}
export async function recordProtectedBotDebug(service,record,{id=randomUUID(),root=rootDefault(),keyProvider=protectedBotDebugKey}={}) {
  let result={id,service,recorded:false};
  try{
    const key=await keyProvider(service,{root}),envelope=encryptBotDebug(record,key,{service,id});
    const directory=path.join(root,service);await mkdir(directory,{recursive:true});
    const target=path.join(directory,id+'.json'),temporary=target+'.'+randomUUID()+'.tmp';
    try{await writeFile(temporary,JSON.stringify(envelope),{flag:'wx',mode:0o600});await rename(temporary,target);}
    finally{await unlink(temporary).catch(()=>{});}
    await cleanup(root,service,Date.now());result={id,service,recorded:true};
  }catch(error){result.code=/^[A-Z][A-Z0-9_]{1,100}$/.test(error.code||'')?error.code:'BOT_DEBUG_RECORD_FAILED';}
  try{scope.getStore()?.onRecord(result);}catch{/* Debug reporting does not change request outcomes. */}
  return result;
}
export async function readProtectedBotDebug(service,id,options={}) {
  if(!origins[service]||!validId(id))throw fail('BOT_DEBUG_INPUT');
  const root=options.root||rootDefault(),key=await (options.keyProvider||protectedBotDebugKey)(service,{root});
  return decryptBotDebug(JSON.parse(await readFile(path.join(root,service,id+'.json'),'utf8')),key);
}
function fullError(error,depth=0) {
  if(depth>4)return {causeDepthExceeded:true};
  if(!error||typeof error!=='object')return error;
  const result={name:error.name,message:error.message,stack:error.stack};
  for(const key of Object.getOwnPropertyNames(error)){
    if(['name','message','stack'].includes(key))continue;
    try{const value=error[key];result[key]=value instanceof Error?fullError(value,depth+1):value;}catch{}
  }
  return result;
}
export const recordProtectedBotError=(service,error,metadata,options)=>recordProtectedBotDebug(service,{kind:'operation_error',at:new Date().toISOString(),metadata,error:fullError(error)},options);

function allHeaders(value) {
  const headers=new Headers(value||{}),result={values:[...headers.entries()]};
  if(typeof value?.getSetCookie==='function')result.setCookie=value.getSetCookie();
  else if(typeof headers.getSetCookie==='function')result.setCookie=headers.getSetCookie();
  return result;
}
async function binaryBody(body,service,options){
  const limit=options.inlineLimit??8*1024*1024;
  const size=Buffer.isBuffer(body)||body instanceof Uint8Array?body.byteLength:body.size;
  if(size<=limit){const value=Buffer.isBuffer(body)||body instanceof Uint8Array?Buffer.from(body):Buffer.from(await body.arrayBuffer());
    return {encoding:'base64',value:value.toString('base64'),bytes:value.length,complete:true};}
  const parts=[],chunkSize=1024*1024;let bytes=0,complete=true;
  // Large media is preserved as separately encrypted chunks, never assembled
  // into one base64/JSON allocation before the network request.
  const count=Math.ceil(size/chunkSize);
  for(let index=0;index<count;index++){
    const from=index*chunkSize,to=Math.min(size,from+chunkSize);
    const value=Buffer.isBuffer(body)||body instanceof Uint8Array?Buffer.from(body.subarray(from,to)):Buffer.from(await body.slice(from,to).arrayBuffer());
    const reference=await recordProtectedBotDebug(service,{kind:'request_binary_chunk',index,encoding:'base64',value:value.toString('base64'),bytes:value.length},options);
    parts.push(reference);bytes+=value.length;if(!reference.recorded){complete=false;break;}
  }
  return {encoding:'protected_chunks',parts,bytes,size,complete:complete&&bytes===size};
}
async function requestBody(body,service,options) {
  if(body==null)return null;
  if(typeof body==='string')return {encoding:'utf8',value:body};
  if(body instanceof URLSearchParams)return {encoding:'urlencoded',value:body.toString(),entries:[...body.entries()]};
  if(body instanceof FormData)return {encoding:'multipart-values',entries:await Promise.all([...body.entries()].map(async([name,value])=>[
    name,typeof value==='string'?value:{name:value.name,type:value.type,size:value.size,...await binaryBody(value,service,options)},
  ]))};
  if(Buffer.isBuffer(body)||body instanceof Uint8Array||typeof body.arrayBuffer==='function'&&typeof body.size==='number')return binaryBody(body,service,options);
  return {type:body.constructor?.name||typeof body,captureUnavailable:true};
}
async function responseBody(response,signal,limit=8*1024*1024) {
  if(typeof response?.clone!=='function')return {captureUnavailable:true};
  const reader=response.clone().body?.getReader();if(!reader)return {encoding:'base64',value:'',complete:true};
  const chunks=[];let bytes=0,complete=false,aborted=false;
  const abort=()=>{aborted=true;void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  try{
    while(bytes<limit){const {done,value}=await reader.read();if(done){complete=!aborted;break;}const size=Math.min(value.byteLength,limit-bytes);chunks.push(Buffer.from(value.subarray(0,size)));bytes+=size;}
    if(!complete)void reader.cancel().catch(()=>{});
    return {encoding:'base64',value:Buffer.concat(chunks).toString('base64'),bytes,complete,aborted};
  }finally{signal?.removeEventListener('abort',abort);}
}
export function createBotDebugFetch(fetchImpl,{service,force=false,...options}={}) {
  if(!origins[service]||typeof fetchImpl!=='function')throw fail('BOT_DEBUG_INPUT');
  if(fetchImpl[wrapped]?.has(service)||process.env.NODE_TEST_CONTEXT&&!force)return fetchImpl;
  const result=async(rawUrl,init={})=>{
    let url;try{url=new URL(rawUrl instanceof Request?rawUrl.url:rawUrl);}catch{return fetchImpl(rawUrl,init);}
    if(!origins[service].has(url.origin))return fetchImpl(rawUrl,init);
    const id=randomUUID(),startedAt=new Date().toISOString();
    const isRequest=rawUrl instanceof Request;
    const requestSignal=init.signal!==undefined?init.signal:isRequest?rawUrl.signal:null;
    let record={kind:'http',pid:process.pid,startedAt,request:{url:url.href,method:init.method||(isRequest?rawUrl.method:'GET'),headers:allHeaders(init.headers||(isRequest?rawUrl.headers:null)),headerSource:'fetch_arguments',redirect:init.redirect||(isRequest?rawUrl.redirect:null)}};
    try{record.request.body=init.body!=null?await requestBody(init.body,service,options)
      :isRequest&&rawUrl.body?await responseBody(rawUrl,requestSignal?AbortSignal.any([requestSignal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000),options.inlineLimit??8*1024*1024):null;
    }catch(error){record.request.body={captureError:fullError(error)};}
    await recordProtectedBotDebug(service,{...record,stage:'request_prepared'},{...options,id});
    let response;const capture={service,attempts:[]};
    try{response=await wireScope.run(capture,()=>fetchImpl(rawUrl,init));}
    catch(error){await recordProtectedBotDebug(service,{...record,transport:wireCapture(capture),stage:'transport_error',finishedAt:new Date().toISOString(),error:fullError(error)},{...options,id});throw error;}
    record={...record,stage:'response_received',finishedAt:new Date().toISOString(),response:{status:response.status,url:response.url,headers:allHeaders(response.headers)}};
    const captureSignal=requestSignal?AbortSignal.any([requestSignal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000);
    try{record.response.body=await responseBody(response,captureSignal);}catch(error){record.response.body={captureError:fullError(error)};}
    record.transport=wireCapture(capture);
    const reference=await recordProtectedBotDebug(service,record,{...options,id});
    try{response.protectedDebugRecord=reference;}catch{}
    return response;
  };
  result[wrapped]=new Set([...(fetchImpl[wrapped]||[]),service]);return result;
}
