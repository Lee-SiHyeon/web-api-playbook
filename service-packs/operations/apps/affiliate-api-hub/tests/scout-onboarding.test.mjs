import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractScoutFindings,mergeScoutQueue,checkpointScoutQueue,selectScoutWork,
  mergeScoutManifest,syncScoutQueue,readScoutQueue,publicSourceUrl } from '../lib/scout-onboarding.mjs';
import { inspectOnboarding,selectNextWork } from '../scripts/api-only-onboarding.mjs';
import { saveCheckpoint } from '../scripts/scout-api-queue.mjs';

const seeds={schemaVersion:1,services:[{id:'threads',provider:'discovery',priority:100,
  sourceHosts:['threads.com'],label:'Threads',nextTask:'old task'}]};
const when='2026-09-27T06:00:00Z';
const refs=(queue,id)=>queue.services.find(x=>x.id===id).findings.map(x=>({id:x.id,revision:x.revision}));
const finding=(host='new-source.example',extra={})=>({sourceUrl:`https://${host}/article`,
  title:'Scouted source',whyUseful:'Fills a documented evidence gap',ontologyRefs:['acada:example#Source'],
  disposition:'accepted',checkedAt:when,readCoverage:'full_text',evidenceFile:'workflow-runs/scout/scouting-findings.json',
  evidencePointer:'/findings/0',...extra});

test('a new scouted domain enters the real manifest and work selection without editing seeds',async()=>{
  const queue=mergeScoutQueue(null,[finding()],seeds,when);
  const manifest=mergeScoutManifest(seeds,queue);
  assert.equal(seeds.services.length,1);
  assert.equal(manifest.services.length,2);
  const result=await inspectOnboarding({manifest,scoutQueue:queue,
    keeper:async()=>({services:{}}),credentialStatus:async()=>false});
  assert.equal(result.nextWork[0].host,'new-source.example');
  assert.equal(result.nextWork[0].origin,'scouting');
  assert.equal(result.nextWork[0].stage,'access_assessment');
  assert.equal(result.signupWrites,0);
  assert.equal(result.services[1].accountExistence,'unknown');
});

test('reference evidence connects the discovered service to its supporting claim and concept',()=>{
  const rows=extractScoutFindings({kind:'reference_knowledge',id:'graph',checkedAt:when,
    sourceObservations:[{id:'s',canonicalUrl:'https://novel.example/help',title:'help',summary:'input requirements',acquisition:{contentCoverage:'reviewed_section'}}],
    evidenceSpans:[{id:'e',observationId:'s'}],claims:[{id:'c',subjectId:'input-quality',text:'requires a source image',evidenceSpanIds:['e']}]},'reference.json');
  const queue=mergeScoutQueue(null,rows,seeds,when);
  assert.deepEqual(queue.services[0].findings[0].ontologyRefs,['graph#input-quality']);
  assert.equal(queue.services[0].findings[0].whyUseful,'requires a source image');
});

test('source ledgers accept both text and list ontology rationale and retain the real ontology identity',()=>{
  const rows=extractScoutFindings({snapshotId:'scan',capturedOn:when,ontologyId:'acada:side-hustle',sourceRecords:[{
    id:'new',url:'https://panelnow.co.kr/survey',title:'survey rules',evidenceClass:'first_party_rule',
    ontologyUse:'PayoutCondition rules',scopeDisposition:'in_scope'}]},'scan.json');
  const queue=mergeScoutQueue(null,rows,seeds,when);
  assert.equal(queue.services.length,1);
  assert.deepEqual(queue.services[0].findings[0].ontologyRefs,['acada:side-hustle']);
  assert.deepEqual(queue.services[0].findings[0].sourceRefs,['scan#new']);
});

test('source reading and an explicitly scouted service get different first tasks',()=>{
  const queue=mergeScoutQueue(null,[finding('law-source.example'),finding('review.example',{
    apiOnlyTarget:{url:'https://new-tool.example/',capabilities:['source_read','account_access_discovery']}})],seeds,when);
  assert.equal(queue.services.find(x=>x.host==='law-source.example').accessKind,'source_read');
  const service=queue.services.find(x=>x.host==='new-tool.example');
  assert.equal(service.accessKind,'service_access');
  assert.equal(service.findings[0].sourceUrl,'https://review.example/article');
  const docs=extractScoutFindings({kind:'reference_knowledge',id:'docs',checkedAt:when,
    sourceObservations:[{id:'s',canonicalUrl:'https://docs.photoroom.com/',platform:'official_web',acquisition:{contentCoverage:'reviewed_section'}}],
    evidenceSpans:[{id:'e',observationId:'s'}],claims:[{id:'c',subjectId:'api-docs',text:'documented requirements',evidenceSpanIds:['e']}]},'docs.json');
  assert.equal(mergeScoutQueue(null,docs,seeds,when).services[0].accessKind,'source_read');
});

test('scouted work comes first and spare capacity continues original work without reopening queued blockers',()=>{
  let queue=mergeScoutQueue(null,[finding()],seeds,when);
  const services=[{id:'threads',priority:100,authentication:'auth_unverified'},
    {id:'gmarket',priority:98,authentication:'auth_unverified'}];
  assert.deepEqual(selectNextWork(services,2,queue).map(x=>x.service),[queue.services[0].id,'threads']);
  queue=mergeScoutQueue(queue,[finding('threads.com')],seeds,when,[]);
  queue=checkpointScoutQueue(queue,{service:'threads',status:'blocked',stage:'login_signup_flow',
    evidenceFile:'flow.json',nextTask:'resume',resumeCondition:'new input'},when);
  assert.deepEqual(selectNextWork(services,2,queue).map(x=>x.service),[queue.services.find(x=>x.host==='new-source.example').id,'gmarket']);
  queue.services.find(x=>x.id==='threads').sourceActive=false;
  assert.equal(selectNextWork(services,2,queue)[1].service,'threads');
});

test('duplicates merge by site while excluded, unread and unsupported input is not promoted',()=>{
  const rows=[finding(),finding('www.new-source.example'),finding('ignored.example',{disposition:'excluded'}),
    finding('unread.example',{readCoverage:'not_read'}),finding('no-purpose.example',{whyUseful:''}),
    finding('duplicate.example',{duplicateOf:'prior'}),finding('127.0.0.1')];
  const queue=mergeScoutQueue(null,rows,seeds,when);
  assert.equal(queue.services.length,1);
  assert.equal(queue.importSummary.skipped,5);
  assert.deepEqual(extractScoutFindings({kind:'reference-scout',genres:{}},'rankings.json'),[]);
  assert.equal(publicSourceUrl('https://user:pass@example.com/'),null);
  assert.equal(publicSourceUrl('https://site.example/a?token=secret&si=tracking&no=14'),'https://site.example/a?no=14');
});

test('known host reuses its client but successful auth does not finish collector integration',()=>{
  const queue=mergeScoutQueue(null,[finding('threads.com')],seeds,when);
  assert.equal(queue.services[0].id,'threads');
  assert.equal(mergeScoutManifest(seeds,queue).services.length,1);
  assert.equal(selectNextWork([{id:'threads',authentication:'authenticated'}],2,queue)[0].service,'threads');
});

test('unchanged blockers and completed work persist; newly scouted domains are not starved',()=>{
  let queue=mergeScoutQueue(null,[finding('a.example'),finding('b.example')],seeds,when);
  const [a,b]=queue.services;
  queue=checkpointScoutQueue(queue,{service:a.id,status:'blocked',stage:'login_signup_flow',
    evidenceFile:'flow.json',nextTask:'resume after code',resumeCondition:'User verification available'},when);
  queue=checkpointScoutQueue(queue,{service:b.id,status:'complete',stage:'complete',
    evidenceFile:'integration.json',nextTask:'Maintain completed adapter',processedFindings:refs(queue,b.id)},when);
  queue=mergeScoutQueue(queue,[finding('a.example'),finding('b.example'),finding('c.example')],seeds,when);
  assert.deepEqual(selectScoutWork(queue).map(x=>x.host),['c.example']);
  const c=queue.services.find(x=>x.host==='c.example');
  queue=checkpointScoutQueue(queue,{service:c.id,status:'ready',stage:'http_capture',evidenceFile:'flow.json',nextTask:'capture'},when);
  queue=mergeScoutQueue(queue,[finding('d.example')],seeds,when,[]);
  assert.equal(selectScoutWork(queue)[0].host,'d.example');
});

test('a fresh scouted host outranks older untouched work even when its fixed priority is lower',()=>{
  const oldAt='2026-09-10T00:00:00Z',newAt='2026-09-29T00:00:00Z';
  let queue=mergeScoutQueue(null,[finding('old.example')],seeds,oldAt);
  queue=mergeScoutQueue(queue,[finding('new.example')],seeds,newAt,[]);
  queue.services.find(row=>row.host==='old.example').priority=1000;
  assert.equal(selectScoutWork(queue,1,newAt)[0].host,'new.example');
});

test('in-progress source work resumes before untouched hosts',()=>{
  const now='2026-09-29T00:00:00Z';
  let queue=mergeScoutQueue(null,[finding('resume.example')],seeds,now);
  queue=mergeScoutQueue(queue,[finding('untouched.example')],seeds,now,[]);
  const resume=queue.services.find(row=>row.host==='resume.example');
  resume.status='in_progress';resume.lastAttemptAt='2026-09-29T00:01:00Z';
  assert.equal(selectScoutWork(queue,1,'2026-09-29T00:02:00Z')[0].host,'resume.example');
});

test('withdrawing evidence stops scheduling and new scope reopens a completed site only once',()=>{
  let queue=mergeScoutQueue(null,[finding()],seeds,when);
  const id=queue.services[0].id;
  queue=checkpointScoutQueue(queue,{service:id,status:'complete',stage:'complete',evidenceFile:'receipt.json',nextTask:'done',processedFindings:refs(queue,id)},when);
  queue=mergeScoutQueue(queue,[finding()],seeds,when);
  assert.equal(selectScoutWork(queue).length,0);
  queue=mergeScoutQueue(queue,[finding('new-source.example',{sourceUrl:'https://new-source.example/new-operation'})],seeds,when);
  assert.equal(selectScoutWork(queue).length,1);
  queue=mergeScoutQueue(queue,[finding('new-source.example',{disposition:'rejected'})],seeds,when);
  assert.equal(selectScoutWork(queue).length,0);
});

test('changed evidence and late completion cannot mark unprocessed discovery revisions complete',()=>{
  let queue=mergeScoutQueue(null,[finding()],seeds,when);
  const id=queue.services[0].id,processedFindings=refs(queue,id);
  const change={service:id,status:'complete',stage:'complete',evidenceFile:'receipt.json',nextTask:'done',processedFindings};
  queue=checkpointScoutQueue(queue,change,when);
  queue=mergeScoutQueue(queue,[finding('new-source.example',{summary:'new collection scope'})],seeds,when);
  assert.equal(queue.services[0].status,'ready');
  queue=checkpointScoutQueue(queue,change,when);
  assert.equal(queue.services[0].status,'ready');
  assert.notEqual(refs(queue,id)[0].revision,processedFindings[0].revision);
  queue=checkpointScoutQueue(queue,{...change,processedFindings:refs(queue,id)},when);
  assert.equal(queue.services[0].status,'complete');
  assert.throws(()=>checkpointScoutQueue(queue,{...change,processedFindings:[]},when),/SCOPE_REQUIRED/);
});

test('disk intake and checkpoint survive fresh loading; invalid input does not hide valid findings',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'scout-queue-'));
  try {
    const dir=path.join(root,'workflow-runs/new-scout');
    await mkdir(dir,{recursive:true});
    await mkdir(path.join(root,'apps/naver-blog-api/research/content-store'),{recursive:true});
    await mkdir(path.join(root,'apps/naver-blog-api/workflow-runs/partial'),{recursive:true});
    await writeFile(path.join(dir,'scouting-findings.json'),JSON.stringify({findings:[finding()]}));
    await writeFile(path.join(root,'apps/naver-blog-api/workflow-runs/partial/scouting-findings.json'),'{');
    const result=await syncScoutQueue(root,seeds);
    assert.equal(result.errors.length,1);
    assert.equal(result.queue.services.length,1);
    await writeFile(path.join(dir,'flow.json'),'{}');
    await saveCheckpoint(root,{service:result.queue.services[0].id,status:'blocked',stage:'login_signup_flow',
      evidenceFile:'workflow-runs/new-scout/flow.json',nextTask:'resume observed verification',resumeCondition:'new verification state'});
    const fresh=await syncScoutQueue(root,seeds);
    assert.equal(fresh.queue.services[0].status,'blocked');
    assert.equal((await readScoutQueue(root)).services[0].history.length,1);
    await writeFile(path.join(dir,'scouting-findings.json'),'{');
    const broken=await syncScoutQueue(root,seeds);
    assert.equal(broken.queue.services[0].sourceActive,false);
    assert.equal(broken.queue.services[0].history.length,1);
    await assert.rejects(saveCheckpoint(root,{service:'x',evidenceFile:'../outside.json'}),/OUTSIDE_REPO/);
  } finally {await rm(root,{recursive:true,force:true});}
});
