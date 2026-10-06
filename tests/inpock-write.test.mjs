import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInpockPublisher } from '../lib/inpock-write.mjs';
import { WriteJournal } from '../lib/write-journal.mjs';

const API = 'https://link-rest.inpock.co.kr';
const actor = { id: 42, username: 'owner_test' };
const owner = { authenticated: true, ownerVerified: true, user: { username: actor.username } };
const card = () => ({
  confirm: true, ownerUsername: actor.username,
  sourceIdentity: { channel: 'naver-blog', blogId: 'source_blog', logNo: '123456789' },
  payload: { block_type: 'link', url: 'https://blog.naver.com/source_blog/123456789', title: 'Original article title',
    style: 'simple', image: '', button_text: '', is_open: true },
});
const ordered = value => Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
const hash = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const response = (value, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(value) });

async function harness(t, { handle, actorValue = actor, ownerValue = owner, wrapJournal, expectedPayload = card().payload } = {}) {
  const scratch = process.env.TMPDIR || path.join(os.homedir(), '.nad-scratch', 'tmp');
  await fs.mkdir(scratch, { recursive: true });
  const root = await fs.mkdtemp(path.join(scratch, 'inpock-write-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journal = new WriteJournal({ root, service: 'inpock' });
  const calls = [], events = [], waits = [], anonymousCalls = [];
  const state = { owned: [], public: [], publicOwnerId: actor.id, lockCalls: 0, postCalls: 0, failAuthSave: false };
  const session = { request: async (url, init = {}) => {
    const parsed = new URL(url), method = init.method || 'GET';
    assert.equal(parsed.origin, API);
    calls.push({ url, method, init });
    events.push(method + ' ' + parsed.pathname);
    if (method === 'POST') {
      state.postCalls++;
      assert.equal(parsed.pathname, '/blocks');
      assert.deepEqual(init.headers, { 'content-type': 'application/json' });
      assert.deepEqual(JSON.parse(init.body), expectedPayload);
    }
    const custom = await handle?.({ url: parsed, method, init, state, calls, events });
    if (custom !== undefined) return custom;
    if (method === 'POST') {
      const created = { ...JSON.parse(init.body), id: 101 };
      state.owned = [created]; state.public = [{ ...created }];
      return response({ block: created }, 201);
    }
    if (parsed.pathname === '/v2/blocks') return response({ blocks: state.owned, has_next: false, next_cursor: null });
    if (parsed.pathname === '/v2/users/owner_test/public') return response({
      user: { user_id: state.publicOwnerId, username: actor.username, design: {}, slug: actor.username },
      blocks: state.public, cta_block: null,
    });
    assert.fail('unexpected route ' + parsed.pathname);
  } };
  let holding = false;
  const auth = {
    withSession: async callback => {
      state.lockCalls++;
      // Separate callers may overlap for the reservation race test; nested
      // library calls are rejected by the unused auth methods below.
      holding = true;
      try { return await callback(session, ownerValue, actorValue); }
      finally {
        holding = false;
        if (state.failAuthSave) {
          state.failAuthSave = false;
          throw Object.assign(new Error('private store diagnostics'), { code: 'PROTECTED_STORE_OPERATION_FAILED' });
        }
      }
    },
    ensure: () => assert.fail('nested ensure'), owner: () => assert.fail('nested owner'), health: () => assert.fail('nested health'),
  };
  const decorated = wrapJournal ? wrapJournal(journal, events) : {
    key: (...args) => journal.key(...args), read: (...args) => journal.read(...args),
    reserve: (...args) => journal.reserve(...args), reconcile: (...args) => journal.reconcile(...args),
    finish: async (...args) => { const result = await journal.finish(...args); events.push('ACK_DURABLE'); return result; },
  };
  const anonymousFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('authorization'), null);
    assert.equal(init.method, 'GET');
    assert.equal(new URL(url).pathname, '/v2/users/owner_test/public');
    anonymousCalls.push(url);
    const reply = await session.request(url, init);
    return new Response(reply.raw, { status: reply.status, headers: reply.headers });
  };
  const publisher = createInpockPublisher({ auth, journal: decorated, readAttempts: 1, anonymousFetch,
    now: () => Date.parse('2026-10-04T16:00:00Z'), wait: async ms => { waits.push(ms); } });
  const input = card();
  const key = journal.key('create-link', { ownerId: actor.id }, { sourceIdentity: ordered(input.sourceIdentity) });
  const safeRecord = { operation: 'create-link', ownerId: actor.id, sourceHash: hash(input.sourceIdentity), payloadFingerprint: hash(input.payload) };
  return { publisher, journal, state, calls, events, waits, anonymousCalls, key, safeRecord, get holding() { return holding; } };
}

test('confirmation and actor mismatches prevent POST and invalid confirmation never authenticates', async t => {
  const missing = await harness(t);
  await assert.rejects(missing.publisher.publish({ ...card(), confirm: false }), { code: 'INPOCK_CONFIRM_REQUIRED' });
  assert.equal(missing.state.lockCalls, 0);
  assert.equal(missing.calls.length, 0);
  for (const input of [{ ...card(), ownerUsername: 'different_owner' }, card()]) {
    const h = await harness(t, input.ownerUsername === actor.username ? { actorValue: { ...actor, username: 'different_owner' } } : {});
    await assert.rejects(h.publisher.publish(input), { code: 'OWNER_MISMATCH' });
    assert.equal(h.state.postCalls, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('a thumbnail card carries an https product image; image rules are checked before any request', async t => {
  const thumb = { ...card(), payload: { ...card().payload, style: 'thumbnail', image: 'https://shopping.toss.im/live/temp/x.png' } };
  const h = await harness(t, { expectedPayload: thumb.payload });
  const result = await h.publisher.publish(thumb);
  assert.equal(result.readbackVerified, true);
  for (const payload of [{ ...thumb.payload, image: '' }, { ...thumb.payload, image: 'http://example.com/x.png' }, { ...card().payload, image: 'https://example.com/x.png' }, { ...card().payload, style: 'big' }]) {
    const bad = await harness(t);
    await assert.rejects(bad.publisher.publish({ ...thumb, payload }), { code: 'INPOCK_CARD_INPUT_INVALID' });
    assert.equal(bad.calls.length, 0);
  }
});

test('update edits an own card in place once, verifies owner and public copies, and never changes the URL', async t => {
  const thumb = { ...card().payload, style: 'thumbnail', image: 'https://shopping.toss.im/live/temp/x.png' };
  const puts = [];
  const h = await harness(t, { handle: async ({ url, method, init, state }) => {
    if (method === 'PUT') {
      assert.equal(url.pathname, '/blocks/101');
      puts.push(JSON.parse(init.body));
      state.owned = [{ ...JSON.parse(init.body), id: 101 }]; state.public = [{ ...state.owned[0] }];
      return response({ block: state.owned[0] });
    }
    return undefined;
  } });
  h.state.owned = [{ ...card().payload, id: 101 }]; h.state.public = [{ ...card().payload, id: 101 }];
  const input = { ...card(), blockId: 101, payload: thumb };
  const first = await h.publisher.update(input);
  assert.equal(first.status, 'updated_verified');
  assert.deepEqual(puts, [thumb]);
  const again = await h.publisher.update(input);
  assert.equal(again.status, 'already_verified');
  assert.equal(puts.length, 1, 'no second PUT');
  await assert.rejects(h.publisher.update({ ...input, payload: { ...thumb, url: 'https://example.com/other' } }), { code: 'INPOCK_CARD_URL_CHANGE_NOT_ALLOWED' });
  await assert.rejects(h.publisher.update({ ...input, blockId: 999 }), { code: 'INPOCK_CARD_NOT_FOUND' });
});

test('setVisibility hides an own card once and verifies it left the public page', async t => {
  const patches = [];
  const h = await harness(t, { handle: async ({ url, method, init, state }) => {
    if (method === 'PATCH') {
      assert.equal(url.pathname, '/blocks/101/open');
      patches.push(JSON.parse(init.body));
      state.owned = [{ ...state.owned[0], is_open: false }]; state.public = [];
      return response({}, 200);
    }
    return undefined;
  } });
  h.state.owned = [{ ...card().payload, id: 101 }]; h.state.public = [{ ...card().payload, id: 101 }];
  const input = { confirm: true, ownerUsername: actor.username, blockId: 101, isOpen: false };
  assert.equal((await h.publisher.setVisibility(input)).status, 'visibility_verified');
  assert.deepEqual(patches, [{ is_open: false }]);
  assert.equal((await h.publisher.setVisibility(input)).status, 'already_in_state');
  assert.equal(patches.length, 1);
  await assert.rejects(h.publisher.setVisibility({ ...input, blockId: 5 }), { code: 'INPOCK_CARD_NOT_FOUND' });
});

test('one successful publication durably saves ACK ID before readback and acquires auth only once', async t => {
  const h = await harness(t);
  const result = await h.publisher.publish(card());
  assert.equal(result.readbackVerified, true);
  assert.equal(result.publicVerified, true);
  assert.equal(result.anonymousPublicVerified, true);
  assert.equal(result.publicCredentialsSent, false);
  assert.equal(h.anonymousCalls.length, 1);
  assert.equal(result.blockId, 101);
  assert.equal(result.blockIdSource, 'ack_full_card');
  assert.equal(result.status, 'created_verified');
  assert.equal(result.publicationPerformed, true);
  assert.equal(result.writeReceipt.responseSchema.block.id, 'number');
  assert.equal(result.writeReceipt.responseSchema.block.title, 'string');
  assert.equal(result.postAttempts, 1);
  assert.equal(h.state.lockCalls, 1);
  assert.equal(h.holding, false);
  assert.equal(h.state.postCalls, 1);
  const post = h.events.indexOf('POST /blocks'), durable = h.events.indexOf('ACK_DURABLE');
  assert.ok(durable > post);
  assert.equal(h.events[durable + 1], 'GET /v2/blocks');
  const record = await h.journal.read(h.key);
  assert.equal(record.status, 'reconciled');
  assert.equal(record.safeReceipt.blockId, 101);
  assert.equal(record.reconciliation.result, 'found');
  assert.equal(record.reconciliation.exactFieldsVerified, true);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(card().payload.url), false);
  assert.equal(serialized.includes(card().payload.title), false);
});

test('the same source publishes once and changed payload on that source conflicts', async t => {
  const h = await harness(t);
  await h.publisher.publish(card());
  const repeat = await h.publisher.publish(card());
  assert.equal(repeat.readbackVerified, true);
  assert.equal(repeat.writeSuppressed, true);
  assert.equal(repeat.postAttempts, 0);
  const changed = card(); changed.payload.title = 'Changed article title';
  await assert.rejects(h.publisher.publish(changed), { code: 'INPOCK_CARD_PAYLOAD_CONFLICT' });
  assert.equal(h.state.postCalls, 1);
});

test('an exact existing remote card is verified without POST; same URL with another title conflicts', async t => {
  const h = await harness(t);
  const existing = { ...card().payload, id: 202 };
  h.state.owned = [existing]; h.state.public = [{ ...existing }];
  const result = await h.publisher.publish(card());
  assert.equal(result.status, 'existing_verified');
  assert.equal(result.blockId, 202);
  assert.equal(result.postAttempts, 0);
  assert.equal(h.state.postCalls, 0);
  const conflict = await harness(t);
  conflict.state.owned = [{ ...existing, title: 'Other title' }];
  await assert.rejects(conflict.publisher.publish(card()), { code: 'INPOCK_CARD_REMOTE_CONFLICT' });
  assert.equal(conflict.state.postCalls, 0);
  assert.equal(await conflict.journal.read(conflict.key), null);
});

test('duplicate existing owner URLs are ambiguous and prevent any new write', async t => {
  const h = await harness(t);
  h.state.owned = [{ ...card().payload, id: 201 }, { ...card().payload, id: 202 }];
  await assert.rejects(h.publisher.publish(card()), { code: 'INPOCK_CARD_AMBIGUOUS' });
  assert.equal(h.state.postCalls, 0);
});

test('reserved and pending journal records suppress POST even when the remote list remains empty', async t => {
  for (const pending of [false, true]) {
    const h = await harness(t);
    await h.journal.reserve(h.key, h.safeRecord);
    if (pending) await h.journal.finish(h.key, 'outcome_unknown', { postAttempts: 1 });
    const result = await h.publisher.publish(card());
    assert.equal(result.status, 'outcome_unknown');
    assert.equal(result.postAttempts, 0);
    assert.equal(result.writeSuppressed, true);
    assert.equal(result.automaticResendAllowed, false);
    assert.equal(h.state.postCalls, 0);
    assert.equal((await h.journal.read(h.key)).status, 'needs-reconciliation');
    await h.publisher.publish(card());
    assert.equal(h.state.postCalls, 0);
  }
});

test('a timeout with a later exact owner/public record reconciles without resending', async t => {
  const h = await harness(t, { handle: ({ method, init, state }) => {
    if (method !== 'POST') return;
    const created = { ...JSON.parse(init.body), id: 303 };
    state.owned = [created]; state.public = [{ ...created }];
    throw Object.assign(new Error('private network diagnostics'), { code: 'SCOPED_SESSION_TIMEOUT' });
  } });
  const result = await h.publisher.publish(card());
  assert.equal(result.readbackVerified, true);
  assert.equal(result.blockId, 303);
  assert.equal(result.blockIdSource, 'independent_readback');
  assert.equal(result.writeReceipt.code, 'SCOPED_SESSION_TIMEOUT');
  assert.equal(result.status, 'desired_state_verified_after_unclear_write');
  assert.equal(result.publicationPerformed, 'unknown');
  assert.equal(result.writeSent, true);
  const repeat = await h.publisher.publish(card());
  assert.equal(repeat.writeSuppressed, true);
  assert.equal(h.state.postCalls, 1);
});

test('ACK persistence failure preserves the reserved intent and the next run never resends', async t => {
  let failFinish = true;
  const h = await harness(t, { wrapJournal: journal => ({
    key: (...args) => journal.key(...args), read: (...args) => journal.read(...args), reserve: (...args) => journal.reserve(...args),
    reconcile: (...args) => journal.reconcile(...args), finish: async (...args) => {
      if (failFinish) { failFinish = false; throw Object.assign(new Error('disk'), { code: 'WRITE_JOURNAL_IO_FAILED' }); }
      return journal.finish(...args);
    },
  }) });
  await assert.rejects(h.publisher.publish(card()), error => {
    assert.equal(error.code, 'INPOCK_ACK_PERSIST_UNKNOWN');
    assert.equal(error.receipt.writeSent, true);
    assert.equal(error.receipt.postAttempts, 1);
    assert.equal(error.receipt.journalKey, h.key);
    return true;
  });
  assert.equal((await h.journal.read(h.key)).status, 'reserved');
  const repeat = await h.publisher.publish(card());
  assert.equal(repeat.readbackVerified, true);
  assert.equal(repeat.writeSuppressed, true);
  assert.equal(h.state.postCalls, 1);
});

test('public content, visibility and numeric owner mismatches leave a pending journal', async t => {
  for (const change of [
    state => { state.public[0].title = 'Different title'; },
    state => { state.public[0].url = 'https://blog.naver.com/source_blog/987654321'; },
    state => { state.public[0].style = 'other'; },
    state => { state.public[0].is_open = false; },
    state => { state.public[0].image = 'https://example.invalid/unexpected.png'; },
    state => { state.public[0].button_text = 'Different button'; },
    state => { state.public[0].id = 404; },
    state => { state.publicOwnerId = 43; },
  ]) {
    const h = await harness(t, { handle: ({ method, init, state }) => {
      if (method !== 'POST') return;
      const created = { ...JSON.parse(init.body), id: 101 };
      state.owned = [created]; state.public = [{ ...created }]; change(state);
      return response({ block: created }, 201);
    } });
    const result = await h.publisher.publish(card());
    assert.equal(result.status, 'outcome_unknown');
    assert.equal(result.readbackVerified, false);
    assert.equal(result.automaticResendAllowed, false);
    assert.equal((await h.journal.read(h.key)).status, 'needs-reconciliation');
    await h.publisher.publish(card());
    assert.equal(h.state.postCalls, 1);
  }
});

test('a full-payload ACK ID must match the owner/public resource ID', async t => {
  const h = await harness(t, { handle: ({ method, init, state }) => {
    if (method !== 'POST') return;
    const payload = JSON.parse(init.body);
    state.owned = [{ ...payload, id: 505 }]; state.public = [{ ...payload, id: 505 }];
    return response({ block: { ...payload, id: 101 } }, 201);
  } });
  const result = await h.publisher.publish(card());
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.readbackVerified, false);
  assert.equal((await h.journal.read(h.key)).safeReceipt.blockId, 101);
  assert.equal((await h.journal.read(h.key)).status, 'needs-reconciliation');
  assert.equal(h.state.postCalls, 1);
});

test('duplicate public IDs cannot prove an unambiguous public resource', async t => {
  const h = await harness(t, { handle: ({ method, init, state }) => {
    if (method !== 'POST') return;
    const created = { ...JSON.parse(init.body), id: 101 };
    state.owned = [created]; state.public = [{ ...created }, { ...created }];
    return response({ block: created }, 201);
  } });
  const result = await h.publisher.publish(card());
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.readbackVerified, false);
  assert.equal((await h.journal.read(h.key)).status, 'needs-reconciliation');
  await h.publisher.publish(card());
  assert.equal(h.state.postCalls, 1);
});

test('a 2xx JSON error object is not treated as an application ACK', async t => {
  const h = await harness(t, { handle: ({ method, init, state }) => {
    if (method !== 'POST') return;
    const created = { ...JSON.parse(init.body), id: 606 };
    state.owned = [created]; state.public = [{ ...created }];
    return response({ error: 'unrecognized application result' }, 200);
  } });
  const result = await h.publisher.publish(card());
  assert.equal(result.status, 'desired_state_verified_after_unclear_write');
  assert.equal(result.publicationPerformed, 'unknown');
  assert.equal(result.blockIdSource, 'independent_readback');
  assert.equal(result.readbackVerified, true);
  assert.equal(Object.hasOwn((await h.journal.read(h.key)).safeReceipt, 'blockId'), false);
  assert.equal(h.state.postCalls, 1);
});

test('post-send journal-read failure reports the attempted write and never permits a resend', async t => {
  let reads = 0;
  const h = await harness(t, { wrapJournal: journal => ({
    key: (...args) => journal.key(...args), reserve: (...args) => journal.reserve(...args),
    finish: (...args) => journal.finish(...args), reconcile: (...args) => journal.reconcile(...args),
    read: async (...args) => {
      if (++reads === 3) throw Object.assign(new Error('private disk diagnostics'), { code: 'WRITE_JOURNAL_IO_FAILED' });
      return journal.read(...args);
    },
  }) });
  await assert.rejects(h.publisher.publish(card()), error => {
    assert.equal(error.code, 'INPOCK_WRITE_OUTCOME_UNKNOWN');
    assert.equal(error.receipt.writeSent, true);
    assert.equal(error.receipt.postAttempts, 1);
    assert.equal(error.receipt.journalKey, h.key);
    assert.equal(error.receipt.automaticResendAllowed, false);
    assert.equal(error.receipt.causeCode, 'WRITE_JOURNAL_IO_FAILED');
    assert.equal(JSON.stringify(error.receipt).includes('private'), false);
    return true;
  });
  assert.equal((await h.journal.read(h.key)).status, 'finished');
  const resumed = await h.publisher.publish(card());
  assert.equal(resumed.readbackVerified, true);
  assert.equal(resumed.writeSuppressed, true);
  assert.equal(h.state.postCalls, 1);
});

test('auth-finally persistence failure preserves remote verification and blocks another POST', async t => {
  const h = await harness(t);
  h.state.failAuthSave = true;
  await assert.rejects(h.publisher.publish(card()), error => {
    assert.equal(error.code, 'INPOCK_WRITE_OUTCOME_UNKNOWN');
    assert.equal(error.receipt.writeSent, true);
    assert.equal(error.receipt.postAttempts, 1);
    assert.equal(error.receipt.journalKey, h.key);
    assert.equal(error.receipt.readbackVerified, true);
    assert.equal(error.receipt.publicVerified, true);
    assert.equal(error.receipt.blockId, 101);
    assert.equal(error.receipt.automaticResendAllowed, false);
    assert.equal(error.receipt.causeCode, 'PROTECTED_STORE_OPERATION_FAILED');
    return true;
  });
  assert.equal((await h.journal.read(h.key)).status, 'reconciled');
  const resumed = await h.publisher.publish(card());
  assert.equal(resumed.readbackVerified, true);
  assert.equal(resumed.writeSuppressed, true);
  assert.equal(h.state.postCalls, 1);
});

test('incomplete owner pagination prevents POST and reservation', async t => {
  let cursor = 0;
  const h = await harness(t, { handle: ({ url, method }) => {
    if (method === 'GET' && url.pathname === '/v2/blocks') return response({ blocks: [], has_next: true, next_cursor: 'cursor-' + ++cursor });
  } });
  await assert.rejects(h.publisher.publish(card()), { code: 'INPOCK_OWNER_LIST_INCOMPLETE' });
  assert.equal(cursor, 20);
  assert.equal(h.state.postCalls, 0);
  assert.equal(await h.journal.read(h.key), null);
});

test('concurrent reservations for the same source permit one POST', async t => {
  let preflightReads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { handle: async ({ url, method }) => {
    if (method === 'GET' && url.pathname === '/v2/blocks' && preflightReads < 2) {
      preflightReads++;
      if (preflightReads === 2) release();
      await gate;
      return response({ blocks: [], has_next: false, next_cursor: null });
    }
  } });
  const results = await Promise.allSettled([h.publisher.publish(card()), h.publisher.publish(card())]);
  assert.equal(h.state.postCalls, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.readbackVerified).length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected?.reason.code, 'WRITE_JOURNAL_EXISTS');
});
