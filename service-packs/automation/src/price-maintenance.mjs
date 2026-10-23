import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {requestPartners} from './partners-transport.mjs';

function key(p){
 const ids=['productId','itemId','vendorItemId'].map(k=>String(p[k]??''));
 if(ids.some(id=>!/^\d+$/.test(id)))throw Error('Exact offer identifiers required');
 return ids.join(':');
}
export function inspectOffer(expected,products){
 const variantKey=key(expected);
 const matches=products.filter(p=>['productId','itemId','vendorItemId'].every(k=>String(p[k])===String(expected[k])));
 if(!matches.length)return {variantKey,status:'not_observed',stock:'unknown',action:'verify-exact-offer',reason:'Search absence is not evidence of delisting or sold-out stock'};
 const values=new Set(matches.map(p=>JSON.stringify([p.salesPrice,p.isSoldOut])));
 if(values.size!==1)return {variantKey,status:'conflicting_observations',action:'verify-exact-offer'};
 const p=matches[0];
 if(!Number.isFinite(p.salesPrice)||p.salesPrice<=0)return {variantKey,status:'invalid_price',action:'verify-exact-offer'};
 const baseline=expected.baseline;
 if(!baseline||!Number.isFinite(baseline.displayedAmount)||!baseline.checkedAt||!baseline.evidenceRef)throw Error('Observed displayed-price baseline required');
 const delta=p.salesPrice-baseline.displayedAmount;
 return {variantKey,status:p.isSoldOut===true?'reported_sold_out':delta!==0?'displayed_price_changed':'displayed_price_unchanged',
  displayedAmount:p.salesPrice,currency:'KRW',baseline,delta,
  stock:p.isSoldOut===true?'reported_sold_out':p.isSoldOut===false?'not_reported_sold_out':'unknown',
  deliveredAmount:null,action:p.isSoldOut===true||delta!==0?'verify-destination-and-update-content':'retain-dated-observation'};
}
export async function searchOffers(filter,env=process.env,{fetchImpl=globalThis.fetch}={}){
 if(!env.COUPANG_COOKIE||!env.COUPANG_X_TOKEN)throw Object.assign(Error('Credentials unavailable'),{code:'credentials_unavailable'});
 const {response,raw}=await requestPartners('/api/v1/search',{method:'POST',cookie:env.COUPANG_COOKIE,xToken:env.COUPANG_X_TOKEN,body:{filter,page:{pageNumber:0,size:36},deliveryTypes:[]},referer:'https://partners.coupang.com/',fetchImpl});
 if(response.status!==200)throw Object.assign(Error('Search transport rejected'),{code:'http_failure',httpStatus:response.status});
 if(!response.headers.get('content-type')?.includes('json'))throw Object.assign(Error('Unexpected content'),{code:'schema_failure'});
 const d=JSON.parse(raw);
 if(d.rCode!=='0'||!Array.isArray(d.data?.products)||typeof d.data.total!=='number')throw Object.assign(Error('Search rejected or schema changed'),{code:'application_or_schema_failure'});
 return {products:d.data.products,total:d.data.total,responseHash:createHash('sha256').update(raw).digest('hex'),httpStatus:response.status};
}
export async function collectPrices(expected,directory,{search=searchOffers,now=()=>new Date(),uuid=randomUUID}={}){
 if(!Array.isArray(expected.offers)||!expected.offers.length)throw Error('Expected offers required');
 for(const offer of expected.offers){key(offer);if(typeof offer.query!=='string'||!offer.query.trim())throw Error('Search query required');}
 const receipt={postUrl:expected.postUrl,checkedAt:now().toISOString(),status:'collected',results:[],requests:[],
  limitations:['First-page search observation is not exhaustive inventory','Shipping, conditional discounts and final destination require separate verification','No public content is changed by this check']};
 const cache=new Map();
 for(const offer of expected.offers){
  try{
   if(!cache.has(offer.query)){
    const result=await search(offer.query);cache.set(offer.query,result);
    receipt.requests.push({query:offer.query,httpStatus:result.httpStatus,responseHash:result.responseHash,resultCount:result.products.length,total:result.total});
   }
   receipt.results.push(inspectOffer(offer,cache.get(offer.query).products));
  }catch(e){
   receipt.status='blocked';receipt.failure={code:e.code??e.name,httpStatus:e.httpStatus??null,cause:'unverified',variantKey:key(offer)};
   break; // A failed shared transport must not trigger one retry per product.
  }
 }
 receipt.remainingOffers=expected.offers.slice(receipt.results.length).map(key);
 receipt.reviewRequired=receipt.results.some(r=>r.status!=='displayed_price_unchanged');
 await mkdir(directory,{recursive:true});const file=join(directory,'price-maintenance-'+uuid()+'.json');
 await writeFile(file,JSON.stringify(receipt,null,2),{flag:'wx'});return {file,...receipt};
}
