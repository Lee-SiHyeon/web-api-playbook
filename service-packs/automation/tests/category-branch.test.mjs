import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve,sep}from'node:path';
import{traverseBranch}from'../src/category-branch.mjs';
import{decodeSubcategories}from'../src/category-client.mjs';
test('malformed response cannot leave partial children in a resumable checkpoint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'category-atomic-')),file=join(dir,'state.json');
 try{
  const seed={linkcodes:100,component:1};let calls=0;
  const coverage=await traverseBranch(file,seed,async()=>{calls++;return {children:[{id:2,linkCode:'200',hasChild:true},{id:'invalid',linkCode:'300',hasChild:true}]};},{intervalMs:0});
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(coverage.blocked,1);assert.equal(saved.nodes.length,1);assert.deepEqual(saved.edges,[]);
  await traverseBranch(file,seed,async()=>{calls++;throw Error('Invalid child must never be queued');},{intervalMs:0});
  assert.equal(calls,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('branch resumes budgets, preserves shared edges and distinguishes component from category',async()=>{
 const root=await mkdtemp(join(tmpdir(),'category-branch-'));assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
 try{
  const file=join(root,'state.json'),seed={linkcodes:100,component:1},calls=[];
  const fetch=async({component})=>{calls.push(component);return {children:component==='1'?[{id:2,linkCode:'200',name:'child',hasChild:true}]:[],responseHash:'observed'};};
  const first=await traverseBranch(file,seed,fetch,{budget:1});assert.equal(first.pending,1);
  const second=await traverseBranch(file,seed,fetch);assert.equal(second.navigationBranchExhausted,true);assert.equal(second.wholeSiteComplete,false);
  assert.deepEqual(calls,['1','2']);const state=JSON.parse(await readFile(file,'utf8'));assert.equal(state.nodes[1].categoryId,'200');assert.equal(state.edges.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('observed omitted leaf flag avoids spurious expansion and context fallback stops sibling requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'category-fallback-')),file=join(dir,'state.json');let calls=0;
 const leaf=decodeSubcategories({children:[{id:2,linkCode:'200',linkUri:'/np/categories/200',name:'leaf'}]});
 const first=await traverseBranch(file,{linkcodes:100,component:1},async()=>{calls++;return {children:leaf,responseHash:'leaf'};});
 assert.equal(calls,1);assert.equal(first.navigationBranchExhausted,true);assert.equal(first.listingTraversalVerified,false);
 const secondFile=join(dir,'fallback.json');calls=0;
 const result=await traverseBranch(secondFile,{linkcodes:100,component:1},async({component})=>{calls++;return {children:component==='1'?[{id:2,linkCode:'200',hasChild:true},{id:3,linkCode:'300',hasChild:true}]:[{id:99,linkCode:'100',hasChild:true}],responseHash:'response'};},{intervalMs:0});
 assert.equal(calls,2);assert.equal(result.blocked,1);assert.equal(result.pending,1);assert.equal(result.edges,2);
});
