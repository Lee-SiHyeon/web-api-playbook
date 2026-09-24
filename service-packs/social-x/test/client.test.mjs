import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {XClient,decode} from '../src/client.mjs';
const contracts={operations:Object.fromEntries(['UserByScreenName','UserOriginalsTimeline','TweetDetail','CreateTweet'].map(n=>[n,{queryId:'fixture',features:{},fieldToggles:{}}]))};
const tweet={__typename:'Tweet',rest_id:'1234567890',core:{user_results:{result:{core:{screen_name:'sama'}}}},legacy:{full_text:'hello',favorite_count:0}};
const instructions=[{entries:[{content:{itemContent:{tweet_results:{result:tweet}}}}]}];
const json=data=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json'}});
const client=fetchImpl=>new XClient({authToken:'fixture-auth',csrfToken:'fixture-csrf',bearerToken:'fixture-bearer',contracts,fetchImpl});
test('missing session rejected',()=>assert.throws(()=>new XClient({contracts}),/SESSION_INVALID/));
test('malformed session rejected',()=>assert.throws(()=>new XClient({authToken:'x\r\n',csrfToken:'y',bearerToken:'z',contracts}),/SESSION_INVALID/));
test('profile uses observed same-origin route and exact identity',async()=>{
  const c=client(async(url,options)=>{assert.equal(url.origin,'https://x.com');assert.equal(url.pathname,'/i/api/graphql/fixture/UserByScreenName');assert.equal(options.redirect,'error');return json({user:{result:{__typename:'User',rest_id:'1605',core:{screen_name:'sama'}}}});});
  assert.equal((await c.profile('sama')).id,'1605');c.close();await assert.rejects(c.profile('sama'),/CLIENT_CLOSED/);
});
test('HTML login response is failure',async()=>{await assert.rejects(client(async()=>new Response('<html>login</html>')).profile('sama'),/NOT_JSON/);});
test('429 has no implicit retry',async()=>{let n=0;await assert.rejects(client(async()=>{n++;return new Response('',{status:429});}).profile('sama'),/RATE_LIMITED/);assert.equal(n,1);});
test('author filtering and absent metrics remain distinct from zero',()=>{
  const p=decode(instructions,'sama');assert.equal(p.items[0].metrics.likes,0);assert.equal(p.items[0].metrics.views,null);assert.equal(decode(instructions,'other').items.length,0);
});
test('publish dry-run never sends any request',async()=>{let n=0;const c=client(async()=>{n++;});assert.equal((await c.publish({text:'hello',expectedHandle:'sama',expectedUserId:'1605',jobId:'dry'})).dryRun,true);assert.equal(n,0);});
test('publish rejects invalid target and overlong text before requests',async()=>{const c=client(async()=>{throw Error('unexpected');});await assert.rejects(c.publish({text:'한'.repeat(141),expectedHandle:'sama',expectedUserId:'1605',jobId:'x'}),/PUBLISH_INPUT/);});
test('successful write is read back and duplicate job is blocked',async()=>{
  const journalDir=await mkdtemp(path.join(tmpdir(),'snsx-'));let writes=0;
  const c=client(async(url,options)=>{
    if(url.pathname.endsWith('UserByScreenName'))return json({user:{result:{__typename:'User',rest_id:'1605',core:{screen_name:'sama'}}}});
    if(options.method==='POST'){writes++;assert.equal(JSON.parse(options.body).variables.tweet_text,'hello');return json({create_tweet:{tweet_results:{result:tweet}}});}
    return json({threaded_conversation_with_injections_v2:{instructions}});
  });
  const job={text:'hello',expectedHandle:'sama',expectedUserId:'1605',jobId:'one',execute:true,journalDir};
  try{assert.equal((await c.publish(job)).verified,true);await assert.rejects(c.publish(job),/JOB_ALREADY_EXISTS/);assert.equal(writes,1);const j=await readFile(path.join(journalDir,'one.json'),'utf8');assert.ok(!j.includes('fixture-auth'));assert.ok(!j.includes('hello'));}finally{await rm(journalDir,{recursive:true});}
});
test('lost write response leaves durable unknown status and never retries',async()=>{
  const journalDir=await mkdtemp(path.join(tmpdir(),'snsx-'));let writes=0;
  const c=client(async(url,options)=>{if(options.method==='POST'){writes++;throw Error('connection lost');}return json({user:{result:{__typename:'User',rest_id:'1605',core:{screen_name:'sama'}}}});});
  try{await assert.rejects(c.publish({text:'hello',expectedHandle:'sama',expectedUserId:'1605',jobId:'lost',execute:true,journalDir}),/unknown_needs_review/);assert.equal(writes,1);assert.equal(JSON.parse(await readFile(path.join(journalDir,'lost.json'))).state,'unknown_needs_review');}finally{await rm(journalDir,{recursive:true});}
});
