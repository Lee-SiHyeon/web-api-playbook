import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {singleOfferHotdealFixture,hotdealPublicHtml} from './support/single-offer-hotdeal-fixture.mjs';
import {NOW,bind,publicationFixture} from './support/publication-fixture.mjs';
import {evaluatePublisherJobGate} from '../scripts/gates/publisher-gates.mjs';
import {evaluateSingleOfferHotdeal} from '../scripts/gates/single-offer-hotdeal-contract.mjs';
import {evaluateAffiliateLinkGate,verifyAffiliateRedirect} from '../scripts/gates/affiliate-link-gate.mjs';
import {verifyPublicationArtifacts} from '../scripts/gates/publication-artifacts.mjs';
import {evaluateExactReadback} from '../scripts/gates/publication-review-gates.mjs';
import {parsePublicDocument} from '../scripts/api/public-document.mjs';
import {sha256} from '../scripts/gates/publication-document.mjs';

async function fixture(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'single-hotdeal-contract-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,job:await singleOfferHotdealFixture(directory)};
}
test('verified single retail promotion with own top image banner passes without claimed use or fake comparator products',async t=>{
  const {directory,job}=await fixture(t),gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});
  assert.deepEqual(gate.failedChecks,[],JSON.stringify(gate.details));assert.equal(job.publicationBundle.products.length,1);
});
for(const [name,mutate,failed] of [
  ['bare low price',j=>delete j.commercialSnapshot.promotion,'hotdealDiscountArithmetic'],
  ['undiscounted price',j=>j.commercialSnapshot.promotion.referencePriceKrw=10000,'hotdealDiscountArithmetic'],
  ['wrong arithmetic',j=>j.commercialSnapshot.promotion.discountAmountKrw=2500,'hotdealDiscountArithmetic'],
  ['different final price',j=>j.commercialSnapshot.payablePriceKrw=9000,'hotdealDiscountArithmetic'],
  ['missing reference basis',j=>delete j.commercialSnapshot.promotion.referenceBasis,'hotdealReferenceBasis'],
  ['stale promotion',j=>j.commercialSnapshot.promotion.checkedAt='2026-09-20T08:59:00Z','hotdealPromotionFresh'],
  ['expired promotion',j=>j.commercialSnapshot.promotion.validUntil='2026-09-20T09:59:00Z','hotdealDeadlineRecorded'],
  ['fake second comparison product',j=>j.publicationBundle.products.push({...j.commercialSnapshot,productId:'9999'}),'hotdealOneExactOffer'],
  ['different item URL',j=>j.commercialSnapshot.productUrl=j.commercialSnapshot.productUrl.replace('itemId=2000','itemId=9999'),'hotdealOneExactOffer'],
  ['different blog',j=>j.blogId='anotherblog','hotdealPublicationScope'],
  ['update request',j=>j.target={type:'update',logNo:'123456789'},'hotdealPublicationScope'],
  ['unverified membership terms',j=>{j.commercialSnapshot.priceBasis='member';j.commercialSnapshot.promotion.kind='member_discount';j.commercialSnapshot.promotion.eligibility='member';},'hotdealConditionalPriceEvidence'],
  ['unrecorded promotion claim',j=>j.publicationBundle.claimLedger.claims=j.publicationBundle.claimLedger.claims.filter(c=>c.claimType!=='promotion'),'hotdealPromotionClaimPresent'],
  ['lowest-ever assertion',j=>j.publicationBundle.document.blocks.push({type:'paragraph',text:'역대 최저가 상품입니다.',claimClass:'guidance'}),'hotdealNoUnsupportedSuperlatives'],
  ['purported hands-on review',j=>j.publicationBundle.document.blocks.push({type:'paragraph',text:'직접 사용해 보니 아주 좋았습니다.',claimClass:'guidance'}),'hotdealNoPurportedUse'],
]) test(`single offer rejects ${name}`,async t=>{
  const {job}=await fixture(t);mutate(job);bind(job);const result=evaluateSingleOfferHotdeal(job,{now:NOW});
  assert.equal(result.passed,false);assert.ok(result.failedChecks.includes(failed),result.failedChecks.join(','));
});
for(const [name,mutate] of [
  ['text link instead of banner',j=>j.publicationBundle.document.blocks[1]={type:'link',label:'상품 보기',url:j.affiliate.url}],
  ['unlinked image',j=>delete j.publicationBundle.document.blocks[1].href],
  ['wrong banner target',j=>j.publicationBundle.document.blocks[1].href='https://link.coupang.com/a/another'],
  ['unverified extra sales link',j=>j.publicationBundle.document.blocks.push({type:'link',label:'다른 판매처',url:'https://www.coupang.com/vp/products/9999'})],
  ['wrong owner identity',j=>j.affiliate.verification.accountId='AF9999'],
]) test(`single offer banner ownership gate rejects ${name}`,async t=>{
  const {job}=await fixture(t);mutate(job);bind(job);assert.equal(evaluateAffiliateLinkGate(job,{now:NOW}).passed,false);
});
test('live redirect retains publisher-owned account and exact product/item/vendor requirements for the new banner',async t=>{
  const {job}=await fixture(t);let calls=0;
  const verify=async owner=>verifyAffiliateRedirect(job,{now:NOW,fetchImpl:async(raw,init)=>{
    calls++;assert.equal(raw,job.affiliate.url);assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).has('cookie'),false);
    return new Response(null,{status:302,headers:{location:job.commercialSnapshot.productUrl+`&lptag=${owner}`}});
  }});
  assert.equal((await verify('AF5462559')).passed,true);assert.equal((await verify('AF9999')).passed,false);assert.equal(calls,2);
});
test('source JSON prices and exact SKU are verified from hashed original bytes, not article-supplied success flags',async t=>{
  const {directory,job}=await fixture(t),bundle=job.publicationBundle;
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).passed,true);
  bundle.products[0].promotion.referencePriceKrw=14000;
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).checks.hotdeal0_hotdealSourceReferencePriceMatches,false);
  bundle.products[0].promotion.referencePriceKrw=12000;
  bundle.products[0].promotion.proof.fields.itemId='/vendorItemId';
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).checks.hotdeal0_hotdealSourceOfferMatches,false);
  await writeFile(path.join(directory,bundle.products[0].promotion.proof.evidenceFile),'tampered');
  assert.equal((await verifyPublicationArtifacts(bundle,{baseDir:directory})).checks.hotdeal0_hotdealOriginalSourceVerified,false);
});
for(const [name,mutate,failed] of [
  ['missing image',b=>b.document.blocks.splice(b.document.blocks.findIndex(x=>x.role==='price_breakdown'),1),'hotdealImageFloor'],
  ['missing AI caption',b=>b.document.blocks[2].text='배너 설명','generatedImageCaption'],
  ['plain section heading',b=>b.document.blocks[3].presentation='plain','hotdealQuoteSections'],
  ['missing mobile image load',b=>b.renderReviews.mobile.presentationChecks.imagesLoaded=false,'mobileReferenceImagesRendered'],
  ['editorial self-review',b=>b.qualityReview.provenance.reviewerExecutionId=b.authorExecutionId,'independentReviewProvenance'],
]) test(`single offer preserves ${name} failure`,async t=>{
  const {directory,job}=await fixture(t);mutate(job.publicationBundle);bind(job);
  const gate=await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW});assert.equal(gate.passed,false);
  assert.ok(gate.details.publicationReview.failedChecks.includes(failed),gate.details.publicationReview.failedChecks.join(','));
});
test('comparison does not inherit single-offer or image-banner exceptions',async t=>{
  const {job}=await fixture(t);job.publicationBundle.format='comparison';bind(job);
  assert.equal(evaluateAffiliateLinkGate(job,{now:NOW}).passed,false);
  const {directory}=await fixture(t);const comparison=await publicationFixture(directory);comparison.publicationBundle.products.pop();bind(comparison);
  const gate=await evaluatePublisherJobGate(comparison,{baseDir:directory,now:NOW});assert.equal(gate.details.publicationReview.checks.comparisonSetPresent,false);
});
test('public readback requires the clickable banner href as well as every ordered body unit',async t=>{
  const {job}=await fixture(t),logNo='987654321';
  const html=hotdealPublicHtml({...job.publicationBundle.document,logNo}),url=`https://blog.naver.com/PostView.naver?blogId=${job.blogId}&logNo=${logNo}`;
  const observation=parsePublicDocument(html,{url,checkedAt:NOW.toISOString()});
  assert.equal(evaluateExactReadback(job,observation,{now:NOW,createdLogNo:logNo}).passed,true);
  const broken=parsePublicDocument(html.replace(`href="${job.affiliate.url}"`,'href="https://example.com/"'),{url,checkedAt:NOW.toISOString()});
  assert.equal(evaluateExactReadback(job,broken,{now:NOW,createdLogNo:logNo}).passed,false);
});

test('ordinary item price and member-only shipping remain separate and require a visible shipping eligibility scope',async t=>{
  const {directory,job}=await fixture(t),product=job.commercialSnapshot,bundle=job.publicationBundle;
  const shippingText='와우 회원 무료배송 혜택이 표시되었습니다.',shippingFile='native-shipping.txt',shippingHash=sha256(shippingText);
  await writeFile(path.join(directory,shippingFile),shippingText);
  product.shippingQuote={eligibility:'wow_member',amountKrw:0,conditions:'와우 회원 무료배송',otherBuyerShipping:'not_verified',checkedAt:NOW.toISOString(),
    evidence:{source:'native_dom',url:product.productUrl,evidenceFile:shippingFile,sha256:shippingHash,excerpt:shippingText}};
  bundle.claimLedger.evidence.SHIPPING={url:product.productUrl,checkedAt:NOW.toISOString(),evidenceFile:shippingFile,sha256:shippingHash};
  bundle.claimLedger.claims.find(c=>c.claimId==='SHIPPING').sources=['SHIPPING'];
  const block=bundle.document.blocks.find(b=>b.claimIds?.includes('SHIPPING'));block.text='와우 회원 무료배송 조건입니다. 일반 회원 배송비는 별도 확인이 필요합니다.';
  bind(job);
  assert.equal(product.priceBasis,'none');assert.equal(product.promotion.eligibility,'none');
  assert.equal((await evaluatePublisherJobGate(job,{baseDir:directory,now:NOW})).passed,true);
  block.text='와우 회원 무료배송 조건입니다.';bind(job);
  assert.equal(evaluateSingleOfferHotdeal(job,{now:NOW}).checks.hotdealShippingScopeVisible,false);
});

test('unverified shipping, altered native evidence or a deadline without an original source field cannot pass',async t=>{
  const {directory,job}=await fixture(t),product=job.commercialSnapshot;
  product.shippingQuote.evidence.excerpt='This fabricated observation was not present in the original source.';
  assert.equal((await verifyPublicationArtifacts(job.publicationBundle,{baseDir:directory})).checks.hotdeal0_hotdealShippingOriginalVerified,false);
  product.shippingQuote.checkedAt='2026-09-20T08:59:00Z';assert.equal(evaluateSingleOfferHotdeal(job,{now:NOW}).checks.hotdealShippingQuote,false);
  product.promotion.validUntil='2026-09-21T10:00:00Z';assert.equal(evaluateSingleOfferHotdeal(job,{now:NOW}).checks.hotdealDeadlineEvidence,false);
});

test('shipping evidence reads decoded JSON strings without rewriting the original native observation',async t=>{
  const {directory,job}=await fixture(t),product=job.commercialSnapshot;
  const excerpt='고객님은\n와우회원\n으로\n무조건 무료배송',bytes=Buffer.from(JSON.stringify({publicProductText:excerpt}));
  const file='native-shipping-original.json';await writeFile(path.join(directory,file),bytes);
  product.shippingQuote.evidence={source:'native_dom',url:product.productUrl,evidenceFile:file,sha256:sha256(bytes),excerpt};
  assert.equal((await verifyPublicationArtifacts(job.publicationBundle,{baseDir:directory})).checks.hotdeal0_hotdealShippingOriginalVerified,true);
  assert.deepEqual(await readFile(path.join(directory,file)),bytes);
});
