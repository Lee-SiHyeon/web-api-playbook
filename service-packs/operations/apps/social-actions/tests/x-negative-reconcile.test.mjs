import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beginJournalIntent, reconcileIntent, readXCreateJournalSlot, unresolvedJournalFiles, xNegativeReconciliation } from '../../affiliate-api-hub/scripts/sns/writers/journal.mjs';
import { reconcileReplyByReadback } from '../x-reply-reconcile.mjs';

const parentId='2100000000000000000',ownerId='2100000000000000001',text='A concise reply.';
const intentAt='2026-10-01T10:00:00.000Z',cutoffAt='2026-10-01T09:59:00.000Z';
const contentSha256=createHash('sha256').update(text).digest('hex');
const proof=(extra={})=>({outcome:'not_created_owner_timeline_proof',ownerId,parentId,contentSha256,intentAt,
  pagesRead:2,rangeStartAt:'2026-10-02T12:00:00.000Z',rangeEndAt:'2026-10-01T09:58:00.000Z',cutoffAt,
  coverageComplete:true,reachedCutoff:true,endReached:false,ownerTimelineReplyCount:0,
  parentDetailVerified:true,parentDetailReplyCount:0,proofCheckedAt:'2026-10-01T10:00:05.000Z',...extra});

async function fixture(t){
  const journalDir=await mkdtemp(path.join(tmpdir(),'x-negative-reconcile-'));t.after(()=>rm(journalDir,{recursive:true,force:true}));
  const runKey='followbot-123-'+parentId;
  const intent=await beginJournalIntent({channel:'x',runKey,journalDir,now:()=>intentAt,
    request:{method:'POST',url:'https://x.com/i/api/graphql/q/CreateTweet',postIdentity:{parentId,contentSha256},
      body:JSON.stringify({variables:{tweet_text:text,reply:{in_reply_to_tweet_id:parentId}}})}});
  await intent.result({outcome:'known_error',httpStatus:200});
  return {journalDir,runKey,intent};
}
const verifiedOwner=async()=>({owner:'lifehack__ailab',userId:ownerId,ownerVerified:true});
const emptyDetail=async()=>({owner:'lifehack__ailab',items:[{id:parentId,author:'target',replyToId:null}],fullConversation:true,nextCursor:null});
const coveredTimeline=async({cutoffAt:requested,maxPages=2})=>({owner:'lifehack__ailab',ownerId,pagesRead:Math.min(2,maxPages),rangeStartAt:'2026-10-02T12:00:00.000Z',
  rangeEndAt:'2026-10-01T09:58:00.000Z',cutoffAt:requested,reachedCutoff:true,endReached:false,coverageComplete:true,items:[]});

test('a complete negative timeline and empty parent detail leave the uncertain intent unresolved',async t=>{
  const f=await fixture(t),reads=[];let timelineOptions;
  const result=await reconcileReplyByReadback({postId:parentId,runKey:f.runKey,text,journalDir:f.journalDir,readOwner:verifiedOwner,
    readConversation:async id=>{reads.push('detail');return emptyDetail(id);},
    readOwnerTimeline:async options=>{reads.push('timeline');timelineOptions=options;return coveredTimeline(options);}});
  assert.equal(result.held,true);assert.equal(result.reconciled,0);assert.equal('notCreatedProof' in result,false);
  assert.deepEqual(reads,['detail','timeline']);
  assert.deepEqual(timelineOptions,{cutoffAt,maxPages:1});
  assert.equal((await unresolvedJournalFiles({channel:'x',runKey:f.runKey,journalDir:f.journalDir})).length,1);
  const slot=await readXCreateJournalSlot({runKey:f.runKey,journalDir:f.journalDir});
  assert.equal(slot.resolved,false);assert.equal(slot.reconciliation,null);
});

test('a legacy negative proof cannot be refreshed to release an already reconciled intent',async t=>{
  const f=await fixture(t);
  await appendFile(f.intent.file,JSON.stringify({type:'reconciled',...proof()})+'\n');
  const before=await readFile(f.intent.file,'utf8');
  const slot=await readXCreateJournalSlot({runKey:f.runKey,journalDir:f.journalDir});
  const result=await reconcileReplyByReadback({postId:parentId,runKey:f.runKey,text,journalDir:f.journalDir,allowResolved:true,
    journalIndex:0,previousProof:slot.reconciliation,readOwner:verifiedOwner,
    readConversation:emptyDetail,readOwnerTimeline:coveredTimeline});
  assert.equal(result.held,true);assert.equal(result.reconciled,0);assert.equal('notCreatedProof' in result,false);
  assert.equal(await readFile(f.intent.file,'utf8'),before);
});

test('an exact owner reply found on a partial detail page is adopted from the owner timeline',async t=>{
  const f=await fixture(t),replyId='2100000000000000010';let timelineOptions;
  const timeline=async options=>{timelineOptions=options;return {...await coveredTimeline(options),items:[
    {id:replyId,authorId:ownerId,author:'lifehack__ailab',replyToId:parentId,text,createdAt:'2026-10-01T10:00:01.000Z'}]};
  };
  const result=await reconcileReplyByReadback({postId:parentId,runKey:f.runKey,text,journalDir:f.journalDir,readOwner:verifiedOwner,
    readConversation:emptyDetail,readOwnerTimeline:timeline,
    readReply:async id=>({owner:'lifehack__ailab',tweet:{id,author:'lifehack__ailab',authorId:ownerId,replyToId:parentId,text,createdAt:'2026-10-01T10:00:01.000Z'}})});
  assert.deepEqual(result,{found:[replyId],reconciled:1,held:false});
  assert.deepEqual(timelineOptions,{cutoffAt,maxPages:1});
  assert.equal((await unresolvedJournalFiles({channel:'x',runKey:f.runKey,journalDir:f.journalDir})).length,0);
});

test('incomplete timeline coverage or an owner reply in parent detail keeps the journal held',async t=>{
  const f=await fixture(t);
  const incomplete=async options=>({...await coveredTimeline(options),coverageComplete:false});
  const result=await reconcileReplyByReadback({postId:parentId,runKey:f.runKey,text,journalDir:f.journalDir,readOwner:verifiedOwner,
    readConversation:emptyDetail,readOwnerTimeline:incomplete});
  assert.equal(result.held,true);assert.equal((await unresolvedJournalFiles({channel:'x',runKey:f.runKey,journalDir:f.journalDir})).length,1);
  const detailReply=async()=>({owner:'lifehack__ailab',items:[{id:parentId,author:'target'},{id:'2100000000000000010',author:'lifehack__ailab',replyToId:parentId}]});
  const second=await reconcileReplyByReadback({postId:parentId,runKey:f.runKey,text,journalDir:f.journalDir,readOwner:verifiedOwner,
    readConversation:detailReply,readOwnerTimeline:coveredTimeline,
    readReply:async id=>({owner:'lifehack__ailab',tweet:{id,author:'lifehack__ailab',authorId:ownerId,replyToId:parentId,text:'different reply',createdAt:'2026-10-01T10:00:03.000Z'}})});
  assert.equal(second.held,true);assert.equal((await unresolvedJournalFiles({channel:'x',runKey:f.runKey,journalDir:f.journalDir})).length,1);
});

test('an incomplete parent TweetDetail cannot contribute negative proof',async t=>{
  const f=await fixture(t);
  const detail=async()=>({...await emptyDetail(),fullConversation:false,nextCursor:'older'});
  const result=await reconcileReplyByReadback({postId:parentId,runKey:f.runKey,text,journalDir:f.journalDir,readOwner:verifiedOwner,
    readConversation:detail,readOwnerTimeline:coveredTimeline});
  assert.equal(result.held,true);
  assert.equal((await unresolvedJournalFiles({channel:'x',runKey:f.runKey,journalDir:f.journalDir})).length,1);
});

test('journal validator rejects incomplete or identity-mismatched negative evidence',async t=>{
  const f=await fixture(t);
  assert.equal(xNegativeReconciliation({type:'reconciled',...proof()}),false);
  assert.equal(xNegativeReconciliation({type:'reconciled',...proof({coverageComplete:false})}),false);
  await assert.rejects(reconcileIntent({file:f.intent.file,result:proof({coverageComplete:false})}),{code:'SNS_X_RECONCILIATION_POSITIVE_REQUIRED'});
  await assert.rejects(reconcileIntent({file:f.intent.file,result:proof({parentId:'2100000000000000099'})}),{code:'SNS_X_RECONCILIATION_POSITIVE_REQUIRED'});
  assert.equal((await unresolvedJournalFiles({channel:'x',runKey:f.runKey,journalDir:f.journalDir})).length,1);
});
