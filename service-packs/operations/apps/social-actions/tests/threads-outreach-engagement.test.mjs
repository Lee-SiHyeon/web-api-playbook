import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runThreadsOutreachEngagement, followThreadsOutreachActor } from '../threads-outreach-engagement.mjs';
import { reconcileJournal } from '../lib/journal.mjs';

function fixture() {
  let row = { actorId: '12345', postId: '3997530329766474000', postAuthor: 'friend',
    status: 'verified_present', readbackVerified: true, engagementRequested: true, engagementPolicyVersion: 1 };
  const calls = [];
  const state = { following: false, outgoingRequest: false, liked: false, reposted: false };
  const options = {
    followJournalPath: '/scoped/follow.json',
    verifyTarget: async value => { assert.equal(value.actorId, '12345'); calls.push('target'); },
    verifyFinal: async () => ({ ...state }),
    save: async patch => { row = { ...row, ...structuredClone(patch) }; },
    follow: async input => {
      assert.equal(input.author, 'friend'); assert.equal(input.actorId, '12345');
      calls.push('follow'); state.following = true;
      return { success: true, readbackVerified: true, mutationCount: 1, currentState: { ...state }, journalPath: input.journalPath };
    },
    reaction: async input => {
      assert.equal(input.postId, row.postId); assert.equal(input.expectedAuthor, 'friend'); assert.equal(input.expectedActorId, '12345');
      calls.push(input.operation + (input.reconcile ? ':reconcile' : ''));
      state[input.operation === 'like' ? 'liked' : 'reposted'] = true;
      return { success: true, readbackVerified: true, writes: 1, currentState: { ...state }, journalPath: '/scoped/' + input.operation + '.json' };
    },
  };
  return { options, calls, state, row: () => row, set: patch => { row = { ...row, ...patch }; } };
}

test('verified invitation performs follow, exact-post like and repost in order, then records full completion', async () => {
  const f = fixture();
  const result = await runThreadsOutreachEngagement(f.row(), f.options);
  assert.deepEqual(f.calls.filter(call => call !== 'target'), ['follow', 'like', 'repost']);
  assert.equal(result.writes, 3); assert.equal(result.readbackVerified, true);
  assert.equal(f.row().status, 'verified_present'); assert.equal(f.row().engagementStatus, 'verified');
  assert.equal(f.row().engagementReadbackVerified, true);
});

test('missing reply readback or explicit engagement intent prevents all account actions', async () => {
  for (const change of [{ readbackVerified: false }, { status: 'needs_reconciliation' }, { engagementRequested: false }]) {
    const f = fixture(); f.set(change);
    await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { code: 'THREADS_OUTREACH_ENGAGEMENT_SCOPE_INVALID' });
    assert.deepEqual(f.calls, []);
  }
});

test('pending follow request holds the invitation before like or repost', async () => {
  const f = fixture();
  f.options.follow = async () => ({ success: true, readbackVerified: true, mutationCount: 1,
    currentState: { following: false, outgoingRequest: true }, journalPath: '/scoped/follow.json' });
  const result = await runThreadsOutreachEngagement(f.row(), f.options);
  assert.equal(result.status, 'pending_follow_request'); assert.equal(result.success, false);
  assert.equal(f.row().engagementStatus, 'pending_follow_request');
  assert.equal(f.calls.includes('like'), false); assert.equal(f.calls.includes('repost'), false);
});

test('failed like holds the workflow, and resumption only reconciles that journal without repeating follow', async () => {
  const f = fixture();
  f.options.reaction = async input => {
    f.calls.push(input.operation + (input.reconcile ? ':reconcile' : ''));
    return { success: false, readbackVerified: false, writes: 1, httpStatus: 503, code: 'META_GRAPHQL_REJECTED',
      currentState: { liked: false, reposted: false }, journalPath: '/scoped/like.json', message: 'raw-secret-never-stored' };
  };
  await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { code: 'META_GRAPHQL_REJECTED', httpStatus: 503 });
  assert.equal(f.row().engagementStatus, 'needs_reconciliation');
  assert.equal(JSON.stringify(f.row()).includes('raw-secret'), false);
  assert.equal(f.calls.includes('repost'), false);
  f.calls.length = 0;
  f.options.reaction = async input => {
    f.calls.push(input.operation + (input.reconcile ? ':reconcile' : ''));
    if (input.operation === 'like') assert.equal(input.reconcile, true);
    f.state[input.operation === 'like' ? 'liked' : 'reposted'] = true;
    return { success: true, readbackVerified: true, writes: 1, currentState: { ...f.state }, journalPath: '/scoped/' + input.operation + '.json' };
  };
  const resumed = await runThreadsOutreachEngagement(f.row(), f.options);
  assert.deepEqual(f.calls.filter(call => call !== 'target'), ['like:reconcile', 'repost']);
  assert.equal(resumed.writes, 1); assert.equal(resumed.readbackVerified, true);
});

test('stop after follow preserves the owed steps and never claims full completion', async () => {
  const f = fixture(); let stop = false;
  f.options.onReceipt = async receipt => { if (receipt.operation === 'follow') stop = true; };
  f.options.isStopRequested = async () => stop;
  const result = await runThreadsOutreachEngagement(f.row(), f.options);
  assert.equal(result.stopped, true); assert.equal(f.row().engagementStatus, 'pending');
  assert.equal(f.calls.includes('like'), false); assert.equal(f.row().engagementReadbackVerified, false);
});

test('changed final account state never causes another write or a completion claim', async () => {
  const f = fixture(); f.options.verifyFinal = async () => ({ ...f.state, liked: false });
  await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { code: 'THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED' });
  assert.deepEqual(f.calls.filter(call => call !== 'target'), ['follow', 'like']);
  assert.equal(f.row().engagementReadbackVerified, false);
});

test('a rejected response stops later mutations even when its desired state is confirmed', async () => {
  for (const httpStatus of [400, 401, 403, 429]) {
    const f = fixture();
    f.options.reaction = async input => {
      f.calls.push(input.operation); f.state.liked = true;
      return { success: true, readbackVerified: true, writes: 1, httpStatus, retryAfterSeconds: 30,
        code: 'META_GRAPHQL_REJECTED', currentState: { ...f.state }, journalPath: '/scoped/like.json' };
    };
    await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { httpStatus });
    assert.equal(f.calls.includes('repost'), false);
    assert.equal(f.row().engagement.like.readbackVerified, true);
    assert.equal(f.row().engagement.like.httpStatus, httpStatus);
    assert.equal(f.row().engagement.like.retryAfterSeconds, 30);
    assert.equal(f.row().engagementReadbackVerified, false);
  }
});

test('ambiguous follow response holds later reactions despite confirmed following state', async () => {
  const f = fixture();
  f.options.follow = async () => {
    f.calls.push('follow'); f.state.following = true;
    return { success: true, readbackVerified: true, mutationCount: 1, responseVerified: false,
      currentState: { ...f.state }, journalPath: '/scoped/follow.json' };
  };
  await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { code: 'THREADS_OUTREACH_ENGAGEMENT_RESPONSE_UNVERIFIED' });
  assert.deepEqual(f.calls.filter(call => call !== 'target'), ['follow']);
  assert.equal(f.row().engagement.follow.readbackVerified, true);
});

test('a stop received during target preflight prevents its first mutation', async () => {
  const f = fixture(); let stop = false;
  f.options.verifyTarget = async () => { stop = true; };
  f.options.isStopRequested = async () => stop;
  const result = await runThreadsOutreachEngagement(f.row(), f.options);
  assert.equal(result.stopped, true); assert.equal(result.writes, 0);
  assert.deepEqual(f.calls, []); assert.equal(f.row().engagementStatus, 'pending');
});

test('a previously confirmed follow that is now absent prevents owed reactions', async () => {
  const f = fixture();
  f.set({ engagement: { follow: { success: true, readbackVerified: true,
    currentState: { following: true, outgoingRequest: false } } } });
  await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { code: 'THREADS_OUTREACH_ENGAGEMENT_STATE_CHANGED' });
  assert.deepEqual(f.calls.filter(call => call !== 'target'), []);
});

test('a cached verified follow repairs its derived tracking receipt without counting or repeating a write', async () => {
  const f = fixture(); f.state.following = true;
  f.set({ engagement: { follow: { success: true, readbackVerified: true, writesThisRun: 1,
    currentState: { following: true, outgoingRequest: false } } } });
  const tracked = [];
  f.options.onReceipt = async receipt => tracked.push(receipt);
  const result = await runThreadsOutreachEngagement(f.row(), f.options);
  assert.deepEqual(f.calls.filter(call => call !== 'target'), ['like', 'repost']);
  assert.equal(tracked[0].operation, 'follow');
  assert.equal(tracked[0].writesThisRun, 0); assert.equal(tracked[0].reconciliationOnly, true);
  assert.equal(result.writes, 2);
});

test('a rejected cached desired-state receipt still blocks later actions on restart', async () => {
  for (const httpStatus of [400, 401, 403, 429]) {
    const f = fixture(); f.state.following = true; f.state.liked = true;
    f.set({ engagementStatus: 'needs_reconciliation', engagement: {
      follow: { success: true, readbackVerified: true, currentState: { following: true, outgoingRequest: false } },
      like: { success: true, readbackVerified: true, httpStatus, retryAfterSeconds: 30,
        checkedAt: new Date().toISOString(), currentState: { liked: true }, journalPath: '/scoped/like.json' },
    } });
    await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { httpStatus });
    assert.deepEqual(f.calls.filter(call => call !== 'target'), []);
  }
  const f = fixture(); f.state.following = true;
  f.set({ engagement: { follow: { success: true, readbackVerified: true, responseVerified: false, writesThisRun: 1,
    currentState: { following: true, outgoingRequest: false } } } });
  await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { code: 'THREADS_OUTREACH_ENGAGEMENT_RESPONSE_UNVERIFIED' });
  assert.deepEqual(f.calls, []);
});

test('an expired observed 429 permits only saved-journal read reconciliation before the remaining action', async () => {
  const f = fixture(); f.state.following = true; f.state.liked = true;
  const checkedAt = '2026-10-01T00:00:00.000Z';
  f.options.now = () => Date.parse(checkedAt) + 60001;
  f.set({ engagement: {
    follow: { success: true, readbackVerified: true, currentState: { following: true, outgoingRequest: false } },
    like: { success: true, readbackVerified: true, httpStatus: 429, retryAfterSeconds: 30, checkedAt,
      currentState: { liked: true }, journalPath: '/scoped/like.json' },
  } });
  const original = f.options.reaction;
  f.options.reaction = async (input, options) => {
    if (input.operation === 'like') assert.equal(input.reconcile, true);
    return original(input, options);
  };
  const result = await runThreadsOutreachEngagement(f.row(), f.options);
  assert.equal(result.readbackVerified, true); assert.equal(result.writes, 1);
  assert.deepEqual(f.calls.filter(call => call !== 'target'), ['like:reconcile', 'repost']);
});

test('a refusal retained only by the action journal blocks engagement after a persistence crash', async () => {
  const f = fixture(); f.state.following = true;
  f.set({ engagement: { follow: { success: true, readbackVerified: true,
    currentState: { following: true, outgoingRequest: false } } } });
  f.options.reaction = async input => {
    f.calls.push(input.operation); f.state.liked = true;
    return { success: true, readbackVerified: true, noOp: true, writes: 0, priorWriteHttpStatus: 400,
      priorWriteCode: 'META_GRAPHQL_REJECTED', priorFailureCheckedAt: new Date().toISOString(), currentState: { ...f.state } };
  };
  await assert.rejects(runThreadsOutreachEngagement(f.row(), f.options), { code: 'THREADS_OUTREACH_ENGAGEMENT_CONTRACT_REJECTED', httpStatus: 400 });
  assert.deepEqual(f.calls.filter(call => call !== 'target'), ['like']);
});

test('follow dispatch guard checks stop before and after durable journal preparation', async () => {
  for (const stopAt of ['provider_preflight', 'journal_flush']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'threads-outreach-follow-'));
    let stop = false, mutations = 0, reserved = 0;
    const ready = { service: 'threads', operation: 'follow', normalizedTarget: '12345', target: 'friend',
      auth: { ownerVerified: true }, ready: true };
    const result = await followThreadsOutreachActor({ actorId: '12345', author: 'friend',
      journalPath: path.join(root, 'follow.json'), isStopRequested: async () => stop }, {
      providerLoader: async () => ({ prepare: async () => ready, execute: async (_, options) => {
        if (stopAt === 'provider_preflight') stop = true;
        if (await options.beforeWrite(ready) === false) throw Object.assign(new Error('guarded'), { code: 'SOCIAL_JOURNAL_REJECTED' });
        mutations++; return { ...ready, mutationCount: 1 };
      } }),
      journalExecutor: async (input, provider) => {
        await provider.prepare(input);
        return provider.execute(input, { beforeWrite: async () => {
          reserved++; if (stopAt === 'journal_flush') stop = true;
        } });
      },
    });
    assert.equal(mutations, 0); assert.equal(result.writesThisRun, 0);
    assert.equal(result.writeSent, false); assert.equal(result.code, 'THREADS_OUTREACH_STOP_REQUESTED');
    assert.equal(reserved, stopAt === 'journal_flush' ? 1 : 0);
  }
});

test('only a read-reconciled zero-attempt follow journal permits a new attempt', async () => {
  for (const attempts of [0, 1]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'threads-outreach-follow-resume-'));
    const journalPath = path.join(root, 'follow.json');
    await writeFile(journalPath, JSON.stringify({ attempts }));
    let executions = 0;
    const result = await followThreadsOutreachActor({ actorId: '12345', author: 'friend', journalPath }, {
      reconcile: async () => ({ normalizedTarget: '12345', target: 'friend', mutationCount: attempts,
        status: attempts === 0 ? 'not_sent' : 'outcome_unknown', needs_reconciliation: attempts === 1 }),
      providerLoader: async () => ({}),
      journalExecutor: async () => {
        executions++; await writeFile(journalPath, JSON.stringify({ attempts: 1 }));
        return { mutationCount: 1, success: true, readbackVerified: true };
      },
    });
    assert.equal(executions, attempts === 0 ? 1 : 0);
    assert.equal(result.writesThisRun, attempts === 0 ? 1 : 0);
    const archives = (await readdir(root)).filter(name => name.includes('.not-sent-'));
    assert.equal(archives.length, attempts === 0 ? 1 : 0);
    if (archives.length) assert.equal(JSON.parse(await readFile(path.join(root, archives[0]), 'utf8')).attempts, 0);
  }
});

test('follow journal reconciliation preserves a rejected response through repeated current-state reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'threads-follow-rejected-journal-'));
  const file = path.join(root, 'follow.json'), ownerFingerprint = 'test-' + randomUUID();
  const prepared = { service: 'threads', operation: 'follow', target: 'friend', normalizedTarget: '12345',
    ownerFingerprint, ready: true, noOp: true, currentState: { following: true, outgoingRequest: false } };
  const targetIdentity = ['threads', ownerFingerprint, '12345'].join(':');
  const pendingPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
    'affiliate-content-operations', 'social-actions', 'pending', createHash('sha256').update(targetIdentity).digest('hex') + '.json');
  await writeFile(file, JSON.stringify({ version: 1, journalId: randomUUID(), writerPid: process.pid,
    writerIdentity: 'win32:123456789012345678', input: { service: 'threads', operation: 'follow', target: 'friend' },
    targetIdentity, pendingPath, status: 'succeeded', attempts: 1, prepared,
    updatedAt: '2026-10-01T00:00:00.000Z', result: { httpStatus: 400, code: 'META_GRAPHQL_REJECTED',
      responseVerified: false, readbackVerified: true, success: true } }));
  let writes = 0;
  const provider = async () => ({ prepare: async () => prepared, execute: async () => { writes++; } });
  for (let index = 0; index < 2; index++) {
    const result = await reconcileJournal(file, provider);
    assert.equal(result.readbackVerified, true); assert.equal(result.priorWriteHttpStatus, 400);
    assert.equal(result.priorResponseUnverified, true);
    assert.equal(result.priorFailureCheckedAt, '2026-10-01T00:00:00.000Z');
  }
  assert.equal(writes, 0);
});
