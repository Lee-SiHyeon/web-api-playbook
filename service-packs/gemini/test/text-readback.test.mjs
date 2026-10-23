import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTextReadbackConversation } from '../src/text-readback.mjs';

const CID_A = 'c_0123456789abcdef';
const CID_B = 'c_fedcba9876543210';
const START = '2026-10-06T03:30:57.127Z';
const END = '2026-10-06T03:31:00.000Z';

test('text readback prefers the source-decoded conversation ID and never inspects a title', () => {
  const result = selectTextReadbackConversation([
    { conversationId: CID_A, title: 'unrelated title', updatedAt: null },
  ], {
    responseConversationId: CID_A,
    dispatchStartedAt: START,
    responseReceivedAt: END,
  });
  assert.deepEqual(result, {
    state: 'candidate', source: 'response', conversationId: CID_A, historyRowMatched: true, candidateCount: 1,
  });
});

test('text readback falls back to exactly one history timestamp inside the dispatch window', () => {
  const result = selectTextReadbackConversation([
    { conversationId: CID_A, title: 'prompt-shaped title is irrelevant', updatedAt: '2026-10-06T03:30:52.500Z' },
    { conversationId: CID_B, title: 'recent unrelated title', updatedAt: '2026-10-06T03:15:00.000Z' },
  ], { dispatchStartedAt: START, responseReceivedAt: END });
  assert.equal(result.state, 'candidate');
  assert.equal(result.source, 'dispatch_time');
  assert.equal(result.conversationId, CID_A);
  assert.equal(result.candidateCount, 1);
});

test('text readback leaves a multi-row timestamp window unbound', () => {
  const result = selectTextReadbackConversation([
    { conversationId: CID_A, updatedAt: '2026-10-06T03:30:58.000Z' },
    { conversationId: CID_B, updatedAt: '2026-10-06T03:31:01.000Z' },
  ], { dispatchStartedAt: START, responseReceivedAt: END });
  assert.equal(result.state, 'ambiguous');
  assert.equal(result.conversationId, null);
  assert.equal(result.candidateCount, 2);
});

test('text readback does not use a title when response IDs and usable timestamps are absent', () => {
  const result = selectTextReadbackConversation([
    { conversationId: CID_A, title: 'a task-like title that must not be used for matching' },
  ]);
  assert.equal(result.state, 'window_unavailable');
  assert.equal(result.conversationId, null);
});

test('text readback rejects a malformed source response ID without guessing from history', () => {
  const result = selectTextReadbackConversation([
    { conversationId: CID_A, updatedAt: '2026-10-06T03:30:58.000Z' },
  ], {
    responseConversationId: 'bad-id',
    dispatchStartedAt: START,
    responseReceivedAt: END,
  });
  assert.equal(result.state, 'invalid_response_id');
  assert.equal(result.conversationId, null);
});
