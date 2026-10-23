import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundCredentials, GROK_WEB_ORIGIN } from './session.mjs';
import { fail } from './errors.mjs';
import { validatePreparedGrokOutboundEvent } from './grok-castle-event-preparer.mjs';

export const GROK_CONVERSATION_WSS_OPERATION_ID = 'chat.regenerate.wss';
const SOCKET_PATH = '/ws/mgw/';
const PAGE_ROLE = 'codex-grok-lifecycle-20261006';
const HELPER_PATH = fileURLToPath(new URL('../scripts/grok-conversation-wss-transport.py', import.meta.url));
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const CONTROL_FIELDS = new Set([
  'accept_interleaved_phases', 'active_response_id', 'client_side_toolsets', 'connector_ids', 'conversation_id',
  'disable_artifact', 'disable_text_follow_ups', 'enable_image_generation', 'enable_side_by_side', 'force_concise',
  'force_side_by_side', 'image_generation_count', 'initial_leaf_id', 'initial_load_id', 'load_existing',
  'protocol_capabilities', 'use_chunk',
]);
const READBACK_ATTEMPTS = 20;
const READBACK_INTERVAL_MS = 1_000;
const RECOVERY_EVIDENCE_KEYS = Object.freeze([
  'operationId', 'state', 'httpStatus', 'reasonCode', 'requestDigest', 'intentDigest',
  'controlFrameSent', 'serverSessionAcknowledgementObserved', 'businessFrameBoundToServerSession',
  'directBusinessFrameSent', 'browserBusinessFramesDelivered', 'historyUnchanged', 'ownerVerified',
  'sameConversationTarget', 'sameParentTarget', 'targetAssistantUnchanged', 'userResponseCountUnchanged',
]);

function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validateId(value, code) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512 || /[\r\n\0]/.test(value)) throw fail(code);
  return value;
}

function validateTargetProof(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !['expectedParentMessageSha256', 'expectedAssistantPattern'].includes(key))
    || typeof value.expectedParentMessageSha256 !== 'string' || !DIGEST.test(value.expectedParentMessageSha256)
    || typeof value.expectedAssistantPattern !== 'string' || !value.expectedAssistantPattern.trim()
    || value.expectedAssistantPattern.length > 512 || /[\r\n\0]/.test(value.expectedAssistantPattern)) {
    throw fail('CONVERSATION_REGENERATE_PROOF_INVALID');
  }
  try { new RegExp(value.expectedAssistantPattern); } catch { throw fail('CONVERSATION_REGENERATE_PROOF_INVALID'); }
  return value;
}

function validateIntent(options) {
  if (!plainObject(options) || options.confirm !== true) throw fail('CONVERSATION_REGENERATE_CONFIRM_REQUIRED');
  if (typeof options.intentId !== 'string' || !options.intentId.trim() || options.intentId.length > 256
    || /[\r\n\0]/.test(options.intentId)) throw fail('CONVERSATION_REGENERATE_INTENT_ID_REQUIRED');
}

function validateNoBusinessRecoveryEvidence(value, { intentDigest }) {
  if (!plainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...RECOVERY_EVIDENCE_KEYS].sort())
    || value.operationId !== GROK_CONVERSATION_WSS_OPERATION_ID || value.state !== 'rejected'
    || value.httpStatus !== 101 || value.reasonCode !== 'CONVERSATION_WSS_FRAME_NOT_SENT'
    || typeof value.requestDigest !== 'string' || !DIGEST.test(value.requestDigest)
    || value.intentDigest !== intentDigest || value.controlFrameSent !== true
    || value.serverSessionAcknowledgementObserved !== true || value.businessFrameBoundToServerSession !== false
    || value.directBusinessFrameSent !== false || value.browserBusinessFramesDelivered !== 0
    || value.historyUnchanged !== true || value.ownerVerified !== true || value.sameConversationTarget !== true
    || value.sameParentTarget !== true || value.targetAssistantUnchanged !== true
    || value.userResponseCountUnchanged !== true) throw fail('CONVERSATION_WSS_RECOVERY_EVIDENCE_INVALID');
  return value;
}

function validateSocketUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('CONVERSATION_WSS_SOCKET_URL_INVALID'); }
  const keys = [...url.searchParams.keys()];
  if (url.protocol !== 'wss:' || url.hostname !== 'grok.com' || url.port || url.username || url.password
    || url.pathname !== SOCKET_PATH || url.hash || keys.length !== 1 || keys[0] !== 'uid'
    || !url.searchParams.get('uid') || url.searchParams.getAll('uid').length !== 1) {
    throw fail('CONVERSATION_WSS_SOCKET_URL_INVALID');
  }
  return url.href;
}

function validateControlFrame(value, conversationId, responseIds) {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 64 * 1024) {
    throw fail('CONVERSATION_WSS_CONTROL_FRAME_INVALID');
  }
  let frame;
  try { frame = JSON.parse(value); } catch { throw fail('CONVERSATION_WSS_CONTROL_FRAME_INVALID'); }
  const event = frame?.event;
  const session = event?.session;
  const xGrok = session?.x_grok;
  const top = plainObject(frame) ? Object.keys(frame).sort() : [];
  const eventFields = plainObject(event) ? Object.keys(event).sort() : [];
  const sessionFields = plainObject(session) ? Object.keys(session).sort() : [];
  if ((!['event', 'event,session_id'].includes(top.join(',')))
    || (Object.hasOwn(frame, 'session_id') && (typeof frame.session_id !== 'string' || !frame.session_id))
    || !plainObject(event) || JSON.stringify(eventFields) !== JSON.stringify(['event_id', 'session', 'type'])
    || event.type !== 'session.create' || typeof event.event_id !== 'string' || !event.event_id
    || !plainObject(session) || JSON.stringify(sessionFields) !== JSON.stringify(['model', 'x_grok'])
    || typeof session.model !== 'string' || !plainObject(xGrok)
    || Object.keys(xGrok).some(key => !CONTROL_FIELDS.has(key))
    || xGrok.conversation_id !== conversationId || xGrok.load_existing !== true
    || !responseIds.includes(xGrok.active_response_id) || !responseIds.includes(xGrok.initial_leaf_id)) {
    throw fail('CONVERSATION_WSS_CONTROL_TARGET_MISMATCH');
  }
  if (containsWorkspaceTarget(frame)) throw fail('CONVERSATION_WSS_WORKSPACE_TARGET_PRESENT');
  return frame;
}

function containsWorkspaceTarget(value, depth = 0) {
  if (depth > 24) return true;
  if (Array.isArray(value)) return value.some(item => containsWorkspaceTarget(item, depth + 1));
  if (!plainObject(value)) return false;
  return Object.entries(value).some(([key, child]) => key.toLowerCase().includes('workspace') || containsWorkspaceTarget(child, depth + 1));
}

function validateBusinessFrame(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 4 * 1024 * 1024) {
    throw fail('CONVERSATION_WSS_BUSINESS_FRAME_INVALID');
  }
  let frame;
  try { frame = JSON.parse(value); } catch { throw fail('CONVERSATION_WSS_BUSINESS_FRAME_INVALID'); }
  if (!plainObject(frame) || typeof frame.session_id !== 'string' || !frame.session_id
    || !plainObject(frame.event) || frame.event.type !== 'response.create') {
    throw fail('CONVERSATION_WSS_BUSINESS_FRAME_INVALID');
  }
  if (typeof frame.event.castle_request_token !== 'string' || !frame.event.castle_request_token.trim()) {
    throw fail('CONVERSATION_WSS_CASTLE_TOKEN_UNAVAILABLE');
  }
  let prepared;
  try { prepared = validatePreparedGrokOutboundEvent(frame.event); }
  catch (error) {
    if (error?.code === 'TEXT_FIRST_PARTY_CASTLE_TOKEN_UNAVAILABLE') throw fail('CONVERSATION_WSS_CASTLE_TOKEN_UNAVAILABLE');
    if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) {
      throw fail(`CONVERSATION_WSS_${error.code}`);
    }
    throw fail('CONVERSATION_WSS_CASTLE_EVENT_INVALID');
  }
  const parentResponseId = validateId(prepared.parent_response_id ?? prepared.parentResponseId,
    'CONVERSATION_WSS_BUSINESS_FRAME_INVALID');
  if (containsWorkspaceTarget(frame)) {
    throw fail('CONVERSATION_WSS_BUSINESS_FRAME_INVALID');
  }
  return { frame, event: prepared, parentResponseId };
}

function validateCapture(capture, { conversationId, responseIds }) {
  const requiredKeys = [
    'sourcePageRole', 'httpMutationAbortGuardInstalled', 'websocketBusinessGuardInstalled',
    'browserControlFramesForwarded', 'browserBusinessFramesCaptured', 'browserBusinessFramesDelivered',
    'nativeRegenerateControlCount', 'nativeRegenerateClickCount', 'targetConversationIdMatched',
    'targetResponseCardMatched', 'targetResponseCardIdDigest', 'socketUrl', 'controlFrameText', 'frameText',
  ];
  if (!plainObject(capture) || JSON.stringify(Object.keys(capture).sort()) !== JSON.stringify([...requiredKeys].sort())
    || capture.sourcePageRole !== PAGE_ROLE || capture.httpMutationAbortGuardInstalled !== true
    || capture.websocketBusinessGuardInstalled !== true || capture.browserControlFramesForwarded !== 1
    || capture.browserBusinessFramesCaptured !== 1 || capture.browserBusinessFramesDelivered !== 0
    || capture.nativeRegenerateControlCount !== 1 || capture.nativeRegenerateClickCount !== 1
    || capture.targetConversationIdMatched !== true || capture.targetResponseCardMatched !== true) {
    throw fail('CONVERSATION_WSS_CAPTURE_NOT_GUARDED');
  }
  const socketUrl = validateSocketUrl(capture.socketUrl);
  const controlFrame = validateControlFrame(capture.controlFrameText, conversationId, responseIds);
  const business = validateBusinessFrame(capture.frameText);
  return { socketUrl, controlFrame, businessFrame: business.frame, event: business.event,
    businessParentResponseId: business.parentResponseId,
    controlFrameText: capture.controlFrameText, frameText: capture.frameText };
}

function senderKind(value) {
  const sender = typeof value === 'string' ? value.toLowerCase() : '';
  if (sender === 'assistant' || sender === 'model') return 'assistant';
  if (sender === 'user' || sender === 'human' || sender === 'you') return 'user';
  return 'other';
}

function readResult(result, code) {
  if (!result || result.status !== 200 || !plainObject(result.data)) throw fail(code);
  return result;
}

function extractResponseIds(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500
    || rows.some(row => !plainObject(row) || typeof row.responseId !== 'string')) throw fail('CONVERSATION_WSS_HISTORY_INVALID');
  const ids = rows.map(row => validateId(row.responseId, 'CONVERSATION_WSS_HISTORY_INVALID'));
  if (new Set(ids).size !== ids.length) throw fail('CONVERSATION_WSS_HISTORY_INVALID');
  return ids;
}

function promptValue(parent, proof) {
  const values = [parent.message, parent.query].filter(value => typeof value === 'string');
  return values.find(value => sha256(value) === proof.expectedParentMessageSha256) ?? null;
}

function assistantMatches(response, pattern) {
  return typeof response?.message === 'string' && new RegExp(pattern).test(response.message.trim());
}

export function createPythonGrokConversationWebSocketDispatcher({ pythonExecutable, timeoutMs = 120_000 } = {}) {
  const executable = pythonExecutable ?? process.env.GROK_CONVERSATION_WSS_PYTHON ?? 'python3';
  if (typeof executable !== 'string' || !executable.trim() || /[\r\n\0]/.test(executable)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw fail('CONVERSATION_WSS_DISPATCH_OPTIONS_INVALID');
  }
  return async function dispatch({ socketUrl, cookieHeader, controlFrameText, frameText, conversationId, parentResponseId, responseIds }) {
    const packet = Buffer.from(JSON.stringify({ socketUrl, cookieHeader, controlFrameText, frameText,
      conversationId, parentResponseId, responseIds, timeoutMs }), 'utf8');
    if (packet.length > MAX_PACKET_BYTES) { packet.fill(0); throw fail('CONVERSATION_WSS_PACKET_TOO_LARGE'); }
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
            try { child.kill('SIGTERM'); } catch { /* The bounded helper may already have exited. */ }
          }
          reject(error);
        } else resolve(result);
      };
      try {
        const env = { PYTHONDONTWRITEBYTECODE: '1' };
        for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
          if (typeof process.env[name] === 'string') env[name] = process.env[name];
        }
        child = spawn(executable, [HELPER_PATH], { stdio: ['pipe', 'pipe', 'ignore'], shell: false, env });
      } catch { finish(fail('CONVERSATION_WSS_HELPER_FAILED')); return; }
      timer = setTimeout(() => finish(fail('CONVERSATION_WSS_TIMEOUT')), timeoutMs + 5_000);
      timer.unref?.();
      child.stdout.on('data', chunk => {
        stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
        if (stdout.length > MAX_OUTPUT_BYTES) finish(fail('CONVERSATION_WSS_HELPER_OUTPUT_LIMIT'));
      });
      child.on('error', () => finish(fail('CONVERSATION_WSS_HELPER_FAILED')));
      child.on('close', code => {
        if (code !== 0 || settled) { if (!settled) finish(fail('CONVERSATION_WSS_HELPER_FAILED')); return; }
        let value;
        try { value = JSON.parse(stdout.toString('utf8')); } catch { finish(fail('CONVERSATION_WSS_HELPER_FAILED')); return; }
        const valid = Number.isInteger(value?.handshakeStatus) && value.handshakeStatus >= 0 && value.handshakeStatus <= 599
          && typeof value.controlFrameSent === 'boolean'
          && typeof value.serverSessionAcknowledgementObserved === 'boolean'
          && typeof value.businessFrameBoundToServerSession === 'boolean'
          && typeof value.capturedSessionIdMatchedAcknowledgement === 'boolean'
          && typeof value.businessFrameSent === 'boolean'
          && typeof value.terminalEventObserved === 'boolean'
          && Array.isArray(value.eventTypes) && value.eventTypes.length <= 128
          && value.eventTypes.every(item => typeof item === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/.test(item));
        if (!valid) { finish(fail('CONVERSATION_WSS_HELPER_FAILED')); return; }
        finish(null, value);
      });
      child.stdin.end(packet);
    });
  };
}

export async function submitGrokConversationRegenerationWssOnce({
  client, sessionPersistence, operationJournal, conversationId, responseId, responseIds, targetProof, capture,
  intentId, confirm = false, dispatchImpl, pythonExecutable, allowVerifiedNoBusinessRecovery = false,
  previousAttemptEvidence = null, ownerVerificationStatus = null,
} = {}) {
  if (confirm !== true) throw fail('CONVERSATION_REGENERATE_CONFIRM_REQUIRED');
  if (!client || typeof client.status !== 'function' || typeof client.read !== 'function'
    || !sessionPersistence || typeof sessionPersistence.read !== 'function'
    || !operationJournal || typeof operationJournal.begin !== 'function' || typeof operationJournal.transition !== 'function') {
    throw fail('CONVERSATION_WSS_RUNTIME_REQUIRED');
  }
  if (typeof intentId !== 'string' || !intentId.trim() || intentId.length > 256 || /[\r\n\0]/.test(intentId)) {
    throw fail('CONVERSATION_REGENERATE_INTENT_ID_REQUIRED');
  }
  const id = validateId(conversationId, 'CONVERSATION_ID_INVALID');
  const targetResponseId = validateId(responseId, 'HISTORY_RESPONSE_ID_INVALID');
  const proof = validateTargetProof(targetProof);
  if (typeof allowVerifiedNoBusinessRecovery !== 'boolean'
    || allowVerifiedNoBusinessRecovery !== (previousAttemptEvidence !== null)) {
    throw fail('CONVERSATION_WSS_RECOVERY_OPTIONS_INVALID');
  }
  if (!Array.isArray(responseIds) || responseIds.length < 2 || responseIds.length > 500) {
    throw fail('CONVERSATION_WSS_CAPTURE_NOT_GUARDED');
  }
  const knownResponseIds = responseIds.map(value => validateId(value, 'CONVERSATION_WSS_CAPTURE_NOT_GUARDED'));
  if (!knownResponseIds.includes(targetResponseId)) throw fail('CONVERSATION_WSS_CAPTURE_TARGET_MISMATCH');
  const captured = validateCapture(capture, { conversationId: id, responseIds: knownResponseIds });
  const stored = await sessionPersistence.read();
  const session = stored?.session;
  if (stored?.kind !== 'grok-session' || !plainObject(session)
    || session.generation !== session.ownerBinding?.generation
    || typeof session.ownerBinding?.identityDigest !== 'string' || !DIGEST.test(session.ownerBinding.identityDigest)) {
    throw fail('OWNER_VERIFICATION_REQUIRED');
  }
  const status = await client.status();
  if (status?.session?.ownerVerified !== true) throw fail('OWNER_VERIFICATION_REQUIRED');
  if (ownerVerificationStatus !== null
    && (!Number.isInteger(ownerVerificationStatus) || ownerVerificationStatus < 200 || ownerVerificationStatus > 299)) {
    throw fail('CONVERSATION_WSS_OWNER_VERIFICATION_STATUS_INVALID');
  }

  const detail = readResult(await client.read('conversation.read', { conversationId: id }), 'CONVERSATION_READ_FAILED');
  const conversation = detail.data.conversation ?? detail.data;
  if (conversation?.conversationId !== id || conversation?.viewerIsOwner !== true || conversation?.isReadonly === true) {
    throw fail('CONVERSATION_OWNER_ACCESS_REQUIRED');
  }
  const beforeNodeResult = readResult(await client.read('history.response-nodes', { conversationId: id }), 'HISTORY_RESPONSE_NODES_READ_FAILED');
  const beforeRows = beforeNodeResult.data.responseNodes;
  if (!Array.isArray(beforeRows) || !Array.isArray(beforeNodeResult.data.inflightResponses)) throw fail('HISTORY_RESPONSE_NODES_RESPONSE_INVALID');
  const beforeIds = extractResponseIds(beforeRows);
  if (!beforeIds.includes(targetResponseId)) throw fail('CONVERSATION_REGENERATE_TARGET_INVALID');
  const beforeLoaded = readResult(await client.read('history.load-responses', { conversationId: id, responseIds: beforeIds }), 'HISTORY_LOAD_RESPONSES_READ_FAILED');
  if (!Array.isArray(beforeLoaded.data.responses)) throw fail('HISTORY_LOAD_RESPONSES_RESPONSE_INVALID');
  const beforeById = new Map(beforeLoaded.data.responses.map(row => [row.responseId, row]));
  const userResponseCountBefore = beforeLoaded.data.responses.filter(row => senderKind(row?.sender) === 'user').length;
  const targetNode = beforeRows.find(row => row.responseId === targetResponseId);
  const target = beforeById.get(targetResponseId);
  const parentResponseId = validateId(target?.parentResponseId, 'CONVERSATION_REGENERATE_PARENT_INVALID');
  if (captured.businessParentResponseId !== parentResponseId) throw fail('CONVERSATION_WSS_CAPTURE_TARGET_MISMATCH');
  const parent = beforeById.get(parentResponseId);
  const parentText = plainObject(parent) ? promptValue(parent, proof) : null;
  const taskPatternMatched = beforeLoaded.data.responses.some(row => senderKind(row?.sender) === 'assistant'
    && typeof row.message === 'string' && new RegExp(proof.expectedAssistantPattern).test(row.message.trim()));
  if (senderKind(targetNode?.sender) !== 'assistant' || targetNode.parentResponseId !== parentResponseId
    || senderKind(target?.sender) !== 'assistant' || typeof target?.message !== 'string' || !target.message.trim()
    || senderKind(parent?.sender) !== 'user' || parentText === null || !taskPatternMatched) {
    throw fail('CONVERSATION_REGENERATE_TARGET_PROOF_MISMATCH');
  }
  if (capture.targetResponseCardMatched !== true || capture.targetResponseCardIdDigest !== sha256(targetResponseId)) {
    throw fail('CONVERSATION_WSS_CAPTURE_TARGET_MISMATCH');
  }

  const credentials = boundCredentials(session, GROK_WEB_ORIGIN, SOCKET_PATH, { cookieNames: ['sso'], headerNames: [] });
  const requestDigest = sha256(`${captured.socketUrl}\n${captured.controlFrameText}\n${captured.frameText}`);
  const intentDigest = sha256(`${GROK_CONVERSATION_WSS_OPERATION_ID}\n${session.ownerBinding.identityDigest}\n${intentId.trim()}`);
  let journalEntry;
  if (allowVerifiedNoBusinessRecovery) {
    const priorEvidence = validateNoBusinessRecoveryEvidence(previousAttemptEvidence, { intentDigest });
    if (typeof operationJournal.list !== 'function' || typeof operationJournal.recordVerifiedNoBusinessWssAttempt !== 'function'
      || typeof operationJournal.beginVerifiedNoBusinessWssRecovery !== 'function') throw fail('JOURNAL_WSS_RECOVERY_UNAVAILABLE');
    const priorRows = (await operationJournal.list()).filter(item => item.contractId === GROK_CONVERSATION_WSS_OPERATION_ID
      && item.requestDigest === priorEvidence.requestDigest && item.intentDigest === priorEvidence.intentDigest);
    if (priorRows.length !== 1) throw fail('JOURNAL_WSS_RECOVERY_NOT_ALLOWED');
    await operationJournal.recordVerifiedNoBusinessWssAttempt(priorRows[0].localOperationId, {
      controlFrameSent: priorEvidence.controlFrameSent,
      serverSessionAcknowledgementObserved: priorEvidence.serverSessionAcknowledgementObserved,
      businessFrameBoundToServerSession: priorEvidence.businessFrameBoundToServerSession,
      directBusinessFrameSent: priorEvidence.directBusinessFrameSent,
      browserBusinessFramesDelivered: priorEvidence.browserBusinessFramesDelivered,
      historyUnchanged: priorEvidence.historyUnchanged,
      ownerVerified: priorEvidence.ownerVerified,
      sameConversationTarget: priorEvidence.sameConversationTarget,
      sameParentTarget: priorEvidence.sameParentTarget,
      targetAssistantUnchanged: priorEvidence.targetAssistantUnchanged,
      userResponseCountUnchanged: priorEvidence.userResponseCountUnchanged,
    });
    journalEntry = await operationJournal.beginVerifiedNoBusinessWssRecovery({
      requestDigest,
      intentDigest,
      conversationBindingDigest: sha256(id),
      parentBindingDigest: sha256(parentResponseId),
    });
  } else {
    journalEntry = await operationJournal.begin({ contractId: GROK_CONVERSATION_WSS_OPERATION_ID, requestDigest, intentDigest });
  }
  const dispatcher = dispatchImpl ?? createPythonGrokConversationWebSocketDispatcher({ pythonExecutable });
  let dispatched;
  try {
    dispatched = await dispatcher({
      socketUrl: captured.socketUrl,
      cookieHeader: credentials.cookieHeader,
      controlFrameText: captured.controlFrameText,
      frameText: captured.frameText,
      conversationId: id,
      parentResponseId,
      responseIds: knownResponseIds,
    });
  } catch {
    await operationJournal.transition(journalEntry.localOperationId, 'outcome_unknown', {
      reasonCode: 'CONVERSATION_WSS_DISPATCH_OUTCOME_UNKNOWN',
    });
    return { operation: GROK_CONVERSATION_WSS_OPERATION_ID, state: 'outcome_unknown', verified: false,
      handshakeStatus: null, browserBusinessFramesDelivered: 0, directBusinessFrameSent: null,
      castleRequestTokenPresent: true, readbackStatus: null };
  }
  const handshakeStatus = Number.isInteger(dispatched?.handshakeStatus) ? dispatched.handshakeStatus : null;
  const controlSent = dispatched?.controlFrameSent === true;
  const sessionAck = dispatched?.serverSessionAcknowledgementObserved === true;
  const bound = dispatched?.businessFrameBoundToServerSession === true;
  const sent = dispatched?.businessFrameSent === true;
  const terminal = dispatched?.terminalEventObserved === true;
  const eventTypes = Array.isArray(dispatched?.eventTypes) ? dispatched.eventTypes : [];
  if (handshakeStatus !== 101 || !controlSent || !sessionAck || !bound || !sent) {
    const stateName = sent ? 'outcome_unknown' : 'rejected';
    await operationJournal.transition(journalEntry.localOperationId, stateName, {
      httpStatus: handshakeStatus,
      reasonCode: sent ? 'CONVERSATION_WSS_DISPATCH_OUTCOME_UNKNOWN' : 'CONVERSATION_WSS_FRAME_NOT_SENT',
    });
    return { operation: GROK_CONVERSATION_WSS_OPERATION_ID, state: stateName, verified: false,
      handshakeStatus, controlFrameSent: controlSent, serverSessionAcknowledgementObserved: sessionAck,
      businessFrameBoundToServerSession: bound,
      capturedSessionIdMatchedAcknowledgement: dispatched?.capturedSessionIdMatchedAcknowledgement === true,
      directBusinessFrameSent: sent, terminalEventObserved: terminal,
      eventTypes, browserBusinessFramesDelivered: 0, castleRequestTokenPresent: true, readbackStatus: null };
  }
  await operationJournal.transition(journalEntry.localOperationId, 'accepted', { httpStatus: 101 });

  const beforeSet = new Set(beforeIds);
  let afterNodes = null;
  let newNode = null;
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt++) {
    try {
      afterNodes = readResult(await client.read('history.response-nodes', { conversationId: id }), 'HISTORY_RESPONSE_NODES_READ_FAILED');
    } catch { afterNodes = null; break; }
    if (!Array.isArray(afterNodes.data.responseNodes) || !Array.isArray(afterNodes.data.inflightResponses)) break;
    const added = afterNodes.data.responseNodes.filter(row => !beforeSet.has(row?.responseId));
    if (added.length > 1) break;
    if (added.length === 1 && afterNodes.data.inflightResponses.length === 0) { newNode = added[0]; break; }
    if (attempt + 1 < READBACK_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, READBACK_INTERVAL_MS));
  }
  if (!afterNodes || !newNode || senderKind(newNode.sender) !== 'assistant' || newNode.parentResponseId !== parentResponseId) {
    await operationJournal.transition(journalEntry.localOperationId, 'outcome_unknown', {
      httpStatus: afterNodes?.status ?? 101,
      reasonCode: 'CONVERSATION_WSS_READBACK_PENDING',
    });
    return { operation: GROK_CONVERSATION_WSS_OPERATION_ID, state: 'outcome_unknown', verified: false,
      handshakeStatus, controlFrameSent: true, serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true,
      capturedSessionIdMatchedAcknowledgement: dispatched.capturedSessionIdMatchedAcknowledgement,
      directBusinessFrameSent: true, terminalEventObserved: terminal,
      eventTypes, browserBusinessFramesDelivered: 0, castleRequestTokenPresent: true,
      readbackStatus: afterNodes?.status ?? null };
  }
  let loaded;
  try {
    const afterIds = extractResponseIds(afterNodes.data.responseNodes);
    loaded = readResult(await client.read('history.load-responses', {
      conversationId: id,
      responseIds: afterIds,
    }), 'HISTORY_LOAD_RESPONSES_READ_FAILED');
    if (!Array.isArray(loaded.data.responses)) throw fail('HISTORY_LOAD_RESPONSES_RESPONSE_INVALID');
  } catch {
    await operationJournal.transition(journalEntry.localOperationId, 'outcome_unknown', {
      httpStatus: 101,
      reasonCode: 'CONVERSATION_WSS_READBACK_PENDING',
    });
    return { operation: GROK_CONVERSATION_WSS_OPERATION_ID, state: 'outcome_unknown', verified: false,
      handshakeStatus, controlFrameSent: true, serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true,
      capturedSessionIdMatchedAcknowledgement: dispatched.capturedSessionIdMatchedAcknowledgement,
      directBusinessFrameSent: true, terminalEventObserved: terminal,
      eventTypes, browserBusinessFramesDelivered: 0, castleRequestTokenPresent: true, readbackStatus: null };
  }
  const afterById = new Map(loaded.data.responses.map(row => [row.responseId, row]));
  const afterParent = afterById.get(parentResponseId);
  const afterTarget = afterById.get(targetResponseId);
  const regenerated = afterById.get(newNode.responseId);
  const parentStillMatches = promptValue(afterParent, proof) === parentText;
  const targetStillMatches = typeof afterTarget?.message === 'string' && afterTarget.message === target.message;
  const taskPatternStillMatched = loaded.data.responses.some(row => senderKind(row?.sender) === 'assistant'
    && typeof row.message === 'string' && new RegExp(proof.expectedAssistantPattern).test(row.message.trim()));
  const userResponseCountAfter = loaded.data.responses.filter(row => senderKind(row?.sender) === 'user').length;
  const regeneratedNonempty = senderKind(regenerated?.sender) === 'assistant'
    && typeof regenerated?.message === 'string' && Boolean(regenerated.message.trim());
  const regeneratedMatches = assistantMatches(regenerated, proof.expectedAssistantPattern);
  const verified = senderKind(regenerated?.sender) === 'assistant' && newNode.parentResponseId === parentResponseId
    && parentStillMatches && targetStillMatches && taskPatternStillMatched && regeneratedNonempty
    && regeneratedMatches && userResponseCountAfter === userResponseCountBefore;
  if (!verified) {
    await operationJournal.transition(journalEntry.localOperationId, 'outcome_unknown', {
      httpStatus: loaded.status,
      reasonCode: 'CONVERSATION_WSS_READBACK_MISMATCH',
    });
    return { operation: GROK_CONVERSATION_WSS_OPERATION_ID, state: 'outcome_unknown', verified: false,
      handshakeStatus, controlFrameSent: true, serverSessionAcknowledgementObserved: true,
      businessFrameBoundToServerSession: true,
      capturedSessionIdMatchedAcknowledgement: dispatched.capturedSessionIdMatchedAcknowledgement,
      directBusinessFrameSent: true, terminalEventObserved: terminal,
      eventTypes, browserBusinessFramesDelivered: 0, castleRequestTokenPresent: true,
      readbackStatus: loaded.status, exactParentMatched: parentStillMatches,
      targetAssistantUnchanged: targetStillMatches, taskAssistantPatternMatched: taskPatternStillMatched,
      regeneratedAssistantNonempty: regeneratedNonempty, regeneratedPatternMatched: regeneratedMatches,
      userResponseCountUnchanged: userResponseCountAfter === userResponseCountBefore };
  }
  await operationJournal.transition(journalEntry.localOperationId, 'completed', {
    httpStatus: loaded.status,
    reasonCode: 'CONVERSATION_WSS_HISTORY_READBACK_VERIFIED',
    reconciledBy: 'history.load-responses',
  });
  return { operation: GROK_CONVERSATION_WSS_OPERATION_ID, state: 'completed', verified: true,
    handshakeStatus, controlFrameSent: true, serverSessionAcknowledgementObserved: true,
    businessFrameBoundToServerSession: true,
    capturedSessionIdMatchedAcknowledgement: dispatched.capturedSessionIdMatchedAcknowledgement,
    directBusinessFrameSent: true, terminalEventObserved: terminal,
    eventTypes, browserBusinessFramesDelivered: 0, castleRequestTokenPresent: true,
    requestDigest: journalEntry.requestDigest, intentDigest: journalEntry.intentDigest,
    ...(journalEntry.recoveryOfRequestDigest ? { recoveryOfRequestDigest: journalEntry.recoveryOfRequestDigest } : {}),
    verifiedNoBusinessRecoveryUsed: Boolean(journalEntry.recoveryOfRequestDigest),
    ownerVerificationStatus,
    conversationReadStatus: detail.status,
    responseNodesStatus: afterNodes.status,
    loadResponsesStatus: loaded.status,
    responseCountBefore: beforeRows.length,
    responseCountAfter: afterNodes.data.responseNodes.length,
    userResponseCountBefore,
    userResponseCountAfter,
    readbackStatus: loaded.status, exactParentMatched: true, targetAssistantUnchanged: true,
    targetResponseParentMatched: true, newAssistantParentMatched: true,
    taskAssistantPatternMatched: true, regeneratedAssistantNonempty: true, regeneratedPatternMatched: true,
    userResponseCountUnchanged: true, addedAssistantResponseCount: 1 };
}
