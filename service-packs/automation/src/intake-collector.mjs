import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tistoryBlogOrigin} from './measurement-snapshot.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');

export function matchReviewRevision(task,comment){
 if(!comment)return {status:'not_observed',action:'reconcile-source-before-review'};
 if(String(comment.id)!==task.commentId||String(comment.entryId)!==task.postId||typeof comment.comment!=='string')throw Error('Review source mismatch');
 const hash=sha(comment.comment);
 return hash===task.bodyHash?{status:'current-revision',action:'review-in-memory'}:{status:'changed',action:'collect-current-revision-before-review'};
}

export function mergeIntake(prior,response,postIds,now=new Date().toISOString()){
 const total=typeof response?.totalCount==='string'&&/^\d+$/.test(response.totalCount)?Number(response.totalCount):response?.totalCount;
 if(!Array.isArray(response?.items)||!Number.isSafeInteger(total)||total<0)throw Error('Comment schema mismatch');
 const allowed=new Set(postIds.map(String)),records={...prior.records};let added=0,changed=0;
 for(const comment of response.items){
  if(!allowed.has(String(comment.entryId)))continue;
  if(!/^\d+$/.test(String(comment.id))||typeof comment.comment!=='string')throw Error('Comment identity or body missing');
  const key='tistory-comment-'+comment.id,bodyHash=sha(comment.comment),old=records[key];
  const parentCommentId=comment.parent==null?null:String(comment.parent);
  if(parentCommentId!==null&&!/^\d+$/.test(parentCommentId))throw Error('Comment parent identity invalid');
  if(old?.bodyHash===bodyHash){records[key]={...old,parentCommentId};continue;}
  records[key]={id:key,source:'tistory-comment',commentId:String(comment.id),postId:String(comment.entryId),parentCommentId,bodyHash,
   status:'needs_review',firstSeenAt:old?.firstSeenAt??now,lastChangedAt:now,
   priorReview:old?{status:old.status,bodyHash:old.bodyHash}:null,
   interpretation:'Incoming comment candidate; not a confirmed purchase or service order',
   rawContentPersisted:false};
  old?changed++:added++;
 }
 return {version:1,records,lastPoll:{checkedAt:now,added,changed,returnedComments:response.items.length,totalPlatformComments:total,
  coverage:'observed-default-page-only',paginationComplete:false,postedReplies:0}};
}

export async function collectIntake(directory,postIds,env=process.env,{fetchImpl=globalThis.fetch,now=()=>new Date(),uuid=randomUUID,maxPages=50}={}){
 if(!Array.isArray(postIds)||!postIds.length||postIds.some(id=>!/^[0-9]+$/.test(String(id))))throw Error('Published post IDs required');
 if(!env.TISTORY_COOKIE)throw Error('Current session required');
 const origin=tistoryBlogOrigin(env.TISTORY_BLOG_ORIGIN);if(!origin)throw Error('Current Tistory blog origin required');
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>50)throw Error('Comment page budget must be between 1 and 50');
 await mkdir(directory,{recursive:true});
 const lockPath=join(directory,'intake.lock'),lock=await open(lockPath,'wx');
 try{
  const file=join(directory,'requests.json');let prior={records:{}};
  try{prior=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  let state=prior;const seen=new Set();let expected,added=0,changed=0;
  for(let page=1;page<=maxPages;page++){
   const response=await fetchImpl(origin+'/manage/comments.json'+(page===1?'':'?page='+page),{headers:{cookie:env.TISTORY_COOKIE,accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000)});
   if(response.status!==200||!response.headers.get('content-type')?.includes('json'))throw Error('Comment transport failure');
   const data=await response.json();state=mergeIntake(state,data,postIds,now().toISOString());added+=state.lastPoll.added;changed+=state.lastPoll.changed;
   expected??=state.lastPoll.totalPlatformComments;
   let newIds=0;for(const comment of data.items){if(!/^\d+$/.test(String(comment.id)))throw Error('Comment ID missing');if(!seen.has(String(comment.id))){seen.add(String(comment.id));newIds++;}}
   const stable=expected===state.lastPoll.totalPlatformComments,complete=stable&&seen.size===expected;
   const stopReason=complete?'reported-total-reconciled':!stable?'total-changed':!newIds?'no-new-identities':page===maxPages?'budget-exhausted':null;
   state.lastPoll={...state.lastPoll,added,changed,pagesRead:page,uniqueComments:seen.size,coverage:'paginated-snapshot',paginationComplete:complete,stopReason,
    restartPolicy:'Each fresh poll scans from page 1 to catch newly inserted comments; saved candidates deduplicate repeats. Offset pagination is not a transactional snapshot.'};
   const temp=file+'.'+uuid()+'.tmp';await writeFile(temp,JSON.stringify(state,null,2));await rename(temp,file);
   if(stopReason)break;
  }
  return {file,httpStatus:200,...state.lastPoll,openCandidates:Object.values(state.records).filter(record=>record.status==='needs_review').length};
 }finally{await lock.close();await unlink(lockPath);}
}
