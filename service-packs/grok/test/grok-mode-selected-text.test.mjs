import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtectedJsonStore } from '../src/protected-json-store.mjs';
import { OperationJournal } from '../src/journal.mjs';
import { createInMemoryGrokModeStore } from '../src/runtime.mjs';
import { GROK_MODEL_SELECTION_SOURCE, createGrokModelSelectionClient } from '../src/grok-model-selection.mjs';
import {
  GROK_SELECTED_MODE_TEXT_SOURCE,
  submitGrokTextInSelectedMode,
  summarizeGrokSelectedModeCapture,
} from '../src/grok-mode-selected-text.mjs';
import { GrokSessionStore } from '../src/session.mjs';

const ROLE = 'codex-grok-model-current-validation-20261006';
const OWNER_DIGEST = 'a'.repeat(64);
const PROMPT = 'What is 21 + 21? Reply with only its decimal result.';
const CATALOG = {
  defaultModeId: 'auto',
  modes: [
    { id: 'auto', title: 'Auto', availability: { available: true } },
    { id: 'fast', title: 'Fast', description: 'Quick responses · Grok 4.7', availability: { available: null } },
    { id: 'expert', title: 'Expert', availability: { available: null } },
    { id: 'heavy', title: 'Heavy', availability: { available: false,
      requiresUpgrade: { minimumSubscriptionTier: 'TIER_SUPERGROK_HEAVY' } } },
  ],
};

function capturedNativeText(model = 'fast', eventOverrides = {}) {
  const control = { event: { event_id: 'evt_init_capture', type: 'session.create', session: {
    model, x_grok: { connector_ids: ['connector-a', 'connector-b', 'connector-c'],
      enable_image_generation: true, image_generation_count: 1, client_side_toolsets: ['connectors-v3'] },
  } } };
  const business = { session_id: 'page-session-placeholder', event: {
    event_id: 'native-event', type: 'response.create', castle_request_token: 'native-castle-token', item: {
      type: 'message', role: 'user', x_grok: { client_message_id: 'native-message',
        input_chunks: [{ text: { text: PROMPT } }] },
    },
    ...eventOverrides,
  } };
  return {
    sourcePageRole: ROLE,
    browserWriteAbortVerified: true,
    browserBusinessFramesCaptured: 1,
    browserBusinessWritesDelivered: 0,
    browserControlFramesForwarded: 1,
    socketUrl: 'wss://grok.com/ws/mgw/?uid=native-connection-uid',
    controlFrameText: JSON.stringify(control),
    frameText: JSON.stringify(business),
  };
}

function selectionEvidence(overrides = {}) {
  return {
    source: 'normal_sdk_mode_menu',
    pageRole: ROLE,
    selectedModeId: 'fast',
    visibleSelectedTitle: 'Fast',
    visibleSelectedMode: true,
    controlEnabled: true,
    userSelectionClicked: true,
    sourceSetterCallsiteVerified: true,
    preferenceWriteForwarded: false,
    ...overrides,
  };
}

async function ownerPersistence() {
  const store = new ProtectedJsonStore({ provider: 'memory' });
  const session = new GrokSessionStore({ store, ownerBindingToken: 'test-owner-binding-token' });
  await session.importBundle({
    schemaVersion: 1, serviceId: 'grok-web', origin: 'https://grok.com',
    capturedAt: new Date().toISOString(), sourceObservationId: 'mode-text-test',
    origins: [{ origin: 'https://grok.com', headers: [], cookies: [
      { name: 'sso', value: 'private-sso-fixture', domain: 'grok.com', path: '/', secure: true, httpOnly: true },
    ] }],
  });
  await session.bindVerifiedOwner('test-owner-binding-token', {
    operationId: 'auth.owner.read', httpStatus: 200, identityMatched: true, identityDigest: OWNER_DIGEST,
  });
  return store;
}

function memoryJournal() {
  return new OperationJournal({ store: new ProtectedJsonStore({ provider: 'memory' }) });
}

function readClient(queue) {
  return {
    async status() { return { session: { ownerVerified: true } }; },
    async read(operationId) {
      const next = queue.shift();
      assert.equal(next.operationId, operationId);
      return { status: 200, data: next.data };
    },
  };
}

function historyQueue() {
  return [
    { operationId: 'conversation.list.read', data: { conversations: [] } },
    { operationId: 'conversation.read', data: { conversation: { conversationId: 'new-mode-text' } } },
    { operationId: 'history.response-nodes', data: { responseNodes: [{ responseId: 'private-response' }] } },
    { operationId: 'history.load-responses', data: { responses: [
      { sender: 'user', message: PROMPT }, { responseId: 'private-response', sender: 'assistant', message: '42' },
    ] } },
  ];
}

test('selected local mode must bind to the normal SDK capture before direct WSS dispatch and history readback', async () => {
  const modeStore = createInMemoryGrokModeStore();
  const modeSelection = createGrokModelSelectionClient({ client: { read: async () => ({ status: 200, data: CATALOG }) }, modeStore });
  const catalog = (await modeSelection.modes()).data;
  let dispatchCount = 0;
  const result = await submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(),
    operationJournal: memoryJournal(),
    client: readClient(historyQueue()),
    modeStore,
    catalog,
    modeId: 'fast',
    expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence(),
    capture: capturedNativeText(),
    expectedPrompt: PROMPT,
    expectedAssistantText: '42',
    intentId: 'mode-fast-neutral-text-new-intent',
    confirm: true,
    dispatchImpl: async () => {
      dispatchCount++;
      return {
        handshakeStatus: 101, normalControlFrameSentCount: 1,
        serverSessionAcknowledgementObserved: true, businessFrameBoundToServerSession: true,
        businessFrameSentCount: 1, eventTypes: ['session.created', 'response.completed'],
        terminalEventObserved: true, privateConversationIdHints: ['new-mode-text'],
        privateResponseIdHints: ['private-response'],
        providerModelMetadata: { requestedSessionModel: 'fast', sessionCreatedModel: 'fast',
          terminalResponseModel: 'grok-4.7', terminalResponseMode: 'fast',
          observedFieldPaths: ['event.session.model', 'event.response.model', 'event.response.modelMode'] },
      };
    },
  });
  assert.equal(dispatchCount, 1);
  assert.equal(result.state, 'completed');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.selectedModeId, 'fast');
  assert.equal(result.selectionSource, 'sdk_state');
  assert.equal(result.serverPreferenceWritePerformed, false);
  assert.equal(result.modeBinding.sessionModel, 'fast');
  assert.equal(result.modeBinding.sessionModelEqualsSelectedModeId, true);
  assert.equal(result.serverSessionAcknowledgementModeEchoed, true);
  assert.equal(result.terminalResponseModeEchoed, true);
  assert.equal(result.modelSelectionAcceptance, 'server_acknowledged_selected_mode_with_exact_history_readback');
  assert.equal(result.exactPromptSha256, createHash('sha256').update(PROMPT, 'utf8').digest('hex'));
  assert.equal(result.readbackConversationIdSha256, createHash('sha256').update('new-mode-text', 'utf8').digest('hex'));
  assert.equal(result.readbackResponseIdHintMatched, true);
  assert.equal(result.providerBackendModelVersion, 'grok-4.7');
  assert.equal(result.providerHonoringSelectedMode, 'terminal_response_mode_echoed');
  assert.equal(JSON.stringify(result).includes('new-mode-text'), false);
  assert.equal(JSON.stringify(result).includes(PROMPT), false);
  assert.equal(JSON.stringify(result).includes('native-castle-token'), false);
  assert.equal(summarizeGrokSelectedModeCapture(result).providerHonoringSelectedMode, 'terminal_response_mode_echoed');
  assert.equal(GROK_MODEL_SELECTION_SOURCE.selectionEffect, 'local_sdk_state_and_local_storage');
  assert.equal(GROK_SELECTED_MODE_TEXT_SOURCE.directOperation, 'chat.text.wss');
});

test('rejects a capture from another local mode before dispatch and leaves the direct journal empty', async () => {
  const modeStore = createInMemoryGrokModeStore();
  const journal = memoryJournal();
  let dispatchCount = 0;
  await assert.rejects(submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(), operationJournal: journal,
    client: readClient(historyQueue()), modeStore, catalog: CATALOG, modeId: 'fast', expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence({ selectedModeId: 'auto', visibleSelectedTitle: 'Auto' }),
    capture: capturedNativeText(), expectedPrompt: PROMPT, intentId: 'mode-fast-mismatch', confirm: true,
    dispatchImpl: async () => { dispatchCount++; return {}; },
  }), { code: 'MODEL_TEXT_SELECTION_CAPTURE_MISMATCH' });
  assert.equal(dispatchCount, 0);
  assert.equal((await journal.list()).length, 0);
});

test('rejects a native session.create model mismatch before dispatch', async () => {
  const modeStore = createInMemoryGrokModeStore();
  const journal = memoryJournal();
  let dispatchCount = 0;
  await assert.rejects(submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(), operationJournal: journal,
    client: readClient(historyQueue()), modeStore, catalog: CATALOG, modeId: 'fast', expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence(), capture: capturedNativeText('expert'), expectedPrompt: PROMPT,
    intentId: 'mode-fast-native-model-mismatch', confirm: true,
    dispatchImpl: async () => { dispatchCount++; return {}; },
  }), { code: 'MODEL_TEXT_SESSION_MODE_MISMATCH' });
  assert.equal(dispatchCount, 0);
  assert.equal((await journal.list()).length, 0);
});

test('accepts normal capability advertisements but rejects actual file/tool effects in response.create', async () => {
  const modeStore = createInMemoryGrokModeStore();
  let dispatchCount = 0;
  await assert.rejects(submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(), operationJournal: memoryJournal(),
    client: readClient(historyQueue()), modeStore, catalog: CATALOG, modeId: 'fast', expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence(),
    capture: capturedNativeText('fast', { file_attachment_ids: ['untrusted-attachment'] }),
    expectedPrompt: PROMPT, intentId: 'mode-fast-business-effect-rejected', confirm: true,
    dispatchImpl: async () => { dispatchCount++; return {}; },
  }), { code: 'MODEL_TEXT_BUSINESS_FRAME_INVALID' });
  assert.equal(dispatchCount, 0);
});

test('does not select Heavy when current catalog reports an upgrade requirement', async () => {
  const modeStore = createInMemoryGrokModeStore();
  let dispatchCount = 0;
  await assert.rejects(submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(), operationJournal: memoryJournal(),
    client: readClient(historyQueue()), modeStore, catalog: CATALOG, modeId: 'heavy', expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence({ selectedModeId: 'heavy', visibleSelectedTitle: 'Heavy' }),
    capture: capturedNativeText(), expectedPrompt: PROMPT, intentId: 'mode-heavy-blocked', confirm: true,
    dispatchImpl: async () => { dispatchCount++; return {}; },
  }), { code: 'MODEL_MODE_NOT_SELECTABLE' });
  assert.equal(dispatchCount, 0);
});

test('reports selected-mode provider honor only when the terminal response echoes the mode id', async () => {
  const modeStore = createInMemoryGrokModeStore();
  const result = await submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(), operationJournal: memoryJournal(),
    client: readClient(historyQueue()), modeStore, catalog: CATALOG, modeId: 'fast', expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence(), capture: capturedNativeText(), expectedPrompt: PROMPT,
    expectedAssistantText: '42', intentId: 'mode-fast-echo-test', confirm: true,
    dispatchImpl: async () => ({
      handshakeStatus: 101, normalControlFrameSentCount: 1, serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true, businessFrameSentCount: 1, eventTypes: ['response.completed'],
      terminalEventObserved: true, privateConversationIdHints: ['new-mode-text'],
      providerModelMetadata: { requestedSessionModel: 'fast', sessionCreatedModel: null,
        terminalResponseModel: null, terminalResponseMode: null, observedFieldPaths: [] },
    }),
  });
  assert.equal(result.serverSessionAcknowledgementModeEchoed, null);
  assert.equal(result.terminalResponseModeEchoed, null);
  assert.equal(result.modelSelectionAcceptance, 'selected_mode_request_accepted_with_exact_history_readback');
  assert.equal(result.providerBackendModelVersion, null);
  assert.equal(result.providerHonoringSelectedMode, 'not_observed');
});

test('accepts an ack-bound selected-mode request with exact history when mode echoes are omitted', async () => {
  const modeStore = createInMemoryGrokModeStore();
  const result = await submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(), operationJournal: memoryJournal(),
    client: readClient(historyQueue()), modeStore, catalog: CATALOG, modeId: 'fast', expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence(), capture: capturedNativeText(), expectedPrompt: PROMPT,
    expectedAssistantText: '42', intentId: 'mode-fast-no-echo-test', confirm: true,
    dispatchImpl: async () => ({
      handshakeStatus: 101, normalControlFrameSentCount: 1, serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true, businessFrameSentCount: 1, eventTypes: ['response.completed'],
      terminalEventObserved: true, privateConversationIdHints: ['new-mode-text'],
    }),
  });
  assert.equal(result.state, 'completed');
  assert.equal(result.serverSessionAcknowledgementModeEchoed, null);
  assert.equal(result.terminalResponseModeEchoed, null);
  assert.equal(result.modelSelectionAcceptance, 'selected_mode_request_accepted_with_exact_history_readback');
  assert.equal(result.providerBackendModelVersion, null);
  assert.equal(result.providerHonoringSelectedMode, 'not_observed');
});

test('does not accept exact history if the server session ACK explicitly echoes another mode', async () => {
  const modeStore = createInMemoryGrokModeStore();
  const result = await submitGrokTextInSelectedMode({
    sessionPersistence: await ownerPersistence(), operationJournal: memoryJournal(),
    client: readClient(historyQueue()), modeStore, catalog: CATALOG, modeId: 'fast', expectedPageRole: ROLE,
    selectionEvidence: selectionEvidence(), capture: capturedNativeText(), expectedPrompt: PROMPT,
    expectedAssistantText: '42', intentId: 'mode-fast-mismatch-ack-test', confirm: true,
    dispatchImpl: async () => ({
      handshakeStatus: 101, normalControlFrameSentCount: 1, serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true, businessFrameSentCount: 1, eventTypes: ['response.completed'],
      terminalEventObserved: true, privateConversationIdHints: ['new-mode-text'],
      providerModelMetadata: { requestedSessionModel: 'fast', sessionCreatedModel: 'expert',
        terminalResponseModel: null, terminalResponseMode: 'expert',
        observedFieldPaths: ['event.session.model', 'event.response.modelMode'] },
    }),
  });
  assert.equal(result.readbackVerified, true);
  assert.equal(result.serverSessionAcknowledgementModeEchoed, false);
  assert.equal(result.terminalResponseModeEchoed, false);
  assert.equal(result.modelSelectionAcceptance, 'not_verified');
  assert.equal(result.providerHonoringSelectedMode, 'terminal_response_mode_mismatch');
});
