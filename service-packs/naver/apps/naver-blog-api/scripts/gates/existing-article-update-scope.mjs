// Existing posts requested for editorial revision. This only extends target
// dispatch; every format's evidence, ownership, rendering and write gates remain.
export const EXISTING_ARTICLE_UPDATES=Object.freeze({
 '224419004923':Object.freeze({blogId:'aicandoanything',existingLogNo:'224419004923',format:'ai_research_article',topicKey:'jev-judgment-workflow-20260921',categoryId:12}),
 '224419034040':Object.freeze({blogId:'aicandoanything',existingLogNo:'224419034040',format:'ai_research_article',topicKey:'jev-applications-20260921',categoryId:12}),
 '224421338326':Object.freeze({blogId:'aicandoanything',existingLogNo:'224421338326',format:'ai_research_article',topicKey:'gpt6-sol-luna-vs-opus55-20260923',categoryId:12}),
 '224418980453':Object.freeze({blogId:'aicandoanything',existingLogNo:'224418980453',format:'hotel_promotion',productId:'seoul_shilla_202609',categoryId:10}),
 '224418864957':Object.freeze({blogId:'aicandoanything',existingLogNo:'224418864957',format:'hotel_promotion',productId:'iclub_202609',categoryId:10}),
 '224419069353':Object.freeze({blogId:'aicandoanything',existingLogNo:'224419069353',format:'single_offer_hotdeal',productId:'7447842898',variantId:'19382112694-73436003598-245ml-30cans',categoryId:11}),
 '224417064414':Object.freeze({blogId:'aicandoanything',existingLogNo:'224417064414',format:'single_offer_hotdeal',productId:'6888281723',variantId:'25978979167-83715729697-ctype-white',categoryId:1}),
});
export function existingArticleUpdateScope(job){
 const s=EXISTING_ARTICLE_UPDATES[job?.target?.logNo],b=job?.publicationBundle;
 return s&&job.target.type==='update'&&job.blogId===s.blogId&&b?.document?.blogId===s.blogId&&b.document.logNo===s.existingLogNo&&b.format===s.format&&
  job.inputProvider==='independent_http'&&job.executionMode==='independent_http'&&
  (!s.topicKey||b.research?.topicKey===s.topicKey)&&(!s.productId||job.commercialSnapshot?.productId===s.productId)&&
  (!s.variantId||job.commercialSnapshot?.variantId===s.variantId)?s:null;
}
export const isExistingAiUpdate=job=>existingArticleUpdateScope(job)?.format==='ai_research_article';
