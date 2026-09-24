import {articleBlockText} from './article-block-text.mjs';
import {existingArticleUpdateScope} from './existing-article-update-scope.mjs';
import {fingerprint} from '../../../../packages/contracts/src/index.mjs';
import {text} from './publication-document.mjs';

export const SINGLE_OFFER_HOTDEAL=Object.freeze({format:'single_offer_hotdeal',blogId:'aicandoanything',provider:'coupang',layoutId:'naver-single-offer-hotdeal-v1',minImages:3});
export const isSingleOfferHotdeal=job=>job?.publicationBundle?.format===SINGLE_OFFER_HOTDEAL.format;
const hash=value=>/^[a-f0-9]{64}$/.test(value||'');
const digits=value=>/^\d+$/.test(String(value||''));
const positive=value=>Number.isInteger(value)&&value>0;
const recent=(value,now)=>Number.isFinite(Date.parse(value))&&Date.parse(value)<=now.getTime()&&now.getTime()-Date.parse(value)<=60*60000;
const finish=checks=>({passed:Object.values(checks).every(v=>v===true),checks,failedChecks:Object.keys(checks).filter(k=>checks[k]!==true)});
const sourceUrl=value=>{try{const u=new URL(value);return u.protocol==='https:'&&['www.coupang.com','m.coupang.com','partners.coupang.com'].includes(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.hash;}catch{return false;}};
const shortLink=value=>/^https:\/\/link\.coupang\.com\/a\/[A-Za-z0-9]+$/.test(value||'');
const recordBlocks=job=>[job?.publicationBundle?.document?.blocks||[],job?.bodyBlocks||job?.blocks||[]];

export function exactHotdealProductUrl(value,product) {
  try {const u=new URL(value);return u.protocol==='https:'&&u.hostname==='www.coupang.com'&&!u.username&&!u.password&&!u.port&&
    u.pathname===`/vp/products/${product.productId}`&&u.searchParams.getAll('itemId').length===1&&u.searchParams.get('itemId')===String(product.itemId)&&
    u.searchParams.getAll('vendorItemId').length===1&&u.searchParams.get('vendorItemId')===String(product.vendorItemId);
  } catch {return false;}
}

export function evaluateSingleOfferHotdeal(job,{now=new Date()}={}) {
  const bundle=job?.publicationBundle,product=job?.commercialSnapshot,promotion=product?.promotion,proof=promotion?.proof;
  const products=Array.isArray(bundle?.products)?bundle.products:[],blocks=bundle?.document?.blocks||[],claims=bundle?.claimLedger?.claims||[];
  const shipping=product?.shippingQuote,shippingProof=shipping?.evidence;
  const kindBasis={instant_discount:'none',coupon:'coupon',member_discount:'member',member_coupon:'member_coupon'};
  const facts=blocks.filter(b=>b.claimClass==='factual'),used=new Set(facts.flatMap(b=>b.claimIds||[]));
  const proofFieldSet=proof?.fields||{};
  const sameClaim=claim=>claim?.support==='supports'&&claim.publishable===true&&claim.productId===product?.productId&&claim.variantId===product?.variantId&&used.has(claim.claimId);
  const sourceBound=claims.filter(c=>c.claimType==='promotion'&&sameClaim(c)).some(c=>c.sources?.some(id=>{
    const e=bundle?.claimLedger?.evidence?.[id];return e?.evidenceFile===proof?.evidenceFile&&e?.sha256===proof?.sha256&&e?.url===proof?.url&&e?.checkedAt===proof?.checkedAt;
  }));
  return finish({
    hotdealFormat:isSingleOfferHotdeal(job),
    hotdealPublicationScope:job?.blogId===SINGLE_OFFER_HOTDEAL.blogId&&(['224419069353','224417064414'].includes(existingArticleUpdateScope(job)?.existingLogNo)||job?.target?.type==='create'&&!job.target.logNo&&job?.inputProvider==='headless_sdk')&&job?.executionMode==='independent_http'&&job?.publishSettings?.visibility==='public'&&job.publishSettings.timing==='current'&&job.publishSettings.searchAllowed===true,
    hotdealListingBasis:bundle?.contentBasis==='listing_review_only',
    hotdealOneExactOffer:products.length===1&&fingerprint(products[0])===fingerprint(product??null)&&product?.provider==='coupang'&&
      [product?.productId,product?.itemId,product?.vendorItemId].every(digits)&&product?.quantity===1&&exactHotdealProductUrl(product?.productUrl,product),
    hotdealPromotionKind:Object.hasOwn(kindBasis,promotion?.kind||'')&&kindBasis[promotion.kind]===product?.priceBasis&&promotion.eligibility===product.priceBasis,
    hotdealPromotionFresh:recent(promotion?.checkedAt,now)&&recent(proof?.checkedAt,now)&&promotion.checkedAt===proof.checkedAt,
    hotdealReferenceBasis:promotion?.referenceBasis==='seller_displayed_reference_price',
    hotdealDiscountArithmetic:positive(promotion?.referencePriceKrw)&&positive(promotion?.payablePriceKrw)&&positive(promotion?.discountAmountKrw)&&
      promotion.referencePriceKrw>promotion.payablePriceKrw&&promotion.referencePriceKrw-promotion.payablePriceKrw===promotion.discountAmountKrw&&promotion.payablePriceKrw===product?.payablePriceKrw,
    hotdealDeadlineRecorded:promotion?.validUntil===null||Number.isFinite(Date.parse(promotion?.validUntil))&&Date.parse(promotion.validUntil)>=now.getTime(),
    hotdealDeadlineEvidence:promotion?.validUntil===null||typeof proofFieldSet.validUntil==='string',
    hotdealProofContract:proof?.source==='independent_http'&&proof?.status===200&&proof?.format==='json_pointer'&&sourceUrl(proof.url)&&
      text(proof.evidenceFile)&&hash(proof.sha256)&&typeof proof.recordPointer==='string'&&
      ['referencePriceKrw','payablePriceKrw'].every(k=>typeof proofFieldSet[k]==='string')&&
      (typeof proofFieldSet.productUrl==='string'||['productId','itemId','vendorItemId'].every(k=>typeof proofFieldSet[k]==='string')),
    hotdealConditionalPriceEvidence:product?.priceBasis==='none'||typeof proofFieldSet.conditions==='string'&&text(product?.conditions).length>=5&&
      facts.some(b=>articleBlockText(b).includes(text(product.conditions))),
    hotdealReferencePriceWording:blocks.some(b=>/판매\s*페이지|판매자/.test(articleBlockText(b))&&/표시\s*(?:기준가|가격)|기준가/.test(articleBlockText(b))),
    hotdealSourceBound:sourceBound,
    hotdealPromotionClaimPresent:claims.some(c=>c.claimType==='promotion'&&sameClaim(c)),
    hotdealShippingQuote:['all_buyers','wow_member','order_threshold'].includes(shipping?.eligibility)&&shipping?.amountKrw===product?.shippingKrw&&
      Number.isInteger(shipping?.amountKrw)&&shipping.amountKrw>=0&&text(shipping?.conditions).length>=5&&recent(shipping?.checkedAt,now)&&
      (shipping.eligibility==='all_buyers'?shipping.otherBuyerShipping==='same':shipping.otherBuyerShipping==='not_verified'),
    hotdealShippingEvidence:['independent_http','native_dom'].includes(shippingProof?.source)&&sourceUrl(shippingProof?.url)&&hash(shippingProof?.sha256)&&
      text(shippingProof?.evidenceFile)&&text(shippingProof?.excerpt).length>=12&&text(shippingProof.excerpt).includes(text(shipping?.conditions))&&
      (shipping?.eligibility!=='wow_member'||/와우\s*회원/.test(text(shippingProof?.excerpt))),
    hotdealShippingScopeVisible:facts.some(b=>articleBlockText(b).includes(text(shipping?.conditions)))&&
      (shipping?.eligibility==='all_buyers'||blocks.some(b=>/(?:일반\s*회원|비회원|다른\s*구매자).*배송비/.test(articleBlockText(b))&&/확인|별도|달라/.test(articleBlockText(b)))),
    hotdealShippingEligibilityVisible:shipping?.eligibility!=='wow_member'||facts.some(b=>/와우\s*회원/.test(articleBlockText(b))&&articleBlockText(b).includes(text(shipping.conditions))),
    hotdealShippingClaimBound:claims.some(c=>c.claimType==='shipping'&&sameClaim(c)&&c.sources?.some(id=>{
      const e=bundle?.claimLedger?.evidence?.[id];return e?.evidenceFile===shippingProof?.evidenceFile&&e?.sha256===shippingProof?.sha256&&e?.url===shippingProof?.url&&e?.checkedAt===shipping?.checkedAt;
    })),
    hotdealNoUnsupportedSuperlatives:!/(?:역대\s*최저|최저가|최저\s*가격|전국\s*최저|전체\s*최저|무조건\s*저렴)/i.test(blocks.map(b=>articleBlockText(b)).join('\n')),
    hotdealNoPurportedUse:!/(?:직접\s*(?:사용|구매|써|마셔|먹어)|실사용\s*(?:후기|리뷰)|내돈내산|써\s*보니|사용해\s*보니|마셔\s*보니|먹어\s*보니)/.test(blocks.map(b=>articleBlockText(b)).join('\n')),
  });
}

export function singleOfferHotdealLayoutChecks(bundle) {
  const blocks=bundle?.document?.blocks||[],images=blocks.map((b,i)=>({b,i})).filter(({b})=>b.type==='image');
  const headings=blocks.filter(b=>b.type==='heading');
  const roles=new Set(images.map(({b})=>b.role));
  const originalBattery=bundle?.layoutReference?.variant==='original-seller-battery-v1';
  const battery=bundle?.products?.[0];
  const sellerAssets=images.map(({b})=>b.sourceArtifact?.assetUrl);
  const batteryScope=originalBattery&&bundle?.document?.blogId==='aicandoanything'&&bundle.document.logNo==='224417064414'&&battery?.productId==='6888281723'&&battery.itemId==='25978979167'&&battery.vendorItemId==='83715729697'&&battery.variantId==='25978979167-83715729697-ctype-white';
  const sellerAssetSource=value=>{try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='thumbnail.coupangcdn.com'&&u.pathname.startsWith('/thumbnails/remote/492x492ex/image/')&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}};
  let run=0,maxRun=0;
  for(const b of blocks){if(b.type==='image')run=0;else if(['paragraph','quote'].includes(b.type)){run+=articleBlockText(b).length;maxRun=Math.max(maxRun,run);}}
  return {
    hotdealLayoutProfile:bundle?.layoutReference?.id===SINGLE_OFFER_HOTDEAL.layoutId,
    hotdealImageFloor:images.length>=SINGLE_OFFER_HOTDEAL.minImages,
    hotdealImageRoles:originalBattery?batteryScope&&images.length===3&&['affiliate_banner','product_detail','connector_detail'].every(role=>roles.has(role))&&new Set(sellerAssets).size===3&&images.every(({b,i})=>b.rights?.basis==='product_listing'&&sellerAssetSource(b.sourceArtifact?.assetUrl)&&hash(b.sha256)&&b.sourceRepresentation==='seller_original_transcoded'&&hash(b.sourceArtifact?.sourceSha256)&&hash(b.sourceArtifact?.decodedPixelSha256)&&b.rights.source==='https://www.coupang.com/vp/products/6888281723?itemId=25978979167&vendorItemId=83715729697'&&text(b.rights.attribution)&&blocks[i+1]?.type==='paragraph'&&text(blocks[i+1].text).includes(text(b.rights.attribution))):['affiliate_banner','price_breakdown','purchase_checklist'].every(role=>roles.has(role)),
    hotdealTopBanner:blocks[0]?.type==='notice'&&blocks[0].presentation==='panel'&&blocks[1]?.type==='image'&&blocks[1].role==='affiliate_banner'&&shortLink(blocks[1].href),
    hotdealQuoteSections:headings.length>=3&&headings.every(b=>b.presentation==='quotation'),
    hotdealSectionImages:images.slice(1).every(({i})=>blocks.slice(0,i).some(b=>b.type==='heading')),
    hotdealTextImageRhythm:maxRun<=900,
    hotdealNoImageStrips:blocks.every(b=>b.type!=='imageStrip'),
    hotdealDesktopNoticePanel:bundle?.renderReviews?.desktop?.presentationChecks?.disclosurePanel===true,
    hotdealMobileNoticePanel:bundle?.renderReviews?.mobile?.presentationChecks?.disclosurePanel===true,
  };
}

export function evaluateSingleOfferHotdealAffiliate(job,{now=new Date()}={}) {
  const a=job?.affiliate,p=job?.commercialSnapshot,proof=a?.verification;
  return finish({
    hotdealCoupangAffiliate:a?.provider==='coupang'&&p?.provider==='coupang'&&shortLink(a?.url),
    hotdealSingleImageBanner:recordBlocks(job).every(blocks=>blocks[0]?.type==='notice'&&blocks[1]?.type==='image'&&blocks[1].role==='affiliate_banner'&&blocks[1].href===a?.url&&
      blocks.filter(b=>b.href).length===1&&blocks.every(b=>!['link','oglink','imageStrip'].includes(b.type))&&
      blocks.filter(b=>['notice','heading','paragraph','quote','list','numbered','table'].includes(b.type)).every(b=>!/https?:\/\//i.test(articleBlockText(b)))),
    selectedOfferMatches:p?.affiliateUrl===a?.url&&[p?.productId,p?.itemId,p?.vendorItemId].every(digits),
    redirectEvidenceRequired:proof?.source==='independent_http_redirect'&&proof?.status===302&&recent(proof?.checkedAt,now),
    verifiedUrlMatches:proof?.url===a?.url,
    attributionPresent:/^AF\d+$/.test(a?.accountId||'')&&proof?.accountId===a?.accountId,
    exactOfferVerified:proof?.productId===p?.productId&&proof?.itemId===p?.itemId&&proof?.vendorItemId===p?.vendorItemId,
  });
}

function pointer(value,location) {
  if(location==='')return value;
  if(typeof location!=='string'||!location.startsWith('/'))throw Error('HOTDEAL_POINTER_INVALID');
  for(const raw of location.slice(1).split('/')) {
    const key=raw.replaceAll('~1','/').replaceAll('~0','~');
    if(!value||typeof value!=='object'||!Object.hasOwn(value,key)||['__proto__','constructor','prototype'].includes(key))throw Error('HOTDEAL_POINTER_UNRESOLVED');
    value=value[key];
  }
  return value;
}
const amount=value=>typeof value==='number'?value:/^\d[\d,]*$/.test(String(value||''))?Number(String(value).replaceAll(',','')):NaN;
const jsonStrings=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(jsonStrings):value&&typeof value==='object'?Object.values(value).flatMap(jsonStrings):[];
export async function verifySingleOfferHotdealEvidence(product,{read}={}) {
  const promotion=product?.promotion,proof=promotion?.proof,checks={};
  try {
    const original=JSON.parse((await read(proof.evidenceFile,proof.sha256)).toString('utf8'));
    const row=pointer(original,proof.recordPointer),fields=proof.fields;
    checks.hotdealOriginalSourceVerified=true;
    checks.hotdealSourceOfferMatches=typeof fields.productUrl==='string'
      ? exactHotdealProductUrl(pointer(row,fields.productUrl),product)
      : ['productId','itemId','vendorItemId'].every(k=>String(pointer(row,fields[k]))===String(product[k]));
    checks.hotdealSourceReferencePriceMatches=amount(pointer(row,fields.referencePriceKrw))===promotion.referencePriceKrw;
    checks.hotdealSourceCurrentPriceMatches=amount(pointer(row,fields.payablePriceKrw))===promotion.payablePriceKrw;
    checks.hotdealSourceEligibilityMatches=product.priceBasis==='none'||text(pointer(row,fields.conditions))===text(product.conditions);
    checks.hotdealSourceDeadlineMatches=promotion.validUntil===null||Date.parse(pointer(row,fields.validUntil))===Date.parse(promotion.validUntil);
  } catch {checks.hotdealOriginalSourceVerified=false;}
  try {
    const shipping=product.shippingQuote,proof=shipping.evidence;
    const original=(await read(proof.evidenceFile,proof.sha256)).toString('utf8');
    const candidates=[original];try{candidates.push(...jsonStrings(JSON.parse(original)));}catch{}
    checks.hotdealShippingOriginalVerified=candidates.some(value=>text(value).includes(text(proof.excerpt)));
  } catch {checks.hotdealShippingOriginalVerified=false;}
  return finish(checks);
}
