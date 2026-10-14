// Ported from affiliate-content-automation/src/tistory-private-comment.mjs (2026-10-14) into the playbook Tistory pack.
// Journal-first writes, no automatic retry of a business write, explicit ledger status states.
// Observed private owner root comments and first-level replies; no customer-send policy.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {BLOG_ORIGIN} from '../transport.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
// Raw records stay in memory for exact revision reconciliation.
export async function readOwnerComments(cookie,{fetchImpl=fetch,maxPages=50}={}){
 if(!cookie||!Number.isInteger(maxPages)||maxPages<1||maxPages>50)throw Error('Current session and bounded page budget required');
 const records=new Map();let expected;
 for(let page=1;page<=maxPages;page++){
  const response=await fetchImpl(BLOG_ORIGIN+'/manage/comments.json'+(page===1?'':'?page='+page),{headers:{Cookie:cookie,Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(response.status!==200||!response.headers.get('content-type')?.includes('json'))throw Error('Independent comment read failed');
  const data=await response.json(),total=typeof data.totalCount==='string'&&/^\d+$/.test(data.totalCount)?Number(data.totalCount):data.totalCount;
  if(!Array.isArray(data.items)||!Number.isSafeInteger(total)||total<0)throw Error('Comment snapshot schema mismatch');
  expected??=total;if(total!==expected)throw Error('Comment total changed during snapshot');
  const before=records.size;
  for(const row of data.items){
   if(!/^\d+$/.test(String(row.id))||!/^\d+$/.test(String(row.entryId))||typeof row.comment!=='string')throw Error('Comment snapshot identity missing');
   const key=String(row.id),old=records.get(key);
   if(old&&(old.comment!==row.comment||String(old.entryId)!==String(row.entryId)||old.secret!==row.secret))throw Error('Comment changed during snapshot');
   records.set(key,row);
  }
  if(records.size===expected)return {complete:true,items:[...records.values()],pagesRead:page,total:expected,consistency:'Stable observed total and unique IDs; offset pagination is not transactional'};
  if(records.size>expected||records.size===before)throw Error('Comment pagination stalled or total mismatched');
 }
 throw Error('Comment snapshot budget exhausted');
}
async function save(file,value){
 const temp=file+'.'+randomUUID()+'.tmp',handle=await open(temp,'wx');
 try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
 await rename(temp,file);
}
export function ownerCommentRequest(cookie){
 if(!cookie)throw Error('Current owner session required');
 return async(path,{method,body})=>{
  if(!/^\/m\/api\/\d+\/comment(?:\/\d+)?$/.test(path))throw Error('Unsupported comment path');
  const response=await fetch(BLOG_ORIGIN+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Origin:BLOG_ORIGIN,Referer:BLOG_ORIGIN+'/'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(response.status!==200||!response.headers.get('content-type')?.includes('json'))throw Error('Comment request not verified');
  await response.json();return {httpStatus:200};
 };
}
export async function createPrivateOwnerComment(root,input,deps){
 if(input.payload?.parent!==null)throw Error('Private root-comment identity required');
 return createPrivateComment(root,input,deps);
}
export async function createPrivateOwnerReply(root,input,deps){
 if(!Number.isSafeInteger(input.payload?.parent)||input.payload.parent<=0||!/^[a-f0-9]{64}$/.test(input.parentBodyHash??''))throw Error('Exact reviewed parent revision required');
 return createPrivateComment(root,input,deps);
}
async function createPrivateComment(root,input,{request,readComments}){
 const {operationId,postId,payload}=input;
 if(!/^[a-zA-Z0-9_-]+$/.test(operationId)||!/^\d+$/.test(String(postId))||!payload||payload.isSecret!==true||payload.mentionId!==null||!payload.comment?.trim())throw Error('Private comment identity required');
 for(const key of ['captcha','comment','homepage','name','password'])if(typeof payload[key]!=='string')throw Error('Observed owner fields required');
 if(Object.keys(payload).sort().join(',')!=='captcha,comment,homepage,isSecret,mentionId,name,parent,password')throw Error('Unobserved payload fields');
 const dir=join(root,'data/intake/mutations');await mkdir(dir,{recursive:true});
 const file=join(dir,operationId+'.json'),lockPath=file+'.lock',lock=await open(lockPath,'wx');
 try{
  let ledger;try{ledger=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const bodyHash=sha(payload.comment);
  const parentId=payload.parent===null?null:String(payload.parent),parentBodyHash=parentId===null?null:input.parentBodyHash;
  if(ledger&&(ledger.postId!==String(postId)||ledger.bodyHash!==bodyHash||(ledger.parentId??null)!==parentId||(ledger.parentBodyHash??null)!==parentBodyHash))throw Error('Operation identity conflict');
  async function observed(){
   const snapshot=await readComments();
   if(snapshot.complete!==true||!Array.isArray(snapshot.items))throw Error('Complete independent comment snapshot required');
   if(parentId!==null){
    const parents=snapshot.items.filter(c=>String(c.id)===parentId&&String(c.entryId)===String(postId));
    if(parents.length!==1||typeof parents[0].comment!=='string'||sha(parents[0].comment)!==parentBodyHash||parents[0].parent!=null)throw Error('Parent missing, changed, or not a root comment');
   }
   return snapshot.items.filter(c=>String(c.entryId)===String(postId)&&(c.parent==null?null:String(c.parent))===parentId&&typeof c.comment==='string'&&sha(c.comment)===bodyHash&&c.secret===true);
  }
  const before=await observed();
  if(!ledger){
   if(before.length)throw Error('Matching comment predates this operation');
   ledger={operationId,postId:String(postId),bodyHash,parentId,parentBodyHash,status:'create-intended',createdAt:new Date().toISOString()};await save(file,ledger);
   try{await request('/m/api/'+postId+'/comment',{method:'POST',body:payload});}catch{ledger.status='needs-reconciliation';await save(file,ledger);}
  }
  const matches=await observed();
  if(matches.length!==1||!/^\d+$/.test(String(matches[0].id)))throw Error('Creation unresolved; do not resend');
  if(ledger.commentId&&ledger.commentId!==String(matches[0].id))throw Error('Comment identity changed');
  ledger={...ledger,commentId:String(matches[0].id),status:'readback-verified',verifiedAt:new Date().toISOString()};await save(file,ledger);
  return {file,...ledger};
 }finally{await lock.close();await unlink(lockPath);}
}
