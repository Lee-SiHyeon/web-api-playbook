// Ported from affiliate-content-automation/src/tistory-content-update.mjs (2026-10-14) into the playbook Tistory pack.
// Journal-first writes, no automatic retry of a business write, explicit ledger status states.
// Content-only update of this blog's existing post, with exact before/after checks.
import {readFile,mkdir,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {publicationRequest} from './publish-reviewed.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const metadataFields=['id','title','slogan','visibility','category','tags','published','password','acceptComment','uselessMargin','cclCommercial','cclDerive','daumLikeCategory','thumbnail','type'];
const metadataHashes=post=>Object.fromEntries(metadataFields.map(k=>[k,hash(JSON.stringify(post[k])??'undefined')]));
async function save(file,data){const tmp=file+'.'+randomUUID()+'.tmp',h=await open(tmp,'wx');try{await h.writeFile(JSON.stringify(data,null,2));await h.sync();}finally{await h.close();}await rename(tmp,file);}
export async function updateReviewedContent(root,input,{request=publicationRequest}={}){
 if(!/^\d+$/.test(String(input.postId))||!/^[a-zA-Z0-9_-]+$/.test(input.updateId)||typeof input.content!=='string'||!input.content.trim()||input.reviewedContentHash!==hash(input.content)||!/^[a-f0-9]{64}$/.test(input.expectedBeforeHash))throw Error('Reviewed content revision required');
 if(!/^data\/pilots\/[a-zA-Z0-9_-]+\.json$/.test(input.reviewEvidenceRef??''))throw Error('Review reference required');
 await readFile(join(root,input.reviewEvidenceRef));
 const dir=join(root,'data/publication-updates');await mkdir(dir,{recursive:true});
 const file=join(dir,input.updateId+'.json'),lockPath=file+'.lock',lock=await open(lockPath,'wx');
 try{
  let ledger;try{ledger=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(ledger&&(ledger.postId!==String(input.postId)||ledger.beforeHash!==input.expectedBeforeHash||ledger.afterHash!==input.reviewedContentHash))throw Error('Update identity conflict');
  async function current(){
   const response=await request('/manage/newpost/'+input.postId+'?type=post&returnURL=ENTRY');
   const line=response.raw.match(/^\s*post:\s*(\{[^\r\n]*\}),?\s*$/m);
   if(!response.mime.includes('text/html')||!line||!response.raw.includes('needCaptcha: false')||!(/postType:\s*"post"/.test(response.raw)))throw Error('Current editor context unavailable');
   const post=JSON.parse(line[1]);if(String(post.id)!==String(input.postId)||typeof post.content!=='string')throw Error('Current target mismatch');return post;
  }
  const before=await current();let changed=false;
  if(hash(before.content)!==input.reviewedContentHash){
   if(ledger)throw Error('Prior update needs reconciliation; do not resend');
   if(hash(before.content)!==input.expectedBeforeHash)throw Error('Current content changed; no write performed');
   if(!Array.isArray(before.tags)||typeof before.acceptComment==='undefined'||!['0','post'].includes(before.type)||/<(?:img|video|audio|iframe)\b/i.test(before.content+input.content))throw Error('Unsupported content-only update context');
   const payload={id:before.id,title:before.title,content:input.content,slogan:before.slogan,visibility:before.visibility,category:before.category,tag:before.tags.join(','),acceptComment:before.acceptComment,published:before.published,password:before.password,uselessMarginForEntry:before.uselessMargin,daumLike:before.daumLikeCategory,cclCommercial:before.cclCommercial,cclDerive:before.cclDerive,thumbnail:before.thumbnail,type:'post',attachments:[],recaptchaValue:'',draftSequence:null,totalWritingTimeMs:0};
   if(Object.values(payload).some(v=>v===undefined))throw Error('Incomplete current publication fields');
   ledger={postId:String(input.postId),updateId:input.updateId,beforeHash:input.expectedBeforeHash,afterHash:input.reviewedContentHash,status:'update-intended',createdAt:new Date().toISOString(),metadataHashes:metadataHashes(before)};
   await save(file,ledger);
   try{await request('/manage/post/'+input.postId+'.json',{method:'PUT',body:payload});changed=true;}
   catch(e){ledger.status='needs-reconciliation';await save(file,ledger);throw Error('Update indeterminate; do not resend');}
  }
  const after=await current();
  if(hash(after.content)!==input.reviewedContentHash)throw Error('Update readback mismatch; do not resend');
  // Verify fields controlled by the editor; platform timestamps are not input fields.
  const baseline=ledger?.metadataHashes??metadataHashes(before),observed=metadataHashes(after);
  for(const k of metadataFields)if(baseline[k]!==observed[k])throw Error('Unrelated publication field changed: '+k);
  ledger??={postId:String(input.postId),updateId:input.updateId,beforeHash:input.expectedBeforeHash,afterHash:input.reviewedContentHash,createdAt:new Date().toISOString()};
  ledger.status='readback-verified';ledger.verifiedAt=new Date().toISOString();ledger.readback={exactContentHash:true,metadataPreserved:true};await save(file,ledger);
  return {file,postId:String(input.postId),status:ledger.status,changedThisInvocation:changed,contentHash:input.reviewedContentHash};
 }finally{await lock.close();await unlink(lockPath);}
}
