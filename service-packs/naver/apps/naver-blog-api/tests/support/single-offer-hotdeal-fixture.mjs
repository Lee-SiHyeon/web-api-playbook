import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PNG} from 'pngjs';
import {publicationFixture,bind,NOW,publicHtml} from './publication-fixture.mjs';
import {sha256} from '../../scripts/gates/publication-document.mjs';
import {SINGLE_OFFER_HOTDEAL} from '../../scripts/gates/single-offer-hotdeal-contract.mjs';

export async function singleOfferHotdealFixture(directory,now=NOW) {
  const job=await publicationFixture(directory,now),bundle=job.publicationBundle,product=job.commercialSnapshot,checkedAt=now.toISOString();
  job.blogId=SINGLE_OFFER_HOTDEAL.blogId;job.target={type:'create'};job.inputProvider='headless_sdk';
  job.publishSettings={tags:['테스트','정보'],visibility:'public',timing:'current',searchAllowed:true,categoryId:6};
  bundle.document.blogId=job.blogId;delete bundle.document.logNo;
  bundle.format=SINGLE_OFFER_HOTDEAL.format;bundle.contentBasis='listing_review_only';bundle.layoutReference={id:SINGLE_OFFER_HOTDEAL.layoutId};
  bundle.collision={blogId:job.blogId,checkedAt,decision:'create'};
  product.provider='coupang';product.productUrl=`https://www.coupang.com/vp/products/${product.productId}?itemId=${product.itemId}&vendorItemId=${product.vendorItemId}`;
  const original={synthetic:true,items:[{productId:product.productId,itemId:product.itemId,vendorItemId:product.vendorItemId,referencePrice:12000,salePrice:10000,conditions:'일반 고객 표시 가격',shippingTerms:'모든 구매자 무료배송 조건을 표시합니다.'}]};
  const bytes=Buffer.from(JSON.stringify(original)),evidenceFile='hotdeal-source.json',hash=sha256(bytes),url='https://partners.coupang.com/api/v1/search';
  await writeFile(path.join(directory,evidenceFile),bytes);product.evidenceFile=evidenceFile;product.evidenceSha256=hash;
  product.promotion={kind:'instant_discount',checkedAt,referenceBasis:'seller_displayed_reference_price',referencePriceKrw:12000,payablePriceKrw:10000,
    discountAmountKrw:2000,eligibility:'none',validUntil:null,proof:{source:'independent_http',status:200,format:'json_pointer',url,checkedAt,evidenceFile,sha256:hash,recordPointer:'/items/0',
      fields:{productId:'/productId',itemId:'/itemId',vendorItemId:'/vendorItemId',referencePriceKrw:'/referencePrice',payablePriceKrw:'/salePrice'}}};
  product.shippingQuote={eligibility:'all_buyers',amountKrw:0,conditions:original.items[0].shippingTerms,otherBuyerShipping:'same',checkedAt,
    evidence:{source:'independent_http',url,evidenceFile,sha256:hash,excerpt:`"shippingTerms":"${original.items[0].shippingTerms}"`}};
  bundle.products=[product];
  bundle.claimLedger={schemaVersion:1,evidence:{OFFER:{url,checkedAt,evidenceFile,sha256:hash}},claims:[
    {claimId:'PRICE',claimType:'price',text:'현재 표시 가격은 10,000원입니다.',productId:product.productId,variantId:product.variantId,support:'supports',publishable:true,sources:['OFFER'],expiresAt:new Date(now.getTime()+60*60000).toISOString()},
    {claimId:'PROMO',claimType:'promotion',text:'판매 페이지 표시 기준가 12,000원에서 2,000원 낮은 가격입니다.',productId:product.productId,variantId:product.variantId,support:'supports',publishable:true,sources:['OFFER']},
    {claimId:'SHIPPING',claimType:'shipping',text:original.items[0].shippingTerms,productId:product.productId,variantId:product.variantId,support:'supports',publishable:true,sources:['OFFER'],expiresAt:new Date(now.getTime()+60*60000).toISOString()},
  ]};
  job.affiliate.provider='coupang';job.affiliate.accountId='AF5462559';job.affiliate.verification.accountId='AF5462559';
  const images=[];
  for(const [i,role] of ['affiliate_banner','price_breakdown','purchase_checklist'].entries()) {
    const png=new PNG({width:12,height:8});png.data.fill(90+i*50);const data=PNG.sync.write(png),file=`${role}.png`;
    await writeFile(path.join(directory,file),data);images.push({type:'image',role,file,sha256:sha256(data),publishedUrl:`https://blogfiles.pstatic.net/synthetic-hotdeal/${file}`,
      ...(i===0?{href:job.affiliate.url}:{}),purpose:`Synthetic useful illustration for ${role}`,rights:{basis:'generated',source:'Synthetic fixture only'}});
  }
  const paragraph=text=>({type:'paragraph',text,claimClass:'guidance'}),heading=text=>({type:'heading',text,presentation:'quotation',claimClass:'guidance'});
  job.title=bundle.document.title='상품 하나의 표시 할인과 구매 조건 확인';
  bundle.document.blocks=[
    {type:'notice',presentation:'panel',text:'이 포스팅은 쿠팡 파트너스 활동의 일환으로 일정액의 수수료를 제공받습니다.'},images[0],paragraph('AI로 제작한 상품 확인 배너입니다.'),
    heading('현재 표시 가격을 확인하기'),
    ...bundle.claimLedger.claims.map(c=>({type:'paragraph',text:c.text,claimClass:'factual',claimIds:[c.claimId]})),
    images[1],paragraph('AI로 생성한 표시 가격 계산 그림입니다.'),
    heading('필요한 옵션을 고르는 기준'),paragraph('필요 수량과 보관 공간을 먼저 확인하고 최종 선택 옵션의 정보를 비교하세요.'),
    heading('결제 전에 확인할 항목'),images[2],paragraph('AI로 제작한 구매 조건 확인 그림입니다.'),
    paragraph('판매 정보 기준으로 정리했습니다. 가격과 배송 조건은 선택 시점의 상품 페이지에서 다시 확인하세요.'),
  ];
  for(const review of Object.values(bundle.renderReviews)){review.imageCount=3;review.presentationChecks.disclosurePanel=true;review.presentationChecks.disclosureStyled=true;}
  return bind(job);
}

export function hotdealPublicHtml(document) {
  let html=publicHtml(document);
  for(const image of document.blocks.filter(b=>b.type==='image'&&b.href)) {
    const original=`<img data-lazy-src="${image.publishedUrl}">`;
    html=html.replace(original,`<a href="${image.href}">${original}</a>`);
  }
  return html;
}
