import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLoadedResponseBindings, selectExactSearchTarget } from '../scripts/verify-conversations.mjs';

const targetId = 'fixture-target-conversation';
const otherId = 'fixture-other-conversation';

test('search readback uses the exact requested conversation even when another result comes first', () => {
  const target = { conversationId: targetId };
  assert.equal(selectExactSearchTarget([{ conversationId: otherId }, target], targetId), target);
});

test('an unrelated nonempty search result cannot prove the requested conversation was found', () => {
  assert.throws(() => selectExactSearchTarget([{ conversationId: otherId }], targetId),
    { code: 'CONVERSATION_SEARCH_TARGET_NOT_FOUND' });
});

test('loaded response proof rejects unrelated, duplicate, and empty results', () => {
  for (const rows of [[], [{ responseId: 'unrequested' }], [{ responseId: 'requested' }, { responseId: 'requested' }]]) {
    assert.throws(() => assertLoadedResponseBindings(rows, ['requested']), { code: 'HISTORY_LOADED_IDS_NOT_BOUND' });
  }
});

test('a returned subset is bound to requested IDs without claiming all requested responses were returned', () => {
  assert.doesNotThrow(() => assertLoadedResponseBindings([{ responseId: 'requested-2' }], ['requested-1', 'requested-2']));
});
