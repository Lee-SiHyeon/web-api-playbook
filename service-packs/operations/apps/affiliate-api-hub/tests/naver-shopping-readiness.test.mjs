import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probePartnerEnvelope } from '../adapters/partner-account-probes.mjs';
import { evaluateShoppingReadiness } from '../adapters/naver-shopping-readiness.mjs';

const now = Date.now();
const cookies = ['NID_AUT', 'NID_SES'].map(name => ({name, value:'synthetic-secret', domain:'.naver.com', path:'/', expires:-1}));
const body = () => ({ loginId:'fixture', accountId:123, creator:true, partner:false, groupAccount:false,
  activeSpaceIds:[], spaces:[], space:null, existsWaitingSpace:null });
async function probe(changes = {}) {
  return probePartnerEnvelope({schemaVersion:1, acquiredAt:new Date(now).toISOString(),
    services:{brandconnect:{cookies,expectedLoginId:'fixture'}}},
  {now:()=>now, fetchImpl:async()=>Response.json({...body(),...changes})});
}
const evaluate = value => evaluateShoppingReadiness(value, {now:Date.now()});

test('creator=true and an assigned account do not imply an active shopping space', async () => {
  const result = await probe();
  assert.equal(result.services.brandconnect.authenticated, true);
  assert.deepEqual(result.services.brandconnect.spaceStatus, {observed:true,activeSpaceCount:0,spaceCount:0,selectedSpaceAssigned:false,waitingSpace:null});
  const readiness = evaluate(result);
  assert.equal(readiness.status, 'blocked_space_setup');
  assert.equal(readiness.stages.accountRead, 'verified');
  assert.equal(readiness.readyForScopedDiscovery, false);
  assert.equal(readiness.commercialOperationsEnabled, false);
});

test('older schemas stay unknown and waiting spaces remain blocked', async () => {
  const legacy = await probe({activeSpaceIds:undefined,spaces:undefined,space:undefined});
  assert.equal(evaluate(legacy).status, 'space_state_unverified');
  const waiting = await probe({existsWaitingSpace:true});
  assert.equal(evaluate(waiting).status, 'blocked_space_pending');
});

test('an active space only enables scoped discovery, not terms, links, or publishing', async () => {
  const result = await probe({activeSpaceIds:[987], spaces:[{id:987,name:'synthetic-private-space'}],space:{id:987}});
  const readiness = evaluate(result);
  assert.equal(readiness.status, 'ready_for_scoped_discovery');
  assert.equal(readiness.stages.affiliateTerms, 'unverified');
  assert.equal(readiness.stages.linkIssue, 'unverified');
  assert.equal(readiness.publishingEnabled, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture|synthetic|987/);
});

test('stale or future receipts cannot carry old readiness into a new run', async () => {
  const result = await probe();
  for (const age of [300001,-1]) {
    result.services.brandconnect.checkedAt = new Date(now-age).toISOString();
    assert.equal(evaluateShoppingReadiness(result,{now}).status, 'fresh_account_probe_required');
  }
});

test('wrong account, missing entitlement, another endpoint and browser-only proof remain blocked', async () => {
  assert.equal(evaluate(await probe({loginId:'other'})).status, 'account_probe_required');
  assert.equal(evaluate(await probe({creator:false})).status, 'blocked_creator_access');
  for (const changes of [{path:'/unobserved'},{browserUsed:true},{credentialPropagated:false},{httpStatus:403}]) {
    const result = await probe();
    Object.assign(result.services.brandconnect,changes);
    assert.equal(evaluate(result).status, 'account_probe_required');
  }
});

test('readiness CLI consumes a sanitized probe and exits blocked without echoing input', async () => {
  const result = await probe();
  result.syntheticUnused = 'synthetic-private-extra';
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/naver-shopping-readiness.mjs',import.meta.url))],
    {input:JSON.stringify(result),encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(child.status,2);
  assert.equal(JSON.parse(child.stdout).status,'blocked_space_setup');
  assert.doesNotMatch(child.stdout,/synthetic-private-extra/);
});
