import {text} from './publication-document.mjs';
import {travelPlanningLayoutChecks} from './travel-planning-contract.mjs';
import {hotelPromotionLayoutChecks} from './hotel-promotion-contract.mjs';
import {aiResearchLayoutChecks} from './ai-research-article-contract.mjs';
import {singleOfferHotdealLayoutChecks} from './single-offer-hotdeal-contract.mjs';
import {marketAnalysisLayoutChecks} from './market-analysis-article-contract.mjs';

// The single-product review criteria already existed in the reference study.
// Resolve them from the article format, never from optional job minimums.
export const singleProductLayout = Object.freeze({
  id:'naver-single-product-v1',
  source:'research/naver-blog-reference-analysis-2026-09-19.md',
  minImages:8,minQuotationHeadings:4,maxTextBetweenImages:900,
});

export function referenceLayoutChecks(bundle) {
  if(bundle?.format==='ai_research_article'&&bundle.gatePlan){
    const media=(bundle.document?.blocks||[]).filter(b=>['image','video'].includes(b.type));
    const images=media.filter(b=>b.type==='image'),videos=media.filter(b=>b.type==='video');
    const checks={referenceFormatKnown:true,...aiResearchLayoutChecks(bundle)};
    for(const device of ['desktop','mobile']){
      const review=bundle.renderReviews?.[device];
      checks[device+'DynamicMediaRendered']=review?.imageCount===images.length&&
        (videos.length===0||review?.videoCount===videos.length&&review?.presentationChecks?.nativeVideos===true)&&
        (images.length===0||review?.presentationChecks?.imagesLoaded===true);
    }
    return checks;
  }
  if(!['tested_single_product','comparison','travel_itinerary','hotel_promotion','ai_research_article','single_offer_hotdeal','market_analysis_article'].includes(bundle?.format)) return {referenceFormatKnown:false};
  const blocks=bundle.document?.blocks||[],profile=singleProductLayout;
  const images=blocks.map((block,index)=>({block,index})).filter(({block})=>block.type==='image');
  // Every supported commerce format needs actual images, even when a caller
  // omits image minimums. A nonempty comparison is only the baseline; its brief
  // and native render review still decide whether the images are sufficient.
  const common={
    referenceFormatKnown:true,
    referenceImageFloor:images.length>=(bundle.format==='tested_single_product'?profile.minImages:1),
    referenceImagePurpose:images.length>0&&images.every(({block})=>text(block.purpose).length>=4)&&new Set(images.map(({block})=>text(block.purpose))).size===images.length,
    referenceImageAttribution:images.every(({block,index})=>block.rights?.basis!=='product_listing'||text(block.rights.attribution).length>0&&blocks[index+1]?.type==='paragraph'&&text(blocks[index+1].text).includes(text(block.rights.attribution))),
    generatedImageCaption:images.every(({block,index})=>block.rights?.basis!=='generated'||blocks[index+1]?.type==='paragraph'&&/AI.*(?:생성|제작|만든)|인공지능.*(?:생성|제작)/i.test(text(blocks[index+1].text))),
  };
  for(const device of ['desktop','mobile']){
    const review=bundle.renderReviews?.[device];
    common[`${device}ReferenceImagesRendered`]=review?.imageCount===images.length&&images.length>0&&review?.presentationChecks?.imagesLoaded===true;
  }
  if(bundle.format==='ai_research_article')return {...common,...aiResearchLayoutChecks(bundle)};
  if(bundle.format==='market_analysis_article')return {...common,...marketAnalysisLayoutChecks(bundle)};
  if(bundle.format==='single_offer_hotdeal')return {...common,...singleOfferHotdealLayoutChecks(bundle)};
  if(bundle.format==='comparison')return common;
  if(bundle.format==='travel_itinerary')return {...common,...travelPlanningLayoutChecks(bundle)};
  if(bundle.format==='hotel_promotion')return {...common,...hotelPromotionLayoutChecks(bundle)};
  const headings=blocks.map((block,index)=>({block,index})).filter(({block})=>block.type==='heading');
  let run=0,maxRun=0;
  for(const block of blocks){if(block.type==='image')run=0;else if(['paragraph','quote'].includes(block.type)){run+=text(block.text).length;maxRun=Math.max(maxRun,run);}}
  const checks={
    ...common,
    referenceProfileApplied:bundle.layoutReference?.id===profile.id,
    referenceQuotationHeadings:headings.length>=profile.minQuotationHeadings&&headings.every(({block})=>block.presentation==='quotation'),
    referenceDisclosurePanel:blocks[0]?.type==='notice'&&blocks[0].presentation==='panel',
    referenceLeadImage:images.length>0&&headings.length>0&&images[0].index<headings[0].index,
    referenceSectionImages:headings.length>0&&headings.every(({index},i)=>images.some(image=>image.index>index&&image.index<(headings[i+1]?.index??blocks.length))),
    referenceTextImageRhythm:maxRun<=profile.maxTextBetweenImages,
  };
  for(const device of ['desktop','mobile']){
    const review=bundle.renderReviews?.[device];
    checks[`${device}ReferenceDisclosurePanel`]=review?.presentationChecks?.disclosurePanel===true;
  }
  return checks;
}
