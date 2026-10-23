import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateThreadsFollowers, buildThreadsFollowersVariables } from '../threads-social.mjs';
const OWNER_ID = '17824859444';
const node = i => ({ node: { pk: String(1000 + i), username: `u${i}`, is_verified: false, text_post_app_is_private: false,
  friendship_status: { followed_by: true, following: i !== 25, outgoing_request: false } } });
const page = (from, to, next) => ({ data: { user: { pk: OWNER_ID, followers: {
  edges: Array.from({ length: to - from }, (_, k) => node(from + k)), page_info: { has_next_page: !!next, end_cursor: next } } } } });
test('followers variables carry the cursor only after page 1', () => {
  assert.equal('after' in buildThreadsFollowersVariables(OWNER_ID), false);
  assert.equal(buildThreadsFollowersVariables(OWNER_ID, 'c1').after, 'c1');
});
test('paginateThreadsFollowers pages until has_next_page is false', async () => {
  const seen = []; const pages = { '': page(0, 20, 'c1'), c1: page(20, 30, null) };
  const r = await paginateThreadsFollowers(async after => { seen.push(after || ''); return { payload: pages[after || ''], receipt: {} }; }, OWNER_ID, 20);
  assert.deepEqual(seen, ['', 'c1']);
  assert.equal(r.followers.length, 30);
  assert.deepEqual(r.followers.filter(f => !f.following).map(f => f.username), ['u25']);
  assert.equal(r.last.page.hasNextPage, false);
});
test('paginateThreadsFollowers stops at maxPages', async () => {
  let n = 0; const r = await paginateThreadsFollowers(async () => { n++; return { payload: page(n * 20, n * 20 + 20, 'c' + n), receipt: {} }; }, OWNER_ID, 3);
  assert.equal(n, 3); assert.equal(r.followers.length, 60);
});
