import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFollowers, readFollowers } from '../x-followers.mjs';
const user = (id, following, pending = false, followsMe = true) => ({ content: { itemContent: { user_results: { result: { __typename: 'User', rest_id: String(id), core: { screen_name: 'user' + id, name: 'User ' + id }, relationship_perspectives: { following, followed_by: followsMe }, follow_request_sent: pending } } } } });
const data = (entries, cursor) => ({ data: { user: { result: { timeline: { timeline: { instructions: [{ entries: [...entries, ...(cursor ? [{ content: { cursorType: 'Bottom', value: cursor } }] : [])] }] } } } } } });
test('only explicit incoming followers without outgoing follow or pending request are unmatched', () => {
  const result = decodeFollowers(data([user(1, true), user(2, false), user(3, false, true), user(4, undefined), user(5, false, false, false)], 'next'));
  assert.deepEqual(result.items.filter(u => u.notFollowingBack).map(u => u.id), ['2']);
  assert.equal(result.items.find(u => u.id === '4').relationshipKnown, false);
  assert.equal(result.cursor, 'next');
});
test('pagination deduplicates users, preserves full-scan counts when filtering, and follows observed cursors', async () => {
  const calls = []; let i = 0;
  const result = await readFollowers({ onlyNotFollowingBack: true }, { contract: { origin: 'https://x.com', path: '/i/api/graphql/fixture/Followers', variables: { count: 20, includePromotedContent: false, withGrokTranslatedBio: true }, features: {} },
    withContext: async work => work({ ownerHandle: 'owner', lookupUser: async () => ({ userId: '123' }), request: async (method, path, rawUrl) => {
      calls.push(JSON.parse(new URL(rawUrl).searchParams.get('variables')));
      return { status: 200, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(i++ === 0 ? data([user(1, true), user(2, false)], 'page2') : data([user(2, false), user(3, false, true)])) };
    } }) });
  assert.deepEqual(result.items.map(u => u.id), ['2']);
  assert.equal(calls[1].cursor, 'page2');
  assert.equal(result.followerCountRead, 3);
  assert.equal(result.mutualCount, 1);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.complete, true);
  assert.equal(result.writes, 0);
});
test('repeated cursors and page limits remain partial, and malformed schemas fail closed', async () => {
  assert.throws(() => decodeFollowers({}), /X_FOLLOWERS_SCHEMA/);
  const result = await readFollowers({ maxPages: 3 }, { contract: { origin: 'https://x.com', path: '/i/api/graphql/fixture/Followers', variables: {}, features: {} }, withContext: async work => work({ ownerHandle: 'owner', lookupUser: async () => ({ userId: '123' }), request: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(data([user(2, false)], 'same')) }) }) });
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'repeated_cursor');
  assert.equal(result.pages, 2);
});
test('Bottom terminator is authoritative even when a bottom cursor remains', () => {
  const response = data([user(1, false)], 'stale');
  response.data.user.result.timeline.timeline.instructions.push({ type: 'TimelineTerminateTimeline', direction: 'Bottom' });
  assert.equal(decodeFollowers(response).terminatedBottom, true);
});
test('current source contract replaces the saved follower query ID and feature set',async()=>{
 const result=await readFollowers({}, {contract:{origin:'https://x.com',path:'/i/api/graphql/saved/Followers',variables:{count:20},features:{}},withContext:async work=>work({ownerHandle:'owner',followersContract:{queryId:'current',features:{flag:false},missing:[]},lookupUser:async()=>({userId:'123'}),request:async(method,route,url)=>{
  assert.equal(route,'/i/api/graphql/current/Followers');assert.deepEqual(JSON.parse(new URL(url).searchParams.get('features')),{flag:false});
  return{status:200,headers:{'content-type':'application/json'},raw:JSON.stringify(data([user(1,false)]))};
 }})});assert.equal(result.complete,true);
});
