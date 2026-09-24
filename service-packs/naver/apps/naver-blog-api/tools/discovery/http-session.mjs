import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { read as readApi, resolveRequest } from '../../scripts/client.mjs';
import { loadNaverCookies, storeNaverCookies } from '../../scripts/session-vault.mjs';
import { observedReadPages } from './read-pages.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,'');
const parser=fileURLToPath(new URL('./parse-html.py',import.meta.url));
const python=process.env.PYTHON || 'python';
const {identity,checkpoint}=await import('./frontier.mjs');
const jar=[];
let frontier=JSON.parse(await fs.readFile(repo+'/discovery/frontier.json','utf8'));
const navigation=JSON.parse(await fs.readFile(repo+'/discovery/stat-navigation-2026-09-13.json','utf8'));
const safeNavigation=observedReadPages([
 ...frontier.nodes.filter(n=>n.navigable&&['inspected','http_inspected'].includes(n.state)).map(n=>n.url),
 ...navigation.visits.flatMap(n=>[n.url,...(n.frames||[])])
]);
async function resumeJSON(relative,fallback){
 try{return JSON.parse(await fs.readFile(path.join(repo,relative),'utf8'));}
 catch(error){if(error.code==='ENOENT')return fallback;throw Error('Existing discovery checkpoint could not be read');}
}
const httpEvidence=await resumeJSON('evidence/http-navigation-2026-09-13.json',[]);
const resources=new Map((await resumeJSON('discovery/source-frontier.json',[])).map(asset=>[asset.url,asset]));
const memoryPages=new Map();
let ready=false;
let sessionUserAgent=null;
const cleanURL=raw=>{const u=new URL(raw);u.hash='';for(const key of [...u.searchParams.keys()])if(/token|password|cookie|secret|session|csrf|auth|email|search|keyword|query|signature|^(?:q|code|state)$/i.test(key))u.searchParams.set(key,'[redacted]');return u.href;};
const pathOnly=raw=>{const u=new URL(raw);return u.origin+u.pathname;};
async function bootstrap({fromChrome=false}={}){
 ready=false;jar.length=0;sessionUserAgent=null;
 let saved;try{saved=await loadNaverCookies();}catch(error){if(!fromChrome||process.env.NAVER_COOKIE)throw error;saved={cookies:[],provider:null};}
 if(saved.provider&&saved.cookies.length){jar.push(...saved.cookies);sessionUserAgent=saved.userAgent||null;ready=true;return {sessionInMemory:true,browserDisconnected:true,provider:saved.provider,credentialValuesReturned:false,persisted:true};}

 if(!fromChrome)throw Error('Provide NAVER_COOKIE, store a DPAPI session, or explicitly request bootstrapChrome for the authorized one-time handoff');
 const port=(await fs.readFile(path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data/DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);
 if(port[0]!=='9222')throw Error('Debug endpoint does not match confirmed port');
 const ws=new WebSocket('ws://127.0.0.1:9222'+port[1]);
 let serial=0;const pending=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('Session transfer method rejected')):p.resolve(m.result);}});
 const call=(method,params={},sid)=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Session transfer timed out'));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{reject(Error('Chrome connection approval timed out'));ws.close();},300000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',event=>{clearTimeout(timer);const code=event.error?.cause?.code||event.error?.code||'unavailable';reject(Error('Chrome connection failed; transport code: '+code));},{once:true});});
 try{
  const targets=await call('Target.getTargets');
  const target=targets.targetInfos.find(t=>t.type==='page'&&t.url==='https://blog.stat.naver.com/blog/average/device');
  if(!target)throw Error('Previously verified Naver statistics tab not found');
  const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  const result=await call('Network.getCookies',{urls:['https://admin.blog.naver.com/4053103','https://blog.stat.naver.com/api/blog/daily/cv']},attached.sessionId);
  for(const c of result.cookies)if(c.domain==='naver.com'||c.domain.endsWith('.naver.com'))jar.push(c);
  if(!jar.some(c=>c.name==='NID_AUT')||!jar.some(c=>c.name==='NID_SES'))throw Error('Authenticated session cookies absent');
  try{await storeNaverCookies(jar);}catch{jar.length=0;throw Error('DPAPI session storage failed');}
  await call('Target.detachFromTarget',{sessionId:attached.sessionId});
 }finally{ws.close();}
 ready=true;
 return {sessionInMemory:true,browserDisconnected:true,credentialValuesReturned:false,persisted:true,provider:'authorized_chrome_one_time_handoff'};
}
function cookieHeader(url){
 const u=new URL(url);const now=Date.now()/1000;
 return jar.filter(c=>{const domain=c.domain.replace(/^\./,'');return(u.hostname===domain||(c.domain.startsWith('.')&&u.hostname.endsWith('.'+domain)))&&u.pathname.startsWith(c.path||'/')&&(!c.secure||u.protocol==='https:')&&(c.expires===-1||c.expires>now);}).sort((a,b)=>(b.path?.length||0)-(a.path?.length||0)).map(c=>c.name+'='+c.value).join('; ');
}
function acceptCookies(response,url){
 const u=new URL(url);
 let changed=false;
 for(const header of response.headers.getSetCookie()){
  const pieces=header.split(';');const first=pieces.shift();const equal=first.indexOf('=');if(equal<1)continue;
  const c={name:first.slice(0,equal).trim(),value:first.slice(equal+1),domain:u.hostname,path:u.pathname.slice(0,u.pathname.lastIndexOf('/')+1)||'/',secure:false,expires:-1};
  let maxAge=null;
  for(const piece of pieces){const p=piece.trim();const i=p.indexOf('=');const k=(i<0?p:p.slice(0,i)).toLowerCase();const v=i<0?'':p.slice(i+1);if(k==='domain')c.domain=v.startsWith('.')?v:'.'+v;if(k==='path')c.path=v;if(k==='secure')c.secure=true;if(k==='expires'&&Number.isFinite(Date.parse(v)))c.expires=Date.parse(v)/1000;if(k==='max-age'&&/^-?\d+$/.test(v))maxAge=Number(v);}
  if(maxAge!==null)c.expires=maxAge<=0?0:Date.now()/1000+maxAge;
  const domain=c.domain.replace(/^\./,'');if(u.hostname!==domain&&!u.hostname.endsWith('.'+domain))continue;
  const old=jar.findIndex(x=>x.name===c.name&&x.domain===c.domain&&x.path===c.path);if(old>=0){jar.splice(old,1);changed=true;}if(c.expires===-1||c.expires>Date.now()/1000){jar.push(c);changed=true;}
 }
 return changed;
}
async function fetchRead(url){
 if(!ready)throw Error('In-memory authenticated session not initialized');
 const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw Error('Unsupported target URL');
 const isApp=['admin.blog.naver.com','blog.stat.naver.com'].includes(u.hostname);
 if(!isApp&&!resources.has(url))throw Error('Asset URL was not observed');
 if(isApp&&u.searchParams.has('blogId')&&u.searchParams.getAll('blogId').some(v=>v!=='4053103'))throw Error('Different blog actor');
 const response=await fetch(url,{method:'GET',redirect:'manual',headers:{accept:'text/html,application/json,application/javascript;q=0.9,*/*;q=0.1',...(isApp&&cookieHeader(url)?{cookie:cookieHeader(url),...(sessionUserAgent?{'user-agent':sessionUserAgent}:{})}:{}),referer:'https://admin.blog.naver.com/4053103'},signal:AbortSignal.timeout(20000)});
 if(isApp&&acceptCookies(response,url)){try{await storeNaverCookies(jar,{allowIncomplete:true,userAgent:sessionUserAgent});}catch{jar.length=0;ready=false;throw Error('DPAPI session rotation storage failed');}}
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw Error('Response exceeds read budget');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);const mime=response.headers.get('content-type')||'';
 const charset=/charset=([^;]+)/i.exec(mime)?.[1]?.trim().toLowerCase();
 const body=new TextDecoder(['ms949','ks_c_5601-1987'].includes(charset)?'euc-kr':charset||'utf-8').decode(bytes);
 const loginHTML=mime.includes('html')&&bytes.length<5000&&body.includes('nid.naver.com/nidlogin.login');
 const evidence={url:cleanURL(url),method:'GET',httpStatus:response.status,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),checkedAt:new Date().toISOString(),source:'independent_HTTP',loginHTML,redirect:response.headers.get('location')?pathOnly(new URL(response.headers.get('location'),url).href):null};
 return {body,evidence};
}
async function parseHtml(url,body){
 return await new Promise((resolve,reject)=>{
  const parserEnv=Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));parserEnv.PYTHONIOENCODING='utf-8';const child=spawn(python,[parser],{env:parserEnv,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';
  child.stdout.on('data',c=>out+=c);child.once('error',()=>reject(Error('HTML parser failed to start')));child.once('close',code=>{try{if(code)throw Error();resolve(JSON.parse(out));}catch{reject(Error('HTML parser failed'));}});child.stdin.end(JSON.stringify({url,body}));
 });
}
function addEdge(parent,url,type){
 if(!url||url.startsWith('javascript:'))return;
 // Preserve sensitive links as redacted candidates, never executable requests.
 let id,clean,redacted;try{clean=cleanURL(url);redacted=clean!==new URL(url).href.split('#')[0];id=redacted?{id:createHash('sha256').update(clean).digest('hex').slice(0,24),url:clean,navigable:false,reason:'redacted_query_metadata_only'}:identity(url);}catch{return;}
 if(!id.navigable&&!redacted)return;
 let child=frontier.nodes.find(n=>n.id===id.id);
 if(!child){const readOnly=!redacted&&safeNavigation(url);child={...id,aliases:[clean],incoming:[],sources:[],historicalStates:[],state:readOnly?'pending':'candidate',reason:id.reason||(readOnly?null:'operation_semantics_require_review'),depth:(parent.depth??0)+1,attempts:0,last_attempt_at:null,evidence_source:'HTTP_HTML'};frontier.nodes.push(child);}
 if(!child.incoming.includes(parent.id))child.incoming.push(parent.id);
 if(!frontier.edges.some(e=>e.from===parent.id&&e.to===child.id&&e.type===type))frontier.edges.push({from:parent.id,to:child.id,type,evidence_source:'HTTP_HTML'});
}
async function inspect(url){
 const node=frontier.nodes.find(n=>n.id===identity(url).id);
 if(!node||node.state==='mutation_excluded'||!node.navigable||!safeNavigation(url))throw Error('URL is not an observed read page; retain as a candidate for semantics review');
 const result=await fetchRead(url);const e=result.evidence;
 if(e.httpStatus===401||e.httpStatus===403||e.loginHTML){node.state=e.httpStatus===403?'blocked_permission':'blocked_auth';frontier.sharedFailureBoundary={code:'HTTP_AUTH_OR_ACCESS_FAILURE',httpStatus:e.httpStatus,loginHTML:e.loginHTML,observedAt:e.checkedAt};}
 else if(e.httpStatus!==200){node.state='blocked_http';node.reason='Unexpected HTTP status '+e.httpStatus;}
 else if(e.mime.includes('html')){
  const parsed=await parseHtml(url,result.body);memoryPages.set(url,parsed);
  for(const link of parsed.links)addEdge(node,link.url,'page_link');
  for(const frame of parsed.frames)addEdge(node,frame,'page_iframe');
  for(const script of parsed.scripts){const u=new URL(script);if(u.protocol==='https:'&&(u.hostname.endsWith('.pstatic.net')||u.hostname.endsWith('.naver.com'))&&!resources.has(script))resources.set(script,{url:cleanURL(script),parent:cleanURL(url),state:'pending',kind:'script'});}
  node.state='http_inspected';e.links=parsed.links.length;e.frames=parsed.frames.length;e.scriptAssets=parsed.scripts.length;e.formContracts=parsed.forms.map(f=>({method:f.method,action:cleanURL(f.action)}));e.fieldNames=[...new Set(parsed.fields.map(f=>f.name||f.id).filter(Boolean))];e.apiCandidates=parsed.apiCandidates.map(x=>new URL(x,url).href);e.literalDefaults=parsed.literalDefaults;
 }else{node.state='http_inspected';e.responseKind='non_html';}
 node.attempts++;node.last_attempt_at=e.checkedAt;node.evidence_source='independent_HTTP';node.httpEvidence=e;
 httpEvidence.push(e);frontier.checkedAt=e.checkedAt;
 await persist();
 return {url:e.url,httpStatus:e.httpStatus,loginHTML:e.loginHTML,bytes:e.bytes,links:e.links,frames:e.frames,apiCandidates:e.apiCandidates,literalDefaults:e.literalDefaults,state:node.state};
}
async function persist(){
 await checkpoint(repo+'/discovery/frontier.json',frontier);
 await fs.writeFile(repo+'/evidence/http-navigation-2026-09-13.json',JSON.stringify(httpEvidence,null,2)+'\n');
 await fs.writeFile(repo+'/discovery/source-frontier.json',JSON.stringify([...resources.values()],null,2)+'\n');
}
async function root(){
 const result=await inspect('https://admin.blog.naver.com/4053103');
 if(result.httpStatus===200&&!result.loginHTML&&result.links>10){frontier.sharedFailureBoundary=null;await persist();return {...result,protectedRoot:true,browserUsedForRequest:false};}
 throw Error('Protected root not verified');
}
async function scan({limit=10}={}){
 if(frontier.sharedFailureBoundary)throw Error('Shared failure boundary must be resolved by protected root verification');
 const result=[];
 for(let i=0;i<limit;i++){
  const next=frontier.nodes.filter(n=>n.navigable&&n.state==='pending').sort((a,b)=>(a.depth??0)-(b.depth??0))[0];
  if(!next)break;
  if(!safeNavigation(next.url)){next.state='candidate';next.reason='operation_semantics_require_review';await persist();result.push({url:cleanURL(next.url),state:next.state});continue;}
  try{result.push(await inspect(next.url));}catch{next.state='blocked_runtime';next.reason='Independent HTTP read or parser failed';await persist();result.push({url:next.url,state:next.state});}
  if(frontier.sharedFailureBoundary)break;
 }
 return {result,pending:frontier.nodes.filter(n=>n.state==='pending').length,candidates:frontier.nodes.filter(n=>n.state==='candidate').length,httpInspected:frontier.nodes.filter(n=>n.state==='http_inspected').length,assets:resources.size,browserNavigationCount:0};
}
async function source({limit=5}={}){
 const result=[];
 for(const asset of [...resources.values()].filter(x=>x.state==='pending').slice(0,limit)){
  try{const {body,evidence}=await fetchRead(asset.url);const candidates=[...new Set([...body.matchAll(/["'`]((?:https:\/\/blog\.stat\.naver\.com)?\/api\/blog\/[A-Za-z0-9_./-]+)["'`]/g)].map(m=>m[1]))];Object.assign(asset,{state:evidence.httpStatus===200?'inspected':'blocked_http',httpStatus:evidence.httpStatus,bytes:evidence.bytes,sha256:evidence.sha256,apiCandidates:candidates,source:'HTTP_JavaScript'});result.push({url:pathOnly(asset.url),status:evidence.httpStatus,apiCandidates:candidates});}catch{asset.state='blocked_runtime';result.push({url:pathOnly(asset.url),state:asset.state});}
 }
 await persist();return {result,pending:[...resources.values()].filter(x=>x.state==='pending').length};
}
const commands={bootstrap,bootstrapChrome:()=>bootstrap({fromChrome:true}),root,scan,source,api:async input=>{if(!ready)throw Error('Session not initialized');const request=resolveRequest(input);const result=await readApi(input,{cookie:cookieHeader(request.url.href),userAgent:sessionUserAgent});return result.evidence;},inspect:({url})=>inspect(url),status:()=>({ready,sessionInMemory:jar.length>0,browserConnected:false,httpReads:httpEvidence.length,pending:frontier.nodes.filter(n=>n.state==='pending').length,assets:resources.size}),stop:()=>{jar.length=0;ready=false;sessionUserAgent=null;return{sessionCleared:true};}};
for await(const line of createInterface({input:process.stdin})){
 let request;try{request=JSON.parse(line);if(!Object.hasOwn(commands,request.method))throw Error('Unknown command');const result=await commands[request.method](request.args);process.stdout.write(JSON.stringify({id:request.id,result})+'\n');}catch(error){process.stdout.write(JSON.stringify({id:request?.id,error:error instanceof SyntaxError?'Invalid JSON command':error.message})+'\n');}
}
