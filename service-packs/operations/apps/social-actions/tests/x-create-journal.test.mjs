import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishThread } from '../../affiliate-api-hub/scripts/sns/writers/x.mjs';
import { unresolvedJournalFiles, reconcileIntent } from '../../affiliate-api-hub/scripts/sns/writers/journal.mjs';
const contracts={operations:{CreateTweet:{queryId:'fixture',features:{}}}};
test('schema failure holds successful HTTP create; same run cannot send a second write',async()=>{
 const journalDir=await mkdtemp(path.join(os.tmpdir(),'x-create-'));
 let writes=0;
 const client={request:async()=>{writes++;return {data:{unexpected:{}},receipt:{status:200}};}};
 const options={client,contracts,journalDir,runKey:'schema-test'};
 try {
  await assert.rejects(publishThread(['hello'],options),{code:'X_CREATE_SCHEMA'});
  await assert.rejects(publishThread(['hello'],options),{code:'SNS_JOURNAL_RECONCILIATION_REQUIRED'});
  assert.equal(writes,1);
 }finally{await rm(journalDir,{recursive:true,force:true});}
});
test('CreateNoteTweet HTTP success without a result stays unresolved and cannot send twice',async()=>{
 const journalDir=await mkdtemp(path.join(os.tmpdir(),'x-note-create-'));let writes=0;
 const noteContracts={operations:{...contracts.operations,CreateNoteTweet:{queryId:'note-fixture',features:{}}}};
 const client={request:async operation=>{assert.equal(operation,'CreateNoteTweet');writes++;return {data:{notetweet_create:{tweet_results:{}}},receipt:{status:200}};}};
 const options={client,contracts:noteContracts,journalDir,runKey:'note-schema-test',longPostAllowed:true};
 try{
  await assert.rejects(publishThread(['x'.repeat(281)],options),{code:'X_CREATE_SCHEMA'});
  assert.equal((await unresolvedJournalFiles({channel:'x',runKey:'note-schema-test',journalDir})).length,1);
  await assert.rejects(publishThread(['x'.repeat(281)],options),{code:'SNS_JOURNAL_RECONCILIATION_REQUIRED'});
  assert.equal(writes,1);
 }finally{await rm(journalDir,{recursive:true,force:true});}
});
test('created ID is checkpointed and exact text plus parent readback is required',async()=>{
 const journalDir=await mkdtemp(path.join(os.tmpdir(),'x-create-'));
 const client={request:async()=>({data:{create_tweet:{tweet_results:{result:{rest_id:'1234567890123456789'}}}},receipt:{status:200}}),conversation:async()=>({focal:{id:'1234567890123456789',text:'hello',parentId:'999'}})};
 try {const result=await publishThread(['hello'],{client,contracts,journalDir,runKey:'success-test',replyToId:'999'});assert.equal(result.readbackVerified,true);}finally{await rm(journalDir,{recursive:true,force:true});}
});
test('old no_visible_reply events remain unresolved and cannot permit a second create',async()=>{
 const journalDir=await mkdtemp(path.join(os.tmpdir(),'x-create-'));let writes=0;
 const client={request:async()=>{writes++;return {data:{create_tweet:{tweet_results:{}}},receipt:{status:200}};}};
 try{
  const options={client,contracts,journalDir,runKey:'legacy-unknown'};
  await assert.rejects(publishThread(['hello'],options),{code:'X_CREATE_SCHEMA'});
  const file=path.join(journalDir,(await readdir(journalDir))[0]);
  await appendFile(file,JSON.stringify({type:'reconciled',outcome:'no_visible_reply'})+'\n');
  assert.equal((await unresolvedJournalFiles({channel:'x',runKey:'legacy-unknown',journalDir})).length,1);
  await assert.rejects(reconcileIntent({file,result:{outcome:'not_created_owner_readback'}}),{code:'SNS_X_RECONCILIATION_POSITIVE_REQUIRED'});
  await assert.rejects(publishThread(['hello'],options),{code:'SNS_JOURNAL_RECONCILIATION_REQUIRED'});
  assert.equal(writes,1);
 }finally{await rm(journalDir,{recursive:true,force:true});}
});
test('a completed multi-post run reuses each exact slot and emits no new POST on reentry',async()=>{
 const journalDir=await mkdtemp(path.join(os.tmpdir(),'x-create-'));let writes=0;const values=new Map();
 const client={request:async(_operation,variables)=>{const id=String(100+(++writes));values.set(id,{id,text:variables.tweet_text,parentId:variables.reply?.in_reply_to_tweet_id||null});return {data:{create_tweet:{tweet_results:{result:{rest_id:id}}}},receipt:{status:200}};},
  conversation:async id=>({focal:values.get(id)})};
 try{
  const options={client,contracts,journalDir,runKey:'completed-chain'};
  const first=await publishThread(['hello','follow up'],options);assert.equal(writes,2);assert.equal(first.readbackVerified,true);
  const again=await publishThread(['hello','follow up'],options);assert.deepEqual(again.ids,first.ids);assert.equal(again.readbackVerified,true);assert.equal(writes,2);
  await assert.rejects(publishThread(['different content'],options),{code:'SNS_JOURNAL_RECONCILIATION_REQUIRED'});assert.equal(writes,2);
 }finally{await rm(journalDir,{recursive:true,force:true});}
});
