import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validPublicationTags, serializePublicationTags, parseOwnerTags, parsePublicTagResponse, tagsOnlyContentFingerprint} from '../scripts/gates/publication-tags.mjs';
import {evaluatePublisherJobGate, publisherContentFingerprint} from '../scripts/gates/publisher-gates.mjs';
import {parsePublicDocument} from '../scripts/api/public-document.mjs';
import {NaverEditorClient} from '../scripts/api/editor-client.mjs';
import {WriteJournal} from '../scripts/api/write-journal.mjs';
import {environmentSession} from '../scripts/api/environment-session.mjs';
import {compileEditorModel} from '../scripts/api/editor-model.mjs';
import {NOW, seedModel, publicHtml, publicationFixture, IMAGE_URL} from './support/publication-fixture.mjs';

test('tags are reviewed canonical values with observed 30-count/100-character boundaries', () => {
  const tags = ['비트코인', 'AI개발', '11월이탈리아여행'];
  assert.equal(serializePublicationTags(tags), tags.join(',')); assert.deepEqual(parseOwnerTags(tags.join(',')), tags);
  for (const invalid of [[], [''], ['#비트코인'], ['AI,개발'], ['AI 개발'], ['AI\n'], ['AI', 'ai'], ['태그', '태그'], ['A'.repeat(101)], Array.from({length:31}, (_,i) => `태그${i}`)]) assert.equal(validPublicationTags(invalid), false);
  assert.equal(validPublicationTags(Array.from({length:30}, (_,i) => `태그${i}`)), true);
  assert.equal(validPublicationTags(['A'.repeat(100)]), true);
});

test('public tag API decoding is scoped and uses UTF-8 tagName, never legacy encTagName', () => {
  const tags = ['바티칸투어', '11월이탈리아여행'];
  assert.deepEqual(parsePublicTagResponse({taglist:[{msg:'',logno:'123456',tagName:encodeURIComponent(tags.join(',')),encTagName:'invalid-legacy'}]}, '123456'), tags);
  assert.deepEqual(parsePublicTagResponse({taglist:[]}, '123456'), []);
  for (const response of [{}, {taglist:[{msg:'',logno:'999999',tagName:''}]}, {taglist:[{msg:'denied',logno:'123456',tagName:''}]}, {taglist:[{msg:'',logno:'123456',tagName:'%xx'}]}]) assert.throws(() => parsePublicTagResponse(response,'123456'));
});

test('body hashtags and another post tag list cannot masquerade as current metadata', () => {
  const doc = {blogId:'aicandoanything',logNo:'123456',title:'메타데이터 검사',blocks:[{type:'paragraph',text:'#비트코인 #시장분석'}]};
  const html = publicHtml(doc,{tags:[]}).replace('</body>', '<div id="tagList_999999"><a class="itemTagfont"><span class="ell">#다른글</span></a></div></body>');
  const observation = parsePublicDocument(html,{url:'https://blog.naver.com/PostView.naver?blogId=aicandoanything&logNo=123456'});
  assert.deepEqual(observation.tags, []); assert.equal(observation.tagsObserved, false);
});

test('ordinary full publication requires tags and authorization fingerprints bind their exact values', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'naver-tags-gate-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const job = await publicationFixture(dir), original = publisherContentFingerprint(job);
  delete job.publishSettings.tags;
  const gate = await evaluatePublisherJobGate(job,{baseDir:dir,now:NOW}); assert.equal(gate.checks.publicationTagsPresent,false);
  job.publishSettings.tags=['다른주제']; assert.notEqual(publisherContentFingerprint(job),original);
});

const json = result => new Response(JSON.stringify({isSuccess:true,result}),{headers:{'content-type':'application/json'}});
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'naver-tags-only-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const logNo='224419142479', document={blogId:'aicandoanything',logNo,title:'기존 공개 문서의 내용 보존 검사',blocks:[
    {type:'paragraph',text:'이 본문의 가격이나 분석은 태그 수정 작업에서 새로 검증했다고 주장하지 않습니다.'},
    {type:'image',publishedUrl:IMAGE_URL},
    {type:'link',display:'label',label:'기존 외부 링크 보존',url:'https://link.coupang.com/a/existing123'},
  ]};
  const originalModel=compileEditorModel(seedModel(),document); originalModel.opaqueOriginal={retained:true};
  const originalConfiguration={openType:2,searchYn:true,commentYn:false,sympathyYn:true,commercialUsesYn:null};
  const originalMetadata={logNo:Number(logNo),categoryId:13,tags:'',themeSourceCode:0,noticePostYn:false,postLocationJson:{original:true}};
  const state={writes:0,model:structuredClone(originalModel),configuration:structuredClone(originalConfiguration),metadata:structuredClone(originalMetadata),postMutation:null,publicTags:null,publicChanged:false,lostResponse:false,wrongOwner:false};
  const job={jobId:'synthetic-tags-only',operation:'update_tags',blogId:'aicandoanything',target:{type:'update',logNo},tags:['비트코인','시장분석'],executionMode:'independent_http'};
  const session=environmentSession({NAVER_COOKIE:'NID_AUT=synthetic; NID_SES=synthetic'});t.after(()=>session.clear());
  const fetchImpl=async(raw,init)=>{
    const url=new URL(raw); assert.equal(url.origin,'https://blog.naver.com');
    if(url.pathname==='/PostWriteFormSeOptions.naver')return json({documentModel:JSON.stringify(state.model)});
    if(url.pathname==='/PostWriteFormManagerOptions.naver')return json({blogId:job.blogId,isWriterBlogOwner:!state.wrongOwner,
      formView:{editorSource:'observed-source',postConfiguration:state.configuration,postFormMeta:state.metadata}});
    if(url.pathname==='/PostView.naver') {
      assert.equal(new Headers(init.headers).has('cookie'),false);
      return new Response(publicHtml(state.publicChanged?{...document,title:'외부에서 변경된 제목입니다'}:document,{tags:[]}),{headers:{'content-type':'text/html'}});
    }
    if(url.pathname==='/BlogTagListInfo.naver') {
      assert.equal(new Headers(init.headers).has('cookie'),false);assert.equal(url.searchParams.get('logNoList'),logNo);assert.equal(url.searchParams.get('logType'),'mylog');
      const tags=state.publicTags??state.metadata.tags;
      return new Response(JSON.stringify({taglist:tags?[{msg:'',logno:logNo,tagName:encodeURIComponent(tags)}]:[]}),{headers:{'content-type':'text/plain;charset=UTF-8'}});
    }
    if(url.pathname==='/RabbitUpdate.naver') {
      state.writes++; const model=JSON.parse(init.body.get('documentModel')),population=JSON.parse(init.body.get('populationParams'));
      if(state.delayedUnknown)throw Error('Synthetic request outcome unknown while old state is still visible');
      assert.deepEqual(model,originalModel,'Complete original model is submitted without recompiling it');
      assert.deepEqual({...population.populationMeta,tags:''},{logNo:Number(logNo),categoryId:13,tags:'',noticePostYn:false,postLocationJson:{original:true}});
      state.model=model;state.configuration={...state.configuration,...population.configuration};state.metadata={...state.metadata,...population.populationMeta};
      state.postMutation?.(state);
      if(state.lostResponse)throw Error('Synthetic response lost');
      return json({redirectUrl:`https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${logNo}`});
    }
    throw Error('UNEXPECTED_REQUEST');
  };
  const client=new NaverEditorClient({blogId:job.blogId,session,fetchImpl,journal:new WriteJournal(path.join(dir,'journal')),now:()=>NOW});
  job.preflight=await client.prepareTags(job);
  job.authorization={approved:true,approvedBy:'user',approvedAt:NOW.toISOString(),scope:'update_tags_once',contentFingerprint:tagsOnlyContentFingerprint(job)};
  return {job,client,state,originalModel,originalConfiguration,originalMetadata};
}

test('tags-only performs one journaled write, preserves raw model and all other state, and independently verifies owner/public tags',async t=>{
  const {job,client,state}=await setup(t);const receipt=await client.updateTags(job);
  assert.equal(state.writes,1);assert.equal(receipt.readbackVerified,true);assert.equal(receipt.metadataOnly,true);assert.equal(receipt.contentQualityRevalidated,false);
  assert.deepEqual(Object.values(receipt.checks),Array(9).fill(true));assert.deepEqual(receipt.tags,job.tags);
  assert.equal((await client.reconcileTags(job)).readbackVerified,true);assert.equal(state.writes,1);
  await assert.rejects(client.updateTags(job));assert.equal(state.writes,1);
});

for(const [name,mutate] of [
  ['document payload',j=>j.document={title:'replace content'}],['settings payload',j=>j.publishSettings={visibility:'private'}],
  ['normal publication bundle',j=>j.publicationBundle={format:'market_analysis_article'}],['changed tags after approval',j=>j.tags=['변경된태그']],
  ['stale preflight',j=>j.preflight.checkedAt='2026-09-19T00:00:00Z'],['wrong authorization scope',j=>j.authorization.scope='publish_once'],
])test(`tags-only rejects ${name} before POST`,async t=>{const {job,client,state}=await setup(t);mutate(job);await assert.rejects(client.updateTags(job),{code:'TAGS_ONLY_GATE_FAILED'});assert.equal(state.writes,0);});

for(const [name,mutate] of [
  ['original content',s=>s.model.opaqueOriginal.retained=false],['configuration',s=>s.configuration.commentYn=true],
  ['other metadata',s=>s.metadata.categoryId=12],['public content',s=>s.publicChanged=true],['already tagged post',s=>s.metadata.tags='기존태그'],
])test(`tags-only rejects concurrently changed ${name}`,async t=>{const {job,client,state}=await setup(t);mutate(state);await assert.rejects(client.updateTags(job),{code:'TAGS_SOURCE_CHANGED'});assert.equal(state.writes,0);});

for(const [name,mutate] of [
  ['body model',s=>s.model.opaqueOriginal.retained=false],['configuration',s=>s.configuration.commentYn=true],
  ['metadata',s=>s.metadata.categoryId=12],['public tag mismatch',s=>s.publicTags='틀린태그'],
])test(`post-write ${name} mismatch stays uncertain and reconciles without another write`,async t=>{
  const {job,client,state,originalModel,originalConfiguration,originalMetadata}=await setup(t);state.postMutation=mutate;
  await assert.rejects(client.updateTags(job),{code:'WRITE_OUTCOME_UNKNOWN'});assert.equal(state.writes,1);assert.equal((await client.reconcileTags(job)).readbackVerified,false);
  state.model=structuredClone(originalModel);state.configuration=structuredClone(originalConfiguration);state.metadata={...originalMetadata,tags:job.tags.join(',')};state.publicTags=null;
  assert.equal((await client.reconcileTags(job)).readbackVerified,true);assert.equal(state.writes,1);
});

test('lost tags response is reconciled from exact owner/public state without fabricating an accepted API response',async t=>{
  const {job,client,state}=await setup(t);state.lostResponse=true;const result=await client.updateTags(job);
  assert.equal(result.readbackVerified,true);assert.equal(result.accepted,false);assert.equal(state.writes,1);
});

for(const [name,mutate] of [
  ['nondefault omitted configuration',s=>s.configuration.commercialUsesYn=true],
  ['nondefault omitted metadata',s=>s.metadata.themeSourceCode=1],
  ['unknown configuration',s=>s.configuration.newSetting=null],
  ['unknown metadata',s=>s.metadata.newMetadata=''],
])test(`tags-only rejects ${name} before a write even after new preparation`,async t=>{
  const {job,client,state}=await setup(t);mutate(state);
  await assert.rejects(client.prepareTags(job),{code:'TAGS_UNSUPPORTED_ORIGINAL_SETTINGS'});
  await assert.rejects(client.updateTags(job),{code:'TAGS_UNSUPPORTED_ORIGINAL_SETTINGS'});
  assert.equal(state.writes,0);
});

test('target reservation survives an uncertain result, fresh preparation, reordered tags and a new authorization',async t=>{
  const {job,client,state}=await setup(t);state.delayedUnknown=true;
  await assert.rejects(client.updateTags(job),{code:'WRITE_OUTCOME_UNKNOWN'});assert.equal(state.writes,1);
  job.jobId='new-synthetic-tags-job';job.tags.reverse();job.preflight=await client.prepareTags(job);
  job.authorization.contentFingerprint=tagsOnlyContentFingerprint(job);
  await assert.rejects(client.updateTags(job),/WRITE_ALREADY_ATTEMPTED_READBACK_REQUIRED/);
  assert.equal(state.writes,1);
  await assert.rejects(client.reconcileTags(job),{code:'TAGS_JOURNAL_MISMATCH'});
});
