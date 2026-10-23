import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConversationListRequest,
  buildConversationReadRequest,
  GEMINI_RPC,
  GeminiProtocolError,
  parseBatchReply,
  parseConversationList,
  parseConversationRows,
} from '../src/protocol.mjs';

const ID = 'c_0123456789abcdef0123456789abcdef';

function responseFrame(rpcId, payload) {
  const entry = ['wrb.fr', rpcId, JSON.stringify(payload), null, null, null];
  return ")]}'\n" + JSON.stringify([entry]);
}

function rejectedResponseFrame(rpcId) {
  return ")]}'\n" + JSON.stringify([['wrb.fr', rpcId, null, null, null, ['SYNTHETIC_PRIVATE_ERROR']]]);
}

test('conversation list request matches the captured read envelope', () => {
  assert.equal(buildConversationListRequest(), JSON.stringify([[[
    GEMINI_RPC.listConversations, JSON.stringify([24, null, [0, null, 1]]), null, 'generic',
  ]]]));
});

test('conversation read request matches the captured read envelope and validates IDs', () => {
  assert.equal(buildConversationReadRequest(ID), JSON.stringify([[[
    GEMINI_RPC.readConversation, JSON.stringify([ID, 10, null, 1, [0], [4], null, 1]), null, 'generic',
  ]]]));
  assert.throws(() => buildConversationReadRequest('c_not-hex'), (error) => error.code === 'GEMINI_CONVERSATION_ID_INVALID');
});

test('batch parser selects the expected wrb.fr RPC and preserves list titles', () => {
  const title = '  synthetic title  ';
  const payload = [null, null, [[ID, title]]];
  assert.deepEqual(parseConversationList(parseBatchReply(responseFrame(GEMINI_RPC.listConversations, payload), GEMINI_RPC.listConversations)), [
    { id: ID, title },
  ]);
});

test('batch parser rejects a missing or rejected RPC without exposing response content', () => {
  assert.throws(
    () => parseBatchReply(responseFrame('OtherRpc', ['synthetic private body']), GEMINI_RPC.listConversations),
    (error) => error instanceof GeminiProtocolError && error.code === 'GEMINI_RPC_RESULT_MISSING'
      && !error.message.includes('synthetic private body'),
  );
  assert.throws(
    () => parseBatchReply(rejectedResponseFrame(GEMINI_RPC.readConversation), GEMINI_RPC.readConversation),
    (error) => error.code === 'GEMINI_RPC_REJECTED' && !error.message.includes('synthetic private body'),
  );
});

test('conversation list and content parsers reject schema drift and retain opaque rows', () => {
  const rawRows = [['synthetic user text', [1, 'synthetic assistant text']]];
  assert.deepEqual(parseConversationRows([rawRows]), rawRows);
  assert.throws(() => parseConversationList([null, null, [['bad-id', 'title']]]), (error) => error.code === 'GEMINI_CONVERSATION_LIST_SCHEMA');
  assert.throws(() => parseConversationRows([['not-an-array']]), (error) => error.code === 'GEMINI_CONVERSATION_SCHEMA');
});
