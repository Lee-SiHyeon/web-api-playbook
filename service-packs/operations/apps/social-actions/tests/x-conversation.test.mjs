import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeConversation } from '../x-conversation.mjs';
test('current v2 detail envelope decodes focal and module replies without recursively including quoted tweets', () => {
  const tweet = (id,parent=null) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: { result: { rest_id: '200', core: { screen_name: 'host' }, is_blue_verified: true, privacy: { protected: false } } } }, legacy: { full_text: 'Follow back please', created_at: 'Wed Sep 30 12:00:00 +0000 2026', in_reply_to_status_id_str: parent } });
  const focal = tweet('100'); focal.quoted_status_result = { result: tweet('999') };
  const result = decodeConversation({ data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [
    { content: { itemContent: { tweet_results: { result: focal } } } },
    { content: { items: [{ item: { itemContent: { tweet_results: { result: tweet('101','100') } } } }] } }
  ] }] } } });
  assert.deepEqual(result.items.map(p=>p.id), ['100','101']); assert.equal(result.items[1].replyToId, '100');
  assert.throws(() => decodeConversation({ data: {} }), { code: 'X_CONVERSATION_SCHEMA' });
});
