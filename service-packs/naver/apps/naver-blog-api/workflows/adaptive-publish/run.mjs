// Adaptive AI-article publication stages for a run directory that already has
// document.json, claim-ledger.json, bundle.json and job.json (a dry-run create
// job produced by the article's own build step).
//
//   gates           deterministic gates on job.json (or --job=)
//   lint            browser-free HTTP compile + model lint           -> model-lint.json
//   preview         native desktop/mobile preview (browser)           -> native-preview.json
//   preview-rebind  reuse the last native preview when the fresh HTTP compile proves
//                   the same presentation and render units            -> native-preview-rebind.json
//   review          bind editorial-review-raw.json (separate agent)   -> job-reviewed.json
//   jev             reference + adaptive Jev, bounded retries         -> job-reviewed.json
//   waive-jev       record an explicit user waiver of the Jev reviews -> job-reviewed.json
//   preview-bind    bind the (re)bound native preview                 -> job-native-bound.json
//   prepare | authorize | create | readback | verify
//
// Common options: --run=<dir>  --container=<existing read-only logNo for previews>
// authorize: --basis="<user request>"   waive-jev: --instruction="<user words>" --reason="<why>"
import {readFile,writeFile,access,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const imp=p=>import(pathToFileURL(path.join(app,p)).href);
const launcher=process.env.NAVER_DIRECT_LAUNCHER||fileURLToPath(new URL('../../scripts/publisher-direct.mjs',import.meta.url));
const [command,...rest]=process.argv.slice(2);
const opt=Object.fromEntries(rest.map(a=>{const m=/^--([a-z-]+)=([\s\S]+)$/.exec(a);if(!m)throw Error('ARGUMENT '+a);return [m[1],m[2]];}));
if(!opt.run)throw Error('RUN_DIR_REQUIRED');
const dir=path.resolve(opt.run),journal=path.join(dir,'publication-journal.jsonl');
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=async f=>JSON.parse((await readFile(path.join(dir,f),'utf8')).replace(/^\uFEFF/,''));
const unwrap=v=>v?.result&&!v.reviews&&!v.kind?v.result:v;
const assert=(v,c)=>{if(!v)throw Error(c);};
const fresh=async f=>{try{await access(path.join(dir,f));}catch{return;}await rename(path.join(dir,f),path.join(dir,`${f}.superseded-${Date.now()}`));};
const direct=(mode,args,timeout=900000)=>{
 const c=spawnSync(process.execPath,[launcher,`--mode=${mode}`,...args],{cwd:app,encoding:'utf8',windowsHide:true,timeout,maxBuffer:8*1024*1024,shell:false});
 return {status:c.status,lines:(c.stdout+'\n'+c.stderr).split('\n').filter(l=>/"ok"|"code"|progress/.test(l)).map(l=>l.slice(0,300))};
};
const {fingerprint}=await imp('../../packages/contracts/src/index.mjs');
const {documentFingerprint,renderUnits,unitsFingerprint}=await imp('scripts/gates/publication-document.mjs');
async function containerJob(jobFile){
 assert(/^\d{6,}$/.test(opt.container||''),'CONTAINER_LOGNO_REQUIRED');
 const job=await read(jobFile),doc={...structuredClone(job.publicationBundle.document),logNo:opt.container};
 assert(job.target?.type==='create'&&job.publish===false&&job.dryRun===true&&!job.publicationBundle.document.logNo,'DRY_CREATE_JOB_REQUIRED');
 const p=structuredClone(job);p.jobId=`${job.jobId}-container`;p.target={type:'update',logNo:opt.container};p.publicationBundle.document=doc;
 p.publicationBundleFingerprint=fingerprint(p.publicationBundle);p.publish=false;p.dryRun=true;
 p.preflight={...p.preflight,documentFingerprint:documentFingerprint(doc),publicationBundleFingerprint:p.publicationBundleFingerprint,compiledPresentationFingerprint:null,checkedAt:new Date().toISOString()};
 assert(unitsFingerprint(renderUnits(doc))===unitsFingerprint(renderUnits(job.publicationBundle.document)),'CONTAINER_CLONE_MISMATCH');
 return p;
}
async function bindReviews(job,preview,extra={}){
 const source=job.publicationBundle.document,sourceFp=documentFingerprint(source),units=unitsFingerprint(renderUnits(source)),reviews={};
 assert(preview.browserClosed===true&&(preview.blockedBrowserWrites||[]).every(w=>!['/RabbitWrite.naver','/PostWrite.naver'].includes(w.path)),'PREVIEW_RUNTIME_UNVERIFIED');
 for(const device of ['desktop','mobile']){
  const r=preview.reviews?.[device];
  assert(r?.source==='rendered_dom'&&r.channel==='naver_editor'&&r.nativeDocumentInjected===true&&r.browserWritesBlocked===true&&r.observedUnitsFingerprint===units&&
   Object.values(r.presentationChecks||{}).every(Boolean)&&r.paragraphGapViolations?.length===0,`PREVIEW_${device.toUpperCase()}_FAILED`);
  assert(sha(await readFile(path.join(dir,r.screenshotFile)))===r.screenshotSha256,`PREVIEW_${device.toUpperCase()}_SCREENSHOT`);
  reviews[device]={...r,documentFingerprint:sourceFp,sourceDocumentFingerprint:sourceFp,previewContainerDocumentFingerprint:r.documentFingerprint,normalizedForCreate:{removedOnly:['document.logNo'],renderUnitsMatched:true},...extra};
 }
 assert(reviews.desktop.compiledPresentationFingerprint===reviews.mobile.compiledPresentationFingerprint,'PREVIEW_PRESENTATION_MISMATCH');
 job.publicationBundle.renderReviews=reviews;job.publicationBundleFingerprint=fingerprint(job.publicationBundle);
 job.preflight={...job.preflight,documentFingerprint:sourceFp,publicationBundleFingerprint:job.publicationBundleFingerprint,compiledPresentationFingerprint:reviews.desktop.compiledPresentationFingerprint,checkedAt:new Date().toISOString()};
 return job;
}
async function saveReviewed(job,bundle){
 job.qualityPolicy={...(job.qualityPolicy||{}),jev:'required'};job.publicationBundle=bundle;job.publicationBundleFingerprint=fingerprint(bundle);
 job.preflight={...job.preflight,documentFingerprint:documentFingerprint(bundle.document),publicationBundleFingerprint:job.publicationBundleFingerprint,checkedAt:new Date().toISOString()};
 await writeFile(path.join(dir,'job-reviewed.json'),JSON.stringify(job,null,2)+'\n');
}
const out={};
if(command==='gates'){
 const job=await read(opt.job||'job.json'),bundle=job.publicationBundle;
 const g=await imp('scripts/gates/ai-research-article-contract.mjs'),{evaluateClaimEvidenceGate}=await imp('scripts/gates/claim-evidence-gates.mjs');
 const {documentChecks}=await imp('scripts/gates/publication-document.mjs'),{evaluatePublisherJobGate}=await imp('scripts/gates/publisher-gates.mjs');
 const now=new Date(),rd=async(f,h)=>{const b=await readFile(path.resolve(dir,f));if(h&&sha(b)!==h)throw Error('HASH');return b;};
 const r={snapshot:g.evaluateAiResearchSnapshot(bundle,{now}),article:g.evaluateAiResearchArticle(job,{now}),layout:g.aiResearchLayoutChecks(bundle),evidence:await g.verifyAiResearchEvidence(bundle,{read:rd}),
  claims:evaluateClaimEvidenceGate(bundle.claimLedger,{now}),document:documentChecks(bundle.document,{contentKind:'ai_research_article',researchSources:bundle.research.sources}),publisherJob:await evaluatePublisherJobGate(job,{baseDir:dir,now})};
 for(const [k,v] of Object.entries(r))out[k]=v.failedChecks??Object.keys(v).filter(x=>v[x]!==true);
}else if(command==='lint'){
 const job=await containerJob('job.json');await writeFile(path.join(dir,'model-lint-job.json'),JSON.stringify(job,null,2)+'\n');await fresh('model-lint.json');
 Object.assign(out,direct('api',['--command=lint-model',`--job=${path.join(dir,'model-lint-job.json')}`,`--journal=${journal}`,`--output=${path.join(dir,'model-lint.json')}`],300000));
 const l=unwrap(await read('model-lint.json'));Object.assign(out,{passed:l.passed,failedChecks:l.failedChecks,layoutRisk:l.layoutRisk,riskFactors:l.riskFactors,browserUsed:false});
}else if(command==='preview'){
 const job=await containerJob('job.json');await writeFile(path.join(dir,'native-preview-job.json'),JSON.stringify(job,null,2)+'\n');await fresh('native-preview.json');
 for(let i=1;i<=3;i++){ // the editor sometimes times out under memory pressure
  const r=direct('api',['--command=preview-update',`--job=${path.join(dir,'native-preview-job.json')}`,`--journal=${journal}`,`--output=${path.join(dir,'native-preview.json')}`]);
  const p=unwrap(await read('native-preview.json').catch(()=>({})));if(p.reviews){out.attempts=i;break;}
  out['attempt'+i]=r.lines.at(-1);await fresh('native-preview.json');
 }
 const p=unwrap(await read('native-preview.json'));
 for(const d of ['desktop','mobile'])out[d]=Object.entries(p.reviews[d].presentationChecks).filter(([,v])=>!v).map(([k])=>k);
}else if(command==='preview-rebind'){
 // Rendering is a function of the compiled editor model. If a fresh HTTP compile
 // of the current document yields the same presentation fingerprint and the same
 // render units as the last browser preview, that preview is valid evidence for
 // the current document (e.g. only claimIds or firstPartyRunIds changed).
 const lint=unwrap(await read('model-lint.json')),prev=unwrap(await read('native-preview.json')),job=await read('job.json');
 const units=unitsFingerprint(renderUnits(job.publicationBundle.document));
 assert(lint.passed===true&&Date.now()-Date.parse(lint.checkedAt)<30*60000,'FRESH_PASSING_LINT_REQUIRED');
 for(const d of ['desktop','mobile'])assert(prev.reviews?.[d]?.compiledPresentationFingerprint===lint.compiledPresentationFingerprint&&prev.reviews[d].observedUnitsFingerprint===units,'PRESENTATION_CHANGED_PREVIEW_REQUIRED');
 const proof={rebind:{fromContainerDocumentFingerprint:prev.reviews.desktop.documentFingerprint,compiledPresentationFingerprint:lint.compiledPresentationFingerprint,renderUnitsFingerprint:units,lintFile:'model-lint.json',lintSha256:sha(await readFile(path.join(dir,'model-lint.json'))),checkedAt:new Date().toISOString()}};
 await writeFile(path.join(dir,'native-preview-rebind.json'),JSON.stringify(proof,null,2)+'\n');Object.assign(out,{rebound:true,...proof.rebind});
}else if(command==='review'||command==='waive-jev'||command==='jev'){
 const job=await read('job.json'),bundle=job.publicationBundle,docBytes=await readFile(path.join(dir,'document.json'));
 const raw=await read('editorial-review-raw.json'),rawBytes=await readFile(path.join(dir,'editorial-review-raw.json'));
 assert(raw.reviewedDocumentSha256===sha(docBytes)&&fingerprint(JSON.parse(docBytes.toString('utf8')))===fingerprint(bundle.document),'REVIEW_NOT_FOR_THIS_DOCUMENT');
 assert(raw.decision==='pass'&&raw.hardBlocks?.length===0,'REVIEW_NOT_PASSED');
 const blocks=bundle.document.blocks,textual=i=>!['image','video','imageStrip','spacer','divider'].includes(blocks[i]?.type),dropped={},assessments={};
 for(const [k,a] of Object.entries(raw.editorialAssessments||{})){const drop=(a.blockIndexes||[]).filter(i=>!textual(i));if(drop.length)dropped[k]=drop;assessments[k]={...a,blockIndexes:(a.blockIndexes||[]).filter(textual)};}
 const now=new Date().toISOString(),review={schemaVersion:1,checkedAt:now,decision:'pass',reviewerRole:'independent_verifier',reviewerId:opt.reviewer||'separate-review-agent',
  reviewMode:'separate agent; re-fetched sources and verified media/provenance; wrote only its own output file',documentFingerprint:documentFingerprint(bundle.document),claimLedgerFingerprint:fingerprint(bundle.claimLedger),
  provenance:{method:'separate_agent',authorExecutionId:bundle.authorExecutionId,reviewerExecutionId:opt['reviewer-execution']||'/review-agent',receipt:`editorial-review-raw.json sha256=${sha(rawBytes)}`},
  checks:raw.checks,hardBlocks:[],editorialAssessments:assessments,mediaBlockIndexesDropped:dropped};
 await writeFile(path.join(dir,'independent-review.json'),JSON.stringify(review,null,2)+'\n');
 const {schemaVersion,...core}=review;bundle.qualityReview={...core,evidenceFile:'independent-review.json',evidenceSha256:sha(await readFile(path.join(dir,'independent-review.json')))};
 if(command==='waive-jev'){
  assert((opt.instruction||'').length>=8&&(opt.reason||'').length>=8,'WAIVER_TEXT_REQUIRED');
  const {userDirectedJevWaiver}=await imp('scripts/gates/dynamic-article-gates.mjs');
  bundle.jevWaiver={source:'conversation_user_instruction',approvedBy:'user',scope:'jev_reviews_only',recordedAt:now,instruction:opt.instruction,reason:opt.reason,
   documentFingerprint:documentFingerprint(bundle.document),planFingerprint:fingerprint(bundle.gatePlan??null)};
  assert(userDirectedJevWaiver(bundle),'WAIVER_NOT_VALID');out.jevWaiver=true;
 }else if(command==='jev'){
  const {runJevQuality}=await imp('workflows/republish/jev-quality.mjs'),{runAdaptiveArticleReview}=await imp('workflows/republish/adaptive-article-review.mjs');
  const attempts=Number(opt.attempts||3);let ok=false;
  for(let i=1;i<=attempts&&!ok;i++){
   try{bundle.jevQuality=await runJevQuality({dir,document:bundle.document,ledger:bundle.claimLedger,research:bundle.research});}catch(e){out['reference'+i]=e.code||e.message;continue;}
   const a=await runAdaptiveArticleReview({bundle});await writeFile(path.join(dir,'adaptive-review.json'),JSON.stringify(a,null,2)+'\n');
   out['adaptive'+i]={provider:a.receipt?.providerResult,failed:a.failedChecks};
   if(a.passed){bundle.adaptiveReview={...a,evidenceFile:'adaptive-review.json',evidenceSha256:sha(await readFile(path.join(dir,'adaptive-review.json')))};ok=true;}
   else if(a.receipt?.providerResult==='ok')break; // a real judgment, not an outage: fix the plan/draft instead of retrying
   else await new Promise(r=>setTimeout(r,60000));
  }
  if(!ok){console.log(JSON.stringify({...out,next:'fix the reported plan/draft issue, or ask the user whether to waive-jev'}));process.exit(2);}
 }
 await saveReviewed(job,bundle);out.bound=true;
}else if(command==='preview-bind'){
 const job=await read('job-reviewed.json'),preview=unwrap(await read('native-preview.json'));
 let extra={};try{extra=await read('native-preview-rebind.json');}catch{}
 if(!extra.rebind)assert(unitsFingerprint(renderUnits(job.publicationBundle.document))===preview.reviews.desktop.observedUnitsFingerprint,'PREVIEW_UNITS_MISMATCH');
 await bindReviews(job,preview,extra);await writeFile(path.join(dir,'job-native-bound.json'),JSON.stringify(job,null,2)+'\n');
 out.compiledPresentationFingerprint=job.preflight.compiledPresentationFingerprint;out.rebound=!!extra.rebind;
}else if(command==='prepare'){
 await fresh('prepare-create.json');Object.assign(out,direct('headless',['--command=prepare-create',`--job=${path.join(dir,'job-native-bound.json')}`,`--journal=${journal}`,`--output=${path.join(dir,'prepare-create.json')}`]));
}else if(command==='authorize'){
 assert((opt.basis||'').length>=12,'AUTHORIZATION_BASIS_REQUIRED');
 const {publisherContentFingerprint,evaluatePublisherJobGate}=await imp('scripts/gates/publisher-gates.mjs');
 const dry=await read('job-native-bound.json'),prepared=unwrap(await read('prepare-create.json')),now=new Date();
 const dryGate=await evaluatePublisherJobGate(dry,{baseDir:dir,now});assert(dryGate.passed,'DRYRUN_GATE_FAILED '+JSON.stringify(dryGate.failedChecks));
 assert(prepared.kind==='headless_input_http_create_preflight'&&prepared.documentFingerprint===documentFingerprint(dry.publicationBundle.document)&&
  prepared.publicationBundleFingerprint===fingerprint(dry.publicationBundle)&&prepared.compiledPresentationFingerprint===dry.preflight.compiledPresentationFingerprint&&
  now-Date.parse(prepared.checkedAt)<30*60000,'CREATE_PREFLIGHT_UNVERIFIED');
 const job=structuredClone(dry);job.jobId=`${dry.runId}-publish-once`;job.publish=true;job.dryRun=false;
 job.preflight={...prepared,passed:true,dryRunJobId:dry.jobId,dryRunJobFingerprint:fingerprint(dry),dryRunResultFingerprint:fingerprint(prepared),dryRunGateFingerprint:fingerprint(dryGate)};
 job.authorization={approved:true,approvedBy:'user',approvedAt:now.toISOString(),scope:'publish_once',basis:opt.basis};job.authorization.contentFingerprint=publisherContentFingerprint(job);
 const gate=await evaluatePublisherJobGate(job,{baseDir:dir,now});
 await writeFile(path.join(dir,'publish-job-gate.json'),JSON.stringify({checkedAt:now.toISOString(),passed:gate.passed,failedChecks:gate.failedChecks},null,2)+'\n');
 assert(gate.passed,'PUBLISH_JOB_GATE_FAILED '+JSON.stringify(gate.failedChecks));
 await writeFile(path.join(dir,'job-publish.json'),JSON.stringify(job,null,2)+'\n');out.authorized=true;
}else if(command==='create'){
 try{await access(path.join(dir,'create-result.json'));throw Error('CREATE_ALREADY_ATTEMPTED_RECONCILE_FIRST');}catch(e){if(e.message.startsWith('CREATE_'))throw e;}
 Object.assign(out,direct('headless',['--command=create',`--job=${path.join(dir,'job-publish.json')}`,`--journal=${journal}`,`--output=${path.join(dir,'create-result.json')}`]));
}else if(command==='readback'){
 const c=unwrap(await read('create-result.json')),logNo=String(c.logNo);assert(/^\d{6,}$/.test(logNo),'LOGNO_MISSING');
 for(const [cmd,f] of [['read-post','public-readback.json'],['inspect-editor','owner-readback.json']]){await fresh(f);out[cmd]=direct('api',[`--command=${cmd}`,`--blog-id=${c.blogId||'aicandoanything'}`,`--log-no=${logNo}`,`--output=${path.join(dir,f)}`,`--journal=${journal}`]).status;}
}else if(command==='verify'){
 const {evaluateExactReadback}=await imp('scripts/gates/publication-review-gates.mjs'),{auditPost}=await imp('scripts/api/post-audit.mjs');
 const job=await read('job-publish.json'),created=unwrap(await read('create-result.json')),pub=unwrap(await read('public-readback.json')),owner=unwrap(await read('owner-readback.json'));
 const exact=evaluateExactReadback(job,pub,{now:new Date(),createdLogNo:created.logNo}),audit=await auditPost(pub,{researchJob:job});
 const checks={createAccepted:created.accepted===true&&created.readbackVerified===true,publicHttp200:pub.httpStatus===200&&pub.smartEditorBodyPresent===true,
  publicExactReadback:exact.passed===true,publicArticleAudit:audit.passed===true,publicTagsMatch:fingerprint(pub.tags)===fingerprint(job.publishSettings.tags),
  protectedOwnerVerified:owner.protectedOwnerVerified===true&&String(owner.logNo)===String(created.logNo),
  protectedOwnerDocumentExact:fingerprint(owner.document)===fingerprint({title:job.publicationBundle.document.title,units:renderUnits(job.publicationBundle.document)}),
  visibilityPublic:created.visibilityVerified===job.publishSettings.visibility,configurationVerified:created.configurationVerified===true};
 const failedChecks=Object.keys(checks).filter(k=>checks[k]!==true);
 const result={schemaVersion:1,checkedAt:new Date().toISOString(),status:failedChecks.length?'readback_mismatch':'published_verified',publicUrl:`https://blog.naver.com/${job.blogId}/${created.logNo}`,logNo:String(created.logNo),createCount:1,checks,failedChecks,
  exact:{passed:exact.passed,expectedUnits:exact.expectedUnits,observedUnits:exact.observedUnits,firstMismatch:exact.firstMismatch},audit:{passed:audit.passed,failures:audit.failures}};
 await writeFile(path.join(dir,'final-verification.json'),JSON.stringify(result,null,2)+'\n');Object.assign(out,result);if(failedChecks.length)process.exitCode=2;
}else throw Error('COMMAND gates|lint|preview|preview-rebind|review|jev|waive-jev|preview-bind|prepare|authorize|create|readback|verify');
console.log(JSON.stringify(out));
