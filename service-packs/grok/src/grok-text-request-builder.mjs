import { createHash, randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { prepareGrokOutboundEvent } from './grok-castle-event-preparer.mjs';
import { boundCredentials, GROK_WEB_ORIGIN } from './session.mjs';
import { createPythonGrokTextRequestDispatcher } from './grok-text-request-dispatcher.mjs';

export const GROK_TEXT_REQUEST_BUILDER_SOURCE = Object.freeze({
  sessionCreateEventId: 'evt_init_${crypto.randomUUID()}',
  ackBoundBusinessSessionField: 'session_id',
  userEventId: 'crypto.randomUUID()',
  clientMessageId: 'crypto.randomUUID()',
  inputPath: 'event.item.x_grok.input_chunks[].text.text',
  sessionModelField: 'event.session.model',
  castleField: 'event.castle_request_token',
});

const MODEL_MODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOCKET_PATH = '/ws/mgw/';
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_X_GROK_FIELDS = new Set([
  'accept_interleaved_phases', 'client_side_toolsets', 'connector_ids', 'conversation_id', 'disable_artifact',
  'disable_text_follow_ups', 'enable_image_generation', 'enable_side_by_side', 'force_concise',
  'force_side_by_side', 'image_generation_count', 'initial_load_id', 'load_existing', 'protocol_capabilities', 'use_chunk',
]);
const REQUEST_METADATA_HEADERS = new Set(['x-statsig-id', 'x-xai-request-id']);
const OPERATION_ID = 'chat.text.wss';
const TERMINAL_EVENTS = new Set(['response.completed', 'response.done', 'response.finished', 'response.error']);
const MAX_READBACK_ATTEMPTS = 5;
const READBACK_INTERVAL_MS = 1500;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function validEventTypes(value) {
  if (!Array.isArray(value) || value.length > 128
    || value.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_.-]{0,95}$/.test(item))) {
    throw fail('TEXT_WSS_RESULT_INVALID');
  }
  return [...new Set(value)];
}

async function readClientJson(client, operationId, input) {
  const result = await client.read(operationId, input);
  if (result?.status !== 200 || !plainObject(result.data)) throw fail('TEXT_WSS_READBACK_HTTP_FAILED');
  return result.data;
}

function conversationIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => item?.conversationId)
    .filter(id => typeof id === 'string' && id && id.length <= 512 && !/[\r\n\0]/.test(id)))];
}

function isUserSender(value) {
  return typeof value === 'string' && ['user', 'human', 'you'].includes(value.trim().toLowerCase());
}

async function verifyTextReadback({ client, baselineIds, privateConversationIdHints, expectedPrompt, expectedAssistantText }) {
  const hints = new Set(privateConversationIdHints);
  for (let attempt = 0; attempt < MAX_READBACK_ATTEMPTS; attempt++) {
    let list;
    try { list = await readClientJson(client, 'conversation.list.read', { pageSize: 24 }); } catch { return { verified: false }; }
    const newIds = conversationIds(list.conversations).filter(id => !baselineIds.has(id));
    const candidates = hints.size ? newIds.filter(id => hints.has(id)) : newIds;
    if (candidates.length === 1) {
      const conversationId = candidates[0];
      try {
        const detail = await readClientJson(client, 'conversation.read', { conversationId });
        const conversation = detail.conversation;
        if (!plainObject(conversation) || conversation.conversationId !== conversationId) return { verified: false };
        const nodeData = await readClientJson(client, 'history.response-nodes', { conversationId });
        const nodes = Array.isArray(nodeData.responseNodes) ? nodeData.responseNodes : [];
        const responseIds = [...new Set(nodes.map(item => item?.responseId)
          .filter(id => typeof id === 'string' && id && id.length <= 512))];
        if (!responseIds.length || responseIds.length > 256) return { verified: false };
        const loaded = await readClientJson(client, 'history.load-responses', { conversationId, responseIds });
        const responses = Array.isArray(loaded.responses) ? loaded.responses : [];
        const userMatched = responses.some(item => isUserSender(item?.sender) && item?.message === expectedPrompt);
        const assistantMessages = responses.filter(item => !isUserSender(item?.sender)
          && typeof item?.sender === 'string' && item.sender.trim()
          && typeof item?.message === 'string' && item.message.trim()).map(item => item.message);
        const assistantMessage = assistantMessages.find(message => expectedAssistantText === undefined
          || message.trim() === expectedAssistantText.trim());
        if (userMatched && assistantMessage) return { verified: true, assistantMessage };
        return { verified: false };
      } catch { return { verified: false }; }
    }
    if (candidates.length > 1) return { verified: false };
    if (attempt + 1 < MAX_READBACK_ATTEMPTS) await sleep(READBACK_INTERVAL_MS);
  }
  return { verified: false };
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || /\0/.test(prompt)
    || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) throw fail('TEXT_REQUEST_PROMPT_INVALID');
  return prompt;
}

function nextUuid(uuidGenerator) {
  let value;
  try { value = uuidGenerator(); } catch { throw fail('TEXT_REQUEST_UUID_GENERATOR_FAILED'); }
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('TEXT_REQUEST_UUID_INVALID');
  return value;
}

function validateSocketUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('TEXT_REQUEST_SOCKET_URL_INVALID'); }
  const queryKeys = [...url.searchParams.keys()];
  if (url.protocol !== 'wss:' || url.hostname !== 'grok.com' || url.port || url.username || url.password
    || url.pathname !== SOCKET_PATH || url.hash || queryKeys.length !== 1 || queryKeys[0] !== 'uid'
    || !url.searchParams.get('uid') || url.searchParams.getAll('uid').length !== 1) {
    throw fail('TEXT_REQUEST_SOCKET_URL_INVALID');
  }
  return url.href;
}

function safeRequestMetadataHeaders(value) {
  if (value === undefined) return Object.freeze({});
  if (!plainObject(value) || Object.keys(value).some(key => !REQUEST_METADATA_HEADERS.has(key.toLowerCase()))) {
    throw fail('TEXT_REQUEST_METADATA_HEADERS_INVALID');
  }
  const headers = {};
  for (const [key, header] of Object.entries(value)) {
    if (typeof header !== 'string' || !header.trim() || header.length > 2_048 || /[\r\n\0]/.test(header)) {
      throw fail('TEXT_REQUEST_METADATA_HEADERS_INVALID');
    }
    headers[key.toLowerCase()] = header;
  }
  return Object.freeze(headers);
}

function validateSessionControl(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['model', 'x_grok'].includes(key))
    || typeof value.model !== 'string' || !SESSION_MODEL.test(value.model)) {
    throw fail('TEXT_SESSION_CONTROL_INVALID');
  }
  const session = { model: value.model };
  if (value.x_grok !== undefined) {
    const xGrok = value.x_grok;
    if (!plainObject(xGrok) || Object.keys(xGrok).some(key => !MAX_X_GROK_FIELDS.has(key))) {
      throw fail('TEXT_SESSION_CONTROL_INVALID');
    }
    if ((xGrok.conversation_id !== undefined && xGrok.conversation_id !== null)
      || (xGrok.initial_load_id !== undefined && xGrok.initial_load_id !== null)
      || (xGrok.load_existing !== undefined && xGrok.load_existing !== false)
      || (xGrok.enable_image_generation !== undefined && xGrok.enable_image_generation !== false)
      || (xGrok.image_generation_count !== undefined && xGrok.image_generation_count !== 0)
      || (xGrok.connector_ids !== undefined && (!Array.isArray(xGrok.connector_ids) || xGrok.connector_ids.length > 64
        || xGrok.connector_ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 512 || /[\r\n\0]/.test(id))))) {
      throw fail('TEXT_SESSION_CONTROL_SCOPE_INVALID');
    }
    try { session.x_grok = structuredClone(xGrok); } catch { throw fail('TEXT_SESSION_CONTROL_INVALID'); }
  }
  return session;
}

function validateServerSessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw fail('TEXT_SERVER_SESSION_ID_INVALID');
  }
  return value;
}

function validateRequestPlan(plan, selectedModeId) {
  if (!plainObject(plan) || plan.operationId !== OPERATION_ID || plan.selectedModeId !== selectedModeId
    || typeof plan.sessionModel !== 'string' || !SESSION_MODEL.test(plan.sessionModel)
    || typeof plan.controlFrameText !== 'string' || Buffer.byteLength(plan.controlFrameText, 'utf8') > 64 * 1024
    || typeof plan.socketUrl !== 'string' || !plainObject(plan.requestMetadataHeaders)
    || typeof plan.buildBusinessFrameText !== 'function') {
    throw fail('TEXT_REQUEST_PLAN_INVALID');
  }
  const socketUrl = validateSocketUrl(plan.socketUrl);
  let control;
  try { control = JSON.parse(plan.controlFrameText); } catch { throw fail('TEXT_REQUEST_PLAN_INVALID'); }
  const event = control?.event;
  if (JSON.stringify(Object.keys(control).sort()) !== JSON.stringify(['event'])
    || !plainObject(event) || event.type !== 'session.create'
    || typeof event.event_id !== 'string' || !event.event_id.startsWith('evt_init_')
    || event.session?.model !== plan.sessionModel) throw fail('TEXT_REQUEST_PLAN_INVALID');
  return {
    socketUrl,
    controlFrameText: plan.controlFrameText,
    requestMetadataHeaders: safeRequestMetadataHeaders(plan.requestMetadataHeaders),
  };
}

/**
 * Create a one-use, source-native WSS text request plan.
 * The mode-to-session model mapping and Castle event preparer must come from
 * injected first-party adapters; this module supplies no token or account data.
 */
export function createGrokTextRequestBuilder({ sessionControlProvider, requestMetadataProducer, uuidGenerator = randomUUID } = {}) {
  if (typeof sessionControlProvider !== 'function') throw fail('TEXT_SESSION_CONTROL_PROVIDER_REQUIRED');
  if (!requestMetadataProducer || typeof requestMetadataProducer.prepareOutboundEvent !== 'function'
    || typeof requestMetadataProducer.getConnectionMetadata !== 'function') {
    throw fail('TEXT_FIRST_PARTY_REQUEST_METADATA_PRODUCER_REQUIRED');
  }
  if (typeof uuidGenerator !== 'function') throw fail('TEXT_REQUEST_UUID_GENERATOR_INVALID');

  return async function build({ prompt, selectedModeId } = {}) {
    const message = validatePrompt(prompt);
    if (typeof selectedModeId !== 'string' || !MODEL_MODE_ID.test(selectedModeId)) throw fail('MODEL_MODE_ID_INVALID');
    let sessionControl;
    try { sessionControl = await sessionControlProvider({ selectedModeId }); }
    catch { throw fail('TEXT_SESSION_CONTROL_PROVIDER_FAILED'); }
    let connectionMetadata;
    try { connectionMetadata = await requestMetadataProducer.getConnectionMetadata(); }
    catch { throw fail('TEXT_REQUEST_METADATA_PRODUCER_FAILED'); }
    const session = validateSessionControl(sessionControl);
    if (!plainObject(connectionMetadata) || Object.keys(connectionMetadata).some(key => !['socketUrl', 'headers'].includes(key))) {
      throw fail('TEXT_REQUEST_CONNECTION_METADATA_INVALID');
    }
    let socketUrlInMemory = validateSocketUrl(connectionMetadata.socketUrl);
    let requestMetadataHeadersInMemory = safeRequestMetadataHeaders(connectionMetadata.headers);
    let controlFrameTextInMemory = JSON.stringify({
      event: {
        type: 'session.create',
        event_id: `evt_init_${nextUuid(uuidGenerator)}`,
        session,
      },
    });

    let promptInMemory = message;
    let businessFrameBuilt = false;
    let planCleared = false;
    return Object.freeze({
      operationId: 'chat.text.wss',
      selectedModeId,
      sessionModel: session.model,
      get socketUrl() { return socketUrlInMemory; },
      get requestMetadataHeaders() { return requestMetadataHeadersInMemory; },
      get controlFrameText() { return controlFrameTextInMemory; },
      async buildBusinessFrameText(serverSessionId) {
        if (planCleared) throw fail('TEXT_REQUEST_PLAN_CLEARED');
        if (businessFrameBuilt || promptInMemory === null) throw fail('TEXT_REQUEST_PLAN_ALREADY_USED');
        businessFrameBuilt = true;
        const text = promptInMemory;
        promptInMemory = null;
        const serverId = validateServerSessionId(serverSessionId);
        const baseEvent = {
          type: 'response.create',
          event_id: nextUuid(uuidGenerator),
          item: {
            type: 'message',
            role: 'user',
            x_grok: {
              client_message_id: nextUuid(uuidGenerator),
              input_chunks: [{ text: { text } }],
            },
          },
        };
        const preparedEvent = await prepareGrokOutboundEvent(baseEvent, { requestMetadataProducer });
        return JSON.stringify({ session_id: serverId, event: preparedEvent });
      },
      clear() {
        planCleared = true;
        promptInMemory = null;
        socketUrlInMemory = null;
        requestMetadataHeadersInMemory = null;
        controlFrameTextInMemory = null;
      },
    });
  };
}

/** Create a journaled one-shot submit path around a dynamic ack-bound dispatcher. */
export function createGrokTextRequestSubmitter({
  sessionPersistence,
  operationJournal,
  client,
  requestBuilder,
  dispatchImpl,
  pythonExecutable,
  timeoutMs,
  spawnImpl,
} = {}) {
  if (typeof sessionPersistence?.read !== 'function'
    || typeof operationJournal?.begin !== 'function' || typeof operationJournal?.transition !== 'function'
    || typeof client?.status !== 'function' || typeof client?.read !== 'function'
    || typeof requestBuilder !== 'function'
    || dispatchImpl !== undefined && typeof dispatchImpl !== 'function') {
    throw fail('TEXT_REQUEST_SUBMITTER_REQUIRED');
  }
  const dispatcher = dispatchImpl ?? createPythonGrokTextRequestDispatcher({ pythonExecutable, timeoutMs, spawnImpl });

  return async function submit({
    prompt,
    selectedModeId,
    intentId,
    confirm = false,
    includeContent = false,
    expectedAssistantText,
  } = {}) {
    if (confirm !== true) throw fail('TEXT_WSS_CONFIRMATION_REQUIRED');
    const message = validatePrompt(prompt);
    if (typeof intentId !== 'string' || !intentId.trim() || intentId.length > 256 || /[\r\n\0]/.test(intentId)) {
      throw fail('TEXT_WSS_INTENT_ID_INVALID');
    }
    if (typeof includeContent !== 'boolean') throw fail('TEXT_WSS_RESULT_INVALID');
    if (typeof selectedModeId !== 'string' || !MODEL_MODE_ID.test(selectedModeId)) throw fail('MODEL_MODE_ID_INVALID');
    if (expectedAssistantText !== undefined
      && (typeof expectedAssistantText !== 'string' || !expectedAssistantText.trim() || expectedAssistantText.length > 4_096)) {
      throw fail('TEXT_WSS_EXPECTED_RESPONSE_INVALID');
    }

    const stored = await sessionPersistence.read();
    const session = stored?.session;
    if (stored?.kind !== 'grok-session' || !session || session.generation !== session.ownerBinding?.generation
      || typeof session.ownerBinding?.identityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(session.ownerBinding.identityDigest)) {
      throw fail('OWNER_VERIFICATION_REQUIRED');
    }
    if ((await client.status())?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
    const bound = boundCredentials(session, GROK_WEB_ORIGIN, SOCKET_PATH, { cookieNames: ['sso'], headerNames: [] });

    const plan = await requestBuilder({ prompt: message, selectedModeId });
    let validatedPlan;
    try { validatedPlan = validateRequestPlan(plan, selectedModeId); } catch (error) {
      plan?.clear?.();
      throw error;
    }
    const requestDigest = sha256(`${OPERATION_ID}\n${plan.selectedModeId}\n${plan.sessionModel}\n${sha256(message)}\n${sha256(validatedPlan.controlFrameText)}`);
    const intentDigest = sha256(`${OPERATION_ID}\n${session.ownerBinding.identityDigest}\n${intentId.trim()}`);
    let entry;
    try {
      entry = await operationJournal.begin({ contractId: OPERATION_ID, requestDigest, intentDigest });
    } catch (error) {
      plan.clear?.();
      throw error;
    }

    let baselineIds;
    try {
      const baseline = await readClientJson(client, 'conversation.list.read', { pageSize: 24 });
      if (!Array.isArray(baseline.conversations)) throw fail('TEXT_WSS_BASELINE_INVALID');
      baselineIds = new Set(conversationIds(baseline.conversations));
    } catch {
      plan.clear?.();
      await operationJournal.transition(entry.localOperationId, 'rejected', { reasonCode: 'TEXT_WSS_BASELINE_READ_FAILED' });
      throw fail('TEXT_WSS_BASELINE_READ_FAILED');
    }

    let dispatched;
    try {
      dispatched = await dispatcher({
        socketUrl: validatedPlan.socketUrl,
        cookieHeader: bound.cookieHeader,
        requestMetadataHeaders: validatedPlan.requestMetadataHeaders,
        controlFrameText: plan.controlFrameText,
        buildBusinessFrameText: plan.buildBusinessFrameText,
      });
    } catch {
      plan.clear?.();
      await operationJournal.transition(entry.localOperationId, 'outcome_unknown', { reasonCode: 'TEXT_WSS_DISPATCH_OUTCOME_UNKNOWN' });
      return {
        operation: OPERATION_ID,
        state: 'outcome_unknown',
        selectedModeId: plan.selectedModeId,
        handshakeStatus: null,
        businessFrameSent: null,
        terminalEventObserved: false,
        readbackVerified: false,
      };
    }
    plan.clear?.();

    let eventTypes;
    try { eventTypes = validEventTypes(dispatched?.eventTypes ?? []); } catch {
      await operationJournal.transition(entry.localOperationId, 'outcome_unknown', {
        httpStatus: Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null,
        reasonCode: 'TEXT_WSS_RESULT_UNREADABLE',
      });
      return { operation: OPERATION_ID, state: 'outcome_unknown', handshakeStatus: null,
        businessFrameSent: null, terminalEventObserved: false, readbackVerified: false };
    }
    const handshakeStatus = Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null;
    const businessFrameSent = dispatched?.businessFrameSentCount === 1;
    const normalControlFrameSent = dispatched?.normalControlFrameSentCount === 1;
    const serverSessionAcknowledgementObserved = dispatched?.serverSessionAcknowledgementObserved === true;
    const businessFrameBoundToServerSession = dispatched?.businessFrameBoundToServerSession === true;
    const terminalEventObserved = dispatched?.terminalEventObserved === true;
    if (handshakeStatus !== 101 || !businessFrameSent || !normalControlFrameSent
      || !serverSessionAcknowledgementObserved || !businessFrameBoundToServerSession) {
      const state = businessFrameSent ? 'outcome_unknown' : 'rejected';
      await operationJournal.transition(entry.localOperationId, state, {
        httpStatus: handshakeStatus,
        reasonCode: businessFrameSent ? 'TEXT_WSS_DISPATCH_OUTCOME_UNKNOWN' : 'TEXT_WSS_FRAME_NOT_SENT',
      });
      return { operation: OPERATION_ID, state, selectedModeId: plan.selectedModeId, handshakeStatus,
        normalControlFrameSent, serverSessionAcknowledgementObserved, businessFrameSent,
        businessFrameBoundToServerSession, terminalEventObserved, eventTypes, readbackVerified: false };
    }

    const idHints = Array.isArray(dispatched.privateConversationIdHints)
      ? dispatched.privateConversationIdHints.filter(value => typeof value === 'string' && value && value.length <= 512 && !/[\r\n\0]/.test(value))
      : [];
    const readback = await verifyTextReadback({
      client,
      baselineIds,
      privateConversationIdHints: idHints,
      expectedPrompt: message,
      expectedAssistantText,
    });
    if (readback.verified) {
      await operationJournal.transition(entry.localOperationId, 'accepted', { httpStatus: 101 });
      await operationJournal.transition(entry.localOperationId, 'completed', {
        httpStatus: 101,
        reasonCode: 'TEXT_WSS_READBACK_VERIFIED',
        reconciledBy: 'history.load-responses',
      });
      return { operation: OPERATION_ID, state: 'completed', selectedModeId: plan.selectedModeId,
        handshakeStatus, normalControlFrameSent: true, serverSessionAcknowledgementObserved: true,
        businessFrameSent: true, businessFrameBoundToServerSession: true, terminalEventObserved, eventTypes,
        readbackVerified: true,
        ...(includeContent ? { businessOutput: { assistantMessage: readback.assistantMessage } } : {}) };
    }
    await operationJournal.transition(entry.localOperationId, 'outcome_unknown', {
      httpStatus: 101,
      reasonCode: 'TEXT_WSS_READBACK_PENDING',
    });
    return { operation: OPERATION_ID, state: 'outcome_unknown', selectedModeId: plan.selectedModeId,
      handshakeStatus, normalControlFrameSent: true, serverSessionAcknowledgementObserved: true,
      businessFrameSent: true, businessFrameBoundToServerSession: true, terminalEventObserved, eventTypes,
      readbackVerified: false };
  };
}
