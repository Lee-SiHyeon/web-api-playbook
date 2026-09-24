import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { NaverEditorClient } from '../scripts/api/editor-client.mjs';
import { WriteJournal } from '../scripts/api/write-journal.mjs';
import { environmentSession } from '../scripts/api/environment-session.mjs';
import { compileEditorModel } from '../scripts/api/editor-model.mjs';
import { createSeedDocument, validateCreateEnvelope } from '../scripts/api/create-envelope.mjs';
import { createSeedClipboardHtml } from '../scripts/hybrid/headless-inputs.mjs';
import { runHeadlessPublication } from '../scripts/hybrid/publisher.mjs';
import { publicationFixture, bind, seedModel, publicHtml, NOW, IMAGE_URL, IMAGE_BYTES } from './support/publication-fixture.mjs';
const json = result => new Response(JSON.stringify({ isSuccess: true, result }), { headers: { 'content-type': 'application/json' } });

test('link-free seed clipboard preserves all ordered paragraphs and escapes markup without adding links',()=>{
  const blocks=Array.from({length:28},(_,i)=>({type:'paragraph',text:`문단 ${i+1}: 2026년 9월 조건 <확인> & "요금"`}));
  const document={blogId:'aicandoanything',title:'링크 없는 쿠폰 기사',blocks};
  const html=createSeedClipboardHtml(document);
  assert.equal((html.match(/<p>/g)||[]).length,28);
  assert.ok(html.indexOf('문단 16:')<html.indexOf('문단 17:'));
  assert.match(html,/&lt;확인&gt; &amp; &quot;요금&quot;/);
  assert.doesNotMatch(html,/<a\b|<확인>/);
});

test('seed clipboard retains existing labeled links without inventing an image-banner text link',()=>{
  const document={blogId:'aicandoanything',title:'표시 링크 검증',blocks:[{type:'paragraph',text:'소개'},{type:'link',display:'label',label:'공식 <안내>',url:'https://example.com/?a=1&b=2'},{type:'image',href:'https://example.com/banner',publishedUrl:'https://example.com/image.png'},{type:'paragraph',text:'마침'}]};
  const html=createSeedClipboardHtml(document);
  assert.match(html,/<a href="https:\/\/example.com\/\?a=1&amp;b=2">공식 &lt;안내&gt;<\/a>/);
  assert.doesNotMatch(html,/example.com\/banner/);
});

async function setup(t, mode = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'naver-create-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const job = await publicationFixture(directory);
  job.target = { type: 'create' }; delete job.publicationBundle.document.logNo;
  job.inputProvider = 'headless_sdk'; job.publishSettings.visibility = mode.public ? 'public' : 'private';
  if(Object.hasOwn(mode,'searchAllowed'))job.publishSettings.searchAllowed=mode.searchAllowed;
  job.publicationBundle.collision.decision = 'create';
  const document = job.publicationBundle.document;
  const seed = compileEditorModel(seedModel(), createSeedDocument(document));
  for (const c of seed.document.components) for (const p of c.value || []) for (const n of p.nodes || [])
    if (n.value === job.affiliate.url) n.link = { url: job.affiliate.url };
  seed.documentId = ''; // Observed new-post envelope, not an existing post ID.
  const envelope = { blogId: job.blogId, observedAt: NOW.toISOString(), browserClosed: true, browserRequestCancelled: true,
    body: new URLSearchParams({ blogId: job.blogId, documentModel: JSON.stringify(seed),
      productApiVersion: 'v1', tokenId: 'synthetic-sdk-token', mediaResources: JSON.stringify({ image: [], video: [], file: [] }),
      populationParams: JSON.stringify({ editorSource: 'synthetic-source', configuration: { openType: 0,searchYn:false,commentYn:false,sympathyYn:true,outSideAllowYn:false,scrapType:2 },
        populationMeta: { logNo: 0, tags: '', postWriteTimeType: 'now', noticePostYn: false } }) }).toString() };
  const state = { writes: 0, model: null, failReadback: false, logNo: '987654321',configuration:{openType:0,searchYn:false,commentYn:false,sympathyYn:true,outSideAllowYn:false,scrapType:2},ownerSearchOverride:mode.wrongSearch };
  const session = environmentSession({ NAVER_COOKIE: 'NID_AUT=synthetic-aut; NID_SES=synthetic-ses' });
  t.after(() => session.clear());
  const fetchImpl = async (raw, init) => {
    const url = new URL(raw);
    if (url.pathname === '/BlogTagListInfo.naver') return new Response(JSON.stringify({taglist:[{msg:'',logno:state.logNo,tagName:encodeURIComponent(mode.wrongPublicTags?'다른태그':state.tags||'')}]}),{headers:{'content-type':'text/plain;charset=UTF-8'}});
    if(url.origin+url.pathname===IMAGE_URL)return new Response(IMAGE_BYTES,{headers:{'content-type':'image/png'}});
    if (url.origin === 'https://link.coupang.com') return new Response(null, {status:302,headers:{location:`https://www.coupang.com/vp/products/1000?itemId=2000&vendorItemId=3000&lptag=${mode.wrongAffiliate ? 'AF999' : 'AF1234567'}`}});
    if (url.pathname === '/PostWriteFormSeOptions.naver') return json({ documentModel: state.model ? JSON.stringify(state.model) : null });
    if (url.pathname === '/PostWriteFormManagerOptions.naver') return json({ blogId: job.blogId, isWriterBlogOwner: true,
      formView: { editorSource: 'synthetic-source', postConfiguration: {...state.configuration,
        ...(mode.wrongVisibility?{openType:2}:{}),...(state.ownerSearchOverride!==undefined?{searchYn:state.ownerSearchOverride}:{}),...(mode.wrongOutside?{outSideAllowYn:true}:{})},
        postFormMeta: { logNo: state.logNo, tags: mode.wrongOwnerTags?'다른태그':state.tags || '' } } });
    if (url.pathname === '/RabbitWrite.naver') {
      state.writes++;
      assert.equal(init.redirect, 'manual');
      assert.equal(JSON.parse(init.body.get('populationParams')).configuration.openType, mode.public ? 2 : 0);
      state.configuration=JSON.parse(init.body.get('populationParams')).configuration;
      state.tags=JSON.parse(init.body.get('populationParams')).populationMeta.tags;
      state.model = JSON.parse(init.body.get('documentModel'));
      if (mode.lostResponse) throw Error('synthetic-lost-response');
      return json({ redirectUrl: `https://${mode.foreignRedirect ? 'evil.example' : 'blog.naver.com'}/PostView.naver?blogId=${job.blogId}&logNo=${state.logNo}` });
    }
    if (url.pathname === '/PostView.naver') {
      if (state.failReadback) throw Error('synthetic-readback-error');
      return new Response(publicHtml({ ...document, logNo: state.logNo }), { headers: { 'content-type': 'text/html' } });
    }
    throw Error('UNEXPECTED_REQUEST');
  };
  const journal = new WriteJournal(path.join(directory, 'journal'));
  // Synthetic, locally journalled upload; no production receipt is fabricated.
  const image=document.blocks.find(b=>b.type==='image');
  image.uploadReceipt={schemaVersion:1,operation:'uploadPng',source:'independent_http',blogId:job.blogId,
    checkedAt:NOW.toISOString(),sha256:image.sha256,publishedUrl:IMAGE_URL,fileName:'comparison.png',
    width:12,height:8,fileSize:IMAGE_BYTES.length,readbackVerified:true};
  const imageKey=journal.key('uploadPng',{blogId:job.blogId},{sha256:image.sha256,fileName:'comparison.png'});
  await journal.reserve(imageKey,{operation:'uploadPng',synthetic:true});
  await journal.finish(imageKey,'verified',image.uploadReceipt);
  const client = new NaverEditorClient({ blogId: job.blogId, affiliateAccounts: {fixtureblog:'AF1234567'}, session, journal, fetchImpl, now: () => NOW });
  job.preflight = { ...job.preflight, ...await client.prepareCreate(job, envelope) };
  bind(job);
  return { directory, job, envelope, state, client, journal, session, fetchImpl };
}

test('generic create replaces the seed document, journals returned ID, and verifies full private readback', async t => {
  const { client, job, envelope, directory, state } = await setup(t);
  const receipt = await client.createPost(job, { envelope, baseDir: directory });
  assert.equal(state.writes, 1); assert.equal(receipt.readbackVerified, true);
  assert.equal(receipt.resultGate.passed, true); assert.equal(receipt.browserEngineFree, false);
  assert.equal(receipt.audit.passed, true);
  assert.equal(receipt.tagsVerified, true); assert.equal(state.tags, job.publishSettings.tags.join(','), 'Explicit job tags replace the empty private SDK seed tags');
  assert.equal(receipt.searchAllowedVerified,false);assert.equal(state.configuration.searchYn,false);
  assert.equal(state.model.document.components.some(c => c['@ctype'] === 'quotation'), true);
  assert.equal(job.target.logNo, undefined); // Do not mutate the approved target to authorize the returned ID.
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-sdk-token|NID_AUT=/);
});

for (const flag of ['wrongOwnerTags', 'wrongPublicTags']) test(`create cannot complete with ${flag} despite exact title/body and images`, async t => {
  const {client, job, envelope, directory, state} = await setup(t, {public: true, [flag]: true});
  await assert.rejects(client.createPost(job, {envelope, baseDir: directory}), {code: 'WRITE_OUTCOME_UNKNOWN'});
  assert.equal(state.writes, 1);
  await assert.rejects(client.reconcileCreate(job), {code: 'CREATE_READBACK_MISMATCH'});
  assert.equal(state.writes, 1);
});
test('a missing captured seed paragraph still blocks creation and diagnostics exclude body text and tokens',async t=>{
  const {job,envelope,state}=await setup(t);
  const body=new URLSearchParams(envelope.body),model=JSON.parse(body.get('documentModel'));
  const index=model.document.components.findIndex(c=>c['@ctype']==='text');
  assert.ok(index>=0);model.document.components.splice(index,1);body.set('documentModel',JSON.stringify(model));
  const changed={...envelope,body:body.toString()};
  assert.throws(()=>validateCreateEnvelope(changed,{blogId:job.blogId,document:job.publicationBundle.document,now:NOW}),error=>{
    assert.equal(error.message,'CREATE_SEED_CONTENT_MISMATCH');
    assert.ok(error.details.expectedUnitCount>error.details.observedUnitCount);
    assert.ok(error.details.firstMismatchIndex>=0);
    assert.match(error.details.expectedUnit.fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(error.details.expectedUnit,'value'),false);
    assert.doesNotMatch(JSON.stringify(error.details),/synthetic-sdk-token|NID_AUT|synthetic-source/);
    return true;
  });
  assert.equal(state.writes,0);
});
test('new job IDs and fresh tokens cannot repeat an attempted create', async t => {
  const { client, job, envelope, directory, state } = await setup(t);
  await client.createPost(job, { envelope, baseDir: directory });
  job.jobId = 'synthetic-other-job'; bind(job);
  const body = new URLSearchParams(envelope.body); body.set('tokenId', 'synthetic-new-sdk-token'); envelope.body = body.toString();
  await assert.rejects(client.createPost(job, { envelope, baseDir: directory }), /WRITE_ALREADY_ATTEMPTED/);
  assert.equal(state.writes, 1);
});
test('reviewed public create applies the same affiliate gate and exact clickable readback',async t=>{
  const {client,job,envelope,directory,state}=await setup(t,{public:true});
  const receipt=await client.createPost(job,{envelope,baseDir:directory});
  assert.equal(state.writes,1);assert.equal(receipt.visibilityVerified,'public');assert.equal(receipt.exactReadback.checks.affiliateClickable,true);
  assert.equal(receipt.searchAllowedVerified,true);assert.deepEqual(state.configuration,{openType:2,searchYn:true,commentYn:false,sympathyYn:true,outSideAllowYn:false,scrapType:2});
});

for(const mode of [{public:true,searchAllowed:false},{public:true,searchAllowed:true},{searchAllowed:false}])test(`create preserves explicit searchAllowed=${mode.searchAllowed}, public=${Boolean(mode.public)}`,async t=>{
  const {client,job,envelope,directory,state}=await setup(t,mode);
  const receipt=await client.createPost(job,{envelope,baseDir:directory});
  assert.equal(receipt.configurationVerified,true);assert.equal(receipt.searchAllowedVerified,mode.searchAllowed);
  assert.equal(state.configuration.searchYn,mode.searchAllowed);assert.equal(state.configuration.commentYn,false);assert.equal(state.configuration.outSideAllowYn,false);
});
test('public create with unchanged body but wrong owner search setting stays uncertain and reconciles read-only',async t=>{
  const {client,job,envelope,directory,state}=await setup(t,{public:true,wrongSearch:false});
  await assert.rejects(client.createPost(job,{envelope,baseDir:directory}),{code:'WRITE_OUTCOME_UNKNOWN'});
  await assert.rejects(client.reconcileCreate(job),{code:'CREATE_READBACK_MISMATCH'});
  state.ownerSearchOverride=undefined;
  assert.equal((await client.reconcileCreate(job)).searchAllowedVerified,true);assert.equal(state.writes,1);
});
test('public create verifies preserved non-search settings as well as search and body',async t=>{
  const {client,job,envelope,directory,state}=await setup(t,{public:true,wrongOutside:true});
  await assert.rejects(client.createPost(job,{envelope,baseDir:directory}),{code:'WRITE_OUTCOME_UNKNOWN'});assert.equal(state.writes,1);
});
test('search intent has strict boolean/private scope and cannot change after authorization',async t=>{
  for(const value of [null,'true',1]){
    const {client,job,envelope,directory,state}=await setup(t,{public:true});job.publishSettings.searchAllowed=value;bind(job);
    await assert.rejects(client.createPost(job,{envelope,baseDir:directory}),{code:'PUBLICATION_GATE_FAILED'});assert.equal(state.writes,0);
  }
  const privateJob=await setup(t);privateJob.job.publishSettings.searchAllowed=true;bind(privateJob.job);
  await assert.rejects(privateJob.client.createPost(privateJob.job,{envelope:privateJob.envelope,baseDir:privateJob.directory}),{code:'PUBLICATION_GATE_FAILED'});assert.equal(privateJob.state.writes,0);
  const changed=await setup(t,{public:true});changed.job.publishSettings.searchAllowed=false;
  await assert.rejects(changed.client.createPost(changed.job,{envelope:changed.envelope,baseDir:changed.directory}),{code:'PUBLICATION_GATE_FAILED'});assert.equal(changed.state.writes,0);
});
test('public create refuses a wrong live affiliate account before POST',async t=>{
  const {client,job,envelope,directory,state}=await setup(t,{public:true,wrongAffiliate:true});
  await assert.rejects(client.createPost(job,{envelope,baseDir:directory}),{code:'AFFILIATE_PUBLICATION_BLOCKED'});
  assert.equal(state.writes,0);
});
test('returned identity survives readback failure and reconciles by GET without resubmission', async t => {
  const { client, job, envelope, directory, state } = await setup(t);
  state.failReadback = true;
  await assert.rejects(client.createPost(job, { envelope, baseDir: directory }), /WRITE_OUTCOME_UNKNOWN/);
  state.failReadback = false;
  assert.equal((await client.reconcileCreate(job)).readbackVerified, true);
  assert.equal(state.writes, 1);
});
for (const mode of ['lostResponse', 'foreignRedirect', 'wrongVisibility']) test(`create ${mode} never auto-retries`, async t => {
  const { client, job, envelope, directory, state } = await setup(t, { [mode]: true });
  await assert.rejects(client.createPost(job, { envelope, baseDir: directory }), /WRITE_OUTCOME_UNKNOWN/);
  await assert.rejects(client.createPost(job, { envelope, baseDir: directory }), /WRITE_ALREADY_ATTEMPTED/);
  assert.equal(state.writes, 1);
});
for (const mode of ['expired', 'openBrowser', 'tamperedSeed', 'duplicateFields', 'badGate', 'unverifiedPublicCreate']) test(`create rejects ${mode} before POST`, async t => {
  const { client, job, envelope, directory, state } = await setup(t);
  if (mode === 'expired') envelope.observedAt = '2026-09-20T09:58:00Z';
  if (mode === 'openBrowser') envelope.browserClosed = false;
  if (mode === 'tamperedSeed') {
    const form = new URLSearchParams(envelope.body); form.set('documentModel', JSON.stringify(seedModel())); envelope.body = form.toString();
  }
  if (mode === 'duplicateFields') envelope.body += '&tokenId=synthetic-second';
  if (mode === 'badGate') job.publicationBundle.qualityReview.decision = 'fail';
  if (mode === 'unverifiedPublicCreate') { job.publishSettings.visibility = 'public'; }
  await assert.rejects(client.createPost(job, { envelope, baseDir: directory }));
  assert.equal(state.writes, 0);
});
test('hybrid runner evaluates business gates before collecting an SDK token or launching Chrome', async t => {
  const { job, directory } = await setup(t);
  job.authorization.approved = false;
  let collected = 0;
  await assert.rejects(runHeadlessPublication({ job, command: 'create', baseDir: directory }, {
    now: () => NOW, collect: async () => { collected++; },
  }), /PUBLICATION_GATE_FAILED/);
  assert.equal(collected, 0);
});

test('empty tags block both ordinary API creation and hybrid collection before any publication POST', async t => {
  const {client, job, envelope, directory, state} = await setup(t, {public: true});
  job.publishSettings.tags = []; bind(job);
  await assert.rejects(client.createPost(job, {envelope, baseDir: directory}), error => error.code === 'PUBLICATION_GATE_FAILED' && error.details.failedChecks.includes('publicationTagsPresent'));
  let collected = 0;
  await assert.rejects(runHeadlessPublication({job, command:'create', baseDir:directory}, {now:()=>NOW, collect:async()=>{collected++;}}), /PUBLICATION_GATE_FAILED/);
  assert.equal(collected, 0); assert.equal(state.writes, 0);
});

test('changing selected tags after authorization blocks the ordinary create before POST', async t => {
  const {client, job, envelope, directory, state} = await setup(t, {public: true});
  job.publishSettings.tags = ['태그변경'];
  await assert.rejects(client.createPost(job, {envelope, baseDir: directory}), error => error.code === 'PUBLICATION_GATE_FAILED' && error.details.failedChecks.includes('authorizationContentMatches'));
  assert.equal(state.writes, 0);
});
test('image-free create cannot collect an SDK token or submit a POST even with zero optional minimums',async t=>{
 const {client,job,envelope,directory,state}=await setup(t);
 job.minImageCount=0;job.minImageComponents=0;
 job.publicationBundle.document.blocks=job.publicationBundle.document.blocks.filter(b=>b.type!=='image');bind(job);
 await assert.rejects(client.createPost(job,{envelope,baseDir:directory}),{code:'PUBLICATION_GATE_FAILED'});
 let collected=0;
 await assert.rejects(runHeadlessPublication({job,command:'create',baseDir:directory},{now:()=>NOW,collect:async()=>{collected++;}}),/PUBLICATION_GATE_FAILED/);
 assert.equal(state.writes,0);assert.equal(collected,0);
});
test('an existing journal prevents even relaunching the headless input provider', async t => {
  const { client, job, envelope, directory, journal } = await setup(t);
  await client.createPost(job, { envelope, baseDir: directory });
  let collected = 0;
  await assert.rejects(runHeadlessPublication({ job, command: 'create', baseDir: directory, journal: journal.directory }, {
    now: () => NOW, collect: async () => { collected++; },
  }), /WRITE_ALREADY_ATTEMPTED/);
  assert.equal(collected, 0);
});
test('hybrid runner closes input browser before a separate HTTP child and clears handoff secrets', async t => {
  const { job, envelope, directory } = await setup(t), order = [];
  const captured = { envelope, metadata: { browserClosed: true },
    cookieHeader: 'NID_AUT=synthetic-aut; NID_SES=synthetic-ses' };
  const result = await runHeadlessPublication({ job, command: 'create', baseDir: directory,
    jobPath: path.join(directory, 'job.json'), journal: path.join(directory, 'journal'),
    cookieHeader: captured.cookieHeader }, {
    now: () => NOW, env: { SystemRoot: 'C:\\Windows', UNRELATED_SECRET: 'synthetic-unrelated' },
    verifyOwner: async () => { order.push('owner'); },
    collect: async () => { order.push('closed_browser'); return captured; },
    spawnImpl: (_, args, options) => {
      order.push('http_child'); assert.equal(options.env.UNRELATED_SECRET, undefined);
      assert.match(options.env.NAVER_COOKIE, /synthetic-aut/);
      assert.equal(args[0], 'scripts/api/publisher-cli.mjs');
      assert.doesNotMatch(args.join(' '), /synthetic-aut|synthetic-sdk-token/);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = input => {
        assert.equal(JSON.parse(input).browserClosed, true);
        queueMicrotask(() => { child.stdout.emit('data', Buffer.from('{"ok":true}')); child.emit('close', 0); });
      };
      return child;
    },
  });
  assert.deepEqual(order, ['owner', 'closed_browser', 'http_child']);
  assert.equal(result.browserClosedBeforeHTTPWrite, true);
  assert.equal(captured.envelope.body, ''); assert.equal(captured.cookieHeader, '');
});
