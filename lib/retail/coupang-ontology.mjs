import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw Object.assign(new Error(),{code:'COUPANG_ONTOLOGY_INPUT_INVALID'})};

/** Evidence-bound travel-price source records. This does not write an ontology database. */
export function projectCoupangTravel(run) {
  if(run?.schema!=='web-api-coupang-public-result-v1'||run.ok!==true||run.executionMode!=='pure_http'
    ||run.browserUsed!==false||run.credentialsUsed!==false||run.writesSubmitted!==0
    ||run.request?.origin!=='https://trip.coupang.com'||run.request.httpStatus!==200
    ||run.request.cookieSent!==false||run.projectionSha256!==sha(run.data))fail();
  const evidenceId=`http:${sha({request:run.request,data:run.data,checkedAt:run.checkedAt})}`;
  const result={schema:'web-api-coupang-travel-projection-v1',sourceId:'coupang-travel',targetVertical:'travel-price',
    networkUsed:false,databaseWrites:0,completeCatalog:false,checkedAt:run.checkedAt,
    evidence:{id:evidenceId,request:run.request,projectionSha256:run.projectionSha256},
    offerings:[],priceObservations:[],options:[],reviews:[]};
  const price=(offeringId,p,context,optionId=null)=>{
    if(p?.salePrice===null||p?.salePrice===undefined)return;
    if(!Number.isSafeInteger(p.salePrice)||p.salePrice<0||p.currency!=='KRW'||p.accountApplied!==false)fail();
    result.priceObservations.push({sellerId:'coupang-travel',offeringId,optionId,currency:'KRW',
      displayedAmount:p.salePrice,originalAmount:p.originalPrice,conditionalDiscountAmount:p.discountPrice,
      discountedSaleAmount:p.discountedSalePrice,totalSalesAmount:p.totalSalesPrice,
      totalDiscountedAmount:p.totalDiscountedPrice,unitPeriod:p.unitPeriod,priceLabel:p.description,
      membershipCondition:p.membershipCondition,accountAppliedPriceVerified:false,checkoutTotalVerified:false,
      queryContext:context??null,evidenceRef:evidenceId});
  };
  const offering=(productId,title,productType,packageId=null,url=null)=>{
    const offeringId=`coupang-travel:${productId}`;
    if(!result.offerings.some(x=>x.id===offeringId))result.offerings.push({id:offeringId,sellerId:'coupang-travel',
      sellerProductId:productId,packageProductId:packageId,title,productType,canonicalUrl:url,evidenceRef:evidenceId});
    return offeringId;
  };
  const d=run.data;
  if(d.kind==='travel_listing')for(const p of d.products){
    const key=offering(p.productId,p.title,p.productType,p.packageProductId,p.productUrl);
    price(key,p.price,d.query?.lodging??d.query?.rentalCar??d.context??null);
  }
  else if(d.kind==='travel_detail'){
    const key=offering(d.productId,d.name,d.productType,d.packageProductId,d.sourceUrl);
    if(d.representativeOption)result.options.push({...d.representativeOption,offeringId:key,optionId:d.representativeOption.vendorItemId,evidenceRef:evidenceId});
    price(key,d.price,d.context??null,d.representativeOption?.vendorItemId??null);
  }else if(d.kind==='travel_rooms'){
    const key=offering(d.productId,null,'ACCOMMODATION');
    for(const room of d.rooms)for(const rate of room.rates){
      const optionId=`${room.vendorItemId}:${rate.rateCategoryId??'basic'}`;
      result.options.push({offeringId:key,optionId,vendorItemId:room.vendorItemId,itemId:room.itemId,name:room.name,
        conditions:rate.conditions,numberOfGuests:rate.numberOfGuests,isSoldOut:rate.isSoldOut,evidenceRef:evidenceId});
      price(key,rate.price,d.context,optionId);
    }
  }else if(d.kind==='travel_ticket_options'){
    const key=offering(d.productId,null,'TICKET');
    for(const item of d.options)for(const v of item.vendorItems){
      result.options.push({offeringId:key,optionId:v.vendorItemId,travelItemId:item.travelItemId,name:v.name,
        validFrom:item.validFrom,validTo:item.validTo,stockCount:v.stockCount,evidenceRef:evidenceId});
      price(key,v.price,{validFrom:item.validFrom,validTo:item.validTo},v.vendorItemId);
    }
  }else if(d.kind==='travel_reviews')result.reviews=d.reviews.map(r=>({...r,offeringId:`coupang-travel:${r.productId}`,evidenceRef:evidenceId}));
  else fail();
  return result;
}
