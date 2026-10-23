import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeEngagement, readEngagement } from '../x-engagement.mjs';
const payload = (kind, instructions) => ({ data: { [kind + '_timeline']: { timeline: { instructions } } } });
const user = { rest_id: '1', __typename: 'User', core: { screen_name: 'example', name: 'Example' }, is_blue_verified: true, relationship_perspectives: { followed_by: true, following: false }, follow_request_sent: false };
test('actual engagement envelope preserves account identity and relationships', () => {
  for (const kind of ['favoriters', 'retweeters']) {
    const result = decodeEngagement(payload(kind, [{ type: 'TimelineAddEntries', entries: [{ content: { itemContent: { user_results: { result: user } } } }] }]));
    assert.equal(result.items[0].id, '1'); assert.equal(result.items[0].notFollowingBack, true);
  }
});
test('pagination deduplicates accounts and stops on a repeated cursor without claiming exhaustion', async () => {
  const result = await readEngagement('123', 'likes', { withContext: async work => work({ ownerHandle: 'owner', request: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, raw: JSON.stringify(payload('favoriters', [{ entries: [{ content: { itemContent: { user_results: { result: user } } } }, { content: { cursorType: 'Bottom', value: 'next' } }] }])) }) }) });
  assert.equal(result.count, 1); assert.equal(result.pages, 2); assert.equal(result.stopReason, 'repeated_cursor'); assert.equal(result.serverListExhausted, false);
});
