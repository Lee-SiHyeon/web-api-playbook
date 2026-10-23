import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createGrokTextRequestBuilder, createGrokTextRequestSubmitter } from '../src/grok-text-request-builder.mjs';

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

function providers(overrides = {}) {
  const suppliedModes = [];
  const suppliedEvents = [];
  let uuidIndex = 0;
  return {
    suppliedModes,
    suppliedEvents,
    builder: createGrokTextRequestBuilder({
      sessionControlProvider: async value => {
        suppliedModes.push(value.selectedModeId);
        return { model: 'grok-4.7', x_grok: { enable_image_generation: false,
          connector_ids: ['connector-a', 'connector-b', 'connector-c'] } };
      },
      requestMetadataProducer: {
        async getConnectionMetadata() {
          return { socketUrl: 'wss://grok.com/ws/mgw/?uid=fixture-uid', headers: { 'x-xai-request-id': 'fixture-request-id' } };
        },
        async prepareOutboundEvent(value) {
          suppliedEvents.push(structuredClone(value));
          return { ...value, castle_request_token: 'fixture-only-castle-token' };
        },
      },
      uuidGenerator: () => UUIDS[uuidIndex++ % UUIDS.length],
      ...overrides,
    }),
  };
}

test('requires a source-derived model session and the injected first-party request-metadata producer', () => {
  assert.throws(() => createGrokTextRequestBuilder({ sessionControlProvider: async () => ({ model: 'grok-4.7' }) }),
    { code: 'TEXT_FIRST_PARTY_REQUEST_METADATA_PRODUCER_REQUIRED' });
  assert.throws(() => createGrokTextRequestBuilder({ requestMetadataProducer: {} }),
    { code: 'TEXT_SESSION_CONTROL_PROVIDER_REQUIRED' });
});

test('builds source-shaped two-phase frames and obtains Castle data only from the injected producer', async () => {
  const fixture = providers();
  const plan = await fixture.builder({ prompt: 'private prompt held in memory', selectedModeId: 'fast' });
  assert.deepEqual(fixture.suppliedModes, ['fast']);
  assert.equal(plan.sessionModel, 'grok-4.7');
  const control = JSON.parse(plan.controlFrameText);
  assert.deepEqual(Object.keys(control), ['event']);
  assert.equal(control.event.type, 'session.create');
  assert.equal(control.event.event_id, `evt_init_${UUIDS[0]}`);
  assert.equal(control.event.session.model, 'grok-4.7');
  assert.equal(control.event.session.x_grok.connector_ids.length, 3);
  assert.equal(plan.controlFrameText.includes('private prompt held in memory'), false);

  const frameText = await plan.buildBusinessFrameText('new-session-from-direct-ack');
  const frame = JSON.parse(frameText);
  assert.equal(frame.session_id, 'new-session-from-direct-ack');
  assert.equal(frame.event.type, 'response.create');
  assert.equal(frame.event.event_id, UUIDS[1]);
  assert.equal(frame.event.castle_request_token, 'fixture-only-castle-token');
  assert.equal(frame.event.item.x_grok.client_message_id, UUIDS[2]);
  assert.deepEqual(frame.event.item.x_grok.input_chunks, [{ text: { text: 'private prompt held in memory' } }]);
  assert.deepEqual(fixture.suppliedEvents[0], {
    type: 'response.create',
    event_id: UUIDS[1],
    item: {
      type: 'message', role: 'user',
      x_grok: { client_message_id: UUIDS[2], input_chunks: [{ text: { text: 'private prompt held in memory' } }] },
    },
  });
  await assert.rejects(plan.buildBusinessFrameText('another-session'), { code: 'TEXT_REQUEST_PLAN_ALREADY_USED' });
  plan.clear();
  assert.equal(plan.socketUrl, null);
  assert.equal(plan.requestMetadataHeaders, null);
  assert.equal(plan.controlFrameText, null);
  await assert.rejects(plan.buildBusinessFrameText('new-session-from-direct-ack'), { code: 'TEXT_REQUEST_PLAN_CLEARED' });
});

test('fails closed for missing fresh Castle output, invalid connection metadata, image controls, and bad input', async () => {
  const noToken = providers({
    requestMetadataProducer: {
      async getConnectionMetadata() { return { socketUrl: 'wss://grok.com/ws/mgw/?uid=fixture-uid' }; },
      async prepareOutboundEvent(value) { return value; },
    },
  });
  const plan = await noToken.builder({ prompt: 'private prompt', selectedModeId: 'auto' });
  await assert.rejects(plan.buildBusinessFrameText('sdk-session-id'), { code: 'TEXT_FIRST_PARTY_CASTLE_TOKEN_UNAVAILABLE' });

  const invalidControl = providers({
    sessionControlProvider: async () => ({ model: 'grok-4.7', x_grok: { enable_image_generation: true } }),
  });
  await assert.rejects(invalidControl.builder({ prompt: 'private prompt', selectedModeId: 'auto' }), { code: 'TEXT_SESSION_CONTROL_SCOPE_INVALID' });

  const invalidSocket = providers({
    requestMetadataProducer: {
      async getConnectionMetadata() { return { socketUrl: 'wss://example.invalid/ws/mgw/?uid=fixture-uid' }; },
      async prepareOutboundEvent(value) { return { ...value, castle_request_token: 'fixture-only-token' }; },
    },
  });
  await assert.rejects(invalidSocket.builder({ prompt: 'private prompt', selectedModeId: 'auto' }), { code: 'TEXT_REQUEST_SOCKET_URL_INVALID' });
  await assert.rejects(providers().builder({ prompt: '  ', selectedModeId: 'auto' }), { code: 'TEXT_REQUEST_PROMPT_INVALID' });
});

test('binds the business frame to the new direct-socket acknowledgement session without a preexisting control ID', async () => {
  const fixture = providers();
  const plan = await fixture.builder({ prompt: 'private prompt', selectedModeId: 'fast' });
  const control = JSON.parse(plan.controlFrameText);
  assert.deepEqual(Object.keys(control), ['event']);
  const frame = JSON.parse(await plan.buildBusinessFrameText('new-session-from-direct-ack'));
  assert.equal(frame.session_id, 'new-session-from-direct-ack');
  assert.equal(fixture.suppliedEvents.length, 1);
});

test('source-built submitter shares the stable text journal and completes only after independent readback', async () => {
  const fixture = providers();
  const entries = [];
  const operationJournal = {
    async begin(entry) {
      const duplicate = entries.find(existing => existing.intentDigest === entry.intentDigest);
      if (duplicate) throw Object.assign(new Error('held'), { code: 'OPERATION_ALREADY_COMPLETED' });
      const result = { localOperationId: '00000000-0000-4000-8000-000000000099', ...entry, state: 'sending' };
      entries.push(result);
      return result;
    },
    async transition(id, state, details = {}) {
      const entry = entries.find(item => item.localOperationId === id);
      Object.assign(entry, { state, ...details });
      return entry;
    },
  };
  const responses = [
    { operationId: 'conversation.list.read', data: { conversations: [] } },
    { operationId: 'conversation.list.read', data: { conversations: [{ conversationId: 'private-new-conversation' }] } },
    { operationId: 'conversation.read', data: { conversation: { conversationId: 'private-new-conversation' } } },
    { operationId: 'history.response-nodes', data: { responseNodes: [{ responseId: 'private-response-id' }] } },
    { operationId: 'history.load-responses', data: { responses: [
      { sender: 'user', message: 'memory-only submit prompt' },
      { sender: 'assistant', message: 'fixture assistant result' },
    ] } },
  ];
  const client = {
    async status() { return { session: { ownerVerified: true } }; },
    async read(operationId) {
      const value = responses.shift();
      assert.equal(value.operationId, operationId);
      return { status: 200, data: value.data };
    },
  };
  const sessionPersistence = {
    async read() {
      return { kind: 'grok-session', session: {
        generation: 1,
        ownerBinding: { generation: 1, identityDigest: 'a'.repeat(64) },
        origins: [{ origin: 'https://grok.com', cookies: [{ name: 'sso', value: 'memory-only-cookie', domain: 'grok.com', path: '/', expiresAt: null }], headers: [] }],
      } };
    },
  };
  let dispatches = 0;
  let businessFrameText;
  const spawnImpl = (_executable, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const packet = JSON.parse(chunk.toString('utf8').trim());
        if (packet.kind === 'start') {
          child.stdout.write(`${JSON.stringify({ kind: 'session_ack', handshakeStatus: 101,
            normalControlFrameSentCount: 1, serverSessionAcknowledgementObserved: true,
            sessionId: 'new-session-from-direct-ack' })}\n`);
        } else if (packet.kind === 'business_frame') {
          dispatches++;
          businessFrameText = packet.frameText;
          child.stdout.write(`${JSON.stringify({ kind: 'result', result: {
            handshakeStatus: 101,
            normalControlFrameSentCount: 1,
            serverSessionAcknowledgementObserved: true,
            businessFrameBoundToServerSession: JSON.parse(packet.frameText).session_id === 'new-session-from-direct-ack',
            businessFrameSentCount: 1,
            eventTypes: ['response.completed'],
            terminalEventObserved: true,
            conversationIdHints: ['private-new-conversation'],
            responseIdHints: [],
          } })}\n`);
          setImmediate(() => {
            child.exitCode = 0;
            child.stdout.end();
            child.emit('close', 0, null);
          });
        }
        callback();
      },
    });
    child.kill = signal => {
      child.signalCode = signal;
      child.stdout.end();
      child.emit('close', null, signal);
      return true;
    };
    return child;
  };
  const submit = createGrokTextRequestSubmitter({
    sessionPersistence,
    operationJournal,
    client,
    requestBuilder: fixture.builder,
    pythonExecutable: 'python-fixture',
    timeoutMs: 1_000,
    spawnImpl,
  });
  const result = await submit({
    prompt: 'memory-only submit prompt',
    selectedModeId: 'fast',
    intentId: 'text-builder-submit-once',
    confirm: true,
    includeContent: true,
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.selectedModeId, 'fast');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.businessOutput.assistantMessage, 'fixture assistant result');
  assert.equal(dispatches, 1);
  assert.equal(JSON.parse(businessFrameText).session_id, 'new-session-from-direct-ack');
  assert.equal(JSON.parse(businessFrameText).event.castle_request_token, 'fixture-only-castle-token');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].contractId, 'chat.text.wss');
  assert.equal(entries[0].state, 'completed');
  assert.equal(JSON.stringify(entries).includes('memory-only submit prompt'), false);
  assert.equal(JSON.stringify(entries).includes('fixture-only-castle-token'), false);
  assert.equal(JSON.stringify(entries).includes('private-new-conversation'), false);
  assert.equal(JSON.stringify(entries).includes('private-response-id'), false);
  await assert.rejects(submit({
    prompt: 'memory-only submit prompt',
    selectedModeId: 'fast',
    intentId: 'text-builder-submit-once',
    confirm: true,
  }), { code: 'OPERATION_ALREADY_COMPLETED' });
  assert.equal(dispatches, 1);
});
