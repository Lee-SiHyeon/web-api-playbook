// Ported from affiliate-content-automation/src/tistory-publish.mjs (2026-10-14) into the playbook Tistory pack.
// Journal-first writes, no automatic retry of a business write, explicit ledger status states.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {parsePublicationContext} from './publication-context.mjs';
import {BLOG_ORIGIN as origin} from '../transport.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
async function save(file,data){const tmp=file+'.'+randomUUID()+'.tmp';const h=await open(tmp,'wx');try{await h.writeFile(JSON.stringify(data,null,2));await h.sync();}finally{await h.close();}await rename(tmp,file);}
async function optional(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function postId(url){const u=new URL(url);if(u.origin!==origin||!/^\/\d+$/.test(u.pathname)||u.search||u.hash)throw Error('Unexpected publication target');return u.pathname.slice(1);}
export async function publicationRequest(path,{method='GET',body,authenticated=true}={}){
 if(authenticated&&!process.env.TISTORY_COOKIE)throw Error('Current Tistory session required');
 const r=await fetch(origin+path,{method,headers:{accept:'*/*',...(authenticated?{cookie:process.env.TISTORY_COOKIE}:{}),...(body?{'content-type':'application/json',origin,referer:origin+'/manage/post'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.timeout(20000)});
 const raw=await r.text();if(r.status!==200)throw Error('Publication HTTP '+r.status);
 return {httpStatus:r.status,mime:r.headers.get('content-type')??'',raw};
}
function json(response){if(!response.mime.includes('json'))throw Error('Expected publication JSON');return JSON.parse(response.raw);}
// inspectPublication(html, expected) -> {status, missing[]} is consumer-supplied (public marker policy).
export async function publishReviewed(root,input,{request=publicationRequest,inspectPublication}={}){
 if(typeof inspectPublication!=='function')throw Error('inspectPublication dependency required');
 const p=input.payload;
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(input.contentId)||typeof p?.title!=='string'||!p.title.trim()||typeof p.content!=='string'||!p.content.trim())throw Error('Reviewed publication input required');
 if(input.reviewedContentHash!==hash(p.content)||!/^data\/pilots\/[a-zA-Z0-9_-]+\.json$/.test(input.reviewEvidenceRef??''))throw Error('Reviewed revision evidence required');
 if(p.id!=='0'||p.visibility!==20||p.published!==1||!Number.isSafeInteger(p.category)||p.category<=0||p.type!=='post'||p.recaptchaValue!==''||!Array.isArray(p.attachments)||p.attachments.length)throw Error('Unsupported captured publication shape');
 const fields=['id','title','content','visibility','category','tag','published','uselessMarginForEntry','cclCommercial','cclDerive','type','attachments','recaptchaValue','draftSequence','totalWritingTimeMs'];
 if(Object.keys(p).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(p,k))||typeof p.tag!=='string'||![0,1].includes(p.uselessMarginForEntry)||![0,1].includes(p.cclCommercial)||![0,1].includes(p.cclDerive)||(p.draftSequence!==null&&(!Number.isSafeInteger(p.draftSequence)||p.draftSequence<=0))||!Number.isFinite(p.totalWritingTimeMs)||p.totalWritingTimeMs<0)throw Error('Incomplete or unsupported observed payload profile');
 if(input.expected?.title!==p.title||inspectPublication(p.content,input.expected).missing.some(x=>x!=='title'))throw Error('Expected public markers mismatch');
 // The referenced editorial review must exist; its substantive adequacy and authorization remain agent responsibilities.
 await readFile(join(root,input.reviewEvidenceRef));
 const directory=join(root,'data/publications');await mkdir(directory,{recursive:true});
 const file=join(directory,input.contentId+'.json');const lockPath=file+'.lock';const lock=await open(lockPath,'wx');
 try{
  let createdThisInvocation=false;
  const contentHash=hash(p.content),payloadHash=hash(JSON.stringify(p));
  let ledger=await optional(file);
  if(ledger&&(ledger.contentHash!==contentHash||ledger.payloadHash!==payloadHash))throw Error('Published identity has a different revision; use separately verified update workflow');
  if(!ledger){
   const knowledge=await optional(join(root,'knowledge-index.json'));
   const known=(knowledge?.records??[]).filter(r=>r.type==='public-post-readback'&&r.status==='published'&&r.contentId===input.contentId);
   let prior;
   if(input.priorIntentRef){
    if(!/^data\/pilots\/[a-zA-Z0-9_-]+\.json$/.test(input.priorIntentRef))throw Error('Invalid prior publication reference');
    prior=await optional(join(root,input.priorIntentRef));
    if(!prior||prior.contentId!==input.contentId||prior.contentHash!==contentHash||prior.title!==p.title||prior.category!==p.category||prior.visibility!==p.visibility)throw Error('Historical publication identity mismatch');
   }
   if(known.length&&(!prior?.entryUrl||known.some(r=>r.url!==prior.entryUrl)))throw Error('Existing publication requires reconciliation; no create allowed');
   if(prior&&!prior.entryUrl)throw Error('Prior creation is indeterminate; no create allowed');
   if(prior)postId(prior.entryUrl);
   ledger={contentId:input.contentId,contentHash,payloadHash,titleHash:hash(p.title),category:p.category,attemptId:randomUUID(),createdAt:new Date().toISOString(),status:prior?'create-acknowledged':'create-intended',entryUrl:prior?.entryUrl??null,importedHistorical:!!prior};
   if(!prior){
    const contextResponse=await request('/manage/newpost/?type=post&returnURL=%2Fmanage%2Fposts%2F');
    if(!contextResponse.mime.includes('text/html'))throw Error('Editor context unavailable');
    const context=parsePublicationContext(contextResponse.raw);
    if(context.needCaptcha||!context.categories.some(c=>c.id===p.category&&c.visibility===20))throw Error('Current publication context requires review');
   }
   await save(file,ledger); // Once this exists, a later invocation may only reconcile/read.
   if(!prior){
    try{
     const result=json(await request('/manage/post.json',{method:'POST',body:p}));
     postId(result.entryUrl);ledger.entryUrl=result.entryUrl;ledger.status='create-acknowledged';ledger.acknowledgedAt=new Date().toISOString();await save(file,ledger);createdThisInvocation=true;
    }catch(e){ledger.status='needs-reconciliation';ledger.failureClass=e.code??e.name;await save(file,ledger);throw Error('Creation indeterminate; reconcile before further action');}
   }
  }
  if(!ledger.entryUrl)throw Error('Creation indeterminate; do not resend POST');
  const id=postId(ledger.entryUrl);
  const rows=json(await request('/manage/posts.json'));
  if(!Array.isArray(rows.items))throw Error('Management readback schema changed');
  const row=rows.items.find(r=>String(r.id)===id);
  if(!row||row.title!==p.title||row.visibility!=='PUBLIC'||String(row.categoryId)!==String(p.category))throw Error('Management readback unconfirmed; absence is not permission to recreate');
  const page=await request('/'+id,{authenticated:false});
  const markers=page.mime.includes('text/html')?inspectPublication(page.raw,input.expected):{status:'unavailable'};
  if(markers.status!=='content-markers-present')throw Error('Public readback unconfirmed; do not recreate');
  ledger.status='readback-verified';ledger.verifiedAt=new Date().toISOString();
  ledger.readback={postId:id,management:{titleMatches:true,visibility:'PUBLIC',categoryId:String(row.categoryId)},public:{httpStatus:page.httpStatus,responseHash:hash(page.raw),markersVerified:true,exactBodyEqualityVerified:false},verificationTraffic:true};
  ledger.monitoring={title:p.title,disclosure:input.expected.disclosure,links:input.expected.links,...(input.priceInput?{priceInput:input.priceInput}:{})};
  await save(file,ledger);
  return {file,status:'readback-verified',entryUrl:ledger.entryUrl,reused:!createdThisInvocation,createdThisInvocation,contentHash,readback:ledger.readback};
 }finally{await lock.close();await unlink(lockPath);}
}
