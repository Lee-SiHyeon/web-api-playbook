import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCategoryTree,fetchSubcategories} from '../src/category-client.mjs';

const response=(body,{status=200,type='application/json'}={})=>({status,headers:new Headers({'content-type':type}),text:async()=>JSON.stringify(body)});

test('category root preserves observed endpoint, cookie header, response hash and bounded coverage',async()=>{
 let call;
 const result=await fetchCategoryTree('synthetic-cookie',{now:()=>12345,checkedAt:()=>new Date('2026-10-01T00:00:00Z'),fetchImpl:async(url,options)=>{call={url:new URL(url),options};return response({data:{gnb:{shoppingComponent:[{name:'root',linkUri:'/np/categories/100'}]}}});}});
 assert.equal(call.url.origin,'https://www.coupang.com');assert.equal(call.url.pathname,'/n-api/web-adapter/category-list');assert.equal(call.url.searchParams.get('_'),'12345');
 assert.equal(call.options.headers.cookie,'synthetic-cookie');assert.equal(call.options.redirect,'manual');
 assert.equal(result.coverage,'observed-navigation-tree-not-entire-inventory');assert.equal(result.nodes[0].categoryId,'100');assert.match(result.responseHash,/^[a-f0-9]{64}$/);
});

test('lazy category request keeps all observed selectors and explicit omitted-hint semantics',async()=>{
 let call;
 const result=await fetchSubcategories({linkcodes:100,component:200},'synthetic-cookie',{now:()=>new Date('2026-10-01T00:00:00Z'),fetchImpl:async(url,options)=>{call={url:new URL(url),options};return response({children:[{id:201,linkCode:'301',linkUri:'/np/categories/301',name:'Leaf'}]});}});
 assert.deepEqual([...call.url.searchParams.entries()],[['linkcodes','100'],['channel','user'],['isPriceRange','false'],['rocketAll','false'],['isGoogleLanding','false'],['component','200']]);
 assert.equal(call.options.headers.cookie,'synthetic-cookie');assert.equal(call.options.headers.accept,'application/json');
 assert.equal(result.children[0].hasChild,false);assert.equal(result.children[0].hasChildEvidence,'omitted-ui-no-expansion');assert.equal(result.inventoryComplete,false);
});

test('category HTTP failures and unsupported inline traversal stop before returning partial results',async()=>{
 let calls=0;
 await assert.rejects(fetchCategoryTree('cookie',{fetchImpl:async()=>{calls++;return response({}, {status:403});}}),/Category transport failure: HTTP 403/);
 await assert.rejects(fetchSubcategories({linkcodes:1,component:2},'cookie',{fetchImpl:async()=>{calls++;return response({children:[{id:3,linkCode:4,linkUri:'/np/categories/4',name:'p',hasChild:true,children:[{}]}]});}}),/Inline subcategory traversal requires contract extension/);
 await assert.rejects(fetchSubcategories({linkcodes:'x',component:2},'cookie',{fetchImpl:async()=>{calls++;return response({});}}),/numeric category selectors/);
 assert.equal(calls,2);
});
