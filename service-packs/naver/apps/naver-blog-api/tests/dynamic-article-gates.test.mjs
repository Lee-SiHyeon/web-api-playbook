import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {evaluateDynamicPlan,dynamicLayoutChecks,dynamicSourceContract,evaluateAdaptiveReceipt,adaptiveQuestions} from '../scripts/gates/dynamic-article-gates.mjs';
import {evaluateAiResearchSnapshot,aiResearchLayoutChecks} from '../scripts/gates/ai-research-article-contract.mjs';
import {runAdaptiveArticleReview} from '../workflows/republish/adaptive-article-review.mjs';
import {runReferenceJevQuality,extractGenericReference} from '../workflows/republish/reference-jev-quality.mjs';
const current=()=>new Date().toISOString();
function bundle(topic='unlisted-new-model',host='new-vendor.example'){
 const source={id:'release',url:'https://'+host+'/release',publicUrl:'https://'+host+'/release',sourceKind:'official_documentation',collectionMethod:'official_http',
 status:200,httpStatus:200,readerReturnedContent:true,checkedAt:current(),evidenceFile:'evidence/release.json',sha256:'a'.repeat(64)};
 const claims=[{claimId:'c1',claimType:'feature',publishable:true,support:'supports',sources:['release'],text:'A source-backed capability description.'}];
 const document={blogId:'aicandoanything',title:'A newly released tool',blocks:[
  {type:'paragraph',text:'The reader can choose whether the new feature fits this task.',claimClass:'factual',claimIds:['c1']},
  {type:'paragraph',text:'Start with a small representative task before committing to the workflow.',claimClass:'guidance'}]};
 return {format:'ai_research_article',document,layoutReference:{id:'adaptive-ai-v1'},claimLedger:{claims,evidence:{release:source}},
  research:{schemaVersion:1,topicKey:topic,checkedAt:current(),category:{id:12,name:'AI'},sources:[source],claimBindings:[{claimId:'c1',sourceId:'release',locator:'release article',excerpt:'A source-backed capability description.'}],
   trendAssessment:{basis:'curated_primary_sources',checkedAt:current(),limitations:'This source selection makes no popularity or trend ranking claim.'}},
  gatePlan:{schemaVersion:1,policyVersion:'adaptive-ai-v1',topicKey:topic,genre:'explainer',userIntent:'Explain this feature using the official release.',readerOutcome:'Decide whether to try the feature on a small task.',
   target:{blogId:'aicandoanything',categoryId:12},sources:[{...source,role:'primary',authorityBasis:'Vendor-owned official release page with attributed publication identity.'}],
   media:{motionRequired:false,originalRequired:false,rationale:'This explanation needs no motion evidence for the supported claim.'},layoutRationale:'Two focused sections answer the reader question without decorative media.',
   requirements:[{id:'facts',kind:'claim_evidence',sourceIds:['release'],claimIds:['c1'],rationale:'Bind the central feature claim to its original source.'},
    {id:'action',kind:'reader_action',sourceIds:[],claimIds:[],rationale:'Give the reader a specific task they can try.'}]}};
}
const config={mode:'active',provider:'vercel',endpoint:'https://ai-gateway.vercel.sh/typesafe/v1/systemone',apiKey:'fixture',model:'typesafe-ai/jev',confidenceFloor:0,timeoutMs:1000};
const snapshot=()=>({schemaVersion:1,profile:'explanation',selection:'Relevant published explanatory articles',checkedAt:current(),references:[1,2,3].map(i=>({
 id:'new-reference-'+i,url:'https://reference'+i+'.example/article',httpStatus:200,checkedAt:current(),bodySha256:String(i).repeat(64),bodyCharacters:1500,paragraphCount:12,
 sampledParagraphs:[0,1,2,3,4,5].map(position=>({position,text:'Reference author '+i+' uses distinct examples and limitations in paragraph '+position+'.'}))}))});
const response=answers=>new Response(JSON.stringify({model:'typesafe-ai/jev',answers}),{headers:{'content-type':'application/json'}});
test('new topics and first-party sources pass without source maps or fixed image counts',()=>{
 for(const b of [bundle(),bundle('another-future-topic','another-vendor.example')]){
  assert.equal(evaluateDynamicPlan(b).passed,true);
  assert.equal(evaluateAiResearchSnapshot(b).passed,true);
  assert.ok(Object.values(aiResearchLayoutChecks(b)).every(Boolean));
 }
});
test('missing benchmark/motion requirements and source substitutions fail deterministically',()=>{
 let b=bundle();b.claimLedger.claims[0].claimType='benchmark';assert.equal(evaluateDynamicPlan(b).checks.dynamicBenchmarkRequirement,false);
 b=bundle();b.gatePlan.media.motionRequired=true;assert.equal(evaluateDynamicPlan(b).checks.dynamicMotionRequirement,false);
 b.gatePlan.requirements.push({id:'motion',kind:'motion_demo',sourceIds:['release'],claimIds:[],rationale:'User specifically requested moving demonstrations.'});
 assert.equal(evaluateDynamicPlan(b).checks.dynamicRequirement_motion,false);
 b=bundle();b.research.sources[0].url='https://unrelated.example/';assert.equal(evaluateDynamicPlan(b).checks.dynamicSourcesDeclared,false);
 assert.equal(dynamicSourceContract({...b.research.sources[0],url:'https://person:secret@vendor.example/'}),false);
});
test('first-party runs need hash-bound records, owned media and disclosed model/effort',()=>{
 const run={id:'run-a',model:'model-x',effort:'high',tool:'vendor-cli 1.0',runCount:1,promptSha256:'b'.repeat(64),outputSha256:'c'.repeat(64),
  provenanceSha256:'d'.repeat(64),outputFile:'runs/a.html',provenanceFile:'runs/a.json',editedAfterGeneration:false};
 const withRun=()=>{const b=bundle();b.firstPartyRuns=[structuredClone(run)];
  b.document.blocks.push({type:'video',file:'media/a.mp4',sha256:'e'.repeat(64),videoId:'A'.repeat(36),rights:{basis:'owned',source:'Own recording'},firstPartyRunIds:['run-a'],purpose:'Own run'},
   {type:'paragraph',presentation:'caption',claimClass:'guidance',text:'One run on model-x with effort high.'});
  b.gatePlan.requirements.push({id:'own-run',kind:'first_party_run',sourceIds:[],claimIds:[],runIds:['run-a'],rationale:'Disclose and bind the author run shown in the video.'});return b;};
 assert.equal(evaluateDynamicPlan(withRun()).checks['dynamicRequirement_own-run'],true);
 let b=withRun();b.document.blocks.at(-1).text='One run.';assert.equal(evaluateDynamicPlan(b).checks['dynamicRequirement_own-run'],false);
 b=withRun();b.firstPartyRuns[0].editedAfterGeneration=true;assert.equal(evaluateDynamicPlan(b).checks['dynamicRequirement_own-run'],false);
 b=withRun();b.document.blocks.at(-2).rights.basis='licensed';assert.equal(evaluateDynamicPlan(b).checks['dynamicRequirement_own-run'],false);
 b=withRun();b.gatePlan.requirements.at(-1).runIds=['missing'];assert.equal(evaluateDynamicPlan(b).checks['dynamicRequirement_own-run'],false);
 b=withRun();delete b.gatePlan.requirements.at(-1).runIds;assert.equal(evaluateDynamicPlan(b).checks.dynamicRequirementsDeclared,false);
});
test('captions require an immediately preceding image or video',()=>{
 const b=bundle();b.document.blocks.push({type:'paragraph',presentation:'caption',text:'Orphan.'});
 assert.equal(dynamicLayoutChecks(b).dynamicNativeCaptions,false);
});
test('adaptive Jev is bound to plan, source, draft and reference review; unavailable judgments never pass',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'naver-adaptive-'));
 try{
  const b=bundle(),answers=Object.fromEntries([1,2,3].map(i=>['reference_'+i,{type:'score',score:3,confidence:.6}]));answers.next_action={type:'choice',choice:'publish',confidence:.6};
  b.jevQuality=await runReferenceJevQuality({dir,document:b.document,ledger:b.claimLedger,snapshot:snapshot(),mode:'active',config,fetchImpl:async()=>response(answers)});
  const choices=Object.fromEntries(Object.keys(adaptiveQuestions(b)).map(k=>[k,{type:'choice',choice:k==='plan_fit'?'adequate':k==='source_authority'?'sufficient':k==='next_action'?'ready':'satisfied',confidence:.6}]));
  const report=await runAdaptiveArticleReview({bundle:b,config,fetchImpl:async()=>response(choices)});
  assert.equal(report.passed,true);b.adaptiveReview=report;
  b.gatePlan.readerOutcome+=' Changed.';assert.equal(evaluateAdaptiveReceipt(b).checks.adaptiveReviewBound,false);
  const unavailable=await runAdaptiveArticleReview({bundle:b,config,fetchImpl:async()=>new Response('',{status:503})});
  assert.equal(unavailable.passed,false);assert.equal(unavailable.receipt.providerResult,'provider_http_503');
  const omission=await runAdaptiveArticleReview({bundle:b,config,fetchImpl:async()=>response({...choices,plan_fit:{type:'choice',choice:'missing_requirements',confidence:.9}})});
  assert.equal(omission.passed,false);assert.equal(omission.checks.adaptivePlanSuitable,false);
 }finally{if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('naver-adaptive-'))throw Error('CLEANUP_SCOPE');await fs.rm(dir,{recursive:true,force:true});}
});
test('new reference sites need an unambiguous actual article body',()=>{
 const paragraphs=Array.from({length:10},(_,i)=>'<p>Paragraph '+i+' '+('A concrete editorial explanation with facts and limitations. '.repeat(4))+'</p>').join('');
 const html='<html><body><article><h1>New reference author</h1>'+paragraphs+'</article><footer><p>Do not extract this.</p></footer></body></html>';
 const parsed=extractGenericReference(html);assert.equal(parsed.paragraphs.length,10);assert.equal(parsed.title,'New reference author');
 assert.throws(()=>extractGenericReference(html.replace('</article>','</article><article>'+paragraphs+'</article>')),/AMBIGUOUS/);
});
