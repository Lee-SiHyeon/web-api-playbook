import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const scripts=['affiliate-link','category-branch','category-tree','daily-report','intake-poll','measurements','partners','price-check','publication-health','reviews'];

test('pack help and every CLI --help exit without credentials or stdin',()=>{
 const env={PATH:process.env.PATH??''};
 const catalog=spawnSync(process.execPath,[join(root,'scripts/help.mjs')],{cwd:root,env,encoding:'utf8'});
 assert.equal(catalog.status,0,catalog.stderr);assert.match(catalog.stdout,/no credentials or network access/i);
 for(const script of scripts){
  const result=spawnSync(process.execPath,[join(root,'scripts',script+'.mjs'),'--help'],{cwd:root,env,input:'',encoding:'utf8'});
  assert.equal(result.status,0,`${script}: ${result.stderr}`);assert.match(result.stdout,/Usage:/,script);
 }
});
