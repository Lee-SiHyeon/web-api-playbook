import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {aiResearchFixture} from './support/ai-research-fixture.mjs';
import {NOW,bind,publicationFixture,publicHtml} from './support/publication-fixture.mjs';
import {evaluateAiResearchArticle,researchSourcePublicUrl} from '../scripts/gates/ai-research-article-contract.mjs';
import {evaluatePublisherJobGate,publisherContentFingerprint} from '../scripts/gates/publisher-gates.mjs';
import {evaluateExactReadback} from '../scripts/gates/publication-review-gates.mjs';
import {verifyPublicationArtifacts} from '../scripts/gates/publication-artifacts.mjs';
import {parsePublicDocument} from '../scripts/api/public-document.mjs';
import {auditPost} from '../scripts/api/post-audit.mjs';
import {documentChecks,sha256} from '../scripts/gates/publication-document.mjs';

async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'ai-research-contract-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,job:await aiResearchFixture(directory)};
}
test('noncommercial AI create passes complete source, claim, render, review and authorization gates without dummy affiliate data',async t=>{
  const {directory,job}=await fixture(t);
  const gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});
  assert.deepEqual(gate.failedChecks,[],JSON.stringify(gate.details));
  assert.equal(Object.hasOwn(gate.checks,'monetizedAffiliateVerified'),false);
  assert.equal(gate.details.researchGate.passed,true);
  assert.equal(gate.details.publicationReview.checks.researchNoticeFirst,true);
});
for(const [name,mutate,expected] of [
  ['update target',j=>j.target={type:'update',logNo:'123456789'},'researchArticleScope'],
  ['wrong blog',j=>j.blogId='otherblog','researchArticleScope'],
  ['wrong category name',j=>j.publishSettings.categoryName='여행','researchCategoryScope'],
  ['wrong category ID',j=>j.publishSettings.categoryId=55,'researchCategoryScope'],
  ['wrong subject',j=>j.publicationBundle.research.topicKey='unreviewed-topic','researchTopicScope'],
  ['commercial payload',j=>j.affiliate={url:'https://myrealt.rip/example'},'researchNoCommercePayload'],
  ['fake product',j=>j.publicationBundle.products=[{productId:'dummy'}],'researchNoCommercePayload'],
  ['renamed third-party source',j=>j.publicationBundle.research.sources[0].url='https://untrusted.example/primitives','researchOfficialSourceScope'],
  ['invented canonical URL',j=>j.publicationBundle.research.sources[0].publicUrl='https://affiliate.example/go','researchOfficialSourceScope'],
  ['stale source',j=>j.publicationBundle.research.sources[0].checkedAt='2026-09-18T00:00:00Z','researchSourceContracts'],
  ['unbound source',j=>delete j.publicationBundle.claimLedger.evidence.S0,'researchLedgerSourcesBound'],
  ['missing claim excerpt',j=>j.publicationBundle.research.claimBindings=[],'researchClaimBindings'],
  ['unverified trending rank',j=>j.publicationBundle.claimLedger.claims[0].claimType='trend_rank','researchTrendNotInvented'],
  ['self reviewer',j=>j.publicationBundle.qualityReview.provenance.method='author_self_review','researchEditorialReviewProvenance'],
  ['arbitrary CTA',j=>j.publicationBundle.document.blocks.push({type:'link',display:'label',label:'판매 링크 확인',url:'https://buy.example/'}),'researchLinksScoped'],
]) test(`AI route rejects ${name}`,async t=>{
  const {job}=await fixture(t);mutate(job);bind(job);
  const result=evaluateAiResearchArticle(job,{now:NOW});
  assert.equal(result.passed,false);assert.ok(result.failedChecks.includes(expected),result.failedChecks.join(','));
});
test('research snapshot is included in the authorization fingerprint',async t=>{
  const {job}=await fixture(t),before=publisherContentFingerprint(job);
  job.researchSnapshot.category.id=123;assert.notEqual(publisherContentFingerprint(job),before);
  assert.equal(evaluateAiResearchArticle(job,{now:NOW}).checks.researchSnapshotBound,false);
});
for(const [name,mutate,expected] of [
  ['missing image',b=>b.document.blocks.splice(5,1),'researchImageFloor'],
  ['missing AI caption',b=>b.document.blocks[2].text='그림입니다.','generatedImageCaption'],
  ['self review execution',b=>b.qualityReview.provenance.reviewerExecutionId=b.authorExecutionId,'independentReviewProvenance'],
  ['missing mobile render',b=>delete b.renderReviews.mobile,'mobileRenderMatches'],
  ['collapsed headings',b=>b.document.blocks[4].presentation='plain','researchQuotationSections'],
]) test(`AI does not waive ${name}`,async t=>{
  const {directory,job}=await fixture(t);mutate(job.publicationBundle);bind(job);
  const gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});
  assert.equal(gate.passed,false);assert.ok(gate.details.publicationReview.failedChecks.includes(expected));
});
test('raw hashes and literal claim excerpts independently verify the claimed sources',async t=>{
  const {directory,job}=await fixture(t),bundle=job.publicationBundle;
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).passed,true);
  bundle.research.claimBindings[0].excerpt='Fabricated evidence cannot match the original source bytes.';
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).checks.researchExcerpt_0,false);
  await writeFile(path.join(directory,bundle.research.sources[1].evidenceFile),'altered raw source');
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).checks.researchSource_S1,false);
});
test('AI research can quote an unchanged official Xiaomi chart with page, file, and pixel evidence',async t=>{
  const {directory,job}=await fixture(t),bundle=job.publicationBundle;
  const png=new PNG({width:2,height:1});png.data=Buffer.from([15,25,35,255,45,55,65,255]);
  const original=PNG.sync.write(png),rgb=Buffer.from([15,25,35,45,55,65]);
  await writeFile(path.join(directory,'official-source.png'),original);
  await writeFile(path.join(directory,'official-render.png'),original);
  await mkdir(path.join(directory,'evidence'));
  const sourcePageUrl='https://mimo.mi.com/docs/en-US/news/latest/v2-6';
  const sourceUrl='https://aistudio-cdn.xiaomimimo.com/xiaomimimo-static/mimo-docs-figures/display/Chart26.png';
  const evidenceFile='evidence/official-chart.json';
  const evidenceBytes=Buffer.from(JSON.stringify({collectionMethod:'web_public_excerpt',readerReturnedContent:true,httpStatus:null,url:sourcePageUrl,excerpts:['Official MiMo-V2.6 chart']},null,2)+'\n');
  await writeFile(path.join(directory,evidenceFile),evidenceBytes);
  bundle.research.sources.push({id:'mimo-chart',url:sourcePageUrl,publicUrl:sourcePageUrl,sourceKind:'official_documentation',collectionMethod:'web_public_excerpt',status:null,httpStatus:null,readerReturnedContent:true,checkedAt:NOW.toISOString(),evidenceFile,sha256:sha256(evidenceBytes)});
  const image=bundle.document.blocks.find(block=>block.type==='image');
  image.file='official-render.png';image.sha256=sha256(original);
  image.rights={basis:'official_source_reproduced',source:sourcePageUrl};
  image.sourceArtifact={kind:'official_image_quotation',sourcePageUrl,sourceUrl,sourceFile:'official-source.png',sourceSha256:sha256(original),decodedPixelSha256:sha256(rgb),width:2,height:1};
  assert.equal(documentChecks(bundle.document,{contentKind:'ai_research_article',researchSources:bundle.research.sources}).imageRightsRecorded,true);
  const verified=await verifyPublicationArtifacts(bundle,{baseDir:directory});
  assert.equal(verified.checks.aiResearchOfficialImage0Verified,true,JSON.stringify(verified.checks));
  const altered=PNG.sync.write(Object.assign(new PNG({width:2,height:1}),{data:Buffer.from([15,25,36,255,45,55,65,255])}));
  await writeFile(path.join(directory,'official-render.png'),altered);image.sha256=sha256(altered);
  const rejected=await verifyPublicationArtifacts(bundle,{baseDir:directory});
  assert.equal(rejected.checks.aiResearchOfficialImage0Verified,false);
});
test('renaming a commerce bundle cannot bypass its affiliate and product requirements',async t=>{
  const {directory}=await fixture(t),job=await publicationFixture(directory);
  job.publicationBundle.format='ai_research_article';bind(job);
  assert.equal((await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW})).passed,false);
});
test('canonical reader links derive only from the observed documentation/repository/social source transformations',()=>{
  assert.equal(researchSourcePublicUrl({url:'https://docs.typesafe.ai/primitives.md'}),'https://docs.typesafe.ai/primitives');
  assert.equal(researchSourcePublicUrl({url:'https://raw.githubusercontent.com/typesafe-ai/typesafe-sdk-python/main/README.md'}),'https://github.com/typesafe-ai/typesafe-sdk-python');
  assert.equal(researchSourcePublicUrl({url:'https://raw.githubusercontent.com/other/repository/main/README.md'}),null);
});
test('public readback verifies full ordered content and actual source hrefs; all images still download and audit',async t=>{
  const {directory,job}=await fixture(t),logNo='987654321';
  const observation=parsePublicDocument(publicHtml({...job.publicationBundle.document,logNo}),{
    url:`https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${logNo}`,checkedAt:NOW.toISOString()});
  assert.equal(evaluateExactReadback(job,observation,{now:NOW,createdLogNo:logNo}).passed,true);
  const audit=await auditPost(observation,{researchJob:job,now:()=>NOW,fetchImpl:async raw=>{
    const file=new URL(raw).pathname.split('/').at(-1);return new Response(await readFile(path.join(directory,file)),{headers:{'content-type':'image/png'}});
  }});
  assert.equal(audit.passed,true);assert.equal(audit.uniqueVerifiedImageContents,3);
  assert.equal(Object.hasOwn(audit.checks,'disclosureFirst'),false);
  const broken=structuredClone(observation);broken.links[0]='https://evil.example/';
  assert.equal(evaluateExactReadback(job,broken,{now:NOW,createdLogNo:logNo}).passed,false);
  broken.links=observation.links;broken.units.splice(3,1);
  assert.equal(evaluateExactReadback(job,broken,{now:NOW,createdLogNo:logNo}).passed,false);
});
