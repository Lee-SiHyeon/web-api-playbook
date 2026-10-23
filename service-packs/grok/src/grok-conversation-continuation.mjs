import { createHash } from 'node:crypto';
import { boundCredentials, GROK_WEB_ORIGIN } from './session.mjs';
import { fail } from './errors.mjs';
import { createPythonGrokTextWebSocketDispatcher } from './grok-text-websocket.mjs';

export const GROK_CONVERSATION_CONTINUATION_OPERATION_ID = 'chat.text.continuation.wss';
const SOCKET_PATH = '/ws/mgw/';
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,95}$/;
const CONTROL_FIELDS = new Set([
  'accept_interleaved_phases', 'active_response_id', 'client_side_toolsets', 'connector_ids',
  'conversation_id', 'disable_artifact', 'disable_text_follow_ups', 'enable_image_generation',
  'enable_side_by_side', 'force_concise', 'force_side_by_side', 'image_generation_count',
  'initial_leaf_id', 'initial_load_id', 'load_existing', 'protocol_capabilities', 'use_chunk',
]);
const TERMINAL_TYPES = new Set(['response.completed', 'response.done', 'response.finished', 'response.error']);
const MAX_READBACK_ATTEMPTS = 20;
const READBACK_INTERVAL_MS = 1_000;

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return plainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function requireId(value, code) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /[\r\n\0]/.test(value)) throw fail(code);
  return value;
}
function isId(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 && !/[\r\n\0]/.test(value);
}
function senderKind(value) {
  const sender = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['user', 'human', 'you'].includes(sender)) return 'user';
  if (['assistant', 'model'].includes(sender)) return 'assistant';
  return 'other';
}
function safeEventTypes(value) {
  if (!Array.isArray(value) || value.length > 128
      || value.some(item => typeof item !== 'string' || !EVENT_TYPE.test(item))) {
    throw fail('CONVERSATION_CONTINUATION_DISPATCH_RESULT_INVALID');
  }
  return [...new Set(value)];
}
function textLeaves(value, output = [], depth = 0) {
  if (depth > 24 || output.length >= 128) return output;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 512)) textLeaves(child, output, depth + 1);
  } else if (plainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'text' || key === 'message') && typeof child === 'string') output.push(child);
      else textLeaves(child, output, depth + 1);
    }
  }
  return output;
}
function inputText(chunks) {
  if (!Array.isArray(chunks) || chunks.length !== 1) throw fail('CONVERSATION_CONTINUATION_PROMPT_INVALID');
  const leaves = textLeaves(chunks[0]);
  if (leaves.length !== 1 || !leaves[0].trim()) throw fail('CONVERSATION_CONTINUATION_PROMPT_INVALID');
  return leaves[0];
}
function normalizeOneLineEnding(value) {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}
function validateAttachmentIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 64
      || value.some(id => !isId(id))
      || new Set(value).size !== value.length) throw fail('CONVERSATION_CONTINUATION_FILE_IDS_INVALID');
  return [...value];
}
function compareCapturedAttachmentIds(event, item, expected) {
  const eventIds = event.file_attachment_ids;
  const itemIds = item.file_attachment_ids;
  const validateCaptured = value => {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length < 1 || value.length > 64
        || value.some(id => !isId(id))
        || new Set(value).size !== value.length) throw fail('CONVERSATION_CONTINUATION_CAPTURE_FILE_IDS_INVALID');
    return value;
  };
  const eventList = validateCaptured(eventIds);
  const itemList = validateCaptured(itemIds);
  if (eventList && itemList && JSON.stringify(eventList) !== JSON.stringify(itemList)) {
    throw fail('CONVERSATION_CONTINUATION_CAPTURE_FILE_IDS_MISMATCH');
  }
  const actual = eventList ?? itemList ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw fail('CONVERSATION_CONTINUATION_CAPTURE_FILE_IDS_MISMATCH');
  return actual;
}
function validateSocketUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('CONVERSATION_CONTINUATION_SOCKET_URL_INVALID'); }
  const keys = [...url.searchParams.keys()];
  if (url.protocol !== 'wss:' || url.hostname !== 'grok.com' || url.port || url.username || url.password
      || url.pathname !== SOCKET_PATH || url.hash || keys.length !== 1 || keys[0] !== 'uid'
      || !url.searchParams.get('uid') || url.searchParams.getAll('uid').length !== 1) {
    throw fail('CONVERSATION_CONTINUATION_SOCKET_URL_INVALID');
  }
  return url.href;
}
function validateCapture(capture, { conversationId, expectedPrompt, expectedSourcePageRole, fileAttachmentIds }) {
  const keys = ['browserBusinessFramesCaptured', 'browserBusinessWritesDelivered', 'browserControlFramesForwarded',
    'browserWriteAbortVerified', 'controlFrameText', 'frameText', 'socketUrl', 'sourcePageRole'];
  if (!exactKeys(capture, keys) || capture.sourcePageRole !== expectedSourcePageRole
      || !/^codex-grok-[A-Za-z0-9-]{8,96}$/.test(expectedSourcePageRole)
      || capture.browserWriteAbortVerified !== true || capture.browserBusinessFramesCaptured !== 1
      || capture.browserBusinessWritesDelivered !== 0 || capture.browserControlFramesForwarded !== 1
      || typeof capture.controlFrameText !== 'string' || Buffer.byteLength(capture.controlFrameText) < 1
      || Buffer.byteLength(capture.controlFrameText) > 64 * 1024
      || typeof capture.frameText !== 'string' || Buffer.byteLength(capture.frameText) < 1
      || Buffer.byteLength(capture.frameText) > 4 * 1024 * 1024) {
    throw fail('CONVERSATION_CONTINUATION_CAPTURE_NOT_VERIFIED');
  }
  let control;
  let frame;
  try {
    control = JSON.parse(capture.controlFrameText);
    frame = JSON.parse(capture.frameText);
  } catch { throw fail('CONVERSATION_CONTINUATION_FRAME_INVALID'); }
  validateSocketUrl(capture.socketUrl);

  const controlTopKeys = plainObject(control) ? Object.keys(control).sort() : [];
  const controlEvent = control?.event;
  const session = controlEvent?.session;
  const xGrokSession = session?.x_grok;
  const controlEventKeys = plainObject(controlEvent) ? Object.keys(controlEvent).sort() : [];
  const sessionKeys = plainObject(session) ? Object.keys(session).sort() : [];
  const xGrokKeys = plainObject(xGrokSession) ? Object.keys(xGrokSession) : [];
  const hasInitialLoadId = plainObject(xGrokSession) && Object.hasOwn(xGrokSession, 'initial_load_id');
  const initialLoadId = hasInitialLoadId ? xGrokSession.initial_load_id : undefined;
  const initialLoadIdValid = !hasInitialLoadId || initialLoadId === null || initialLoadId === ''
    || (typeof initialLoadId === 'string' && Buffer.byteLength(initialLoadId, 'utf8') <= 512
      && !/[\r\n\0]/.test(initialLoadId));
  if (!['event', 'event,session_id'].includes(controlTopKeys.join(','))
      || Object.hasOwn(control, 'session_id') && (typeof control.session_id !== 'string' || !control.session_id)
      || !exactKeys(controlEvent, ['event_id', 'session', 'type']) || controlEvent.type !== 'session.create'
      || typeof controlEvent.event_id !== 'string' || !controlEvent.event_id
      || !plainObject(session) || typeof session.model !== 'string' || !session.model.trim()
      || !['model', 'model,x_grok'].includes(sessionKeys.join(','))
      || !plainObject(xGrokSession) || xGrokKeys.some(key => !CONTROL_FIELDS.has(key))
      || !initialLoadIdValid
      || xGrokSession.conversation_id !== conversationId || xGrokSession.load_existing !== true) {
    throw fail('CONVERSATION_CONTINUATION_CONTROL_TARGET_MISMATCH');
  }

  const event = frame?.event;
  const item = event?.item;
  const xGrok = item?.x_grok;
  const eventKeys = plainObject(event) ? Object.keys(event).sort() : [];
  const itemKeys = plainObject(item) ? Object.keys(item).sort() : [];
  const expectedEventKeys = ['castle_request_token', 'event_id', 'item', 'type'];
  if (expectedAttachmentKeysPresent(event)) expectedEventKeys.push('file_attachment_ids');
  if (!exactKeys(frame, ['event', 'session_id']) || typeof frame.session_id !== 'string' || !frame.session_id
      || !plainObject(event) || JSON.stringify(eventKeys) !== JSON.stringify(expectedEventKeys.sort())
      || event.type !== 'response.create' || typeof event.event_id !== 'string' || !event.event_id
      || typeof event.castle_request_token !== 'string' || !event.castle_request_token.trim()
      || !plainObject(item) || !['role,type,x_grok', 'file_attachment_ids,role,type,x_grok'].includes(itemKeys.join(','))
      || item.type !== 'message' || item.role !== 'user'
      || !exactKeys(xGrok, ['client_message_id', 'input_chunks'])
      || typeof xGrok.client_message_id !== 'string' || !xGrok.client_message_id
      || containsWorkspaceTarget(control) || containsWorkspaceTarget(frame)) {
    throw fail('CONVERSATION_CONTINUATION_BUSINESS_FRAME_INVALID');
  }
  const attachmentIds = compareCapturedAttachmentIds(event, item, fileAttachmentIds);
  const prompt = inputText(xGrok.input_chunks);
  if (prompt !== expectedPrompt) throw fail('CONVERSATION_CONTINUATION_PROMPT_MISMATCH');
  return {
    socketUrl: capture.socketUrl,
    controlFrameText: capture.controlFrameText,
    frameText: capture.frameText,
    prompt,
    attachmentIds,
  };
}
function expectedAttachmentKeysPresent(event) { return Object.hasOwn(event ?? {}, 'file_attachment_ids'); }
function containsWorkspaceTarget(value, depth = 0) {
  if (depth > 24) return true;
  if (Array.isArray(value)) return value.some(child => containsWorkspaceTarget(child, depth + 1));
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, child]) => key.toLowerCase().includes('workspace')
    || containsWorkspaceTarget(child, depth + 1));
}
function responseRows(data) {
  if (!plainObject(data) || !Array.isArray(data.responses)
      || data.responses.some(row => !plainObject(row) || typeof row.responseId !== 'string')) {
    throw fail('CONVERSATION_CONTINUATION_HISTORY_INVALID');
  }
  const ids = data.responses.map(row => row.responseId);
  if (new Set(ids).size !== ids.length) throw fail('CONVERSATION_CONTINUATION_HISTORY_INVALID');
  return data.responses;
}
function rowsFromNodes(data) {
  if (!plainObject(data) || !Array.isArray(data.responseNodes) || !Array.isArray(data.inflightResponses)
      || data.responseNodes.length > 256 || data.inflightResponses.length > 256
      || data.responseNodes.some(row => !plainObject(row) || typeof row.responseId !== 'string')) {
    throw fail('CONVERSATION_CONTINUATION_NODES_INVALID');
  }
  const ids = data.responseNodes.map(row => row.responseId);
  if (new Set(ids).size !== ids.length) throw fail('CONVERSATION_CONTINUATION_NODES_INVALID');
  return data.responseNodes;
}
async function readOk(client, operationId, input) {
  const result = await client.read(operationId, input);
  if (!result || result.status !== 200 || !plainObject(result.data)) throw fail('CONVERSATION_CONTINUATION_READ_FAILED');
  return result;
}
function safeResultMetadata(result) {
  return {
    status: result.status,
    responseBytes: result.responseBytes ?? null,
    requestDigest: result.requestDigest ?? null,
    responseDigest: result.rawResponseDigest ?? result.responseDigest ?? null,
  };
}
function attachmentIdsFromUserResponse(response) {
  const output = new Set();
  const metadataIdFields = new Set([
    'assetId', 'fileId', 'fileMetadataId', 'fileAttachmentId', 'id',
    'asset_id', 'file_id', 'file_metadata_id', 'file_attachment_id',
  ]);
  const collect = value => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === 'string') output.add(entry);
      else if (plainObject(entry)) {
        for (const [key, id] of Object.entries(entry)) {
          if (metadataIdFields.has(key) && typeof id === 'string') output.add(id);
        }
      }
    }
  };
  const values = [
    response.file_attachment_ids,
    response.x_grok?.file_attachment_ids,
    response.metadata?.file_attachment_ids,
    response.metadata?.request_metadata?.file_attachment_ids,
    response.fileAttachments,
    response.fileAttachmentsMetadata,
    response.fileAttachmentAssetMetadata,
    response.fileIds,
  ];
  for (const value of values) collect(value);
  const rows = [...output];
  if (rows.some(id => !isId(id))) {
    throw fail('CONVERSATION_CONTINUATION_HISTORY_FILE_IDS_INVALID');
  }
  return rows;
}
function dispatchResult(value) {
  if (!plainObject(value) || !Number.isInteger(value.handshakeStatus) || value.handshakeStatus < 0
      || value.handshakeStatus > 599 || !Number.isInteger(value.businessFrameSentCount)
      || value.businessFrameSentCount < 0 || value.businessFrameSentCount > 1
      || !Number.isInteger(value.normalControlFrameSentCount) || value.normalControlFrameSentCount < 0
      || value.normalControlFrameSentCount > 1 || typeof value.serverSessionAcknowledgementObserved !== 'boolean'
      || typeof value.businessFrameBoundToServerSession !== 'boolean'
      || typeof value.terminalEventObserved !== 'boolean') throw fail('CONVERSATION_CONTINUATION_DISPATCH_RESULT_INVALID');
  return {
    handshakeStatus: value.handshakeStatus,
    businessFrameSentCount: value.businessFrameSentCount,
    normalControlFrameSentCount: value.normalControlFrameSentCount,
    serverSessionAcknowledgementObserved: value.serverSessionAcknowledgementObserved,
    businessFrameBoundToServerSession: value.businessFrameBoundToServerSession,
    terminalEventObserved: value.terminalEventObserved,
    eventTypes: safeEventTypes(value.eventTypes ?? []),
    responseIdHints: Array.isArray(value.privateResponseIdHints) ? value.privateResponseIdHints : [],
  };
}
function safeFailureSummary({ conversationId, prompt, attachmentIds, intentDigest, requestDigest,
  state, handshakeStatus, directBusinessFrameSent, reasonCode, beforeDetail, beforeNodes, ownerScopeSha256 }) {
  return {
    operation: GROK_CONVERSATION_CONTINUATION_OPERATION_ID,
    state,
    verified: false,
    ownerVerified: true,
    ownerScopeSha256,
    conversationIdSha256: sha256(conversationId),
    promptSha256: sha256(prompt),
    promptBytes: Buffer.byteLength(prompt),
    intentDigest,
    requestDigest,
    emptyOwnerTargetVerified: true,
    beforeDetail: safeResultMetadata(beforeDetail),
    beforeResponseNodes: { ...safeResultMetadata(beforeNodes), responseCount: 0, inflightCount: 0 },
    fileAttachmentCount: attachmentIds.length,
    fileAttachmentIdsSha256: attachmentIds.length ? sha256(attachmentIds.join('\n')) : null,
    handshakeStatus,
    directBusinessFrameSent,
    browserBusinessFramesDelivered: 0,
    terminalEventObserved: false,
    eventTypes: [],
    reasonCode,
  };
}

/** Submit one source-captured response.create into a freshly created, owner-bound empty conversation. */
export async function submitCapturedGrokConversationContinuationOnce({
  client,
  sessionPersistence,
  operationJournal,
  capture,
  conversationId,
  intentId,
  expectedPrompt,
  expectedSourcePageRole,
  fileAttachmentIds: expectedAttachmentIds,
  expectedAssistantText,
  confirm = false,
  dispatchImpl,
  pythonExecutable,
} = {}) {
  if (confirm !== true) throw fail('CONVERSATION_CONTINUATION_CONFIRM_REQUIRED');
  if (!client || typeof client.read !== 'function' || typeof client.status !== 'function'
      || !sessionPersistence || typeof sessionPersistence.read !== 'function'
      || !operationJournal || typeof operationJournal.begin !== 'function'
      || typeof operationJournal.transition !== 'function') throw fail('CONVERSATION_CONTINUATION_RUNTIME_REQUIRED');
  const id = requireId(conversationId, 'CONVERSATION_CONTINUATION_ID_INVALID');
  if (typeof intentId !== 'string' || !intentId.trim() || intentId.length > 256 || /[\r\n\0]/.test(intentId)) {
    throw fail('CONVERSATION_CONTINUATION_INTENT_INVALID');
  }
  if (typeof expectedPrompt !== 'string' || !expectedPrompt.trim() || Buffer.byteLength(expectedPrompt) > 4096) {
    throw fail('CONVERSATION_CONTINUATION_PROMPT_INVALID');
  }
  if (expectedAssistantText !== undefined && (typeof expectedAssistantText !== 'string'
      || !expectedAssistantText.trim() || Buffer.byteLength(expectedAssistantText) > 4096)) {
    throw fail('CONVERSATION_CONTINUATION_EXPECTED_ASSISTANT_INVALID');
  }
  const attachmentIds = validateAttachmentIds(expectedAttachmentIds);
  const captured = validateCapture(capture, { conversationId: id, expectedPrompt,
    expectedSourcePageRole, fileAttachmentIds: attachmentIds });

  const stored = await sessionPersistence.read();
  const session = stored?.session;
  const status = await client.status();
  if (stored?.kind !== 'grok-session' || !session || session.generation !== session.ownerBinding?.generation
      || typeof session.ownerBinding?.identityDigest !== 'string' || status?.session?.ownerVerified !== true) {
    throw fail('OWNER_VERIFICATION_REQUIRED');
  }
  const ownerScopeSha256 = session.ownerBinding.identityDigest;
  const beforeDetail = await readOk(client, 'conversation.read', { conversationId: id });
  const conversation = beforeDetail.data.conversation;
  if (!plainObject(conversation) || conversation.conversationId !== id || conversation.viewerIsOwner !== true
      || conversation.isReadonly === true || conversation.isDeleted === true
      || conversation.accessLevel && conversation.accessLevel !== 'OWNER') {
    throw fail('CONVERSATION_CONTINUATION_OWNER_TARGET_INVALID');
  }
  const beforeNodes = await readOk(client, 'history.response-nodes', { conversationId: id });
  const beforeRows = rowsFromNodes(beforeNodes.data);
  if (beforeRows.length !== 0 || beforeNodes.data.inflightResponses.length !== 0) {
    throw fail('CONVERSATION_CONTINUATION_TARGET_NOT_EMPTY');
  }

  const credentials = boundCredentials(session, GROK_WEB_ORIGIN, SOCKET_PATH, { cookieNames: ['sso'], headerNames: [] });
  const requestDigest = sha256(`${captured.socketUrl}\n${captured.controlFrameText}\n${captured.frameText}`);
  const intentDigest = sha256(`${GROK_CONVERSATION_CONTINUATION_OPERATION_ID}\n${ownerScopeSha256}\n${intentId.trim()}`);
  const journalEntry = await operationJournal.begin({ contractId: GROK_CONVERSATION_CONTINUATION_OPERATION_ID,
    requestDigest, intentDigest });
  const dispatcher = dispatchImpl ?? createPythonGrokTextWebSocketDispatcher({ pythonExecutable });
  let dispatchedRaw;
  try {
    dispatchedRaw = await dispatcher({ socketUrl: captured.socketUrl,
      cookieHeader: credentials.cookieHeader,
      controlFrameText: captured.controlFrameText,
      frameText: captured.frameText,
      expectedFileAttachmentIds: attachmentIds,
      expectedConversationId: id });
  } catch {
    await operationJournal.transition(journalEntry.localOperationId, 'outcome_unknown', {
      reasonCode: 'CONVERSATION_CONTINUATION_DISPATCH_OUTCOME_UNKNOWN' });
    return safeFailureSummary({ conversationId: id, prompt: captured.prompt, attachmentIds, intentDigest,
      requestDigest, state: 'outcome_unknown', handshakeStatus: null,
      directBusinessFrameSent: null, reasonCode: 'CONVERSATION_CONTINUATION_DISPATCH_OUTCOME_UNKNOWN',
      beforeDetail, beforeNodes, ownerScopeSha256 });
  }
  let dispatched;
  try { dispatched = dispatchResult(dispatchedRaw); } catch {
    await operationJournal.transition(journalEntry.localOperationId, 'outcome_unknown', {
      httpStatus: Number.isInteger(dispatchedRaw?.handshakeStatus) ? dispatchedRaw.handshakeStatus : null,
      reasonCode: 'CONVERSATION_CONTINUATION_RESULT_UNREADABLE' });
    return safeFailureSummary({ conversationId: id, prompt: captured.prompt, attachmentIds, intentDigest,
      requestDigest, state: 'outcome_unknown',
      handshakeStatus: Number.isInteger(dispatchedRaw?.handshakeStatus) ? dispatchedRaw.handshakeStatus : null,
      directBusinessFrameSent: dispatchedRaw?.businessFrameSentCount === 1 ? true : null,
      reasonCode: 'CONVERSATION_CONTINUATION_RESULT_UNREADABLE', beforeDetail, beforeNodes, ownerScopeSha256 });
  }
  const sent = dispatched.businessFrameSentCount === 1;
  const handshakeVerified = dispatched.handshakeStatus === 101
    && dispatched.normalControlFrameSentCount === 1
    && dispatched.serverSessionAcknowledgementObserved === true
    && dispatched.businessFrameBoundToServerSession === true;
  if (!sent || !handshakeVerified) {
    const stateName = sent ? 'outcome_unknown' : 'rejected';
    const reasonCode = sent ? 'CONVERSATION_CONTINUATION_DISPATCH_OUTCOME_UNKNOWN' : 'CONVERSATION_CONTINUATION_FRAME_NOT_SENT';
    await operationJournal.transition(journalEntry.localOperationId, stateName, {
      httpStatus: dispatched.handshakeStatus, reasonCode,
    });
    const summary = safeFailureSummary({ conversationId: id, prompt: captured.prompt, attachmentIds, intentDigest,
      requestDigest, state: stateName, handshakeStatus: dispatched.handshakeStatus,
      directBusinessFrameSent: sent, reasonCode, beforeDetail, beforeNodes, ownerScopeSha256 });
    return { ...summary, terminalEventObserved: dispatched.terminalEventObserved, eventTypes: dispatched.eventTypes,
      serverSessionAcknowledgementObserved: dispatched.serverSessionAcknowledgementObserved,
      businessFrameBoundToServerSession: dispatched.businessFrameBoundToServerSession };
  }

  await operationJournal.transition(journalEntry.localOperationId, 'accepted', { httpStatus: 101 });
  let afterDetail = null;
  let afterNodes = null;
  let afterRows = null;
  let loaded = null;
  let afterResponses = null;
  let readbackError = null;
  for (let attempt = 0; attempt < MAX_READBACK_ATTEMPTS; attempt += 1) {
    try {
      afterDetail = await readOk(client, 'conversation.read', { conversationId: id });
      const afterConversation = afterDetail.data.conversation;
      if (!plainObject(afterConversation) || afterConversation.conversationId !== id
          || afterConversation.viewerIsOwner !== true || afterConversation.isReadonly === true) {
        throw fail('CONVERSATION_CONTINUATION_OWNER_READBACK_MISMATCH');
      }
      afterNodes = await readOk(client, 'history.response-nodes', { conversationId: id });
      afterRows = rowsFromNodes(afterNodes.data);
      const responseIds = afterRows.map(row => row.responseId);
      if (responseIds.length > 256) throw fail('CONVERSATION_CONTINUATION_HISTORY_LIMIT');
      if (responseIds.length > 0 && afterNodes.data.inflightResponses.length === 0) {
        loaded = await readOk(client, 'history.load-responses', { conversationId: id, responseIds });
        afterResponses = responseRows(loaded.data);
        break;
      }
    } catch (error) {
      readbackError = error;
      afterDetail = null;
      afterNodes = null;
      afterRows = null;
      loaded = null;
      afterResponses = null;
    }
    if (attempt + 1 < MAX_READBACK_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, READBACK_INTERVAL_MS));
  }
  const userRows = afterResponses?.filter(row => senderKind(row.sender) === 'user' && row.message === expectedPrompt) ?? [];
  const addedUserRows = afterResponses?.filter(row => senderKind(row.sender) === 'user') ?? [];
  const assistantRows = afterResponses?.filter(row => senderKind(row.sender) === 'assistant') ?? [];
  const newResponseIds = new Set(afterRows?.map(row => row.responseId) ?? []);
  const newAssistantRows = assistantRows.filter(row => newResponseIds.has(row.responseId));
  const userResponse = userRows.length === 1 ? userRows[0] : null;
  const assistantChildren = userResponse ? newAssistantRows.filter(row => row.parentResponseId === userResponse.responseId) : [];
  const assistantResponse = assistantChildren.length === 1 ? assistantChildren[0] : null;
  const actualAttachmentIds = userResponse ? attachmentIdsFromUserResponse(userResponse) : [];
  const attachmentReadbackVerified = JSON.stringify(actualAttachmentIds) === JSON.stringify(attachmentIds);
  const assistantText = typeof assistantResponse?.message === 'string' ? assistantResponse.message : '';
  const assistantTextMatched = expectedAssistantText === undefined
    ? Boolean(assistantText.trim())
    : normalizeOneLineEnding(assistantText) === normalizeOneLineEnding(expectedAssistantText);
  const responseIdHints = dispatched.responseIdHints.filter(isId);
  const responseHintMatched = responseIdHints.length
    ? responseIdHints.includes(assistantResponse?.responseId) : null;
  const verified = Boolean(afterDetail && afterNodes && loaded && userResponse && assistantResponse
    && addedUserRows.length === 1 && newAssistantRows.length === 1 && assistantTextMatched
    && attachmentReadbackVerified && afterNodes.data.inflightResponses.length === 0
    && (responseHintMatched === null || responseHintMatched));
  const readbackStatus = loaded?.status ?? afterNodes?.status ?? afterDetail?.status ?? null;
  if (!verified) {
    await operationJournal.transition(journalEntry.localOperationId, 'outcome_unknown', {
      httpStatus: readbackStatus ?? 101,
      reasonCode: 'CONVERSATION_CONTINUATION_READBACK_PENDING',
    });
    return {
      operation: GROK_CONVERSATION_CONTINUATION_OPERATION_ID,
      state: 'outcome_unknown', verified: false, ownerVerified: true,
      ownerScopeSha256, conversationIdSha256: sha256(id), promptSha256: sha256(captured.prompt),
      promptBytes: Buffer.byteLength(captured.prompt), intentDigest, requestDigest,
      emptyOwnerTargetVerified: true, sameConversationReadbackVerified: Boolean(afterDetail && afterDetail.data?.conversation?.conversationId === id),
      beforeDetail: safeResultMetadata(beforeDetail), beforeResponseNodes: { ...safeResultMetadata(beforeNodes), responseCount: 0, inflightCount: 0 },
      afterDetail: afterDetail ? safeResultMetadata(afterDetail) : null,
      afterResponseNodes: afterNodes ? { ...safeResultMetadata(afterNodes), responseCount: afterRows.length,
        inflightCount: afterNodes.data.inflightResponses.length } : null,
      loadResponses: loaded ? safeResultMetadata(loaded) : null,
      exactUserPromptMatchCount: userRows.length,
      newUserResponseCount: addedUserRows.length,
      assistantResponseCount: newAssistantRows.length,
      assistantChildOfUserMatched: assistantChildren.length === 1,
      assistantTextMatched,
      fileAttachmentCount: attachmentIds.length,
      fileAttachmentIdsSha256: attachmentIds.length ? sha256(attachmentIds.join('\n')) : null,
      fileAttachmentIdsReadbackVerified: attachmentReadbackVerified,
      expectedAssistantTextSha256: expectedAssistantText === undefined ? null : sha256(expectedAssistantText),
      responseHintCount: responseIdHints.length,
      responseHintMatched,
      handshakeStatus: dispatched.handshakeStatus,
      directBusinessFrameSent: true,
      serverSessionAcknowledgementObserved: dispatched.serverSessionAcknowledgementObserved,
      businessFrameBoundToServerSession: dispatched.businessFrameBoundToServerSession,
      terminalEventObserved: dispatched.terminalEventObserved,
      eventTypes: dispatched.eventTypes,
      browserBusinessFramesDelivered: 0,
      readbackStatus,
      readbackErrorCode: readbackError?.code ?? null,
      reasonCode: 'CONVERSATION_CONTINUATION_READBACK_PENDING',
    };
  }

  await operationJournal.transition(journalEntry.localOperationId, 'completed', {
    httpStatus: loaded.status,
    reasonCode: 'CONVERSATION_CONTINUATION_HISTORY_READBACK_VERIFIED',
    reconciledBy: 'history.load-responses',
  });
  return {
    operation: GROK_CONVERSATION_CONTINUATION_OPERATION_ID,
    state: 'completed', verified: true, ownerVerified: true,
    ownerScopeSha256, conversationIdSha256: sha256(id), promptSha256: sha256(captured.prompt),
    promptBytes: Buffer.byteLength(captured.prompt), intentDigest, requestDigest,
    emptyOwnerTargetVerified: true, sameConversationReadbackVerified: true,
    beforeDetail: safeResultMetadata(beforeDetail), beforeResponseNodes: { ...safeResultMetadata(beforeNodes), responseCount: 0, inflightCount: 0 },
    afterDetail: safeResultMetadata(afterDetail),
    afterResponseNodes: { ...safeResultMetadata(afterNodes), responseCount: afterRows.length,
      inflightCount: afterNodes.data.inflightResponses.length },
    loadResponses: safeResultMetadata(loaded),
    exactUserPromptMatchCount: 1, newUserResponseCount: 1,
    assistantResponseCount: 1, assistantChildOfUserMatched: true,
    assistantTextMatched: true,
    fileAttachmentCount: attachmentIds.length,
    fileAttachmentIdsSha256: attachmentIds.length ? sha256(attachmentIds.join('\n')) : null,
    fileAttachmentIdsReadbackVerified: true,
    expectedAssistantTextSha256: expectedAssistantText === undefined ? null : sha256(expectedAssistantText),
    responseHintCount: responseIdHints.length, responseHintMatched,
    handshakeStatus: dispatched.handshakeStatus,
    normalControlFrameSent: true,
    serverSessionAcknowledgementObserved: true,
    businessFrameBoundToServerSession: true,
    directBusinessFrameSent: true,
    terminalEventObserved: dispatched.terminalEventObserved,
    eventTypes: dispatched.eventTypes,
    browserBusinessFramesDelivered: 0,
    readbackStatus: loaded.status,
  };
}
