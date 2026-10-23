import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EXISTING_ARTICLE_UPDATES,existingArticleUpdateScope,isExistingAiUpdate} from '../scripts/gates/existing-article-update-scope.mjs';
import {evaluateAiResearchArticle} from '../scripts/gates/ai-research-article-contract.mjs';
import {evaluateSingleOfferHotdeal} from '../scripts/gates/single-offer-hotdeal-contract.mjs';
import {evaluateIclubAffiliate} from '../scripts/gates/iclub-hotel-contract.mjs';
import {evaluateSeoulShillaAffiliate} from '../scripts/gates/seoul-shilla-contract.mjs';
import {evaluatePublisherJobGate,publisherContentFingerprint} from '../scripts/gates/publisher-gates.mjs';
import {aiResearchFixture} from './support/ai-research-fixture.mjs';
import {NOW,bind} from './support/publication-fixture.mjs';

function scoped(id){const s=EXISTING_ARTICLE_UPDATES[id];return {blogId:s.blogId,target:{type:'update',logNo:id},inputProvider:'independent_http',executionMode:'independent_http',
 publicationBundle:{format:s.format,document:{blogId:s.blogId,logNo:id,blocks:[]},research:{topicKey:s.topicKey}},
 ...(s.productId?{commercialSnapshot:{productId:s.productId,variantId:s.variantId}}:{}),
 publishSettings:{visibility:'public',timing:'current',searchAllowed:true,categoryId:s.categoryId}};}
for(const id of Object.keys(EXISTING_ARTICLE_UPDATES))test(`scope ${id} rejects foreign targets, owners, formats and browser writes`,()=>{
 const job=scoped(id);assert.equal(existingArticleUpdateScope(job),EXISTING_ARTICLE_UPDATES[id]);
 for(const mutate of [j=>j.target.logNo='999999999999',j=>j.target.type='create',j=>j.blogId='other',j=>j.publicationBundle.document.blogId='other',j=>j.publicationBundle.document.logNo='999999999999',j=>j.publicationBundle.format='other',j=>j.inputProvider='headless_sdk',j=>j.executionMode='browser']){
  const changed=structuredClone(job);mutate(changed);assert.equal(existingArticleUpdateScope(changed),null);
 }
 if(job.publicationBundle.research.topicKey){job.publicationBundle.research.topicKey='wrong-topic';assert.equal(existingArticleUpdateScope(job),null);}
 if(job.commercialSnapshot){job.commercialSnapshot.productId='foreign-product';assert.equal(existingArticleUpdateScope(job),null);}
});
test('Narangd adapter rejects another option of the same product',()=>{const j=scoped('224419069353');j.commercialSnapshot.variantId='other-option';assert.equal(existingArticleUpdateScope(j),null);});
test('commercial scope cannot dispatch into informational bypass',()=>{
 for(const id of ['224418980453','224418864957','224419069353'])assert.equal(isExistingAiUpdate(scoped(id)),false);
});
test('allowlisted affiliate updates still require all existing commercial and attribution checks',()=>{
 for(const [id,evaluate,key] of [['224418980453',evaluateSeoulShillaAffiliate,'shillaCreateScope'],['224418864957',evaluateIclubAffiliate,'iclubCreateScope'],['224419069353',evaluateSingleOfferHotdeal,'hotdealPublicationScope']]){
  const result=evaluate(scoped(id),{now:NOW});assert.equal(result.checks[key],true);assert.equal(result.passed,false);assert.ok(result.failedChecks.length>5);
 }
});
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'existing-ai-update-'));t.after(()=>rm(dir,{recursive:true,force:true}));const job=await aiResearchFixture(dir);job.target={type:'update',logNo:'224419004923'};job.inputProvider='independent_http';job.publicationBundle.document.logNo=job.target.logNo;job.preflight.sourceConfigurationFingerprint='a'.repeat(64);job.preflight.sourcePopulationMetaFingerprint='b'.repeat(64);bind(job);return {dir,job};}
test('AI update admission still executes source, category, commercial exclusion and independent review contracts',async t=>{
 const {job}=await fixture(t);assert.equal(evaluateAiResearchArticle(job,{now:NOW}).passed,true);
 for(const [mutate,key] of [[j=>j.publicationBundle.research.sources=[],'researchPrimarySourceLinks'],[j=>j.publishSettings.categoryId=10,'researchCategoryScope'],[j=>j.affiliate={url:'https://link.coupang.com/a/foreign'},'researchNoCommercePayload'],[j=>j.publicationBundle.qualityReview.provenance.method='self_review','researchEditorialReviewProvenance']]){
  const bad=structuredClone(job);mutate(bad);const r=evaluateAiResearchArticle(bad,{now:NOW});assert.equal(r.passed,false);assert.equal(r.checks[key],false,key);assert.ok(r.failedChecks.includes(key),r.failedChecks.join(','));
 }
});
test('AI update authorization fingerprint binds source settings and category metadata',async t=>{
 const {job}=await fixture(t);const baseline=publisherContentFingerprint(job);
 for(const field of ['sourceConfigurationFingerprint','sourcePopulationMetaFingerprint']){const bad=structuredClone(job);bad.preflight[field]='c'.repeat(64);assert.notEqual(publisherContentFingerprint(bad),baseline);}
});
test('allowlisted update remains blocked by absent authorization, review and image evidence',async t=>{
 const {dir,job}=await fixture(t);job.authorization.approved=false;job.publicationBundle.qualityReview.provenance.method='self_review';job.publicationBundle.document.blocks.find(b=>b.type==='image').file='missing.png';
 const r=await evaluatePublisherJobGate(job,{baseDir:dir,now:NOW});assert.equal(r.passed,false);assert.equal(r.checks.explicitAuthorizationPresent,false);assert.equal(r.checks.publicationReviewPassed,false);assert.ok(r.failedChecks.some(k=>/image|artifact/i.test(k)));
});
