// Ported from affiliate-content-automation/src/tistory-draft.mjs (2026-10-14) into the playbook Tistory pack.
// Journal-first writes, no automatic retry of a business write, explicit ledger status states.
// Update an explicitly observed existing autosave only; never create or publish a post.
import {createHash} from 'node:crypto';
import {BLOG_ORIGIN} from '../transport.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
export async function updateExistingAutosave(input,{request:requestImpl}={}){
 if(!Number.isInteger(input.draftSequence)||input.draftSequence<=0||typeof input.title!=='string'||typeof input.content!=='string'||!input.title.trim()||!input.content.trim())throw Error('Observed draft sequence, title and content required');
 if(!requestImpl&&!process.env.TISTORY_COOKIE)throw Error('Current authorized Tistory session required');
 const url=BLOG_ORIGIN+'/manage/autosave';
 async function defaultRequest(body){
  const r=await fetch(url,{method:body?'POST':'GET',headers:{cookie:process.env.TISTORY_COOKIE,accept:'application/json','content-type':'application/json',origin:BLOG_ORIGIN,referer:BLOG_ORIGIN+'/manage/post'},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(r.status!==200||!r.headers.get('content-type')?.includes('json'))throw Error('Draft transport failure HTTP '+r.status);
  return await r.json();
 }
 const request=requestImpl??defaultRequest;
 const before=(await request()).autosavedEntry;
 if(before?.draftSequence!==input.draftSequence)throw Error('Current autosave differs from intended draft; no write performed');
 let reused=before.title===input.title&&before.content===input.content;
 if(!reused){
  const body=Object.fromEntries(['title','content','tags','categoryId','draftSequence','totalWritingTimeMs'].map(k=>[k,before[k]]));
  if(typeof body.tags!=='string'||!Number.isInteger(body.categoryId)||!Number.isFinite(body.totalWritingTimeMs))throw Error('Observed autosave schema mismatch');
  body.title=input.title;body.content=input.content;
  const result=await request(body);if(result.success!==true)throw Error('Draft write unconfirmed; read back before any retry');
 }
 const after=(await request()).autosavedEntry;
 if(after?.draftSequence!==input.draftSequence||after.title!==input.title||after.content!==input.content)throw Error('Draft readback mismatch; do not repeat automatically');
 return ({operation:'update-existing-autosave',checkedAt:new Date().toISOString(),draftSequence:after.draftSequence,titleHash:digest(after.title),contentHash:digest(after.content),contentBytes:Buffer.byteLength(after.content),readbackVerified:true,reused,publiclyPublished:false});
}
