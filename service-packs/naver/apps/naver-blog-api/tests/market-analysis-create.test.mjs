import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PNG} from 'pngjs';
import {NaverEditorClient} from '../scripts/api/editor-client.mjs';
import {WriteJournal} from '../scripts/api/write-journal.mjs';
import {environmentSession} from '../scripts/api/environment-session.mjs';
import {compileEditorModel} from '../scripts/api/editor-model.mjs';
import {createSeedDocument} from '../scripts/api/create-envelope.mjs';
import {marketAnalysisFixture} from './support/market-analysis-fixture.mjs';
import {NOW,bind,seedModel,publicHtml} from './support/publication-fixture.mjs';
import {fingerprint} from '../../../packages/contracts/src/index.mjs';
import {publisherContentFingerprint} from '../scripts/gates/publisher-gates.mjs';

const json=result=>new Response(JSON.stringify({isSuccess:true,result}),{headers:{'content-type':'application/json'}});
async function setup(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'naver-market-create-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const job=await marketAnalysisFixture(directory),document=job.publicationBundle.document;
  const seed=compileEditorModel(seedModel(),createSeedDocument(document));seed.documentId='';
  const initial={openType:0,searchYn:false,commentYn:false,sympathyYn:true,outSideAllowYn:false,scrapType:2};
  const envelope={blogId:job.blogId,observedAt:NOW.toISOString(),browserClosed:true,browserRequestCancelled:true,
    body:new URLSearchParams({blogId:job.blogId,documentModel:JSON.stringify(seed),productApiVersion:'v1',tokenId:'synthetic-market-token',
      mediaResources:JSON.stringify({image:[],video:[],file:[]}),populationParams:JSON.stringify({editorSource:'synthetic-source',configuration:initial,
        populationMeta:{logNo:0,categoryId:job.publishSettings.categoryId,postWriteTimeType:'now',noticePostYn:false}})}).toString()};
  const state={writes:0,model:null,logNo:'987654321',configuration:initial,breakSourceLink:false};
  const journal=new WriteJournal(path.join(directory,'journal'));
  for(const image of document.blocks.filter(b=>b.type==='image')) {
    const bytes=await readFile(path.join(directory,image.file)),png=PNG.sync.read(bytes);
    image.uploadReceipt={schemaVersion:1,operation:'uploadPng',source:'independent_http',blogId:job.blogId,checkedAt:NOW.toISOString(),
      sha256:image.sha256,publishedUrl:image.publishedUrl,fileName:image.file,width:png.width,height:png.height,fileSize:bytes.length,readbackVerified:true};
    const key=journal.key('uploadPng',{blogId:job.blogId},{sha256:image.sha256,fileName:image.file});
    await journal.reserve(key,{operation:'uploadPng',synthetic:true});await journal.finish(key,'verified',image.uploadReceipt);
  }
  const session=environmentSession({NAVER_COOKIE:'NID_AUT=synthetic-market-aut; NID_SES=synthetic-market-ses'});t.after(()=>session.clear());
  const fetchImpl=async(raw,init)=>{
    const url=new URL(raw);
    if(url.pathname==='/BlogTagListInfo.naver')return new Response(JSON.stringify({taglist:[{msg:'',logno:state.logNo,tagName:encodeURIComponent(state.tags||'')}]}),{headers:{'content-type':'text/plain;charset=UTF-8'}});
    if(url.origin==='https://blogfiles.pstatic.net') {
      assert.equal(new Headers(init.headers).has('cookie'),false);
      return new Response(await readFile(path.join(directory,url.pathname.split('/').at(-1))),{headers:{'content-type':'image/png'}});
    }
    assert.equal(url.origin,'https://blog.naver.com','No commerce or unrelated API is required by this noncommercial create');
    if(url.pathname==='/PostWriteFormSeOptions.naver')return json({documentModel:state.model?JSON.stringify(state.model):null});
    if(url.pathname==='/PostWriteFormManagerOptions.naver')return json({blogId:job.blogId,isWriterBlogOwner:true,
      formView:{editorSource:'synthetic-source',postConfiguration:state.configuration,postFormMeta:{logNo:state.logNo,categoryId:job.publishSettings.categoryId,tags:state.tags||''}}});
    if(url.pathname==='/RabbitWrite.naver') {
      state.writes++;state.model=JSON.parse(init.body.get('documentModel'));
      state.configuration=JSON.parse(init.body.get('populationParams')).configuration;
      state.tags=JSON.parse(init.body.get('populationParams')).populationMeta.tags;
      return json({redirectUrl:`https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${state.logNo}`});
    }
    if(url.pathname==='/PostView.naver') {
      let html=publicHtml({...document,logNo:state.logNo});
      if(state.breakSourceLink)html=html.replace('href="https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400"','href="https://evil.example/"');
      return new Response(html,{headers:{'content-type':'text/html'}});
    }
    throw Error('UNEXPECTED_REQUEST');
  };
  const client=new NaverEditorClient({blogId:job.blogId,session,journal,fetchImpl,now:()=>NOW});
  const prepared=await client.prepareCreate(job,envelope);
  job.preflight={...job.preflight,...prepared};bind(job);
  // This transport fixture uses actual upload components, while the reusable
  // synthetic bind helper compiles a simplified comparison-image template.
  // Bind the already prepared exact presentation, as the native renderer does.
  job.preflight.compiledPresentationFingerprint=prepared.compiledPresentationFingerprint;
  for(const review of Object.values(job.publicationBundle.renderReviews))review.compiledPresentationFingerprint=prepared.compiledPresentationFingerprint;
  job.publicationBundleFingerprint=fingerprint(job.publicationBundle);
  job.preflight.publicationBundleFingerprint=job.publicationBundleFingerprint;
  job.authorization.contentFingerprint=publisherContentFingerprint(job);
  return {directory,job,envelope,client,state};
}

test('Market create performs one guarded HTTP write then verifies owner, category, exact public units, source hrefs and three image bytes',async t=>{
  const {directory,job,envelope,client,state}=await setup(t);
  const receipt=await client.createPost(job,{envelope,baseDir:directory});
  assert.equal(state.writes,1);assert.equal(receipt.readbackVerified,true);assert.equal(receipt.protectedOwnerVerified,true);
  assert.equal(receipt.searchAllowedVerified,true);assert.equal(receipt.exactReadback.passed,true);
  assert.equal(receipt.audit.uniqueVerifiedImageContents,3);assert.equal(receipt.audit.passed,true);
  assert.equal(receipt.resultGate.passed,true);assert.equal(receipt.data.receipt.publicReadback.researchSourceLinksPresent,true);
  assert.equal(Object.hasOwn(receipt.data.receipt.publicReadback,'affiliateLinkPresent'),false);
  assert.doesNotMatch(JSON.stringify(receipt),/synthetic-market-token|NID_AUT=/);
  await assert.rejects(client.createPost(job,{envelope,baseDir:directory}),/WRITE_ALREADY_ATTEMPTED/);assert.equal(state.writes,1);
});
test('missing public source href remains uncertain and reconciles by reads without another create',async t=>{
  const {directory,job,envelope,client,state}=await setup(t);state.breakSourceLink=true;
  await assert.rejects(client.createPost(job,{envelope,baseDir:directory}),{code:'WRITE_OUTCOME_UNKNOWN'});
  assert.equal(state.writes,1);await assert.rejects(client.reconcileCreate(job),{code:'CREATE_READBACK_MISMATCH'});
  state.breakSourceLink=false;assert.equal((await client.reconcileCreate(job)).readbackVerified,true);assert.equal(state.writes,1);
});
