import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reactThreads, decodeThreadsReactionPost, buildThreadsReactionVariables } from '../threads-reactions.mjs';

const postId = '3996994421430736442';
const input = { operation: 'like', postId, expectedAuthor: 'some_person', execute: true };
function context() {
  return { service: 'threads', createdAt: Date.now(), requestCount: 0, url: 'https://www.threads.com/@some_person',
    documentReceipt: { ownerVerified: true },
    bundle: { service: 'threads', owner: 'lifehack__ailab', ownerId: '17824859444', origin: 'https://www.threads.com',
      cookies: [{ name: 'csrftoken', value: 'fake-csrf', domain: 'threads.com', path: '/', secure: true }] },
    sources: new Map([['DTSGUtils', { source: 'SprinkleConfig .charCodeAt(' }],
      ['useTHLikeMutation', { source: 'requestData:{ nav_chain:t==null?void 0:t.nav_chain' }],
      ['useTHLikeMutationLikeMutation.threads.graphql', { source: 'id:"27990590487282317" name:"requestData"' }]]),
    document: { modules: new Map([
      ['DTSGInitialData', { token: 'test-dtsg' }], ['LSD', { token: 'test-lsd' }],
      ['SprinkleConfig', { param_name: 'jazoest', version: 2, should_randomize: false }],
      ['SiteData', { haste_session: 'h', pr: 1, client_revision: 2, hsi: 3, comet_env: 1, __spin_r: 4, __spin_b: 'trunk', __spin_t: 4 }],
      ['RelayAPIConfigDefaults', { actorID: '17824859444', customHeaders: { 'x-ig-app-id': 'test-app' } }],
      ['CurrentUserInitialData', { USER_ID: '0' }],
    ]) } };
}
function payload(liked = false) {
  return { data: { media: { pk: postId, code: 'Dd4LT_SmNY6', user: { username: 'some_person' }, has_liked: liked,
    text_post_app_info: { share_info: { is_reposted_by_viewer: false } } } } };
}
const sessionLock = async (_, fn) => fn();

test('rejects mismatched target and unavailable reaction state', () => {
  assert.throws(() => decodeThreadsReactionPost(payload(), postId, 'other_person'), /THREADS_REACTION_POST_MISMATCH/);
  const missing = payload(); delete missing.data.media.has_liked;
  assert.throws(() => decodeThreadsReactionPost(missing, postId), /THREADS_REACTION_POST_MISMATCH/);
  assert.deepEqual(buildThreadsReactionVariables(context(), 'like', postId), { mediaID: postId, requestData: {} });
  const changed = context(); changed.sources.clear();
  assert.throws(() => buildThreadsReactionVariables(changed, 'like', postId), /THREADS_LIKE_SOURCE_CHANGED/);
  for (const operation of ['toString', '__proto__', 'constructor']) {
    assert.throws(() => buildThreadsReactionVariables(context(), operation, postId), /THREADS_REACTION_INPUT/);
  }
});
test('a changed stable author ID blocks a reaction before journal reservation or mutation', async () => {
  let mutations = 0;
  const response = payload(); response.data.media.user.pk = '99999';
  await assert.rejects(reactThreads({ ...input, expectedActorId: '12345' }, {
    sessionLock, contextLoader: async () => context(), querySender: async (_, request) => {
      if (request.body.get('fb_api_req_friendly_name') !== 'BarcelonaPostPageTargetQuery') mutations++;
      return { payload: response };
    },
  }), { code: 'THREADS_REACTION_POST_MISMATCH' });
  assert.equal(mutations, 0);
});

test('ambiguous mutation leaves a durable reservation and blocks a second send', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-reaction-test-'));
  let writes = 0;
  const deps = { journalRoot, sessionLock, contextLoader: async () => context(), querySender: async (_, r) => {
    if (r.body.get('fb_api_req_friendly_name') === 'useTHLikeMutationLikeMutation') { writes++; throw new Error('timeout'); }
    return { payload: payload() };
  } };
  const result = await reactThreads(input, deps);
  assert.equal(result.status, 'needs_reconciliation'); assert.equal(writes, 1);
  const stored = JSON.parse(await readFile(result.journalPath, 'utf8'));
  assert.equal(stored.writes, 1);
  assert.equal(JSON.stringify(stored).includes('test-dtsg'), false);
  await assert.rejects(reactThreads(input, deps), /THREADS_REACTION_RECONCILE_FIRST/);
  assert.equal(writes, 1);
});

test('fresh readback reconciles an ambiguous successful send without resending', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-reaction-test-'));
  let liked = false, writes = 0, loads = 0;
  const deps = { journalRoot, sessionLock, contextLoader: async () => { loads++; return context(); }, querySender: async (_, r) => {
    if (r.body.get('fb_api_req_friendly_name') === 'useTHLikeMutationLikeMutation') { liked = true; writes++; throw new Error('timeout'); }
    return { payload: payload(liked) };
  } };
  const result = await reactThreads(input, deps);
  assert.equal(result.readbackVerified, true); assert.equal(result.live_replay, false); assert.equal(loads, 2);
  const repeat = await reactThreads(input, deps);
  assert.equal(repeat.noOp, true); assert.equal(writes, 1);
  const reconciled = await reactThreads({ ...input, execute: false, reconcile: true }, deps);
  assert.equal(reconciled.success, true); assert.equal(writes, 1);
  assert.equal(reconciled.live_replay, false);
});

test('probe never sends a mutation and rejects self target', async () => {
  const deps = { sessionLock, contextLoader: async () => context(), querySender: async (_, r) => {
    assert.equal(r.body.get('fb_api_req_friendly_name'), 'BarcelonaPostPageTargetQuery');
    return { payload: payload() };
  } };
  const result = await reactThreads({ ...input, execute: false }, deps);
  assert.equal(result.writes, 0); assert.equal(result.live_replay, false);
  assert.equal(result.credential_propagated, false); assert.equal(result.readCredentialPropagated, true);
  await assert.rejects(reactThreads({ ...input, expectedAuthor: 'lifehack__ailab' }, deps), /THREADS_REACTION_SELF_TARGET/);
});

test('a full readback budget blocks mutation before any action journal is reserved',async()=>{
  const journalRoot=await mkdtemp(path.join(os.tmpdir(),'threads-reaction-capacity-'));
  let mutations=0;
  const deps={journalRoot,sessionLock,contextLoader:async()=>context(),reserveReadback:async()=>{
    throw Object.assign(new Error('local wait'),{code:'THREADS_READ_BUDGET_WAIT',retryAt:Date.now()+3600000,
      dispatchStarted:false,writeSent:false,receipt:{localBudget:true}});
  },querySender:async(_,request)=>{
    if(request.body.get('fb_api_req_friendly_name')==='useTHLikeMutationLikeMutation')mutations++;
    return {payload:payload(mutations>0)};
  }};
  await assert.rejects(reactThreads(input,deps),{code:'THREADS_READ_BUDGET_WAIT'});
  assert.equal(mutations,0);
  const {readdir}=await import('node:fs/promises');
  assert.deepEqual(await readdir(journalRoot),[]);
});

test('a switched authenticated owner cannot supply positive readback for the original owner',async()=>{
 const journalRoot=await mkdtemp(path.join(os.tmpdir(),'threads-reaction-owner-'));
 let loads=0,writes=0,reads=0;
 const reservation={id:'local-readback-ticket'};
 const result=await reactThreads(input,{journalRoot,sessionLock,
  reserveReadback:async scope=>{assert.equal(scope.ownerId,'17824859444');assert.equal(scope.postId,postId);return reservation;},
  contextLoader:async(_service,_handle,options)=>{
   const value=context();
   if(++loads===2){assert.equal(options.readBudgetReservation,reservation);value.bundle.ownerId='17824859445';}
   return value;
  },querySender:async(_,request)=>{
   if(request.body.get('fb_api_req_friendly_name')==='useTHLikeMutationLikeMutation'){writes++;return {payload:{}};}
   reads++;return {payload:payload(writes>0)};
  }});
 assert.equal(writes,1);assert.equal(reads,1,'mismatched owner is rejected before readback dispatch');
 assert.equal(result.status,'needs_reconciliation');assert.equal(result.readbackVerified,false);
 assert.equal(result.code,'THREADS_REACTION_OWNER_MISMATCH');
 assert.equal(JSON.parse(await readFile(result.journalPath,'utf8')).writes,1);
});

test('a stop during protected preflight is checked immediately before dispatch and safely resumes only zero sends', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-reaction-stop-test-'));
  let stop = false, liked = false, writes = 0;
  const deps = { journalRoot, sessionLock, contextLoader: async () => context(),
    beforeWrite: async () => !stop,
    querySender: async (_, request) => {
      if (request.body.get('fb_api_req_friendly_name') === 'useTHLikeMutationLikeMutation') {
        writes++; liked = true; return { receipt: { httpStatus: 200 }, payload: {} };
      }
      stop = true; return { payload: payload(liked) };
    } };
  const stopped = await reactThreads(input, deps);
  assert.equal(stopped.writes, 0); assert.equal(stopped.notSentVerified, true);
  assert.equal(writes, 0);
  const reconciled = await reactThreads({ ...input, execute: false, reconcile: true }, deps);
  assert.equal(reconciled.status, 'not_sent'); assert.equal(reconciled.notSentVerified, true);
  assert.equal(writes, 0);
  const resumed = await reactThreads(input, { ...deps, beforeWrite: async () => true });
  assert.equal(resumed.readbackVerified, true); assert.equal(writes, 1);
  const repeat = await reactThreads(input, deps);
  assert.equal(repeat.noOp, true); assert.equal(writes, 1);
});

test('an existing desired state cannot erase a rejected mutation from the action journal', async () => {
  for (const httpStatus of [400, 429]) {
    const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-reaction-rejected-test-'));
    let liked = false, writes = 0;
    const deps = { journalRoot, sessionLock, contextLoader: async () => context(), querySender: async (_, request) => {
      if (request.body.get('fb_api_req_friendly_name') === 'useTHLikeMutationLikeMutation') {
        writes++; liked = true;
        throw Object.assign(new Error('protected provider response'), { code: 'META_GRAPHQL_REJECTED', httpStatus, retryAfterSeconds: 30 });
      }
      return { payload: payload(liked) };
    } };
    const original = await reactThreads(input, deps);
    assert.equal(original.success, true); assert.equal(original.httpStatus, httpStatus);
    const noOp = await reactThreads(input, deps);
    assert.equal(noOp.noOp, true); assert.equal(noOp.priorWriteHttpStatus, httpStatus);
    for (let index = 0; index < 2; index++) {
      const result = await reactThreads({ ...input, execute: false, reconcile: true }, deps);
      assert.equal(result.priorWriteHttpStatus, httpStatus);
      assert.equal(result.priorFailureCheckedAt, original.checkedAt);
      assert.equal(result.retryAfterSeconds, 30);
    }
    assert.equal(writes, 1);
  }
});

test('reconciliation preserves one bounded original receipt across positive and negative rereads', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-reaction-history-'));
  const journalPath = path.join(journalRoot, `17824859444-like-${postId}.json`);
  const original = {
    owner: 'lifehack__ailab', operation: 'like', postId, target: 'some_person',
    status: 'needs_reconciliation', code: 'THREADS_READ_BUDGET_WAIT',
    checkedAt: '2026-10-05T02:03:04.000Z',
    currentState: { id: postId, author: 'some_person', liked: false, reposted: false },
    writes: 1, dispatchStarted: true, writeSent: true,
    dispatchConfirmed: true, credential_propagated: true,
  };
  await mkdir(journalRoot, { recursive: true });
  await writeFile(journalPath, JSON.stringify(original) + '\n', { mode: 0o600 });

  let liked = true, mutations = 0;
  const deps = { journalRoot, sessionLock, contextLoader: async () => context(), querySender: async (_, request) => {
    if (request.body.get('fb_api_req_friendly_name') === 'useTHLikeMutationLikeMutation') mutations++;
    return { payload: payload(liked) };
  } };
  const expectedOriginal = {
    owner: original.owner, operation: original.operation, postId: original.postId, target: original.target,
    status: original.status, code: original.code, checkedAt: original.checkedAt,
    currentState: original.currentState, writes: original.writes,
    dispatchStarted: original.dispatchStarted, writeSent: original.writeSent,
    dispatchConfirmed: original.dispatchConfirmed, credential_propagated: original.credential_propagated,
    httpStatus: null, priorWriteHttpStatus: null, priorWriteCode: null, priorFailureCheckedAt: null,
    retryAfterSeconds: null, rateLimitReset: null,
  };
  const expectedHistory = { schemaVersion: 1, entries: [expectedOriginal] };

  const positive = await reactThreads({ ...input, execute: false, reconcile: true }, deps);
  assert.equal(positive.success, true);
  assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')).reconciliationHistory, expectedHistory);

  const firstHistory = JSON.parse(await readFile(journalPath, 'utf8')).reconciliationHistory;
  liked = false;
  const negative = await reactThreads({ ...input, execute: false, reconcile: true }, deps);
  assert.equal(negative.success, false);
  assert.deepEqual(JSON.parse(await readFile(journalPath, 'utf8')).reconciliationHistory, firstHistory,
    'a repeated negative read must not nest or grow the archived original');
  assert.equal(mutations, 0);
});

test('reconciliation fails closed on malformed journal history without replacing it', async () => {
  const journalRoot = await mkdtemp(path.join(os.tmpdir(), 'threads-reaction-history-invalid-'));
  const journalPath = path.join(journalRoot, `17824859444-like-${postId}.json`);
  const original = {
    owner: 'lifehack__ailab', operation: 'like', postId, target: 'some_person',
    status: 'needs_reconciliation', writes: 1, dispatchConfirmed: true,
    currentState: { id: postId, author: 'some_person', liked: false, reposted: false },
    reconciliationHistory: { schemaVersion: 1, original: { writes: 2 } },
  };
  await mkdir(journalRoot, { recursive: true });
  const raw = JSON.stringify(original) + '\n';
  await writeFile(journalPath, raw, { mode: 0o600 });
  let mutations = 0;
  const deps = { journalRoot, sessionLock, contextLoader: async () => context(), querySender: async (_, request) => {
    if (request.body.get('fb_api_req_friendly_name') === 'useTHLikeMutationLikeMutation') mutations++;
    return { payload: payload(true) };
  } };

  await assert.rejects(reactThreads({ ...input, execute: false, reconcile: true }, deps),
    { code: 'THREADS_REACTION_JOURNAL_HISTORY_INVALID' });
  assert.equal(await readFile(journalPath, 'utf8'), raw);
  assert.equal(mutations, 0);
});
