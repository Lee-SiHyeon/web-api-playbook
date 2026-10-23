import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {ThreadsClient,buildTextOnlyConfigureRequest,parseCreateResponse} from '../src/client.mjs';
import {buildVideoUploadRequest,newUploadId} from '../src/media.mjs';
import {res,profileHtml,post} from './helpers.mjs';
const provider={credentials:{owner:'me',ownerId:'42',webSessionId:'w'},headersFor:u=>{if(!u.startsWith('https://www.threads.com/api/v1/media/configure_text_only_post/'))throw new Error('SCOPE');return {cookie:'sessionid=s','X-CSRFToken':'c'};}};
const base={posts:['첫 글','두 번째'],expectedOwner:'me',expectedOwnerId:'42',jobId:'job1'};
const tmp=()=>mkdtemp(path.join(os.tmpdir(),'sns-threads-'));
let u=0;const uuid=()=>`00000000-0000-4000-8000-${String(++u).padStart(12,'0')}`;
test('dry-run sends nothing and exposes no credentials',async()=>{
  const client=new ThreadsClient({fetchImpl:async()=>{throw new Error('network used');},uuid});
  const r=await client.publish(base);assert.equal(r.dryRun,true);assert.equal(r.requests.length,2);
  assert.ok(!JSON.stringify(r).includes('sessionid'));
});
test('request carries evidenced fields and chain linkage',()=>{
  const r=buildTextOnlyConfigureRequest({caption:'hi',uploadId:'1',chainId:'c',chainIndex:1,chainLength:2,replyId:'1234567890123',selfThreadContextId:'ctx'});
  const b=new URLSearchParams(r.body);assert.equal(b.get('publish_mode'),'text_post');assert.equal(b.get('barcelona_source_reply_id'),'1234567890123');
  const info=JSON.parse(b.get('text_post_app_info'));assert.equal(info.reply_id,'1234567890123');assert.equal(info.text_with_entities.text,'hi');
  assert.ok(!('cookie' in r.headers));
});
test('execute: journal first, each reply chains to the previous id, public readback verifies',async()=>{
  const dir=await tmp();const sent=[];let reads=0;
  const fetchImpl=async(url,opt={})=>{
    if(url.endsWith('configure_text_only_post/')){sent.push(new URLSearchParams(opt.body));const n=sent.length;
      const j=JSON.parse(await readFile(path.join(dir,'job1.json'),'utf8'));assert.equal(j.intent.index,n-1);
      return res(200,{status:'ok',media:{pk:`99999999999${n}`,permalink:`https://www.threads.com/@me/post/Code${n}x`}});}
    reads++;if(url.startsWith('https://www.threads.com/@me'))return res(200,profileHtml('me'),{setCookie:['csrftoken=a']});
    return res(200,{data:{a:[post('me','Code1x','999999999991','첫 글'),post('me','Code2x','999999999992','두 번째')]}});};
  const client=new ThreadsClient({fetchImpl,provider,uuid});
  const r=await client.publish({...base,journalDir:dir,execute:true});
  assert.equal(r.verified,true);assert.equal(sent[1].get('barcelona_source_reply_id'),'999999999991');assert.equal(sent[0].get('chain_id'),sent[1].get('chain_id'));
  const j=JSON.parse(await readFile(path.join(dir,'job1.json'),'utf8'));assert.equal(j.state,'verified');assert.ok(!JSON.stringify(j).includes('첫 글'));
  await assert.rejects(client.publish({...base,journalDir:dir,execute:true}),/JOB_ALREADY_EXISTS/);
});
test('transport failure and 202 are unknown, never retried',async()=>{
  for(const [name,impl] of [['throw',async()=>{throw new Error('reset');}],['202',async()=>res(202,'{}')]]){
    const dir=await tmp();let n=0;
    const client=new ThreadsClient({fetchImpl:async(...a)=>{n++;return impl(...a);},provider,uuid});
    await assert.rejects(client.publish({...base,journalDir:dir,execute:true}),/unknown_needs_review/);assert.equal(n,1,name);
    assert.equal(JSON.parse(await readFile(path.join(dir,'job1.json'),'utf8')).state,'unknown_needs_review');
  }
});
test('partial chain failure is created_needs_review; auth error is distinct',async()=>{
  const dir=await tmp();let n=0;
  const client=new ThreadsClient({fetchImpl:async()=>++n===1?res(200,{media:{pk:'9999999999991'}}):res(403,'{}'),provider,uuid});
  await assert.rejects(client.publish({...base,journalDir:dir,execute:true}),e=>e.code==='created_needs_review'&&e.detail.error==='AUTH_REJECTED');
});
test('owner mismatch and media are refused before any network',async()=>{
  const client=new ThreadsClient({fetchImpl:async()=>{throw new Error('network used');},provider,uuid});
  await assert.rejects(client.publish({...base,expectedOwnerId:'7',journalDir:await tmp(),execute:true}),/EXPECTED_OWNER_MISMATCH/);
  await assert.rejects(client.publish({...base,media:[{}]}),/MEDIA_PUBLISH_UNVERIFIED/);
});
test('create parser handles pending and rejects bad schema',()=>{
  assert.deepEqual(parseCreateResponse({posts:[{status:'PENDING',post_client_id:'x'}]}),{pending:true,id:null,permalink:null});
  assert.throws(()=>parseCreateResponse({posts:[{status:'ERROR'}]}),/REJECTED/);assert.throws(()=>parseCreateResponse({media:{pk:'1'}}),/SCHEMA/);
});
test('media builders validate numeric video ids and mp4 magic',()=>{
  const id=newUploadId(5);assert.equal(newUploadId(5),String(Number(id)+1));
  const mp4=Buffer.concat([Buffer.from([0,0,0,0]),Buffer.from('ftypisom')]);
  assert.match(buildVideoUploadRequest({bytes:mp4,width:1,height:1,uploadId:'123'}).url,/rupload_igvideo\/fb_uploader_123$/);
  assert.throws(()=>buildVideoUploadRequest({bytes:mp4,width:1,height:1,uploadId:'uuid-x'}),/VIDEO_INVALID/);
});
