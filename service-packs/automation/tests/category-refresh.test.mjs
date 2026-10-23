import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {refreshCategories} from '../src/category-refresh.mjs';
import {categoryFrontier} from '../src/category-frontier.mjs';
test('refresh failure preserves checkpoint; concurrent refresh cannot take lock',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'category-refresh-'));
 const file=join(dir,'frontier.json');
 try{
  const tree=categoryFrontier({data:{gnb:{shoppingComponent:[{linkUri:'/np/categories/1'}]}}});
  tree.nodes[0].state='blocked_http';tree.nodes[0].cursor=2;
  const original=JSON.stringify(tree);await writeFile(file,original);
  await assert.rejects(refreshCategories(file,async()=>{throw Error('HTTP 403');}),/403/);
  assert.equal(await readFile(file,'utf8'),original);
  let release,started;const entered=new Promise(r=>started=r);
  const running=refreshCategories(file,async()=>{started();await new Promise(r=>release=r);return tree;});
  await entered;
  try{await assert.rejects(refreshCategories(file,async()=>tree),{code:'EEXIST'});}finally{release();}
  await running;
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.nodes[0].state,'blocked_http');assert.equal(saved.nodes[0].cursor,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
