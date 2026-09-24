import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NaverEditorClient } from '../scripts/api/editor-client.mjs';
import { WriteJournal } from '../scripts/api/write-journal.mjs';
import { compileEditorModel, inspectEditorModel } from '../scripts/api/editor-model.mjs';
import { seedModel, publicHtml } from './support/publication-fixture.mjs';

const json = result => new Response(JSON.stringify({isSuccess:true,result}),{headers:{'content-type':'application/json'}});
async function fixture(t, {openType=0,title='API 연동 검증용 임시 초안 20260920',lost=false,mismatch=false}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'private-probe-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const document={blogId:'syntheticblog',logNo:'123456789',title,blocks:[{type:'paragraph',text:'이 글은 API 연동을 확인하기 위한 임시 초안입니다.'}]};
  let model=compileEditorModel(seedModel(),document),posts=0,current=document;
  const client=new NaverEditorClient({blogId:document.blogId,session:{cookieFor:()=> 'synthetic'},journal:new WriteJournal(dir),fetchImpl:async(raw,init)=>{
    const u=new URL(raw);
    if(u.pathname==='/PostWriteFormSeOptions.naver')return json({documentModel:JSON.stringify(model)});
    if(u.pathname==='/PostWriteFormManagerOptions.naver')return json({blogId:document.blogId,isWriterBlogOwner:true,formView:{editorSource:'synthetic',postConfiguration:{openType},postFormMeta:{logNo:Number(document.logNo),postWriteTimeType:'now'}}});
    if(u.pathname==='/RabbitUpdate.naver'){
      posts++;
      assert.equal(JSON.parse(init.body.get('populationParams')).configuration.openType,0);
      if(!mismatch){model=JSON.parse(init.body.get('documentModel'));const observed=inspectEditorModel(model);current={...document,title:observed.title,blocks:observed.units.map(u=>({type:'paragraph',text:u.value}))};}
      if(lost)throw Error('sensitive transport detail');
      return json({redirectUrl:`https://blog.naver.com/PostView.naver?blogId=${document.blogId}&logNo=${document.logNo}`});
    }
    if(u.pathname==='/PostView.naver'){
      assert.ok(init.headers.cookie);
      return new Response(publicHtml(current),{headers:{'content-type':'text/html'}});
    }
    throw Error('unexpected request');
  }});
  return {client,document,posts:()=>posts};
}
test('private transport probe uses the normal update transport and exact ordered readback',async t=>{
  const f=await fixture(t),probe=await f.client.preparePrivateProbe(f.document.logNo);
  const receipt=await f.client.verifyPrivateUpdate(probe);
  assert.equal(receipt.readbackVerified,true);assert.equal(receipt.privateVisibilityVerified,true);
  assert.equal(receipt.publicationQualityVerified,false);assert.equal(f.posts(),1);
  await assert.rejects(f.client.verifyPrivateUpdate(await f.client.preparePrivateProbe(f.document.logNo)),/WRITE_ALREADY_ATTEMPTED/);
});
for(const options of [{openType:2},{title:'기존 상업용 글입니다'}])test('probe refuses public posts and ordinary private articles '+JSON.stringify(options),async t=>{
  const f=await fixture(t,options);
  await assert.rejects(f.client.preparePrivateProbe(f.document.logNo),{code:'PRIVATE_PROBE_TARGET_REQUIRED'});assert.equal(f.posts(),0);
});
test('probe cannot introduce arbitrary content or use a stale preflight',async t=>{
  const f=await fixture(t),probe=await f.client.preparePrivateProbe(f.document.logNo);
  probe.document.blocks.push({type:'paragraph',text:'unreviewed article'});
  await assert.rejects(f.client.verifyPrivateUpdate(probe),{code:'SOURCE_DOCUMENT_CHANGED'});
  probe.checkedAt='2000-01-01T00:00:00Z';
  await assert.rejects(f.client.verifyPrivateUpdate(probe),{code:'PRIVATE_PROBE_PREFLIGHT_REQUIRED'});assert.equal(f.posts(),0);
});
test('private probe reconciles a lost response and never retries a mismatched write',async t=>{
  const lost=await fixture(t,{lost:true});
  assert.equal((await lost.client.verifyPrivateUpdate(await lost.client.preparePrivateProbe(lost.document.logNo))).accepted,false);
  assert.equal(lost.posts(),1);
  const bad=await fixture(t,{mismatch:true});
  const probe=await bad.client.preparePrivateProbe(bad.document.logNo);
  await assert.rejects(bad.client.verifyPrivateUpdate(probe),{code:'WRITE_OUTCOME_UNKNOWN'});
  await assert.rejects(bad.client.verifyPrivateUpdate(probe),/WRITE_ALREADY_ATTEMPTED/);assert.equal(bad.posts(),1);
});
