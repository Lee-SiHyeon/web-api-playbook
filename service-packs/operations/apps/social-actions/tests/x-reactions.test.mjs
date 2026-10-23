import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { react, reactPair, decodeTweet } from '../x-reactions.mjs';
const payload = (liked = false, author = 'target') => ({ data: { result: { __typename: 'Tweet', rest_id: '123', core: { user_results: { result: { core: { screen_name: author } } } }, legacy: { full_text: 'Example', favorited: liked, retweeted: false } } } });
test('missing state and wrong target fail closed without writes', async () => {
  assert.throws(() => decodeTweet({}, '123'), /UNVERIFIED/);
  let writes = 0;
  await assert.rejects(react({ operation: 'like', tweetId: '123', expectedAuthor: 'other', execute: true }, { withContext: async work => work({ ownerHandle: 'owner', ownerFingerprint:'fixture', request: async method => { if (method === 'POST') writes++; return { status: 200, raw: JSON.stringify(payload()) }; } }) }), /MISMATCH/);
  assert.equal(writes, 0);
});
test('like and repost share one initial read and one independent final read',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let reads=0,writes=0;const events=[];
 const context={ownerHandle:'owner',ownerFingerprint:'fixture',request:async(method,route)=>{
  events.push([method,route]);if(method==='POST'){writes++;return{status:200,raw:'{}',headers:{}};}reads++;const p=payload(writes>0);p.data.result.legacy.retweeted=writes>=2;return{status:200,raw:JSON.stringify(p),headers:{}};
 }};
 try{const result=await reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext:work=>work(context)});
 assert.equal(reads,2);assert.equal(writes,2);assert.equal(result.like.readbackVerified,true);assert.equal(result.repost.readbackVerified,true);
 assert.equal(events[0][0],'GET');assert.equal(events.at(-1)[0],'GET');
 const again=await reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext:work=>work(context)});
 assert.equal(writes,2);assert.equal(again.like.writes,0);assert.equal(again.repost.writes,0);
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('positive uncertain-journal reconciliation is read-only and bypasses the write gate',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let reads=0,writes=0,gates=0;
 const context={ownerHandle:'owner',ownerFingerprint:'fixture',request:async method=>{
  if(method==='POST'){writes++;return{status:200,raw:'{}',headers:{}};}
  reads++;const p=payload(true);p.data.result.legacy.retweeted=true;return{status:200,raw:JSON.stringify(p),headers:{}};
 }};
 try{
  for(const operation of ['like','repost'])await writeFile(path.join(journalRoot,`fixture-${operation}-123.json`),JSON.stringify({owner:'owner',operation,tweetId:'123',target:'target',writes:1,httpStatus:200,status:'needs_reconciliation'}));
  const result=await reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext:work=>work(context),writeGate:async()=>{gates++;assert.fail('uncertain writes must reconcile without a new budget reservation');}});
  assert.equal(reads,1);assert.equal(writes,0);assert.equal(gates,0);
  assert.equal(result.like.readbackVerified,true);assert.equal(result.repost.readbackVerified,true);
  for(const operation of ['like','repost'])assert.equal(JSON.parse(await readFile(path.join(journalRoot,`fixture-${operation}-123.json`),'utf8')).status,'verified');
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('new repost writes reserve budget outside the session and revalidate journals before dispatch',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let writes=0,reads=0,locked=false,gates=0;const events=[];
 const context={ownerHandle:'owner',ownerFingerprint:'fixture',request:async method=>{
  if(method==='POST'){writes++;events.push('post');return{status:200,raw:'{}',headers:{}};}
  reads++;events.push('read');const p=payload(writes>=1);p.data.result.legacy.retweeted=writes>=2;return{status:200,raw:JSON.stringify(p),headers:{}};
 }};
 const withContext=async work=>{assert.equal(locked,false);locked=true;events.push('lock-enter');try{return await work(context);}finally{locked=false;events.push('lock-exit');}};
 try{
  const result=await reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext,writeGate:async()=>{assert.equal(locked,false);gates++;events.push('gate');}});
  assert.equal(gates,1);assert.equal(reads,3);assert.equal(writes,2);
  assert.ok(events.indexOf('lock-exit')<events.indexOf('gate'));
  assert.ok(events.indexOf('gate')<events.lastIndexOf('lock-enter'));
  assert.equal(result.like.readbackVerified,true);assert.equal(result.repost.readbackVerified,true);
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('a repost that becomes necessary during locked revalidation releases the lock before gating',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let writes=0,reads=0,locked=false,gates=0;
 const context={ownerHandle:'owner',ownerFingerprint:'fixture',request:async method=>{
  if(method==='POST'){writes++;return{status:200,raw:'{}',headers:{}};}
  reads++;const p=payload(reads>=4&&writes>=1);p.data.result.legacy.retweeted=reads===1||reads>=4&&writes>=2;return{status:200,raw:JSON.stringify(p),headers:{}};
 }};
 const withContext=async work=>{assert.equal(locked,false);locked=true;try{return await work(context);}finally{locked=false;}};
 try{
  const result=await reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext,writeGate:async()=>{assert.equal(locked,false);gates++;}});
  assert.equal(gates,1);assert.equal(reads,4);assert.equal(writes,2);
  assert.equal(result.like.readbackVerified,true);assert.equal(result.repost.readbackVerified,true);
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('repost dispatch aborts if either owner handle or fingerprint changes after the write gate',async()=>{
 for(const changedIdentityField of ['ownerHandle','ownerFingerprint']){
  const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let contextCalls=0,reads=0,writes=0,gates=0;
  const withContext=async work=>{
   contextCalls++;
   const ownerHandle=changedIdentityField==='ownerHandle'&&contextCalls>1?'other':'owner';
   const ownerFingerprint=changedIdentityField==='ownerFingerprint'&&contextCalls>1?'other-fingerprint':'fixture';
   return work({ownerHandle,ownerFingerprint,request:async method=>{
    if(method==='POST'){writes++;return{status:200,raw:'{}',headers:{}};}
    reads++;return{status:200,raw:JSON.stringify(payload()),headers:{}};
   }});
  };
  try{
   await assert.rejects(reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext,writeGate:async()=>{gates++;}}),{code:'X_REACTION_OWNER_CHANGED'});
   assert.equal(contextCalls,2);assert.equal(reads,1);assert.equal(gates,1);assert.equal(writes,0);
  }finally{await rm(journalRoot,{recursive:true,force:true});}
 }
});
test('reactions require a verified owner handle and fingerprint before GET, gate, journal, or POST',async()=>{
 for(const missingField of ['ownerHandle','ownerFingerprint']){
  const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let requests=0,gates=0;
  const context={ownerHandle:'owner',ownerFingerprint:'fixture',request:async()=>{requests++;return{status:200,raw:JSON.stringify(payload()),headers:{}};}};
  context[missingField]='';
  try{
   await assert.rejects(reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext:work=>work(context),writeGate:async()=>{gates++;}}),{code:'X_REACTION_OWNER_UNVERIFIED'});
   assert.equal(requests,0);assert.equal(gates,0);
  }finally{await rm(journalRoot,{recursive:true,force:true});}
 }
});
test('a frozen final-read error is wrapped without mutating it and preserves actual dispatch evidence',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let writes=0,reads=0;
 const source=Object.freeze(Object.assign(new Error('read timeout'),{code:'X_READ_TIMEOUT',receipt:Object.freeze({operation:'TweetDetail'})}));
 const context={ownerHandle:'owner',ownerFingerprint:'fixture',request:async method=>{
  if(method==='POST'){writes++;return{status:200,raw:'{}',headers:{}};}
  reads++;if(reads===3)throw source;const p=payload(writes>=1);p.data.result.legacy.retweeted=writes>=2;return{status:200,raw:JSON.stringify(p),headers:{}};
 }};
 try{
  await assert.rejects(reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext:work=>work(context),writeGate:async()=>{}}),error=>{
   assert.equal(error.code,'X_READ_TIMEOUT');assert.equal(error.receipt.writeSent,true);assert.equal(error.receipt.mutationCount,2);return true;
  });
  assert.equal(writes,2);assert.equal(source.receipt.writeSent,undefined);
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('uncertain first mutation holds the pair and is never resent or followed by the second mutation',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let writes=0,gates=0;
 const options={journalRoot,writeGate:async()=>{gates++;},withContext:work=>work({ownerHandle:'owner',ownerFingerprint:'fixture',request:async method=>{if(method==='POST'){writes++;throw new Error('lost response');}return{status:200,raw:JSON.stringify(payload()),headers:{}};}})};
 try{const input={tweetId:'123',expectedAuthor:'target',execute:true};await assert.rejects(reactPair(input,options),{code:'X_REACTION_RECONCILIATION_REQUIRED'});await assert.rejects(reactPair(input,options),{code:'X_REACTION_RECONCILIATION_REQUIRED'});assert.equal(writes,1);assert.equal(gates,1,'an uncertain negative read must not reserve another write budget');
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('the final read validates both states even when one reaction was initially already present',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'x-reactions-'));let writes=0;
 const context={ownerHandle:'owner',ownerFingerprint:'fixture',request:async method=>{if(method==='POST'){writes++;return{status:200,raw:'{}',headers:{}};}const p=payload(writes===0);p.data.result.legacy.retweeted=writes>0;return{status:200,raw:JSON.stringify(p),headers:{}};}};
 try{const result=await reactPair({tweetId:'123',expectedAuthor:'target',execute:true},{journalRoot,withContext:work=>work(context)});assert.equal(writes,1);assert.equal(result.like.readbackVerified,false);assert.equal(result.repost.readbackVerified,true);
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('ambiguous write is held until the state reads true, then closes without a second write', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'x-reactions-'));
  let writes = 0; let liked = false;
  const options = { journalRoot, withContext: async work => work({ ownerHandle: 'owner', ownerFingerprint: 'fixture', request: async method => {
    if (method === 'POST') { writes++; throw new Error('lost response'); }
    return { status: 200, raw: JSON.stringify(payload(liked)) };
  } }) };
  const input = { operation: 'like', tweetId: '123', expectedAuthor: 'target', execute: true };
  try {
    await assert.rejects(react(input, options), /RECONCILIATION_REQUIRED/);
    await assert.rejects(react(input, options), /RECONCILIATION_REQUIRED/);
    assert.equal(writes, 1);
    liked = true;
    const result = await react(input, options);
    assert.equal(result.readbackVerified, true); assert.equal(result.noOp, true);
    assert.equal(writes, 1);
  } finally { await rm(journalRoot, { recursive: true, force: true }); }
});

test('a still-false ambiguous reaction remains held after aging until positive readback', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'x-reactions-'));
  let writes = 0, liked = false, lose = true;
  const options = { journalRoot, withContext: async work => work({ ownerHandle: 'owner', ownerFingerprint: 'fixture', request: async method => {
    if (method === 'POST') { writes++; if (lose) throw new Error('lost response'); liked = true; return { status: 200, raw: '{"errors":[{"code":139}]}' }; }
    return { status: 200, raw: JSON.stringify(payload(liked)) };
  } }) };
  const input = { operation: 'like', tweetId: '123', expectedAuthor: 'target', execute: true };
  const journal = path.join(journalRoot, 'fixture-like-123.json');
  const age = async () => { const old = new Date(Date.now() - 3 * 60_000); await utimes(journal, old, old); };
  try {
    await assert.rejects(react(input, options), /RECONCILIATION_REQUIRED/);
    await assert.rejects(react(input, options), /RECONCILIATION_REQUIRED/);
    assert.equal(writes, 1, 'no resend inside the settle window');
    await age();
    await assert.rejects(react(input, options), /RECONCILIATION_REQUIRED/);
    assert.equal(writes, 1, 'no resend after the window');
    await age();
    await assert.rejects(react(input, options), /RECONCILIATION_REQUIRED/);
    assert.equal(writes, 1, 'repeated reads never resend');
    lose = false; liked = true;
    const result = await react(input, options);
    assert.equal(result.readbackVerified, true, 'positive readback reconciles the original journal');
    assert.equal(writes, 1);
  } finally { await rm(journalRoot, { recursive: true, force: true }); }
});
