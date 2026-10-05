import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(args,input)=>spawnSync(process.execPath,['scripts/commerce.mjs',...args],{cwd:root,input,encoding:'utf8',timeout:10000});

test('service-bound credential packets reject a different service before any client is constructed',()=>{
  const token='fixture-sensitive-token';
  const result=run(['aliexpress-partner','search','--query=charger','--credentials-stdin'],JSON.stringify({provider:'impact',authToken:token}));
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'COMMERCE_CREDENTIAL_SERVICE_MISMATCH');
  assert.equal(result.stdout.includes(token),false);
});

test('unrelated login/password fields cannot become API credentials or reach the output',()=>{
  const password='fixture-sensitive-password';
  const result=run(['aliexpress-partner','search','--query=charger','--credentials-stdin'],JSON.stringify({provider:'aliexpress-partner',username:'fixture',password}));
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'COMMERCE_CREDENTIAL_FIELDS_INVALID');
  assert.equal(result.stdout.includes(password),false);
});

test('missing private API credentials report the exact unresolved boundary without network calls',()=>{
  const result=run(['amazon-partner','search','--query=charger']);
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'COMMERCE_CREDENTIALS_REQUIRED');
});

test('the registry never exposes credential fields as available anonymous APIs',()=>{
  const result=run(['providers']);assert.equal(result.status,0);
  const data=JSON.parse(result.stdout);assert.equal(data.networkUsed,false);
  assert.equal(data.providers['amazon-partner'].readiness,'credentialed_live_pending');
  assert.equal(data.providers.awin.readiness,'feed_row_envelope_unconfirmed');
});

test('ranking rejects a search query instead of silently returning another collection',()=>{
  const result=run(['oliveyoung-public','ranking','--query=cream']);
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'COMMERCE_RANKING_ARGUMENT_INVALID');
});

test('ranking-only category IDs cannot silently become ordinary search inputs',()=>{
  const result=run(['oliveyoung-public','search','--query=cream','--category-id=10000010001']);
  assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'COMMERCE_JOB_INVALID');
});
