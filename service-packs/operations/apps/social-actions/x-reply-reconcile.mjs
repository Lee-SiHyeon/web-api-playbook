import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectConversation } from './x-conversation.mjs';
import { inspectTweet } from './x-reactions.mjs';
import { inspectXOwner } from './providers/x.mjs';
import { readOwnerRepliesBefore } from './x-owner-replies.mjs';
import { replyTextMatches } from '../affiliate-api-hub/scripts/sns/writers/x-reply-readback.mjs';
import { reconcileIntent, unresolvedJournalFiles, readXCreateJournalSlot, xNegativeReconciliation } from '../affiliate-api-hub/scripts/sns/writers/journal.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function emptyCreateResult(error){
  const d=error?.detail;
  return error?.code==='X_CREATE_SCHEMA'&&d?.dataType==='object'&&d.createType==='object'
    &&d.resultType==='undefined'&&d.errorCount===0&&d.createKeys?.includes('tweet_results');
}
export function retryableCreate200(error){
  return emptyCreateResult(error)||error?.code==='SERVICE_ERROR'&&error.receipt?.operation==='CreateTweet'
    &&Number(error.receipt.status??error.receipt.httpStatus)===200;
}
export async function ownerRepliesTo(postId,{readConversation=inspectConversation}={}){
  const conversation=await readConversation(postId);
  if(!conversation.items.some(item=>item.id===postId))fail('X_REPLY_READBACK_FOCAL_MISSING');
  const owner=String(conversation.owner||'').toLowerCase();if(!owner)fail('X_REPLY_READBACK_OWNER_MISSING');
  return conversation.items.filter(item=>item.author?.toLowerCase()===owner&&item.replyToId===postId).map(item=>item.id);
}
export async function reconcileReplyByReadback({postId,runKey,text,expectedOwner='lifehack__ailab',
  readConversation=inspectConversation,readReply=inspectTweet,readOwner=inspectXOwner,
  readOwnerTimeline=readOwnerRepliesBefore,journalDir,allowResolved=false,journalIndex=0,previousProof}={}){
  if(!/^\d{1,25}$/.test(postId||'')||typeof text!=='string'||!text.trim())fail('X_REPLY_RECONCILIATION_INPUT');
  const files=await unresolvedJournalFiles({channel:'x',runKey,...(journalDir?{journalDir}:{})});
  let file, resolved=false, priorReconciliation=null;
  if(allowResolved){
    if(files.length)return {found:[],reconciled:0,held:true};
    const slot=await readXCreateJournalSlot({runKey,index:journalIndex,...(journalDir?{journalDir}:{})});
    if(!slot?.resolved||!xNegativeReconciliation(slot.reconciliation)||!xNegativeReconciliation(previousProof)
      ||slot.reconciliation.proofCheckedAt!==previousProof.proofCheckedAt)return {found:[],reconciled:0,held:true};
    file=slot.file;resolved=true;priorReconciliation=slot.reconciliation;
  }else{
    if(files.length!==1)return {found:[],reconciled:0,held:true};
    file=files[0];
  }
  const events=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse),intent=events.find(event=>event.type==='intent');
  const contentSha256=createHash('sha256').update(text).digest('hex'),identity=intent?.request?.postIdentity;
  // A legacy run key proves the parent only. A caller's current draft cannot
  // establish the content of the original dispatched request.
  if(!identity)return {found:[],reconciled:0,held:true};
  if(identity.parentId!==postId||identity.contentSha256!==contentSha256)fail('X_REPLY_RECONCILIATION_SCOPE');
  if(allowResolved&&(!identity||priorReconciliation.parentId!==postId||priorReconciliation.contentSha256!==contentSha256
    ||Date.parse(priorReconciliation.intentAt)!==Date.parse(intent.at)))return {found:[],reconciled:0,held:true};
  const startedAt=Date.parse(intent.at);if(!Number.isFinite(startedAt))fail('X_REPLY_RECONCILIATION_TIME');
  const response=events.find(event=>event.type==='result'),responseAt=Date.parse(response?.at||'');
  if(!Number.isFinite(responseAt)||responseAt<startedAt||response.httpStatus!==200
    ||!['response','known_error'].includes(response.outcome))return {found:[],reconciled:0,held:true};
  const conversation=await readConversation(postId);
  if(conversation.owner?.toLowerCase()!==expectedOwner.toLowerCase()||!Array.isArray(conversation.items)
    ||!conversation.items.some(item=>item.id===postId))fail('X_REPLY_READBACK_OWNER_MISSING');
  const candidates=conversation.items.filter(item=>item.author?.toLowerCase()===expectedOwner.toLowerCase()&&item.replyToId===postId);
  const owner=await readOwner();
  if(owner.ownerVerified!==true||owner.owner?.toLowerCase()!==expectedOwner.toLowerCase()||!/^\d{1,25}$/.test(owner.userId||''))fail('X_REPLY_READBACK_OWNER_MISSING');
  const verifyCandidates=async rows=>{
    const found=[];
    for(const candidate of rows){
      if(!/^\d{1,25}$/.test(candidate?.id||''))continue;
      const readback=await readReply(candidate.id),reply=readback.tweet,date=Date.parse(reply?.createdAt);
      if(readback.owner?.toLowerCase()===expectedOwner.toLowerCase()&&reply?.id===candidate.id
        &&reply.author?.toLowerCase()===expectedOwner.toLowerCase()&&reply.authorId===owner.userId
        &&Number.isFinite(date)&&date>=startedAt-1000&&date<=responseAt+30_000
        &&replyTextMatches({text:reply.text,parentId:reply.replyToId},text,postId))found.push(reply.id);
    }
    return [...new Set(found)];
  };
  const storePositive=async found=>{
    if(found.length!==1)return {found:[],reconciled:0,held:true};
    if(!resolved)await reconcileIntent({file,result:{outcome:'created_found_by_owner_readback',postId:found[0],parentId:postId,
      ownerId:owner.userId,contentSha256,readbackVerified:true}});
    return {found,reconciled:resolved?0:1,held:false};
  };

  // Keep the original exact, complete TweetDetail readback as the first positive path.
  if(conversation.fullConversation===true&&!conversation.nextCursor&&candidates.length){
    const found=await verifyCandidates(candidates);
    if(found.length===1)return storePositive(found);
  }

  const cutoffAt=new Date(startedAt-60_000).toISOString();
  // The immediate recovery path needs only a recent positive match. An empty
  // page remains held, so deep history adds lock time without proving failure.
  const timeline=await readOwnerTimeline({cutoffAt,maxPages:1});
  if(timeline.owner?.toLowerCase()!==expectedOwner.toLowerCase()||timeline.ownerId!==owner.userId
    ||!Array.isArray(timeline.items)||Date.parse(timeline.cutoffAt)!==Date.parse(cutoffAt))return {found:[],reconciled:0,held:true};
  const timelineCandidates=timeline.items.filter(item=>item.replyToId===postId);
  const completeDetail=conversation.fullConversation===true&&!conversation.nextCursor;
  const allCandidates=[...new Map([...(completeDetail?candidates:[]),...timelineCandidates].map(item=>[item.id,item])).values()];
  if(allCandidates.length){
    if(allCandidates.length>20)return {found:[],reconciled:0,held:true};
    const found=await verifyCandidates(allCandidates);
    if(found.length===1)return storePositive(found);
    return {found:[],reconciled:0,held:true};
  }
  // An empty timeline or parent detail cannot prove an uncertain CreateTweet
  // was never applied. Only a positively verified exact owner reply may
  // resolve this journal; absence always leaves it held for reconciliation.
  return {found:[],reconciled:0,held:true};
}
