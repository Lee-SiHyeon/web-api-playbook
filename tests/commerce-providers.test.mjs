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

test('Shopee raw price strings and null currency retain range and follow the actual page number',async()=>{
  const calls=[];
  const loadPage=await createCommerceReader({provider:'shopee-id',args:{query:'shoes'},credentials:{appId:'fixture-id',appSecret:'fixture-secret'},
    factories:{'shopee-id':()=>({searchProducts:async input=>{
      calls.push(input.page);return{products:[{itemId:String(input.page),title:'Shoes',url:'https://shopee.co.id/product/1/'+input.page,
        price:{amount:'15000',currency:null},priceRange:{min:'10000',max:'15000'}}],pageInfo:{page:null,hasNextPage:input.page===1},
        request:{...receipt,credentialsUsed:true}};
    }})}});
  const result=await collectOfferSnapshot({provider:'shopee-id',loadPage,maxPages:3});
  assert.deepEqual(calls,[1,2]);assert.equal(result.offers[0].price.amount,'15000');
  assert.equal(result.offers[0].priceRange.min.amount,'10000');assert.equal(result.collection.currencyUnverifiedCount,2);
  assert.equal(result.collection.complete,false);assert.equal(result.receipts[0].credentialsUsed,true);
});

test('Rakuten Advertising keeps retailer list and reported sale quotes distinct without inferred URL',async()=>{
  const loadPage=await createCommerceReader({provider:'rakuten-advertising',args:{query:'lipstick',merchantId:'123'},credentials:{accessToken:'fixture-token'},
    factories:{'rakuten-advertising':()=>({searchProducts:async input=>{
      assert.equal(input.keyword,'lipstick');assert.equal(input.advertiserMid,'123');
      return{items:[{productId:'123:456',variantId:'SKU',title:'Lipstick',canonicalURL:null,affiliateURL:'https://tracking.example/click?pub=owned',
        price:{amount:'30.00',currency:'USD',kind:'retail_list'},salePrice:{amount:'25.00',currency:'USD'},source:{advertiserId:'123'}}],
        pagination:{page:1,pageSize:20,totalPages:1,conservativeResultCap:1000},receipt};
    }})}});
  const result=await collectOfferSnapshot({provider:'rakuten-advertising',loadPage});
  assert.deepEqual(result.offers.map(o=>o.price.kind),['retail_list','reported_sale']);
  assert.equal(result.offers[0].url,null);assert.equal(result.offers[0].affiliateLink.attributionVerified,false);
});

test('Sephora product-level ranges do not pretend to be a selected-SKU scalar quote',async()=>{
  const loadPage=await createCommerceReader({provider:'sephora',args:{query:'lipstick'},factories:{sephora:()=>({searchProducts:async()=>({
    page:1,pageSize:20,totalProducts:1,products:[{productId:'P1234',variantId:'123456',brandName:'Brand',productName:'Lipstick',price:null,
      priceScope:'product_range',productUrl:'https://www.sephora.com/product/item-P1234',priceRange:{min:{amount:'20.00',currency:'USD'},max:{amount:'25.00',currency:'USD'}}}],receipt,
  })})}});
  const result=await collectOfferSnapshot({provider:'sephora',loadPage});
  assert.equal(result.offers[0].variantId,null);assert.equal(result.offers[0].price,null);
  assert.equal(result.offers[0].priceRange.min.kind,'retail_list');assert.equal(result.offers[0].context.priceBasis,'product_range');
});

test('Ulta traverses upstream pages without discarding sponsored cards through a local result cap',async()=>{
  const inputs=[];
  const loadPage=await createCommerceReader({provider:'ulta',args:{query:'lipstick',pageSize:20},factories:{ulta:()=>({searchProducts:async input=>{
    inputs.push(input);
    return{page:input.page,pageCount:2,pageSize:64,products:Array.from({length:input.page===1?74:64},(_,i)=>({
      productId:String(input.page*1000+i),variantId:String(input.page*1000+i),brandName:'Brand',productName:'Lipstick',productUrl:null,
      price:{amount:'25.00',currency:'USD',kind:'retail_sale'},salePrice:{minAmount:'25.00',maxAmount:'25.00',currency:'USD'},
    })),receipt};
  }})}});
  const result=await collectOfferSnapshot({provider:'ulta',loadPage,maxOffers:500});
  assert.deepEqual(inputs.map(i=>[i.page,i.pageSize]),[[1,100],[2,100]]);assert.equal(result.offers.length,138);
  assert.equal(result.offers[0].price.kind,'retail_current');assert.equal(result.collection.complete,false);
});

test('Amazon public search keeps explicit KRW major units and never infers USD from the host or dollar symbol', async () => {
  const loadPage = await createCommerceReader({ provider: 'amazon-public', args: { query: 'charger' }, factories: {
    'amazon-public': () => ({ searchProducts: async ({ page }) => ({ page, items: [
      { asin: 'B012345678', title: 'Charger', productUrl: 'https://www.amazon.com/dp/B012345678',
        currentDisplayPrice: { displayText: 'KRW 20,011', amount: '20011', currencyCode: 'KRW' } },
      { asin: 'B012345679', title: 'Other charger', productUrl: 'https://www.amazon.com/dp/B012345679',
        currentDisplayPrice: { displayText: '$10.00', amount: '10.00', currencyCode: null } },
    ], receipt }) }),
  } });
  const result = await collectOfferSnapshot({ provider: 'amazon-public', loadPage, maxPages: 1 });
  assert.deepEqual(result.offers.map(offer => [offer.price.amount, offer.price.currency]), [['20011', 'KRW'], ['10.00', null]]);
  assert.equal(result.offers[0].context.priceBasis, 'displayed_search_card');
  assert.equal(result.collection.complete, false); assert.equal(result.collection.currencyUnverifiedCount, 1);
});

test('Olive Young price collection binds USD to the actual market context and preserves variant and price kinds', async () => {
  const product = { id: 'GA1', name: 'Mask', url: 'https://global.oliveyoung.com/product/detail?prdtNo=GA1',
    price: { amount: '13.50', currency: 'USD' }, listPrice: { amount: '27.00', currency: 'USD' },
    options: [{ variantId: 'sku-1', name: 'Green', price: { amount: '14.00', currency: 'USD' } }], marketContext: { currencyVerified: true } };
  const factory = { 'oliveyoung-global': () => ({ getProduct: async () => ({ product, receipt }),
    getBestSellers: async () => ({ products: [product], marketContext: { currencyVerified: true }, receipt }) }) };
  const loadPage = await createCommerceReader({ provider: 'oliveyoung-global', args: { id: 'GA1' }, factories: factory });
  const result = await collectOfferSnapshot({ provider: 'oliveyoung-global', loadPage });
  assert.deepEqual(result.offers.map(row => [row.variantId, row.price.kind, row.price.amount]),
    [[null, 'retail_current', '13.50'], [null, 'retail_list', '27.00'], ['sku-1', 'retail_current', '14.00']]);
  const browse = await createCommerceReader({ provider: 'oliveyoung-global', factories: factory });
  assert.equal((await collectOfferSnapshot({ provider: 'oliveyoung-global', loadPage: browse })).collection.complete, false);
  const unbound = await createCommerceReader({ provider: 'oliveyoung-global', args: { id: 'GA1' }, factories: {
    'oliveyoung-global': () => ({ getProduct: async () => ({ product: { ...product, marketContext: { currencyVerified: false } } }) }) } });
  await assert.rejects(unbound(), { code: 'OLIVEYOUNG_GLOBAL_CURRENCY_CONTEXT_UNVERIFIED' });
});
