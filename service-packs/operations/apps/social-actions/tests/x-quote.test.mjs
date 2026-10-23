import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildCreateTweetRequest,publishThread} from '../../affiliate-api-hub/scripts/sns/writers/x.mjs';
import {quoteTextMatches} from '../../affiliate-api-hub/scripts/sns/writers/x-quote-readback.mjs';
import {decodeTweet} from '../x-reactions.mjs';
import {loadOptionalPeerModule} from './helpers/optional-peer.mjs';
const conversationPeer=await loadOptionalPeerModule('SNS_X_ROOT','src/conversation.mjs');
const quoteUrl='https://x.com/example/status/100',contracts={operations:{CreateTweet:{queryId:'observed',features:{flag:true},fieldToggles:{}}}};
test('quote builder uses the observed attachment_url and forbids ambiguous media/reply or unrelated destinations',()=>{
 const variables=JSON.parse(buildCreateTweetRequest({post:'Reflection',quoteUrl,contracts}).body).variables;
 assert.equal(variables.attachment_url,quoteUrl);assert.equal(variables.reply,undefined);
 for(const invalid of ['','https://example.com/post','https://x.com/example/status/100?token=value',quoteUrl+'#fragment'])
  assert.throws(()=>buildCreateTweetRequest({post:'Reflection',quoteUrl:invalid,contracts}),{code:'X_QUOTE_INPUT_INVALID'});
 assert.throws(()=>buildCreateTweetRequest({post:'Reflection',quoteUrl,replyToId:'999',contracts}),{code:'X_QUOTE_INPUT_INVALID'});
});
test('quote verification checks both exact quoted ID and prose, including only the automatic quote URL suffix',()=>{
 const item={text:'Reflection',quotedPostId:'100',parentId:null};
 assert.equal(quoteTextMatches(item,'Reflection',quoteUrl),true);
 assert.equal(quoteTextMatches({...item,text:'Reflection '+quoteUrl},'Reflection',quoteUrl),true);
 assert.equal(quoteTextMatches({...item,quotedPostId:'999'},'Reflection',quoteUrl),false);
 assert.equal(quoteTextMatches({...item,text:'Reflection extra prose'},'Reflection',quoteUrl),false);
 assert.equal(quoteTextMatches({...item,parentId:'100'},'Reflection',quoteUrl),false);
});
test('journaled quote sends once and the writer refuses to call a mismatched quoted ID verified',async t=>{
 const journalDir=await mkdtemp(path.join(os.tmpdir(),'x-quote-test-'));t.after(()=>rm(journalDir,{recursive:true,force:true}));
 let calls=0;
 const client={request:async(_operation,variables)=>{calls++;assert.equal(variables.attachment_url,quoteUrl);return {data:{create_tweet:{tweet_results:{result:{rest_id:'200'}}}}};},
  conversation:async()=>({focal:{id:'200',text:'Reflection',quotedPostId:'999'}})};
 const result=await publishThread(['Reflection'],{client,contracts,quoteUrl,journalDir,runKey:'quote-test'});
 assert.equal(calls,1);assert.equal(result.readbackVerified,false);assert.deepEqual(result.ids,['200']);
 await assert.rejects(publishThread(['first','second'],{client,contracts,quoteUrl,journalDir,runKey:'invalid-quote'}),{code:'X_QUOTE_INPUT_INVALID'});
 assert.equal(calls,1);
});
test('long-form source text survives the local decoder and quoted target survives both decoders', {skip:conversationPeer.skip},()=>{
 const {decodeConversation}=conversationPeer.module;
 const tweet={__typename:'Tweet',rest_id:'200',core:{user_results:{result:{rest_id:'11',core:{screen_name:'example'}}}},
  legacy:{full_text:'truncated',quoted_status_id_str:'100',favorited:false,retweeted:false},
  note_tweet:{note_tweet_results:{result:{text:'Full note &amp; context'}}}};
 const decoded=decodeTweet({tweet},'200');assert.equal(decoded.text,'Full note & context');assert.equal(decoded.authorId,'11');assert.equal(decoded.quotedPostId,'100');
 const instructions=[{entries:[{content:{itemContent:{tweet_results:{result:tweet}}}}]}];
 assert.equal(decodeConversation(instructions,'200').focal.quotedPostId,'100');
});
