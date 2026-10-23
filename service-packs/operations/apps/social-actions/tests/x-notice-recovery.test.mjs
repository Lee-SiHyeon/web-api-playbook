import test from 'node:test';
import assert from 'node:assert/strict';
import { sendCompletionNotice, noticePromotionId } from '../x-completion-notices.mjs';
import { recoveryDecision } from '../x-recovery.mjs';

test('failed notice dispatch checkpoints its exact batch and never resends held members',async()=>{
 const state={records:{'123':{status:'verified',results:{follow:{following:true,readbackVerified:true}}}},relationships:{'123':{visibility:'present',followsMe:true,handle:'guest'}}};
 const status={status:'blocked',code:'SERVICE_ERROR',workPhase:'notice_write',receipt:{operation:'CreateTweet'}};
 let calls=0,saved;
 const options={saveState:async value=>{saved=structuredClone(value);},reader:async()=>({owner:'lifehack__ailab',tweet:{id:noticePromotionId,author:'lifehack__ailab'}}),beforePublish:async batch=>{
  assert.equal(saved.completionNotices['123'].base,batch.batchId);
  status.currentNoticeBatchId=batch.batchId;
 },publisher:async()=>{calls++;throw Object.assign(new Error('SERVICE_ERROR'),{code:'SERVICE_ERROR'});}};
 await assert.rejects(sendCompletionNotice(state,options),{code:'SERVICE_ERROR'});
 assert.equal(recoveryDecision({status,state:saved}).action,'restart');
 assert.equal(await sendCompletionNotice(saved,options),null);
 assert.equal(calls,1);
});
