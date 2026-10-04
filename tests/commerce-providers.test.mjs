import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommerceReader } from '../lib/commerce/providers.mjs';
import { collectOfferSnapshot } from '../lib/commerce/snapshots.mjs';
const receipt = { method:'GET',origin:'https://fixture.example',path:'/products',httpStatus:200,mime:'application/json',browserUsed:false,credentialsUsed:true };
const quote = id => ({ productId:id,title:'Product '+id,price:{amount:'10.00',currency:'USD',kind:'retail_current'},url:null,availability:'unknown' });

test('eBay pagination keeps a fixed request limit when the final storage budget is smaller', async () => {
  const calls=[];
  const loadPage=await createCommerceReader({provider:'ebay-partner',args:{query:'charger',pageSize:20},credentials:{accessToken:'fixture-only-token'},
    factories:{'ebay-partner':()=>({searchItems:async input=>{
      calls.push(input);
      return {items:Array.from({length:20},(_,i)=>({itemId:String(input.offset+i),title:'Charger',itemWebUrl:null,price:{amount:'10.00',currency:'USD',kind:'retail_current'}})),
        marketplaceId:'EBAY_US',pagination:{total:100,limit:20,offset:input.offset,nextOffset:input.offset+20},receipt};
    }})}});
  const result=await collectOfferSnapshot({provider:'ebay-partner',loadPage,maxOffers:35});
  assert.deepEqual(calls.map(c=>[c.offset,c.limit]),[[0,20],[20,20]]);
  assert.equal(result.offers.length,35);assert.equal(result.collection.capHit,true);
  assert.equal(result.offers[0].context.marketplace,'EBAY_US');
});

test('Impact possible continuation is followed while unpriced records remain explicit', async () => {
  const calls=[];
  const loadPage=await createCommerceReader({provider:'impact',args:{query:'shirt',pageSize:2},credentials:{accountSid:'fixture-sid',authToken:'fixture-token'},
    factories:{impact:()=>({searchProducts:async({page})=>{
      calls.push(page);
      return {items:page===1?[quote('1'),{...quote('2'),price:{amount:null,currency:null,kind:'unknown'}}]:[],
        page:{page,pageSize:2,hasMore:page===1?'possible':'unknown'},receipt};
    }})}});
  const result=await collectOfferSnapshot({provider:'impact',loadPage,maxOffers:10});
  assert.deepEqual(calls,[1,2]);assert.equal(result.offers.length,1);
  assert.equal(result.collection.priceUnavailableCount,1);assert.equal(result.collection.complete,false);
});

test('Printful production-price pages bind region/currency/technique and compute offsets', async () => {
  const calls=[];
  const loadPage=await createCommerceReader({provider:'printful-api',args:{id:'1',region:'europe',currency:'GBP',productionCurrency:'EUR',pageSize:20},credentials:{accessToken:'fixture-token'},
    factories:{'printful-api':()=>({getProduct:async()=>({product:{title:'Shirt'}}),getProductPrices:async input=>{
      calls.push(input);
      return {prices:{variants:Array.from({length:input.offset===0?20:1},(_,i)=>({variantId:input.offset+i+1,techniques:[{technique:'dtg',price:{amount:'12.00',currency:'GBP'}}]}))},
        pagination:{offset:input.offset,limit:20,total:21},receipt};
    }})}});
  const result=await collectOfferSnapshot({provider:'printful-api',loadPage,maxOffers:21});
  assert.deepEqual(calls.map(c=>c.offset),[0,20]);assert.ok(calls.every(c=>c.limit===20&&c.sellingRegionName==='europe'&&c.productionCurrency==='EUR'));
  assert.equal(result.offers.length,21);assert.equal(result.offers[0].context.technique,'dtg');
  assert.equal(result.offers[0].context.productionCurrency,'EUR');assert.equal(result.collection.complete,true);
});

test('CJ detail retains individual variant prices and does not infer wholesale units or stock', async () => {
  const loadPage=await createCommerceReader({provider:'cjdropshipping',args:{id:'product-1'},credentials:{accessToken:'fixture-token'},
    factories:{cjdropshipping:()=>({getProductDetail:async()=>({product:{productId:'product-1',title:'Shirt',variants:[
      {productId:'product-1',variantId:'variant-a',title:'Large',price:{raw:'3.50',currency:'USD'}},
      {productId:'product-1',variantId:'variant-b',title:'Small',price:{raw:'3.00-4.00',currency:'USD'}},
    ]},receipt})})}});
  const result=await collectOfferSnapshot({provider:'cjdropshipping',loadPage});
  assert.deepEqual(result.offers.map(v=>v.variantId),['variant-a','variant-b']);
  assert.equal(result.offers[0].price.kind,'supplier_catalog');assert.equal(result.offers[0].availability,'unknown');
  assert.equal(result.offers[1].price,null);assert.equal(result.offers[1].priceRange.max.amount,'4.00');
  await assert.rejects(createCommerceReader({provider:'cjdropshipping',args:{id:'p',country:'US'},credentials:{accessToken:'fixture-token'}}),{code:'COMMERCE_DESTINATION_UNSUPPORTED_FOR_DETAIL'});
});

test('Amazon partial pages remain partial snapshots, and first returned quote is not called a minimum', async () => {
  const loadPage=await createCommerceReader({provider:'amazon-partner',args:{query:'shirt'},credentials:{credentialId:'fixture-id'},
    factories:{'amazon-partner':()=>({searchItems:async()=>({items:[{asin:'B123456789',title:'Shirt',url:null,offers:[{currentPrice:{amount:'20.00',currency:'USD'}},{currentPrice:{amount:'10.00',currency:'USD'}}]}],
      totalResultCount:1,partial:true,receipt})})}});
  const result=await collectOfferSnapshot({provider:'amazon-partner',loadPage});
  assert.equal(result.offers[0].price.amount,'20.00');assert.equal(result.collection.partialResponses,1);
  assert.equal(result.collection.complete,false);
});
