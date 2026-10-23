import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeGflowSpec, createSingleSubmit, generationRequestIdentity, generateWithGflow } from '../src/gflow-adapter.mjs';
import { findUnresolvedJournal, loadJournal } from '../src/journal.mjs';

const PROJECT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REQUEST = '11111111-2222-3333-4444-555555555555';
const options = { prompt: 'Slow camera push in.', projectId: PROJECT, outputPath: 'fixture.mp4', confirmGeneration: true };

test('backend requires confirmation and rejects unobserved audio contracts before writing', () => {
  assert.throws(() => normalizeGflowSpec({...options,confirmGeneration:false}), {code:'GENERATION_CONFIRMATION_REQUIRED'});
  assert.throws(() => normalizeGflowSpec({...options,audio:'on'}), {code:'FLOW_AUDIO_CONTRACT_UNVERIFIED'});
  assert.throws(() => normalizeGflowSpec({...options,extend:REQUEST,startFrame:'frame.jpg'}), {code:'FLOW_GFLOW_EXTEND_OPTIONS_INVALID'});
  const normalized = normalizeGflowSpec({...options,aspect:'9:16',duration:8,startFrame:'frame.jpg',endFrame:'end.jpg',character:['Fixture Character']});
  assert.equal(normalized.aspect,'9:16'); assert.equal(normalized.duration,8); assert.equal(path.isAbsolute(normalized.startFrame),true);
});

test('a failed or uncertain generation click cannot be clicked again', async () => {
  let intents=0, clicks=0;
  const submit = createSingleSubmit(async()=>{intents++;});
  await assert.rejects(submit(async()=>{clicks++;throw new Error('fixture-timeout');}));
  await assert.rejects(submit(async()=>{clicks++;}),{code:'FLOW_GFLOW_DUPLICATE_SUBMIT_BLOCKED'});
  assert.equal(intents,1); assert.equal(clicks,1);
});

test('captured request identity is scoped to the active project and ignores credentials', () => {
  const form = project => new URLSearchParams({'f.req':JSON.stringify([[['YhhmEf',JSON.stringify([[],[null,22,null,null,null,project],[REQUEST,2]]),null,'generic']]]),at:'fixture-secret'}).toString();
  assert.deepEqual(generationRequestIdentity(form(PROJECT),PROJECT),{requestId:REQUEST});
  assert.equal(generationRequestIdentity(form(REQUEST),PROJECT),null);
  assert.equal(generationRequestIdentity('binary-fixture',PROJECT),null);
});

test('unknown gflow outcome keeps the shared project fence and blocks the next submit', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'flow-gflow-'));
  const client={async assertActiveProject(){},async prepareOutputPath(p){return p;}};
  let submits=0;
  const runImpl=async (_spec,{beforeSubmit,onIdentity})=>{await beforeSubmit();submits++;await onIdentity({requestId:REQUEST});throw new Error('fixture-private-url');};
  try {
    await assert.rejects(generateWithGflow(client,options,{runImpl,jobDir:dir}),e=>e.code==='FLOW_GFLOW_OUTCOME_UNCERTAIN'&&e.generationSubmitAttempts===1);
    const pending=await findUnresolvedJournal(PROJECT,undefined,{jobDir:dir});
    assert.equal(pending.state,'needs_reconciliation'); assert.equal(pending.inputMode,'gflow_browser'); assert.equal(pending.requestId,REQUEST);
    assert.equal((await loadJournal(pending.jobPath)).backend,'gflow');
    await assert.rejects(generateWithGflow(client,options,{runImpl,jobDir:dir}),{code:'FLOW_GENERATION_FENCE_BUSY'});
    assert.equal(submits,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('preflight failure does not reserve a generation journal or submit', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'flow-gflow-'));
  try {
    await assert.rejects(generateWithGflow({async assertActiveProject(){},async prepareOutputPath(p){return p;}},options,
      {jobDir:dir,runImpl:async()=>{throw Object.assign(new Error(),{code:'FLOW_PROFILE_NOT_DEBUGGABLE'});}}),{code:'FLOW_PROFILE_NOT_DEBUGGABLE'});
    assert.equal(await findUnresolvedJournal(PROJECT,undefined,{jobDir:dir}),undefined);
  } finally {await rm(dir,{recursive:true,force:true});}
});
