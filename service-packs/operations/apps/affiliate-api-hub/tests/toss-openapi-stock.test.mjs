import test from 'node:test';
import assert from 'node:assert/strict';
import {createTossOpenApi} from '../adapters/toss-openapi.mjs';

test('Toss API mapping preserves explicit in-stock, sold-out and unknown stock separately',async()=>{
  const store={read:()=>JSON.stringify({accessKey:'fixture',secretKey:'fixture',memberLinkId:'fixture',token:'fixture',tokenExpiresAt:'2040-01-01T00:00:00Z'})};
  const api=createTossOpenApi({store,fetchImpl:async()=>new Response(JSON.stringify({resultType:'SUCCESS',success:{items:[
    {tacaItemId:1,displayName:'상품 A',displayPrice:10000,isSoldOut:false},
    {tacaItemId:2,displayName:'상품 B',displayPrice:10000,isSoldOut:true},
    {tacaItemId:3,displayName:'상품 C',displayPrice:10000}
  ]}}),{status:200})});
  const result=await api.detail(['1','2','3']);
  assert.deepEqual(result.items.map(i=>i.soldOut),[false,true,null]);
});

test('a missing upstream pagination flag remains unknown rather than marking a list exhausted',async()=>{
  const store={read:()=>JSON.stringify({accessKey:'fixture',secretKey:'fixture',memberLinkId:'fixture',token:'fixture',tokenExpiresAt:'2040-01-01T00:00:00Z'})};
  for(const [flag,expected] of [[true,true],[false,false],[undefined,null],['false',null]]){
    const api=createTossOpenApi({store,fetchImpl:async()=>new Response(JSON.stringify({resultType:'SUCCESS',success:{items:[],hasNext:flag}}),{status:200})});
    assert.equal((await api.todayDeals()).hasNext,expected);
  }
});
