import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {documentFingerprint} from '../../scripts/gates/publication-document.mjs';
import {adaptiveReviewState,adaptiveQuestions,evaluateDynamicPlan,evaluateAdaptiveReceipt,dynamicRepairActions,DYNAMIC_DECISION} from '../../scripts/gates/dynamic-article-gates.mjs';
import {JevSupervisor,jevConfig} from '../affiliate-content-e2e/jev-supervisor.mjs';
export async function runAdaptiveArticleReview({bundle,config,fetchImpl,now=new Date()}){
 const structural=evaluateDynamicPlan(bundle);
 const state=adaptiveReviewState(bundle),questions=adaptiveQuestions(bundle);
 const fallbacks=Object.fromEntries(Object.keys(questions).map(k=>[k,k==='plan_fit'?'missing_requirements':k==='next_action'?'collect_evidence':'needs_research']));
 const receipt=await new JevSupervisor({config:config??jevConfig(process.env,{mode:'active',confidenceFloor:0,timeoutMs:30000}),fetchImpl}).evaluate({
  decisionId:DYNAMIC_DECISION,state,questions,fallbacks});
 const artifact={schemaVersion:1,decisionId:DYNAMIC_DECISION,checkedAt:receipt.checkedAt,planFingerprint:fingerprint(bundle.gatePlan),
  documentFingerprint:documentFingerprint(bundle.document),claimLedgerFingerprint:fingerprint(bundle.claimLedger),
  requestFingerprint:fingerprint(state),receipt,publicationAuthorized:false};
 const combined={...structural.checks,...evaluateAdaptiveReceipt({...bundle,adaptiveReview:artifact},{now:new Date()}).checks};
 const failedChecks=Object.keys(combined).filter(k=>combined[k]!==true);
 return {...artifact,checks:combined,failedChecks,passed:failedChecks.length===0,nextActions:dynamicRepairActions(bundle,{failedChecks})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const args=Object.fromEntries(process.argv.slice(2).map(x=>{const m=/^--(bundle|output)=(.+)$/.exec(x);if(!m)throw Error('INPUT');return [m[1],m[2]];}));
  const bundle=JSON.parse((await fs.readFile(args.bundle,'utf8')).replace(/^\uFEFF/,''));
  const handle=await fs.open(args.output,'wx');
  try{const report=await runAdaptiveArticleReview({bundle});await handle.writeFile(JSON.stringify(report,null,2)+'\n');
   console.log(JSON.stringify({passed:report.passed,providerResult:report.receipt.providerResult,failedChecks:report.failedChecks,nextActions:report.nextActions}));if(!report.passed)process.exitCode=2;
  }finally{await handle.close();}
 }catch(e){console.error(JSON.stringify({code:/^[A-Z_]+$/.test(e.message)?e.message:'ADAPTIVE_REVIEW_FAILED'}));process.exitCode=2;}
}
