import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildJevQualityState,evaluateJevQualityEvidence,JEV_QUALITY_QUESTIONS,runJevQuality} from '../workflows/republish/jev-quality.mjs';
import {fingerprint} from '../../../packages/contracts/src/index.mjs';
import {documentFingerprint} from '../scripts/gates/publication-document.mjs';

const document={blogId:'testblog',logNo:'224417064414',title:'A reviewable article',blocks:[
 {type:'paragraph',text:'Evidence-backed opening.'},
 {type:'table',columns:['Item','Value'],rows:[['One','Known']]},
 {type:'paragraph',text:'The table shows the key difference.'},
]};
const ledger={claims:[{claimId:'c1',text:'Known',support:'supports',sources:[{sourceId:'s1',locator:'line 1',excerpt:'Known'}]}]};

function artifact(overrides={}){
 const state=buildJevQualityState(document,ledger);
 const adopted={evidence_sufficient:{noul:0.95},editorial_quality:{score:2},next_action:{choice:'publish'},ai_slop_free:{noul:0.95},table_use:{noul:0.95},core_prose:{noul:0.95},unsupported_claims_absent:{noul:0.95}};
 return {schemaVersion:1,checkedAt:new Date().toISOString(),decisionId:'republish-editorial-quality',mode:'active',provider:'fixture',model:'fixture',providerResult:'ok',confidenceFloor:0.82,documentFingerprint:documentFingerprint(document),claimLedgerFingerprint:fingerprint(ledger),requestFingerprint:fingerprint(state),comparisons:Object.fromEntries(Object.keys(JEV_QUALITY_QUESTIONS).map(id=>[id,{eligible:true,adoptedSource:'jev_active'}])),adopted,...overrides};
}

test('active Jev evidence passes only for the exact document and ledger',()=>{
 const result=evaluateJevQualityEvidence(artifact(),{document,ledger,requestFingerprint:artifact().requestFingerprint});
 assert.equal(result.passed,true);
 assert.deepEqual(result.failedChecks,[]);
});

test('Jev receives excerpts for the claim ledger source-ID format',()=>{
 const idLedger={claims:[{claimId:'c1',text:'Known',support:'supports',sources:['s1','s2']}]};
 const bindings=[
  {claimId:'c1',sourceId:'s1',locator:'pricing table row',excerpt:'Official price is $2 per million tokens.'},
  {claimId:'c1',sourceId:'s2',locator:'benchmark table row',excerpt:'Model score is 46 on the published index.'},
 ];
 const state=buildJevQualityState(document,idLedger,bindings);
 assert.deepEqual(state.claimLedger.claims[0].sources,bindings.map(({sourceId,locator,excerpt})=>({sourceId,url:'',sourceKind:'',collectionMethod:'',checkedAt:null,locator,excerpt})));
});

test('fallback, shadow, stale, and changed revisions fail the quality gate',()=>{
 for(const change of [
   {mode:'shadow'},
   {providerResult:'provider_unavailable'},
   {requestFingerprint:'old'},
   {adopted:{...artifact().adopted,next_action:{choice:'revise'}}},
 ]){
   const a={...artifact(),...change};
   const result=evaluateJevQualityEvidence(a,{document,ledger,requestFingerprint:artifact().requestFingerprint});
   assert.equal(result.passed,false);
 }
});

test('the active gate rejects a score below reviewable quality',()=>{
 const a=artifact({adopted:{...artifact().adopted,editorial_quality:{score:1}}});
 const result=evaluateJevQualityEvidence(a,{document,ledger,requestFingerprint:a.requestFingerprint});
 assert.equal(result.failedChecks.includes('editorial_quality'),true);
});

test('the runner persists a live active receipt bound to the revision',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-quality-'));
 await fs.writeFile(path.join(dir,'document.json'),JSON.stringify(document));
 await fs.writeFile(path.join(dir,'claim-ledger.json'),JSON.stringify(ledger));
 const answers={
   evidence_sufficient:{type:'noul',noul:0.95},
   editorial_quality:{type:'score',score:2,confidence:0.95},
   next_action:{type:'choice',choice:'publish',confidence:0.95},
   ai_slop_free:{type:'noul',noul:0.95},
   table_use:{type:'noul',noul:0.95},
   core_prose:{type:'noul',noul:0.95},
   unsupported_claims_absent:{type:'noul',noul:0.95},
 };
 const artifact=await runJevQuality({dir,config:{mode:'active',provider:'vercel',endpoint:'https://ai-gateway.vercel.sh/typesafe/v1/systemone',apiKey:'fixture',model:'typesafe-ai/jev',confidenceFloor:0.82,timeoutMs:8000},fetchImpl:async(url,options)=>{
   assert.equal(url,'https://ai-gateway.vercel.sh/typesafe/v1/systemone');
   assert.equal(options.redirect,'error');
   return new Response(JSON.stringify({model:'typesafe-ai/jev',answers}),{status:200,headers:{'content-type':'application/json'}});
 }});
 assert.equal(artifact.passed,true);
 assert.equal((await fs.stat(path.join(dir,'jev-quality.json'))).isFile(),true);
 await fs.rm(dir,{recursive:true,force:true});
});
