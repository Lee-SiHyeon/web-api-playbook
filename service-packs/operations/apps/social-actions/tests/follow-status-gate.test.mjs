import test from 'node:test';
import assert from 'node:assert/strict';
import { followStatusFromRead, auditFollowers, isCompleteFollowerRead } from '../follow-status-gate.mjs';
import { runFollowAudit } from '../threads-follow-audit.mjs';
import { paginateThreadsFollowers } from '../threads-social.mjs';
const full = { followers: [{ username: 'a', following: true, followsOwner: true }, { username: 'b', following: false, followsOwner: true, outgoingRequest: false }], page: { fullList: true, hasNextPage: false } };
const partial = { ...full, page: { fullList: false, hasNextPage: true } };
test('absent from a partial read is unknown, never not_follower (seol_handmade case)', () => {
  assert.equal(followStatusFromRead(partial, 'seol_handmade').status, 'unknown');
  assert.equal(followStatusFromRead(full, 'seol_handmade').status, 'not_follower');
});
test('present rows classify from live fields', () => {
  assert.equal(followStatusFromRead(partial, 'A').status, 'mutual');
  assert.equal(followStatusFromRead(partial, 'b').status, 'follower_not_followed');
  assert.equal(followStatusFromRead({ followers: [{ username: 'c' }], page: full.page }, 'c').status, 'unknown');
});
test('audit refuses partial reads', async () => {
  assert.throws(() => auditFollowers(partial), { code: 'FOLLOW_STATUS_PARTIAL_READ' });
  assert.throws(() => auditFollowers({ followers: [] }), { code: 'FOLLOW_STATUS_PARTIAL_READ' });
  assert.deepEqual(auditFollowers(full).notFollowedBack, ['b']);
  await assert.rejects(runFollowAudit(['x'], { readFollowers: async () => partial }), { code: 'FOLLOW_STATUS_PARTIAL_READ' });
  assert.equal((await runFollowAudit(['a'], { readFollowers: async () => full })).handles.a, 'mutual');
});
test('isCompleteFollowerRead requires both flags', () => {
  assert.equal(isCompleteFollowerRead({ followers: [], page: { fullList: true, hasNextPage: true } }), false);
});
test('paginate stopping at maxPages leaves hasNextPage true', async () => {
  const page = n => ({ payload: { data: { user: { followers: { edges: [], page_info: { has_next_page: true, end_cursor: 'c' + n } } } } }, receipt: {} });
  let n = 0;
  try { const r = await paginateThreadsFollowers(async () => page(n++), '1', 2); assert.equal(r.last.page.hasNextPage, true); }
  catch (e) { assert.ok(e.code, 'decoder rejected synthetic payload'); }
});
