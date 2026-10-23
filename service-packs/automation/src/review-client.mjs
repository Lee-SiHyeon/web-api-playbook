import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(String(s)).digest('hex');

export async function fetchReviewSample({productId,mode='evidence',sample='best',page=1},{cookie=process.env.COUPANG_REVIEW_COOKIE,fetchImpl=globalThis.fetch,now=()=>new Date()}={}){
 const samples={best:{sortBy:'ORDER_SCORE_ASC',ratings:''},latest:{sortBy:'DATE_DESC',ratings:''},critical:{sortBy:'DATE_DESC',ratings:'1'}};
 if(!samples[sample])throw Error('Unknown observed sample');
 if(!Number.isInteger(page)||page<1||page>2||(page===2&&sample!=='best'))throw Error('Unobserved pagination combination');
 if(!/^\d+$/.test(String(productId)))throw Error('Numeric productId required');
 if(!['evidence','synthesis-input'].includes(mode))throw Error('Unknown mode');
 if(!cookie)throw Error('Current authorized review cookie required');
 // Page 2 best-sort is the only observed continuation; other pagination remains unverified.
 const url=new URL('https://www.coupang.com/next-api/review');
 url.search=new URLSearchParams({productId:String(productId),page:String(page),size:'10',...samples[sample],ratingSummary:'true',market:''});
 const r=await fetchImpl(url,{headers:{cookie,accept:'application/json',referer:'https://www.coupang.com/vp/products/'+productId},redirect:'manual',signal:AbortSignal.timeout(20000)});
 const raw=await r.text();if(r.status!==200||!r.headers.get('content-type')?.includes('json'))throw Error('Transport/authentication failure: HTTP '+r.status);
 const d=JSON.parse(raw),p=d.rData?.paging;
 if(d.rCode!=='RET0000'||!Array.isArray(p?.contents))throw Error('Review service/schema failure');
 const reviews=p.contents.map(x=>({reviewKey:hash(productId+':'+x.reviewId),productId:x.productId,itemId:x.itemId,vendorItemId:x.vendorItemId,variant:x.itemName,rating:x.rating,vine:x.vine,incentive:x.incentive,contentHash:hash(x.content||''),...(mode==='synthesis-input'?{text:x.content,title:x.title}:{} )}));
 if(sample==='critical'&&reviews.some(x=>x.rating!==1))throw Error('Rating filter response mismatch');
 return {operation:page===1?'reviewsFirstPage':'reviewsPage',page,sample,httpStatus:r.status,applicationStatus:d.rCode,verified:true,checkedAt:now().toISOString(),sourceUrl:url.href,responseHash:hash(raw),reviewCount:reviews.length,sampleWarning:'Bounded stratified sample; not representative; variants may differ',reviews};
}
