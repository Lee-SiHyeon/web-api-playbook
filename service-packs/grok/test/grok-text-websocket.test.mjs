import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GrokSessionStore } from '../src/session.mjs';
import { ProtectedJsonStore } from '../src/protected-json-store.mjs';
import { OperationJournal } from '../src/journal.mjs';
import { submitCapturedGrokTextOnce } from '../src/grok-text-websocket.mjs';

const OWNER_DIGEST = 'a'.repeat(64);

function validCapture(overrides = {}) {
  const frame = {
    session_id: 'ephemeral-session-id',
    event: {
      type: 'response.create',
      event_id: 'ephemeral-event-id',
      castle_request_token: 'ephemeral-castle-token',
      item: {
          type: 'message',
          role: 'user',
          x_grok: {
            client_message_id: 'ephemeral-message-id',
            input_chunks: [{ text: { text: 'A private smoke test.' } }],
        },
      },
    },
  };
  const controlFrame = {
    event: {
      event_id: 'captured-control-event-id',
      type: 'session.create',
      session: {
        model: 'grok-3',
        x_grok: {
          accept_interleaved_phases: true,
          client_side_toolsets: [],
          connector_ids: ['fixture-connector-a'],
          disable_artifact: false,
          disable_text_follow_ups: false,
          enable_image_generation: true,
          enable_side_by_side: false,
          force_concise: false,
          force_side_by_side: false,
          image_generation_count: 1,
          protocol_capabilities: [],
          use_chunk: true,
        },
      },
    },
  };
  return {
    socketUrl: 'wss://grok.com/ws/mgw/?uid=ephemeral-uid',
    controlFrameText: JSON.stringify(controlFrame),
    frameText: JSON.stringify(frame),
    sourcePageRole: 'codex-grok-core-20261006',
    browserWriteAbortVerified: true,
    browserBusinessFramesCaptured: 1,
    browserBusinessWritesDelivered: 0,
    browserControlFramesForwarded: 1,
    ...overrides,
  };
}

async function ownerStore({ verified = true } = {}) {
  const protectedStore = new ProtectedJsonStore({ provider: 'memory' });
  const store = new GrokSessionStore({
    store: protectedStore,
    ownerBindingToken: 'test-owner-binding-token',
  });
  await store.importBundle({
    schemaVersion: 1,
    serviceId: 'grok-web',
    origin: 'https://grok.com',
    capturedAt: new Date().toISOString(),
    sourceObservationId: 'grok-text-wss-test',
    origins: [{
      origin: 'https://grok.com',
      cookies: [{ name: 'sso', value: 'synthetic-sso-value', domain: 'grok.com', path: '/', secure: true, httpOnly: true }],
      headers: [],
    }],
  });
  if (verified) {
    await store.bindVerifiedOwner('test-owner-binding-token', {
      operationId: 'auth.owner.read', httpStatus: 200, identityMatched: true, identityDigest: OWNER_DIGEST,
    });
  }
  return protectedStore;
}

function memoryJournal() {
  return new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
}

function fakeClient(queue = [], { ownerVerified = true } = {}) {
  return {
    async status() { return { session: { ownerVerified } }; },
    async read(operationId, input) {
      const next = queue.shift();
      assert.ok(next, `unexpected read ${operationId}`);
      assert.equal(next.operationId, operationId);
      if (next.assertInput) next.assertInput(input);
      return { status: next.status ?? 200, data: next.data };
    },
  };
}

test('text WSS requires a verified owner and an exact one-frame capture before dispatch', async () => {
  const calls = [];
  const operationJournal = memoryJournal();
  await assert.rejects(submitCapturedGrokTextOnce({
    sessionPersistence: await ownerStore({ verified: false }),
    operationJournal,
    client: fakeClient(),
    capture: validCapture(),
    intentId: 'test-private-text-owner-gate',
    confirm: true,
    dispatchImpl: async packet => { calls.push(packet); return {}; },
  }), { code: 'OWNER_VERIFICATION_REQUIRED' });
  assert.equal(calls.length, 0);
  assert.equal((await operationJournal.list()).length, 0);

  await assert.rejects(submitCapturedGrokTextOnce({
    sessionPersistence: await ownerStore(),
    operationJournal,
    client: fakeClient(),
    capture: validCapture({ browserBusinessWritesDelivered: 1 }),
    intentId: 'test-private-text-abort-gate',
    confirm: true,
    dispatchImpl: async packet => { calls.push(packet); return {}; },
  }), { code: 'TEXT_WSS_CAPTURE_NOT_VERIFIED' });
  assert.equal(calls.length, 0);
  assert.equal((await operationJournal.list()).length, 0);
});

test('one captured text frame is sent once and completes only after private readback', async () => {
  const operationJournal = memoryJournal();
  let dispatchCount = 0;
  const prompt = 'A private smoke test.';
  const client = fakeClient([
    { operationId: 'conversation.list.read', data: { conversations: [{ conversationId: 'existing' }] } },
    { operationId: 'conversation.read', data: { conversation: { conversationId: 'new-private-conversation', title: 'Private smoke test' } } },
    { operationId: 'history.response-nodes', data: { responseNodes: [{ responseId: 'user-response' }, { responseId: 'assistant-response' }] } },
    { operationId: 'history.load-responses', data: { responses: [
      { responseId: 'user-response', sender: 'USER', message: prompt },
      { responseId: 'assistant-response', sender: 'GROK', message: 'Hello.' },
    ] } },
  ]);
  const result = await submitCapturedGrokTextOnce({
    sessionPersistence: await ownerStore(),
    operationJournal,
    client,
    capture: validCapture(),
    intentId: 'test-private-text-complete',
    confirm: true,
    dispatchImpl: async packet => {
      dispatchCount++;
      assert.equal(packet.socketUrl.startsWith('wss://grok.com/ws/mgw/?uid='), true);
      assert.equal(packet.cookieHeader.startsWith('sso='), true);
      assert.equal(JSON.parse(packet.controlFrameText).event.type, 'session.create');
      assert.equal(packet.frameText, validCapture().frameText);
      return {
        handshakeStatus: 101,
        normalControlFrameSentCount: 1,
        serverSessionAcknowledgementObserved: true,
        businessFrameBoundToServerSession: true,
        businessFrameSentCount: 1,
        eventTypes: ['response.completed'],
        terminalEventObserved: true,
        terminalMetadata: { eventType: 'response.completed', responseStatus: 'completed', responseStatusReason: null,
          errorClass: null, errorCode: null, responseFieldNames: ['status'], errorFieldNames: [] },
        privateConversationIdHints: ['new-private-conversation'],
        privateResponseIdHints: ['assistant-response'],
      };
    },
  });
  assert.equal(dispatchCount, 1);
  assert.equal(result.state, 'completed');
  assert.equal(result.businessFrameSent, true);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.readbackResponseIdHintMatched, true);
  assert.equal(result.readbackConversationIdSha256,
    createHash('sha256').update('new-private-conversation', 'utf8').digest('hex'));
  assert.equal(result.readbackAssistantResponseIdSha256,
    createHash('sha256').update('assistant-response', 'utf8').digest('hex'));
  assert.deepEqual(result.readbackEvidence, {
    ownerBound: true, listStatus: 200, listResponseBytes: null, windowStart: null, windowEnd: null,
    timestampField: 'conversation.attached.event.conversation.id', candidateCount: 1, candidateReadCount: 1,
    exactPromptCandidateCount: 1, detailStatus: 200, detailResponseBytes: null, responseNodesStatus: 200,
    responseNodesResponseBytes: null, loadResponsesStatus: 200, loadResponsesResponseBytes: null,
    userTurnCount: 1, assistantTurnCount: 1, exactPromptMatched: true,
    assistantExactExpectedTextMatched: true, assistantTextLengthCodePoints: 6,
    assistantTextSha256: createHash('sha256').update('Hello.', 'utf8').digest('hex'),
    conversationIdSha256: createHash('sha256').update('new-private-conversation', 'utf8').digest('hex'),
    assistantResponseIdSha256: createHash('sha256').update('assistant-response', 'utf8').digest('hex'),
    responseIdHintMatched: true,
  });
  assert.ok(/^[a-f0-9]{64}$/.test(result.journalEvidence.requestDigest));
  assert.ok(/^[a-f0-9]{64}$/.test(result.journalEvidence.intentDigest));
  assert.ok(/^[a-f0-9]{64}$/.test(result.journalEvidence.localOperationIdSha256));
  assert.equal(result.terminalMetadata?.eventType, 'response.completed');
  assert.equal(result.terminalMetadata?.responseStatus, 'completed');
  assert.equal(JSON.stringify(result).includes('new-private-conversation'), false);
  assert.equal(JSON.stringify(result).includes('ephemeral-castle-token'), false);
  const entries = await operationJournal.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'completed');
  assert.equal(JSON.stringify(entries[0]).includes('ephemeral-castle-token'), false);
  assert.equal(JSON.stringify(entries[0]).includes('private-conversation-id'), false);
});

test('accepts only the explicitly expected fresh model-validation role and sanitizes actual model echoes', async () => {
  const role = 'codex-grok-model-current-validation-20261006';
  const capture = validCapture({ sourcePageRole: role });
  const result = await submitCapturedGrokTextOnce({
    sessionPersistence: await ownerStore(),
    operationJournal: memoryJournal(),
    client: fakeClient([
      { operationId: 'conversation.list.read', data: { conversations: [] } },
      { operationId: 'conversation.read', data: { conversation: { conversationId: 'new-mode-text' } } },
      { operationId: 'history.response-nodes', data: { responseNodes: [{ responseId: 'response' }] } },
      { operationId: 'history.load-responses', data: { responses: [
        { sender: 'user', message: 'A private smoke test.' }, { responseId: 'response', sender: 'assistant', message: '42' },
      ] } },
    ]),
    capture,
    expectedSourcePageRole: role,
    intentId: 'test-model-mode-direct-text',
    confirm: true,
    expectedAssistantText: '42',
    dispatchImpl: async () => ({
      handshakeStatus: 101,
      normalControlFrameSentCount: 1,
      serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true,
      businessFrameSentCount: 1,
      eventTypes: ['session.created', 'response.completed'],
      terminalEventObserved: true,
      privateConversationIdHints: ['new-mode-text'],
      providerModelMetadata: {
        requestedSessionModel: 'grok-3',
        sessionCreatedModel: 'grok-4.7',
        terminalResponseModel: 'grok-4.7',
        terminalResponseMode: 'fast',
        observedFieldPaths: ['event.session.model', 'event.response.model', 'event.response.modelMode', 'private.path'],
      },
    }),
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.readbackVerified, true);
  assert.deepEqual(result.providerModelMetadata, {
    requestedSessionModel: 'grok-3',
    sessionCreatedModel: 'grok-4.7',
    terminalResponseModel: 'grok-4.7',
    terminalResponseMode: 'fast',
    observedFieldPaths: ['event.session.model', 'event.response.model', 'event.response.modelMode'],
  });
  assert.equal(JSON.stringify(result).includes('new-mode-text'), false);
  assert.equal(JSON.stringify(result).includes('private smoke test'), false);
});

test('does not accept another page role just because its capture has the same event shape', async () => {
  const capture = validCapture({ sourcePageRole: 'codex-grok-model-current-validation-20261006' });
  await assert.rejects(submitCapturedGrokTextOnce({
    sessionPersistence: await ownerStore(),
    operationJournal: memoryJournal(),
    client: fakeClient(),
    capture,
    intentId: 'test-model-mode-role-mismatch',
    confirm: true,
    dispatchImpl: async () => { throw new Error('should not dispatch'); },
  }), { code: 'TEXT_WSS_CAPTURE_NOT_VERIFIED' });
});

test('a bounded owner-list candidate cannot prove a write without exact task detail/history', async () => {
  const operationJournal = memoryJournal();
  let dispatchCount = 0;
  const reads = [
    { operationId: 'conversation.list.read', data: { conversations: [{ conversationId: 'existing' }] } },
    { operationId: 'conversation.list.read', data: { conversations: [{ conversationId: 'new-private-conversation' }, { conversationId: 'existing' }] } },
    { operationId: 'conversation.read', data: { conversation: {} } },
  ];
  const client = fakeClient(reads);
  const options = {
    sessionPersistence: await ownerStore(),
    operationJournal,
    client,
    capture: validCapture(),
    intentId: 'test-private-text-uncertain',
    confirm: true,
    dispatchImpl: async () => {
      dispatchCount++;
      return { handshakeStatus: 101, normalControlFrameSentCount: 1, serverSessionAcknowledgementObserved: true,
        businessFrameBoundToServerSession: true, businessFrameSentCount: 1, eventTypes: [], terminalEventObserved: false, privateConversationIdHints: [] };
    },
  };
  const first = await submitCapturedGrokTextOnce(options);
  assert.equal(first.state, 'outcome_unknown');
  assert.equal(first.businessFrameSent, true);
  assert.equal(dispatchCount, 1);
  assert.equal(first.readbackVerified, false);
  assert.equal(reads.length, 0, 'bounded candidate is read but its incomplete detail does not prove the task');
  await assert.rejects(submitCapturedGrokTextOnce(options), { code: 'OPERATION_ALREADY_HELD' });
  assert.equal(dispatchCount, 1);
  assert.equal((await operationJournal.list())[0].state, 'outcome_unknown');
});

test('text WSS capture rejects unknown hosts and invalid business event frames before journaling', async () => {
  const operationJournal = memoryJournal();
  const sessionPersistence = await ownerStore();
  const capture = validCapture({ socketUrl: 'wss://example.invalid/ws/mgw/?uid=uid' });
  await assert.rejects(submitCapturedGrokTextOnce({
    sessionPersistence, operationJournal, client: fakeClient(), capture, intentId: 'test-private-text-host', confirm: true,
    dispatchImpl: async () => { throw new Error('should not dispatch'); },
  }), { code: 'TEXT_WSS_SOCKET_URL_INVALID' });
  const invalidFrame = validCapture({ frameText: JSON.stringify({ event: { type: 'response.create' } }) });
  await assert.rejects(submitCapturedGrokTextOnce({
    sessionPersistence, operationJournal, client: fakeClient(), capture: invalidFrame, intentId: 'test-private-text-frame', confirm: true,
    dispatchImpl: async () => { throw new Error('should not dispatch'); },
  }), { code: 'TEXT_WSS_FRAME_SCHEMA_INVALID' });
  assert.equal((await operationJournal.list()).length, 0);
});

test('text WSS accepts normal image capability advertisement but rejects actual file effects', async () => {
  const operationJournal = memoryJournal();
  const capture = validCapture();
  const frame = JSON.parse(capture.frameText);
  frame.event.file_attachment_ids = ['untrusted-attachment'];
  capture.frameText = JSON.stringify(frame);
  let dispatchCount = 0;
  await assert.rejects(submitCapturedGrokTextOnce({
    sessionPersistence: await ownerStore(), operationJournal, client: fakeClient(), capture,
    intentId: 'test-text-actual-file-effect', confirm: true,
    dispatchImpl: async () => { dispatchCount++; return {}; },
  }), { code: 'TEXT_WSS_FRAME_SCHEMA_INVALID' });
  assert.equal(dispatchCount, 0);
  assert.equal((await operationJournal.list()).length, 0);
});
