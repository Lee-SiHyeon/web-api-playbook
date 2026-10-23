import test from 'node:test';
import assert from 'node:assert/strict';
import {categoryFrontier,mergeCategoryFrontier,mergeLazyCategories} from '../src/category-frontier.mjs';
test('lazy branches absent from global navigation survive repeated refreshes',()=>{
 const fresh=()=>categoryFrontier({data:{gnb:{shoppingComponent:[{name:'root',linkUri:'/np/categories/100'}]}}});
 const receipt={httpStatus:200,responseHash:'observed',url:'https://www.coupang.com/n-api/first-sub-category?linkcodes=100&component=200',children:[{id:201,linkCode:'301',linkUri:'/np/categories/301',name:'leaf',hasChild:false}]};
 const merged=mergeLazyCategories(fresh(),receipt,{url:'/np/categories/300',name:'parent',observedParentUrl:'/np/categories/100'});
 const once=mergeCategoryFrontier(merged,fresh()),twice=mergeCategoryFrontier(once,fresh());
 assert.equal(twice.nodes.find(n=>n.categoryId==='301').state,'pending');
 const edge=twice.edges.find(e=>e.type==='lazy-category-child');
 assert.equal(edge.componentId,201);assert.ok(edge.child.endsWith('/301'));
 assert.equal(twice.supplementalEdges.length,2);assert.equal(once.edges.length,twice.edges.length);
});
const leaf=(id)=>({name:String(id),linkUri:'/np/categories/'+id});
test('selected request context is not inferred as the navigation parent',()=>{
 const fresh=categoryFrontier({data:{gnb:{shoppingComponent:[leaf(520056),leaf(520059)]}}});
 const receipt={httpStatus:200,responseHash:'observed',url:'https://www.coupang.com/n-api/first-sub-category?linkcodes=520059&page=3&component=519979',children:[{id:519980,linkCode:'520080',linkUri:'/np/categories/520080',name:'specialized',hasChild:true}]};
 const parent={url:'/np/categories/520079',name:'fridge',observedParentUrl:'/np/categories/520056'};
 assert.throws(()=>mergeLazyCategories(fresh,receipt,{url:parent.url}),/Observed navigation parent required/);
 const merged=mergeLazyCategories(fresh,receipt,parent);
 assert.ok(merged.edges.some(e=>e.parent.endsWith('/520056')&&e.child.endsWith('/520079')));
 assert.ok(!merged.edges.some(e=>e.parent.endsWith('/520059')&&e.child.endsWith('/520079')));
 assert.equal(merged.edges.find(e=>e.type==='lazy-category-child').requestContext,'520059');
 assert.equal(fresh.nodes.length,2);
});
test('retains descendants of noncategory containers and additional observed menu groups',()=>{
 const result=categoryFrontier({data:{gnb:{shoppingComponent:[{name:'container',visibleChildren:[leaf(1)]},{linkUri:'https://example.com/?token=secret',visibleChildren:[leaf(2)]}],giftCardComponent:[leaf(3),leaf(1)],extraTopMenusComponentIds:[1,2]}}});
 assert.deepEqual(result.nodes.map(n=>n.categoryId),['3','1','2']);
 assert.equal(result.containers.length,2);
 assert.equal(result.edges.filter(e=>e.child==='https://www.coupang.com/np/categories/1').length,2);
 assert.ok(!JSON.stringify(result).includes('secret'));
 const keys=new Set([result.root,...result.nodes.map(n=>n.url),...result.containers.map(n=>n.key)]);
 assert.ok(result.edges.every(e=>keys.has(e.parent)&&keys.has(e.child)));
});
test('refresh retains checkpoints and removed nodes without silently completing them',()=>{
 const old=categoryFrontier({data:{gnb:{shoppingComponent:[leaf(1),leaf(2)]}}});
 Object.assign(old.nodes[0],{state:'blocked_http',attempts:1,cursor:2,evidenceRefs:['receipt']});
 const fresh=categoryFrontier({data:{gnb:{shoppingComponent:[leaf(1),leaf(3)]}}});
 const merged=mergeCategoryFrontier(old,fresh);
 assert.equal(merged.nodes[0].state,'blocked_http');
 assert.equal(merged.nodes[0].cursor,2);
 assert.deepEqual(merged.nodes[0].evidenceRefs,['receipt']);
 assert.equal(merged.nodes.find(n=>n.categoryId==='2').navigationPresent,false);
 assert.equal(merged.nodes.find(n=>n.categoryId==='3').state,'pending');
});
