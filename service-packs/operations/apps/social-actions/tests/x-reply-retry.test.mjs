import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { processTarget, processBenefitStageSafely } from '../x-followback-bot.mjs';
import { rewardStage, baseRetryLimit, baseRetryWaiting } from '../x-rewards.mjs';
import { emptyCreateResult, reconcileReplyByReadback } from '../x-reply-reconcile.mjs';
import { reactPair } from '../x-reactions.mjs';
import { beginJournalIntent, unresolvedJournalFiles } from '../../affiliate-api-hub/scripts/sns/writers/journal.mjs';

const user = { id: '123', handle: 'target' };
const plan = { primary: { id: '100', text: 'Pinned introduction', format: { lang: 'en' } }, additional: [] };
const emptyCreate = () => Object.assign(new Error('X_CREATE_SCHEMA'), { code: 'X_CREATE_SCHEMA', receipt: { httpStatus: 200, writeSent: true },
  detail: { dataType: 'object', createType: 'object', resultType: 'undefined', dataKeys: ['create_tweet'], createKeys: ['tweet_results'], resultKeys: [], errorCount: 0, type: null } });
const baseDeps = (over = {}) => ({ contextComment: 'A clear introduction makes it easier to connect.', saveState: async () => {}, isStopped: async () => false,
  withReactionsContext: async work => work({}), wait: async () => {}, readbackDelayMs: 0,
  followAction: async () => ({ readbackVerified: true, writeSent: true, currentState: { following: true } }),
  pairedReaction: async () => ({ like: { readbackVerified: true, writes: 1 }, repost: { readbackVerified: true, writes: 1 } }), ...over });
function ownerAbsenceProof({parentId,text,intentAt,proofCheckedAt}){
  const cutoffAt=new Date(Date.parse(intentAt)-60_000).toISOString();
  return {type:'reconciled',outcome:'not_created_owner_timeline_proof',ownerId:'1',parentId,
    contentSha256:createHash('sha256').update(text).digest('hex'),intentAt,pagesRead:1,
    rangeStartAt:new Date(Date.parse(proofCheckedAt)-1000).toISOString(),
    rangeEndAt:new Date(Date.parse(cutoffAt)-1000).toISOString(),cutoffAt,coverageComplete:true,
    reachedCutoff:true,endReached:false,ownerTimelineReplyCount:0,parentDetailVerified:true,
    parentDetailReplyCount:0,proofCheckedAt};
}

test('only the id-less empty CreateTweet body counts as an empty create result', () => {
  assert.equal(emptyCreateResult(emptyCreate()), true);
  const withErrors = emptyCreate(); withErrors.detail = { ...withErrors.detail, errorCount: 1 };
  assert.equal(emptyCreateResult(withErrors), false);
  assert.equal(emptyCreateResult(Object.assign(new Error(), { code: 'WRITE_UNKNOWN' })), false);
});

test('an empty create with no visible owner reply remains held and never sends twice', async () => {
  const state = { records: {}, relationships: { '123': { handle: 'target', followsMe: true, following: true, checkedAt: new Date().toISOString() } } };
  let sends = 0, readbacks = 0;
  await assert.rejects(processTarget(user, plan, state, baseDeps({ publisher: async () => { sends++; throw emptyCreate(); },
    replyReadback: async () => { readbacks++; return { found: [], reconciled: 0 }; } })),{code:'X_CREATE_SCHEMA'});
  assert.equal(sends, 1); assert.equal(readbacks, 1);
  const record = state.records['123'];
  assert.equal(record.status, 'needs_reconciliation');
  assert.equal(rewardStage(record, false), 'reconciliation');
  state.relationships['123'].checkedAt = new Date().toISOString();
  const calls = [];
  await assert.rejects(processTarget(user, plan, state, baseDeps({ followAction: async () => assert.fail('no second follow'),
    pairedReaction: async () => { calls.push('react'); return { like: { readbackVerified: true, writes: 0 }, repost: { readbackVerified: true, writes: 0 } }; },
    replyReadback: async () => { calls.push('prior-check'); return { found: [], reconciled: 0 }; },
    publisher: async()=>{sends++;assert.fail('no second reply');} })),{code:'X_BOT_ACCOUNT_ALREADY_RECORDED'});
  assert.deepEqual(calls, []);assert.equal(sends,1);assert.equal(record.status,'needs_reconciliation');
});

test('a reply that landed despite the empty body is adopted from the owner readback and never sent twice', async () => {
  const state = { records: {}, relationships: {} };
  let sends = 0;
  await processTarget(user, plan, state, baseDeps({ publisher: async () => { sends++; throw emptyCreate(); },
    replyReadback: async () => ({ found: ['300'], reconciled: 1 }),
    reader: async id => ({ owner: 'owner', tweet: { id, author: 'owner', replyToId: '100', text: state.records['123'].replyText } }) }));
  assert.equal(sends, 1);
  assert.equal(state.records['123'].status, 'verified');
  assert.deepEqual(state.records['123'].results.reply, { ids: ['300'], readbackVerified: true, adoptedByOwnerReadback: true });
});

test('retry attempts are bounded and then fall back to manual reconciliation', async () => {
  const previousProof={type:'reconciled',outcome:'not_created_owner_timeline_proof',ownerId:'1',parentId:'100',contentSha256:'a'.repeat(64),
    intentAt:'2026-09-30T10:00:00.000Z',pagesRead:1,rangeStartAt:'2026-09-30T10:01:00.000Z',rangeEndAt:'2026-09-30T09:58:00.000Z',
    cutoffAt:'2026-09-30T09:59:00.000Z',coverageComplete:true,reachedCutoff:true,endReached:false,ownerTimelineReplyCount:0,
    parentDetailVerified:true,parentDetailReplyCount:0,proofCheckedAt:'2026-09-30T10:00:03.000Z'};
  const state = { records: { '123': { handle: 'target', policyVersion: 3, status: 'retry_wait', pinnedPostId: '100', replyText: 'Saved draft.',
    replyAttemptedAt: new Date().toISOString(),replySendAttempts:2, results: { follow: { readbackVerified: true, following: true }, '100': {} },
    retry: { attempts: baseRetryLimit - 1, reason: 'not_created_owner_timeline_proof',proof:previousProof, after: new Date(Date.now() - 1).toISOString() } } },
    relationships: { '123': { handle: 'target', followsMe: true, following: true, checkedAt: new Date().toISOString() } } };
  await assert.rejects(processTarget(user, plan, state, baseDeps({ followAction: async () => assert.fail('no follow'),
    replyReadback: async () => ({ found: [], reconciled: 0 }), publisher: async () => { assert.fail('no second send'); } })), { code: 'X_BOT_REPLY_RECONCILIATION_REQUIRED' });
  assert.equal(state.records['123'].status, 'needs_reconciliation');
  assert.equal(rewardStage(state.records['123'], false), 'reconciliation');
});

test('a negative owner-history result after an empty 200 leaves the reply held and never resends',async()=>{
  const state={records:{},relationships:{'123':{handle:'target',followsMe:true,following:true,checkedAt:new Date().toISOString()}}};
  let sends=0,checks=0;
  const proof=ownerAbsenceProof({parentId:'100',text:'A clear introduction makes it easier to connect.',
    intentAt:'2026-10-01T10:00:00.000Z',proofCheckedAt:'2026-10-01T10:00:05.000Z'});
  await assert.rejects(processTarget(user,plan,state,baseDeps({
    publisher:async()=>{sends++;throw emptyCreate();},
    replyReadback:async()=>{checks++;return {found:[],reconciled:0,held:true,notCreatedProof:proof};}
  })),{code:'X_CREATE_SCHEMA'});
  const record=state.records['123'];
  assert.equal(record.status,'needs_reconciliation');
  assert.equal(record.replySendAttempts,1);assert.equal(sends,1);assert.equal(checks,1);
  assert.equal(record.retry?.reason,undefined);
  assert.equal(baseRetryWaiting({...record,status:'retry_wait',retry:{attempts:0,after:new Date(Date.now()-1).toISOString(),
    reason:'not_created_owner_timeline_proof',proof}}),false);
  assert.equal(baseRetryWaiting({...record,status:'retry_wait',replyAttemptedAt:undefined,
    retry:{attempts:0,after:new Date(Date.now()-1).toISOString(),reason:'not_created_owner_timeline_proof',proof}}),false);
  assert.equal(baseRetryWaiting({...record,status:'retry_wait',replyAttemptedAt:undefined,replySendAttempts:undefined,
    retry:{attempts:0,after:new Date(Date.now()-1).toISOString(),reason:'not_created_owner_timeline_proof',proof}}),false);
  assert.equal(rewardStage(record,false),'reconciliation');
});

test('an owner readback error after an uncertain create holds the target without retrying',async()=>{
  const state={records:{},relationships:{'123':{handle:'target',followsMe:true,following:true,checkedAt:new Date().toISOString()}}};
  let sends=0,reads=0;
  const readError=Object.freeze(Object.assign(new Error('Owner timeline read timed out'),{
    code:'X_READ_TIMEOUT',receipt:Object.freeze({operation:'UserTweetsAndReplies'})
  }));
  const outcome=await processBenefitStageSafely({...user,stage:'base'},plan,state,baseDeps({
    publisher:async()=>{sends++;throw emptyCreate();},
    replyReadback:async()=>{reads++;throw readError;}
  }));
  const record=state.records['123'];
  assert.equal(outcome.status,'held_for_reconciliation');
  assert.equal(outcome.code,'X_READ_TIMEOUT');
  assert.equal(record.status,'needs_reconciliation');
  assert.equal(record.replySendAttempts,1);
  assert.equal(record.reconciliationHold.retryAllowed,false);
  assert.equal(outcome.error.receipt.replyOutcomeUncertain,true);
  assert.equal(outcome.error.receipt.replyReconciliationReadFailed,true);
  assert.equal(outcome.error.receipt.writeSent,true);
  assert.deepEqual([sends,reads],[1,1]);
});

test('a predispatch journal hold stays held after a frozen read error without claiming a sent write',async()=>{
  const state={records:{},relationships:{'123':{handle:'target',followsMe:true,following:true,checkedAt:new Date().toISOString()}}};
  let publisherCalls=0,reads=0;
  const readError=Object.freeze(Object.assign(new Error('Owner timeline read timed out'),{
    code:'X_READ_TIMEOUT',receipt:Object.freeze({operation:'UserTweetsAndReplies'})
  }));
  const journalError=Object.assign(new Error('journal already held'),{
    code:'SNS_JOURNAL_RECONCILIATION_REQUIRED',receipt:Object.freeze({operation:'CreateTweet',writeSent:false})
  });
  const outcome=await processBenefitStageSafely({...user,stage:'base'},plan,state,baseDeps({
    publisher:async()=>{publisherCalls++;throw journalError;},
    replyReadback:async()=>{reads++;throw readError;}
  }));
  assert.equal(outcome.status,'held_for_reconciliation');
  assert.equal(outcome.code,'X_READ_TIMEOUT');
  assert.equal(state.records['123'].reconciliationHold.retryAllowed,false);
  assert.equal(outcome.error.receipt.writeSent,false);
  assert.equal(outcome.error.receipt.replyOutcomeUncertain,undefined);
  assert.equal(outcome.error.receipt.replyReconciliationReadFailed,true);
  assert.deepEqual([publisherCalls,reads],[1,1]);
});

test('a legacy negative proof in retry_wait becomes a per-target hold before any follow, reaction, read, or send',async()=>{
  const text='Saved draft.',intentAt='2026-10-01T10:00:00.000Z';
  const proof=ownerAbsenceProof({parentId:'100',text,intentAt,proofCheckedAt:'2026-10-01T10:00:05.000Z'});
  const record={handle:'target',policyVersion:3,status:'retry_wait',pinnedPostId:'100',replyText:text,
    results:{follow:{readbackVerified:true,following:true},'100':{}},
    retry:{attempts:0,reason:'not_created_owner_timeline_proof',proof,after:new Date(Date.now()-1).toISOString()}};
  const state={records:{'123':record},relationships:{'123':{handle:'target',followsMe:true,following:true,checkedAt:new Date().toISOString()}}};
  let follows=0,reactions=0,reads=0,sends=0;
  assert.equal(baseRetryWaiting(record),false);assert.equal(rewardStage(record,false),'reconciliation');
  assert.equal(baseRetryWaiting({...record,replyAttemptedAt:undefined}),false);
  assert.equal(baseRetryWaiting({...record,replyAttemptedAt:undefined,replySendAttempts:undefined}),false);
  const outcome=await processBenefitStageSafely({...user,stage:'base'},plan,state,baseDeps({
    followAction:async()=>{follows++;return {readbackVerified:true,writeSent:false};},
    pairedReaction:async()=>{reactions++;return {like:{readbackVerified:true,writes:0},repost:{readbackVerified:true,writes:0}};},
    replyReadback:async()=>{reads++;return {found:[],reconciled:0,held:true};},
    publisher:async()=>{sends++;return {ids:['300'],readbackVerified:true};}
  }));
  assert.equal(outcome.status,'held_for_reconciliation');
  assert.equal(outcome.code,'X_BOT_REPLY_RECONCILIATION_REQUIRED');
  assert.equal(record.status,'needs_reconciliation');
  assert.equal(record.reconciliationHold.retryAllowed,false);
  assert.deepEqual([follows,reactions,reads,sends],[0,0,0,0]);
});

test('a reply-send cap of three moves retry_wait to manual reconciliation without another read or send',async()=>{
  const text='Saved draft.',intentAt='2026-10-01T10:00:00.000Z';
  const proof=ownerAbsenceProof({parentId:'100',text,intentAt,proofCheckedAt:'2026-10-01T10:00:05.000Z'});
  const state={records:{'123':{handle:'target',policyVersion:3,status:'retry_wait',pinnedPostId:'100',replyText:text,
    replyAttemptedAt:intentAt,replySendAttempts:3,results:{follow:{readbackVerified:true,following:true}},
    retry:{attempts:2,reason:'not_created_owner_timeline_proof',proof,after:new Date(Date.now()-1).toISOString()}}},
    relationships:{'123':{handle:'target',followsMe:true,following:true,checkedAt:new Date().toISOString()}}};
  let reads=0,sends=0;
  await assert.rejects(processTarget(user,plan,state,baseDeps({replyReadback:async()=>{reads++;return {found:[],reconciled:0};},
    publisher:async()=>{sends++;return {ids:['301'],readbackVerified:true};}})),{code:'X_BOT_REPLY_RECONCILIATION_REQUIRED'});
  assert.equal(state.records['123'].status,'needs_reconciliation');assert.equal(reads,0);assert.equal(sends,0);
});

test('a partial conversation with no owner reply leaves the original intent unresolved', async () => {
  const journalDir = await mkdtemp(path.join(tmpdir(), 'x-reply-retry-'));
  try {
    const runKey = 'followbot-123-100';
    const intent = await beginJournalIntent({ channel: 'x', runKey, journalDir, request: { method: 'POST', url: 'https://x.com/i/api/graphql/q/CreateTweet', body: '{}' } });
    await intent.result({ outcome: 'known_error', httpStatus: 200 });
    assert.equal((await unresolvedJournalFiles({ channel: 'x', runKey, journalDir })).length, 1);
    const conversation = { owner: 'owner', items: [{ id: '100', author: 'target', replyToId: null }, { id: '5', author: 'other', replyToId: '100' }] };
    const result = await reconcileReplyByReadback({ postId: '100', runKey, text:'Saved draft.',expectedOwner:'owner', journalDir,
      readOwner:async()=>({owner:'owner',userId:'2',ownerVerified:true}),readConversation: async () => conversation,
      readOwnerTimeline:async({cutoffAt})=>({owner:'owner',ownerId:'2',pagesRead:1,rangeStartAt:'2026-09-30T10:01:00.000Z',
        rangeEndAt:'2026-09-30T09:58:00.000Z',cutoffAt,reachedCutoff:false,endReached:false,coverageComplete:false,items:[]}) });
    assert.deepEqual(result, { found: [], reconciled: 0,held:true });
    assert.equal((await unresolvedJournalFiles({ channel: 'x', runKey, journalDir })).length, 1);
    await assert.rejects(beginJournalIntent({ channel: 'x', runKey, journalDir, request: { method: 'POST', url: 'https://x.com/i/api/graphql/q/CreateTweet', body: '{}' } }),{code:'SNS_JOURNAL_RECONCILIATION_REQUIRED'});
    assert.deepEqual((await readdir(journalDir)).sort(), [`x.${runKey}.000001.jsonl`]);
  } finally { await rm(journalDir, { recursive: true, force: true }); }
});

test('a 200 reaction journal holds false state and verifies positive state without another write', async () => {
  const journalRoot = await mkdtemp(path.join(tmpdir(), 'x-reactions-retry-'));
  try {
    let retweeted = false, posts = 0;
    const payload = () => ({ data: { result: { __typename: 'Tweet', rest_id: '100', core: { user_results: { result: { core: { screen_name: 'target' } } } }, legacy: { full_text: 'Example', favorited: true, retweeted } } } });
    const context = { ownerHandle: 'owner', ownerFingerprint: 'fp', request: async (method) => {
      if (method === 'POST') { posts++; retweeted = true; return { status: 200, raw: '{"data":{}}', headers: {} }; }
      return { status: 200, raw: JSON.stringify(payload()), headers: {} };
    } };
    const file = path.join(journalRoot, 'fp-repost-100.json');
    await writeFile(file, JSON.stringify({ owner: 'owner', operation: 'repost', tweetId: '100', target: 'target', writes: 1, httpStatus: 200, status: 'needs_reconciliation' }));
    const options = { journalRoot, withContext: work => work(context) };
    await assert.rejects(reactPair({tweetId:'100',expectedAuthor:'target',execute:true},options),{code:'X_REACTION_RECONCILIATION_REQUIRED'});
    assert.equal(posts,0);
    assert.deepEqual(await readdir(journalRoot),['fp-repost-100.json']);
    assert.equal(JSON.parse(await readFile(file,'utf8')).status,'needs_reconciliation');
    retweeted=true;
    const result=await reactPair({tweetId:'100',expectedAuthor:'target',execute:true},options);
    assert.equal(result.repost.readbackVerified,true);assert.equal(result.repost.writes,0);assert.equal(posts,0);
    assert.equal(JSON.parse(await readFile(file,'utf8')).status,'verified');
  } finally { await rm(journalRoot, { recursive: true, force: true }); }
});
