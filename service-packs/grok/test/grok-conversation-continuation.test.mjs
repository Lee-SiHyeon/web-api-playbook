import test from 'node:test';
import assert from 'node:assert/strict';
import { submitCapturedGrokConversationContinuationOnce } from '../src/grok-conversation-continuation.mjs';

const OWNER = 'a'.repeat(64);
const CID = 'conversation-task-1234567890';
const USER_RESPONSE_ID = 'user-response-1234567890';
const ASSISTANT_RESPONSE_ID = 'assistant-response-1234567890';
const ROLE = 'codex-grok-files-20261006';
const PROMPT = 'Create a task-owned neutral file.';

function capture({ fileAttachmentIds = [], conversationId = CID, prompt = PROMPT, initialLoadId } = {}) {
  const controlFrame = { event: { type: 'session.create', event_id: 'control-event-id', session: {
    model: 'grok-3', x_grok: { conversation_id: conversationId, load_existing: true,
      ...(initialLoadId !== undefined ? { initial_load_id: initialLoadId } : {}) },
  } } };
  const item = { type: 'message', role: 'user',
    x_grok: { client_message_id: 'client-message-id', input_chunks: [{ text: { text: prompt } }] },
    ...(fileAttachmentIds.length ? { file_attachment_ids: [...fileAttachmentIds] } : {}) };
  const event = { type: 'response.create', event_id: 'business-event-id', castle_request_token: 'castle-token', item,
    ...(fileAttachmentIds.length ? { file_attachment_ids: [...fileAttachmentIds] } : {}) };
  return {
    sourcePageRole: ROLE,
    browserWriteAbortVerified: true,
    browserBusinessFramesCaptured: 1,
    browserBusinessWritesDelivered: 0,
    browserControlFramesForwarded: 1,
    socketUrl: 'wss://grok.com/ws/mgw/?uid=normal-source-uid',
    controlFrameText: JSON.stringify(controlFrame),
    frameText: JSON.stringify({ session_id: 'captured-server-session', event }),
  };
}

function sessionPersistence() {
  return { async read() { return { kind: 'grok-session', session: {
    generation: 1,
    ownerBinding: { generation: 1, identityDigest: OWNER },
    origins: [{ origin: 'https://grok.com', cookies: [
      { name: 'sso', value: 'in-memory-session', domain: 'grok.com', path: '/', secure: true },
    ], headers: [] }],
  } }; } };
}

function journal() {
  const entries = [];
  return {
    entries,
    async begin(value) { entries.push({ type: 'begin', value }); return { localOperationId: 'operation-1', ...value }; },
    async transition(id, state, metadata) { entries.push({ type: 'transition', id, state, metadata }); },
  };
}

function rowReadback({ fileAttachmentIds = [] } = {}) {
  const detail = { conversation: { conversationId: CID, viewerIsOwner: true, isReadonly: false, accessLevel: 'OWNER' } };
  const nodes = { responseNodes: [
    { responseId: USER_RESPONSE_ID, sender: 'user', parentResponseId: null },
    { responseId: ASSISTANT_RESPONSE_ID, sender: 'assistant', parentResponseId: USER_RESPONSE_ID },
  ], inflightResponses: [] };
  const responses = { responses: [
    { responseId: USER_RESPONSE_ID, sender: 'user', parentResponseId: null, message: PROMPT,
      ...(fileAttachmentIds.length ? {
        file_attachment_ids: [...fileAttachmentIds],
        fileAttachments: [...fileAttachmentIds],
        fileAttachmentsMetadata: fileAttachmentIds.map(assetId => ({ assetId, fileId: assetId,
          fileMetadataId: assetId, fileAttachmentId: assetId, id: assetId, asset_id: assetId,
          file_id: assetId, file_metadata_id: assetId, file_attachment_id: assetId,
          fileName: 'private-task-file.txt' })),
        fileAttachmentAssetMetadata: fileAttachmentIds.map(assetId => ({ assetId, fileMimeType: 'text/plain' })),
        fileIds: [...fileAttachmentIds],
      } : {}) },
    { responseId: ASSISTANT_RESPONSE_ID, sender: 'assistant', parentResponseId: USER_RESPONSE_ID, message: 'Created the neutral file.' },
  ] };
  const queue = [
    { operationId: 'conversation.read', data: detail },
    { operationId: 'history.response-nodes', data: { responseNodes: [], inflightResponses: [] } },
    { operationId: 'conversation.read', data: detail },
    { operationId: 'history.response-nodes', data: nodes },
    { operationId: 'history.load-responses', data: responses },
  ];
  return {
    queue,
    client: {
      async status() { return { session: { ownerVerified: true } }; },
      async read(operationId, input) {
        const next = queue.shift();
        assert.ok(next, `unexpected ${operationId}`);
        assert.equal(next.operationId, operationId);
        assert.equal(input.conversationId, CID);
        return { status: 200, data: next.data, responseBytes: 123, requestDigest: 'b'.repeat(64), rawResponseDigest: 'c'.repeat(64) };
      },
    },
  };
}

function dispatch({ fileAttachmentIds = [] } = {}) {
  const calls = [];
  const impl = async input => {
    calls.push(input);
    return {
      handshakeStatus: 101,
      normalControlFrameSentCount: 1,
      serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true,
      businessFrameSentCount: 1,
      terminalEventObserved: true,
      eventTypes: ['response.completed'],
      privateConversationIdHints: [CID],
      privateResponseIdHints: [ASSISTANT_RESPONSE_ID],
    };
  };
  return { calls, impl };
}

function input(overrides = {}) {
  return {
    client: rowReadback().client,
    sessionPersistence: sessionPersistence(),
    operationJournal: journal(),
    capture: capture(),
    conversationId: CID,
    intentId: 'continuation-intent-one',
    expectedPrompt: PROMPT,
    expectedSourcePageRole: ROLE,
    confirm: true,
    ...overrides,
  };
}

test('continuation requires an owner-bound empty target and completes on exact same-CID user/assistant history', async () => {
  const { client, queue } = rowReadback();
  const operationJournal = journal();
  const { calls, impl } = dispatch();
  const result = await submitCapturedGrokConversationContinuationOnce(input({ client, operationJournal, dispatchImpl: impl }));
  assert.equal(result.operation, 'chat.text.continuation.wss');
  assert.equal(result.state, 'completed');
  assert.equal(result.verified, true);
  assert.equal(result.emptyOwnerTargetVerified, true);
  assert.equal(result.sameConversationReadbackVerified, true);
  assert.equal(result.exactUserPromptMatchCount, 1);
  assert.equal(result.assistantChildOfUserMatched, true);
  assert.equal(result.responseHintMatched, true);
  assert.equal(result.conversationIdSha256.length, 64);
  assert.equal(JSON.stringify(result).includes(CID), false);
  assert.equal(JSON.stringify(result).includes(PROMPT), false);
  assert.equal(calls.length, 1);
  assert.equal(queue.length, 0);
  assert.equal(operationJournal.entries.at(-1).state, 'completed');
});

test('captured file IDs and expected assistant text are checked against the same task history before completion', async () => {
  const fileAttachmentIds = ['uploaded-file-id-1234567890'];
  const { client } = rowReadback({ fileAttachmentIds });
  const operationJournal = journal();
  const { calls, impl } = dispatch();
  const result = await submitCapturedGrokConversationContinuationOnce(input({
    client,
    operationJournal,
    capture: capture({ fileAttachmentIds }),
    fileAttachmentIds,
    expectedAssistantText: 'Created the neutral file.\n',
    dispatchImpl: impl,
  }));
  assert.equal(result.state, 'completed');
  assert.equal(result.fileAttachmentIdsReadbackVerified, true);
  assert.equal(result.fileAttachmentCount, 1);
  assert.equal(result.expectedAssistantTextSha256.length, 64);
  assert.equal(calls.length, 1);
  const forwarded = JSON.parse(calls[0].frameText);
  assert.deepEqual(forwarded.event.file_attachment_ids, fileAttachmentIds);
});

test('preserves a source-captured bounded nonmatching initial_load_id in the exact control frame', async () => {
  const initialLoadId = 'grok-load-opaque-20261006-1234567890';
  const operationJournal = journal();
  const { calls, impl } = dispatch();
  const result = await submitCapturedGrokConversationContinuationOnce(input({
    capture: capture({ initialLoadId }), operationJournal, dispatchImpl: impl,
  }));
  assert.equal(result.state, 'completed');
  assert.equal(calls.length, 1);
  const forwarded = JSON.parse(calls[0].controlFrameText);
  assert.equal(forwarded.event.session.x_grok.initial_load_id, initialLoadId);
});

test('accepts the exact 512-byte UTF-8 initial_load_id boundary unchanged', async () => {
  const initialLoadId = '😀'.repeat(128);
  const operationJournal = journal();
  const { calls, impl } = dispatch();
  const result = await submitCapturedGrokConversationContinuationOnce(input({
    capture: capture({ initialLoadId }), operationJournal, dispatchImpl: impl,
  }));
  assert.equal(result.state, 'completed');
  assert.equal(Buffer.byteLength(JSON.parse(calls[0].controlFrameText).event.session.x_grok.initial_load_id, 'utf8'), 512);
  assert.equal(JSON.parse(calls[0].controlFrameText).event.session.x_grok.initial_load_id, initialLoadId);
});

test('rejects malformed or overlong initial_load_id before journal or WSS dispatch', async () => {
  for (const initialLoadId of [42, 'bad\nvalue', 'x'.repeat(513)]) {
    const operationJournal = journal();
    const { calls, impl } = dispatch();
    await assert.rejects(submitCapturedGrokConversationContinuationOnce(input({
      capture: capture({ initialLoadId }), operationJournal, dispatchImpl: impl,
    })), { code: 'CONVERSATION_CONTINUATION_CONTROL_TARGET_MISMATCH' });
    assert.equal(operationJournal.entries.length, 0);
    assert.equal(calls.length, 0);
  }
});

test('continuation rejects mismatched source frame IDs and nonempty targets before journaling or dispatch', async () => {
  const operationJournal = journal();
  const { calls, impl } = dispatch();
  await assert.rejects(submitCapturedGrokConversationContinuationOnce(input({
    capture: capture({ conversationId: 'other-conversation-1234567890' }),
    operationJournal,
    dispatchImpl: impl,
  })), { code: 'CONVERSATION_CONTINUATION_CONTROL_TARGET_MISMATCH' });
  assert.equal(operationJournal.entries.length, 0);
  assert.equal(calls.length, 0);

  const staleReadClient = {
    async status() { return { session: { ownerVerified: true } }; },
    async read(operationId) {
      if (operationId === 'conversation.read') return { status: 200, data: {
        conversation: { conversationId: CID, viewerIsOwner: true, isReadonly: false },
      } };
      return { status: 200, data: { responseNodes: [{ responseId: 'old-response-1234567890' }], inflightResponses: [] } };
    },
  };
  await assert.rejects(submitCapturedGrokConversationContinuationOnce(input({
    client: staleReadClient, operationJournal, dispatchImpl: impl,
  })), { code: 'CONVERSATION_CONTINUATION_TARGET_NOT_EMPTY' });
  assert.equal(operationJournal.entries.length, 0);
  assert.equal(calls.length, 0);
});

test('transport exception is held as outcome_unknown and is never retried', async () => {
  const { client } = rowReadback();
  const operationJournal = journal();
  let dispatchCount = 0;
  const result = await submitCapturedGrokConversationContinuationOnce(input({
    client,
    operationJournal,
    dispatchImpl: async () => { dispatchCount += 1; throw new Error('private transport failure'); },
  }));
  assert.equal(result.state, 'outcome_unknown');
  assert.equal(result.directBusinessFrameSent, null);
  assert.equal(dispatchCount, 1);
  assert.equal(operationJournal.entries.at(-1).state, 'outcome_unknown');
});
