import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beginJournalIntent, unresolvedJournalFiles, readXCreateJournalSlot } from '../../affiliate-api-hub/scripts/sns/writers/journal.mjs';
import { reconcileReplyByReadback } from '../x-reply-reconcile.mjs';
const at='2026-09-30T10:00:00.000Z';
async function fixture(t,{legacy=false}={}){
 const journalDir=await mkdtemp(path.join(tmpdir(),'x-positive-reconcile-'));t.after(()=>rm(journalDir,{recursive:true,force:true}));
 const runKey='followbot-123-100',intent=await beginJournalIntent({channel:'x',runKey,journalDir,now:()=>at,
  request:{method:'POST',url:'https://x.com/i/api/graphql/q/CreateTweet',
    body:legacy?'{}':JSON.stringify({variables:{tweet_text:'Saved draft.',reply:{in_reply_to_tweet_id:'100'}}})}});
 await intent.result({outcome:'known_error',httpStatus:200});
 const input={postId:'100',runKey,journalDir,text:'Saved draft.',expectedOwner:'owner',
  readOwner:async()=>({owner:'owner',userId:'2',ownerVerified:true}),
  readConversation:async()=>({owner:'owner',fullConversation:true,items:[{id:'100',author:'target'},{id:'200',author:'owner',replyToId:'100'}]}),
  readOwnerTimeline:async({cutoffAt})=>({owner:'owner',ownerId:'2',pagesRead:1,rangeStartAt:'2026-09-30T10:03:00.000Z',
    rangeEndAt:'2026-09-30T09:58:00.000Z',cutoffAt,reachedCutoff:true,endReached:false,coverageComplete:true,items:[]}),
  readReply:async id=>({owner:'owner',tweet:{id,author:'owner',authorId:'2',replyToId:'100',text:'Saved draft.',createdAt:'2026-09-30T10:00:01.000Z'}})};
 return {input,intent};
}
test('independent exact owner ID, parent, text and creation time resolve only the matching persisted intent',async t=>{
 const {input,intent}=await fixture(t);
 await appendFile(intent.file,JSON.stringify({type:'reconciled',outcome:'no_visible_reply'})+'\n');
 const result=await reconcileReplyByReadback(input);assert.deepEqual(result,{found:['200'],reconciled:1,held:false});
 assert.equal((await unresolvedJournalFiles({channel:'x',runKey:input.runKey,journalDir:input.journalDir})).length,0);
 const slot=await readXCreateJournalSlot({...input,index:0});assert.equal(slot.postId,'200');assert.equal(slot.resolved,true);
});

test('legacy intents without persisted request content remain held without readback or journal mutation',async t=>{
 const {input,intent}=await fixture(t,{legacy:true});
 const before=await readFile(intent.file,'utf8');
 for(const key of ['readOwner','readConversation','readOwnerTimeline','readReply'])input[key]=async()=>assert.fail('unbound legacy intent must stay held');
 assert.deepEqual(await reconcileReplyByReadback(input),{found:[],reconciled:0,held:true});
 assert.equal(await readFile(intent.file,'utf8'),before);
 assert.equal((await unresolvedJournalFiles({channel:'x',runKey:input.runKey,journalDir:input.journalDir})).length,1);
});
test('an unrelated reply, wrong owner ID, pre-intent reply or duplicate exact replies stays held',async t=>{
 for(const cause of ['text','ownerId','time','late','duplicate','overflow','partial','unknownCompleteness','cursor']){
  const {input}=await fixture(t),reader=input.readReply;
  if(cause==='duplicate'||cause==='overflow')input.readConversation=async()=>({owner:'owner',fullConversation:true,items:[{id:'100',author:'target'},...Array.from({length:cause==='overflow'?21:2},(_,index)=>({id:String(200+index),author:'owner',replyToId:'100'}))]});
  else if(['partial','unknownCompleteness','cursor'].includes(cause)){const read=input.readConversation;input.readConversation=async()=>{const value=await read();if(cause==='partial')value.fullConversation=false;if(cause==='unknownCompleteness')delete value.fullConversation;if(cause==='cursor')value.nextCursor='next';return value;};}
  else input.readReply=async id=>{const value=await reader(id);if(cause==='text')value.tweet.text='An unrelated reply.';if(cause==='ownerId')value.tweet.authorId='99';if(cause==='time')value.tweet.createdAt='2026-09-30T09:59:00.000Z';if(cause==='late')value.tweet.createdAt='2026-09-30T10:03:00.000Z';return value;};
  assert.deepEqual(await reconcileReplyByReadback(input),{found:[],reconciled:0,held:true});
  assert.equal((await unresolvedJournalFiles({channel:'x',runKey:input.runKey,journalDir:input.journalDir})).length,1);
 }
});
