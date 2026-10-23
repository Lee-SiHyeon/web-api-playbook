import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundCredentials, GROK_WEB_ORIGIN } from './session.mjs';
import { fail } from './errors.mjs';

const OPERATION_ID = 'chat.text.wss';
const SOCKET_PATH = '/ws/mgw/';
const PAGE_ROLE = 'codex-grok-core-20261006';
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PACKET_BYTES = 6 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const HELPER_PATH = fileURLToPath(new URL('../scripts/grok-text-websocket-transport.py', import.meta.url));
const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,95}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MODEL_CODE = /^(?:auto|fast|expert|heavy|build|grok-[a-z0-9]+(?:[._:-][a-z0-9]+)*)$/;
const ID_HINT_KEYS = new Set(['conversationId', 'conversation_id', 'responseId', 'response_id']);
const TERMINAL_EVENTS = new Set(['response.completed', 'response.done', 'response.finished', 'response.error']);
const SAFE_TERMINAL_ATOM = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;
const MAX_READBACK_ATTEMPTS = 10;
const READBACK_INTERVAL_MS = 1500;
const MAX_READBACK_CANDIDATES = 24;
const CONTROL_X_GROK_FIELDS = [
  'accept_interleaved_phases', 'client_side_toolsets', 'connector_ids', 'conversation_id', 'disable_artifact',
  'disable_text_follow_ups', 'enable_image_generation', 'enable_side_by_side', 'force_concise',
  'force_side_by_side', 'image_generation_count', 'initial_load_id', 'load_existing',
  'protocol_capabilities', 'use_chunk',
];
const CONTROL_X_GROK_FIELD_SET = new Set(CONTROL_X_GROK_FIELDS);
const CONVERSATION_ID_KEYS = new Set(['conversationId', 'conversation_id', 'initial_load_id']);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return plainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
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

function inputChunkTexts(chunks) {
  if (!Array.isArray(chunks)) return [];
  return chunks.flatMap(chunk => textLeaves(chunk));
}

function safeEventTypes(value) {
  if (!Array.isArray(value) || value.length > 128
    || value.some(item => typeof item !== 'string' || !EVENT_TYPE.test(item))) throw fail('TEXT_WSS_RESULT_INVALID');
  return [...new Set(value)];
}

function safeModelCode(value) {
  return typeof value === 'string' && value.length <= 64 && MODEL_CODE.test(value) ? value : null;
}

function safeProviderModelMetadata(value, requestSessionModel = null) {
  const metadata = plainObject(value) ? value : {};
  const allowedPaths = new Set(['event.session.model', 'event.model', 'event.response.model',
    'event.response.modelMode', 'event.response.model_mode']);
  const paths = Array.isArray(metadata.observedFieldPaths)
    ? [...new Set(metadata.observedFieldPaths.filter(item => typeof item === 'string' && allowedPaths.has(item)))] : [];
  return Object.freeze({
    requestedSessionModel: safeModelCode(requestSessionModel ?? metadata.requestedSessionModel),
    sessionCreatedModel: safeModelCode(metadata.sessionCreatedModel),
    terminalResponseModel: safeModelCode(metadata.terminalResponseModel),
    terminalResponseMode: safeModelCode(metadata.terminalResponseMode),
    observedFieldPaths: Object.freeze(paths),
  });
}

function safeTerminalFieldNames(value, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems
    || value.some(item => typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(item))) {
    throw fail('TEXT_WSS_RESULT_INVALID');
  }
  return [...new Set(value)];
}

function safeTerminalMetadata(value) {
  if (value === null || value === undefined) return null;
  if (!plainObject(value) || !TERMINAL_EVENTS.has(value.eventType)) throw fail('TEXT_WSS_RESULT_INVALID');
  const atom = item => item === null || item === undefined ? null
    : typeof item === 'string' && SAFE_TERMINAL_ATOM.test(item) ? item : null;
  for (const key of ['responseStatus', 'responseStatusReason', 'errorClass', 'errorCode']) {
    if (value[key] !== null && value[key] !== undefined && atom(value[key]) === null) throw fail('TEXT_WSS_RESULT_INVALID');
  }
  return Object.freeze({
    eventType: value.eventType,
    responseStatus: atom(value.responseStatus),
    responseStatusReason: atom(value.responseStatusReason),
    errorClass: atom(value.errorClass),
    errorCode: atom(value.errorCode),
    responseFieldNames: Object.freeze(safeTerminalFieldNames(value.responseFieldNames ?? [], 64)),
    errorFieldNames: Object.freeze(safeTerminalFieldNames(value.errorFieldNames ?? [], 32)),
  });
}

function validateSocketUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('TEXT_WSS_SOCKET_URL_INVALID'); }
  const queryKeys = [...url.searchParams.keys()];
  if (url.protocol !== 'wss:' || url.hostname !== 'grok.com' || url.port || url.username || url.password
    || url.pathname !== SOCKET_PATH || url.hash || queryKeys.length !== 1 || queryKeys[0] !== 'uid'
    || !url.searchParams.get('uid') || url.searchParams.getAll('uid').length !== 1) {
    throw fail('TEXT_WSS_SOCKET_URL_INVALID');
  }
  return url;
}

function validateCapturedFrame(capture, expectedSourcePageRole = PAGE_ROLE) {
  const expectedKeys = [
    'browserBusinessFramesCaptured', 'browserBusinessWritesDelivered', 'browserControlFramesForwarded',
    'browserWriteAbortVerified', 'controlFrameText', 'frameText', 'socketUrl', 'sourcePageRole',
  ];
  if (typeof expectedSourcePageRole !== 'string' || !/^codex-grok-[A-Za-z0-9-]{8,96}$/.test(expectedSourcePageRole)
    || !plainObject(capture) || JSON.stringify(Object.keys(capture).sort()) !== JSON.stringify(expectedKeys.sort())
    || capture.sourcePageRole !== expectedSourcePageRole || capture.browserWriteAbortVerified !== true
    || capture.browserBusinessFramesCaptured !== 1 || capture.browserBusinessWritesDelivered !== 0
    || capture.browserControlFramesForwarded !== 1 || typeof capture.controlFrameText !== 'string'
    || Buffer.byteLength(capture.controlFrameText) < 1 || Buffer.byteLength(capture.controlFrameText) > 64 * 1024
    || typeof capture.frameText !== 'string'
    || Buffer.byteLength(capture.frameText) < 1 || Buffer.byteLength(capture.frameText) > MAX_FRAME_BYTES) {
    throw fail('TEXT_WSS_CAPTURE_NOT_VERIFIED');
  }
  const socketUrl = validateSocketUrl(capture.socketUrl);
  let controlFrame;
  let frame;
  try {
    controlFrame = JSON.parse(capture.controlFrameText);
    frame = JSON.parse(capture.frameText);
  } catch { throw fail('TEXT_WSS_FRAME_INVALID'); }
  const controlEvent = controlFrame?.event;
  const controlSession = controlEvent?.session;
  const controlXGrok = controlSession?.x_grok;
  const controlTopKeys = plainObject(controlFrame) ? Object.keys(controlFrame).sort() : [];
  const eventOnlyControl = JSON.stringify(controlTopKeys) === JSON.stringify(['event']);
  const sessionIdControl = JSON.stringify(controlTopKeys) === JSON.stringify(['event', 'session_id'])
    && typeof controlFrame.session_id === 'string' && Boolean(controlFrame.session_id);
  const controlSessionKeys = plainObject(controlSession) ? Object.keys(controlSession).sort() : [];
  const modelOnlyControl = JSON.stringify(controlSessionKeys) === JSON.stringify(['model']);
  const xGrokSessionControl = JSON.stringify(controlSessionKeys) === JSON.stringify(['model', 'x_grok'])
    && plainObject(controlXGrok);
  const boundedStringArray = value => Array.isArray(value) && value.length <= 64
    && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 512 && !/[\r\n\0]/.test(item));
  const booleanControlFields = ['accept_interleaved_phases', 'disable_artifact', 'disable_text_follow_ups',
    'enable_image_generation', 'enable_side_by_side', 'force_concise', 'force_side_by_side', 'load_existing', 'use_chunk'];
  const observedXGrokSubset = xGrokSessionControl
    && Object.keys(controlXGrok).every(key => CONTROL_X_GROK_FIELD_SET.has(key))
    && booleanControlFields.every(key => !Object.hasOwn(controlXGrok, key) || typeof controlXGrok[key] === 'boolean')
    && (!Object.hasOwn(controlXGrok, 'client_side_toolsets') || boundedStringArray(controlXGrok.client_side_toolsets))
    && (!Object.hasOwn(controlXGrok, 'connector_ids')
      || boundedStringArray(controlXGrok.connector_ids))
    && (!Object.hasOwn(controlXGrok, 'protocol_capabilities') || boundedStringArray(controlXGrok.protocol_capabilities))
    && (!Object.hasOwn(controlXGrok, 'image_generation_count')
      || Number.isInteger(controlXGrok.image_generation_count) && controlXGrok.image_generation_count >= 0 && controlXGrok.image_generation_count <= 32)
    && (!Object.hasOwn(controlXGrok, 'conversation_id') || controlXGrok.conversation_id === null || typeof controlXGrok.conversation_id === 'string')
    && (!Object.hasOwn(controlXGrok, 'initial_load_id') || controlXGrok.initial_load_id === null || typeof controlXGrok.initial_load_id === 'string')
    && (!Object.hasOwn(controlXGrok, 'load_existing') || controlXGrok.load_existing === false);
  if (!plainObject(controlFrame) || (!eventOnlyControl && !sessionIdControl)
    || !plainObject(controlEvent) || JSON.stringify(Object.keys(controlEvent).sort()) !== JSON.stringify(['event_id', 'session', 'type'])
    || controlEvent.type !== 'session.create' || typeof controlEvent.event_id !== 'string' || !controlEvent.event_id
    || !plainObject(controlSession) || typeof controlSession.model !== 'string'
    || (!modelOnlyControl && !observedXGrokSubset)) {
    throw fail('TEXT_WSS_CONTROL_FRAME_SCHEMA_INVALID');
  }
  const event = frame?.event;
  const item = event?.item;
  const xGrok = item?.x_grok;
  const chunks = xGrok?.input_chunks;
  if (!hasExactKeys(frame, ['event', 'session_id']) || typeof frame.session_id !== 'string' || !frame.session_id
    || !hasExactKeys(event, ['castle_request_token', 'event_id', 'item', 'type'])
    || event.type !== 'response.create' || typeof event.event_id !== 'string' || !event.event_id
    || typeof event.castle_request_token !== 'string' || !event.castle_request_token
    || !hasExactKeys(item, ['role', 'type', 'x_grok']) || item.type !== 'message' || item.role !== 'user'
    || !hasExactKeys(xGrok, ['client_message_id', 'input_chunks'])
    || typeof xGrok.client_message_id !== 'string' || !xGrok.client_message_id
    || !Array.isArray(chunks) || chunks.length !== 1
    || chunks.some(chunk => !hasExactKeys(chunk, ['text']) || textLeaves(chunk).length !== 1
      || textLeaves(chunk).some(text => !text.trim()))) {
    throw fail('TEXT_WSS_FRAME_SCHEMA_INVALID');
  }
  const promptTexts = inputChunkTexts(chunks);
  if (!promptTexts.length || chunks.some(chunk => textLeaves(chunk).length === 0)
    || promptTexts.some(text => !text.trim())) throw fail('TEXT_WSS_INPUT_TEXT_INVALID');
  if (promptTexts.some(text => capture.controlFrameText.includes(text))) throw fail('TEXT_WSS_CONTROL_CONTAINS_BUSINESS_INPUT');
  const hasWorkspaceTarget = value => {
    if (Array.isArray(value)) return value.some(hasWorkspaceTarget);
    if (!plainObject(value)) return false;
    return Object.entries(value).some(([key, child]) => key.toLowerCase().includes('workspace') || hasWorkspaceTarget(child));
  };
  if (hasWorkspaceTarget(controlFrame) || hasWorkspaceTarget(frame)) throw fail('TEXT_WSS_WORKSPACE_TARGET_PRESENT');
  return { socketUrl: socketUrl.href, controlFrameText: capture.controlFrameText, frameText: capture.frameText,
    controlFrame, frame, requestSessionModel: controlSession.model };
}

function capturedConversationIdHints(value, output = new Set(), depth = 0) {
  if (depth > 24 || output.size >= 64) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 512)) capturedConversationIdHints(item, output, depth + 1);
  } else if (plainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (CONVERSATION_ID_KEYS.has(key) && typeof child === 'string' && child && child.length <= 512) output.add(child);
      capturedConversationIdHints(child, output, depth + 1);
    }
  }
  return output;
}

function conversationIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => item?.conversationId).filter(id => typeof id === 'string' && id && id.length <= 512))];
}

function isUserSender(value) {
  return typeof value === 'string' && ['user', 'human', 'you'].includes(value.trim().toLowerCase());
}

async function readJsonResult(client, operationId, input) {
  const result = await client.read(operationId, input);
  if (result?.status !== 200 || !plainObject(result.data)) throw fail('TEXT_WSS_READBACK_HTTP_FAILED');
  return {
    data: result.data,
    status: result.status,
    responseBytes: Number.isSafeInteger(result.responseBytes) && result.responseBytes >= 0 ? result.responseBytes : null,
    contentType: typeof result.contentType === 'string' ? result.contentType.split(';', 1)[0].trim().toLowerCase() : null,
  };
}

async function readJson(client, operationId, input) {
  return (await readJsonResult(client, operationId, input)).data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function inspectNewTextConversation({ client, conversationId, responseIdHints, expectedPrompt,
  expectedAssistantText, directHint = false, baselineReadEvidence = null, boundedListReadEvidence = null }) {
  try {
    const detailRead = await readJsonResult(client, 'conversation.read', { conversationId });
    const detail = detailRead.data;
    const conversation = detail.conversation;
    if (!plainObject(conversation) || conversation.conversationId !== conversationId) {
      return { verified: false, retryable: directHint, inspected: false };
    }
    const nodeRead = await readJsonResult(client, 'history.response-nodes', { conversationId });
    const nodeData = nodeRead.data;
    const nodes = Array.isArray(nodeData.responseNodes) ? nodeData.responseNodes : [];
    const responseIds = [...new Set(nodes.map(item => item?.responseId)
      .filter(id => typeof id === 'string' && id && id.length <= 512))];
    if (!responseIds.length || responseIds.length > 256) return { verified: false, retryable: true, inspected: false };
    const responseHintMatched = [...new Set(responseIdHints)].some(id => responseIds.includes(id));
    const loadedRead = await readJsonResult(client, 'history.load-responses', { conversationId, responseIds });
    const loaded = loadedRead.data;
    const responses = Array.isArray(loaded.responses) ? loaded.responses : [];
    const userMessages = responses.filter(item => isUserSender(item?.sender) && item?.message === expectedPrompt);
    const assistantMessages = responses.filter(item => !isUserSender(item?.sender)
      && typeof item?.sender === 'string' && item.sender.trim()
      && typeof item?.message === 'string' && item.message.trim());
    const assistantResponse = assistantMessages.find(item => expectedAssistantText === undefined
      || item.message.trim() === expectedAssistantText.trim());
    if (userMessages.length === 1 && assistantResponse && responseIds.includes(assistantResponse.responseId)) {
      const assistantMessage = assistantResponse.message;
      return {
        verified: true,
        inspected: true,
        assistantMessage,
        conversationIdSha256: sha256(conversationId),
        assistantResponseIdSha256: typeof assistantResponse.responseId === 'string'
          ? sha256(assistantResponse.responseId) : null,
        responseIdHintMatched: responseIdHints.length ? responseHintMatched : null,
        readbackEvidence: {
          ownerBound: true,
          listStatus: baselineReadEvidence?.status ?? boundedListReadEvidence?.status ?? null,
          listResponseBytes: baselineReadEvidence?.responseBytes ?? boundedListReadEvidence?.responseBytes ?? null,
          windowStart: null,
          windowEnd: null,
          timestampField: directHint ? 'conversation.attached.event.conversation.id' : 'conversation.list.read',
          candidateCount: 1,
          candidateReadCount: 1,
          exactPromptCandidateCount: 1,
          detailStatus: detailRead.status,
          detailResponseBytes: detailRead.responseBytes,
          responseNodesStatus: nodeRead.status,
          responseNodesResponseBytes: nodeRead.responseBytes,
          loadResponsesStatus: loadedRead.status,
          loadResponsesResponseBytes: loadedRead.responseBytes,
          userTurnCount: userMessages.length,
          assistantTurnCount: assistantMessages.length,
          exactPromptMatched: true,
          assistantExactExpectedTextMatched: expectedAssistantText === undefined
            || assistantMessage.trim() === expectedAssistantText.trim(),
          assistantTextLengthCodePoints: [...assistantMessage].length,
          assistantTextSha256: sha256(assistantMessage),
          conversationIdSha256: sha256(conversationId),
          assistantResponseIdSha256: typeof assistantResponse.responseId === 'string'
            ? sha256(assistantResponse.responseId) : null,
          responseIdHintMatched: responseIdHints.length ? responseHintMatched : null,
        },
      };
    }
    return { verified: false, retryable: true, inspected: true,
      exactPromptMatched: userMessages.length === 1,
      assistantExpectedTextMatched: expectedAssistantText === undefined
        ? assistantMessages.length > 0 : assistantMessages.some(item => item.message.trim() === expectedAssistantText.trim()) };
  } catch { /* A direct task hint can arrive before its independent history rows are readable. */
    return { verified: false, retryable: true, inspected: false };
  }
}

async function verifyNewTextReadback({ client, baselineIds, frame, privateConversationIdHints,
  privateResponseIdHints = [], expectedAssistantText, baselineReadEvidence = null }) {
  const chunks = frame.event.item.x_grok.input_chunks;
  const expectedPrompt = inputChunkTexts(chunks).join('');
  const hints = [...new Set(privateConversationIdHints)];
  const safeResponseHints = [...new Set(privateResponseIdHints)];
  const newHints = hints.filter(id => !baselineIds.has(id));
  if (newHints.length === 1) {
    for (let attempt = 0; attempt < MAX_READBACK_ATTEMPTS; attempt++) {
      const readback = await inspectNewTextConversation({ client, conversationId: newHints[0],
        responseIdHints: safeResponseHints, expectedPrompt, expectedAssistantText, directHint: true,
        baselineReadEvidence });
      if (readback.verified) return readback;
      if (attempt + 1 < MAX_READBACK_ATTEMPTS) await sleep(READBACK_INTERVAL_MS);
    }
  }
  let boundedListRead;
  try {
    boundedListRead = await readJsonResult(client, 'conversation.list.read', { pageSize: MAX_READBACK_CANDIDATES });
  } catch { return { verified: false }; }
  const listedIds = conversationIds(boundedListRead.data.conversations).filter(id => !baselineIds.has(id));
  const candidateIds = [...new Set([...newHints, ...listedIds])];
  if (!candidateIds.length || candidateIds.length > MAX_READBACK_CANDIDATES) return { verified: false };

  const exactMatches = [];
  let allCandidatesInspected = true;
  for (const conversationId of candidateIds) {
    const inspected = await inspectNewTextConversation({ client, conversationId,
      responseIdHints: safeResponseHints, expectedPrompt, expectedAssistantText,
      directHint: newHints.includes(conversationId), baselineReadEvidence,
      boundedListReadEvidence: boundedListRead });
    if (inspected.verified) exactMatches.push(inspected);
    if (inspected.inspected !== true) allCandidatesInspected = false;
  }
  if (!allCandidatesInspected || exactMatches.length !== 1) return { verified: false };
  const selected = exactMatches[0];
  return { ...selected, readbackEvidence: {
    ...selected.readbackEvidence,
    candidateCount: candidateIds.length,
    candidateReadCount: candidateIds.length,
    exactPromptCandidateCount: exactMatches.length,
    windowAvailable: false,
    boundedOwnerListScan: true,
  } };
}

function childEnvironment() {
  const environment = { PYTHONDONTWRITEBYTECODE: '1' };
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

export function createPythonGrokTextWebSocketDispatcher({ pythonExecutable, timeoutMs = 120_000 } = {}) {
  const executable = pythonExecutable ?? process.env.GROK_TEXT_WS_PYTHON ?? 'python3';
  if (typeof executable !== 'string' || !executable.trim() || /[\r\n\0]/.test(executable)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw fail('TEXT_WSS_DISPATCH_OPTIONS_INVALID');
  }

  return async function dispatchCapturedFrame({ socketUrl, cookieHeader, controlFrameText, frameText,
    expectedFileAttachmentIds = [], expectedConversationId = null }) {
    if (typeof socketUrl !== 'string' || typeof cookieHeader !== 'string' || typeof controlFrameText !== 'string' || typeof frameText !== 'string'
      || Buffer.byteLength(frameText) > MAX_FRAME_BYTES
      || !Array.isArray(expectedFileAttachmentIds) || expectedFileAttachmentIds.length > 64
      || expectedFileAttachmentIds.some(id => typeof id !== 'string' || id.length < 16 || id.length > 512 || /[\r\n\0]/.test(id))
      || new Set(expectedFileAttachmentIds).size !== expectedFileAttachmentIds.length
      || expectedConversationId !== null && (typeof expectedConversationId !== 'string'
        || expectedConversationId.length < 16 || expectedConversationId.length > 512 || /[\r\n\0]/.test(expectedConversationId))) {
      throw fail('TEXT_WSS_DISPATCH_INPUT_INVALID');
    }
    const packet = Buffer.from(JSON.stringify({ socketUrl, cookieHeader, controlFrameText, frameText,
      expectedFileAttachmentIds, expectedConversationId, timeoutMs }), 'utf8');
    if (packet.length > MAX_PACKET_BYTES) {
      packet.fill(0);
      throw fail('TEXT_WSS_PACKET_TOO_LARGE');
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      let child;
      let timer;
      let stdout = Buffer.alloc(0);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        packet.fill(0);
        if (error) {
          if (child && child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGTERM'); } catch { /* The bounded child may already have exited. */ }
          }
          reject(error);
        } else resolve(result);
      };
      try {
        child = spawn(executable, [HELPER_PATH], {
          stdio: ['pipe', 'pipe', 'ignore'], shell: false, env: childEnvironment(),
        });
      } catch { finish(fail('TEXT_WSS_HELPER_FAILED')); return; }
      timer = setTimeout(() => finish(fail('TEXT_WSS_TIMEOUT')), timeoutMs + 5_000);
      timer.unref?.();
      child.stdout.on('data', chunk => {
        stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
        if (stdout.length > MAX_HELPER_OUTPUT_BYTES) finish(fail('TEXT_WSS_HELPER_OUTPUT_LIMIT'));
      });
      child.on('error', () => finish(fail('TEXT_WSS_HELPER_FAILED')));
      child.on('close', code => {
        if (code !== 0 || settled) {
          if (!settled) finish(fail('TEXT_WSS_HELPER_FAILED'));
          return;
        }
        let packetResult;
        try { packetResult = JSON.parse(stdout.toString('utf8')); } catch { finish(fail('TEXT_WSS_HELPER_FAILED')); return; }
        if (!Number.isInteger(packetResult?.handshakeStatus) || packetResult.handshakeStatus < 0 || packetResult.handshakeStatus > 599
          || !Number.isInteger(packetResult?.normalControlFrameSentCount) || packetResult.normalControlFrameSentCount < 0
          || packetResult.normalControlFrameSentCount > 1
          || typeof packetResult?.serverSessionAcknowledgementObserved !== 'boolean'
          || typeof packetResult?.businessFrameBoundToServerSession !== 'boolean'
          || !Number.isInteger(packetResult?.businessFrameSentCount) || packetResult.businessFrameSentCount < 0
          || packetResult.businessFrameSentCount > 1 || typeof packetResult.terminalEventObserved !== 'boolean'
          || !Array.isArray(packetResult?.conversationIdHints) || packetResult.conversationIdHints.length > 32
          || packetResult.conversationIdHints.some(value => typeof value !== 'string' || !value || value.length > 512 || /[\r\n\0]/.test(value))
          || !Array.isArray(packetResult?.responseIdHints) || packetResult.responseIdHints.length > 32
          || packetResult.responseIdHints.some(value => typeof value !== 'string' || !value || value.length > 512 || /[\r\n\0]/.test(value))) {
          finish(fail('TEXT_WSS_HELPER_FAILED'));
          return;
        }
        let eventTypes;
        try { eventTypes = safeEventTypes(packetResult.eventTypes); } catch (error) { finish(error); return; }
        const providerModelMetadata = safeProviderModelMetadata(packetResult.providerModelMetadata);
        const terminalMetadata = safeTerminalMetadata(packetResult.terminalMetadata);
        finish(null, {
          handshakeStatus: packetResult.handshakeStatus,
          normalControlFrameSentCount: packetResult.normalControlFrameSentCount,
          serverSessionAcknowledgementObserved: packetResult.serverSessionAcknowledgementObserved,
          businessFrameBoundToServerSession: packetResult.businessFrameBoundToServerSession,
          businessFrameSentCount: packetResult.businessFrameSentCount,
          eventTypes,
          terminalEventObserved: packetResult.terminalEventObserved,
          privateConversationIdHints: packetResult.conversationIdHints,
          privateResponseIdHints: packetResult.responseIdHints,
          providerModelMetadata,
          terminalMetadata,
        });
      });
      child.stdin.end(packet);
    });
  };
}

export async function submitCapturedGrokTextOnce({
  sessionPersistence,
  operationJournal,
  client,
  capture,
  intentId,
  confirm = false,
  dispatchImpl,
  pythonExecutable,
  includeContent = false,
  expectedAssistantText,
  expectedSourcePageRole = PAGE_ROLE,
} = {}) {
  if (confirm !== true) throw fail('TEXT_WSS_CONFIRMATION_REQUIRED');
  if (!sessionPersistence || typeof sessionPersistence.read !== 'function'
    || !operationJournal || typeof operationJournal.begin !== 'function' || typeof operationJournal.transition !== 'function') {
    throw fail('TEXT_WSS_RUNTIME_REQUIRED');
  }
  if (!client || typeof client.status !== 'function' || typeof client.read !== 'function') throw fail('TEXT_WSS_READBACK_CLIENT_REQUIRED');
  const dispatcher = dispatchImpl ?? createPythonGrokTextWebSocketDispatcher({ pythonExecutable });
  if (typeof dispatcher !== 'function') throw fail('TEXT_WSS_RUNTIME_REQUIRED');
  if (typeof intentId !== 'string' || !intentId.trim() || intentId.length > 256 || /[\r\n\0]/.test(intentId)) {
    throw fail('TEXT_WSS_INTENT_ID_INVALID');
  }
  if (expectedAssistantText !== undefined
    && (typeof expectedAssistantText !== 'string' || !expectedAssistantText.trim() || expectedAssistantText.length > 4096)) {
    throw fail('TEXT_WSS_EXPECTED_RESPONSE_INVALID');
  }
  const { socketUrl, controlFrameText, frameText, controlFrame, frame, requestSessionModel } =
    validateCapturedFrame(capture, expectedSourcePageRole);
  const stored = await sessionPersistence.read();
  const session = stored?.session;
  if (stored?.kind !== 'grok-session' || !session || session.generation !== session.ownerBinding?.generation
    || typeof session.ownerBinding?.identityDigest !== 'string' || !DIGEST.test(session.ownerBinding.identityDigest)) {
    throw fail('OWNER_VERIFICATION_REQUIRED');
  }
  const clientStatus = await client.status();
  if (clientStatus?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
  const bound = boundCredentials(session, GROK_WEB_ORIGIN, SOCKET_PATH, { cookieNames: ['sso'], headerNames: [] });
  const requestDigest = sha256(`${socketUrl}\n${controlFrameText}\n${frameText}`);
  const intentDigest = sha256(`${OPERATION_ID}\n${session.ownerBinding.identityDigest}\n${intentId.trim()}`);
  const entry = await operationJournal.begin({ contractId: OPERATION_ID, requestDigest, intentDigest });
  const journalEvidence = Object.freeze({
    requestDigest,
    intentDigest,
    localOperationIdSha256: sha256(entry.localOperationId),
  });

  let baselineIds;
  let baselineReadEvidence;
  try {
    const baselineResult = await readJsonResult(client, 'conversation.list.read', { pageSize: 24 });
    const baselineData = baselineResult.data;
    if (!Array.isArray(baselineData.conversations)) throw fail('TEXT_WSS_BASELINE_INVALID');
    baselineIds = new Set(conversationIds(baselineData.conversations));
    baselineReadEvidence = {
      status: baselineResult.status,
      responseBytes: baselineResult.responseBytes,
      candidateCount: baselineIds.size,
    };
  } catch {
    await operationJournal.transition(entry.localOperationId, 'rejected', { reasonCode: 'TEXT_WSS_BASELINE_READ_FAILED' });
    throw fail('TEXT_WSS_BASELINE_READ_FAILED');
  }
  const captureConversationIds = new Set([
    ...capturedConversationIdHints(controlFrame),
    ...capturedConversationIdHints(frame),
  ]);
  if ([...captureConversationIds].some(id => baselineIds.has(id))) {
    await operationJournal.transition(entry.localOperationId, 'rejected', { reasonCode: 'TEXT_WSS_EXISTING_CONVERSATION_TARGET' });
    throw fail('TEXT_WSS_EXISTING_CONVERSATION_TARGET');
  }

  let dispatched;
  try {
    dispatched = await dispatcher({ socketUrl, cookieHeader: bound.cookieHeader, controlFrameText, frameText });
  } catch {
    await operationJournal.transition(entry.localOperationId, 'outcome_unknown', { reasonCode: 'TEXT_WSS_DISPATCH_OUTCOME_UNKNOWN' });
    return { operation: OPERATION_ID, state: 'outcome_unknown',
      handshakeStatus: null, businessFrameSent: null, terminalEventObserved: false, readbackVerified: false,
      journalEvidence };
  }

  let eventTypes;
  try { eventTypes = safeEventTypes(dispatched?.eventTypes ?? []); } catch {
    await operationJournal.transition(entry.localOperationId, 'outcome_unknown', {
      httpStatus: Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null,
      reasonCode: 'TEXT_WSS_RESULT_UNREADABLE',
    });
    return { operation: OPERATION_ID, state: 'outcome_unknown',
      handshakeStatus: Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null,
      businessFrameSent: dispatched?.businessFrameSentCount === 1 ? true : null,
      terminalEventObserved: false, readbackVerified: false, journalEvidence };
  }
  const providerModelMetadata = safeProviderModelMetadata(dispatched?.providerModelMetadata, requestSessionModel);
  let terminalMetadata;
  try { terminalMetadata = safeTerminalMetadata(dispatched?.terminalMetadata); } catch {
    await operationJournal.transition(entry.localOperationId, 'outcome_unknown', {
      httpStatus: Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null,
      reasonCode: 'TEXT_WSS_RESULT_UNREADABLE',
    });
    return { operation: OPERATION_ID, state: 'outcome_unknown',
      handshakeStatus: Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null,
      businessFrameSent: dispatched?.businessFrameSentCount === 1 ? true : null,
      terminalEventObserved: dispatched?.terminalEventObserved === true, eventTypes,
      providerModelMetadata, readbackVerified: false, journalEvidence };
  }
  const sentOnce = dispatched?.businessFrameSentCount === 1;
  const handshakeStatus = Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null;
  const terminalEventObserved = dispatched?.terminalEventObserved === true;
  const controlSentOnce = dispatched?.normalControlFrameSentCount === 1;
  const sessionAcknowledged = dispatched?.serverSessionAcknowledgementObserved === true;
  const businessBoundToServerSession = dispatched?.businessFrameBoundToServerSession === true;
  if (!sentOnce || handshakeStatus !== 101 || !controlSentOnce || !sessionAcknowledged || !businessBoundToServerSession) {
    const state = sentOnce ? 'outcome_unknown' : 'rejected';
    await operationJournal.transition(entry.localOperationId, state, {
      httpStatus: handshakeStatus,
      reasonCode: sentOnce ? 'TEXT_WSS_DISPATCH_OUTCOME_UNKNOWN' : 'TEXT_WSS_FRAME_NOT_SENT',
    });
    return { operation: OPERATION_ID, state,
      handshakeStatus, normalControlFrameSent: controlSentOnce, serverSessionAcknowledgementObserved: sessionAcknowledged,
      businessFrameSent: sentOnce, businessFrameBoundToServerSession, terminalEventObserved, eventTypes,
      providerModelMetadata, terminalMetadata, readbackVerified: false, journalEvidence };
  }

  const hints = Array.isArray(dispatched.privateConversationIdHints) ? dispatched.privateConversationIdHints : [];
  const responseHints = Array.isArray(dispatched.privateResponseIdHints) ? dispatched.privateResponseIdHints : [];
  const readback = await verifyNewTextReadback({ client, baselineIds, frame,
    privateConversationIdHints: hints, privateResponseIdHints: responseHints, expectedAssistantText,
    baselineReadEvidence });
  const readbackVerified = readback.verified;

  if (readbackVerified) {
    await operationJournal.transition(entry.localOperationId, 'accepted', { httpStatus: 101 });
    await operationJournal.transition(entry.localOperationId, 'completed', {
      httpStatus: 101,
      reasonCode: 'TEXT_WSS_READBACK_VERIFIED',
      reconciledBy: 'history.load-responses',
    });
    return { operation: OPERATION_ID, state: 'completed',
      handshakeStatus, normalControlFrameSent: true, serverSessionAcknowledgementObserved: true,
      businessFrameSent: true, businessFrameBoundToServerSession: true, terminalEventObserved, eventTypes,
      providerModelMetadata, terminalMetadata, readbackVerified: true,
      readbackConversationIdSha256: readback.conversationIdSha256,
      readbackAssistantResponseIdSha256: readback.assistantResponseIdSha256,
      readbackResponseIdHintMatched: readback.responseIdHintMatched,
      readbackEvidence: readback.readbackEvidence,
      journalEvidence,
      ...(includeContent === true ? { businessOutput: { assistantMessage: readback.assistantMessage } } : {}) };
  }

  await operationJournal.transition(entry.localOperationId, 'outcome_unknown', {
    httpStatus: 101, reasonCode: 'TEXT_WSS_READBACK_PENDING',
  });
  return { operation: OPERATION_ID, state: 'outcome_unknown',
    handshakeStatus, normalControlFrameSent: true, serverSessionAcknowledgementObserved: true,
    businessFrameSent: true, businessFrameBoundToServerSession: true, terminalEventObserved, eventTypes,
    providerModelMetadata, terminalMetadata, readbackVerified: false, readbackEvidence: readback.readbackEvidence ?? null,
    journalEvidence };
}
