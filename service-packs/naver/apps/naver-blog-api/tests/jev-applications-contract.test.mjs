import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {jevApplicationsFixture} from './support/jev-applications-fixture.mjs';
import {aiResearchFixture} from './support/ai-research-fixture.mjs';
import {NOW,bind} from './support/publication-fixture.mjs';
import {evaluatePublisherJobGate} from '../scripts/gates/publisher-gates.mjs';
import {evaluateAiResearchArticle,evaluateAiResearchSnapshot,researchSourcePublicUrl,AI_RESEARCH_SCOPE} from '../scripts/gates/ai-research-article-contract.mjs';
import {JEV_APPLICATIONS_SCOPE,jevApplicationSourceOwnerScope,JEV_APPLICATION_SOURCES} from '../scripts/gates/jev-applications-contract.mjs';
import {verifyPublicationArtifacts} from '../scripts/gates/publication-artifacts.mjs';

async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'jev-applications-contract-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,job:await jevApplicationsFixture(directory)};
}
test('applications article supports distinct primary cases with source hashes, attribution levels and finance limits through the complete publication gate',async t=>{
  const {directory,job}=await fixture(t);
  const gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});
  assert.deepEqual(gate.failedChecks,[],JSON.stringify(gate.details));
  assert.equal(gate.details.researchGate.checks.applicationsFinancialLimits,true);
  assert.equal(gate.details.jevQuality.passed,true);
});
for(const [name,mutate,expected] of [
  ['document',b=>b.document.blocks.push({type:'paragraph',claimClass:'guidance',text:'최종 검토 이후에 추가한 안내 문장입니다.'}),'documentRevisionMatches'],
  ['claim ledger',b=>b.claimLedger.claims[0].text+=' 최종 검토 이후 수정됨.','claimLedgerRevisionMatches'],
]) test(`applications gate rejects a ${name} revision made after its synthetic quality review`,async t=>{
  const {directory,job}=await fixture(t);
  mutate(job.publicationBundle);
  // Rebind ordinary fixture artifacts without issuing a new Jev review.
  bind(job);
  const gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});
  assert.equal(gate.passed,false);
  assert.equal(gate.checks.jevQualityPassed,false);
  assert.ok(gate.details.jevQuality.failedChecks.includes(expected),gate.details.jevQuality.failedChecks.join(','));
});
for(const [name,mutate,expected] of [
  ['only one application',b=>b.research.applications.pop(),'applicationsPresent'],
  ['duplicated project',b=>b.research.applications[1].projectId='jev-trader','applicationsDistinct'],
  ['foreign fork URL',b=>b.research.sources.find(s=>s.id==='T_REPO').url='https://raw.githubusercontent.com/other/jev-trader/main/README.md','researchOfficialSourceScope'],
  ['invented author identity',b=>b.research.sources.find(s=>s.id==='T_REPO').creatorIdentity='verified-by-us','researchOfficialSourceScope'],
  ['unobserved demo page',b=>b.research.sources.find(s=>s.id==='T_REPO').url='https://jev-trader.vercel.app/unobserved','researchOfficialSourceScope'],
  ['invented performance level',b=>b.research.applications[0].observationLevel='live_trades_verified','applicationsObservationLevel'],
  ['repo labeled live demo',b=>b.research.applications[0].observationLevel='public_demo','applicationsEvidenceLevelSupported'],
  ['missing source-to-project relation',b=>b.research.applications[0].sourceIds=['S0'],'applicationsSourcesBound'],
  ['unattributed case claim',b=>delete b.claimLedger.claims.find(c=>c.claimId==='trader_observation').evidenceLevel,'applicationsClaimsBound'],
  ['case omitted from article',b=>b.document.blocks=b.document.blocks.filter(x=>!x.claimIds?.includes('trader_observation')),'applicationsCoverage'],
  ['author claims execution',b=>b.research.applicationBoundaries.authorExecutedProjects=true,'applicationsExecutionBoundary'],
  ['financial results claimed verified',b=>b.research.applicationBoundaries.financialPerformanceVerified=true,'applicationsExecutionBoundary'],
  ['trading scope renamed to evade limits',b=>{b.research.applications[0].domain='software';delete b.research.applications[0].financialResults;},'applicationsFinancialLimits'],
  ['missing finance caution paragraph',b=>b.document.blocks=b.document.blocks.filter(x=>!x.claimIds?.includes('financial_uncertainty')),'applicationsFinancialLimits'],
  ['unverified profit claim',b=>b.claimLedger.claims.find(c=>c.claimId==='trader_observation').claimType='trading_performance','applicationsNoFinancialPerformanceClaims'],
  ['financial guarantee wording',b=>b.document.blocks.push({type:'paragraph',claimClass:'guidance',text:'이 시스템은 검증된 수익률을 제공합니다.'}),'applicationsNoFinancialGuarantees'],
]) test(`applications contract rejects ${name}`,async t=>{
  const {job}=await fixture(t);mutate(job.publicationBundle);bind(job);
  const result=evaluateAiResearchArticle(job,{now:NOW});
  assert.equal(result.passed,false);assert.ok(result.failedChecks.includes(expected),result.failedChecks.join(','));
});
test('the earlier introduction does not inherit third-party project sources or the new topic scope',async t=>{
  const {job}=await fixture(t);job.publicationBundle.research.topicKey=AI_RESEARCH_SCOPE.topicKey;
  const result=evaluateAiResearchSnapshot(job.publicationBundle,{now:NOW});
  assert.equal(result.passed,false);assert.equal(result.checks.researchOfficialSourceScope,false);
});
test('the original official-source introduction still passes without applications metadata',async t=>{
  const {directory}=await fixture(t),job=await aiResearchFixture(directory);
  assert.equal((await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW})).passed,true);
});
test('project canonical links are available only to the scoped applications topic',()=>{
  const source=JEV_APPLICATION_SOURCES.find(s=>s.projectId==='jev-ultrafast');
  assert.equal(researchSourcePublicUrl(source,JEV_APPLICATIONS_SCOPE.topicKey),'https://github.com/browser-use/jev-ultrafast');
  assert.equal(researchSourcePublicUrl(source,AI_RESEARCH_SCOPE.topicKey),null);
  assert.equal(jevApplicationSourceOwnerScope({...source,publicUrl:'https://signup.example/'}),false);
});
test('official demo descriptions and creator X observations retain exact scope without claims of measured performance',()=>{
  for(const kind of ['official_documentation','verified_creator_post','project_demo']) {
    const source=JEV_APPLICATION_SOURCES.find(s=>s.sourceKind===kind);
    assert.equal(jevApplicationSourceOwnerScope(source),true);
    assert.equal(jevApplicationSourceOwnerScope({...source,projectId:'another-project'}),false);
  }
});
test('project-source artifact tampering still fails literal source and file verification',async t=>{
  const {directory,job}=await fixture(t),bundle=job.publicationBundle;
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).passed,true);
  await writeFile(path.join(directory,bundle.research.sources.find(s=>s.id==='T_REPO').evidenceFile),'different source');
  const report=await verifyPublicationArtifacts(bundle,{baseDir:directory});
  assert.equal(report.passed,false);assert.equal(report.checks.researchSource_T_REPO,false);
});
