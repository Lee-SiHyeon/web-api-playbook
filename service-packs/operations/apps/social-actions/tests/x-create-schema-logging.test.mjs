import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTweetResponseShape } from '../../affiliate-api-hub/scripts/sns/writers/x.mjs';
import { safeBotFailure, recordBotEvent, readBotFailureLog } from '../lib/bot-diagnostics.mjs';

test('CreateTweet schema failures survive later restarts without storing body, keys or server text',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'x-schema-log-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const secret='SYNTHETIC_TOKEN_DO_NOT_PERSIST';
  const shape=createTweetResponseShape({data:{create_tweet:{tweet_results:{}},[secret]:secret},errors:[{message:secret}]});
  assert.deepEqual(shape,{dataType:'object',createType:'object',resultType:'undefined',dataKeys:['create_tweet'],createKeys:['tweet_results'],resultKeys:[],errorCount:1,type:null});
  const failure=safeBotFailure({code:'X_CREATE_SCHEMA',responseSchema:{...shape,raw:secret,resultKeys:[secret]},receipt:{httpStatus:200,writeSent:true}});
  await recordBotEvent('x-followback-bot',root,{event:'failure',code:'X_CREATE_SCHEMA',failure});
  const [event]=await readBotFailureLog(root);
  assert.equal(event.failure.responseSchema.resultType,'undefined');
  assert.equal(event.failure.responseSchema.errorCount,1);
  assert.equal(event.failure.writeSent,true);assert.equal(event.failure.httpStatus,200);
  assert.equal(JSON.stringify(event).includes(secret),false);
});
