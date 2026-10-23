import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishChainGraph, ensureThreadsGraphToken, tokenAge, TOKEN_RECORD } from '../scripts/sns/writers/threads-graph.mjs';
import { publishChain } from '../scripts/sns/writers/threads.mjs';
import { reserveThreadsChain, beginJournalIntent, reconcileIntent } from '../scripts/sns/writers/journal.mjs';
import { createHash } from 'node:crypto';
import { threadsWriter, xImageUrlsFor } from '../scripts/quick-fact.mjs';

const TOKEN = 'TH' + 'a'.repeat(120);
const journal = t => { const dir = mkdtempSync(path.join(tmpdir(), 'tg-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const events = dir => readdirSync(dir).flatMap(f => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));

// Fake Graph API: containers, publish, post detail. `reject` makes a POST fail like Meta's error object.
function fakeClient({ reject = () => null, publishThrows = null } = {}) {
  const calls = [], posts = new Map();
  let n = 0;
  const client = {
    calls,
    async call(method, p, params = {}) {
      calls.push({ method, p, params: { ...params } });
      const refused = reject(p, params);
      if (refused) throw Object.assign(new Error('THREADS_GRAPH_REJECTED'), { code: 'THREADS_GRAPH_REJECTED', httpStatus: 400, receipt: { status: 400 }, detail: { code: 100, message: refused } });
      if (p === '/me/threads') { const id = `c${++n}`; posts.set(id, params); return { status: 200, json: { id } }; }
      if (p === '/me/threads_publish') {
        if (publishThrows) throw publishThrows;
        const c = posts.get(params.creation_id);
        const id = String(18000000000000000 + (++n));
        posts.set(id, { ...c, published: true });
        return { status: 200, json: { id } };
      }
      throw new Error('unexpected ' + p);
    },
    async waitFinished() { return { status: 'FINISHED' }; },
    async post(id) { const c = posts.get(id); return { id, username: 'lifehack__ailab', text: c.text, is_reply: Boolean(c.reply_to_id),
      media_type: c.media_type, permalink: `https://www.threads.net/@lifehack__ailab/post/C${id.slice(-6)}` }; },
    async recent() { return [...posts.entries()].filter(([, c]) => c.published).map(([id, c]) => ({ id, text: c.text, timestamp: new Date().toISOString() })); },
  };
  return client;
}

test('a two-post chain: container then journaled publish, reply chained by id, topic on the root, verified readback', async t => {
  const dir = journal(t), client = fakeClient();
  const r = await publishChainGraph(['루트 글', '답글 비교'], { runKey: 'qf-threads-abc', journalDir: dir, client, topic: '장보기', readbackDelayMs: 0 });
  assert.equal(r.readbackVerified, true);
  assert.equal(r.ids.length, 2);
  assert.match(r.permalinks[0], /^https:\/\/www\.threads\.com\/@lifehack__ailab\/post\//);
  const creates = client.calls.filter(c => c.p === '/me/threads');
  assert.equal(creates[0].params.topic_tag, '장보기');
  assert.equal(creates[0].params.media_type, 'TEXT');
  assert.equal(creates[1].params.reply_to_id, r.ids[0]);
  assert.equal(creates[1].params.topic_tag, undefined);
  const e = events(dir);
  assert.equal(e.filter(x => x.type === 'intent').length, 2);
  assert.ok(e.filter(x => x.type === 'intent').every(x => x.request.url === 'https://graph.threads.net/v1.0/me/threads_publish'));
  assert.equal(e.filter(x => x.type === 'checkpoint').length, 2);
  assert.ok(!JSON.stringify(e).includes(TOKEN));
});

test('several image URLs become a carousel of child containers; one becomes an IMAGE post', async t => {
  const client = fakeClient();
  await publishChainGraph(['사진 글'], { runKey: 'qf-threads-car', journalDir: journal(t), client, readbackDelayMs: 0,
    imageUrls: ['https://pbs.twimg.com/media/A.png?name=large', 'https://pbs.twimg.com/media/B.png?name=large'] });
  const creates = client.calls.filter(c => c.p === '/me/threads').map(c => c.params);
  assert.deepEqual(creates.slice(0, 2).map(c => [c.media_type, c.is_carousel_item]), [['IMAGE', 'true'], ['IMAGE', 'true']]);
  assert.equal(creates[2].media_type, 'CAROUSEL');
  assert.equal(creates[2].children, 'c1,c2');
  const single = fakeClient();
  await publishChainGraph(['한 장'], { runKey: 'qf-threads-one', journalDir: journal(t), client: single, readbackDelayMs: 0, imageUrls: ['https://pbs.twimg.com/media/A.png'] });
  assert.equal(single.calls[0].params.media_type, 'IMAGE');
  await assert.rejects(publishChainGraph(['x'], { runKey: 'k', journalDir: journal(t), client: single, imageUrls: ['http://insecure/a.png'] }),
    e => e.code === 'THREADS_GRAPH_IMAGE_URL_INVALID' && e.notSent === true);
});

test('a refused topic_tag is dropped and the container made again; nothing was published in between', async t => {
  const client = fakeClient({ reject: (p, params) => (p === '/me/threads' && params.topic_tag ? 'Invalid parameter topic_tag' : null) });
  const r = await publishChainGraph(['글'], { runKey: 'qf-threads-top', journalDir: journal(t), client, topic: '핫딜', readbackDelayMs: 0 });
  assert.equal(r.readbackVerified, true);
  assert.equal(r.notes[0].topicDropped, 'Invalid parameter topic_tag');
});

test('a publish refused by Meta is reconciled as not created and marked notSent so the caller may fall back', async t => {
  const dir = journal(t);
  const client = fakeClient({ reject: p => (p === '/me/threads_publish' ? 'Media not ready' : null) });
  await assert.rejects(publishChainGraph(['글'], { runKey: 'qf-threads-rej', journalDir: dir, client }), e => e.notSent === true && e.httpStatus === 400);
  assert.ok(events(dir).some(e => e.type === 'reconciled' && e.outcome === 'not_created_provider_rejected'));
  // The run key is free again.
  const ok = await publishChainGraph(['글'], { runKey: 'qf-threads-rej', journalDir: dir, client: fakeClient(), readbackDelayMs: 0 });
  assert.equal(ok.readbackVerified, true);
});

test('Graph honors an existing web reservation before it creates any container', async t => {
  const dir = journal(t), client = fakeClient();
  await reserveThreadsChain({ runKey: 'shared-web', journalDir: dir });
  await assert.rejects(publishChainGraph(['one'], { runKey: 'shared-web', journalDir: dir, client }),
    error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(client.calls.length, 0);
});

test('only a typed direct Graph rejection permits the existing web fallback on the same key', async t => {
  const dir = journal(t), runKey = 'typed-fallback';
  await assert.rejects(publishChainGraph(['one'], { runKey, journalDir: dir,
    client: fakeClient({ reject: p => p === '/me/threads_publish' ? 'rejected' : null }) }),
    error => error.notSent === true);
  const owned = { service: 'threads', owner: 'lifehack__ailab',
    cookies: ['sessionid', 'csrftoken', 'ds_user_id', 'rur'].map(name => ({ name, value: 'fake-' + name })),
    ownerRequest: { headers: { 'x-ig-app-id': 'fake-app', 'x-fb-lsd': 'fake-lsd' } } };
  let sends = 0;
  const result = await publishChain(['one'], { runKey, journalDir: dir, session: owned, rotateCookies: async () => {},
    transport: async () => { sends++; return Response.json({ status: 'ok', media: { pk: '10000003001' } }); },
    readbackClient: async ids => ({ owner: owned.owner, ownerVerified: true, relations: [],
      posts: ids.map(id => ({ id, code: 'ABCDE', owner: owned.owner,
        captionSha256: createHash('sha256').update('one').digest('hex'),
        threadId: 'only-thread', position: 1, threadLength: 1, isReply: false })) }) });
  assert.equal(result.readbackVerified, true);
  assert.equal(sends, 1);
  const next = fakeClient();
  await assert.rejects(publishChainGraph(['one'], { runKey, journalDir: dir, client: next }),
    error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
  assert.equal(next.calls.length, 0);
});

test('an operator result cannot masquerade as a direct Graph provider rejection', async t => {
  const dir = journal(t), runKey = 'operator-claim';
  const slot = await beginJournalIntent({ channel: 'threads', runKey, journalDir: dir,
    request: { method: 'POST', url: 'https://graph.threads.net/v1.0/me/threads_publish', body: '{}' } });
  await slot.result({ outcome: 'known_error', code: 'TRANSPORT_UNKNOWN' });
  const event = await reconcileIntent({ file: slot.file, result: {
    type: 'provider_rejected', origin: 'https://graph.threads.net', httpStatus: 400, providerCode: 100,
    outcome: 'not_created_provider_rejected',
  } });
  assert.equal(event.type, 'reconciled');
  await assert.rejects(reserveThreadsChain({ runKey, journalDir: dir }),
    error => error.code === 'SNS_JOURNAL_RECONCILIATION_REQUIRED');
});

test('a lost publish response is resolved from the owner list when the post is there, else the journal stays locked', async t => {
  const dir = journal(t);
  const client = fakeClient();
  const lost = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  // Publish lands, but the response is lost: the post shows up in recent().
  const real = client.call.bind(client);
  let first = true;
  client.call = async (m, p, params) => { const r = await real(m, p, params); if (p === '/me/threads_publish' && first) { first = false; throw lost; } return r; };
  const r = await publishChainGraph(['잃어버린 응답'], { runKey: 'qf-threads-lost', journalDir: dir, client, readbackDelayMs: 0 });
  assert.equal(r.readbackVerified, true);
  assert.ok(events(dir).some(e => e.type === 'reconciled' && e.outcome === 'created_found_by_owner_readback'));

  const dir2 = journal(t);
  const never = fakeClient({ publishThrows: lost });
  await assert.rejects(publishChainGraph(['없는 글'], { runKey: 'qf-threads-none', journalDir: dir2, client: never }), e => e.code === 'ECONNRESET' && !e.notSent);
  await assert.rejects(publishChainGraph(['없는 글'], { runKey: 'qf-threads-none', journalDir: dir2, client: fakeClient() }), /SNS_JOURNAL_RECONCILIATION_REQUIRED/);
});

function memoryStore(record) {
  const values = new Map([[TOKEN_RECORD, JSON.stringify(record)]]);
  return { read: k => values.get(k) ?? null, write: (k, v) => { values.set(k, v); return { stored: true }; }, values };
}
const meFetch = (username = 'lifehack__ailab', refresh = null) => async url => {
  const u = new URL(url);
  if (u.pathname === '/refresh_access_token') return new Response(JSON.stringify(refresh ?? { access_token: 'TH' + 'b'.repeat(120), token_type: 'bearer', expires_in: 5184000 }), { status: 200 });
  return new Response(JSON.stringify({ id: '1', username }), { status: 200 });
};

test('ensure keeps a young token, refreshes a week-old one after checking the new token, and never returns the token', async () => {
  const now = Date.parse('2026-10-12T00:00:00Z');
  const young = memoryStore({ accessToken: TOKEN, obtainedAt: '2026-10-10T00:00:00Z', lifetimeDays: 60 });
  const kept = await ensureThreadsGraphToken({ store: young, fetchImpl: meFetch(), now: () => now });
  assert.equal(kept.action, 'reused');
  assert.equal(Math.round(kept.daysLeft), 58);
  const old = memoryStore({ accessToken: TOKEN, obtainedAt: '2026-10-05T00:00:00Z', lifetimeDays: 60 });
  const refreshed = await ensureThreadsGraphToken({ store: old, fetchImpl: meFetch(), now: () => now });
  assert.equal(refreshed.action, 'refreshed');
  assert.equal(Math.round(refreshed.daysLeft), 60);
  assert.equal(JSON.parse(old.values.get(TOKEN_RECORD)).accessToken, 'TH' + 'b'.repeat(120));
  assert.ok(!JSON.stringify([kept, refreshed]).includes('TH' + 'a'.repeat(20)));
  const checkOnly = await ensureThreadsGraphToken({ store: memoryStore({ accessToken: TOKEN, obtainedAt: '2026-10-01T00:00:00Z' }), fetchImpl: meFetch(), now: () => now, allowRefresh: false });
  assert.equal(checkOnly.action, 'reused');
});

test('ensure reports reauth on a rejected token and refuses another account', async () => {
  const rejected = async () => new Response(JSON.stringify({ error: { code: 190, message: 'expired' } }), { status: 400 });
  assert.equal((await ensureThreadsGraphToken({ store: memoryStore({ accessToken: TOKEN, obtainedAt: '2026-10-05T00:00:00Z' }), fetchImpl: rejected })).code, 'THREADS_GRAPH_REAUTH_REQUIRED');
  assert.equal((await ensureThreadsGraphToken({ store: memoryStore({ accessToken: TOKEN, obtainedAt: '2026-10-05T00:00:00Z' }), fetchImpl: meFetch('someone') })).code, 'THREADS_GRAPH_ACCOUNT_MISMATCH');
  assert.deepEqual(tokenAge({ obtainedAt: '2026-10-05T00:00:00Z', lifetimeDays: 60 }, Date.parse('2026-10-06T00:00:00Z')).ageDays, 1);
});

test('quick-fact picks the Graph writer unless SNS_THREADS_WRITER=web; image URLs come from the same X post', async () => {
  assert.equal(threadsWriter({}), 'graph');
  assert.equal(threadsWriter({ SNS_THREADS_WRITER: 'web' }), 'web');
  const readMedia = async () => ({ items: [{ id: '2106943448293261714', media: [
    { type: 'photo', url: 'https://pbs.twimg.com/media/AAA.png' }, { type: 'photo', url: 'https://pbs.twimg.com/media/BBB.png' }] }] });
  assert.deepEqual(await xImageUrlsFor({ ok: true, ids: ['2106943448293261714'] }, 2, { readMedia, sleepImpl: async () => {} }),
    ['https://pbs.twimg.com/media/AAA.png?name=large', 'https://pbs.twimg.com/media/BBB.png?name=large']);
  assert.deepEqual(await xImageUrlsFor({ ok: false, ids: [] }, 2, { readMedia }), []);
  assert.deepEqual(await xImageUrlsFor({ ok: true, ids: ['2106943448293261714'] }, 3, { readMedia, sleepImpl: async () => {} }), []);
});
