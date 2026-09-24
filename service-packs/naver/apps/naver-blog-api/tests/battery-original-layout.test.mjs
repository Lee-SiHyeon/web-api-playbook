import {documentChecks} from '../scripts/gates/publication-document.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {singleOfferHotdealLayoutChecks} from '../scripts/gates/single-offer-hotdeal-contract.mjs';
import {existingArticleUpdateScope} from '../scripts/gates/existing-article-update-scope.mjs';
function fixture(){
 const p={productId:'6888281723',itemId:'25978979167',vendorItemId:'83715729697',variantId:'25978979167-83715729697-ctype-white'};
 const blocks=[{type:'notice',presentation:'panel',text:'제휴 안내'}];
 for(const [i,role]of ['affiliate_banner','product_detail','connector_detail'].entries()){
  if(i)blocks.push({type:'heading',presentation:'quotation',text:'제품 확인'+i});
  const source='https://thumbnail.coupangcdn.com/thumbnails/remote/492x492ex/image/synthetic-'+i+'.jpg';
  blocks.push({type:'image',role,sha256:String(i+1).repeat(64),...(i?{}:{href:'https://link.coupang.com/a/example'}),rights:{basis:'product_listing',source:'https://www.coupang.com/vp/products/6888281723?itemId=25978979167&vendorItemId=83715729697',attribution:'판매자 상품 이미지'},sourceRepresentation:'seller_original_transcoded',sourceArtifact:{sourceSha256:'a'.repeat(64),decodedPixelSha256:'b'.repeat(64),assetUrl:source}});
  blocks.push({type:'paragraph',text:'판매자 상품 이미지 · 상세 보기'});
 }blocks.push({type:'heading',presentation:'quotation',text:'구매 조건'});
 const bundle={format:'single_offer_hotdeal',products:[p],document:{blogId:'aicandoanything',logNo:'224417064414',blocks},layoutReference:{id:'naver-single-offer-hotdeal-v1',variant:'original-seller-battery-v1'}};
 return {bundle,job:{blogId:'aicandoanything',target:{type:'update',logNo:'224417064414'},inputProvider:'independent_http',executionMode:'independent_http',commercialSnapshot:p,publicationBundle:bundle}};
}
test('only exact existing battery SKU admits attributed original seller image roles',()=>{
 const {bundle,job}=fixture();assert.equal(singleOfferHotdealLayoutChecks(bundle).hotdealImageRoles,true);assert.equal(existingArticleUpdateScope(job).categoryId,1);assert.equal(documentChecks(bundle.document).imageRightsRecorded,true);
 for(const mutate of [b=>b.document.logNo='224419069353',b=>b.products[0].itemId='other',b=>b.products[0].variantId='8pin',b=>b.document.blocks[2].text='출처 없음',b=>b.document.blocks[1].rights.source='https://example.com/a.jpg',b=>b.document.blocks[1].sourceArtifact.assetUrl='https://example.com/image.jpg',b=>b.document.blocks[1].sourceArtifact.decodedPixelSha256='',b=>b.document.blocks[1].role='price_breakdown']){
  const copy=structuredClone(bundle);mutate(copy);assert.equal(singleOfferHotdealLayoutChecks(copy).hotdealImageRoles,false);
 }
 job.commercialSnapshot.variantId='8pin';assert.equal(existingArticleUpdateScope(job),null);
});
test('generic hotdeal retains original price/checklist image roles',()=>{
 const {bundle}=fixture();delete bundle.layoutReference.variant;assert.equal(singleOfferHotdealLayoutChecks(bundle).hotdealImageRoles,false);
 bundle.document.blocks.filter(b=>b.type==='image').forEach((b,i)=>b.role=['affiliate_banner','price_breakdown','purchase_checklist'][i]);assert.equal(singleOfferHotdealLayoutChecks(bundle).hotdealImageRoles,true);
});
