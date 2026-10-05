import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createInpockReadClient } from '../lib/inpock-read.mjs';

const API = 'https://link-rest.inpock.co.kr';
const boundActor = { id: 42, username: 'owner_test' };
const actor = { authenticated: true, ownerVerified: true, user: { username: boundActor.username } };
const response = (value, status = 200, mime = 'application/json; charset=utf-8') => ({
  status, headers: { 'content-type': mime }, raw: JSON.stringify(value),
});
const page = (blocks = [], next = null) => ({ blocks, has_next: next !== null, next_cursor: next });
const profile = () => ({
  user: { user_id: 42, username: actor.user.username, design: {}, slug: 'owner-test' },
  blocks: [{ id: 7, type: 'LINK' }], cta_block: null,
});
const stats = () => ({
  results: { today: 2, accumulated: 20, realtime: 1, subscribers: 3 }, updated_at: '2026-10-04T13:30:00Z',
});

function harness(handler, owner = actor) {
  const calls = [];
  const session = {
    async request(url, init) {
      calls.push({ url, init });
      assert.equal(new URL(url).origin, API);
      assert.ok(init === undefined || init.method === undefined || init.method === 'GET');
      return handler(new URL(url), init);
    },
  };
  const auth = { withSession: callback => callback(session, owner, boundActor) };
  return { reader: createInpockReadClient({ auth, now: () => Date.parse('2026-10-04T14:00:00Z') }), calls };
}

test('an empty server-end page is complete and distinct from a page-budget stop', async () => {
  const h = harness(() => response(page()));
  const result = await h.reader.listBlocks();
  assert.deepEqual(result.blocks, []);
  assert.equal(result.complete, true);
  assert.equal(result.recordCount, 0);
  assert.equal(result.pages, 1);
  assert.equal(result.stopReason, 'server_end');
  assert.deepEqual(h.calls.map(call => call.url), [API + '/v2/blocks']);
  assert.equal(result.receipts[0].hasNext, false);
});

test('pagination safely encodes opaque cursors and follows the server end', async () => {
  const next = 'opaque+/=&? cursor';
  const h = harness(url => {
    if (!url.search) return response(page([{ id: 1 }], next));
    assert.equal(url.searchParams.get('cursor'), next);
    assert.deepEqual([...url.searchParams.keys()], ['cursor']);
    return response(page([{ id: 2 }]));
  });
  const result = await h.reader.listBlocks({ maxPages: 2 });
  assert.deepEqual(result.blocks.map(block => block.id), [1, 2]);
  assert.equal(result.recordCount, 2);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.equal(result.stopReason, 'server_end');
  assert.equal(result.receipts.every(receipt => receipt.path === '/v2/blocks'), true);
  assert.equal(JSON.stringify(result.receipts).includes(next), false);
});

test('a bounded traversal keeps partial records and reports incomplete coverage', async () => {
  const h = harness(() => response(page([{ id: 1 }], 'next-page')));
  const result = await h.reader.listBlocks({ maxPages: 1 });
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'page_budget');
  assert.equal(result.pages, 1);
  assert.equal(result.recordCount, 1);
  assert.equal(h.calls.length, 1);
});

test('repeated cursors and multi-page cycles fail instead of silently duplicating records', async () => {
  for (const cursors of [['same', 'same'], ['first', 'second', 'first']]) {
    let index = 0;
    const h = harness(() => response(page([{ id: index + 1 }], cursors[index++])));
    await assert.rejects(h.reader.listBlocks({ maxPages: 5 }), { code: 'INPOCK_PAGINATION_LOOP' });
    assert.equal(h.calls.length, cursors.length);
  }
});

test('invalid page budgets never issue business requests', async () => {
  for (const maxPages of [0, -1, 21, 1.5, '2', NaN, Infinity, null]) {
    const h = harness(() => assert.fail('business request must not run'));
    await assert.rejects(h.reader.listBlocks({ maxPages }), { code: 'INPOCK_PAGE_BUDGET_INVALID' });
    assert.equal(h.calls.length, 0);
  }
});

test('block schema failures reject missing pagination, scalar records and unsafe cursors', async () => {
  for (const value of [
    null, [], { blocks: [], next_cursor: null }, { blocks: {}, has_next: false },
    { blocks: [null], has_next: false }, { blocks: ['record'], has_next: false },
    { blocks: [], has_next: true, next_cursor: null },
    { blocks: [], has_next: true, next_cursor: '' },
    { blocks: [], has_next: true, next_cursor: 'cursor\r\ninjection' },
    { blocks: [], has_next: true, next_cursor: 'x'.repeat(4097) },
  ]) {
    const h = harness(() => response(value));
    await assert.rejects(h.reader.listBlocks(), { code: 'INPOCK_BLOCKS_SCHEMA_INVALID' });
    assert.equal(h.calls.length, 1);
  }
});

test('HTML, malformed JSON and unexpected status cannot masquerade as a successful read', async () => {
  for (const reply of [
    { status: 200, headers: { 'content-type': 'text/html' }, raw: '<html>Login</html>' },
    { status: 200, headers: { 'content-type': 'application/json' }, raw: '{broken' },
    response(page(), 201), response(page(), 500),
  ]) {
    const h = harness(() => reply);
    await assert.rejects(h.reader.listBlocks(), { code: 'INPOCK_RESPONSE_INVALID' });
    assert.equal(h.calls.length, 1);
  }
});

test('explicit authentication, permission and throttling failures do not retry reads', async () => {
  for (const [status, code] of [[401, 'REAUTH_REQUIRED'], [403, 'AUTH_FORBIDDEN'], [429, 'AUTH_THROTTLED']]) {
    for (const operation of ['listBlocks', 'publicProfile', 'miniStats']) {
      const h = harness(() => response({ detail: 'private response omitted' }, status));
      await assert.rejects(h.reader[operation](), error => {
        assert.equal(error.code, code);
        assert.equal(error.receipt.httpStatus, status);
        assert.equal(JSON.stringify(error.receipt).includes('private response omitted'), false);
        return true;
      });
      assert.equal(h.calls.length, 1);
    }
  }
});

test('transport diagnostics are reduced to safe codes and do not retry', async () => {
  for (const cause of [new Error('private transport details'), Object.assign(new Error('private'), { code: 'SCOPED_SESSION_TIMEOUT' })]) {
    const h = harness(() => { throw cause; });
    await assert.rejects(h.reader.listBlocks(), error => {
      assert.equal(error.code, 'INPOCK_TRANSPORT_FAILED');
      assert.equal(error.receipt.causeCode, cause.code ?? 'TRANSPORT_ERROR');
      assert.equal(JSON.stringify(error.receipt).includes('private'), false);
      return true;
    });
    assert.equal(h.calls.length, 1);
  }
});

test('authentication must succeed before a business callback can execute', async () => {
  const auth = { withSession: async () => { throw Object.assign(new Error('REAUTH_REQUIRED'), { code: 'REAUTH_REQUIRED' }); } };
  const reader = createInpockReadClient({ auth });
  for (const operation of ['listBlocks', 'publicProfile', 'miniStats']) {
    await assert.rejects(reader[operation](), { code: 'REAUTH_REQUIRED' });
  }
});

test('public profile routes remain bound to the verified actor and reject another username', async () => {
  const h = harness(url => {
    assert.equal(url.pathname, '/v2/users/owner_test/public');
    assert.equal(url.search, '');
    return response(profile());
  });
  const result = await h.reader.publicProfile({ username: 'another_user' });
  assert.equal(result.profile.username, actor.user.username);
  assert.equal(result.receipt.ownerMatched, true);
  assert.equal(result.receipt.path, '/v2/users/:username/public');
  const mismatch = harness(() => response({ ...profile(), user: { ...profile().user, username: 'another_user' } }));
  await assert.rejects(mismatch.reader.publicProfile(), { code: 'INPOCK_PUBLIC_SCHEMA_INVALID' });
});

test('public profile schemas reject malformed records and another numeric owner', async () => {
  for (const value of [
    null, [], { blocks: [] }, { user: null, blocks: [] },
    { ...profile(), user: { username: actor.user.username } },
    { ...profile(), user: { ...profile().user, user_id: 43 } },
    { ...profile(), blocks: [null] }, { ...profile(), blocks: ['record'] },
  ]) {
    const h = harness(() => response(value));
    await assert.rejects(h.reader.publicProfile(), { code: 'INPOCK_PUBLIC_SCHEMA_INVALID' });
  }
});

test('stats query and returned fields remain bound to the verified actor', async () => {
  const h = harness(url => {
    assert.equal(url.pathname, '/stats/mini');
    assert.deepEqual([...url.searchParams.entries()], [['username', actor.user.username]]);
    return response({ ...stats(), results: { ...stats().results, unrelated_private_field: 'omitted' } });
  });
  const result = await h.reader.miniStats({ username: 'another_user' });
  assert.deepEqual(result.stats, stats().results);
  assert.equal(result.updatedAt, stats().updated_at);
  assert.equal(result.receipt.path, '/stats/mini');
  assert.equal(JSON.stringify(result).includes('unrelated_private_field'), false);
});

test('stats reject missing, negative, fractional and unsafe integer counters', async () => {
  for (const value of [
    null, { results: null, updated_at: stats().updated_at },
    { ...stats(), updated_at: null },
    ...[undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'].map(today => ({ ...stats(), results: { ...stats().results, today } })),
  ]) {
    const h = harness(() => response(value));
    await assert.rejects(h.reader.miniStats(), { code: 'INPOCK_STATS_SCHEMA_INVALID' });
  }
});

test('the real runner rejects writes and actor override options before reading stdin or logging in', () => {
  for (const args of [
    ['publish', '--credentials-stdin'], ['update', '--credentials-stdin'], ['delete', '--credentials-stdin'],
    ['stats', '--username=another_user'], ['public', '--username=another_user'], ['blocks', '--cursor=other-page'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/inpock.mjs', ...args], {
      input: 'deliberately invalid JSON', encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, args[0] === 'stats' || args[0] === 'public' || args[0] === 'blocks' ? 'ARGUMENT_INVALID' : 'COMMAND_NOT_ALLOWED');
    assert.equal(Object.hasOwn(receipt, 'loginReceipt'), false);
  }
});
