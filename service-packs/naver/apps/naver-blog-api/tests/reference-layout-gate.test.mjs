import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceLayoutChecks,singleProductLayout} from '../scripts/gates/reference-layout-gate.mjs';
import {evaluatePublicationReview} from '../scripts/gates/publication-review-gates.mjs';

function fixture(){
 const blocks=[{type:'notice',presentation:'panel',text:'쿠팡 파트너스 안내'}];
 const image=i=>[{type:'image',purpose:`distinct useful view ${i}`,rights:{basis:'product_listing',attribution:'판매자 이미지'}},{type:'paragraph',text:'판매자 이미지'}];
 blocks.push(...image(0));
 for(let i=0;i<4;i++){blocks.push({type:'heading',presentation:'quotation',text:`제목 ${i}`},{type:'paragraph',text:'해당 이미지와 관련한 선택 기준 설명입니다.'},...image(i+1));if(i<3)blocks.push({type:'paragraph',text:'다른 구체적인 부분을 살펴봅니다.'},...image(i+5));}
 return {format:'tested_single_product',layoutReference:{id:singleProductLayout.id},document:{blocks},renderReviews:Object.fromEntries(['desktop','mobile'].map(d=>[d,{imageCount:8,presentationChecks:{imagesLoaded:true,disclosurePanel:true}}]))};
}
test('reference layout accepts distributed useful images, attributed sources and native panel',()=>assert.ok(Object.values(referenceLayoutChecks(fixture())).every(Boolean)));
test('comparison requires images, distinct purposes, attribution and both complete native renders',()=>{
 const good={...fixture(),format:'comparison'};
 assert.ok(Object.values(referenceLayoutChecks(good)).every(Boolean));
 for(const mutate of [
  b=>b.document.blocks=b.document.blocks.filter(x=>x.type!=='image'),
  b=>delete b.document.blocks.find(x=>x.type==='image').purpose,
  b=>b.document.blocks[2].text='missing credit',
  b=>b.renderReviews.mobile.imageCount=7,
  b=>b.renderReviews.desktop.presentationChecks.imagesLoaded=false,
  b=>delete b.renderReviews.mobile,
 ]){
  const bad=structuredClone(good);mutate(bad);
  assert.ok(Object.values(referenceLayoutChecks(bad)).some(value=>value===false));
 }
});
test('generated images require an adjacent visible AI-generation caption in either format',()=>{
 for(const format of ['comparison','tested_single_product']){
  const b={...fixture(),format};b.document.blocks[1].rights={basis:'generated'};
  assert.equal(referenceLayoutChecks(b).generatedImageCaption,false);
  b.document.blocks[2].text='AI로 생성한 구성 예시 이미지입니다.';
  assert.equal(referenceLayoutChecks(b).generatedImageCaption,true);
 }
});
test('omitting or inventing the format cannot bypass its reference policy',()=>{
 for(const format of [undefined,'text_only'])assert.equal(referenceLayoutChecks({...fixture(),format}).referenceFormatKnown,false);
});
for(const [name,mutate,failed] of [
 ['no reference profile',b=>delete b.layoutReference,'referenceProfileApplied'],
 ['zero optional image floors',b=>b.document.blocks=b.document.blocks.filter(x=>x.type!=='image'),'referenceImageFloor'],
 ['flattened section titles',b=>b.document.blocks.filter(x=>x.type==='heading').forEach(x=>delete x.presentation),'referenceQuotationHeadings'],
 ['inline notice highlight',b=>b.document.blocks[0].presentation='muted','referenceDisclosurePanel'],
 ['all images at the end',b=>{const bs=b.document.blocks;b.document.blocks=[...bs.filter(x=>x.type!=='image'),...bs.filter(x=>x.type==='image')];},'referenceSectionImages'],
 ['missing image attribution',b=>b.document.blocks[2].text='source omitted','referenceImageAttribution'],
 ['mobile image failed to load',b=>b.renderReviews.mobile.presentationChecks.imagesLoaded=false,'mobileReferenceImagesRendered'],
 ['mobile has fewer images',b=>b.renderReviews.mobile.imageCount=7,'mobileReferenceImagesRendered'],
 ['native paragraph box absent',b=>b.renderReviews.desktop.presentationChecks.disclosurePanel=false,'desktopReferenceDisclosurePanel'],
])test(`publication gate rejects ${name}`,()=>{const bundle=fixture();mutate(bundle);const result=evaluatePublicationReview({publicationBundle:bundle,minImageCount:0,minQuoteComponents:0});assert.ok(result.failedChecks.includes(failed));});
