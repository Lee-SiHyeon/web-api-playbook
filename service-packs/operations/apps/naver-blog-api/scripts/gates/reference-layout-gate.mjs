import {text} from './publication-document.mjs';

// The single-product review criteria already existed in the reference study.
// Resolve them from the article format, never from optional job minimums.
export const singleProductLayout = Object.freeze({
  id:'naver-single-product-v1',
  source:'research/naver-blog-reference-analysis-2026-09-19.md',
  minImages:8,minQuotationHeadings:4,maxTextBetweenImages:900,
});

export function referenceLayoutChecks(bundle) {
  if(bundle?.format !== 'tested_single_product') return {referenceFormatKnown:bundle?.format==='comparison'};
  const blocks=bundle.document?.blocks||[],profile=singleProductLayout;
  const images=blocks.map((block,index)=>({block,index})).filter(({block})=>block.type==='image');
  const headings=blocks.map((block,index)=>({block,index})).filter(({block})=>block.type==='heading');
  let run=0,maxRun=0;
  for(const block of blocks){if(block.type==='image')run=0;else if(['paragraph','quote'].includes(block.type)){run+=text(block.text).length;maxRun=Math.max(maxRun,run);}}
  const checks={
    referenceFormatKnown:true,
    referenceProfileApplied:bundle.layoutReference?.id===profile.id,
    referenceImageFloor:images.length>=profile.minImages,
    referenceQuotationHeadings:headings.length>=profile.minQuotationHeadings&&headings.every(({block})=>block.presentation==='quotation'),
    referenceDisclosurePanel:blocks[0]?.type==='notice'&&blocks[0].presentation==='panel',
    referenceLeadImage:images.length>0&&headings.length>0&&images[0].index<headings[0].index,
    referenceSectionImages:headings.length>0&&headings.every(({index},i)=>images.some(image=>image.index>index&&image.index<(headings[i+1]?.index??blocks.length))),
    referenceTextImageRhythm:maxRun<=profile.maxTextBetweenImages,
    referenceImagePurpose:images.length>0&&images.every(({block})=>text(block.purpose).length>=4)&&new Set(images.map(({block})=>block.purpose)).size===images.length,
    referenceImageAttribution:images.every(({block,index})=>block.rights?.basis!=='product_listing'||blocks[index+1]?.type==='paragraph'&&text(blocks[index+1].text).includes(text(block.rights.attribution))),
  };
  for(const device of ['desktop','mobile']){
    const review=bundle.renderReviews?.[device];
    checks[`${device}ReferenceImagesRendered`]=review?.imageCount===images.length&&images.length>0&&review?.presentationChecks?.imagesLoaded===true;
    checks[`${device}ReferenceDisclosurePanel`]=review?.presentationChecks?.disclosurePanel===true;
  }
  return checks;
}
