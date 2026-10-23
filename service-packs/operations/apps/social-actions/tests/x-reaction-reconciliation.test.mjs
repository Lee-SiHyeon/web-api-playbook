import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { react, reactPair, explicitReactionRejection } from '../x-reactions.mjs';

const payload=({liked=false,retweeted=false,author='target'}={})=>({data:{result:{__typename:'Tweet',rest_id:'1234567890123456789',
  core:{user_results:{result:{core:{screen_name:author}}}},legacy:{full_text:'Example',favorited:liked,retweeted}}}});
test('incident CreateRetweet 404 holds the pair on restart without resending either reaction',async t=>{
  const journalRoot=await mkdtemp(path.join(tmpdir(),'x-reaction-404-'));t.after(()=>rm(journalRoot,{recursive:true,force:true}));
  const sent=[];
  const context={ownerHandle:'owner',ownerFingerprint:'owner',request:async(method,route)=>{
    if(method==='POST'){
      sent.push(route.split('/').at(-1));
      return {status:route.endsWith('/CreateRetweet')?404:200,raw:'{}',headers:{}};
    }
    return {status:200,raw:JSON.stringify(payload({liked:sent.includes('FavoriteTweet')})),headers:{}};
  }};
  const input={tweetId:'1234567890123456789',expectedAuthor:'target',execute:true};
  const options={journalRoot,withContext:work=>work(context)};
  await assert.rejects(reactPair(input,options),error=>{
    assert.equal(error.code,'X_REACTION_RECONCILIATION_REQUIRED');
    assert.equal(error.receipt.operation,'CreateRetweet');
    assert.equal(error.receipt.httpStatus,404);
    assert.equal(error.receipt.writeSent,true);
    return true;
  });
  const file=path.join(journalRoot,'owner-repost-1234567890123456789.json');
  const original=await readFile(file,'utf8');
  assert.equal(JSON.parse(original).status,'needs_reconciliation');
  assert.equal(JSON.parse(original).httpStatus,404);
  for(let restart=0;restart<2;restart++){
    await assert.rejects(reactPair(input,options),error=>{
      assert.equal(error.receipt.operation,'CreateRetweet');
      assert.equal(error.receipt.writeSent,false);
      assert.equal(error.receipt.journalReconciliationHold,true);
      return error.code==='X_REACTION_RECONCILIATION_REQUIRED';
    });
    assert.equal(await readFile(file,'utf8'),original);
  }
  assert.deepEqual(sent,['FavoriteTweet','CreateRetweet']);
  assert.deepEqual((await readdir(journalRoot)).sort(),['owner-like-1234567890123456789.json','owner-repost-1234567890123456789.json']);
});
async function fixture(t,operation='repost',state={},expectedAuthor='target'){
  const journalRoot=await mkdtemp(path.join(tmpdir(),'x-reaction-reconcile-'));t.after(()=>rm(journalRoot,{recursive:true,force:true}));
  const file=path.join(journalRoot,`owner-${operation}-1234567890123456789.json`);
  await writeFile(file,JSON.stringify({owner:'owner',operation,tweetId:'1234567890123456789',target:expectedAuthor,writes:1,status:'needs_reconciliation',...state}));
  let posts=0;
  const context={ownerHandle:'owner',ownerFingerprint:'owner',request:async(method)=>{
    if(method==='POST'){posts++;return {status:200,raw:'{"data":{}}',headers:{}};}
    return {status:200,raw:JSON.stringify(payload({liked:state.favorited===true,retweeted:state.retweeted===true,author:expectedAuthor})),headers:{}};
  }};
  return {journalRoot,file,context,posts:()=>posts,options:{journalRoot,withContext:work=>work(context)},input:{operation,tweetId:'1234567890123456789',expectedAuthor,execute:true}};
}

test('HTTP 200 journal plus true current state is locally verified with zero writes',async t=>{
  const f=await fixture(t,'repost',{httpStatus:200,retweeted:true});
  const result=await react(f.input,f.options);
  assert.equal(result.readbackVerified,true);assert.equal(result.writes,0);assert.equal(result.noOp,true);assert.equal(f.posts(),0);
  assert.equal(JSON.parse(await readFile(f.file,'utf8')).status,'verified');
});

test('HTTP 200 with false readback remains held across restart without reposting or rearming the journal',async t=>{
  const f=await fixture(t,'repost',{httpStatus:200,retweeted:false});
  const original=await readFile(f.file,'utf8');
  for(let restart=0;restart<2;restart++){
    await assert.rejects(react(f.input,f.options),{code:'X_REACTION_RECONCILIATION_REQUIRED'});
    assert.equal(f.posts(),0);
    assert.equal(await readFile(f.file,'utf8'),original);
    assert.deepEqual(await readdir(f.journalRoot),[path.basename(f.file)]);
  }
});

test('a needs-reconciliation journal without an HTTP status closes on a true state with zero writes',async t=>{
  const f=await fixture(t,'like',{favorited:true});
  const result=await react(f.input,f.options);
  assert.equal(result.readbackVerified,true);assert.equal(f.posts(),0);
  assert.equal(JSON.parse(await readFile(f.file,'utf8')).status,'verified');
});

test('aged uncertain reactions remain held without archiving or resending after false readback',async t=>{
  for(const operation of ['like','repost'])for(const status of ['reserved','needs_reconciliation']){
    const f=await fixture(t,operation,{status,httpStatus:404});
    const old=new Date(Date.now()-24*60*60_000);
    await utimes(f.file,old,old);
    const original=await readFile(f.file,'utf8');
    await assert.rejects(react(f.input,f.options),{code:'X_REACTION_RECONCILIATION_REQUIRED'});
    assert.equal(f.posts(),0);
    assert.equal(await readFile(f.file,'utf8'),original);
    assert.deepEqual(await readdir(f.journalRoot),[path.basename(f.file)]);
  }
});

test('CreateRetweet HTTP 404 with a true state closes; with a false state it is held inside the settle window',async t=>{
  const done=await fixture(t,'repost',{httpStatus:404,retweeted:true});
  assert.equal((await react(done.input,done.options)).readbackVerified,true);assert.equal(done.posts(),0);
  for(const retweeted of [false]){
    const f=await fixture(t,'repost',{httpStatus:404,retweeted});
    const original=await readFile(f.file,'utf8');
    for(let restart=0;restart<2;restart++){
      await assert.rejects(react(f.input,f.options),error=>{
        assert.equal(error.code,'X_REACTION_RECONCILIATION_REQUIRED');
        assert.equal(error.receipt.operation,'CreateRetweet');
        assert.equal(error.receipt.writeSent,false);
        assert.equal(error.receipt.journalReconciliationHold,true);
        return true;
      });
      assert.equal(f.posts(),0);
      assert.equal(await readFile(f.file,'utf8'),original);
      assert.deepEqual(await readdir(f.journalRoot),[path.basename(f.file)]);
    }
  }
});

test('an explicit 200 rejection (X 344, empty data) is journaled as rejected and the next attempt sends fresh',async t=>{
  const journalRoot=await mkdtemp(path.join(tmpdir(),'x-reaction-reject-'));t.after(()=>rm(journalRoot,{recursive:true,force:true}));
  let posts=0,reject=true;
  const context={ownerHandle:'owner',ownerFingerprint:'owner',request:async method=>{
    if(method==='POST'){posts++;return reject
      ?{status:200,raw:JSON.stringify({errors:[{code:344,kind:'Permissions',name:'AuthorizationError',message:'daily limit'}],data:{}}),headers:{}}
      :{status:200,raw:'{"data":{"create_retweet":{"retweet_results":{"result":{"rest_id":"9"}}}}}',headers:{}};}
    return {status:200,raw:JSON.stringify(payload({retweeted:!reject&&posts>1})),headers:{}};}};
  const input={operation:'repost',tweetId:'1234567890123456789',expectedAuthor:'target',execute:true};
  const options={journalRoot,withContext:work=>work(context)};
  await assert.rejects(react(input,options),error=>{
    assert.equal(error.code,'X_REACTION_RECONCILIATION_REQUIRED');
    assert.equal(error.receipt.explicitRejection,true);assert.deepEqual(error.receipt.xErrorCodes,[344]);return true;});
  const file=path.join(journalRoot,'owner-repost-1234567890123456789.json');
  assert.equal(JSON.parse(await readFile(file,'utf8')).status,'rejected');
  reject=false;
  const result=await react(input,options);
  assert.equal(result.readbackVerified,true);assert.equal(posts,2);
  assert.ok((await readdir(journalRoot)).some(name=>name.includes('.rejected-')));
});

test('only all-known rejection codes with empty data count as explicit rejections',()=>{
  assert.deepEqual(explicitReactionRejection('{"errors":[{"code":344}],"data":{}}'),[344]);
  assert.deepEqual(explicitReactionRejection('{"errors":[{"code":226}]}'),[226]);
  assert.equal(explicitReactionRejection('{"errors":[{"code":344}],"data":{"create_retweet":{}}}'),null);
  assert.equal(explicitReactionRejection('{"errors":[{"code":344},{"code":131}],"data":{}}'),null);
  assert.equal(explicitReactionRejection('{"data":{}}'),null);
  assert.equal(explicitReactionRejection('not json'),null);
});
