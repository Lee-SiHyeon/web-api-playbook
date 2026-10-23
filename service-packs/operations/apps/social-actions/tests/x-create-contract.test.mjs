import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractFromSource,refreshCreateTweetContract } from '../../affiliate-api-hub/scripts/sns/writers/x-create-contract.mjs';
test('current mutation ID and declared feature keys replace stale contract; uncaptured features fail closed',()=>{
 const source='queryId:"new-id",operationName:"CreateTweet",operationType:"mutation",metadata:{featureSwitches:["a"],fieldToggles:["b"]}';
 const saved={queryId:'old-id',features:{a:false,unused:true},fieldToggles:{b:true}};
 assert.deepEqual(createContractFromSource(source,saved),{...saved,queryId:'new-id',features:{a:false},fieldToggles:{b:true}});
 assert.throws(()=>createContractFromSource(source,{features:{},fieldToggles:{b:true}}),{code:'X_CREATE_CURRENT_CONTRACT_INCOMPLETE'});
 assert.throws(()=>createContractFromSource('',saved),{code:'X_CREATE_CURRENT_CONTRACT_MISSING'});
 const note='queryId:"note-id",operationName:"CreateNoteTweet",operationType:"mutation",metadata:{featureSwitches:["a"],fieldToggles:["b"]}';
 assert.equal(createContractFromSource(note,saved,'CreateNoteTweet').queryId,'note-id');
});
test('manifest 404 falls back to public homepage asset and refreshes both create operations',async()=>{
 const defaults={featureSwitch:{defaultConfig:{a:{value:true}},user:{config:{a:{value:false}}}}};
 const html='window.__INITIAL_STATE__='+JSON.stringify(defaults)+';window.next=true; <script src="https://abs.twimg.com/responsive-web/client-web/main.fixture.js"></script>';
 const source='queryId:"live-id",operationName:"CreateTweet",operationType:"mutation",metadata:{featureSwitches:["a"],fieldToggles:["optional"]};'+
  'queryId:"note-live-id",operationName:"CreateNoteTweet",operationType:"mutation",metadata:{featureSwitches:["a"],fieldToggles:["noteOptional"]}';
 const calls=[];const fetchImpl=async url=>{calls.push(url);
  if(url==='https://x.com/manifest.js')return new Response('',{status:404});
  if(url==='https://x.com/')return new Response(html,{status:200});
  return new Response(source,{status:200});
 };
 const result=await refreshCreateTweetContract({operations:{
  CreateTweet:{queryId:'stale',features:{a:true},fieldToggles:{}},
  CreateNoteTweet:{queryId:'stale-note',features:{a:true},fieldToggles:{noteOptional:true}},
 }},fetchImpl);
 assert.equal(result.operations.CreateTweet.queryId,'live-id');assert.equal(result.operations.CreateTweet.features.a,false);assert.deepEqual(result.operations.CreateTweet.fieldToggles,{});
 assert.equal(result.operations.CreateNoteTweet.queryId,'note-live-id');assert.equal(result.operations.CreateNoteTweet.features.a,false);assert.deepEqual(result.operations.CreateNoteTweet.fieldToggles,{noteOptional:true});
 assert.equal(result.createEvidence.discoverySource,'homepage');
 assert.deepEqual(calls,['https://x.com/manifest.js','https://x.com/','https://abs.twimg.com/responsive-web/client-web/main.fixture.js']);
});
