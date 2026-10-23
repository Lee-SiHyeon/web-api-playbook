import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';
import {
  normalizeGrokModelModes,
  readGrokSelectedModeId,
  selectGrokModelMode,
} from './grok-model-selection.mjs';
import { submitCapturedGrokTextOnce } from './grok-text-websocket.mjs';

export const GROK_SELECTED_MODE_TEXT_SOURCE = Object.freeze({
  sourceStore: 'useModesStore',
  selectedModeField: 'selectedModeId',
  setter: 'setSelectedModeId(modeId,{source:"user"})',
  effect: 'local_sdk_state_and_local_storage',
  nativeSessionControl: 'captured session.create under selected SDK mode',
  directOperation: 'chat.text.wss',
  semanticReadback: 'conversation.list.read + conversation.read + history.response-nodes + history.load-responses',
});

const SAFE_MODE_CODE = /^(?:auto|fast|expert|heavy|build|grok-[a-z0-9]+(?:[._:-][a-z0-9]+)*)$/;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeModeCode(value) {
  return typeof value === 'string' && value.length <= 64 && SAFE_MODE_CODE.test(value) ? value : null;
}

function parseCaptureText(value, code) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_CAPTURE_BYTES) throw fail(code);
  try { return JSON.parse(value); } catch { throw fail(code); }
}

function collectInputTexts(chunks) {
  const output = [];
  const visit = (value, depth = 0) => {
    if (depth > 16 || output.length > 64) return;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 256)) visit(child, depth + 1);
    } else if (isObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'text' && typeof child === 'string') output.push(child);
        else visit(child, depth + 1);
      }
    }
  };
  visit(chunks);
  return output;
}

function hasExactKeys(value, keys) {
  return isObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateNativeModeCapture({
  catalog,
  modeStore,
  modeId,
  expectedPageRole,
  selectionEvidence,
  capture,
  expectedPrompt,
} = {}) {
  const normalized = normalizeGrokModelModes(catalog);
  const mode = normalized.modes.find(item => item.id === modeId);
  if (!mode) throw fail('MODEL_MODE_NOT_AVAILABLE');
  if (mode.availability.available === false) throw fail('MODEL_MODE_NOT_SELECTABLE');
  if (typeof expectedPageRole !== 'string' || !/^codex-grok-[A-Za-z0-9-]{8,96}$/.test(expectedPageRole)
    || !isObject(capture) || capture.sourcePageRole !== expectedPageRole) {
    throw fail('MODEL_TEXT_CAPTURE_ROLE_INVALID');
  }
  if (!isObject(selectionEvidence)
    || selectionEvidence.source !== 'normal_sdk_mode_menu'
    || selectionEvidence.pageRole !== expectedPageRole
    || selectionEvidence.selectedModeId !== modeId
    || selectionEvidence.visibleSelectedTitle !== mode.title
    || selectionEvidence.visibleSelectedMode !== true
    || selectionEvidence.controlEnabled !== true
    || selectionEvidence.userSelectionClicked !== true
    || selectionEvidence.sourceSetterCallsiteVerified !== true
    || selectionEvidence.preferenceWriteForwarded !== false) {
    throw fail('MODEL_TEXT_SELECTION_CAPTURE_MISMATCH');
  }
  const selectedModeId = readGrokSelectedModeId(modeStore);
  if (selectedModeId !== modeId) throw fail('MODEL_TEXT_SELECTION_STATE_MISMATCH');
  if (typeof expectedPrompt !== 'string' || !expectedPrompt.trim() || Buffer.byteLength(expectedPrompt, 'utf8') > 64 * 1024) {
    throw fail('MODEL_TEXT_PROMPT_INVALID');
  }
  if (capture.browserWriteAbortVerified !== true || capture.browserBusinessFramesCaptured !== 1
    || capture.browserBusinessWritesDelivered !== 0 || capture.browserControlFramesForwarded !== 1) {
    throw fail('MODEL_TEXT_CAPTURE_GUARD_REQUIRED');
  }
  const control = parseCaptureText(capture.controlFrameText, 'MODEL_TEXT_CONTROL_FRAME_INVALID');
  const frame = parseCaptureText(capture.frameText, 'MODEL_TEXT_BUSINESS_FRAME_INVALID');
  const controlEvent = control?.event;
  const session = controlEvent?.session;
  if (!isObject(control) || !['event', 'event,session_id'].includes(Object.keys(control).sort().join(','))
    || !isObject(controlEvent) || controlEvent.type !== 'session.create'
    || !isObject(session) || typeof session.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session.model)) {
    throw fail('MODEL_TEXT_CONTROL_FRAME_INVALID');
  }
  if (session.model !== modeId) throw fail('MODEL_TEXT_SESSION_MODE_MISMATCH');
  const xGrok = session.x_grok;
  if (xGrok !== undefined) {
    if (!isObject(xGrok) || Object.keys(xGrok).some(key => key.toLowerCase().includes('workspace'))
      || (xGrok.conversation_id !== undefined && xGrok.conversation_id !== null && xGrok.conversation_id !== '')
      || (xGrok.initial_load_id !== undefined && xGrok.initial_load_id !== null && xGrok.initial_load_id !== '')
      || (xGrok.load_existing !== undefined && xGrok.load_existing !== false)
      || (xGrok.enable_image_generation !== undefined && typeof xGrok.enable_image_generation !== 'boolean')
      || (xGrok.image_generation_count !== undefined
        && (!Number.isInteger(xGrok.image_generation_count) || xGrok.image_generation_count < 0 || xGrok.image_generation_count > 32))) {
      throw fail('MODEL_TEXT_CONTROL_SCOPE_INVALID');
    }
  }
  const event = frame?.event;
  const item = event?.item;
  const payload = item?.x_grok;
  const texts = collectInputTexts(payload?.input_chunks);
  if (!hasExactKeys(frame, ['event', 'session_id']) || typeof frame.session_id !== 'string' || !frame.session_id
    || !hasExactKeys(event, ['castle_request_token', 'event_id', 'item', 'type']) || event.type !== 'response.create'
    || typeof event.event_id !== 'string' || !event.event_id
    || !hasExactKeys(item, ['role', 'type', 'x_grok']) || item.type !== 'message' || item.role !== 'user'
    || !hasExactKeys(payload, ['client_message_id', 'input_chunks'])
    || typeof payload.client_message_id !== 'string' || !payload.client_message_id
    || !Array.isArray(payload.input_chunks) || payload.input_chunks.length !== 1
    || !hasExactKeys(payload.input_chunks[0], ['text']) || typeof event.castle_request_token !== 'string'
    || !event.castle_request_token.trim() || texts.length !== 1 || texts[0] !== expectedPrompt) {
    throw fail('MODEL_TEXT_BUSINESS_FRAME_INVALID');
  }
  return Object.freeze({
    modeId,
    modeTitle: mode.title,
    availability: mode.availability.available,
    uiControlEnabled: selectionEvidence.controlEnabled,
    visibleSelectedMode: selectionEvidence.visibleSelectedMode,
    userSelectionClicked: selectionEvidence.userSelectionClicked,
    sourceSetterCallsiteVerified: selectionEvidence.sourceSetterCallsiteVerified,
    storageSelectionMatched: typeof selectionEvidence.storageSelectionMatched === 'boolean'
      ? selectionEvidence.storageSelectionMatched : null,
    localSelectionMatchedAtCapture: true,
    sourceNativeControlCaptured: true,
    sessionModel: session.model,
    sessionModelEqualsSelectedModeId: true,
    providerModelEchoStatus: 'pending_direct_response',
    serverSessionAcknowledgementModeEchoed: null,
    terminalResponseModeEchoed: null,
    serverPreferenceWritePerformed: false,
    browserBusinessFrameForwarded: false,
  });
}

/**
 * Select one locally available mode in the SDK-state mirror, bind it to the
 * same-mode native capture, then delegate exactly one direct WSS request and
 * independent history verification to the existing text submitter.
 */
export async function submitGrokTextInSelectedMode({
  sessionPersistence,
  operationJournal,
  client,
  modeStore,
  catalog,
  modeId,
  expectedPageRole,
  selectionEvidence,
  capture,
  expectedPrompt,
  intentId,
  expectedAssistantText,
  includeContent = false,
  confirm = false,
  dispatchImpl,
  pythonExecutable,
} = {}) {
  if (confirm !== true) throw fail('TEXT_WSS_CONFIRMATION_REQUIRED');
  const normalizedCatalog = normalizeGrokModelModes(catalog);
  const selected = selectGrokModelMode(modeStore, normalizedCatalog, modeId);
  const binding = validateNativeModeCapture({
    catalog: normalizedCatalog,
    modeStore,
    modeId,
    expectedPageRole,
    selectionEvidence,
    capture,
    expectedPrompt,
  });
  const result = await submitCapturedGrokTextOnce({
    sessionPersistence,
    operationJournal,
    client,
    capture,
    intentId,
    confirm,
    dispatchImpl,
    pythonExecutable,
    includeContent,
    expectedAssistantText,
    expectedSourcePageRole: expectedPageRole,
  });
  const metadata = result.providerModelMetadata ?? null;
  const sessionAckModel = typeof metadata?.sessionCreatedModel === 'string' ? metadata.sessionCreatedModel : null;
  const sessionAckEchoed = sessionAckModel === null ? null : sessionAckModel === modeId;
  const terminalMode = typeof metadata?.terminalResponseMode === 'string' ? metadata.terminalResponseMode : null;
  const terminalModeEchoed = terminalMode === null ? null : terminalMode === modeId;
  const exactHistoryVerified = result.state === 'completed' && result.readbackVerified === true;
  const acceptedSelectedModeRequest = binding.sessionModelEqualsSelectedModeId === true
    && result.handshakeStatus === 101 && result.normalControlFrameSent === true
    && result.serverSessionAcknowledgementObserved === true
    && result.businessFrameSent === true && result.businessFrameBoundToServerSession === true
    && exactHistoryVerified && sessionAckEchoed !== false;
  return Object.freeze({
    ...result,
    exactPromptSha256: sha256(expectedPrompt),
    selectedModeId: selected.selectedModeId,
    selectionSource: selected.selectionSource,
    selectionEffect: 'local_sdk_state_and_local_storage',
    serverPreferenceWritePerformed: selected.serverPreferenceWritePerformed,
    modeBinding: binding,
    providerModelMetadata: metadata,
    serverSessionAcknowledgementModeEchoed: sessionAckEchoed,
    terminalResponseModeEchoed: terminalModeEchoed,
    modelSelectionAcceptance: acceptedSelectedModeRequest && sessionAckEchoed === true
      ? 'server_acknowledged_selected_mode_with_exact_history_readback'
      : acceptedSelectedModeRequest ? 'selected_mode_request_accepted_with_exact_history_readback'
        : sessionAckEchoed === true ? 'server_acknowledged_selected_mode_readback_unverified' : 'not_verified',
    providerBackendModelVersion: metadata?.terminalResponseModel ?? null,
    providerTerminalResponseMode: terminalMode,
    providerHonoringSelectedMode: terminalModeEchoed === true ? 'terminal_response_mode_echoed'
      : terminalModeEchoed === false ? 'terminal_response_mode_mismatch' : 'not_observed',
  });
}

export function summarizeGrokSelectedModeCapture(input) {
  const binding = input?.modeBinding ?? input?.binding;
  if (!isObject(binding) || typeof binding.modeId !== 'string' || typeof binding.sessionModel !== 'string') {
    throw fail('MODEL_TEXT_CAPTURE_SUMMARY_INVALID');
  }
  return Object.freeze({
    selectedModeId: binding.modeId,
    selectedModeTitle: binding.modeTitle,
    localSelectionMatchedAtCapture: binding.localSelectionMatchedAtCapture === true,
    visibleSelectedMode: binding.visibleSelectedMode === true,
    storageSelectionMatched: binding.storageSelectionMatched,
    sessionModel: safeModeCode(binding.sessionModel),
    sessionModelSource: 'normal_sdk_session_create',
    sessionModelEqualsSelectedModeId: binding.sessionModelEqualsSelectedModeId === true,
    providerHonoringSelectedMode: input.providerHonoringSelectedMode ?? 'not_observed',
  });
}
